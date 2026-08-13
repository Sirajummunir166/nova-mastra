/**
 * Mastra Studio, served by this app at /studio.
 *
 * The `mastra` package ships Studio as a static SPA whose runtime config is
 * a set of `%%PLACEHOLDER%%` tokens in index.html that the CLI fills at serve
 * time. We fill them ourselves, with MASTRA_AUTO_DETECT_URL=true so the SPA
 * talks to whatever origin served it — same-origin, no CORS, no hardcoded
 * deployment URL.
 *
 * ACCESS: Studio can run every agent and workflow in this project, and the
 * customer-turn workflow creates REAL orders in a real store. So /studio is
 * gated by HTTP Basic auth against NOVA_STUDIO_TOKEN (any username, the
 * token as the password). A successful login sets a session cookie that the
 * API guard in index.ts also accepts, so the SPA's own /api calls are
 * authorized without the operator pasting headers into Studio's settings.
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { createHmac, timingSafeEqual } from "node:crypto";
import express, { Router, type Request, type Response, type NextFunction } from "express";

export const STUDIO_COOKIE = "nova_studio";

function studioDir(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const dir = join(dirname(require.resolve("mastra/package.json")), "dist", "studio");
    return existsSync(join(dir, "index.html")) ? dir : null;
  } catch {
    return null;
  }
}

/**
 * Cookie value = HMAC of a fixed label under the token, so the token itself
 * never rides in the cookie and rotating it invalidates every session.
 */
export function studioCookieValue(token: string): string {
  return createHmac("sha256", token).update("nova-studio-session").digest("base64url");
}

export function hasValidStudioCookie(req: Request, token: string): boolean {
  const raw = req.headers.cookie;
  if (!raw) return false;
  const match = raw.split(";").map((c) => c.trim()).find((c) => c.startsWith(`${STUDIO_COOKIE}=`));
  if (!match) return false;
  return safeEqual(match.slice(STUDIO_COOKIE.length + 1), studioCookieValue(token));
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

const PLACEHOLDERS: Record<string, string> = {
  MASTRA_STUDIO_BASE_PATH: "/studio",
  // The whole point: the SPA calls window.location.origin instead of a
  // compiled-in host, so this works on Railway and on localhost unchanged.
  MASTRA_AUTO_DETECT_URL: "true",
  MASTRA_API_PREFIX: "/api",
  MASTRA_SERVER_PROTOCOL: "https",
  MASTRA_SERVER_HOST: "localhost",
  MASTRA_SERVER_PORT: "443",
  MASTRA_TELEMETRY_DISABLED: "1",
  MASTRA_HIDE_CLOUD_CTA: "true",
};

function renderIndex(dir: string): string {
  let html = readFileSync(join(dir, "index.html"), "utf8");
  for (const [key, value] of Object.entries(PLACEHOLDERS)) {
    html = html.replaceAll(`%%${key}%%`, value);
  }
  // Any placeholder we did not set becomes an empty string; the SPA treats
  // every one of them as an opt-in flag compared against "true".
  return html.replace(/%%MASTRA_[A-Z0-9_]+%%/g, "");
}

/**
 * Returns null when Studio cannot be served (package pruned in a production
 * install) so the caller can skip mounting rather than crash at boot.
 */
export function createStudioRouter(token: string | undefined): Router | null {
  const dir = studioDir();
  if (!dir) return null;

  const router = Router();
  const html = renderIndex(dir);

  router.use((req: Request, res: Response, next: NextFunction) => {
    if (!token) return next(); // unset = open (loopback only; index.ts warns)
    if (hasValidStudioCookie(req, token)) return next();

    const header = req.headers.authorization ?? "";
    const basic = /^Basic\s+(.+)$/i.exec(header.trim())?.[1];
    if (basic) {
      const decoded = Buffer.from(basic, "base64").toString("utf8");
      const password = decoded.slice(decoded.indexOf(":") + 1);
      if (safeEqual(password, token)) {
        res.cookie?.(STUDIO_COOKIE, studioCookieValue(token), {
          httpOnly: true,
          sameSite: "lax",
          secure: req.secure || req.headers["x-forwarded-proto"] === "https",
          maxAge: 12 * 60 * 60 * 1000,
        });
        return next();
      }
    }
    res.setHeader("WWW-Authenticate", 'Basic realm="Nova Studio", charset="UTF-8"');
    res.status(401).send("Nova Studio — sign in with any username and the NOVA_STUDIO_TOKEN as the password.");
  });

  router.use("/assets", express.static(join(dir, "assets"), { immutable: true, maxAge: "1y" }));
  router.get("/mastra.svg", (_req, res) => res.sendFile(join(dir, "mastra.svg")));

  // SPA fallback: Studio owns its client-side routes (/studio/workflows, ...).
  router.get(/.*/, (_req: Request, res: Response) => {
    res.type("html").send(html);
  });

  return router;
}
