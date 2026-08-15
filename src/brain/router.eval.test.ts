/**
 * The routing table, its guard rails, and the tripwire — the decisions that
 * decide WHO a message reaches.
 *
 * Every case here is a rule nova-ai learned the hard way (`dispatchJobToChannel`,
 * agent/channels/internal.ts):
 *
 *   • a promise-backed follow-up with no thread must NOT quietly become
 *     founder-plane work, because that answers a customer's promise into the
 *     founder's chat;
 *   • a case update with no thread must NOT throw, because a webhook can open a
 *     case on an order nobody ever discussed and there is still real work to do;
 *   • an NBA nudge belongs to the customer's thread, not the founder plane —
 *     module 03 assumed otherwise and the assumption shipped;
 *   • a server sweep must never reach a model lane at all.
 *
 * Demo backend, no network, no model.
 */

import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  planJob,
  routeJob,
  instructionFor,
  promiseStillOpen,
  ServerSweepError,
  type CustomerTurnPlan,
} from "./router.js";
import { BRAIN_LANES, SERVER_SWEEP_KINDS, laneFor } from "./registry.js";
import { storeFor, resetStores } from "../store/resolve.js";
import type { InboxPromise, JobKind, NovaJob } from "../store/types.js";

// Read lazily by `resolve.ts`, never at import — so setting it in the module
// body, after ESM import hoisting, still lands before any client is built.
process.env.NOVA_STORE_BACKEND = "demo";

const STORE = "store-aurora";

function job(kind: JobKind, payload: Record<string, unknown> = {}, over: Partial<NovaJob> = {}): NovaJob {
  return {
    id: `job_${kind}`,
    kind,
    payload,
    dueAt: new Date().toISOString(),
    priority: 3,
    status: "leased",
    attempts: 1,
    lastError: null,
    dedupeKey: `${kind}:test`,
    leaseUntil: new Date(Date.now() + 600_000).toISOString(),
    department: null,
    leaseToken: "lease-1",
    ...over,
  };
}

/** Replace this store's promise ledger for one case. */
function withPromises(impl: () => Promise<InboxPromise[]>): () => void {
  const client = storeFor(STORE) as unknown as { listPromises: unknown };
  const saved = client.listPromises;
  client.listPromises = impl;
  return () => {
    client.listPromises = saved;
  };
}

/**
 * An open promise ROW. `conversationId` is not decoration — a promise is a debt
 * owed to a person ON A THREAD, and every case below that pairs one with a
 * conversation is asserting something about that pair.
 */
const openPromise = (id: string, conversationId: string | null = "c"): InboxPromise =>
  ({ id, status: "open", conversationId }) as unknown as InboxPromise;

before(() => {
  resetStores();
});
beforeEach(() => {
  process.env.NOVA_STORE_BACKEND = "demo";
});

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

test("the registry is the source of truth: every kind is either a lane or a sweep, and nothing is unrouted", () => {
  const laneKinds = new Set(BRAIN_LANES.map((l) => l.kind));
  const sweeps = new Set(SERVER_SWEEP_KINDS);
  assert.equal(laneKinds.size + sweeps.size, 21, "dakio-api can mint 21 kinds; the registry must know all of them");
  for (const kind of [...laneKinds, ...sweeps]) {
    // Either it plans, or it throws — never "returns something undefined-ish".
    // A silently unrouted kind is the failure this assertion exists to make
    // impossible: adding a 22nd kind breaks `LANES`'s exhaustive Record first.
    if (sweeps.has(kind)) {
      assert.throws(() => planJob(job(kind)), /SERVER SWEEP/, `${kind} must be refused`);
    } else {
      const plan = planJob(job(kind, minimalPayloadFor(kind)));
      assert.ok(plan.lane === "customer_turn" || plan.lane === "founder_plane", `${kind} planned`);
    }
  }
});

/** The smallest payload each conversation-bound kind needs to be well-formed. */
function minimalPayloadFor(kind: JobKind): Record<string, unknown> {
  if (kind === "inbox_reply") return { conversationId: "conv_1" };
  if (kind === "case_update") return { caseId: "case_1" };
  return {};
}

test("server sweeps are a LOUD refusal, not a silent skip — dakio-api leases them itself", () => {
  for (const kind of SERVER_SWEEP_KINDS) {
    assert.throws(
      () => planJob(job(kind)),
      (err: Error) =>
        // TYPED, not a bare Error: the dispatcher has to settle a sweep
        // differently from every other refusal (completing it rather than
        // releasing, so the refusal does not walk the server's own bookkeeping
        // row up its retry ladder to `failed`). An untyped throw is
        // indistinguishable from a guard-rail fault and gets released.
        err instanceof ServerSweepError && err.kind === kind && err.message.includes(kind) && /SERVER SWEEP/.test(err.message),
      `${kind} must be named in the error — "a failed sweep looks exactly like a flaky one"`,
    );
  }
  // And the registry agrees with the router about what a sweep is.
  for (const kind of SERVER_SWEEP_KINDS) assert.equal(laneFor(kind), null);
});

test("THERE IS EXACTLY ONE RUN PATH, and the router is not it", async () => {
  // `routeAndRun` was a second copy of the dispatcher's run path, and it had
  // already drifted: it never read NOVA_BRAIN_TURN_MODE (so the one operator
  // switch that decides whether Nova speaks to customers did not apply to it)
  // and it applied none of the honesty checks — no modelFailure throw, no
  // silent-but-owed-a-reply throw — so a turn that produced nothing came back
  // indistinguishable from one that answered. Nothing called it; it stayed
  // compiling and stayed wrong. Routing decides lanes, the dispatcher runs
  // them, and this is the test that stops the copy coming back.
  const mod: Record<string, unknown> = await import("./router.js");
  assert.equal("routeAndRun" in mod, false, "run paths live in dispatcher.ts (performJob), and there is one");
  for (const [name, value] of Object.entries(mod)) {
    if (typeof value !== "function") continue;
    assert.ok(
      !/^(run|execute|perform)/.test(name),
      `router.ts exports ${name}() — the router plans and decides; it must not RUN a turn`,
    );
  }
});

test("inbox_reply rejoins the customer thread — and REQUIRES a conversation", () => {
  const plan = planJob(job("inbox_reply", { conversationId: "conv_1", platform: "instagram" }));
  assert.deepEqual(plan, {
    lane: "customer_turn",
    kind: "inbox_reply",
    conversationId: "conv_1",
    platform: "instagram",
    mode: "inbox_reply",
  });
  assert.throws(() => planJob(job("inbox_reply", {})), /no payload\.conversationId/);
  assert.throws(() => planJob(job("inbox_reply", { conversationId: "" })), /no payload\.conversationId/);
});

test("platform defaults to messenger when a producer omits it", () => {
  const plan = planJob(job("inbox_reply", { conversationId: "conv_1" })) as CustomerTurnPlan;
  assert.equal(plan.platform, "messenger");
});

test("THE GUARD WITH TEETH: a promise-backed follow-up with no thread throws, it does not fall to the founder", () => {
  assert.throws(
    () => planJob(job("followup", { promiseId: "prom_1" })),
    (err: Error) =>
      /promiseId/.test(err.message) && /conversationId/.test(err.message) && /founder/.test(err.message),
    "silently falling through would pay a customer's promise into the founder's chat",
  );
  // Punctuation is not a fault: an explicit null means "no promise", i.e. a nudge.
  const nudge = planJob(job("followup", { conversationId: "conv_1", promiseId: null })) as CustomerTurnPlan;
  assert.equal(nudge.mode, "nba_nudge");
  // But a present-and-malformed promise id is.
  assert.throws(() => planJob(job("followup", { conversationId: "conv_1", promiseId: "" })), /non-string or empty/);
  assert.throws(() => planJob(job("followup", { conversationId: "conv_1", promiseId: 7 })), /non-string or empty/);
});

test("the follow-up discriminator is THE CONVERSATION, not the debt — all three sub-modes", () => {
  const promise = planJob(job("followup", { conversationId: "c", promiseId: "prom_1" })) as CustomerTurnPlan;
  assert.equal(promise.mode, "promise");
  assert.equal(promise.promiseId, "prom_1");

  const cart = planJob(
    job("followup", { conversationId: "c", triggeredBy: "cart_recovery", cartItems: [{ name: "Linen Throw" }] }),
  ) as CustomerTurnPlan;
  assert.equal(cart.mode, "cart_recovery");

  // An NBA nudge is Nova going back to a specific customer on a specific
  // thread. Module 03 assumed it was founder-plane work; module 04 corrected it.
  const nudge = planJob(job("followup", { conversationId: "c" })) as CustomerTurnPlan;
  assert.equal(nudge.lane, "customer_turn");
  assert.equal(nudge.mode, "nba_nudge");
});

test("a follow-up with neither thread nor promise is malformed but harmless — founder plane, named", () => {
  const plan = planJob(job("followup", {}));
  assert.equal(plan.lane, "founder_plane");
  assert.equal(plan.lane === "founder_plane" && plan.fellThrough, "followup_without_thread");
});

test("case_update: a missing caseId throws, a missing conversation does NOT", () => {
  assert.throws(() => planJob(job("case_update", { conversationId: "c" })), /no payload\.caseId/);

  // THE ASYMMETRY THAT MATTERS: a courier webhook can open a case on an order
  // never discussed in chat. Real work, nobody to tell — founder plane, not a
  // fault.
  const threadless = planJob(job("case_update", { caseId: "case_1" }));
  assert.equal(threadless.lane, "founder_plane");
  assert.equal(threadless.lane === "founder_plane" && threadless.fellThrough, "case_without_thread");

  const threaded = planJob(job("case_update", { caseId: "case_1", conversationId: "c" })) as CustomerTurnPlan;
  assert.equal(threaded.lane, "customer_turn");
  assert.equal(threaded.mode, "case_update");
});

test("every founder-plane kind routes to a typed NOT-BUILT outcome naming the kind — never a fake success", async () => {
  const founderKinds = BRAIN_LANES.map((l) => l.kind).filter(
    (k) => k !== "inbox_reply" && k !== "followup" && k !== "case_update",
  );
  assert.ok(founderKinds.length >= 9, "the cadenced six plus the event lanes");
  for (const kind of founderKinds) {
    const outcome = await routeJob(STORE, job(kind));
    assert.equal(outcome.lane, "not_built", `${kind} must not claim to have run`);
    assert.ok(outcome.lane === "not_built" && outcome.detail.includes(kind), "the outcome names the kind");
    assert.ok(outcome.lane === "not_built" && outcome.detail.startsWith("lane_not_built:"), "and says so in one grep-able token");
  }
});

// ---------------------------------------------------------------------------
// The promise pre-check
// ---------------------------------------------------------------------------

test("a promise-backed follow-up whose debt is GONE does nothing at all — cleanly", async () => {
  const restore = withPromises(async () => []);
  try {
    const outcome = await routeJob(STORE, job("followup", { conversationId: "c", promiseId: "prom_gone" }));
    assert.equal(outcome.lane, "none", "no turn, no apology for a promise the customer never received");
    assert.ok(outcome.lane === "none" && /prom_gone/.test(outcome.reason));
  } finally {
    restore();
  }
});

test("a promise still on the ledger wakes the turn — and the ROW travels with it", async () => {
  const restore = withPromises(async () => [openPromise("prom_1", "c")]);
  try {
    const outcome = await routeJob(STORE, job("followup", { conversationId: "c", promiseId: "prom_1" }));
    assert.equal(outcome.lane, "customer_turn");
    assert.equal(outcome.lane === "customer_turn" && outcome.instruction.mode, "promise");
    // The row this router already read, handed on. Without it the turn seam
    // re-reads one page of open promises to answer a question the router had
    // the answer to — a weaker read, and one that warns loudly.
    assert.deepEqual(
      outcome.lane === "customer_turn" ? outcome.instruction.promise : null,
      { id: "prom_1", conversationId: "c" },
    );
  } finally {
    restore();
  }
});

test("D3: a promise owed on ANOTHER thread is REFUSED, not paid into this one", async () => {
  // The reproduction: promise prom_1 is owed to the customer on thread A. The
  // job pairs it with thread B. Guard rail 2 is satisfied — B is a real
  // conversationId — and the old pre-check read this very row, answered a bare
  // `true`, and threw the row away. The turn then opened on B and paid A's
  // commitment to a customer who was never promised anything.
  const restore = withPromises(async () => [openPromise("prom_1", "conv_A")]);
  try {
    await assert.rejects(
      routeJob(STORE, job("followup", { conversationId: "conv_B", promiseId: "prom_1" })),
      (err: Error) =>
        /prom_1/.test(err.message) && /conv_A/.test(err.message) && /conv_B/.test(err.message),
      "the error must name the promise and BOTH threads — an operator has to see the mispairing",
    );
  } finally {
    restore();
  }
});

test("D3: a promise owed on NO thread is not owed on this one either", async () => {
  const restore = withPromises(async () => [openPromise("prom_1", null)]);
  try {
    await assert.rejects(
      routeJob(STORE, job("followup", { conversationId: "c", promiseId: "prom_1" })),
      /owed on conversation \(none\)/,
    );
  } finally {
    restore();
  }
});

test("D3: an UNVERIFIED check never refuses — a read we could not make is not evidence of a mispairing", async () => {
  // Both degrades: the read failed, and the page came back full. Neither saw the
  // row, so neither may refuse the debt — and neither may claim the pairing was
  // checked, so no `promise` rides the instruction and the seam re-reads.
  for (const rows of [
    async () => {
      throw new Error("dakio-api 503");
    },
    async () => Array.from({ length: 50 }, (_, i) => openPromise(`other_${i}`, "conv_A")),
  ]) {
    const restore = withPromises(rows as () => Promise<InboxPromise[]>);
    try {
      const outcome = await routeJob(STORE, job("followup", { conversationId: "c", promiseId: "prom_1" }));
      assert.equal(outcome.lane, "customer_turn");
      assert.equal(
        outcome.lane === "customer_turn" ? outcome.instruction.promise : "missing",
        undefined,
        "an unverified check must not hand the seam a row it never saw",
      );
    } finally {
      restore();
    }
  }
});

test("the pre-check reports HOW it knows: a row, a whole ledger, or an assumption", async () => {
  const seen = withPromises(async () => [openPromise("prom_1", "c")]);
  try {
    assert.deepEqual(await promiseStillOpen(STORE, "prom_1"), {
      open: true,
      promise: openPromise("prom_1", "c"),
      verified: true,
    });
    // The whole (short) ledger was visible and the debt is not on it: gone, and
    // KNOWN to be gone.
    assert.deepEqual(await promiseStillOpen(STORE, "prom_other"), { open: false, verified: true });
  } finally {
    seen();
  }

  const down = withPromises(async () => {
    throw new Error("dakio-api 503");
  });
  try {
    assert.deepEqual(await promiseStillOpen(STORE, "prom_1"), { open: true, verified: false });
  } finally {
    down();
  }
});

test("the pre-check answers STILL OPEN on a failed read — a transient error must not drop a debt", async () => {
  const restore = withPromises(async () => {
    throw new Error("dakio-api 503");
  });
  try {
    const outcome = await routeJob(STORE, job("followup", { conversationId: "c", promiseId: "prom_1" }));
    assert.equal(outcome.lane, "customer_turn", "a rare barge-in beats a routine broken promise");
  } finally {
    restore();
  }
});

test("…and on a FULL page, because 'not in the first 50' is not 'gone'", async () => {
  const restore = withPromises(async () => Array.from({ length: 50 }, (_, i) => openPromise(`other_${i}`)));
  try {
    const outcome = await routeJob(STORE, job("followup", { conversationId: "c", promiseId: "prom_1" }));
    assert.equal(outcome.lane, "customer_turn", "absence only counts when the whole list was seen");
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// The instructions themselves
// ---------------------------------------------------------------------------

test("ids only: no directive carries thread content, and every one names its own job", () => {
  const rows: Array<[JobKind, Record<string, unknown>, CustomerTurnPlan]> = [
    [
      "inbox_reply",
      { conversationId: "c", messageIds: ["m1", "m2"] },
      { lane: "customer_turn", kind: "inbox_reply", conversationId: "c", platform: "messenger", mode: "inbox_reply" },
    ],
    [
      "followup",
      { conversationId: "c", promiseId: "prom_1" },
      { lane: "customer_turn", kind: "followup", conversationId: "c", platform: "messenger", mode: "promise", promiseId: "prom_1" },
    ],
    [
      "case_update",
      { conversationId: "c", caseId: "case_1" },
      { lane: "customer_turn", kind: "case_update", conversationId: "c", platform: "messenger", mode: "case_update" },
    ],
  ];
  for (const [kind, payload, plan] of rows) {
    const instruction = instructionFor(job(kind, payload), plan);
    assert.equal(instruction.jobKind, plan.kind);
    assert.equal(instruction.jobId, `job_${kind}`);
    assert.ok(instruction.directive.length > 40, "a directive is a real instruction, not a label");
    // The one thing a directive may never do: pretend to carry the customer's
    // words. The turn re-reads those from the store.
    assert.doesNotMatch(instruction.directive, /customer said|they wrote|their message was/i);
  }
  const withIds = instructionFor(
    job("inbox_reply", { conversationId: "c", messageIds: ["m1", "m2"] }),
    { lane: "customer_turn", kind: "inbox_reply", conversationId: "c", platform: "messenger", mode: "inbox_reply" },
  );
  assert.deepEqual(withIds.messageIds, ["m1", "m2"], "ids ride; content does not");
});

test("who owes an answer: the promise and the case do, the two nudges do not", () => {
  const plan = (mode: CustomerTurnPlan["mode"], promiseId?: string): CustomerTurnPlan => ({
    lane: "customer_turn",
    kind: mode === "case_update" ? "case_update" : mode === "inbox_reply" ? "inbox_reply" : "followup",
    conversationId: "c",
    platform: "messenger",
    mode,
    ...(promiseId ? { promiseId } : {}),
  });
  assert.equal(instructionFor(job("inbox_reply", { conversationId: "c" }), plan("inbox_reply")).owesReply, true);
  assert.equal(
    instructionFor(job("followup", { conversationId: "c", promiseId: "p" }), plan("promise", "p")).owesReply,
    true,
  );
  assert.equal(instructionFor(job("case_update", { conversationId: "c", caseId: "k" }), plan("case_update")).owesReply, true);
  // Silence is a real answer on both nudge paths — the instruction says so, and
  // the flag is what lets the dispatcher complete a silent turn honestly.
  const nudge = instructionFor(job("followup", { conversationId: "c" }), plan("nba_nudge"));
  assert.equal(nudge.owesReply, false);
  assert.match(nudge.directive, /silence is a real answer/i);
  const cart = instructionFor(
    job("followup", { conversationId: "c", triggeredBy: "cart_recovery", cartItems: [{ name: "Linen Throw", qty: 2 }] }),
    plan("cart_recovery"),
  );
  assert.equal(cart.owesReply, false);
});

test("the cart nudge is the ONE seam that carries a snapshot — and refuses to improvise without one", () => {
  const plan: CustomerTurnPlan = {
    lane: "customer_turn",
    kind: "followup",
    conversationId: "c",
    platform: "messenger",
    mode: "cart_recovery",
  };
  const named = instructionFor(
    job("followup", {
      conversationId: "c",
      triggeredBy: "cart_recovery",
      cartItems: [{ name: "Linen Throw", qty: 2 }, { name: "Ceramic Mug" }],
    }),
    plan,
  );
  assert.match(named.directive, /Linen Throw ×2/, "the item names ARE the licence for the message");
  assert.match(named.directive, /Ceramic Mug/);
  assert.match(named.directive, /no prices|carries no\s+prices/i, "a snapshot is not a price list");

  // dakio-api refuses to book a nameless cart, so an empty payload means the
  // row was malformed in transit — and a nudge that cannot say what the basket
  // held is a blast.
  const nameless = instructionFor(job("followup", { conversationId: "c", triggeredBy: "cart_recovery" }), plan);
  assert.match(nameless.directive, /Say nothing to the customer/i);
  assert.doesNotMatch(nameless.directive, /you left something in your cart/i);
});

test("the promise directive tells the turn the debt was re-checked, and forbids inventing the answer", () => {
  const instruction = instructionFor(job("followup", { conversationId: "c", promiseId: "prom_9" }), {
    lane: "customer_turn",
    kind: "followup",
    conversationId: "c",
    platform: "messenger",
    mode: "promise",
    promiseId: "prom_9",
  });
  assert.match(instruction.directive, /prom_9/);
  assert.match(instruction.directive, /still open/i);
  assert.match(instruction.directive, /do NOT invent the answer/);
  assert.equal(instruction.action, "PAY_PROMISE");
});
