#!/usr/bin/env node
/**
 * `npm run studio` — Mastra Studio, with one thing set before Node boots.
 *
 * ── WHY THIS WRAPPER EXISTS ────────────────────────────────────────────────
 *
 * Node's global `fetch` ignores `HTTPS_PROXY`. Behind a proxy that means every
 * model call from the Studio playground comes back
 *
 *   403  Host not in allowlist: ai-gateway.vercel.sh
 *
 * which reads like a credential or allowlist problem and is neither.
 *
 * The server path (`src/index.ts`) fixes this by importing `src/boot.ts`,
 * which installs undici's `EnvHttpProxyAgent`. That does NOT work here, and
 * the reason is worth writing down because it cost a round of debugging:
 * `mastra dev` BUNDLES the app into `.mastra/output/`, and a bare
 * `import "../boot.js"` — a module whose only purpose is a side effect and
 * whose exports nothing uses — is exactly what a tree-shaking bundler drops.
 * Verified rather than assumed: `installProxyFromEnv` appears nowhere in the
 * bundled output.
 *
 * So the setting has to arrive from OUTSIDE the bundle, as a real environment
 * variable, before the child process starts. `NODE_USE_ENV_PROXY=1` is Node's
 * own supported switch for precisely this, and it needs no bundle cooperation.
 *
 * ── WHY A .mjs WRAPPER AND NOT `NODE_USE_ENV_PROXY=1 mastra dev` ───────────
 *
 * That shell prefix is POSIX-only. It fails on Windows `cmd`, and this team
 * develops on Windows. A Node wrapper is the portable spelling that needs no
 * extra dependency.
 *
 * ── IT CHANGES NOTHING WHEN THERE IS NO PROXY ──────────────────────────────
 *
 * `NODE_USE_ENV_PROXY` only does anything when `HTTPS_PROXY`/`HTTP_PROXY` are
 * set. On a normal laptop they are not, so this is an ordinary `mastra dev`.
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * Resolve Mastra's CLI entry from the installed package rather than trusting a
 * `mastra` binary to be on PATH — npm puts it in `node_modules/.bin`, which is
 * on PATH for npm scripts but not for a direct `node scripts/studio.mjs`.
 */
function mastraCliPath() {
  try {
    return require.resolve("mastra/bin/mastra.js");
  } catch {
    return null;
  }
}

const cli = mastraCliPath();
const args = process.argv.slice(2);
const subcommand = args.length > 0 ? args : ["dev"];

const env = { ...process.env, NODE_USE_ENV_PROXY: "1" };
const proxy = env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy;
if (proxy) console.log(`[studio] routing outbound fetch through ${proxy}`);

const child = cli
  ? spawn(process.execPath, [cli, ...subcommand], { stdio: "inherit", env })
  : // Fall back to the PATH lookup npm provides. `shell: true` is required on
    // Windows to run the `.cmd` shim npm writes for package binaries.
    spawn("mastra", subcommand, { stdio: "inherit", env, shell: true });

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
child.on("error", (err) => {
  console.error("[studio] could not start the Mastra CLI:", err.message);
  process.exit(1);
});
