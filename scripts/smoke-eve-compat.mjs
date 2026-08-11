/**
 * Smoke test for the eve/v1 compatibility layer.
 *
 * Drives the server exactly the way the merchant app's novaAgentClient.js
 * does — create session, read the NDJSON stream with a cursor, follow up —
 * and asserts the protocol invariants NovaChat depends on. Local dev only:
 * signs a merchant-dialect test JWT ({userId, tenantId, role}) with the
 * shared dev DAKIO_JWT_SECRET, same trust root dakio-api uses.
 *
 * Usage: node --env-file=.env scripts/smoke-eve-compat.mjs [storeId]
 */

import { createHmac } from "node:crypto";

const BASE = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:2100";
const storeId = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? process.env.NOVA_DEV_STORE_ID;
if (!storeId) throw new Error("pass a storeId or set NOVA_DEV_STORE_ID");
const secret = process.env.DAKIO_JWT_SECRET;
if (!secret) throw new Error("DAKIO_JWT_SECRET not set");

// Merchant-dialect claims on purpose — exercises the {userId, tenantId,
// role:"OWNER"} → {sub, storeId, role:"owner"} normalisation path.
const b64 = (s) => Buffer.from(s).toString("base64url");
const iat = Math.floor(Date.now() / 1000);
const header = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
const payload = b64(JSON.stringify({ userId: "smoke-test-user", tenantId: storeId, role: "OWNER", iat, exp: iat + 600 }));
const sig = b64(createHmac("sha256", secret).update(`${header}.${payload}`).digest());
const jwt = `${header}.${payload}.${sig}`;

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};
const assert = (cond, msg) => {
  if (!cond) fail(msg);
};

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
      "x-dakio-client-context": JSON.stringify({ page: "nova-hq" }),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** novaAgentClient.readTurn, verbatim semantics: count every non-empty line. */
async function readTurn(sessionId, cursor) {
  const res = await fetch(`${BASE}/eve/v1/session/${sessionId}/stream?startIndex=${cursor}`, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  assert(res.ok && res.body, `stream failed: ${res.status}`);
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

function turnText(events) {
  const blocks = events.filter((e) => e.type === "message.completed" && typeof e.data?.message === "string");
  return blocks.map((e) => e.data.message).join("\n\n");
}

// With --allow-model-down, a turn that fails ONLY because the model
// credential is dead (gateway outage) still passes the protocol checks:
// auth, session create, stream cursor, token rotation on success paths is
// unverifiable, but settle-on-turn.failed and the guards are.
const ALLOW_MODEL_DOWN = process.argv.includes("--allow-model-down");
let degraded = false;

// ---- Turn 1: hello → CEO report -------------------------------------------
console.log(`store ${storeId} → ${BASE}`);
const created = await post("/eve/v1/session", { message: "hello" });
assert(created.status === 200, `create returned ${created.status}: ${JSON.stringify(created.body)}`);
assert(typeof created.body?.sessionId === "string", "create: no sessionId");
assert(typeof created.body?.continuationToken === "string", "create: no continuationToken");
const sessionId = created.body.sessionId;
let token = created.body.continuationToken;
let cursor = 0;

const turn1 = await readTurn(sessionId, cursor);
cursor += turn1.consumed;
const settle1 = turn1.events.at(-1);

if (ALLOW_MODEL_DOWN && settle1?.type === "turn.failed" && String(settle1.data?.message ?? "").includes("model returned no output")) {
  degraded = true;
  console.log(`turn 1 DEGRADED — model credential down, turn.failed surfaced correctly: ${settle1.data.message}`);
  // On failure the token must NOT rotate — the client's token stays valid.
} else {
  assert(settle1?.type === "session.waiting", `turn 1 settled on ${settle1?.type}: ${JSON.stringify(settle1?.data ?? {})}`);
  assert(typeof settle1.data?.continuationToken === "string", "session.waiting: no fresh token");
  assert(settle1.data.continuationToken !== token, "continuationToken did not rotate");
  token = settle1.data.continuationToken;

  const deltas = turn1.events.filter((e) => e.type === "message.appended");
  assert(deltas.length > 0, "turn 1: no message.appended deltas (no streaming)");
  const text1 = turnText(turn1.events);
  assert(text1.length > 0, "turn 1: empty reply");
  const streamed = deltas.map((e) => e.data?.messageDelta ?? "").join("");
  assert(streamed === text1, "delta concatenation != completed block");
  console.log(`turn 1 OK — ${turn1.consumed} events, ${text1.length} chars`);
  console.log("--- CEO report ---");
  console.log(text1);
  console.log("------------------");
}

// ---- Turn 2: follow-up continues the same session -------------------------
const followUp = await post(`/eve/v1/session/${sessionId}`, {
  continuationToken: token,
  message: "Which single product should I restock first, and why?",
});
assert(followUp.status === 200, `follow-up returned ${followUp.status}: ${JSON.stringify(followUp.body)}`);
const turn2 = await readTurn(sessionId, cursor);
cursor += turn2.consumed;
if (degraded) {
  assert(turn2.events.at(-1)?.type === "turn.failed", "turn 2: expected turn.failed while model is down");
  console.log("turn 2 DEGRADED — follow-up on the same session + old token accepted after failed turn");
} else {
  assert(turn2.events.at(-1)?.type === "session.waiting", "turn 2 did not settle on session.waiting");
  const text2 = turnText(turn2.events);
  assert(text2.length > 0, "turn 2: empty reply");
  console.log(`turn 2 OK — ${turn2.consumed} events, ${text2.length} chars`);
  console.log(text2.slice(0, 400));
}

// ---- Guardrails ------------------------------------------------------------
const stale = await post(`/eve/v1/session/${sessionId}`, { continuationToken: "nm:bogus", message: "x" });
assert(stale.status === 409, `stale token: expected 409, got ${stale.status}`);
const noAuth = await fetch(`${BASE}/eve/v1/session`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ message: "x" }),
});
assert(noAuth.status === 401, `no auth: expected 401, got ${noAuth.status}`);

console.log(
  degraded
    ? "\nDEGRADED PASS — protocol + auth + guards verified; model turns blocked on the gateway credential. Re-run without --allow-model-down once the key is fixed."
    : "\nALL PASS — eve-compat speaks NovaChat's protocol.",
);
