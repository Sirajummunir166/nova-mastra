/**
 * The authority seam (PRD §4 Authority, §5) — ONE server-side place that
 * decides what Nova may do.
 *
 * Every action Nova attempts is judged here: founder-only verb → no-touch lock
 * → duty → mode → level → guardrails. **First refusal wins**, and every verdict
 * names the exact rule that produced it, because "Nova refused" is useless to a
 * founder and "Nova refused: no_touch:saree pricing" is actionable.
 *
 * Three rules this module exists to make unbreakable:
 *
 *  1. **Model output can propose, never authorize.** Nothing here reads model
 *     text as permission. Locks and duty names are DATA — they are matched
 *     against, never interpreted as instructions.
 *  2. **Fail closed.** Any lookup that errors or returns something unexpected
 *     refuses. A gate that fails open is not a gate.
 *  3. **Ambiguity resolves toward refusal.** A false freeze costs the founder a
 *     tap; a false pass breaks a promise they made to themselves.
 *
 * There is deliberately no second gate: `checkGuardrails` from `autonomy.ts` is
 * called from inside this seam as the platform superset, not alongside it.
 */

import type {
  ActionType,
  AuthorityDecision,
  AuthorityState,
  AutonomyLevel,
  NovaMode,
  RiskClass,
} from "./types.js";
import type { StoreClient } from "./client.js";
import { RISK_CLASS, checkGuardrailsForAuthority } from "./autonomy.js";
import { DUTY_BY_KEY } from "./duties.js";

/**
 * §5.4 — verbs the founder must perform personally. These are propose-only at
 * EVERY level including L4, on every path. This is a classification of the act,
 * not a check on the caller's role: raising autonomy must never turn a
 * founder-only verb into something Nova can do alone.
 *
 * **Module 08 adds nothing here, and that is a finding, not an oversight.** Its
 * doc lists `FOUNDER_ONLY += refund_promise` twice (Files touched, and the §5.4
 * matrix row "Refund promise / payment confirmation"). There is no
 * `refund_promise`: `ActionType` ends at `bulk_refund`, and the string occurs in
 * no executor, tool, schema, Prisma model or migration in any of the three
 * repos. A member naming a verb nothing can dispatch buys a green assertion for
 * a capability that cannot fire, and an `AuthorityDecision.rule` of
 * `founder_only:refund_promise` that nothing can ever emit — coverage-shaped,
 * and worse than the gap because it reads as closed.
 * `DEFAULT_GUARDRAILS.maxAutoRefundTotal` (`autonomy.ts`) already carries the
 * same NOT-ENFORCED note for the same reason.
 *
 * What actually stops Nova promising a refund today is that there is no refund
 * verb to call and the customer register forbids the utterance: an absent
 * capability plus an instruction-level control, NOT a set membership. Say it
 * that way. Whoever ships a real refund verb (module 05/06) adds it here in the
 * same change — the only moment the membership means anything.
 */
export const FOUNDER_ONLY: ReadonlySet<string> = new Set([
  "bulk_refund",
  "guardrail_edit",
  "promotion_accept",
  "contract_sign",
]);

/**
 * The inverse of FOUNDER_ONLY: verbs the tier dial may never hold back.
 *
 * `escalate_conversation` is the one that matters today — asking for a human
 * must work at every tier, including Shadow, or the safest thing Nova can do
 * becomes the slowest. Escalation sends nothing the model authored (the
 * holding line is a deterministic server template) and it hands authority
 * AWAY, so there is nothing for a level ceiling to protect against.
 *
 * Everything before this check still applies: a founder-only verb, a no-touch
 * lock, an unknown duty, and a duty the founder explicitly paused all win.
 *
 * Module 03 added `link_customer_identity` — bookkeeping in the same sense:
 * it writes a JOIN, sends the customer nothing, exposes nothing (the 360 is a
 * separate server-side read), and its undo removes the join cleanly. It must
 * work at T0 Shadow because a thread Nova cannot identify is a thread Nova
 * answers blind.
 *
 * **Module 08 examined this set and added NOTHING — do not re-litigate it from
 * the doc.** The sentence above used to promise that module 08 would "extend
 * this set with the rest of its bookkeeping verbs"; it shipped and it did not,
 * for four separate reasons, all verified against the code:
 *
 *  - The mechanism the doc names, `BOOKKEEPING_VERBS` — "a set consulted before
 *    the ceiling check" — exists in no repo. This set is that mechanism, and it
 *    is consulted at "3b" below, before the ceiling, exactly as described. There
 *    is nothing to build; there was only something to find.
 *  - `open_case` and `flag_courier_issue` are module 06's and module 06 has not
 *    shipped, so neither string exists to add. Worse for the doc's own case,
 *    module 06 specifies `flag_courier_issue` as forced `needs_approval` ALWAYS
 *    — the exact opposite of never-gated. Two docs, one verb, contradictory
 *    rulings: 06 owns it, and the ruling is 06's to make when it lands.
 *  - `schedule_follow_up` stays out for the reasons written below, and a
 *    CI check pins its absence.
 *  - `refund_promise` does not exist at all (see `FOUNDER_ONLY` above).
 *
 * So the honest statement of module 08's tier carve-out is: it is this set, it
 * has two members, and module 08 added none of them. A future module extends it
 * by naming a verb that EXISTS and arguing membership on the terms below — never
 * by pre-registering a name from a doc.
 *
 * **Know what membership costs.** The check at "3b" below returns BEFORE
 * `effectiveLevel`/`verdictForLevel` and BEFORE `checkGuardrailsForAuthority`,
 * so a never-gated verb bypasses the tier dial and every numeric guardrail. It
 * is safe for these two only because neither can spend, send, or choose: the
 * SERVER decides the link (exact single match, or a server-side digit compare)
 * and the model supplies a phone, never a customerId to link to. What it does
 * NOT bypass is the duty ladder above — a founder who pauses
 * `support.inbox_replies` still stops the link, and an off-roster `dutyRef`
 * still fails closed.
 *
 * **`schedule_follow_up` is deliberately NOT here (module 04, OD-6), and this
 * DIVERGES from the module-04 doc**, which classes it a bookkeeping verb that
 * executes at every tier including T0 Shadow on the grounds that it "sends
 * nothing customer-visible". That is true of the scheduling and false of its
 * consequence. `link_customer_identity` above ends where it starts — a join
 * written, nothing owed, nobody contacted. Scheduling a follow-up ends with
 * Nova speaking to a customer at a time it picked; the send is gated on its
 * own, but membership here would let a T0 Shadow store, whose whole promise is
 * that Nova only watches, accumulate real commitments the founder never
 * approved. The cost of leaving it out is named honestly: it does not execute
 * at T0, and `support.inbox_replies`' minLevel 2 plus any future `inbox.*` cap
 * apply to it — which is the point.
 */
export const NEVER_GATED: ReadonlySet<string> = new Set([
  "escalate_conversation",
  "link_customer_identity",
]);

/**
 * Verbs that are always a DRAFT — never an auto-execute, never a refusal.
 *
 * This exists because neither shipped mechanism says what module 03 D5 means.
 * A `riskClass: "high"` still EXECUTES at level 4 (`verdictForLevel`'s last
 * line), so risk alone cannot express "always ask". `FOUNDER_ONLY` yields
 * verdict `refuse` → a **blocked** ledger row and an *escalation* Decision,
 * which says "Nova may not do this" — the opposite of the truth here. Merging
 * two customer records is legitimate work Nova should prepare in full, down to
 * the survivor and the counts; it is only the signature that must be human,
 * because the repoint has no inverse.
 *
 * Checked immediately after NEVER_GATED, so it sits below the founder's own
 * rules (founder-only, no-touch, duty) and above the dial: a paused duty still
 * wins, and raising autonomy to Acting CEO still does not auto-merge.
 *
 * **Module 05 adds `verify_payment_slip`, and it is here rather than relying on
 * `riskClass: "high"` because high is not a promise.** The module doc asserts
 * that high "always drafts, at every tier, forever"; `verdictForLevel`'s last
 * line returns `{verdict:"execute"}` for every risk class at level 4, and level
 * 4 is genuinely reachable — `effectiveLevel` is min(level, earnedLevel,
 * MODE_CEILING), an autonomous door ceilings at 4, and dakio-api's `novaTrust`
 * promotes `earnedLevel` to 4 on a good record. So on the doc's mechanism a
 * well-behaved store would auto-"verify" a payment.
 *
 * What makes that unacceptable is the verb's own honesty: Dakio has no
 * payment-gateway API and Meta attachments are lossy, so NOTHING in this system
 * can read a bKash screenshot and know money moved. The verb files a CLAIM. A
 * claim that auto-resolves is a shop telling a customer their money arrived on
 * the strength of a picture — and in a COD market the correction lands at the
 * door, with a courier holding a parcel nobody will pay for.
 *
 * The dakio-api mirror (`src/lib/novaAuthority.js`) is not optional. This copy
 * is the agent judging itself; that one is read at `POST /actions` and 403s an
 * always-draft verb recorded as `executed`, which is the only layer that can
 * stop a direct ledger write.
 */
export const ALWAYS_DRAFT: ReadonlySet<string> = new Set([
  "merge_customer_records",
  "verify_payment_slip",
  // ── Module 06 settles the contradiction the note on NEVER_GATED records. ──
  //
  // Module 08's doc wanted `flag_courier_issue` never-gated; module 06's wants
  // it forced `needs_approval` ALWAYS. 06 owns the ruling and this is it: the
  // verb belongs here, and 06's READING is right while its MECHANISM was wrong.
  //
  // A guardrail-arm `needs_approval` is a per-tenant platform check — it is only
  // as permanent as the platform bag, and module 05 shipped a ceiling that was
  // unreachable for exactly that reason. `riskClass` cannot express it either
  // (`verdictForLevel` executes every class at level 4). This set is the only
  // thing in the codebase that means "always, at every tier, forever", and it
  // sits below the founder's own rules and above the dial — the right altitude
  // for a verb whose entire output is a proposal.
  //
  // What the verb actually does is worth stating, because it decides the
  // ruling: it changes NOTHING. Dakio can book, cancel, poll and receive
  // webhooks at the three couriers — it cannot reschedule, redirect or hold a
  // parcel. So this verb gathers the tracking id, the last scan, the expected
  // COD and what the customer was told, and puts them in front of the person
  // who can pick up a phone. Auto-executing a proposal would mean Nova
  // "flagging" things to nobody.
  "flag_courier_issue",
]);

/**
 * Per-verb extractor for the text a no-touch lock is matched against.
 *
 * Registering a verb here is how it becomes lockable. A verb with NO extractor
 * is treated as unlockable-and-therefore-suspicious: `targetTextFor` returns
 * null and the matcher refuses rather than silently letting the action past
 * every lock the founder set. §16.3's CI check owns keeping this table complete.
 */
type Extractor = (payload: Record<string, unknown>) => string;

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

export const TARGET_TEXT: Partial<Record<ActionType | string, Extractor>> = {
  update_price: (p) => [str(p.productId), str(p.productName), "price", "pricing"].join(" "),
  create_discount: (p) => [str(p.code), str(p.productIds), "discount", "price", "pricing"].join(" "),
  create_campaign: (p) => [str(p.name), str(p.channel), str(p.productIds), "campaign"].join(" "),
  update_campaign: (p) => [str(p.campaignId), str(p.name), str(p.note), "campaign", "budget"].join(" "),
  publish_social_post: (p) => [str(p.caption), str(p.platform), str(p.productIds), "post", "social"].join(" "),
  send_customer_message: (p) => [str(p.subject), str(p.body), str(p.purpose), "message"].join(" "),
  resolve_ticket: (p) => [str(p.reply), str(p.ticketId), "ticket", "support"].join(" "),
  create_purchase_order: (p) => [str(p.supplierId), str(p.productId), "purchase", "supplier"].join(" "),
  switch_supplier: (p) => [str(p.productId), str(p.newSupplierId), "supplier"].join(" "),
  assign_courier: (p) => [str(p.orderId), str(p.courierId), "courier", "delivery", "shipping"].join(" "),
  import_product: (p) => [str(p.trendingProductId), str(p.price), "product", "import"].join(" "),
  bulk_refund: (p) => [str(p.orderIds), str(p.reason), "refund"].join(" "),
  /**
   * Front Office. The reply's own words ARE the target text: if a founder
   * locked "SAREE PRICING", a chat message quoting a saree price must hit the
   * lock exactly as a dashboard reprice would. `normalizeForMatch` NFC-folds
   * both sides, so a Bangla product name typed with matras in the lock still
   * matches the same name as Nova wrote it.
   *
   * Registering these is not optional bookkeeping: a verb with no extractor
   * makes `targetTextFor` return null, and the seam then refuses every action
   * while any lock exists — the lock does not silently fail open, but the verb
   * silently stops working.
   *
   * Module 03 D-10 adds the declared promise to the reply's haystack. A promise
   * is precisely the sentence a no-touch lock exists to stop: a founder who
   * locked "REFUND" means Nova must not commit to one in chat either, and the
   * commitment can live entirely in `promise.text` while the bubbles say
   * something softer.
   */
  send_inbox_reply: (p) =>
    [
      chunkText(p.chunks),
      promiseText(p.promise),
      str(p.intent),
      str(p.purpose),
      "reply",
      "message",
      "inbox",
    ].join(" "),
  escalate_conversation: (p) =>
    [str(p.reason), str(p.summary), str(p.suggestedReply), "escalation", "handover"].join(" "),
  /**
   * Module 03. Ids and literal keywords only — deliberately NOT the phone. The
   * haystack is matched locally and logged nowhere, but a full number in an
   * extractor is a full number in a code path that has no business holding one,
   * and the lock a founder would set here is "customer records", not a digit
   * string. Same reasoning on the merge: the pair's ids and the basis label,
   * never a name.
   */
  link_customer_identity: (p) =>
    [str(p.conversationId), "customer", "identity", "link", "phone"].join(" "),
  merge_customer_records: (p) =>
    [str(p.customerIdA), str(p.customerIdB), str(p.basis), "customer", "merge", "records"].join(" "),
  /**
   * Module 04. `reason` is the load-bearing half: it is the sentence Nova wrote
   * about what it is coming back to do, so a founder who locked "REFUND" must
   * stop a follow-up that plans to revisit one, exactly as the same lock stops
   * a reply that promises one. `plannedIntent` is in for the same reason at
   * slug level (`return_refund`, `payment_claim`).
   *
   * Ids and literals otherwise, never a phone — same rule as the two above, and
   * the payload deliberately carries none to begin with.
   *
   * Registering it is not bookkeeping: with no extractor `targetTextFor`
   * returns null, and this verb is NOT never-gated, so the seam would refuse
   * every follow-up with `no_touch:unverifiable` for any tenant that has set a
   * single lock. That failure is silent to tsc and loud to exactly one person —
   * the customer who was told "kal janabo" and never heard back.
   */
  schedule_follow_up: (p) =>
    [str(p.conversationId), str(p.reason), str(p.plannedIntent), "follow", "up", "reminder"].join(" "),
  /**
   * Module 05. The PRODUCT NAMES are the load-bearing half, which is why
   * `createOrderFromChatPayload` makes `items[].productName` required rather
   * than settling for ids. A founder's lock is a phrase they would type —
   * "শাড়ি", "SAREE PRICING", "bridal" — and an id matches none of them. With
   * ids alone this extractor would return a string no lock could ever hit, so
   * every lock would fail open on the one verb in the phase that spends the
   * customer's money.
   *
   * WHERE THE NFC FOLD ACTUALLY HAPPENS: `lockMatches` → `normalizeForMatch`,
   * applied to BOTH the lock and this haystack, so a Bangla product name typed
   * with composed matras in the founder's lock matches the decomposed form Nova
   * copied out of the catalogue. It is not done here — normalizing a fragment
   * before joining and then normalizing the join again is the same string, and
   * a second `.normalize("NFC")` in this file would read as though the fold were
   * per-extractor and let the next verb ship without one.
   *
   * The district is in because "no Chittagong orders" is a lock a Dhaka-only
   * shop really sets. The phone and the address line are NOT, for the same
   * reason module 03's extractors leave them out: a full number in a haystack is
   * a full number in a code path with no business holding one, and nobody locks
   * on a house number.
   */
  create_order_from_chat: (p) =>
    [
      chatOrderItemsText(p.items),
      str(p.customerDistrict),
      str(p.customerCity),
      str(p.couponCode),
      "order",
      "sell",
      "cod",
    ].join(" "),
  /**
   * Module 05. `reason` carries the product and the negotiation in the model's
   * own words, so a founder who locked "SAREE PRICING" stops a saree discount
   * exactly as the same lock stops a dashboard reprice — which is the whole
   * point of the lock existing at two doors. The mechanism and the amount are in
   * so that "free delivery" and "discount" are lockable phrases in their own
   * right; a shop that has decided never to give delivery away can say so once.
   */
  offer_chat_discount: (p) =>
    [
      str(p.reason),
      str(p.mechanism),
      str(p.percentOff),
      str(p.amount),
      "discount",
      "coupon",
      "price",
      "pricing",
    ].join(" "),
  /**
   * Module 05. Ids, the method and the customer's own sentence — never the trx
   * id padded out into something that looks verified, and never an amount this
   * verb has confirmed, because it confirms nothing. "REFUND" and "PAYMENT" are
   * both locks a founder plausibly sets on money threads, and
   * `customerStatement` is where a customer's own "টাকা ফেরত দেন" would live.
   */
  verify_payment_slip: (p) =>
    [
      str(p.conversationId),
      str(p.orderId),
      str(p.method),
      str(p.customerStatement),
      "payment",
      "slip",
      "claim",
    ].join(" "),
  /**
   * Module 06. Five extractors, and they are mandatory rather than nice to have:
   * this map is `Partial<Record<…>>`, so tsc will not miss one, and a verb
   * without an extractor makes `targetTextFor` return null — which
   * `evaluateAuthority` turns into `no_touch:unverifiable` for EVERY tenant that
   * has set ANY lock. The failure is silent to the compiler and total for the
   * merchant.
   *
   * The `kind` is included on the case verbs so a founder who has locked
   * "REFUND" also stops a `payment_unverified` case being opened on a thread —
   * the lock is about the SUBJECT, and a case is one of the places a subject
   * shows up.
   */
  open_case: (p) => [str(p.kind), str(p.title), str(p.factsNote), "case"].join(" "),
  /**
   * The courier name and the tracking id matter here beyond the free text: a
   * founder who has stopped Nova touching a particular courier's parcels while
   * a dispute is running expects that to hold at every door, and this is one.
   */
  flag_courier_issue: (p) =>
    [
      str(p.courierType),
      str(p.trackingId),
      str(p.reason),
      str(p.recommendation),
      "courier",
      "delivery",
      "shipping",
    ].join(" "),
  confirm_order_intent: (p) =>
    [str(p.orderId), str(p.confirmedText), "confirm", "order"].join(" "),
  /**
   * The NEW address is in, and that is the deliberate half: a founder who locked
   * a district Nova must not ship to should have that lock fire when a customer
   * asks to redirect a parcel there, not only when an order is first placed.
   */
  update_order_contact: (p) =>
    [
      str(p.orderId),
      str(p.address),
      str(p.city),
      str(p.district),
      "address",
      "delivery",
    ].join(" "),
  cancel_order_from_chat: (p) =>
    [str(p.orderId), str(p.reason), "cancel", "order"].join(" "),
};

/**
 * Flatten `items: [{productId, variantId?, productName, qty}]` into matchable
 * text (module 05 D5).
 *
 * The NAME first, because that is what a founder locks on. `qty` is included so
 * a lock like "BULK" has something to bite; `productId` is included because the
 * founder-facing surfaces sometimes show it and a lock pasted from there must
 * still work. `variantId` is deliberately absent — it is an opaque cuid that
 * appears in no founder-facing text, and adding ids nobody types only dilutes
 * the haystack.
 */
function chatOrderItemsText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return str(item);
      const i = item as Record<string, unknown>;
      return [str(i.productName), str(i.productId), str(i.qty)].join(" ");
    })
    .join(" ");
}

/**
 * Flatten a declared `promise: {text, kind, dueAtISO}` into matchable text
 * (module 03 D-10). `dueAtISO` is left out on purpose: a timestamp matches no
 * lock a founder would write, and including it only adds noise to the haystack.
 */
function promiseText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const p = value as Record<string, unknown>;
  return [str(p.text), str(p.kind), "promise"].join(" ");
}

/** Flatten a `chunks: [{text}]` reply into one matchable string. */
function chunkText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((chunk) => (chunk && typeof chunk === "object" ? str((chunk as Record<string, unknown>).text) : str(chunk)))
    .join(" ");
}

/**
 * Per-verb extractor for money this action would COMMIT today, in ৳ minor
 * units. Only verbs that actually spend register here; everything else
 * contributes zero to the cumulative daily cap.
 */
export const SPEND_MINOR: Partial<Record<ActionType | string, (p: Record<string, unknown>) => number>> = {
  // A campaign commits its daily budget for today.
  create_campaign: (p) => Math.round(Number(p.dailyBudget ?? 0) * 100),
  // Only an INCREASE counts; lowering a budget spends nothing.
  update_campaign: (p) => {
    const next = Number(p.dailyBudget ?? 0);
    const prev = Number(p.previousDailyBudget ?? 0);
    return Math.max(0, Math.round((next - prev) * 100));
  },
  create_purchase_order: (p) => Math.round(Number(p.quantity ?? 0) * Number(p.unitCost ?? 0) * 100),
};

/* ── no-touch matching ─────────────────────────────────────────────────── */

/**
 * Normalize for comparison: NFC (so composed and decomposed Bangla compare
 * equal), lowercased, punctuation flattened to spaces.
 *
 * NFC matters here specifically — Bangla text arrives in both composed and
 * decomposed forms depending on the keyboard, and a lock typed one way must
 * still match text stored the other way.
 */
export function normalizeForMatch(text: string): string {
  return text
    .normalize("NFC")
    .toLowerCase()
    // \p{M} is load-bearing: Bangla matras and nuktas are combining MARKS, not
    // letters. Without it a Bangla lock shreds into single letters, every token
    // is dropped as noise, and the lock silently never matches anything.
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, " ")
    .trim();
}

/** Tokens worth matching on. One-character noise is dropped, digits kept. */
function significantTokens(text: string): string[] {
  return normalizeForMatch(text)
    .split(" ")
    .filter((t) => t.length > 1);
}

/**
 * A lock matches when EVERY significant token in the lock appears in the
 * target text. Conservative on purpose: "SAREE PRICING" must not fire on every
 * saree action, only on ones that are also about price.
 */
export function lockMatches(lock: string, targetText: string): boolean {
  const lockTokens = significantTokens(lock);
  if (lockTokens.length === 0) return false;
  const haystack = ` ${normalizeForMatch(targetText)} `;
  return lockTokens.every((t) => haystack.includes(` ${t} `) || haystack.includes(t));
}

/** The text a lock is matched against, or null if this verb has no extractor. */
export function targetTextFor(type: string, payload: Record<string, unknown>): string | null {
  const extract = TARGET_TEXT[type];
  if (!extract) return null;
  try {
    return extract(payload);
  } catch {
    return null;
  }
}

/* ── mode + level resolution ───────────────────────────────────────────── */

/**
 * Doors whose stored mode scope is also matched case-insensitively.
 *
 * Duty doors are DISPLAY names ("Inbox", "Content Studio"); stored mode scopes
 * are whatever the founder's dial wrote ("door:inbox"). Exact-match lookup
 * therefore never sees `door:inbox`, and `door:inbox = assisted` has silently
 * done nothing for as long as the dial has existed.
 *
 * Fixing that for ALL doors at once is not a bug fix, it is a migration: a
 * tenant carrying `door:orders = autonomous` — set months ago, while it
 * demonstrably did nothing — would start auto-executing order verbs on the
 * first deploy that made the lookup work. So the repair is opt-in per door.
 * Inbox is here because module 02 needs it and because its stored scopes were
 * audited; add a door to this set only after checking live `modes` keys for
 * scopes that would come alive, and say so in that module's Risks table.
 */
export const CASE_INSENSITIVE_DOOR_SCOPES: ReadonlySet<string> = new Set(["Inbox"]);

/** door:<module> beats store, store beats the assisted default. */
export function resolveMode(modes: Record<string, NovaMode>, doorModule: string | null): NovaMode {
  if (doorModule) {
    if (modes[`door:${doorModule}`]) return modes[`door:${doorModule}`];
    if (CASE_INSENSITIVE_DOOR_SCOPES.has(doorModule)) {
      const wanted = `door:${doorModule}`.toLowerCase();
      for (const [scope, mode] of Object.entries(modes)) {
        if (scope.toLowerCase() === wanted) return mode;
      }
    }
  }
  return modes.store ?? "assisted";
}

const MODE_CEILING: Record<NovaMode, AutonomyLevel> = {
  // manual can still recommend — that is L1, "Suggest".
  manual: 1,
  // assisted can prepare a full draft — that is L2, "Draft".
  assisted: 2,
  // autonomous imposes no ceiling of its own.
  autonomous: 4,
};

/** Effective capability is min(mode, level, earnedLevel) — never a max. */
export function effectiveLevel(state: AuthorityState, doorModule: string | null): AutonomyLevel {
  const mode = resolveMode(state.modes, doorModule);
  return Math.min(state.level, state.earnedLevel, MODE_CEILING[mode]) as AutonomyLevel;
}

/** What a given level does with an otherwise-permitted action. */
function verdictForLevel(level: AutonomyLevel, riskClass: RiskClass): AuthorityVerdictish {
  if (level <= 0) return { verdict: "refuse", rule: "level:observe_only" };
  if (level === 1) return { verdict: "suggest", rule: "level:suggest" };
  if (level === 2) return { verdict: "draft", rule: "level:draft" };
  if (level === 3) return riskClass === "low" ? { verdict: "execute", rule: "level:operator" } : { verdict: "draft", rule: "level:operator_needs_approval" };
  return { verdict: "execute", rule: "level:acting_ceo" };
}

type AuthorityVerdictish = { verdict: AuthorityDecision["verdict"]; rule: string };

/* ── the seam ──────────────────────────────────────────────────────────── */

export interface AuthorityRequest {
  type: ActionType | string;
  payload: Record<string, unknown>;
  /** E-5 duty this action is performed under. Unknown keys fail closed. */
  dutyKey?: string;
  /** "chat" | "job" | "founder" — recorded, never trusted for permission. */
  origin?: string;
}

const bn = (en: string, bnText: string): [string, string] => [en, bnText];

/**
 * Namespace a guardrail-check rule. The numeric caps report bare names
 * (`max_discount_pct`) and get the `guardrail:` prefix; branches that answer
 * in a DIFFERENT namespace report it themselves (`duty:thread_off`) and are
 * left alone, so the rule string a founder sees is the one the docs promise
 * rather than `guardrail:duty:thread_off`.
 */
function qualifyRule(rule: string): string {
  return rule.includes(":") ? rule : `guardrail:${rule}`;
}

function decide(
  verdict: AuthorityDecision["verdict"],
  rule: string,
  [explanation, explanationBn]: [string, string],
  riskClass: RiskClass,
  guardrailsVersion: number,
  escalate = false,
): AuthorityDecision {
  return {
    verdict,
    riskClass,
    rule,
    explanation,
    explanationBn,
    guardrailsVersion,
    ...(escalate
      ? { escalation: { reason: explanation, rule, raisedAt: new Date().toISOString() } }
      : {}),
  };
}

/**
 * Judge one action. Order is fixed and the first refusal wins, so that the
 * rule a founder sees is the FIRST reason their instruction was honoured —
 * not whichever check happened to run last.
 */
export async function evaluateAuthority(
  client: StoreClient,
  request: AuthorityRequest,
): Promise<AuthorityDecision> {
  const riskClass: RiskClass = RISK_CLASS[request.type as ActionType] ?? "high";

  // Fail closed: if we cannot read the authority state, we do not act.
  let state: AuthorityState;
  try {
    state = await client.getAuthority();
  } catch (error) {
    return decide(
      "refuse",
      "authority:unavailable",
      bn(
        `Nova could not read this store's authority settings, so it did nothing. (${String(error)})`,
        "নোভা এই স্টোরের অনুমতি সেটিংস পড়তে পারেনি, তাই কিছু করেনি।",
      ),
      riskClass,
      0,
      true,
    );
  }
  const gv = state.guardrails.version;

  // 1. Founder-only verbs — propose-only at every level, including L4.
  if (FOUNDER_ONLY.has(request.type)) {
    return decide(
      "refuse",
      `founder_only:${request.type}`,
      bn(
        `"${request.type}" is yours to do, not Nova's — it stays a proposal at every autonomy level, including Acting CEO.`,
        `"${request.type}" শুধু আপনি করতে পারেন — নোভা যেকোনো অটোনমি লেভেলে এটি কেবল প্রস্তাব হিসেবে রাখে।`,
      ),
      riskClass,
      gv,
      true,
    );
  }

  // 2. No-touch locks.
  const locks = Array.isArray(state.guardrails.noTouch) ? state.guardrails.noTouch : [];
  if (locks.length > 0) {
    const targetText = targetTextFor(request.type, request.payload);
    if (targetText === null) {
      // Unlockable verb while locks exist → refuse. We cannot prove the action
      // is outside the founder's locks, and guessing is how a lock gets evaded.
      return decide(
        "refuse",
        "no_touch:unverifiable",
        bn(
          `Nova can't check "${request.type}" against your no-touch locks, so it stopped rather than risk crossing one.`,
          `নোভা "${request.type}"-কে আপনার নো-টাচ লকের সাথে মেলাতে পারেনি, তাই ঝুঁকি না নিয়ে থেমে গেছে।`,
        ),
        riskClass,
        gv,
        true,
      );
    }
    const hit = locks.find((lock) => lockMatches(lock, targetText));
    if (hit) {
      return decide(
        "refuse",
        `no_touch:${hit.toLowerCase()}`,
        bn(
          `You locked "${hit}". Nova left it alone.`,
          `আপনি "${hit}" লক করে রেখেছেন। নোভা এতে হাত দেয়নি।`,
        ),
        riskClass,
        gv,
        true,
      );
    }
  }

  // 3. Duty — is this something Nova claims to do, is it on, and is the level enough?
  let doorModule: string | null = null;
  if (request.dutyKey) {
    const spec = DUTY_BY_KEY.get(request.dutyKey);
    const duty = state.duties[request.dutyKey];
    if (!spec) {
      return decide(
        "refuse",
        "duty:unknown",
        bn(
          `"${request.dutyKey}" isn't a duty on Nova's roster, so Nova didn't act on it.`,
          `"${request.dutyKey}" নোভার দায়িত্ব তালিকায় নেই, তাই নোভা এতে কাজ করেনি।`,
        ),
        riskClass,
        gv,
        true,
      );
    }
    doorModule = spec.door;
    if (duty && duty.enabled === false) {
      return decide(
        "refuse",
        "duty:paused",
        bn(
          `You paused "${spec.name}", so Nova skipped it.`,
          `আপনি "${spec.name}" বন্ধ রেখেছেন, তাই নোভা এটি বাদ দিয়েছে।`,
        ),
        riskClass,
        gv,
      );
    }
    if (duty && duty.doorExists === false) {
      return decide(
        "refuse",
        "duty:needs_door",
        bn(
          `"${spec.name}" has nowhere to land yet — its screen isn't built, so Nova didn't start work it couldn't show you.`,
          `"${spec.name}"-এর জন্য এখনো কোনো পর্দা তৈরি হয়নি, তাই নোভা এমন কাজ শুরু করেনি যা আপনাকে দেখাতে পারবে না।`,
        ),
        riskClass,
        gv,
      );
    }
  }

  // 3b. Never-gated verbs — past the founder's own rules, below the dial.
  if (NEVER_GATED.has(request.type)) {
    return decide(
      "execute",
      `never_gated:${request.type}`,
      bn(
        `"${request.type}" is always allowed — Nova must be able to hand something to you no matter how low the dial is set.`,
        `"${request.type}" সবসময় অনুমোদিত — অটোনমি যত কমই থাকুক, নোভা আপনাকে বিষয়টি হস্তান্তর করতে পারবে।`,
      ),
      riskClass,
      gv,
    );
  }

  // 3c. Always-draft verbs — Nova prepares the whole thing, a human signs it.
  // Below the founder's own rules and the duty ladder, above the dial: raising
  // autonomy to Acting CEO must not turn a merge into something Nova does alone
  // (module 03 D5).
  if (ALWAYS_DRAFT.has(request.type)) {
    return decide(
      "draft",
      `always_draft:${request.type}`,
      bn(
        `"${request.type}" is always prepared for you to approve — it rewires records that cannot be un-rewired.`,
        `"${request.type}" সবসময় আপনার অনুমোদনের জন্য তৈরি করা হয় — এটি এমন রেকর্ড বদলায় যা ফেরানো যায় না।`,
      ),
      riskClass,
      gv,
    );
  }

  // 4 + 5. Mode ceiling and level semantics, composed as min(mode, level).
  const level = effectiveLevel(state, doorModule);
  const mode = resolveMode(state.modes, doorModule);
  const levelCall = verdictForLevel(level, riskClass);

  if (levelCall.verdict === "refuse") {
    return decide(
      "refuse",
      levelCall.rule,
      bn(
        "Nova is set to observe only, so it reported this instead of doing it.",
        "নোভা কেবল পর্যবেক্ষণে সেট করা আছে, তাই এটি না করে জানিয়েছে।",
      ),
      riskClass,
      gv,
    );
  }

  if (request.dutyKey) {
    const spec = DUTY_BY_KEY.get(request.dutyKey)!;
    if (spec.minLevel > level) {
      return decide(
        "refuse",
        "duty:min_level",
        bn(
          `"${spec.name}" needs autonomy level ${spec.minLevel}; Nova is effectively at ${level}${mode !== "autonomous" ? ` (${mode} mode)` : ""}.`,
          `"${spec.name}"-এর জন্য অটোনমি লেভেল ${spec.minLevel} দরকার; নোভা এখন কার্যত ${level}-এ আছে।`,
        ),
        riskClass,
        gv,
      );
    }
  }

  // 6. Guardrails — the canonical trio, then the platform superset.
  if (request.type === "create_discount") {
    const pct = Number(request.payload.percentOff ?? 0);
    if (pct > state.guardrails.maxDiscountPct) {
      return decide(
        "refuse",
        "guardrail:max_discount_pct",
        bn(
          `A ${pct}% discount is over your ${state.guardrails.maxDiscountPct}% limit, so Nova didn't create it.`,
          `${pct}% ছাড় আপনার ${state.guardrails.maxDiscountPct}% সীমার বেশি, তাই নোভা এটি তৈরি করেনি।`,
        ),
        riskClass,
        gv,
        true,
      );
    }
  }

  // Cumulative daily spend: today's executed spend PLUS what this would commit.
  const spendFn = SPEND_MINOR[request.type];
  if (spendFn) {
    const requested = Math.max(0, spendFn(request.payload) || 0);
    const projected = state.spentTodayMinor + requested;
    if (requested > 0 && projected > state.guardrails.dailySpendCapMinor) {
      const taka = (m: number): string => `৳${Math.round(m / 100).toLocaleString("en-IN")}`;
      // Deliberately a DOWNGRADE, not a block: the spend is legitimate, it just
      // exceeds what Nova may commit alone. The founder decides.
      return decide(
        "draft",
        "guardrail:daily_spend_cap",
        bn(
          `This would take today's spend to ${taka(projected)}, past your ${taka(state.guardrails.dailySpendCapMinor)}/day cap, so Nova prepared it for you to approve instead of spending it.`,
          `এতে আজকের খরচ ${taka(projected)} হয়ে যেত, যা আপনার দৈনিক ${taka(state.guardrails.dailySpendCapMinor)} সীমার বেশি — তাই নোভা খরচ না করে আপনার অনুমোদনের জন্য প্রস্তুত করেছে।`,
        ),
        riskClass,
        gv,
      );
    }
  }

  // Platform superset — the shipped numeric caps plus the per-verb branches
  // (Front Office reply gate), same seam, evaluated last.
  const platform = await checkGuardrailsForAuthority(client, state.guardrails.platform, request.type as ActionType, request.payload);
  if (platform.result === "block") {
    return decide(
      "refuse",
      qualifyRule(platform.rule),
      bn(platform.why, platform.whyBn ?? platform.why),
      riskClass,
      gv,
      true,
    );
  }
  if (platform.result === "needs_approval") {
    return decide("draft", qualifyRule(platform.rule), bn(platform.why, platform.whyBn ?? platform.why), riskClass, gv);
  }

  // Nothing objected.
  return decide(
    levelCall.verdict,
    levelCall.rule,
    bn(
      `Within autonomy level ${level}${mode !== "autonomous" ? ` (${mode} mode)` : ""} and all guardrails.`,
      `অটোনমি লেভেল ${level} এবং সব গার্ডরেলের মধ্যে।`,
    ),
    riskClass,
    gv,
  );
}
