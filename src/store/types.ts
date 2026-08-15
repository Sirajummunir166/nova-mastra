/**
 * Nova domain model.
 *
 * These types describe everything the Dakio store exposes to Nova (catalog,
 * orders, marketing, logistics, finance) plus everything Nova persists back
 * into the store (memory, activity, prepared actions, reports).
 *
 * All money values are ৳ (BDT), Dakio's currency. All timestamps are ISO 8601
 * strings.
 */

// ---------------------------------------------------------------------------
// Catalog & inventory
// ---------------------------------------------------------------------------

export interface Product {
  id: string;
  sku: string;
  name: string;
  category: string;
  description: string;
  price: number;
  /** Strike-through price shown in the storefront, if discounted. */
  compareAtPrice: number | null;
  /** Unit cost from the current supplier. */
  cost: number;
  stock: number;
  reorderPoint: number;
  supplierId: string;
  status: "active" | "draft" | "archived";
  rating: number;
  reviewCount: number;
  /** Units sold per week, most recent week last (8 weeks). */
  weeklyVelocity: number[];
  tags: string[];
  /**
   * The product's option names (size/colour), storefront-public. Doc 04b
   * piece C: what lets the ONE consolidated order ask say "kon size neben
   * (M/L/XL)?" without a second read. Empty = no variants.
   */
  variantNames: string[];
  /**
   * Per-option stock by name (doc 04b round 3) — so the ask offers only
   * options actually in stock instead of every size blind. Absent or null
   * when per-option truth does not exist: dropship stock is per PRODUCT
   * (lib/stock.js in dakio-api), never per option — then offer the names.
   */
  variantStock?: Record<string, number> | null;
  /**
   * Option name → variant ID (doc 04b round 4). `create_order_from_chat`
   * requires a variant ID, and before this map the customer plane had no
   * source of one — the model invented an id and the founder's Approve died
   * on VARIANT_NOT_FOUND after the customer had already confirmed.
   */
  variantIds?: Record<string, string>;
  createdAt: string;
}

export interface TrendingProduct {
  id: string;
  name: string;
  category: string;
  /** 0-100 composite of search volume + social traction. */
  demandScore: number;
  /** 0-100, higher = more crowded. */
  competitionScore: number;
  estimatedUnitCost: number;
  suggestedPrice: number;
  estimatedMarginPct: number;
  source: string;
  insight: string;
}

// ---------------------------------------------------------------------------
// Customers, orders, carts
// ---------------------------------------------------------------------------

export type CustomerSegment = "vip" | "repeat" | "new" | "at-risk";

export interface Customer {
  id: string;
  name: string;
  email: string;
  segment: CustomerSegment;
  ordersCount: number;
  lifetimeValue: number;
  lastOrderAt: string | null;
  notes: string;
  createdAt: string;
}

export interface OrderItem {
  productId: string;
  productName: string;
  quantity: number;
  unitPrice: number;
}

export type OrderStatus =
  | "placed"
  | "paid"
  | "fulfilled"
  | "delivered"
  | "rto" // returned to origin — delivery failed
  | "refund_requested"
  | "refunded"
  | "cancelled";

export interface Order {
  id: string;
  customerId: string;
  items: OrderItem[];
  subtotal: number;
  discount: number;
  shipping: number;
  total: number;
  status: OrderStatus;
  courierId: string | null;
  placedAt: string;
  deliveredAt: string | null;
  region: string;
}

export type CartRecoveryState =
  | "none" // nothing done yet
  | "message_prepared"
  | "message_sent"
  | "recovered"
  | "lost";

export interface AbandonedCart {
  id: string;
  customerId: string;
  items: OrderItem[];
  value: number;
  abandonedAt: string;
  recoveryState: CartRecoveryState;
  recoveryMessage: string | null;
  /**
   * Stage 10 module 05 (D8): the inbox thread this cart's owner is reachable
   * in, when the server could match one. Optional-and-nullable rather than
   * required, for the reason `proposal` and `nba` on {@link InboxThread} are:
   * a dakio-api that predates module 05's `cartOut` omits the key entirely, and
   * a required field would make "no thread matched" and "this server cannot
   * match threads" the same observation — the first is a normal cart, the
   * second is a cart-recovery lane that is silently doing nothing.
   */
  conversationId?: string | null;
}

// ---------------------------------------------------------------------------
// Marketing
// ---------------------------------------------------------------------------

export type CampaignChannel = "meta" | "google" | "tiktok" | "email" | "sms";
export type CampaignStatus = "active" | "paused" | "scheduled" | "completed";

export interface CampaignDayStat {
  date: string; // YYYY-MM-DD
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  revenue: number;
}

export interface Campaign {
  id: string;
  name: string;
  channel: CampaignChannel;
  status: CampaignStatus;
  dailyBudget: number;
  productIds: string[];
  startedAt: string;
  /** Most recent day last (up to 14 days). */
  dailyStats: CampaignDayStat[];
  notes: string;
}

export type SocialPostStatus = "draft" | "scheduled" | "published";

export interface SocialPost {
  id: string;
  platform: "instagram" | "tiktok" | "facebook";
  format: "reel" | "post" | "story";
  caption: string;
  productIds: string[];
  status: SocialPostStatus;
  scheduledFor: string | null;
  publishedAt: string | null;
}

/**
 * Which arm of a coupon this is (Stage 10 module 05). The strings are
 * dakio-api's own `Coupon.type` column values, upper-case, so a reader diffing
 * a wire payload against the DB sees the same token in both.
 */
export type DiscountKind = "PERCENT" | "FIXED";

export interface Discount {
  id: string;
  code: string;
  /**
   * Absent on every server that predates module 05's `discountOut` fix. Read it
   * as PERCENT only when it is genuinely absent — never infer FIXED from a zero
   * `percentOff`, because that is exactly the bug module 05 fixed: the old
   * serializer read every FIXED coupon back as `percentOff: 0`, which is
   * indistinguishable from a percent coupon somebody set to nothing.
   */
  type?: DiscountKind;
  /**
   * `null` on a FIXED coupon — never 0. A ৳100-off coupon is not a 0% coupon,
   * and `percentOff: 0` is precisely what made every FIXED coupon read back as
   * "no discount" to a caller that only looked at this field. Null forces the
   * reader to branch on `type`.
   */
  percentOff: number | null;
  /**
   * The raw `Coupon.amount` column: the whole-percent figure on a PERCENT
   * coupon, WHOLE TAKA off on a FIXED one. `Coupon.amount` is numeric(65,30) in
   * taka — 100 here is one hundred taka, not one hundred poisha. There is no
   * minor-unit money anywhere on this wire.
   */
  amount?: number | null;
  /** WHOLE TAKA. The cart subtotal this code needs before it applies. */
  minOrder?: number | null;
  /** Total redemptions allowed across all customers. Null = unlimited. */
  maxUses?: number | null;
  /** Redemptions so far. Compared against `maxUses` at checkout, server-side. */
  usedCount?: number;
  /** by:nova attribution — names the receipt that explains this coupon. */
  novaActionId?: string | null;
  scope: "order" | "product";
  productIds: string[];
  /** Customer this code was issued to, if targeted. */
  customerId: string | null;
  expiresAt: string;
  active: boolean;
  createdAt: string;
}

/**
 * The body of `POST /api/v1/store/discounts` (Stage 10 module 05 extends it).
 *
 * A named input type rather than `Omit<Discount, …>` because the two shapes
 * genuinely differ now: `percentOff` is required on a PERCENT coupon and
 * meaningless on a FIXED one, and `usedCount`/`novaActionId` are written by the
 * server, never by a caller's `Omit`.
 *
 * ONE OF `customerId` / `conversationId` IS REQUIRED whenever `novaActionId` is
 * set, and the route 422s without it. `Coupon` has NO `customerId` column, so
 * the only record of who a Nova coupon was issued to is inside
 * `NovaAction.payload` — omit the recipient and the once-per-N-days frequency
 * guard has nothing to match on and silently passes every time. A rule that
 * reads as enforced and is enforced against nobody is the worst of the three
 * states, which is why the server refuses rather than defaults.
 *
 * `scope`, `productIds` and `customerId` are accepted and IGNORED server-side —
 * Dakio coupons are order-level only and `discountOut` hardcodes all three on
 * the way back. They stay on the type because the founder-plane `create_discount`
 * verb has always sent them; they are not a capability.
 */
export interface CreateDiscountInput {
  code: string;
  /** Required for `type: "PERCENT"`; the route rejects anything outside 1–100. */
  percentOff?: number;
  /** Inferred as PERCENT when absent, so pre-module-05 callers are unchanged. */
  type?: DiscountKind;
  /** WHOLE TAKA. Required for `type: "FIXED"` and must be positive. */
  amount?: number | null;
  minOrder?: number | null;
  maxUses?: number | null;
  scope?: "order" | "product";
  productIds?: string[];
  customerId?: string | null;
  expiresAt: string;
  active: boolean;
  /** Set on a Nova-issued coupon; turns on the frequency guard below. */
  novaActionId?: string;
  /**
   * The thread the code was negotiated in. Accepted as the frequency guard's
   * identity key when `customerId` is absent, because a thread is a person even
   * before the identity join has earned them a `Customer` row — and Nova
   * negotiates with plenty of buyers it has not linked yet.
   */
  conversationId?: string;
}

// ---------------------------------------------------------------------------
// Support
// ---------------------------------------------------------------------------

export type TicketStatus = "open" | "waiting_on_customer" | "escalated" | "resolved";

/* ── Grow Lab ────────────────────────────────────────────────────────────
 *
 * The six founder-facing Grow modules (Campaigns, Content Studio, Broadcast,
 * Research, Growth, Goals) — real Dakio rows, read via `/api/v1/store/grow/*`.
 *
 * These are deliberately distinct from {@link Campaign} and {@link SocialPost}
 * above: those model Meta ad insights, these model the merchant's own Grow Lab
 * records. Same words, different things — the `Grow` prefix keeps them apart.
 *
 * Every row carries `createdBy` and `novaActionId` so Nova can tell its own
 * work from the founder's and link a row back to the receipt explaining it.
 * Attribution is metadata: a null `novaActionId` never means a row is invalid.
 */

/** Who authored a Grow row. Nova's rows are always explained by a receipt. */
export type GrowAuthor = "founder" | "nova";

export interface GrowCampaign {
  id: string;
  name: string;
  /** Sales | Awareness | Launch */
  goal: string;
  status: "Draft" | "Scheduled" | "Live" | "Paused" | "Ended";
  productIds: string[];
  /** FB | IG | WA | SMS | EMAIL */
  channels: string[];
  startsAt: string | null;
  endsAt: string | null;
  /**
   * Planned spend in ৳. Dakio has no ads-management scope, so this figure is
   * never actually spent — never describe it as money that went out.
   */
  budget: number | null;
  createdBy: GrowAuthor;
  novaActionId: string | null;
  createdAt: string;
}

export interface GrowPost {
  id: string;
  /** REEL | PHOTO | CAROUSEL | STORY | TEXT */
  type: string;
  title: string;
  caption: string;
  mediaUrl: string | null;
  /** IG | FB — only FB can actually publish today. */
  channels: string[];
  scheduledAt: string | null;
  publishedAt: string | null;
  status: "Draft" | "Scheduled" | "Published" | "Failed";
  campaignId: string | null;
  /** Set once a real publish happened, e.g. `{ fb: "123_456" }`. */
  externalIds: Record<string, string> | null;
  /** Columns exist; no insights ingester writes them yet, so null ≠ zero. */
  metrics: Record<string, number> | null;
  createdBy: GrowAuthor;
  novaActionId: string | null;
  createdAt: string;
}

export interface GrowBroadcast {
  id: string;
  name: string;
  audienceKey: string;
  audienceLabel: string;
  /** WA | SMS | EMAIL */
  channel: string;
  message: string;
  scheduledAt: string | null;
  sentAt: string | null;
  /**
   * Never "Sent" today: Dakio has no merchant→customer channel, so broadcasts
   * are prepared and held. Do not report one as delivered.
   */
  status: "Draft" | "Scheduled" | "Sending" | "Sent" | "Failed";
  recipientCount: number;
  /** Held back by the 7-day cool-off the product promises. */
  skippedCount: number;
  deliveredCount: number;
  readCount: number;
  ordersCount: number;
  revenue: number;
  createdBy: GrowAuthor;
  novaActionId: string | null;
  createdAt: string;
}

export interface GrowIdea {
  id: string;
  /** trend | product */
  kind: string;
  label: string;
  source: string | null;
  note: string | null;
  supplier: string | null;
  costPrice: number | null;
  sellPrice: number | null;
  status: "saved" | "queued" | "imported" | "dismissed";
  /** Set once the idea became a real draft Product. */
  productId: string | null;
  importedAt: string | null;
  createdBy: GrowAuthor;
  novaActionId: string | null;
  createdAt: string;
}

/** One month's target. Actuals are Nova's own arithmetic over orders. */
export interface GrowGoal {
  id: string;
  /** 'YYYY-MM' in store-local (Bangladesh) time. */
  month: string;
  revenueGoal: number;
  ordersGoal: number;
  createdAt: string;
}

export interface SupportTicket {
  id: string;
  customerId: string;
  orderId: string | null;
  subject: string;
  category: "order_tracking" | "refund" | "product_question" | "complaint" | "other";
  status: TicketStatus;
  openedAt: string;
  messages: { from: "customer" | "nova" | "owner"; text: string; at: string }[];
}

export interface CustomerMessage {
  id: string;
  customerId: string;
  channel: "email" | "sms" | "chat";
  purpose:
    | "cart_recovery"
    | "support_reply"
    | "sales_reply"
    | "upsell"
    | "winback"
    | "order_update";
  subject: string | null;
  body: string;
  relatedId: string | null; // cart id, ticket id, order id …
  sentAt: string;
}

// ---------------------------------------------------------------------------
// Suppliers & logistics
// ---------------------------------------------------------------------------

export interface SupplierOffer {
  productId: string;
  unitCost: number;
  leadTimeDays: number;
}

export interface Supplier {
  id: string;
  name: string;
  country: string;
  /** 0-1 fraction of POs delivered on time. */
  reliabilityScore: number;
  /** 0-1 quality audit score. */
  qualityScore: number;
  offers: SupplierOffer[];
  /** Days of delay on currently open POs, 0 if none. */
  currentDelayDays: number;
  notes: string;
}

export interface PurchaseOrder {
  id: string;
  supplierId: string;
  productId: string;
  quantity: number;
  unitCost: number;
  total: number;
  status: "draft" | "placed" | "in_transit" | "received" | "cancelled";
  createdAt: string;
  expectedAt: string;
}

/**
 * ONE COURIER'S SCORECARD ROW, exactly as `GET /api/v1/store/couriers` emits it.
 *
 * ── WHAT THIS REPLACED, AND WHY IT MATTERED ────────────────────────────────
 *
 * This interface used to declare `costPerShipment`, `avgDeliveryDays`,
 * `onTimeRate: number`, `rtoRate: number` and `regions: string[]` — a shape
 * invented for the demo seed while the route returned a hardcoded
 * `{ couriers: [] }`. Not one of those five fields is on the wire today, and
 * three of them were the dangerous kind of wrong:
 *
 *  · `onTimeRate: number` promised a fraction that CAN NEVER EXIST. Dakio's
 *    schema records no promised-delivery date anywhere — not on `Order`, not on
 *    `CourierConsignment`, not on `Tenant` — so the route ships `onTimeRate:
 *    null` forever and says why in {@link Courier.onTimeBasis}. A non-nullable
 *    number here is a standing invitation for a caller to write
 *    `courier.onTimeRate * 100` and tell a founder a courier missed a promise
 *    nobody ever made. Use {@link Courier.avgDaysToDeliver}, whose base is
 *    {@link Courier.deliveryTimeSample}.
 *  · `rtoRate: number` hid the zero-base case. Rates are computed over RESOLVED
 *    parcels only (`delivered + rto + failed`), and when nothing has resolved
 *    every rate is `null` — never `0`. "No evidence yet" and "a perfect record"
 *    must not be the same value.
 *  · `costPerShipment`/`regions` have no source at all; a caller comparing
 *    couriers on price would have been comparing seed fiction.
 *
 * ── THE EVIDENCE GRADIENT ──────────────────────────────────────────────────
 *
 * {@link Courier.sufficientEvidence} (resolved ≥ 25) and the plain-English
 * {@link Courier.basis} exist so 2 parcels cannot be read as 300. A rate is real
 * arithmetic at any base; it is EVIDENCE only above the floor, and the pulse
 * gates every rate claim on it.
 */
export interface Courier {
  id: string;
  name: string;
  /** Parcels dispatched in the window — resolved + inFlight + cancelled. */
  parcels: number;
  /** The rate denominator: `delivered + rto + failed`. Never in-flight or cancelled. */
  resolved: number;
  delivered: number;
  /** Came back: the merchant's own RTO reconciliation, or a return scan. */
  rto: number;
  /** Ended without delivering, with no raw string saying it returned. */
  failed: number;
  /** A merchant/customer decision — reported, and charged to no rate. */
  cancelled: number;
  /** Still moving: excluded from every rate rather than dragging them to zero. */
  inFlight: number;
  /**
   * In-flight parcels stagnant by `novaJourney`'s OWN thresholds, which the
   * route imports rather than restates — so the scorecard can never call
   * healthy a parcel the journey has already raised to `at_risk`.
   */
  inFlightStagnant: number;
  /** 0-1 over `resolved`. NULL when `resolved === 0` — never 0. */
  deliveredRate: number | null;
  /** 0-1 over `resolved`. NULL when `resolved === 0` — never 0. */
  rtoRate: number | null;
  /** 0-1 over `resolved`. NULL when `resolved === 0` — never 0. */
  failedRate: number | null;
  /**
   * NULL, ALWAYS, TODAY. There is no promised-delivery date in Dakio's schema,
   * so there is nothing to be on time against. Typed nullable rather than
   * removed because the field is genuinely on the wire and a caller must see
   * the null; typed `number | null` rather than `null` so the day a promise
   * date exists, this shape does not have to change to carry it.
   */
  onTimeRate: number | null;
  /** Why {@link Courier.onTimeRate} is null, in words the founder can read. */
  onTimeBasis: string;
  /** Mean dispatch→delivery days. NULL when no parcel carried both stamps. */
  avgDaysToDeliver: number | null;
  /** How many parcels that mean is over. 0 ⇒ `avgDaysToDeliver` is null. */
  deliveryTimeSample: number;
  /** `resolved >= 25`. False ⇒ an observation, not a verdict. */
  sufficientEvidence: boolean;
  /** e.g. "6 resolved of 9 dispatched" — the base, in words. */
  basis: string;
}

/** The window a {@link CourierScorecard} was computed over. */
export interface CourierScorecardWindow {
  days: number;
  since: string;
  until: string;
  /**
   * Always "dispatch". A delivery-dated window would silently drop every parcel
   * that never arrived — i.e. hide exactly what the scorecard is for.
   */
  basedOn: string;
}

/**
 * The whole `GET /couriers` response — the ENVELOPE, not just the rows.
 *
 * `listCouriers` returns this rather than `Courier[]` because two fields
 * outside the array are honesty-critical and a seam that dropped them would let
 * a caller quote a capped read as a period total:
 *
 *  · {@link CourierScorecard.truncated} — the window held more parcels than one
 *    request reads, so the rows describe the MOST RECENT N dispatches only.
 *  · {@link CourierScorecard.window} — the period the counts belong to. A count
 *    with no window is a number with no meaning.
 */
export interface CourierScorecard {
  couriers: Courier[];
  window: CourierScorecardWindow;
  totals: {
    parcels: number;
    resolved: number;
    inFlight: number;
    cancelled: number;
    /** Consignments whose Order row is gone — counted, never rated. */
    orphaned: number;
  };
  /** True ⇒ the rows are the most recent N dispatches, NOT the period's totals. */
  truncated: boolean;
  /** The route's own caveats, carried so a reader meets them at the seam. */
  notes: string[];
}

// ---------------------------------------------------------------------------
// Finance
// ---------------------------------------------------------------------------

export interface ExpenseEntry {
  id: string;
  date: string; // YYYY-MM-DD
  category: "ads" | "shipping" | "software" | "refunds" | "cogs" | "fees" | "other";
  amount: number;
  note: string;
}

// ---------------------------------------------------------------------------
// Nova agent data (persisted in the store alongside business data)
// ---------------------------------------------------------------------------

/**
 * PRD autonomy levels:
 * 0 observation only · 1 recommendations · 2 prepared actions ·
 * 3 autonomous low-risk · 4 business operator (guardrails).
 */
export type AutonomyLevel = 0 | 1 | 2 | 3 | 4;

export interface Guardrails {
  /** Largest discount Nova may ever issue, in percent. */
  maxDiscountPct: number;
  /** Largest single price change, in percent of current price. */
  maxPriceChangePct: number;
  /** Largest daily-budget change on a campaign, in percent. */
  maxBudgetChangePct: number;
  /** Never let a price change push margin below this percent. */
  minMarginPct: number;
  /** Purchase orders above this total always need approval. */
  maxAutoPurchaseOrderTotal: number;
  /** Refunds above this amount always need approval. */
  maxAutoRefundTotal: number;
  /**
   * Stage 10 Front Office platform keys (canonical C-16), a FLAT `inbox.*`
   * namespace stored as JSON on the guardrail row — e.g. `inbox.autoIntents`,
   * `inbox.maxAutoOrder`, `inbox.persona`. Typed as `unknown` on purpose:
   * every reader must narrow it, and a MISSING key reads as absent ⇒ the
   * guardrail branch fails closed (`needs_approval`), never open. Module 08
   * owns the key registry and seeds the defaults.
   */
  [inboxKey: `inbox.${string}`]: unknown;
}

export interface AutonomyConfig {
  level: AutonomyLevel;
  guardrails: Guardrails;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Stage 1 "Law" — authority (PRD §4, §5, E-1/E-2/E-3/E-5)
// ---------------------------------------------------------------------------

/**
 * The ladder, named. Numeric storage stays 0–4; these are what the founder
 * reads, and what Nova must use when it narrates its own authority.
 */
export const AUTONOMY_LADDER = {
  0: "Observe",
  1: "Suggest",
  2: "Draft",
  3: "Operator",
  4: "Acting CEO",
} as const;

/**
 * How much rope Nova has in a given door. A ceiling, NOT a second level —
 * effective capability is `min(mode, level)`.
 *
 *  manual     — Nova may only suggest; drafts are held.
 *  assisted   — everything lands as a draft for the founder (the default).
 *  autonomous — level semantics apply as written.
 */
export type NovaMode = "manual" | "assisted" | "autonomous";

/**
 * The canonical guardrail trio (E-2) plus the shipped six as a platform
 * superset. Versioned and immutable: a receipt can always be re-read against
 * the limits that were in force when the action ran.
 */
export interface NovaGuardrailsV2 {
  version: number;
  /** ৳ in MINOR units (poisha) — integer arithmetic, no float drift. */
  dailySpendCapMinor: number;
  maxDiscountPct: number;
  /** Freeform founder locks, e.g. ["SAREE PRICING"]. Data, never instructions. */
  noTouch: string[];
  /** The six shipped numeric caps, evaluated after the trio. */
  platform: Guardrails;
}

/** A duty as the authority seam sees it (mirrored per tenant). */
export interface DutyState {
  key: string;
  minLevel: number;
  enabled: boolean;
  doorExists: boolean;
}

/** Everything `evaluateAuthority` needs, composed in one read per turn. */
export interface AuthorityState {
  level: AutonomyLevel;
  /** L4 stays locked until trust is earned; the gate refuses to exceed this. */
  earnedLevel: AutonomyLevel;
  guardrails: NovaGuardrailsV2;
  /** Keyed by scope: "store" | "door:<module>". */
  modes: Record<string, NovaMode>;
  /** Keyed by duty key. Absent = unknown duty, which fails closed. */
  duties: Record<string, DutyState>;
  /** Store-local day spend already executed today, ৳ minor units. */
  spentTodayMinor: number;
}

/**
 * What the seam decides.
 *
 *  execute — do it now
 *  draft   — prepare a full artifact behind its door for approval (L2 shape)
 *  suggest — a recommendation only, no artifact (L1 shape)
 *  refuse  — do not do it, and say which rule said so
 */
export type AuthorityVerdict = "execute" | "draft" | "suggest" | "refuse";

export interface AuthorityDecision {
  verdict: AuthorityVerdict;
  riskClass: RiskClass;
  /**
   * The exact rule that decided, e.g. `founder_only:bulk_refund`,
   * `guardrail:daily_spend_cap`, `no_touch:saree pricing`, `duty:min_level`.
   * Owner-safe, reproducible, and the string the escalation card shows.
   */
  rule: string;
  /** Founder-facing English explanation. */
  explanation: string;
  /** Founder-facing Bangla explanation (bn+en, §14 NFR). */
  explanationBn: string;
  /** Which guardrail version judged this, for the receipt. */
  guardrailsVersion: number;
  /** Present when a refusal should be raised to the founder, not dropped. */
  escalation?: { reason: string; rule: string; raisedAt: string };
}

export type RiskClass = "low" | "medium" | "high";

export const NOVA_DEPARTMENTS = [
  "ceo",
  "marketing",
  "sales",
  "support",
  "product_research",
  "inventory",
  "operations",
  "shipping",
  "finance",
  "growth",
] as const;

export type NovaDepartment = (typeof NOVA_DEPARTMENTS)[number];

/** Every mutation Nova can perform on the store. */
export type ActionType =
  | "update_campaign"
  | "create_campaign"
  | "publish_social_post"
  | "update_price"
  | "create_discount"
  | "send_customer_message"
  | "resolve_ticket"
  | "create_purchase_order"
  | "switch_supplier"
  | "assign_courier"
  | "import_product"
  /**
   * Stage 10 Front Office (module 02). `send_inbox_reply` is the ONLY verb
   * that can put a byte in front of a customer in Messenger/Instagram: the
   * model never sends, an approved/executed action does. `escalate_conversation`
   * hands the thread to the founder and is never gated at any tier.
   */
  | "send_inbox_reply"
  | "escalate_conversation"
  /**
   * Stage 10 Front Office (module 03). Identity is written by the SERVER, never
   * resolved by the model: `link_customer_identity` asserts a self-stated phone
   * or a server-verified digit check and dakio-api decides whether it matches.
   * `merge_customer_records` rewires financial records across two Customer rows
   * and is therefore always a founder Decision, never a mid-conversation move.
   */
  | "link_customer_identity"
  | "merge_customer_records"
  /**
   * Stage 10 Front Office (module 04). Books a `followup` NovaJob that brings
   * Nova BACK to this thread at a chosen delay. It is the only verb here whose
   * whole effect is in the future: nothing customer-visible happens at T0, and
   * the reply it eventually composes goes through `send_inbox_reply` and the
   * full gate like any other.
   *
   * That is exactly why it is NOT in `NEVER_GATED` alongside
   * `link_customer_identity` — see the set's own comment in authority.ts. What
   * it schedules is a customer touch, so it is not bookkeeping.
   */
  | "schedule_follow_up"
  /**
   * Stage 10 Front Office (module 05) — the three selling verbs.
   *
   * `create_order_from_chat` is the first verb in the phase that writes a
   * FINANCIAL record from a conversation. It is `low` risk deliberately (C-2):
   * `medium` would pin every chat order to draft until the whole store reached
   * L4, coupling the inbox dial to the dashboard's. The control is not the risk
   * class, it is the fail-closed guardrail branch plus `inbox.orderAuto`, which
   * ships FALSE and stays false until module 11 (FD-3).
   *
   * `offer_chat_discount` is the ONLY way Nova may sell below list. It mints a
   * Coupon row; it never touches a price. `update_price` exists and is a
   * store-wide act with its own margin guardrail — answering one customer's
   * haggle by repricing the product discounts every other customer that day.
   *
   * `verify_payment_slip` VERIFIES NOTHING, and the name is the one place that
   * could mislead. Dakio has no payment-gateway API, so it files the customer's
   * CLAIM for the owner to judge and never writes `Order.paid`. It is `high`
   * risk AND in `ALWAYS_DRAFT` (`authority.ts`), because risk alone does not
   * mean "always ask": `verdictForLevel` executes every risk class at level 4,
   * and a trusted store would otherwise auto-"verify" money nobody read.
   *
   * THE INVERSES ARE NOT MEMBERS OF THIS UNION, and that is deliberate — same
   * as `cancel_followup` (module 04) and `unlink_customer` (module 03). An undo
   * is dispatched by dakio-api's `UNDO[undoData.kind]`, keyed by the STRING the
   * executor returns in `undoData.kind`, while nova-ai's `undoers` map is keyed
   * by the VERB name. Two maps, two keying schemes, both correct; the `kind`
   * string is the only bridge, and omitting it is what made a founder tapping
   * Undo see "No inverse is defined for undefined" twice already. The slugs
   * module 05 owns, fixed here so the two repos cannot each invent one:
   *
   *   create_order_from_chat → undoData.kind `cancel_chat_order`
   *                            (cancels a PENDING order only — a parcel already
   *                            with the courier is not undoable by software)
   *   offer_chat_discount    → undoData.kind `deactivate_chat_discount`
   *                            (flips the Coupon inactive; a code already
   *                            redeemed stays redeemed)
   *   verify_payment_slip    → no inverse. Filing a claim moves no money, so
   *                            there is nothing to reverse.
   *
   * Adding them to this union instead would force a RISK_CLASS row, a
   * MINUTES_BY_ACTION row and an executor for a verb nothing dispatches —
   * coverage-shaped, which is the failure `FOUNDER_ONLY`'s note in authority.ts
   * already had to write down once.
   */
  | "create_order_from_chat"
  | "offer_chat_discount"
  | "verify_payment_slip"
  /**
   * Module 06 — delivery coordination. Five verbs, and two of them are the
   * first things Nova does that a customer can feel BEFORE a parcel moves.
   *
   * Undo slugs, fixed here so the two repos cannot each invent one:
   *
   *   open_case              → no inverse. A case is closed with a resolution
   *                            sentence, never deleted; module 09 counts these
   *                            rows and a vanished case is a vanished number.
   *   flag_courier_issue     → no inverse. It is a proposal on a founder's desk,
   *                            and it changes nothing to reverse.
   *   confirm_order_intent   → no inverse. `confirmedAt` records that a human
   *                            said yes; un-saying it is not a thing software
   *                            gets to do. An address change resets it, which is
   *                            a different event with its own reason.
   *   update_order_contact   → no inverse. The previous address is in the case
   *                            facts; "undo" would mean shipping to an address
   *                            the customer has already told us is wrong.
   *   cancel_order_from_chat → undoData.kind `uncancel_chat_order` (restores a
   *                            PENDING order the courier never received).
   */
  | "open_case"
  | "flag_courier_issue"
  | "confirm_order_intent"
  | "update_order_contact"
  | "cancel_order_from_chat"
  /** Founder-only (PRD 5.4): Nova may propose, never execute. */
  | "bulk_refund";

/**
 * Derived compatibility projection of the receipt ({reason, expectedImpact,
 * confidence}) kept for existing readers. The receipt is the source of truth
 * since Stage 0 — never author a justification directly.
 */
export interface ActionJustification {
  /** Why Nova is doing this, stated with evidence. */
  reason: string;
  /** What Nova expects to happen, quantified where possible. */
  expectedImpact: string;
  /** Nova's own confidence, 0-1. */
  confidence: number;
}

/** One supporting observation behind an action (PRD E-8 receipt.evidence). */
export interface ReceiptEvidence {
  /** Where the observation came from, e.g. "orders", "guardrail", "campaign cmp-…". */
  source: string;
  /** The observation itself, e.g. "0 orders in 30d; 2 campaigns scheduled". */
  note: string;
  /** Optional named metric this evidence cites. */
  metric?: string;
  /** Optional value for the metric. */
  value?: string | number;
  /** Optional evidence window, e.g. "30d". */
  window?: string;
}

/**
 * The PRD E-8 receipt — the founder-facing evidence record on EVERY state
 * change (executed, prepared, and blocked alike). A write missing its receipt
 * is a failed write (§16.2, enforced at the dakio-api layer).
 */
export interface ActionReceipt {
  reason: string;
  expectedImpact: string;
  /** 0-1. */
  confidence: number;
  /** Non-empty for post-Stage-0 rows; empty only on `migrated` backfills. */
  evidence: ReceiptEvidence[];
  /** Display snapshot before the mutation (null for drafts/refusals). */
  before: Record<string, unknown> | null;
  /** Display snapshot after the mutation (null for drafts/refusals). */
  after: Record<string, unknown> | null;
  /** True on rows backfilled from the pre-Stage-0 justification shape. */
  migrated?: boolean;
}

export type ActionStatus =
  | "executed" // ran immediately under current autonomy level
  | "prepared" // queued, waiting for owner approval
  | "blocked" // guardrail or autonomy level forbids it
  | "rejected" // owner said no
  | "undone"; // executed, then rolled back

export type ActionActor = "nova" | "founder" | "system";

export interface ActionRecord {
  id: string;
  type: ActionType;
  department: NovaDepartment;
  title: string;
  /** Tool input that produced (or will produce) the mutation. */
  payload: Record<string, unknown>;
  /** Derived from `receipt` — kept for readers that predate Stage 0. */
  justification: ActionJustification;
  /** The E-8 receipt. Required on every write since Stage 0. */
  receipt: ActionReceipt;
  riskClass: RiskClass;
  status: ActionStatus;
  /** Human-readable outcome, set when executed. */
  outcome: string | null;
  /** Whether this action can be rolled back after execution. */
  undoable: boolean;
  /** Snapshot the executor needs to roll back (internal — not the receipt's display snapshot). */
  undoData: Record<string, unknown> | null;
  /** Who performed it: nova | founder | system. */
  actor: ActionActor;
  /** The door record this action touched, e.g. "coupon:ck…". */
  targetRef: string | null;
  /** E-22 department agent id — null until phase 14. */
  agentId: string | null;
  /** E-5 duty key — null until phase 07 seeds the registry. */
  dutyRef: string | null;
  /** executedAt + 24h on undoable executed actions (undo is a right with a clock). */
  undoDeadline: string | null;
  undoneAt: string | null;
  createdAt: string;
  decidedAt: string | null;
  executedAt: string | null;
}

export interface ActivityEntry {
  id: string;
  at: string;
  department: NovaDepartment;
  kind: "action" | "analysis" | "communication" | "report" | "alert";
  title: string;
  detail: string;
  /** Human-equivalent minutes of work this saved the founder. */
  minutesSaved: number;
  /** Revenue this activity influenced, when measurable. */
  revenueInfluence: number;
  actionId: string | null;
  /**
   * Business entity this activity relates to (cart id, ticket id, order id …).
   * Lets the nightly attribution pass join, e.g., a cart-recovery message to
   * the order it recovered and replace the heuristic influence with actuals.
   */
  relatedId?: string | null;
  /**
   * How `revenueInfluence` was derived. `estimated` = heuristic at write time;
   * `measured` = an attribution pass matched it to a real outcome (with a note).
   */
  revenueBasis?: "estimated" | "measured";
  /** Provenance for a measured influence (e.g. the matched order id). */
  revenueProvenance?: string | null;
}

export type MemoryNamespace =
  | "goals"
  | "brand"
  | "preferences"
  | "rules"
  | "insights"
  | "experiments"
  | "customers";

/**
 * Where a memory came from. Governs trust and owner-visibility (Phase 04):
 * `owner` = the founder told Nova; `nova` = Nova wrote it during a turn;
 * `reflection` = distilled by a nightly reflection job; `system` = seeded.
 */
export type MemorySource = "owner" | "nova" | "reflection" | "system";

/** Audit trail tying a learned memory back to the episodes that produced it. */
export interface MemoryProvenance {
  /** Action ids this memory was distilled from (rejections, experiments). */
  actionIds?: string[];
  /** Session that wrote it, when known. */
  sessionId?: string;
  /** Free-form note, e.g. the reflection summary line. */
  note?: string;
}

export interface MemoryEntry {
  namespace: MemoryNamespace;
  key: string;
  value: string;
  updatedAt: string;
  /**
   * Fields added in Phase 04. Optional so Phase 1–3 seeds and writers that
   * only carry {namespace,key,value} still type-check; the service and
   * backend normalize missing values to defaults (source "owner", weight 1).
   */
  source?: MemorySource;
  provenance?: MemoryProvenance | null;
  /** Retrieval boost; decays over time and via the forgetting pass. */
  weight?: number;
  /** Optional TTL — the entry stops being retrieved after this instant. */
  expiresAt?: string | null;
  /**
   * Semantic embedding used for vector recall. Filled asynchronously by the
   * embed worker (an "outbox": entries with `embedding == null` are pending).
   * Never rendered into the model prompt — an index, not content.
   */
  embedding?: number[] | null;
}

/** The relaxed input accepted by `upsertMemory` — Phase 04 fields optional. */
export interface MemoryUpsert {
  namespace: MemoryNamespace;
  key: string;
  value: string;
  source?: MemorySource;
  provenance?: MemoryProvenance | null;
  weight?: number;
  expiresAt?: string | null;
  embedding?: number[] | null;
}

// ---------------------------------------------------------------------------
// Procedural memory — playbooks (reflection can propose; owner promotes)
// ---------------------------------------------------------------------------

export type PlaybookStatus = "candidate" | "active" | "retired";

export interface NovaPlaybook {
  id: string;
  name: string;
  description: string;
  /** The procedure body, served as a dynamic skill when `active` (Phase 06). */
  markdown: string;
  status: PlaybookStatus;
  /** What this playbook was distilled from (action ids, source note). */
  createdFrom: MemoryProvenance | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Experiments — hypotheses evaluated against actuals (data flywheel)
// ---------------------------------------------------------------------------

export type ExperimentStatus = "running" | "won" | "lost" | "inconclusive";

export interface NovaExperiment {
  id: string;
  hypothesis: string;
  /** Actions that enacted the experiment (a campaign change, a price test). */
  actionIds: string[];
  /** What the experiment moves, e.g. "roas7d" or "revenue7d". */
  metric: string;
  baseline: number;
  target: number;
  actual: number | null;
  status: ExperimentStatus;
  startedAt: string;
  evaluatedAt: string | null;
}

export interface NovaReport {
  id: string;
  kind: "morning" | "night_plan" | "weekly_strategy" | "pulse" | "custom";
  title: string;
  /** Markdown body, rendered by the Dakio dashboard. */
  body: string;
  /** Phase 05 — a job-filed report passes its job's dedupeKey so a re-leased rerun re-files the SAME row instead of a duplicate. Omitted for ad hoc (non-job) reports. */
  dedupeKey?: string | null;
  /**
   * Per-department morning notes — `morning` reports only. The same turn that
   * writes the CEO body writes one short note per department it has something
   * REAL to say about, and dakio-api stores them on the day's NovaBrief so each
   * Nova department room can open with its own overnight line.
   *
   * Omit a department you have nothing real for: the room renders an honest
   * quiet line from its own live state. Never write a note to fill the slot.
   */
  departments?: { department: NovaDepartment; body: string }[];
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Inbox — inbound store events (Phase 2.3). Dakio enqueues these on real
// commerce mutations (order created/updated, cart abandoned); Nova drains
// unprocessed ones on its regular schedule cadence instead of only ever
// discovering them by polling reads. Persisted store-side (Nova is stateless),
// same as memory/actions/activity/reports.
// ---------------------------------------------------------------------------

export type InboxEventType = "order.created" | "order.updated" | "cart.abandoned";

export interface InboxEvent {
  id: string;
  eventType: InboxEventType;
  /** Shape depends on eventType — see `emitOrderCreated`/`emitOrderUpdated`/`emitCartAbandoned` in dakio-api's novaEvents.js. */
  payload: Record<string, unknown>;
  receivedAt: string;
  processedAt: string | null;
}

// ---------------------------------------------------------------------------
// Front Office — the Messenger/Instagram inbox (Stage 10). These are VIEWS of
// dakio-api rows, not Nova-owned state: the conversation, its transcript, and
// the outbound ledger all live in dakio-api, which is the sole authority on
// the thread lock, the 24h Meta window, and whether a send actually happened.
// Nova reads them per turn and never caches a fact only in a session
// (cold-start invariant, module 02 D1).
// ---------------------------------------------------------------------------

/** Adapters that can carry a customer conversation today (module 01 D11). */
export type InboxPlatform = "messenger" | "instagram";

/** Who wrote a message. `founder_external` = typed from Meta Business Suite. */
export type InboxActor = "customer" | "nova" | "founder" | "founder_external" | "system";

/** The reply's script/register, mirrored from the customer (module 02 D4). */
export type InboxLanguage = "bn" | "banglish" | "en";

/**
 * The closed `NovaPromise.kind` set (module 03 D7). Mirrors the DB column
 * byte-for-byte and `PROMISE_KINDS` in `nova/schemas.ts` — three copies of one
 * taxonomy, because the model names the kind, zod rejects anything else, and
 * Postgres stores the string. A value that exists in only two of the three is a
 * promise that either cannot be declared or cannot be written.
 */
export type PromiseKind =
  | "follow_up_info"
  | "delivery_eta"
  | "courier_check"
  | "restock_notify"
  | "refund"
  | "replacement"
  | "callback_founder"
  | "price_hold"
  | "other";

/**
 * `conversationOut` (module 02 D10) — frozen base shape. `senderId` is
 * deliberately NOT exposed: the PSID is Meta-derived identity that Nova never
 * needs and that the data-deletion path must be able to erase cleanly.
 */
export interface InboxConversationView {
  id: string;
  platform: string;
  senderName: string | null;
  /** Set only by an EARNED identity link (module 03) — never guessed. */
  customerId: string | null;
  /** 'nova' | 'founder' | null. `founder` means the thread is handed over. */
  handledBy: string | null;
  /** Set ONLY by a human takeover. Nova can never clear it. */
  novaLockedAt: string | null;
  /** Per-thread founder switch, server-enforced. */
  novaEnabled: boolean;
  lastIntent: string | null;
  escalatedAt: string | null;
  lastInboundAt: string | null;
  /** lastInboundAt + 24h — the Meta messaging window. Past = no sends, ever. */
  windowExpiresAt: string | null;
  lastMessageAt: string | null;
}

/** `messageOut` (module 02 D10) — one line of the transcript. */
export interface InboxMessageView {
  id: string;
  direction: "in" | "out";
  actor: string | null;
  text: string | null;
  attachmentUrl: string | null;
  attachmentType: string | null;
  /** Outbound rows: the reply's purpose slug. */
  purpose: string | null;
  /** The ledger receipt behind this message. Every Nova bubble has one. */
  novaActionId: string | null;
  sentAt: string;
  /** Meta's own event timestamp — the ordering truth, unlike `sentAt`. */
  metaTimestamp: string | null;
}

/** What `get_conversation` reads: the thread as dakio-api sees it. */
export interface InboxThread {
  conversation: InboxConversationView;
  /** Oldest → newest, capped by the caller (≤50). */
  messages: InboxMessageView[];
  /**
   * The server-assembled customer block, rendered TRUSTED (it is Dakio's own
   * data, not customer text). Shape is deliberately open here: module 03 owns
   * the `customer360Out` serializer and its redaction boundary, and nova-ai
   * renders that block without ever authoring it. `null` = an unlinked thread,
   * which is the honest default — the identity join is earned, never guessed.
   */
  customer: Record<string, unknown> | null;
  /**
   * Basis-only proposal (module 03 D2, the MEDIUM tier). `{basis}` and nothing
   * else: the candidate's id and data deliberately never cross this boundary,
   * because a proposal licenses exactly one verification question and grants
   * zero access. `null` on a linked or unproposed thread.
   *
   * It is declared here for the same reason `customer` is — the wire body
   * assembles field by field on both sides, so a key nova-ai does not name is a
   * key the server sends and the client silently drops.
   */
  proposal: { basis: string } | null;
  /**
   * The server-computed Next-Best-Action block (module 04 D6), rendered
   * TRUSTED beside `customer` for the same reason: dakio-api's `novaNba.js`
   * assembles it from the journey row, the 360 and the guardrails — no part of
   * it is a stranger's typing.
   *
   * OPTIONAL, not required, and that is deliberate: a dakio-api that predates
   * module 04 simply does not send the key, and "this server has no journey
   * engine" must stay distinguishable from "this thread has no journey". Both
   * read as `null` to the model, but only one of them is a bug.
   */
  nba?: NbaBlock | null;

  /**
   * Nova Live Context (Sales-Engine Phase 2, doc 05 Part A) — dakio-api's
   * structured understanding of the sale in progress.
   *
   * Typed loosely on purpose in this phase. The server owns the shape and it is
   * still moving: Phase 3 adds hydration and freshness, Phase 4 adds stage,
   * missing fields and next action. Pinning a narrow interface here would make
   * every server-side addition a cross-repo lockstep deploy, for a block no
   * code path reads yet. It tightens in Phase 4, when the register first tells
   * the model the state exists and something actually depends on the fields.
   */
  state?: Record<string, unknown> | null;
}

/** One human-sized bubble. 1–3 of these are a reply (canonical C-12). */
export interface InboxChunk {
  text: string;
}

/** Body of `POST /api/v1/inbox/conversations/:id/reply` (module 02 D10). */
export interface InboxReplyRequest {
  chunks: InboxChunk[];
  /** Idempotency + receipt correlation id for this send. */
  novaActionId: string;
  /** Newest inbound seen when composing — the staleness anchor. */
  inReplyToMessageId: string;
  intent: string;
  language: InboxLanguage;
  purpose?: string | null;
  /**
   * Module 07 D10: which order this message is about. Carried only for
   * `purpose:'review_ask'` today, where it is the key "once per order, EVER" is
   * written under. dakio-api rides it on the stored chunk rather than an
   * `InboxOutbound` column and stamps `stageData.reviewAsks[orderId]` at
   * send-confirm — never at enqueue, or a cancelled send would burn the
   * customer's single ask for that order.
   */
  orderId?: string | null;
  /** `instant` skips the human-pacing engine (founder already waited). */
  timing?: { mode: "human" | "instant" };
  /** D6 identity-disclosure counters for this turn. */
  disclosure?: { asked: boolean; given: boolean };
  /**
   * Module 03 D7: the commitment this reply makes, declared at send time —
   * never mined from the text afterwards. dakio-api creates the NovaPromise row
   * in the SAME transaction as the InboxOutbound and deletes it if the send is
   * ever canceled, because an unsent promise was never made.
   */
  promise?: { text: string; kind: PromiseKind; dueAtISO: string };
}

/** What the reply route returns once the send is QUEUED (never "sent"). */
export interface InboxReplyResult {
  outboundId: string;
  /** When chunk 1 is due to leave, per the human-timing engine (D7). */
  scheduledAt: string;
  chunks: InboxChunk[];
  /** The first bubble's message id — the action's `targetRef`. */
  firstMessageId: string;
}

/** Body of `POST /api/v1/inbox/conversations/:id/handover` (module 08). */
export interface InboxHandoverRequest {
  novaActionId: string;
  reason: string;
  department: string;
  summary: string;
  summaryBn: string;
  suggestedReply?: string;
  suggestedAction?: string;
  factsChecked: { source: string; note: string }[];
}

export interface InboxHandoverResult {
  escalated: boolean;
  /** The escalation Decision the founder answers, when one was authored. */
  decisionId: string | null;
  /** Whether the deterministic holding line went to the customer. */
  holdingSent: boolean;
  /** True when an open escalation already existed and the brief was updated. */
  alreadyEscalated?: boolean;
}

/** Body of `POST /api/v1/inbox/conversations/:id/link-customer` (module 03 D4). */
export interface LinkCustomerRequest {
  /** Idempotency + receipt correlation id — this route's `w()` key (D4). */
  novaActionId: string;
  /** Self-stated, first person. Normalized and variant-matched server-side. */
  phone?: string;
  /**
   * The server compares; the model never holds the digits it is checking, and
   * never chooses WHO is checked — the route tests the conversation's own
   * `proposedCustomerId` and ignores this id for selection. `customerId` is
   * therefore OPTIONAL and advisory: it exists only so that a caller which
   * named a different candidate is visible on the failure receipt. Optional
   * because `InboxThread.proposal` is basis-only, so the customer plane has no
   * way to learn a candidate id in the first place.
   */
  verify?: { customerId?: string; lastDigits: string };
}

/**
 * `matched:false` is an ANSWER, not a failure: zero matches stores
 * `claimedPhone` for a later join, and >1 match returns `mergeProposed:true`
 * with the conversation deliberately still unlinked (D2's NEVER tier —
 * ambiguity resolves to "unknown customer", always).
 */
export interface LinkCustomerResult {
  matched: boolean;
  customerId?: string;
  channelWritten: boolean;
  mergeProposed?: boolean;
}

/**
 * `promiseOut` (module 03 D-APIs) — one row of the commitments ledger.
 *
 * Memory stores what Nova BELIEVES; this is what Nova OWES. It carries no
 * customer text beyond the commitment itself, which Nova authored.
 */
export interface InboxPromise {
  id: string;
  customerId: string | null;
  conversationId: string | null;
  /** 'messenger' | 'instagram' | 'sms' — 'sms' has no v1 sender (D8 rung 2). */
  channelKind: string;
  madeBy: "nova" | "founder";
  text: string;
  kind: PromiseKind;
  dueAt: string;
  status: "open" | "kept" | "broken" | "released";
  keptAt: string | null;
  brokenAt: string | null;
}

/**
 * Body of `PATCH /api/v1/inbox/promises/:id`. `broken` is SWEEP-ONLY and is
 * deliberately absent from this union — a turn may keep or release a promise,
 * it may never declare its own failure away.
 */
export interface PromiseSettleRequest {
  status: "kept" | "released";
  /** The action that fulfilled it. Also the `w()` idempotency key when present. */
  keptActionId?: string;
  releasedReason?: string;
}

/* ── Front Office — lifecycle & NBA (Stage 10 module 04) ────────────────────
 *
 * Same rule as identity, one layer up: the SERVER decides. The journey stage is
 * a deterministic reducer's output (D1.1 — "stage is code, never model
 * output"), the eligible-candidate list is computed from it, and the model
 * chooses among what it is handed. Nothing below is a shape nova-ai authors;
 * these are the views of dakio-api rows the runtime reads and the two writes it
 * is allowed to make.
 */

/**
 * The delays a follow-up may be booked at (module 04 D7). Closed on purpose:
 * the model picks from the list the NBA block hands it and cannot invent "in 10
 * minutes", which is a pressure loop, not a follow-up.
 *
 * Mirrored by `FOLLOWUP_DELAYS` in `nova/schemas.ts` (the zod enum the model is
 * validated against) and by the route's own allow-list server-side — the same
 * three-copies-of-one-taxonomy arrangement as {@link PromiseKind}, and for the
 * same reason: the model names it, zod rejects anything else, dakio-api stores
 * the string.
 */
export type FollowupDelay = "2h" | "4h" | "24h" | "3d";

/**
 * One row of the NBA candidate list. `eligible:false` always carries a `reason`
 * from dakio-api's closed reason-code set (`stage_not_X`, `window_closed`,
 * `quiet_hours`, `touch_budget_reached`, `unanswered_streak`, `no_consent`,
 * `opted_out`, …) — an ineligible candidate with no reason is one the model can
 * only guess about, and it will guess out loud to the customer.
 *
 * `action` is typed `string`, not a union, deliberately. The candidate
 * vocabulary is closed and VERSIONED server-side (D6, `nbaVersion`), and a
 * fourth hand-copy of it here would be a taxonomy with no CI check keeping it
 * honest — the failure mode would be a candidate dakio-api computes and nova-ai
 * silently type-errors on. Read it, do not re-declare it.
 */
export interface NbaCandidate {
  action: string;
  eligible: boolean;
  /** Closed reason code. Present whenever `eligible` is false. */
  reason?: string;
  /**
   * What `evaluateAuthority` WILL do — advisory mirror, never the gate itself.
   *
   * All FOUR verdicts plus `none`, because dakio-api's mirror (`gateFor`) can
   * return every one of them and its own suite pins two this union used to
   * exclude: `"suggest"` when a founder has lowered the duty's `minLevel` to 1,
   * and `"none"` for `do_nothing`, which has no verb to judge. A value the
   * server sends and this type does not name reads as impossible to anyone
   * writing the next consumer.
   */
  gate?: "auto" | "suggest" | "draft" | "refuse" | "none";
  /** For `schedule_follow_up`: which delays are legal in this stage. */
  allowedDelays?: FollowupDelay[];
  /** Verb-specific limits the server already applied (e.g. discount bounds). */
  bounds?: Record<string, unknown>;
  /** Founder-facing note about the cap that let this through. */
  capNote?: string;
}

/**
 * The D6 context block, injected every turn and on every fired follow-up.
 *
 * Assembled ONLY by dakio-api (`src/lib/novaNba.js`), which is also the single
 * redaction point: like the 360, nothing customer-authored belongs in it — it
 * carries flags, ids and server-computed state, and the customer's own words
 * stay in the fenced transcript where authorship is visible. A field added here
 * that echoes back what the customer typed would cross the trust boundary
 * silently, because this block is rendered UNFENCED.
 *
 * The nested shapes dakio-api owns outright (`stageData`, `priors`) stay open
 * for the same reason `InboxThread.customer` does: naming them here would freeze
 * a serializer this repo does not write.
 */
export interface NbaBlock {
  /** Bumped when the candidate vocabulary or reason codes change. */
  nbaVersion: number;
  journey: {
    /**
     * The id the `intent-observed` callback is posted against, or `null` when
     * the reducer has not created a row for this thread yet — the server's own
     * honest "there is nothing to call back about", not a fault. A caller that
     * treats it as always-present posts to `/journeys/undefined/intent-observed`.
     */
    id: string | null;
    stage: string;
    /** Fixed per-stage string (D11) — what "forward" means here. `null` for a
     *  stage this build has no goal text for. */
    stageGoal: string | null;
    enteredAt: string;
    hoursInStage: number;
    /** Where an `at_risk` journey returns to once it resolves. */
    resumeStage: string | null;
    stageData: Record<string, unknown>;
  };
  customer: {
    /** false for stranger/inquirer — an unlinked thread is the honest default. */
    known: boolean;
    segment: string | null;
    ordersCount: number;
    ltvBdt: number;
    riskLevel: string | null;
    language: string | null;
    openOrder: Record<string, unknown> | null;
    /** Open `NovaPromise` rows (module 03) — what Nova already owes. */
    promises: { promiseId: string; text: string; dueAt: string }[];
  };
  /** Meta's 24h window, as dakio-api computed it. Past = no sends, ever. */
  window: { open: boolean; expiresAt: string | null };
  quietHours: { quietNow: boolean; tz: string; nextAllowedAt: string | null };
  touchBudget: { proactiveUsedThisWeek: number; max: number; unansweredStreak: number };
  /**
   * Follow-ups outstanding on this thread — `due`, plus the `leased` row when
   * one is firing right now, which is how a fired follow-up's own turn finds
   * itself here by job id.
   *
   * NO `note`. D6's example row carries one and the server does not send it:
   * the note is the model-authored `reason` string, founder-facing free text
   * that dakio-api defangs but does not mask, and re-rendering it into unfenced
   * model context would need a second redaction point the block deliberately
   * does not have. `plannedIntent` (a closed slug, `null` when the stored value
   * is not slug-shaped) is what crosses instead, with `promiseBacked` marking
   * the rows that are paying off a module 03 debt rather than nudging.
   */
  commitments: {
    jobId: string;
    dueAt: string;
    plannedIntent: string | null;
    promiseBacked: boolean;
  }[];
  candidates: NbaCandidate[];
  /** Ledger-derived counts, `sample`-marked so thin data reads as thin. */
  priors: Record<string, unknown>;
}

/**
 * Body of `POST /api/v1/inbox/followups` (module 04 D7).
 *
 * `scheduledByActionId` is BOTH the receipt correlation id and the route's
 * `w()` idempotency key (sent as the `Idempotency-Key` header, since that is
 * what `novaIdempotency.js` reads — a body field named "key" would key nothing).
 * A retry after a network timeout must not book two commitments for one
 * decision.
 */
export interface ScheduleFollowupRequest {
  conversationId: string;
  /** From the NBA block. Null when the thread has no journey row yet. */
  journeyId?: string | null;
  delay: FollowupDelay;
  /** Why Nova is coming back — founder-facing, lands on the commitments list. */
  reason: string;
  /** The intent the follow-up expects to serve; decides its department. */
  plannedIntent: string;
  scheduledByActionId: string;
  /**
   * Module 03's debts ride the same job kind (canonical C-15). Set ONLY by a
   * promise-fulfilment producer: a job carrying it is never superseded by an
   * NBA nudge and never cancelled as one, because a customer writing back
   * cancels a nudge but does not settle a debt.
   */
  promiseId?: string;
}

/**
 * `superseded` names the job this one replaced — one outstanding NBA follow-up
 * per conversation (D7). It is `null`, not absent, when nothing was replaced:
 * "nothing to supersede" and "this server does not supersede" must not read the
 * same on a receipt.
 */
export interface ScheduleFollowupResult {
  jobId: string;
  dueAt: string;
  superseded: string | null;
}

/**
 * Body of `POST /api/v1/inbox/journeys/:id/intent-observed` (module 04 D5
 * pass 2 / D12) — one callback per turn.
 *
 * This is how a MODEL judgement becomes a DETERMINISTIC transition without the
 * model ever setting a stage: it reports the intent it classified and the NBA
 * candidate it chose, and the server's table decides what that means. Sending
 * `nbaAction: "do_nothing"` is what makes chosen silence countable
 * (`journey.silences_chosen`) instead of indistinguishable from a dropped turn.
 */
export interface IntentObservedRequest {
  intent: string;
  /** The inbound this turn answered. Idempotency is per (journeyId, messageId). */
  messageId: string;
  nbaAction?: string;
  nbaReason?: string;
}

/**
 * What the reducer's second pass did with it — stage AFTER, plus what moved.
 *
 * The row shape is dakio-api's `transitionOut` verbatim. It was declared with a
 * `cause` field neither backend can populate: the server names that column
 * `reason` (it carries the transition rule, e.g. `journey.intent_observed`), and
 * `DemoStore` returns `transitions: []`. A declared field nothing can fill is a
 * contract lie in the direction that costs most — it reads as always-absent.
 */
export interface IntentObservedResult {
  stage: string;
  transitions: {
    id: string;
    fromStage: string | null;
    toStage: string;
    /** The transition rule that fired, or `null` — NOT a free-text cause. */
    reason: string | null;
    occurredAt: string;
  }[];
}

/* ── Front Office — selling & conversion (Stage 10 module 05) ───────────────
 *
 * The wire shapes behind `/api/v1/store/*`'s selling surface. Two rules bind
 * every one of them and both are rules about what is ABSENT:
 *
 * 1. **NO MINOR UNITS.** dakio-api holds money in WHOLE TAKA — `Order.total`,
 *    `OrderItem.unitPrice` and `Coupon.amount` are Decimals in taka, and
 *    `Tenant.deliveryInsideDhaka = 60` is sixty taka. Only the guardrail
 *    REGISTRY is denominated in poisha (`inbox.highValueMinor`,
 *    `dailySpendCapMinor`). A field here named `…Minor` would be a lying name
 *    on a wire that carries taka, and the first reader to trust it ships a 100×
 *    error at a real customer's door.
 * 2. **NO PRICE LEVER.** {@link ChatOrderRequest} carries no `discount`, no
 *    `paid`, no `unitPrice` and no `total`. The server prices the order from
 *    the catalogue; the only honest way to sell below list is a Coupon row.
 *    The merchant order route accepts a raw client `discount` that flows
 *    unvalidated into the total — that is precisely the lever this shape exists
 *    not to hand a model.
 */

/** One line of a chat order on the wire. No price field, by rule 2 above. */
export interface ChatOrderItemInput {
  productId: string;
  /**
   * The variant the customer actually confirmed. It reaches `OrderItem.variantId`
   * — a plain string column with NO foreign key, deliberately, because the
   * merchant product editor deletes variants by name diff and a rename must not
   * erase the record of which size was sold. Consequence for readers: the value
   * may be dangling, so resolve it with an explicit lookup and tolerate a miss.
   */
  variantId?: string;
  qty: number;
}

/**
 * Body of `POST /api/v1/store/orders` (module 05 D4).
 *
 * `novaActionId` is BOTH the receipt correlation id and the route's `w()`
 * idempotency key (sent as the `Idempotency-Key` HEADER, since that is what
 * `novaIdempotency.js` reads — a body field of the same name would key
 * nothing). It matters more here than anywhere else on this router: `w()` is
 * NOT a mutex, so the route's own at-most-once guarantee is a conditional
 * read-back on `Order.novaActionId` before insert, and that column is indexed
 * for exactly this call.
 *
 * The buyer's details are on the payload rather than looked up because the
 * customer-360 deliberately shows the model a MASKED phone and no street
 * address. Everything a parcel needs therefore comes from what the customer
 * typed in this thread — every time, by design, not as a fallback.
 */
export interface ChatOrderRequest {
  /**
   * The thread this was agreed in. Named for the COLUMN it lands on
   * (`Order.sourceConversationId`) rather than `conversationId`, because that
   * column is a plain string with NO foreign key: Meta's data-deletion callback
   * hard-deletes `InboxConversation` rows, so a reader must tolerate an id that
   * resolves to no conversation. It is also what the route derives the identity
   * join and `sourceChannel` from.
   */
  sourceConversationId: string;
  customerName: string;
  /** As the customer typed it. The SERVER normalizes and validates. */
  customerPhone: string;
  customerCity: string;
  /** Decides the shipping charge server-side (inside vs outside Dhaka). */
  customerDistrict: string;
  customerAddress?: string;
  items: ChatOrderItemInput[];
  /** Re-validated server-side (active, expiry, maxUses, minOrder) or refused. */
  couponCode?: string;
  /** Free-text order note. Never a price instruction — there is no such lever. */
  note?: string;
  novaActionId: string;
  // NO `sourceChannel`, deliberately, even though the route accepts one. It is
  // RESOLVED from the thread's own platform whenever `sourceConversationId` is
  // present, and it is the one provenance column that OUTLIVES the conversation
  // — so the durable answer to "where did this sale come from" must not be a
  // field a caller can set to disagree with the thread it names.
}

/**
 * What `POST /api/v1/store/orders` answers with (module 05 D4).
 *
 * Every money field is WHOLE TAKA. There is no `subtotal` and no `discount`:
 * `chatOrderOut` is its own serializer with its own contract, and it returns
 * what the next sentence to the customer is built from — what the parcel costs,
 * what the courier collects, and where they can watch it.
 *
 * `codAmount` is read from `Order.due`, NOT from `total`. The two diverge the
 * moment an advance is ever recorded, and the courier consignment is built from
 * `due` — quoting the total at the door would be quoting a number nobody owes.
 *
 * `trackingUrl` is `string | null` and the null is real: it needs
 * `DAKIO_STOREFRONT_URL` plus a slug, and a path-based store gets the shop's
 * tracking FORM rather than a per-order deep link (only the custom-domain
 * storefront tree has `track/[code]`). Never render this without checking it —
 * a dead tap after a COD confirmation is worse than no link.
 */
export interface ChatOrderResult {
  id: string;
  orderNumber: string;
  total: number;
  shippingCharge: number;
  /** What the courier collects at the door, from `Order.due`. WHOLE TAKA. */
  codAmount: number;
  status: string;
  /** The customer row the order created or matched, once identity resolved. */
  customerId: string | null;
  trackingUrl: string | null;
}

/**
 * The discount arms a chat may offer (module 05 D6).
 *
 * Byte-equal to `CHAT_DISCOUNT_MECHANISMS` in `nova/schemas.ts`, which is the
 * MODEL-facing copy, exactly as {@link FollowupDelay} pairs with
 * `FOLLOWUP_DELAYS`. Two copies of one taxonomy on purpose: this file is the
 * wire, that one is the tool schema, and `lib/types.ts` importing from
 * `lib/nova/schemas.ts` would invert the dependency the whole `store/` layer
 * rests on. A value present in only one of them is a mechanism the model can
 * name and the client cannot send, or the reverse.
 */
export type ChatDiscountMechanism = "percent" | "fixed" | "free_delivery";

/**
 * Body of `POST /api/v1/store/discounts/validate` (module 05 D6).
 *
 * `subtotal` is WHOLE TAKA and is REQUIRED. The merchant-plane validate route
 * (`coupons.js`) guards its `minOrder` test with `if (subtotal && …)`, so a
 * caller that omits it gets `valid: true` on a coupon whose floor it is nowhere
 * near — and for a FIXED coupon, the full discount back with it. That guard is
 * the one piece of those semantics module 05 deliberately does not port.
 */
export interface CouponValidationRequest {
  code: string;
  subtotal: number;
}

/**
 * Why a coupon does not hold. Closed set, server-authored, MACHINE-facing —
 * the customer never hears a slug; the shopkeeper script turns it into a
 * sentence, and only one of the five is a fact the buyer can act on.
 */
export type CouponRefusal =
  | "not_found"
  | "inactive"
  | "expired"
  | "max_uses_reached"
  | "below_min_order";

/**
 * What the coupon check answers (module 05 D6).
 *
 * A refusal is a 200 with `valid: false`, not a 4xx: "is this code good?"
 * answered "no" is a successful query. `discount` is WHOLE TAKA and is what
 * THIS subtotal would actually get — already resolved from percent or fixed and
 * already clamped to the cart — so nobody recomputes a percentage model-side.
 *
 * `minOrder` comes back on `below_min_order` and on no other reason, because it
 * is the only one where the number helps the buyer ("৳২০০ এর অর্ডার হলে কুপনটা
 * কাজ করবে"). Naming an expiry date or a usage counter would be telling a
 * customer about the shop's bookkeeping.
 */
export interface CouponValidation {
  valid: boolean;
  /** Echoed back upper-cased, as the server stores and matches it. */
  code: string;
  discount: number;
  reason?: CouponRefusal;
  /** Present only on `below_min_order`. WHOLE TAKA. */
  minOrder?: number;
  /** Present only on a valid code. */
  type?: DiscountKind;
}

/**
 * One configured shop policy (module 05 D2), keyed by an OPEN string —
 * `exchange`, `warranty`, `wholesale`, whatever the shop actually wrote down.
 *
 * The absence of a row is the product's answer, not a gap in the read: it means
 * the merchant has never told Nova this rule, which is precisely what the
 * `policy_gap` escalation reason reports. `textEn` is optional because a
 * Bangladeshi merchant writing one version writes the Bangla one.
 */
export interface TenantPolicyView {
  key: string;
  textBn: string;
  textEn?: string | null;
}

/**
 * `GET /api/v1/store/settings` (module 05 D2).
 *
 * `deliveryInsideDhaka` / `deliveryOutsideDhaka` are Int columns in WHOLE TAKA
 * — 60 and 120 mean sixty and one hundred twenty taka. They are named without a
 * unit suffix for the same reason nothing else here carries one: the module doc
 * called them `…Minor`, and following that name literally ships a 100× shipping
 * charge.
 *
 * `Tenant.deliveryRates Json?` is deliberately NOT here. It exists and the
 * merchant can edit it, but NO dakio-api shipping path reads it — both order
 * paths use only the two Int columns. Exposing it would hand Nova a rate table
 * the server will not honour, so Nova would quote a delivery charge the order
 * then contradicts.
 */
export interface StoreSettings {
  storeName: string;
  /**
   * The shop's own storefront root, or null when neither a verified custom
   * domain nor `DAKIO_STOREFRONT_URL` is configured. Null is common, not
   * exceptional — never build a link out of it without checking.
   */
  storefrontUrl: string | null;
  deliveryInsideDhaka: number;
  deliveryOutsideDhaka: number;
  /**
   * A constant `true`, not a column: the storefront checkout has exactly one
   * payment method. It is stated rather than omitted so Nova can say it out
   * loud, which in BD DM commerce is the most reassuring sentence there is.
   */
  codAvailable: boolean;
  /** Empty until the merchant configures one. Empty is an ANSWER — see above. */
  policies: TenantPolicyView[];
}

/**
 * `GET /api/v1/store/customers/risk?phone=` (module 05 D4.2).
 *
 * These are `calculateCustomerRisk`'s REAL keys plus one. The module doc
 * promised `{riskLevel, rtoCount, ordersCount, cancelledCount}` and not one of
 * those four is a key that function produces — it returns `level`, not
 * `riskLevel`, and no `rtoCount` at all.
 *
 * `cancelledOrders` LUMPS RETURNED IN WITH CANCELLED, by design: for risk
 * scoring an RTO and a cancellation are the same failed outcome, and
 * `customerRisk.js` says so in its own comment. That is why `rtoCount` is a
 * SEPARATE field the route computes with its own status groupBy — reading an
 * RTO count off `cancelledOrders` would double-count a customer who cancelled
 * twice and never refused a parcel.
 */
// ── Stage 10 module 06 — delivery coordination ───────────────────────────────

/** One appended fact. `at` is server-set; the note is what gets quoted back. */
export interface NovaCaseFact {
  at: string;
  source: string;
  note: string;
  data?: Record<string, unknown>;
}

/**
 * A case as the service surface returns it.
 *
 * `refs` is where everything this case touched is listed — actions, decisions,
 * jobs, and every conversation that asked about it. That last list is the one
 * the loop-closer fans out over, so it is the difference between "one company
 * answering" and two threads each getting half an answer.
 */
export interface NovaCaseView {
  id: string;
  kind: string;
  status: string;
  department: string;
  conversationId: string | null;
  orderId: string | null;
  customerId: string | null;
  journeyId: string | null;
  title: string;
  facts: NovaCaseFact[];
  refs: {
    actionIds?: string[];
    decisionIds?: string[];
    jobIds?: string[];
    conversationIds?: string[];
  };
  promiseId: string | null;
  openedByActionId: string | null;
  resolvedAt: string | null;
  resolution: string | null;
  createdAt: string;
  updatedAt: string;
  /** How long this has been open. The number a founder actually triages on. */
  ageHours: number;
}

export interface OpenCaseRequest {
  kind: string;
  conversationId: string;
  orderId?: string;
  productId?: string;
  customerId?: string;
  title: string;
  factsNote?: string;
  factsSource?: string;
  /** The action that opened it. Absent when the SERVER opened it — a courier
   *  webhook or the stagnation sweep — and that null is meaningful: those cases
   *  never passed through the authority gate because no model asked for them. */
  novaActionId?: string;
}

export interface PatchCaseRequest {
  status?: string;
  /** Named `appendFacts`, not `facts`, so a replacement cannot be expressed. */
  appendFacts?: Array<{ source?: string; note: string; data?: Record<string, unknown> }>;
  /** Required when moving to a terminal status, including the bad endings. */
  resolution?: string;
}

export interface UpdateOrderDeliveryRequest {
  /** Requires `confirmedByActionId` — a confirmation with no receipt is a claim. */
  confirm?: boolean;
  confirmedByActionId?: string;
  address?: string;
  city?: string;
  /** Changing this RE-PRICES the order off the shop's own delivery charges. */
  district?: string;
  phone?: string;
  /** 'cancelled' is the only status this path sets; the rest go through `updateOrder`. */
  status?: OrderStatus;
}

/**
 * What Nova may tell a customer about their parcel.
 *
 * NO RAW COURIER STRING and NO ETA. The server maps the scan through the same
 * humanizer the public tracking page uses, and no courier gives Dakio a delivery
 * date — so a date here would be a promise the shop then has to keep.
 */
export interface OrderStatusView {
  orderNumber: string;
  /** The step, in the same words the customer's own tracking page shows. */
  displayStatus: string;
  statusStep: number;
  courierProvider: string | null;
  /** Whole taka due at the door, or null when it is not a COD order. */
  codAmount: number | null;
  placedAt: string;
  courierSentAt: string | null;
  /** When the courier last actually moved it. */
  lastMovedAt: string | null;
  confirmed: boolean;
  /** The SERVER's verdict, off the same rule the nightly sweep uses. */
  stuck: boolean;
  trackingCode: string;
  openCase: { id: string; kind: string; status: string; latestFact: string | null } | null;
}

export interface CustomerRiskView {
  /** The normalized form the server matched on, never the raw input. */
  phone: string;
  level: "NEW" | "POSITIVE" | "MEDIUM" | "RISK";
  totalOrders: number;
  deliveredOrders: number;
  /** CANCELLED **and** RETURNED together — see the note above. */
  cancelledOrders: number;
  activeOrders: number;
  /** RETURNED only. The number `inbox.rtoShadowThreshold` is compared against. */
  rtoCount: number;
  /** CANCELLED only, so the split can be reconstructed without subtracting. */
  cancelledOnlyCount: number;
  successRate: number;
  returnRate: number;
  message: string;
}

// ---------------------------------------------------------------------------
// Proactive job queue (Phase 05). Per-tenant daily rhythm: a JobDef is the
// tenant's cadence config for a job kind (edited by the founder eventually —
// Phase 06); a Job is one due/leased/done unit of work, expanded from a def's
// occurrence or enqueued by the event→job mapper. Persisted store-side, same
// as memory/actions/activity/reports/inbox — Nova itself holds no job state.
// ---------------------------------------------------------------------------

export type JobKind =
  | "morning_report"
  | "pulse"
  | "cart_sweep"
  | "night_ops"
  | "weekly_strategy"
  | "reflection"
  // Stage 10 module 01: fallback lane for undelivered inbound customer
  // messages (drained from unprocessed `message.received` events when the
  // live delivery POST to the customer channel failed). Never cron-defined —
  // event-enqueued by dakio-api's drain, priority 1, and routed by the
  // dispatcher to the customer conversation session, not a `job:<id>` one.
  | "inbox_reply"
  // Stage 10 module 03: promise fulfillment. THE unified follow-up kind
  // (canonical C-15 — `promise_follow_up` does not exist). Module 04 later adds
  // the NBA producer on this same kind, and its supersede-on-inbound rule must
  // skip rows carrying `payload.promiseId`: a customer writing back cancels a
  // nudge, but it does not settle a debt. Enqueued inside the reply transaction
  // at `dueAt = promise.dueAt − 30min`, priority 3, and routed by the dispatcher
  // BACK INTO `customer:inbox:<conversationId>` when the payload carries both
  // promiseId and conversationId (see `dispatchJobToChannel`).
  | "followup"
  // Stage 10 module 03: the nightly sweeps and the quiet-thread distiller.
  // Registered here so the kind unions on both sides of the wire agree, but
  // nova-ai never runs one: dakio-api executes all three server-side
  // (`SERVER_SWEEPS`), claiming their rows inside the claim transaction before
  // the candidate query, so the dispatcher is never handed one. They are
  // model-free by design — the sweeps author Decisions and the distiller writes
  // memory, none of which needs a turn. Their entries in the exhaustive
  // `TEMPLATES` map are routing tripwires, not instructions.
  | "promise_sweep"
  | "identity_merge_sweep"
  | "conversation_distill"
  // Stage 10 module 04: the nightly journey pass — dormancy, retained
  // promotion, delivery stagnation, slot-filling abandonment, refill windows,
  // review arming. Server-side for the same reason as the three above, and for
  // one more: the stage machine is a deterministic reducer (D1.1 — "stage is
  // code, never model output"), so handing it to a session would be handing the
  // model the one thing module 04 exists to keep away from it. Its entry in
  // `TEMPLATES` is a routing tripwire, not instructions.
  //
  // It is the only one of the four with a cron: dakio-api's `PLATFORM_JOB_DEFS`
  // runs it daily on the PLATFORM timezone, not the tenant's. Pausing it is a
  // stored `NovaJobDef{enabled:false}` shadowing that default.
  | "journey_sweep"
  /**
   * Stage 10 module 06 — delivery coordination.
   *
   * All three are LEASED MODEL TURNS, not server sweeps, because each one ends
   * in a sentence a human reads and the sentence IS the work.
   *
   * `case_update` is the loop closer, and it is the one with a channel branch:
   * it rejoins the customer's own thread so tone, memory and register come free,
   * and the reply it composes passes the ordinary send gate — which is why a T0
   * Shadow store's loop-closure lands as a draft rather than not happening.
   */
  | "courier_intervention"
  | "case_update"
  | "restock_check"
  /**
   * Stage 10 module 09 — the nightly attribution pass.
   *
   * A SERVER SWEEP. dakio-api runs it in `SERVER_SWEEPS`; nothing here ever
   * leases it. It is named in this union anyway, on modules 03/04's precedent
   * rather than module 08's (`inbox_sla_sweep` is absent and has no tripwire),
   * so that `TEMPLATES` is forced to carry a body saying "not yours" — a lane
   * that somehow reached a model with an `undefined` prompt would burn five
   * failed attempts nightly, forever.
   *
   * It is the only thing in the system permitted to call a revenue figure
   * `measured`, which is exactly why no model turn may own it.
   */
  | "inbox_attribution"
  /**
   * Stage 11 Phase 3 — catalog photo indexing, A LEASED MODEL TURN.
   *
   * Minted by dakio-api whenever a store has catalog photos awaiting caption
   * fingerprints (`syncProductImageMemory` on product writes, hour-bucket
   * deduped, and the `catalog_photo_sweep` server sweep nightly). The turn
   * calls `run_catalog_vision` once, which captions + embeds up to 100
   * pending photos — the batch cap IS the price: one completed run charges
   * one Nova task on the meter, so 100 photos = 1 task.
   */
  | "catalog_vision"
  /* ──────────────────────────────────────────────────────────────────────────
   * ROUTING TRIPWIRES — the four kinds this union was missing (phase E).
   *
   * dakio-api's `JOB_KINDS` (src/routes/novaJobs.js) knows 21 kinds; the
   * ported union knew 17. The four below are SERVER SWEEPS: dakio-api leases
   * and executes them inside its own claim transaction, off the queue, BEFORE
   * the candidate query runs — so a healthy dispatcher is never handed one and
   * the omission cost nothing at runtime.
   *
   * It cost something at the TYPE level, which is why they are here now: any
   * `Record<JobKind, …>` router table was exhaustive over 17 of the 21 kinds
   * the server can actually mint. TypeScript called that table complete. It
   * wasn't — it was complete over a stale copy of the server's list.
   *
   * The failure mode, if one ever does reach a model lane: the lane renders an
   * `undefined` prompt, the turn fails, the row retries, and `MAX_ATTEMPTS=5`
   * burns five failed attempts into a `failed` row every single night, forever
   * — silently, because a failed sweep looks exactly like a flaky one.
   *
   * So each is registered here as a TRIPWIRE, not as work: `src/brain/registry.ts`
   * maps every one of them to `null` in an exhaustive `Record<JobKind, …>`, and
   * `registry.eval.test.ts` asserts no server-sweep kind ever acquires a lane.
   * Adding a 22nd kind to this union breaks that Record at compile time — which
   * is the whole point of naming them. Do NOT give one of these a workflow.
   * ────────────────────────────────────────────────────────────────────────── */
  /**
   * Stage 10 module 08 — the escalation SLA sweep (every 10 min).
   *
   * SERVER SWEEP. One of only two entries in dakio-api's `SERVER_SWEEPS` that
   * can send a customer-visible message, which is why its selection rule lives
   * entirely in the WHERE clause (`lib/inboxSlaSweep.js`): a bound on rows
   * examined is not a bound on rows acted on. There is nothing for a model to
   * do — the holding message is a deterministic template.
   */
  | "inbox_sla_sweep"
  /**
   * Stage 11 — the order-confirmation backstop (every 10 min).
   *
   * SERVER SWEEP, and the reason is almost poetic: it fires precisely when the
   * MODEL could not speak (a chat order no outbound message on its own thread
   * has ever named). Handing it to a model lane would route the backstop for a
   * broken model through the model.
   */
  | "order_confirm_sweep"
  /**
   * Blueprint 17 (R1) — the production night shift, 01:30 tenant-local,
   * deliberately BEFORE `night_ops` at 02:00 so the judgment turn reads fresh
   * grades instead of yesterday's.
   *
   * SERVER SWEEP: deterministic grading arithmetic over the founder's own
   * rows. A grade a model can invent is exactly what the rooms doctrine
   * forbids. (Doc 07 B5: nova-ai also carried a `runNightShift` that was a
   * canned Stage-3 gate demo, explicitly never to run against a real tenant.
   * The migration ports the real grader and does NOT bring that name collision
   * along — nothing in nova-mastra may claim this kind.)
   */
  | "night_shift"
  /**
   * Stage 11 Phase 3 — the catalog photo-memory reconciler (nightly).
   *
   * SERVER SWEEP, and the twin of `catalog_vision` above — the split between
   * them IS the model line. This one syncs memory rows, counts what is
   * pending, and MINTS the `catalog_vision` job; the leased turn is where the
   * captioning happens. Deterministic bookkeeping, no prompt, nothing for a
   * model to do.
   */
  | "catalog_photo_sweep";
export type JobStatus = "due" | "leased" | "done" | "failed" | "skipped";

export interface NovaJobDef {
  kind: JobKind;
  /** 5-field cron string (minute hour dom month dow; dom/month must be '*'), interpreted in `tz`. */
  cadence: string;
  tz: string;
  enabled: boolean;
  config: Record<string, unknown>;
  updatedAt: string;
}

export interface NovaJob {
  id: string;
  kind: JobKind;
  payload: Record<string, unknown>;
  dueAt: string;
  /** 1 = approval-surfacing/critical … 9 = lowest (pulse). */
  priority: number;
  status: JobStatus;
  attempts: number;
  lastError: string | null;
  dedupeKey: string;
  leaseUntil: string | null;
  /**
   * Blueprint 17 — the ROOM this visit belongs to. `null` = not a room visit.
   *
   * Stamped by dakio-api at row creation (`lib/novaJobDepartments.js`
   * `departmentForJob`, whose default the payload can override) and sent on
   * every claimed job by `jobOut`; the merchant room feed reads this column to
   * render "Nova is working here". It arrived on the wire before this type
   * named it, so a claimed job has carried a `department` this side silently
   * dropped — and every reader that wanted the room had to re-derive it.
   *
   * It is server-authoritative: nova-mastra never sets it, and
   * `src/brain/registry.ts`'s copy of the map exists for ROUTING and registry
   * checks, never for stamping. Nullable because the server sweeps map to
   * `null` on purpose — bookkeeping passes are not room visits and must never
   * light a room up.
   */
  department: NovaDepartment | null;
  /** Fencing value for this specific lease — pass it back to completeJob/releaseJob so a stale (superseded) lease's call is a safe no-op. */
  leaseToken: string | null;
}

/**
 * What `completeJob` / `releaseJob` answer.
 *
 * The whole point of this type is the one boolean. dakio-api answers a
 * SUPERSEDED lease with HTTP 200 `{ok:true, stale:true}` — not an error,
 * because nothing went wrong: the lease window simply passed, the watchdog
 * re-dued the row, and somebody else owns it now. That 200 is the ONLY way a
 * caller ever learns its lease was recovered and its work may be running
 * twice. Both backends used to answer `void`, so the signal never left the
 * HTTP layer.
 *
 * `stale: true` ⇒ NOTHING was written. Do not treat it as success (the row did
 * not record this outcome) and do not retry it (the row has moved on) — treat
 * it as "my work was orphaned": worth logging, worth counting, and worth
 * knowing before any side effect this job performs is assumed unique.
 */
export interface JobSettleResult {
  /** Always `true`. The call was ACCEPTED; failures throw instead. */
  readonly ok: true;
  /** `true` = superseded lease, nothing written, work possibly duplicated. */
  readonly stale: boolean;
}

// ---------------------------------------------------------------------------
// Seed container
// ---------------------------------------------------------------------------


/**
 * E-9 Decision — a gated action, asked as a question the founder can answer.
 *
 * One record, rendered on every surface. `surfacedIn` records WHERE it has
 * been shown so a single approve can clear it everywhere at once; duplicating the
 * decision per surface is how two copies end up disagreeing about whether it
 * was already answered.
 */
export interface DecisionRecord {
  id: string;
  tag: NovaDepartment;
  kind: "proposal" | "escalation" | "promotion";
  impactLabel: string;
  title: string;
  paramsLine: string;
  why: string;
  /** The E-8 action this asks about; payload, receipt and undo live there. */
  actionId: string;
  bundleRef: string | null;
  status: "queued" | "approved" | "later" | "rejected" | "frozen" | "expired" | "undone";
  queuePos: number;
  surfacedIn: string[];
  /** 1 = pinned (escalation or high risk), 5 = normal. */
  priority: number;
  /** Which no-touch lock froze it — a founder must be told which. */
  frozenByLock: string | null;
  expiresAt: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
}

// ── Night shift outputs (E-4 / E-6 / E-7 / E-16, Stage 3) ──────────────────

/** E-6 — one of the three metrics a department's grade was computed from. */
export interface ScoreMetric {
  label: string;
  value: string;
  targetText: string;
  pct: number;
  tone: "good" | "warn" | "bad";
}

/** E-4 — a department's nightly grade, memo, and now/next, with the metrics. */
export interface DepartmentGrade {
  key: NovaDepartment;
  grade: string;
  statusLine?: string | null;
  now?: string | null;
  next?: string[];
  memo?: string | null;
  metrics?: ScoreMetric[];
  gradedAt?: string;
}

export type PlanItemStatus = "DONE" | "IN_PROGRESS" | "WAITING_ON_YOU" | "SCHEDULED" | "NEEDS_DOOR";

/** E-7 — a plan-board row. Over-authority items are born WAITING_ON_YOU with a
 *  decisionRef that the approve transaction flips. */
export interface PlanItem {
  id: string;
  department: NovaDepartment;
  status: PlanItemStatus;
  title: string;
  detail?: string | null;
  progressPct: number;
  decisionRef?: string | null;
  nightShiftDate?: string | null;
  /** Blueprint 17 R2: why this item exists. REQUIRED by the dakio service
   *  plane on create; optional here only for legacy rows read back. */
  sourceRef?: PlanSourceRef | null;
}

export interface PlanSourceRef {
  kind: "goal" | "case" | "decision" | "playbook" | "experiment" | "duty" | "founder" | "strategy";
  id?: string;
  note?: string;
}

export interface BriefTile {
  key: string;
  label: string;
  value?: number;
  valueMinor?: number;
  basis: "measured" | "estimated";
  evidenceQuery: string;
}

export interface BriefDecisionRef {
  id: string;
  title: string;
  impactLabel: string;
  priority: number;
  tag?: string;
}

/** E-16 — the structured morning brief. Tiles are computed server-side; the
 *  night shift supplies only the narrative. */
export interface MorningBrief {
  id: string;
  day: string;
  narrative: string;
  tiles: BriefTile[];
  decisionRefs: BriefDecisionRef[];
  plannedVsDone?: unknown;
  openedAt: string | null;
}

// ── Brand voice (E-12) + voice scoring (Stage 4 "Craft") ───────────────────

export type BrandLanguage = "bn" | "en";

export interface BrandRule {
  kind: "do" | "dont";
  /** The phrase or instruction, in English. */
  text: string;
  /** Bangla parity, when the rule is language-specific. */
  textBn?: string;
}

/** E-12 — the structured brand profile. Memory stays the narrative layer; this
 *  is the checkable truth a draft is scored against. One per tenant. */
export interface BrandProfile {
  toneWords: string[];
  palette: string[];
  rules: BrandRule[];
  languages: BrandLanguage[];
  assets: {
    logoRef?: string;
    boilerplateEn?: string;
    boilerplateBn?: string;
    hashtags?: string[];
  };
  /** Below this 0–100 score a draft is flagged off-voice. Default 70. */
  threshold?: number;
}

export type ContentLanguage = "bn" | "en" | "mixed";

export type ContentType =
  | "post" | "reel" | "story" | "captions" | "email" | "sms" | "push" | "product_desc";

export interface VoiceViolation {
  /** Machine slug: banned_phrase | missing_required | language_mismatch | too_long | tone_thin | emoji_over | hashtag_over */
  code: string;
  /** Founder-facing sentence — cites the draft, never an unexplained score (§2.4). */
  message: string;
  /** The offending fragment, when there is one to quote. */
  evidence?: string;
}

export interface VoiceScore {
  score: number;
  flagged: boolean;
  violations: VoiceViolation[];
}

/** E-11 — a content item as returned by the store (Stage 4). */
export interface ContentItem {
  id: string;
  type: ContentType;
  title: string;
  language: ContentLanguage;
  body: Record<string, unknown>;
  status: string;
  voiceScore: number;
  violations: VoiceViolation[];
  createdAt: string;
}

/** What the night shift / generation files. `id` present = a regeneration. */
export interface ContentDraftInput {
  id?: string;
  type: ContentType;
  title: string;
  language: ContentLanguage;
  body: Record<string, unknown>;
  voiceScore: number;
  violations: VoiceViolation[];
  decisionRef?: string | null;
  novaActionId?: string | null;
}

/* ── Ledger-backed finance (DAKIO_FINANCE_PRD §12.3) ────────────────────────
 *
 * dakio-api keeps a real double-entry ledger per merchant; these are the
 * read-view shapes `/api/v1/store/finance/*` answers with. Every figure is a
 * sum over journal lines — reproducible, never estimated. The discriminant
 * matters: `ledgerActive: false` means the tenant's ledger isn't switched on
 * yet and the caller must fall back to the heuristic path AND SAY SO. */

export interface LedgerInactive {
  ledgerActive: false;
}

/** One ledger account's movement inside a P&L window. */
export interface PnlLine {
  code: string;
  name: string;
  type: "INCOME" | "EXPENSE";
  subtype: string | null;
  amount: number;
}

export interface FinancePnlWindow {
  from: string;
  to: string;
  income: number;
  expenses: number;
  netProfit: number;
  lines: PnlLine[];
}

export type FinancePnl =
  | LedgerInactive
  | (FinancePnlWindow & {
      ledgerActive: true;
      /** Present when the read asked for `compare`: the immediately-preceding window of the same length. */
      previous?: FinancePnlWindow;
    });

export interface FinanceBalanceRow {
  code?: string;
  courier?: string;
  name: string;
  balance: number;
}

export type FinanceOverview =
  | LedgerInactive
  | {
      ledgerActive: true;
      baseCurrency: string;
      onboardedAt: string;
      cash: { total: number; accounts: FinanceBalanceRow[] };
      courierOwesYou: { total: number; byCourier: FinanceBalanceRow[] };
      youOweSuppliers: { total: number; bySupplier: FinanceBalanceRow[] };
      customerCredit: { total: number; count: number };
      dakioOwesYou: number;
      stockValue: number;
      customerAdvances: number;
      staffAdvances: number;
      thisMonth: { income: number; expenses: number; netProfit: number };
    };

export interface ChartAccountRow {
  code: string;
  name: string;
  subtype: string | null;
  debit: number;
  credit: number;
  balance: number;
}

export type FinanceAccounts =
  | LedgerInactive
  | {
      ledgerActive: true;
      currency: string;
      onboardedAt: string;
      groups: {
        type: "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "EXPENSE";
        accounts: ChartAccountRow[];
        subtotal: number;
      }[];
      totals: { debit: number; credit: number; balanced: boolean };
    };

export interface StatementLine {
  id: string;
  date: string;
  event: string;
  memo: string | null;
  referenceType: string | null;
  referenceId: string | null;
  channel: string | null;
  isReversal: boolean;
  debit: number;
  credit: number;
  /** Running balance AFTER this line (rows arrive newest-first). */
  balance: number;
}

export type AccountStatement =
  | LedgerInactive
  | {
      ledgerActive: true;
      account: { code: string; name: string; type: string; subtype: string | null };
      normalSide: "DEBIT" | "CREDIT";
      currency: string;
      opening: number;
      closing: number;
      count: number;
      truncated: boolean;
      lines: StatementLine[];
    };

export interface StoreSeed {
  products: Product[];
  trendingProducts: TrendingProduct[];
  customers: Customer[];
  orders: Order[];
  abandonedCarts: AbandonedCart[];
  campaigns: Campaign[];
  socialPosts: SocialPost[];
  discounts: Discount[];
  supportTickets: SupportTicket[];
  customerMessages: CustomerMessage[];
  suppliers: Supplier[];
  purchaseOrders: PurchaseOrder[];
  couriers: Courier[];
  expenses: ExpenseEntry[];
  autonomy: AutonomyConfig;
  memory: MemoryEntry[];
  activity: ActivityEntry[];
  actions: ActionRecord[];
  reports: NovaReport[];
  /** Phase 04 — optional so Phase 1–3 seeds don't need to declare them. */
  playbooks?: NovaPlaybook[];
  experiments?: NovaExperiment[];
  /** Phase 2.3 — optional; the demo backend has no external event source, so seeds that omit it simply start with an empty inbox. */
  inboxEvents?: InboxEvent[];
  /** Phase 05 — optional so earlier-phase seeds don't need to declare them; DemoStore lazily initializes an empty queue. */
  jobDefs?: NovaJobDef[];
  jobs?: NovaJob[];
  /**
   * Phase 06 — Grow Lab. Optional: the demo store has no Grow modules seeded,
   * so Nova sees them genuinely empty rather than pretending a founder had
   * been working in them.
   */
  /** Stage 1 authority: optional so earlier seeds need not declare them. */
  dailySpendCapMinor?: number;
  noTouch?: string[];
  modes?: Record<string, NovaMode>;
  /** Stage 2 decisions; the demo store starts with an empty desk. */
  decisions?: DecisionRecord[];
  growCampaigns?: GrowCampaign[];
  growPosts?: GrowPost[];
  growBroadcasts?: GrowBroadcast[];
  growIdeas?: GrowIdea[];
  growGoals?: GrowGoal[];
  /**
   * Ledger-backed finance views. Optional AND honest by default: a seed
   * without it answers `ledgerActive: false` from every finance read, which
   * is exactly what a real un-onboarded tenant answers — the demo store never
   * pretends to have books it doesn't hold.
   */
  finance?: {
    overview: FinanceOverview;
    pnl: FinancePnl;
    accounts: FinanceAccounts;
    /** Keyed by account code; missing code = 404 → null, like the live route. */
    statements: Record<string, AccountStatement>;
  };
}
