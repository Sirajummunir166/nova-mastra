/**
 * In-memory demo implementation of the Dakio store.
 *
 * Plays the role of the Express store server: holds business data and
 * Nova's agent data, and applies mutations. State lives for the duration of
 * the process (one continuous demo "day" per server run) and is seeded with
 * a realistic dataset anchored to the current wall-clock time.
 *
 * Every StoreClient method is declared `async` to satisfy the interface,
 * even though the in-memory data access itself never actually awaits
 * anything — that's the point: callers already treat every store call as a
 * network round trip, so swapping this class for an HTTP client later is a
 * one-line change in `client.ts`, not a ripple through the agent.
 */

import type {
  AbandonedCart,
  ActionRecord,
  ActionStatus,
  ActivityEntry,
  AuthorityState,
  AutonomyConfig,
  Campaign,
  CartRecoveryState,
  ChatOrderRequest,
  ChatOrderResult,
  Courier,
  CouponRefusal,
  CouponValidation,
  CreateDiscountInput,
  DiscountKind,
  BrandProfile,
  Customer,
  CustomerMessage,
  CustomerRiskView,
  NovaCaseView,
  OrderStatusView,
  OpenCaseRequest,
  PatchCaseRequest,
  UpdateOrderDeliveryRequest,
  ContentDraftInput,
  ContentItem,
  DecisionRecord,
  DepartmentGrade,
  Discount,
  ExpenseEntry,
  AccountStatement,
  FinanceAccounts,
  FinanceOverview,
  FinancePnl,
  GrowBroadcast,
  GrowCampaign,
  GrowGoal,
  GrowIdea,
  GrowPost,
  InboxConversationView,
  InboxEvent,
  InboxHandoverRequest,
  InboxHandoverResult,
  InboxMessageView,
  InboxPromise,
  InboxReplyRequest,
  InboxReplyResult,
  InboxThread,
  IntentObservedRequest,
  IntentObservedResult,
  JobKind,
  LinkCustomerRequest,
  LinkCustomerResult,
  MemoryEntry,
  MemoryNamespace,
  MemoryUpsert,
  MorningBrief,
  NbaBlock,
  NovaExperiment,
  NovaJob,
  NovaJobDef,
  NovaPlaybook,
  NovaReport,
  Order,
  OrderStatus,
  PlanItem,
  Product,
  PromiseKind,
  PromiseSettleRequest,
  PurchaseOrder,
  ScheduleFollowupRequest,
  ScheduleFollowupResult,
  SocialPost,
  StoreSeed,
  StoreSettings,
  Supplier,
  SupportTicket,
  TicketStatus,
  TrendingProduct,
} from "./types.js";
import type {
  StoreClient,
  RunStartInput,
  RunFinishInput,
  CatalogPhotoPending,
  CatalogPhotoResult,
  CatalogPhotoFingerprint,
} from "./client.js";
import { InboxSendRefused } from "./client.js";
import { DUTIES, DOORS } from "./duties.js";
import { SPEND_MINOR } from "./authority.js";
import { NOVA_MAX_CONSECUTIVE_OUTBOUND } from "./inboxIntents.js";
import { createSeed } from "./seed.js";
import { lastOccurrenceAtOrBefore } from "./cron.js";
import { randomUUID } from "node:crypto";

// 1 = approval-surfacing/critical … 9 = lowest. Mirrors dakio-api's
// novaJobs.js — no dedicated approval-surfacing job kind exists yet.
const PRIORITY_BY_KIND: Record<JobKind, number> = {
  inbox_reply: 1, // reserved fast-lane band — a waiting customer outranks everything
  morning_report: 3,
  night_ops: 3,
  // Stage 10 module 03: a promise coming due is work the customer is already
  // expecting, so it rides the same band as the morning report rather than the
  // sweeps' band. Canonical C-15 — one unified kind, priority 3.
  followup: 3,
  weekly_strategy: 4,
  // Stage 10 module 06. Mirrors dakio-api's PRIORITY_BY_KIND exactly. Spread
  // rather than bunched: a stuck parcel is a customer already waiting, so the
  // intervention shares band 3; the loop-closure that tells them what was found
  // sits behind it at 4, because it has nothing useful to say until the
  // intervention has written its findings.
  courier_intervention: 3,
  case_update: 4,
  restock_check: 5,
  reflection: 6,
  // Stage 10 module 09. Mirrors dakio-api's PRIORITY_BY_KIND. Nightly, nothing
  // waits on it, and it is a server sweep DemoStore never dispatches — present
  // because this record is total over JobKind.
  inbox_attribution: 6,
  // Stage 10 module 03: nightly/quiet-lane housekeeping. Nobody is waiting on
  // any of these, and all three author work for the founder rather than the
  // customer, so they sit with reflection at the bottom of the useful band.
  promise_sweep: 6,
  identity_merge_sweep: 6,
  conversation_distill: 6,
  // Stage 10 module 04: the nightly journey pass. Same band and the same
  // argument — nobody is waiting on a dormancy recalculation, and it runs
  // server-side in dakio-api rather than as model work.
  journey_sweep: 6,
  // Stage 11 Phase 3: catalog photo indexing. Batch bookkeeping band — a
  // photo that reaches memory an hour later costs nothing, and under budget
  // pressure indexing sheds first (customers degrade to describe-and-ask).
  catalog_vision: 6,
  cart_sweep: 5,
  pulse: 9,
};
const LEASE_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const CART_SWEEP_DEBOUNCE_MINUTES = 30;

function backoffMinutes(attempts: number): number {
  return Math.min(30, 2 ** attempts);
}

/**
 * The demo's phone fold (Stage 10 module 03). Deliberately a SIMPLIFIED stand-in
 * for dakio-api's `normalizePhone`/`phoneVariants` (`src/lib/customerRisk.js`),
 * which is the only real matcher and the only one module 03 pins with tests:
 * digits only, then the `88` country code dropped so `+8801…`, `8801…` and
 * `01…` fold to one string. It is named `demo…` so nobody mistakes it for the
 * shipped ladder and re-implements identity matching on this side of the wire.
 */
function demoNormalizePhone(raw: string): string {
  const digits = String(raw).replace(/\D+/g, "");
  return digits.startsWith("88") ? digits.slice(2) : digits;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The bookable follow-up delays (module 04 D7), in milliseconds. Keyed by the
 * same four strings as `FOLLOWUP_DELAYS` in `nova/schemas.ts` and
 * `FollowupDelay` in types.ts; an unknown key is a refusal here, not a default,
 * because silently rounding "in 10 minutes" to something legal is how a
 * pressure loop gets built out of a validation shortcut.
 */
const FOLLOWUP_DELAY_MS: Record<string, number> = {
  "2h": 2 * 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "24h": DAY_MS,
  "3d": 3 * DAY_MS,
};

/**
 * One demo conversation: the thread row, its transcript, and the queued sends.
 * Kept OUT of `StoreSeed` deliberately — a seeded dataset would imply real
 * customers wrote in, and the demo backend has no Meta webhook. Threads exist
 * here only when a caller explicitly seeds one (see `seedInboxConversation`).
 */
interface DemoInboxThread {
  conversation: InboxConversationView;
  messages: InboxMessageView[];
  customer: Record<string, unknown> | null;
  /** Module 03 D2: basis-only, and never the candidate's id or data. */
  proposal: { basis: string } | null;
  /**
   * Module 04 D6. Seeded, never computed — for exactly the reason `customer`
   * is: dakio-api's `novaNba.js` derives this from a journey row, the 360 and
   * the tenant's guardrails, and a demo that assembled a plausible one would be
   * inventing the eligibility decisions the whole module exists to make
   * server-side. Unseeded it is `null`, which is the honest reading of a
   * backend with no journey engine.
   */
  nba: NbaBlock | null;
  /**
   * Module 03 provenance. Internal demo state, NOT part of the wire view —
   * `conversationOut` does not expose which rung of the ladder wrote the join,
   * and inventing that field here would invent a contract dakio-api never made.
   */
  customerLinkSource: string | null;
  /** A normalized in-thread phone that matched ZERO customers (D4). */
  claimedPhone: string | null;
  outbounds: {
    id: string;
    novaActionId: string;
    chunks: { text: string }[];
    status: string;
    scheduledAt: string;
  }[];
}

/** What a test/demo caller may set when materializing a thread. */
export interface DemoInboxSeed {
  id: string;
  platform?: string;
  senderName?: string | null;
  customerId?: string | null;
  handledBy?: string | null;
  novaLockedAt?: string | null;
  novaEnabled?: boolean;
  lastIntent?: string | null;
  windowExpiresAt?: string | null;
  customer?: Record<string, unknown> | null;
  /**
   * Module 03 D2. Seedable because nothing in {@link StoreClient} can write a
   * proposal — the PATCH that sets it is a merchant/service route Nova does not
   * call — so an unlinked-but-proposed thread is only reachable by seeding one.
   */
  proposal?: { basis: string } | null;
  /**
   * Module 04 D6. Seedable for the same reason `customer` is: the block is
   * dakio-api's to compute, so a suite that needs a thread with a stage and a
   * candidate list hands one over rather than asking this backend to invent it.
   */
  nba?: NbaBlock | null;
  messages?: {
    direction: "in" | "out";
    actor: string;
    text: string;
    sentAt?: string;
    id?: string;
    purpose?: string | null;
    novaActionId?: string | null;
    /**
     * A photo the customer sent. Seedable since 2026-08-12: before that this
     * backend hard-coded both to null, so a demo thread could not represent the
     * single most expensive message type in production — 21.6% of customer
     * messages carry an image — and every vision check had to hand-build
     * message objects instead of reading a real thread.
     */
    attachmentType?: string | null;
    attachmentUrl?: string | null;
  }[];
}

/**
 * What a test/demo caller may set when materializing a promise. Same
 * discipline as {@link DemoInboxSeed}: a promise exists only because a reply
 * was actually queued, so the demo never conjures one on read.
 */
export interface DemoPromiseSeed {
  id?: string;
  conversationId?: string | null;
  customerId?: string | null;
  channelKind?: string;
  madeBy?: "nova" | "founder";
  text: string;
  kind: PromiseKind;
  /** ISO 8601. Defaults to 24h out — a plausible "kal janabo". */
  dueAt?: string;
  status?: InboxPromise["status"];
}

/**
 * One booked follow-up (module 04 D7). The demo's stand-in for the `followup`
 * NovaJob row dakio-api writes — same fields the founder's commitments list
 * renders, and the same two that decide its fate: `promiseId` (exempt from
 * supersession and from the inbound cancel) and `status`.
 */
export interface DemoFollowup {
  jobId: string;
  conversationId: string;
  journeyId: string | null;
  dueAt: string;
  reason: string;
  plannedIntent: string;
  scheduledByActionId: string;
  /** Non-null = module 03 debt repayment, never an NBA nudge. */
  promiseId: string | null;
  status: "due" | "superseded" | "cancelled";
  /** The job this one replaced, if any. */
  superseded: string | null;
}

/** One turn-end `intent-observed` callback (module 04 D5 pass 2 / D12). */
export interface DemoIntentObservation {
  journeyId: string;
  intent: string;
  messageId: string;
  nbaAction: string | null;
  nbaReason: string | null;
  at: string;
}

export class DemoStore implements StoreClient {
  private readonly data: StoreSeed;
  private idCounter = 9000;
  /** Front Office threads. Empty until a caller seeds one — never invented. */
  private readonly inbox = new Map<string, DemoInboxThread>();
  /** The commitments ledger (module 03 D7). Empty until a reply makes a promise. */
  private readonly promises: InboxPromise[] = [];
  /**
   * The demo's phone book (module 03 D4). Empty until a caller seeds it, for
   * exactly the reason threads are: `Customer` in this backend has no phone
   * column, so a `linkCustomer` that matched anyway would be inventing the one
   * fact the whole identity ladder rests on. Unseeded, every link honestly
   * answers `matched:false`.
   */
  private readonly customerPhones: { phone: string; customerId: string }[] = [];
  /**
   * The commitments ledger (module 04 D7). Empty until a follow-up is booked —
   * a demo store that started with pending commitments would be a store that
   * owes customers things nobody promised.
   */
  private readonly followups: DemoFollowup[] = [];
  /** Every `intent-observed` callback this store received, in order. */
  private readonly intentObservations: DemoIntentObservation[] = [];
  /**
   * Chat orders by `novaActionId` (module 05 D4) — the demo's stand-in for the
   * route's conditional read-back on `Order.novaActionId`. Deliberately NOT the
   * `w()` idempotency cache: `w()` is not a mutex and is not what makes "one
   * order, ever" true, so a demo that modelled the cache instead of the
   * read-back would be modelling the layer that does not hold.
   */
  private readonly chatOrders = new Map<string, ChatOrderResult>();

  /**
   * NovaRun mirror (per-turn run audit) — keyed `${sessionId}|${turnId}`,
   * mirroring the server's upsert-on-(sessionId, turnId) semantics. Public
   * readonly so the runs eval can assert on what the channels recorded; demo
   * data only.
   */
  readonly runs = new Map<string, RunStartInput & { outcome: "running" | "completed" | "failed" | "cancelled"; error?: string }>();

  constructor(seed?: StoreSeed) {
    this.data = seed ?? createSeed(Date.now());
  }

  now(): string {
    return new Date().toISOString();
  }

  private nextId(prefix: string): string {
    this.idCounter += 1;
    return `${prefix}-${this.idCounter}`;
  }

  private sinceCutoff(sinceDays: number): number {
    return Date.now() - sinceDays * DAY_MS;
  }

  private mustFind<T>(value: T | undefined, kind: string, id: string): T {
    if (value === undefined) {
      throw new Error(`${kind} not found: ${id}`);
    }
    return value;
  }

  // ---- Catalog ----

  async listProducts(filter?: { status?: Product["status"]; category?: string }): Promise<Product[]> {
    return this.data.products.filter(
      (p) =>
        (filter?.status === undefined || p.status === filter.status) &&
        (filter?.category === undefined || p.category === filter.category),
    );
  }

  async getProduct(id: string): Promise<Product | null> {
    return this.data.products.find((p) => p.id === id || p.sku === id) ?? null;
  }

  async createProduct(product: Omit<Product, "id" | "createdAt">): Promise<Product> {
    const created: Product = {
      ...product,
      id: this.nextId("prod"),
      createdAt: this.now(),
    };
    this.data.products.push(created);
    return created;
  }

  async updateProduct(
    id: string,
    patch: Partial<
      Pick<Product, "price" | "compareAtPrice" | "stock" | "status" | "supplierId" | "cost">
    >,
  ): Promise<Product> {
    const product = this.mustFind(
      this.data.products.find((p) => p.id === id),
      "Product",
      id,
    );
    Object.assign(product, patch);
    return product;
  }

  async listTrendingProducts(): Promise<TrendingProduct[]> {
    return this.data.trendingProducts;
  }

  // ---- Customers ----

  async listCustomers(filter?: { segment?: Customer["segment"] }): Promise<Customer[]> {
    return this.data.customers.filter(
      (c) => filter?.segment === undefined || c.segment === filter.segment,
    );
  }

  async getCustomer(id: string): Promise<Customer | null> {
    return this.data.customers.find((c) => c.id === id) ?? null;
  }

  // ---- Orders ----

  async listOrders(filter?: { sinceDays?: number; status?: OrderStatus; customerId?: string }): Promise<Order[]> {
    const cutoff = filter?.sinceDays !== undefined ? this.sinceCutoff(filter.sinceDays) : null;
    return this.data.orders.filter(
      (o) =>
        (cutoff === null || Date.parse(o.placedAt) >= cutoff) &&
        (filter?.status === undefined || o.status === filter.status) &&
        // Mirrors the live filter rather than ignoring it: a demo that returned
        // every order for any customerId would make an eval pass on a history
        // the live backend would never hand back.
        (filter?.customerId === undefined || o.customerId === filter.customerId),
    );
  }

  async getOrder(id: string): Promise<Order | null> {
    return this.data.orders.find((o) => o.id === id) ?? null;
  }

  async updateOrder(patch: { id: string; status?: OrderStatus; courierId?: string }): Promise<Order> {
    const order = this.mustFind(
      this.data.orders.find((o) => o.id === patch.id),
      "Order",
      patch.id,
    );
    if (patch.status !== undefined) order.status = patch.status;
    if (patch.courierId !== undefined) order.courierId = patch.courierId;
    return order;
  }

  // ---- Abandoned carts ----

  async listAbandonedCarts(state?: CartRecoveryState): Promise<AbandonedCart[]> {
    return this.data.abandonedCarts.filter(
      (c) => state === undefined || c.recoveryState === state,
    );
  }

  async updateCart(
    id: string,
    patch: { recoveryState?: CartRecoveryState; recoveryMessage?: string | null },
  ): Promise<AbandonedCart> {
    const cart = this.mustFind(
      this.data.abandonedCarts.find((c) => c.id === id),
      "Cart",
      id,
    );
    if (patch.recoveryState !== undefined) cart.recoveryState = patch.recoveryState;
    if (patch.recoveryMessage !== undefined) cart.recoveryMessage = patch.recoveryMessage;
    return cart;
  }

  // ---- Marketing ----

  async listCampaigns(status?: Campaign["status"]): Promise<Campaign[]> {
    return this.data.campaigns.filter((c) => status === undefined || c.status === status);
  }

  async getCampaign(id: string): Promise<Campaign | null> {
    return this.data.campaigns.find((c) => c.id === id) ?? null;
  }

  async createCampaign(campaign: Omit<Campaign, "id" | "dailyStats">): Promise<Campaign> {
    const created: Campaign = { ...campaign, id: this.nextId("cmp"), dailyStats: [] };
    this.data.campaigns.push(created);
    return created;
  }

  async updateCampaign(
    id: string,
    patch: Partial<Pick<Campaign, "status" | "dailyBudget" | "notes">>,
  ): Promise<Campaign> {
    const campaign = this.mustFind(
      this.data.campaigns.find((c) => c.id === id),
      "Campaign",
      id,
    );
    Object.assign(campaign, patch);
    return campaign;
  }

  async listSocialPosts(status?: SocialPost["status"]): Promise<SocialPost[]> {
    return this.data.socialPosts.filter((p) => status === undefined || p.status === status);
  }

  async createSocialPost(post: Omit<SocialPost, "id">): Promise<SocialPost> {
    const created: SocialPost = { ...post, id: this.nextId("post") };
    this.data.socialPosts.push(created);
    return created;
  }

  async updateSocialPost(
    id: string,
    patch: Partial<Pick<SocialPost, "status" | "scheduledFor" | "publishedAt">>,
  ): Promise<SocialPost> {
    const post = this.mustFind(
      this.data.socialPosts.find((p) => p.id === id),
      "Social post",
      id,
    );
    Object.assign(post, patch);
    return post;
  }

  async listDiscounts(activeOnly?: boolean): Promise<Discount[]> {
    return this.data.discounts.filter((d) => !activeOnly || d.active);
  }

  async createDiscount(discount: CreateDiscountInput): Promise<Discount> {
    const code = discount.code.trim().toUpperCase();
    // `type` is INFERRED when absent, exactly as the route infers it, so every
    // pre-module-05 caller — which sends only `{code, percentOff}` — keeps
    // working unchanged.
    const type: DiscountKind =
      discount.type === "FIXED" || discount.type === "PERCENT"
        ? discount.type
        : discount.percentOff !== undefined
          ? "PERCENT"
          : "FIXED";
    // One column, two meanings, mirroring `Coupon.amount`: the whole-percent
    // figure on a PERCENT coupon, WHOLE TAKA off on a FIXED one.
    const amount = type === "PERCENT" ? (discount.percentOff ?? 0) : Number(discount.amount ?? 0);
    if (!(amount > 0)) {
      throw new Error(
        type === "PERCENT"
          ? "percentOff must be a number between 1 and 100"
          : "amount must be a positive number of taka",
      );
    }
    // The frequency guard's identity key. The route 422s without one whenever
    // `novaActionId` is set, because `Coupon` has NO customerId column and the
    // only record of a Nova coupon's recipient is the NovaAction payload —
    // omit it and the rule reads as enforced while being enforced against
    // nobody. This backend refuses for the same reason rather than accepting
    // what production would reject.
    if (discount.novaActionId && !discount.customerId && !discount.conversationId) {
      throw new Error(
        "customerId or conversationId is required on a Nova-attributed discount — the per-customer frequency guard has nothing to match on without one",
      );
    }
    if (this.data.discounts.some((d) => d.code.trim().toUpperCase() === code)) {
      // The demo's stand-in for `@@unique([tenantId, code])` → P2002 → 409. It
      // is what makes a minted-code collision a failed action rather than a
      // second customer quietly sharing the first one's single-use coupon.
      throw new Error(`Coupon code "${code}" already exists`);
    }
    const created: Discount = {
      id: this.nextId("disc"),
      // Upper-cased here as well as in `DakioStoreClient.createDiscount`,
      // because both redemption paths in this file compare against the folded
      // form: a demo that stored a lower-case code would mint one no eval could
      // then redeem, and the failure would read as the coupon logic being wrong.
      code,
      type,
      // `null` on FIXED, never 0 — see the note on `Discount.percentOff`.
      percentOff: type === "PERCENT" ? amount : null,
      amount,
      minOrder: discount.minOrder ?? 0,
      maxUses: discount.maxUses ?? null,
      usedCount: 0,
      novaActionId: discount.novaActionId ?? null,
      // Accepted and ignored by the route — Dakio coupons are order-level only
      // and `discountOut` hardcodes all three. Echoed rather than dropped so a
      // founder-plane caller reads back what it sent.
      scope: discount.scope ?? "order",
      productIds: discount.productIds ?? [],
      customerId: discount.customerId ?? null,
      expiresAt: discount.expiresAt,
      active: discount.active,
      createdAt: this.now(),
    };
    this.data.discounts.push(created);
    return created;
  }

  /**
   * The one place this backend decides what a coupon is worth (module 05 D6).
   *
   * Shared by {@link validateCoupon} and {@link createChatOrder} on purpose:
   * the storefront's real failure today is that the pre-transaction check and
   * the in-transaction re-check test DIFFERENT things (neither reads
   * `minOrder`), so a code can pass the advisory check and still be applied
   * below its floor. One function means the answer Nova quotes in the thread
   * and the answer the order gets cannot disagree.
   *
   * A missing `type` reads as PERCENT — never as FIXED-with-zero-amount. See
   * the note on {@link Discount.type}.
   */
  private judgeCoupon(code: string, subtotal: number): CouponValidation {
    const wanted = code.trim().toUpperCase();
    const coupon = this.data.discounts.find((d) => d.code.trim().toUpperCase() === wanted);
    const minOrder = Number(coupon?.minOrder ?? 0);
    const reason: CouponRefusal | null = !coupon
      ? "not_found"
      : !coupon.active
        ? "inactive"
        : coupon.expiresAt && Date.parse(coupon.expiresAt) < Date.parse(this.now())
          ? "expired"
          : coupon.maxUses != null && (coupon.usedCount ?? 0) >= coupon.maxUses
            ? "max_uses_reached"
            : // Unconditional, unlike `coupons.js:148`'s `if (subtotal && …)`.
              // That guard means a caller who omits the subtotal skips the floor
              // entirely and is handed the full discount; module 05 ports the
              // semantics and not the hole.
              subtotal < minOrder
              ? "below_min_order"
              : null;
    if (reason) {
      return {
        valid: false,
        code: wanted,
        discount: 0,
        reason,
        // Only on the one reason the buyer can act on. Naming an expiry date or
        // a usage counter is telling a customer about the shop's bookkeeping.
        ...(reason === "below_min_order" ? { minOrder } : {}),
      };
    }
    const type: DiscountKind = coupon!.type ?? "PERCENT";
    const discount =
      type === "PERCENT"
        ? Math.round((subtotal * Number(coupon!.amount ?? coupon!.percentOff ?? 0)) / 100)
        : // Clamped to the cart. `store.js:599`/`:745` do NOT clamp, so a FIXED
          // coupon larger than the cart writes a negative `total` and a negative
          // `due` — the number the courier's COD amount is computed from. An
          // eval that could produce a negative COD would be pinning that bug.
          Math.min(Number(coupon!.amount ?? 0), subtotal);
    return { valid: true, code: wanted, discount, type };
  }

  async validateCoupon(code: string, subtotal: number): Promise<CouponValidation> {
    return this.judgeCoupon(code, subtotal);
  }

  /**
   * Stage 1 authority state, composed from the demo seed.
   *
   * The demo store starts with no locks and no per-door modes — a founder who
   * has configured nothing. Guardrails come from the seeded autonomy config so
   * the demo and the gate agree, and `spentTodayMinor` is summed from actions
   * actually executed today rather than tracked separately, which keeps it
   * honest when a test time-travels a record.
   */
  async getAuthority(): Promise<AuthorityState> {
    const autonomy = this.data.autonomy;
    const startOfDay = new Date(this.now().slice(0, 10) + "T00:00:00.000Z").getTime();
    let spentTodayMinor = 0;
    for (const a of this.data.actions) {
      if (a.status !== "executed" || !a.executedAt) continue;
      if (Date.parse(a.executedAt) < startOfDay) continue;
      const spend = SPEND_MINOR[a.type];
      if (spend) spentTodayMinor += Math.max(0, spend(a.payload as Record<string, unknown>) || 0);
    }
    return {
      level: autonomy.level,
      // No trust formula until phase 08 — the ceiling simply tracks the level.
      earnedLevel: autonomy.level,
      guardrails: {
        version: 1,
        dailySpendCapMinor: this.data.dailySpendCapMinor ?? 500_000,
        maxDiscountPct: autonomy.guardrails.maxDiscountPct,
        noTouch: this.data.noTouch ?? [],
        platform: autonomy.guardrails,
      },
      modes: this.data.modes ?? { store: "autonomous" },
      duties: Object.fromEntries(
        DUTIES.map((d) => [
          d.key,
          { key: d.key, minLevel: d.minLevel, enabled: true, doorExists: DOORS[d.door]?.exists ?? false },
        ]),
      ),
      spentTodayMinor,
    };
  }

  // ---- Decisions (E-9) ----

  async listDecisions(filter?: { status?: DecisionRecord["status"]; tag?: string; limit?: number }): Promise<DecisionRecord[]> {
    const rows = (this.data.decisions ?? [])
      .filter((d) => (filter?.status === undefined || d.status === filter.status) && (filter?.tag === undefined || d.tag === filter.tag))
      // Pinned first, then FIFO. A founder should meet the urgent ask before
      // the queue buries it, but order is otherwise the order they were asked.
      .sort((a, b) => a.priority - b.priority || a.queuePos - b.queuePos);
    return filter?.limit ? rows.slice(0, filter.limit) : rows;
  }

  async addDecision(input: Omit<DecisionRecord, "id" | "createdAt" | "queuePos" | "status" | "decidedBy" | "decidedAt" | "bundleRef" | "frozenByLock">): Promise<DecisionRecord> {
    const all = this.data.decisions ?? (this.data.decisions = []);
    const created: DecisionRecord = {
      ...input,
      id: this.nextId("dec"),
      bundleRef: null,
      status: "queued",
      queuePos: all.reduce((max, d) => Math.max(max, d.queuePos), 0) + 1,
      frozenByLock: null,
      decidedBy: null,
      decidedAt: null,
      createdAt: this.now(),
    };
    all.push(created);
    return created;
  }

  async updateDecision(id: string, patch: Partial<Pick<DecisionRecord, "status" | "surfacedIn" | "queuePos" | "frozenByLock" | "decidedBy" | "decidedAt">>): Promise<DecisionRecord> {
    const decision = this.mustFind((this.data.decisions ?? []).find((d) => d.id === id), "Decision", id);
    // "Later" sends a card to the BACK of the queue rather than dropping it —
    // the founder deferred it, they did not decline it.
    if (patch.status === "later" && patch.queuePos === undefined) {
      const all = this.data.decisions ?? [];
      decision.queuePos = all.reduce((max, d) => Math.max(max, d.queuePos), 0) + 1;
    }
    Object.assign(decision, patch);
    return decision;
  }

  async setNoTouch(locks: string[]): Promise<string[]> {
    this.data.noTouch = [...locks];
    return this.data.noTouch;
  }

  // ---- Grow Lab (read-only) ----
  //
  // The demo seed ships no Grow rows, so these read empty. That is the honest
  // state for a demo store nobody has worked in — Nova should say "nothing in
  // Content Studio yet", not invent a founder's backlog. Seeds may populate
  // the optional collections when a scenario needs them.

  async listGrowCampaigns(status?: GrowCampaign["status"]): Promise<GrowCampaign[]> {
    const rows = this.data.growCampaigns ?? [];
    return status === undefined ? rows : rows.filter((c) => c.status === status);
  }

  async listGrowPosts(status?: GrowPost["status"]): Promise<GrowPost[]> {
    const rows = this.data.growPosts ?? [];
    return status === undefined ? rows : rows.filter((p) => p.status === status);
  }

  async listGrowBroadcasts(): Promise<GrowBroadcast[]> {
    return this.data.growBroadcasts ?? [];
  }

  async listGrowIdeas(status?: GrowIdea["status"]): Promise<GrowIdea[]> {
    const rows = this.data.growIdeas ?? [];
    return status === undefined ? rows : rows.filter((i) => i.status === status);
  }

  async getGrowGoal(month?: string): Promise<GrowGoal | null> {
    const key = month ?? this.now().slice(0, 7);
    return (this.data.growGoals ?? []).find((g) => g.month === key) ?? null;
  }

  async updateDiscount(id: string, patch: { active: boolean }): Promise<Discount> {
    const discount = this.mustFind(
      this.data.discounts.find((d) => d.id === id),
      "Discount",
      id,
    );
    discount.active = patch.active;
    return discount;
  }

  // ---- Support & messaging ----

  async listSupportTickets(status?: TicketStatus): Promise<SupportTicket[]> {
    return this.data.supportTickets.filter((t) => status === undefined || t.status === status);
  }

  async getSupportTicket(id: string): Promise<SupportTicket | null> {
    return this.data.supportTickets.find((t) => t.id === id) ?? null;
  }

  async addTicketMessage(
    ticketId: string,
    message: { from: "nova" | "owner"; text: string },
  ): Promise<SupportTicket> {
    const ticket = this.mustFind(
      this.data.supportTickets.find((t) => t.id === ticketId),
      "Ticket",
      ticketId,
    );
    ticket.messages.push({ ...message, at: this.now() });
    return ticket;
  }

  async updateTicketStatus(ticketId: string, status: TicketStatus): Promise<SupportTicket> {
    const ticket = this.mustFind(
      this.data.supportTickets.find((t) => t.id === ticketId),
      "Ticket",
      ticketId,
    );
    ticket.status = status;
    return ticket;
  }

  async listCustomerMessages(filter?: {
    purpose?: CustomerMessage["purpose"];
    sinceDays?: number;
  }): Promise<CustomerMessage[]> {
    const cutoff = filter?.sinceDays !== undefined ? this.sinceCutoff(filter.sinceDays) : null;
    return this.data.customerMessages.filter(
      (m) =>
        (filter?.purpose === undefined || m.purpose === filter.purpose) &&
        (cutoff === null || Date.parse(m.sentAt) >= cutoff),
    );
  }

  async addCustomerMessage(message: Omit<CustomerMessage, "id" | "sentAt">): Promise<CustomerMessage> {
    const created: CustomerMessage = {
      ...message,
      id: this.nextId("msg"),
      sentAt: this.now(),
    };
    this.data.customerMessages.push(created);
    return created;
  }

  // ---- Suppliers & logistics ----

  async listSuppliers(): Promise<Supplier[]> {
    return this.data.suppliers;
  }

  async getSupplier(id: string): Promise<Supplier | null> {
    return this.data.suppliers.find((s) => s.id === id) ?? null;
  }

  async listPurchaseOrders(status?: PurchaseOrder["status"]): Promise<PurchaseOrder[]> {
    return this.data.purchaseOrders.filter((po) => status === undefined || po.status === status);
  }

  async createPurchaseOrder(po: Omit<PurchaseOrder, "id" | "createdAt" | "total">): Promise<PurchaseOrder> {
    const created: PurchaseOrder = {
      ...po,
      id: this.nextId("po"),
      total: Math.round(po.quantity * po.unitCost * 100) / 100,
      createdAt: this.now(),
    };
    this.data.purchaseOrders.push(created);
    return created;
  }

  async updatePurchaseOrder(id: string, patch: { status: PurchaseOrder["status"] }): Promise<PurchaseOrder> {
    const po = this.mustFind(
      this.data.purchaseOrders.find((p) => p.id === id),
      "Purchase order",
      id,
    );
    po.status = patch.status;
    return po;
  }

  async listCouriers(): Promise<Courier[]> {
    return this.data.couriers;
  }

  async getCourier(id: string): Promise<Courier | null> {
    return this.data.couriers.find((c) => c.id === id) ?? null;
  }

  // ---- Finance ----

  async listExpenses(sinceDays?: number): Promise<ExpenseEntry[]> {
    const cutoff = sinceDays !== undefined ? this.sinceCutoff(sinceDays) : null;
    return this.data.expenses.filter(
      (e) => cutoff === null || Date.parse(`${e.date}T00:00:00Z`) >= cutoff,
    );
  }

  // ---- Ledger-backed finance ----
  // A seed without `finance` answers `ledgerActive: false` everywhere — the
  // exact answer a real un-onboarded tenant gives — so the demo store never
  // fabricates books, and evals can opt into grounded fixtures per seed.

  async getFinanceOverview(): Promise<FinanceOverview> {
    return this.data.finance?.overview ?? { ledgerActive: false };
  }

  async getFinancePnl(): Promise<FinancePnl> {
    return this.data.finance?.pnl ?? { ledgerActive: false };
  }

  async getFinanceAccounts(): Promise<FinanceAccounts> {
    return this.data.finance?.accounts ?? { ledgerActive: false };
  }

  async getAccountStatement(code: string): Promise<AccountStatement | null> {
    if (!this.data.finance) return { ledgerActive: false };
    return this.data.finance.statements[code] ?? null;
  }

  // ---- Nova agent data ----

  async getAutonomy(): Promise<AutonomyConfig> {
    return this.data.autonomy;
  }

  async setAutonomy(config: AutonomyConfig): Promise<AutonomyConfig> {
    this.data.autonomy = config;
    return config;
  }

  async listMemory(namespace?: MemoryNamespace): Promise<MemoryEntry[]> {
    return this.data.memory.filter((m) => namespace === undefined || m.namespace === namespace);
  }

  async upsertMemory(entry: MemoryUpsert): Promise<MemoryEntry> {
    const existing = this.data.memory.find(
      (m) => m.namespace === entry.namespace && m.key === entry.key,
    );
    if (existing) {
      existing.value = entry.value;
      existing.updatedAt = this.now();
      if (entry.source !== undefined) existing.source = entry.source;
      if (entry.provenance !== undefined) existing.provenance = entry.provenance;
      if (entry.weight !== undefined) existing.weight = entry.weight;
      if (entry.expiresAt !== undefined) existing.expiresAt = entry.expiresAt;
      // A changed value invalidates the old embedding; re-embed on next pass
      // unless the caller supplied one alongside the new value.
      existing.embedding = entry.embedding ?? null;
      return existing;
    }
    const created: MemoryEntry = {
      namespace: entry.namespace,
      key: entry.key,
      value: entry.value,
      updatedAt: this.now(),
      source: entry.source ?? "owner",
      provenance: entry.provenance ?? null,
      weight: entry.weight ?? 1.0,
      expiresAt: entry.expiresAt ?? null,
      embedding: entry.embedding ?? null,
    };
    this.data.memory.push(created);
    return created;
  }

  async deleteMemory(namespace: MemoryNamespace, key: string): Promise<boolean> {
    const index = this.data.memory.findIndex(
      (m) => m.namespace === namespace && m.key === key,
    );
    if (index === -1) return false;
    // Hard delete — the row and its embedding go together (compliance).
    this.data.memory.splice(index, 1);
    return true;
  }

  async setMemoryEmbedding(
    namespace: MemoryNamespace,
    key: string,
    embedding: number[],
  ): Promise<boolean> {
    const entry = this.data.memory.find((m) => m.namespace === namespace && m.key === key);
    if (!entry) return false;
    entry.embedding = embedding;
    return true;
  }

  async listActivity(filter?: {
    sinceDays?: number;
    department?: ActivityEntry["department"];
  }): Promise<ActivityEntry[]> {
    const cutoff = filter?.sinceDays !== undefined ? this.sinceCutoff(filter.sinceDays) : null;
    return this.data.activity.filter(
      (a) =>
        (cutoff === null || Date.parse(a.at) >= cutoff) &&
        (filter?.department === undefined || a.department === filter.department),
    );
  }

  async addActivity(entry: Omit<ActivityEntry, "id" | "at">): Promise<ActivityEntry> {
    const created: ActivityEntry = { ...entry, id: this.nextId("act"), at: this.now() };
    this.data.activity.push(created);
    return created;
  }

  async updateActivity(
    id: string,
    patch: Partial<Pick<ActivityEntry, "revenueInfluence" | "revenueBasis" | "revenueProvenance">>,
  ): Promise<ActivityEntry> {
    const activity = this.mustFind(
      this.data.activity.find((a) => a.id === id),
      "Activity",
      id,
    );
    Object.assign(activity, patch);
    return activity;
  }

  // ---- Night shift outputs (E-4/E-6/E-7/E-16) — in-memory twin for evals ----
  private nightDepts: DepartmentGrade[] = [];
  private nightPlan: PlanItem[] = [];
  private nightBriefs: MorningBrief[] = [];

  async setDepartment(dept: DepartmentGrade): Promise<DepartmentGrade> {
    const saved: DepartmentGrade = { ...dept, gradedAt: dept.gradedAt ?? this.now() };
    const idx = this.nightDepts.findIndex((d) => d.key === dept.key);
    if (idx >= 0) this.nightDepts[idx] = saved;
    else this.nightDepts.push(saved);
    return saved;
  }

  async listDepartments(): Promise<DepartmentGrade[]> {
    return [...this.nightDepts];
  }

  async addPlanItem(item: Omit<PlanItem, "id">): Promise<PlanItem> {
    const created: PlanItem = { ...item, id: this.nextId("plan") };
    this.nightPlan.push(created);
    return created;
  }

  async fileBrief(input: { day?: string; narrative?: string }): Promise<MorningBrief> {
    const day = input.day ?? this.now().slice(0, 10);
    const existing = this.nightBriefs.find((b) => b.day === day);
    if (existing) {
      if (input.narrative != null) existing.narrative = input.narrative;
      return existing;
    }
    const created: MorningBrief = {
      id: this.nextId("brief"), day, narrative: input.narrative ?? "",
      tiles: [], decisionRefs: [], openedAt: null,
    };
    this.nightBriefs.push(created);
    return created;
  }

  // A seeded brand voice so evals (and a store that hasn't configured one) have
  // a real profile to score against: warm/handmade/cozy tone, "cheap" and
  // "limited time only" off-limits. The live backend serves the founder's own.
  private brandProfile: BrandProfile = {
    toneWords: ["warm", "handmade", "cozy"],
    palette: [],
    rules: [
      { kind: "dont", text: "cheap" },
      { kind: "dont", text: "limited time only" },
    ],
    languages: ["en", "bn"],
    assets: {},
    threshold: 70,
  };
  async getBrandProfile(): Promise<BrandProfile> {
    return this.brandProfile;
  }

  private nightContent: ContentItem[] = [];
  async fileContent(input: ContentDraftInput): Promise<ContentItem> {
    if (input.id) {
      const existing = this.nightContent.find((c) => c.id === input.id);
      if (existing) {
        Object.assign(existing, { body: input.body, voiceScore: input.voiceScore, violations: input.violations, status: "review" });
        return existing;
      }
    }
    const created: ContentItem = {
      id: this.nextId("content"), type: input.type, title: input.title, language: input.language,
      body: input.body, status: "review", voiceScore: input.voiceScore, violations: input.violations,
      createdAt: this.now(),
    };
    this.nightContent.push(created);
    return created;
  }

  // ---- Procedural memory: playbooks ----

  private get playbooks(): NovaPlaybook[] {
    if (!this.data.playbooks) this.data.playbooks = [];
    return this.data.playbooks;
  }

  async listPlaybooks(status?: NovaPlaybook["status"]): Promise<NovaPlaybook[]> {
    return this.playbooks.filter((p) => status === undefined || p.status === status);
  }

  async upsertPlaybook(
    playbook: Omit<NovaPlaybook, "id" | "createdAt"> & { id?: string },
  ): Promise<NovaPlaybook> {
    const existing = this.playbooks.find(
      (p) => (playbook.id !== undefined && p.id === playbook.id) || p.name === playbook.name,
    );
    if (existing) {
      existing.description = playbook.description;
      existing.markdown = playbook.markdown;
      existing.status = playbook.status;
      existing.createdFrom = playbook.createdFrom;
      return existing;
    }
    const created: NovaPlaybook = {
      id: playbook.id ?? this.nextId("play"),
      name: playbook.name,
      description: playbook.description,
      markdown: playbook.markdown,
      status: playbook.status,
      createdFrom: playbook.createdFrom,
      createdAt: this.now(),
    };
    this.playbooks.push(created);
    return created;
  }

  async updatePlaybookStatus(id: string, status: NovaPlaybook["status"]): Promise<NovaPlaybook> {
    const playbook = this.mustFind(
      this.playbooks.find((p) => p.id === id),
      "Playbook",
      id,
    );
    playbook.status = status;
    return playbook;
  }

  // ---- Experiments ----

  private get experiments(): NovaExperiment[] {
    if (!this.data.experiments) this.data.experiments = [];
    return this.data.experiments;
  }

  async listExperiments(status?: NovaExperiment["status"]): Promise<NovaExperiment[]> {
    return this.experiments.filter((e) => status === undefined || e.status === status);
  }

  async getExperiment(id: string): Promise<NovaExperiment | null> {
    return this.experiments.find((e) => e.id === id) ?? null;
  }

  async createExperiment(experiment: Omit<NovaExperiment, "id" | "startedAt">): Promise<NovaExperiment> {
    const created: NovaExperiment = {
      ...experiment,
      id: this.nextId("exp"),
      startedAt: this.now(),
    };
    this.experiments.push(created);
    return created;
  }

  async updateExperiment(
    id: string,
    patch: Partial<Pick<NovaExperiment, "actual" | "status" | "evaluatedAt" | "actionIds">>,
  ): Promise<NovaExperiment> {
    const experiment = this.mustFind(
      this.experiments.find((e) => e.id === id),
      "Experiment",
      id,
    );
    Object.assign(experiment, patch);
    return experiment;
  }

  async listActions(status?: ActionStatus): Promise<ActionRecord[]> {
    return this.data.actions.filter((a) => status === undefined || a.status === status);
  }

  async getAction(id: string): Promise<ActionRecord | null> {
    return this.data.actions.find((a) => a.id === id) ?? null;
  }

  async addAction(record: Omit<ActionRecord, "id" | "createdAt">): Promise<ActionRecord> {
    const created: ActionRecord = {
      ...record,
      id: this.nextId("action"),
      createdAt: this.now(),
    };
    // Mirror dakio-api's server-computed undo window: 24h from execution on
    // undoable executions (undo is a right with a clock — E-8).
    if (created.status === "executed" && created.undoable && created.executedAt && !created.undoDeadline) {
      created.undoDeadline = new Date(Date.parse(created.executedAt) + 24 * 3600 * 1000).toISOString();
    }
    this.data.actions.push(created);
    return created;
  }

  async updateAction(
    id: string,
    patch: Partial<
      Pick<ActionRecord, "status" | "outcome" | "undoData" | "undoable" | "decidedAt" | "executedAt">
    >,
  ): Promise<ActionRecord> {
    const action = this.mustFind(
      this.data.actions.find((a) => a.id === id),
      "Action",
      id,
    );
    Object.assign(action, patch);
    // Mirror dakio-api stamping: undoneAt on undo; undo window when a prepared
    // action executes as undoable (the approve path).
    if (patch.status === "undone" && !action.undoneAt) {
      action.undoneAt = this.now();
    }
    if (action.status === "executed" && action.undoable && action.executedAt && !action.undoDeadline) {
      action.undoDeadline = new Date(Date.parse(action.executedAt) + 24 * 3600 * 1000).toISOString();
    }
    return action;
  }

  async executePreparedAction(actionId: string): Promise<{ executed: boolean; note: string }> {
    // Mirror of dakio-api's approve pipeline for the in-memory store. The
    // demo store has no door executors, so the two honest outcomes are the
    // advisory acknowledgement and "nothing ran" — never a fabricated effect.
    const ADVISORY = new Set(["suggest_reorder", "suggest_restock", "flag_rto_spike", "flag_risk", "recommend"]);
    const action = this.mustFind(
      this.data.actions.find((a) => a.id === actionId),
      "Action",
      actionId,
    );
    if (action.status !== "prepared") {
      throw new Error(`Action is ${action.status}, not awaiting approval.`);
    }
    if (!ADVISORY.has(action.type)) {
      return { executed: false, note: "No executor is registered for this action yet — nothing ran." };
    }
    action.status = "executed";
    action.outcome = "Acknowledged — recommendation accepted; no automated store change.";
    action.decidedAt = this.now();
    action.executedAt = this.now();
    return { executed: true, note: action.outcome };
  }

  async attributeDoorRecord(_targetRef: string, _actionId: string): Promise<void> {
    // The in-memory demo store has no door tables to stamp; the live backend
    // (dakio.ts → POST /agent-data/attribute) persists the link.
  }

  async listReports(filter?: { kind?: NovaReport["kind"]; limit?: number }): Promise<NovaReport[]> {
    const matching = this.data.reports
      .filter((r) => filter?.kind === undefined || r.kind === filter.kind)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    return filter?.limit !== undefined ? matching.slice(0, filter.limit) : matching;
  }

  async addReport(report: Omit<NovaReport, "id" | "createdAt">): Promise<NovaReport> {
    // A dedupeKey collision returns the ORIGINAL report (mirrors dakio-api's
    // novaJobs-safety P2002 handling) — a job that reran after failing to
    // mark itself done must not double-file.
    if (report.dedupeKey) {
      const existing = this.data.reports.find((r) => r.dedupeKey === report.dedupeKey);
      if (existing) return existing;
    }
    const created: NovaReport = {
      ...report,
      id: this.nextId("rpt"),
      createdAt: this.now(),
    };
    this.data.reports.push(created);
    return created;
  }

  // The demo backend has no external event source (no real Dakio webhooks/
  // mutations to react to) — seeds simply start with an empty inbox unless a
  // seed explicitly pre-populates `inboxEvents` for a scenario/eval.
  async listInboxEvents(filter?: { processed?: boolean }): Promise<InboxEvent[]> {
    const events = this.data.inboxEvents ?? [];
    if (filter?.processed === undefined) return events;
    return events.filter((e) => (filter.processed ? e.processedAt !== null : e.processedAt === null));
  }

  async markEventProcessed(id: string): Promise<InboxEvent> {
    const events = (this.data.inboxEvents ??= []);
    const event = this.mustFind(
      events.find((e) => e.id === id),
      "Inbox event",
      id,
    );
    event.processedAt = this.now();
    return event;
  }

  // ---- Front Office — customer conversations (Stage 10, module 02) ----
  //
  // The demo backend plays dakio-api's `/api/v1/inbox/*` surface: it runs the
  // SAME guard ladder (thread off → founder lock → someone already answered →
  // customer double-texted → 24h window → loop cap) and refuses with the same
  // codes, so a refusal path can be exercised without Meta, a webhook, or a
  // database. Two things it deliberately does NOT do, because they are not
  // ours to fake: the human-timing engine (dakio-api computes `scheduledAt`
  // from read/typing delays and hour-of-day bands) and the Graph send. A
  // queued row here is queued, never "delivered".

  /**
   * Materialize a conversation for a demo or eval run. Not part of
   * {@link StoreClient}: the live backend's threads are created by real
   * customers through the Meta webhook, and a demo store that conjured one on
   * first read would be inventing a customer.
   */
  seedInboxConversation(seed: DemoInboxSeed): InboxThread {
    const now = this.now();
    const messages: InboxMessageView[] = (seed.messages ?? []).map((m, index) => ({
      id: m.id ?? `inmsg-${seed.id}-${index + 1}`,
      direction: m.direction,
      actor: m.actor,
      text: m.text,
      attachmentUrl: m.attachmentUrl ?? null,
      attachmentType: m.attachmentType ?? null,
      purpose: m.purpose ?? null,
      novaActionId: m.novaActionId ?? null,
      sentAt: m.sentAt ?? now,
      metaTimestamp: m.sentAt ?? now,
    }));
    const lastInbound = [...messages].reverse().find((m) => m.direction === "in");
    const thread: DemoInboxThread = {
      conversation: {
        id: seed.id,
        platform: seed.platform ?? "messenger",
        senderName: seed.senderName ?? "Demo customer",
        customerId: seed.customerId ?? null,
        handledBy: seed.handledBy ?? null,
        novaLockedAt: seed.novaLockedAt ?? null,
        novaEnabled: seed.novaEnabled ?? true,
        lastIntent: seed.lastIntent ?? null,
        escalatedAt: null,
        lastInboundAt: lastInbound?.sentAt ?? null,
        windowExpiresAt:
          seed.windowExpiresAt ??
          new Date(Date.parse(lastInbound?.sentAt ?? now) + DAY_MS).toISOString(),
        lastMessageAt: messages[messages.length - 1]?.sentAt ?? null,
      },
      messages,
      customer: seed.customer ?? null,
      proposal: seed.proposal ?? null,
      nba: seed.nba ?? null,
      // A seeded link is a human writing the join by hand, which is exactly
      // what `founder_manual` means — the one rung of the ladder a demo can
      // honestly claim. `linkCustomer` overwrites it with the rung it used.
      customerLinkSource: seed.customerId ? "founder_manual" : null,
      claimedPhone: null,
      outbounds: [],
    };
    this.inbox.set(seed.id, thread);
    return {
      conversation: thread.conversation,
      messages: thread.messages,
      customer: thread.customer,
      proposal: thread.proposal,
      nba: thread.nba,
    };
  }

  /**
   * The demo backend has no conversation-state store, so there is nothing to
   * record into. A no-op rather than a throw: the caller is advisory by
   * contract and a demo run must not diverge from production on a path whose
   * whole point is that it cannot affect the reply.
   */
  async noteProductIdentified(): Promise<void> {}

  /**
   * The demo store never rolls: there is no server counting turns, and a demo
   * session that re-keyed itself mid-script would look like a bug. 0 renders no
   * token segment at all, which is exactly today's behaviour.
   */
  async getSessionEpoch(): Promise<number> {
    return 0;
  }

  async getInboxConversation(
    conversationId: string,
    opts?: { messages?: number },
  ): Promise<InboxThread | null> {
    const thread = this.inbox.get(conversationId);
    if (!thread) return null;
    const limit = Math.min(Math.max(opts?.messages ?? 50, 1), 50);
    return {
      conversation: { ...thread.conversation },
      // Newest last, oldest trimmed first — the tail is what a reply needs.
      messages: thread.messages.slice(-limit).map((m) => ({ ...m })),
      customer: thread.customer,
      // A linked thread has nothing to propose — the proposal is cleared on
      // link or on mismatch, and it is never a substitute for one.
      proposal: thread.conversation.customerId === null ? thread.proposal : null,
      // Module 04. Handed back as-is: dakio-api embeds the same block it would
      // return from `GET /nba/:conversationId`, assembled once per read.
      nba: thread.nba,
    };
  }

  async replyInThread(conversationId: string, input: InboxReplyRequest): Promise<InboxReplyResult> {
    const thread = this.inbox.get(conversationId);
    if (!thread) throw new Error(`Conversation not found: ${conversationId}`);
    const c = thread.conversation;
    const nowMs = Date.parse(this.now());

    // 1. Per-thread founder switch.
    if (c.novaEnabled !== true) {
      throw new InboxSendRefused("THREAD_OFF", `Nova is switched off for conversation ${conversationId}.`);
    }
    // 2. The founder holds the thread. No exceptions, ever — holding and SLA
    //    lines are system sends that never pass through this path.
    if (c.novaLockedAt !== null || c.handledBy === "founder") {
      throw new InboxSendRefused("LOCKED", `The founder has conversation ${conversationId}; Nova does not write on it.`);
    }
    const anchor = thread.messages.find((m) => m.id === input.inReplyToMessageId);
    if (!anchor) {
      // Cannot prove freshness against a message that is not in the thread.
      throw new InboxSendRefused("STALE", `Unknown inReplyToMessageId ${input.inReplyToMessageId}; re-read the thread.`);
    }
    const anchorAt = Date.parse(anchor.sentAt);
    // 3. Someone already answered by hand since the anchor.
    if (
      thread.messages.some(
        (m) =>
          m.direction === "out" &&
          (m.actor === "founder" || m.actor === "founder_external") &&
          Date.parse(m.sentAt) > anchorAt,
      )
    ) {
      throw new InboxSendRefused("LOCKED", "The founder already answered this message.");
    }
    // 4. The customer wrote again — answering the old message now is worse
    //    than not answering at all.
    if (thread.messages.some((m) => m.direction === "in" && Date.parse(m.sentAt) > anchorAt)) {
      throw new InboxSendRefused("STALE", "The customer sent another message; re-read the thread before replying.");
    }
    // 5. Meta's 24h window. v1 refuses honestly — no MESSAGE_TAG, ever.
    if (c.windowExpiresAt !== null && Date.parse(c.windowExpiresAt) <= nowMs) {
      throw new InboxSendRefused("WINDOW_CLOSED", "The 24h messaging window closed; this reply cannot be sent.");
    }
    // 6. Loop breaker: consecutive Nova messages since the last inbound.
    let consecutive = 0;
    for (let i = thread.messages.length - 1; i >= 0; i -= 1) {
      const m = thread.messages[i]!;
      if (m.direction === "in") break;
      if (m.actor === "nova") consecutive += 1;
    }
    if (consecutive >= NOVA_MAX_CONSECUTIVE_OUTBOUND) {
      throw new InboxSendRefused(
        "LOOP_GUARD",
        `${consecutive} Nova messages since the customer last wrote — stopping rather than talking to itself.`,
      );
    }

    // Pass. dakio-api would schedule each bubble through the pacing engine;
    // the demo queues them at once and inserts the message rows the ledger
    // links to. `scheduledAt` is honest about that: it is now, not a
    // simulated human delay.
    const scheduledAt = this.now();
    const outboundId = this.nextId("outb");
    const inserted: InboxMessageView[] = input.chunks.map((chunk, index) => ({
      id: `inmsg-${outboundId}-${index + 1}`,
      direction: "out",
      actor: "nova",
      text: chunk.text,
      attachmentUrl: null,
      attachmentType: null,
      purpose: input.purpose ?? null,
      novaActionId: input.novaActionId,
      sentAt: scheduledAt,
      metaTimestamp: scheduledAt,
    }));
    thread.messages.push(...inserted);
    thread.outbounds.push({
      id: outboundId,
      novaActionId: input.novaActionId,
      chunks: input.chunks,
      status: "sent",
      scheduledAt,
    });
    c.lastMessageAt = scheduledAt;
    c.lastIntent = input.intent;
    c.handledBy = "nova";
    // D7: the promise is co-created with the outbound, not after it. dakio-api
    // does this inside the same `$transaction`; the demo does it in the same
    // statement, past every guard above — a promise made on a refused send
    // would be a debt for a message the customer never got.
    if (input.promise) {
      this.promises.push({
        id: this.nextId("prm"),
        customerId: c.customerId,
        conversationId: conversationId,
        channelKind: c.platform,
        madeBy: "nova",
        text: input.promise.text,
        kind: input.promise.kind,
        dueAt: input.promise.dueAtISO,
        status: "open",
        keptAt: null,
        brokenAt: null,
      });
    }
    return {
      outboundId,
      scheduledAt,
      chunks: input.chunks,
      firstMessageId: inserted[0]!.id,
    };
  }

  async handoverConversation(
    conversationId: string,
    input: InboxHandoverRequest,
  ): Promise<InboxHandoverResult> {
    const thread = this.inbox.get(conversationId);
    if (!thread) throw new Error(`Conversation not found: ${conversationId}`);
    const c = thread.conversation;
    // Anti-spam: one open escalation per conversation. A second call updates
    // the brief instead of stacking a second ask on the founder's desk.
    if (c.escalatedAt !== null) {
      return { escalated: true, alreadyEscalated: true, decisionId: null, holdingSent: false };
    }
    c.escalatedAt = this.now();
    c.handledBy = "founder";
    // `novaLockedAt` stays null — no human has acted yet; escalation is Nova
    // stepping back, not the founder stepping in.
    return { escalated: true, decisionId: null, holdingSent: false, alreadyEscalated: false };
  }

  // ---- Front Office — identity and promises (Stage 10, module 03) ----
  //
  // The demo plays dakio-api's decision-making half: it normalizes the phone,
  // counts matches, and answers. What it deliberately does NOT play is the
  // CustomerChannel spoke table (there is no channel model here, so
  // `channelWritten` is always false and `channelsMoved` is always 0) or the
  // psid→customerId memory migration. Both are named rather than faked.

  /**
   * Teach the demo which phone belongs to which customer. Not part of
   * {@link StoreClient}: the live backend reads a real `Customer.phone` column,
   * and a demo store that guessed the mapping would be inventing the single
   * fact the whole identity ladder is built on. Seed the same phone twice to
   * exercise the collision → `mergeProposed` path.
   */
  seedCustomerPhone(phone: string, customerId: string): void {
    this.customerPhones.push({ phone: demoNormalizePhone(phone), customerId });
  }

  /**
   * Materialize a promise for a demo or eval run. Not part of
   * {@link StoreClient}: promises are co-created with a real queued reply
   * (see `replyInThread`), and a store that conjured one would be inventing a
   * debt nobody took on.
   */
  seedPromise(seed: DemoPromiseSeed): InboxPromise {
    const promise: InboxPromise = {
      id: seed.id ?? this.nextId("prm"),
      customerId: seed.customerId ?? null,
      conversationId: seed.conversationId ?? null,
      channelKind: seed.channelKind ?? "messenger",
      madeBy: seed.madeBy ?? "nova",
      text: seed.text,
      kind: seed.kind,
      dueAt: seed.dueAt ?? new Date(Date.parse(this.now()) + DAY_MS).toISOString(),
      status: seed.status ?? "open",
      keptAt: null,
      brokenAt: null,
    };
    this.promises.push(promise);
    return { ...promise };
  }

  async linkCustomer(conversationId: string, input: LinkCustomerRequest): Promise<LinkCustomerResult> {
    const thread = this.inbox.get(conversationId);
    if (!thread) throw new Error(`Conversation not found: ${conversationId}`);
    const c = thread.conversation;

    // The digit check (D3): the caller supplies the digits the customer just
    // said — never the number being checked against. A failed check is an
    // answer, and it clears the proposal rather than leaving a candidate the
    // next turn would re-ask about.
    //
    // WHERE THE CANDIDATE COMES FROM, and how this differs from production:
    // the real route resolves it from the conversation's own
    // `proposedCustomerId` column and IGNORES `verify.customerId`, which is
    // advisory (it lands on the failure receipt and nowhere else). This demo
    // backend has no proposal column beyond the basis label, so it stands in
    // for that lookup with the advisory id — and when there is none, there is
    // no candidate to test, so the check fails, which is exactly what the real
    // route answers for a thread with no live proposal.
    if (input.verify) {
      const candidateId = input.verify.customerId ?? null;
      const known =
        candidateId === null ? undefined : this.customerPhones.find((row) => row.customerId === candidateId);
      const digits = input.verify.lastDigits.replace(/\D+/g, "");
      const passed = known !== undefined && digits.length > 0 && known.phone.endsWith(digits);
      thread.proposal = null;
      if (!passed || candidateId === null) return { matched: false, channelWritten: false };
      c.customerId = candidateId;
      thread.customerLinkSource = "digits_verified";
      return { matched: true, customerId: candidateId, channelWritten: false };
    }

    // The self-stated phone (D4). Zero matches is not a failure: the number is
    // held on the thread so the join materializes later, when an order finally
    // creates the Customer.
    const normalized = demoNormalizePhone(input.phone ?? "");
    const hits = normalized.length === 0 ? [] : this.customerPhones.filter((row) => row.phone === normalized);
    const distinct = [...new Set(hits.map((row) => row.customerId))];
    thread.proposal = null;
    if (distinct.length === 0) {
      thread.claimedPhone = normalized.length > 0 ? normalized : null;
      return { matched: false, channelWritten: false };
    }
    if (distinct.length > 1) {
      // D2's NEVER tier: two records, one number. The thread stays UNLINKED and
      // the merge goes to the founder — guessing a survivor here is exactly the
      // move that shows one customer another customer's orders.
      return { matched: false, channelWritten: false, mergeProposed: true };
    }
    c.customerId = distinct[0]!;
    thread.customerLinkSource = "phone_stated";
    thread.claimedPhone = null;
    return { matched: true, customerId: distinct[0]!, channelWritten: false };
  }

  async unlinkCustomer(conversationId: string): Promise<{ unlinked: boolean }> {
    const thread = this.inbox.get(conversationId);
    if (!thread) throw new Error(`Conversation not found: ${conversationId}`);
    const had = thread.conversation.customerId !== null;
    thread.conversation.customerId = null;
    thread.customerLinkSource = null;
    // The channel address is NOT removed (D4): it is a fact that was
    // established, and undoing a join must not forget something true.
    return { unlinked: had };
  }

  async listPromises(filter?: { status?: string; customerId?: string; limit?: number }): Promise<InboxPromise[]> {
    // `status` defaults to open server-side — the sweep and the brief both want
    // the debts, not the history.
    const status = filter?.status ?? "open";
    const limit = Math.min(Math.max(filter?.limit ?? 50, 1), 50);
    return this.promises
      .filter(
        (p) =>
          p.status === status &&
          (filter?.customerId === undefined || p.customerId === filter.customerId),
      )
      .slice(0, limit)
      .map((p) => ({ ...p }));
  }

  async settlePromise(
    promiseId: string,
    input: PromiseSettleRequest,
  ): Promise<{ ok: boolean; promise: InboxPromise }> {
    const promise = this.promises.find((p) => p.id === promiseId);
    if (!promise) throw new Error(`Promise not found: ${promiseId}`);
    // The wire is JSON; the type is a promise, not a guard. `broken` is the
    // sweep's word alone — a turn may keep or release a debt, it may never
    // declare its own failure away.
    const requested = String(input.status);
    if (requested !== "kept" && requested !== "released") {
      throw new InboxSendRefused(
        "PROMISE_TRANSITION",
        `"${requested}" is not settleable here; only kept | released are, and 'broken' belongs to the nightly sweep.`,
      );
    }
    if (promise.status !== "open") {
      // Losing this race is an ANSWER, usually "the sweep got there first" —
      // never an overwrite, and never a second transition on one debt.
      throw new InboxSendRefused(
        "PROMISE_SETTLED",
        `Promise ${promiseId} is already ${promise.status}; it does not transition twice.`,
      );
    }
    promise.status = requested === "kept" ? "kept" : "released";
    if (promise.status === "kept") promise.keptAt = this.now();
    return { ok: true, promise: { ...promise } };
  }

  async mergeCustomers(input: { customerIdA: string; customerIdB: string; basis: string }): Promise<{
    survivorCustomerId: string;
    mergedCustomerId: string;
    ordersMoved: number;
    channelsMoved: number;
    conversationsMoved: number;
    promisesMoved: number;
  }> {
    const a = this.mustFind(this.data.customers.find((c) => c.id === input.customerIdA), "Customer", input.customerIdA);
    const b = this.mustFind(this.data.customers.find((c) => c.id === input.customerIdB), "Customer", input.customerIdB);
    if (a.id === b.id) throw new Error(`Cannot merge customer ${a.id} into itself.`);
    // D5's survivor rule, server-side and not the caller's to choose: more
    // orders wins; a tie goes to the older record, because the older row is the
    // one other systems have had longer to reference.
    const ordersOf = (id: string): number => this.data.orders.filter((o) => o.customerId === id).length;
    const aWins =
      ordersOf(a.id) !== ordersOf(b.id)
        ? ordersOf(a.id) > ordersOf(b.id)
        : Date.parse(a.createdAt) <= Date.parse(b.createdAt);
    const survivor = aWins ? a : b;
    const merged = aWins ? b : a;

    let ordersMoved = 0;
    for (const order of this.data.orders) {
      if (order.customerId === merged.id) {
        order.customerId = survivor.id;
        ordersMoved += 1;
      }
    }
    let conversationsMoved = 0;
    for (const thread of this.inbox.values()) {
      if (thread.conversation.customerId === merged.id) {
        thread.conversation.customerId = survivor.id;
        conversationsMoved += 1;
      }
    }
    let promisesMoved = 0;
    for (const promise of this.promises) {
      if (promise.customerId === merged.id) {
        promise.customerId = survivor.id;
        promisesMoved += 1;
      }
    }
    for (const row of this.customerPhones) {
      if (row.customerId === merged.id) row.customerId = survivor.id;
    }
    // Recomputed from the repointed rows, never summed from the two stale
    // aggregates: two half-truths added together is a third wrong number.
    const survivorOrders = this.data.orders.filter((o) => o.customerId === survivor.id);
    survivor.ordersCount = survivorOrders.length;
    survivor.lifetimeValue = survivorOrders.reduce((sum, o) => sum + o.total, 0);
    // The demo drops the merged row because it has no `mergedIntoId` tombstone
    // column to record the redirect in. What actually happens to the loser row
    // is dakio-api's transaction to decide.
    this.data.customers.splice(this.data.customers.indexOf(merged), 1);

    return {
      survivorCustomerId: survivor.id,
      mergedCustomerId: merged.id,
      ordersMoved,
      // There is no CustomerChannel model in this backend, so this is honestly
      // zero rather than a plausible-looking count.
      channelsMoved: 0,
      conversationsMoved,
      promisesMoved,
    };
  }

  // ---- Front Office — lifecycle & NBA (Stage 10, module 04) ----
  //
  // The demo plays the COMMITMENT half in full — booking, idempotency,
  // supersession, the promise-backed exemption, cancellation — because those
  // are rules, and a rule this backend does not enforce is a rule an eval
  // cannot see broken.
  //
  // What it deliberately does NOT play, and says so at each site rather than
  // faking it: the NBA block itself (dakio-api derives it from a journey row,
  // the 360 and the tenant's guardrails), quiet-hour shifting (no tenant
  // timezone here), the `chainCount ≤ 2` cap (the count lives on the job rows
  // dakio-api keeps), and the D4 transition table (the reducer is the server's,
  // by D1.1 — "stage is code, never model output"). A demo that guessed any of
  // them would be guessing exactly the thing module 04 exists to compute.

  async getNba(conversationId: string): Promise<NbaBlock | null> {
    // A thread this backend has never seen and a thread with no journey row
    // answer the same way, and that is right: both mean "no scaffold", and the
    // caller's contract is to answer the person anyway.
    return this.inbox.get(conversationId)?.nba ?? null;
  }

  // ==========================================================================
  // Front Office — delivery coordination (Stage 10 module 06)
  //
  // The create-or-join is modelled for real rather than stubbed, because "one
  // parcel, one case, however many people ask" is the behaviour the evals rest
  // on. A demo backend that minted a fresh case per call would make every
  // coordination test pass for the wrong reason.
  // ==========================================================================

  private readonly cases: NovaCaseView[] = [];

  /** Mirrors dakio-api's `activeKeyFor` — order beats product beats thread. */
  private caseActiveKey(kind: string, subject: { orderId?: string | null; productId?: string | null; conversationId?: string | null }): string | null {
    if (subject.orderId) return `${kind}:order:${subject.orderId}`;
    if (subject.productId) return `${kind}:product:${subject.productId}`;
    if (subject.conversationId) return `${kind}:conv:${subject.conversationId}`;
    return null;
  }

  /** Mirrors dakio-api's `DEPARTMENT_BY_KIND`. Derived, never caller-supplied. */
  private caseDepartment(kind: string): string {
    const map: Record<string, string> = {
      delivery_stuck: "shipping",
      failed_attempt: "shipping",
      address_change_postdispatch: "shipping",
      payment_unverified: "finance",
      damaged_item: "support",
      restock_wait: "inventory",
    };
    const dept = map[kind];
    if (!dept) throw new Error(`Unknown case kind: ${kind}`);
    return dept;
  }

  private static readonly TERMINAL_CASE_STATUSES = ["resolved", "closed_unresolved", "expired"];

  async getOrderStatus(orderId: string): Promise<OrderStatusView | null> {
    const order = this.data.orders.find((o) => o.id === orderId);
    if (!order) return null;
    // The demo carries no courier scans, so `stuck` is honestly false and
    // `lastMovedAt` is honestly null rather than invented. An eval that needs a
    // stuck parcel seeds the case directly.
    const openCase = this.cases.find(
      (c) => c.orderId === orderId && !DemoStore.TERMINAL_CASE_STATUSES.includes(c.status),
    );
    return {
      orderNumber: order.id,
      displayStatus: order.status,
      statusStep: 1,
      courierProvider: order.courierId ?? null,
      codAmount: order.total ?? null,
      placedAt: order.placedAt,
      courierSentAt: null,
      lastMovedAt: null,
      confirmed: false,
      stuck: false,
      trackingCode: String(order.id).replace(/^#/, "").toUpperCase(),
      openCase: openCase
        ? {
            id: openCase.id,
            kind: openCase.kind,
            status: openCase.status,
            latestFact: openCase.facts.length ? openCase.facts[openCase.facts.length - 1].note : null,
          }
        : null,
    };
  }

  async openCase(input: OpenCaseRequest): Promise<{ case: NovaCaseView; joined: boolean }> {
    const department = this.caseDepartment(input.kind);
    const activeKey = this.caseActiveKey(input.kind, input);
    // Only a case that still HOLDS the key can be joined. A closed one released
    // it, which is what lets the same order have a second case later.
    const existing = activeKey
      ? this.cases.find(
          (c) =>
            !DemoStore.TERMINAL_CASE_STATUSES.includes(c.status) &&
            this.caseActiveKey(c.kind, c) === activeKey,
        )
      : undefined;

    const now = this.now();
    const fact = input.factsNote
      ? [{ at: now, source: input.factsSource ?? "nova", note: input.factsNote }]
      : [];

    if (existing) {
      existing.facts.push(...fact);
      // A set, not a list: the loop-closer fans out over this, so a duplicate
      // entry is one customer told the same thing twice.
      const convs = existing.refs.conversationIds ?? [];
      if (input.conversationId && !convs.includes(input.conversationId)) convs.push(input.conversationId);
      existing.refs.conversationIds = convs;
      existing.updatedAt = now;
      return { case: { ...existing }, joined: true };
    }

    const created: NovaCaseView = {
      id: this.nextId("case"),
      kind: input.kind,
      status: "open",
      department,
      conversationId: input.conversationId ?? null,
      orderId: input.orderId ?? null,
      customerId: input.customerId ?? null,
      journeyId: null,
      title: input.title,
      facts: fact,
      refs: input.conversationId ? { conversationIds: [input.conversationId] } : {},
      promiseId: null,
      openedByActionId: input.novaActionId ?? null,
      resolvedAt: null,
      resolution: null,
      createdAt: now,
      updatedAt: now,
      ageHours: 0,
    };
    this.cases.push(created);
    return { case: { ...created }, joined: false };
  }

  async getCase(caseId: string): Promise<NovaCaseView | null> {
    const found = this.cases.find((c) => c.id === caseId);
    return found ? { ...found } : null;
  }

  async patchCase(caseId: string, patch: PatchCaseRequest): Promise<NovaCaseView> {
    const found = this.cases.find((c) => c.id === caseId);
    if (!found) throw new Error(`Case not found: ${caseId}`);
    if (DemoStore.TERMINAL_CASE_STATUSES.includes(found.status) && patch.status && patch.status !== found.status) {
      throw new InboxSendRefused(
        "CASE_CLOSED",
        `This case is already ${found.status}; its key was released and another case may hold it now.`,
      );
    }
    // Append-only, exactly like the server. There is no branch that replaces.
    for (const f of patch.appendFacts ?? []) {
      found.facts.push({ at: this.now(), source: f.source ?? "nova", note: f.note, ...(f.data ? { data: f.data } : {}) });
    }
    if (patch.status) {
      if (DemoStore.TERMINAL_CASE_STATUSES.includes(patch.status) && !patch.resolution) {
        throw new Error("closing a case needs a one-sentence resolution, including when the ending is a bad one");
      }
      found.status = patch.status;
      if (DemoStore.TERMINAL_CASE_STATUSES.includes(patch.status)) {
        found.resolution = patch.resolution ?? null;
        found.resolvedAt = this.now();
      }
    }
    found.updatedAt = this.now();
    return { ...found };
  }

  async updateOrderDelivery(orderId: string, patch: UpdateOrderDeliveryRequest): Promise<Order> {
    const order = this.mustFind(this.data.orders.find((o) => o.id === orderId), "Order", orderId);
    // The demo has no `courierSentAt` column, so the pre-dispatch fence is
    // modelled on the status the seed DOES carry — same refusal shape as the
    // real route, so a flow that must handle it is exercised here too.
    const dispatched = order.status === "fulfilled" || order.status === "delivered" || order.status === "rto";
    if (dispatched && (patch.address || patch.city || patch.district || patch.phone || patch.confirm)) {
      throw new InboxSendRefused(
        "ALREADY_DISPATCHED",
        "This order is already with the courier, so its address cannot be edited here.",
      );
    }
    if (patch.status === "cancelled") order.status = "cancelled";
    return { ...order };
  }

  async scheduleFollowup(input: ScheduleFollowupRequest): Promise<ScheduleFollowupResult> {
    const thread = this.inbox.get(input.conversationId);
    if (!thread) throw new Error(`Conversation not found: ${input.conversationId}`);

    // The route is `w()`-idempotent on `scheduledByActionId` (it rides the
    // Idempotency-Key header). Replaying one decision must return the SAME
    // commitment, not book a second one and supersede the first — that would
    // read as Nova changing its mind on a network retry.
    const replay = this.followups.find((f) => f.scheduledByActionId === input.scheduledByActionId);
    if (replay) {
      return { jobId: replay.jobId, dueAt: replay.dueAt, superseded: replay.superseded };
    }

    const ms = FOLLOWUP_DELAY_MS[input.delay];
    if (ms === undefined) {
      // Not an Error: the route answers 409 with a code, because "that delay is
      // not legal here" is an ANSWER the model should read and pick again from.
      throw new InboxSendRefused(
        "FOLLOWUP_DELAY",
        `"${input.delay}" is not one of the bookable delays (${Object.keys(FOLLOWUP_DELAY_MS).join(" | ")}).`,
      );
    }
    // dueAt is `now + delay` and nothing else here. dakio-api additionally
    // shifts it out of the tenant's quiet hours; this backend has no timezone
    // to shift against, so it returns the unshifted time rather than a
    // plausible-looking one an eval would read as proof the shift works.
    const dueAt = new Date(Date.parse(this.now()) + ms).toISOString();

    // D7 supersession: ONE outstanding NBA nudge per conversation. Rows
    // carrying a `promiseId` are exempt and stay due — a customer coming back
    // cancels a nudge, but a debt is only settled by paying it (module 03 §4.1,
    // the rule `meta.js`'s cancel hook carries in a comment).
    let superseded: string | null = null;
    for (const row of this.followups) {
      if (row.conversationId !== input.conversationId) continue;
      if (row.status !== "due") continue;
      if (row.promiseId !== null) continue;
      row.status = "superseded";
      superseded = row.jobId;
    }

    const booked: DemoFollowup = {
      jobId: this.nextId("job"),
      conversationId: input.conversationId,
      journeyId: input.journeyId ?? null,
      dueAt,
      reason: input.reason,
      plannedIntent: input.plannedIntent,
      scheduledByActionId: input.scheduledByActionId,
      promiseId: input.promiseId ?? null,
      status: "due",
      superseded,
    };
    this.followups.push(booked);
    return { jobId: booked.jobId, dueAt: booked.dueAt, superseded };
  }

  async cancelFollowup(jobId: string): Promise<{ cancelled: boolean }> {
    const row = this.followups.find((f) => f.jobId === jobId);
    // A jobId this store never issued is a caller bug, not an outcome — unlike
    // an already-settled row, which is the ordinary race the undo button loses.
    if (!row) throw new Error(`Followup not found: ${jobId}`);
    if (row.status !== "due") return { cancelled: false };
    row.status = "cancelled";
    return { cancelled: true };
  }

  async postIntentObserved(
    journeyId: string,
    input: IntentObservedRequest,
  ): Promise<IntentObservedResult> {
    const thread = [...this.inbox.values()].find((t) => t.nba?.journey.id === journeyId);
    if (!thread?.nba) throw new Error(`Journey not found: ${journeyId}`);
    // Idempotent per (journeyId, messageId): one turn answers one inbound, and
    // a replayed callback must not record a second `do_nothing` — that marker
    // is what `journey.silences_chosen` counts.
    const seen = this.intentObservations.find(
      (o) => o.journeyId === journeyId && o.messageId === input.messageId,
    );
    if (!seen) {
      this.intentObservations.push({
        journeyId,
        intent: input.intent,
        messageId: input.messageId,
        nbaAction: input.nbaAction ?? null,
        nbaReason: input.nbaReason ?? null,
        at: this.now(),
      });
    }
    // `transitions: []` is the honest answer, not an empty stub: the D4 table
    // lives in dakio-api's `novaJourney.js` and is deliberately the one thing
    // no model-adjacent process computes. The stage is reported back exactly as
    // it was read, so nothing here can look like a stage this backend moved.
    return { stage: thread.nba.journey.stage, transitions: [] };
  }

  /**
   * The commitments this store holds, newest last. Not part of
   * {@link StoreClient}: the founder's list is a MERCHANT-plane route
   * (`GET /api/nova/followups`, JWT) that Nova's service token cannot read, so
   * exposing one here as a client method would invent a capability the agent
   * does not have. It exists for suites that need to see supersession happen.
   */
  listFollowups(conversationId?: string): DemoFollowup[] {
    return this.followups
      .filter((f) => conversationId === undefined || f.conversationId === conversationId)
      .map((f) => ({ ...f }));
  }

  /**
   * Every turn-end callback this store received. Not part of
   * {@link StoreClient} for the same reason as {@link listFollowups}: the
   * transition log is read by module 09's nightly pass over `JourneyTransition`
   * rows, never by the agent.
   */
  listIntentObservations(journeyId?: string): DemoIntentObservation[] {
    return this.intentObservations
      .filter((o) => journeyId === undefined || o.journeyId === journeyId)
      .map((o) => ({ ...o }));
  }

  // ---- Front Office — selling & conversion (Stage 10 module 05) ----
  //
  // What this backend PLAYS: catalogue pricing, the stock check and the stock
  // decrement, the coupon judgement, the district's shipping charge, the
  // one-order-per-novaActionId read-back, and the identity join when the phone
  // is in the demo phone book. Those are the rules an eval has to be able to
  // watch break.
  //
  // What it deliberately does NOT play, and says so here rather than faking it:
  // the fake-order guard (four rules keyed on a tenant config this backend has
  // no column for), the free-plan daily order cap (gated on an env var that is
  // inert unless set), VARIANTS (`Product` here has no variants array at all,
  // so `variantId` is carried onto the row and priced at the product's own
  // price — dakio-api applies the variant price override and decrements
  // `ProductVariant.stock`), and the customer-facing tracking page (there is no
  // storefront here, so `trackingUrl` is honestly null rather than a plausible
  // string an eval would read as proof the link works).

  async getStoreSettings(): Promise<StoreSettings> {
    return {
      storeName: "Demo Store",
      // Null, honestly: there is no storefront in this process. A plausible URL
      // here would be read as proof the tracking link works, and null is the
      // COMMON production answer too — it needs a verified custom domain or
      // `DAKIO_STOREFRONT_URL`, and neither is guaranteed.
      storefrontUrl: null,
      // WHOLE TAKA, and these are dakio-api's own column defaults
      // (`Tenant.deliveryInsideDhaka Int @default(60)` / `@default(120)`) rather
      // than round numbers picked here — a demo that invented its own delivery
      // charges would let a cap test pass at a figure production never uses.
      deliveryInsideDhaka: 60,
      deliveryOutsideDhaka: 120,
      codAvailable: true,
      // Empty is the ANSWER, not a stub: an absent policy row is how the
      // product says "the merchant has never told me this rule", which is
      // exactly what the `policy_gap` escalation reason reports. There is no
      // `TenantPolicy` seed and there should not be one.
      policies: [],
    };
  }

  /**
   * The demo's inside/outside-Dhaka test. dakio-api owns the real one — this is
   * a stand-in named for what it is, so nobody reads a district rule off this
   * file. It exists because a chat order has to be charged SOMETHING for
   * delivery and quoting the wrong side of the split is the visible failure.
   */
  private demoShippingCharge(district: string, settings: StoreSettings): number {
    return /dhaka/i.test(district) ? settings.deliveryInsideDhaka : settings.deliveryOutsideDhaka;
  }

  async getCustomerRisk(phone: string): Promise<CustomerRiskView> {
    const normalized = demoNormalizePhone(phone);
    // An input that normalizes to nothing cannot be matched against anything,
    // and answering `level: "NEW"` for it would report "no history" for what is
    // really "unreadable input". The route 422s here; this throws, and the
    // guardrail's catch turns either into a draft.
    if (!normalized) throw new Error(`phone "${phone}" is not a usable number`);
    const customerIds = new Set(
      this.customerPhones.filter((p) => p.phone === normalized).map((p) => p.customerId),
    );
    // An unmatched phone answers zero-history NEW, exactly as
    // `calculateCustomerRisk` does. That is an ANSWER; only a throw means the
    // read failed, and conflating the two would turn a fail-closed guardrail
    // into a fail-open one.
    const orders = this.data.orders.filter((o) => customerIds.has(o.customerId));

    // The status folds mirror `customerRisk.js`'s three constants, mapped onto
    // this repo's own `OrderStatus` names. `rto` is dakio-api's `RETURNED`, and
    // it counts BOTH ways on purpose: into `cancelledOrders`, because for risk
    // scoring an RTO and a cancellation are the same failed outcome, and again
    // into `rtoCount`, which is the separate RETURNED-only figure the auto-order
    // guardrail compares against `inbox.rtoShadowThreshold`.
    const deliveredOrders = orders.filter((o) => o.status === "delivered").length;
    const rtoCount = orders.filter((o) => o.status === "rto").length;
    const cancelledOrders = orders.filter((o) => o.status === "cancelled" || o.status === "rto").length;
    const activeOrders = orders.filter(
      (o) => !["delivered", "cancelled", "rto"].includes(o.status),
    ).length;

    const settled = deliveredOrders + cancelledOrders;
    const successRate = settled > 0 ? deliveredOrders / settled : 0;
    const returnRate = settled > 0 ? cancelledOrders / settled : 0;
    const level: CustomerRiskView["level"] =
      settled === 0
        ? "NEW"
        : (settled >= 2 && returnRate >= 0.5) || cancelledOrders >= 3
          ? "RISK"
          : settled >= 2 && successRate >= 0.75
            ? "POSITIVE"
            : "MEDIUM";

    const parts: string[] = [];
    if (deliveredOrders > 0) parts.push(`${deliveredOrders} delivered`);
    if (cancelledOrders > 0) parts.push(`${cancelledOrders} cancelled/returned`);
    if (activeOrders > 0) parts.push(`${activeOrders} active`);
    return {
      phone: normalized,
      level,
      totalOrders: orders.length,
      deliveredOrders,
      cancelledOrders,
      activeOrders,
      rtoCount,
      cancelledOnlyCount: orders.filter((o) => o.status === "cancelled").length,
      successRate: Math.round(successRate * 100) / 100,
      returnRate: Math.round(returnRate * 100) / 100,
      message: parts.length > 0 ? parts.join(", ") : "New customer — no order history",
    };
  }

  async createChatOrder(input: ChatOrderRequest): Promise<ChatOrderResult> {
    const thread = this.inbox.get(input.sourceConversationId);
    if (!thread) throw new Error(`Conversation not found: ${input.sourceConversationId}`);

    // ONE ORDER, EVER, per novaActionId — the read-back, before anything is
    // priced. Replaying a decision must return the SAME order, not a second
    // parcel: the customer is holding an order number from the first attempt.
    const replay = this.chatOrders.get(input.novaActionId);
    if (replay) return replay;

    // Price and stock, both from the catalogue and neither from the caller.
    // There is no `unitPrice` on the request and there must never be — that is
    // rule 2 of module 05's payload header, and it is the difference between a
    // model that can sell and a model that can set prices.
    let subtotal = 0;
    const picked: { product: Product; qty: number }[] = [];
    for (const line of input.items) {
      const product = this.data.products.find((p) => p.id === line.productId || p.sku === line.productId);
      if (!product) {
        // A refusal, not an Error: "that product is not in the catalogue" is an
        // ANSWER the model has to tell the customer, and the route answers 409.
        throw new InboxSendRefused("PRODUCT_NOT_FOUND", `No such product: ${line.productId}`);
      }
      if (product.stock < line.qty) {
        throw new InboxSendRefused(
          "OUT_OF_STOCK",
          `"${product.name}" has ${product.stock} left; the order asked for ${line.qty}.`,
        );
      }
      subtotal += product.price * line.qty;
      picked.push({ product, qty: line.qty });
    }

    const settings = await this.getStoreSettings();
    const shippingCharge = this.demoShippingCharge(input.customerDistrict, settings);

    // The coupon is judged against the SUBTOTAL, not the total: `minOrder` is a
    // floor on what was bought, and folding delivery into it would let a ৳900
    // cart clear a ৳1,000 floor because the parcel is going to Chittagong.
    let discount = 0;
    if (input.couponCode) {
      const verdict = this.judgeCoupon(input.couponCode, subtotal);
      if (!verdict.valid) {
        throw new InboxSendRefused(
          "COUPON_INVALID",
          `Coupon ${verdict.code} does not hold (${verdict.reason}) — the order was not placed.`,
        );
      }
      discount = verdict.discount;
      const coupon = this.data.discounts.find((d) => d.code === verdict.code);
      if (coupon) coupon.usedCount = (coupon.usedCount ?? 0) + 1;
    }

    // Everything above could refuse; nothing above has written. From here on
    // the writes happen together, which is what dakio-api's single transaction
    // buys and what this ordering imitates — a stock decrement that survived a
    // coupon refusal would sell inventory to nobody.
    for (const { product, qty } of picked) product.stock -= qty;

    // Identity. The real path calls `linkConversationToCustomer(…, 'order_created', tx)`,
    // which does FIVE writes in one transaction: the conditional conversation
    // claim, the CustomerChannel spoke upsert, the PSID memory fold, the
    // StorefrontLead stamp and the NovaPromise backfill. This plays the first
    // one only, and says so — a demo that hand-rolled the other four would be
    // hand-rolling exactly what module 03 shipped to stop anyone hand-rolling.
    const normalized = demoNormalizePhone(input.customerPhone);
    const matched = this.customerPhones.find((p) => p.phone === normalized)?.customerId ?? null;
    const customerId = thread.conversation.customerId ?? matched;
    if (thread.conversation.customerId === null && matched !== null) {
      thread.conversation.customerId = matched;
      thread.customerLinkSource = "order_created";
    }

    this.idCounter += 1;
    const orderNumber = `#${String(this.idCounter).padStart(5, "0")}`;
    const total = subtotal + shippingCharge - discount;
    const order: Order = {
      id: this.nextId("ord"),
      customerId: customerId ?? "",
      items: picked.map(({ product, qty }) => ({
        productId: product.id,
        productName: product.name,
        quantity: qty,
        unitPrice: product.price,
      })),
      subtotal,
      discount,
      shipping: shippingCharge,
      total,
      status: "placed",
      courierId: null,
      placedAt: this.now(),
      deliveredAt: null,
      region: input.customerDistrict,
    };
    this.data.orders.push(order);

    const result: ChatOrderResult = {
      id: order.id,
      orderNumber,
      total,
      shippingCharge,
      // A chat order is COD with nothing paid, so the whole total is what the
      // courier collects. dakio-api reads this from `Order.due` rather than
      // `total` because the two diverge the moment an advance is recorded.
      codAmount: total,
      status: order.status,
      customerId,
      // Honestly null — `getStoreSettings().storefrontUrl` is null here, and
      // `orderTrackingUrl` returns null without a base. A plausible URL would
      // be read as proof the tracking link works.
      trackingUrl: null,
    };
    this.chatOrders.set(input.novaActionId, result);
    return result;
  }

  // ---- Proactive job queue (Phase 05) ----
  //
  // Single in-process array — no SKIP LOCKED or transaction needed (there is
  // no concurrent access within one JS event-loop tick), but the expand/lease
  // sequencing mirrors dakio-api's novaJobs.js exactly so both backends
  // behave identically to callers.

  async listJobDefs(): Promise<NovaJobDef[]> {
    return this.data.jobDefs ?? [];
  }

  async upsertJobDef(
    kind: JobKind,
    input: { cadence: string; tz: string; enabled?: boolean; config?: Record<string, unknown> },
  ): Promise<NovaJobDef> {
    lastOccurrenceAtOrBefore(input.cadence, input.tz, new Date()); // throws on invalid cadence/tz — fail closed, matching novaJobs.js
    const defs = (this.data.jobDefs ??= []);
    const existing = defs.find((d) => d.kind === kind);
    const updated: NovaJobDef = {
      kind,
      cadence: input.cadence,
      tz: input.tz,
      enabled: input.enabled ?? true,
      config: input.config ?? {},
      updatedAt: this.now(),
    };
    if (existing) Object.assign(existing, updated);
    else defs.push(updated);
    return existing ?? updated;
  }

  private drainCartAbandonedEventsToJobs(now: Date): void {
    const events = (this.data.inboxEvents ??= []);
    const jobs = (this.data.jobs ??= []);
    const pending = events.filter((e) => e.eventType === "cart.abandoned" && e.processedAt === null);
    if (pending.length === 0) return;

    const bucketMs = CART_SWEEP_DEBOUNCE_MINUTES * 60_000;
    const buckets = new Map<number, typeof pending>();
    for (const e of pending) {
      const bucketStart = Math.floor(Date.parse(e.receivedAt) / bucketMs) * bucketMs;
      const list = buckets.get(bucketStart) ?? [];
      list.push(e);
      buckets.set(bucketStart, list);
    }

    for (const [bucketStart, bucketEvents] of buckets) {
      const dedupeKey = `cart_sweep:event-window:${new Date(bucketStart).toISOString()}`;
      if (jobs.some((j) => j.dedupeKey === dedupeKey)) continue; // already expanded this window
      jobs.push({
        id: this.nextId("job"),
        kind: "cart_sweep",
        payload: { triggeredBy: "event", eventCount: bucketEvents.length },
        dueAt: new Date(bucketStart + bucketMs).toISOString(),
        priority: PRIORITY_BY_KIND.cart_sweep,
        status: "due",
        attempts: 0,
        lastError: null,
        dedupeKey,
        leaseUntil: null,
        leaseToken: null,
      });
    }
    for (const e of pending) e.processedAt = now.toISOString();
  }

  private expandDueDefs(now: Date): void {
    const defs = this.data.jobDefs ?? [];
    const jobs = (this.data.jobs ??= []);
    for (const def of defs) {
      if (!def.enabled || def.cadence === "event") continue;
      const occurrence = lastOccurrenceAtOrBefore(def.cadence, def.tz, now);
      if (!occurrence || occurrence.getTime() > now.getTime()) continue;
      const dedupeKey = `${def.kind}:${occurrence.toISOString()}`;
      if (jobs.some((j) => j.dedupeKey === dedupeKey)) continue;
      jobs.push({
        id: this.nextId("job"),
        kind: def.kind,
        payload: def.config,
        dueAt: occurrence.toISOString(),
        priority: PRIORITY_BY_KIND[def.kind] ?? 5,
        status: "due",
        attempts: 0,
        lastError: null,
        dedupeKey,
        leaseUntil: null,
        leaseToken: null,
      });
    }
  }

  async claimDueJobs(limit: number): Promise<NovaJob[]> {
    const now = new Date();
    const jobs = (this.data.jobs ??= []);

    // Watchdog: a stale lease (past its window) is due again.
    for (const j of jobs) {
      if (j.status === "leased" && j.leaseUntil && Date.parse(j.leaseUntil) < now.getTime()) {
        j.status = "due";
        j.leaseUntil = null;
        j.leaseToken = null;
      }
    }

    this.drainCartAbandonedEventsToJobs(now);
    this.expandDueDefs(now);

    const due = jobs
      .filter((j) => j.status === "due" && Date.parse(j.dueAt) <= now.getTime())
      .sort((a, b) => a.priority - b.priority || Date.parse(a.dueAt) - Date.parse(b.dueAt))
      .slice(0, limit);

    const leaseUntil = new Date(now.getTime() + LEASE_MINUTES * 60_000).toISOString();
    for (const j of due) {
      j.status = "leased";
      j.attempts += 1;
      j.leaseUntil = leaseUntil;
      // Fresh token per lease — a re-lease of this same row (e.g. after the
      // watchdog reclaims a slow job) gets a DIFFERENT token, so a stale
      // caller's later complete/release (see below) is a safe no-op instead
      // of overwriting a newer lease's outcome. Mirrors novaJobs.js exactly.
      j.leaseToken = randomUUID();
    }
    return due;
  }

  async completeJob(id: string, leaseToken: string): Promise<void> {
    const jobs = (this.data.jobs ??= []);
    const job = jobs.find((j) => j.id === id);
    if (!job || job.status !== "leased" || job.leaseToken !== leaseToken) return; // superseded lease — leave it alone
    job.status = "done";
    job.leaseUntil = null;
  }

  async releaseJob(id: string, leaseToken: string, error: string): Promise<void> {
    const jobs = (this.data.jobs ??= []);
    const job = jobs.find((j) => j.id === id);
    if (!job || job.status !== "leased" || job.leaseToken !== leaseToken) return; // superseded lease — leave whatever currently owns it alone
    job.lastError = error;
    job.leaseUntil = null;
    if (job.attempts >= MAX_ATTEMPTS) {
      job.status = "failed";
      return;
    }
    job.status = "due";
    job.dueAt = new Date(Date.now() + backoffMinutes(job.attempts) * 60_000).toISOString();
  }

  // ---- Catalog photo memory (Stage 11 Phase 3) ----
  //
  // The demo store has no catalog photo backlog: the indexer lib's evals
  // drive it through their own stub clients, so a demo-store catalog_vision
  // run honestly reports "nothing pending" — same shape the server returns
  // for a fully indexed store.

  async listPendingCatalogPhotos(): Promise<{ photos: CatalogPhotoPending[]; pendingTotal: number }> {
    return { photos: [], pendingTotal: 0 };
  }

  async recordCatalogPhotoReadings(
    _results: CatalogPhotoResult[],
  ): Promise<{ captioned: number; failed: number; pendingAfter: number }> {
    // Mirror the server's tenant-scoped updateMany on unknown ids: a no-op.
    return { captioned: 0, failed: 0, pendingAfter: 0 };
  }

  async listCatalogPhotoFingerprints(): Promise<{ fingerprints: CatalogPhotoFingerprint[] }> {
    return { fingerprints: [] };
  }

  async recordRunStart(input: RunStartInput): Promise<void> {
    const key = `${input.sessionId}|${input.turnId}`;
    const existing = this.runs.get(key);
    // Mirror the server: a redelivered start never resets a settled outcome.
    if (existing && existing.outcome !== "running") return;
    this.runs.set(key, { ...input, outcome: "running" });
  }

  async recordRunFinish(input: RunFinishInput): Promise<void> {
    const key = `${input.sessionId}|${input.turnId}`;
    this.runs.set(key, { ...(this.runs.get(key) ?? {}), ...input });
  }
}
