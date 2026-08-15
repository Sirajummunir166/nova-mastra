/**
 * THE SENSE LAYER — the store's numbers, read once, degrading per source.
 *
 * Two readers live here, over the same discipline:
 *
 *  - {@link buildCeoSnapshot} — the ~300-token text block behind the founder's
 *    hello turn. Aggregate server-side, never hand the model raw row dumps.
 *  - {@link senseStore} — the structured observation the BRAIN senses with
 *    (phase E unit 2). Same reads, no prose: the pulse compares it against the
 *    last one and only wakes a model for what moved.
 *
 * ── WHY THIS FILE AND NOT A PORT OF nova-ai's `analytics.ts` ────────────────
 *
 * `detectAnomalies` reads its seven domains inside a single `Promise.all`, so
 * ONE failing read rejects the whole scan and the pulse senses nothing at all.
 * That is survivable for a founder-triggered tool call; it is not survivable
 * for a loop meant to run hourly, forever, on every tenant — an inventory API
 * blip would blind the sales, cart and margin domains too. This file already
 * had the right shape for that (`pull`: a failed source becomes one
 * "(unavailable)" line rather than a thrown snapshot), so the sense layer grew
 * here instead. {@link senseStore} keeps the property structurally: every
 * domain is its own {@link DomainRead}, and an unreadable one carries its
 * reason while the others still answer.
 *
 * ── THE HONEST DOMAINS, AND THE TWO THAT ARE NOT SENSED ────────────────────
 *
 * See {@link SENSE_GAPS}. `analytics.ts` also scanned ads, courier ("logistics"
 * on its side) and support. Two of those three are still dead at the source, so
 * anything this layer said about them would be a lie dressed as a metric; they
 * are named there rather than silently missing.
 *
 * COURIER IS NO LONGER ONE OF THEM. dakio-api's `GET /couriers` stopped being a
 * hardcoded `{ couriers: [] }` and became a real aggregate over
 * `CourierConsignment` + `Order.courierStatus/At`, so {@link StoreSense.courier}
 * is the sixth sense and the gap entry is deleted. What arrives with it is a
 * whole vocabulary of unknowns that must NOT be read as zeros — a rate over
 * nothing resolved, a mean over one delivery, an on-time figure that can never
 * exist — and every one of them is carried as `null` here and refused a finding
 * in `pulse-compare.ts`.
 *
 * ── AND THREE FIELDS THAT ARE DEAD INSIDE A LIVE DOMAIN ────────────────────
 *
 * The phase E spec called inventory (days-of-cover, dead stock) a fully honest
 * domain. It is honest in SHAPE, and against a real tenant three of its inputs
 * are documented gaps in dakio-api's own `novaStore.js` product mapping:
 *
 *   weeklyVelocity: []   "gap: derivable from OrderItem history (deferred)"
 *   reorderPoint:   0    "gap: no source in Dakio"
 *   supplierId:     ''   "gap: Product has no supplier FK"
 *
 * So on a live store there is no velocity to divide by, no lead time to
 * compare against, and no reorder point to measure overhang from — the cover
 * and dead-stock findings cannot fire, and MUST NOT be faked from the defaults.
 * `null` (unknown) is carried instead of `0` (measured) everywhere those three
 * appear, and `pulse-compare.ts` refuses to build a finding on an unknown. The
 * demo backend carries real velocity series, which is what keeps those rules
 * exercised and tested until dakio-api grows the reads.
 *
 * TWO MORE FIELDS JOINED THAT LIST, for the same reason and after the same
 * defect was found one field over:
 *
 *   cost:             `num(p.purchasePrice)` with `num(null) = 0`, so a product
 *                     with no purchase price arrives as `cost: 0` — which reads
 *                     as a 100% margin and SILENTLY DROPS the thin-margin
 *                     finding for exactly the catalogue Nova cannot cost.
 *                     {@link costOf} carries `null` instead (see it for why 0
 *                     is treated as absent rather than as free goods).
 *   currentDelayDays: `0, // gap` — hard-coded by dakio-api's supplier mapper.
 *                     An unreported delay must not become a MEASURED on-time
 *                     observation, so a non-numeric value is carried as `null`.
 *                     The value `0` itself is genuinely ambiguous on the wire
 *                     and is named as a blind spot by {@link blindSpots}
 *                     whenever the supplier record carries no offers either —
 *                     the shape dakio-api's stub always has.
 *
 * ── AND THE PAGES ARE PAGES, NOT TOTALS ────────────────────────────────────
 *
 * Every list route in dakio-api's Nova surface is `take: LIST_CAP` (200),
 * `orderBy: createdAt desc`, with no pagination to page around. A 200-row page
 * presented as "your catalogue" or "your carts" is a measurement the founder
 * can check and find wrong, so {@link StoreSense.partial} says which reads hit
 * the cap and everything downstream words itself as a PARTIAL VIEW — or, where
 * the truncation destroys the arithmetic outright (week-over-week revenue),
 * refuses to make the claim at all.
 */

import { storeFor } from "../store/resolve.js";
import type { StoreClient } from "../store/client.js";
import type { InboxEvent, Order as StoreOrder, Product as StoreProduct, Supplier } from "../store/types.js";

// Lite views of the client's return shapes — only the fields the snapshot
// aggregates. The full `store/types.js` rows are structurally assignable.

interface OrderItem {
  productName: string;
  quantity: number;
}

interface Order {
  total: number;
  status: string;
  placedAt: string;
  items: OrderItem[];
}

interface Product {
  name: string;
  price: number;
  stock: number;
  reorderPoint: number;
  status: string;
}

interface Customer {
  segment: string;
  lifetimeValue: number;
}

interface Cart {
  value: number;
  recoveryState: string;
}

/**
 * One guarded client call. A failed source answers `null` so its section can
 * degrade to "(unavailable)" instead of killing the whole snapshot.
 */
async function pull<T>(storeId: string, label: string, call: () => Promise<T>): Promise<T | null> {
  try {
    return await call();
  } catch (err) {
    console.warn(`[snapshot] ${label} for ${storeId} failed:`, err instanceof Error ? err.message : err);
    return null;
  }
}

function money(n: number, currency: string): string {
  return `${currency} ${Math.round(n).toLocaleString("en-US")}`;
}

/**
 * Build the snapshot block, one section per data source. A failed source
 * degrades to a "(unavailable)" line — the report must never block the turn.
 */
export async function buildCeoSnapshot(storeId: string, currency: string): Promise<string> {
  const client = storeFor(storeId);
  const [orders, products, customers, carts, finance] = await Promise.all([
    pull<Order[]>(storeId, "orders", () => client.listOrders({ sinceDays: 30 })),
    pull<Product[]>(storeId, "products", () => client.listProducts()),
    pull<Customer[]>(storeId, "customers", () => client.listCustomers()),
    pull<Cart[]>(storeId, "carts", () => client.listAbandonedCarts()),
    pull<Record<string, unknown>>(
      storeId,
      "finance/overview",
      async () => (await client.getFinanceOverview()) as unknown as Record<string, unknown>,
    ),
  ]);

  const lines: string[] = ["## Live store snapshot (real data, just pulled)"];
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;

  if (orders) {
    const last7 = orders.filter((o) => now - Date.parse(o.placedAt) <= 7 * DAY);
    const revenue = (list: Order[]) =>
      list.filter((o) => o.status !== "cancelled" && o.status !== "returned")
        .reduce((sum, o) => sum + (o.total || 0), 0);
    const byStatus = new Map<string, number>();
    for (const o of orders) byStatus.set(o.status, (byStatus.get(o.status) ?? 0) + 1);
    const statusStr = [...byStatus.entries()].map(([s, n]) => `${s} ${n}`).join(", ");

    const soldByProduct = new Map<string, number>();
    for (const o of orders) {
      for (const item of o.items ?? []) {
        soldByProduct.set(item.productName, (soldByProduct.get(item.productName) ?? 0) + item.quantity);
      }
    }
    const top = [...soldByProduct.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);

    lines.push(
      `- Orders 30d: ${orders.length} (revenue ${money(revenue(orders), currency)}) · last 7d: ${last7.length} (${money(revenue(last7), currency)})`,
      `- Order status: ${statusStr || "none"}`,
    );
    if (top.length > 0) {
      lines.push(`- Top sellers 30d: ${top.map(([name, qty]) => `${name} (${qty} pcs)`).join(", ")}`);
    }
  } else {
    lines.push("- Orders: (unavailable)");
  }

  if (products) {
    const active = products.filter((p) => p.status === "active");
    const low = products.filter((p) => p.stock <= p.reorderPoint);
    lines.push(`- Catalog: ${products.length} products (${active.length} active)`);
    if (low.length > 0) {
      lines.push(
        `- LOW STOCK (at/below reorder point): ${low.slice(0, 5).map((p) => `${p.name} (${p.stock} left)`).join(", ")}${low.length > 5 ? ` +${low.length - 5} more` : ""}`,
      );
    }
  } else {
    lines.push("- Catalog: (unavailable)");
  }

  if (customers) {
    const ltv = customers.reduce((sum, c) => sum + (c.lifetimeValue || 0), 0);
    lines.push(`- Customers: ${customers.length} on file · combined LTV ${money(ltv, currency)}`);
  } else {
    lines.push("- Customers: (unavailable)");
  }

  if (carts) {
    const open = carts.filter((c) => c.recoveryState !== "recovered" && c.recoveryState !== "lost");
    if (open.length > 0) {
      lines.push(`- Abandoned carts: ${open.length} open, ${money(open.reduce((s, c) => s + (c.value || 0), 0), currency)} recoverable`);
    } else {
      lines.push("- Abandoned carts: none open");
    }
  }

  if (finance && finance.ledgerActive === true) {
    // Ledger is onboarded — surface whatever headline figures the overview carries.
    const nums = Object.entries(finance)
      .filter(([k, v]) => typeof v === "number" && k !== "ledgerActive")
      .slice(0, 6)
      .map(([k, v]) => `${k} ${money(v as number, currency)}`);
    if (nums.length > 0) lines.push(`- Finance (ledger): ${nums.join(" · ")}`);
  }

  return lines.join("\n");
}

// ===========================================================================
// THE SENSE LAYER — structured observation for the brain
// ===========================================================================

/**
 * A domain either answered or it did not. There is no third state, and the
 * reason travels with the failure so a report can say WHICH sense went dark
 * instead of quietly reporting a store with no products.
 *
 * This is the whole degradation contract: `ok:false` on one domain leaves the
 * others untouched. Nothing downstream may infer a finding from a domain that
 * did not answer — a silent `[]` would read as "no low stock anywhere", which
 * is the most dangerous possible reading of a failed read.
 */
export type DomainRead<T> = { ok: true; value: T } | { ok: false; reason: string };

/** One product, with everything the inventory and margin senses need. */
export interface ProductSignal {
  id: string;
  name: string;
  stock: number;
  reorderPoint: number;
  price: number;
  /**
   * Unit cost. NULL MEANS UNKNOWN — see {@link costOf}. A `0` on the wire is
   * dakio-api's `num(null)`, and reading it as a measurement is what produced a
   * confident "100% margin" for every product whose purchase price Nova cannot
   * see, and a `NaN% margin at ৳3,959 on ৳NaN cost` for a non-numeric one.
   */
  cost: number | null;
  /**
   * Units/day, the mean of the last 4 weekly buckets ÷ 7 (nova-ai's window).
   *
   * NULL MEANS UNKNOWN, NOT ZERO, and the difference is load-bearing: against a
   * real dakio tenant `weeklyVelocity` comes back `[]` (novaStore.js: "gap:
   * derivable from OrderItem history (deferred)"). Reading that as 0/day would
   * declare every product in the catalogue dead stock — a whole domain of
   * confident, false findings built on a field with no source.
   */
  velocity: number | null;
  /**
   * HOW MANY WEEKLY BUCKETS THAT MEAN IS OVER — 0 when velocity is unknown.
   *
   * The window is "the last 4 weeks", and the average was taken over however
   * many buckets happened to exist: one week of history read as a settled
   * "~0.14/day" with nothing saying it was one week. The count travels so the
   * evidence line can say what was actually averaged.
   */
  velocityWeeks: number;
  /**
   * `stock / velocity`. NULL when velocity is unknown, or at or below
   * {@link NEAR_ZERO_VELOCITY} — a product nobody is buying has no meaningful
   * days-of-cover, and `Infinity` would sort and diff like a number.
   */
  daysOfCover: number | null;
  /**
   * Supplier lead time for THIS product PLUS that supplier's current delay —
   * the honest wait, not the catalogue one. NULL when the supplier or its
   * offer could not be read, and a null lead time means the stock-out finding
   * cannot be made for this product at all (nova-ai's rule, kept).
   */
  leadTimeDays: number | null;
  /** `(price - cost) / price * 100`. NULL when the price is 0 or absent. */
  marginPct: number | null;
  supplierId: string;
  supplierName: string | null;
}

/**
 * Revenue over the last 7 days and the 7 before it — the WoW comparison.
 *
 * TWO BIASES TRAVEL WITH THIS WINDOW and neither can be fixed from this side,
 * so both are stated rather than smoothed over:
 *
 *  · TRUNCATION. The window is one `sinceDays: 14` page, capped at 200 rows
 *    NEWEST FIRST. On a store busy enough to fill it, the rows that fall off
 *    are the OLDEST — the prior week — so the ratio is biased toward "revenue
 *    is up" and the drop alarm silently stops firing. {@link SalesWindow.partial}
 *    marks it and `pulse-compare.ts` REFUSES to compute a week-over-week claim
 *    from a truncated page: a percentage the founder can check against their own
 *    dashboard and find wrong is worse than no percentage.
 *  · MATURITY. `revenueEligible` strips cancelled/refunded/RTO, and the older
 *    week has had a week longer to reach those statuses. That inflates the
 *    ratio too, by a smaller amount, and it is named in the finding's evidence
 *    so a founder comparing against their dashboard knows what was counted.
 */
export interface SalesWindow {
  revenue7d: number;
  revenuePrior7d: number;
  orders7d: number;
  ordersPrior7d: number;
  /** The order page hit the row cap — this is a slice, not the fortnight. */
  partial: boolean;
  /** Eligible orders with no usable total; excluded from the sums, not zeroed. */
  unpricedOrders: number;
}

/**
 * Carts nobody has recovered yet: `none` + `message_prepared`.
 *
 * NOT A TOTAL WHEN {@link CartTotals.partial} IS SET. dakio-api's `/carts` is
 * the 200 newest storefront leads OF ANY STATUS, of all time; the unrecovered
 * ones are a subset of that page, so on a store with more leads the count can
 * never exceed 200 no matter how bad it gets. Leads with no cart value are
 * COUNTED but not priced (dakio-api's `num(null) = 0` would otherwise fold
 * them into the money figure at ৳0).
 */
export interface CartTotals {
  count: number;
  value: number;
  /** The lead page hit the row cap — "at least this many", never a total. */
  partial: boolean;
  /** Unrecovered carts with no usable value; excluded from `value`. */
  unpriced: number;
}

export interface SupplierSignal {
  id: string;
  name: string;
  /**
   * Days of delay on currently open POs, 0 if none. NULL = the supplier did
   * not report a number. An unreported delay is not an on-time delivery, and
   * storing it as one is how "measured, on time" gets written about a supplier
   * nobody has heard from.
   */
  currentDelayDays: number | null;
  /**
   * Does this record carry supplier offers at all? dakio-api's supplier mapper
   * ships `offers: []` and `currentDelayDays: 0, // gap` together, so a record
   * with no offers is a STUB and its `0` is indistinguishable from a measured
   * on-time supplier. {@link blindSpots} says so rather than the pulse quietly
   * believing every live supplier is running perfectly to schedule.
   */
  hasOffers: boolean;
}

/**
 * ONE COURIER, AS THE PULSE MAY REASON ABOUT IT.
 *
 * A near-passthrough of dakio-api's scorecard row, and deliberately so: the
 * route already did the honest arithmetic (rates over RESOLVED parcels only,
 * `null` rather than `0` on a zero base, an evidence floor, stagnation read off
 * `novaJourney`'s own thresholds). Re-deriving any of it here would be a second
 * opinion about the same parcels.
 *
 * WHAT THIS LAYER ADDS is normalization of the two fields a caller can be
 * fooled by:
 *
 *  · every rate is coerced to `number | null` — a non-numeric value from an
 *    older route build becomes UNKNOWN, never a number that compares against a
 *    threshold;
 *  · {@link CourierSignal.onTimeRate} is carried as-is and is `null` forever
 *    today, with {@link CourierSignal.onTimeBasis} saying why. It exists on
 *    this shape so {@link blindSpots} can say out loud that on-time performance
 *    cannot be judged — an absent field would just look like nobody asked.
 */
export interface CourierSignal {
  id: string;
  name: string;
  parcels: number;
  /** The only legitimate rate denominator: delivered + rto + failed. */
  resolved: number;
  delivered: number;
  rto: number;
  failed: number;
  cancelled: number;
  inFlight: number;
  /** Stagnant by `novaJourney`'s thresholds — parcels it has already raised. */
  inFlightStagnant: number;
  /** 0-1 over `resolved`. NULL = nothing resolved; a finding may not be built on it. */
  rtoRate: number | null;
  deliveredRate: number | null;
  failedRate: number | null;
  /** NULL always, today. Dakio records no promised-delivery date. */
  onTimeRate: number | null;
  onTimeBasis: string;
  /** Mean dispatch→delivery days, over {@link CourierSignal.deliveryTimeSample}. */
  avgDaysToDeliver: number | null;
  deliveryTimeSample: number;
  /** `resolved >= 25`, as the ROUTE computed it. Never re-derived here. */
  sufficientEvidence: boolean;
  /** "6 resolved of 9 dispatched" — the base, in the words a founder reads. */
  basis: string;
}

/**
 * The courier domain, sensed: the rows plus the two envelope facts that decide
 * how they may be worded.
 *
 * `truncated` is not a detail. It means the window held more parcels than one
 * request reads, so the rows describe the MOST RECENT N dispatches — quoting
 * them as the period's totals would be a number the founder can check against
 * their own courier ledger and find wrong.
 */
export interface CourierWindow {
  couriers: CourierSignal[];
  /** The rolling dispatch-dated window these counts belong to. */
  windowDays: number;
  /** The rows are the most recent N dispatches, NOT the window's parcels. */
  truncated: boolean;
}

/** One unprocessed store event — awareness, never a finding of its own. */
export interface InboxEventSignal {
  id: string;
  eventType: string;
  receivedAt: string;
}

/**
 * One store, sensed. Every field is a {@link DomainRead}: the sense layer
 * reports what it could see and says so when it could not.
 *
 * `products` deliberately serves BOTH the inventory and margin domains from
 * ONE read (doc 06: "1 shared SENSE + 9 cheap decide steps" — in eve each
 * department re-read its own context). The consequence is stated rather than
 * hidden: an unreadable catalogue takes inventory AND margin dark together.
 */
export interface StoreSense {
  storeId: string;
  at: string;
  products: DomainRead<ProductSignal[]>;
  sales: DomainRead<SalesWindow>;
  carts: DomainRead<CartTotals>;
  suppliers: DomainRead<SupplierSignal[]>;
  /**
   * THE SIXTH SENSE, and the first one to leave {@link SENSE_GAPS} rather than
   * being added beside them. dakio-api's `GET /couriers` was a hardcoded
   * `{ couriers: [] }` until it became a real aggregate over
   * `CourierConsignment` + `Order.courierStatus/At`; the entry that named
   * courier unknowable was deleted the day the read landed, which is exactly
   * what that list is for.
   */
  courier: DomainRead<CourierWindow>;
  inbox: DomainRead<InboxEventSignal[]>;
  /**
   * Which reads came back on a page that hit dakio-api's row cap. A capped page
   * is a SLICE — the newest 200 rows — and nothing downstream may present one
   * as a total.
   */
  partial: { products: boolean; orders: boolean; carts: boolean };
}

/**
 * The senses, by name. ONE list, so "did every sense go dark?" is a question
 * about this array rather than a hard-coded `=== 5` that a sixth sense would
 * silently walk past.
 *
 * The sixth sense has now arrived (`courier`), which is the first time that
 * property was worth anything: `allSensesDark` and `blindSpots` picked it up
 * without an edit, and the all-blind guard in `pulse.ts` still asks this list
 * rather than counting to five.
 */
export const SENSE_DOMAINS = ["products", "sales", "carts", "suppliers", "courier", "inbox"] as const;

export type SenseDomain = (typeof SENSE_DOMAINS)[number];

/**
 * THE DOMAINS THIS LAYER DELIBERATELY DOES NOT SENSE, and why.
 *
 * nova-ai's `detectAnomalies` scanned three more. Each one is dead at the
 * SOURCE — not unimplemented here, but empty on the wire from dakio-api — so a
 * finding built on any of them would be Nova telling a founder something it
 * cannot know. Exported (and asserted on) so a reader meets the gap instead of
 * assuming we forgot, and so the day a real read lands, the entry has to be
 * deleted on purpose.
 *
 * ── ONE ENTRY HAS NOW LEFT THIS LIST, WHICH IS THE POINT OF KEEPING IT ─────
 *
 * `courier` was here, and its reason ended "Until then: no shipping finding,
 * ever." dakio-api answered it: `GET /couriers` is a real aggregate over
 * `CourierConsignment` + `Order.courierStatus/At` — the months of per-parcel
 * outcomes the entry pointed at — so the domain is sensed
 * ({@link StoreSense.courier}) and the entry is deleted rather than left as a
 * disclaimer the code has outgrown. Everything keyed on this list moved with
 * it in one step: the report footer's "Not checked:" line, the change card's
 * "NOVA CANNOT SEE" line, and the judge's vocabulary bound, which now permits a
 * sentence about couriers because there is finally a measurement behind it.
 *
 * The two that remain are still dead, and courier leaving is not evidence that
 * they are close to living.
 */
export const SENSE_GAPS: readonly { domain: "ads" | "support"; reason: string }[] = [
  {
    domain: "ads",
    reason:
      "dakio-api's ads route returns `campaigns: []` — it reports the Meta connection STATUS and nothing " +
      "else. Burn, CPA and ROAS have no source, so no ad finding can be made. (nova-ai's ads scan runs " +
      "against demo-seeded campaigns, which is why it looks alive there.)",
  },
  {
    domain: "support",
    reason:
      "`listSupportTickets` is a client-side stub returning [] — and pointing it at dakio-api's real " +
      "`SupportTicket` table would be worse than empty: that desk is merchant ↔ DAKIO, not the merchant's " +
      "own customers. The honest source is cases + escalated inbox conversations (phase E spec §C).",
  },
];

/** Treat average daily sales at or below this as "not selling" (nova-ai). */
export const NEAR_ZERO_VELOCITY = 0.01;

/**
 * dakio-api's row cap on every Nova list route (`LIST_CAP = 200` in
 * `novaStore.js`), mirrored here because there is no pagination to page around
 * it and no header that says a page was truncated. A read that comes back with
 * this many rows is ASSUMED to be a slice — conservative in the honest
 * direction: a store with exactly 200 products is described as "at least 200",
 * which is true, rather than as a complete sweep, which might not be.
 */
export const LIST_PAGE_CAP = 200;

/** The velocity window: the last 4 weekly buckets (nova-ai's). */
export const VELOCITY_WEEKS = 4;

const DAY_MS = 86_400_000;

function sum(values: number[]): number {
  return values.reduce((total, v) => total + v, 0);
}

/**
 * A number, or UNKNOWN. The `null`s dakio-api sends deliberately (`rtoRate`
 * over a zero base, `onTimeRate` always) survive as `null`, and so does
 * anything non-numeric an older or broken build might send. Nothing here ever
 * becomes `0`: that is the mistake this whole file is a list of.
 */
function numberOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Orders that count toward revenue: everything a customer did not un-buy. */
function revenueEligible(orders: StoreOrder[]): StoreOrder[] {
  return orders.filter(
    (o) => o.status !== "cancelled" && o.status !== "refunded" && o.status !== "rto",
  );
}

/**
 * The weekly buckets this velocity is actually averaged over: the last
 * {@link VELOCITY_WEEKS}, with anything that is not a finite number dropped.
 *
 * A single `null` inside the series used to poison the mean into `NaN`, which
 * then propagated into `daysOfCover` and compared as a number against every
 * threshold below.
 */
function weeklyBuckets(product: Pick<StoreProduct, "weeklyVelocity">): number[] {
  return (product.weeklyVelocity ?? []).filter((n) => Number.isFinite(n)).slice(-VELOCITY_WEEKS);
}

/**
 * Units/day from the last 4 weekly buckets — nova-ai's window, kept.
 *
 * `null` when there are no buckets at all. nova-ai returned 0 here, which was
 * safe against its demo seed (every product carries eight real weeks) and is
 * not safe against dakio-api, which returns `weeklyVelocity: []` for every
 * product. See {@link ProductSignal.velocity}.
 *
 * THE MEAN IS OVER WHATEVER BUCKETS EXIST, which is the right arithmetic and
 * the wrong sentence: one week of history is a legitimate estimate of a daily
 * rate and an illegitimate "we watched this for a month". {@link velocityWeeksOf}
 * carries the count so the founder-facing line can say which it was.
 */
export function velocityOf(product: Pick<StoreProduct, "weeklyVelocity">): number | null {
  const weeks = weeklyBuckets(product);
  if (weeks.length === 0) return null;
  return sum(weeks) / weeks.length / 7;
}

/** How many weekly buckets {@link velocityOf} averaged. 0 = no velocity source. */
export function velocityWeeksOf(product: Pick<StoreProduct, "weeklyVelocity">): number {
  return weeklyBuckets(product).length;
}

/**
 * Unit cost, or `null` when Nova cannot see one.
 *
 * ZERO IS TREATED AS UNKNOWN, and that is a judgement call worth stating.
 * dakio-api maps a missing `purchasePrice` through `num(null) = 0`, so on the
 * wire "I have no cost for this" and "this cost me nothing" are the same
 * number. One of those two readings produces a confident 100% margin on a
 * catalogue Nova cannot cost, and silently drops every thin-margin finding
 * there is; the other loses a finding about goods that genuinely cost nothing,
 * which no store sells. Unknown wins.
 */
export function costOf(product: Pick<StoreProduct, "cost">): number | null {
  return Number.isFinite(product.cost) && product.cost > 0 ? product.cost : null;
}

/**
 * `(price - cost) / price * 100`, or `null` when either side is unknown.
 *
 * The price guard was here from the start; the cost guard was not, and that is
 * the whole of D3/D4: `((3959 - 0) / 3959) * 100 = 100%` for an uncosted
 * product (finding dropped, founder told nothing), and `NaN` for a non-numeric
 * one (finding rendered as `NaN% margin at ৳3,959 on ৳NaN cost`).
 */
export function marginPctOf(product: Pick<StoreProduct, "price" | "cost">): number | null {
  const cost = costOf(product);
  if (cost === null) return null;
  if (!Number.isFinite(product.price) || product.price <= 0) return null;
  return ((product.price - cost) / product.price) * 100;
}

/**
 * One guarded read for the sense layer. Same posture as {@link pull}, but it
 * keeps the REASON rather than collapsing to `null`: a pulse report that says
 * "inventory unreadable: 503 from /products" is actionable, and one that says
 * nothing about inventory at all is indistinguishable from a healthy store.
 */
async function sense<T>(storeId: string, label: string, call: () => Promise<T>): Promise<DomainRead<T>> {
  try {
    return { ok: true, value: await call() };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[sense] ${label} for ${storeId} failed: ${reason}`);
    return { ok: false, reason: `${label}: ${reason}` };
  }
}

/**
 * Sense one store. Free — no model, and one round of parallel reads.
 *
 * Every read is independently guarded, so this NEVER throws for a data reason.
 * A caller that gets a `StoreSense` back has whatever could be read; a caller
 * that gets an exception has a programming error.
 */
export async function senseStore(storeId: string, client: StoreClient = storeFor(storeId)): Promise<StoreSense> {
  const at = client.now();
  const nowMs = Date.parse(at);

  const [products, suppliers, orders14, cartPage, courierPage, events] = await Promise.all([
    sense(storeId, "products", () => client.listProducts({ status: "active" })),
    sense(storeId, "suppliers", () => client.listSuppliers()),
    sense(storeId, "orders", () => client.listOrders({ sinceDays: 14 })),
    // ONE cart read, filtered here. It used to be two calls for `none` and
    // `message_prepared` — two identical GETs of the same 200-row page, each
    // filtered server-side — which cost double and, worse, hid the page size:
    // "were there more leads than fit?" is unanswerable from a filtered slice,
    // and that is exactly the question a cart TOTAL depends on.
    sense(storeId, "carts", () => client.listAbandonedCarts()),
    // ONE read, the route's DEFAULT window (30 days back from dispatch). The
    // default is not passed explicitly: the window is the route's product
    // decision and it ships `window.days` in the response, so restating "30"
    // here would be a second copy of it that could silently disagree.
    sense(storeId, "couriers", () => client.listCouriers()),
    sense(storeId, "inbox_events", () => client.listInboxEvents({ processed: false })),
  ]);

  // ── inventory + margin, from ONE catalogue read ───────────────────────────
  //
  // The supplier read is a SEPARATE domain and its failure is NOT fatal here:
  // a product whose lead time cannot be read simply carries `leadTimeDays:
  // null`, which suppresses the stock-out finding for that product rather than
  // suppressing the catalogue. Dead stock and margin never needed the supplier.
  const supplierById = new Map<string, Supplier>(
    suppliers.ok ? suppliers.value.map((s) => [s.id, s]) : [],
  );
  const productSignals: DomainRead<ProductSignal[]> = products.ok
    ? {
        ok: true,
        value: products.value.map((p) => {
          const velocity = velocityOf(p);
          const supplier = supplierById.get(p.supplierId) ?? null;
          const offer = supplier?.offers?.find((o) => o.productId === p.id) ?? null;
          return {
            id: p.id,
            name: p.name,
            stock: p.stock,
            reorderPoint: p.reorderPoint,
            price: p.price,
            cost: costOf(p),
            velocity,
            velocityWeeks: velocityWeeksOf(p),
            daysOfCover: velocity !== null && velocity > NEAR_ZERO_VELOCITY ? p.stock / velocity : null,
            // Lead time is the CATALOGUE wait plus the supplier's CURRENT
            // delay: reordering against a lead time that ignores a supplier
            // already running eight days late is how a stock-out is predicted
            // to be fine right up until it happens.
            leadTimeDays: supplier && offer ? offer.leadTimeDays + supplier.currentDelayDays : null,
            marginPct: marginPctOf(p),
            supplierId: p.supplierId,
            supplierName: supplier?.name ?? null,
          };
        }),
      }
    : products;

  // ── sales: last 7 days vs the 7 before ────────────────────────────────────
  //
  // `o.total || 0` used to fold an order with no usable total into the sum as a
  // free order. It is counted and excluded instead — an order Nova cannot price
  // is not an order worth ৳0, and the count rides out so the report can say the
  // revenue figure is a floor.
  const salesWindow: DomainRead<SalesWindow> = orders14.ok
    ? (() => {
        const eligible = revenueEligible(orders14.value);
        const priced = eligible.filter((o) => Number.isFinite(o.total));
        const last7 = priced.filter((o) => Date.parse(o.placedAt) >= nowMs - 7 * DAY_MS);
        const prior7 = priced.filter((o) => Date.parse(o.placedAt) < nowMs - 7 * DAY_MS);
        return {
          ok: true as const,
          value: {
            revenue7d: sum(last7.map((o) => o.total)),
            revenuePrior7d: sum(prior7.map((o) => o.total)),
            orders7d: last7.length,
            ordersPrior7d: prior7.length,
            partial: orders14.value.length >= LIST_PAGE_CAP,
            unpricedOrders: eligible.length - priced.length,
          },
        };
      })()
    : orders14;

  // ── carts: one page, filtered here ────────────────────────────────────────
  //
  // Unrecovered = `none` + `message_prepared`. The page is what dakio-api will
  // give (200 newest leads, ANY status, all time), so `partial` says when the
  // subset below cannot be a total, and leads with no cart value are counted
  // without being priced at ৳0.
  const carts: DomainRead<CartTotals> = cartPage.ok
    ? (() => {
        const unrecovered = cartPage.value.filter(
          (c) => c.recoveryState === "none" || c.recoveryState === "message_prepared",
        );
        const priced = unrecovered.filter((c) => Number.isFinite(c.value) && c.value > 0);
        return {
          ok: true as const,
          value: {
            count: unrecovered.length,
            value: sum(priced.map((c) => c.value)),
            partial: cartPage.value.length >= LIST_PAGE_CAP,
            unpriced: unrecovered.length - priced.length,
          },
        };
      })()
    : cartPage;

  // ── courier: the scorecard, normalized and not re-derived ─────────────────
  //
  // A rate that is not a finite number becomes `null` (UNKNOWN), never a value
  // that would compare against a threshold. Everything else — the counts, the
  // evidence flag, the basis line — is the route's own and is carried, because
  // the route computed it over the parcels and this layer did not see them.
  const courier: DomainRead<CourierWindow> = courierPage.ok
    ? {
        ok: true as const,
        value: {
          couriers: (courierPage.value.couriers ?? []).map((c) => ({
            id: c.id,
            name: c.name,
            parcels: c.parcels,
            resolved: c.resolved,
            delivered: c.delivered,
            rto: c.rto,
            failed: c.failed,
            cancelled: c.cancelled,
            inFlight: c.inFlight,
            inFlightStagnant: c.inFlightStagnant,
            rtoRate: numberOrNull(c.rtoRate),
            deliveredRate: numberOrNull(c.deliveredRate),
            failedRate: numberOrNull(c.failedRate),
            // Carried, and carried as unknown. It is `null` on every response
            // dakio-api can currently produce, and a caller that turns it into
            // a number is claiming a promise date the schema does not hold.
            onTimeRate: numberOrNull(c.onTimeRate),
            onTimeBasis: c.onTimeBasis ?? "unavailable",
            avgDaysToDeliver: numberOrNull(c.avgDaysToDeliver),
            deliveryTimeSample: Number.isFinite(c.deliveryTimeSample) ? c.deliveryTimeSample : 0,
            // The ROUTE decides what counts as evidence; `=== true` so a
            // response missing the field reads as "not evidence", never as
            // evidence by default.
            sufficientEvidence: c.sufficientEvidence === true,
            basis: c.basis ?? `${c.resolved} resolved of ${c.parcels} dispatched`,
          })),
          windowDays: courierPage.value.window?.days ?? 0,
          truncated: courierPage.value.truncated === true,
        },
      }
    : courierPage;

  return {
    storeId,
    at,
    products: productSignals,
    sales: salesWindow,
    carts,
    courier,
    partial: {
      products: products.ok && products.value.length >= LIST_PAGE_CAP,
      orders: orders14.ok && orders14.value.length >= LIST_PAGE_CAP,
      carts: cartPage.ok && cartPage.value.length >= LIST_PAGE_CAP,
    },
    suppliers: suppliers.ok
      ? {
          ok: true,
          value: suppliers.value.map((s) => ({
            id: s.id,
            name: s.name,
            currentDelayDays: Number.isFinite(s.currentDelayDays) ? s.currentDelayDays : null,
            hasOffers: (s.offers ?? []).length > 0,
          })),
        }
      : suppliers,
    inbox: events.ok
      ? {
          ok: true,
          value: events.value.map((e: InboxEvent) => ({
            id: e.id,
            eventType: e.eventType,
            receivedAt: e.receivedAt,
          })),
        }
      : events,
  };
}

/** The read behind one sense, by name. */
function readOf(sense: StoreSense, domain: SenseDomain): DomainRead<unknown> {
  return sense[domain];
}

/** Which senses went dark this pass, as report-ready lines. Empty = all read. */
export function senseFailures(sense: StoreSense): string[] {
  const out: string[] = [];
  for (const domain of SENSE_DOMAINS) {
    const read = readOf(sense, domain);
    if (!read.ok) out.push(`${domain} (${read.reason})`);
  }
  return out;
}

/**
 * Did EVERY sense go dark? Asked of {@link SENSE_DOMAINS} rather than of a
 * hard-coded count, so a sixth sense cannot silently switch the all-blind guard
 * off by making `dark.length === 5` unreachable.
 */
export function allSensesDark(sense: StoreSense): boolean {
  return SENSE_DOMAINS.every((domain) => !readOf(sense, domain).ok);
}

/**
 * ONE BLIND SPOT — something Nova could not see this pass, at whatever
 * granularity it went dark.
 *
 * ── WHY A DARK SENSE WAS NOT ENOUGH ────────────────────────────────────────
 *
 * `senseFailures` only ever named a whole read that THREW. A read that succeeds
 * and comes back missing the field the finding is built on is just as blind and
 * looks perfectly healthy: probed, a product read that answered 200 OK with no
 * velocity closed every open critical stock-out condition (nothing re-derived
 * them, so they "cleared"), and when the field came back the evidence line said
 * *"(first sighting)"* about a condition that had been continuously true.
 *
 * So blindness is a first-class observation with a STABLE KEY — the key is what
 * lets `pulse.ts` treat it edge-triggered like everything else: announced when
 * it appears, re-announced daily while it lasts, and never allowed to sit under
 * a `quiet: true`.
 */
export interface BlindSpot {
  /** Stable across passes — the reason text changes, this does not. */
  key: string;
  /** One line the founder reads, naming what cannot be judged because of it. */
  detail: string;
}

/**
 * Everything Nova could not see this pass: dark senses, load-bearing fields
 * missing inside a healthy read, and pages that came back truncated.
 */
export function blindSpots(sense: StoreSense): BlindSpot[] {
  const out: BlindSpot[] = [];

  for (const domain of SENSE_DOMAINS) {
    const read = readOf(sense, domain);
    if (!read.ok) out.push({ key: `sense:${domain}`, detail: `${domain} could not be read — ${read.reason}` });
  }

  if (sense.products.ok) {
    const products = sense.products.value;
    const total = products.length;
    const noVelocity = products.filter((p) => p.velocity === null).length;
    const noLeadTime = products.filter((p) => p.leadTimeDays === null).length;
    const noCost = products.filter((p) => p.cost === null).length;
    if (noVelocity > 0) {
      out.push({
        key: "field:velocity",
        detail:
          `no sales-velocity source for ${noVelocity} of ${total} product(s) — days of cover and dead stock ` +
          `cannot be judged for them, so silence about those products is not "all clear"`,
      });
    }
    if (noLeadTime > 0) {
      out.push({
        key: "field:leadTime",
        detail:
          `no supplier lead time for ${noLeadTime} of ${total} product(s) — Nova cannot tell whether a reorder ` +
          `would land before the shelf empties`,
      });
    }
    if (noCost > 0) {
      out.push({
        key: "field:cost",
        detail:
          `no unit cost for ${noCost} of ${total} product(s) — margin cannot be computed for them, and a ` +
          `missing cost is NOT a 100% margin`,
      });
    }
    if (sense.partial.products) {
      out.push({
        key: "page:products",
        detail:
          `the catalogue sweep covered the ${total} most recently created products and stopped there — anything ` +
          `older was not looked at this pass`,
      });
    }
  }

  if (sense.sales.ok) {
    if (sense.sales.value.partial) {
      out.push({
        key: "page:orders",
        detail:
          `the 14-day order read came back at the ${LIST_PAGE_CAP}-row cap, so the earlier week is truncated — ` +
          `week-over-week revenue cannot be measured and Nova makes no claim about it`,
      });
    }
    if (sense.sales.value.unpricedOrders > 0) {
      out.push({
        key: "field:orderTotal",
        detail:
          `${sense.sales.value.unpricedOrders} order(s) in the window carry no usable total — they are excluded ` +
          `from revenue rather than counted at ৳0, so the revenue figures are a floor`,
      });
    }
  }

  if (sense.carts.ok) {
    if (sense.carts.value.partial) {
      out.push({
        key: "page:carts",
        detail:
          `the abandoned-cart read came back at the ${LIST_PAGE_CAP}-row cap (newest leads of any status), so ` +
          `the cart figures are a floor, not a total`,
      });
    }
    if (sense.carts.value.unpriced > 0) {
      out.push({
        key: "field:cartValue",
        detail:
          `${sense.carts.value.unpriced} abandoned cart(s) carry no value — counted, but left out of the money ` +
          `figure instead of being added at ৳0`,
      });
    }
  }

  if (sense.courier.ok) {
    const { couriers, truncated, windowDays } = sense.courier.value;
    if (couriers.length > 0) {
      // ── WHY `onTimeRate: null` IS NOT ONE OF THESE ────────────────────────
      //
      // It is the most tempting candidate on this shape and it is deliberately
      // absent. A blind spot in this list is EDGE-TRIGGERED and re-announced
      // every 24h for as long as it lasts (`BLIND_REANNOUNCE_MS`), and
      // `pulse.ts` cannot answer `quiet: true` while one is unreported — so
      // listing "the schema has no promised-delivery date" here would file a
      // report every single day, on every store, forever, with the identical
      // sentence and nothing any founder could ever do about it. That is the
      // definition of the spam this lane exists not to send.
      //
      // The other blind spots earn their re-announcement because they can
      // CLOSE: a velocity source can be built, a courier accumulates parcels, a
      // page stops being capped. A promise date that does not exist in the data
      // model is a standing fact, and standing facts belong in the footnote,
      // not the alarm. It is stated wherever a courier claim is actually
      // made — in the slow-delivery finding's own evidence line, and as a
      // footnote in the report body under the courier section (`pulse.ts`) —
      // so the founder meets it exactly where it could otherwise mislead.

      // ── WHAT IS HERE: a rate that is real arithmetic and not yet evidence.
      // Silence about these couriers is a small sample, not a clean record —
      // and unlike the on-time gap, it closes on its own as parcels resolve.
      const thin = couriers.filter((c) => !c.sufficientEvidence);
      if (thin.length > 0) {
        out.push({
          key: "field:courierEvidence",
          detail:
            `${thin.length} of ${couriers.length} courier(s) have too few resolved parcels to judge ` +
            `(${thin.map((c) => `${c.name}: ${c.basis}`).join("; ")}) — Nova makes no claim about their rates, ` +
            `and a small sample is not a good record`,
        });
      }
      // Nothing has finished yet: rates are null for these, by design.
      const unresolved = couriers.filter((c) => c.resolved === 0);
      if (unresolved.length > 0) {
        out.push({
          key: "field:courierUnresolved",
          detail:
            `${unresolved.length} of ${couriers.length} courier(s) have no resolved parcel in the window — ` +
            `every rate for them is unknown, not 0`,
        });
      }
    }
    if (truncated) {
      out.push({
        key: "page:couriers",
        detail:
          `the courier read came back capped, so the rows cover only the most recent dispatches inside the ` +
          `${windowDays}-day window — the counts are a floor, not the period's totals`,
      });
    }
  }

  if (sense.suppliers.ok) {
    const suppliers = sense.suppliers.value;
    const unknown = suppliers.filter((s) => s.currentDelayDays === null).length;
    // A stub record: dakio-api ships `offers: []` and `currentDelayDays: 0,
    // // gap` from the same mapper, so that 0 is a placeholder, not a delivery
    // record. Believing it means reporting every live supplier as on time.
    const stubs = suppliers.filter((s) => s.currentDelayDays !== null && !s.hasOffers).length;
    if (unknown > 0) {
      out.push({
        key: "field:supplierDelay",
        detail: `${unknown} of ${suppliers.length} supplier(s) report no delay figure — unknown, not on time`,
      });
    }
    if (stubs > 0) {
      out.push({
        key: "field:supplierRecord",
        detail:
          `${stubs} of ${suppliers.length} supplier(s) came back with no offers and no lead times, so their ` +
          `"0 days late" is a placeholder from the source, not a measured on-time record`,
      });
    }
  }

  return out;
}
