/**
 * Make Node's `fetch` respect `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`.
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
 *
 * This cost an hour, twice, and the failure it fixes is the most misleading
 * kind: it looks exactly like a permissions problem, so you go and fix the
 * permissions, and nothing changes.
 *
 * `curl` reads the proxy environment variables. Node's global `fetch` (undici)
 * DOES NOT — not on Node 22, not by default. So in any environment where
 * outbound traffic must leave through a proxy, you get this:
 *
 *   curl  https://ai-gateway.vercel.sh/v1/models   → 200, real model list
 *   fetch("https://ai-gateway.vercel.sh/...")      → 403 "Host not in allowlist"
 *
 * Same host, same machine, same second. The 403 is not the gateway refusing
 * the key — it is the sandbox's egress filter refusing traffic that tried to
 * go around the proxy. The error text says "add this host to your network
 * egress settings", which sends you to the allowlist, which was already
 * correct. Anthropic's Claude Code cloud sandbox behaves this way (its own
 * README says never to disable TLS verification or unset the proxy to work
 * around it, and this file does neither), and so does every corporate egress
 * proxy with the same shape.
 *
 * `installProxyFromEnv()` closes the gap the supported way: it installs
 * undici's `EnvHttpProxyAgent` as the global dispatcher, which is precisely
 * what Node's own `NODE_USE_ENV_PROXY=1` does — it just does not depend on
 * every caller remembering to set that variable on every command.
 *
 * ── WHY IT IS SAFE IN PRODUCTION ───────────────────────────────────────────
 *
 * It is a NO-OP when no proxy is configured. On Railway, `HTTPS_PROXY` is
 * unset, this returns `false` on the first line, and `fetch` is untouched.
 * It changes behaviour only where a proxy was already mandatory.
 */

import { createRequire } from "node:module";

/** This project is ESM; `require` has to be made, not assumed. */
const require = createRequire(import.meta.url);

let installed: boolean | null = null;

/**
 * Route `fetch` through the environment's proxy, if there is one.
 *
 * Idempotent and safe to call from several entry points — the work happens
 * once and the same answer is returned afterwards.
 *
 * @returns `true` if a proxy was found and installed, `false` if there was
 *   nothing to do (the normal production case).
 */
export function installProxyFromEnv(): boolean {
  if (installed !== null) return installed;

  const proxy =
    process.env.HTTPS_PROXY ??
    process.env.https_proxy ??
    process.env.HTTP_PROXY ??
    process.env.http_proxy;

  if (!proxy) {
    installed = false;
    return installed;
  }

  try {
    // `undici` ships inside Node, but the bundled copy is not importable by
    // name; the standalone package is a transitive dependency here. Required
    // lazily so a missing package degrades to a warning rather than taking
    // the process down — a service that cannot reach the model must still
    // boot and say so.
    const { EnvHttpProxyAgent, setGlobalDispatcher } = require("undici") as {
      EnvHttpProxyAgent: new () => unknown;
      setGlobalDispatcher: (d: unknown) => void;
    };
    setGlobalDispatcher(new EnvHttpProxyAgent());
    installed = true;
  } catch (err) {
    console.warn(
      "[egress] a proxy is configured (%s) but undici's EnvHttpProxyAgent could not be installed; " +
        "outbound fetch will bypass it and may be refused. Run with NODE_USE_ENV_PROXY=1 instead. Cause:",
      proxy,
      err,
    );
    installed = false;
  }
  return installed;
}
