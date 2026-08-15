/**
 * The one invariant `brain/runs.ts` exists to keep: THE AUDIT MUST NEVER FAIL,
 * SLOW, OR PARK A TURN.
 *
 * NovaRun is the record the ledger tables cannot provide — NovaAction only sees
 * gated mutations, NovaActivity only notable outcomes — so it is written on
 * every turn, including the ones that crash. Which means its writer sits in the
 * hot path of every customer reply Nova sends, and a writer in that position
 * that can throw is worse than no audit at all: it converts "we lost a log row"
 * into "the customer got nothing".
 *
 * nova-ai's original held this with two nested catches. The port adds two new
 * ways in — an optional `measure` hook and an `onTurnStart` hook — so each of
 * the four failure surfaces is pinned here:
 *
 *   1. no tenant on the principal      → nothing written, nothing thrown
 *   2. `storeFor` throws synchronously → swallowed (this is the real one: it
 *      throws on a misconfigured deployment, i.e. exactly when everything else
 *      is already going wrong)
 *   3. the store write REJECTS         → swallowed, and no unhandled rejection
 *   4. a hook throws                   → swallowed, and the run is still recorded
 *
 * Demo backend, no network, no model.
 */

import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { turnRunRecorder } from "./runs.js";
import { tenantAppPrincipal, type NovaSessionContext } from "./principal.js";
import { storeFor, resetStores } from "../store/resolve.js";

// Read lazily by `resolve.ts`, never at import — so setting it in the module
// body, after ESM import hoisting, still lands before any client is built.
process.env.NOVA_STORE_BACKEND = "demo";

const STORE = "store-aurora";

function ctxFor(auth: NovaSessionContext["session"]["auth"], id = "ses_test"): NovaSessionContext {
  return { session: { id, auth } };
}

/** A session the recorder can resolve a tenant from. */
function jobCtx(id = "ses_job"): NovaSessionContext {
  return ctxFor({ current: tenantAppPrincipal(STORE, "job_1", "pulse") }, id);
}

/** Let the fire-and-forget write settle before asserting on it. */
const settle = () => new Promise((r) => setImmediate(r));

before(() => {
  resetStores();
});

beforeEach(() => {
  process.env.NOVA_STORE_BACKEND = "demo";
});

test("records a full turn — start then finish — off the principal's attributes", async () => {
  const rec = turnRunRecorder("job_turn", "founder");
  const ctx = jobCtx("ses_happy");
  rec.started({ turnId: "t1" }, ctx);
  rec.completed({ turnId: "t1" }, ctx);
  await settle();

  const runs = (storeFor(STORE) as unknown as { runs: Map<string, Record<string, unknown>> }).runs;
  const row = [...runs.values()].find((r) => r.turnId === "t1");
  assert.ok(row, "a run row was written");
  assert.equal(row.sessionId, "ses_happy", "joined on the session id");
  assert.equal(row.kind, "job_turn");
  assert.equal(row.lane, "founder");
  assert.equal(row.outcome, "completed");
  // Stamped at TURN START from the scheduler principal — the mid-run job↔run
  // join. The dispatcher's own sessionId stamp on the job row lands later.
  assert.equal(row.jobId, "job_1", "jobId rides the auth attributes");
});

test("1. no tenant on the principal — nothing thrown, nothing written", async () => {
  const rec = turnRunRecorder("founder_turn", "founder");
  const before = (storeFor(STORE) as unknown as { runs: Map<string, unknown> }).runs.size;

  assert.doesNotThrow(() => rec.started({ turnId: "t-no-tenant" }, ctxFor({})));
  assert.doesNotThrow(() => rec.completed({ turnId: "t-no-tenant" }, ctxFor({ current: null })));
  await settle();

  assert.equal(
    (storeFor(STORE) as unknown as { runs: Map<string, unknown> }).runs.size,
    before,
    "no tenant, no tenant-scoped audit row — and no guess at which store it belonged to",
  );
});

test("2. storeFor throwing synchronously never reaches the turn", async () => {
  // The real-world trigger: dakio backend selected, DAKIO_API_URL unset. A
  // misconfigured deployment must degrade to "no audit", never to "no reply".
  resetStores();
  process.env.NOVA_STORE_BACKEND = "dakio";
  const savedUrl = process.env.DAKIO_API_URL;
  delete process.env.DAKIO_API_URL;
  try {
    const rec = turnRunRecorder("customer_turn", "customer");
    assert.throws(() => storeFor(STORE), "precondition: storeFor really does throw here");
    assert.doesNotThrow(() => rec.started({ turnId: "t-boom" }, jobCtx()));
    assert.doesNotThrow(() =>
      rec.failed({ turnId: "t-boom", code: "E", message: "m" }, jobCtx()),
    );
    await settle();
  } finally {
    if (savedUrl !== undefined) process.env.DAKIO_API_URL = savedUrl;
    process.env.NOVA_STORE_BACKEND = "demo";
    resetStores();
  }
});

test("3. a rejecting store write is swallowed, with no unhandled rejection", async () => {
  const client = storeFor(STORE) as unknown as {
    recordRunStart: (i: unknown) => Promise<void>;
    recordRunFinish: (i: unknown) => Promise<void>;
  };
  const savedStart = client.recordRunStart;
  const savedFinish = client.recordRunFinish;

  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);

  client.recordRunStart = () => Promise.reject(new Error("dakio-api 503"));
  client.recordRunFinish = () => Promise.reject(new Error("dakio-api 503"));
  try {
    const rec = turnRunRecorder("job_turn", "founder");
    const ctx = jobCtx("ses_reject");
    assert.doesNotThrow(() => rec.started({ turnId: "t-reject" }, ctx));
    assert.doesNotThrow(() => rec.cancelled({ turnId: "t-reject" }, ctx));
    await settle();
    await settle();
    assert.deepEqual(unhandled, [], "the .catch() on the fire-and-forget write is load-bearing");
  } finally {
    process.off("unhandledRejection", onUnhandled);
    client.recordRunStart = savedStart;
    client.recordRunFinish = savedFinish;
  }
});

test("4. a throwing measure/onTurnStart hook costs the measurement, never the run", async () => {
  const rec = turnRunRecorder("job_turn", "founder", {
    onTurnStart: () => {
      throw new Error("scratch open failed");
    },
    measure: () => {
      throw new Error("report failed");
    },
  });
  const ctx = jobCtx("ses_hooks");
  assert.doesNotThrow(() => rec.started({ turnId: "t-hooks" }, ctx));
  assert.doesNotThrow(() => rec.completed({ turnId: "t-hooks" }, ctx));
  await settle();

  const runs = (storeFor(STORE) as unknown as { runs: Map<string, Record<string, unknown>> }).runs;
  const row = [...runs.values()].find((r) => r.turnId === "t-hooks");
  assert.ok(row, "the run is still recorded when measurement fails");
  assert.equal(row.outcome, "completed");
});

test("a measure hook returning nothing is a first-class answer, not an error", async () => {
  // The default state until nova-ai's `turnTiming.ts` ports: dakio-api treats
  // an absent measurement block as "no measurement" and settles the run exactly
  // as it did before, so neither repo blocks the other.
  const rec = turnRunRecorder("job_turn", "founder", { measure: () => null });
  const ctx = jobCtx("ses_nomeasure");
  rec.started({ turnId: "t-null" }, ctx);
  rec.completed({ turnId: "t-null" }, ctx);
  await settle();

  const runs = (storeFor(STORE) as unknown as { runs: Map<string, Record<string, unknown>> }).runs;
  const row = [...runs.values()].find((r) => r.turnId === "t-null");
  assert.ok(row, "run recorded");
  assert.equal(row.timing, undefined, "no timing block invented");
  assert.equal(row.usage, undefined, "no usage block invented");
});

test("failed turns carry their error, capped so one stack trace cannot fill a column", async () => {
  const rec = turnRunRecorder("customer_turn", "customer");
  const ctx = jobCtx("ses_failed");
  rec.started({ turnId: "t-fail" }, ctx);
  rec.failed({ turnId: "t-fail", code: "gateway_error", message: "x".repeat(4000) }, ctx);
  await settle();

  const runs = (storeFor(STORE) as unknown as { runs: Map<string, Record<string, unknown>> }).runs;
  const row = [...runs.values()].find((r) => r.turnId === "t-fail");
  assert.ok(row, "a crashed turn leaves a row — in eve this event was literally discarded");
  assert.equal(row.outcome, "failed");
  assert.equal(typeof row.error, "string");
  assert.ok((row.error as string).startsWith("gateway_error: "), "code prefixes the message");
  assert.equal((row.error as string).length, 2000, "capped at 2000 chars");
});
