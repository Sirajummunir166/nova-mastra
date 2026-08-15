/**
 * Demo dataset for "Aurora Living" — a home & lifestyle DTC store on Dakio.
 *
 * Everything derives deterministically from the `nowMs` anchor (no RNG, no
 * Date.now), so the store always boots into the same living, coherent
 * business day. The data intentionally contains the PRD-signature
 * situations Nova must find and act on:
 *
 *  - "Evening Glow Retargeting": CPA up ~43% over the last 3 days (pause candidate)
 *  - "Blender Summer Push": ROAS 3.8, budget-limited (scale candidate;
 *    prepared action action-8001 already queued)
 *  - exactly 14 abandoned carts in various recovery states
 *  - stockout risks (blender, yoga mat) incl. a delayed supplier + a cheaper
 *    alternative supplier (prepared PO action-8002 queued, over the ৳3,00,000 cap)
 *  - dead stock (ceramic vase set), a thin-margin product (carafe set)
 *  - a bad courier (SwiftShip: 13 of 42 resolved parcels came back, 5.4 days
 *    to deliver, 4 parcels stagnant in transit) beside one whose 50% RTO is
 *    over TWO parcels and may therefore be reported to nobody
 *  - an overdue refund ticket (>12h), pre-seeded memory, overnight activity
 *
 * Note: orders are a representative sample (base rows + one echo clone per
 * normal order to reach realistic volume); weeklyVelocity on products is
 * authoritative for demand forecasting.
 */

import type {
  AbandonedCart,
  ActionRecord,
  ActivityEntry,
  Campaign,
  CampaignDayStat,
  Courier,
  Customer,
  CustomerMessage,
  Discount,
  ExpenseEntry,
  MemoryEntry,
  NovaReport,
  Order,
  OrderItem,
  Product,
  PurchaseOrder,
  SocialPost,
  StoreSeed,
  Supplier,
  SupportTicket,
  TrendingProduct,
} from "./types.js";
import { DEFAULT_GUARDRAILS } from "./autonomy.js";

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** dakio-api's own evidence floor (`COURIER_MIN_EVIDENCE`), mirrored for the seed. */
const COURIER_MIN_EVIDENCE = 25;

/**
 * Build ONE courier scorecard row from a parcel history, with dakio-api's
 * arithmetic — not with hand-typed rates.
 *
 * WHY THE COUNTS ARE THE INPUT AND THE RATES ARE DERIVED. A seed that typed
 * `rtoRate: 0.11` beside `resolved: 2` would be internally impossible, and the
 * two rules the pulse must obey — no rate over a zero base, and a rate is not
 * evidence below the floor — would then be testable only against fixtures that
 * agree with them by hand. Here they fall out of the same three lines the route
 * runs (`novaStore.js` → `courierScorecard`): a courier with nothing resolved
 * gets `null` rates rather than a perfect record, and `sufficientEvidence` is
 * arithmetic over `resolved`, never an opinion.
 *
 * `onTimeRate` is hard-coded `null` here for the same reason it is null there:
 * Dakio's schema has no promised-delivery date, so there is no promise to be on
 * time against. The seed does not get to invent one for its own convenience.
 *
 * Exported because `seed-beacon.ts` needs the same arithmetic, and a second
 * copy is how two demo stores would come to disagree about what a rate means.
 */
export function courierRow(input: {
  id: string;
  name: string;
  delivered: number;
  rto: number;
  failed: number;
  cancelled: number;
  inFlight: number;
  inFlightStagnant: number;
  /** The mean this courier really posts, or null when nothing timed-stamped. */
  avgDaysToDeliver: number | null;
  deliveryTimeSample: number;
}): Courier {
  const { delivered, rto, failed, cancelled, inFlight } = input;
  const resolved = delivered + rto + failed;
  const parcels = resolved + inFlight + cancelled;
  // Never a NaN, never a rate over a zero base — the route's `courierRate`.
  const rate = (n: number): number | null =>
    resolved > 0 ? Math.round((n / resolved) * 10000) / 10000 : null;
  return {
    id: input.id,
    name: input.name,
    parcels,
    resolved,
    delivered,
    rto,
    failed,
    cancelled,
    inFlight,
    inFlightStagnant: input.inFlightStagnant,
    deliveredRate: rate(delivered),
    rtoRate: rate(rto),
    failedRate: rate(failed),
    onTimeRate: null,
    onTimeBasis: "unavailable: Dakio records no promised-delivery date",
    avgDaysToDeliver: input.deliveryTimeSample > 0 ? input.avgDaysToDeliver : null,
    deliveryTimeSample: input.deliveryTimeSample,
    sufficientEvidence: resolved >= COURIER_MIN_EVIDENCE,
    basis: `${resolved} resolved of ${parcels} dispatched`,
  };
}

export function createSeed(nowMs: number): StoreSeed {
  const iso = (daysAgo: number, hour = 12, minute = 0): string => {
    const d = new Date(nowMs - daysAgo * DAY);
    d.setUTCHours(hour, minute, 0, 0);
    return d.toISOString();
  };
  const hoursAgo = (h: number): string => new Date(nowMs - h * HOUR).toISOString();
  const inDays = (d: number, hour = 9): string => {
    const x = new Date(nowMs + d * DAY);
    x.setUTCHours(hour, 0, 0, 0);
    return x.toISOString();
  };
  const day = (daysAgo: number): string =>
    new Date(nowMs - daysAgo * DAY).toISOString().slice(0, 10);
  const r2 = (n: number): number => Math.round(n * 100) / 100;

  /**
   * Delivery, in ৳.
   *
   * The threshold converts straight across with the rest of the seed, which
   * keeps the free-vs-paid split exactly where it was (60 of 136 orders) so
   * the demo shows both outcomes at the same rate it always did.
   *
   * The FEE is the one figure deliberately NOT scaled: converting the old
   * $5.95 rate lands at ৳714, which no Bangladeshi store charges. Home
   * delivery here is a small flat fee, not a fraction of basket value, so it
   * is set at the real market rate. That drops shipping from ~4.3% of
   * subtotal to ~0.2% — an intended consequence of charging a real price, not
   * a rescaling error.
   *
   * Nothing in the autonomy gate reads shipping, so neither figure can move a
   * guardrail verdict — verified by `scripts/money-audit.ts`.
   */
  const FREE_SHIPPING_OVER = 9000;
  const FLAT_DELIVERY = 120;

  // ---- Products (19) -------------------------------------------------------

  const products: Product[] = [
    {
      id: "prod-blender", sku: "AUR-BLD-01", name: "Portable Blender Pro", category: "Kitchen",
      description: "USB-C rechargeable 500ml personal blender. Crushes ice, cleans itself.",
      price: 5999, compareAtPrice: 7199, cost: 2220, stock: 35, reorderPoint: 40,
      supplierId: "sup-shenzhen", status: "active", rating: 4.7, reviewCount: 214,
      weeklyVelocity: [22, 26, 28, 31, 34, 36, 38, 41], tags: ["bestseller", "summer"], variantNames: [], createdAt: iso(160),
    },
    {
      id: "prod-yogamat", sku: "AUR-YGA-01", name: "EcoFlex Yoga Mat", category: "Wellness",
      description: "6mm natural rubber mat with alignment lines. Non-slip, plastic-free.",
      price: 4799, compareAtPrice: null, cost: 1320, stock: 12, reorderPoint: 25,
      supplierId: "sup-lotus", status: "active", rating: 4.6, reviewCount: 142,
      // The demo store's one variant product, so the gate demo can exercise
      // the one-ask ("kon color neben?") and the VARIANT_REQUIRED refusal.
      // Purple is deliberately DEAD stock (doc 04b round 3): the ask must
      // offer Green/Black only, and a Purple request gets an honest "stock
      // out" — never a size list recited blind.
      weeklyVelocity: [14, 15, 16, 17, 18, 18, 19, 18], tags: ["wellness"], variantNames: ["Green", "Purple", "Black"], variantStock: { Green: 7, Purple: 0, Black: 5 }, variantIds: { Green: "var-yogamat-green", Purple: "var-yogamat-purple", Black: "var-yogamat-black" }, createdAt: iso(220),
    },
    {
      id: "prod-vase", sku: "AUR-VSE-03", name: "Ceramic Vase Set (3pc)", category: "Home Decor",
      description: "Hand-glazed stoneware vases in sand, clay, and cream.",
      price: 7799, compareAtPrice: null, cost: 2880, stock: 80, reorderPoint: 15,
      supplierId: "sup-artisan", status: "active", rating: 4.2, reviewCount: 31,
      weeklyVelocity: [2, 1, 1, 0, 1, 0, 1, 0], tags: ["decor"], variantNames: [], createdAt: iso(190),
    },
    {
      id: "prod-candle-amber", sku: "AUR-CDL-01", name: "Amber & Oak Soy Candle", category: "Aromatherapy",
      description: "60-hour soy candle, amber, oakmoss, and vanilla.",
      price: 2999, compareAtPrice: null, cost: 744, stock: 140, reorderPoint: 40,
      supplierId: "sup-artisan", status: "active", rating: 4.8, reviewCount: 326,
      weeklyVelocity: [25, 24, 26, 28, 27, 29, 30, 31], tags: ["bestseller", "gift"], variantNames: [], createdAt: iso(300),
    },
    {
      id: "prod-candle-linen", sku: "AUR-CDL-02", name: "Fresh Linen Soy Candle", category: "Aromatherapy",
      description: "60-hour soy candle, line-dried linen and white tea.",
      price: 2999, compareAtPrice: null, cost: 744, stock: 95, reorderPoint: 40,
      supplierId: "sup-artisan", status: "active", rating: 4.7, reviewCount: 198,
      weeklyVelocity: [18, 19, 17, 20, 21, 20, 22, 21], tags: ["gift"], variantNames: [], createdAt: iso(300),
    },
    {
      id: "prod-diffuser", sku: "AUR-DIF-01", name: "CloudMist Aroma Diffuser", category: "Aromatherapy",
      description: "400ml ultrasonic diffuser with warm-light ring and auto-off.",
      price: 5399, compareAtPrice: 6599, cost: 1896, stock: 58, reorderPoint: 20,
      supplierId: "sup-shenzhen", status: "active", rating: 4.5, reviewCount: 167,
      weeklyVelocity: [12, 13, 15, 14, 16, 17, 18, 19], tags: ["bundle-friendly"], variantNames: [], createdAt: iso(180),
    },
    {
      id: "prod-throw", sku: "AUR-THR-01", name: "Belgian Linen Throw Blanket", category: "Bedding",
      description: "Stonewashed Belgian linen throw, 130×170cm, in oat.",
      price: 10799, compareAtPrice: null, cost: 3840, stock: 41, reorderPoint: 12,
      supplierId: "sup-nordic", status: "active", rating: 4.9, reviewCount: 88,
      weeklyVelocity: [6, 7, 8, 7, 9, 8, 10, 9], tags: ["premium"], variantNames: [], createdAt: iso(140),
    },
    {
      id: "prod-mug-set", sku: "AUR-MUG-04", name: "Stoneware Mug Set (4pc)", category: "Kitchen",
      description: "Reactive-glaze stoneware mugs, 350ml, dishwasher safe.",
      price: 4439, compareAtPrice: null, cost: 1488, stock: 66, reorderPoint: 20,
      supplierId: "sup-artisan", status: "active", rating: 4.6, reviewCount: 154,
      weeklyVelocity: [9, 10, 11, 10, 12, 11, 13, 12], tags: ["gift"], variantNames: [], createdAt: iso(260),
    },
    {
      id: "prod-bottle", sku: "AUR-BTL-01", name: "Insulated Steel Bottle 750ml", category: "Wellness",
      description: "Triple-wall vacuum bottle. 24h cold, 12h hot.",
      price: 3599, compareAtPrice: null, cost: 1092, stock: 104, reorderPoint: 30,
      supplierId: "sup-shenzhen", status: "active", rating: 4.4, reviewCount: 241,
      weeklyVelocity: [16, 15, 17, 18, 17, 19, 20, 21], tags: ["everyday"], variantNames: [], createdAt: iso(280),
    },
    {
      id: "prod-cutting-board", sku: "AUR-CTB-01", name: "Acacia Cutting Board", category: "Kitchen",
      description: "End-grain acacia board with juice groove, 40×30cm.",
      price: 6599, compareAtPrice: null, cost: 2340, stock: 37, reorderPoint: 10,
      supplierId: "sup-vista", status: "active", rating: 4.7, reviewCount: 76,
      weeklyVelocity: [5, 6, 6, 7, 7, 8, 8, 9], tags: ["kitchen"], variantNames: [], createdAt: iso(120),
    },
    {
      id: "prod-sheets", sku: "AUR-SHT-Q1", name: "Bamboo Sheet Set (Queen)", category: "Bedding",
      description: "300TC bamboo lyocell sheets — cool, soft, OEKO-TEX certified.",
      price: 14399, compareAtPrice: 16799, cost: 4920, stock: 29, reorderPoint: 10,
      supplierId: "sup-nordic", status: "active", rating: 4.8, reviewCount: 112,
      weeklyVelocity: [4, 5, 5, 6, 6, 7, 7, 8], tags: ["premium", "sleep"], variantNames: [], createdAt: iso(150),
    },
    {
      id: "prod-pillow", sku: "AUR-PLW-01", name: "Cloud Memory Pillow", category: "Bedding",
      description: "Shredded memory foam pillow with washable bamboo cover.",
      price: 5999, compareAtPrice: null, cost: 1956, stock: 73, reorderPoint: 20,
      supplierId: "sup-nordic", status: "active", rating: 4.5, reviewCount: 203,
      weeklyVelocity: [8, 9, 9, 10, 11, 10, 12, 11], tags: ["sleep"], variantNames: [], createdAt: iso(200),
    },
    {
      id: "prod-planter", sku: "AUR-PLT-01", name: "Ribbed Ceramic Planter", category: "Home Decor",
      description: "Ribbed matte planter with drainage and saucer, 18cm.",
      price: 3359, compareAtPrice: null, cost: 1068, stock: 88, reorderPoint: 25,
      supplierId: "sup-artisan", status: "active", rating: 4.6, reviewCount: 95,
      weeklyVelocity: [7, 7, 8, 8, 9, 9, 10, 10], tags: ["decor"], variantNames: [], createdAt: iso(170),
    },
    {
      id: "prod-tray", sku: "AUR-TRY-01", name: "Marble Serving Tray", category: "Home Decor",
      description: "Genuine marble tray with brass handles, 30cm.",
      price: 8999, compareAtPrice: null, cost: 3420, stock: 22, reorderPoint: 8,
      supplierId: "sup-vista", status: "active", rating: 4.3, reviewCount: 41,
      weeklyVelocity: [3, 4, 4, 5, 4, 5, 6, 5], tags: ["premium", "gift"], variantNames: [], createdAt: iso(110),
    },
    {
      id: "prod-teapot", sku: "AUR-TPT-01", name: "Glass Teapot with Infuser", category: "Kitchen",
      description: "Borosilicate 900ml teapot with removable steel infuser.",
      price: 5159, compareAtPrice: null, cost: 1704, stock: 49, reorderPoint: 15,
      supplierId: "sup-vista", status: "active", rating: 4.6, reviewCount: 129,
      weeklyVelocity: [6, 6, 7, 7, 8, 8, 9, 9], tags: ["kitchen", "gift"], variantNames: [], createdAt: iso(230),
    },
    {
      id: "prod-oilset", sku: "AUR-OIL-06", name: "Essential Oil Set (6×10ml)", category: "Aromatherapy",
      description: "Lavender, eucalyptus, sweet orange, peppermint, tea tree, cedarwood.",
      price: 4199, compareAtPrice: null, cost: 1272, stock: 121, reorderPoint: 35,
      supplierId: "sup-lotus", status: "active", rating: 4.5, reviewCount: 188,
      weeklyVelocity: [13, 14, 15, 16, 15, 17, 18, 19], tags: ["bundle-friendly"], variantNames: [], createdAt: iso(210),
    },
    {
      id: "prod-weighted", sku: "AUR-WBL-15", name: "Serenity Weighted Blanket 15lb", category: "Bedding",
      description: "Glass-bead weighted blanket with removable minky cover.",
      price: 11999, compareAtPrice: null, cost: 4560, stock: 32, reorderPoint: 8,
      supplierId: "sup-shenzhen", status: "active", rating: 4.7, reviewCount: 67,
      weeklyVelocity: [4, 4, 5, 5, 6, 6, 7, 7], tags: ["sleep", "premium"], variantNames: [], createdAt: iso(95),
    },
    {
      id: "prod-carafe", sku: "AUR-CRF-01", name: "Bedside Water Carafe Set", category: "Home Decor",
      description: "Mouth-blown glass carafe with tumbler lid.",
      price: 3959, compareAtPrice: null, cost: 3036, stock: 54, reorderPoint: 15,
      supplierId: "sup-vista", status: "active", rating: 4.1, reviewCount: 22,
      weeklyVelocity: [5, 5, 6, 6, 7, 7, 8, 8], tags: ["decor"], variantNames: [], createdAt: iso(75),
    },
    {
      id: "prod-runner", sku: "AUR-RUN-01", name: "Woven Cotton Table Runner", category: "Home Decor",
      description: "Handwoven cotton runner in terracotta stripe, 180cm.",
      price: 3239, compareAtPrice: null, cost: 936, stock: 61, reorderPoint: 15,
      supplierId: "sup-artisan", status: "active", rating: 4.4, reviewCount: 58,
      weeklyVelocity: [4, 5, 5, 5, 6, 6, 6, 7], tags: ["decor", "table"], variantNames: [], createdAt: iso(85),
    },
  ];

  const priceOf = new Map(products.map((p) => [p.id, p.price]));
  const nameOf = new Map(products.map((p) => [p.id, p.name]));
  const item = (productId: string, quantity: number): OrderItem => ({
    productId,
    productName: nameOf.get(productId) ?? productId,
    quantity,
    unitPrice: priceOf.get(productId) ?? 0,
  });

  // ---- Suppliers (5) -------------------------------------------------------

  const suppliers: Supplier[] = [
    {
      id: "sup-shenzhen", name: "Shenzhen HomeGoods Co.", country: "CN",
      reliabilityScore: 0.82, qualityScore: 0.88, currentDelayDays: 4,
      offers: [
        { productId: "prod-blender", unitCost: 2220, leadTimeDays: 15 },
        { productId: "prod-diffuser", unitCost: 1896, leadTimeDays: 18 },
        { productId: "prod-bottle", unitCost: 1092, leadTimeDays: 20 },
        { productId: "prod-weighted", unitCost: 4560, leadTimeDays: 25 },
      ],
      notes: "Best blender pricing. Port congestion has added ~4 days to open POs this month.",
    },
    {
      id: "sup-vista", name: "Vista Trading Ltd.", country: "VN",
      reliabilityScore: 0.91, qualityScore: 0.86, currentDelayDays: 0,
      offers: [
        { productId: "prod-yogamat", unitCost: 1104, leadTimeDays: 10 },
        { productId: "prod-blender", unitCost: 2328, leadTimeDays: 9 },
        { productId: "prod-cutting-board", unitCost: 2340, leadTimeDays: 18 },
        { productId: "prod-tray", unitCost: 3420, leadTimeDays: 21 },
        { productId: "prod-teapot", unitCost: 1704, leadTimeDays: 16 },
        { productId: "prod-carafe", unitCost: 3036, leadTimeDays: 14 },
      ],
      notes: "Fast, reliable. Slightly higher blender unit cost but 9-day lead time.",
    },
    {
      id: "sup-artisan", name: "Artisan Collective", country: "PT",
      reliabilityScore: 0.95, qualityScore: 0.97, currentDelayDays: 0,
      offers: [
        { productId: "prod-vase", unitCost: 2880, leadTimeDays: 12 },
        { productId: "prod-candle-amber", unitCost: 744, leadTimeDays: 9 },
        { productId: "prod-candle-linen", unitCost: 744, leadTimeDays: 9 },
        { productId: "prod-mug-set", unitCost: 1488, leadTimeDays: 11 },
        { productId: "prod-planter", unitCost: 1068, leadTimeDays: 13 },
        { productId: "prod-runner", unitCost: 936, leadTimeDays: 12 },
      ],
      notes: "Premium quality, EU-based. Owner's preferred supplier for ceramics.",
    },
    {
      id: "sup-nordic", name: "Nordic Textiles AB", country: "SE",
      reliabilityScore: 0.93, qualityScore: 0.94, currentDelayDays: 0,
      offers: [
        { productId: "prod-throw", unitCost: 3840, leadTimeDays: 14 },
        { productId: "prod-sheets", unitCost: 4920, leadTimeDays: 16 },
        { productId: "prod-pillow", unitCost: 1956, leadTimeDays: 12 },
      ],
      notes: "Certified textiles. Minimum order 50 units per SKU.",
    },
    {
      id: "sup-lotus", name: "Lotus Wellness Supply", country: "IN",
      reliabilityScore: 0.88, qualityScore: 0.9, currentDelayDays: 0,
      offers: [
        { productId: "prod-yogamat", unitCost: 1320, leadTimeDays: 12 },
        { productId: "prod-oilset", unitCost: 1272, leadTimeDays: 15 },
      ],
      notes: "Current yoga mat source. Vista quotes ৳1,104 for the same spec.",
    },
  ];

  // ---- Couriers (4) — a parcel history, not a rating card -------------------
  //
  // These rows are {@link courierRow}'s output: counts in, the route's own
  // arithmetic out. They used to be five invented fields (`costPerShipment`,
  // `onTimeRate: 0.79`, `regions`) that dakio-api has never emitted and, in
  // `onTimeRate`'s case, never can — the schema records no promised-delivery
  // date anywhere. The narrative is unchanged (SwiftShip is the bad courier);
  // what changed is that it is now told in the only currency the real route
  // has: parcels that resolved, and how.
  //
  // THE GRADIENT IS THE POINT. ZipParcel's RTO rate is 50% — the worst number
  // in the seed — over TWO resolved parcels, and no honest reader may report
  // it. It is here so the evidence floor is exercised offline, every run.

  const couriers: Courier[] = [
    // The bad courier: 31% RTO over 42 resolved parcels, and slow with it.
    courierRow({
      id: "cour-swift", name: "SwiftShip",
      delivered: 27, rto: 13, failed: 2, cancelled: 3, inFlight: 9, inFlightStagnant: 4,
      avgDaysToDeliver: 5.4, deliveryTimeSample: 25,
    }),
    // The good one, and the busiest — 4% RTO over 75.
    courierRow({
      id: "cour-meridian", name: "Meridian Express",
      delivered: 71, rto: 3, failed: 1, cancelled: 4, inFlight: 12, inFlightStagnant: 0,
      avgDaysToDeliver: 2.1, deliveryTimeSample: 68,
    }),
    // Ordinary: 11% RTO over 38 — real evidence, below every threshold.
    courierRow({
      id: "cour-atlas", name: "Atlas Post",
      delivered: 33, rto: 4, failed: 1, cancelled: 2, inFlight: 6, inFlightStagnant: 1,
      avgDaysToDeliver: 3.4, deliveryTimeSample: 30,
    }),
    // TOO FEW PARCELS TO JUDGE: 1 delivered, 1 returned. The rate is 50% and it
    // is not evidence of anything — `sufficientEvidence` is false and nothing
    // downstream may build a finding on it.
    courierRow({
      id: "cour-zip", name: "ZipParcel",
      delivered: 1, rto: 1, failed: 0, cancelled: 1, inFlight: 3, inFlightStagnant: 0,
      avgDaysToDeliver: 2.8, deliveryTimeSample: 1,
    }),
  ];
  /** Transit days for the order fixtures below — the mean this courier really posts. */
  const courierDays = new Map(couriers.map((c) => [c.id, c.avgDaysToDeliver ?? 3]));

  // ---- Customers (24) ------------------------------------------------------

  const mkCustomer = (
    n: number, name: string, segment: Customer["segment"], ordersCount: number,
    lifetimeValue: number, lastOrderDaysAgo: number | null, notes: string, createdDaysAgo: number,
  ): Customer => ({
    id: `cust-${n}`,
    name,
    email: `${name.toLowerCase().replace(/[^a-z ]/g, "").replace(/ /g, ".")}@example.com`,
    segment, ordersCount, lifetimeValue,
    lastOrderAt: lastOrderDaysAgo === null ? null : iso(lastOrderDaysAgo, 14),
    notes, createdAt: iso(createdDaysAgo),
  });

  const customers: Customer[] = [
    mkCustomer(101, "Amelia Chen", "vip", 14, 2340, 2, "Top VIP. Loves the bedding line; gifts candles quarterly.", 410),
    mkCustomer(102, "Priya Raman", "vip", 11, 1890, 5, "VIP. Wellness-focused basket; responds to early access.", 380),
    mkCustomer(103, "Jordan Whitfield", "vip", 9, 1655, 9, "VIP. Buys premium decor; price-insensitive.", 350),
    mkCustomer(104, "Sofia Marino", "vip", 8, 1480, 1, "VIP. Referred 4 customers; loves handwritten notes.", 290),
    mkCustomer(105, "Daniel Okafor", "vip", 8, 1310, 12, "VIP. Corporate gifting twice a year.", 320),
    mkCustomer(106, "Maya Lindqvist", "repeat", 6, 520, 3, "Tea & kitchen buyer.", 240),
    mkCustomer(107, "Tom Baxter", "repeat", 5, 610, 8, "Plants and planters.", 260),
    mkCustomer(108, "Grace Adeyemi", "repeat", 4, 470, 4, "Cozy-home basket; candle subscriber candidate.", 200),
    mkCustomer(109, "Lucas Ferreira", "repeat", 4, 455, 10, "Kitchen upgrades.", 180),
    mkCustomer(110, "Hannah Kim", "repeat", 3, 380, 6, "Sleep-focused purchases.", 160),
    mkCustomer(111, "Omar Haddad", "repeat", 3, 290, 15, "", 150),
    mkCustomer(112, "Elena Petrova", "repeat", 3, 340, 7, "", 190),
    mkCustomer(113, "Ben Carver", "repeat", 2, 210, 18, "", 130),
    mkCustomer(114, "Ines Rodrigues", "repeat", 2, 195, 21, "", 120),
    mkCustomer(115, "Charlie Nguyen", "repeat", 2, 175, 13, "", 110),
    mkCustomer(116, "Ava Thompson", "new", 0, 0, null, "Abandoned first cart (blender).", 2),
    mkCustomer(117, "Noah Williams", "new", 1, 59.98, 1, "", 6),
    mkCustomer(118, "Zoe Martin", "new", 1, 49.98, 3, "", 9),
    mkCustomer(119, "Leo Fischer", "new", 0, 0, null, "Signed up via candle giveaway.", 4),
    mkCustomer(120, "Ruby Santos", "new", 1, 64.99, 5, "", 12),
    mkCustomer(121, "Ethan Brooks", "new", 1, 79.98, 2, "", 8),
    mkCustomer(122, "Nora Vasquez", "at-risk", 5, 640, 61, "Was a regular; last order 2 months ago. Open refund ticket.", 300),
    mkCustomer(123, "Felix Wagner", "at-risk", 4, 410, 74, "Churn risk; last two orders were discounted.", 280),
    mkCustomer(124, "Isla MacLeod", "at-risk", 3, 355, 88, "No response to June winback.", 310),
  ];

  // ---- Orders (72, oldest first; ids ord-1001…) ---------------------------
  // Row: [daysAgo, custNo, items, status, courierId|null, region, discount$]

  type Row = [number, number, [string, number][], Order["status"], string | null, string, number];
  const rows: Row[] = [
    // Days 14-29 (26 orders)
    [29.4, 101, [["prod-sheets", 1], ["prod-pillow", 2]], "delivered", "cour-meridian", "west", 0],
    [28.7, 109, [["prod-cutting-board", 1]], "delivered", "cour-atlas", "midwest", 0],
    [27.9, 115, [["prod-candle-amber", 2]], "delivered", "cour-swift", "south", 0],
    [27.2, 106, [["prod-teapot", 1], ["prod-mug-set", 1]], "delivered", "cour-zip", "east", 0],
    [26.5, 122, [["prod-diffuser", 1], ["prod-oilset", 1]], "delivered", "cour-swift", "west", 0],
    [25.8, 103, [["prod-tray", 1], ["prod-vase", 1]], "delivered", "cour-meridian", "east", 0],
    [25.1, 111, [["prod-bottle", 2]], "rto", "cour-swift", "south", 0],
    [24.4, 108, [["prod-candle-linen", 2], ["prod-planter", 1]], "delivered", "cour-atlas", "east", 0],
    [23.8, 102, [["prod-yogamat", 1], ["prod-oilset", 1]], "delivered", "cour-meridian", "west", 0],
    [23.1, 117, [["prod-blender", 1]], "delivered", "cour-zip", "west", 0],
    [22.5, 107, [["prod-planter", 2]], "delivered", "cour-atlas", "midwest", 0],
    [21.8, 105, [["prod-throw", 1], ["prod-candle-amber", 2]], "delivered", "cour-meridian", "midwest", 0],
    [21.2, 113, [["prod-blender", 1]], "rto", "cour-swift", "west", 0],
    [20.6, 110, [["prod-weighted", 1]], "delivered", "cour-zip", "east", 0],
    [19.9, 124, [["prod-runner", 1], ["prod-candle-linen", 1]], "delivered", "cour-atlas", "south", 0],
    [19.2, 106, [["prod-bottle", 1], ["prod-oilset", 1]], "delivered", "cour-meridian", "east", 0],
    [18.6, 101, [["prod-candle-amber", 3]], "delivered", "cour-meridian", "west", 0],
    [17.9, 114, [["prod-mug-set", 1]], "refunded", "cour-atlas", "midwest", 0],
    [17.3, 109, [["prod-blender", 1], ["prod-bottle", 1]], "delivered", "cour-zip", "west", 0],
    [16.7, 112, [["prod-diffuser", 1]], "delivered", "cour-atlas", "east", 0],
    [16.1, 104, [["prod-sheets", 1]], "delivered", "cour-meridian", "west", 0],
    [15.5, 118, [["prod-candle-amber", 2]], "delivered", "cour-swift", "south", 0],
    [15.0, 121, [["prod-blender", 1], ["prod-bottle", 1]], "delivered", "cour-zip", "west", 0],
    [14.6, 107, [["prod-vase", 1]], "cancelled", null, "midwest", 0],
    [14.3, 102, [["prod-throw", 1]], "delivered", "cour-meridian", "west", 0],
    [14.0, 111, [["prod-teapot", 1]], "delivered", "cour-atlas", "south", 0],
    // Days 7-13 — prior week (22 orders)
    [13.6, 103, [["prod-weighted", 1], ["prod-candle-linen", 1]], "delivered", "cour-meridian", "east", 0],
    [13.2, 115, [["prod-planter", 1], ["prod-runner", 1]], "delivered", "cour-atlas", "south", 0],
    [12.8, 106, [["prod-blender", 1]], "delivered", "cour-zip", "east", 0],
    [12.4, 110, [["prod-pillow", 1], ["prod-candle-amber", 1]], "delivered", "cour-zip", "east", 0],
    [12.0, 120, [["prod-vase", 1]], "delivered", "cour-swift", "south", 0],
    [11.6, 101, [["prod-diffuser", 1], ["prod-oilset", 1]], "delivered", "cour-meridian", "west", 0],
    [11.2, 113, [["prod-mug-set", 1], ["prod-teapot", 1]], "delivered", "cour-atlas", "midwest", 0],
    [10.8, 105, [["prod-tray", 1]], "delivered", "cour-meridian", "midwest", 0],
    [10.4, 108, [["prod-yogamat", 1]], "delivered", "cour-atlas", "east", 0],
    [10.0, 112, [["prod-candle-amber", 2], ["prod-candle-linen", 1]], "delivered", "cour-atlas", "east", 0],
    [9.6, 107, [["prod-blender", 1], ["prod-oilset", 1]], "delivered", "cour-meridian", "midwest", 1200],
    [9.2, 116, [["prod-bottle", 1]], "cancelled", null, "west", 0],
    [8.9, 102, [["prod-sheets", 1], ["prod-pillow", 1]], "delivered", "cour-meridian", "west", 0],
    [8.5, 109, [["prod-cutting-board", 1], ["prod-runner", 1]], "delivered", "cour-atlas", "midwest", 0],
    [8.2, 123, [["prod-candle-linen", 2]], "rto", "cour-swift", "south", 0],
    [7.9, 111, [["prod-blender", 1]], "delivered", "cour-zip", "west", 0],
    [7.6, 104, [["prod-throw", 1], ["prod-carafe", 1]], "delivered", "cour-meridian", "west", 0],
    [7.4, 114, [["prod-oilset", 1]], "delivered", "cour-atlas", "east", 0],
    [7.2, 119, [["prod-candle-amber", 1]], "delivered", "cour-swift", "south", 0],
    [7.1, 106, [["prod-carafe", 1], ["prod-planter", 1]], "delivered", "cour-zip", "east", 0],
    [7.05, 110, [["prod-weighted", 1]], "delivered", "cour-zip", "east", 0],
    [7.02, 103, [["prod-mug-set", 2]], "delivered", "cour-meridian", "east", 0],
    // Days 0-6 — last week, ~8% up (24 orders)
    [6.8, 101, [["prod-throw", 1], ["prod-candle-amber", 2]], "delivered", "cour-meridian", "west", 0],
    [6.5, 108, [["prod-blender", 1], ["prod-bottle", 1]], "delivered", "cour-atlas", "east", 0],
    [6.1, 115, [["prod-teapot", 1]], "delivered", "cour-meridian", "south", 0],
    [5.8, 112, [["prod-pillow", 1]], "delivered", "cour-zip", "east", 0],
    [5.5, 107, [["prod-planter", 2], ["prod-runner", 1]], "delivered", "cour-meridian", "midwest", 0],
    [5.2, 122, [["prod-diffuser", 1]], "refund_requested", "cour-swift", "west", 0],
    [4.9, 106, [["prod-blender", 1], ["prod-oilset", 1]], "delivered", "cour-zip", "east", 0],
    [4.6, 102, [["prod-yogamat", 1], ["prod-bottle", 1]], "delivered", "cour-meridian", "west", 0],
    [4.2, 120, [["prod-candle-amber", 1], ["prod-candle-linen", 1]], "delivered", "cour-atlas", "south", 0],
    [3.9, 109, [["prod-blender", 1]], "delivered", "cour-zip", "west", 0],
    [3.6, 105, [["prod-sheets", 1], ["prod-carafe", 1]], "delivered", "cour-meridian", "midwest", 0],
    [3.3, 118, [["prod-oilset", 1]], "refund_requested", "cour-atlas", "east", 0],
    [3.0, 111, [["prod-mug-set", 1]], "delivered", "cour-meridian", "south", 0],
    [2.7, 104, [["prod-weighted", 1], ["prod-candle-linen", 1]], "delivered", "cour-meridian", "west", 0],
    [2.4, 113, [["prod-bottle", 2]], "fulfilled", "cour-zip", "west", 0],
    [2.1, 108, [["prod-vase", 1]], "fulfilled", "cour-atlas", "east", 0],
    [1.8, 106, [["prod-blender", 1], ["prod-candle-amber", 1]], "fulfilled", "cour-meridian", "east", 0],
    [1.5, 121, [["prod-yogamat", 1], ["prod-bottle", 1]], "fulfilled", "cour-zip", "west", 0],
    [1.2, 110, [["prod-throw", 1]], "fulfilled", "cour-meridian", "east", 0],
    [0.9, 101, [["prod-blender", 2]], "paid", null, "west", 0],
    [0.6, 117, [["prod-candle-amber", 2]], "paid", null, "west", 0],
    [0.4, 112, [["prod-diffuser", 1], ["prod-oilset", 1]], "paid", null, "east", 0],
    [0.2, 104, [["prod-pillow", 1]], "placed", null, "west", 0],
    [0.08, 107, [["prod-teapot", 1], ["prod-mug-set", 1]], "placed", null, "midwest", 0],
  ];

  const baseOrders: Order[] = rows.map(([daysAgo, custNo, its, status, courierId, region, discount], i) => {
    const items = its.map(([pid, q]) => item(pid, q));
    const subtotal = r2(items.reduce((s, it) => s + it.quantity * it.unitPrice, 0));
    const shipping = status === "cancelled" ? 0 : subtotal >= FREE_SHIPPING_OVER ? 0 : FLAT_DELIVERY;
    const placedMs = nowMs - daysAgo * DAY;
    const transitDays = courierId ? (courierDays.get(courierId) ?? 3) : 3;
    const hasArrived = ["delivered", "rto", "refunded", "refund_requested"].includes(status);
    return {
      id: `ord-${1001 + i}`,
      customerId: `cust-${custNo}`,
      items,
      subtotal,
      discount,
      shipping,
      total: r2(subtotal - discount + shipping),
      status,
      courierId,
      placedAt: new Date(placedMs).toISOString(),
      deliveredAt: hasArrived ? new Date(placedMs + transitDays * DAY).toISOString() : null,
      region,
    };
  });

  // Echo clones lift order volume to a realistic level for the ad spend in
  // the ledger, without duplicating the special-status narratives.
  const SPECIAL_STATUS = new Set<Order["status"]>(["rto", "refunded", "refund_requested", "cancelled"]);
  const echoOrders: Order[] = baseOrders
    .filter((o) => !SPECIAL_STATUS.has(o.status))
    .map((o, i) => ({
      ...o,
      id: `ord-${1101 + i}`,
      items: o.items.map((it) => ({ ...it })),
      placedAt: new Date(Date.parse(o.placedAt) - 3 * HOUR).toISOString(),
      deliveredAt: o.deliveredAt
        ? new Date(Date.parse(o.deliveredAt) - 3 * HOUR).toISOString()
        : null,
    }));
  const orders: Order[] = [...baseOrders, ...echoOrders];

  // ---- Abandoned carts (14: 9 none, 3 message_sent, 1 recovered, 1 lost) ---

  const cart = (
    n: number, custNo: number, its: [string, number][], hoursAbandoned: number,
    recoveryState: AbandonedCart["recoveryState"], recoveryMessage: string | null = null,
  ): AbandonedCart => {
    const items = its.map(([pid, q]) => item(pid, q));
    return {
      id: `cart-${String(n).padStart(2, "0")}`,
      customerId: `cust-${custNo}`,
      items,
      value: r2(items.reduce((s, it) => s + it.quantity * it.unitPrice, 0)),
      abandonedAt: hoursAgo(hoursAbandoned),
      recoveryState,
      recoveryMessage,
    };
  };

  const abandonedCarts: AbandonedCart[] = [
    cart(1, 116, [["prod-blender", 1]], 1.5, "none"),
    cart(2, 108, [["prod-throw", 1], ["prod-candle-amber", 1]], 3, "none"),
    cart(3, 101, [["prod-sheets", 1], ["prod-pillow", 1]], 5, "none"),
    cart(4, 119, [["prod-oilset", 1]], 8, "none"),
    cart(5, 111, [["prod-mug-set", 1], ["prod-teapot", 1]], 11, "none"),
    cart(6, 117, [["prod-bottle", 2]], 16, "none"),
    cart(7, 104, [["prod-weighted", 1], ["prod-candle-linen", 1]], 22, "none"),
    cart(8, 113, [["prod-diffuser", 1], ["prod-oilset", 1]], 30, "none"),
    cart(9, 122, [["prod-blender", 1], ["prod-bottle", 1]], 40, "none"),
    cart(10, 107, [["prod-planter", 3]], 26, "message_sent",
      "Hi Tom, your three ribbed planters are still set aside. They pair well with the terracotta runner you browsed. Your cart is saved whenever you are ready. — Nova at Aurora Living"),
    cart(11, 118, [["prod-candle-amber", 2]], 34, "message_sent",
      "Hi Zoe, the two Amber & Oak candles in your cart are our longest-burning batch yet. We will hold them for you. — Nova at Aurora Living"),
    cart(12, 109, [["prod-cutting-board", 1], ["prod-tray", 1]], 45, "message_sent",
      "Hi Lucas, your acacia board and marble tray are waiting. Both ship free together. — Nova at Aurora Living"),
    cart(13, 106, [["prod-teapot", 1]], 50, "recovered"),
    cart(14, 120, [["prod-vase", 1]], 70, "lost"),
  ];

  // ---- Campaigns (7) -------------------------------------------------------

  const stats = (rowsIn: [number, number, number, number, number][]): CampaignDayStat[] =>
    rowsIn.map(([spend, impressions, clicks, conversions, revenue], i) => ({
      date: day(rowsIn.length - 1 - i),
      spend, impressions, clicks, conversions, revenue,
    }));

  const campaigns: Campaign[] = [
    {
      id: "cmp-blender", name: "Blender Summer Push", channel: "meta", status: "active",
      dailyBudget: 5400, productIds: ["prod-blender"], startedAt: iso(21), notes:
        "Hero product prospecting. Budget caps out by early evening most days.",
      dailyStats: stats([
        [44.6, 30800, 552, 4, 148.97], [45.0, 31500, 566, 5, 192.46], [44.8, 30900, 561, 5, 171.47],
        [45.0, 32100, 578, 5, 185.96], [44.9, 31200, 570, 5, 178.46], [45.0, 31800, 574, 6, 214.95],
        [44.7, 30600, 549, 5, 171.47], [45.0, 31900, 575, 5, 192.46], [44.9, 31400, 568, 5, 178.46],
        [45.0, 32300, 581, 5, 185.96], [44.8, 31100, 563, 5, 171.47], [45.0, 32000, 577, 6, 199.96],
        [44.9, 31600, 571, 5, 185.96], [45.0, 31700, 573, 5, 178.46],
      ]),
    },
    {
      id: "cmp-eveglow", name: "Evening Glow Retargeting", channel: "meta", status: "active",
      dailyBudget: 4560, productIds: ["prod-candle-amber", "prod-candle-linen", "prod-diffuser"],
      startedAt: iso(30), notes: "Retargeting warm audiences with candle/diffuser bundles.",
      dailyStats: stats([
        [38.0, 21400, 372, 4, 118.96], [37.8, 21100, 368, 3, 94.97], [38.0, 21600, 375, 4, 109.96],
        [37.9, 21300, 371, 3, 99.96], [38.0, 21500, 374, 4, 118.96], [37.8, 21000, 366, 3, 94.97],
        [38.0, 21700, 377, 4, 104.96], [37.9, 21200, 369, 3, 99.96], [38.0, 21400, 372, 3, 84.97],
        [37.8, 21100, 367, 3, 94.97], [38.0, 21300, 370, 3, 89.97], [38.0, 20900, 341, 2, 59.98],
        [37.9, 20700, 335, 3, 74.97], [38.0, 20500, 328, 2, 49.98],
      ]),
    },
    {
      id: "cmp-google-brand", name: "Google Search — Brand + Category", channel: "google",
      status: "active", dailyBudget: 3360, productIds: ["prod-blender", "prod-sheets", "prod-candle-amber"],
      startedAt: iso(60), notes: "Always-on search coverage.",
      dailyStats: stats([
        [27.8, 4150, 208, 3, 73.97], [28.0, 4230, 212, 3, 76.97], [27.9, 4180, 209, 3, 71.97],
        [28.0, 4260, 214, 3, 79.97], [27.8, 4120, 206, 3, 73.97], [28.0, 4300, 216, 3, 76.97],
        [27.9, 4200, 210, 3, 71.97], [28.0, 4250, 213, 3, 79.97], [27.8, 4160, 207, 3, 73.97],
        [28.0, 4280, 215, 3, 76.97], [27.9, 4190, 209, 3, 71.97], [28.0, 4310, 217, 3, 79.97],
        [27.8, 4140, 206, 3, 73.97], [28.0, 4270, 214, 3, 76.97],
      ]),
    },
    {
      id: "cmp-email-july", name: "July Newsletter Flows", channel: "email", status: "active",
      dailyBudget: 720, productIds: ["prod-candle-amber", "prod-throw", "prod-oilset"],
      startedAt: iso(19), notes: "Weekly newsletter + welcome/post-purchase flows.",
      dailyStats: stats([
        [6.0, 7900, 296, 3, 62.97], [6.0, 8100, 305, 4, 84.96], [6.0, 8000, 301, 3, 65.97],
        [6.0, 8200, 309, 4, 79.96], [6.0, 7800, 292, 3, 62.97], [6.0, 8300, 312, 4, 84.96],
        [6.0, 8100, 304, 3, 65.97], [6.0, 8000, 300, 4, 79.96], [6.0, 8200, 308, 3, 62.97],
        [6.0, 7900, 295, 4, 84.96], [6.0, 8100, 303, 3, 65.97], [6.0, 8300, 311, 4, 79.96],
        [6.0, 8000, 299, 3, 62.97], [6.0, 8200, 307, 4, 84.96],
      ]),
    },
    {
      id: "cmp-sms-winback", name: "SMS Winback — Lapsed 60d", channel: "sms", status: "paused",
      dailyBudget: 1440, productIds: ["prod-candle-amber", "prod-bottle"], startedAt: iso(45),
      notes: "Paused after weak June performance; revisit copy before resuming.",
      dailyStats: stats([
        [12.0, 900, 41, 1, 24.99], [12.0, 880, 38, 0, 0], [12.0, 910, 40, 1, 29.99],
        [12.0, 890, 39, 0, 0], [12.0, 900, 40, 1, 24.99], [12.0, 870, 37, 0, 0],
        [12.0, 920, 42, 1, 24.99], [11.8, 860, 36, 0, 0], [12.0, 900, 39, 0, 0],
        [12.0, 880, 38, 1, 29.99], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0],
      ]),
    },
    {
      id: "cmp-tiktok-test", name: "TikTok Spark Test", channel: "tiktok", status: "completed",
      dailyBudget: 3000, productIds: ["prod-planter", "prod-mug-set"], startedAt: iso(50),
      notes: "Two-week creator test. CPA 2.4× Meta's — concluded not viable at current AOV.",
      dailyStats: stats([
        [25.0, 18200, 260, 1, 27.99], [25.0, 18500, 265, 1, 36.99], [25.0, 18100, 255, 0, 0],
        [25.0, 18700, 270, 1, 27.99], [25.0, 18300, 261, 1, 36.99], [25.0, 18000, 252, 0, 0],
        [25.0, 18600, 268, 1, 27.99], [25.0, 18400, 263, 1, 27.99], [25.0, 18200, 258, 0, 0],
        [25.0, 18800, 272, 1, 36.99], [25.0, 18100, 254, 1, 27.99], [25.0, 18500, 264, 0, 0],
        [25.0, 18300, 259, 1, 27.99], [25.0, 18600, 266, 1, 36.99],
      ]),
    },
    {
      id: "cmp-fall-preview", name: "Fall Collection Preview", channel: "meta", status: "scheduled",
      dailyBudget: 4800, productIds: ["prod-throw", "prod-weighted", "prod-candle-amber"],
      startedAt: inDays(14), notes: "Launches mid-August: cozy positioning, new creative set.",
      dailyStats: [],
    },
  ];

  // ---- Social posts, discounts --------------------------------------------

  const socialPosts: SocialPost[] = [
    {
      id: "post-01", platform: "instagram", format: "reel",
      caption: "Morning smoothie, zero cleanup. The Portable Blender Pro rinses itself in 30 seconds.",
      productIds: ["prod-blender"], status: "published", scheduledFor: null, publishedAt: hoursAgo(2),
    },
    {
      id: "post-02", platform: "facebook", format: "post",
      caption: "Sunday reset: Amber & Oak burning, linen throw out, phone away.",
      productIds: ["prod-candle-amber", "prod-throw"], status: "published",
      scheduledFor: null, publishedAt: iso(1, 15),
    },
    {
      id: "post-03", platform: "instagram", format: "story",
      caption: "48 hours left on diffuser bundle pricing — tap to build yours.",
      productIds: ["prod-diffuser", "prod-oilset"], status: "published",
      scheduledFor: null, publishedAt: iso(2, 10),
    },
    {
      id: "post-04", platform: "tiktok", format: "reel",
      caption: "POV: your 3pm slump meets a 10-second smoothie.",
      productIds: ["prod-blender"], status: "scheduled", scheduledFor: inDays(1, 14), publishedAt: null,
    },
    {
      id: "post-05", platform: "instagram", format: "post",
      caption: "A first look at fall: heavier linens, deeper ambers. Preview coming soon.",
      productIds: ["prod-throw", "prod-weighted"], status: "draft", scheduledFor: null, publishedAt: null,
    },
  ];

  const discounts: Discount[] = [
    {
      id: "disc-01", code: "VIP10", percentOff: 10, scope: "order", productIds: [],
      customerId: null, expiresAt: inDays(30), active: true, createdAt: iso(20),
    },
    {
      id: "disc-02", code: "WELCOME15", percentOff: 15, scope: "order", productIds: [],
      customerId: null, expiresAt: inDays(60), active: true, createdAt: iso(45),
    },
    {
      id: "disc-03", code: "SPRING20", percentOff: 20, scope: "order", productIds: [],
      customerId: null, expiresAt: iso(40), active: false, createdAt: iso(100),
    },
  ];

  // ---- Support tickets (12) ------------------------------------------------

  const supportTickets: SupportTicket[] = [
    {
      id: "tick-01", customerId: "cust-122", orderId: "ord-1054", subject: "Refund request — diffuser arrived cracked",
      category: "refund", status: "open", openedAt: hoursAgo(14),
      messages: [
        { from: "customer", text: "My CloudMist diffuser arrived with a crack in the tank. I want a refund.", at: hoursAgo(14) },
      ],
    },
    {
      id: "tick-02", customerId: "cust-113", orderId: "ord-1063", subject: "Where is my order?",
      category: "order_tracking", status: "open", openedAt: hoursAgo(3),
      messages: [
        { from: "customer", text: "Ordered two bottles three days ago and tracking hasn't moved.", at: hoursAgo(3) },
      ],
    },
    {
      id: "tick-03", customerId: "cust-119", orderId: null, subject: "Are the essential oils safe around cats?",
      category: "product_question", status: "open", openedAt: hoursAgo(1),
      messages: [
        { from: "customer", text: "I have two cats — is the eucalyptus oil in the set safe to diffuse around them?", at: hoursAgo(1) },
      ],
    },
    {
      id: "tick-04", customerId: "cust-103", orderId: "ord-1006", subject: "Vase arrived chipped — replacement pending",
      category: "complaint", status: "escalated", openedAt: iso(2, 9),
      messages: [
        { from: "customer", text: "One of the three vases has a chip on the rim.", at: iso(2, 9) },
        { from: "nova", text: "I am sorry about that. I have started a replacement and asked our ceramics partner to review packaging on this batch. You will get tracking within 48 hours.", at: iso(2, 10) },
        { from: "customer", text: "It has been two days and no tracking yet.", at: hoursAgo(8) },
      ],
    },
    {
      id: "tick-05", customerId: "cust-108", orderId: "ord-1064", subject: "Change shipping address",
      category: "other", status: "waiting_on_customer", openedAt: iso(1, 11),
      messages: [
        { from: "customer", text: "Can I change the delivery address on my vase order?", at: iso(1, 11) },
        { from: "nova", text: "Yes — reply with the new address before it ships tonight and I will update it.", at: iso(1, 11, 30) },
      ],
    },
    {
      id: "tick-06", customerId: "cust-110", orderId: "ord-1014", subject: "Weighted blanket wash instructions",
      category: "product_question", status: "resolved", openedAt: iso(3, 14),
      messages: [
        { from: "customer", text: "Can the weighted blanket cover go in the dryer?", at: iso(3, 14) },
        { from: "nova", text: "The minky cover is dryer-safe on low. The weighted insert should be air-dried flat.", at: iso(3, 14, 20) },
      ],
    },
    {
      id: "tick-07", customerId: "cust-111", orderId: "ord-1007", subject: "Bottle order returned to sender?",
      category: "order_tracking", status: "resolved", openedAt: iso(20, 10),
      messages: [
        { from: "customer", text: "Tracking says my bottles went back to you?", at: iso(20, 10) },
        { from: "nova", text: "SwiftShip failed the delivery twice and returned it. I have reshipped with Meridian Express at no charge — new tracking attached.", at: iso(20, 11) },
      ],
    },
    {
      id: "tick-08", customerId: "cust-114", orderId: "ord-1018", subject: "Mug set refund",
      category: "refund", status: "resolved", openedAt: iso(16, 9),
      messages: [
        { from: "customer", text: "Two mugs arrived cracked. I would like a refund.", at: iso(16, 9) },
        { from: "nova", text: "Refund issued in full — you should see it in 3-5 business days. No need to return the set.", at: iso(16, 9, 40) },
      ],
    },
    {
      id: "tick-09", customerId: "cust-106", orderId: "ord-1029", subject: "Blender warranty length",
      category: "product_question", status: "resolved", openedAt: iso(9, 16),
      messages: [
        { from: "customer", text: "How long is the blender warranty?", at: iso(9, 16) },
        { from: "nova", text: "12 months, and we replace rather than repair. Register with your order number to activate.", at: iso(9, 16, 15) },
      ],
    },
    {
      id: "tick-10", customerId: "cust-102", orderId: "ord-1039", subject: "Sheets — deeper pocket option?",
      category: "product_question", status: "resolved", openedAt: iso(6, 13),
      messages: [
        { from: "customer", text: "Do the bamboo sheets fit a 16-inch mattress?", at: iso(6, 13) },
        { from: "nova", text: "Yes — the queen set fits up to 16 inches with elastic all the way around.", at: iso(6, 13, 25) },
      ],
    },
    {
      id: "tick-11", customerId: "cust-121", orderId: "ord-1066", subject: "Gift wrap available?",
      category: "other", status: "resolved", openedAt: iso(1, 17),
      messages: [
        { from: "customer", text: "Can my order be gift wrapped?", at: iso(1, 17) },
        { from: "nova", text: "We include a plain kraft gift wrap free on request — I have added it to your order.", at: iso(1, 17, 10) },
      ],
    },
    {
      id: "tick-12", customerId: "cust-123", orderId: "ord-1041", subject: "Candles arrived after RTO reship",
      category: "order_tracking", status: "resolved", openedAt: iso(5, 12),
      messages: [
        { from: "customer", text: "Finally got the candles after the courier mess. All good now.", at: iso(5, 12) },
        { from: "nova", text: "Glad they arrived. The failed first attempt was on us — a 10% code for your next order is on your account.", at: iso(5, 12, 30) },
      ],
    },
  ];

  // ---- Customer messages (10) ----------------------------------------------

  const customerMessages: CustomerMessage[] = [
    {
      id: "msg-01", customerId: "cust-107", channel: "email", purpose: "cart_recovery",
      subject: "Your planters are set aside", body: abandonedCarts[9].recoveryMessage ?? "",
      relatedId: "cart-10", sentAt: hoursAgo(25),
    },
    {
      id: "msg-02", customerId: "cust-118", channel: "email", purpose: "cart_recovery",
      subject: "Two candles, still yours", body: abandonedCarts[10].recoveryMessage ?? "",
      relatedId: "cart-11", sentAt: hoursAgo(33),
    },
    {
      id: "msg-03", customerId: "cust-109", channel: "email", purpose: "cart_recovery",
      subject: "Your kitchen upgrade is waiting", body: abandonedCarts[11].recoveryMessage ?? "",
      relatedId: "cart-12", sentAt: hoursAgo(44),
    },
    {
      id: "msg-04", customerId: "cust-110", channel: "email", purpose: "support_reply",
      subject: "Re: Weighted blanket wash instructions",
      body: "The minky cover is dryer-safe on low. The weighted insert should be air-dried flat. — Nova at Aurora Living",
      relatedId: "tick-06", sentAt: iso(3, 14, 20),
    },
    {
      id: "msg-05", customerId: "cust-114", channel: "email", purpose: "support_reply",
      subject: "Your refund is on its way",
      body: "Refund issued in full — you should see it in 3-5 business days. No need to return the set. — Nova at Aurora Living",
      relatedId: "tick-08", sentAt: iso(16, 9, 40),
    },
    {
      id: "msg-06", customerId: "cust-106", channel: "chat", purpose: "support_reply", subject: null,
      body: "12 months, and we replace rather than repair. Register with your order number to activate.",
      relatedId: "tick-09", sentAt: iso(9, 16, 15),
    },
    {
      id: "msg-07", customerId: "cust-101", channel: "email", purpose: "order_update",
      subject: "Your order is on the way",
      body: "Your sheets and pillows shipped with Meridian Express — arriving in about 2 days. — Nova at Aurora Living",
      relatedId: "ord-1001", sentAt: iso(29, 10),
    },
    {
      id: "msg-08", customerId: "cust-113", channel: "email", purpose: "order_update",
      subject: "Your bottles have shipped",
      body: "Your two insulated bottles are with ZipParcel — tracking inside. — Nova at Aurora Living",
      relatedId: "ord-1063", sentAt: iso(2, 9),
    },
    {
      id: "msg-09", customerId: "cust-124", channel: "email", purpose: "winback",
      subject: "It has been a while, Isla",
      body: "We have added new pieces to the collection since your last visit — and your favorites are back in stock. — Nova at Aurora Living",
      relatedId: null, sentAt: iso(30, 9),
    },
    {
      id: "msg-10", customerId: "cust-121", channel: "email", purpose: "sales_reply",
      subject: "Re: Gift wrap",
      body: "Gift wrap added to your order at no charge — it ships tonight. — Nova at Aurora Living",
      relatedId: "ord-1066", sentAt: iso(1, 17, 10),
    },
  ];

  // ---- Purchase orders, expenses ------------------------------------------

  const purchaseOrders: PurchaseOrder[] = [
    {
      id: "po-7001", supplierId: "sup-shenzhen", productId: "prod-blender", quantity: 200,
      unitCost: 2220, total: 444000, status: "in_transit", createdAt: iso(12), expectedAt: inDays(2),
    },
    {
      id: "po-7002", supplierId: "sup-artisan", productId: "prod-candle-amber", quantity: 300,
      unitCost: 744, total: 223200, status: "received", createdAt: iso(20), expectedAt: iso(9),
    },
  ];

  const expenses: ExpenseEntry[] = [];
  let expId = 0;
  for (let d = 30; d >= 1; d--) {
    expenses.push({
      id: `exp-${++expId}`, date: day(d), category: "ads",
      amount: r2(13320 + ((d * 7) % 13) * 120), note: "Meta / Google / email ad spend",
    });
    expenses.push({
      id: `exp-${++expId}`, date: day(d), category: "shipping",
      amount: r2(2640 + ((d * 11) % 17) * 120), note: "Courier invoices",
    });
    expenses.push({
      id: `exp-${++expId}`, date: day(d), category: "fees",
      amount: r2(1560 + ((d * 5) % 11) * 120), note: "Payment processing",
    });
  }
  expenses.push({ id: `exp-${++expId}`, date: day(18), category: "software", amount: 26400, note: "Dakio + Klaviyo + Canva subscriptions" });
  expenses.push({ id: `exp-${++expId}`, date: day(16), category: "refunds", amount: 5153, note: "Mug set refund (ord-1018)" });
  expenses.push({ id: `exp-${++expId}`, date: day(9), category: "other", amount: 18000, note: "Product photography — fall preview" });
  expenses.push({ id: `exp-${++expId}`, date: day(24), category: "other", amount: 10200, note: "Packaging samples" });

  // ---- Trending products (10) ----------------------------------------------

  const trendingProducts: TrendingProduct[] = [
    {
      id: "trend-01", name: "Collapsible Water Bottle 2.0", category: "Wellness",
      demandScore: 87, competitionScore: 41, estimatedUnitCost: 816, suggestedPrice: 2999,
      estimatedMarginPct: 72.8, source: "TikTok #WaterTok",
      insight: "Search volume up 3x in 60 days; few branded players. Fits our wellness line and ships flat.",
    },
    {
      id: "trend-02", name: "Sunset Projection Lamp", category: "Home Decor",
      demandScore: 82, competitionScore: 58, estimatedUnitCost: 888, suggestedPrice: 3599,
      estimatedMarginPct: 75.3, source: "TikTok trends",
      insight: "Strong impulse buy; crowded but our audience overlap (cozy-home) is high.",
    },
    {
      id: "trend-03", name: "Electric Spice Grinder", category: "Kitchen",
      demandScore: 76, competitionScore: 49, estimatedUnitCost: 1092, suggestedPrice: 4199,
      estimatedMarginPct: 74.0, source: "Google Trends",
      insight: "Steady riser; pairs naturally with our kitchen line for bundles.",
    },
    {
      id: "trend-04", name: "Linen Table Runner Set", category: "Home Decor",
      demandScore: 71, competitionScore: 32, estimatedUnitCost: 1344, suggestedPrice: 5399,
      estimatedMarginPct: 75.1, source: "Pinterest rising",
      insight: "Low competition; extends our existing runner into a premium set.",
    },
    {
      id: "trend-05", name: "Cold Brew Carafe", category: "Kitchen",
      demandScore: 79, competitionScore: 55, estimatedUnitCost: 1296, suggestedPrice: 4799,
      estimatedMarginPct: 73.0, source: "Google Trends",
      insight: "Summer seasonal spike; complements the teapot buyer profile.",
    },
    {
      id: "trend-06", name: "Acupressure Mat & Pillow", category: "Wellness",
      demandScore: 74, competitionScore: 61, estimatedUnitCost: 1500, suggestedPrice: 5999,
      estimatedMarginPct: 75.0, source: "Amazon movers",
      insight: "Proven category; differentiation would come from our calmer branding.",
    },
    {
      id: "trend-07", name: "Ceramic Ring Trays", category: "Home Decor",
      demandScore: 66, competitionScore: 28, estimatedUnitCost: 468, suggestedPrice: 2039,
      estimatedMarginPct: 77.0, source: "Etsy trending",
      insight: "Cheap add-on item to lift AOV; Artisan Collective could produce.",
    },
    {
      id: "trend-08", name: "Smart Herb Garden", category: "Kitchen",
      demandScore: 81, competitionScore: 67, estimatedUnitCost: 2940, suggestedPrice: 9599,
      estimatedMarginPct: 69.4, source: "TikTok trends",
      insight: "High interest but dominated by two brands; risky without a unique angle.",
    },
    {
      id: "trend-09", name: "Wool Dryer Balls (6pk)", category: "Wellness",
      demandScore: 63, competitionScore: 35, estimatedUnitCost: 504, suggestedPrice: 2399,
      estimatedMarginPct: 79.0, source: "Google Trends",
      insight: "Evergreen eco item; low risk, modest ceiling.",
    },
    {
      id: "trend-10", name: "Stone Diffuser Mini", category: "Aromatherapy",
      demandScore: 77, competitionScore: 44, estimatedUnitCost: 1392, suggestedPrice: 4799,
      estimatedMarginPct: 71.0, source: "Pinterest rising",
      insight: "Natural upsell for our oil-set buyers; premium look at mid price.",
    },
  ];

  // ---- Nova agent data ------------------------------------------------------

  const memory: MemoryEntry[] = [
    {
      namespace: "brand", key: "voice",
      value: "Warm, unhurried, quietly premium. No exclamation marks or emojis in customer messages. Sign as 'Nova at Aurora Living'.",
      updatedAt: iso(60),
    },
    {
      namespace: "goals", key: "revenue-target",
      value: "Reach ৳60,00,000/month revenue by Q4 2026 with net margin at or above 30%.",
      updatedAt: iso(45),
    },
    {
      namespace: "preferences", key: "discount-style",
      value: "Owner prefers targeted, single-customer discounts over sitewide sales.",
      updatedAt: iso(30),
    },
    {
      namespace: "preferences", key: "vip-shipping",
      value: "VIP customers always get free expedited shipping (Meridian Express).",
      updatedAt: iso(30),
    },
    {
      namespace: "rules", key: "max-discount",
      value: "Never discount above 20%. Standard recovery offer is 10%, and only for carts over ৳9,600.",
      updatedAt: iso(30),
    },
    {
      namespace: "experiments", key: "june-flash-sale",
      value: "June 2026 flash sale: 15% sitewide lifted revenue 22% but net margin fell to 19% — owner called it a mistake. Do not repeat sitewide sales.",
      updatedAt: iso(35),
    },
    {
      namespace: "insights", key: "blender-repeat-rate",
      value: "Portable Blender buyers repeat-purchase at 31% within 60 days — bundle and post-purchase flow opportunity.",
      updatedAt: iso(14),
    },
    {
      namespace: "customers", key: "amelia-chen",
      value: "Amelia Chen (cust-101) is our top VIP — priority support, prefers email, never needs discounts to convert.",
      updatedAt: iso(21),
    },
  ];

  const activity: ActivityEntry[] = [
    {
      id: "act-101", at: hoursAgo(6), department: "ceo", kind: "report",
      title: "Filed tonight's night plan",
      detail: "Deep analysis complete: campaign scan, inventory forecast, and tomorrow's focus prepared.",
      minutesSaved: 45, revenueInfluence: 0, actionId: null,
    },
    {
      id: "act-102", at: hoursAgo(6.5), department: "inventory", kind: "analysis",
      title: "Overnight inventory forecast",
      detail: "Yoga mat at 4.6 days of cover vs 12-day lead; blender at 6.6 days vs 19-day effective lead (supplier delayed 4d).",
      minutesSaved: 30, revenueInfluence: 0, actionId: null,
    },
    {
      id: "act-103", at: hoursAgo(7), department: "marketing", kind: "analysis",
      title: "Nightly campaign scan",
      detail: "Evening Glow CPA up ~43% over 3 days (৳1,344 → ৳1,920). Blender Push holding ROAS 3.8 — scale case prepared.",
      minutesSaved: 30, revenueInfluence: 0, actionId: null,
    },
    {
      id: "act-104", at: hoursAgo(8), department: "support", kind: "communication",
      title: "Replied to Jordan Whitfield (escalated vase claim)",
      detail: "Chased ceramics partner for replacement tracking; customer updated.",
      minutesSaved: 12, revenueInfluence: 0, actionId: null,
    },
    {
      id: "act-105", at: hoursAgo(9.5), department: "support", kind: "communication",
      title: "Answered wash-care question",
      detail: "Weighted blanket care instructions sent to Hannah Kim.",
      minutesSaved: 8, revenueInfluence: 0, actionId: null,
    },
    {
      id: "act-106", at: hoursAgo(21), department: "support", kind: "communication",
      title: "Confirmed gift wrap for Ethan Brooks",
      detail: "Added kraft gift wrap to ord-1066 at no charge.",
      minutesSaved: 8, revenueInfluence: 0, actionId: null,
    },
    {
      id: "act-107", at: hoursAgo(2), department: "marketing", kind: "action",
      title: "Published Instagram reel — blender self-clean demo",
      detail: "Post-01 live at 6am store time; first-hour saves tracking above account average.",
      minutesSaved: 35, revenueInfluence: 0, actionId: null,
    },
    {
      id: "act-108", at: hoursAgo(23), department: "sales", kind: "communication",
      title: "Sent 3 cart recovery emails (৳31,680 at stake)",
      detail: "Personalized notes to Tom Baxter, Zoe Martin, and Lucas Ferreira; no discounts needed per standing rules.",
      minutesSaved: 24, revenueInfluence: 7920, actionId: null,
    },
    {
      id: "act-109", at: hoursAgo(12), department: "shipping", kind: "analysis",
      title: "Reviewed SwiftShip performance",
      detail: "79% on-time, 11% RTO trailing rate (3 RTOs in the last 30 days). Recommending region-by-region migration to Meridian/Atlas.",
      minutesSaved: 20, revenueInfluence: 0, actionId: null,
    },
    {
      id: "act-110", at: hoursAgo(10), department: "finance", kind: "alert",
      title: "Margin watch: carafe set",
      detail: "Bedside Water Carafe margin is 23.3% — below the 25% floor. Flagged for repricing or supplier renegotiation.",
      minutesSaved: 5, revenueInfluence: 0, actionId: null,
    },
  ];

  // E-8 fields shared by seeded prepared actions (Stage 0 shape).
  const seedActionDefaults = {
    actor: "nova" as const, targetRef: null, agentId: null, dutyRef: null,
    undoDeadline: null, undoneAt: null,
  };
  const actions: ActionRecord[] = [
    {
      id: "action-8001", type: "update_campaign", department: "marketing",
      title: 'Scale "Blender Summer Push" daily budget ৳5,400 → ৳7,560',
      payload: { campaignId: "cmp-blender", dailyBudget: 7560 },
      justification: {
        reason: "7-day ROAS is 3.8 with CPA steady at ~৳1,080 across 14 days, and the campaign exhausts its budget by early evening daily — demand is being left unserved.",
        expectedImpact: "+12–18% daily profit over the next 7 days (~৳5,400–8,400/day gross revenue added at current efficiency).",
        confidence: 0.86,
      },
      receipt: {
        reason: "7-day ROAS is 3.8 with CPA steady at ~৳1,080 across 14 days, and the campaign exhausts its budget by early evening daily — demand is being left unserved.",
        expectedImpact: "+12–18% daily profit over the next 7 days (~৳5,400–8,400/day gross revenue added at current efficiency).",
        confidence: 0.86,
        evidence: [
          { source: "campaign cmp-blender", note: "ROAS 3.8, CPA ~৳1,080, budget exhausted by early evening", metric: "roas7d", value: 3.8, window: "7d" },
        ],
        before: null, after: null,
      },
      riskClass: "medium", status: "prepared", outcome: null, undoable: false, undoData: null,
      ...seedActionDefaults,
      createdAt: hoursAgo(7), decidedAt: null, executedAt: null,
    },
    {
      id: "action-8002", type: "create_purchase_order", department: "inventory",
      title: "Reorder 300 EcoFlex Yoga Mats from Vista Trading",
      payload: { supplierId: "sup-vista", productId: "prod-yogamat", quantity: 300, unitCost: 1104 },
      justification: {
        reason: "Stock covers ~4.6 days at current velocity vs a 12-day lead time — stockout is otherwise certain. Vista offers ৳1,104/unit vs Lotus ৳1,320 with a faster 10-day lead.",
        expectedImpact: "Avoids an estimated ৳2,52,000 in lost sales and saves ৳64,800 vs the current supplier on this order.",
        confidence: 0.78,
      },
      receipt: {
        reason: "Stock covers ~4.6 days at current velocity vs a 12-day lead time — stockout is otherwise certain. Vista offers ৳1,104/unit vs Lotus ৳1,320 with a faster 10-day lead.",
        expectedImpact: "Avoids an estimated ৳2,52,000 in lost sales and saves ৳64,800 vs the current supplier on this order.",
        confidence: 0.78,
        evidence: [
          { source: "inventory prod-yogamat", note: "4.6 days cover vs 12-day lead time", metric: "days_cover", value: 4.6 },
          { source: "supplier sup-vista", note: "৳1,104/unit vs Lotus ৳1,320, 10-day lead" },
        ],
        before: null, after: null,
      },
      riskClass: "high", status: "prepared", outcome: null, undoable: false, undoData: null,
      ...seedActionDefaults,
      createdAt: hoursAgo(6.5), decidedAt: null, executedAt: null,
    },
  ];

  const reports: NovaReport[] = [
    {
      id: "rpt-901", kind: "morning", title: `Morning report — ${day(1)}`,
      body: [
        "Good morning. While you were away…",
        "",
        "**The numbers**: Revenue ৳73,440 yesterday (+6% vs 7-day average) · 9 orders · est. profit ৳23,760.",
        "",
        "**Completed overnight**: replied to 3 customers, published the Sunday reset post, prepared the weekly inventory forecast.",
        "",
        "**Watchlist**: Evening Glow CPA creeping up; SwiftShip missed two delivery promises this week.",
        "",
        "**Today's focus**: finalize the Blender scale case — the campaign keeps hitting its budget cap before 7pm.",
      ].join("\n"),
      createdAt: iso(1, 8),
    },
    {
      id: "rpt-902", kind: "night_plan", title: `Night operations — ${day(0)}`,
      body: [
        "Deep work completed tonight:",
        "",
        "1. Campaign scan: Evening Glow CPA +43% over 3 days — pause case ready. Blender Push scale action prepared (action-8001, awaiting approval).",
        "2. Inventory: yoga mat reorder prepared (action-8002, awaiting approval — over the ৳3,00,000 auto-cap). Blender restock already in transit but 4 days delayed.",
        "3. Content: tomorrow's TikTok reel scheduled for 2pm.",
        "",
        "Tomorrow's focus: get the two prepared actions decided — both are time-sensitive.",
      ].join("\n"),
      createdAt: hoursAgo(6),
    },
  ];

  return {
    products,
    trendingProducts,
    customers,
    orders,
    abandonedCarts,
    campaigns,
    socialPosts,
    discounts,
    supportTickets,
    customerMessages,
    suppliers,
    purchaseOrders,
    couriers,
    expenses,
    autonomy: { level: 2, guardrails: DEFAULT_GUARDRAILS, updatedAt: iso(30) },
    memory,
    activity,
    actions,
    reports,
  };
}
