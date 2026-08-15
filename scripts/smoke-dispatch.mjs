#!/usr/bin/env node
/**
 * Dispatcher drill (phase E unit 1) — proves the brain's heartbeat against the
 * LOCAL stack (postgres + dakio-api on :5001, seeded demo store), through the
 * REAL claim/lease contract rather than a demo backend:
 *
 *   0. seed, through dakio-api's own surfaces:
 *      · a `pulse` job DEF with cadence `* * * * *` → the server expands it into
 *        a real job row inside the claim transaction (job-defs expansion, the
 *        production path — there is no "create a job" route, and inventing one
 *        would test a surface nobody uses)
 *      · an unprocessed `message.received` inbox event on a real conversation →
 *        the server's own drain mints the `inbox_reply` row, with the payload a
 *        real one carries (conversationId, platform, messageIds)
 *   1. ONE dispatcher tick, programmatically (`runDispatchTick`) — no cron, no
 *      waiting. Assert both rows were CLAIMED WITH A LEASE TOKEN (captured off
 *      the complete/release calls: the token, not the id, is the fence), and
 *      that each was settled TRUTHFULLY:
 *        · pulse        → COMPLETED through the founder-plane runner (phase E
 *                         unit 2 built the lane). The drill reads the model-call
 *                         count off the tick report: on a store the pulse has
 *                         seen before, a quiet hour is ZERO.
 *        · inbox_reply  → COMPLETED if a model credential is present, RELEASED
 *                         with the writer's own error if not. Both are honest;
 *                         a completed job whose turn produced nothing is not.
 *   2. a SECOND tick does not re-claim a settled job — a completed row is done,
 *      and a released row is sitting on its backoff.
 *
 * Everything it writes, it deletes: the `* * * * *` job def especially, which
 * would otherwise mint a pulse row a minute forever in a dev database.
 *
 * Run:  node --import tsx scripts/smoke-dispatch.mjs
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
// The whole point of this drill: the REAL backend, the REAL lease contract.
process.env.NOVA_STORE_BACKEND = "dakio";

// ---- self-bootstrap under tsx (the src imports below are TypeScript) -------
// Probes a module with NO env capture, so nothing is frozen before `loadEnv`.
if (!process.env.SMOKE_DISPATCH_TSX) {
  const probe = await import("../src/store/duties.js").catch(() => null);
  if (!probe) {
    const r = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url)], {
      stdio: "inherit",
      cwd: ROOT,
      env: { ...process.env, SMOKE_DISPATCH_TSX: "1" },
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
const { runDispatchTick } = await import("../src/brain/dispatcher.js");
const { serviceTokenFor } = await import("../src/lib/service-token.js");
const { resetPulseState } = await import("../src/brain/pulse-state.js");

const STAMP = Date.now();
const CONV_ID = `nova-dispatch-smoke-${STAMP}`;
const MSG_ID = `nova-dispatch-msg-${STAMP}`;
const EVENT_DEDUPE = `nova-dispatch-evt-${STAMP}`;

const db = new pg.Client({ connectionString: DAKIO_DB_URL });

/**
 * Capture the (id, leaseToken, …) every settle call was made with, keeping the
 * real behaviour. This is how the drill proves the FENCE: a dispatcher that
 * settled by id alone would show an empty token here and still look fine on
 * every row in the database.
 */
const settles = { complete: [], release: [] };
function watchSettles() {
  const client = storeFor(STORE_ID);
  for (const [method, bucket] of [
    ["completeJob", settles.complete],
    ["releaseJob", settles.release],
  ]) {
    const original = client[method].bind(client);
    client[method] = (...args) => {
      bucket.push(args);
      return original(...args);
    };
  }
}

async function jobRows() {
  const { rows } = await db.query(
    `SELECT id, kind, status, attempts, "lastError", "dueAt", "leaseToken", "sessionId", payload
       FROM "NovaJob" WHERE "tenantId" = $1 AND kind IN ('pulse', 'inbox_reply', 'followup', 'restock_check')
      ORDER BY "createdAt" DESC LIMIT 20`,
    [STORE_ID],
  );
  return rows;
}

/**
 * The pulse job def as it was BEFORE the drill touched it, so cleanup restores
 * rather than deletes: on a store that already had a real pulse cadence,
 * dropping it would quietly stop that store's hourly watchdog.
 */
let priorPulseDef = null;

/** The `restock_wait` case this drill opens, so cleanup can remove it. */
let restockCaseId = null;

async function cleanup() {
  // The event-lane drill's own rows: the job, the report the lane may have
  // filed (keyed by the job's dedupeKey, which is how a re-leased rerun re-files
  // the same row), and the case itself.
  await db.query(`DELETE FROM "NovaJob" WHERE "tenantId" = $1 AND kind = 'restock_check' AND "dedupeKey" = $2`, [STORE_ID, `restock_check:${restockCaseId}`]).catch(() => {});
  await db.query(`DELETE FROM "NovaReport" WHERE "tenantId" = $1 AND "dedupeKey" = $2`, [STORE_ID, `restock_check:${restockCaseId}`]).catch(() => {});
  if (restockCaseId) {
    await db.query(`DELETE FROM "NovaCase" WHERE "tenantId" = $1 AND id = $2`, [STORE_ID, restockCaseId]).catch(() => {});
  }
  // The `* * * * *` def first — it is the one thing here that would keep
  // producing work after the drill exits.
  if (priorPulseDef) {
    await db
      .query(
        `UPDATE "NovaJobDef" SET cadence = $3, tz = $4, enabled = $5, config = $6::jsonb
           WHERE "tenantId" = $1 AND kind = $2`,
        [STORE_ID, "pulse", priorPulseDef.cadence, priorPulseDef.tz, priorPulseDef.enabled, JSON.stringify(priorPulseDef.config ?? {})],
      )
      .catch(() => {});
  } else {
    await db.query(`DELETE FROM "NovaJobDef" WHERE "tenantId" = $1 AND kind = 'pulse'`, [STORE_ID]).catch(() => {});
  }
  await db.query(`DELETE FROM "NovaJob" WHERE "tenantId" = $1 AND "dedupeKey" LIKE '%nova-dispatch-smoke-%'`, [STORE_ID]).catch(() => {});
  await db.query(`DELETE FROM "NovaJob" WHERE "tenantId" = $1 AND kind = 'pulse' AND "createdAt" > now() - interval '10 minutes'`, [STORE_ID]).catch(() => {});
  await db.query(`DELETE FROM "NovaInbox" WHERE "tenantId" = $1 AND "dedupeKey" = $2`, [STORE_ID, EVENT_DEDUPE]).catch(() => {});
  await db.query(`DELETE FROM "InboxMessage" WHERE "conversationId" = $1`, [CONV_ID]).catch(() => {});
  await db.query(`DELETE FROM "InboxConversation" WHERE id = $1`, [CONV_ID]).catch(() => {});
  await db.query(`DELETE FROM "NovaRun" WHERE "tenantId" = $1 AND "sessionId" LIKE 'job:%' AND "startedAt" > now() - interval '10 minutes'`, [STORE_ID]).catch(() => {});
  // The pulse lane now really runs during this drill, so its two side effects
  // are cleaned up here too: the report it may file, and the delta-store row it
  // writes (owned by nova-mastra, not dakio-api — see brain/pulse-state.ts).
  await db.query(`DELETE FROM "NovaReport" WHERE "tenantId" = $1 AND kind = 'pulse' AND "createdAt" > now() - interval '10 minutes'`, [STORE_ID]).catch(() => {});
  // The pulse drains unprocessed inbox events as plain bookkeeping (that is the
  // point — it used to be model steps). Put back the ones this drill's pulse
  // consumed, so a dev database is not quietly emptied by running a smoke test.
  await db
    .query(
      `UPDATE "NovaInbox" SET "processedAt" = NULL
        WHERE "tenantId" = $1 AND "processedAt" > now() - interval '10 minutes' AND "dedupeKey" <> $2`,
      [STORE_ID, EVENT_DEDUPE],
    )
    .catch(() => {});
  await resetPulseState(STORE_ID).catch(() => {});
}

try {
  const health = await fetch(`${DAKIO_URL}/api/health`).catch(() => null);
  assert(health?.ok, `dakio-api not reachable at ${DAKIO_URL} — start it (see scripts/local-stack.sh)`);
  await db.connect();
  await cleanup();

  console.log(`store ${STORE_ID} · model credential: ${HAS_MODEL ? "present" : "ABSENT (the writer will fail — expected)"}\n`);

  // ---- 0. seed, through the real surfaces ---------------------------------

  // (a) the founder-plane row, via the job-def expansion the server owns.
  const { rows: priorDefs } = await db.query(
    `SELECT cadence, tz, enabled, config FROM "NovaJobDef" WHERE "tenantId" = $1 AND kind = 'pulse'`,
    [STORE_ID],
  );
  priorPulseDef = priorDefs[0] ?? null;
  const defRes = await fetch(`${DAKIO_URL}/api/v1/agent-data/job-defs/pulse`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${serviceTokenFor(STORE_ID)}` },
    body: JSON.stringify({ cadence: "* * * * *", tz: "UTC", enabled: true, config: {} }),
  });
  assert(defRes.ok, `PUT /job-defs/pulse failed: ${defRes.status} ${await defRes.text()}`);
  ok("seeded a pulse job def (cadence * * * * *) through the service-token API");

  // (b) the conversation-bound row, via an unprocessed inbox event. The drain
  //     has an age gate (DRAIN_AFTER_MS = 60s: a younger event is still the
  //     live lane's to deliver), so the event is backdated five minutes — the
  //     same shape a real delivery failure leaves behind.
  await db.query(
    `INSERT INTO "InboxConversation" (id, "tenantId", platform, "senderId", "senderName", "novaSessionEpoch", "windowExpiresAt", "lastMessageAt", "lastInboundAt")
     VALUES ($1, $2, 'messenger', 'dispatch-psid-1', 'Dispatch Smoke', 0, now() + interval '12 hours', now(), now())
     ON CONFLICT (id) DO UPDATE SET "tenantId" = EXCLUDED."tenantId"`,
    [CONV_ID, STORE_ID],
  );
  await db.query(
    `INSERT INTO "InboxMessage" (id, "conversationId", direction, text, "sentAt")
     VALUES ($1, $2, 'in', 'apu eta ki ache?', now() - interval '5 minutes')
     ON CONFLICT (id) DO NOTHING`,
    [MSG_ID, CONV_ID],
  );
  await db.query(
    `INSERT INTO "NovaInbox" (id, "tenantId", "eventType", payload, "receivedAt", "processedAt", "dedupeKey")
     VALUES ($1, $2, 'message.received', $3::jsonb, now() - interval '5 minutes', NULL, $4)
     ON CONFLICT ("dedupeKey") DO NOTHING`,
    [
      `evt-${STAMP}`,
      STORE_ID,
      JSON.stringify({ conversationId: CONV_ID, messageId: MSG_ID, platform: "messenger" }),
      EVENT_DEDUPE,
    ],
  );
  ok("seeded an unprocessed message.received event (backdated past the drain's age gate)");

  // (c) a promise-backed follow-up whose DEBT IS GONE — the one path that
  //     completes without a model, and the reason the drill can prove "a
  //     completed job is not re-claimed" at all.
  //
  //     Inserted directly, and that is not a shortcut around a route: dakio-api
  //     has NO create-a-job endpoint. Promise follow-ups are enqueued inside
  //     the reply transaction that made the promise, so a drill cannot ask for
  //     one without first sending a customer a message. The row below is
  //     byte-shaped like the one that producer writes.
  await db.query(
    `INSERT INTO "NovaJob" (id, "tenantId", kind, payload, "dueAt", priority, status, "dedupeKey", department)
     VALUES ($1, $2, 'followup', $3::jsonb, now() - interval '1 minute', 3, 'due', $4, 'support')
     ON CONFLICT ("tenantId", "dedupeKey") DO NOTHING`,
    [
      `job-followup-${STAMP}`,
      STORE_ID,
      JSON.stringify({ conversationId: CONV_ID, promiseId: `prom-gone-${STAMP}`, triggeredBy: "promise" }),
      `followup:nova-dispatch-smoke-${STAMP}`,
    ],
  );
  ok("seeded a promise-backed follow-up whose promise was never on the ledger");

  // (d) ONE OF THE TWO EVENT LANES, END TO END — `restock_check`.
  //
  //     The case is opened through the REAL service surface (the same
  //     `POST /api/v1/inbox/cases` the front office calls), so the lane reads a
  //     row dakio-api actually wrote — kind, department and the join key
  //     included.
  //
  //     The JOB row is inserted directly, and that is not a shortcut around a
  //     route: `mintRestockCheckJob` is the only producer and it is behind
  //     `NOVA_RESTOCK_CHECK_PRODUCER`, which ships OFF and stays off until this
  //     lane is proven — which is what this drill is for. The row below is
  //     byte-shaped like the one that producer writes (same kind, priority,
  //     dedupeKey and payload), so what runs here is what will run when the
  //     flag flips.
  // Stock lives on ProductVariant/Inventory in dakio-api, not on Product — the
  // lane reads it through the store client, so the drill only needs an id.
  const { rows: productRows } = await db.query(
    `SELECT id, name FROM "Product" WHERE "tenantId" = $1 ORDER BY "createdAt" ASC LIMIT 1`,
    [STORE_ID],
  );
  const product = productRows[0] ?? null;
  const store = storeFor(STORE_ID);
  const opened = await store.openCase({
    kind: "restock_wait",
    conversationId: CONV_ID,
    ...(product ? { productId: product.id } : {}),
    title: `Waiting for ${product?.name ?? "a product"} to come back`,
    factsNote: "Dispatch smoke: customer asked when this comes back in stock.",
  });
  restockCaseId = opened.case.id;
  await db.query(
    `INSERT INTO "NovaJob" (id, "tenantId", kind, payload, "dueAt", priority, status, "dedupeKey", department)
     VALUES ($1, $2, 'restock_check', $3::jsonb, now() - interval '1 minute', 5, 'due', $4, 'inventory')
     ON CONFLICT ("tenantId", "dedupeKey") DO NOTHING`,
    [
      `job-restock-${STAMP}`,
      STORE_ID,
      JSON.stringify({
        caseId: restockCaseId,
        productId: product?.id ?? null,
        conversationId: CONV_ID,
        customerId: null,
        triggeredBy: "case.opened",
      }),
      `restock_check:${restockCaseId}`,
    ],
  );
  ok(`seeded a restock_wait case (${restockCaseId}) and the restock_check row its producer would mint`);

  // ---- 1. ONE tick --------------------------------------------------------

  watchSettles();
  const tick1 = await runDispatchTick({ tenantIds: [STORE_ID] });
  console.log(`\ntick 1 → ${JSON.stringify({ ...tick1, jobs: undefined })}`);
  for (const j of tick1.jobs) console.log(`   ${j.kind.padEnd(12)} ${j.lane.padEnd(14)} ${j.settled}${j.error ? ` — ${j.error.slice(0, 120)}` : ""}`);

  assert(
    tick1.claimed >= 4,
    `expected the pulse, the inbox_reply, the follow-up and the restock_check to be claimed, got ${tick1.claimed}`,
  );
  ok(`one tick claimed ${tick1.claimed} job(s) for one tenant, through that tenant's own service token`);

  // THE FENCE. Every settle call carried the token minted for THAT lease.
  const allSettles = [...settles.complete, ...settles.release];
  assert(allSettles.length === tick1.claimed, `every claimed job settled exactly once (${allSettles.length} vs ${tick1.claimed})`);
  for (const [id, token] of allSettles) {
    assert(typeof token === "string" && token.length > 0, `job ${id} settled without a lease token — the id alone is not the fence`);
  }
  ok(`every claimed job carried a leaseToken into complete/release (${allSettles.length} settles)`);

  const pulse = tick1.jobs.find((j) => j.kind === "pulse");
  assert(pulse, "the pulse row was claimed");
  assert(pulse.lane === "founder_plane", `the pulse routes to the founder plane (got ${pulse.lane})`);
  assert(
    pulse.settled === "completed",
    `the pulse lane is BUILT (phase E unit 2), so it runs and completes (got ${pulse.settled}: ${pulse.error})`,
  );
  assert(typeof pulse.modelCalls === "number", "and the tick report carries what it cost");
  ok(`founder-plane pulse: ran through the lane runner and completed — ${pulse.modelCalls} model call(s)`);

  const reply = tick1.jobs.find((j) => j.kind === "inbox_reply");
  assert(reply, "the drain minted an inbox_reply row and the dispatcher claimed it");
  assert(reply.lane === "customer_turn", `the inbox_reply routed to the customer turn (got ${reply.lane})`);
  if (HAS_MODEL) {
    assert(reply.settled === "completed", `with a model credential the turn should complete (got ${reply.settled}: ${reply.error})`);
    ok("conversation-bound inbox_reply: routed to the customer thread, turn ran, job completed");
  } else {
    assert(reply.settled === "released", `without a model credential the turn cannot draft — it must RELEASE (got ${reply.settled})`);
    assert(/produced no reply/.test(reply.error ?? ""), `and name the failure: ${reply.error}`);
    ok("conversation-bound inbox_reply: writer down → RELEASED with the error, never falsely completed");
  }

  const followup = tick1.jobs.find((j) => j.kind === "followup");
  assert(followup, "the promise-backed follow-up was claimed");
  assert(
    followup.settled === "completed" && followup.lane === "none",
    `a follow-up whose debt is gone does nothing and completes cleanly — no turn, no apology for a promise the ` +
      `customer never received (got ${followup.lane}/${followup.settled}${followup.error ? `: ${followup.error}` : ""}` +
      `; if this store holds 50+ open promises the pre-check deliberately fails safe to "still open")`,
  );
  ok("promise-backed follow-up with a settled debt: no turn at all, completed truthfully");

  // ── The event lane, against the real stack ────────────────────────────────
  //
  // This is the half the two dark lanes never had: a row of one of their kinds,
  // claimed and RUN, instead of released as `lane_not_built`. What it proves is
  // narrow and load-bearing — the router sends the kind to a runner, the runner
  // reads real dakio-api rows through the service token, and the answer lands
  // where the customer's reply is composed from (the case), at zero model cost.
  const restock = tick1.jobs.find((j) => j.kind === "restock_check");
  assert(restock, "the restock_check row was claimed");
  assert(
    restock.lane === "founder_plane",
    `restock_check routes to a BUILT founder-plane lane, not lane_not_built (got ${restock.lane}: ${restock.error})`,
  );
  assert(restock.settled === "completed", `and it completed (got ${restock.settled}: ${restock.error})`);
  assert(restock.modelCalls === 0, `an honest supply answer costs nothing (got ${restock.modelCalls} model calls)`);
  ok(`founder-plane restock_check: ran through the lane runner and completed — ${restock.modelCalls} model calls`);

  // The answer is ON THE CASE, in facts, where `case_update` composes from.
  const caseRow = await store.getCase(restockCaseId);
  const supplyFacts = (caseRow?.facts ?? []).filter((f) => f.source === "nova:restock_check");
  assert(supplyFacts.length === 1, `the supply position was written onto the case once (got ${supplyFacts.length})`);
  const note = supplyFacts[0].note;
  const onOrder = /units are on order/.test(note);
  assert(
    onOrder || !/\d{4}-\d{2}-\d{2}|next week/i.test(note),
    `THE HONESTY FORK: nothing on order means NO date — got "${note}"`,
  );
  ok(`the supply position is on the case, and it ${onOrder ? "quotes a real purchase order" : "gives no date it could not check"}: "${note.slice(0, 110)}"`);

  // The rows agree with the report.
  const rows1 = await jobRows();
  const pulseRow = rows1.find((r) => r.id === pulse.jobId);
  assert(pulseRow.status === "done", `the completed pulse row is done (${pulseRow.status}/${pulseRow.attempts})`);
  ok("dakio-api's own row agrees: the pulse job is done, not re-dued");

  const replyRow = rows1.find((r) => r.id === reply.jobId);
  assert(replyRow.payload?.conversationId === CONV_ID, "the server's drain wrote the conversationId the router keyed on (ids only)");
  if (HAS_MODEL) {
    assert(replyRow.status === "done", `completed job row is done (got ${replyRow.status})`);
    assert(replyRow.sessionId === `job:${reply.jobId}`, `and carries the session id that joins it to its NovaRun (got ${replyRow.sessionId})`);
  }

  // The audit half of the phase gate.
  const { rows: runRows } = await db.query(
    `SELECT "turnId", kind, lane, outcome, "jobId" FROM "NovaRun"
      WHERE "tenantId" = $1 AND "jobId" = $2`,
    [STORE_ID, reply.jobId],
  );
  assert(runRows.length >= 1, "the job turn landed as a NovaRun row (joined by jobId at turn start)");
  assert(runRows[0].kind === "job_turn" && runRows[0].lane === "customer", `run row shape: ${JSON.stringify(runRows[0])}`);
  ok(`NovaRun audit written: ${runRows[0].kind}/${runRows[0].lane} → ${runRows[0].outcome}`);

  // ---- 2. a second tick must not re-claim settled work ---------------------

  settles.complete.length = 0;
  settles.release.length = 0;
  const tick2 = await runDispatchTick({ tenantIds: [STORE_ID] });
  console.log(`\ntick 2 → ${JSON.stringify({ ...tick2, jobs: undefined })}`);
  const settledIds = new Set([pulse.jobId, reply.jobId, followup.jobId]);
  const reclaimed = tick2.jobs.filter((j) => settledIds.has(j.jobId));
  assert(
    reclaimed.length === 0,
    `a second tick re-claimed settled work: ${reclaimed.map((j) => `${j.kind}:${j.jobId}`).join(", ")}`,
  );
  const followupRow = (await jobRows()).find((r) => r.id === followup.jobId);
  assert(followupRow.status === "done", `the completed follow-up row stays done (got ${followupRow.status})`);
  ok("a second tick re-claims neither the COMPLETED follow-up nor the backed-off released rows");
  if (tick2.claimed > 0) {
    console.log(`   (tick 2 claimed ${tick2.claimed} other row(s) — the minute rolled and the def expanded a new occurrence)`);
  }

  console.log(`\n${passed} checks passed — the heartbeat claims, routes and settles truthfully.`);
} finally {
  await cleanup().catch(() => {});
  await db.end().catch(() => {});
}
