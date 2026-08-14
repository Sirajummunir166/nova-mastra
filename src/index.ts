import "dotenv/config";
import express, { type Request, type Response } from "express";
import { MastraServer } from "@mastra/express";
import { mastra } from "./mastra/index.js";
import { getStoreProfile } from "./lib/store.js";
import { novaInstructions } from "./lib/context.js";
import { toolsForTurn } from "./tools/index.js";
import { eveRouter } from "./eve-compat/router.js";
import { withGatewayRetry } from "./lib/gateway-retry.js";
import { createStudioRouter, hasValidStudioCookie } from "./studio.js";

const app = express();
const PORT = Number(process.env.PORT) || 2100;

// CORS — mirrors nova-ai channels/eve.ts: origins from NOVA_CORS_ORIGINS
// (comma-separated, * if unset), the session id exposed.
//
// Request headers are REFLECTED rather than allowlisted: Mastra Studio talks
// to this server from its own origin and sends its own headers
// (x-mastra-client-type and friends), which a fixed list silently breaks in
// the browser. The real access decision is the origin check above plus the
// API guard below — the header list was never the control.
const ORIGINS = (process.env.NOVA_CORS_ORIGINS ?? "*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowed = ORIGINS.includes("*") ? (origin ?? "*") : origin && ORIGINS.includes(origin) ? origin : null;
  if (allowed) {
    res.setHeader("Access-Control-Allow-Origin", allowed);
    res.setHeader("Vary", "Origin");
    res.setHeader(
      "Access-Control-Allow-Headers",
      (req.headers["access-control-request-headers"] as string | undefined) ??
        "authorization, content-type, x-dakio-client-context",
    );
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Expose-Headers", "x-eve-session-id");
  }
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

/**
 * Guard for the Mastra API surface (/api/*) and /chat.
 *
 * These routes run agents and workflows — the customer-turn workflow can
 * CREATE REAL ORDERS in a real store — and unlike /eve/v1 they carry no
 * auth of their own. Set NOVA_STUDIO_TOKEN in any deployed environment and
 * pass it as `Authorization: Bearer <token>` (Mastra Studio: Settings →
 * Custom headers). Unset = open, which is fine on loopback and dangerous
 * anywhere else, so an unguarded non-local boot says so loudly.
 */
const STUDIO_TOKEN = process.env.NOVA_STUDIO_TOKEN?.trim();
app.use((req, res, next) => {
  if (!STUDIO_TOKEN) return next();
  if (!req.path.startsWith("/api/") && req.path !== "/chat") return next();
  // The hosted Studio at /studio signs in once and rides its session cookie,
  // so its own API calls need no pasted headers; scripts use the bearer.
  if (hasValidStudioCookie(req, STUDIO_TOKEN)) return next();
  const header = req.headers.authorization ?? "";
  const presented = /^Bearer\s+(.+)$/i.exec(header.trim())?.[1] ?? (req.headers["x-nova-studio-token"] as string | undefined);
  if (presented !== STUDIO_TOKEN) {
    res.status(401).json({ ok: false, error: "NOVA_STUDIO_TOKEN required for this route" });
    return;
  }
  next();
});

// Mastra Studio, same-origin at /studio (see studio.ts). Mounted before the
// JSON body parser: it serves static files and needs no parsed body.
const studioRouter = createStudioRouter(STUDIO_TOKEN);
if (studioRouter) app.use("/studio", studioRouter);

app.use(express.json());

// The eve protocol surface NovaChat speaks (novaAgentClient.js).
app.use("/eve/v1", eveRouter);

// Registers Mastra's own endpoints (/api/agents/nova/generate etc.).
const server = new MastraServer({ app, mastra });
await server.init();

/**
 * Root must answer 200: Studio decides whether a Mastra instance is reachable
 * by fetching the bare origin, and treats a non-2xx as "no instance here" —
 * which drops it onto the manual "Mastra instance URL" setup screen instead of
 * auto-detecting. A 404 here is the difference between Studio just working and
 * every operator typing the deployment URL by hand.
 */
app.get("/", (_req: Request, res: Response) => {
  res.json({ ok: true, service: "nova-mastra", studio: "/studio", api: "/api" });
});

app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true, service: "nova-mastra" });
});

/**
 * The chatbox seam. Body: { message?: string, storeId?: string }.
 * storeId falls back to NOVA_DEV_STORE_ID for local dev; in production the
 * caller's Dakio JWT will carry tenancy (same as nova-ai) — auth lands with
 * the real chat contract.
 */
app.post("/chat", async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as { message?: string; storeId?: string };
    const storeId = body.storeId || process.env.NOVA_DEV_STORE_ID;
    const message = body.message || "Introduce yourself to the founder.";
    if (!storeId) {
      res.status(400).json({ ok: false, error: "storeId required (or set NOVA_DEV_STORE_ID)" });
      return;
    }

    const store = await getStoreProfile(storeId);
    if (!store) {
      res.status(502).json({ ok: false, error: `store ${storeId} unavailable from dakio-api` });
      return;
    }
    if (store.status !== "active") {
      res.status(403).json({ ok: false, error: `store ${storeId} is not active` });
      return;
    }

    const agent = mastra.getAgent("nova");
    // Same rules-first tool selection the eve lane uses — /chat must not be a
    // second, quietly different Nova.
    const { toolsets } = toolsForTurn(storeId, message);
    const result = await withGatewayRetry(() =>
      agent.generate(message, {
        instructions: novaInstructions(store),
        ...(toolsets ? { toolsets } : {}),
      }),
    );

    res.json({
      ok: true,
      store: { id: store.storeId, name: store.name, plan: store.plan },
      model: result.response?.modelId,
      usage: result.usage,
      reply: result.text,
    });
  } catch (err) {
    console.error("[chat]", err);
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`nova-mastra listening on http://localhost:${PORT}`);
  console.log(studioRouter ? `Studio at /studio (${STUDIO_TOKEN ? "token required" : "OPEN"})` : "Studio not bundled — `mastra` package unavailable");
  if (!STUDIO_TOKEN && process.env.RAILWAY_ENVIRONMENT) {
    console.warn(
      "[security] /studio, /api/* and /chat are UNAUTHENTICATED on a deployed instance — anyone with the URL can run " +
        "agents, and the customer-turn workflow can create real orders. Set NOVA_STUDIO_TOKEN.",
    );
  }
});
