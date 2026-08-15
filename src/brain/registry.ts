/**
 * The brain registry — which job kind is a lane, which room it visits, and
 * WHICH DUTIES IT CLAIMS TO FULFIL.
 *
 * ## Why this file exists (doc 07 B4)
 *
 * The founder is shown a roster of 72 duties: "what Nova does in each
 * department, at what trust level". The jobs do the actual work. Before this
 * file, **nothing connected a duty to the job that fulfils it** — the two
 * systems shared only a ten-value department enum. That is exactly how a
 * product slowly starts *promising* things its machinery does not *do*, and it
 * has already happened once: a merge card shipped with no duty reference
 * because its duty was never added to the roster.
 *
 * The rule doc 07 sets, and this file implements: **every brain workflow names
 * the duty keys it serves.** Then "what Nova says it does" and "what Nova
 * actually does" become one checkable list — and the difference between them
 * becomes {@link UNCLAIMED}, which is large, written down, and reviewed.
 *
 * ## Where it does NOT live
 *
 * Not in dakio-api. `departmentForJob` stamps a column at row creation and
 * stays server-side; the DUTY CLAIM is about what the workflow *does*, so it
 * lives beside the workflow. dakio-api never reads this file.
 *
 * ## Asserted in three places, cheapest first
 *
 * 1. **Module load** — an unknown duty key throws at boot, not at 02:00. Same
 *    posture as the authority layer, where an off-roster `dutyRef` is not a
 *    soft failure: `evaluateAuthority` returns `refuse` with rule
 *    `duty:unknown` PLUS an escalation, 100% of the time, at every tier. An
 *    unknown duty is a hard refusal there; it is a hard boot failure here.
 * 2. **A two-way coverage eval** (`registry.eval.test.ts`) — every claimed duty
 *    exists in the roster, and every roster duty is claimed by a lane, by a
 *    front-office action's `dutyRef`, or by an explicit {@link UNCLAIMED} entry
 *    with a written reason.
 * 3. **Runtime** — {@link assertDutyInLane}: a brain workflow may only pass a
 *    `dutyKey` drawn from its own lane. That is what turns this registry from
 *    documentation into a CAPABILITY BOUND — a pulse cannot quietly start
 *    pausing ad sets. Enforced AT THE GATE (`gateOrFile` calls it for every
 *    filing whose lane is a job kind), not by each lane remembering to; a lane
 *    names itself on the `GateSpec` and the seam does the rest.
 *
 * A SECOND BOUND SITS BESIDE IT, and it is the one that makes this one worth
 * anything: `VERB_DUTIES` in `src/store/duties.ts` says which duties may govern
 * which verb. Lane membership alone would still let the pulse file a purchase
 * order under `inventory.low_stock_alerts` — a duty it legitimately holds, and
 * the wrong law to judge a purchase order under.
 *
 * ## What a claim means, precisely
 *
 * "This lane's work is (part of) how Nova delivers this duty." It is NOT "this
 * lane is the only producer" (several lanes legitimately claim
 * `support.inbox_replies` — they all end in a reply on one thread), and it is
 * NOT "this duty is fully delivered" (a lane may serve a duty partially; the
 * roster's own `minLevel`/door status still governs whether it may act).
 */

import { DUTY_BY_KEY } from "../store/duties.js";
import type { JobKind, NovaDepartment } from "../store/types.js";
import { departmentForJob, PAYLOAD_RESOLVED_KINDS } from "./departments.js";

/** One model lane: a job kind the dispatcher may route to a workflow. */
export interface BrainLane {
  kind: JobKind;
  /**
   * The room this lane visits. Must agree with `departmentForJob(kind)` for
   * every kind whose room is decided by the kind alone; `null` for the
   * payload-resolved kinds (`followup`, `case_update`), where there is no
   * single right answer at registry time and asserting one would bake in
   * whichever branch an empty payload happens to take.
   */
  department: NovaDepartment | null;
  /** Duty keys from `src/store/duties.ts`. Validated at module load. */
  duties: readonly string[];
  /** Mastra workflow id, once the lane's workflow is built. Absent = not built yet. */
  workflow?: string;
}

/**
 * EVERY job kind, exhaustively. `null` means SERVER SWEEP: dakio-api leases and
 * runs it inside its own claim transaction, off the queue, before the candidate
 * query — nothing on this side may ever route one to a model.
 *
 * The `Record<JobKind, …>` is the tripwire. dakio-api can mint 21 kinds; the
 * ported union tracked 17 until phase E, so any router table like this one was
 * "exhaustive" over a stale copy of the server's list and TypeScript said so
 * approvingly. Adding a 22nd kind to `JobKind` now fails to compile HERE, which
 * is the point: the forgetting has to happen in the open.
 *
 * A sweep that somehow reached a model lane would render an `undefined` prompt,
 * fail, retry, and burn `MAX_ATTEMPTS=5` failed attempts every night, forever —
 * silently, because a failed sweep looks exactly like a flaky one.
 */
const LANES: Record<JobKind, BrainLane | null> = {
  // ── Founder plane: the cadenced six ────────────────────────────────────────

  /**
   * The watchdog, hourly 9–21. Its designed success is SILENCE: no critical
   * findings ⇒ stop, never spam the owner.
   *
   * Claims only what it actually senses today. Per the phase E spec (§C) three
   * of its seven sense domains are dead at the source — ads returns
   * `campaigns: []`, courier returns `couriers: []`, support is a client-side
   * stub returning `[]` — so this lane deliberately claims NO marketing,
   * shipping or support duty. Claiming them would be precisely the false
   * promise this registry exists to prevent.
   *
   * Its margin and supplier-delay domains are real but have no duty on the
   * roster to attach to; see UNCLAIMED's `finance.expense_flagging` and
   * `operations.rfq_compare` entries, which record that from the other side.
   */
  pulse: {
    kind: "pulse",
    department: "ceo",
    duties: [
      "ceo.risk_alerts",
      "ceo.department_oversight",
      "inventory.stock_monitoring",
      "inventory.low_stock_alerts",
    ],
    // Built in phase E unit 2 — `src/brain/pulse.ts`. Every one of the four
    // duties above is a WATCHING duty, and that is not an accident of drafting:
    // the pulse notices and reports, and every REMEDY it can propose (reorder,
    // clearance, reprice, switch supplier, cart recovery) belongs to a duty
    // this lane does not hold. Those surface as capability gaps on the result
    // and in the report rather than being acted on. See the remedy table's
    // header in pulse.ts, which cross-references each one to its lane or to
    // its UNCLAIMED entry below.
    workflow: "brain-pulse",
  },

  /** The face: ≤120 words on the founder's phone — what happened, what needs you, today's one move. */
  morning_report: {
    kind: "morning_report",
    department: "ceo",
    duties: ["ceo.daily_business_brief"],
  },

  /**
   * The CEO hour, Monday 09:00: goal pace, three things that worked and three
   * that didn't (with numbers), three ranked moves, one new experiment, and a
   * plan board where DONE is computed by the system, never claimed by the model.
   *
   * "One new experiment" is what claims `growth.hypothesis_backlog` — the
   * experiment lands as a backlog row, not as a live A/B test, so
   * `growth.ab_testing` stays unclaimed.
   */
  weekly_strategy: {
    kind: "weekly_strategy",
    department: "ceo",
    duties: ["ceo.weekly_strategy_memo", "ceo.goal_tracking", "growth.hypothesis_backlog"],
  },

  /**
   * 02:00, the working night pass: ads reviewed, purchase orders drafted,
   * tickets resolved, one content draft — reading the grades `night_shift`
   * wrote at 01:30.
   *
   * "Tickets resolved" is NOT claimed as `support.complaint_resolution`, and
   * that omission is the honest one: dakio-api's `SupportTicket` is the DAKIO
   * PLATFORM desk (merchant ↔ Dakio), not the merchant's customer support, so
   * resolving those tickets does nothing for the duty a founder reads as
   * "Nova resolves my customers' complaints" (phase E spec §C).
   */
  night_ops: {
    kind: "night_ops",
    department: "ceo",
    duties: [
      "marketing.ad_budget_optimization",
      "marketing.pause_weak_ad_sets",
      "marketing.campaign_scaling",
      "marketing.ad_copywriting",
      "operations.po_drafting",
      "inventory.reorder_drafts",
    ],
  },

  /**
   * 01:00 — turns the day's rejections and outcomes into ≤10 traceable
   * memories and corrects revenue estimates.
   *
   * ⚠️ CLAIMS NOTHING, and that is a finding, not an oversight: the roster has
   * no duty for "Nova learns". This is the MIRROR of the bug doc 07 names —
   * there, a card shipped with no duty because the duty was never added; here,
   * a whole nightly lane does real work no duty on the founder's roster
   * describes. Recorded in {@link LANES_WITHOUT_DUTIES}.
   */
  reflection: { kind: "reflection", department: "ceo", duties: [] },

  /**
   * Every 4h — founder-plane cart recovery by email/SMS: personal messages
   * naming the actual items, discounts a last resort (≤10%, big carts only),
   * never contacting a cart the in-thread lane already nudged.
   *
   * Email and SMS only. `sales.whatsapp_cart_recovery` is a THIRD channel with
   * no transport wired on either side, so it stays unclaimed rather than being
   * quietly folded in here.
   */
  cart_sweep: {
    kind: "cart_sweep",
    department: "sales",
    duties: ["sales.abandoned_checkout_emails", "sales.sms_cart_recovery"],
  },

  // ── Customer plane: rejoin the conversation ────────────────────────────────

  /**
   * Priority 1, the fast lane — the fallback so no customer message is lost
   * when live delivery fails. Ids only; content never rides the job bus.
   *
   * Claims BOTH reply duties on purpose. The roster carries two for one act:
   * the mined `support.customer_replies` and the Stage-10 `support.inbox_replies`,
   * added so a founder can pause Nova's inbox replies without touching anything
   * else. A lane that named only one would keep replying after a founder paused
   * the other — the toggle would look live and do nothing.
   */
  inbox_reply: {
    kind: "inbox_reply",
    department: "support",
    duties: ["support.inbox_replies", "support.customer_replies", "support.inbox_escalations"],
  },

  /**
   * Nova's own scheduled future check-ins. Three producers, one discipline:
   * promise repayment (fires 30 min BEFORE the promised time), NBA nudges, and
   * in-thread cart nudges — every one passing five fire-time re-checks.
   *
   * `department: null` — payload-resolved. `promiseId` present ⇒ `support` (Nova
   * paying a debt), absent ⇒ `sales` (a nudge). The duties span both rooms for
   * exactly that reason.
   */
  followup: {
    kind: "followup",
    department: null,
    duties: ["support.inbox_replies", "sales.inbox_cart_recovery", "sales.lead_followups"],
  },

  /**
   * The loop closer. Rejoins the customer's OWN thread, so tone, memory and
   * register come free, and the reply passes the ordinary send gate — which is
   * why a T0 Shadow store's loop-closure lands as a draft rather than not
   * happening.
   *
   * `department: null` — payload-resolved: the case drain stamps the case row's
   * own department, falling back to `shipping`. Its `conversationId` is legally
   * absent (a webhook can open a case on an order never discussed), and a
   * threadless case falls to the founder plane.
   */
  case_update: {
    kind: "case_update",
    department: null,
    duties: ["shipping.delivery_cases", "support.inbox_replies"],
  },

  // ── Delivery & inventory: the two dark lanes (no producer today, doc 07 D) ──

  /**
   * The founder's homework on a stuck parcel: last scan, dwell time, what the
   * customer was told, and THE ONE QUESTION to ask the courier — honest that
   * Dakio itself cannot reschedule a parcel.
   *
   * DARK: nothing in either repo mints this row yet (spec §D wires it to
   * `novaJourney.js`'s stagnation edge). It reads what `courierSync` already
   * wrote; it does not re-poll — which is also why it claims `delay_chasing`
   * (chasing what is late) and not `delay_prediction` (forecasting what will
   * be).
   */
  courier_intervention: {
    kind: "courier_intervention",
    department: "shipping",
    duties: ["shipping.delay_chasing", "shipping.delivery_cases"],
  },

  /**
   * Answer a waiting customer honestly: a real PO date may be promised; nothing
   * on order means "soon, and I'll tell you the moment it lands" — *"a date you
   * made up is a second disappointment."*
   *
   * DARK: customers open `restock_wait` cases today and nothing listens (spec
   * §D hooks it at `novaCase.js:487`). It READS stock and answers; the
   * "three customers waiting = a restock decision" it raises is a decision
   * card, not a drafted PO, so `inventory.reorder_drafts` stays with `night_ops`.
   */
  restock_check: {
    kind: "restock_check",
    department: "inventory",
    duties: ["inventory.stock_monitoring", "support.inbox_replies"],
  },

  /**
   * Gives Nova eyes: captions + embeds up to 100 product photos per run so a
   * customer-sent photo can be matched to a product. One run = one billed task,
   * enforced by the batch cap.
   *
   * ⚠️ CLAIMS NOTHING — the second lane with real work and no duty. Catalog
   * photo indexing is not on the founder's roster in any form, so a founder
   * has no row to read, no level to set, and no toggle to pause it. Recorded in
   * {@link LANES_WITHOUT_DUTIES}.
   */
  catalog_vision: { kind: "catalog_vision", department: "inventory", duties: [] },

  // ── SERVER SWEEPS — never a lane, never a model turn, never routed here. ────
  // dakio-api leases these inside its claim transaction; the dispatcher is
  // never handed one. `null` is the enforcement: `laneFor` returns null and the
  // router has nowhere to go. See the tripwire block on `JobKind` in types.ts.
  promise_sweep: null, // the conscience: overdue promises → founder card
  identity_merge_sweep: null, // duplicate customers → merge cards
  conversation_distill: null, // memory retention clock
  journey_sweep: null, // deterministic stage reducer — "stage is code, never model output"
  inbox_attribution: null, // the ONLY thing allowed to call revenue "measured"
  inbox_sla_sweep: null, // one polite holding update on a founder-held escalation
  order_confirm_sweep: null, // the backstop for when the model could not speak
  night_shift: null, // deterministic room grading — a grade a model can invent is forbidden
  catalog_photo_sweep: null, // reconciler that MINTS catalog_vision; the turn is over there
};

/**
 * Boot-time validation — assertion #1.
 *
 * Exported so `registry.eval.test.ts` can drive it with a deliberately broken
 * lane and prove it throws, rather than asserting on a module it cannot
 * corrupt. The module body below calls this with the real table, so importing
 * this file IS the assertion.
 */
export function assertLaneDutiesExist(
  lanes: readonly Pick<BrainLane, "kind" | "duties">[],
): void {
  const unknown: string[] = [];
  for (const lane of lanes) {
    for (const key of lane.duties) {
      if (!DUTY_BY_KEY.has(key)) unknown.push(`${lane.kind} → "${key}"`);
    }
  }
  if (unknown.length > 0) {
    throw new Error(
      `[nova:brain] lane claims a duty that is not on Nova's roster: ${unknown.join(", ")}. ` +
        `An unknown duty key is a hard refusal at every authority tier ` +
        `(evaluateAuthority → refuse, rule "duty:unknown", plus an escalation), so a lane ` +
        `built on one would refuse 100% of its work at 02:00. Failing at import instead. ` +
        `Add the duty to src/store/duties.ts (and re-run scripts/check-duty-seed-sync.ts), ` +
        `or fix the key.`,
    );
  }
}

/** Every duty key named in {@link UNCLAIMED} must also be real — same posture. */
function assertUnclaimedKeysExist(entries: readonly UnclaimedDuty[]): void {
  const unknown = entries.filter((e) => !DUTY_BY_KEY.has(e.key)).map((e) => e.key);
  if (unknown.length > 0) {
    throw new Error(
      `[nova:brain] UNCLAIMED names duty keys that are not on the roster: ${unknown.join(", ")}. ` +
        `A gap list that lists things which do not exist stops being a gap list.`,
    );
  }
}

/** The lanes, in declaration order. Server sweeps are absent by construction. */
export const BRAIN_LANES: readonly BrainLane[] = Object.values(LANES).filter(
  (l): l is BrainLane => l !== null,
);

/**
 * Kinds dakio-api runs itself. Exported so the dispatcher can say "this should
 * never have reached me" with a name rather than a shrug.
 */
export const SERVER_SWEEP_KINDS: readonly JobKind[] = (
  Object.keys(LANES) as JobKind[]
).filter((k) => LANES[k] === null);

/** The lane for a kind, or `null` for a server sweep (which must not be routed). */
export function laneFor(kind: JobKind): BrainLane | null {
  return LANES[kind] ?? null;
}

/** Every duty key claimed by at least one lane. */
export const LANE_CLAIMED_DUTY_KEYS: ReadonlySet<string> = new Set(
  BRAIN_LANES.flatMap((l) => l.duties),
);

/**
 * Assertion #3 — the runtime capability bound.
 *
 * A brain workflow may only act under a duty key its OWN lane claims. Without
 * this the registry is documentation: a lane could pass any roster key to the
 * authority layer, and `evaluateAuthority` would happily evaluate it, because
 * from there a valid key is a valid key. With it, the pulse cannot quietly
 * start pausing ad sets — `marketing.pause_weak_ad_sets` is not in its lane.
 *
 * WHERE IT IS CALLED FROM, and why that had to change. It used to be called
 * from nowhere but its own test: the pulse re-implemented the same membership
 * check inline, so the registry's "runtime bound" was enforced by convention in
 * one file, and every future lane had to remember. It is now called by
 * `gateOrFile` (front-office/actions.ts) — the ONE seam every lane files
 * through, which takes the lane on its `GateSpec` and asserts membership there,
 * beside the verb↔duty binding. A lane cannot decline to be bounded, because it
 * cannot decline to name itself: the field is required.
 *
 * Throws rather than returning false: this is a programming error at the seam
 * between a workflow and the gate, not a runtime condition to branch on.
 */
export function assertDutyInLane(kind: JobKind, dutyKey: string): void {
  const lane = laneFor(kind);
  if (!lane) {
    throw new Error(
      `[nova:brain] job kind "${kind}" is a server sweep — it has no lane and may not act ` +
        `under any duty. dakio-api runs it; nothing here should have been handed one.`,
    );
  }
  if (!lane.duties.includes(dutyKey)) {
    throw new Error(
      `[nova:brain] lane "${kind}" may not act under duty "${dutyKey}" — its lane claims ` +
        `[${lane.duties.join(", ") || "nothing"}]. Either the workflow is reaching outside its ` +
        `remit, or the claim belongs in the registry where a reviewer can see it.`,
    );
  }
}

// ---------------------------------------------------------------------------
// The honest capability gap
// ---------------------------------------------------------------------------

export interface UnclaimedDuty {
  key: string;
  /** Why nothing fulfils it today. A reason, not a placeholder. */
  reason: string;
}

/**
 * Duties on the founder's roster that NO lane and NO front-office action
 * fulfils today — 47 of 72.
 *
 * This array IS the honest capability gap, reviewed like the existing
 * `NEEDS_DOOR` list. It is large on day one, and that is the point: the roster
 * is a promise the founder reads, and until now nothing measured the distance
 * between it and the machinery. Every entry carries a reason, because "not yet"
 * without a reason is how a gap list becomes wallpaper.
 *
 * A duty leaves this list by being claimed in a lane above (or by a
 * front-office action's `dutyRef`) — never by being deleted from here to make
 * a number look better.
 */
export const UNCLAIMED: readonly UnclaimedDuty[] = [
  // ── CEO ────────────────────────────────────────────────────────────────────
  {
    key: "ceo.revenue_forecasting",
    reason:
      "No lane projects revenue. weekly_strategy reports goal PACE, which is tracking against a " +
      "target that already exists — a forecast is a different claim and nothing computes one.",
  },

  // ── Marketing — night_ops covers the four ad-account duties; everything that
  //    SENDS or PUBLISHES is unclaimed, because no lane owns a broadcast. ─────
  {
    key: "marketing.email_campaigns",
    reason: "No lane composes or sends a Broadcast campaign; cart_sweep's email is cart recovery, not campaigns.",
  },
  {
    key: "marketing.sms_campaigns",
    reason: "Same as email_campaigns — cart_sweep's SMS arm is recovery, not a campaign send.",
  },
  { key: "marketing.push_notifications", reason: "No lane sends push. No producer, no transport wired." },
  {
    key: "marketing.social_posts",
    reason:
      "night_ops writes ONE content draft and claims ad_copywriting for it; nothing publishes to FB/IG.",
  },
  { key: "marketing.reels_and_stories", reason: "No lane produces video/story assets at all." },
  {
    key: "marketing.seasonal_promotions",
    reason:
      "Nothing is seasonally aware. growth.seasonal_planning below is the same gap from the planning side.",
  },

  // ── Sales ──────────────────────────────────────────────────────────────────
  {
    key: "sales.whatsapp_cart_recovery",
    reason:
      "A third recovery channel with no transport on either side. cart_sweep does email/SMS; the " +
      "in-thread nudge is sales.inbox_cart_recovery on the followup lane. WhatsApp is neither.",
  },
  {
    key: "sales.bulk_buyer_quotes",
    reason: "No lane quotes wholesale. The front office takes chat orders; a bulk quote is a different artifact.",
  },
  {
    key: "sales.payment_chasing",
    reason:
      "The followup lane could carry it — three producers exist and none of them is an unpaid order. " +
      "Nothing reads payment state and schedules a chase.",
  },
  {
    key: "sales.upsell_offers",
    reason:
      "No lane mints an upsell coupon. cart_sweep's ≤10% last-resort discount is recovery, not upsell.",
  },
  {
    key: "sales.winback_campaigns",
    reason:
      "journey_sweep computes dormancy server-side, but nothing consumes it: no lane messages a lapsed customer.",
  },

  // ── Support ────────────────────────────────────────────────────────────────
  {
    key: "support.complaint_resolution",
    reason:
      "THE HONESTY CASE. night_ops 'resolves tickets', but dakio-api's SupportTicket is the DAKIO " +
      "PLATFORM desk (merchant ↔ Dakio) — not the merchant's customer support. Claiming this duty " +
      "for that work would tell a founder Nova resolves THEIR customers' complaints. It does not. " +
      "The honest fix (spec §C) is to re-point this at cases + escalated inbox conversations.",
  },
  {
    key: "support.faq_policy_updates",
    reason: "No lane writes to Store Studio. Nova reads policy for answers; it never edits it.",
  },
  {
    key: "support.refund_processing",
    reason: "minLevel 4 and no producer — no lane issues a refund. The front office cancels orders; refunding is separate.",
  },
  { key: "support.replacement_shipments", reason: "minLevel 4, no producer — nothing ships a replacement." },
  {
    key: "support.review_responses",
    reason: "No review source is read anywhere in either repo; the duty was re-doored to Inbox but has no input.",
  },

  // ── Product research — the whole department is unclaimed (7/7). ─────────────
  {
    key: "product_research.winning_product_imports",
    reason: "No lane touches the dropship marketplace. The entire product_research department has no producer.",
  },
  { key: "product_research.pricing_research", reason: "No lane researches competitor pricing." },
  { key: "product_research.supplier_sourcing", reason: "No lane sources new suppliers for new SKUs." },
  {
    key: "product_research.product_page_generation",
    reason: "No lane writes product pages. catalog_vision reads photos into memory; it never authors a page.",
  },
  { key: "product_research.trend_scouting", reason: "No external trend source is read anywhere." },
  { key: "product_research.competitor_tracking", reason: "No competitor data source exists on either side." },
  { key: "product_research.demand_validation", reason: "No lane runs a demand test." },

  // ── Inventory ──────────────────────────────────────────────────────────────
  {
    key: "inventory.dead_stock_clearance",
    reason:
      "pulse SENSES dead stock (a real, honest domain) but nothing acts: minting a clearance coupon " +
      "is a Coupons write at minLevel 3 that no lane performs. Sensed, never cleared.",
  },
  { key: "inventory.multi_channel_sync", reason: "There is no second channel to sync to." },

  // ── Shipping ───────────────────────────────────────────────────────────────
  {
    key: "shipping.predispatch_confirms",
    reason:
      "order_confirm_sweep is the closest thing and it is a SERVER SWEEP with a deterministic " +
      "template — no lane, so no duty claim. A sweep cannot claim a duty (it never reaches a model).",
  },
  { key: "shipping.pickup_booking", reason: "No lane books a pickup; Dakio cannot dispatch a courier from here." },
  {
    key: "shipping.rate_compare",
    reason:
      "The Rate Compare door shipped as a read-model surface; no lane computes or acts on a comparison.",
  },
  {
    key: "shipping.rto_reduction",
    reason:
      "The pulse's courier domain is DEAD AT THE SOURCE (the route returns `couriers: []`), so nothing " +
      "reads RTO. Spec §C: the fix is a real courier scorecard read over CourierConsignment — one read " +
      "that would serve the pulse and ship doc 07's Tier-2 founder feature at once.",
  },
  {
    key: "shipping.delay_prediction",
    reason:
      "courier_intervention CHASES what is already late; nothing forecasts. journey_sweep's " +
      "stagnation edge is a detection, not a prediction.",
  },

  // ── Finance — the whole department is unclaimed (7/7). ─────────────────────
  {
    key: "finance.cod_reconciliation",
    reason: "No lane reads settlements. The entire finance department has no producer on the brain side.",
  },
  { key: "finance.invoice_logging", reason: "No lane writes to the ledger." },
  {
    key: "finance.expense_flagging",
    reason:
      "The pulse's MARGIN domain is real and honest (under-25% detection), but no duty on the roster " +
      "describes it, so the sense has nothing to attach to. Closest neighbour, and not close enough.",
  },
  {
    key: "finance.ad_spend_audit",
    reason:
      "The pulse's ads domain is dead at the source (`campaigns: []`), and night_ops reviews ad " +
      "PERFORMANCE, never audits spend against the ledger.",
  },
  { key: "finance.refund_ledger", reason: "Nothing issues refunds (see support.refund_processing), so nothing ledgers them." },
  { key: "finance.pnl_reports", reason: "No lane computes P&L or cashflow; the door is a read-model surface only." },
  { key: "finance.tax_export", reason: "minLevel 4, no producer — nothing exports." },

  // ── Operations ─────────────────────────────────────────────────────────────
  { key: "operations.rfq_requests", reason: "No lane sends an RFQ; night_ops drafts POs against known suppliers." },
  {
    key: "operations.rfq_compare",
    reason:
      "The pulse's SUPPLIER-DELAY domain is real, but a delay signal is not a scorecard: nothing " +
      "aggregates supplier performance into the comparison this duty promises.",
  },
  { key: "operations.supplier_switching", reason: "`switch_supplier` is a shipped verb with no lane that calls it." },
  { key: "operations.payment_terms_negotiation", reason: "minLevel 4, no producer — no lane negotiates terms." },

  // ── Growth ─────────────────────────────────────────────────────────────────
  {
    key: "growth.bundle_offers",
    reason:
      "No lane builds a bundle. night_ops is the only lane that writes merchandising artifacts and " +
      "it drafts POs and ad copy, never a product bundle.",
  },
  { key: "growth.landing_page_variants", reason: "No lane writes to Store Studio." },
  {
    key: "growth.ab_testing",
    reason:
      "weekly_strategy files ONE experiment as a hypothesis-backlog row; nothing runs, splits or " +
      "measures a test.",
  },
  { key: "growth.competitor_benchmarks", reason: "No competitor data source exists (see product_research)." },
  {
    key: "growth.seasonal_planning",
    reason: "Nothing in the brain is calendar-aware. Same gap as marketing.seasonal_promotions, from the planning side.",
  },
];

/**
 * The inverse gap: lanes that do real, nightly work no duty on the founder's
 * roster describes.
 *
 * Doc 07's named bug is a card shipping with no duty. These are the same bug at
 * lane scale — and worth listing separately because the coverage eval cannot
 * find them: a lane with `duties: []` breaks no assertion. Only a human reading
 * this list notices that a founder has no row, no level and no pause switch for
 * either of them.
 */
export const LANES_WITHOUT_DUTIES: readonly { kind: JobKind; reason: string }[] = [
  {
    kind: "reflection",
    reason:
      "Nightly learning — ≤10 traceable memories from the day's rejections and outcomes, plus " +
      "revenue-estimate corrections. The roster has no duty for 'Nova learns' in any department.",
  },
  {
    kind: "catalog_vision",
    reason:
      "Catalog photo indexing — captions + embeds up to 100 photos per run, one billed task each. " +
      "Not on the roster in any form, so the founder cannot see it, level it, or pause it.",
  },
];

// ---------------------------------------------------------------------------
// Assertion #1 runs HERE — importing this module is the check.
// ---------------------------------------------------------------------------
assertLaneDutiesExist(BRAIN_LANES);
assertUnclaimedKeysExist(UNCLAIMED);

/**
 * Guard the department claim at load too, since it is free: a lane whose
 * declared room disagrees with `departmentForJob` would render "Nova is working
 * here" in one room while the server filed the visit under another.
 */
for (const lane of BRAIN_LANES) {
  if (PAYLOAD_RESOLVED_KINDS.includes(lane.kind)) continue;
  const server = departmentForJob(lane.kind);
  if (lane.department !== server) {
    throw new Error(
      `[nova:brain] lane "${lane.kind}" claims department "${lane.department}" but ` +
        `departmentForJob says "${server}". The server stamps the column; a lane that disagrees ` +
        `lights up the wrong room.`,
    );
  }
}
