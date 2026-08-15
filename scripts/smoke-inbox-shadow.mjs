#!/usr/bin/env node
/**
 * Shadow-ingress drill (phase C unit 1) — proves the dakio-api → nova-mastra
 * wire contract and the observe-only shadow turn against the LOCAL stack
 * (postgres + dakio-api on :5001 + nova-mastra on :2100, see local-stack.sh):
 *
 *   1. correct HMAC            → 202, and a nova_shadow_turns row appears with
 *                                the pipeline verdict (intent/rung/action; the
 *                                draft, or the recorded model failure when no
 *                                AI_GATEWAY_API_KEY is present)
 *   2. wrong signature         → 401
 *   3. replayed timestamp/body → 409 duplicate
 *   4. stale timestamp (>5min) → 401 (freshness is bound into the MAC)
 *   5. dakio-api session roll (higher epoch) → a FRESH nova_conversation_state
 *      row for the new epoch; the old epoch's row stays byte-identical
 *
 * The drill seeds its own InboxConversation/InboxMessage rows in dakio-api's
 * database (the ingress reads message text back through dakio-api's
 * service-token API, same as nova-ai's get_conversation) and rolls the epoch
 * by writing novaSessionEpoch — which IS dakio-api's session roll mechanism.
 *
 * Run:  node scripts/smoke-inbox-shadow.mjs
 */

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---- env -------------------------------------------------------------------

function loadEnv() {
  const env = { ...process.env };
  try {
    for (const line of readFileSync(join(ROOT, ".env"), "utf8").split("\n")) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m && !(m[1] in process.env)) env[m[1]] = m[2].replace(/^"|"$/g, "");
    }
  } catch {
    /* no .env — rely on process env */
  }
  return env;
}

const env = loadEnv();
const NOVA_URL = env.SMOKE_NOVA_URL ?? `http://localhost:${env.PORT ?? 2100}`;
const SECRET = env.NOVA_INBOX_SHARED_SECRET;
const STORE_ID = env.NOVA_DEV_STORE_ID;
const NOVA_PG_URL = env.NOVA_PG_URL;
const DAKIO_DB_URL = env.DAKIO_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/dakio_db";

if (!SECRET) fail("NOVA_INBOX_SHARED_SECRET missing (set it in nova-mastra/.env — must equal dakio-api's)");
if (!STORE_ID) fail("NOVA_DEV_STORE_ID missing (run scripts/local-stack.sh first)");
if (!NOVA_PG_URL) fail("NOVA_PG_URL missing — the shadow drill asserts on the pg dataset");

// Fresh id per run: the running server's in-process context cache is keyed by
// conversation, so reusing an id across runs would leak state (and versions)
// between drills. Prior runs' rows are swept at seed time.
const CONV_ID = `nova-shadow-smoke-${Date.now()}`;
const MSG_1 = `${CONV_ID}-msg-1`;
const MSG_2 = `${CONV_ID}-msg-2`;

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- wire helpers ----------------------------------------------------------

function signedHeaders(rawBody, { timestamp = new Date().toISOString(), signature } = {}) {
  return {
    "content-type": "application/json",
    "x-nova-timestamp": timestamp,
    "x-nova-signature": signature ?? createHmac("sha256", SECRET).update(`${timestamp}.${rawBody}`).digest("hex"),
  };
}

async function deliver(messageIds, opts = {}) {
  const rawBody = JSON.stringify({ storeId: STORE_ID, conversationId: CONV_ID, platform: "messenger", messageIds });
  const res = await fetch(`${NOVA_URL}/customer/message`, {
    method: "POST",
    headers: signedHeaders(rawBody, opts),
    body: rawBody,
  });
  return { res, rawBody, timestamp: opts.timestamp };
}

async function pollShadowRow(novaDb, epoch, sinceId) {
  for (let i = 0; i < 60; i++) {
    const { rows } = await novaDb.query(
      `SELECT * FROM nova_shadow_turns
        WHERE conversation_id = $1 AND epoch = $2 AND id > $3
        ORDER BY id DESC LIMIT 1`,
      [CONV_ID, epoch, sinceId],
    );
    if (rows[0]) return rows[0];
    await sleep(500);
  }
  return null;
}

// ---- drill -----------------------------------------------------------------

const dakioDb = new pg.Client({ connectionString: DAKIO_DB_URL });
const novaDb = new pg.Client({ connectionString: NOVA_PG_URL });

try {
  // 0a. stack up?
  const health = await fetch(`${NOVA_URL}/health`).catch(() => null);
  assert(health?.ok, `nova-mastra not reachable at ${NOVA_URL} — start it (npm run start) with NOVA_INBOX_SHARED_SECRET set`);
  const api = await fetch("http://localhost:5001/api/health").catch(() => null);
  assert(api?.ok, "dakio-api not reachable on :5001 — run scripts/local-stack.sh");

  await dakioDb.connect();
  await novaDb.connect();

  // 0b. sweep previous drill runs, then seed the conversation + inbound
  // messages in dakio-api's own tables (message rows cascade on delete).
  await dakioDb.query(`DELETE FROM "InboxConversation" WHERE id LIKE 'nova-shadow-smoke-%'`);
  await novaDb.query(`DELETE FROM nova_shadow_turns WHERE conversation_id LIKE 'nova-shadow-smoke-%'`).catch(() => {});
  await novaDb
    .query(`DELETE FROM nova_conversation_state WHERE conversation_id LIKE 'nova-shadow-smoke-%'`)
    .catch(() => {});
  await dakioDb.query(
    `INSERT INTO "InboxConversation" (id, "tenantId", platform, "senderId", "senderName", "novaSessionEpoch")
     VALUES ($1, $2, 'messenger', 'smoke-psid-1', 'Shadow Smoke', 0)
     ON CONFLICT (id) DO UPDATE SET "tenantId" = EXCLUDED."tenantId", "novaSessionEpoch" = 0`,
    [CONV_ID, STORE_ID],
  );
  for (const [id, text] of [
    [MSG_1, "hi"],
    [MSG_2, "hi"],
  ]) {
    await dakioDb.query(
      `INSERT INTO "InboxMessage" (id, "conversationId", direction, text, "sentAt")
       VALUES ($1, $2, 'in', $3, now())
       ON CONFLICT (id) DO UPDATE SET text = EXCLUDED.text`,
      [id, CONV_ID, text],
    );
  }
  const { rows: maxRows } = await novaDb
    .query(`SELECT COALESCE(MAX(id), 0) AS max FROM nova_shadow_turns`)
    .catch(() => ({ rows: [{ max: 0 }] }));
  let sinceId = Number(maxRows[0].max);
  console.log(`seeded ${CONV_ID} for store ${STORE_ID}\n`);

  // 1. correct HMAC → 202, shadow row recorded
  {
    const { res } = await deliver([MSG_1]);
    if (res.status !== 202) fail(`case 1: expected 202, got ${res.status} ${await res.text()}`);
    const body = await res.json();
    assert(body.status === "accepted", `case 1: expected status accepted, got ${JSON.stringify(body)}`);
    ok("case 1a: correct HMAC → 202 accepted");

    const row = await pollShadowRow(novaDb, 0, sinceId);
    assert(row, "case 1: no nova_shadow_turns row appeared within 30s");
    sinceId = Number(row.id);
    assert(row.store_id === STORE_ID, `case 1: row.store_id ${row.store_id}`);
    assert(row.inbound_text === "hi", `case 1: inbound_text ${JSON.stringify(row.inbound_text)}`);
    assert(row.intent === "greeting", `case 1: intent ${row.intent} (expected greeting — L0 rules)`);
    assert(row.rung === 0, `case 1: rung ${row.rung} (expected 0 — no model needed to classify)`);
    assert(row.action === "GREET", `case 1: action ${row.action}`);
    const modelFailure = row.would_have_done?.modelFailure;
    assert(
      (row.draft_reply && row.draft_reply.length > 0) || modelFailure,
      "case 1: expected a draft reply OR a recorded modelFailure (modelless env)",
    );
    ok(
      row.draft_reply
        ? `case 1b: shadow row has draft (${row.draft_reply.length} chars), intent=greeting rung=0`
        : `case 1b: shadow row recorded modelless verdict (intent=greeting rung=0, writer failure noted: ${String(modelFailure).slice(0, 80)}…)`,
    );
    const { rows: state } = await novaDb.query(
      `SELECT state FROM nova_conversation_state WHERE store_id=$1 AND conversation_id=$2 AND epoch=0`,
      [STORE_ID, CONV_ID],
    );
    assert(state.length === 1, "case 1: expected a nova_conversation_state row for epoch 0");
    ok("case 1c: conversation state persisted to pg under epoch 0");
  }

  // 2. wrong signature → 401
  {
    const { res } = await deliver([MSG_1], { signature: "0".repeat(64) });
    assert(res.status === 401, `case 2: expected 401, got ${res.status}`);
    ok("case 2: wrong signature → 401");
  }

  // 3. replayed timestamp/body → 409
  {
    const timestamp = new Date().toISOString();
    const first = await deliver([MSG_1], { timestamp });
    assert(first.res.status === 202, `case 3: first delivery expected 202, got ${first.res.status}`);
    // wait out the in-flight guard so the replay hits the DUPLICATE arm, not busy
    const row = await pollShadowRow(novaDb, 0, sinceId);
    assert(row, "case 3: first delivery's shadow row did not appear");
    sinceId = Number(row.id);
    const replay = await deliver([MSG_1], { timestamp });
    assert(replay.res.status === 409, `case 3: replay expected 409, got ${replay.res.status}`);
    const body = await replay.res.json();
    assert(body.status === "duplicate", `case 3: expected duplicate, got ${JSON.stringify(body)}`);
    ok("case 3: replayed (timestamp, body) → 409 duplicate");
  }

  // 4. stale timestamp → 401
  {
    const stale = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    const { res } = await deliver([MSG_1], { timestamp: stale });
    assert(res.status === 401, `case 4: expected 401 for stale timestamp, got ${res.status}`);
    ok("case 4: stale timestamp (>5 min, correctly signed) → 401");
  }

  // 5. session roll: higher epoch → fresh state row, old epoch untouched
  {
    const before = await novaDb.query(
      `SELECT state, updated_at FROM nova_conversation_state WHERE store_id=$1 AND conversation_id=$2 AND epoch=0`,
      [STORE_ID, CONV_ID],
    );
    assert(before.rows.length === 1, "case 5: epoch-0 state row missing before the roll");
    const epoch0Before = JSON.stringify(before.rows[0].state);

    await dakioDb.query(`UPDATE "InboxConversation" SET "novaSessionEpoch" = 3 WHERE id = $1`, [CONV_ID]);

    const { res } = await deliver([MSG_2]);
    assert(res.status === 202, `case 5: expected 202, got ${res.status}`);
    const row = await pollShadowRow(novaDb, 3, sinceId);
    assert(row, "case 5: no shadow row for epoch 3 within 30s");
    assert(Number(row.epoch) === 3, `case 5: shadow row epoch ${row.epoch}`);
    ok("case 5a: rolled epoch → shadow turn ran under epoch 3");

    const { rows: state3 } = await novaDb.query(
      `SELECT state FROM nova_conversation_state WHERE store_id=$1 AND conversation_id=$2 AND epoch=3`,
      [STORE_ID, CONV_ID],
    );
    assert(state3.length === 1, "case 5: expected a FRESH nova_conversation_state row for epoch 3");
    assert(
      Number(state3[0].state.version) === 1,
      `case 5: epoch-3 state should be turn 1 of a fresh context, got version ${state3[0].state.version}`,
    );
    const after = await novaDb.query(
      `SELECT state FROM nova_conversation_state WHERE store_id=$1 AND conversation_id=$2 AND epoch=0`,
      [STORE_ID, CONV_ID],
    );
    assert(JSON.stringify(after.rows[0].state) === epoch0Before, "case 5: epoch-0 state row CHANGED across the roll");
    ok("case 5b: fresh state row under epoch 3; epoch-0 row byte-identical");
  }

  console.log(`\nall ${passed} checks passed — shadow ingress holds the contract, nothing was sent, no order created`);
  const { rows: orders } = await dakioDb.query(
    `SELECT count(*)::int AS n FROM "Order" WHERE "sourceConversationId" = $1`,
    [CONV_ID],
  );
  if (orders[0].n > 0) fail(`SHADOW VIOLATION: ${orders[0].n} order(s) exist for the drill conversation`);
  console.log("verified: zero orders for the drill conversation in dakio-api");
} finally {
  await dakioDb.end().catch(() => {});
  await novaDb.end().catch(() => {});
}
