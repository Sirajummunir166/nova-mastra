/**
 * Next Best Action — ported from nova-ai's inbox evals: nba.ts [nba-5]'s
 * invariant ("asking for a human and saying nothing are never illegal" — here:
 * human_ask/complaint force ESCALATE past every ladder state), selling.ts's
 * no-discount-authority spirit (a discount ask is declined, never granted),
 * and closing.ts's checkout ladder (variant → qty → zone → phone/addr → ONE
 * summary → confirm → mutate; ask ONLY for missing fields). Re-anchored from
 * eve's authority matrix + NBA candidate block onto our deterministic
 * nextBestAction — the app picks the move; the model only words it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { nextBestAction } from "./nba.js";
import { fact, newLiveContext, type NovaLiveContext } from "./state.js";

/** A checkout in progress, complete up to `upto`. */
function checkoutCtx(
  upto: "focus" | "variant" | "qty" | "zone" | "contact" | "summary" = "focus",
  opts: { options?: string[] } = { options: ["M", "L", "XL"] },
): NovaLiveContext {
  const ctx = newLiveContext("conv-nba", "store-1");
  ctx.products.focusId = "p-1";
  ctx.products.tracked["p-1"] = "wants_to_buy";
  ctx.hydrated.product = fact(
    { id: "p-1", name: "Blue Cotton Panjabi", price: 1250, stock: 8, options: opts.options },
    "tool:list_products",
  );
  const order = ["focus", "variant", "qty", "zone", "contact", "summary"];
  const at = (s: string) => order.indexOf(upto) >= order.indexOf(s);
  if (at("variant")) ctx.purchase.variant = "M";
  if (at("qty")) ctx.purchase.qty = 1;
  if (at("zone")) ctx.purchase.zone = "dhaka";
  if (at("contact")) {
    ctx.customer.phone = fact("01712345689", "customer");
    ctx.customer.addr = fact("বাসা ১২, রোড ৫, মিরপুর ২, ঢাকা", "customer");
  }
  if (at("summary")) ctx.purchase.confirmSent = true;
  return ctx;
}

// ---------------------------------------------------------------------------
// Judgment/authority moves beat the ladder — [nba-5] re-anchored
// ---------------------------------------------------------------------------

test("asking for a human is never illegal — ESCALATE wins in every ladder state", () => {
  for (const upto of ["focus", "variant", "qty", "zone", "contact", "summary"] as const) {
    assert.equal(nextBestAction(checkoutCtx(upto), "human_ask"), "ESCALATE", `human_ask at '${upto}' must escalate`);
  }
  assert.equal(nextBestAction(newLiveContext("c", "s"), "human_ask"), "ESCALATE", "…and with no product at all");
});

test("a complaint escalates too — even one summary away from the close", () => {
  assert.equal(nextBestAction(checkoutCtx("summary"), "complaint"), "ESCALATE");
});

test("a discount ask is declined once — no discount authority on this lane, at any stage", () => {
  assert.equal(nextBestAction(checkoutCtx("summary"), "discount_ask"), "DECLINE_DISCOUNT_ONCE");
  assert.equal(nextBestAction(checkoutCtx("focus"), "discount_ask"), "DECLINE_DISCOUNT_ONCE");
});

test("order status, delivery FAQ and rejection are answered where they land", () => {
  assert.equal(nextBestAction(checkoutCtx("qty"), "order_status_q"), "ANSWER_ORDER_STATUS");
  assert.equal(nextBestAction(checkoutCtx("qty"), "faq_delivery"), "ANSWER_DELIVERY_FAQ");
  assert.equal(nextBestAction(checkoutCtx("qty"), "reject"), "ACKNOWLEDGE_REJECT");
});

// ---------------------------------------------------------------------------
// No focus yet — discovery moves
// ---------------------------------------------------------------------------

test("no product in focus: greet a greeting, ask which product for anything product-shaped", () => {
  const ctx = newLiveContext("conv-d", "store-1");
  assert.equal(nextBestAction(ctx, "greeting"), "GREET");
  for (const intent of ["product_query", "buy_intent", "price_q", "stock_q"] as const) {
    assert.equal(nextBestAction(ctx, intent), "ASK_PRODUCT", `${intent} without focus → ASK_PRODUCT`);
  }
  assert.equal(nextBestAction(ctx, "other"), "CLARIFY");
});

// ---------------------------------------------------------------------------
// Answer first, then one step forward
// ---------------------------------------------------------------------------

test("a focused price/stock question is ANSWERED — never hijacked into the next ask", () => {
  // "dam koto?" mid-checkout gets the price; the writer folds the one step
  // forward into the same message. The action must be the answer.
  assert.equal(nextBestAction(checkoutCtx("focus"), "price_q"), "ANSWER_PRICE");
  assert.equal(nextBestAction(checkoutCtx("focus"), "stock_q"), "ANSWER_STOCK");
  assert.equal(nextBestAction(checkoutCtx("zone"), "price_q"), "ANSWER_PRICE", "…at any rung of the ladder");
});

// ---------------------------------------------------------------------------
// The checkout ladder — variant → qty → zone → phone/addr → ONE summary
// ---------------------------------------------------------------------------

test("the ladder asks for exactly the next missing field, one at a time", () => {
  assert.equal(nextBestAction(checkoutCtx("focus"), "buy_intent"), "ASK_SIZE", "options exist → size first");
  assert.equal(nextBestAction(checkoutCtx("variant"), "size_pick"), "ASK_QTY");
  assert.equal(nextBestAction(checkoutCtx("qty"), "qty_pick"), "ASK_ZONE");
  assert.equal(nextBestAction(checkoutCtx("zone"), "zone_pick"), "ASK_PHONE_ADDR");
  assert.equal(nextBestAction(checkoutCtx("contact"), "phone_give"), "PRESENT_SUMMARY", "everything known → ONE summary");
});

test("the variant law on the ladder: a product without options never gets a size ask", () => {
  const ctx = checkoutCtx("focus", { options: undefined });
  assert.equal(nextBestAction(ctx, "buy_intent"), "ASK_QTY", "no options → qty is the first ask");
});

test("already-known fields are never re-asked — the ask ladder skips what the thread said", () => {
  // Zone arrived early (customer volunteered "savar" before picking a size):
  const ctx = checkoutCtx("focus");
  ctx.purchase.zone = "savar";
  assert.equal(nextBestAction(ctx, "buy_intent"), "ASK_SIZE");
  ctx.purchase.variant = "L";
  ctx.purchase.qty = 2;
  assert.equal(nextBestAction(ctx, "qty_pick"), "ASK_PHONE_ADDR", "zone already known → straight to contact");
});

// ---------------------------------------------------------------------------
// The confirm gate — the ONE mutation decision
// ---------------------------------------------------------------------------

test("CREATE_ORDER only when the summary was presented AND the customer confirmed", () => {
  assert.equal(nextBestAction(checkoutCtx("summary"), "confirm"), "CREATE_ORDER");
});

test("a confirm BEFORE any summary is not an order — ambiguity is not confirmation", () => {
  // closing.ts §5: emoji-only / an ambiguous "hmm" / agreement mid-collection
  // must not mutate. Our gate encodes it structurally: no summary presented →
  // no CREATE_ORDER, the ladder just continues.
  const early = nextBestAction(checkoutCtx("contact"), "confirm");
  assert.notEqual(early, "CREATE_ORDER");
  assert.equal(early, "PRESENT_SUMMARY", "all fields known but unconfirmed → present the ONE summary first");

  const midway = nextBestAction(checkoutCtx("variant"), "confirm");
  assert.notEqual(midway, "CREATE_ORDER");
});

test("everything known and summary pending: a non-confirm turn re-presents rather than mutating", () => {
  // The customer asked something else instead of confirming — the decided
  // action must never be CREATE_ORDER without the confirm intent itself.
  assert.notEqual(nextBestAction(checkoutCtx("summary"), "other"), "CREATE_ORDER");
  assert.notEqual(nextBestAction(checkoutCtx("summary"), "qty_pick"), "CREATE_ORDER");
});
