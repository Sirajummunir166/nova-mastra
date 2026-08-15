/**
 * Fact envelopes, freshness classes, and the reducer-derived stage/missing —
 * ported from nova-ai's inbox evals: freshness.ts [fresh-2] (the two freshness
 * classes are distinguishable, freshness is the AGE of the observation) and
 * closing.ts's variant law (the shop refuses a sizeless order → `variant` is a
 * missing field exactly when the product has options). Re-anchored from eve's
 * productSnapshot fields onto our Fact/isFresh/computeMissing/computeStage.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addMemo,
  ageSec,
  computeMissing,
  computeStage,
  fact,
  isFresh,
  newLiveContext,
  pushMessage,
  type NovaLiveContext,
} from "./state.js";

const T0 = 1_755_000_000_000;

// ---------------------------------------------------------------------------
// Fact envelopes — no naked values, freshness is the age of the observation
// ---------------------------------------------------------------------------

test("a STABLE fact (ttl null) is fresh forever within the conversation", () => {
  const f = fact("Eco Yoga Mat", "tool:list_products", { at: T0, ttlMs: null });
  assert.equal(isFresh(f, T0), true);
  assert.equal(isFresh(f, T0 + 24 * 60 * 60_000), true, "a day later the identity still holds");
});

test("a VOLATILE fact is fresh inside its window and stale one ms past it", () => {
  const f = fact(3, "tool:list_products", { at: T0, ttlMs: 120_000 });
  assert.equal(isFresh(f, T0 + 20_000), true, "stock checked 20 sec ago answers 'fabric kemon?' turns for free");
  assert.equal(isFresh(f, T0 + 120_000), true, "fresh AT the boundary");
  assert.equal(isFresh(f, T0 + 120_001), false, "stale one ms past it — the next touch revalidates");
});

test("an absent fact is never fresh — unmeasured is not fresh", () => {
  assert.equal(isFresh(undefined), false);
});

test("age is whole seconds from the observation, clamped at zero", () => {
  const f = fact(3, "tool:list_products", { at: T0 });
  assert.equal(ageSec(f, T0 + 20_000), 20, "'checked 20 sec ago' has to come from somewhere");
  assert.equal(ageSec(f, T0 - 5_000), 0, "a clock that went backwards never reports a negative age");
});

test("confidence defaults to confirmed; sources name where a fact came from", () => {
  const said = fact("01712345689", "customer");
  assert.equal(said.confidence, "confirmed");
  const guessed = fact("Mirpur", "profile", { confidence: 0.6 });
  assert.equal(guessed.confidence, 0.6, "an inferred fact is never rendered as confirmed");
});

// ---------------------------------------------------------------------------
// computeMissing — the checkout ladder's ground truth
// ---------------------------------------------------------------------------

function ctxWithFocus(opts: { options?: string[] } = {}): NovaLiveContext {
  const ctx = newLiveContext("conv-m", "store-1");
  ctx.products.focusId = "p-1";
  ctx.products.tracked["p-1"] = "wants_to_buy";
  ctx.hydrated.product = fact(
    { id: "p-1", name: "Eco Yoga Mat", price: 1850, stock: 12, options: opts.options },
    "tool:list_products",
  );
  return ctx;
}

test("a fresh conversation is missing everything, starting with the product", () => {
  const missing = computeMissing(newLiveContext("conv-a", "store-1"));
  assert.deepEqual(missing, ["product", "qty", "zone", "phone", "address", "confirmation"]);
});

test("the variant law: a product WITH options demands a variant; one without never does", () => {
  // closing.ts: "the shop REFUSES a sizeless order" — the server 422s
  // VARIANT_REQUIRED, so the ladder must ask for the size, and must never
  // invent a size question for a product that has none.
  assert.ok(computeMissing(ctxWithFocus({ options: ["M", "L", "XL"] })).includes("variant"));
  assert.ok(!computeMissing(ctxWithFocus()).includes("variant"));

  const chosen = ctxWithFocus({ options: ["M", "L", "XL"] });
  chosen.purchase.variant = "M";
  assert.ok(!computeMissing(chosen).includes("variant"));
});

test("fields leave missing[] as facts arrive; confirmation is last out", () => {
  const ctx = ctxWithFocus({ options: ["M", "L"] });
  ctx.purchase.variant = "M";
  ctx.purchase.qty = 1;
  ctx.purchase.zone = "dhaka";
  ctx.customer.phone = fact("01712345689", "customer");
  ctx.customer.addr = fact("বাসা ১২, রোড ৫, মিরপুর ২, ঢাকা", "customer");
  assert.deepEqual(computeMissing(ctx), ["confirmation"]);
  ctx.purchase.confirmSent = true;
  assert.deepEqual(computeMissing(ctx), [], "summary sent → nothing missing, the confirm decides");
});

// ---------------------------------------------------------------------------
// computeStage — reducer-computed, never model-set
// ---------------------------------------------------------------------------

test("the funnel: discovery → product_interest → product_selection → checkout → final_confirmation", () => {
  const ctx = newLiveContext("conv-s", "store-1");
  assert.equal(computeStage(ctx), "discovery");

  ctx.products.focusId = "p-1";
  ctx.products.tracked["p-1"] = "interested";
  ctx.hydrated.product = fact({ id: "p-1", name: "Mat", price: 1850, stock: 12, options: ["M", "L"] }, "tool:list_products");
  assert.equal(computeStage(ctx), "product_interest", "interest is not yet a purchase");

  ctx.products.tracked["p-1"] = "wants_to_buy";
  assert.equal(computeStage(ctx), "product_selection", "wants to buy but variant/qty still open");

  ctx.purchase.variant = "M";
  ctx.purchase.qty = 1;
  assert.equal(computeStage(ctx), "checkout", "selection done; zone/phone/address remain");

  ctx.purchase.zone = "dhaka";
  ctx.customer.phone = fact("01712345689", "customer");
  ctx.customer.addr = fact("Mirpur 2, Dhaka", "customer");
  assert.equal(computeStage(ctx), "final_confirmation", "all info known → one summary, then the confirm");
});

test("terminal and side stages are sticky — only explicit transitions leave them", () => {
  for (const stage of ["escalated", "ordered", "post_order", "validating", "support"] as const) {
    const ctx = newLiveContext("conv-t", "store-1");
    ctx.conversation.stage = stage;
    ctx.products.focusId = "p-1"; // even with funnel signals present…
    ctx.products.tracked["p-1"] = "wants_to_buy";
    assert.equal(computeStage(ctx), stage, `${stage} must not be recomputed away`);
  }
});

// ---------------------------------------------------------------------------
// recent[] + MEMO — verbatim tail, append-only compressed history
// ---------------------------------------------------------------------------

test("recent keeps the last 8 verbatim; overflow folds into MEMO oldest-first", () => {
  const ctx = newLiveContext("conv-r", "store-1");
  for (let i = 0; i < 10; i++) {
    pushMessage(ctx, { role: i % 2 === 0 ? "customer" : "nova", text: `message number ${i}`, at: T0 + i });
  }
  assert.equal(ctx.recent.length, 8);
  assert.equal(ctx.recent[0]?.text, "message number 2", "the two oldest folded out");
  assert.ok(ctx.conversation.summary.includes("C: message number 0"), "folded customer line is memoed with its author");
  assert.ok(ctx.conversation.summary.includes("N: message number 1"));
});

test("MEMO is bounded (~320 chars) and keeps the newest tail when it overflows", () => {
  const ctx = newLiveContext("conv-memo", "store-1");
  for (let i = 0; i < 20; i++) addMemo(ctx, `note-${i} ${"x".repeat(40)}`);
  assert.ok(ctx.conversation.summary.length <= 320, `memo ${ctx.conversation.summary.length} chars`);
  assert.ok(ctx.conversation.summary.includes("note-19"), "append-only: the newest note survives the cap");
  assert.ok(!ctx.conversation.summary.includes("note-0"), "the oldest is what the cap eats");
});

test("a folded message line is truncated to 60 chars — MEMO cannot be flooded by one long message", () => {
  const ctx = newLiveContext("conv-long", "store-1");
  pushMessage(ctx, { role: "customer", text: "a".repeat(500), at: T0 });
  for (let i = 0; i < 8; i++) pushMessage(ctx, { role: "nova", text: `m${i}`, at: T0 + 1 + i });
  assert.ok(ctx.conversation.summary.length <= 320);
  assert.ok(!ctx.conversation.summary.includes("a".repeat(61)), "at most 60 chars of the folded message survive");
});
