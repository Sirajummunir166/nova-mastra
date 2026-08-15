/**
 * The heartbeat's contract — what one tick may and may not do.
 *
 * Five properties, each of which nova-ai either designed for or paid for:
 *
 *  1. PER-TENANT ISOLATION. One claim per tenant, through that tenant's own
 *     client, never a fleet-wide claim. A bug here leaks across tenants.
 *  2. ONE TENANT CANNOT BLOCK ANOTHER. A thrown claim is swallowed.
 *  3. COMPLETE vs RELEASE, truthfully. Work that happened completes with its
 *     lease token; work that did not releases with the reason on the row.
 *  4. AN ACK FAILURE IS SWALLOWED — never routed into release. The turn already
 *     happened; requeueing finished work answers a customer twice.
 *  5. NOTHING FAKES A SUCCESS. A server sweep, an unbuilt lane and a guard-rail
 *     violation all RELEASE, with the reason readable on the job row.
 *
 * Demo backend, no network. The writer agent is stubbed per case, so the
 * outcomes are decided by the dispatcher rather than by whether a model
 * credential happens to be present.
 */

import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { runDispatchTick, turnCommittedAWrite } from "./dispatcher.js";
import { storeFor, resetStores } from "../store/resolve.js";
import { resetContext } from "../front-office/context-store.js";
import { writerAgent } from "../front-office/agents.js";
import { pulseJudgeAgent } from "./pulse.js";
import { resetPulseState } from "./pulse-state.js";
import type { JobKind, NovaJob, StoreSeed } from "../store/types.js";

process.env.NOVA_STORE_BACKEND = "demo";

const A = "store-aurora";
const B = "store-beacon";
const BOTH = { tenantIds: [A, B] };

/** The demo backend, with the two seams a test needs: its job table and its threads. */
function demo(storeId: string) {
  return storeFor(storeId) as unknown as {
    data: StoreSeed;
    runs: Map<string, Record<string, unknown>>;
    seedInboxConversation: (seed: { id: string; messages?: Array<{ direction: "in" | "out"; actor: string; text: string }> }) => unknown;
    claimDueJobs: (limit: number) => Promise<NovaJob[]>;
    completeJob: (id: string, token: string, sessionId?: string) => Promise<void>;
    releaseJob: (id: string, token: string, error: string) => Promise<void>;
  };
}

let jobSeq = 0;
function enqueue(storeId: string, kind: JobKind, payload: Record<string, unknown> = {}): string {
  const id = `job_${++jobSeq}`;
  const store = demo(storeId);
  (store.data.jobs ??= []).push({
    id,
    kind,
    payload,
    dueAt: new Date(Date.now() - 1000).toISOString(),
    priority: 3,
    status: "due",
    attempts: 0,
    lastError: null,
    dedupeKey: `${kind}:${id}`,
    leaseUntil: null,
    department: null,
    leaseToken: null,
  });
  return id;
}

function row(storeId: string, jobId: string): NovaJob {
  const found = (demo(storeId).data.jobs ?? []).find((j) => j.id === jobId);
  assert.ok(found, `job ${jobId} exists in ${storeId}`);
  return found;
}

/** A thread with one unanswered customer line — what an `inbox_reply` is for. */
function seedThread(storeId: string, convId: string, text = "hello"): void {
  demo(storeId).seedInboxConversation({
    id: convId,
    messages: [{ direction: "in", actor: "customer", text }],
  });
  resetContext(storeId, convId);
}

/** Stub the writer for one case. Returning a string drafts; throwing fails the turn. */
type Generate = typeof writerAgent.generate;
let restoreWriter: (() => void) | null = null;
function writerReturns(text: string | Error): void {
  const agent = writerAgent as unknown as { generate: Generate };
  const saved = agent.generate;
  agent.generate = (async () => {
    if (text instanceof Error) throw text;
    return { text } as unknown as Awaited<ReturnType<Generate>>;
  }) as Generate;
  restoreWriter = () => {
    agent.generate = saved;
  };
}

/**
 * Replace one client method for the duration of a case. No restore is handed
 * back on purpose: `afterEach` calls `resetStores()`, which throws the whole
 * client away, so a stub can never leak into the next test.
 */
function stub(storeId: string, method: string, impl: (...args: never[]) => unknown): void {
  const client = storeFor(storeId) as unknown as Record<string, unknown>;
  client[method] = impl;
}

/** Record every call to a client method, keeping the real behaviour. */
function spy(storeId: string, method: "completeJob" | "releaseJob"): unknown[][] {
  const client = storeFor(storeId) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  const calls: unknown[][] = [];
  const original = client[method]!.bind(client);
  client[method] = (...args: unknown[]) => {
    calls.push(args);
    return original(...args);
  };
  return calls;
}

before(() => {
  resetStores();
});

beforeEach(() => {
  process.env.NOVA_STORE_BACKEND = "demo";
  delete process.env.NOVA_BRAIN_DISPATCH;
  delete process.env.NOVA_BRAIN_TURN_MODE;
});

afterEach(() => {
  restoreWriter?.();
  restoreWriter = null;
  resetStores();
  jobSeq += 1000; // fresh ids after a store reset, so no row can be confused for another
});

// ---------------------------------------------------------------------------
// 1 + 2. Tenancy
// ---------------------------------------------------------------------------

test("a tenant's claim only ever sees its OWN jobs — one claim per tenant, per credential", async () => {
  // `morning_report`: an UNBUILT lane, deliberately. This case is about which
  // rows a claim can see, and an unbuilt lane settles without running anything
  // — so the assertion cannot be coloured by what a built lane does.
  const a = enqueue(A, "morning_report");
  const b = enqueue(B, "morning_report");

  const report = await runDispatchTick(BOTH);

  assert.equal(report.tenants, 2);
  assert.equal(report.claimed, 2, "one row each, not two rows for one store");
  const byJob = new Map(report.jobs.map((j) => [j.jobId, j.storeId]));
  assert.equal(byJob.get(a), A);
  assert.equal(byJob.get(b), B);
  // The rows themselves are in separate backends — there is no shared table a
  // fleet-wide claim could have swept.
  assert.equal((demo(A).data.jobs ?? []).some((j) => j.id === b), false, "B's row is not in A's store");
  assert.equal((demo(B).data.jobs ?? []).some((j) => j.id === a), false, "A's row is not in B's store");
});

test("a thrown claim for one tenant never blocks another tenant's tick", async () => {
  const client = storeFor(A) as unknown as { claimDueJobs: () => Promise<NovaJob[]> };
  const saved = client.claimDueJobs;
  client.claimDueJobs = () => Promise.reject(new Error("dakio-api 503"));
  const b = enqueue(B, "morning_report");
  try {
    const report = await runDispatchTick(BOTH);
    assert.equal(report.claimFailures, 1, "A's failure is counted, not thrown");
    assert.equal(report.claimed, 1, "and B still got its tick");
    assert.equal(report.jobs[0]?.jobId, b);
  } finally {
    client.claimDueJobs = saved;
  }
});

// ---------------------------------------------------------------------------
// 3. Complete vs release
// ---------------------------------------------------------------------------

test("a turn that produced a reply completes — with the lease token as the fence and the session id stamped", async () => {
  const convId = "conv-dispatch-ok";
  seedThread(A, convId);
  const id = enqueue(A, "inbox_reply", { conversationId: convId });
  writerReturns("Hello! What are you looking for today?");
  const completes = spy(A, "completeJob");
  const releases = spy(A, "releaseJob");

  const report = await runDispatchTick({ tenantIds: [A] });

  assert.equal(report.completed, 1);
  assert.equal(report.released, 0);
  assert.equal(releases.length, 0, "finished work is never released");
  assert.equal(completes.length, 1);
  const [jobId, leaseToken, sessionId] = completes[0]!;
  assert.equal(jobId, id);
  assert.equal(typeof leaseToken, "string");
  assert.ok((leaseToken as string).length > 0, "THE TOKEN IS THE FENCE — never the id alone");
  assert.equal(sessionId, `job:${id}`, "NovaJob.sessionId joins the row to its NovaRun and its trace");
  assert.equal(row(A, id).status, "done");
});

test("a turn whose model call failed RELEASES with the error — a job may not say 'answered' when nobody was", async () => {
  const convId = "conv-dispatch-writer-down";
  seedThread(A, convId);
  const id = enqueue(A, "inbox_reply", { conversationId: convId });
  writerReturns(new Error("no AI_GATEWAY_API_KEY"));

  const report = await runDispatchTick({ tenantIds: [A] });

  assert.equal(report.completed, 0);
  assert.equal(report.released, 1);
  assert.match(report.jobs[0]!.error!, /produced no reply/);
  const after = row(A, id);
  assert.equal(after.status, "due", "requeued with backoff, below the attempts cap");
  assert.equal(after.attempts, 1);
  assert.match(after.lastError!, /no AI_GATEWAY_API_KEY/, "the real reason lands on the row an operator reads");
  assert.ok(Date.parse(after.dueAt) > Date.now(), "and it backs off rather than spinning");
});

test("SILENCE IS A REAL ANSWER: an NBA nudge that says nothing still completes", async () => {
  const convId = "conv-dispatch-nudge";
  seedThread(A, convId, "thanks!");
  const id = enqueue(A, "followup", { conversationId: convId });
  // The nudge read the thread and decided there was nothing worth saying.
  writerReturns("");

  const report = await runDispatchTick({ tenantIds: [A] });

  assert.equal(report.completed, 1, "a nudge nobody asked for is worse than a late one");
  assert.equal(report.jobs[0]!.silent, true);
  assert.equal(row(A, id).status, "done");
});

test("a turn that OWED an answer and produced nothing releases too — silence is not an answer there", async () => {
  const convId = "conv-dispatch-owed";
  seedThread(A, convId);
  const id = enqueue(A, "inbox_reply", { conversationId: convId });
  // The model answered, with nothing. Nobody threw; the customer still heard
  // nothing, so the row may not say `done`.
  writerReturns("   ");

  const report = await runDispatchTick({ tenantIds: [A] });

  assert.equal(report.released, 1);
  assert.match(report.jobs[0]!.error!, /owed a reply/);
  assert.equal(row(A, id).status, "due");
});

test("an already-answered inbox_reply is a cheap no-op — no model call, and it completes", async () => {
  const convId = "conv-dispatch-d7";
  seedThread(A, convId);
  // The live lane got there first: run the same message through the ordinary
  // customer turn, so the thread state already holds it.
  writerReturns("Hello!");
  const { runCustomerTurn } = await import("../front-office/turn.js");
  await runCustomerTurn(A, convId, "hello", { mode: "shadow" });
  restoreWriter?.();
  // Any model call from here on would be a bug, so make one fatal.
  writerReturns(new Error("the writer must not be called for an already-answered batch"));

  const id = enqueue(A, "inbox_reply", { conversationId: convId });
  const report = await runDispatchTick({ tenantIds: [A] });

  assert.equal(report.completed, 1);
  assert.equal(report.jobs[0]!.skipped, "already_answered");
  assert.equal(row(A, id).status, "done");
});

// ---------------------------------------------------------------------------
// 4. The ACK failure — the two-argument .then
// ---------------------------------------------------------------------------

test("an ACK failure is SWALLOWED — the work already succeeded, so nothing releases it", async () => {
  const convId = "conv-dispatch-ack";
  seedThread(A, convId);
  const id = enqueue(A, "inbox_reply", { conversationId: convId });
  writerReturns("Hello there.");

  const client = storeFor(A) as unknown as {
    completeJob: (...a: unknown[]) => Promise<void>;
  };
  const savedComplete = client.completeJob;
  client.completeJob = () => Promise.reject(new Error("dakio-api unreachable"));
  const releases = spy(A, "releaseJob");
  try {
    const report = await runDispatchTick({ tenantIds: [A] });
    assert.equal(report.jobs[0]!.settled, "ack_failed");
    assert.equal(report.released, 0);
    assert.equal(
      releases.length,
      0,
      "collapsing .then(ok, fail) into .then().catch() would requeue finished work — the customer gets answered twice",
    );
    // The row stays leased; the watchdog re-dues it and the stale-lease-safe
    // contract keeps the belated complete harmless.
    assert.equal(row(A, id).status, "leased");
  } finally {
    client.completeJob = savedComplete;
  }
});

// ---------------------------------------------------------------------------
// 5. Nothing fakes a success
// ---------------------------------------------------------------------------

test("a server sweep that reaches the dispatcher is refused loudly — and WITHOUT burning its retry ladder", async () => {
  const id = enqueue(A, "promise_sweep");
  writerReturns(new Error("no model may be reached for a sweep"));
  const releases = spy(A, "releaseJob");

  const report = await runDispatchTick({ tenantIds: [A] });

  assert.equal(report.jobs[0]!.lane, "routing_fault");
  assert.equal(report.jobs[0]!.settled, "completed_not_ours");
  assert.match(report.jobs[0]!.error!, /SERVER SWEEP/);
  assert.match(report.jobs[0]!.error!, /promise_sweep/);
  assert.equal(report.refused, 1);
  assert.equal(report.completed, 0, "nothing was done, so nothing may be counted as done work");

  // A sweep was never ours to be leased. `releaseJob` is the one settlement
  // that ADVANCES the server's ladder — attempts are already incremented at
  // claim time, so releasing this every minute walks a bookkeeping row to
  // `failed` and turns a server-side routing bug into a fake sweep alarm.
  assert.equal(releases.length, 0, "the refusal must not consume the sweep's attempts");
  assert.equal(report.released, 0);
  assert.equal(row(A, id).status, "done");
  assert.equal(row(A, id).attempts, 1, "one claim, one attempt — the ladder is where the server left it");
  assert.equal(row(A, id).lastError, null);

  await new Promise((r) => setImmediate(r));
  const run = [...demo(A).runs.values()].find((r) => r.jobId === id);
  assert.ok(run, "the refusal is durable: completing the row leaves no `lastError` to read");
  assert.equal(run.outcome, "failed");
  assert.match(String(run.error), /SERVER SWEEP/);
});

test("an unbuilt founder-plane lane releases, naming the kind — it never completes as if it ran", async () => {
  // `morning_report`, not `pulse`: the pulse lane shipped in phase E unit 2 and
  // now has a runner. The property under test is about lanes nobody has built,
  // so it needs one of those.
  const id = enqueue(A, "morning_report");
  const report = await runDispatchTick({ tenantIds: [A] });

  assert.equal(report.completed, 0, "a job that silently 'succeeds' without doing anything is worse than one that releases");
  assert.equal(report.jobs[0]!.lane, "not_built");
  assert.match(row(A, id).lastError!, /^lane_not_built:morning_report/);
});

test("a BUILT founder-plane lane runs and completes — and reports what it cost", async () => {
  await resetPulseState(A); // no memory of a previous case's pulse
  // The judge is stubbed for the same reason the writer is: this suite asserts
  // what the DISPATCHER does with the outcome, not whether a model credential
  // happens to be present.
  const judge = pulseJudgeAgent as unknown as { generate: (...a: unknown[]) => unknown };
  const savedJudge = judge.generate;
  judge.generate = async () => ({
    object: { worthWaking: true, headline: "Stock cover slipped", note: "Reorder the two that will run out." },
  });
  const id = enqueue(A, "pulse");
  let report;
  try {
    report = await runDispatchTick({ tenantIds: [A] });
  } finally {
    judge.generate = savedJudge;
  }

  const job = report.jobs.find((j) => j.jobId === id);
  assert.equal(job?.lane, "founder_plane");
  assert.equal(job?.settled, "completed");
  assert.equal(row(A, id).status, "done");
  // The number phase E exists to move, carried on the tick report so it is an
  // observed production fact rather than a claim in a doc. The demo store's
  // first pulse has real findings, so this one is not zero — the ZERO case is
  // pinned in pulse.eval.test.ts, which owns the pulse's own contract.
  assert.equal(typeof job?.modelCalls, "number");
  assert.deepEqual(job?.blindSpots, [], "the seeded store can be seen in full, and the row says so explicitly");
});

/**
 * A LANE THAT COULD NOT SEE MUST NOT SETTLE LIKE ONE THAT COULD.
 *
 * `senseFailures` was computed by the pulse and dropped here — the dispatcher
 * forwarded `{modelCalls, quiet}` only. A tenant whose catalogue read had been
 * failing for a week produced tick reports identical to a healthy tenant's, and
 * the job row said the pulse ran.
 */
test("a founder-plane lane that ran blind says so on its job row", async () => {
  await resetPulseState(A);
  const judge = pulseJudgeAgent as unknown as { generate: (...a: unknown[]) => unknown };
  const savedJudge = judge.generate;
  judge.generate = async () => ({
    object: { worthWaking: true, headline: "Stock cover slipped", note: "Reorder the two that will run out." },
  });
  stub(A, "listProducts", async () => {
    throw new Error("dakio-api 503 on /products");
  });
  const id = enqueue(A, "pulse");
  let report;
  try {
    report = await runDispatchTick({ tenantIds: [A] });
  } finally {
    judge.generate = savedJudge;
  }

  const job = report.jobs.find((j) => j.jobId === id);
  assert.equal(job?.settled, "completed", "the work that COULD be done was done");
  assert.ok(job?.blindSpots?.includes("sense:products"), "and the part that could not is on the row");
  assert.equal(row(A, id).status, "done");
});

test("a guard-rail violation releases with the fault on the row", async () => {
  const missingThread = enqueue(A, "inbox_reply", {});
  const promiseNoThread = enqueue(A, "followup", { promiseId: "prom_1" });

  const report = await runDispatchTick({ tenantIds: [A] });

  assert.equal(report.released, 2);
  assert.match(row(A, missingThread).lastError!, /no payload\.conversationId/);
  assert.match(row(A, promiseNoThread).lastError!, /promiseId/);
});

// ---------------------------------------------------------------------------
// The audit, and the off switch
// ---------------------------------------------------------------------------

test("every job turn lands as a NovaRun row, joined to its job — and a broken audit costs no work", async () => {
  const convId = "conv-dispatch-audit";
  seedThread(A, convId);
  const id = enqueue(A, "inbox_reply", { conversationId: convId });
  writerReturns("Hi!");

  await runDispatchTick({ tenantIds: [A] });
  await new Promise((r) => setImmediate(r)); // the audit is fire-and-forget

  const runs = [...demo(A).runs.values()];
  const run = runs.find((r) => r.jobId === id);
  assert.ok(run, "the run is joined to the job at TURN START, not at complete time");
  assert.equal(run.kind, "job_turn");
  assert.equal(run.lane, "customer", "a job-driven customer turn runs on the customer plane");
  assert.equal(run.sessionId, `job:${id}`);
  assert.equal(run.outcome, "completed");

  // And the invariant the recorder exists to keep: a failing audit write must
  // never cost the work.
  const client = storeFor(A) as unknown as { recordRunStart: () => Promise<void> };
  const saved = client.recordRunStart;
  client.recordRunStart = () => Promise.reject(new Error("nova_runs table missing"));
  try {
    const convId2 = "conv-dispatch-audit-down";
    seedThread(A, convId2);
    enqueue(A, "inbox_reply", { conversationId: convId2 });
    const report = await runDispatchTick({ tenantIds: [A] });
    assert.equal(report.completed, 1, "THE AUDIT MUST NEVER FAIL, SLOW, OR PARK A TURN");
  } finally {
    client.recordRunStart = saved;
  }
});

// ---------------------------------------------------------------------------
// 6. Fault isolation — one tenant's bad answer may not cost the fleet its tick
// ---------------------------------------------------------------------------

test("a MALFORMED claim response for one tenant cannot abort the fleet's tick", async () => {
  // The reviewer's reproduction: the claim RESOLVES, with garbage. Only the
  // `await claimDueJobs` used to sit inside the try — `jobs.length` and
  // `jobs.map` were outside it, and the tenant fan-out was `Promise.all`, so
  // this one non-array rejected the whole tick and every OTHER tenant's jobs
  // went unclaimed that minute.
  stub(A, "claimDueJobs", async () => ({ jobs: [] }) as never);

  const convId = "conv-fleet-survivor";
  seedThread(B, convId);
  const id = enqueue(B, "inbox_reply", { conversationId: convId });
  writerReturns("Hello — how can I help?");

  const report = await runDispatchTick(BOTH);

  assert.equal(report.claimFailures, 1, "A's malformed answer is counted like a thrown claim");
  assert.equal(report.claimed, 1, "and it is NOT counted as claimed work");
  assert.equal(report.completed, 1, "B's tenant tick is untouched");
  assert.equal(row(B, id).status, "done", "B's customer was answered in the same minute");
});

test("a tenant whose job settlement explodes still cannot take the fleet down", async () => {
  // Fault isolation has to cover the whole per-tenant body, not just the claim:
  // anything thrown while CONSUMING the claim is the same class of failure.
  stub(A, "completeJob", () => {
    throw new TypeError("client blew up synchronously");
  });
  const convA = "conv-fleet-explode";
  seedThread(A, convA);
  enqueue(A, "inbox_reply", { conversationId: convA });

  const convB = "conv-fleet-explode-b";
  seedThread(B, convB);
  const idB = enqueue(B, "inbox_reply", { conversationId: convB });
  writerReturns("Hi!");

  const report = await runDispatchTick(BOTH);

  assert.equal(row(B, idB).status, "done", "B still got its tick");
  assert.ok(
    report.jobs.some((j) => j.storeId === A && j.settled === "ack_failed"),
    "and A's failure is recorded on A's own job, not thrown at the fleet",
  );
});

// ---------------------------------------------------------------------------
// 7. The server's `stale` flag — the only way we learn our lease was recovered
// ---------------------------------------------------------------------------

test("a complete the server answers `stale:true` is NOT a clean success", async () => {
  const convId = "conv-stale-complete";
  seedThread(A, convId);
  const id = enqueue(A, "inbox_reply", { conversationId: convId });
  writerReturns("Answered.");
  // dakio-api answers a superseded lease with HTTP 200 {ok:true, stale:true}:
  // the watchdog re-dued this row and somebody else owns it now.
  stub(A, "completeJob", async () => ({ ok: true, stale: true }));

  const report = await runDispatchTick({ tenantIds: [A] });
  await new Promise((r) => setImmediate(r)); // the audit is fire-and-forget

  assert.equal(report.completed, 0, "the row did not go `done` on our say-so — it moved on without us");
  assert.equal(report.stale, 1, "counted, so a fleet-wide lease problem is visible in the tick report");
  assert.equal(report.jobs[0]!.settled, "completed_stale");
  assert.equal(report.jobs[0]!.stale, true);

  const run = [...demo(A).runs.values()].find((r) => r.jobId === id);
  assert.ok(run, "the turn's run row exists");
  assert.equal(run.outcome, "failed", "the audit may not say `completed` about work the server never accepted");
  assert.match(String(run.error), /lease/i, "and it names why: the lease was recovered mid-flight");
});

test("a release the server answers `stale:true` is not counted as a requeue either", async () => {
  const convId = "conv-stale-release";
  seedThread(A, convId);
  enqueue(A, "inbox_reply", { conversationId: convId });
  writerReturns(new Error("no AI_GATEWAY_API_KEY"));
  stub(A, "releaseJob", async () => ({ ok: true, stale: true }));

  const report = await runDispatchTick({ tenantIds: [A] });

  assert.equal(report.released, 0, "nothing was requeued — the row was already somebody else's");
  assert.equal(report.stale, 1);
  assert.equal(report.jobs[0]!.settled, "released_stale");
  assert.equal(report.jobs[0]!.stale, true);
});

// ---------------------------------------------------------------------------
// 8. Never re-run a turn that already wrote — and never run one we cannot settle
// ---------------------------------------------------------------------------

test("LIVE: a turn that threw may have already placed an order — it COMPLETES, it never releases", async () => {
  process.env.NOVA_BRAIN_TURN_MODE = "live";
  const convId = "conv-live-writer-down";
  seedThread(A, convId);
  const id = enqueue(A, "inbox_reply", { conversationId: convId });
  // turn.ts re-throws a live writer failure AFTER the order gate and the
  // hand-over gate have already committed server-side. A release would requeue
  // a turn whose irreversible half already happened.
  writerReturns(new Error("gateway 503"));

  const report = await runDispatchTick({ tenantIds: [A] });

  assert.equal(report.released, 0, "a retry could re-place an order or re-hand a thread to a person");
  assert.equal(report.jobs[0]!.settled, "completed_not_retryable");
  assert.equal(row(A, id).status, "done");
  assert.equal(row(A, id).attempts, 1, "and it is not sitting on a backoff waiting to run again");
});

test("SHADOW: the same failure still releases — shadow provably wrote nothing", async () => {
  const convId = "conv-shadow-writer-down";
  seedThread(A, convId);
  const id = enqueue(A, "inbox_reply", { conversationId: convId });
  writerReturns(new Error("gateway 503"));

  const report = await runDispatchTick({ tenantIds: [A] });

  assert.equal(report.released, 1, "no gate is reachable in shadow, so a retry can duplicate nothing");
  assert.equal(row(A, id).status, "due");
});

test("what counts as 'this turn already wrote' — the three live artifacts, and nothing else", () => {
  // The rule the release arm keys on, asserted without a model. Each of these
  // three is a row on dakio-api that a second run would duplicate: a placed
  // order, a prepared order action on the founder's desk, and the
  // escalate_conversation row that locks a thread and pages a person.
  assert.equal(turnCommittedAWrite({}), false, "a turn that wrote nothing may be retried");
  assert.equal(turnCommittedAWrite({ order: { orderNumber: "A-1", total: 100 } }), true);
  assert.equal(turnCommittedAWrite({ pendingActionId: "act_1" }), true, "an order awaiting approval is still an order");
  assert.equal(turnCommittedAWrite({ handoverActionId: "act_2" }), true, "a thread handed to a person is not handed twice");
});

test("a job claimed WITHOUT a lease token is refused before the work runs, not after", async () => {
  const convId = "conv-no-lease";
  seedThread(A, convId);
  const id = enqueue(A, "inbox_reply", { conversationId: convId });
  // NovaJob.leaseToken is `string | null`, and dakio-api 422s an empty token on
  // both complete and release. Running the turn first means answering the
  // customer and then being unable to say so — the row stays leased until the
  // watchdog re-dues it and the customer is answered twice.
  const client = storeFor(A) as unknown as { claimDueJobs: (n: number) => Promise<NovaJob[]> };
  const real = client.claimDueJobs.bind(client);
  stub(A, "claimDueJobs", async (limit: never) =>
    (await real(limit as unknown as number)).map((j) => ({ ...j, leaseToken: null })),
  );
  writerReturns(new Error("the writer must not be called for a job we cannot settle"));
  const completes = spy(A, "completeJob");
  const releases = spy(A, "releaseJob");

  const report = await runDispatchTick({ tenantIds: [A] });

  assert.equal(report.refused, 1, "counted loudly rather than swallowed as an ack failure");
  assert.equal(report.jobs[0]!.settled, "refused");
  assert.match(report.jobs[0]!.error!, /lease token/i);
  assert.equal(completes.length, 0, "an empty token is a guaranteed 422 — do not pretend");
  assert.equal(releases.length, 0);
  assert.equal(report.completed, 0);
  assert.equal(report.released, 0);
  // The row is left exactly as the server has it: leased, for the watchdog.
  assert.equal(row(A, id).status, "leased");

  await new Promise((r) => setImmediate(r));
  const run = [...demo(A).runs.values()].find((r) => r.jobId === id);
  assert.ok(run, "and the refusal is durable — console.error alone reaches nobody in production");
  assert.equal(run.outcome, "failed");
});

test("NOVA_BRAIN_DISPATCH=off stops the heartbeat without a deploy", async () => {
  const id = enqueue(A, "pulse");
  process.env.NOVA_BRAIN_DISPATCH = "off";
  const report = await runDispatchTick(BOTH);
  assert.equal(report.skipped, "disabled");
  assert.equal(report.claimed, 0);
  assert.equal(row(A, id).status, "due", "nothing was even leased");
});

test("job turns default to SHADOW — the brain waking up does not flip live traffic on", async () => {
  const convId = "conv-dispatch-shadow";
  seedThread(A, convId);
  enqueue(A, "inbox_reply", { conversationId: convId });
  let sawInstructions = false;
  const agent = writerAgent as unknown as { generate: Generate };
  const saved = agent.generate;
  agent.generate = (async () => {
    sawInstructions = true;
    return { text: "drafted, not sent" } as unknown as Awaited<ReturnType<Generate>>;
  }) as Generate;
  restoreWriter = () => {
    agent.generate = saved;
  };

  // Shadow's guarantee in this pipeline: the two gated writes are unreachable,
  // so no chat order and no hand-over can be filed by a job turn. Measured as a
  // DELTA over the seeded ledger — "wrote nothing" is a claim about this tick,
  // not about the fixture.
  const client = storeFor(A) as unknown as {
    listActions: (s?: string) => Promise<unknown[]>;
    listDecisions: (f?: unknown) => Promise<unknown[]>;
  };
  const actionsBefore = (await client.listActions()).length;
  const decisionsBefore = (await client.listDecisions()).length;

  await runDispatchTick({ tenantIds: [A] });

  assert.ok(sawInstructions, "the turn ran");
  assert.equal((await client.listActions()).length, actionsBefore, "an instructed turn in shadow files no action");
  assert.equal((await client.listDecisions()).length, decisionsBefore, "and raises no decision card");
});
