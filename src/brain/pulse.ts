/**
 * THE PULSE — Nova's hourly look at the business, and the cheapest lane in the
 * brain.
 *
 * ── THE ONE NUMBER THIS FILE EXISTS FOR ─────────────────────────────────────
 *
 * A pulse where nothing changed costs **zero model calls**. Under eve every
 * hourly pulse was a full ~26K-token agent turn whose usual conclusion was "all
 * quiet" — 13 of them a day, per tenant, to discover nothing. Here SENSE and
 * COMPARE are code, and the model is invited only for the departments whose
 * signals actually moved, with a ~200-token "what changed" card. The saving is
 * not the point on its own: when checking is free, checking often costs
 * nothing, and the same spend buys roughly 10× the watchfulness (doc 06).
 *
 * ── THE LOOP ────────────────────────────────────────────────────────────────
 *
 *   SENSE    `senseStore` (lib/snapshot.ts) — one round of parallel reads,
 *            each independently guarded. Six domains now: inventory, sales,
 *            carts, margin, supplier delay and — since dakio-api's
 *            `GET /couriers` became a real aggregate — COURIER. Ads and support
 *            are still NOT sensed and `SENSE_GAPS` says why, in the code, where
 *            a reader trips over it.
 *   COMPARE  `comparePulse` (pulse-compare.ts) — pure, edge-triggered. Nothing
 *            crossed a threshold ⇒ STOP: write the snapshot, return, spend
 *            nothing. SILENCE IS THE DESIGNED SUCCESS OF THIS LANE, and a
 *            pulse that files a report about a quiet hour is a bug, not a
 *            courtesy ("if there are no critical findings, stop — do not file
 *            a report or take action (never spam the owner)", nova-ai's own
 *            pulse prompt).
 *   DECIDE   one small judgement call per MOVED department, never per finding
 *            and never per whole store. A critical finding is never
 *            suppressible by that judgement — see the `hasCritical` branch in
 *            {@link runPulse}.
 *   ACT      through the SAME authority gate the customer lane uses
 *            (`gateOrFile` → `evaluateAuthority`). No second gate exists in
 *            this repo and this file does not add one.
 *   RECORD   one consolidated `pulse` report, only when something survived —
 *            or when something Nova CANNOT SEE is news.
 *
 * ── THREE RULES ABOUT WHAT THE FOUNDER IS TOLD ─────────────────────────────
 *
 * All three were defects an adversarial review found by probing this lane, and
 * all three passed the suite that was supposed to guard them.
 *
 *  1. THE TITLE IS DERIVED, NEVER WRITTEN BY THE MODEL. {@link pulseTitle}
 *     builds it from the findings' own code-generated titles. The judge's
 *     prose is still used — bounded and checked against the card it was judging
 *     ({@link boundJudgeText}) — but it cannot become the line the founder
 *     reads first, because that line once read "⚠ Sales are down because your
 *     courier is losing parcels and ad spend is wasted" on a report that
 *     disclaimed courier and ads in its own footer. (Half of that sentence is
 *     now measurable and the vocabulary bound has let go of the word
 *     "courier" — see {@link UNKNOWABLE_VOCABULARY}. The title rule has not
 *     moved an inch: a measured domain does not earn model prose a headline.)
 *  2. A CONDITION IS "OPEN" ONLY IF IT REACHED THE FOUNDER. The snapshot's
 *     `announced` flag is set from a filed report or a Decision card on the
 *     desk — not from "we derived it". One `worthWaking: false`, or one 500 on
 *     `POST /reports`, used to retire a finding permanently.
 *  3. `quiet: true` IS UNREACHABLE WHILE SOMETHING IS DARK AND UNREPORTED —
 *     including a load-bearing FIELD inside a read that succeeded. Blindness is
 *     compared like a finding (news when it appears, again after a day) so it
 *     is neither spam nor invisible.
 *
 * ── WHAT THE PULSE MAY DO, AND THE HONEST ANSWER TODAY ─────────────────────
 *
 * `registry.ts` binds this lane to four duties: `ceo.risk_alerts`,
 * `ceo.department_oversight`, `inventory.stock_monitoring`,
 * `inventory.low_stock_alerts`. All four are WATCHING duties. Every REMEDY the
 * pulse can propose (reorder, clearance, reprice, switch supplier, recover a
 * cart) belongs to a duty this lane does not hold — they live with `night_ops`,
 * `cart_sweep`, or nowhere at all (registry's `UNCLAIMED`).
 *
 * The courier sense arrived without moving that line: the pulse lane declares
 * NO shipping duty (checked, not assumed — `registry.ts`'s pulse entry is
 * `ceo.risk_alerts`, `ceo.department_oversight`, `inventory.stock_monitoring`,
 * `inventory.low_stock_alerts`), so the one courier remedy that has a verb
 * behind it surfaces as a capability gap like every other row in the table.
 *
 * So on a real store today the pulse NOTICES and REPORTS, and acts on nothing.
 * That is a capability gap, and this file's job is to make it visible rather
 * than to close it by quietly acting outside the lane: every finding whose
 * remedy is out of lane is returned as a {@link CapabilityGap} naming the verb
 * and the duty it would need. The gate path below is fully built and fully
 * exercised (see `pulse.eval.test.ts`), because the day a duty moves into this
 * lane is the wrong day to discover the act path was never written.
 *
 * A REMEDY NAMES A VERB **AND** THE DUTY IT IS PERFORMED UNDER, and the second
 * one is not a free choice. The authority seam reads the duty key to pick the
 * door, the minimum level and the founder's pause switch, so a table that could
 * choose both could have any verb judged under any duty's law — and this one
 * did: the reprice remedy filed `update_price` under `finance.expense_flagging`,
 * a duty registry.ts's own gap list had already ruled "not close enough". The
 * legitimate pairs now live in `VERB_DUTIES` (store/duties.ts), derived from the
 * tools' own `dutyRef` declarations and the roster, and `gateOrFile` refuses any
 * other pair before it judges anything. One consequence is worth stating up
 * front rather than discovering in a report: `update_price` is governed by NO
 * duty on the founder's roster, so the margin remedy is not "out of lane" — it
 * is a ROSTER gap, and it says so.
 *
 * ── BOOKKEEPING IS CODE NOW ─────────────────────────────────────────────────
 *
 * nova-ai's pulse spent model steps calling `mark_event_processed` on each
 * unprocessed inbox event. That is bookkeeping, not judgement: here it is a
 * `for` loop, and what survives into the snapshot is a single CURSOR (the max
 * `receivedAt` taken into account), not a list. The events themselves are
 * situational awareness for the card — they are never a finding on their own,
 * because a finding must name a sensed observation and an event is not one.
 */

import { createStep, createWorkflow } from "@mastra/core/workflows";
import { Agent } from "@mastra/core/agent";
import { gateway } from "@ai-sdk/gateway";
import { z } from "zod";

import {
  doorFor,
  fileAuthorizedUnexecuted,
  gateOrFile,
  type GateReceiptInput,
  type GateSpec,
} from "../front-office/actions.js";
import {
  allSensesDark,
  blindSpots,
  senseStore,
  senseFailures,
  SENSE_GAPS,
  type BlindSpot,
  type StoreSense,
} from "../lib/snapshot.js";
import { storeFor } from "../store/resolve.js";
import { UNGOVERNED_VERBS } from "../store/duties.js";
import type { StoreClient } from "../store/client.js";
import type { ActionType, JobKind, NovaDepartment } from "../store/types.js";
import { laneFor } from "./registry.js";
import {
  blindSpotNews,
  comparePulse,
  nextBlindSpots,
  nextSnapshot,
  type PulseFinding,
} from "./pulse-compare.js";
import { loadPulseState, savePulseState } from "./pulse-state.js";

/** This lane's kind — every registry lookup below is keyed on it. */
const KIND = "pulse" as const;

/**
 * The `confidence` every pulse receipt carries — A CONSTANT, AND SAID TO BE ONE.
 *
 * The gate's receipt schema wants a number in this field. The pulse has no
 * honest one: it does not estimate probabilities, it reports that a measured
 * value crossed a fixed threshold. The old code wrote `0.9` for critical
 * findings and `0.7` otherwise, which is a severity flag wearing a probability's
 * clothes on a founder's Decision card. Nothing in `evaluateAuthority` reads
 * this field, so no gate outcome moves; what changes is that the card no longer
 * implies an estimate nobody made. A `pulse:confidence` evidence row states it
 * in words beside the number.
 */
export const PULSE_RECEIPT_CONFIDENCE = 1;

// ---------------------------------------------------------------------------
// DECIDE — the only model in the lane
// ---------------------------------------------------------------------------

const JUDGE_MODEL =
  process.env.NOVA_MODEL_PULSE ?? process.env.NOVA_MODEL_RESOLVER ?? "anthropic/claude-haiku-4-5-20251001";

/** Hard bounds on anything the judge writes that a founder will read. */
export const HEADLINE_MAX_CHARS = 120;
export const NOTE_MAX_CHARS = 240;

export const pulseJudgeSchema = z.object({
  /**
   * Is this worth interrupting the founder's day for, right now? `false` is a
   * real answer and the lane's preferred one.
   */
  worthWaking: z.boolean(),
  /**
   * One line about this department's change. BOUNDED AND CHECKED — see
   * {@link boundJudgeText}. It is NOT the report's title (the title is derived
   * from the findings themselves) and it may not carry a number the card does
   * not, or a word about a domain Nova cannot see.
   */
  headline: z.string().max(HEADLINE_MAX_CHARS),
  /** What you would do about it, in one sentence. Same bounds. */
  note: z.string().max(NOTE_MAX_CHARS),
});

export type PulseJudgement = z.infer<typeof pulseJudgeSchema>;

/**
 * The judge. A SMALL model, because the judgement is small: the numbers are
 * already decided by code and handed over as a card; all that is being bought
 * here is "does this deserve the founder's attention, and how would you say
 * it".
 */
export const pulseJudgeAgent = new Agent({
  id: "brain-pulse-judge",
  name: "brain-pulse-judge",
  description:
    "Brain pulse judge — decides whether one department's changed signals are worth waking the founder, and words them.",
  instructions: [
    "You are Nova's hourly watchdog, judging ONE department's changed signals for a Bangladeshi e-commerce store.",
    "You are given a CHANGE CARD: only what moved since the last check, with the numbers already measured.",
    "",
    "RULES:",
    "- Never invent a number, a cause or a name. Use only what the card says.",
    "- NEVER EXPLAIN A CHANGE WITH SOMETHING THE CARD DOES NOT MEASURE. The card lists what Nova cannot see;",
    "  those subjects do not exist for you. 'Sales are down because the courier is losing parcels' is a lie",
    "  when nobody measured the courier — and it is the single worst thing you can write here.",
    "- worthWaking = false is the RIGHT answer for anything the owner would not act on today.",
    "  Silence is success; a report about a quiet hour is spam.",
    `- headline: one line, at most ${HEADLINE_MAX_CHARS} characters, plain, leading with the fact. No greetings,`,
    "  no filler, no cause you were not given.",
    `- note: the single most useful next move, or why it can wait. At most ${NOTE_MAX_CHARS} characters.`,
    "- Both lines are checked against the card before a founder sees them, and a line that fails the check is",
    "  replaced by the measurement itself. Writing within the card is the only way your wording survives.",
  ].join("\n"),
  model: gateway(JUDGE_MODEL),
});

/** What DECIDE is handed: one department's moved findings, nothing else. */
export interface DecideInput {
  storeId: string;
  department: NovaDepartment;
  findings: PulseFinding[];
  /** The ~200-token card, exactly as the model sees it. */
  card: string;
}

export type DecideFn = (input: DecideInput) => Promise<PulseJudgement>;

/**
 * The change card — the entire context the model gets, ~200 tokens.
 *
 * Deliberately NOT the store snapshot: re-reading a whole business to judge two
 * moved numbers is exactly the eve cost this lane exists to kill. What moved,
 * what it was, what it is now.
 */
export function changeCard(input: {
  department: NovaDepartment;
  findings: PulseFinding[];
  eventsSeen: number;
  /**
   * What Nova could not see THIS PASS, in words — dark reads AND dark fields.
   * It used to be failed reads only, so a judge asked about inventory on a
   * store with no velocity source was not told that was why the card was thin.
   */
  senseDark: string[];
}): string {
  const lines = [`DEPARTMENT: ${input.department}`, "WHAT CHANGED SINCE THE LAST CHECK:"];
  for (const f of input.findings) {
    lines.push(
      `- [${f.severity}] ${f.title}`,
      `  ${f.observation.evidence}`,
      `  (${f.observation.metric}: ${f.observation.value ?? "n/a"}` +
        `${f.observation.priorValue === null ? ", first sighting" : ` was ${f.observation.priorValue}`}, ${f.trigger})`,
    );
  }
  if (input.eventsSeen > 0) {
    lines.push(
      `CONTEXT: ${input.eventsSeen} new store event(s) since the last check (orders/carts). Awareness only — not a task list.`,
    );
  }
  // ── WHAT NOVA CANNOT SEE AT ALL ──────────────────────────────────────────
  //
  // This was the hole under D1. The card named only THIS PASS's failed reads,
  // never the three domains that have no source at all — so the judge, asked
  // why sales moved, reached for the most plausible commerce story it knew and
  // wrote "your courier is losing parcels and ad spend is wasted" into a report
  // whose own footer disclaims courier and ads. A model cannot decline to
  // discuss a subject nobody told it was off the table.
  lines.push(
    `NOVA CANNOT SEE (no data source — these subjects do not exist for you, do not name them and do not ` +
      `explain anything with them): ${SENSE_GAPS.map((g) => g.domain).join(", ")}.`,
  );
  if (input.senseDark.length > 0) {
    // A dark sense is stated so the judgement is made knowing what it cannot
    // see, rather than reading absence as good news.
    lines.push(`ALSO BLIND THIS PASS: ${input.senseDark.join("; ")}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// THE BOUND ON WHAT THE MODEL MAY SAY TO A FOUNDER
// ---------------------------------------------------------------------------

/**
 * Vocabulary of the domains Nova has no source for. A judge line that reaches
 * for one of these is talking about something nobody measured.
 *
 * Deliberately wide (a false positive costs a nice sentence; a false negative
 * costs a fabricated cause in the founder's headline) and keyed by the same
 * domains {@link SENSE_GAPS} names, so a domain that gains a real read has
 * exactly one place to be deleted from.
 *
 * ── THE COURIER ENTRY IS GONE, AND THAT WAS THE DESIGN WORKING ────────────
 *
 * It read:
 *
 *     courier: /\b(courier\w*|deliver\w*|shipp?\w*|parcel\w*|rto|…)\b/i
 *
 * and it existed because the probe that built this wall produced *"Sales are
 * down because your courier is losing parcels"* from a judge that had never
 * seen a parcel. The judge now can: `senseStore` reads the courier scorecard,
 * the change card carries RTO counts and dispatch-to-delivery days, and a
 * sentence about parcels is a sentence about a measurement. Keeping the regex
 * would have censored the courier department's own findings — the ONE
 * department whose card is entirely about parcels — and replaced every line the
 * judge wrote about them with the fallback.
 *
 * WHAT STILL STOPS THE ORIGINAL LIE is the other half of {@link boundJudgeText},
 * which never depended on this table: every NUMBER in the prose must appear in
 * the card it was judging. An inventory judge that reaches for a courier cause
 * cannot bring a courier number with it, and the fabricated *cause* it can
 * still write is bounded by the card's own "use only what the card says" and by
 * the fact that no model prose has been the report's TITLE since D1.
 *
 * The `Record<(typeof SENSE_GAPS)[number]["domain"], …>` key type is what made
 * the deletion mandatory rather than optional: removing courier from
 * `SENSE_GAPS` failed this object literal to compile.
 */
const UNKNOWABLE_VOCABULARY: Record<(typeof SENSE_GAPS)[number]["domain"], RegExp> = {
  ads: /\b(ads?|advert\w*|campaign\w*|roas|cpa|cpm|ctr|boost\w*|retarget\w*|ad[- ]?spend|facebook|meta|instagram)\b/i,
  support: /\b(support|ticket\w*|complaint\w*|helpdesk|refund[- ]?request\w*)\b/i,
};

/** Every number in a string, comma-separators removed. */
function numbersIn(text: string): string[] {
  return (text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => n.replace(/,/g, ""));
}

/** A line of model prose, after the check — and why it was replaced, if it was. */
export interface BoundedText {
  text: string;
  /** `null` when the model's own words survived. */
  rejected: string | null;
}

/**
 * BOUND AND CHECK ONE LINE OF JUDGE PROSE against the card it was written from.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * The judge's `headline` used to become the report's TITLE verbatim — the one
 * line a founder reads first — with no length bound, no vocabulary bound and no
 * check against the observations. Probed live it produced *"⚠ Sales are down
 * because your courier is losing parcels and ad spend is wasted"* on a report
 * whose own footer says Nova makes no claim about courier or ads. The same
 * string also lands on a Decision card as `receipt.expectedImpact`, where it
 * reads as Nova's reason for a write.
 *
 * The title is no longer model text at all ({@link pulseTitle} derives it from
 * the findings). This is the second wall, for the prose that remains:
 *
 *   1. it must be non-empty, single-line and within its length bound;
 *   2. it may not name a domain Nova has no source for ({@link SENSE_GAPS});
 *   3. every NUMBER in it must appear in the card it was judging.
 *
 * Rule 3 is strict on purpose: rounding "5.2 days" to "5 days" is rejected, and
 * the cost of that is a slightly duller sentence — the deterministic
 * measurement replaces it. The cost of the opposite mistake is a number in a
 * founder's report that came from nowhere.
 */
export function boundJudgeText(
  raw: string,
  opts: { card: string; fallback: string; maxLen: number },
): BoundedText {
  const reject = (reason: string): BoundedText => ({ text: opts.fallback, rejected: reason });
  const text = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (text.length === 0) return reject("empty");
  if (text.length > opts.maxLen) return reject(`over ${opts.maxLen} characters`);

  for (const gap of SENSE_GAPS) {
    if (UNKNOWABLE_VOCABULARY[gap.domain].test(text)) {
      return reject(`mentions ${gap.domain}, which Nova has no data source for`);
    }
  }

  const known = new Set(numbersIn(opts.card));
  for (const n of numbersIn(text)) {
    if (!known.has(n)) return reject(`cites ${n}, which is not in the measurements it was given`);
  }

  return { text, rejected: null };
}

/** The default DECIDE: one structured call to {@link pulseJudgeAgent}. */
const judgeWithModel: DecideFn = async ({ card }) => {
  const res = await pulseJudgeAgent.generate([{ role: "user", content: card }], {
    structuredOutput: { schema: pulseJudgeSchema },
  });
  const obj = res.object;
  if (!obj) throw new Error("pulse judge returned no structured output");
  return obj;
};

// ---------------------------------------------------------------------------
// The remedy table — what Nova WOULD do, and the duty it would need
// ---------------------------------------------------------------------------

/** A proposed corrective action for one finding. */
export interface Remedy {
  type: ActionType;
  /**
   * The duty this act would be performed under — and it must be one of the
   * duties that GOVERN the verb (`VERB_DUTIES` in store/duties.ts), not a key
   * chosen for how it would be judged.
   *
   * `null` means the verb is governed by NO duty on the founder's roster. That
   * is not a licence to file it under the nearest neighbour; it is a capability
   * gap of its own kind, and {@link settleFinding} surfaces it as one.
   */
  dutyKey: string | null;
  department: NovaDepartment;
  title: string;
  paramsLine: string;
  payload: Record<string, unknown>;
}

export type RemedyFn = (finding: PulseFinding, sense: StoreSense) => Remedy | null;

/**
 * THE PRODUCTION REMEDY TABLE — and every entry in it is out of this lane's
 * reach today. That is the finding, not a bug in the table.
 *
 * ── WHAT THIS TABLE MAY NOT DO, AND USED TO ────────────────────────────────
 *
 * A remedy names TWO things: the verb, and the duty it would be performed
 * under. Until the verb↔duty binding existed (`VERB_DUTIES`, enforced at
 * `gateOrFile`), the second one was a free choice — and the authority seam
 * reads the duty key to pick the DOOR, the MINIMUM LEVEL and the founder's
 * PAUSE SWITCH. A table that picked both could therefore have any verb judged
 * under any duty's law: measured on the demo store, a `create_purchase_order`
 * filed under `inventory.low_stock_alerts` (minLevel 0, a watching duty) came
 * back `suggest` at level 1 where the honest `inventory.reorder_drafts` was
 * refused `duty:min_level`. The duty a remedy names is now a fact about the
 * verb, checked at the seam; it is not this table's opinion.
 *
 * ── EVERY ROW, AND WHY IT CANNOT BE ACTED ON ───────────────────────────────
 *
 *  · reorder      → `create_purchase_order` under `inventory.reorder_drafts`.
 *                   A GOVERNING duty (night_ops claims it for "purchase orders
 *                   drafted"), just not this lane's. OUT OF LANE.
 *  · clearance    → `create_discount` under `inventory.dead_stock_clearance`.
 *                   Governing (UNCLAIMED: "minting a clearance coupon is a
 *                   Coupons write"), out of lane.
 *  · reprice      → `update_price`, under NOTHING. This row used to name
 *                   `finance.expense_flagging`, which registry.ts's own gap
 *                   list had ALREADY RULED OUT in writing — "no duty on the
 *                   roster describes it … Closest neighbour, and not close
 *                   enough". The margin sense is real and the verb is shipped;
 *                   the roster has no row for "Nova changes a price". A ROSTER
 *                   GAP, surfaced as one.
 *  · supplier     → `switch_supplier` under `operations.supplier_switching`.
 *                   Governing (UNCLAIMED names the verb), out of lane.
 *  · cart recovery→ `send_customer_message` under
 *                   `sales.abandoned_checkout_emails`. Governing, held by
 *                   `cart_sweep` — and DIVISION OF LABOUR, not a gap to close
 *                   here: doc 07 B2 is explicit that one cart worked by two
 *                   lanes is how a customer gets nudged twice in one evening.
 *  · revenue drop → NO remedy at all. There is no verb in `ActionType` that
 *                   fixes a week-over-week decline; the judgement belongs to
 *                   `weekly_strategy`. A report is the honest whole response.
 *  · stagnant     → `flag_courier_issue` under `shipping.delay_chasing`.
 *    parcels       Governing (VERB_DUTIES), held by `courier_intervention`,
 *                  not by this lane. OUT OF LANE — the newest row, and the
 *                  first one the courier sense made possible.
 *  · courier RTO  → NO remedy, and this one is worth reading twice, because
 *    / slow          "no remedy" here is not the same shape of gap as the
 *    delivery        revenue drop's. The founder's roster HAS a duty for it:
 *                  `shipping.rto_reduction` (RTO Analytics door, minLevel 2),
 *                  which registry.ts's UNCLAIMED list rules out for a reason
 *                  that this work just made stale — "the pulse's courier domain
 *                  is DEAD AT THE SOURCE (the route returns `couriers: []`), so
 *                  nothing reads RTO". Something reads it now. What is still
 *                  missing is a VERB: `ActionType` has nothing that changes
 *                  which courier a store routes to. `assign_courier` books ONE
 *                  parcel's pickup — booking a parcel is not changing a policy,
 *                  and filing it against a scorecard finding would be the
 *                  laundering `VERB_DUTIES` exists to stop. So the report is
 *                  the whole response, and the gap is written down where the
 *                  people who can close it will read it (registry.ts is not
 *                  this stream's to edit).
 */
export const productionRemedy: RemedyFn = (finding, sense) => {
  const product = sense.products.ok ? sense.products.value.find((p) => p.id === finding.subject) : null;

  if (finding.key.startsWith("inventory:cover:") && product) {
    // Cover the lead time plus a 14-day buffer, minus what is on the shelf —
    // nova-ai's sizing, kept, because a founder comparing the two must see the
    // same number.
    const leadTime = product.leadTimeDays ?? 0;
    // A cover finding cannot exist without a known velocity, so `?? 0` here is
    // unreachable rather than a guess — kept explicit so the types stay honest.
    const quantity = Math.max(1, Math.ceil((product.velocity ?? 0) * (leadTime + 14) - product.stock));
    return {
      type: "create_purchase_order",
      dutyKey: "inventory.reorder_drafts",
      department: "inventory",
      title: `Reorder ${quantity} × ${product.name} before it stocks out`,
      paramsLine: `${quantity} units · ${product.supplierName ?? product.supplierId} · ${leadTime}-day wait`,
      payload: {
        supplierId: product.supplierId,
        productId: product.id,
        quantity,
        unitCost: product.cost,
      },
    };
  }
  if (finding.key.startsWith("inventory:dead:") && product) {
    return {
      type: "create_discount",
      dutyKey: "inventory.dead_stock_clearance",
      department: "inventory",
      title: `Clear ${product.name} with a clearance offer`,
      paramsLine: `${product.stock} units · ${finding.observation.evidence}`,
      payload: { productId: product.id, percentOff: 10, reason: "dead_stock_clearance" },
    };
  }
  if (finding.domain === "margin" && product) {
    return {
      type: "update_price",
      // NOT `finance.expense_flagging` — see the table header. No duty on the
      // roster governs `update_price`, and naming the nearest one would be the
      // laundering this binding exists to stop.
      dutyKey: null,
      department: "finance",
      title: `${product.name} is priced under the margin floor`,
      paramsLine: finding.observation.evidence,
      payload: { productId: product.id, currentPrice: product.price, cost: product.cost },
    };
  }
  if (finding.domain === "supplier") {
    return {
      type: "switch_supplier",
      dutyKey: "operations.supplier_switching",
      department: "operations",
      title: finding.title,
      paramsLine: finding.observation.evidence,
      payload: { supplierId: finding.subject },
    };
  }
  // ── Courier: ONE of the three conditions has a verb behind it ────────────
  //
  // Stagnant parcels are a thing a person can act on today — someone rings the
  // courier about parcels that have stopped scanning — and `flag_courier_issue`
  // is exactly that act: it changes nothing at the courier (Dakio cannot hold,
  // redirect or reschedule a parcel), it assembles the facts and puts them in
  // front of the person who can pick up a phone.
  //
  // NO `trackingId`, deliberately. The verb's payload carries one because its
  // native caller (`courier_intervention`) works ONE parcel; this finding is a
  // pattern across a courier's whole in-flight book, and inventing a
  // representative parcel id would put a specific tracking number on a card
  // about a general problem. The courier and the count are the honest facts.
  //
  // The other two courier conditions (RTO rate, slow delivery) fall through to
  // `return null` — see the table header: the roster has the duty
  // (`shipping.rto_reduction`) and `ActionType` has no verb.
  if (finding.key.startsWith("courier:stagnant:")) {
    const courier = sense.courier.ok
      ? sense.courier.value.couriers.find((c) => c.id === finding.subject)
      : null;
    return {
      type: "flag_courier_issue",
      dutyKey: "shipping.delay_chasing",
      department: "shipping",
      title: finding.title,
      paramsLine: finding.observation.evidence,
      payload: {
        courierType: courier?.name ?? finding.subject,
        reason: finding.observation.evidence,
        recommendation: "Chase the courier for a scan on these parcels before the customers ask.",
      },
    };
  }
  if (finding.domain === "carts") {
    return {
      type: "send_customer_message",
      dutyKey: "sales.abandoned_checkout_emails",
      department: "sales",
      title: finding.title,
      paramsLine: finding.observation.evidence,
      payload: { purpose: "cart_recovery" },
    };
  }
  // sales:revenue_drop and anything new: report-only, on purpose.
  return null;
};

// ---------------------------------------------------------------------------
// The outcome of one finding
// ---------------------------------------------------------------------------

/**
 * A remedy this lane may not perform. Surfaced, never acted on.
 *
 * Two kinds, and the report tells them apart because the fix is different:
 *  · `out_of_lane` — a real duty governs the verb, another lane holds it (or
 *    no lane does). The fix is a REGISTRY edit, or a lane that does the work.
 *  · `ungoverned_verb` — the verb is shipped and NO duty on the founder's
 *    roster describes it, so there is nothing to hold. The fix is a ROSTER
 *    edit, reviewed, and mirrored to dakio-api's `NovaDuty` seed.
 */
export interface CapabilityGap {
  findingKey: string;
  verb: ActionType;
  kind: "out_of_lane" | "ungoverned_verb";
  /** The duty it would need, or `null` when no duty governs the verb at all. */
  wantedDuty: string | null;
  reason: string;
}

export type FindingOutcome =
  /** No remedy verb exists — the report IS the response. */
  | { kind: "reported" }
  /** A remedy exists but its duty is not this lane's. Surfaced, not acted. */
  | { kind: "capability_gap"; gap: CapabilityGap }
  /** The gate drafted it: a Decision card is on the founder's desk. */
  | { kind: "decision_filed"; actionId: string; rule: string }
  /** The gate refused it outright. Receipted as a blocked row. */
  | { kind: "refused"; actionId: string; rule: string }
  /** Already filed under this key by an earlier attempt — nothing new. */
  | { kind: "replayed"; actionId: string }
  /**
   * The gate would let Nova do this alone, and this lane has no executor for
   * the verb. See {@link settleFinding} — the honest outcome, not a hidden one,
   * and it carries the id of the row that RECORDS "authorized, nothing ran".
   */
  | { kind: "no_executor"; verb: ActionType; actionId: string };

export interface SettledFinding {
  finding: PulseFinding;
  headline: string;
  note: string;
  outcome: FindingOutcome;
}

/**
 * One department's judgement, plus what it is honestly ABOUT.
 *
 * DECIDE buys one judgement per moved department — never one per finding, which
 * is the cost claim this lane exists for. The consequence has to be carried
 * rather than forgotten: when a department moved on three findings, the model's
 * `note` is one sentence about all three, so it may not be pasted onto one
 * finding's receipt and Decision card as though it were about that finding.
 */
export interface DepartmentJudgement {
  /** The model's note, exactly as written. */
  note: string;
  /** How many findings that one note covered. */
  findingCount: number;
  /** The note, labelled with its scope when it covers more than one finding. */
  scopedNote: string;
}

/** Attach a department judgement to the findings it actually covered. */
export function scopeJudgement(
  judgement: PulseJudgement,
  department: NovaDepartment,
  findingCount: number,
): DepartmentJudgement {
  return {
    note: judgement.note,
    findingCount,
    scopedNote:
      findingCount === 1
        ? judgement.note
        : `Nova's note on all ${findingCount} ${department} findings this pass: ${judgement.note}`,
  };
}

/**
 * One department's judgement AFTER the bound — what the founder may actually be
 * shown, plus a record of anything the model wrote that was set aside.
 */
export interface BoundedJudgement extends PulseJudgement {
  department: NovaDepartment;
  /** Wording the check refused, named so the founder is told it happened. */
  rejections: string[];
}

/**
 * Put the judge's two prose fields through {@link boundJudgeText}, falling back
 * to the MEASUREMENT itself when they do not survive.
 *
 * The fallbacks are deterministic strings built from the findings, so a
 * rejected line degrades to something a founder can still act on rather than to
 * a blank.
 */
export function boundJudgement(
  judgement: PulseJudgement,
  input: { department: NovaDepartment; findings: PulseFinding[]; card: string },
): BoundedJudgement {
  const lead = input.findings[0];
  const headline = boundJudgeText(judgement.headline, {
    card: input.card,
    fallback: lead?.title ?? `${input.department}: signals moved`,
    maxLen: HEADLINE_MAX_CHARS,
  });
  const note = boundJudgeText(judgement.note, {
    card: input.card,
    fallback:
      `Nova's own wording for this was set aside; the measurement stands: ` +
      `${lead?.observation.evidence ?? "see the findings above"}`,
    maxLen: NOTE_MAX_CHARS,
  });
  const rejections: string[] = [];
  if (headline.rejected) rejections.push(`headline (${headline.rejected})`);
  if (note.rejected) rejections.push(`note (${note.rejected})`);
  return {
    department: input.department,
    worthWaking: judgement.worthWaking,
    headline: headline.text,
    note: note.text,
    rejections,
  };
}

// ---------------------------------------------------------------------------
// The pulse
// ---------------------------------------------------------------------------

export interface PulseOptions {
  /** Test/ops seam: the client to sense and act through. */
  client?: StoreClient;
  /** Test seam: the remedy table. Defaults to {@link productionRemedy}. */
  remedyFor?: RemedyFn;
  /** Test seam: the judgement step. Defaults to a real model call. */
  decide?: DecideFn;
  /** The job row's dedupe key, so a re-leased rerun re-files the SAME report. */
  dedupeKey?: string | null;
  /** For the report body's provenance line. */
  jobId?: string;
}

export interface PulseResult {
  storeId: string;
  at: string;
  /**
   * True = nothing crossed a threshold AND Nova could see everything it is
   * supposed to see. The success case.
   *
   * IT IS NOT REACHABLE WHILE A SENSE, OR A LOAD-BEARING FIELD INSIDE ONE, IS
   * DARK AND UNREPORTED. Probed on the old build: four of five senses down
   * answered `quiet: true, modelCalls: 0`, no report, job row completed — a
   * store blind for a week was indistinguishable from a healthy one on the
   * founder's board. See {@link PulseResult.blindSpots}.
   */
  quiet: boolean;
  /** THE HEADLINE NUMBER. Zero on a quiet pulse, one per moved department otherwise. */
  modelCalls: number;
  departments: NovaDepartment[];
  findings: SettledFinding[];
  capabilityGaps: CapabilityGap[];
  /** Senses that did not answer this pass, with their reasons. */
  senseFailures: string[];
  /**
   * EVERYTHING NOVA COULD NOT SEE — dark senses, load-bearing fields missing
   * inside a healthy read, and pages that came back truncated. A superset of
   * {@link PulseResult.senseFailures}, which only ever covered whole reads that
   * threw.
   */
  blindSpots: BlindSpot[];
  /** The blind spots this pass actually told the founder about. */
  blindSpotsReported: string[];
  /**
   * Set when the consolidated report could NOT be filed. The findings are then
   * left `announced: false`, so the next pulse raises them again instead of the
   * snapshot recording them as told.
   */
  reportFailed?: string;
  /** Inbox events marked processed by code (never by a model step). */
  eventsProcessed: number;
  /**
   * Events the drain could NOT mark, with the reason each. Not fatal (they are
   * re-read next hour) and no longer silent — see the drain block in
   * {@link runPulse}.
   */
  eventDrainFailures: string[];
  inboxCursor: string | null;
  snapshotWritten: boolean;
  /** Present only when findings survived — a quiet pulse files nothing. */
  reportId?: string;
}

/**
 * Run one pulse for one store.
 *
 * THE RUN PATH. `pulseWorkflow` below is the Studio surface over this function
 * and the dispatcher calls it directly, for the same reason the customer lane
 * has exactly one `runInstructedTurn`: a second copy of a run path drifts, and
 * the copy is always the one missing a guard.
 */
export async function runPulse(storeId: string, opts: PulseOptions = {}): Promise<PulseResult> {
  const client = opts.client ?? storeFor(storeId);
  const remedyFor = opts.remedyFor ?? productionRemedy;
  const decide = opts.decide ?? judgeWithModel;
  let modelCalls = 0;

  // ── SENSE (code, free) ───────────────────────────────────────────────────
  const sense = await senseStore(storeId, client);
  const dark = senseFailures(sense);
  // Everything Nova cannot see this pass, at whatever granularity it went dark:
  // a read that threw, a field that came back unknown inside a read that did
  // not, a page that stopped at the row cap.
  const blind = blindSpots(sense);

  // ── The inbox bookkeeping, as CODE — A QUEUE DRAIN, OUTSIDE THE GATE ─────
  //
  // Under eve this was model steps: one `mark_event_processed` tool call per
  // event, inside a paid turn. It decides nothing, so it is a loop.
  //
  // SAY WHAT IT IS: this write does NOT pass the authority gate, and it is the
  // only write in this lane that does not. That is defensible because of what
  // it touches — `NovaInbox.processedAt`, Nova's own read cursor over its own
  // queue. Nothing a founder or a customer can see moves; no money, no message,
  // no record of theirs is changed; there is no duty on the roster for "Nova
  // ticks off its own inbox", and inventing one would put a pause switch on the
  // founder's roster that stops Nova reading its own mail. It is bookkeeping in
  // the strict sense, not in the sense a verb claims when it wants a bypass.
  //
  // Failures do not fail the pulse (an unmarked event is re-read next hour,
  // which is free, and one stuck row must not stop the watchdog) — but they are
  // no longer INVISIBLE: they are counted, ride on the result, and are named in
  // the report body. A drain that has silently stopped draining is exactly the
  // sort of thing a swallowed catch hides for a month.
  const events = sense.inbox.ok ? sense.inbox.value : [];
  let eventsProcessed = 0;
  const drainFailures: string[] = [];
  let cursor: string | null = null;
  for (const event of events) {
    if (cursor === null || Date.parse(event.receivedAt) > Date.parse(cursor)) cursor = event.receivedAt;
    try {
      await client.markEventProcessed(event.id);
      eventsProcessed += 1;
    } catch (err) {
      drainFailures.push(`${event.id}: ${err instanceof Error ? err.message : String(err)}`);
      console.warn(`[pulse] could not mark event ${event.id} processed for ${storeId}:`, err);
    }
  }

  // ── A PULSE THAT COULD SEE NOTHING DID NOT HAPPEN ────────────────────────
  //
  // Some senses dark is a degrade and the pulse carries on (that is the whole
  // point of per-domain reads). ALL of them dark is not a quiet business, it is
  // a blind watchdog — and returning `quiet: true` there would complete the job
  // row, tell the founder's board the pulse ran, and write a snapshot of
  // nothing over the last good one. Throwing releases the row with the reason
  // on it, spends an attempt, and lets the watchdog bring it back.
  //
  // The count is asked of the sense list itself (`allSensesDark`), not written
  // down here: `dark.length === 5` was a hard-coded five, and a sixth sense
  // would have switched this guard off without touching this line.
  if (allSensesDark(sense)) {
    throw new Error(
      `pulse for ${storeId} could not read ANY sense this pass — ${dark.join("; ")}. A blind pulse is not a ` +
        `quiet one; refusing to complete the job or overwrite the last snapshot.`,
    );
  }

  // ── COMPARE (code, free) ─────────────────────────────────────────────────
  const prior = await loadPulseState(storeId);
  const comparison = comparePulse(sense, prior);
  // Blindness is compared the same way findings are: news when it appears, news
  // again once a day while it lasts, silent in between.
  const blindNews = blindSpotNews(blind, prior, sense.at);

  /** Write the snapshot with exactly what became of this pass's findings on it. */
  const store = (outcome: {
    announced?: ReadonlySet<string>;
    dismissed?: ReadonlySet<string>;
    blindAnnounced?: ReadonlySet<string>;
  }) =>
    writeSnapshot(
      storeId,
      nextSnapshot(sense, prior, comparison, cursor, {
        announced: outcome.announced,
        dismissed: outcome.dismissed,
        blindSpots: nextBlindSpots(blind, prior, sense.at, outcome.blindAnnounced ?? new Set()),
      }),
    );

  // ── STOP. Nothing crossed a threshold, and nothing new is dark. ──────────
  //
  // The snapshot is still written — that is what makes the NEXT pulse cheap
  // too — and nothing else happens. No report, no card, no model, no row.
  //
  // THE SECOND CLAUSE IS NOT DECORATION. Without it this branch was reachable
  // with four of the five senses down: no findings can be derived from reads
  // that never answered, so `comparison.quiet` was true and the pulse reported
  // a healthy business it had not looked at.
  if (comparison.quiet && blindNews.length === 0) {
    const snapshotWritten = await store({});
    return {
      storeId,
      at: sense.at,
      quiet: true,
      modelCalls: 0,
      departments: [],
      findings: [],
      capabilityGaps: [],
      senseFailures: dark,
      blindSpots: blind,
      blindSpotsReported: [],
      eventsProcessed,
      eventDrainFailures: drainFailures,
      inboxCursor: nextInboxCursor(cursor, prior),
      snapshotWritten,
    };
  }

  // ── DECIDE — one call per MOVED department, and only the moved ones ──────
  const settled: SettledFinding[] = [];
  const gaps: CapabilityGap[] = [];
  const departmentsWithFindings: NovaDepartment[] = [];
  const reads: BoundedJudgement[] = [];
  /** Findings the judge said were not worth waking the founder for — see below. */
  const dismissed = new Set<string>();

  for (const department of comparison.departments) {
    const findings = comparison.findings.filter((f) => f.department === department);
    const card = changeCard({
      department,
      findings,
      eventsSeen: events.length,
      senseDark: blind.map((b) => b.detail),
    });

    let raw: PulseJudgement;
    try {
      modelCalls += 1;
      raw = await decide({ storeId, department, findings, card });
    } catch (err) {
      // A DEAD MODEL MUST NOT LOSE A CRITICAL FINDING. The numbers were
      // measured by code and are already in hand; only the wording and the
      // "is this worth it" judgement are missing. Fall back to the
      // deterministic title and treat everything as worth waking — the
      // fail-open direction here is the safe one, because the alternative is a
      // silent watchdog.
      console.warn(`[pulse] judge failed for ${storeId}/${department} — falling back to the observation:`, err);
      raw = {
        worthWaking: true,
        headline: findings[0]?.title ?? `${department}: signals moved`,
        note: "Judgement unavailable this pass (the model call failed); the measurements above stand on their own.",
      };
    }

    // NOTHING THE MODEL WROTE REACHES A FOUNDER UNCHECKED. See
    // {@link boundJudgeText}: length, vocabulary, and every number against the
    // card it was judging.
    const judgement = boundJudgement(raw, { department, findings, card });
    if (judgement.rejections.length > 0) {
      console.warn(
        `[pulse] the judge's wording for ${storeId}/${department} was set aside — ` +
          `${judgement.rejections.join("; ")}; using the measurement instead.`,
      );
    }

    // A CRITICAL FINDING IS NOT SUPPRESSIBLE. The model may judge whether a
    // warning or an info line deserves the founder's attention; it may not
    // decide that a stock-out that lands before the reorder does is fine.
    //
    // AND A DROPPED DEPARTMENT IS NO LONGER FORGOTTEN. Its conditions are
    // recorded as DISMISSED, not as announced: nobody was told, so they cannot
    // be retired, and `DISMISSAL_QUIET_MS` later they are news again. What this
    // replaces marked them open — "the founder knows" — which silenced them for
    // the life of the subject, because only stock-out conditions are ever
    // critical and an open condition only returns by worsening 25%.
    const hasCritical = findings.some((f) => f.severity === "critical");
    if (!judgement.worthWaking && !hasCritical) {
      for (const finding of findings) dismissed.add(finding.key);
      continue;
    }

    reads.push(judgement);
    departmentsWithFindings.push(department);
    // ONE judgement, N findings — carried as what it is (see
    // {@link scopeJudgement}), so finding B's receipt and Decision card cannot
    // present the sentence the model wrote about finding A as its own.
    const scoped = scopeJudgement(judgement, department, findings.length);
    for (const finding of findings) {
      const outcome = await settleFinding(client, finding, sense, remedyFor, scoped, KIND);
      if (outcome.kind === "capability_gap") gaps.push(outcome.gap);
      settled.push({ finding, headline: judgement.headline, note: scoped.scopedNote, outcome });
    }
  }

  // Every department's findings were judged not worth waking, and nothing is
  // newly dark: silence, and no report.
  //
  // THE CONDITIONS ARE RECORDED AS DISMISSED, NOT AS ANNOUNCED. The snapshot
  // used to mark them open — meaning "the founder knows" — so a single
  // `worthWaking: false` retired a supplier delay, a revenue drop or a margin
  // finding permanently (only a 25% worsening can raise an open condition
  // again, and only stock-out conditions are ever critical). They are still
  // true, nobody has been told, and `DISMISSAL_QUIET_MS` from now they are news
  // again — sooner if they materially worsen.
  if (settled.length === 0 && blindNews.length === 0) {
    const snapshotWritten = await store({ dismissed });
    return {
      storeId,
      at: sense.at,
      quiet: true,
      modelCalls,
      departments: [],
      findings: [],
      capabilityGaps: [],
      senseFailures: dark,
      blindSpots: blind,
      blindSpotsReported: [],
      eventsProcessed,
      eventDrainFailures: drainFailures,
      inboxCursor: nextInboxCursor(cursor, prior),
      snapshotWritten,
    };
  }

  // ── RECORD — ONE consolidated report, never one per finding ──────────────
  //
  // Filed when findings survived OR when something Nova cannot see is news. The
  // second half is what makes blindness reportable at all: a store whose
  // catalogue read has been failing all week has no findings to report BECAUSE
  // of the failure, and that is the report.
  let reportId: string | undefined;
  let reportFailed: string | undefined;
  try {
    const report = await client.addReport({
      kind: "pulse",
      // DERIVED FROM THE FINDINGS, never from model prose. See {@link pulseTitle}.
      title: pulseTitle(settled, blindNews),
      body: pulseBody({ settled, reads, gaps, blindNews, blind, drainFailures, jobId: opts.jobId }),
      // A re-leased rerun re-files the SAME row rather than a duplicate
      // (dakio-api returns the original on a dedupeKey collision).
      dedupeKey: opts.dedupeKey ?? null,
    });
    reportId = report.id;
  } catch (err) {
    // ── A LOST REPORT LOSES NOTHING PERMANENTLY ────────────────────────────
    //
    // It used to: the failure was logged, the snapshot was written anyway, and
    // every condition in it was recorded as open. Probed, one 500 on /reports
    // erased six findings including two critical stock-outs — for good. The
    // work still stands (rows filed through the gate are on the ledger), so the
    // job is not failed; what changes is that nothing here is marked announced,
    // so the next pulse says it all again.
    reportFailed = err instanceof Error ? err.message : String(err);
    console.error(
      `[pulse] could not file the pulse report for ${storeId} — nothing is marked as told, so the next pulse ` +
        `will raise these findings again:`,
      err,
    );
  }

  // ── WHAT ACTUALLY REACHED THE FOUNDER ────────────────────────────────────
  //
  // The report is the main channel. When it fails, the only findings that still
  // reached a person are the ones that put a card on the founder's desk — the
  // gate's own artifacts, which are on the ledger whatever happened here.
  const announced = new Set<string>();
  for (const s of settled) {
    if (reportId || reachedTheDesk(s.outcome)) announced.add(s.finding.key);
  }
  const blindAnnounced = new Set<string>(reportId ? blindNews.map((b: BlindSpot) => b.key) : []);

  const snapshotWritten = await store({ announced, dismissed, blindAnnounced });
  return {
    storeId,
    at: sense.at,
    quiet: false,
    modelCalls,
    departments: departmentsWithFindings,
    findings: settled,
    capabilityGaps: gaps,
    senseFailures: dark,
    blindSpots: blind,
    blindSpotsReported: [...blindAnnounced],
    eventsProcessed,
    eventDrainFailures: drainFailures,
    inboxCursor: nextInboxCursor(cursor, prior),
    snapshotWritten,
    ...(reportId ? { reportId } : {}),
    ...(reportFailed ? { reportFailed } : {}),
  };
}

/** The cursor the snapshot will carry — forward-only, as `nextSnapshot` writes it. */
function nextInboxCursor(cursor: string | null, prior: { inboxCursor: string | null } | null): string | null {
  return cursor ?? prior?.inboxCursor ?? null;
}

/**
 * Did this outcome put something in front of the founder ON ITS OWN, without
 * the report?
 *
 * Only the gate's artifacts qualify: a Decision card on the desk (`prepared`,
 * including the authorized-but-unexecuted case) or a card an earlier pulse
 * already filed under the same key. A refused row and a capability gap are
 * ledger and report material — real records, but not something anyone is shown
 * — so they stay unannounced and come back next hour.
 */
function reachedTheDesk(outcome: FindingOutcome): boolean {
  return outcome.kind === "decision_filed" || outcome.kind === "no_executor" || outcome.kind === "replayed";
}

/**
 * Store the snapshot, and say whether it landed.
 *
 * A pulse whose memory did not persist will re-report everything it just
 * reported on the next tick. That is worth knowing about (it rides on the
 * result and, on the job path, on the report body) but it is NOT worth failing
 * the job over: the work that mattered already happened.
 */
async function writeSnapshot(storeId: string, snapshot: Parameters<typeof savePulseState>[1]): Promise<boolean> {
  try {
    await savePulseState(storeId, snapshot);
    return true;
  } catch (err) {
    console.error(
      `[pulse] snapshot NOT written for ${storeId} — the next pulse will re-report everything this one found:`,
      err,
    );
    return false;
  }
}

/**
 * Take one finding as far as this lane is allowed to take it.
 *
 * The order is the whole safety argument:
 *   1. no remedy verb ⇒ the report is the response;
 *   2. no duty on the roster GOVERNS the remedy's verb ⇒ surface it. The verb
 *      is shipped and nothing on the founder's roster claims it, so there is
 *      no duty to perform it under and none may be borrowed;
 *   3. the remedy's duty is not in THIS LANE's registry entry ⇒ surface it and
 *      stop. Not a soft warning — the gate is never even consulted, because
 *      consulting it would mean this lane had decided it might act. (The GATE
 *      enforces both bounds too, and throws; these two checks exist so the
 *      lane answers with a founder-readable gap rather than a stack trace for
 *      the conditions it can see coming.)
 *   4. only then the gate, which is the front office's `gateOrFile` →
 *      `evaluateAuthority`. There is exactly one authority gate in this repo
 *      and this lane uses it rather than growing a second opinion.
 *
 * Exported for the suite: every production remedy stops at step 2 or 3, so the
 * only way to exercise steps 4+ is to drive this function AS a lane that holds
 * an acting duty — which is exactly the day-one-of-the-duty-moving rehearsal
 * the act path is built for. `runPulse` always passes its own {@link KIND}.
 */
export async function settleFinding(
  client: StoreClient,
  finding: PulseFinding,
  sense: StoreSense,
  remedyFor: RemedyFn,
  judgement: DepartmentJudgement,
  /** Whose duty set bounds this act. Production: the pulse's own lane. */
  lane: JobKind = KIND,
): Promise<FindingOutcome> {
  const remedy = remedyFor(finding, sense);
  if (!remedy) return { kind: "reported" };

  // 2. A verb the roster does not describe. `null` is not "unchecked" — it is
  //    the remedy table stating that `VERB_DUTIES` has no key for this verb.
  if (remedy.dutyKey === null) {
    return {
      kind: "capability_gap",
      gap: {
        findingKey: finding.key,
        verb: remedy.type,
        kind: "ungoverned_verb",
        wantedDuty: null,
        reason:
          `The pulse sensed this, and \`${remedy.type}\` would fix it — but NO duty on Nova's roster ` +
          `governs \`${remedy.type}\`, so there is nothing to perform it under. ` +
          `${UNGOVERNED_VERBS[remedy.type] ?? ""} Reported instead.`,
      },
    };
  }

  // 3. A governing duty, held by somebody else.
  const duties = laneFor(lane)?.duties ?? [];
  if (!duties.includes(remedy.dutyKey)) {
    return {
      kind: "capability_gap",
      gap: {
        findingKey: finding.key,
        verb: remedy.type,
        kind: "out_of_lane",
        wantedDuty: remedy.dutyKey,
        reason:
          `The pulse sensed this, but "${remedy.dutyKey}" is not one of its lane's duties ` +
          `[${duties.join(", ")}], so it may not act on it. Reported instead.`,
      },
    };
  }

  const receipt: GateReceiptInput = {
    // THE OBSERVATION IS THE REASON. Every row this lane files can be traced to
    // a number it read this hour, and nothing else can end up here.
    reason: finding.observation.evidence,
    // THE NOTE IS THE DEPARTMENT'S, NOT THIS FINDING'S. One judgement is bought
    // per moved department, so when a department moved on three findings the
    // model wrote one sentence about all three — and this line is what becomes
    // the Decision card's impact label. Attaching it bare would put the note
    // the model wrote about finding A on finding B's card. Where the department
    // had exactly one finding the note IS about it; otherwise it is labelled as
    // what it is.
    expectedImpact: judgement.scopedNote,
    // See {@link PULSE_RECEIPT_CONFIDENCE} — one constant, and an evidence row
    // that says what it is, instead of 0.9/0.7 rendered as a measurement.
    confidence: PULSE_RECEIPT_CONFIDENCE,
    evidence: [
      {
        source: `pulse:${finding.domain}`,
        note: finding.observation.evidence,
        metric: finding.observation.metric,
        value: finding.observation.value ?? "n/a",
      },
      {
        source: "pulse:delta",
        note: `${finding.trigger} since the last pulse`,
        metric: "priorValue",
        value: finding.observation.priorValue ?? "first sighting",
      },
      {
        // The receipt's `confidence` field wants a number and the pulse has no
        // honest one to put there: it estimates nothing. It used to write 0.9
        // for critical findings and 0.7 otherwise — a severity re-badged as a
        // probability, sitting on a Decision card next to real measurements.
        // One constant, and this line so nobody reads it as a forecast.
        source: "pulse:confidence",
        note:
          "Not a probability. The pulse does not estimate one — this row exists because a measured number " +
          "crossed a fixed threshold, and the confidence field is a constant.",
        metric: "confidence",
        value: PULSE_RECEIPT_CONFIDENCE,
      },
      {
        source: "pulse:judgement",
        note: judgement.note,
        metric: "scope",
        value: judgement.findingCount === 1
          ? `${finding.department}: this finding`
          : `${finding.department}: all ${judgement.findingCount} findings this pass`,
      },
    ],
  };

  const spec: GateSpec = {
    verb: remedy.type,
    department: remedy.department,
    dutyRef: remedy.dutyKey,
    // The lane, so the seam can enforce the registry's capability bound itself
    // rather than trusting the check above to have been written.
    lane,
    // Recorded (as `origin` receipt evidence on the filed row), never trusted
    // for permission — a job-driven action does not file itself as a chat one.
    origin: "job",
    door: doorFor(remedy.department),
    title: remedy.title,
    paramsLine: remedy.paramsLine,
    payload: { ...remedy.payload, novaActionId: novaActionIdFor(finding, sense.at) },
    receipt,
    preparedDetail: (delivered) =>
      delivered
        ? "Nova prepared this and put it on your desk."
        : "Nova prepared this, but the card did not reach your desk — it is on the action ledger.",
  };

  const step = await gateOrFile(client, spec);

  if (!step.proceed) {
    const o = step.outcome;
    if (o.status === "prepared") return { kind: "decision_filed", actionId: o.actionId, rule: o.rule };
    if (o.status === "blocked") return { kind: "refused", actionId: o.actionId, rule: o.rule };
    return { kind: "replayed", actionId: o.actionId };
  }

  // ── The gate says Nova may do this alone — and this lane cannot ──────────
  //
  // Founder-plane verbs have no executor on this side: dakio-api owns them (see
  // `executePreparedAction` — "the backend owns executors for advisory verbs and
  // its own doors"), and the front office's five executors are all
  // conversation-scoped. Writing one here would be a second write path outside
  // the gate's own verbs, which is precisely what this lane must not grow.
  //
  // WHAT THIS BRANCH MUST NOT DO is drop the gate's work on the floor. It used
  // to: no row, so nothing on the ledger recorded that Nova was authorized and
  // did not act, and `step.settle` / `step.rowEvidence` / the masked title and
  // params line — the replay protocol the five customer verbs are built around
  // — were discarded at exactly the seam a future author is invited to fill.
  // `fileAuthorizedUnexecuted` files the fact through that protocol, so the
  // founder can do in one tap what Nova was allowed to do and could not, and so
  // whoever gives the verb an executor inherits a safe seam.
  const outcome = await fileAuthorizedUnexecuted(
    client,
    spec,
    step,
    `Nova was allowed to do this on its own (${step.authority.rule}), but the ${lane} lane has no executor ` +
      `for \`${remedy.type}\` — nothing ran, so it is on your desk instead.`,
  );
  console.warn(
    `[pulse] authority allows ${remedy.type} for ${finding.key}, but the ${lane} lane has no executor for it — ` +
      `nothing ran; filed as ${outcome.actionId}. Give the verb an executor, or move the duty to a lane that has one.`,
  );
  return { kind: "no_executor", verb: remedy.type, actionId: outcome.actionId };
}

/**
 * The at-most-once key for a filed action: the CONDITION, plus the day it was
 * raised on.
 *
 * ── WHY IT IS NOT THE CONDITION ALONE ──────────────────────────────────────
 *
 * It was, and the comment recorded only the benign half ("two pulses that both
 * decide to act on the same crossed condition file one row, not two"). The
 * other half: `findByKey` matches at ANY status and `settleOwningRow` answers a
 * spent key from the row that owns it — FOREVER. So one founder tapping Reject
 * on one clearance card made that condition permanently unfileable for that
 * product's life; every later pulse, including one raised because the condition
 * had materially worsened, answered `replay:rejected`. The chat lane's key at
 * least carries a per-conversation counter; this one had nothing to advance.
 *
 * ── WHY A DAY, AND NOT THE SIGHTING ────────────────────────────────────────
 *
 * The sighting time would advance on every pulse, which loses the protection
 * that matters: a pulse that files its row and then dies before writing its
 * snapshot is re-leased, re-senses the same condition as a first sighting, and
 * must not file a second purchase order. Same day ⇒ same key ⇒ it replays.
 * A day later, a condition that is news again (it re-crossed, or it materially
 * worsened) gets a key nobody has spent. That is at most one card per condition
 * per day even in the worst case, and in practice far fewer: an open condition
 * that has not moved produces no finding at all, so it never reaches this
 * function.
 *
 * The clock is the STORE's (`sense.at`), not this process's — a pulse and the
 * ledger it writes to must agree about what day it is.
 */
function novaActionIdFor(finding: PulseFinding, at: string): string {
  return `nm:pulse:${finding.key}:${at.slice(0, 10)}`;
}

// ---------------------------------------------------------------------------
// The report — one, consolidated, only when something survived
// ---------------------------------------------------------------------------

/** The report title's own length bound — a headline, not a paragraph. */
const TITLE_MAX_CHARS = 120;

/**
 * THE ONE LINE THE FOUNDER READS FIRST — derived from the findings, never
 * written by the model.
 *
 * ── WHAT THIS REPLACES ─────────────────────────────────────────────────────
 *
 * `settled[0].headline`: an unvalidated model string, prefixed with a `⚠` that
 * was computed from a severity across ALL departments. Two defects in one line.
 * Probed live, it titled a report *"⚠ Sales are down because your courier is
 * losing parcels and ad spend is wasted"* — in a report whose own footer says
 * Nova makes no claim about courier or ads. A model cannot be bounded into
 * never doing that; the title simply must not be a place model prose can reach.
 * (What the judge writes is still used, bounded, further down the body.)
 *
 * Every part of what comes out of here traces to a measurement: the lead is one
 * finding's own code-generated title, the `⚠` and the count are arithmetic over
 * the findings that carry it, and a blind pass says it is blind rather than
 * borrowing a headline from findings it does not have.
 */
export function pulseTitle(settled: SettledFinding[], blindNews: BlindSpot[] = []): string {
  if (settled.length === 0) {
    // A report with no findings exists for exactly one reason.
    return blindNews.length === 1
      ? `Nova could not see part of your store this pass`
      : `Nova could not see ${blindNews.length} parts of your store this pass`;
  }
  const criticals = settled.filter((s) => s.finding.severity === "critical");
  // The `⚠` and the lead now come from the SAME finding, so the badge cannot
  // belong to one department while the sentence belongs to another.
  const lead = (criticals[0] ?? settled[0])!.finding.title;
  const others = settled.length - 1;
  const tail = others > 0 ? ` (+${others} more finding${others === 1 ? "" : "s"})` : "";
  const head = criticals.length > 0 ? `⚠ ${lead}` : lead;
  const full = `${head}${tail}`;
  if (full.length <= TITLE_MAX_CHARS) return full;
  return `${full.slice(0, TITLE_MAX_CHARS - 1).trimEnd()}…`;
}

function pulseBody(input: {
  settled: SettledFinding[];
  reads: BoundedJudgement[];
  gaps: CapabilityGap[];
  blindNews: BlindSpot[];
  blind: BlindSpot[];
  drainFailures: string[];
  jobId?: string;
}): string {
  const { settled, reads, gaps, blindNews, blind, drainFailures, jobId } = input;
  const lines: string[] = [];
  for (const s of settled) {
    lines.push(
      `**${s.finding.title}**`,
      `- ${s.finding.observation.evidence}`,
      `- ${outcomeLine(s.outcome)}`,
      "",
    );
  }
  // Nova's own wording, after the check, and labelled as wording — the numbers
  // above are the measurement and this is a read of them.
  if (reads.length > 0) {
    lines.push(
      "**Nova's read**",
      ...reads.map((r) => `- ${r.department}: ${r.headline} — ${r.note}`),
      "",
    );
    const setAside = reads.filter((r) => r.rejections.length > 0);
    if (setAside.length > 0) {
      lines.push(
        ...setAside.map(
          (r) =>
            `_Nova's own wording for ${r.department} was set aside this pass (${r.rejections.join("; ")}) — ` +
            `the measurements above are unchanged._`,
        ),
        "",
      );
    }
  }
  if (gaps.length > 0) {
    lines.push(
      "**What Nova could not do about it**",
      // The two gap kinds read differently on purpose: one needs a lane to hold
      // a duty that exists, the other needs the roster to grow a duty at all.
      ...gaps.map((g) =>
        g.wantedDuty === null
          ? `- \`${g.verb}\` would fix it, and NO duty on your Nova roster covers \`${g.verb}\` — so there is ` +
            `nothing to switch on. Nova will not perform a verb you were never promised.`
          : `- \`${g.verb}\` needs the duty \`${g.wantedDuty}\`, which the pulse does not hold.`,
      ),
      "",
    );
  }
  // WHAT NOVA COULD NOT SEE. `blindNews` is what is being REPORTED this pass
  // (new, or dark long enough to say again); `blind` is everything still dark,
  // so a founder reading one report sees the whole shape of the gap and not
  // only this hour's edge.
  if (blindNews.length > 0) {
    lines.push(
      "**Nova could not see this**",
      ...blindNews.map((b) => `- ${b.detail}`),
      "",
      "_Silence about anything above is not good news — it is Nova having nothing to look at._",
      "",
    );
  }
  const stillDark = blind.filter((b) => !blindNews.some((n) => n.key === b.key));
  if (stillDark.length > 0) {
    lines.push(
      "**Still dark, reported earlier**",
      ...stillDark.map((b) => `- ${b.detail}`),
      "",
    );
  }
  if (drainFailures.length > 0) {
    // The inbox drain is the one write in this lane that does not pass the
    // gate, so when it fails the founder is told rather than a log line being
    // the only witness.
    lines.push(
      `**Inbox queue**: ${drainFailures.length} event(s) could not be marked as seen — Nova will re-read them ` +
        `next pass.`,
      ...drainFailures.map((f) => `- ${f}`),
      "",
    );
  }
  // ── THE ON-TIME FOOTNOTE, said where a courier claim is actually made ────
  //
  // Courier is sensed now, so it is not in the "Not checked" line below — but
  // ONE thing inside it can never be measured: Dakio's schema records no
  // promised-delivery date anywhere, so "was this courier late?" has no answer
  // at all. A founder reading "5.4 days to deliver" with nothing beside it may
  // reasonably hear "and that is within the promise", which is a sentence
  // nobody is entitled to.
  //
  // It is a footnote and not a blind spot on purpose (see `blindSpots` in
  // snapshot.ts): a blind spot re-announces daily forever and blocks a quiet
  // pulse, and this fact will be equally true tomorrow and next year. So it
  // appears exactly when the report carries a courier finding, which is exactly
  // when it could mislead.
  if (settled.some((s) => s.finding.domain === "courier")) {
    lines.push(
      "_On-time delivery is not measured anywhere above: the store records no promised-delivery date, so Nova " +
        "reports how long parcels took, never whether they were late._",
      "",
    );
  }
  // Stated on every pulse report, because a founder reading "nothing wrong with
  // your ads" into a Nova report that never looked at ads is the exact failure
  // the sense layer's gap list exists to prevent.
  lines.push(
    "_Not checked: " +
      SENSE_GAPS.map((g) => g.domain).join(", ") +
      " — no data source today, so Nova makes no claim about them._",
  );
  if (jobId) lines.push(`_Pulse job ${jobId}._`);
  return lines.join("\n");
}

function outcomeLine(outcome: FindingOutcome): string {
  switch (outcome.kind) {
    case "reported":
      return "Reported. There is no action Nova can take on this one.";
    case "capability_gap":
      return outcome.gap.wantedDuty === null
        ? `Not acted on: no duty on your roster covers \`${outcome.gap.verb}\`, so Nova has nothing to do it under.`
        : `Not acted on: needs the duty \`${outcome.gap.wantedDuty}\`, which this lane does not hold.`;
    case "decision_filed":
      return `Prepared for your approval (${outcome.rule}).`;
    case "refused":
      return `Nova was not allowed to do this (${outcome.rule}).`;
    case "replayed":
      return "Already filed under this key by an earlier pulse.";
    case "no_executor":
      return (
        `Allowed, but nothing ran — no executor for \`${outcome.verb}\` on this lane. Prepared on your desk ` +
        `instead (${outcome.actionId}).`
      );
  }
}

// ---------------------------------------------------------------------------
// The Studio surface
// ---------------------------------------------------------------------------

const pulseStep = createStep({
  id: "pulse",
  inputSchema: z.object({
    storeId: z.string().optional().describe("Tenant id; defaults to NOVA_DEV_STORE_ID"),
  }),
  outputSchema: z.object({
    quiet: z.boolean(),
    modelCalls: z.number().describe("0 on a quiet pulse — the whole point of the lane"),
    departments: z.array(z.string()),
    findings: z.array(z.object({ key: z.string(), title: z.string(), outcome: z.string() })),
    capabilityGaps: z.array(
      z.object({
        verb: z.string(),
        kind: z.string().describe("out_of_lane | ungoverned_verb — a registry fix or a roster fix"),
        wantedDuty: z.string().nullable().describe("null = no duty on the roster governs the verb"),
      }),
    ),
    senseFailures: z.array(z.string()),
    blindSpots: z
      .array(z.object({ key: z.string(), detail: z.string() }))
      .describe("Everything Nova could not see — dark reads, dark fields, truncated pages"),
    blindSpotsReported: z.array(z.string()),
    eventsProcessed: z.number(),
    eventDrainFailures: z.array(z.string()),
    snapshotWritten: z.boolean(),
    reportId: z.string().optional(),
    reportFailed: z.string().optional().describe("Set when the report could not be filed — nothing was marked told"),
  }),
  execute: async ({ inputData }) => {
    const storeId = inputData.storeId || process.env.NOVA_DEV_STORE_ID;
    if (!storeId) throw new Error("storeId required (or set NOVA_DEV_STORE_ID)");
    const result = await runPulse(storeId);
    return {
      quiet: result.quiet,
      modelCalls: result.modelCalls,
      departments: result.departments,
      findings: result.findings.map((f) => ({
        key: f.finding.key,
        title: f.finding.title,
        outcome: f.outcome.kind,
      })),
      capabilityGaps: result.capabilityGaps.map((g) => ({ verb: g.verb, kind: g.kind, wantedDuty: g.wantedDuty })),
      senseFailures: result.senseFailures,
      blindSpots: result.blindSpots,
      blindSpotsReported: result.blindSpotsReported,
      eventsProcessed: result.eventsProcessed,
      eventDrainFailures: result.eventDrainFailures,
      snapshotWritten: result.snapshotWritten,
      ...(result.reportId ? { reportId: result.reportId } : {}),
      ...(result.reportFailed ? { reportFailed: result.reportFailed } : {}),
    };
  },
});

/**
 * The pulse as a Mastra workflow: the id `registry.ts` names on the lane, and
 * the surface a founder-facing operator (or Studio) can run one pulse from.
 *
 * NO SCHEDULE. The brain has exactly one clock — the dispatcher's minute tick —
 * and the pulse's cadence is DATA: a founder-editable `nova_job_defs` row in
 * dakio-api, in the tenant's own timezone. A cron here would be a second copy
 * of that cadence, in UTC, that no founder can see or change.
 */
export const pulseWorkflow = createWorkflow({
  id: "brain-pulse",
  description:
    "The hourly watchdog: sense the store (code) → compare against the last pulse (code) → wake a small model only for the departments that moved → act through the authority gate or file a Decision. A quiet pulse costs zero model calls.",
  inputSchema: pulseStep.inputSchema,
  outputSchema: pulseStep.outputSchema,
})
  .then(pulseStep)
  .commit();
