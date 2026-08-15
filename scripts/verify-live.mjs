#!/usr/bin/env node
/**
 * Verify a DEPLOYED nova-mastra — the one command to run when you want to know
 * whether the live service is actually working, and against which store.
 *
 *   npm run verify:live -- --store cms05ymxq0001ld0t8s23g3hg
 *   npm run verify:live -- --store <id> --base http://localhost:4111
 *   npm run verify:live -- --store <id> --pulse        # ⚠️ WRITES — see below
 *
 * ── READ-ONLY BY DEFAULT, AND THAT IS A DELIBERATE CHOICE ──────────────────
 *
 * The obvious way to prove the brain works against a live store is to run
 * `brain-pulse` on it. That is NOT read-only. A pulse that finds something
 * files a NovaReport, can file Decision cards, and always writes a pulse
 * snapshot — and the snapshot is load-bearing: it is what makes the NEXT pulse
 * quiet. Run one by accident against a real merchant and you have put rows on
 * a founder's desk and moved the edge-trigger state underneath the real
 * hourly pulse.
 *
 * So the default run only READS: it asks the service what it is and what it
 * can do. The pulse is behind `--pulse`, prints a warning, and names the store
 * it is about to write to.
 *
 * ── WHAT THE DEFAULT RUN PROVES, AND WHAT IT DOES NOT ──────────────────────
 *
 * Proves: the service is up, the Mastra server is mounted, the agent and all
 * the workflows registered, and the store id you passed is one the deployment
 * can resolve.
 *
 * Does NOT prove the founder chat lane. The `nova` agent registered with
 * Mastra carries a BASE PERSONA ONLY — the real per-turn instructions (store
 * snapshot, answer rules) and the tool selection that the whole token argument
 * rests on are built in the `/chat` route, not in the agent. So a "hello"
 * through the agent playground exercises the model plumbing and nothing else,
 * and its token count is not comparable to a real founder turn. This script
 * says so rather than letting a small number look like good news.
 */

import { installProxyFromEnv } from "../src/lib/egress.js";

installProxyFromEnv();

const argOf = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const has = (name) => process.argv.includes(`--${name}`);

const BASE = (argOf("base", "https://nova-mastra-production.up.railway.app")).replace(/\/$/, "");
const STORE = argOf("store", process.env.NOVA_DEV_STORE_ID);
const RUN_PULSE = has("pulse");
/**
 * `/api/*` and `/chat` on a deployed instance are guarded by
 * NOVA_STUDIO_TOKEN. UNSET MEANS OPEN — and open means anyone with the URL
 * can run the customer-turn workflow, which creates real orders in a real
 * store. This script therefore does not just authenticate; it REPORTS which
 * of the two states the deployment is in.
 */
const TOKEN = argOf("token", process.env.NOVA_STUDIO_TOKEN ?? null);
const authHeaders = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};

let failures = 0;
const ok = (label, detail = "") => console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
const bad = (label, detail = "") => {
  failures += 1;
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
};

async function get(path, timeoutMs = 20_000) {
  const res = await fetch(`${BASE}${path}`, { headers: authHeaders, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json — the raw text is the diagnostic */
  }
  return { status: res.status, json, text };
}

console.log(`\nnova-mastra live check`);
console.log(`  base:  ${BASE}`);
console.log(`  store: ${STORE ?? "(none given — pass --store <id>)"}\n`);

// ── 1. Is the service up at all? ──────────────────────────────────────────
console.log("[1] the service");
try {
  const health = await get("/health");
  if (health.status === 200) ok("GET /health", JSON.stringify(health.json ?? health.text).slice(0, 120));
  else bad("GET /health", `HTTP ${health.status} — ${health.text.slice(0, 160)}`);
} catch (err) {
  bad("GET /health", err instanceof Error ? err.message : String(err));
  console.log(
    `\n  Could not reach ${BASE} at all. If this is a sandboxed environment, the host\n` +
      `  may need adding to the network egress allowlist — the failure looks identical\n` +
      `  to the service being down.\n`,
  );
  process.exit(1);
}

// ── 2. Is the Mastra server mounted, with everything registered? ──────────
console.log("\n[2] what the deployment can do");
const EXPECTED_WORKFLOWS = [
  "customer-turn",
  "brain-dispatch",
  "brain-pulse",
  "brain-courier-intervention",
  "brain-restock-check",
];
try {
  const agents = await get("/api/agents");
  const names = Object.keys(agents.json ?? {});
  if (names.length > 0) ok(`agents registered`, names.join(", "));
  else bad("agents registered", `HTTP ${agents.status} — ${agents.text.slice(0, 160)}`);

  const workflows = await get("/api/workflows");
  const ids = Object.keys(workflows.json ?? {});
  for (const want of EXPECTED_WORKFLOWS) {
    if (ids.includes(want)) ok(`workflow ${want}`);
    else bad(`workflow ${want}`, "not registered on this deployment");
  }
  const extra = ids.filter((id) => !EXPECTED_WORKFLOWS.includes(id));
  if (extra.length) console.log(`  · also registered: ${extra.join(", ")}`);
} catch (err) {
  bad("Mastra server routes", err instanceof Error ? err.message : String(err));
}

// ── 3. The founder lane caveat, stated rather than discovered ─────────────
console.log("\n[3] the founder chat lane");
console.log("  ! NOT verifiable through the agent playground on this deployment.");
console.log("    The registered `nova` agent carries a base persona only; the real");
console.log("    per-turn instructions and tool selection live in the /chat route.");
console.log("    A 'hello' through the playground proves the model works and nothing");
console.log("    about cost or grounding.");

// ── 4. The pulse — opt-in, because it writes ──────────────────────────────
console.log("\n[4] the brain");
if (!STORE) {
  console.log("  · skipped — pass --store <id> to check a specific store");
} else if (!RUN_PULSE) {
  console.log(`  · skipped — brain-pulse WRITES (a report, possibly Decision cards, and`);
  console.log(`    always the pulse snapshot that makes the next hour quiet).`);
  console.log(`    Re-run with --pulse when you want it, on a store you are happy to`);
  console.log(`    put rows on:  npm run verify:live -- --store ${STORE} --pulse`);
} else {
  console.log(`  ⚠ running brain-pulse against ${STORE} — this WRITES to that store.`);
  try {
    const res = await fetch(`${BASE}/api/workflows/brain-pulse/start-async`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({ inputData: { storeId: STORE } }),
      signal: AbortSignal.timeout(180_000),
    });
    const body = await res.json().catch(() => null);
    const result = body?.result ?? {};
    if (res.status >= 400 || body?.status === "failed") {
      bad("brain-pulse", `HTTP ${res.status} — ${JSON.stringify(body).slice(0, 300)}`);
    } else {
      ok("brain-pulse ran", `status=${body?.status}`);
      console.log(`      model calls:  ${result.modelCalls}`);
      console.log(`      quiet:        ${result.quiet}`);
      console.log(`      departments:  ${JSON.stringify(result.departments ?? [])}`);
      console.log(`      findings:     ${(result.findings ?? []).length}`);
      for (const f of result.findings ?? []) console.log(`        · ${f.title} [${f.outcome}]`);
      console.log(`      blind spots:  ${(result.blindSpots ?? []).length}`);
      for (const b of result.blindSpots ?? []) console.log(`        · ${b.detail}`);
      console.log(`      sense reads that failed: ${(result.senseFailures ?? []).length}`);
      console.log(`      report filed: ${result.reportId ?? "none (quiet hour)"}`);
      console.log(
        `\n      Run it a SECOND time: a healthy pulse costs 0 model calls on the\n` +
          `      second pass, because an open problem is not news twice.`,
      );
    }
  } catch (err) {
    bad("brain-pulse", err instanceof Error ? err.message : String(err));
  }
}

console.log(`\n${"═".repeat(62)}`);
if (failures > 0) {
  console.log(`${failures} check(s) FAILED — paste this whole output back.`);
  process.exit(1);
}
console.log("All checks passed. Paste this whole output back.");
