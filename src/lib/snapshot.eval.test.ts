/**
 * THE SENSE LAYER'S OWN CONTRACT — the file that had no test at all.
 *
 * Everything in `snapshot.ts` is a claim about what Nova KNOWS, and every
 * defect this suite pins was live in a shipped build while a green suite one
 * directory over asserted the pulse's honesty. The pattern in all of them is
 * the same, and it is worth naming once: A MISSING FIELD ARRIVED AS A ZERO, AND
 * A ZERO IS A MEASUREMENT.
 *
 *   · `weeklyVelocity: []`  → 0/day  → the whole catalogue is dead stock
 *   · `cost: num(null) = 0` → 100%   → every thin-margin finding disappears
 *   · `currentDelayDays ?? 0`        → every silent supplier is "on time"
 *   · a 200-row page                 → "your 200 products", "24 carts", a
 *                                      week-over-week percentage computed
 *                                      against a truncated denominator
 *
 * The velocity case was found, fixed, documented — and left untested, so
 * reverting `velocityOf` to `return 0` (the precise regression the fix was
 * written to prevent) failed nothing. It fails here now, first test.
 *
 * No network, no model, no state: `senseStore` takes a client, so the client is
 * a literal.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  allSensesDark,
  blindSpots,
  costOf,
  LIST_PAGE_CAP,
  marginPctOf,
  NEAR_ZERO_VELOCITY,
  SENSE_DOMAINS,
  senseFailures,
  senseStore,
  velocityOf,
  velocityWeeksOf,
} from "./snapshot.js";
import type { StoreClient } from "../store/client.js";
import type { AbandonedCart, InboxEvent, Order, Product, Supplier } from "../store/types.js";

const AT = "2026-08-15T09:00:00.000Z";
const DAY = 86_400_000;

/** A complete demo-shaped product; every case overrides only what it is about. */
function product(patch: Partial<Product> & { id: string }): Product {
  return {
    sku: "SKU", name: `Product ${patch.id}`, category: "Home", description: "",
    price: 1000, compareAtPrice: null, cost: 400, stock: 10, reorderPoint: 5,
    supplierId: "sup-1", status: "active", rating: 0, reviewCount: 0,
    weeklyVelocity: [7, 7, 7, 7], tags: [], variantNames: [], createdAt: AT,
    ...patch,
  } as Product;
}

function supplier(patch: Partial<Supplier> & { id: string }): Supplier {
  return {
    name: `Supplier ${patch.id}`, country: "BD", reliabilityScore: 1, qualityScore: 1,
    offers: [{ productId: "p1", unitCost: 400, leadTimeDays: 10 }],
    currentDelayDays: 0, notes: "",
    ...patch,
  } as Supplier;
}

function order(patch: Partial<Order> & { id: string }): Order {
  return {
    customerId: "c1", items: [], subtotal: 1000, discount: 0, shipping: 0, total: 1000,
    status: "delivered", courierId: null, placedAt: AT, deliveredAt: null, region: "Dhaka",
    ...patch,
  } as Order;
}

function cart(patch: Partial<AbandonedCart> & { id: string }): AbandonedCart {
  return {
    customerId: "c1", items: [], value: 500, abandonedAt: AT, recoveryState: "none",
    recoveryMessage: null,
    ...patch,
  } as AbandonedCart;
}

/** A client that answers exactly what a case says, and throws where it says to. */
function client(parts: {
  products?: Product[] | Error;
  suppliers?: Supplier[] | Error;
  orders?: Order[] | Error;
  carts?: AbandonedCart[] | Error;
  events?: InboxEvent[] | Error;
  at?: string;
}): StoreClient {
  const answer = <T>(value: T | Error | undefined, fallback: T) => async (): Promise<T> => {
    if (value instanceof Error) throw value;
    return value ?? fallback;
  };
  return {
    now: () => parts.at ?? AT,
    listProducts: answer(parts.products, []),
    listSuppliers: answer(parts.suppliers, []),
    listOrders: answer(parts.orders, []),
    listAbandonedCarts: answer(parts.carts, []),
    listInboxEvents: answer(parts.events, []),
  } as unknown as StoreClient;
}

// ---------------------------------------------------------------------------
// Unknown is not zero — the four fields, one at a time
// ---------------------------------------------------------------------------

test("velocityOf answers NULL for a product with no velocity source — never 0", () => {
  // THE REGRESSION THIS PINS: `return 0`. dakio-api answers `weeklyVelocity: []`
  // for every product ("gap: derivable from OrderItem history"), and 0/day is
  // what declares an entire live catalogue dead stock, hourly, confidently.
  assert.equal(velocityOf({ weeklyVelocity: [] }), null);
  assert.equal(velocityOf({ weeklyVelocity: undefined as unknown as number[] }), null);
  assert.equal(velocityWeeksOf({ weeklyVelocity: [] }), 0);

  // A real series still measures. 7 units a week is 1/day.
  assert.equal(velocityOf({ weeklyVelocity: [7, 7, 7, 7] }), 1);
  assert.equal(velocityWeeksOf({ weeklyVelocity: [7, 7, 7, 7] }), 4);

  // The window is the last FOUR buckets, and the count says how many were
  // really averaged — "selling ~0.14/day" off one week is an estimate, not a
  // month of watching, and the founder-facing line has to be able to tell them
  // apart.
  assert.equal(velocityWeeksOf({ weeklyVelocity: [1, 2, 3, 4, 5, 6, 7, 8] }), 4);
  assert.equal(velocityOf({ weeklyVelocity: [7] }), 1, "one bucket is still a rate");
  assert.equal(velocityWeeksOf({ weeklyVelocity: [7] }), 1, "…over one week, and it says so");

  // A junk bucket does not poison the mean into NaN, which would then compare
  // as a number against every threshold downstream.
  assert.equal(velocityOf({ weeklyVelocity: [7, null as unknown as number, 7] }), 1);
});

test("costOf and marginPctOf treat a missing cost as UNKNOWN — not as a 100% margin", () => {
  // dakio-api's mapper is `cost: num(p.purchasePrice)` with `num(null) = 0`.
  assert.equal(costOf({ cost: 0 }), null, "0 on the wire is 'no purchase price', not free goods");
  assert.equal(costOf({ cost: NaN }), null);
  assert.equal(costOf({ cost: undefined as unknown as number }), null);
  assert.equal(costOf({ cost: 400 }), 400);

  // The defect, exactly: a ৳3,959 product with no cost read as a 100% margin,
  // sailed over the 25% floor, and the founder was told nothing about a
  // catalogue Nova could not cost at all.
  assert.equal(marginPctOf({ price: 3959, cost: 0 }), null);
  // And the confident nonsense: `NaN% margin at ৳3,959 on ৳NaN cost`.
  assert.equal(marginPctOf({ price: 3959, cost: NaN }), null);
  // The price guard that was already there, kept.
  assert.equal(marginPctOf({ price: 0, cost: 100 }), null);
  assert.equal(marginPctOf({ price: 1000, cost: 900 }), 10);
});

test("a supplier that reports no delay is UNKNOWN, and is never stored as on time", async () => {
  const sense = await senseStore("s", client({
    suppliers: [
      supplier({ id: "sup-quiet", currentDelayDays: undefined as unknown as number }),
      supplier({ id: "sup-late", currentDelayDays: 4 }),
    ],
  }));
  assert.ok(sense.suppliers.ok);
  const [quiet, late] = sense.suppliers.value;
  assert.equal(quiet!.currentDelayDays, null, "`?? 0` turned this into a measured on-time delivery");
  assert.equal(late!.currentDelayDays, 4);

  assert.ok(
    blindSpots(sense).some((b) => b.key === "field:supplierDelay"),
    "and the gap is reported rather than absorbed",
  );
});

test("a supplier record with no offers is a STUB — its '0 days late' is not a measurement", async () => {
  // dakio-api's supplier mapper ships `offers: []` and `currentDelayDays: 0, //
  // gap` from the same lines. Believing that 0 means reporting every supplier
  // on a live tenant as perfectly on schedule, forever.
  const sense = await senseStore("s", client({ suppliers: [supplier({ id: "s1", offers: [] })] }));
  const spot = blindSpots(sense).find((b) => b.key === "field:supplierRecord");
  assert.ok(spot, "the stub shape is named");
  assert.match(spot!.detail, /placeholder from the source/);
});

// ---------------------------------------------------------------------------
// Pages are pages
// ---------------------------------------------------------------------------

test("a catalogue that fills the page is reported as a partial sweep, not as the catalogue", async () => {
  const many = Array.from({ length: LIST_PAGE_CAP }, (_, i) => product({ id: `p${i}` }));
  const sense = await senseStore("s", client({ products: many, suppliers: [supplier({ id: "sup-1" })] }));
  assert.equal(sense.partial.products, true);
  const spot = blindSpots(sense).find((b) => b.key === "page:products");
  assert.ok(spot, "a store with 800 SKUs had 600 never watched and nothing said so");
  assert.match(spot!.detail, /most recently created products/);

  // One product short of the cap is a complete sweep and claims nothing extra.
  const fewer = await senseStore("s", client({ products: many.slice(1), suppliers: [supplier({ id: "sup-1" })] }));
  assert.equal(fewer.partial.products, false);
  assert.equal(blindSpots(fewer).some((b) => b.key === "page:products"), false);
});

test("week-over-week revenue is REFUSED on a truncated order page — the denominator is the part that fell off", async () => {
  const nowMs = Date.parse(AT);
  const orders = Array.from({ length: LIST_PAGE_CAP }, (_, i) =>
    order({ id: `o${i}`, total: 100, placedAt: new Date(nowMs - (i % 13) * DAY).toISOString() }),
  );
  const sense = await senseStore("s", client({ orders }));
  assert.ok(sense.sales.ok);
  assert.equal(sense.sales.value.partial, true);
  const spot = blindSpots(sense).find((b) => b.key === "page:orders");
  assert.ok(spot, "the page cap is a blind spot, because the prior week is what gets cut");
  assert.match(spot!.detail, /week-over-week revenue cannot be measured/);
});

test("an order with no usable total is excluded from revenue, not counted at ৳0", async () => {
  const nowMs = Date.parse(AT);
  const sense = await senseStore("s", client({
    orders: [
      order({ id: "o1", total: 1000, placedAt: new Date(nowMs - DAY).toISOString() }),
      order({ id: "o2", total: undefined as unknown as number, placedAt: new Date(nowMs - DAY).toISOString() }),
    ],
  }));
  assert.ok(sense.sales.ok);
  assert.equal(sense.sales.value.revenue7d, 1000);
  assert.equal(sense.sales.value.orders7d, 1, "an order Nova cannot price is not an order worth ৳0");
  assert.equal(sense.sales.value.unpricedOrders, 1);
  assert.ok(blindSpots(sense).some((b) => b.key === "field:orderTotal"));
});

test("carts are one page of leads of ANY status — the unrecovered subset says when it is a floor", async () => {
  const carts = [
    ...Array.from({ length: LIST_PAGE_CAP - 3 }, (_, i) => cart({ id: `c${i}`, recoveryState: "recovered" })),
    cart({ id: "open-1" }),
    cart({ id: "open-2", recoveryState: "message_prepared" }),
    cart({ id: "open-3", value: 0 }),
  ];
  const sense = await senseStore("s", client({ carts }));
  assert.ok(sense.carts.ok);
  assert.equal(sense.carts.value.count, 3, "only the unrecovered ones count");
  assert.equal(sense.carts.value.value, 1000, "and the ৳0 lead is not priced into the money figure");
  assert.equal(sense.carts.value.unpriced, 1);
  assert.equal(sense.carts.value.partial, true, "the page was full, so this is a floor");
  const keys = blindSpots(sense).map((b) => b.key);
  assert.ok(keys.includes("page:carts"));
  assert.ok(keys.includes("field:cartValue"));
});

// ---------------------------------------------------------------------------
// Blindness, at both granularities
// ---------------------------------------------------------------------------

test("a read that SUCCEEDS but drops a load-bearing field is a blind spot, not a healthy read", async () => {
  const sense = await senseStore("s", client({
    // A live dakio tenant, exactly: velocity gone, no supplier offers, cost 0.
    products: [product({ id: "p1", weeklyVelocity: [], cost: 0 })],
    suppliers: [supplier({ id: "sup-1", offers: [] })],
  }));

  assert.equal(senseFailures(sense).length, 0, "nothing THREW — this is the case that looked healthy");
  const keys = blindSpots(sense).map((b) => b.key);
  assert.ok(keys.includes("field:velocity"), "no velocity: cover and dead stock cannot be judged");
  assert.ok(keys.includes("field:leadTime"), "no offer: a reorder's arrival cannot be predicted");
  assert.ok(keys.includes("field:cost"), "no cost: margin cannot be computed, and is NOT 100%");

  const velocity = blindSpots(sense).find((b) => b.key === "field:velocity")!;
  assert.match(velocity.detail, /not "all clear"/, "the line says what the silence does NOT mean");

  // And the signals themselves carry unknown as unknown.
  assert.ok(sense.products.ok);
  const p = sense.products.value[0]!;
  assert.equal(p.velocity, null);
  assert.equal(p.daysOfCover, null);
  assert.equal(p.leadTimeDays, null);
  assert.equal(p.cost, null);
  assert.equal(p.marginPct, null);
});

test("a dark read names itself, and 'all of them dark' is asked of the sense list, not of the number 5", async () => {
  const boom = new Error("dakio-api 503");
  const sense = await senseStore("s", client({
    products: boom, suppliers: boom, orders: boom, carts: boom, events: boom,
  }));

  assert.equal(senseFailures(sense).length, SENSE_DOMAINS.length, "every sense is guarded, by name");
  assert.equal(allSensesDark(sense), true);
  assert.equal(blindSpots(sense).length, SENSE_DOMAINS.length);

  // The guard is a question about SENSE_DOMAINS. A sixth sense joins the count
  // automatically instead of silently switching the all-blind check off.
  assert.equal(SENSE_DOMAINS.length, 5);
  assert.deepEqual([...SENSE_DOMAINS], ["products", "sales", "carts", "suppliers", "inbox"]);

  const partial = await senseStore("s", client({ products: boom }));
  assert.equal(allSensesDark(partial), false, "one dark sense is a degrade, not a blind pulse");
});

test("a product that sells nothing has no days of cover — Infinity would sort like a number", async () => {
  const sense = await senseStore("s", client({
    products: [product({ id: "p1", weeklyVelocity: [NEAR_ZERO_VELOCITY / 2] })],
    suppliers: [supplier({ id: "sup-1" })],
  }));
  assert.ok(sense.products.ok);
  assert.equal(sense.products.value[0]!.daysOfCover, null);
});

test("the cart page is read ONCE — the same 200 rows were being fetched twice", async () => {
  let calls = 0;
  const base = client({ carts: [cart({ id: "c1" })] });
  const counting = {
    ...base,
    now: () => AT,
    listAbandonedCarts: async (...args: unknown[]) => {
      calls += 1;
      assert.deepEqual(args, [], "unfiltered — the filtering is this layer's, so it can see the page size");
      return [cart({ id: "c1" })];
    },
  } as unknown as StoreClient;
  await senseStore("s", counting);
  assert.equal(calls, 1);
});
