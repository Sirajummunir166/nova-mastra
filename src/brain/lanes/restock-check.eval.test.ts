/**
 * The restock lane's contract — one fork, and everything hangs off it.
 *
 *   · A REAL purchase order ⇒ the customer gets that date, unrounded.
 *   · NOTHING ON ORDER ⇒ no date exists, so no date is written. Anywhere. The
 *     case fact, the report body and the structured `data` are all asserted to
 *     be date-free, because *"a date you made up is a second disappointment on
 *     top of the first"* is only true if nothing downstream can quietly supply
 *     one.
 *   · A DRAFT purchase order is NOT on order. Nobody has ordered anything, and
 *     the field cannot tell the difference between "we ordered it" and "we
 *     thought about ordering it".
 *
 * Plus the two facts that make it a founder-plane lane rather than a chat one:
 * several people waiting for one product is a DECISION worth raising, and the
 * decision is raised — not acted on, because drafting the PO belongs to
 * `night_ops`, which is surfaced as a capability gap rather than borrowed.
 *
 * Demo backend, no network — and no model at all: this lane is asserted to
 * make ZERO model calls, because the fork above is arithmetic and a model
 * invited to word a supply position it cannot check is how "next week" gets
 * invented.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  FACT_SOURCE,
  RESTOCK_DECISION_WAITERS,
  restockDecision,
  runRestockCheck,
  supplyPosition,
  waitersOn,
} from "./restock-check.js";
import { runDispatchTick } from "../dispatcher.js";
import { laneFor } from "../registry.js";
import { storeFor, resetStores } from "../../store/resolve.js";
import type {
  JobKind,
  NovaCaseView,
  NovaJob,
  Product,
  PurchaseOrder,
  StoreSeed,
} from "../../store/types.js";

process.env.NOVA_STORE_BACKEND = "demo";
delete process.env.NOVA_PG_URL;

/** This suite's own tenant — see the courier suite's note on the shared `.data`. */
const A = "store-restock-lane-eval";

const DAY = 86_400_000;
const PRODUCT_ID = "prod-restock-1";

function demo(storeId: string) {
  return storeFor(storeId) as unknown as { data: StoreSeed };
}

function stub(storeId: string, method: string, impl: (...args: never[]) => unknown): void {
  (storeFor(storeId) as unknown as Record<string, unknown>)[method] = impl;
}

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

/** The product everybody is waiting for. Out of stock unless a test says otherwise. */
function seedProduct(patch: Partial<Product> = {}): Product {
  const product: Product = {
    id: PRODUCT_ID,
    sku: "AUR-RST-01",
    name: "Jamdani Sharee",
    category: "Fashion",
    description: "Handloom jamdani.",
    price: 8500,
    compareAtPrice: null,
    cost: 4200,
    stock: 0,
    reorderPoint: 10,
    supplierId: "sup-artisan",
    status: "active",
    rating: 4.8,
    reviewCount: 62,
    weeklyVelocity: [6, 7, 8, 7, 9, 8, 10, 9],
    tags: [],
    variantNames: [],
    createdAt: new Date(Date.now() - 200 * DAY).toISOString(),
    ...patch,
  };
  demo(A).data.products.push(product);
  return product;
}

function seedPo(patch: Partial<PurchaseOrder> = {}): PurchaseOrder {
  const po: PurchaseOrder = {
    id: "po-restock-1",
    supplierId: "sup-artisan",
    productId: PRODUCT_ID,
    quantity: 40,
    unitCost: 4200,
    total: 168000,
    status: "placed",
    createdAt: new Date(Date.now() - 5 * DAY).toISOString(),
    expectedAt: new Date(Date.now() + 9 * DAY).toISOString(),
    ...patch,
  };
  demo(A).data.purchaseOrders.push(po);
  return po;
}

/** Open the one restock case a customer's question produces. */
async function seedCase(): Promise<NovaCaseView> {
  const { case: row } = await storeFor(A).openCase({
    kind: "restock_wait",
    conversationId: "conv-restock-1",
    productId: PRODUCT_ID,
    customerId: "cust-101",
    title: "Waiting for Jamdani Sharee to come back",
    factsNote: "Customer asked when it will be back.",
  });
  return row;
}

/**
 * Put `n` waiting threads on the case — the state a real store reaches when
 * several people ask about one product.
 *
 * WHY IT IS SET RATHER THAN JOINED. dakio-api joins the second asker into the
 * open case off `activeKeyFor`, which reads the case row's own `productId`
 * COLUMN. The demo backend's `NovaCaseView` has no productId field at all, so
 * its mirror of that function falls back to the conversation key and a PRODUCT
 * join cannot be expressed through `openCase` here. The join itself is the
 * server's behaviour and is tested there; this suite is about what the lane
 * does with the join list, so the list is set directly. `getCase` still returns
 * the real row (facts included) — only the waiter list is overlaid.
 */
function joinWaiters(caseId: string, n: number): void {
  const client = storeFor(A) as unknown as {
    getCase: (id: string) => Promise<NovaCaseView | null>;
  };
  const original = client.getCase.bind(client);
  client.getCase = async (id: string) => {
    const row = await original(id);
    if (!row || row.id !== caseId) return row;
    const ids = Array.from({ length: n }, (_, i) => `conv-restock-${i + 1}`);
    return { ...row, refs: { ...row.refs, conversationIds: ids } };
  };
}

/** Every fact this lane wrote onto the case, newest last. */
async function ourFacts(caseId: string): Promise<string[]> {
  const row = await storeFor(A).getCase(caseId);
  return (row?.facts ?? []).filter((f) => f.source === FACT_SOURCE).map((f) => f.note);
}

/** Anything that looks like a date a customer would hold the shop to. */
const DATE_SHAPED = /\d{4}-\d{2}-\d{2}|\bnext (week|month|monday|sunday)\b|\bin \d+ days?\b|\bby (the )?\d+/i;

beforeEach(() => {
  resetStores();
});
afterEach(() => {
  resetStores();
});

// ---------------------------------------------------------------------------
// THE HONESTY FORK
// ---------------------------------------------------------------------------

test("a REAL purchase order gives the customer a real date — the PO's own, unrounded", async () => {
  seedProduct();
  const po = seedPo();
  const caseRow = await seedCase();

  const result = await runRestockCheck(A, { caseId: caseRow.id, productId: PRODUCT_ID, conversationId: "conv-restock-1" });

  assert.equal(result.position.fork, "on_order");
  assert.equal(result.position.date, po.expectedAt, "the date is the purchase order's, not an estimate");
  assert.equal(result.modelCalls, 0, "no model was asked to word a supply position");

  const facts = await ourFacts(caseRow.id);
  assert.equal(facts.length, 1, "the answer is written where the reply is composed from");
  assert.match(facts[0]!, new RegExp(po.expectedAt.slice(0, 10)));
  assert.match(facts[0]!, /40 units are on order/);
  assert.match(facts[0]!, /not an estimate/);

  // One person waiting and stock genuinely coming: nothing for the founder.
  assert.equal(result.quiet, true, "a working supply chain is not news");
  assert.equal(result.reportId, undefined);
});

test("NOTHING ON ORDER: no date is written anywhere, and the founder is told", async () => {
  seedProduct();
  const caseRow = await seedCase();

  const result = await runRestockCheck(A, { caseId: caseRow.id, productId: PRODUCT_ID, conversationId: "conv-restock-1" });

  assert.equal(result.position.fork, "nothing_on_order");
  assert.equal(result.position.date, null, "there is no date, so there is no date");
  assert.equal(result.position.po, null);

  const note = (await ourFacts(caseRow.id))[0]!;
  assert.match(note, /NOTHING is on order/);
  assert.match(note, /no date to give/);
  assert.doesNotMatch(note, DATE_SHAPED, "the fact that gets quoted to a customer carries no invented date");

  // The structured half of the fact is checked too: it is what a future
  // composer would read in preference to the prose.
  const row = await storeFor(A).getCase(caseRow.id);
  const data = row!.facts.find((f) => f.source === FACT_SOURCE)!.data as Record<string, unknown>;
  assert.equal(data.expectedAt, null, "and no date rides in the structured data either");
  assert.equal(data.fork, "nothing_on_order");

  // Somebody is waiting for stock nobody has ordered — that IS the founder's.
  assert.ok(result.reportId, "a report is filed");
  const report = (await storeFor(A).listReports()).find((r) => r.id === result.reportId)!;
  assert.match(report.title, /nothing is on order/);
  assert.doesNotMatch(report.body.replace(/second disappointment/g, ""), DATE_SHAPED, "nor does the founder's copy");
  assert.match(report.body, /NO DATE/);
});

test("a DRAFT purchase order is not on order — nobody has ordered anything", async () => {
  seedProduct();
  seedPo({ status: "draft" });
  const caseRow = await seedCase();

  const result = await runRestockCheck(A, { caseId: caseRow.id, productId: PRODUCT_ID });

  assert.equal(result.position.fork, "nothing_on_order", "a draft PO is a piece of paper, not stock in transit");
  assert.equal(result.position.date, null);
});

test("an OVERDUE purchase order is on order with NO date — the first date is already broken", async () => {
  seedProduct();
  seedPo({ expectedAt: new Date(Date.now() - 3 * DAY).toISOString() });
  const caseRow = await seedCase();

  const result = await runRestockCheck(A, { caseId: caseRow.id, productId: PRODUCT_ID });

  assert.equal(result.position.fork, "on_order_overdue");
  assert.equal(result.position.date, null, "repeating a date that has already passed is a second disappointment");
  const note = (await ourFacts(caseRow.id))[0]!;
  assert.match(note, /It IS on order/);
  assert.match(note, /no new date to give/);
  assert.doesNotMatch(note, /\d{4}-\d{2}-\d{2}/);
});

test("already back in stock is the best answer there is, and it needs no date", async () => {
  seedProduct({ stock: 12 });
  const caseRow = await seedCase();

  const result = await runRestockCheck(A, { caseId: caseRow.id, productId: PRODUCT_ID });

  assert.equal(result.position.fork, "back_in_stock");
  assert.equal(result.position.date, null);
  assert.match((await ourFacts(caseRow.id))[0]!, /back in stock — 12 available right now/);
  assert.equal(result.quiet, true, "no decision to raise");
});

test("the earliest REAL arrival wins, whichever purchase order it is on", () => {
  const product = { id: PRODUCT_ID, name: "P", stock: 0 } as Product;
  const now = new Date().toISOString();
  const late = { id: "po-late", productId: PRODUCT_ID, status: "placed", quantity: 10, expectedAt: new Date(Date.now() + 20 * DAY).toISOString() } as PurchaseOrder;
  const early = { id: "po-early", productId: PRODUCT_ID, status: "in_transit", quantity: 5, expectedAt: new Date(Date.now() + 4 * DAY).toISOString() } as PurchaseOrder;
  const other = { id: "po-other", productId: "prod-else", status: "placed", quantity: 99, expectedAt: now } as PurchaseOrder;
  const position = supplyPosition({ product, purchaseOrders: [late, early, other], productId: PRODUCT_ID, now });
  assert.equal(position.po?.id, "po-early", "a waiting customer cares when the NEXT units land");
});

// ---------------------------------------------------------------------------
// Blindness is never filled in with a guess
// ---------------------------------------------------------------------------

test("a case that names no product says so and gives no date", async () => {
  const caseRow = await seedCase();
  const result = await runRestockCheck(A, { caseId: caseRow.id, productId: null, conversationId: "conv-restock-1" });

  assert.equal(result.position.fork, "unknown");
  assert.equal(result.position.date, null);
  assert.ok(result.blindSpots.some((b) => b.key === "field:product"));
  const note = (await ourFacts(caseRow.id))[0]!;
  assert.match(note, /could not run/);
  assert.match(note, /none has been guessed/);
});

test("a stock count Nova cannot read is NOT a count of zero", async () => {
  // Measured on the live stack, not imagined: dakio-api's `GET /products/:id`
  // strips the stock count (it is the customer-safe read and answers with an
  // availability band instead), and the first version of this lane read it —
  // producing "is out of stock (undefined)" on a real store. The lane now reads
  // the founder-plane list; this pins the behaviour when a count is missing
  // anyway.
  const product = seedProduct();
  delete (product as unknown as Record<string, unknown>).stock;
  const caseRow = await seedCase();

  const result = await runRestockCheck(A, { caseId: caseRow.id, productId: PRODUCT_ID });

  assert.equal(result.position.fork, "unknown", "an unreadable count is not zero");
  assert.equal(result.position.stock, null);
  assert.equal(result.position.date, null);
  assert.ok(result.blindSpots.some((b) => b.key === "field:stock"));
  const note = (await ourFacts(caseRow.id))[0]!;
  assert.match(note, /could not run/);
  assert.doesNotMatch(note, /out of stock/, "never assert a stock-out nobody measured");
});

test("a purchase-order read that FAILS must not read as 'nothing is on order'", async () => {
  seedProduct();
  const caseRow = await seedCase();
  stub(A, "listPurchaseOrders", async () => {
    throw new Error("503 from dakio-api");
  });

  const result = await runRestockCheck(A, { caseId: caseRow.id, productId: PRODUCT_ID });

  assert.equal(result.position.fork, "unknown", "an unread ledger is not an empty one");
  assert.notEqual(result.position.fork, "nothing_on_order");
  assert.ok(result.blindSpots.some((b) => b.key === "read:purchase_orders"));
  assert.equal(result.position.date, null);
});

// ---------------------------------------------------------------------------
// Three customers asking is a restock DECISION
// ---------------------------------------------------------------------------

test("several customers waiting for one product is raised for the founder — as a decision, not a PO", async () => {
  seedProduct();
  const caseRow = await seedCase();
  joinWaiters(caseRow.id, RESTOCK_DECISION_WAITERS);
  const wrote = watch(A, ["createPurchaseOrder", "addAction", "addDecision"]);

  const result = await runRestockCheck(A, { caseId: caseRow.id, productId: PRODUCT_ID, conversationId: "conv-restock-1" });

  assert.equal(result.waiting, RESTOCK_DECISION_WAITERS);
  assert.ok(result.reportId, "the founder is told");
  const report = (await storeFor(A).listReports()).find((r) => r.id === result.reportId)!;
  assert.match(report.title, /3 customers are waiting for Jamdani Sharee/);
  assert.match(report.body, /restock decision, not a coincidence/);

  // The decision is RAISED, never taken: no purchase order, no gated action.
  assert.equal(wrote.size, 0, "nothing was drafted, ordered or gated");
  const gap = result.gaps.find((g) => g.verb === "create_purchase_order");
  assert.ok(gap, "and the reason is stated rather than left as an absence");
  assert.equal(gap!.kind, "out_of_lane");
  assert.equal(gap!.wantedDuty, "inventory.reorder_drafts");
  assert.match(gap!.reason, /night_ops/);
  assert.match(report.body, /needs `inventory.reorder_drafts`/);
});

test("the waiter count is the CASE's join list, not a guess", async () => {
  const caseRow = {
    id: "case-x",
    conversationId: "conv-a",
    refs: { conversationIds: ["conv-a", "conv-b"] },
  } as unknown as NovaCaseView;
  assert.equal(waitersOn(caseRow, "conv-c"), 3, "the payload's own thread is unioned in, never double-counted");
  assert.equal(waitersOn(caseRow, "conv-a"), 2);
  assert.equal(
    waitersOn({ id: "y", conversationId: null, refs: {} } as unknown as NovaCaseView, null),
    0,
  );
});

test("one waiter with stock genuinely on the way raises nothing at all", () => {
  const position = supplyPosition({
    product: { id: PRODUCT_ID, name: "P", stock: 0 } as Product,
    purchaseOrders: [
      { id: "po", productId: PRODUCT_ID, status: "placed", quantity: 10, expectedAt: new Date(Date.now() + DAY).toISOString() } as PurchaseOrder,
    ],
    productId: PRODUCT_ID,
    now: new Date().toISOString(),
  });
  assert.equal(restockDecision(position, 1), null, "a report about the system working is spam");
  assert.equal(restockDecision(position, RESTOCK_DECISION_WAITERS)?.reason, "several_waiting");
});

// ---------------------------------------------------------------------------
// What it must never do
// ---------------------------------------------------------------------------

test("it never messages the waiting customer — that is case_update's work, and it says so", async () => {
  seedProduct();
  const caseRow = await seedCase();
  const touched = watch(A, ["replyInThread", "addCustomerMessage", "scheduleFollowup", "handoverConversation"]);

  const result = await runRestockCheck(A, { caseId: caseRow.id, productId: PRODUCT_ID, conversationId: "conv-restock-1" });

  assert.equal(touched.size, 0, "not one send path was touched");
  const gap = result.gaps.find((g) => g.verb === "send_inbox_reply");
  assert.ok(gap);
  assert.equal(gap!.wantedDuty, "support.inbox_replies");
  assert.match(gap!.reason, /case_update/);

  // And the lane no longer CLAIMS the duty it does not exercise.
  assert.deepEqual(laneFor("restock_check")!.duties, ["inventory.stock_monitoring"]);
});

test("the one ungoverned write is surfaced as a gap, every run", async () => {
  seedProduct({ stock: 3 });
  const caseRow = await seedCase();
  const result = await runRestockCheck(A, { caseId: caseRow.id, productId: PRODUCT_ID });
  const gap = result.gaps.find((g) => g.kind === "no_verb");
  assert.ok(gap, "writing a fact onto a case has no verb and no duty — say so");
  assert.equal(gap!.wantedDuty, null);
  assert.match(gap!.reason, /no duty on the roster/);
});

test("a re-leased rerun with the same supply position appends nothing twice", async () => {
  seedProduct();
  seedPo();
  const caseRow = await seedCase();

  const first = await runRestockCheck(A, { caseId: caseRow.id, productId: PRODUCT_ID });
  const second = await runRestockCheck(A, { caseId: caseRow.id, productId: PRODUCT_ID });

  assert.equal(first.factWritten, true);
  assert.equal(second.factWritten, false, "the case already carried this exact position");
  assert.equal((await ourFacts(caseRow.id)).length, 1);

  // But a position that MOVED is new truth, and append-only facts are for that.
  demo(A).data.products.find((p) => p.id === PRODUCT_ID)!.stock = 25;
  const third = await runRestockCheck(A, { caseId: caseRow.id, productId: PRODUCT_ID });
  assert.equal(third.factWritten, true);
  assert.equal((await ourFacts(caseRow.id)).length, 2);
});

test("a case that is already over completes truthfully and writes nothing", async () => {
  seedProduct();
  const caseRow = await seedCase();
  await storeFor(A).patchCase(caseRow.id, { status: "resolved", resolution: "Customer bought something else." });

  const result = await runRestockCheck(A, { caseId: caseRow.id, productId: PRODUCT_ID });

  assert.match(result.skipped ?? "", /already resolved/);
  assert.equal(result.quiet, true);
  assert.equal(result.factWritten, false);
  assert.equal((await ourFacts(caseRow.id)).length, 0, "nobody is waiting, so nothing is written");
});

test("a missing case, a missing caseId and the wrong case KIND all throw — the row releases", async () => {
  await assert.rejects(() => runRestockCheck(A, { caseId: "" }), /no payload.caseId/);
  await assert.rejects(() => runRestockCheck(A, { caseId: "case-nope" }), /does not exist/);

  const delivery = await storeFor(A).openCase({
    kind: "delivery_stuck",
    conversationId: "conv-other",
    orderId: "ord-1001",
    title: "Parcel stuck",
  });
  await assert.rejects(
    () => runRestockCheck(A, { caseId: delivery.case.id }),
    /is a "delivery_stuck" case, not "restock_wait"/,
  );
});

test("a case write that fails is NOT silent — the answer did not land", async () => {
  seedProduct();
  const caseRow = await seedCase();
  stub(A, "patchCase", async () => {
    throw new Error("409 case closed");
  });

  const result = await runRestockCheck(A, { caseId: caseRow.id, productId: PRODUCT_ID });

  assert.equal(result.factWritten, false);
  assert.match(result.factFailed ?? "", /409 case closed/);
  const report = (await storeFor(A).listReports()).find((r) => r.id === result.reportId)!;
  assert.match(report.body, /could NOT be written onto the case/);
});

// ---------------------------------------------------------------------------
// The dispatcher
// ---------------------------------------------------------------------------

test("the dispatcher routes restock_check to its runner — not to lane_not_built", async () => {
  seedProduct();
  const caseRow = await seedCase();
  const jobId = enqueue(A, "restock_check", {
    caseId: caseRow.id,
    productId: PRODUCT_ID,
    conversationId: "conv-restock-1",
    customerId: "cust-101",
    triggeredBy: "case.opened",
  });

  const report = await runDispatchTick({ tenantIds: [A] });
  const job = report.jobs.find((j) => j.jobId === jobId);
  assert.ok(job, "the row was claimed");
  assert.equal(job!.lane, "founder_plane", "routed to the founder plane, not released as unbuilt");
  assert.equal(job!.settled, "completed");
  assert.equal(job!.modelCalls, 0, "and the tick report shows what an honest answer costs: nothing");
  assert.equal((await ourFacts(caseRow.id)).length, 1, "the supply position is on the case");
});

let jobSeq = 0;
function enqueue(storeId: string, kind: JobKind, payload: Record<string, unknown>): string {
  const id = `job_rc_${++jobSeq}`;
  const jobs = (demo(storeId).data.jobs ??= []) as NovaJob[];
  jobs.push({
    id,
    kind,
    payload,
    dueAt: new Date(Date.now() - 1000).toISOString(),
    priority: 5,
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
