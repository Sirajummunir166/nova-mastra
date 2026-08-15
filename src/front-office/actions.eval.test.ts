/**
 * Order-gate suite (phase D unit 1) — the approval-gated live tier, hermetic
 * against the DEMO backend (deterministic, no network, no model).
 *
 * What it pins, per the design as found in nova-ai (`performAction` +
 * `create_order_from_chat` tool/executor) and dakio-api (`novaExecutors.js`):
 *
 *  1. APPROVAL TIER (the shipping default — `inbox.orderAuto` FALSE, seed
 *     level 2): a decided CREATE_ORDER files a fully-prepared action visible
 *     in the queue plus a founder Decision — and creates NO order, decrements
 *     NO stock.
 *  2. AUTO TIER (level 3 + `inbox.orderAuto` true + caps satisfied): the gate
 *     executes `createChatOrder` directly — server-priced order, stock
 *     decremented, executed ledger row with the undo key dakio-api dispatches
 *     on.
 *  3. PAYLOAD CONTRACT: byte-compatible with nova-ai's schema — no price
 *     fields anywhere in the filed payload, `confirmedByCustomer` literal
 *     true, title says WHAT and WHERE and never the phone.
 *  4. AT-MOST-ONCE: the same `novaActionId` twice files once / orders once.
 *  5. TURN WIRING: `runCustomerTurn` live reaches the gate (prepared filed,
 *     no order); shadow records `wouldHaveDone` and touches nothing.
 */

import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.NOVA_STORE_BACKEND = "demo";
process.env.NOVA_SERVICE_SECRET = "order-gate-suite-secret";
delete process.env.NOVA_SERVICE_TOKEN;
delete process.env.NOVA_SERVICE_TOKENS;
delete process.env.NOVA_PG_URL;

import { storeFor, resetStores } from "../store/resolve.js";
import { DemoStore } from "../store/backend.js";
import { DEFAULT_GUARDRAILS } from "../store/autonomy.js";
import { performCreateOrder, orderTitle, type ChatOrderGatePayload } from "./actions.js";
import { runCustomerTurn } from "./turn.js";
import { loadContext, primeContext, resetContext, saveContext } from "./context-store.js";
import { focusProduct } from "./hydrate.js";
import { fact } from "./state.js";
import type { DakioProduct } from "./dakio.js";

const AURORA = "store-aurora";
const CONV = "conv-order-gate-1";

/** prod-bottle in the Aurora seed: ৳3,599, stock 104, no variants. */
const BOTTLE = "prod-bottle";
const PHONE = "01712345678";

function demo(): DemoStore {
  return storeFor(AURORA) as unknown as DemoStore;
}

/** Prepared rows for THIS verb (the seed ships unrelated prepared rows). */
async function preparedOrderCount(store: DemoStore): Promise<number> {
  return (await store.listActions("prepared")).filter((a) => a.type === "create_order_from_chat").length;
}

/** Queued cards whose action is a chat order filed by this run. */
async function queuedOrderCardCount(store: DemoStore): Promise<number> {
  const orderActionIds = new Set(
    (await store.listActions()).filter((a) => a.type === "create_order_from_chat").map((a) => a.id),
  );
  return (await store.listDecisions({ status: "queued" })).filter((d) => orderActionIds.has(d.actionId)).length;
}

function payloadFor(key: string, over: Partial<ChatOrderGatePayload> = {}): ChatOrderGatePayload {
  return {
    novaActionId: key,
    conversationId: CONV,
    customerName: "Test Customer",
    customerPhone: PHONE,
    customerCity: "Dhaka",
    customerDistrict: "Dhaka",
    customerAddress: "House 5, Road 2, Dhanmondi",
    items: [{ productId: BOTTLE, productName: "Insulated Steel Bottle 750ml", qty: 2 }],
    confirmedByCustomer: true,
    ...over,
  };
}

const RECEIPT = {
  reason: "Customer confirmed the itemized order in this thread: bottle × 2 to Dhaka.",
  expectedImpact: "≈৳7,318 COD order (server prices finally).",
  confidence: 0.9,
  evidence: [{ source: "conversation", note: "customer replied yes to the final order summary" }],
};

async function enableAutoTier(store: DemoStore): Promise<void> {
  await store.setAutonomy({
    level: 3,
    guardrails: {
      ...DEFAULT_GUARDRAILS,
      "inbox.orderAuto": true,
      "inbox.maxAutoOrder": 20_000,
      "inbox.rtoShadowThreshold": 3,
    },
    updatedAt: new Date().toISOString(),
  });
}

beforeEach(() => {
  resetStores();
  demo().seedInboxConversation({ id: CONV });
});

// ---------------------------------------------------------------------------
// 1. Approval tier — the shipping default (FD-3)
// ---------------------------------------------------------------------------

test("default store: a confirmed order FILES a prepared action + Decision and creates NO order", async () => {
  const store = demo();
  const ordersBefore = (await store.listOrders()).length;
  const stockBefore = (await store.getProduct(BOTTLE))!.stock;

  const out = await performCreateOrder(AURORA, { payload: payloadFor("nm:conv-order-gate-1:order-0"), receipt: RECEIPT });
  assert.equal(out.status, "prepared");
  assert.match(out.detail, /shop confirms/i, "FD-3: the reply material says the shop confirms it — not an apology");

  // The prepared row is visible in the queue, shaped for dakio-api's executor.
  // (The Aurora seed ships its own prepared rows + queued cards, so every
  // count below is scoped to THIS verb / this run's cards.)
  const prepared = (await store.listActions("prepared")).filter((a) => a.type === "create_order_from_chat");
  assert.equal(prepared.length, 1);
  const row = prepared[0]!;
  assert.equal(row.type, "create_order_from_chat");
  assert.equal(row.department, "sales");
  assert.equal(row.dutyRef, "sales.inbox_orders");
  assert.equal(row.status, "prepared");
  assert.equal(row.decidedAt, null, "prepared rows are undecided");
  const p = row.payload as Record<string, unknown>;
  assert.equal(p.confirmedByCustomer, true);
  assert.equal(p.conversationId, CONV, "the sourceConversationId join rides on the payload");
  assert.ok(Array.isArray(p.items) && (p.items as unknown[]).length === 1);
  // The gate rule rides as evidence — prepared rows name their rule (nova-ai's
  // 2026-08-10 lesson).
  const gateEv = row.receipt.evidence.find((e) => e.source === "authority_gate");
  assert.ok(gateEv, "prepared row carries the authority_gate evidence");

  // One Decision, queued, surfaced under the Orders door, phone nowhere on it.
  const decisions = (await store.listDecisions({ status: "queued" })).filter((d) => d.actionId === row.id);
  assert.equal(decisions.length, 1);
  const d = decisions[0]!;
  assert.equal(d.kind, "proposal");
  assert.equal(d.tag, "sales");
  assert.equal(d.actionId, row.id);
  assert.ok(d.surfacedIn.includes("door:orders"), "chat orders surface under Orders, not the sales dept's Coupons door");
  assert.equal(d.title, "Chat order: 2 items to Dhaka, Dhaka", "WHAT and WHERE — the tool's title rule");
  assert.ok(!d.title.includes(PHONE) && !d.paramsLine.includes(PHONE), "no phone on the card");
  assert.ok(!d.paramsLine.includes("Dhanmondi"), "no street line on the card");
  assert.match(d.paramsLine, /Insulated Steel Bottle 750ml ×2/, "goods on the params line");

  // NOTHING was sold: no order row, stock untouched.
  assert.equal((await store.listOrders()).length, ordersBefore, "no Order row on the approval tier");
  assert.equal((await store.getProduct(BOTTLE))!.stock, stockBefore, "stock untouched on the approval tier");
});

test("payload contract: the filed payload carries NO price fields at any depth", async () => {
  const store = demo();
  await performCreateOrder(AURORA, { payload: payloadFor("nm:conv-order-gate-1:order-0"), receipt: RECEIPT });
  const [row] = (await store.listActions("prepared")).filter((a) => a.type === "create_order_from_chat");
  assert.ok(row);

  const FORBIDDEN = /^(price|unitPrice|total|subtotal|discount|paid|amount|codAmount|shippingCharge)$/;
  const offending: string[] = [];
  (function walk(value: unknown, path: string): void {
    if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}[${i}]`));
    else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        if (FORBIDDEN.test(k)) offending.push(`${path}.${k}`);
        walk(v, `${path}.${k}`);
      }
    }
  })(row.payload, "payload");
  assert.deepEqual(offending, [], "the server prices every line — the payload may not carry money");
});

test("at-most-once: the same novaActionId twice files ONE action and ONE decision", async () => {
  const store = demo();
  const key = "nm:conv-order-gate-1:order-0";
  const first = await performCreateOrder(AURORA, { payload: payloadFor(key), receipt: RECEIPT });
  const second = await performCreateOrder(AURORA, { payload: payloadFor(key), receipt: RECEIPT });

  assert.equal(first.status, "prepared");
  assert.equal(second.status, "prepared");
  assert.equal(second.replayed, true, "the redelivery is answered from the ledger");
  assert.equal(second.actionId, first.actionId, "same card, not a second one");
  assert.equal(await preparedOrderCount(store), 1);
  assert.equal(await queuedOrderCardCount(store), 1);
});

test("a DIFFERENT novaActionId is a different order and files its own card", async () => {
  const store = demo();
  await performCreateOrder(AURORA, { payload: payloadFor("nm:conv-order-gate-1:order-0"), receipt: RECEIPT });
  await performCreateOrder(AURORA, { payload: payloadFor("nm:conv-order-gate-1:order-1"), receipt: RECEIPT });
  assert.equal(await preparedOrderCount(store), 2);
  assert.equal(await queuedOrderCardCount(store), 2);
});

// ---------------------------------------------------------------------------
// 2. Auto tier — inbox.orderAuto true, level 3, caps satisfied
// ---------------------------------------------------------------------------

test("auto tier: the gate EXECUTES — server-priced order, stock decremented, undoable executed row", async () => {
  const store = demo();
  await enableAutoTier(store);
  const stockBefore = (await store.getProduct(BOTTLE))!.stock;
  const ordersBefore = (await store.listOrders()).length;

  const out = await performCreateOrder(AURORA, { payload: payloadFor("nm:conv-order-gate-1:order-0"), receipt: RECEIPT });
  assert.equal(out.status, "executed");
  assert.equal(out.replayed, false);
  assert.ok(out.order, "a fresh execution returns the server's order");
  // Server-priced: 2 × ৳3,599 + inside-Dhaka delivery ৳60 (dakio column defaults).
  assert.equal(out.order!.total, 2 * 3599 + 60);
  assert.equal(out.order!.shippingCharge, 60);

  assert.equal((await store.listOrders()).length, ordersBefore + 1, "one real Order row");
  assert.equal((await store.getProduct(BOTTLE))!.stock, stockBefore - 2, "stock decremented in the same write");

  const executed = (await store.listActions("executed")).filter((a) => a.type === "create_order_from_chat");
  assert.equal(executed.length, 1);
  const row = executed[0]!;
  assert.equal(row.undoable, true);
  assert.equal((row.undoData as Record<string, unknown>)?.kind, "cancel_chat_order", "the key dakio-api's UNDO map dispatches on");
  assert.equal(row.targetRef, `order:${out.order!.id}`);
  assert.equal((row.receipt.after as Record<string, unknown>)?.orderNumber, out.order!.orderNumber);
  assert.equal(await queuedOrderCardCount(store), 0, "nothing waits on the founder");
});

test("auto tier at-most-once: the same novaActionId twice places ONE order, decrements stock ONCE", async () => {
  const store = demo();
  await enableAutoTier(store);
  const stockBefore = (await store.getProduct(BOTTLE))!.stock;
  const key = "nm:conv-order-gate-1:order-0";

  const first = await performCreateOrder(AURORA, { payload: payloadFor(key), receipt: RECEIPT });
  const second = await performCreateOrder(AURORA, { payload: payloadFor(key), receipt: RECEIPT });

  assert.equal(first.status, "executed");
  assert.equal(second.status, "executed");
  assert.equal(second.replayed, true);
  assert.equal(second.actionId, first.actionId);
  assert.equal(second.order?.orderNumber, first.order?.orderNumber, "the customer holds ONE order number");
  const chatOrders = (await store.listOrders()).filter((o) => o.status === "placed");
  assert.equal((await store.getProduct(BOTTLE))!.stock, stockBefore - 2, "stock moved once, not twice");
  assert.equal(
    (await store.listActions("executed")).filter((a) => a.type === "create_order_from_chat").length,
    1,
    "one executed ledger row",
  );
  assert.ok(chatOrders.length >= 1);
});

// ---------------------------------------------------------------------------
// 3. Blocked — a founder's no-touch lock wins at every tier
// ---------------------------------------------------------------------------

test("a no-touch lock blocks the order with a receipted refusal and an escalation card — no order", async () => {
  const store = demo();
  await enableAutoTier(store); // even the auto tier must not cross a lock
  await store.setNoTouch(["Insulated Steel Bottle"]);
  const ordersBefore = (await store.listOrders()).length;

  const out = await performCreateOrder(AURORA, { payload: payloadFor("nm:conv-order-gate-1:order-0"), receipt: RECEIPT });
  assert.equal(out.status, "blocked");
  assert.match(out.rule, /^no_touch:/);

  const blocked = (await store.listActions("blocked")).filter((a) => a.type === "create_order_from_chat");
  assert.equal(blocked.length, 1, "a refusal is a receipted ledger row, never silence");
  const cards = (await store.listDecisions({ status: "queued" })).filter((d) => d.actionId === blocked[0]!.id);
  assert.equal(cards.length, 1);
  assert.equal(cards[0]!.kind, "escalation", "a flagged refusal reaches the founder as an escalation");
  assert.equal((await store.listOrders()).length, ordersBefore, "no order");
});

// ---------------------------------------------------------------------------
// 4. Turn wiring — runCustomerTurn reaches the gate in live mode only
// ---------------------------------------------------------------------------

/** Build the fully-specified purchase state the confirm turn decides from. */
async function seedConfirmableState(convId: string): Promise<void> {
  const store = demo();
  const products = await store.listProducts({ status: "active" });
  const bottle = products.find((x) => x.id === BOTTLE)! as unknown as DakioProduct;
  await primeContext(AURORA, convId, 0);
  const ctx = loadContext(AURORA, convId, "chat", 0);
  focusProduct(ctx, bottle);
  ctx.products.tracked[BOTTLE] = "wants_to_buy";
  ctx.purchase.qty = 2;
  ctx.purchase.zone = "dhaka";
  ctx.purchase.confirmSent = true;
  ctx.customer.phone = fact(PHONE, "customer");
  ctx.customer.addr = fact("House 5, Road 2, Dhanmondi, Dhaka", "customer");
  saveContext(ctx);
}

test("turn wiring, live + default store: the confirm turn FILES (no order); the writer's failure still throws (live contract)", async () => {
  const store = demo();
  const convId = "conv-turn-live-1";
  store.seedInboxConversation({ id: convId });
  resetContext(AURORA, convId);
  await seedConfirmableState(convId);
  const ordersBefore = (await store.listOrders()).length;

  // No AI gateway credential in the hermetic suite: live mode throws on the
  // writer — TODAY'S contract, unchanged. The gate has already run by then.
  await assert.rejects(() => runCustomerTurn(AURORA, convId, "hae", { mode: "live" }));

  const prepared = (await store.listActions("prepared")).filter((a) => a.type === "create_order_from_chat");
  assert.equal(prepared.length, 1, "the live turn filed the prepared action through the gate");
  assert.equal(await queuedOrderCardCount(store), 1);
  assert.equal((await store.listOrders()).length, ordersBefore, "and created no order");
  resetContext(AURORA, convId);
});

test("turn wiring, shadow: wouldHaveDone recorded, NOTHING filed, no order (unchanged)", async () => {
  const store = demo();
  const convId = "conv-turn-shadow-1";
  store.seedInboxConversation({ id: convId });
  resetContext(AURORA, convId);
  await seedConfirmableState(convId);
  const ordersBefore = (await store.listOrders()).length;

  const result = await runCustomerTurn(AURORA, convId, "hae", { mode: "shadow" });
  assert.equal(result.action, "CREATE_ORDER");
  assert.ok(result.wouldHaveDone, "shadow records the write it did not perform");
  assert.equal(result.wouldHaveDone!.novaActionId, `nm:${convId}:order-0`, "shadow key derivation unchanged");
  assert.equal(await preparedOrderCount(store), 0, "shadow files nothing");
  assert.equal(await queuedOrderCardCount(store), 0);
  assert.equal((await store.listOrders()).length, ordersBefore);
  resetContext(AURORA, convId);
});

// ---------------------------------------------------------------------------
// 5. Title rule
// ---------------------------------------------------------------------------

test("orderTitle says WHAT and WHERE — units and destination, never the phone or street", () => {
  const title = orderTitle(payloadFor("k", { customerCity: "Savar", customerDistrict: "Dhaka" }));
  assert.equal(title, "Chat order: 2 items to Savar, Dhaka");
  const single = orderTitle(
    payloadFor("k", { items: [{ productId: BOTTLE, productName: "Bottle", qty: 1 }] }),
  );
  assert.equal(single, "Chat order: 1 item to Dhaka, Dhaka");
});
