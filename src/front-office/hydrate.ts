/**
 * Product resolution + hydration (PRD §06: identify → hydrate once → render;
 * switch ≠ discard). All reads go through the observation cache so the
 * ledger is the audit trail and freshness is the age of the observation.
 */

import { observe, TTL } from "./cache.js";
import { listProducts, getSettings, type DakioProduct } from "./dakio.js";
import { fact, type NovaLiveContext } from "./state.js";

/** Naive text match over the active catalog — good enough until Product Vision. */
export function matchProduct(products: DakioProduct[], text: string): DakioProduct | null {
  const t = text.toLowerCase();
  const words = t.split(/[^a-z0-9ঀ-৿]+/).filter((w) => w.length >= 3);
  const scored: Array<{ product: DakioProduct; score: number }> = [];
  for (const p of products) {
    const name = p.name.toLowerCase();
    let score = 0;
    if (t.includes(name)) score += 10;
    for (const w of words) if (name.includes(w)) score += 2;
    if (p.category && t.includes(p.category.toLowerCase())) score += 1;
    if (score > 0) scored.push({ product: p, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const [best, second] = scored;
  if (!best) return null;
  // One strong word is enough when it singles out ONE product ("panjabi ta
  // koto?"); ambiguity (a tie at the top) means ask, not guess.
  if (best.score >= 4 && (!second || second.score < best.score)) return best.product;
  if (best.score >= 2 && (!second || second.score < best.score)) return best.product;
  return null;
}

/** Read the catalog through the cache and try to resolve the customer's words. */
export async function resolveProduct(ctx: NovaLiveContext, text: string): Promise<DakioProduct | null> {
  const { raw } = await observe(ctx, "list_products", { status: "active" }, () => listProducts(ctx.storeId), TTL.product);
  return matchProduct(raw, text);
}

/**
 * Hydrate once: identity (stable) + stock/price (volatile) into envelopes.
 * Switching focus later restores from products.items — zero refetch.
 */
export function focusProduct(ctx: NovaLiveContext, p: DakioProduct, source: "customer" | "vision" = "customer"): void {
  const prevFocus = ctx.products.focusId;
  if (prevFocus && prevFocus !== p.id) {
    // Switch ≠ discard: keep the old product's status + saved selections.
    ctx.products.items[prevFocus] = { variant: ctx.purchase.variant, qty: ctx.purchase.qty };
    ctx.purchase.variant = undefined;
    ctx.purchase.qty = undefined;
    ctx.purchase.confirmSent = false;
  }
  ctx.products.focusId = p.id;
  ctx.products.tracked[p.id] ??= "interested";
  // Restore saved selections if we've discussed this product before.
  const saved = ctx.products.items[p.id];
  if (saved) {
    ctx.purchase.variant ??= saved.variant;
    ctx.purchase.qty ??= saved.qty;
  }

  const at = Date.now();
  ctx.hydrated.product = fact(
    {
      id: p.id,
      name: p.name,
      price: p.price,
      compareAtPrice: p.compareAtPrice,
      options: p.variantNames?.length ? p.variantNames : undefined,
      stock: p.stock,
    },
    source === "vision" ? "vision" : "tool:list_products",
    { ttlMs: TTL.product, at },
  );
  ctx.hydrated.stock = fact(p.stock, "tool:list_products", { ttlMs: TTL.stock, at });
  ctx.hydrated.price = fact(p.price, "tool:list_products", { ttlMs: TTL.price, at });
}

/** Case-blind key lookup into a name-keyed variant record. */
function variantKey(record: Record<string, unknown>, variant: string): string | undefined {
  return Object.keys(record).find((k) => k.toLowerCase() === variant.toLowerCase());
}

/**
 * Stock for the currently selected variant (falls back to product total).
 * `variantStock` is a NAME-KEYED record (`store/types.ts` Product) — a dead
 * option must read its own 0, never the product total.
 */
export function variantStock(p: DakioProduct, variant?: string): number {
  if (!variant || !p.variantStock) return p.stock;
  const key = variantKey(p.variantStock, variant);
  return key !== undefined ? (p.variantStock[key] ?? p.stock) : p.stock;
}

/** The variant id the order write needs — from the read's name→id map, never invented. */
export function variantIdFor(p: DakioProduct, variant?: string): string | undefined {
  if (!variant || !p.variantIds) return undefined;
  const key = variantKey(p.variantIds, variant);
  return key !== undefined ? p.variantIds[key] : undefined;
}

/** Policies/fees through the cache; fee resolved from the zone (inside/outside Dhaka). */
export async function hydratePolicies(ctx: NovaLiveContext): Promise<void> {
  const { raw, calledAt } = await observe(ctx, "get_store_settings", {}, () => getSettings(ctx.storeId), TTL.settings);
  ctx.hydrated.policies = fact(
    {
      deliveryFeeInside: raw.deliveryInsideDhaka,
      deliveryFeeOutside: raw.deliveryOutsideDhaka,
      codAvailable: raw.codAvailable,
      insideZone: "dhaka",
    },
    "tool:get_store_settings",
    { ttlMs: TTL.settings, at: calledAt },
  );
}

export function feeForZone(ctx: NovaLiveContext, zone: string): number | undefined {
  const pol = ctx.hydrated.policies?.value;
  if (!pol) return undefined;
  const inside = zone.toLowerCase().includes("dhaka") || zone.includes("ঢাকা");
  return inside ? pol.deliveryFeeInside : pol.deliveryFeeOutside;
}
