/**
 * Product matching + hydration — ported from nova-ai's inbox evals:
 * photomatch.ts [3] (the candidate rule: floor + ambiguity margin — "ambiguity
 * means ask, not guess"), closing.ts (per-option stock: never offer a dead
 * size; the variant id must have a real source), and the PRD §06 invariant
 * "switch ≠ discard". Re-anchored from eve's photoMatch/pickCandidate and
 * get_products seams onto our matchProduct / focusProduct / variantStock /
 * variantIdFor / feeForZone.
 *
 * Hermetic: fixtures only, no network — matchProduct and friends are pure.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { matchProduct, focusProduct, variantStock, variantIdFor, feeForZone } from "./hydrate.js";
import type { DakioProduct } from "./dakio.js";
import { fact, newLiveContext } from "./state.js";

const p = (over: Partial<DakioProduct> & { id: string; name: string }): DakioProduct => ({
  sku: over.id.toUpperCase(),
  category: "General",
  price: 1000,
  compareAtPrice: null,
  stock: 10,
  status: "active",
  ...over,
});

const CATALOG: DakioProduct[] = [
  p({ id: "p-panjabi", name: "Blue Cotton Panjabi", category: "Panjabi" }),
  p({ id: "p-saree-red", name: "Jamdani Saree Red", category: "Saree" }),
  p({ id: "p-saree-blue", name: "Jamdani Saree Blue", category: "Saree" }),
  p({ id: "p-saree-bn", name: "কাতান শাড়ি", category: "Saree" }),
  p({ id: "p-wallet", name: "Leather Wallet", category: "Accessories" }),
];

// ---------------------------------------------------------------------------
// The candidate rule — photomatch [3], re-anchored on text matching
// ---------------------------------------------------------------------------

test("one strong word that singles out ONE product matches it — 'panjabi ta koto?'", () => {
  const m = matchProduct(CATALOG, "panjabi ta koto?");
  assert.equal(m?.id, "p-panjabi");
});

test("the full product name in the message is the strongest signal", () => {
  const m = matchProduct(CATALOG, "blue cotton panjabi ta nibo");
  assert.equal(m?.id, "p-panjabi");
});

test("two different products neck-and-neck → ambiguity means ask, not guess", () => {
  // "jamdani saree" scores Red and Blue identically — a tie at the top must
  // yield null so the turn asks which one, never silently picks one.
  const m = matchProduct(CATALOG, "jamdani saree ta koto?");
  assert.equal(m, null);
});

test("a qualifier that breaks the tie resolves the ambiguity", () => {
  const m = matchProduct(CATALOG, "jamdani saree blue ta koto?");
  assert.equal(m?.id, "p-saree-blue");
});

test("no signal at all → honest none, never a fuzzy guess", () => {
  assert.equal(matchProduct(CATALOG, "mobile cover ache?"), null);
  assert.equal(matchProduct([], "panjabi ta koto?"), null, "an empty catalog matches nothing");
});

test("Bangla-script product words match Bangla-named products", () => {
  // matchProduct's tokenizer keeps the Bangla range, so a customer writing in
  // script can still name a product the catalog spells in script.
  const m = matchProduct(CATALOG, "শাড়ি টা কত?");
  assert.equal(m?.id, "p-saree-bn");
});

// ---------------------------------------------------------------------------
// Switch ≠ discard — PRD §06: saved per-product selections
// ---------------------------------------------------------------------------

test("switching focus saves the old product's selections and voids the pending summary", () => {
  const ctx = newLiveContext("conv-1", "store-1");
  const a = p({ id: "p-a", name: "Product A", variantNames: ["M", "L"] });
  const b = p({ id: "p-b", name: "Product B" });

  focusProduct(ctx, a);
  ctx.purchase.variant = "M";
  ctx.purchase.qty = 2;
  ctx.purchase.confirmSent = true;

  focusProduct(ctx, b);
  assert.equal(ctx.products.focusId, "p-b");
  assert.deepEqual(ctx.products.items["p-a"], { variant: "M", qty: 2 }, "A's selections are saved, not discarded");
  assert.equal(ctx.purchase.variant, undefined, "B starts clean");
  assert.equal(ctx.purchase.qty, undefined);
  assert.equal(ctx.purchase.confirmSent, false, "a pending summary for A cannot confirm an order for B");
  assert.equal(ctx.products.tracked["p-a"], "interested", "A stays tracked");

  // Switching back restores — zero refetch, zero re-asking.
  focusProduct(ctx, a);
  assert.equal(ctx.purchase.variant, "M");
  assert.equal(ctx.purchase.qty, 2);
});

test("hydration writes envelopes: stable identity, volatile stock/price, all stamped", () => {
  const ctx = newLiveContext("conv-2", "store-1");
  focusProduct(ctx, p({ id: "p-a", name: "Product A", price: 1850, stock: 7, variantNames: ["Green", "Black"] }));
  assert.equal(ctx.hydrated.product?.value.name, "Product A");
  assert.deepEqual(ctx.hydrated.product?.value.options, ["Green", "Black"]);
  assert.equal(ctx.hydrated.stock?.value, 7);
  assert.equal(ctx.hydrated.price?.value, 1850);
  // The two freshness classes are distinguishable: stock expires before price,
  // and both are volatile (finite ttl), while the identity read is day-stable.
  assert.ok(typeof ctx.hydrated.stock?.ttlMs === "number" && typeof ctx.hydrated.price?.ttlMs === "number");
  assert.ok(ctx.hydrated.stock.ttlMs < ctx.hydrated.price.ttlMs, "stock is the most volatile fact");
  assert.ok(ctx.hydrated.product?.ttlMs && ctx.hydrated.product.ttlMs > ctx.hydrated.price.ttlMs);
});

test("a product without variants exposes no options — nothing for ASK_SIZE to ask about", () => {
  const ctx = newLiveContext("conv-3", "store-1");
  focusProduct(ctx, p({ id: "p-b", name: "Product B", variantNames: [] }));
  assert.equal(ctx.hydrated.product?.value.options, undefined);
});

// ---------------------------------------------------------------------------
// Per-variant stock — closing.ts round 3/4: never offer a dead size, and the
// variant id must come from the read, never invention
// ---------------------------------------------------------------------------

test("variantStock over the declared array shape answers per option", () => {
  const arr = p({
    id: "p-mat",
    name: "Eco Yoga Mat",
    stock: 12,
    variantNames: ["Green", "Purple", "Black"],
    variantStock: [7, 0, 5],
    variantIds: ["var-g", "var-p", "var-b"],
  });
  assert.equal(variantStock(arr, "Green"), 7);
  assert.equal(variantStock(arr, "purple"), 0, "a dead option reads 0 — case-blind");
  assert.equal(variantStock(arr, undefined), 12, "no variant → product total");
  assert.equal(variantStock(arr, "Nonexistent"), 12, "unknown option falls back to total");
  assert.equal(variantIdFor(arr, "purple"), "var-p");
  assert.equal(variantIdFor(arr, undefined), undefined);
});

test(
  "SUSPECTED BUG: the runtime record shape makes every variant read the product total",
  {
    todo:
      "listProducts really returns name-keyed records (src/store/types.ts Product, seed.ts; dakio.ts's own NOTE admits it) but variantStock/variantIdFor index numerically — so a DEAD variant reports the product total (order gate passes stock it does not have) and variantIdFor returns undefined (the order goes up without a variant id — the exact VARIANT_REQUIRED incident nova-ai's closing round 4 fixed)",
  },
  () => {
    const runtime = p({
      id: "p-mat",
      name: "Eco Yoga Mat",
      stock: 12,
      variantNames: ["Green", "Purple", "Black"],
      // The shape src/store/seed.ts actually ships and DakioStoreClient returns:
      variantStock: { Green: 7, Purple: 0, Black: 5 } as unknown as number[],
      variantIds: { Green: "var-g", Purple: "var-p", Black: "var-b" } as unknown as string[],
    });
    assert.equal(variantStock(runtime, "Purple"), 0, "a dead size must read 0, not the product total");
    assert.equal(variantStock(runtime, "Green"), 7);
    assert.equal(variantIdFor(runtime, "Green"), "var-g", "the order call needs a real variant id from the read");
  },
);

// ---------------------------------------------------------------------------
// Zone → fee — the two-rate delivery truth (knowledge.ts kn-2, re-anchored)
// ---------------------------------------------------------------------------

test("feeForZone maps inside/outside Dhaka, in both scripts, and never invents finer pricing", () => {
  const ctx = newLiveContext("conv-4", "store-1");
  assert.equal(feeForZone(ctx, "dhaka"), undefined, "no policies read yet → no fee, never a guess");

  ctx.hydrated.policies = fact(
    { deliveryFeeInside: 60, deliveryFeeOutside: 120, codAvailable: true, insideZone: "dhaka" },
    "tool:get_store_settings",
  );
  assert.equal(feeForZone(ctx, "dhaka"), 60);
  assert.equal(feeForZone(ctx, "Dhaka Uttara"), 60);
  assert.equal(feeForZone(ctx, "ঢাকা"), 60, "the Bangla-script zone answer pays the inside rate too");
  assert.equal(feeForZone(ctx, "savar"), 120);
  assert.equal(feeForZone(ctx, "sylhet"), 120);
  assert.ok(60 <= 120, "inside ≤ outside — the market shape, pinned so a swap is loud");
});
