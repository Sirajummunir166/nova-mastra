#!/usr/bin/env node
/**
 * Pulse drill (phase E unit 2) — the cost claim, measured against the LOCAL
 * stack (postgres + dakio-api on :5001, seeded demo store) through the REAL
 * StoreClient, not a demo backend.
 *
 * THE DELIVERABLE IS A NUMBER: the model-call count per run.
 *
 *   run 1  first sight of this store — establishes the snapshot. Whatever it
 *          finds, it pays for once.
 *   run 2  nothing touched. MUST be quiet and MUST cost ZERO model calls.
 *          Under eve this same hour was a full ~26K-token agent turn.
 *   run 3  one real mutation through dakio-api's own PATCH /products route,
 *          then a pulse: it must notice EXACTLY that and nothing else.
 *   run 4  nothing touched again. Back to zero — the new condition is open, so
 *          it is not news twice.
 *
 * The counter wraps `pulseJudgeAgent.generate`, so it counts REAL calls to the
 * gateway when a credential is present (and still counts the attempts when the
 * gateway is down — a failed judge does not silence the watchdog, it degrades
 * to the measurement).
 *
 * Everything it changes, it changes back: the product's price, and the
 * `processedAt` on any inbox events the pulse drained. The `nova_pulse_state`
 * row and the reports this drill files are deleted at the end.
 *
 * Run:  node --import tsx scripts/smoke-pulse.mjs
 * (The script re-executes itself under tsx when launched with plain node.)
 *
 * Prereqs: `service postgresql start`, dakio-api on :5001, and nova-mastra/.env
 * carrying DAKIO_API_URL / NOVA_SERVICE_SECRET / NOVA_DEV_STORE_ID
 * (scripts/local-stack.sh sets all three up).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import pg from "pg";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---- env FIRST, then the tsx bootstrap ------------------------------------
//
// ORDER MATTERS AND IT BIT US: several src modules capture `NOVA_PG_URL` at
// MODULE LOAD (`brain/pulse-state.ts`, `front-office/context-store.ts`). The
// bootstrap probe below imports src code, so a probe that ran before `.env` was
// loaded would freeze those modules on the FILE backend — the drill would pass
// while silently exercising the wrong half of the persistence seam.
function loadEnv() {
  try {
    for (const line of readFileSync(join(ROOT, ".env"), "utf8").split("\n")) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
    }
  } catch {
    /* rely on process env */
  }
}
loadEnv();
// The whole point of this drill: the REAL backend, the REAL reads.
process.env.NOVA_STORE_BACKEND = "dakio";

// ---- self-bootstrap under tsx (the src imports below are TypeScript) -------
// Probes a module with NO env capture, so nothing is frozen before `loadEnv`.
if (!process.env.SMOKE_PULSE_TSX) {
  const probe = await import("../src/store/duties.js").catch(() => null);
  if (!probe) {
    const r = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url)], {
      stdio: "inherit",
      cwd: ROOT,
      env: { ...process.env, SMOKE_PULSE_TSX: "1" },
    });
    process.exit(r.status ?? 1);
  }
}

const STORE_ID = process.env.NOVA_DEV_STORE_ID;
const DAKIO_URL = process.env.DAKIO_API_URL ?? "http://localhost:5001";
const DAKIO_DB_URL = process.env.DAKIO_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/dakio_db";
const HAS_MODEL = Boolean(process.env.AI_GATEWAY_API_KEY);

let passed = 0;
function fail(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}
function ok(msg) {
  passed += 1;
  console.log(`✓ ${msg}`);
}
function assert(cond, msg) {
  if (!cond) fail(msg);
}

if (!STORE_ID) fail("NOVA_DEV_STORE_ID missing (run scripts/local-stack.sh first)");

const { storeFor } = await import("../src/store/resolve.js");
const { runPulse, pulseJudgeAgent } = await import("../src/brain/pulse.js");
const { resetPulseState, loadPulseState } = await import("../src/brain/pulse-state.js");
const { senseStore, senseFailures } = await import("../src/lib/snapshot.js");

const db = new pg.Client({ connectionString: DAKIO_DB_URL });
const client = storeFor(STORE_ID);

/**
 * THE INSTRUMENT. Wraps the judge's own `generate`, so what is counted is a
 * real call to a real model — not a stub standing in for one.
 */
let modelCalls = 0;
{
  const original = pulseJudgeAgent.generate.bind(pulseJudgeAgent);
  pulseJudgeAgent.generate = (...args) => {
    modelCalls += 1;
    return original(...args);
  };
}

async function pulse(label) {
  const before = modelCalls;
  const t0 = Date.now();
  const result = await runPulse(STORE_ID, { jobId: `drill-${label}` });
  const observed = modelCalls - before;
  console.log(
    `\n── ${label} ─────────────────────────────────────────────────────────\n` +
      `   MODEL CALLS: ${observed}   (the lane's own count: ${result.modelCalls})\n` +
      `   quiet: ${result.quiet} · findings: ${result.findings.length} · departments: [${result.departments.join(", ")}]\n` +
      `   events drained: ${result.eventsProcessed} · snapshot written: ${result.snapshotWritten} · ${Date.now() - t0}ms`,
  );
  for (const f of result.findings) {
    console.log(`   • [${f.finding.severity}] ${f.finding.title}`);
    console.log(`     ${f.finding.observation.evidence}`);
    console.log(`     → ${f.outcome.kind}${f.outcome.kind === "capability_gap" ? ` (needs ${f.outcome.gap.wantedDuty})` : ""}`);
  }
  if (result.senseFailures.length > 0) console.log(`   blind: ${result.senseFailures.join("; ")}`);
  assert(observed === result.modelCalls, `the lane's reported modelCalls (${result.modelCalls}) must match the real calls (${observed})`);
  return { result, observed };
}

/** The product the drill mutates, and its original price. */
let target = null;
/** Inbox events the pulse drained, so `processedAt` can be put back. */
let drainedEventIds = [];

async function cleanup() {
  if (target) {
    await client.updateProduct(target.id, { price: target.price }).catch(() => {});
  }
  await resetPulseState(STORE_ID).catch(() => {});
  await db
    .query(
      `DELETE FROM "NovaReport" WHERE "tenantId" = $1 AND kind = 'pulse' AND "createdAt" > now() - interval '30 minutes'`,
      [STORE_ID],
    )
    .catch(() => {});
  if (drainedEventIds.length > 0) {
    await db
      .query(`UPDATE "NovaInbox" SET "processedAt" = NULL WHERE "tenantId" = $1 AND id = ANY($2::text[])`, [
        STORE_ID,
        drainedEventIds,
      ])
      .catch(() => {});
  }
}

try {
  const health = await fetch(`${DAKIO_URL}/api/health`).catch(() => null);
  assert(health?.ok, `dakio-api not reachable at ${DAKIO_URL} — start it (see scripts/local-stack.sh)`);
  await db.connect();
  await cleanup();

  console.log(`store ${STORE_ID} · model credential: ${HAS_MODEL ? "present" : "ABSENT (judge calls will fail — still counted)"}`);

  // ---- What this store can actually be sensed for -------------------------
  //
  // Printed first because it is the honest frame for everything below: the four
  // domains this layer senses, and which of them this tenant has data for.
  const opening = await senseStore(STORE_ID);
  drainedEventIds = opening.inbox.ok ? opening.inbox.value.map((e) => e.id) : [];
  const products = opening.products.ok ? opening.products.value : [];
  console.log(
    `\nSENSE: products ${opening.products.ok ? products.length : "UNREADABLE"} · ` +
      `sales7d ${opening.sales.ok ? opening.sales.value.revenue7d : "UNREADABLE"} vs prior ${opening.sales.ok ? opening.sales.value.revenuePrior7d : "?"} · ` +
      `carts ${opening.carts.ok ? opening.carts.value.count : "UNREADABLE"} · ` +
      `suppliers ${opening.suppliers.ok ? opening.suppliers.value.length : "UNREADABLE"} · ` +
      `unprocessed events ${opening.inbox.ok ? opening.inbox.value.length : "UNREADABLE"}`,
  );
  assert(senseFailures(opening).length === 0, `every sense read answered: ${senseFailures(opening).join("; ")}`);
  ok("the sense layer read all five sources off the live backend");
  const withVelocity = products.filter((p) => p.velocity !== null).length;
  console.log(
    `   velocity known for ${withVelocity}/${products.length} products — dakio-api answers ` +
      `weeklyVelocity: [] ("gap: derivable from OrderItem history"), so days-of-cover and dead stock ` +
      `CANNOT fire on a live tenant. Unknown is carried as null, never as 0.`,
  );

  // ---- run 1: first sight -------------------------------------------------
  const first = await pulse("run 1 · first sight (no stored snapshot)");
  const snapshot = await loadPulseState(STORE_ID);
  assert(snapshot, "run 1 wrote the snapshot");
  ok(`run 1 established the snapshot (${Object.keys(snapshot.products ?? {}).length} products, cursor ${snapshot.inboxCursor ?? "none"})`);

  // ---- run 2: THE HEADLINE ------------------------------------------------
  const quiet = await pulse("run 2 · nothing changed");
  assert(quiet.observed === 0, `A QUIET PULSE MUST COST ZERO MODEL CALLS — got ${quiet.observed}`);
  assert(quiet.result.quiet, "and it must report itself quiet");
  assert(quiet.result.findings.length === 0, "with no findings");
  assert(!quiet.result.reportId, "and no report: a report about a quiet hour is spam");
  assert(quiet.result.snapshotWritten, "while still writing its snapshot, which keeps the NEXT hour cheap");
  ok("run 2: ZERO model calls, no report, snapshot refreshed — the cost this migration exists to kill");

  // ---- run 3: one real mutation ------------------------------------------
  //
  // A price change through dakio-api's own PATCH route, chosen because it is a
  // domain this tenant genuinely has data for (cost and price are real; the
  // velocity/lead-time inputs are not — see the SENSE line above). Priced just
  // above cost, it drops through the 25% margin floor.
  const candidate = products.find((p) => p.cost > 0 && p.marginPct !== null && p.marginPct >= 25);
  assert(candidate, "the seeded store has a product with a real cost and a healthy margin to break");
  target = { id: candidate.id, price: candidate.price, name: candidate.name };
  const brokenPrice = Math.max(1, Math.round(candidate.cost * 1.1)); // ~9% margin
  await client.updateProduct(candidate.id, { price: brokenPrice });
  console.log(
    `\nMUTATION: ${candidate.name} — price ৳${candidate.price} → ৳${brokenPrice} ` +
      `(cost ৳${candidate.cost}: margin ${candidate.marginPct.toFixed(1)}% → ~9%), through PATCH /api/v1/store/products/:id`,
  );

  const changed = await pulse("run 3 · one product repriced under the margin floor");
  assert(changed.result.findings.length === 1, `the pulse must notice exactly the one thing that moved (got ${changed.result.findings.length})`);
  const finding = changed.result.findings[0];
  assert(finding.finding.domain === "margin", `and name the domain it came from (got ${finding.finding.domain})`);
  assert(finding.finding.subject === candidate.id, `on the product that was actually changed (got ${finding.finding.subject})`);
  assert(changed.result.departments.length === 1 && changed.result.departments[0] === "finance", `waking one department, not nine (got [${changed.result.departments.join(", ")}])`);
  assert(changed.observed === 1, `one moved department = ONE judgement call (got ${changed.observed})`);
  ok(`run 3: 1 model call, 1 finding, 1 department — "${finding.finding.observation.evidence}"`);

  // The act path: the remedy for a thin margin is `update_price` under
  // `finance.expense_flagging`, which this lane does not hold. It surfaces.
  assert(changed.result.capabilityGaps.length === 1, "the remedy is out of lane, so it surfaces as a capability gap");
  assert(
    changed.result.capabilityGaps[0].wantedDuty === "finance.expense_flagging",
    `naming the duty it would need (got ${changed.result.capabilityGaps[0].wantedDuty})`,
  );
  const actions = await client.listActions();
  assert(
    !actions.some((a) => String(a.payload?.novaActionId ?? "").startsWith("nm:pulse:")),
    "and NOTHING was filed under a duty the lane does not hold",
  );
  ok("run 3: the remedy needed `finance.expense_flagging` — surfaced, not acted on, nothing filed");

  const report = (await client.listReports({ kind: "pulse", limit: 1 }))[0];
  assert(report, "one consolidated report was filed");
  assert(/Not checked: ads, courier, support/.test(report.body), "and it states what Nova never looked at");
  ok(`run 3: ONE report filed (${report.id}), naming the three domains Nova makes no claim about`);

  // ---- run 4: back to quiet ----------------------------------------------
  const again = await pulse("run 4 · nothing changed again");
  assert(again.observed === 0, `an OPEN condition is not news twice — expected 0 model calls, got ${again.observed}`);
  assert(again.result.quiet, "the pulse is quiet again with the problem still open");
  ok("run 4: ZERO model calls — the same problem does not bill the founder every hour");

  console.log(
    `\n${passed} checks passed.\n\n` +
      `  MODEL CALLS PER RUN:  run1 ${first.observed} · run2 ${quiet.observed} · run3 ${changed.observed} · run4 ${again.observed}\n` +
      `  Under eve each of those four hours was one full agent turn (~26K tokens) whatever it found.\n`,
  );
} finally {
  await cleanup().catch(() => {});
  await db.end().catch(() => {});
}
