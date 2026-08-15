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
 * ── THE FOUR HONEST DOMAINS, AND THE THREE THAT ARE NOT SENSED ─────────────
 *
 * See {@link SENSE_GAPS}. `analytics.ts` also scanned ads, courier ("logistics"
 * on its side) and support. Against a real dakio tenant today all three are
 * dead at the source, so anything this layer said about them would be a lie
 * dressed as a metric. They are named there rather than silently missing.
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
  cost: number;
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

/** Revenue over the last 7 days and the 7 before it — the WoW comparison. */
export interface SalesWindow {
  revenue7d: number;
  revenuePrior7d: number;
  orders7d: number;
  ordersPrior7d: number;
}

/** Carts nobody has recovered yet: `none` + `message_prepared`. */
export interface CartTotals {
  count: number;
  value: number;
}

export interface SupplierSignal {
  id: string;
  name: string;
  /** Days of delay on currently open POs, 0 if none. */
  currentDelayDays: number;
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
  inbox: DomainRead<InboxEventSignal[]>;
}

/**
 * THE DOMAINS THIS LAYER DELIBERATELY DOES NOT SENSE, and why.
 *
 * nova-ai's `detectAnomalies` scanned three more. Each one is dead at the
 * SOURCE — not unimplemented here, but empty on the wire from dakio-api — so a
 * finding built on any of them would be Nova telling a founder something it
 * cannot know. Exported (and asserted on) so a reader meets the gap instead of
 * assuming we forgot, and so the day a real read lands, the entry has to be
 * deleted on purpose.
 */
export const SENSE_GAPS: readonly { domain: "ads" | "courier" | "support"; reason: string }[] = [
  {
    domain: "ads",
    reason:
      "dakio-api's ads route returns `campaigns: []` — it reports the Meta connection STATUS and nothing " +
      "else. Burn, CPA and ROAS have no source, so no ad finding can be made. (nova-ai's ads scan runs " +
      "against demo-seeded campaigns, which is why it looks alive there.)",
  },
  {
    domain: "courier",
    reason:
      "The courier route returns `couriers: []` — on-time rate and RTO have no source today. The fix is a " +
      "product, not plumbing: `CourierConsignment` + `Order.courierStatus/At` already hold months of " +
      "per-parcel outcomes written every 5 minutes by courierSync, and one aggregating read would serve " +
      "this sense AND ship doc 07's Tier-2 courier scorecard. Until then: no shipping finding, ever.",
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

const DAY_MS = 86_400_000;

function sum(values: number[]): number {
  return values.reduce((total, v) => total + v, 0);
}

/** Orders that count toward revenue: everything a customer did not un-buy. */
function revenueEligible(orders: StoreOrder[]): StoreOrder[] {
  return orders.filter(
    (o) => o.status !== "cancelled" && o.status !== "refunded" && o.status !== "rto",
  );
}

/**
 * Units/day from the last 4 weekly buckets — nova-ai's window, kept.
 *
 * `null` when there are no buckets at all. nova-ai returned 0 here, which was
 * safe against its demo seed (every product carries eight real weeks) and is
 * not safe against dakio-api, which returns `weeklyVelocity: []` for every
 * product. See {@link ProductSignal.velocity}.
 */
export function velocityOf(product: Pick<StoreProduct, "weeklyVelocity">): number | null {
  const weeks = (product.weeklyVelocity ?? []).slice(-4);
  if (weeks.length === 0) return null;
  return sum(weeks) / weeks.length / 7;
}

function marginPctOf(product: Pick<StoreProduct, "price" | "cost">): number | null {
  if (!Number.isFinite(product.price) || product.price <= 0) return null;
  return ((product.price - product.cost) / product.price) * 100;
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

  const [products, suppliers, orders14, cartsNone, cartsPrepared, events] = await Promise.all([
    sense(storeId, "products", () => client.listProducts({ status: "active" })),
    sense(storeId, "suppliers", () => client.listSuppliers()),
    sense(storeId, "orders", () => client.listOrders({ sinceDays: 14 })),
    sense(storeId, "carts:none", () => client.listAbandonedCarts("none")),
    sense(storeId, "carts:prepared", () => client.listAbandonedCarts("message_prepared")),
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
            cost: p.cost,
            velocity,
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
  const salesWindow: DomainRead<SalesWindow> = orders14.ok
    ? (() => {
        const eligible = revenueEligible(orders14.value);
        const last7 = eligible.filter((o) => Date.parse(o.placedAt) >= nowMs - 7 * DAY_MS);
        const prior7 = eligible.filter((o) => Date.parse(o.placedAt) < nowMs - 7 * DAY_MS);
        return {
          ok: true as const,
          value: {
            revenue7d: sum(last7.map((o) => o.total || 0)),
            revenuePrior7d: sum(prior7.map((o) => o.total || 0)),
            orders7d: last7.length,
            ordersPrior7d: prior7.length,
          },
        };
      })()
    : orders14;

  // ── carts: BOTH reads or neither ──────────────────────────────────────────
  //
  // A partial cart total is worse than none: half the unrecovered carts reads
  // as carts having been recovered since the last pulse, which is a "good news"
  // delta nobody would question.
  const carts: DomainRead<CartTotals> =
    cartsNone.ok && cartsPrepared.ok
      ? {
          ok: true,
          value: {
            count: cartsNone.value.length + cartsPrepared.value.length,
            value: sum([...cartsNone.value, ...cartsPrepared.value].map((c) => c.value || 0)),
          },
        }
      : { ok: false, reason: cartsNone.ok ? (cartsPrepared as { reason: string }).reason : (cartsNone as { reason: string }).reason };

  return {
    storeId,
    at,
    products: productSignals,
    sales: salesWindow,
    carts,
    suppliers: suppliers.ok
      ? {
          ok: true,
          value: suppliers.value.map((s) => ({
            id: s.id,
            name: s.name,
            currentDelayDays: s.currentDelayDays ?? 0,
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

/** Which senses went dark this pass, as report-ready lines. Empty = all read. */
export function senseFailures(sense: StoreSense): string[] {
  const out: string[] = [];
  for (const [domain, read] of Object.entries({
    products: sense.products,
    sales: sense.sales,
    carts: sense.carts,
    suppliers: sense.suppliers,
    inbox: sense.inbox,
  }) as [string, DomainRead<unknown>][]) {
    if (!read.ok) out.push(`${domain} (${read.reason})`);
  }
  return out;
}
