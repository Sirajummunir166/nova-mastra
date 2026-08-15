/**
 * The courier-intervention lane's contract — and it is almost entirely a
 * contract about what Nova MAY NOT SAY.
 *
 * The lane's product value (tracking id, last scan, dwell, what the customer
 * was told, the one ask) is easy to assert and easy to get right. The three
 * things that make it shippable are the ones a prompt alone cannot hold:
 *
 *  1. IT NEVER CLAIMS DAKIO CONTACTED THE COURIER. Dakio can book, cancel,
 *     poll and receive webhooks — it cannot reschedule, redirect or hold a
 *     parcel. A model that writes "we've rescheduled it for tomorrow" is
 *     REPLACED by the measurement, and the card carries the limit in words.
 *  2. IT NEVER MESSAGES THE CUSTOMER. That is `case_update`'s work, after the
 *     owner has acted. The bound is structural (the lane holds no reply duty,
 *     so the gate would throw) and it is asserted from the outside: no send
 *     method on the client is touched.
 *  3. A LANE WITH NOTHING TO SAY SAYS NOTHING. A parcel that moved since the
 *     sweep flagged it produces no card at all, and completes truthfully.
 *
 * Demo backend, no network, no model: `ask` is injected in every case.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  boundAsk,
  courierCardTitle,
  DAKIO_CANNOT,
  fallbackAsk,
  gatherParcel,
  parcelCard,
  runCourierIntervention,
  MOVED_RECENTLY_HOURS,
  type AskFn,
} from "./courier-intervention.js";
import { runDispatchTick } from "../dispatcher.js";
import { laneFor } from "../registry.js";
import { governingDuties } from "../../store/duties.js";
import { gateOrFile } from "../../front-office/actions.js";
import { storeFor, resetStores } from "../../store/resolve.js";
import type { JobKind, NovaJob, Order, OrderStatusView, StoreSeed } from "../../store/types.js";

process.env.NOVA_STORE_BACKEND = "demo";
delete process.env.NOVA_PG_URL;

/**
 * THIS SUITE'S OWN TENANT. `node --test` runs files concurrently in separate
 * processes over one `.data` directory, and the pulse suite has already paid
 * for sharing a store id with another file (its own header records the flake).
 * An unknown id gets the standard Aurora seed from `resolve.ts`.
 */
const A = "store-courier-lane-eval";

const HOUR = 3_600_000;

function demo(storeId: string) {
  return storeFor(storeId) as unknown as { data: StoreSeed };
}

/** Replace one client method for this case. `resetStores` throws it away after. */
function stub(storeId: string, method: string, impl: (...args: never[]) => unknown): void {
  (storeFor(storeId) as unknown as Record<string, unknown>)[method] = impl;
}

/** Record which client methods were called, keeping the real behaviour. */
function watch(storeId: string, methods: string[]): Set<string> {
  const seen = new Set<string>();
  const client = storeFor(storeId) as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const method of methods) {
    const original = client[method]!.bind(client);
    client[method] = (...args: unknown[]) => {
      seen.add(method);
      return original(...args);
    };
  }
  return seen;
}

const ORDER_ID = "ord-stuck-1";
const CONV_ID = "conv-stuck-1";

/**
 * A parcel that has sat still for five days with a real courier, a real
 * tracking id, and a customer who was told it would arrive.
 *
 * The delivery view is STUBBED rather than taken from the demo backend's own
 * `getOrderStatus`: that method honestly reports `lastMovedAt: null` for every
 * order (the demo carries no courier scans), and the interesting assertions
 * here are about a parcel whose last scan is real and old.
 */
function stuckParcel(
  overrides: Partial<OrderStatusView> = {},
  orderPatch: Partial<Order> = {},
): void {
  const now = Date.now();
  const order: Order = {
    id: ORDER_ID,
    customerId: "cust-101",
    items: [],
    subtotal: 2400,
    discount: 0,
    shipping: 120,
    total: 2520,
    status: "fulfilled",
    courierId: "cour-meridian",
    placedAt: new Date(now - 8 * 24 * HOUR).toISOString(),
    deliveredAt: null,
    region: "east",
    ...orderPatch,
  };
  demo(A).data.orders.push(order);

  const status: OrderStatusView = {
    orderNumber: ORDER_ID,
    displayStatus: "At the courier hub",
    statusStep: 3,
    courierProvider: "cour-meridian",
    codAmount: 2520,
    placedAt: order.placedAt,
    courierSentAt: new Date(now - 6 * 24 * HOUR).toISOString(),
    lastMovedAt: new Date(now - 5 * 24 * HOUR).toISOString(),
    confirmed: true,
    stuck: true,
    // The two ids are DIFFERENT on purpose. `trackingCode` is the Dakio order
    // number the customer's own tracking link shows; `courierTrackingId` is
    // what Meridian knows the parcel by. Every assertion below that says "the
    // owner reads this out" must land on the COURIER's one — the fixture used
    // to carry only `trackingCode`, which is how the live card ended up telling
    // a founder to read a Dakio order number to a courier.
    trackingCode: "DAKIO-ORDER-4471",
    courierTrackingId: "MER-7781-XZ",
    bookedCourierType: "cour-meridian",
    openCase: null,
    ...overrides,
  };
  stub(A, "getOrderStatus", async (id: never) => (id === ORDER_ID ? status : null));
}

/** A thread where the customer asked and Nova already answered once. */
function seedThread(): void {
  (storeFor(A) as unknown as { seedInboxConversation: (s: unknown) => unknown }).seedInboxConversation({
    id: CONV_ID,
    messages: [
      { direction: "in", actor: "customer", text: "vai amar parcel kobe asbe?", sentAt: new Date(Date.now() - 3 * 24 * HOUR).toISOString() },
      { direction: "out", actor: "nova", text: "Apnar parcel courier er kache ache, khub shiggiri pouche jabe.", sentAt: new Date(Date.now() - 3 * 24 * HOUR + 60_000).toISOString() },
    ],
  });
}

/** An `ask` that counts, so "one model call" is measured and not asserted from a comment. */
function countingAsk(answer: { ask: string; read: string }): { ask: AskFn; calls: () => number; cards: string[] } {
  let calls = 0;
  const cards: string[] = [];
  return {
    ask: async ({ card }) => {
      calls += 1;
      cards.push(card);
      return answer;
    },
    calls: () => calls,
    cards,
  };
}

const goodAsk = {
  ask: "Ask them where the parcel physically is now and when the next delivery attempt is.",
  read: "At the courier hub with no movement, and the customer was told it would arrive shortly.",
};

async function actions(storeId = A) {
  return storeFor(storeId).listActions();
}

beforeEach(() => {
  resetStores();
});
afterEach(() => {
  resetStores();
});

// ---------------------------------------------------------------------------
// The homework
// ---------------------------------------------------------------------------

test("a stuck parcel becomes ONE founder card carrying the whole homework", async () => {
  stuckParcel();
  seedThread();
  const judge = countingAsk(goodAsk);

  const result = await runCourierIntervention(
    A,
    { orderId: ORDER_ID, conversationId: CONV_ID, journeyId: "jrn-1", riskReason: "delivery_stagnation" },
    { ask: judge.ask },
  );

  assert.equal(result.outcome.kind, "card_filed", "the founder gets a card, not a log line");
  assert.equal(judge.calls(), 1, "exactly one model call — the ask is the only judgement in the lane");
  assert.equal(result.modelCalls, 1);
  assert.equal(result.quiet, false);

  const filed = (await actions()).filter((a) => a.type === "flag_courier_issue");
  assert.equal(filed.length, 1, "one parcel, one artifact");
  const row = filed[0]!;

  // ALWAYS_DRAFT: a proposal at every tier, forever. The demo store sits at
  // level 2 and it is a card here; at level 4 it would still be a card.
  assert.equal(row.status, "prepared", "the verb is ALWAYS_DRAFT — homework is never auto-executed");
  assert.equal(row.dutyRef, "shipping.delay_chasing");

  // The homework, field by field, off the receipt the founder's card renders.
  const evidence = new Map((row.receipt?.evidence ?? []).map((e) => [e.source, e]));
  assert.equal(evidence.get("courier:tracking")?.value, "MER-7781-XZ", "the tracking id the owner reads out");
  assert.match(String(evidence.get("courier:last_scan")?.note), /At the courier hub/, "what the last scan said");
  assert.equal(evidence.get("courier:dwell")?.value, 120, "dwell measured in code: 5 days = 120 hours");
  assert.match(
    String(evidence.get("inbox:customer_told")?.note),
    /khub shiggiri pouche jabe/,
    "what the customer was ALREADY told — half the homework",
  );
  assert.equal(evidence.get("courier:ask")?.note, goodAsk.ask, "and the one thing to ask the courier");

  // The card names the parcel and the wait, and is derived — not model prose.
  assert.match(row.title, /Call Meridian Express about order ord-stuck-1/);
  assert.match(row.title, /no movement for 5 days/);

  // The founder actually has something to tap.
  const decisions = await storeFor(A).listDecisions();
  assert.equal(decisions.filter((d) => d.actionId === row.id).length, 1, "a Decision card on the desk");
});

test("the payload is the one nova-ai's executor reads, and it carries no case it did not find", async () => {
  stuckParcel();
  await runCourierIntervention(A, { orderId: ORDER_ID }, { ask: countingAsk(goodAsk).ask });
  const row = (await actions()).find((a) => a.type === "flag_courier_issue")!;
  const p = row.payload as Record<string, unknown>;
  assert.equal(p.orderId, ORDER_ID);
  assert.equal(p.courierType, "Meridian Express");
  assert.equal(p.trackingId, "MER-7781-XZ");
  assert.equal(p.recommendation, goodAsk.ask);
  assert.equal(p.caseId, null, "no case is open for this parcel, and the payload says so rather than inventing one");
  assert.equal(p.novaActionId, `nm:courier_intervention:${ORDER_ID}:${storeFor(A).now().slice(0, 10)}`);
});

// ---------------------------------------------------------------------------
// HONESTY RULE 1 — Dakio cannot reschedule, and nothing contacted the courier
// ---------------------------------------------------------------------------

test("a model that claims Nova contacted the courier is REPLACED by the measurement", async () => {
  stuckParcel();
  const liar = countingAsk({
    ask: "We have already contacted Meridian Express and rescheduled the delivery for tomorrow.",
    read: "The courier has been notified and the parcel has been redirected to the new address.",
  });

  const result = await runCourierIntervention(A, { orderId: ORDER_ID }, { ask: liar.ask });

  assert.equal(result.outcome.kind, "card_filed", "the card is still filed — the parcel is still stuck");
  assert.equal(result.ask, fallbackAsk(await facts()), "the deterministic ask replaced the claim");
  assert.equal(result.rejections.length, 2, "both lines were set aside, and the run says so");
  assert.match(result.rejections.join(" "), /contacted the courier/);

  const row = (await actions()).find((a) => a.type === "flag_courier_issue")!;
  const rendered = JSON.stringify(row);
  assert.doesNotMatch(rendered, /rescheduled/i, "nothing on the card says the parcel was rescheduled");
  assert.doesNotMatch(rendered, /has been notified/i, "and nothing says the courier was notified");
  // And the card states the limit in words, on every run.
  const limits = (row.receipt?.evidence ?? []).find((e) => e.source === "courier:limits");
  assert.equal(limits?.note, DAKIO_CANNOT);
  assert.equal(limits?.value, "no");
});

test("the bound refuses the claim and keeps the ASK — an owner's ask is not a lie", () => {
  const card = "PARCEL: order o1 · tracking T1\nSAT STILL FOR: 120 hours (about 5 days)";
  const fallback = "FALLBACK";
  const bound = (raw: string) => boundAsk(raw, { card, fallback, maxLen: 160 });

  // The legitimate shape of this lane's whole output: the OWNER asks, the
  // COURIER acts. Rejecting these would leave the lane with nothing to say.
  for (const ok of [
    "Ask them to reschedule delivery for tomorrow morning.",
    "Ask where the parcel physically is and when the next attempt is.",
    "Ask them to hold it at the hub so the customer can collect it.",
  ]) {
    assert.equal(bound(ok).rejected, null, `an owner's ask must survive: ${ok}`);
  }

  // The lies, each in the shape a model actually produces them.
  for (const bad of [
    "We have contacted the courier about this parcel.",
    // The wording a model actually produced, and the one the first version of
    // the pattern let through: the filler between the pronoun and the verb.
    "We have already contacted Meridian Express and rescheduled the delivery for tomorrow.",
    "Nova rescheduled the delivery for tomorrow.",
    "We will call Steadfast and redirect it.",
    "The courier has been informed and the parcel was rescheduled.",
    "I've told the customer it will arrive tomorrow.",
  ]) {
    const out = bound(bad);
    assert.equal(out.text, fallback, `a false claim must not reach a founder: ${bad}`);
    assert.ok(out.rejected, "and the rejection is named");
  }

  // The pulse's number rule, kept: a figure nobody measured is not a figure.
  assert.ok(bound("Ask why it has not moved in 9 days.").rejected, "9 is not in the card");
  assert.equal(bound("Ask why it has not moved in 120 hours.").rejected, null, "120 is");
});

test("the card gives the model the dwell in BOTH units, so an honest sentence survives", async () => {
  stuckParcel();
  const card = parcelCard(await facts());
  assert.match(card, /120 hours \(about 5 days\)/);
  assert.match(card, /WHAT DAKIO CAN DO/);
  assert.match(card, /CANNOT reschedule, redirect or hold/);
  assert.match(card, /DO NOT write a message to the customer/);
});

// ---------------------------------------------------------------------------
// HONESTY RULE 2 — this job does not message the customer, and does not re-poll
// ---------------------------------------------------------------------------

test("nothing in this lane speaks to the customer, and the division of labour is SURFACED", async () => {
  stuckParcel();
  seedThread();
  const touched = watch(A, ["replyInThread", "addCustomerMessage", "scheduleFollowup", "handoverConversation"]);

  const result = await runCourierIntervention(A, { orderId: ORDER_ID, conversationId: CONV_ID }, { ask: countingAsk(goodAsk).ask });

  assert.equal(touched.size, 0, "not one send path was touched");
  const gap = result.gaps.find((g) => g.verb === "send_inbox_reply");
  assert.ok(gap, "the absence is stated as a capability gap, not left to be inferred");
  assert.equal(gap!.kind, "out_of_lane");
  assert.equal(gap!.wantedDuty, "support.inbox_replies");
  assert.match(gap!.reason, /case_update/, "and it names the lane that DOES tell the customer");
});

test("it reads what courierSync already wrote and writes nothing back to the parcel", async () => {
  stuckParcel();
  const written = watch(A, ["updateOrder", "updateOrderDelivery", "openCase", "patchCase"]);
  await runCourierIntervention(A, { orderId: ORDER_ID }, { ask: countingAsk(goodAsk).ask });
  assert.equal(written.size, 0, "no re-poll, no case opened, no case patched — the card is the only artifact");
});

test("a parcel nobody has asked about is honest about it rather than assuming silence is fine", async () => {
  stuckParcel();
  const result = await runCourierIntervention(A, { orderId: ORDER_ID, conversationId: null }, { ask: countingAsk(goodAsk).ask });
  assert.ok(result.blindSpots.some((b) => b.key === "thread:absent"));
  assert.equal(result.customerToldText, null);
  const row = (await actions()).find((a) => a.type === "flag_courier_issue")!;
  assert.match(
    String((row.receipt?.evidence ?? []).find((e) => e.source === "inbox:customer_told")?.note),
    /has not been told anything/,
  );
  assert.equal(
    result.gaps.some((g) => g.verb === "send_inbox_reply"),
    false,
    "and no reply gap is raised for a parcel with no thread — there is nobody to reply to",
  );
});

// ---------------------------------------------------------------------------
// A lane with nothing to say
// ---------------------------------------------------------------------------

test("a parcel that was DELIVERED since the sweep files nothing and completes truthfully", async () => {
  stuckParcel({ displayStatus: "Delivered" }, { status: "delivered" });
  const judge = countingAsk(goodAsk);

  const result = await runCourierIntervention(A, { orderId: ORDER_ID }, { ask: judge.ask });

  assert.equal(result.outcome.kind, "nothing_to_chase");
  assert.match(result.outcome.kind === "nothing_to_chase" ? result.outcome.reason : "", /delivered since the sweep/);
  assert.equal(result.quiet, true, "nothing reached the founder");
  assert.equal(judge.calls(), 0, "and nothing was spent finding that out");
  assert.equal((await actions()).filter((a) => a.type === "flag_courier_issue").length, 0);
});

test("a parcel that MOVED inside the stagnation window is not chased", async () => {
  stuckParcel({ lastMovedAt: new Date(Date.now() - 2 * HOUR).toISOString() });
  const result = await runCourierIntervention(A, { orderId: ORDER_ID }, { ask: countingAsk(goodAsk).ask });
  assert.equal(result.outcome.kind, "nothing_to_chase");
  assert.match(
    result.outcome.kind === "nothing_to_chase" ? result.outcome.reason : "",
    new RegExp(`${MOVED_RECENTLY_HOURS}-hour`),
  );
  assert.equal((await actions()).length === 0 || (await actions()).every((a) => a.type !== "flag_courier_issue"), true);
});

test("a dead ask model still puts a real question on the desk — never a blank, never a claim", async () => {
  stuckParcel();
  const result = await runCourierIntervention(
    A,
    { orderId: ORDER_ID },
    {
      ask: async () => {
        throw new Error("gateway down");
      },
    },
  );
  assert.equal(result.outcome.kind, "card_filed");
  assert.match(result.ask, /where this parcel physically is now and when the next delivery attempt is/);
  assert.match(result.ask, /MER-7781-XZ/, "with the tracking id the owner reads out");
  assert.equal(result.modelCalls, 1, "the attempt is counted even though it failed");
});

// ---------------------------------------------------------------------------
// Never a fake completion
// ---------------------------------------------------------------------------

test("a job with no orderId, and a parcel Nova cannot read, both THROW — the row releases", async () => {
  await assert.rejects(
    () => runCourierIntervention(A, { orderId: "" }, { ask: countingAsk(goodAsk).ask }),
    /no payload.orderId/,
  );
  stub(A, "getOrder", async () => {
    throw new Error("500 from dakio-api");
  });
  stub(A, "getOrderStatus", async () => {
    throw new Error("500 from dakio-api");
  });
  await assert.rejects(
    () => runCourierIntervention(A, { orderId: "ord-nope" }, { ask: countingAsk(goodAsk).ask }),
    /could not read order/,
  );
});

test("two runs on the same parcel on the same day file ONE card", async () => {
  stuckParcel();
  const first = await runCourierIntervention(A, { orderId: ORDER_ID }, { ask: countingAsk(goodAsk).ask });
  const second = await runCourierIntervention(A, { orderId: ORDER_ID }, { ask: countingAsk(goodAsk).ask });
  assert.equal(first.outcome.kind, "card_filed");
  assert.equal(second.outcome.kind, "replayed", "a re-leased rerun answers from the row that owns the key");
  assert.equal((await actions()).filter((a) => a.type === "flag_courier_issue").length, 1);
});

// ---------------------------------------------------------------------------
// The duty bound
// ---------------------------------------------------------------------------

test("the lane files under a duty that GOVERNS the verb and that it actually holds", async () => {
  const lane = laneFor("courier_intervention")!;
  assert.deepEqual(lane.duties, ["shipping.delay_chasing"], "one duty, for the one verb it files");
  assert.ok(governingDuties("flag_courier_issue").includes("shipping.delay_chasing"));

  // And the gate REFUSES the duty the lane no longer claims, even though that
  // duty legitimately governs the verb — which is the registry bound doing its
  // job rather than documenting itself.
  assert.ok(governingDuties("flag_courier_issue").includes("shipping.delivery_cases"));
  await assert.rejects(
    () =>
      gateOrFile(storeFor(A), {
        verb: "flag_courier_issue",
        department: "shipping",
        dutyRef: "shipping.delivery_cases",
        lane: "courier_intervention",
        origin: "job",
        door: "courier",
        title: "t",
        paramsLine: "p",
        payload: { novaActionId: "nm:test:1" },
        receipt: { reason: "r", expectedImpact: "i", confidence: 1, evidence: [] },
        preparedDetail: () => "d",
      }),
    /may not act under duty "shipping.delivery_cases"/,
  );
});

// ---------------------------------------------------------------------------
// The dispatcher
// ---------------------------------------------------------------------------

test("the dispatcher routes courier_intervention to its runner — not to lane_not_built", async () => {
  stuckParcel();
  seedThread();
  // The gateway is never reached: without a credential the ask fails and the
  // lane falls back to its deterministic question, which is a real answer.
  const jobId = enqueue(A, "courier_intervention", {
    orderId: ORDER_ID,
    journeyId: "jrn-1",
    conversationId: CONV_ID,
    triggeredBy: "sweep.stagnation",
    riskReason: "delivery_stagnation",
  });

  const report = await runDispatchTick({ tenantIds: [A] });
  const job = report.jobs.find((j) => j.jobId === jobId);
  assert.ok(job, "the row was claimed");
  assert.equal(job!.lane, "founder_plane", "routed to the founder plane, not released as unbuilt");
  assert.equal(job!.settled, "completed");
  assert.equal(job!.quiet, undefined, "a stuck parcel is not a quiet run");
  assert.ok(Array.isArray(job!.blindSpots), "and the tick report carries what the lane could not see");
  assert.equal((await actions()).filter((a) => a.type === "flag_courier_issue").length, 1);
});

// ---------------------------------------------------------------------------
// helpers that need a live store
// ---------------------------------------------------------------------------

async function facts() {
  return gatherParcel(storeFor(A), { orderId: ORDER_ID, conversationId: null }, storeFor(A).now());
}

let jobSeq = 0;
function enqueue(storeId: string, kind: JobKind, payload: Record<string, unknown>): string {
  const id = `job_ci_${++jobSeq}`;
  const jobs = (demo(storeId).data.jobs ??= []) as NovaJob[];
  jobs.push({
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

test("the derived title never becomes model prose, however long the ask is", async () => {
  stuckParcel();
  const f = await facts();
  assert.equal(courierCardTitle(f), "Call Meridian Express about order ord-stuck-1 — no movement for 5 days");
});
