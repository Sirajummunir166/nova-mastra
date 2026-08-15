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
import type { AbandonedCart, Courier, CourierScorecard, InboxEvent, Order, Product, Supplier } from "../store/types.js";

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

/**
 * One courier scorecard row, real-shaped: the counts are the input and the
 * rates fall out of them, exactly as dakio-api's `courierScorecard` computes
 * them. A case that wants a null rate gets it by resolving nothing, never by
 * typing `rtoRate: null` beside `resolved: 40` — a fixture that can express an
 * impossible row proves nothing about a layer that reads real ones.
 */
function courier(patch: {
  id: string;
  name?: string;
  delivered?: number;
  rto?: number;
  failed?: number;
  cancelled?: number;
  inFlight?: number;
  inFlightStagnant?: number;
  avgDaysToDeliver?: number | null;
  deliveryTimeSample?: number;
}): Courier {
  const delivered = patch.delivered ?? 0;
  const rto = patch.rto ?? 0;
  const failed = patch.failed ?? 0;
  const cancelled = patch.cancelled ?? 0;
  const inFlight = patch.inFlight ?? 0;
  const resolved = delivered + rto + failed;
  const parcels = resolved + inFlight + cancelled;
  const rate = (n: number) => (resolved > 0 ? Math.round((n / resolved) * 10000) / 10000 : null);
  return {
    id: patch.id,
    name: patch.name ?? `Courier ${patch.id}`,
    parcels, resolved, delivered, rto, failed, cancelled, inFlight,
    inFlightStagnant: patch.inFlightStagnant ?? 0,
    deliveredRate: rate(delivered),
    rtoRate: rate(rto),
    failedRate: rate(failed),
    // Null forever: the schema records no promised-delivery date.
    onTimeRate: null,
    onTimeBasis: "unavailable: Dakio records no promised-delivery date",
    avgDaysToDeliver: patch.avgDaysToDeliver ?? null,
    deliveryTimeSample: patch.deliveryTimeSample ?? 0,
    sufficientEvidence: resolved >= 25,
    basis: `${resolved} resolved of ${parcels} dispatched`,
  };
}

/** The scorecard envelope around some rows — `truncated` is the case's to set. */
function scorecard(couriers: Courier[], opts: { truncated?: boolean; days?: number } = {}): CourierScorecard {
  const total = (pick: (c: Courier) => number) => couriers.reduce((s, c) => s + pick(c), 0);
  return {
    couriers,
    window: { days: opts.days ?? 30, since: AT, until: AT, basedOn: "dispatch" },
    totals: {
      parcels: total((c) => c.parcels),
      resolved: total((c) => c.resolved),
      inFlight: total((c) => c.inFlight),
      cancelled: total((c) => c.cancelled),
      orphaned: 0,
    },
    truncated: opts.truncated === true,
    notes: [],
  };
}

/** A client that answers exactly what a case says, and throws where it says to. */
function client(parts: {
  products?: Product[] | Error;
  suppliers?: Supplier[] | Error;
  orders?: Order[] | Error;
  carts?: AbandonedCart[] | Error;
  couriers?: CourierScorecard | Error;
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
    listCouriers: answer(parts.couriers, scorecard([])),
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
// Courier — the sixth sense, and the unknowns that arrive with it
// ---------------------------------------------------------------------------

test("courier is SENSED from a real-shaped payload — counts, rates and the evidence flag survive intact", async () => {
  // The exact shape `GET /api/v1/store/couriers` emits. Nothing here is
  // re-derived by the sense layer: the route counted the parcels, so the route
  // owns what a rate over them means.
  const sense = await senseStore("s", client({
    couriers: scorecard([
      courier({ id: "steadfast", name: "Steadfast", delivered: 27, rto: 13, failed: 2, cancelled: 3, inFlight: 9, inFlightStagnant: 4, avgDaysToDeliver: 5.4, deliveryTimeSample: 25 }),
      courier({ id: "redx", name: "RedX", delivered: 71, rto: 3, failed: 1, cancelled: 4, inFlight: 12, avgDaysToDeliver: 2.1, deliveryTimeSample: 68 }),
    ]),
  }));

  assert.ok(sense.courier.ok, "the domain answered");
  const [steadfast, redx] = sense.courier.value.couriers;
  assert.equal(sense.courier.value.windowDays, 30);
  assert.equal(sense.courier.value.truncated, false);

  assert.equal(steadfast!.resolved, 42, "the denominator is delivered + rto + failed");
  assert.equal(steadfast!.parcels, 54, "in-flight and cancelled parcels are counted, just not rated");
  assert.equal(steadfast!.rtoRate, 0.3095);
  assert.equal(steadfast!.sufficientEvidence, true);
  assert.equal(steadfast!.basis, "42 resolved of 54 dispatched", "the base travels in words");
  assert.equal(steadfast!.inFlightStagnant, 4);
  assert.equal(steadfast!.avgDaysToDeliver, 5.4);
  assert.equal(redx!.rtoRate, 0.04);

  // And the domain is one of the six the all-blind guard asks about.
  assert.ok(SENSE_DOMAINS.includes("courier"));
  assert.equal(senseFailures(sense).length, 0);
});

test("onTimeRate is NULL and stays null — there is no promised-delivery date to be on time against", async () => {
  const sense = await senseStore("s", client({
    couriers: scorecard([courier({ id: "c1", delivered: 40, rto: 2, deliveryTimeSample: 40, avgDaysToDeliver: 3 })]),
  }));
  assert.ok(sense.courier.ok);
  const c = sense.courier.value.couriers[0]!;

  // THE REGRESSION THIS PINS: `onTimeRate: number` on the client type, and any
  // `?? 0`/`Number(...)` normalization behind it. A zero here reads as "this
  // courier delivers 0% of parcels on time" — the most alarming possible
  // sentence — about a measurement that cannot exist.
  assert.equal(c.onTimeRate, null);
  assert.notEqual(c.onTimeRate, 0);
  assert.match(c.onTimeBasis, /no promised-delivery date/i, "the reason travels with the null");

  // And the honest substitute is there, with its own base.
  assert.equal(c.avgDaysToDeliver, 3);
  assert.equal(c.deliveryTimeSample, 40);

  // A route build that sent something non-numeric is UNKNOWN, never a number.
  const junk = await senseStore("s", client({
    couriers: scorecard([{
      ...courier({ id: "c2", delivered: 30, rto: 1 }),
      onTimeRate: "0.9" as unknown as number,
      rtoRate: NaN,
    }]),
  }));
  assert.ok(junk.courier.ok);
  assert.equal(junk.courier.value.couriers[0]!.onTimeRate, null);
  assert.equal(junk.courier.value.couriers[0]!.rtoRate, null, "NaN would compare against every threshold");
});

test("a courier with nothing resolved has NULL rates, and it is named as a blind spot — not read as a clean record", async () => {
  const sense = await senseStore("s", client({
    couriers: scorecard([
      courier({ id: "fresh", name: "Fresh Courier", inFlight: 6, cancelled: 1 }),
      courier({ id: "thin", name: "Thin Courier", delivered: 1, rto: 1, inFlight: 3 }),
    ]),
  }));
  assert.ok(sense.courier.ok);
  const [fresh, thin] = sense.courier.value.couriers;

  assert.equal(fresh!.rtoRate, null, "0/0 is unknown; `0` would be a perfect record");
  assert.equal(fresh!.deliveredRate, null);
  assert.equal(fresh!.sufficientEvidence, false);

  // The thin one has REAL arithmetic — 50% RTO — over two parcels. Honest as a
  // number, useless as a verdict, and the flag is what says which.
  assert.equal(thin!.rtoRate, 0.5);
  assert.equal(thin!.sufficientEvidence, false);
  assert.equal(thin!.basis, "2 resolved of 5 dispatched");

  const keys = blindSpots(sense).map((b) => b.key);
  assert.ok(keys.includes("field:courierEvidence"), "silence about a 2-parcel courier is not a good record");
  assert.ok(keys.includes("field:courierUnresolved"));
  const evidence = blindSpots(sense).find((b) => b.key === "field:courierEvidence")!;
  assert.match(evidence.detail, /2 resolved of 5 dispatched/, "the blind spot quotes the base, not a percentage");

  // AND THE ON-TIME GAP IS NOT ONE OF THESE. It can never close, so it would
  // re-announce daily forever and block every quiet pulse; it is stated in the
  // report body wherever a courier claim is made instead (see pulse.ts).
  assert.equal(keys.includes("field:courierOnTime"), false);
});

test("a truncated courier window is a floor — the rows are the most recent dispatches, not the period", async () => {
  const sense = await senseStore("s", client({
    couriers: scorecard(
      [courier({ id: "c1", delivered: 4000, rto: 900, failed: 100, inFlight: 50, deliveryTimeSample: 4000, avgDaysToDeliver: 3.2 })],
      { truncated: true },
    ),
  }));
  assert.ok(sense.courier.ok);
  assert.equal(sense.courier.value.truncated, true, "the envelope's flag is the whole reason this seam returns one");

  const spot = blindSpots(sense).find((b) => b.key === "page:couriers");
  assert.ok(spot, "a capped read that looks like a total is exactly what this list is for");
  assert.match(spot!.detail, /not the period's totals/);
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
    products: boom, suppliers: boom, orders: boom, carts: boom, couriers: boom, events: boom,
  }));

  assert.equal(senseFailures(sense).length, SENSE_DOMAINS.length, "every sense is guarded, by name");
  assert.equal(allSensesDark(sense), true);
  assert.equal(blindSpots(sense).length, SENSE_DOMAINS.length);

  // ── THE SIXTH SENSE ARRIVED, AND THE GUARD SURVIVED IT ──────────────────
  //
  // This is the property the list-derived form was written for, now tested
  // against the event it was written for: `courier` joined SENSE_DOMAINS and
  // `allSensesDark` picked it up with no edit. A hard-coded `dark.length === 5`
  // in pulse.ts would have become unreachable the moment a sixth read existed —
  // silently, with the all-blind guard switched off and a fully blind store
  // completing its job row as "quiet".
  assert.equal(SENSE_DOMAINS.length, 6);
  assert.deepEqual([...SENSE_DOMAINS], ["products", "sales", "carts", "suppliers", "courier", "inbox"]);

  const partial = await senseStore("s", client({ products: boom }));
  assert.equal(allSensesDark(partial), false, "one dark sense is a degrade, not a blind pulse");
  // FIVE of six dark is still not all six. The guard must not round up.
  const five = await senseStore("s", client({
    products: boom, suppliers: boom, orders: boom, carts: boom, couriers: boom,
  }));
  assert.equal(allSensesDark(five), false, "one sense still answering is not a blind pulse");
  assert.equal(senseFailures(five).length, 5);
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
