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
  conversationOrderRef,
  payloadFingerprint,
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
  assert.equal(undo.code, coupon.code, "the minted code rides on undoData — the claim row's receipt predates it");
  // `targetRef` is null on a claim-finalized row, and that is the documented
  // cost of filing the dedupe record BEFORE the mint (see `performOfferDiscount`):
  // the row is inserted while the coupon does not exist yet, and neither
  // `updateAction` nor dakio-api's `PATCH /agent-data/actions/:id` can set
  // `targetRef` afterwards. The links that matter are asserted above —
  // `undoData.couponId` is what `runUndo` dispatches on, and the door chip is
  // stamped by `attributeDoorRecord` (a no-op in the demo store), not by this
  // denormalized copy.
  assert.equal(row.targetRef, null);
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

/**
 * The order id ALWAYS arrives scoped — `performCancelOrder` takes a
 * `ConversationOrderRef`, not a string, and only `conversationOrderRef()` mints
 * one. `scoped()` is what a caller does with the conversation's own order ids;
 * every test that wants a cancel has to go through it, which is the point.
 */
function scoped(orderId: string, convId = CONV) {
  return conversationOrderRef({ conversationId: convId, orderId, conversationOrderIds: [orderId] });
}

function cancelPayload(key: string, orderId: string, over: Partial<CancelOrderGatePayload> = {}): CancelOrderGatePayload {
  return {
    novaActionId: key,
    order: scoped(orderId),
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
    order: scoped(orderId),
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
        payload: { novaActionId: "nm:c:addr-noop", order: scoped(order.id) },
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

// ═══════════════════════════════════════════════════════════════════════════
// Part 3 — the floors an adversarial review found missing
//
// Every test below FAILS on the code as it stood before this change, and each
// one names the failure it pins. Three floors, one section each:
//
//   SAFETY      what may never reach a founder-facing string, and what may
//               never be written on a caller's unverified word.
//   IDEMPOTENCY what a redelivered key may and may not do — including the
//               half a key alone cannot carry (which request it was, and
//               whether the write either side of the row happened).
//   HONESTY     one rule over every customer-facing string: never assert an
//               outcome that is not determined, never assert state that was
//               not read, never imply queued work is under way.
//
// The suite composes with the server-side unique floor being added in parallel
// in dakio-api (`NovaAction @@unique([tenantId, type, dedupeKey])`) and assumes
// none of it: the DemoStore has no such index, so every dedupe asserted here is
// one this repo enforces on its own.
// ═══════════════════════════════════════════════════════════════════════════

import { orderActionKey, handoverActionKey, buildActionLine } from "./turn.js";
import { PREPARED_DETAIL_BY_VERB, resolveDiscountAmount } from "./actions.js";
import { newLiveContext } from "./state.js";

/** A BD mobile and a street line — the two shapes no founder-facing string may carry. */
const PII_STREET = "House 5, Road 2, Dhanmondi";
const BD_PHONE_SHAPE = /(?:\+?880|0)1[3-9]\d{8}/;

/** Fail ONE call to `method`, then restore it — a crash between two writes. */
function failOnce(store: unknown, method: string, message: string): void {
  const s = store as Record<string, (...a: unknown[]) => unknown>;
  const original = s[method]!.bind(store);
  let fired = false;
  s[method] = (...args: unknown[]) => {
    if (!fired) {
      fired = true;
      return Promise.reject(new Error(message));
    }
    return original(...args);
  };
}

/** Rows and cards this case filed, ignoring whatever the Aurora seed ships. */
async function filedBy(store: DemoStore, before: Set<string>, type: string) {
  const rows = (await store.listActions()).filter((a) => a.type === type && !before.has(a.id));
  const ids = new Set(rows.map((r) => r.id));
  const cards = (await store.listDecisions()).filter((d) => ids.has(d.actionId));
  return { rows, cards };
}

// ---------------------------------------------------------------------------
// 12. SAFETY — the PII floor, over every verb
// ---------------------------------------------------------------------------

/**
 * ONE table, all six verbs, both founder-facing surfaces.
 *
 * The rule was true of five of them and a hope on the sixth: `gateOrFile` ran
 * `maskPhonesIn` over the title and the params line, and `performCreateOrder`
 * — which does not pass through it — composed its title straight from
 * `customerCity`/`customerDistrict`. Those are customer-typed free text, and
 * the order verb is the ONE whose payload provably carries a phone and a street
 * line, so the gap was on exactly the verb that could not afford it.
 *
 * Each case feeds the verb the worst payload the lane could hand it and reads
 * back what actually got stored.
 *
 * TWO DIFFERENT CLAIMS, and the difference is deliberate. The PHONE claim is
 * absolute — `maskPhonesIn` is a shape match, so it holds wherever the digits
 * appear, including inside a customer's own sentence. The STREET claim is
 * asserted only for the two verbs with a DEDICATED address field
 * (`create_order_from_chat.customerAddress`, `update_order_contact.address`),
 * because that is what the code can enforce: a street line a customer types
 * INSIDE their cancellation reason travels with the reason, which the cancel
 * verb files unabridged on purpose ("the only record of why a sale went away").
 * Truncating it to chase a street pattern would lose the founder's one account
 * of the cancellation; the honest boundary is that no verb COMPOSES a title out
 * of an address field.
 */
const PII_CASES: Array<{ verb: string; lock?: string[]; street?: string; run: () => Promise<unknown> }> = [
  {
    verb: "create_order_from_chat",
    // The verb whose payload has a DEDICATED street field — the one the header
    // promises never reaches a title.
    street: PII_STREET,
    run: () =>
      performCreateOrder(AURORA, {
        // A zone as a customer types it, not as a form validates it.
        payload: payloadFor("nm:pii:order-0", {
          customerCity: `Savar (ring ${PHONE})`,
          customerAddress: PII_STREET,
        }),
        receipt: RECEIPT,
      }),
  },
  {
    verb: "offer_chat_discount",
    run: () =>
      performOfferDiscount(AURORA, {
        payload: discountPayload("nm:pii:discount-0", {
          reason: `Buyer at ${PII_STREET} keeps calling from ${PHONE} about the price.`,
        }),
        receipt: GATE_RECEIPT,
      }),
  },
  {
    verb: "cancel_order_from_chat",
    run: async () =>
      performCancelOrder(AURORA, {
        payload: cancelPayload("nm:pii:cancel-0", (await firstOrderWith(demo(), "placed")).id, {
          reason: `Call me on ${PHONE}, I am not at ${PII_STREET} any more.`,
        }),
        receipt: GATE_RECEIPT,
      }),
  },
  {
    verb: "update_order_contact",
    street: PII_STREET,
    run: async () =>
      performUpdateContact(AURORA, {
        payload: contactPayload("nm:pii:addr-0", (await firstOrderWith(demo(), "placed")).id, {
          address: PII_STREET,
          phone: PHONE,
        }),
        receipt: GATE_RECEIPT,
      }),
  },
  {
    verb: "open_case",
    run: () =>
      performOpenCase(AURORA, {
        payload: casePayload("nm:pii:case-0", {
          title: `Parcel stuck at ${PII_STREET}, buyer rang from ${PHONE}`,
          factsNote: `Customer says nobody came to ${PII_STREET}; reachable on ${PHONE}.`,
        }),
        receipt: GATE_RECEIPT,
      }),
  },
  {
    // A no-touch lock so the hand-over BLOCKS and files its own card — the only
    // tier on which this verb authors a local Decision at all.
    verb: "escalate_conversation",
    lock: ["REFUND"],
    run: () =>
      performFlagHandover(AURORA, {
        payload: handoverPayload("nm:pii:handover", {
          summary: `Customer at ${PII_STREET} wants a refund and is calling from ${PHONE} about it.`,
        }),
        receipt: GATE_RECEIPT,
      }),
  },
];

test("PII floor: no verb's founder-facing title or params line can carry a phone or a street line", async () => {
  for (const kase of PII_CASES) {
    resetStores();
    const store = demo();
    store.seedInboxConversation({ id: CONV });
    if (kase.lock) await store.setNoTouch(kase.lock);
    const before = new Set((await store.listActions()).map((a) => a.id));

    await kase.run();
    const { rows, cards } = await filedBy(store, before, kase.verb);
    assert.ok(rows.length >= 1, `${kase.verb}: the case must actually file a row to prove anything`);

    for (const row of rows) {
      assert.ok(!row.title.includes(PHONE), `${kase.verb}: the title outlives the card — it may not carry a full phone`);
      assert.doesNotMatch(row.title, BD_PHONE_SHAPE, `${kase.verb}: no BD phone SHAPE in the title, whatever the digits`);
      if (kase.street) assert.ok(!row.title.includes(kase.street), `${kase.verb}: the address FIELD may not reach the title`);
    }
    for (const card of cards) {
      assert.ok(!card.paramsLine.includes(PHONE), `${kase.verb}: the params line is re-rendered where nobody re-audits it`);
      assert.doesNotMatch(card.paramsLine, BD_PHONE_SHAPE, `${kase.verb}: no BD phone SHAPE in the params line`);
      if (kase.street) assert.ok(!card.paramsLine.includes(kase.street), `${kase.verb}: nor the params line`);
    }
    // And the raw words survive where the founder reads them in context.
    assert.ok(rows.every((r) => r.payload && typeof r.payload === "object"), `${kase.verb}: the payload is still filed`);
  }
});

test("PII floor: the order verb masks its own title and card — the surface that was uncovered", async () => {
  const store = demo();
  const out = await performCreateOrder(AURORA, {
    payload: payloadFor("nm:pii:order-solo", { customerCity: `Savar (ring ${PHONE})` }),
    receipt: RECEIPT,
  });
  assert.equal(out.status, "prepared");
  const [row] = await rowsOf(store, "create_order_from_chat", "prepared");
  assert.ok(row);
  assert.match(row.title, /···678/, "masked to the last three digits — the card's own convention");
  assert.equal(orderTitle(payloadFor("k", { customerCity: `Savar (ring ${PHONE})` })).includes(PHONE), true,
    "the helper still composes the raw string; the MASKER is what the gate applies");
});

// ---------------------------------------------------------------------------
// 13. SAFETY — conversation scoping is a type, not a comment
// ---------------------------------------------------------------------------

test("scoping: an order id this conversation does not own cannot be scoped at all", () => {
  assert.throws(
    () => conversationOrderRef({ conversationId: CONV, orderId: "ord-stranger", conversationOrderIds: ["ord-mine"] }),
    /not one of conversation/,
    "the mint is where the proof obligation lives — a stranger's parcel never gets a ref",
  );
  assert.throws(() => conversationOrderRef({ conversationId: "", orderId: "ord-1", conversationOrderIds: ["ord-1"] }), /conversationId is required/);
  const ref = conversationOrderRef({ conversationId: CONV, orderId: "ord-1", conversationOrderIds: ["ord-1", "ord-2"] });
  assert.equal(ref.orderId, "ord-1");
  assert.equal(ref.conversationId, CONV, "the thread travels WITH the id — a ref minted for one thread cannot be filed under another");
});

test("scoping: both mutating verbs refuse a hand-built ref, and the order never moves", async () => {
  const store = demo();
  await setTier(store, 4, { "inbox.cancelAuto": true, "inbox.addressEditAuto": true });
  const order = await firstOrderWith(store, "placed");
  const forged = { orderId: order.id, conversationId: CONV } as never;

  await assert.rejects(
    () => performCancelOrder(AURORA, { payload: { novaActionId: "nm:scope:cancel", order: forged, reason: "Stop this parcel please." }, receipt: GATE_RECEIPT }),
    /ConversationOrderRef/,
  );
  await assert.rejects(
    () => performUpdateContact(AURORA, { payload: { novaActionId: "nm:scope:addr", order: forged, address: "Somewhere else" }, receipt: GATE_RECEIPT }),
    /ConversationOrderRef/,
  );
  assert.equal((await store.getOrder(order.id))!.status, "placed", "nothing was written on an unscoped id");
  assert.equal((await rowsOf(store, "cancel_order_from_chat")).length, 0, "and no row was filed either");
});

test("scoping: the wire payload still carries orderId + conversationId, exactly as the approve executor reads them", async () => {
  const store = demo();
  const order = await firstOrderWith(store, "placed");
  await performCancelOrder(AURORA, { payload: cancelPayload("nm:scope:wire", order.id), receipt: GATE_RECEIPT });
  const [row] = await rowsOf(store, "cancel_order_from_chat", "prepared");
  const p = row!.payload as Record<string, unknown>;
  assert.equal(p.orderId, order.id);
  assert.equal(p.conversationId, CONV);
  assert.equal(p.order, undefined, "the lane-side ref does not travel on the wire");
});

// ---------------------------------------------------------------------------
// 14. SAFETY — free delivery: no agent-guessed money on the wire
// ---------------------------------------------------------------------------

test("free delivery: no tier reaches the wire with an agent-computed amount today", async () => {
  const store = demo();
  // The most permissive setting this repo can express.
  await setTier(store, 4, { ...DISCOUNT_PLATFORM, "inbox.discountAuto": true });
  const out = await performOfferDiscount(AURORA, {
    payload: discountPayload("nm:fd:0", { mechanism: "free_delivery", percentOff: undefined, reason: "Delivery is the whole objection on this cart." }),
    receipt: GATE_RECEIPT,
  });
  // `checkGuardrails`' non-percent branch returns needs_approval unconditionally
  // (a percent ceiling cannot judge a taka amount), so the direct tier is
  // unreachable for this mechanism and the SERVER prices it at approve time.
  assert.equal(out.status, "prepared");
  const [row] = await rowsOf(store, "offer_chat_discount", "prepared");
  const p = row!.payload as Record<string, unknown>;
  assert.equal(p.mechanism, "free_delivery");
  assert.equal(p.amount, undefined, "the mechanism travels; the money figure does not");
  assert.equal(p.percentOff, undefined);
  assert.equal((await novaCoupons(store)).length, 0);
});

test("free delivery: the one agent-side money computation is READ from the store and labelled a server gap", async () => {
  const store = demo();
  const settings = await store.getStoreSettings();
  const expected = Math.max(settings.deliveryInsideDhaka ?? 0, settings.deliveryOutsideDhaka ?? 0);

  const resolved = await resolveDiscountAmount(store, discountPayload("k", { mechanism: "free_delivery", percentOff: undefined }));
  assert.equal(resolved.amount, expected, "read from the shop's own two charges — never estimated, never a fallback figure");
  assert.ok(resolved.evidence, "and it says so on the receipt, or a reader concludes the server priced it");
  assert.equal(resolved.evidence!.source, "tool:get_store_settings");
  assert.equal(resolved.evidence!.metric, "server_gap");
  assert.match(resolved.evidence!.note, /no free-delivery mechanism/i, "the route citation is the whole justification");

  // A percent or taka offer computes nothing at all and files no such evidence.
  assert.equal((await resolveDiscountAmount(store, discountPayload("k"))).evidence, null);
  const fixed = await resolveDiscountAmount(store, discountPayload("k", { mechanism: "fixed", percentOff: undefined, amount: 200 }));
  assert.equal(fixed.amount, 200, "the founder's own figure, straight through — no ×100");
  assert.equal(fixed.evidence, null);
});

// ---------------------------------------------------------------------------
// 15. IDEMPOTENCY — the halves a key alone does not carry
// ---------------------------------------------------------------------------

test("replay: a key reused for a DIFFERENT payload is refused loudly, not answered from the old row", async () => {
  const store = demo();
  await setTier(store, 3);
  const first = await performOpenCase(AURORA, {
    payload: casePayload("nm:fp:case-0", { title: "Parcel has not moved for three days", factsNote: "Courier scan unchanged since Tuesday." }),
    receipt: GATE_RECEIPT,
  });
  assert.equal(first.status, "executed");

  // Same key, a different problem. Before the fingerprint this returned the
  // delivery-stuck row's outcome, and the customer who reported a broken bottle
  // was told a delivery case was open.
  await assert.rejects(
    () =>
      performOpenCase(AURORA, {
        payload: casePayload("nm:fp:case-0", { kind: "damaged_item", title: "Bottle arrived dented and leaking", factsNote: "Customer sent a photo of a dented lid." }),
        receipt: GATE_RECEIPT,
      }),
    /already filed for a DIFFERENT payload/,
  );
  assert.equal((await rowsOf(store, "open_case", "executed")).length, 1, "and nothing new was written");

  // The same payload still replays — the check is on the REQUEST, not the clock.
  const replay = await performOpenCase(AURORA, {
    payload: casePayload("nm:fp:case-0", { title: "Parcel has not moved for three days", factsNote: "Courier scan unchanged since Tuesday." }),
    receipt: GATE_RECEIPT,
  });
  assert.equal(replay.actionId, first.actionId);
  assert.equal(replay.status === "executed" && replay.replayed, true);
});

test("replay: the fingerprint rides on the row, and key order does not change it", async () => {
  const store = demo();
  await performCreateOrder(AURORA, { payload: payloadFor("nm:fp:order-0"), receipt: RECEIPT });
  const [row] = await rowsOf(store, "create_order_from_chat", "prepared");
  const stamped = row!.receipt.evidence.find((e) => e.source === "idempotency" && e.metric === "payload_fingerprint");
  assert.ok(stamped, "every row this file writes names WHICH request its key stood for");
  assert.equal(stamped.value, payloadFingerprint(payloadFor("nm:fp:order-0") as unknown as Record<string, unknown>));
  assert.equal(
    payloadFingerprint({ a: 1, b: { c: 2, d: 3 } }),
    payloadFingerprint({ b: { d: 3, c: 2 }, a: 1 }),
    "a re-serialized payload is the same request",
  );
  assert.notEqual(payloadFingerprint({ a: 1 }), payloadFingerprint({ a: 2 }));
});

test("replay: a prepared row whose Decision was lost gets it filed on the next delivery", async () => {
  const store = demo();
  const before = new Set((await store.listActions()).map((a) => a.id));
  failOnce(store, "addDecision", "desk unavailable");

  const payload = casePayload("nm:heal:case-0");
  const first = await performOpenCase(AURORA, { payload, receipt: GATE_RECEIPT });
  assert.equal(first.status, "prepared");
  assert.equal((await filedBy(store, before, "open_case")).cards.length, 0, "the card really was lost");

  const second = await performOpenCase(AURORA, { payload, receipt: GATE_RECEIPT });
  assert.equal(second.actionId, first.actionId, "still ONE row — healing is not re-filing");
  const healed = await filedBy(store, before, "open_case");
  assert.equal(healed.rows.length, 1);
  assert.equal(healed.cards.length, 1, "the founder can finally see the ask");
  assert.equal(healed.cards[0]!.kind, "proposal", "a replayed row is never an escalation — blocked rows do not replay");

  // A third delivery must not file a SECOND card on top of the healed one.
  await performOpenCase(AURORA, { payload, receipt: GATE_RECEIPT });
  assert.equal((await filedBy(store, before, "open_case")).cards.length, 1);
});

test("discount: the ledger row exists BEFORE the coupon — a lost claim mints nothing", async () => {
  const store = demo();
  await setTier(store, 3, { ...DISCOUNT_PLATFORM, "inbox.discountAuto": true });
  const couponsBefore = (await novaCoupons(store)).length;
  failOnce(store, "addAction", "ledger unavailable");

  const payload = discountPayload("nm:claim:discount-0");
  await assert.rejects(() => performOfferDiscount(AURORA, { payload, receipt: GATE_RECEIPT }), /ledger unavailable/);
  assert.equal(
    (await novaCoupons(store)).length - couponsBefore,
    0,
    "the claim row is the FIRST write: if it cannot be filed, no coupon is minted",
  );

  // And the retry issues exactly one.
  const out = await performOfferDiscount(AURORA, { payload, receipt: GATE_RECEIPT });
  assert.equal(out.status, "executed");
  assert.equal((await novaCoupons(store)).length - couponsBefore, 1);
});

test("discount: a lost FINALIZE leaves one coupon, and the replay answers with that same code", async () => {
  const store = demo();
  await setTier(store, 3, { ...DISCOUNT_PLATFORM, "inbox.discountAuto": true });
  const couponsBefore = (await novaCoupons(store)).length;
  // The claim files, the coupon mints, and the row never reaches `executed`.
  failOnce(store, "updateAction", "ledger unavailable");

  const payload = discountPayload("nm:claim:discount-1");
  await assert.rejects(() => performOfferDiscount(AURORA, { payload, receipt: GATE_RECEIPT }), /ledger unavailable/);
  const stranded = (await novaCoupons(store)).slice(couponsBefore);
  assert.equal(stranded.length, 1, "the coupon is out there");
  const claim = (await rowsOf(store, "offer_chat_discount", "prepared")).at(-1)!;
  assert.ok(
    claim.receipt.evidence.some((e) => e.source === "idempotency" && e.metric === "claim"),
    "and the row that names it is already on the ledger",
  );

  const replay = await performOfferDiscount(AURORA, { payload, receipt: GATE_RECEIPT });
  assert.equal(replay.status, "executed");
  assert.equal(replay.status === "executed" && replay.replayed, true);
  assert.equal(replay.status === "executed" && replay.code, stranded[0]!.code, "the customer holds ONE code, and it is the one that exists");
  assert.equal((await novaCoupons(store)).length - couponsBefore, 1, "the replay did not mint a second coupon for one negotiation");
  assert.equal((await rowsOf(store, "offer_chat_discount", "executed")).length, 1);
  assert.equal(await cardsFor(store, "offer_chat_discount"), 0, "a claim row is not a founder ask and never grows a card");
});

test("cancel: the status to restore survives a re-execution", async () => {
  const store = demo();
  await setTier(store, 4, { "inbox.cancelAuto": true });
  const order = await firstOrderWith(store, "placed");
  // The claim files, the order really cancels, and the finalize is lost.
  failOnce(store, "updateAction", "ledger unavailable");

  const payload = cancelPayload("nm:claim:cancel-0", order.id);
  await assert.rejects(() => performCancelOrder(AURORA, { payload, receipt: GATE_RECEIPT }), /ledger unavailable/);
  assert.equal((await store.getOrder(order.id))!.status, "cancelled", "the world moved on the first attempt");

  const replay = await performCancelOrder(AURORA, { payload, receipt: GATE_RECEIPT });
  assert.equal(replay.status, "executed");
  const [row] = await rowsOf(store, "cancel_order_from_chat", "executed");
  const undo = row!.undoData as Record<string, unknown>;
  // Read fresh, this would say 'cancelled' — an undo that restores 'cancelled'
  // is an undo that does nothing, and the founder's one way back is gone.
  assert.equal(undo.previousStatus, "placed", "the ORIGINAL status, persisted on the claim before the write");
  assert.equal(replay.status === "executed" && replay.previousStatus, "placed");
  assert.equal(row!.receipt.before?.status, "placed");
  assert.equal((await rowsOf(store, "cancel_order_from_chat", "executed")).length, 1);
});

// ---------------------------------------------------------------------------
// 16. IDEMPOTENCY — the keys the turn derives
// ---------------------------------------------------------------------------

test("keys: shadow and live derive the SAME order key from the same state", async () => {
  const store = demo();
  const convId = "conv-key-agreement";
  store.seedInboxConversation({ id: convId });
  resetContext(AURORA, convId);
  await seedConfirmableState(convId);

  // One order is already on the founder's desk for this thread.
  const ctx = loadContext(AURORA, convId, "chat", 0);
  ctx.pendingOrders = [{ actionId: "act-already-filed", title: "Insulated Steel Bottle 750ml" }];
  saveContext(ctx);
  const expected = orderActionKey(loadContext(AURORA, convId, "chat", 0));
  assert.equal(expected, `nm:${convId}:order-1`, "placed AND pending both count — the live path's rule");

  const shadow = await runCustomerTurn(AURORA, convId, "hae", { mode: "shadow" });
  assert.equal(shadow.wouldHaveDone!.type, "create_chat_order");
  assert.equal(
    shadow.wouldHaveDone!.novaActionId,
    expected,
    "the shadow dataset must record the key the live write would mint, or it is a record of a write live never makes",
  );
  resetContext(AURORA, convId);
});

test("keys: the derivation counts placed and pending orders, and rolls with the session", () => {
  const ctx = newLiveContext("conv-k", AURORA);
  assert.equal(orderActionKey(ctx), "nm:conv-k:order-0");
  ctx.orders.push({ no: "1001", title: "Bottle", total: 3599 });
  assert.equal(orderActionKey(ctx), "nm:conv-k:order-1");
  ctx.pendingOrders = [{ actionId: "a1", title: "Mug" }];
  assert.equal(orderActionKey(ctx), "nm:conv-k:order-2", "a second sale while the first waits gets its own key");

  assert.equal(handoverActionKey(ctx), "nm:conv-k:handover");
  const rolled = newLiveContext("conv-k", AURORA, "chat", 3);
  assert.equal(handoverActionKey(rolled), "nm:conv-k:e3:handover");
  assert.equal(orderActionKey(rolled), "nm:conv-k:e3:order-0");
  assert.equal(
    handoverActionKey(newLiveContext("conv-k", AURORA, "chat", 0)),
    "nm:conv-k:handover",
    "epoch 0 keeps the legacy key shape, so rows already in ledgers keep matching",
  );
});

test("handover: a thread the founder handed back can be escalated again", async () => {
  const store = demo();
  const convId = "conv-reescalate";
  store.seedInboxConversation({ id: convId });
  resetContext(AURORA, convId);

  const first = await runCustomerTurn(AURORA, convId, "human", { mode: "live", epoch: 0 });
  assert.equal(first.action, "ESCALATE");
  assert.equal((await rowsOf(store, "escalate_conversation", "executed")).length, 1);

  // Redelivery of the SAME turn inside the session still dedupes — the key is
  // constant within a session, which is what at-most-once means here.
  resetContext(AURORA, convId);
  await runCustomerTurn(AURORA, convId, "human", { mode: "live", epoch: 0 });
  assert.equal((await rowsOf(store, "escalate_conversation", "executed")).length, 1, "one escalation per session, however many deliveries");

  // The founder answers and hands it back; dakio-api rolls the session.
  const second = await runCustomerTurn(AURORA, convId, "human", { mode: "live", epoch: 1 });
  assert.equal(second.action, "ESCALATE");
  const rows = await rowsOf(store, "escalate_conversation", "executed");
  assert.equal(rows.length, 2, "escalation was once-per-conversation-FOREVER — a re-escalated thread could never reach a person again");
  assert.equal((rows[1]!.payload as Record<string, unknown>).novaActionId, `nm:${convId}:e1:handover`);
  resetContext(AURORA, convId);
});

// ---------------------------------------------------------------------------
// 17. HONESTY — one rule, every customer-facing string
// ---------------------------------------------------------------------------

/**
 * The three ways a line can lie, as patterns.
 *
 * Every one of these fired on the code before this change:
 *   "will be placed as approved"        (order)     — the founder may reject it
 *   "they will confirm it"              (cancel)    — likewise
 *   "nothing has shipped on it"         (cancel)    — nothing read the order
 *   "before the parcel goes out"        (contact)   — likewise
 *   "They will confirm the change"      (contact)   — the founder may reject it
 *   "the shop is picking it up"         (case)      — only a card is queued
 *   "The thread is being handed"        (handover)  — a prepared row moved nothing
 *   "will confirm shortly"              (turn line) — nothing bounds the wait
 *   "will take over shortly"            (turn line) — likewise, and on a BLOCKED
 *                                                     hand-over nothing was handed
 */
const DISHONEST_WORDING: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /\bwill (?:confirm|approve|be placed|be issued|take over|reply|call|get back)\b/i, why: "asserts an outcome the founder has not given" },
  { pattern: /\b(?:shortly|soon|right away|straight away|in a moment)\b/i, why: "promises a timeframe nothing bounds" },
  { pattern: /\bnothing has shipped\b/i, why: "asserts parcel state nothing on this path read" },
  { pattern: /before the parcel goes out/i, why: "asserts pre-dispatch state the server alone knows" },
  { pattern: /\bpicking it up\b|\bis being handed\b|\bis working on\b|\bhas started\b/i, why: "implies queued work is under way" },
  { pattern: /\balready (?:cancelled|changed|done|issued)\b/i, why: "asserts a completed write on a tier that wrote nothing" },
];

/** Every string this lane can put in front of a customer, in one list. */
async function customerFacingLines(): Promise<Array<{ where: string; text: string }>> {
  const ctx = newLiveContext("conv-wording", AURORA);
  const lines: Array<{ where: string; text: string }> = [];
  for (const [verb, detail] of Object.entries(PREPARED_DETAIL_BY_VERB)) {
    lines.push({ where: `${verb} preparedDetail`, text: detail() });
  }
  lines.push({ where: "turn ORDER_PENDING_APPROVAL", text: buildActionLine(ctx, "ORDER_PENDING_APPROVAL", "") });
  lines.push({ where: "turn ESCALATE (shadow / not run)", text: buildActionLine(ctx, "ESCALATE", "") });
  lines.push({ where: "turn ESCALATE (blocked)", text: buildActionLine(ctx, "ESCALATE", "", { handoverOutcome: "blocked" }) });
  lines.push({ where: "turn ANSWER_ORDER_STATUS", text: buildActionLine(ctx, "ANSWER_ORDER_STATUS", "") });
  lines.push({ where: "turn DECLINE_DISCOUNT_ONCE", text: buildActionLine(ctx, "DECLINE_DISCOUNT_ONCE", "") });
  return lines;
}

test("honesty: no verb's customer-facing wording asserts an undetermined outcome, unread state, or completed queued work", async () => {
  const lines = await customerFacingLines();
  assert.equal(lines.length, 11, "all six verbs plus the turn's own instruction lines");
  for (const line of lines) {
    for (const rule of DISHONEST_WORDING) {
      assert.doesNotMatch(line.text, rule.pattern, `${line.where}: ${rule.why} — "${line.text}"`);
    }
  }
});

test("honesty: each prepared line still says the ONE thing that is determined — it reached the shop", async () => {
  const lines = Object.entries(PREPARED_DETAIL_BY_VERB).map(([verb, detail]) => [verb, detail()] as const);
  for (const [verb, text] of lines) {
    assert.match(text, /shop|owner/i, `${verb}: the customer is owed the fact that a person now has it`);
  }
  // And the delicate ones still carry their own load-bearing clause.
  assert.match(PREPARED_DETAIL_BY_VERB.cancel_order_from_chat(), /not cancelled yet/i);
  assert.match(PREPARED_DETAIL_BY_VERB.create_order_from_chat(), /shop confirms/i, "FD-3: the normal flow, never an apology");
  assert.doesNotMatch(PREPARED_DETAIL_BY_VERB.offer_chat_discount(), /NOVA[A-Z0-9]/, "no code exists yet, so none may be named");
  assert.doesNotMatch(PREPARED_DETAIL_BY_VERB.open_case(), /\bcase\b/i, "no case exists yet, so none may be announced");
});

test("honesty: a BLOCKED hand-over does not tell the customer a person is taking over", async () => {
  const store = demo();
  const convId = "conv-blocked-handover-reply";
  store.seedInboxConversation({ id: convId });
  resetContext(AURORA, convId);
  // A lock that bites the hand-over's own summary, so the gate REFUSES it.
  await store.setNoTouch(["REFUND"]);

  const out = await performFlagHandover(AURORA, {
    payload: handoverPayload("nm:blocked:handover", {
      summary: "Customer wants a refund on a delivered parcel and will not accept an exchange.",
    }),
    receipt: GATE_RECEIPT,
  });
  assert.equal(out.status, "blocked", "the action-level state the old suite already pinned");

  // THE PART THAT WAS NEVER TESTED: what the customer is told afterwards.
  // Nova is still on the thread, no card reached anyone, and no holding line
  // was sent — so the reply may not promise a person on any clause.
  const ctx = newLiveContext(convId, AURORA);
  const blocked = buildActionLine(ctx, "ESCALATE", "", { handoverOutcome: "blocked" });
  assert.match(blocked, /promise NO person/i);
  assert.doesNotMatch(blocked, /\bwill take over\b/i);
  assert.doesNotMatch(blocked, /\bshortly\b/i);
  assert.match(blocked, /never mention the shop's internal rules/i, "the founder's lock is the shop's own business");
  // The executed path is the ONLY one that may speak of a person, and even it
  // does not promise when.
  const executed = buildActionLine(ctx, "ESCALATE", "");
  assert.match(executed, /taking this over/i);
  assert.doesNotMatch(executed, /\bshortly\b/i);
  assert.notEqual(blocked, executed, "the two states must not share a sentence");
  resetContext(AURORA, convId);
});

test("honesty: the pending-order line carries FD-3 without promising when or inventing a number", async () => {
  const ctx = newLiveContext("conv-pending-line", AURORA);
  const line = buildActionLine(ctx, "ORDER_PENDING_APPROVAL", "");
  assert.match(line, /double-checks every chat order/i, "the normal flow, stated as normal");
  assert.match(line, /no apology/i);
  assert.match(line, /give NO timeframe/i);
  assert.match(line, /do NOT invent an order number/i);
  assert.doesNotMatch(line, /\bshortly\b/i, "nothing bounds a founder's response time");
});
