/**
 * Restart drill for eve-compat session persistence (Phase B unit 1).
 *
 * Proves a founder chat session survives a nova-mastra restart:
 *   (a) create a session ("hello"), read the stream to settle, counting
 *       consumed events exactly the way novaAgentClient.js does
 *   (b) the pg row exists with history length 1 and event_base recorded
 *   (c) kill nova-mastra, restart it, wait healthy
 *   (d) POST a follow-up to the SAME session id with the SAME
 *       continuationToken → 200 (restored from pg, not 404)
 *   (e) read the stream from the client's accumulated cursor → settles
 *       (turn.failed while the model is down) — verifies the eventBase
 *       cursor arithmetic: old cursor N maps to N - event_base in the
 *       fresh (empty-on-restore) events array
 *   (f) pg history length grew to 2
 *
 * Works with the model credential down: turns settle on turn.failed, and on
 * failure the token does NOT rotate, so the original token stays valid for
 * the post-restart follow-up. Requires NOVA_PG_URL set (persistence on) and
 * dakio-api reachable. JWT minting mirrors smoke-eve-compat.mjs.
 *
 * Usage: node --env-file=.env scripts/smoke-restart.mjs [storeId]
 */

import { createHmac } from "node:crypto";
import { spawn, execSync } from "node:child_process";
import { openSync } from "node:fs";
import pg from "pg";

const BASE = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:2100";
const LOG_FILE = process.env.SMOKE_SERVER_LOG ?? "/tmp/nova-mastra.log";
const storeId = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? process.env.NOVA_DEV_STORE_ID;
if (!storeId) throw new Error("pass a storeId or set NOVA_DEV_STORE_ID");
const secret = process.env.DAKIO_JWT_SECRET;
if (!secret) throw new Error("DAKIO_JWT_SECRET not set");
const pgUrl = process.env.NOVA_PG_URL;
if (!pgUrl) throw new Error("NOVA_PG_URL not set — this drill tests pg persistence");

// Merchant-dialect claims, same as smoke-eve-compat.mjs.
const b64 = (s) => Buffer.from(s).toString("base64url");
const iat = Math.floor(Date.now() / 1000);
const header = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
const payload = b64(JSON.stringify({ userId: "smoke-restart-user", tenantId: storeId, role: "OWNER", iat, exp: iat + 600 }));
const sig = b64(createHmac("sha256", secret).update(`${header}.${payload}`).digest());
const jwt = `${header}.${payload}.${sig}`;

const pool = new pg.Pool({ connectionString: pgUrl });
let failed = false;
const step = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed = true;
};
const bail = async (name, detail) => {
  step(name, false, detail);
  await pool.end().catch(() => {});
  process.exit(1);
};

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** novaAgentClient.readTurn semantics: count every non-empty line consumed. */
async function readTurn(sessionId, cursor) {
  const res = await fetch(`${BASE}/eve/v1/session/${sessionId}/stream?startIndex=${cursor}`, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  if (!res.ok || !res.body) throw new Error(`stream failed: ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let consumed = 0;
  const events = [];
  outer: while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      consumed += 1;
      const event = JSON.parse(line);
      events.push(event);
      if (["session.waiting", "turn.failed", "session.failed", "session.completed"].includes(event.type)) {
        await reader.cancel().catch(() => {});
        break outer;
      }
    }
  }
  return { consumed, events };
}

async function waitHealthy(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** The settle-point save is fire-and-forget — poll pg briefly for the row. */
async function pollRow(sessionId, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let row = null;
  while (Date.now() < deadline) {
    const result = await pool.query("SELECT * FROM nova_eve_sessions WHERE id = $1", [sessionId]);
    row = result.rows[0] ?? null;
    if (row && predicate(row)) return row;
    await new Promise((r) => setTimeout(r, 300));
  }
  return row;
}

// ---- (a) create session, read to settle ------------------------------------
console.log(`store ${storeId} → ${BASE} (pg: ${pgUrl.replace(/:[^:@/]+@/, ":***@")})`);
const created = await post("/eve/v1/session", { message: "hello" });
if (created.status !== 200 || !created.body?.sessionId) {
  await bail("(a) create session", `status ${created.status}: ${JSON.stringify(created.body)}`);
}
const sessionId = created.body.sessionId;
const token = created.body.continuationToken;
let cursor = 0;

const turn1 = await readTurn(sessionId, cursor);
cursor += turn1.consumed;
const settle1 = turn1.events.at(-1)?.type;
step(
  "(a) session created + turn 1 settled",
  turn1.consumed > 0 && ["session.waiting", "turn.failed"].includes(settle1),
  `${turn1.consumed} events consumed, settled on ${settle1}, cursor=${cursor}`,
);

// ---- (b) pg row: history length 1, event_base recorded ---------------------
const row1 = await pollRow(sessionId, (r) => (r.history?.length ?? 0) >= 1 && r.event_base >= turn1.consumed);
if (!row1) await bail("(b) pg row exists", "no row in nova_eve_sessions");
step(
  "(b) pg row: history=1, event_base recorded",
  row1.history.length === 1 && row1.event_base === cursor && row1.continuation_token === token,
  `history=${row1.history.length}, event_base=${row1.event_base} (client cursor=${cursor}), token ${row1.continuation_token === token ? "matches (no rotation on failure)" : "MISMATCH"}`,
);

// ---- (c) kill + restart ----------------------------------------------------
// Bracket trick so pkill's own command line never matches the pattern.
try {
  execSync('pkill -f "tsx src/[i]ndex.ts"');
} catch {
  /* exit 1 = no match; the port check below is the real assertion */
}
// Wait until the port actually stops answering.
const deadDeadline = Date.now() + 10_000;
let dead = false;
while (Date.now() < deadDeadline) {
  try {
    await fetch(`${BASE}/health`);
  } catch {
    dead = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 300));
}
if (!dead) await bail("(c) kill nova-mastra", "server still answering after pkill");

const logFd = openSync(LOG_FILE, "a");
const child = spawn("npm", ["run", "start"], {
  cwd: new URL("..", import.meta.url).pathname,
  detached: true,
  stdio: ["ignore", logFd, logFd],
});
child.unref();
const healthy = await waitHealthy();
if (!healthy) await bail("(c) restart nova-mastra", "server did not come healthy within 30s");
step("(c) killed and restarted", true, "fresh process, in-memory session map is empty");

// ---- (d) follow-up on the SAME session id + SAME token ---------------------
const followUp = await post(`/eve/v1/session/${sessionId}`, {
  continuationToken: token,
  message: "And after the restart?",
});
step(
  "(d) post-restart follow-up accepted (restored from pg, not 404)",
  followUp.status === 200,
  `status ${followUp.status}${followUp.status !== 200 ? `: ${JSON.stringify(followUp.body)}` : ""}`,
);
if (followUp.status !== 200) await bail("(d) cannot continue drill", "follow-up rejected");

// ---- (e) stream from the client's accumulated cursor -----------------------
// cursor === event_base at last save; the server maps it to index 0 of the
// fresh events array, so this read must deliver the new turn's settle event
// instead of hanging waiting for index `cursor` to fill in.
const turn2 = await readTurn(sessionId, cursor);
cursor += turn2.consumed;
const settle2 = turn2.events.at(-1)?.type;
step(
  "(e) stream from old cursor settles (eventBase arithmetic)",
  turn2.consumed > 0 && ["session.waiting", "turn.failed"].includes(settle2),
  `${turn2.consumed} events consumed, settled on ${settle2}, cursor now ${cursor}`,
);

// ---- (f) pg history grew to 2 ----------------------------------------------
const row2 = await pollRow(sessionId, (r) => (r.history?.length ?? 0) >= 2);
step(
  "(f) pg history grew to 2",
  row2 !== null && row2.history.length === 2,
  row2 ? `history=${row2.history.length}, event_base=${row2.event_base}` : "row disappeared",
);

await pool.end().catch(() => {});
console.log(failed ? "\nRESTART DRILL: FAIL" : "\nRESTART DRILL: ALL PASS — sessions survive a restart.");
process.exit(failed ? 1 : 0);
