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

export function newLiveContext(convId: string, storeId: string, channel = "chat"): NovaLiveContext {
  return {
    convId,
    storeId,
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
    const line = `${old.role === "customer" ? "C" : "N"}: ${old.text.slice(0, 60)}`;
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
