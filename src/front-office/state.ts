/**
 * Nova Live Context — the state object from the Front Office PRD
 * ("Nova Live Context PRD", Claude Design project 97de387e, Aug 2026).
 *
 * THE ONE RULE: Nova never rediscovers a conversation it already understands.
 * One persistent, versioned state row per conversation; every turn applies a
 * DELTA to it. Business truth belongs to the application — the LLM writes
 * sentences, it never owns price, stock, order status or authority.
 *
 * No naked values: every consequential fact rides in an envelope
 * { value, source, confidence, checkedAt, ttl } so assumptions are never
 * rendered as confirmed — to Nova or to the founder.
 */

// ---------------------------------------------------------------------------
// Fact envelopes
// ---------------------------------------------------------------------------

export type FactSource =
  | "customer" // said in chat
  | "profile" // customer record / previous orders
  | "vision" // product photo match
  | "founder" // founder correction — never silently overwritten
  | "event" // webhook push (price/stock/courier)
  | `tool:${string}`; // tool observation

export interface Fact<T> {
  value: T;
  source: FactSource;
  /** "confirmed" (customer/founder said it) or inferred probability 0..1. */
  confidence: "confirmed" | number;
  /** Epoch ms of the observation — freshness is the AGE of the observation. */
  checkedAt: number;
  /** null = STABLE (cached for the conversation). Number = VOLATILE ttl ms. */
  ttlMs: number | null;
}

export function fact<T>(
  value: T,
  source: FactSource,
  opts: { confidence?: "confirmed" | number; ttlMs?: number | null; at?: number } = {},
): Fact<T> {
  return {
    value,
    source,
    confidence: opts.confidence ?? "confirmed",
    checkedAt: opts.at ?? Date.now(),
    ttlMs: opts.ttlMs ?? null,
  };
}

export function isFresh(f: Fact<unknown> | undefined, now = Date.now()): boolean {
  if (!f) return false;
  if (f.ttlMs === null) return true;
  return now - f.checkedAt <= f.ttlMs;
}

/** Age in whole seconds — what the state card and the founder sidebar show. */
export function ageSec(f: Fact<unknown>, now = Date.now()): number {
  return Math.max(0, Math.round((now - f.checkedAt) / 1000));
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type Lang = "bn" | "en";
export type DetectedLang = "bn" | "banglish" | "en";
export type ProductTracking = "interested" | "wants_to_buy";

/** Reducer-computed — never set by the model. */
export type Stage =
  | "discovery"
  | "product_interest"
  | "product_selection"
  | "checkout"
  | "final_confirmation"
  | "validating"
  | "ordered"
  | "post_order"
  | "support"
  | "escalated";

export type MissingField = "product" | "variant" | "qty" | "zone" | "phone" | "address" | "confirmation";

export interface HydratedProduct {
  id: string;
  name: string;
  price: number;
  compareAtPrice?: number | null;
  /** Option names when the product has variants (e.g. sizes). */
  options?: string[];
  description?: string;
  stock: number;
}

export interface ChatTurnMessage {
  role: "customer" | "nova";
  text: string;
  at: number;
  /**
   * The STORE's own message ids this line was read from — set only by the
   * instructed lane, which re-reads the thread and therefore knows them (the
   * live ingress is handed text and no id). It is what "this thread has already
   * absorbed that message" means when it is known: two messages with identical
   * text are two messages, and deciding by text alone silently drops the
   * second one ("hello" asked twice is one answered customer and one ignored).
   * Optional, so persisted state written before it loads unchanged and the live
   * lane keeps falling back to the text comparison.
   */
  ids?: string[];
}

export interface ToolLedgerEntry {
  tool: string;
  args: unknown;
  raw: unknown;
  calledAt: number;
  ok: boolean;
}

export interface NovaLiveContext {
  convId: string;
  storeId: string;
  /**
   * dakio-api's session roll (`InboxConversation.novaSessionEpoch`, read via
   * `GET /conversations/:id/session-epoch`). Part of the STORAGE KEY — the
   * same discipline as nova-ai's `inbox:<conv>:<model>:e<epoch>` continuation
   * token: a rolled epoch starts a fresh context and never touches the old
   * one. `0` is the pre-roll default, so legacy state (files without the
   * field) keeps loading under the exact key it already had.
   */
  epoch: number;
  version: number;
  updatedAt: number;

  customer: {
    id?: string;
    name?: Fact<string>;
    phone?: Fact<string>;
    addr?: Fact<string>;
    lang: { pref: Lang; detected: DetectedLang; conf: number; lockedByRequest?: boolean };
    sentiment: "positive" | "neutral" | "negative";
    channel: string;
  };

  products: {
    /** One product in focus. */
    focusId?: string;
    /** Discussed products; ORDERED ids leave tracked → orders[]. */
    tracked: Record<string, ProductTracking>;
    /** Saved per-product selections — switching back restores, zero refetch. */
    items: Record<string, { variant?: string; qty?: number }>;
  };

  purchase: {
    variant?: string;
    qty?: number;
    zone?: string;
    fee?: Fact<number>;
    payment: "cod";
    confirmSent: boolean;
    objRound: number;
  };

  conversation: {
    stage: Stage;
    missing: MissingField[];
    nextAction: string;
    confidence: "low" | "med" | "high";
    /** MEMO — append-only compressed old turns, ≤ ~60 tokens. */
    summary: string;
  };

  orders: Array<{ no: string; title: string; total: number }>;

  /**
   * Orders filed for the shop's approval but not yet placed (phase D unit 1 —
   * the approval-gated live tier). Each row is a prepared `create_order_from_chat`
   * action sitting on the founder's Decision desk; it holds NO order number and
   * NO total because no order exists yet — the server prices at approve time.
   * Optional and absent on legacy persisted state (shadow-only histories never
   * grow it), so old rows load byte-identically. The length also feeds the
   * `nm:<conv>:order-<n>` idempotency key so a SECOND product sold while the
   * first awaits approval mints a fresh key instead of deduping into the first.
   *
   * `state` is what the FOUNDER did with the card, reconciled from the action
   * row on read (`reconcilePendingOrders` in turn.ts) — absent means the same
   * as `pending`, so persisted rows written before this field load unchanged.
   * Entries are never REMOVED once settled, and that is deliberate on two
   * counts: this array's length is part of the order key (dropping a settled
   * entry would re-mint a key the ledger already owns and replay it), and a
   * rejected order is a fact about the conversation worth keeping.
   */
  pendingOrders?: Array<{
    actionId: string;
    title: string;
    /** `placed` = the shop approved it; `closed` = rejected, blocked or undone. */
    state?: "pending" | "placed" | "closed";
    /** The order number, once one exists. Only ever set alongside `placed`. */
    no?: string;
  }>;

  /** Observation cache backing store — raw payloads, timestamped. */
  toolLedger: ToolLedgerEntry[];

  hydrated: {
    product?: Fact<HydratedProduct>;
    stock?: Fact<number>;
    price?: Fact<number>;
    policies?: Fact<{ deliveryFeeInside?: number; deliveryFeeOutside?: number; codAvailable?: boolean; insideZone?: string }>;
  };

  /** Last messages ride verbatim (6–10); older turns fold into MEMO. */
  recent: ChatTurnMessage[];
}

export function newLiveContext(convId: string, storeId: string, channel = "chat", epoch = 0): NovaLiveContext {
  return {
    convId,
    storeId,
    epoch,
    version: 0,
    updatedAt: Date.now(),
    customer: { lang: { pref: "bn", detected: "banglish", conf: 0.5 }, sentiment: "neutral", channel },
    products: { tracked: {}, items: {} },
    purchase: { payment: "cod", confirmSent: false, objRound: 0 },
    conversation: { stage: "discovery", missing: ["product"], nextAction: "GREET", confidence: "med", summary: "" },
    orders: [],
    toolLedger: [],
    hydrated: {},
    recent: [],
  };
}

// ---------------------------------------------------------------------------
// Derived: stage + missing — computed from state, never model-set
// ---------------------------------------------------------------------------

const RECENT_MAX = 8;
const MEMO_MAX_CHARS = 320; // ≈ 60-80 tokens

// ---------------------------------------------------------------------------
// Phone masking — THE one masker. The card's contract is "never full
// phone/address", and it holds for every consumer of this state: the card
// header AND anything folded into MEMO mask through these same helpers.
// ---------------------------------------------------------------------------

/** A Bangladeshi mobile in any wire form (+880…, 880…, 0…). */
const BD_PHONE_RE = /(?:\+?880|0)1[3-9]\d{8}/g;

/** Mask to the last 3 digits — the card's confirmation convention ("ending 689?"). */
export function maskPhone(phone: string): string {
  return `···${phone.slice(-3)}`;
}

/** Replace every full BD phone in free text with its masked form. */
export function maskPhonesIn(text: string): string {
  return text.replace(BD_PHONE_RE, (m) => maskPhone(m));
}

export function computeMissing(ctx: NovaLiveContext): MissingField[] {
  const missing: MissingField[] = [];
  const focus = ctx.products.focusId ? ctx.hydrated.product?.value : undefined;
  if (!ctx.products.focusId) missing.push("product");
  if (focus && (focus.options?.length ?? 0) > 0 && !ctx.purchase.variant) missing.push("variant");
  if (!ctx.purchase.qty) missing.push("qty");
  if (!ctx.purchase.zone) missing.push("zone");
  if (!ctx.customer.phone) missing.push("phone");
  if (!ctx.customer.addr) missing.push("address");
  if (!ctx.purchase.confirmSent) missing.push("confirmation");
  return missing;
}

export function computeStage(ctx: NovaLiveContext): Stage {
  const s = ctx.conversation.stage;
  // Sticky terminal / side stages — only explicit transitions leave them.
  if (s === "escalated" || s === "ordered" || s === "post_order" || s === "validating" || s === "support") return s;
  const focusId = ctx.products.focusId;
  if (!focusId) return "discovery";
  const tracking = ctx.products.tracked[focusId];
  const missing = computeMissing(ctx);
  const infoMissing = missing.filter((m) => m !== "confirmation");
  if (infoMissing.length === 0) return "final_confirmation";
  if (tracking === "wants_to_buy") {
    const needsSelection = missing.includes("variant") || missing.includes("qty");
    return needsSelection ? "product_selection" : "checkout";
  }
  return "product_interest";
}

/** Push a message, folding overflow into the MEMO line (append-only). */
export function pushMessage(ctx: NovaLiveContext, msg: ChatTurnMessage): void {
  ctx.recent.push(msg);
  while (ctx.recent.length > RECENT_MAX) {
    const old = ctx.recent.shift()!;
    // Never compress away: handled upstream — order details, promises, quoted
    // prices and corrections are written into MEMO explicitly by the reducer.
    // Mask BEFORE folding: a phone that ages out of recent[] must ride MEMO
    // masked, or the card leaks the full number on every later turn.
    const line = `${old.role === "customer" ? "C" : "N"}: ${maskPhonesIn(old.text).slice(0, 60)}`;
    ctx.conversation.summary = `${ctx.conversation.summary} · ${line}`.slice(-MEMO_MAX_CHARS).replace(/^ · /, "");
  }
}

export function addMemo(ctx: NovaLiveContext, note: string): void {
  ctx.conversation.summary = `${ctx.conversation.summary}${ctx.conversation.summary ? " · " : ""}${note}`.slice(-MEMO_MAX_CHARS);
}

export function bump(ctx: NovaLiveContext): void {
  ctx.version += 1;
  ctx.updatedAt = Date.now();
}
