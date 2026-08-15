/**
 * Demo dataset for "Beacon Supply Co" — a B2B industrial & janitorial supply
 * store on Dakio. The second seeded tenant.
 *
 * Deliberately unlike Aurora Living in every dimension the context engine
 * surfaces: different vertical (wholesale to facilities buyers, not DTC),
 * different voice (direct/spec-driven, not warm/premium), different goals
 * (reorder rate & AOV, not brand), different autonomy (level 3 — this owner
 * trusts Nova to run low-risk actions), and — critically — a completely
 * disjoint set of ids (`b…` prefixes) so the isolation suite can prove that
 * not one Aurora record ever appears in a Beacon tool result or vice versa.
 *
 * Same deterministic-from-`nowMs` construction as `seed.ts`: no RNG, so the
 * store always boots into the same coherent business day.
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
import type { Guardrails } from "./types.js";
import { courierRow } from "./seed.js";

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** Beacon's owner runs at a higher autonomy with tighter margin discipline. */
const BEACON_GUARDRAILS: Guardrails = {
  maxDiscountPct: 12,
  maxPriceChangePct: 10,
  maxBudgetChangePct: 40,
  minMarginPct: 18,
  maxAutoPurchaseOrderTotal: 720_000,
  maxAutoRefundTotal: 30_000,
};

export function createBeaconSeed(nowMs: number): StoreSeed {
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
   * Freight, in ৳. Unlike Aurora's flat home-delivery fee, B2B freight really
   * does scale with order value (pallets, LTL), so these convert straight
   * across at the same rate as the rest of the seed and the shipping-to-
   * subtotal ratio is preserved exactly.
   */
  const FREE_FREIGHT_OVER = 30000;
  const FLAT_FREIGHT = 2940;

  // ---- Products (10) — bulk industrial/janitorial ---------------------------

  const products: Product[] = [
    {
      id: "bprod-gloves", sku: "BCN-GLV-100", name: "Nitrile Gloves (Case/1000)", category: "Safety",
      description: "5-mil powder-free nitrile exam gloves, blue, case of 1000.",
      price: 10680, compareAtPrice: null, cost: 6240, stock: 640, reorderPoint: 200,
      supplierId: "bsup-guardian", status: "active", rating: 4.6, reviewCount: 84,
      weeklyVelocity: [55, 60, 58, 62, 66, 70, 72, 75], tags: ["ppe", "bestseller"], variantNames: [], createdAt: iso(300),
    },
    {
      id: "bprod-degreaser", sku: "BCN-DEG-05", name: "Industrial Degreaser (5 gal)", category: "Cleaning Chemicals",
      description: "Concentrated citrus degreaser, 5-gallon pail, dilutes 1:20.",
      price: 8940, compareAtPrice: null, cost: 4608, stock: 118, reorderPoint: 60,
      supplierId: "bsup-chemworks", status: "active", rating: 4.5, reviewCount: 51,
      weeklyVelocity: [18, 19, 20, 21, 22, 23, 24, 25], tags: ["chemical"], variantNames: [], createdAt: iso(260),
    },
    {
      id: "bprod-towel", sku: "BCN-TWL-CS", name: "Centerpull Paper Towels (Case/6)", category: "Paper",
      description: "2-ply centerpull hardwound towels, 600 ft/roll, 6 rolls per case.",
      price: 5040, compareAtPrice: null, cost: 2976, stock: 30, reorderPoint: 80,
      supplierId: "bsup-northmill", status: "active", rating: 4.4, reviewCount: 132,
      weeklyVelocity: [40, 42, 44, 45, 47, 48, 50, 52], tags: ["paper", "bestseller"], variantNames: [], createdAt: iso(280),
    },
    {
      id: "bprod-liner", sku: "BCN-LNR-45", name: "Trash Can Liners 45gal (Case/100)", category: "Waste",
      description: "1.5-mil low-density can liners, 45 gallon, 100 per case.",
      price: 4668, compareAtPrice: null, cost: 2592, stock: 210, reorderPoint: 90,
      supplierId: "bsup-northmill", status: "active", rating: 4.3, reviewCount: 77,
      weeklyVelocity: [28, 29, 30, 31, 32, 33, 34, 35], tags: ["waste"], variantNames: [], createdAt: iso(240),
    },
    {
      id: "bprod-mop", sku: "BCN-MOP-24", name: "Microfiber Mop System (24 in)", category: "Equipment",
      description: "Aluminum frame flat mop with 3 microfiber pads.",
      price: 6480, compareAtPrice: 7680, cost: 2700, stock: 96, reorderPoint: 25,
      supplierId: "bsup-guardian", status: "active", rating: 4.7, reviewCount: 39,
      weeklyVelocity: [7, 8, 8, 9, 9, 10, 10, 11], tags: ["equipment"], variantNames: [], createdAt: iso(150),
    },
    {
      id: "bprod-sanitizer", sku: "BCN-SAN-1G", name: "Hand Sanitizer Gel (4×1 gal)", category: "Cleaning Chemicals",
      description: "70% ethyl alcohol gel, 1-gallon pump bottles, 4 per case.",
      price: 7560, compareAtPrice: null, cost: 6600, stock: 340, reorderPoint: 40,
      supplierId: "bsup-chemworks", status: "active", rating: 4.1, reviewCount: 44,
      weeklyVelocity: [3, 3, 2, 2, 2, 1, 1, 1], tags: ["chemical", "overstock"], variantNames: [], createdAt: iso(200),
    },
    {
      id: "bprod-tissue", sku: "BCN-TIS-CS", name: "2-Ply Toilet Tissue (Case/96)", category: "Paper",
      description: "Standard roll 2-ply bath tissue, 500 sheets, 96 rolls per case.",
      price: 6960, compareAtPrice: null, cost: 3984, stock: 145, reorderPoint: 70,
      supplierId: "bsup-northmill", status: "active", rating: 4.5, reviewCount: 96,
      weeklyVelocity: [24, 25, 26, 27, 28, 29, 30, 31], tags: ["paper"], variantNames: [], createdAt: iso(270),
    },
    {
      id: "bprod-disinfectant", sku: "BCN-DIS-CS", name: "Disinfectant Wipes (Case/12)", category: "Cleaning Chemicals",
      description: "EPA-registered disinfecting wipes, 160-count canisters, 12 per case.",
      price: 8160, compareAtPrice: null, cost: 4920, stock: 88, reorderPoint: 50,
      supplierId: "bsup-chemworks", status: "active", rating: 4.6, reviewCount: 61,
      weeklyVelocity: [15, 16, 17, 18, 19, 20, 21, 22], tags: ["chemical"], variantNames: [], createdAt: iso(190),
    },
    {
      id: "bprod-broom", sku: "BCN-BRM-36", name: "Push Broom 36 in (Case/6)", category: "Equipment",
      description: "Heavy-duty coarse/fine push broom head with handle, 6 per case.",
      price: 11520, compareAtPrice: null, cost: 5280, stock: 62, reorderPoint: 15,
      supplierId: "bsup-guardian", status: "active", rating: 4.4, reviewCount: 28,
      weeklyVelocity: [4, 4, 5, 5, 5, 6, 6, 6], tags: ["equipment"], variantNames: [], createdAt: iso(160),
    },
    {
      id: "bprod-floorpad", sku: "BCN-PAD-20", name: 'Floor Buffing Pads 20" (Case/5)', category: "Equipment",
      description: "Red spray-buff floor pads, 20 inch, 5 per case.",
      price: 4080, compareAtPrice: null, cost: 1920, stock: 54, reorderPoint: 20,
      supplierId: "bsup-guardian", status: "active", rating: 4.2, reviewCount: 19,
      weeklyVelocity: [6, 6, 7, 7, 8, 8, 9, 9], tags: ["equipment"], variantNames: [], createdAt: iso(140),
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

  // ---- Suppliers (3) --------------------------------------------------------

  const suppliers: Supplier[] = [
    {
      id: "bsup-guardian", name: "Guardian Industrial", country: "US",
      reliabilityScore: 0.94, qualityScore: 0.92, currentDelayDays: 0,
      offers: [
        { productId: "bprod-gloves", unitCost: 6240, leadTimeDays: 7 },
        { productId: "bprod-mop", unitCost: 2700, leadTimeDays: 9 },
        { productId: "bprod-broom", unitCost: 5280, leadTimeDays: 9 },
        { productId: "bprod-floorpad", unitCost: 1920, leadTimeDays: 8 },
      ],
      notes: "Primary PPE and equipment supplier. Domestic, fast, reliable.",
    },
    {
      id: "bsup-chemworks", name: "ChemWorks Distribution", country: "US",
      reliabilityScore: 0.86, qualityScore: 0.9, currentDelayDays: 3,
      offers: [
        { productId: "bprod-degreaser", unitCost: 4608, leadTimeDays: 12 },
        { productId: "bprod-sanitizer", unitCost: 6600, leadTimeDays: 10 },
        { productId: "bprod-disinfectant", unitCost: 4920, leadTimeDays: 11 },
      ],
      notes: "Chemical line. Freight-class shipping running 3 days behind this month.",
    },
    {
      id: "bsup-northmill", name: "Northmill Paper Co.", country: "CA",
      reliabilityScore: 0.9, qualityScore: 0.88, currentDelayDays: 0,
      offers: [
        { productId: "bprod-towel", unitCost: 2976, leadTimeDays: 6 },
        { productId: "bprod-liner", unitCost: 2592, leadTimeDays: 8 },
        { productId: "bprod-tissue", unitCost: 3984, leadTimeDays: 7 },
      ],
      notes: "Paper goods. Minimum order 40 cases.",
    },
  ];

  // ---- Couriers (3) — freight/LTL, as a parcel history ----------------------
  //
  // Deliberately UNLIKE Aurora's, the way everything else in this seed is: a
  // B2B freight book is low-volume and low-RTO (a facilities buyer does not
  // refuse a pallet at the door), so nothing here crosses the pulse's RTO
  // threshold and the store's courier domain is quiet — which is itself worth
  // having a fixture for. `courierRow` is imported from Aurora's seed rather
  // than re-typed: one arithmetic for what a rate means, two demo stores.
  //
  // MetroVan is the thin-evidence row here: 4 resolved parcels, so its numbers
  // are an observation and never a verdict.

  const couriers: Courier[] = [
    courierRow({
      id: "bcour-ridgeline", name: "Ridgeline Freight",
      delivered: 44, rto: 1, failed: 1, cancelled: 2, inFlight: 7, inFlightStagnant: 0,
      avgDaysToDeliver: 3.1, deliveryTimeSample: 41,
    }),
    courierRow({
      id: "bcour-haulpro", name: "HaulPro LTL",
      delivered: 26, rto: 2, failed: 1, cancelled: 1, inFlight: 5, inFlightStagnant: 1,
      avgDaysToDeliver: 4.6, deliveryTimeSample: 24,
    }),
    courierRow({
      id: "bcour-metrovan", name: "MetroVan Same-Day",
      delivered: 4, rto: 0, failed: 0, cancelled: 0, inFlight: 2, inFlightStagnant: 0,
      avgDaysToDeliver: 1.2, deliveryTimeSample: 4,
    }),
  ];
  const courierDays = new Map(couriers.map((c) => [c.id, c.avgDaysToDeliver ?? 3]));

  // ---- Customers (8) — facilities & businesses ------------------------------

  const mkCustomer = (
    n: number, name: string, segment: Customer["segment"], ordersCount: number,
    lifetimeValue: number, lastOrderDaysAgo: number | null, notes: string, createdDaysAgo: number,
  ): Customer => ({
    id: `bcust-${n}`,
    name,
    email: `orders@${name.toLowerCase().replace(/[^a-z ]/g, "").replace(/ /g, "")}.example.com`,
    segment, ordersCount, lifetimeValue,
    lastOrderAt: lastOrderDaysAgo === null ? null : iso(lastOrderDaysAgo, 15),
    notes, createdAt: iso(createdDaysAgo),
  });

  const customers: Customer[] = [
    mkCustomer(201, "Summit Facilities Mgmt", "vip", 42, 18600, 2, "Largest account — 6 buildings. Net-30 terms, standing monthly reorder.", 600),
    mkCustomer(202, "Cedar Ridge Schools", "vip", 31, 12400, 4, "District contract. Prefers scheduled quarterly bulk deliveries.", 520),
    mkCustomer(203, "Harbor Point Hotels", "vip", 27, 9900, 6, "Hospitality — paper and chemicals heavy. Sensitive to stockouts.", 480),
    mkCustomer(204, "Ironline Manufacturing", "repeat", 15, 5400, 9, "Plant floor PPE and degreaser. Buys in pallet quantities.", 300),
    mkCustomer(205, "Brightway Clinics", "repeat", 12, 3820, 5, "Medical — gloves and sanitizer. Compliance-driven.", 260),
    mkCustomer(206, "Oakfield Gym Group", "repeat", 8, 2100, 14, "Wipes and towels. Price-shops the paper line.", 210),
    mkCustomer(207, "Delta Property Svcs", "new", 1, 214, 3, "First order last week — janitorial starter set.", 8),
    mkCustomer(208, "Riverside Diner Co", "at-risk", 6, 1450, 58, "Was monthly; no order in ~2 months. Open pricing complaint.", 240),
  ];

  // ---- Orders --------------------------------------------------------------
  // Row: [daysAgo, custNo, items, status, courierId|null, region, discount$]

  type Row = [number, number, [string, number][], Order["status"], string | null, string, number];
  const rows: Row[] = [
    // Prior weeks
    [26, 201, [["bprod-gloves", 4], ["bprod-towel", 6]], "delivered", "bcour-ridgeline", "northeast", 2400],
    [24, 203, [["bprod-tissue", 5], ["bprod-liner", 4]], "delivered", "bcour-ridgeline", "northeast", 0],
    [22, 204, [["bprod-degreaser", 8], ["bprod-gloves", 3]], "delivered", "bcour-haulpro", "midwest", 0],
    [20, 202, [["bprod-towel", 10], ["bprod-tissue", 6]], "delivered", "bcour-ridgeline", "midwest", 3600],
    [18, 205, [["bprod-gloves", 6], ["bprod-disinfectant", 3]], "delivered", "bcour-metrovan", "northeast", 0],
    [16, 206, [["bprod-towel", 4]], "rto", "bcour-haulpro", "west", 0],
    [15, 201, [["bprod-liner", 6], ["bprod-degreaser", 3]], "delivered", "bcour-ridgeline", "northeast", 0],
    [13, 203, [["bprod-disinfectant", 4], ["bprod-tissue", 4]], "delivered", "bcour-ridgeline", "southeast", 0],
    [12, 208, [["bprod-towel", 3]], "refund_requested", "bcour-haulpro", "midwest", 0],
    [11, 204, [["bprod-mop", 2], ["bprod-floorpad", 3]], "delivered", "bcour-haulpro", "midwest", 0],
    [10, 202, [["bprod-tissue", 8]], "delivered", "bcour-ridgeline", "midwest", 0],
    [9, 205, [["bprod-gloves", 5]], "delivered", "bcour-metrovan", "northeast", 0],
    [8, 201, [["bprod-degreaser", 6], ["bprod-broom", 2]], "delivered", "bcour-ridgeline", "northeast", 0],
    [7, 207, [["bprod-liner", 2], ["bprod-towel", 2]], "delivered", "bcour-haulpro", "southeast", 0],
    // Last week
    [6, 203, [["bprod-tissue", 6], ["bprod-disinfectant", 3]], "delivered", "bcour-ridgeline", "southeast", 0],
    [5, 204, [["bprod-gloves", 8]], "delivered", "bcour-haulpro", "midwest", 4800],
    [4.5, 201, [["bprod-towel", 12], ["bprod-liner", 8]], "delivered", "bcour-ridgeline", "northeast", 0],
    [4, 206, [["bprod-disinfectant", 2]], "delivered", "bcour-haulpro", "west", 0],
    [3, 202, [["bprod-tissue", 5], ["bprod-towel", 5]], "fulfilled", "bcour-ridgeline", "midwest", 0],
    [2.5, 205, [["bprod-gloves", 4], ["bprod-mop", 1]], "fulfilled", "bcour-metrovan", "northeast", 0],
    [1.8, 203, [["bprod-liner", 5]], "fulfilled", "bcour-ridgeline", "southeast", 0],
    [1.2, 201, [["bprod-degreaser", 5]], "paid", null, "northeast", 0],
    [0.6, 204, [["bprod-gloves", 6], ["bprod-broom", 1]], "paid", null, "midwest", 0],
    [0.2, 202, [["bprod-tissue", 4]], "placed", null, "midwest", 0],
  ];

  const orders: Order[] = rows.map(([daysAgo, custNo, its, status, courierId, region, discount], i) => {
    const items = its.map(([pid, q]) => item(pid, q));
    const subtotal = r2(items.reduce((s, it) => s + it.quantity * it.unitPrice, 0));
    const shipping = status === "cancelled" ? 0 : subtotal >= FREE_FREIGHT_OVER ? 0 : FLAT_FREIGHT;
    const placedMs = nowMs - daysAgo * DAY;
    const transitDays = courierId ? (courierDays.get(courierId) ?? 3) : 3;
    const hasArrived = ["delivered", "rto", "refunded", "refund_requested"].includes(status);
    return {
      id: `bord-${5001 + i}`,
      customerId: `bcust-${custNo}`,
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

  // ---- Abandoned carts (3) --------------------------------------------------

  const cart = (
    n: number, custNo: number, its: [string, number][], hoursAbandoned: number,
    recoveryState: AbandonedCart["recoveryState"], recoveryMessage: string | null = null,
  ): AbandonedCart => {
    const items = its.map(([pid, q]) => item(pid, q));
    return {
      id: `bcart-${String(n).padStart(2, "0")}`,
      customerId: `bcust-${custNo}`,
      items,
      value: r2(items.reduce((s, it) => s + it.quantity * it.unitPrice, 0)),
      abandonedAt: hoursAgo(hoursAbandoned),
      recoveryState,
      recoveryMessage,
    };
  };

  const abandonedCarts: AbandonedCart[] = [
    cart(1, 208, [["bprod-towel", 6], ["bprod-tissue", 4]], 20, "none"),
    cart(2, 206, [["bprod-disinfectant", 3]], 34, "none"),
    cart(3, 207, [["bprod-gloves", 2], ["bprod-liner", 2]], 52, "message_sent",
      "Hi Delta Property Services — your reorder of nitrile gloves and can liners is saved. Freight ships same-day on orders placed before 2pm ET. — Nova, Beacon Supply Co"),
  ];

  // ---- Campaigns (3) — B2B channels -----------------------------------------

  const stats = (rowsIn: [number, number, number, number, number][]): CampaignDayStat[] =>
    rowsIn.map(([spend, impressions, clicks, conversions, revenue], i) => ({
      date: day(rowsIn.length - 1 - i),
      spend, impressions, clicks, conversions, revenue,
    }));

  const campaigns: Campaign[] = [
    {
      id: "bcmp-search", name: "Google Search — Janitorial Supply", channel: "google", status: "active",
      dailyBudget: 7200, productIds: ["bprod-gloves", "bprod-towel", "bprod-liner"], startedAt: iso(70),
      notes: "High-intent bottom-funnel search for facilities buyers.",
      dailyStats: stats([
        [59, 3200, 176, 4, 356], [60, 3300, 181, 5, 402], [58, 3150, 173, 4, 331],
        [60, 3400, 187, 5, 428], [59, 3250, 178, 4, 356], [60, 3380, 185, 5, 402],
        [58, 3120, 171, 4, 331], [60, 3410, 188, 6, 486], [59, 3260, 179, 5, 402],
        [60, 3350, 184, 5, 428], [58, 3130, 172, 4, 331], [60, 3420, 189, 5, 402],
        [59, 3270, 180, 5, 428], [60, 3390, 186, 6, 486],
      ]),
    },
    {
      id: "bcmp-lin", name: "LinkedIn — Facilities Managers", channel: "meta", status: "active",
      dailyBudget: 5280, productIds: ["bprod-mop", "bprod-broom", "bprod-degreaser"], startedAt: iso(40),
      notes: "Account-based prospecting to multi-site facilities managers (run via the meta adapter).",
      dailyStats: stats([
        [44, 8200, 96, 1, 74], [44, 8100, 94, 1, 96], [44, 8300, 98, 0, 0],
        [44, 8000, 92, 1, 74], [44, 8250, 97, 1, 96], [44, 8150, 95, 0, 0],
        [44, 8050, 93, 1, 74], [44, 8280, 98, 0, 0], [44, 8120, 94, 1, 96],
        [44, 8190, 96, 0, 0], [44, 8210, 97, 0, 0], [44, 7900, 88, 0, 0],
        [44, 7850, 85, 0, 0], [44, 7800, 82, 0, 0],
      ]),
    },
    {
      id: "bcmp-email", name: "Reorder Reminder Flow", channel: "email", status: "active",
      dailyBudget: 600, productIds: ["bprod-gloves", "bprod-tissue", "bprod-towel"], startedAt: iso(25),
      notes: "Automated net-30 reorder reminders keyed to each account's cycle.",
      dailyStats: stats([
        [5, 2100, 210, 6, 540], [5, 2150, 215, 7, 602], [5, 2050, 205, 6, 486],
        [5, 2200, 220, 7, 588], [5, 2080, 208, 6, 540], [5, 2180, 218, 7, 602],
        [5, 2020, 202, 6, 486], [5, 2210, 221, 8, 664], [5, 2090, 209, 6, 540],
        [5, 2160, 216, 7, 588], [5, 2040, 204, 6, 486], [5, 2230, 223, 7, 602],
        [5, 2100, 210, 7, 588], [5, 2170, 217, 8, 664],
      ]),
    },
  ];

  const socialPosts: SocialPost[] = [
    {
      id: "bpost-01", platform: "facebook", format: "post",
      caption: "Restocking for Q3? Case pricing on nitrile gloves and centerpull towels ships freight same-day. Ask about net-30 terms.",
      productIds: ["bprod-gloves", "bprod-towel"], status: "published", scheduledFor: null, publishedAt: hoursAgo(20),
    },
  ];

  const discounts: Discount[] = [
    {
      id: "bdisc-01", code: "NET30VOL", percentOff: 8, scope: "order", productIds: [],
      customerId: null, expiresAt: inDays(45), active: true, createdAt: iso(30),
    },
    {
      id: "bdisc-02", code: "FIRSTPALLET", percentOff: 10, scope: "order", productIds: [],
      customerId: null, expiresAt: inDays(90), active: true, createdAt: iso(15),
    },
  ];

  // ---- Support tickets (3) --------------------------------------------------

  const supportTickets: SupportTicket[] = [
    {
      id: "btick-01", customerId: "bcust-208", orderId: "bord-5009", subject: "Overcharged on last towel order?",
      category: "complaint", status: "open", openedAt: hoursAgo(16),
      messages: [
        { from: "customer", text: "Our last case of towels billed higher than the quoted contract price. Please review.", at: hoursAgo(16) },
      ],
    },
    {
      id: "btick-02", customerId: "bcust-203", orderId: "bord-5015", subject: "Need delivery before Friday",
      category: "order_tracking", status: "open", openedAt: hoursAgo(4),
      messages: [
        { from: "customer", text: "Hotel is fully booked this weekend — can the tissue order land before Friday?", at: hoursAgo(4) },
      ],
    },
    {
      id: "btick-03", customerId: "bcust-204", orderId: "bord-5016", subject: "SDS sheet for degreaser",
      category: "product_question", status: "resolved", openedAt: iso(5, 13),
      messages: [
        { from: "customer", text: "Our safety officer needs the current SDS for the citrus degreaser.", at: iso(5, 13) },
        { from: "nova", text: "Attached the current SDS (rev. 2026-04). It's also linked on the product page under Documents. — Nova, Beacon Supply Co", at: iso(5, 13, 20) },
      ],
    },
  ];

  const customerMessages: CustomerMessage[] = [
    {
      id: "bmsg-01", customerId: "bcust-207", channel: "email", purpose: "cart_recovery",
      subject: "Your janitorial reorder is saved", body: abandonedCarts[2].recoveryMessage ?? "",
      relatedId: "bcart-03", sentAt: hoursAgo(50),
    },
    {
      id: "bmsg-02", customerId: "bcust-204", channel: "email", purpose: "support_reply",
      subject: "Re: SDS sheet for degreaser",
      body: "Attached the current SDS (rev. 2026-04). It's also linked on the product page under Documents. — Nova, Beacon Supply Co",
      relatedId: "btick-03", sentAt: iso(5, 13, 20),
    },
  ];

  // ---- Purchase orders, expenses -------------------------------------------

  const purchaseOrders: PurchaseOrder[] = [
    {
      id: "bpo-9001", supplierId: "bsup-northmill", productId: "bprod-towel", quantity: 120,
      unitCost: 2976, total: 357120, status: "in_transit", createdAt: iso(6), expectedAt: inDays(1),
    },
    {
      id: "bpo-9002", supplierId: "bsup-guardian", productId: "bprod-gloves", quantity: 200,
      unitCost: 6240, total: 1248000, status: "received", createdAt: iso(18), expectedAt: iso(11),
    },
  ];

  const expenses: ExpenseEntry[] = [];
  let expId = 0;
  for (let d = 30; d >= 1; d--) {
    expenses.push({ id: `bexp-${++expId}`, date: day(d), category: "ads", amount: r2(12600 + ((d * 9) % 15) * 120), note: "Google / LinkedIn / email spend" });
    expenses.push({ id: `bexp-${++expId}`, date: day(d), category: "shipping", amount: r2(7200 + ((d * 13) % 25) * 120), note: "Freight/LTL invoices" });
    expenses.push({ id: `bexp-${++expId}`, date: day(d), category: "fees", amount: r2(2160 + ((d * 5) % 12) * 120), note: "Payment + net-30 factoring fees" });
  }
  expenses.push({ id: `bexp-${++expId}`, date: day(14), category: "software", amount: 31200, note: "Dakio + QuickBooks + freight portal" });
  expenses.push({ id: `bexp-${++expId}`, date: day(9), category: "refunds", amount: 5040, note: "Towel billing adjustment (bord-5009 pending)" });

  // ---- Trending products (4) ------------------------------------------------

  const trendingProducts: TrendingProduct[] = [
    {
      id: "btrend-01", name: "Foaming Hand Soap (4×1 gal)", category: "Cleaning Chemicals",
      demandScore: 80, competitionScore: 46, estimatedUnitCost: 2520, suggestedPrice: 5399,
      estimatedMarginPct: 53.3, source: "Distributor demand index",
      insight: "Recurring consumable; natural attach to existing sanitizer accounts.",
    },
    {
      id: "btrend-02", name: "Wet Floor Sign (6pk)", category: "Safety",
      demandScore: 68, competitionScore: 30, estimatedUnitCost: 1320, suggestedPrice: 3359,
      estimatedMarginPct: 60.7, source: "Search trends",
      insight: "Low competition compliance item; lifts AOV on janitorial baskets.",
    },
    {
      id: "btrend-03", name: "HEPA Vacuum Bags (Case/50)", category: "Equipment",
      demandScore: 72, competitionScore: 52, estimatedUnitCost: 3960, suggestedPrice: 8399,
      estimatedMarginPct: 52.9, source: "Reorder analytics",
      insight: "High repeat rate; pairs with the equipment buyers already on file.",
    },
    {
      id: "btrend-04", name: "Microfiber Cloths (Case/144)", category: "Paper",
      demandScore: 75, competitionScore: 58, estimatedUnitCost: 3360, suggestedPrice: 7199,
      estimatedMarginPct: 53.3, source: "Search trends",
      insight: "Crowded but steady; competitive at case volume for our hospitality accounts.",
    },
  ];

  // ---- Nova agent data — distinct voice, goals, rules -----------------------

  const memory: MemoryEntry[] = [
    {
      namespace: "brand", key: "voice",
      value: "Direct, efficient, spec-driven. Lead with price, availability, and lead time. No fluff. Sign as 'Nova, Beacon Supply Co'.",
      updatedAt: iso(50),
    },
    {
      namespace: "goals", key: "reorder-target",
      value: "Grow monthly reorder rate to 65% of active accounts and lift average order value above ৳60,000 by Q4 2026.",
      updatedAt: iso(40),
    },
    {
      namespace: "preferences", key: "terms",
      value: "VIP accounts (Summit, Cedar Ridge, Harbor Point) are net-30. Never surprise a contract account with a price change without a heads-up.",
      updatedAt: iso(35),
    },
    {
      namespace: "rules", key: "freight-cutoff",
      value: "Same-day freight only for orders placed before 2pm ET. Free freight at ৳30,000 order value; below that, flat ৳2,940.",
      updatedAt: iso(35),
    },
    {
      namespace: "rules", key: "max-discount",
      value: "Never discount above 12%. Volume code NET30VOL (8%) is the standard lever; FIRSTPALLET (10%) is for new accounts only.",
      updatedAt: iso(30),
    },
    {
      namespace: "customers", key: "summit-facilities",
      value: "Summit Facilities Mgmt (bcust-201) is the flagship account — 6 buildings, standing monthly reorder. Protect fill rate above all.",
      updatedAt: iso(21),
    },
  ];

  const activity: ActivityEntry[] = [
    {
      id: "bact-101", at: hoursAgo(6), department: "inventory", kind: "analysis",
      title: "Overnight stock check — paper line",
      detail: "Centerpull towels at 30 cases vs 80 reorder point and 52/wk velocity — below cover. Northmill PO in transit, ETA tomorrow.",
      minutesSaved: 30, revenueInfluence: 0, actionId: null,
    },
    {
      id: "bact-102", at: hoursAgo(7), department: "finance", kind: "alert",
      title: "Margin watch — hand sanitizer",
      detail: "Sanitizer gel margin is 12.7% at ৳7,560 on ৳6,600 cost, below the 18% floor, and velocity has collapsed to ~1/wk. Overstock clearance candidate.",
      minutesSaved: 5, revenueInfluence: 0, actionId: null,
    },
    {
      id: "bact-103", at: hoursAgo(9), department: "marketing", kind: "analysis",
      title: "Campaign scan",
      detail: "LinkedIn (via meta adapter) ROAS under 1 across 14 days — prospecting not converting at current AOV. Search + reorder email carrying growth.",
      minutesSaved: 30, revenueInfluence: 0, actionId: null,
    },
    {
      id: "bact-104", at: hoursAgo(22), department: "sales", kind: "communication",
      title: "Reorder nudge — Riverside Diner",
      detail: "At-risk account, 58 days since last order. Sent a reorder reminder with the standard NET30VOL code.",
      minutesSaved: 8, revenueInfluence: 13920, actionId: null,
    },
  ];

  const seedActionDefaults = {
    actor: "nova" as const, targetRef: null, agentId: null, dutyRef: null,
    undoDeadline: null, undoneAt: null,
  };
  const actions: ActionRecord[] = [
    {
      id: "baction-9101", type: "create_purchase_order", department: "inventory",
      title: "Reorder 160 cases Centerpull Towels from Northmill",
      payload: { supplierId: "bsup-northmill", productId: "bprod-towel", quantity: 160, unitCost: 2976 },
      justification: {
        reason: "Towels are 30 cases against an 80 reorder point and 52 cases/week velocity — under two weeks of cover even with the in-transit PO. Northmill lead time is 6 days.",
        expectedImpact: "Keeps Summit and Cedar Ridge fill rate at 100% through the reorder cycle; avoids ~৳2,16,000 in bumped orders.",
        confidence: 0.82,
      },
      receipt: {
        reason: "Towels are 30 cases against an 80 reorder point and 52 cases/week velocity — under two weeks of cover even with the in-transit PO. Northmill lead time is 6 days.",
        expectedImpact: "Keeps Summit and Cedar Ridge fill rate at 100% through the reorder cycle; avoids ~৳2,16,000 in bumped orders.",
        confidence: 0.82,
        evidence: [
          { source: "inventory bprod-towel", note: "30 cases vs 80 reorder point, 52/week velocity", metric: "stock", value: 30 },
          { source: "supplier bsup-northmill", note: "6-day lead time" },
        ],
        before: null, after: null,
      },
      riskClass: "high", status: "prepared", outcome: null, undoable: false, undoData: null,
      ...seedActionDefaults,
      createdAt: hoursAgo(6), decidedAt: null, executedAt: null,
    },
    {
      id: "baction-9102", type: "update_campaign", department: "marketing",
      title: 'Pause "LinkedIn — Facilities Managers"',
      payload: { campaignId: "bcmp-lin", status: "paused" },
      justification: {
        reason: "14-day ROAS is under 1.0 (spend ৳5,280/day, thin conversions) while search and the reorder flow return 6×+. Prospecting isn't converting at current AOV.",
        expectedImpact: "Frees ~৳5,280/day to shift into the converting search campaign; no downside to reorder revenue.",
        confidence: 0.8,
      },
      receipt: {
        reason: "14-day ROAS is under 1.0 (spend ৳5,280/day, thin conversions) while search and the reorder flow return 6×+. Prospecting isn't converting at current AOV.",
        expectedImpact: "Frees ~৳5,280/day to shift into the converting search campaign; no downside to reorder revenue.",
        confidence: 0.8,
        evidence: [
          { source: "campaign bcmp-lin", note: "ROAS <1.0 at ৳5,280/day over 14d", metric: "roas14d", window: "14d" },
        ],
        before: null, after: null,
      },
      riskClass: "medium", status: "prepared", outcome: null, undoable: false, undoData: null,
      ...seedActionDefaults,
      createdAt: hoursAgo(9), decidedAt: null, executedAt: null,
    },
  ];

  const reports: NovaReport[] = [
    {
      id: "brpt-901", kind: "morning", title: `Morning report — ${day(1)}`,
      body: [
        "Beacon Supply — overnight summary.",
        "",
        "**Numbers**: 3 orders shipped, freight all on Ridgeline. Reorder email flow converted 2 accounts.",
        "**Stock**: centerpull towels under cover — reorder prepared (baction-9101).",
        "**Ads**: LinkedIn prospecting under break-even — pause prepared (baction-9102).",
        "**Watch**: Riverside Diner (at-risk, 58 days) and the Summit towel fill rate.",
      ].join("\n"),
      createdAt: iso(1, 8),
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
    autonomy: { level: 3, guardrails: BEACON_GUARDRAILS, updatedAt: iso(30) },
    memory,
    activity,
    actions,
    reports,
  };
}
