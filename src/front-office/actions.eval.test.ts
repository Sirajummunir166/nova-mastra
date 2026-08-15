/**
 * Customer-lane write-gate suite (phase D) — the approval-gated live tier,
 * hermetic against the DEMO backend (deterministic, no network, no model).
 *
 * Part 1 (below) is the order gate. Part 2, further down, covers the other five
 * verbs — offer_chat_discount, cancel_order_from_chat, update_order_contact,
 * open_case and escalate_conversation — plus the turn wiring and the
 * shadow-writes-nothing pin for each of them.
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

// ═══════════════════════════════════════════════════════════════════════════
// Part 2 — the remaining customer-lane write verbs
//
// Same hermetic rig (DemoStore, no network, no model). Per verb: the prepare
// tier files a prepared row + a queued Decision and touches nothing; the auto
// tier executes where a guardrail can enable it; the same key twice acts once;
// titles and params lines carry no PII; and SHADOW writes nothing at all.
//
// Two DemoStore gaps are worked around rather than papered over, because
// `src/store/` is out of scope for this change:
//   - `DemoStore.updateOrderDelivery` fences only address/city/district/phone/
//     confirm behind its dispatched check, so a `{status:'cancelled'}` patch on
//     a fulfilled order SUCCEEDS here where dakio-api refuses. No test asserts a
//     terminal-state cancel refusal — that rule is the server's and cannot be
//     proven against this backend.
//   - the same method IGNORES the four contact fields, so an executed
//     `update_order_contact` is asserted on the ledger row it files, never on a
//     changed address the demo never stores.
// ═══════════════════════════════════════════════════════════════════════════

import {
  performOfferDiscount,
  performCancelOrder,
  performUpdateContact,
  performOpenCase,
  performFlagHandover,
  discountTitle,
  discountParamsLine,
  cancelTitle,
  contactTitle,
  contactParamsLine,
  caseParamsLine,
  handoverTitle,
  changedContactFields,
  assertChatDiscountPayload,
  DEPARTMENT_BY_CASE_KIND,
  ESCALATION_REASONS,
  type ChatDiscountGatePayload,
  type CancelOrderGatePayload,
  type UpdateContactGatePayload,
  type OpenCaseGatePayload,
  type HandoverGatePayload,
} from "./actions.js";
import type { AutonomyLevel, Guardrails, Order } from "../store/types.js";

/** Move the dial and the platform bag together — the order suite's own shape. */
async function setTier(
  store: DemoStore,
  level: AutonomyLevel,
  platform: Record<string, unknown> = {},
): Promise<void> {
  await store.setAutonomy({
    level,
    guardrails: { ...DEFAULT_GUARDRAILS, ...platform } as Guardrails,
    updatedAt: new Date().toISOString(),
  });
}

/** dakio-api's PLATFORM_DEFAULTS for the discount lane, minus the auto switch
 *  (which SHIPS FALSE and stays false until module 11). */
const DISCOUNT_PLATFORM = { "inbox.maxDiscountPct": 15, "inbox.discountPerCustomerDays": 30 };

async function rowsOf(store: DemoStore, type: string, status?: "prepared" | "executed" | "blocked") {
  return (await store.listActions(status)).filter((a) => a.type === type);
}

async function cardsFor(store: DemoStore, type: string): Promise<number> {
  const ids = new Set((await store.listActions()).filter((a) => a.type === type).map((a) => a.id));
  return (await store.listDecisions({ status: "queued" })).filter((d) => ids.has(d.actionId)).length;
}

async function novaCoupons(store: DemoStore) {
  return (await store.listDiscounts()).filter((d) => d.code.startsWith("NOVA"));
}

async function firstOrderWith(store: DemoStore, status: Order["status"]): Promise<Order> {
  const found = (await store.listOrders()).find((o) => o.status === status);
  assert.ok(found, `the Aurora seed carries at least one '${status}' order`);
  return found;
}

const GATE_RECEIPT = {
  reason: "The customer is at the counter and this is the move the lane decided on.",
  expectedImpact: "One fewer thing the founder has to type by hand.",
  confidence: 0.85,
  evidence: [{ source: "conversation", note: "read from the live conversation state" }],
};

// ---------------------------------------------------------------------------
// 6. offer_chat_discount
// ---------------------------------------------------------------------------

function discountPayload(key: string, over: Partial<ChatDiscountGatePayload> = {}): ChatDiscountGatePayload {
  return {
    novaActionId: key,
    conversationId: CONV,
    mechanism: "percent",
    percentOff: 10,
    expiresHours: 48,
    reason: "Held the price once; 10% closes a two-round haggle on the bottle.",
    ...over,
  };
}

test("discount, default store: a percent offer is PREPARED with a queued card and mints no coupon", async () => {
  const store = demo();
  const couponsBefore = (await novaCoupons(store)).length;

  const out = await performOfferDiscount(AURORA, { payload: discountPayload("nm:c:discount-0"), receipt: GATE_RECEIPT });
  assert.equal(out.status, "prepared");
  // On a default nova-mastra store there is no `inbox.maxDiscountPct` at all,
  // so the FIRST check fires — not the auto switch. The observable behaviour
  // matches production; the rule string differs and that is worth pinning.
  assert.equal(out.status === "prepared" && out.rule, "guardrail:inbox_discount_no_ceiling");
  assert.match(out.detail, /confirm/i, "the offer is being confirmed, never already theirs");
  assert.doesNotMatch(out.detail, /NOVA[A-Z0-9]/, "no code exists yet, so none may be named");

  const prepared = await rowsOf(store, "offer_chat_discount", "prepared");
  assert.equal(prepared.length, 1);
  const row = prepared[0]!;
  assert.equal(row.department, "sales");
  assert.equal(row.dutyRef, "sales.inbox_discounts");
  assert.equal(row.undoable, false);
  assert.ok(row.receipt.evidence.find((e) => e.source === "authority_gate"), "prepared rows name their rule");
  // The payload the approve executor reads, field for field — and no `code`.
  const p = row.payload as Record<string, unknown>;
  assert.equal(p.mechanism, "percent");
  assert.equal(p.percentOff, 10);
  assert.equal(p.expiresHours, 48, "expiresHours, never a materialized expiresAt — expiry counts from EXECUTION");
  assert.equal(p.code, undefined, "the turn never names the code");
  assert.equal(p.expiresAt, undefined);

  const card = (await store.listDecisions({ status: "queued" })).find((d) => d.actionId === row.id);
  assert.ok(card);
  assert.equal(card.kind, "proposal");
  assert.equal(card.tag, "sales");
  assert.ok(card.surfacedIn.includes("door:coupons"), "a coupon belongs in the Coupons door, not Orders");
  assert.equal((await novaCoupons(store)).length, couponsBefore, "nothing was minted");
});

test("discount, production-shaped platform: the AUTO SWITCH is the rule that fires", async () => {
  const store = demo();
  await setTier(store, 2, DISCOUNT_PLATFORM); // discountAuto absent === false
  const out = await performOfferDiscount(AURORA, { payload: discountPayload("nm:c:discount-0"), receipt: GATE_RECEIPT });
  assert.equal(out.status, "prepared");
  assert.equal(out.status === "prepared" && out.rule, "guardrail:inbox_discount_auto_off");
});

test("discount auto tier: a single-use NOVA coupon is minted, undoable on the couponId key", async () => {
  const store = demo();
  await setTier(store, 3, { ...DISCOUNT_PLATFORM, "inbox.discountAuto": true });

  const out = await performOfferDiscount(AURORA, { payload: discountPayload("nm:c:discount-0"), receipt: GATE_RECEIPT });
  assert.equal(out.status, "executed");
  assert.equal(out.status === "executed" && out.replayed, false);
  const code = out.status === "executed" ? out.code : null;
  assert.ok(code && /^NOVA[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/.test(code), "unambiguous alphabet, no 0/O/1/I/L");

  const coupons = await novaCoupons(store);
  assert.equal(coupons.length, 1);
  const coupon = coupons[0]!;
  assert.equal(coupon.code, code);
  assert.equal(coupon.type, "PERCENT");
  assert.equal(coupon.percentOff, 10);
  assert.equal(coupon.maxUses, 1, "'issued to this customer' — Coupon has no customerId column");
  assert.equal(coupon.active, true);
  assert.equal(coupon.novaActionId, "nm:c:discount-0");
  const hours = (Date.parse(coupon.expiresAt) - Date.parse(store.now())) / 3600_000;
  assert.ok(hours > 47 && hours <= 48.1, "expiry counted from execution, not from draft time");

  const [row] = await rowsOf(store, "offer_chat_discount", "executed");
  assert.ok(row);
  assert.equal(row.undoable, true);
  const undo = row.undoData as Record<string, unknown>;
  assert.equal(undo.kind, "deactivate_chat_discount");
  assert.equal(undo.couponId, coupon.id, "couponId, NOT discountId — dakio-api's UNDO destructures that name");
  assert.equal(row.targetRef, `coupon:${coupon.id}`);
  assert.match(row.outcome ?? "", /one use, expires in 48h/);
  assert.equal(await cardsFor(store, "offer_chat_discount"), 0, "nothing waits on the founder");

  // A coupon does not get credit for existing.
  const activity = (await store.listActivity()).find((a) => a.actionId === row.id);
  assert.ok(activity);
  assert.equal(activity.revenueInfluence, 0);
  assert.equal(activity.minutesSaved, 10);
});

test("discount: over the founder's ceiling is a BLOCK, not an approve-me card", async () => {
  const store = demo();
  await setTier(store, 4, { ...DISCOUNT_PLATFORM, "inbox.discountAuto": true });

  const out = await performOfferDiscount(AURORA, {
    payload: discountPayload("nm:c:discount-0", { percentOff: 90, reason: "Buyer is pushing hard for 90 percent off." }),
    receipt: GATE_RECEIPT,
  });
  assert.equal(out.status, "blocked");
  assert.equal(out.status === "blocked" && out.rule, "guardrail:inbox_max_discount_pct");
  assert.equal((await novaCoupons(store)).length, 0, "block means no coupon, at any tier");
  const [blocked] = await rowsOf(store, "offer_chat_discount", "blocked");
  assert.ok(blocked, "a refusal is a receipted row, never silence");
  const card = (await store.listDecisions({ status: "queued" })).find((d) => d.actionId === blocked.id);
  assert.equal(card?.kind, "escalation");
});

test("discount: a taka or free-delivery offer ALWAYS drafts — there is no taka ceiling to check it against", async () => {
  const store = demo();
  await setTier(store, 4, { ...DISCOUNT_PLATFORM, "inbox.discountAuto": true });

  const fixed = await performOfferDiscount(AURORA, {
    payload: discountPayload("nm:c:discount-0", { mechanism: "fixed", percentOff: undefined, amount: 200 }),
    receipt: GATE_RECEIPT,
  });
  assert.equal(fixed.status, "prepared");
  assert.equal(fixed.status === "prepared" && fixed.rule, "guardrail:inbox_discount_no_ceiling");

  const free = await performOfferDiscount(AURORA, {
    payload: discountPayload("nm:c:discount-1", { mechanism: "free_delivery", percentOff: undefined }),
    receipt: GATE_RECEIPT,
  });
  assert.equal(free.status, "prepared");
  assert.equal((await novaCoupons(store)).length, 0);
});

test("discount at-most-once: the same key twice mints ONE coupon and answers with the same code", async () => {
  const store = demo();
  await setTier(store, 3, { ...DISCOUNT_PLATFORM, "inbox.discountAuto": true });
  const first = await performOfferDiscount(AURORA, { payload: discountPayload("nm:c:discount-0"), receipt: GATE_RECEIPT });
  const second = await performOfferDiscount(AURORA, { payload: discountPayload("nm:c:discount-0"), receipt: GATE_RECEIPT });

  assert.equal(second.status, "executed");
  assert.equal(second.status === "executed" && second.replayed, true);
  assert.equal(second.actionId, first.actionId);
  assert.equal(
    second.status === "executed" && first.status === "executed" && second.code,
    first.status === "executed" ? first.code : null,
    "the customer holds ONE code",
  );
  assert.equal((await novaCoupons(store)).length, 1, "a replay never mints a second live coupon");
  assert.equal((await rowsOf(store, "offer_chat_discount", "executed")).length, 1);
});

test("discount payload: the three refinements throw before any row is filed", () => {
  assert.throws(() => assertChatDiscountPayload(discountPayload("k", { percentOff: undefined })), /requires percentOff/);
  assert.throws(
    () => assertChatDiscountPayload(discountPayload("k", { mechanism: "fixed", percentOff: undefined })),
    /requires amount/,
  );
  assert.throws(
    () => assertChatDiscountPayload(discountPayload("k", { mechanism: "free_delivery", percentOff: undefined, amount: 120 })),
    /takes no amount/,
    "the whole point: no surface may quote a delivery figure it guessed",
  );
  assert.throws(() => assertChatDiscountPayload(discountPayload("k", { expiresHours: 999 })), /between 1 and 168/);
});

test("discount title/params: WHAT then WHY, free delivery carries no number, reason unabridged", () => {
  assert.equal(
    discountTitle(discountPayload("k", { reason: "Two rounds of haggling on the bottle." })),
    "Chat discount: 10% off — Two rounds of haggling on the bottle.",
  );
  const free = discountPayload("k", { mechanism: "free_delivery", percentOff: undefined, reason: "Cart is ready; delivery is the objection." });
  assert.equal(discountTitle(free), "Chat discount: free delivery — Cart is ready; delivery is the objection.");
  assert.doesNotMatch(discountTitle(free), /\d/, "the title never carries a figure the turn could have guessed");

  const long = "The buyer has walked twice over the delivery charge and this is the third round of the same objection.";
  assert.ok(discountParamsLine(discountPayload("k", { reason: long })).endsWith(long), "reason is last and unabridged");
});

// ---------------------------------------------------------------------------
// 7. cancel_order_from_chat
// ---------------------------------------------------------------------------

function cancelPayload(key: string, orderId: string, over: Partial<CancelOrderGatePayload> = {}): CancelOrderGatePayload {
  return {
    novaActionId: key,
    orderId,
    conversationId: CONV,
    reason: "Ordered the wrong size and does not want the parcel to go out.",
    ...over,
  };
}

test("cancel, default store: PREPARED under inbox_cancel_auto_off — the order is untouched", async () => {
  const store = demo();
  const order = await firstOrderWith(store, "placed");
  const stockBefore = (await store.getProduct(BOTTLE))!.stock;

  const out = await performCancelOrder(AURORA, {
    payload: cancelPayload("nm:c:cancel-" + order.id, order.id),
    receipt: GATE_RECEIPT,
  });
  assert.equal(out.status, "prepared");
  assert.equal(out.status === "prepared" && out.rule, "guardrail:inbox_cancel_auto_off");
  // The order is STILL LIVE and may still ship, so the line may not claim it is
  // off — and must say plainly that it is not, rather than leaving it ambiguous.
  assert.match(out.detail, /not cancelled yet/i);
  assert.doesNotMatch(out.detail, /(has been|is now|been) cancelled/i);

  const [row] = await rowsOf(store, "cancel_order_from_chat", "prepared");
  assert.ok(row);
  assert.equal(row.department, "sales", "unwinding a sale is the same room's work as making one");
  assert.equal(row.dutyRef, "sales.inbox_orders", "the ORDER duty — pausing chat orders pauses chat cancels");
  assert.ok(row.receipt.evidence.find((e) => e.source === "authority_gate"));

  const card = (await store.listDecisions({ status: "queued" })).find((d) => d.actionId === row.id);
  assert.ok(card);
  assert.ok(card.surfacedIn.includes("door:orders"));
  assert.equal(card.paramsLine, cancelPayload("k", order.id).reason, "the reason, unabridged, and nothing else");

  assert.equal((await store.getOrder(order.id))!.status, "placed", "nothing moved");
  assert.equal((await store.getProduct(BOTTLE))!.stock, stockBefore, "no stock returns on a cancel, in either direction");
});

test("cancel auto tier: the order really cancels, undo carries the previous status, stock does not move", async () => {
  const store = demo();
  await setTier(store, 4, { "inbox.cancelAuto": true }); // medium risk drafts at 3 — 4 is the floor
  const order = await firstOrderWith(store, "placed");
  const stockBefore = (await store.getProduct(BOTTLE))!.stock;

  const out = await performCancelOrder(AURORA, {
    payload: cancelPayload("nm:c:cancel-" + order.id, order.id),
    receipt: GATE_RECEIPT,
  });
  assert.equal(out.status, "executed");
  assert.equal((await store.getOrder(order.id))!.status, "cancelled");
  assert.equal((await store.getProduct(BOTTLE))!.stock, stockBefore, "a customer's own cancel returns NO stock");

  const [row] = await rowsOf(store, "cancel_order_from_chat", "executed");
  assert.ok(row);
  assert.equal(row.undoable, true);
  const undo = row.undoData as Record<string, unknown>;
  assert.equal(undo.kind, "uncancel_chat_order", "the only bridge to dakio-api's kind-keyed UNDO map");
  assert.equal(undo.orderId, order.id, "the one field UNDO reads");
  assert.equal(undo.previousStatus, "placed");
  assert.equal(row.targetRef, `order:${order.id}`);
  assert.match(row.outcome ?? "", /cancel the parcel with them too/i, "the courier caveat is carried honestly");
  const activity = (await store.listActivity()).find((a) => a.actionId === row.id);
  assert.equal(activity?.minutesSaved, 6);
  assert.equal(activity?.revenueInfluence, 0, "a cancellation is not negative revenue");
});

test("cancel at-most-once: the same key twice files ONE row and answers from the ledger", async () => {
  const store = demo();
  await setTier(store, 4, { "inbox.cancelAuto": true });
  const order = await firstOrderWith(store, "placed");
  const key = "nm:c:cancel-" + order.id;
  const first = await performCancelOrder(AURORA, { payload: cancelPayload(key, order.id), receipt: GATE_RECEIPT });
  const second = await performCancelOrder(AURORA, { payload: cancelPayload(key, order.id), receipt: GATE_RECEIPT });

  assert.equal(second.status, "executed");
  assert.equal(second.status === "executed" && second.replayed, true);
  assert.equal(second.actionId, first.actionId);
  assert.equal((await rowsOf(store, "cancel_order_from_chat", "executed")).length, 1);
});

test("cancel title: the customer's reason IS the title, and a phone inside it is masked", () => {
  assert.equal(
    cancelTitle(cancelPayload("k", "ord-1", { reason: "Found it cheaper next door." })),
    "Cancel an order — Found it cheaper next door.",
  );
});

test("cancel PII: a reason carrying a phone number never reaches the card in full", async () => {
  const store = demo();
  const order = await firstOrderWith(store, "placed");
  await performCancelOrder(AURORA, {
    payload: cancelPayload("nm:c:cancel-pii", order.id, { reason: `Call me on ${PHONE} instead, I want it stopped.` }),
    receipt: GATE_RECEIPT,
  });
  const [row] = await rowsOf(store, "cancel_order_from_chat", "prepared");
  assert.ok(row);
  assert.ok(!row.title.includes(PHONE), "the title outlives the card — it may not carry a full number");
  const card = (await store.listDecisions({ status: "queued" })).find((d) => d.actionId === row.id);
  assert.ok(card && !card.paramsLine.includes(PHONE));
  // The raw words stay on the payload, where the founder reads them in context.
  assert.ok(String((row.payload as Record<string, unknown>).reason).includes(PHONE));
});

// ---------------------------------------------------------------------------
// 8. update_order_contact
// ---------------------------------------------------------------------------

function contactPayload(key: string, orderId: string, over: Partial<UpdateContactGatePayload> = {}): UpdateContactGatePayload {
  return {
    novaActionId: key,
    orderId,
    conversationId: CONV,
    address: "House 9, Road 4, Uttara Sector 7",
    ...over,
  };
}

test("contact, default store: PREPARED under inbox_address_edit_auto_off, with no value on the card", async () => {
  const store = demo();
  const order = await firstOrderWith(store, "placed");

  const out = await performUpdateContact(AURORA, {
    payload: contactPayload("nm:c:addr-0", order.id, { district: "Gazipur" }),
    receipt: GATE_RECEIPT,
  });
  assert.equal(out.status, "prepared");
  assert.equal(out.status === "prepared" && out.rule, "guardrail:inbox_address_edit_auto_off");
  assert.doesNotMatch(out.detail, /৳|\d{3,}/, "never quote a new total — the shop's own answer carries the figure");

  const [row] = await rowsOf(store, "update_order_contact", "prepared");
  assert.ok(row);
  assert.equal(row.department, "shipping");
  assert.equal(row.dutyRef, "shipping.delivery_cases");
  assert.equal(row.title, "Change address + district on an order", "WHAT MOVED, never the new value");
  assert.ok(!row.title.includes("Uttara") && !row.title.includes("Gazipur"));

  const card = (await store.listDecisions({ status: "queued" })).find((d) => d.actionId === row.id);
  assert.ok(card);
  assert.equal(card.tag, "shipping");
  assert.ok(card.surfacedIn.includes("door:courier"), "department's own door — not the order verb's override");
  assert.equal(card.paramsLine, "address + district · re-prices delivery");
  assert.ok(!card.paramsLine.includes("Uttara"));

  const FORBIDDEN = /^(price|unitPrice|total|subtotal|discount|deliveryCharge|shippingCharge|codAmount|amount)$/;
  const keys = Object.keys(row.payload as Record<string, unknown>);
  assert.deepEqual(keys.filter((k) => FORBIDDEN.test(k)), [], "the district re-prices SERVER-side; no money on this path");
});

test("contact auto tier: executes, and it is never undoable", async () => {
  const store = demo();
  await setTier(store, 4, { "inbox.addressEditAuto": true });
  const order = await firstOrderWith(store, "placed");

  const out = await performUpdateContact(AURORA, {
    payload: contactPayload("nm:c:addr-0", order.id, { phone: "01799999999" }),
    receipt: GATE_RECEIPT,
  });
  assert.equal(out.status, "executed");
  assert.deepEqual(out.status === "executed" ? out.changed : [], ["address", "phone"]);

  const [row] = await rowsOf(store, "update_order_contact", "executed");
  assert.ok(row);
  assert.equal(row.undoable, false, "undo would mean shipping to an address they already told us is wrong");
  assert.equal(row.undoData, null, "and no slug: dakio-api's UNDO map has no entry for this verb");
  assert.equal(row.targetRef, `order:${order.id}`);
  assert.match(row.outcome ?? "", /confirmation was reset/i);
  assert.doesNotMatch(row.outcome ?? "", /district changed/i, "no district moved on this payload");
  assert.ok(!row.title.includes("01799999999"), "no phone on the title");
});

test("contact: the pre-dispatch fence is the SERVER's — a dispatched order refuses and the refusal propagates", async () => {
  const store = demo();
  await setTier(store, 4, { "inbox.addressEditAuto": true });
  const dispatched = await firstOrderWith(store, "fulfilled");
  await assert.rejects(
    () =>
      performUpdateContact(AURORA, {
        payload: contactPayload("nm:c:addr-dispatched", dispatched.id),
        receipt: GATE_RECEIPT,
      }),
    /already with the courier/i,
  );
  // The refusal happened at the write, so no executed row claims an edit.
  assert.equal((await rowsOf(store, "update_order_contact", "executed")).length, 0);
});

test("contact: an update that changes nothing is not an update — it throws before any row", async () => {
  const store = demo();
  const order = await firstOrderWith(store, "placed");
  await assert.rejects(
    () =>
      performUpdateContact(AURORA, {
        payload: { novaActionId: "nm:c:addr-noop", orderId: order.id, conversationId: CONV },
        receipt: GATE_RECEIPT,
      }),
    /at least one field/i,
  );
  assert.equal((await rowsOf(store, "update_order_contact")).length, 0, "no prepared card the approve path would refuse");
});

test("contact at-most-once: the same key twice files ONE row", async () => {
  const store = demo();
  const order = await firstOrderWith(store, "placed");
  const first = await performUpdateContact(AURORA, { payload: contactPayload("nm:c:addr-0", order.id), receipt: GATE_RECEIPT });
  const second = await performUpdateContact(AURORA, { payload: contactPayload("nm:c:addr-0", order.id), receipt: GATE_RECEIPT });
  assert.equal(second.actionId, first.actionId);
  assert.equal(second.status === "prepared" && second.replayed, true);
  assert.equal((await rowsOf(store, "update_order_contact", "prepared")).length, 1);
  assert.equal(await cardsFor(store, "update_order_contact"), 1);
});

test("contact helpers: changed fields are `!== undefined`, and the title names only what moved", () => {
  const p = contactPayload("k", "ord-1", { address: undefined, city: "Savar" });
  assert.deepEqual(changedContactFields(p), ["city"]);
  assert.equal(contactTitle(p), "Change city on an order");
  assert.equal(contactParamsLine(p), "city");
  assert.equal(contactParamsLine(contactPayload("k", "ord-1", { district: "Sylhet" })), "address + district · re-prices delivery");
});

// ---------------------------------------------------------------------------
// 9. open_case
// ---------------------------------------------------------------------------

function casePayload(key: string, over: Partial<OpenCaseGatePayload> = {}): OpenCaseGatePayload {
  return {
    novaActionId: key,
    kind: "delivery_stuck",
    conversationId: CONV,
    title: "Parcel has not moved for five days",
    factsNote: "Customer says the parcel has not moved since Tuesday and wants to know where it is.",
    ...over,
  };
}

test("case, default store: PREPARED at level:draft — no guardrail flag exists for this verb", async () => {
  const store = demo();
  const order = await firstOrderWith(store, "placed");

  const out = await performOpenCase(AURORA, {
    payload: casePayload("nm:c:case-0", { orderId: order.id }),
    receipt: GATE_RECEIPT,
  });
  assert.equal(out.status, "prepared");
  // What gates it is the duty floor plus the dial, nothing else: there is no
  // `inbox.caseAuto` anywhere in the three repos and none was invented here.
  assert.equal(out.status === "prepared" && out.rule, "level:draft");
  assert.doesNotMatch(out.detail, /\bcase\b/i, "no case exists yet, so none may be announced");
  assert.doesNotMatch(out.detail, /tomorrow|hour|day|by /i, "a case is never a promise about when");

  const [row] = await rowsOf(store, "open_case", "prepared");
  assert.ok(row);
  assert.equal(row.department, "shipping", "derived from the kind, never caller-supplied");
  assert.equal(row.dutyRef, "shipping.delivery_cases");
  assert.equal(row.undoable, false);
  assert.equal(row.undoData, null, "a case is closed with a resolution, never deleted");

  const card = (await store.listDecisions({ status: "queued" })).find((d) => d.actionId === row.id);
  assert.ok(card);
  assert.equal(card.tag, "shipping");
  assert.ok(card.surfacedIn.includes("door:courier"));
  assert.equal(card.paramsLine, "delivery stuck · on an order");

  assert.equal((await store.getOrderStatus(order.id))!.openCase, null, "nothing was booked");
});

test("case auto tier: opens once, then JOINS — `joined` is server truth, never inferred", async () => {
  const store = demo();
  await setTier(store, 3); // low risk executes at operator level
  const order = await firstOrderWith(store, "placed");

  const first = await performOpenCase(AURORA, {
    payload: casePayload("nm:c:case-0", { orderId: order.id }),
    receipt: GATE_RECEIPT,
  });
  assert.equal(first.status, "executed");
  assert.equal(first.status === "executed" && first.joined, false);
  assert.match(first.detail, /Opened a delivery stuck case with the shipping room/);

  const second = await performOpenCase(AURORA, {
    // A DIFFERENT key — a second person asking about the same parcel.
    payload: casePayload("nm:c:case-1", { orderId: order.id, conversationId: "conv-second-asker" }),
    receipt: GATE_RECEIPT,
  });
  assert.equal(second.status, "executed");
  assert.equal(second.status === "executed" && second.joined, true, "one parcel, one case, however many people ask");
  assert.match(second.detail, /Joined the open case/);
  assert.doesNotMatch(second.detail, /Opened a/, "a join must never be announced as a fresh case");

  const open = (await store.getOrderStatus(order.id))!.openCase;
  assert.ok(open);
  assert.equal(open.kind, "delivery_stuck");

  const executed = await rowsOf(store, "open_case", "executed");
  assert.equal(executed.length, 2, "two receipted asks");
  assert.equal(executed[0]!.targetRef, `case:${open.id}`);
  const activity = (await store.listActivity()).find((a) => a.actionId === executed[0]!.id);
  assert.equal(activity?.minutesSaved, 3);
  assert.equal(activity?.revenueInfluence, 0);
});

test("case: the department is DERIVED from the kind and the card follows it into that room's door", async () => {
  const store = demo();
  // The mirror must stay byte-identical to dakio-api's DEPARTMENT_BY_KIND.
  assert.deepEqual(DEPARTMENT_BY_CASE_KIND, {
    delivery_stuck: "shipping",
    failed_attempt: "shipping",
    address_change_postdispatch: "shipping",
    payment_unverified: "finance",
    damaged_item: "support",
    restock_wait: "inventory",
  });

  await performOpenCase(AURORA, {
    payload: casePayload("nm:c:case-fin", { kind: "payment_unverified", title: "bKash payment not visible on the order" }),
    receipt: GATE_RECEIPT,
  });
  await performOpenCase(AURORA, {
    payload: casePayload("nm:c:case-sup", { kind: "damaged_item", title: "Item arrived with a cracked lid" }),
    receipt: GATE_RECEIPT,
  });

  const rows = await rowsOf(store, "open_case", "prepared");
  const fin = rows.find((r) => (r.payload as Record<string, unknown>).kind === "payment_unverified")!;
  const sup = rows.find((r) => (r.payload as Record<string, unknown>).kind === "damaged_item")!;
  assert.equal(fin.department, "finance");
  assert.equal(sup.department, "support");
  const cards = await store.listDecisions({ status: "queued" });
  assert.ok(cards.find((d) => d.actionId === fin.id)!.surfacedIn.includes("door:accounts"));
  assert.ok(cards.find((d) => d.actionId === sup.id)!.surfacedIn.includes("door:inbox"));
});

test("case at-most-once: the same key twice files ONE row and opens ONE case", async () => {
  const store = demo();
  await setTier(store, 3);
  const order = await firstOrderWith(store, "placed");
  const first = await performOpenCase(AURORA, { payload: casePayload("nm:c:case-0", { orderId: order.id }), receipt: GATE_RECEIPT });
  const second = await performOpenCase(AURORA, { payload: casePayload("nm:c:case-0", { orderId: order.id }), receipt: GATE_RECEIPT });
  assert.equal(second.actionId, first.actionId);
  assert.equal(second.status === "executed" && second.replayed, true);
  // A replay must not flip `joined` false→true: it is the exact fact the
  // customer line and the department-job decision both hang on.
  assert.equal(second.status === "executed" && second.joined, false);
  assert.equal((await rowsOf(store, "open_case", "executed")).length, 1);
});

test("case: title and params line carry no phone, no verbatim customer text, no date", async () => {
  const store = demo();
  await performOpenCase(AURORA, {
    payload: casePayload("nm:c:case-pii", { title: `Parcel stuck, buyer rang from ${PHONE}` }),
    receipt: GATE_RECEIPT,
  });
  const [row] = await rowsOf(store, "open_case", "prepared");
  assert.ok(row);
  assert.ok(!row.title.includes(PHONE));
  const card = (await store.listDecisions({ status: "queued" })).find((d) => d.actionId === row.id)!;
  assert.equal(card.paramsLine, "delivery stuck · thread only — may duplicate", "the factsNote paragraph never lands here");
  assert.equal(caseParamsLine(casePayload("k", { productId: "prod-bottle" })), "delivery stuck · on a product");
});

test("case: an off-taxonomy kind, a short title or an oversized factsNote throws before any row", async () => {
  const store = demo();
  await assert.rejects(
    () => performOpenCase(AURORA, { payload: casePayload("k", { kind: "wholesale_inquiry" as never }), receipt: GATE_RECEIPT }),
    /unknown case kind/,
  );
  await assert.rejects(
    () => performOpenCase(AURORA, { payload: casePayload("k", { title: "hi" }), receipt: GATE_RECEIPT }),
    /5–160/,
  );
  await assert.rejects(
    () => performOpenCase(AURORA, { payload: casePayload("k", { factsNote: "x".repeat(601) }), receipt: GATE_RECEIPT }),
    /3–600/,
  );
  assert.equal((await rowsOf(store, "open_case")).length, 0);
});

// ---------------------------------------------------------------------------
// 10. escalate_conversation — NEVER_GATED
// ---------------------------------------------------------------------------

function handoverPayload(key: string, over: Partial<HandoverGatePayload> = {}): HandoverGatePayload {
  return {
    novaActionId: key,
    conversationId: CONV,
    reason: "human_ask",
    department: "support",
    summary: "Customer asked to speak to a person. No product in focus. Stage: discovery.",
    summaryBn: "ক্রেতা একজন মানুষের সাথে কথা বলতে চেয়েছেন। কোনো পণ্য নির্দিষ্ট হয়নি।",
    factsChecked: [{ source: "conversation", note: "checked ok: intent human_ask" }],
    ...over,
  };
}

test("handover executes at the seed tier AND at level 0 — asking for a human is never gated", async () => {
  const store = demo();
  const out = await performFlagHandover(AURORA, { payload: handoverPayload("nm:c:handover"), receipt: GATE_RECEIPT });
  assert.equal(out.status, "executed");
  assert.equal(out.status === "executed" && out.holdingSent, false, "the demo models no holding template — say nothing");

  const [row] = await rowsOf(store, "escalate_conversation", "executed");
  assert.ok(row);
  assert.equal(row.department, "support");
  assert.equal(row.dutyRef, "support.inbox_escalations", "a constant, whatever room it is routed to");
  assert.equal(row.undoable, false, "a thread has been locked and a line queued — nothing to reverse");
  assert.equal(row.undoData, null);
  assert.equal(row.targetRef, `inbox_conversation:${CONV}`);
  assert.equal(row.title, "Hand a customer conversation to you (human_ask)");
  assert.ok(!row.title.includes(PHONE) && !row.title.includes("Customer asked"), "a fixed sentence and the slug, nothing else");
  const gate = row.receipt.evidence.find((e) => e.source === "authority_gate");
  assert.equal(gate?.value, "never_gated:escalate_conversation");

  // The thread now belongs to a person; Nova stepped back rather than the
  // founder stepping in, so `novaLockedAt` stays null.
  const thread = await store.getInboxConversation(CONV);
  assert.ok(thread!.conversation.escalatedAt);
  assert.equal(thread!.conversation.handledBy, "founder");
  assert.equal(thread!.conversation.novaLockedAt, null);

  // No LOCAL card: dakio-api's handoverHandler authors the priority-1
  // escalation Decision itself, and two asks on one desk for one thread is the
  // failure the ADVISORY carve-out exists to prevent.
  assert.equal(await cardsFor(store, "escalate_conversation"), 0);

  // …and at the bottom of the dial, on a fresh thread.
  await setTier(store, 0);
  store.seedInboxConversation({ id: "conv-observe-only" });
  const atZero = await performFlagHandover(AURORA, {
    payload: handoverPayload("nm:observe:handover", { conversationId: "conv-observe-only" }),
    receipt: GATE_RECEIPT,
  });
  assert.equal(atZero.status, "executed", "observe-only must still be able to fetch a human");
});

test("handover: a second ask on an escalated thread does not ask twice", async () => {
  const store = demo();
  await performFlagHandover(AURORA, { payload: handoverPayload("nm:c:handover"), receipt: GATE_RECEIPT });
  const again = await performFlagHandover(AURORA, {
    payload: handoverPayload("nm:c:handover-2", { reason: "anger" }),
    receipt: GATE_RECEIPT,
  });
  assert.equal(again.status, "executed");
  assert.equal(again.status === "executed" && again.alreadyEscalated, true);
  // `briefUpdated` absent is a THIRD state — "the route did not say" — and must
  // not collapse into `false`.
  assert.match(again.detail, /I did not ask twice\.$/);
});

test("handover at-most-once: the same key twice files ONE ledger row", async () => {
  const store = demo();
  const first = await performFlagHandover(AURORA, { payload: handoverPayload("nm:c:handover"), receipt: GATE_RECEIPT });
  const second = await performFlagHandover(AURORA, { payload: handoverPayload("nm:c:handover"), receipt: GATE_RECEIPT });
  assert.equal(second.actionId, first.actionId);
  assert.equal(second.status === "executed" && second.replayed, true);
  assert.equal((await rowsOf(store, "escalate_conversation", "executed")).length, 1);
});

test("handover: a no-touch lock blocks it, files a receipted row + escalation card, and the thread stays with Nova", async () => {
  const store = demo();
  await store.setNoTouch(["REFUND"]);
  const out = await performFlagHandover(AURORA, {
    payload: handoverPayload("nm:c:handover", {
      summary: "Customer wants a refund on a delivered parcel and will not accept an exchange.",
    }),
    receipt: GATE_RECEIPT,
  });
  assert.equal(out.status, "blocked");
  assert.match(out.status === "blocked" ? out.rule : "", /^no_touch:/);

  const [blocked] = await rowsOf(store, "escalate_conversation", "blocked");
  assert.ok(blocked);
  const card = (await store.listDecisions({ status: "queued" })).find((d) => d.actionId === blocked.id);
  assert.equal(card?.kind, "escalation", "here the card IS local — no server card exists for a refusal");
  const thread = await store.getInboxConversation(CONV);
  assert.equal(thread!.conversation.escalatedAt, null, "Nova is still on the thread and still owes an answer");
});

test("handover: the reason taxonomy is closed and its ORDER is pinned", () => {
  assert.deepEqual(ESCALATION_REASONS.slice(), [
    "human_ask",
    "anger",
    "payment_dispute",
    "legal",
    "lost",
    "negotiation",
    "vip",
    "tool_failure",
    "fraud_risk",
    "guardrail_blocked",
    "policy_gap",
    "catalog_gap",
  ]);
  assert.equal(handoverTitle(handoverPayload("k", { reason: "fraud_risk" })), "Hand a customer conversation to you (fraud_risk)");
});

test("handover: a missing Bangla brief is refused rather than filled with the English one", async () => {
  await assert.rejects(
    () => performFlagHandover(AURORA, { payload: handoverPayload("k", { summaryBn: "" }), receipt: GATE_RECEIPT }),
    /summaryBn is required/,
  );
});

// ---------------------------------------------------------------------------
// 11. Turn wiring — what the decide layer can actually reach today
//
// ESCALATE is the ONE new verb the lane decides: `nextBestAction` returns it
// for `human_ask` and `complaint`, and the order gate's blocked fallback lands
// on it too. The other four verbs have no decision path — there is no
// discount-offer branch (the lane only ever DECLINES once), no cancel intent,
// no address-correction intent and no case branch — so they are implemented and
// tested as functions and deliberately NOT wired. The tests below pin that: a
// shadow turn writes nothing for any of the five.
// ---------------------------------------------------------------------------

test("turn wiring, live: an ESCALATE turn hands the thread over and suppresses the draft", async () => {
  const store = demo();
  const convId = "conv-turn-handover-live";
  store.seedInboxConversation({ id: convId });
  resetContext(AURORA, convId);

  const result = await runCustomerTurn(AURORA, convId, "human", { mode: "live" });
  assert.equal(result.action, "ESCALATE");
  assert.ok(result.handoverActionId, "the executed handover row is named on the turn result");
  // The SERVER owns the deterministic holding line (and sends NONE for
  // `fraud_risk`), so the writer draft is suppressed rather than becoming a
  // second bubble. No model was spent on a line that must not be sent.
  assert.equal(result.reply, "");
  assert.equal(result.modelCalls, 0);
  assert.equal(result.stage, "escalated");

  const rows = (await store.listActions("executed")).filter((a) => a.type === "escalate_conversation");
  assert.equal(rows.length, 1);
  const p = rows[0]!.payload as Record<string, unknown>;
  assert.equal(p.reason, "human_ask");
  assert.equal(p.department, "support");
  assert.equal(p.conversationId, convId, "the thread comes from the turn envelope, never from model output");
  assert.ok(String(p.summaryBn).length >= 5, "a real Bangla brief, not a copy of the English one");
  assert.notEqual(p.summaryBn, p.summary);
  assert.ok(!String(p.summary).includes(PHONE));

  const thread = await store.getInboxConversation(convId);
  assert.ok(thread!.conversation.escalatedAt);

  // The next turn on a locked thread never reaches the gate again.
  const after = await runCustomerTurn(AURORA, convId, "hello?", { mode: "live" });
  assert.equal(after.reply, "");
  assert.equal((await store.listActions("executed")).filter((a) => a.type === "escalate_conversation").length, 1);
  resetContext(AURORA, convId);
});

test("shadow: escalate_conversation records wouldHaveDone and writes NOTHING", async () => {
  const store = demo();
  const convId = "conv-shadow-handover";
  store.seedInboxConversation({ id: convId });
  resetContext(AURORA, convId);

  const result = await runCustomerTurn(AURORA, convId, "human", { mode: "shadow" });
  assert.equal(result.action, "ESCALATE");
  assert.ok(result.wouldHaveDone);
  assert.equal(result.wouldHaveDone!.type, "escalate_conversation");
  assert.equal(result.wouldHaveDone!.novaActionId, `nm:${convId}:handover`);
  assert.equal(result.wouldHaveDone!.reason, "human_ask");

  assert.equal((await rowsOf(store, "escalate_conversation")).length, 0, "no ledger row");
  assert.equal((await store.getInboxConversation(convId))!.conversation.escalatedAt, null, "no thread was locked");
  resetContext(AURORA, convId);
});

test("shadow: a complaint turn writes no open_case row — the verb is implemented but unwired", async () => {
  const store = demo();
  const convId = "conv-shadow-case";
  store.seedInboxConversation({ id: convId });
  resetContext(AURORA, convId);

  const result = await runCustomerTurn(AURORA, convId, "product ta vanga", { mode: "shadow" });
  assert.equal(result.intent, "complaint");
  assert.equal((await rowsOf(store, "open_case")).length, 0);
  assert.equal(await cardsFor(store, "open_case"), 0);
  resetContext(AURORA, convId);
});

test("shadow: a discount ask writes no offer_chat_discount row and mints no coupon", async () => {
  const store = demo();
  const convId = "conv-shadow-discount";
  store.seedInboxConversation({ id: convId });
  resetContext(AURORA, convId);

  const result = await runCustomerTurn(AURORA, convId, "discount den, dam koto?", { mode: "shadow" });
  assert.equal(result.intent, "discount_ask");
  assert.equal(result.action, "DECLINE_DISCOUNT_ONCE", "the lane declines once; there is no offer branch to reach");
  assert.equal((await rowsOf(store, "offer_chat_discount")).length, 0);
  assert.equal((await novaCoupons(store)).length, 0);
  resetContext(AURORA, convId);
});

test("shadow: a cancel word writes no cancel_order_from_chat row and moves no order", async () => {
  const store = demo();
  const convId = "conv-shadow-cancel";
  store.seedInboxConversation({ id: convId });
  resetContext(AURORA, convId);
  const before = (await store.listOrders()).map((o) => `${o.id}:${o.status}`).join(",");

  await runCustomerTurn(AURORA, convId, "cancel", { mode: "shadow" });
  assert.equal((await rowsOf(store, "cancel_order_from_chat")).length, 0);
  assert.equal((await store.listOrders()).map((o) => `${o.id}:${o.status}`).join(","), before);
  resetContext(AURORA, convId);
});

test("shadow: an address correction writes no update_order_contact row", async () => {
  const store = demo();
  const convId = "conv-shadow-contact";
  store.seedInboxConversation({ id: convId });
  resetContext(AURORA, convId);

  await runCustomerTurn(AURORA, convId, `notun thikana: House 9, Road 4, Uttara. ${PHONE}`, { mode: "shadow" });
  assert.equal((await rowsOf(store, "update_order_contact")).length, 0);
  assert.equal(await cardsFor(store, "update_order_contact"), 0);
  resetContext(AURORA, convId);
});

test("turn wiring, live: an order the gate BLOCKED becomes a guardrail_blocked hand-over, and the customer hears no rule", async () => {
  const store = demo();
  const convId = "conv-turn-blocked-order";
  store.seedInboxConversation({ id: convId });
  resetContext(AURORA, convId);
  await seedConfirmableState(convId);
  // A lock that bites the ORDER's target text ("… order sell cod") but not the
  // hand-over's, so the refusal can be handed to a person rather than dying.
  await store.setNoTouch(["COD"]);

  const result = await runCustomerTurn(AURORA, convId, "hae", { mode: "live" });
  assert.equal(result.action, "ESCALATE");
  assert.ok(result.handoverActionId);
  assert.equal(result.reply, "", "the server's holding line is what the customer gets");

  assert.equal((await rowsOf(store, "create_order_from_chat", "blocked")).length, 1);
  const [handed] = await rowsOf(store, "escalate_conversation", "executed");
  assert.ok(handed);
  const p = handed.payload as Record<string, unknown>;
  assert.equal(p.reason, "guardrail_blocked", "not tool_failure — the FD-4 lesson");
  assert.equal(p.department, "sales", "routed to whoever should pick it up");
  // The model may never name a guardrail: the brief says a rule stopped it, the
  // ledger row names WHICH, and the customer hears neither.
  assert.doesNotMatch(String(p.summary), /no_touch|guardrail:|COD lock/i);
  assert.match(String(p.summary), /shop's own rules/i);
  resetContext(AURORA, convId);
});
