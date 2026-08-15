/**
 * The state card — ported from nova-ai's inbox evals: c360.ts [FLOOR] +
 * [NON-VAC] (no full phone in the trusted block, swept with a regex detector
 * over the WHOLE serialized body, and the detector proved capable of firing)
 * and the card's own ~120-token budget (PRD §04). Re-anchored from eve's
 * customer-360 block onto renderStateCard — the one serializer both the model
 * packet and the founder sidebar read.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderStateCard, renderRecent } from "./card.js";
import { addMemo, fact, newLiveContext, pushMessage, type NovaLiveContext } from "./state.js";

/**
 * A Bangladeshi mobile in any of the three forms — the same detector c360.ts
 * and nba.ts sweep with. Swept over the whole card, never key by key: a leak
 * arrives through the field nobody thought of.
 */
const BD_MOBILE = /(?:\+?880|0)1[3-9]\d{8}/;

const FULL_PHONE = "01712345689";

/** A realistically FULL context — every card section populated. */
function maxedCtx(): NovaLiveContext {
  const ctx = newLiveContext("conv-88f2a1", "store-aurora");
  ctx.customer.name = fact("Nusrat Jahan", "customer");
  ctx.customer.phone = fact(FULL_PHONE, "customer");
  ctx.customer.addr = fact("House 12, Road 5, Mirpur 2, Dhaka 1216, near the big mosque", "customer");
  ctx.products.focusId = "prod-yogamat-01";
  ctx.products.tracked["prod-yogamat-01"] = "wants_to_buy";
  ctx.products.tracked["prod-candle-02"] = "interested";
  ctx.products.tracked["prod-shirt-03"] = "interested";
  ctx.products.items["prod-candle-02"] = { variant: "Large", qty: 2 };
  ctx.hydrated.product = fact(
    { id: "prod-yogamat-01", name: "Eco Yoga Mat 6mm", price: 1850, options: ["Green", "Purple", "Black"], stock: 12 },
    "tool:list_products",
  );
  ctx.hydrated.stock = fact(12, "tool:list_products", { ttlMs: 120_000 });
  ctx.hydrated.price = fact(1850, "tool:list_products", { ttlMs: 300_000 });
  ctx.purchase.variant = "Green";
  ctx.purchase.qty = 2;
  ctx.purchase.zone = "dhaka";
  ctx.purchase.fee = fact(60, "tool:get_store_settings");
  ctx.orders.push({ no: "AK-1042", title: "Scented Candle", total: 1450 });
  addMemo(ctx, "focus → Eco Yoga Mat · qty corrected 1→2 · no discount promised · order #AK-1042 ৳1450");
  return ctx;
}

// ---------------------------------------------------------------------------
// The privacy floor — c360 [FLOOR], re-anchored
// ---------------------------------------------------------------------------

test("no full phone anywhere in the card — masked to the last 3 digits", () => {
  const card = renderStateCard(maxedCtx());
  assert.ok(!BD_MOBILE.test(card), `full phone leaked into the card:\n${card}`);
  assert.ok(card.includes("···689"), "the masked tail is still there for confirmation ('number ending 689?')");
});

test("NON-VACUITY: the phone detector fires on the raw value", () => {
  // Every assertion above is a negative, and negatives pass when the detector
  // is broken. Prove it can fail, or a regex typo reads as a clean sweep forever.
  assert.ok(BD_MOBILE.test(FULL_PHONE));
  assert.ok(BD_MOBILE.test(`amar number +88${FULL_PHONE}`));
  assert.ok(!BD_MOBILE.test("#KQ3-8FZM"), "an order number must not fool it");
  assert.ok(!BD_MOBILE.test("···689"), "the masked form must not fire it");
});

test("the address is truncated on the card — never the full doorstep line", () => {
  const card = renderStateCard(maxedCtx());
  assert.ok(!card.includes("near the big mosque"), "the tail of a long address stays off the card");
  assert.ok(card.includes("House 12, Road 5, Mirpur 2, …"), "enough of the address to confirm against");
});

test(
  "SUSPECTED BUG: overflow folding can carry a full phone into the card's MEMO line",
  {
    todo:
      "pushMessage folds overflowed messages verbatim (first 60 chars) into conversation.summary, and renderStateCard prints MEMO unmasked — so once a phone/address message ages out of recent[], the full number the card's own header promises never to show rides the MEMO line into every later turn packet",
  },
  () => {
    const ctx = newLiveContext("conv-leak", "store-1");
    pushMessage(ctx, { role: "customer", text: `amar number ${FULL_PHONE}`, at: 1 });
    for (let i = 0; i < 9; i++) pushMessage(ctx, { role: "nova", text: `reply ${i}`, at: 2 + i });
    const card = renderStateCard(ctx);
    assert.ok(!BD_MOBILE.test(card), `full phone reached the card via MEMO:\n${card}`);
  },
);

// ---------------------------------------------------------------------------
// The token budget — ~120 tokens, rebuilt per turn (PRD §04)
// ---------------------------------------------------------------------------

/** The same rough estimate the PRD budgets with: ~4 chars per token. */
const estTokens = (s: string): number => Math.ceil(s.length / 4);

test("a fully-loaded card stays inside the ~120-token budget (≤150 with MEMO at half cap)", () => {
  const card = renderStateCard(maxedCtx());
  assert.ok(
    estTokens(card) <= 150,
    `card is ~${estTokens(card)} tokens (${card.length} chars) — the budget exists so the turn stays ~300 tokens in`,
  );
});

test("the card without its MEMO line is within ~120 tokens even at maximum fill", () => {
  const card = renderStateCard(maxedCtx())
    .split("\n")
    .filter((l) => !l.startsWith("MEMO"))
    .join("\n");
  assert.ok(estTokens(card) <= 120, `non-MEMO card is ~${estTokens(card)} tokens`);
});

test("an empty conversation renders a tiny card — the budget scales down too", () => {
  const card = renderStateCard(newLiveContext("conv-empty", "store-1"));
  assert.ok(estTokens(card) <= 40, `empty card is ~${estTokens(card)} tokens`);
  assert.ok(card.includes("MISSING product"), "even empty, the card names what the turn needs next");
});

// ---------------------------------------------------------------------------
// Inclusion rules — focus product full, tracked others one line each
// ---------------------------------------------------------------------------

test("the focus product gets detail; tracked others get one ALSO line with saved selections", () => {
  const card = renderStateCard(maxedCtx());
  assert.ok(card.includes("FOCUS Eco Yoga Mat 6mm"));
  assert.ok(card.includes("options Green/Purple/Black"), "the ask can quote real option names");
  const alsoLines = card.split("\n").filter((l) => l.startsWith("ALSO"));
  assert.equal(alsoLines.length, 2, "non-focus products are one line each, never hydrated detail");
  assert.ok(alsoLines.some((l) => l.includes("Large · qty 2")), "saved selections survive on the ALSO line");
});

test("stock and price carry their observation age — assumptions are never rendered as confirmed", () => {
  const ctx = maxedCtx();
  ctx.hydrated.stock = fact(12, "tool:list_products", { ttlMs: 120_000, at: Date.now() - 20_000 });
  const card = renderStateCard(ctx);
  assert.ok(/stock 12 \(20s\)/.test(card), "the model sees 'checked 20 sec ago', not a bare integer");
});

test("renderRecent is the verbatim tail — last N, attributed", () => {
  const ctx = newLiveContext("conv-tail", "store-1");
  for (let i = 0; i < 5; i++) {
    pushMessage(ctx, { role: i % 2 ? "nova" : "customer", text: `m${i}`, at: i });
  }
  const tail = renderRecent(ctx, 3);
  assert.deepEqual(tail.split("\n"), ["CUSTOMER: m2", "NOVA: m3", "CUSTOMER: m4"]);
});
