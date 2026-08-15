/**
 * COMPARE — the step that makes a quiet hour free.
 *
 * Pure: sensed observation in, findings out. No I/O, no clock beyond the
 * observation's own `at`, no model. Everything expensive downstream is gated
 * on this function returning nothing.
 *
 * ── FINDINGS ARE EDGE-TRIGGERED, AND THAT IS THE WHOLE DESIGN ──────────────
 *
 * nova-ai's `detectAnomalies` is a LEVEL detector: it re-derives every
 * currently-true condition from scratch on every call. Under a 13×/day pulse
 * that means the same stock-out risk is "found" thirteen times a day, every day
 * it stays true — and each finding cost a full agent turn. The prompt's own
 * instruction ("if there are no critical findings, stop — never spam the
 * owner") was the only thing standing between the founder and a daily drip of
 * the same alert.
 *
 * Here a condition is news exactly three times:
 *   1. when it CROSSES — it was not true at the last pulse and it is now
 *      (a store with no stored snapshot at all is a first sighting: every true
 *      condition crosses, once, and then goes quiet);
 *   2. when it materially WORSENS — the metric behind an already-open condition
 *      moved by at least {@link MATERIAL_CHANGE_PCT} in the bad direction.
 *      "12 days of cover became 3" is a different fact from "12 days of cover
 *      is still 11".
 *   3. when it is still true and was NEVER REPORTED (`unreported`). See below —
 *      this is the third case, and it exists because the first two silently
 *      assumed that deriving a condition and telling the founder about it were
 *      the same event.
 *
 * A condition that CLOSES is deliberately NOT a finding. Silence is the
 * designed success of this lane, and "the thing I warned you about is fine now"
 * is the most tempting kind of spam there is. It leaves the open set, and the
 * next time it crosses it is news again.
 *
 * ── OPEN MEANS "THE FOUNDER KNOWS", NOT "WE WORKED IT OUT" ─────────────────
 *
 * Every derived condition used to be written into `open` before any judging or
 * filing happened, which quietly made two very different things equal. Probed:
 * a single `worthWaking: false` dropped a department's findings and marked them
 * open forever (they can only return by worsening 25%, and only stock-out
 * conditions are ever critical — so every revenue drop, supplier delay, margin
 * and cart finding was suppressible once and for good); and one 500 on
 * `POST /reports` erased six findings including two critical stock-outs while
 * the snapshot recorded all of them as told.
 *
 * `OpenCondition.announced` is the fix, and `pulse.ts` sets it from what
 * reached the founder — a filed report, or a Decision card on their desk. The
 * zero-model-call property survives intact: a condition that DID reach them
 * stays quiet until it worsens, exactly as before. Only the ones nobody was
 * told about come back.
 *
 * The two ways of not being told are not the same event, and
 * {@link DISMISSAL_QUIET_MS} is where they part company: a LOST REPORT decided
 * nothing, so the next pulse says it again immediately; a DISMISSAL is Nova
 * having answered the question it was asked ("worth waking them RIGHT NOW?"),
 * so it holds for a day and then the condition is news again. Neither is
 * forever, which is the only property the old code got wrong.
 *
 * ── A DOMAIN THAT DID NOT ANSWER PRODUCES NOTHING, AND FORGETS NOTHING ─────
 *
 * An unreadable sense produces no findings (see {@link comparePulse}) AND its
 * prior state is carried forward into the next snapshot by
 * {@link nextSnapshot}. Both halves matter: without the first, a failed read
 * would read as "all conditions cleared"; without the second, the pulse after
 * a blip would see every condition as a first sighting and alert on all of
 * them at once.
 *
 * THE SAME RULE NOW HOLDS ONE LEVEL DOWN. A read that SUCCEEDS but comes back
 * without the field a condition is built on is just as unable to re-derive it:
 * a product page with no velocity closed every open critical stock-out
 * condition, and the re-crossing announced itself as *"(first sighting)"* about
 * something that had been true the whole time. {@link undeterminableKeys} names
 * those conditions and they are carried forward with the dark domains.
 */

import type { NovaDepartment } from "../store/types.js";
import { LIST_PAGE_CAP } from "../lib/snapshot.js";
import type { BlindSpot, CourierSignal, ProductSignal, StoreSense } from "../lib/snapshot.js";
import type { BlindSpotState, OpenCondition, PulseSnapshot, ProductState } from "./pulse-state.js";

/** The domains the sense layer actually reads. Nothing else may appear. */
export type PulseDomain = "inventory" | "sales" | "carts" | "margin" | "supplier" | "courier";

/**
 * The thresholds, in one place because they are product decisions, not
 * implementation details. The first four are nova-ai's, kept byte-for-byte so
 * a founder who has used both does not meet a differently-tuned Nova.
 */
export const PULSE_THRESHOLDS = {
  /** Margin floor for the thin-margin scan — independent of owner guardrails. */
  thinMarginPct: 25,
  /** Average daily sales below this, with stock piled up, is dead stock. */
  deadStockVelocity: 0.15,
  /** Dead stock also needs this much overhang above the reorder point. */
  deadStockOverhangMultiple: 3,
  /** Week-over-week revenue change at or below this is a drop worth naming. */
  revenueDropPct: -15,
  /**
   * How much an ALREADY-OPEN condition's metric must move, in the bad
   * direction, to be news again. 25% is the "this is a different fact now"
   * line: it survives ordinary hourly jitter (a couple of units sold) and
   * fires on the moves a founder would want interrupted for.
   */
  materialChangePct: 25,

  // ── Courier (the sixth sense) ─────────────────────────────────────────────
  //
  // These three are Nova's product decisions, not dakio-api's. What is NOT a
  // decision here is the base every one of them is judged over: the route
  // computes rates across RESOLVED parcels only and ships `sufficientEvidence`
  // (resolved ≥ 25) beside them, and `courierConditions` refuses to build any
  // rate finding without it. A threshold is a line drawn on a measurement; it
  // cannot create the measurement.

  /**
   * RTO share of resolved parcels that is worth a founder's attention.
   *
   * 20% is high on purpose. Bangladeshi COD commerce lives with double-digit
   * RTO as a normal cost of doing business — the merchant screens themselves
   * call 10-15% ordinary — so a threshold tuned to a card-payment market would
   * fire on every store, every window, and teach the founder to skip the
   * courier section. One in five parcels coming back is the level at which the
   * courier, not the market, is the story.
   */
  courierRtoRatePct: 20,
  /**
   * Mean dispatch→delivery days at which a courier is SLOW, not merely slower.
   *
   * Dhaka-inside next-day and nationwide 2-3 days is what the three providers
   * sell; five days average is a different service than the one the customer
   * was told about when they ordered. This is NOT an on-time measure and must
   * never be worded as one — there is no promised date to miss.
   */
  courierSlowDeliveryDays: 5,
  /**
   * The smallest delivery-time sample Nova will state a mean over.
   *
   * `sufficientEvidence` is about RESOLVED parcels, and a courier can clear it
   * while only a handful of its parcels carry both a dispatch and a delivery
   * stamp (a hand-marked delivery contributes to `delivered` and to no
   * duration). A mean over three parcels is an anecdote wearing a decimal
   * point, so the sample carries its own floor and its size is always in the
   * evidence line.
   */
  courierDeliverySample: 10,
  /**
   * How many in-flight parcels must be stagnant before it is a finding.
   *
   * Each one is already established fact — the scorecard uses `novaJourney`'s
   * OWN stagnation thresholds, so these are parcels the journey has raised to
   * `at_risk` — which is why this floor is a spam guard and not an evidence
   * gate. One stuck parcel is the courier lane's business; three at one courier
   * is a pattern the founder should hear about once.
   */
  courierStagnantParcels: 3,
} as const;

/**
 * How long a blind spot may stay dark before Nova says so AGAIN.
 *
 * Blindness is edge-triggered like everything else, or a week-long outage
 * becomes an hourly alarm. But pure edge-triggering is how "four of five senses
 * are dark" turned into a healthy-looking `quiet: true` after the first pass,
 * so a blind spot that is still dark a day later is news again.
 */
export const BLIND_REANNOUNCE_MS = 24 * 60 * 60 * 1000;

/**
 * How long a judge's "not worth waking them for this" holds.
 *
 * The two unreported outcomes are not the same event. A LOST REPORT decided
 * nothing, so the next pulse says it all again. A DISMISSAL is Nova having
 * looked at the finding and answered the question it was asked — "is this worth
 * the founder's attention RIGHT NOW" — and the honest re-ask is tomorrow, not
 * in an hour with the identical card and a predictable identical answer.
 *
 * The bound that matters is that it EXPIRES. What this replaces marked the
 * condition open forever: since only stock-out conditions are ever critical,
 * one dismissive call retired a supplier delay, a revenue drop, a thin margin
 * or a cart pile-up for the life of the subject, recoverable only by a 25%
 * worsening. A worsening still cuts through this window immediately.
 */
export const DISMISSAL_QUIET_MS = 24 * 60 * 60 * 1000;

export const MATERIAL_CHANGE_PCT = PULSE_THRESHOLDS.materialChangePct;

/**
 * One thing the pulse noticed.
 *
 * `observation` is not decoration: NO FINDING MAY EXIST WITHOUT ONE. It names
 * the sensed metric, its value, and the prior value it was compared against, so
 * every line in a pulse report can be traced back to a number this pulse read
 * from the store — and so a finding can never be inferred from a domain the
 * sense layer does not read (there is nothing to fill this in with).
 */
export interface PulseFinding {
  /** Stable identity of the CONDITION, not of this sighting. */
  key: string;
  domain: PulseDomain;
  department: NovaDepartment;
  severity: "critical" | "warning" | "info";
  /** Which subject moved (product id, supplier id, or the domain itself). */
  subject: string;
  title: string;
  observation: {
    metric: string;
    value: number | null;
    /** The same metric, last time it was MEASURED. `null` = first sighting. */
    priorValue: number | null;
    /**
     * When that prior value was measured. Not necessarily the last pulse: a
     * value survives passes whose domain went dark, and "was 12 at the last
     * pulse" about a pulse that never read the number is a small, confident
     * lie. `null` alongside a `null` priorValue.
     */
    priorMeasuredAt: string | null;
    /** One line a founder can check against their own dashboard. */
    evidence: string;
  };
  /**
   * `crossed` = newly true. `worsened` = open, and materially worse.
   * `unreported` = open, unchanged, and the founder was never actually told
   * (a dropped judgement or a lost report — see the file header).
   */
  trigger: "crossed" | "worsened" | "unreported";
}

/** What COMPARE decided. `quiet` is the success case, and it is the common one. */
export interface PulseComparison {
  findings: PulseFinding[];
  /**
   * Conditions currently true, for the next snapshot's `openFindings` — with
   * `announced` carried from the prior snapshot, NOT set from the fact that
   * this pass derived them. `pulse.ts` marks the ones that reached the founder.
   */
  open: Record<string, OpenCondition>;
  /** Departments with at least one finding — the only ones DECIDE may wake. */
  departments: NovaDepartment[];
  quiet: boolean;
}

/** A prior measurement, and when it was actually taken. */
export interface PriorObservation {
  value: number | null;
  at: string;
}

/** Internal shape: a condition that is TRUE right now. */
interface Condition {
  key: string;
  domain: PulseDomain;
  department: NovaDepartment;
  severity: PulseFinding["severity"];
  subject: string;
  title: string;
  metric: string;
  value: number | null;
  /** Which way is worse — decides whether a move is news or relief. */
  worseWhen: "lower" | "higher";
  evidence: (prior: PriorObservation | null) => string;
}

const round = (n: number, dp = 2): number => Math.round(n * 10 ** dp) / 10 ** dp;
const money = (n: number): string => `৳${Math.round(n).toLocaleString("en-IN")}`;

/**
 * How a finding refers to the number it is being compared against.
 *
 * "(was 12 days at the last pulse)" was written whatever the prior value's age,
 * and prior values are deliberately carried across dark passes — so the line
 * could name a pulse that never observed it. The measurement's own date is
 * named instead: always true, and it tells the founder when the comparison
 * actually starts from.
 */
function sinceLine(prior: PriorObservation | null, render: (value: number) => string): string {
  if (prior === null || prior.value === null) return " (first sighting)";
  return ` (was ${render(prior.value)}, measured ${prior.at.slice(0, 10)})`;
}

/**
 * Did an open condition's metric move enough, in the bad direction, to be news?
 *
 * Both nulls are handled explicitly rather than coerced: a metric that was
 * unknown and is now known has no percentage to compute, and a metric that has
 * become unknown is not a worsening — it is a gap.
 */
function materiallyWorse(condition: Condition, prior: number | null): boolean {
  if (prior === null || condition.value === null) return false;
  const delta = condition.value - prior;
  const worse = condition.worseWhen === "lower" ? -delta : delta;
  if (worse <= 0) return false;
  const base = Math.abs(prior);
  // A metric that was ZERO and moved at all is a 0→n crossing in everything but
  // name; treat any move away from zero as material rather than dividing by it.
  if (base === 0) return true;
  return (worse / base) * 100 >= PULSE_THRESHOLDS.materialChangePct;
}

// ---------------------------------------------------------------------------
// The conditions, one function per honest domain
// ---------------------------------------------------------------------------

/**
 * Inventory — days of cover against the supplier's REAL wait, and dead stock.
 *
 * The cover rule needs three things the sense layer may or may not have: a
 * velocity above the near-zero floor (below it, "days of cover" is not a
 * number), and a lead time (supplier + offer). Missing either means NO FINDING
 * for that product — not a guessed lead time. nova-ai made the same call, and
 * it is the difference between "will stock out before a reorder lands" and
 * "has less stock than a number we made up".
 */
function inventoryConditions(products: ProductSignal[]): Condition[] {
  const out: Condition[] = [];
  for (const p of products) {
    if (p.daysOfCover !== null && p.leadTimeDays !== null && p.daysOfCover < p.leadTimeDays) {
      out.push({
        key: `inventory:cover:${p.id}`,
        domain: "inventory",
        department: "inventory",
        severity: "critical",
        subject: p.id,
        title: `${p.name} will stock out before a reorder can arrive`,
        metric: "daysOfCover",
        value: round(p.daysOfCover),
        worseWhen: "lower",
        evidence: (prior) =>
          `${p.stock} units left selling ~${round(p.velocity ?? 0)}/day (${weekWindow(p)}) = ` +
          `${Math.floor(p.daysOfCover!)} days of cover, ` +
          `against a ${p.leadTimeDays}-day wait from ${p.supplierName ?? p.supplierId}` +
          sinceLine(prior, (v) => `${round(v)} days`),
      });
    }
    // DEAD STOCK NEEDS BOTH INPUTS TO BE REAL. A live dakio tenant answers
    // `weeklyVelocity: []` and `reorderPoint: 0` (documented gaps in
    // novaStore.js), and reading those as "sells nothing" and "reorder at zero"
    // would declare the ENTIRE catalogue dead stock, confidently, every hour.
    // Unknown is not a measurement.
    // The CASH figure needs a cost, and a cost of `null` is unknown — see
    // `costOf` in snapshot.ts. Reading dakio-api's `num(null) = 0` as a
    // measurement would price every uncosted overhang at ৳0 tied up, which is
    // both wrong and reassuring.
    if (
      p.velocity !== null &&
      p.cost !== null &&
      p.reorderPoint > 0 &&
      p.stock > PULSE_THRESHOLDS.deadStockOverhangMultiple * p.reorderPoint &&
      p.velocity < PULSE_THRESHOLDS.deadStockVelocity
    ) {
      const tiedUp = p.stock * p.cost;
      out.push({
        key: `inventory:dead:${p.id}`,
        domain: "inventory",
        department: "inventory",
        severity: "info",
        subject: p.id,
        title: `${p.name} looks like dead stock`,
        // The metric is the CASH, not the unit count: 80 units of a ৳7,799
        // vase and 80 units of a ৳120 candle are not the same problem.
        metric: "tiedUpCash",
        value: round(tiedUp),
        worseWhen: "higher",
        evidence: (prior) =>
          `${p.stock} units on hand (reorder point ${p.reorderPoint}) selling ~${round(p.velocity ?? 0)}/day ` +
          `(${weekWindow(p)}) — ${money(tiedUp)} tied up` +
          sinceLine(prior, (v) => money(v)),
      });
    }
  }
  return out;
}

/**
 * What the velocity figure was averaged over, said out loud.
 *
 * "selling ~0.14/day" reads as a settled fact about a product's demand. With
 * one weekly bucket it is one week's sales divided by seven, and the founder
 * cannot tell the two apart from the sentence.
 */
function weekWindow(p: ProductSignal): string {
  return p.velocityWeeks === 1 ? "1 week of sales" : `mean of ${p.velocityWeeks} weeks`;
}

/**
 * Margin — products selling under the floor. Same product read as inventory
 * (one read, two domains), its own condition keys and its own department:
 * finance is where a founder answers a pricing question.
 */
function marginConditions(products: ProductSignal[]): Condition[] {
  const out: Condition[] = [];
  for (const p of products) {
    if (p.marginPct === null || p.marginPct >= PULSE_THRESHOLDS.thinMarginPct) continue;
    out.push({
      key: `margin:${p.id}`,
      domain: "margin",
      department: "finance",
      severity: "info",
      subject: p.id,
      title: `${p.name} is selling below a ${PULSE_THRESHOLDS.thinMarginPct}% margin`,
      metric: "marginPct",
      value: round(p.marginPct),
      worseWhen: "lower",
      // `p.cost` is non-null whenever `marginPct` is — `marginPctOf` returns
      // null without a cost, which is the entire point of D3/D4: no cost, no
      // margin claim, rather than a confident 100% on a product Nova cannot
      // cost or a `NaN% margin at ৳3,959 on ৳NaN cost`.
      evidence: (prior) =>
        `${round(p.marginPct!)}% margin at ${money(p.price)} on ${money(p.cost!)} cost` +
        sinceLine(prior, (v) => `${round(v)}%`),
    });
  }
  return out;
}

/**
 * Sales — revenue over the last 7 days against the 7 before it.
 *
 * REFUSED OUTRIGHT ON A TRUNCATED PAGE. The window is one 200-row page ordered
 * newest-first, so on a busy store the rows that fall off are the prior week's
 * — the denominator. Every such comparison is biased the same way (toward "up",
 * so the alarm goes quiet) and the percentage is one the founder can check
 * against their own dashboard and find wrong. A missing claim is recoverable;
 * a confident wrong percentage in a report costs Nova the founder's trust in
 * every other number on the page.
 */
function salesConditions(sales: {
  revenue7d: number;
  revenuePrior7d: number;
  partial: boolean;
  unpricedOrders: number;
}): Condition[] {
  if (sales.partial) return [];
  // No prior week to compare against ⇒ no claim. A first-week store is not a
  // store whose revenue collapsed.
  if (sales.revenuePrior7d <= 0) return [];
  const changePct = ((sales.revenue7d - sales.revenuePrior7d) / sales.revenuePrior7d) * 100;
  if (changePct > PULSE_THRESHOLDS.revenueDropPct) return [];
  // The maturity bias, named in the line the founder reads: both weeks exclude
  // cancelled/refunded/RTO orders, and the older week has had a week longer to
  // reach one of those statuses.
  const basis =
    ` (cancelled, refunded and returned orders excluded from both weeks — the earlier week has had longer to ` +
    `accumulate them${sales.unpricedOrders > 0 ? `; ${sales.unpricedOrders} order(s) carry no total and are left out` : ""})`;
  return [
    {
      key: "sales:revenue_drop",
      domain: "sales",
      department: "sales",
      severity: "warning",
      subject: "revenue_7d",
      title: `Revenue is down ${Math.abs(round(changePct, 1))}% week over week`,
      metric: "revenueChangePct",
      value: round(changePct, 1),
      worseWhen: "lower",
      evidence: (prior) =>
        `${money(sales.revenue7d)} over the last 7 days against ${money(sales.revenuePrior7d)} the week before` +
        basis +
        sinceLine(prior, (v) => `a ${round(v, 1)}% gap`),
    },
  ];
}

/**
 * Carts — what is sitting unrecovered, measured in money.
 *
 * The count is the unrecovered subset of ONE page of leads (dakio-api hands
 * back the 200 newest, of any status, of all time). When that page is full the
 * subset is a floor and says so — "24 carts" that can never exceed 200 however
 * bad it gets is not a total, and a founder reading it as one is the failure.
 */
function cartConditions(carts: { count: number; value: number; partial: boolean; unpriced: number }): Condition[] {
  if (carts.count <= 0) return [];
  const at = carts.partial ? "at least " : "";
  const plural = carts.count === 1 ? "" : "s";
  const unpriced =
    carts.unpriced > 0
      ? `, ${carts.unpriced} of them with no cart value recorded (counted, not priced at ৳0)`
      : "";
  const scope = carts.partial
    ? ` — counted from the newest ${LIST_PAGE_CAP} leads only, so this is a floor, not a total`
    : "";
  return [
    {
      key: "carts:unrecovered",
      domain: "carts",
      department: "sales",
      severity: "info",
      subject: "carts",
      title: `${at}${carts.count} abandoned cart${plural} awaiting recovery`,
      metric: "unrecoveredValue",
      value: round(carts.value),
      worseWhen: "higher",
      evidence: (prior) =>
        `${at}${carts.count} cart${plural} worth ${at}${money(carts.value)} with no recovery message sent` +
        unpriced +
        scope +
        sinceLine(prior, (v) => money(v)),
    },
  ];
}

/**
 * Supplier — days late on open POs, as the supplier itself reports them.
 *
 * `null` days is UNKNOWN and produces no condition. It used to arrive as
 * `currentDelayDays ?? 0`, which turned "this supplier told us nothing" into a
 * measured, on-time observation — and then stored it as one.
 */
function supplierConditions(suppliers: { id: string; name: string; currentDelayDays: number | null }[]): Condition[] {
  const out: Condition[] = [];
  for (const s of suppliers) {
    const delay = s.currentDelayDays;
    if (delay === null || delay <= 0) continue;
    out.push({
      key: `supplier:${s.id}`,
      domain: "supplier",
      department: "operations",
      severity: "warning",
      subject: s.id,
      title: `${s.name} is running ${delay} day${delay === 1 ? "" : "s"} late`,
      metric: "currentDelayDays",
      value: delay,
      worseWhen: "higher",
      evidence: (prior) =>
        `${s.name} reports ${delay} day${delay === 1 ? "" : "s"} of delay on open POs` +
        sinceLine(prior, (v) => `${v}`),
    });
  }
  return out;
}

/**
 * Courier — what the parcels did, over the base they were counted on.
 *
 * ── THE FOUR RULES, AND WHY EACH ONE COSTS A FINDING SOMEWHERE ─────────────
 *
 *  1. NO RATE WITHOUT `sufficientEvidence`. The route computes rates over
 *     resolved parcels at ANY base and says separately whether that base is
 *     evidence (resolved ≥ 25). The demo seed carries a courier whose RTO rate
 *     is 50% over TWO parcels: arithmetically the worst number in the store,
 *     and reporting it would tell a founder to fire a courier over one return.
 *     That row produces nothing here, forever, until it has a base.
 *  2. NULL IS NOT A NUMBER. `rtoRate === null` means nothing resolved — never
 *     "0% RTO, excellent". Every branch below tests for null explicitly rather
 *     than letting `null < threshold` coerce its way to a verdict.
 *  3. NOTHING FROM A TRUNCATED WINDOW IS A PERIOD TOTAL. When the read came
 *     back capped, the rows are the most recent N dispatches; counts are worded
 *     "at least" and every evidence line says what the numbers are over. The
 *     rates survive — a rate over the most recent parcels is a real rate, and
 *     unlike the week-over-week case its denominator is not systematically the
 *     part that fell off — but they may not be dated to the window.
 *  4. THE EVIDENCE LINE NAMES THE BASIS, NEVER A BARE PERCENTAGE. "31% RTO" is
 *     a claim a founder cannot check; "31% RTO over 42 resolved parcels (13 of
 *     42 came back)" is one they can hold up against their own courier ledger.
 *
 * ── WHAT IS DELIBERATELY NOT A CONDITION HERE ─────────────────────────────
 *
 *  · ON-TIME RATE. `onTimeRate` is `null` on every response dakio-api can
 *    produce, because the schema records no promised-delivery date anywhere. It
 *    is not a threshold nobody has set; it is a measurement that cannot exist.
 *    `blindSpots` says so out loud rather than this file quietly having no rule.
 *  · DELIVERED RATE. `delivered = resolved − rto − failed`, so a "delivery
 *    success is down" finding is the RTO finding again in a friendlier voice,
 *    counted on the same base, waking the same department twice.
 *  · CANCELLATION RATE. A cancelled order is a merchant or customer decision;
 *    the route keeps it out of every denominator for exactly that reason, and
 *    charging it to a courier would make a store with a lot of order-cancels
 *    look like it has a shipping problem.
 *  · COST PER PARCEL / RATE COMPARISON. There is no cost on the wire. The old
 *    `Courier` type had `costPerShipment`, invented in the demo seed, and a
 *    "switch to the cheaper courier" finding built on it would have been Nova
 *    reading its own fixture back to the founder.
 *  · FAILED RATE ON ITS OWN. `failed` means "ended without delivering and no
 *    raw string says it came back" — the honest reading is uncertainty, and a
 *    finding whose whole content is "we do not know what happened to these"
 *    belongs in the blind-spot list, not in the alarm.
 */
function courierConditions(window: { couriers: CourierSignal[]; truncated: boolean }): Condition[] {
  const out: Condition[] = [];
  const { truncated } = window;
  /** Said on every line from a capped read, so no count reads as a period total. */
  const scope = truncated
    ? " — counted over the most recent dispatches only, so this is a floor, not the period's total"
    : "";
  const atLeast = truncated ? "at least " : "";

  for (const c of window.couriers) {
    // RULE 1 + 2, in one line: a rate that is unknown, or real but not yet
    // evidence, produces NOTHING. Not a quieter finding — nothing.
    if (c.rtoRate !== null && c.sufficientEvidence) {
      const rtoPct = c.rtoRate * 100;
      if (rtoPct >= PULSE_THRESHOLDS.courierRtoRatePct) {
        out.push({
          key: `courier:rto:${c.id}`,
          domain: "courier",
          department: "shipping",
          severity: "warning",
          subject: c.id,
          title: `${c.name} is returning ${Math.round(rtoPct)}% of the parcels it resolves`,
          metric: "rtoRatePct",
          value: round(rtoPct, 1),
          worseWhen: "higher",
          // THE BASIS, ALWAYS. `c.basis` is the route's own sentence about the
          // denominator ("42 resolved of 54 dispatched"), so the founder is
          // never handed a percentage without the parcels behind it.
          evidence: (prior) =>
            `${round(rtoPct, 1)}% RTO over ${c.resolved} resolved parcel${c.resolved === 1 ? "" : "s"} ` +
            `(${c.rto} came back, ${c.basis}; ${c.inFlight} still in flight and ${c.cancelled} cancelled are ` +
            `excluded from the rate)` +
            scope +
            sinceLine(prior, (v) => `${round(v, 1)}%`),
        });
      }
    }

    // A MEAN NEEDS ITS OWN BASE. `sufficientEvidence` is about resolved
    // parcels; this average is over the ones that carried both a dispatch and
    // a delivery stamp, and that sample is usually smaller. Both floors apply.
    if (
      c.avgDaysToDeliver !== null &&
      c.sufficientEvidence &&
      c.deliveryTimeSample >= PULSE_THRESHOLDS.courierDeliverySample &&
      c.avgDaysToDeliver >= PULSE_THRESHOLDS.courierSlowDeliveryDays
    ) {
      out.push({
        key: `courier:slow:${c.id}`,
        domain: "courier",
        department: "shipping",
        severity: "info",
        subject: c.id,
        // NOT "late". Nothing was promised, so nothing was missed — this is
        // how long parcels took, which is a different sentence.
        title: `${c.name} is taking ${round(c.avgDaysToDeliver, 1)} days to deliver`,
        metric: "avgDaysToDeliver",
        value: round(c.avgDaysToDeliver, 1),
        worseWhen: "higher",
        evidence: (prior) =>
          `${round(c.avgDaysToDeliver!, 1)} days from dispatch to delivery, averaged over ` +
          `${c.deliveryTimeSample} delivered parcel${c.deliveryTimeSample === 1 ? "" : "s"} ` +
          `(${c.basis}). No delivery promise is recorded anywhere in the store, so this is how long parcels ` +
          `took — not how late they were` +
          scope +
          sinceLine(prior, (v) => `${round(v, 1)} days`),
      });
    }

    // A COUNT, NOT A RATE, so the evidence floor does not apply — each of these
    // parcels was raised by `novaJourney`'s own stagnation thresholds, which
    // the scorecard reads rather than restating. What applies instead is the
    // truncation rule: on a capped read this is "at least N".
    if (c.inFlightStagnant >= PULSE_THRESHOLDS.courierStagnantParcels) {
      out.push({
        key: `courier:stagnant:${c.id}`,
        domain: "courier",
        department: "shipping",
        severity: "warning",
        subject: c.id,
        title: `${atLeast}${c.inFlightStagnant} ${c.name} parcels have stopped moving`,
        metric: "inFlightStagnant",
        value: c.inFlightStagnant,
        worseWhen: "higher",
        evidence: (prior) =>
          `${atLeast}${c.inFlightStagnant} of ${c.inFlight} in-flight parcel${c.inFlight === 1 ? "" : "s"} at ` +
          `${c.name} have not had a courier scan in long enough for the delivery journey to flag them` +
          scope +
          sinceLine(prior, (v) => `${v}`),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// COMPARE
// ---------------------------------------------------------------------------

/**
 * Compare a fresh observation against the last pulse's snapshot.
 *
 * Costs nothing but arithmetic. When it answers `quiet: true` the pulse is
 * over: write the snapshot, complete the job, spend zero tokens.
 */
export function comparePulse(sense: StoreSense, prior: PulseSnapshot | null): PulseComparison {
  const conditions: Condition[] = [];

  // Each domain contributes ONLY if it answered. An unreadable domain produces
  // no conditions — never an empty one, which would read as "all clear".
  if (sense.products.ok) {
    conditions.push(...inventoryConditions(sense.products.value));
    conditions.push(...marginConditions(sense.products.value));
  }
  if (sense.sales.ok) conditions.push(...salesConditions(sense.sales.value));
  if (sense.carts.ok) conditions.push(...cartConditions(sense.carts.value));
  if (sense.suppliers.ok) conditions.push(...supplierConditions(sense.suppliers.value));
  if (sense.courier.ok) conditions.push(...courierConditions(sense.courier.value));

  const priorOpen = prior?.openFindings ?? null;
  const findings: PulseFinding[] = [];
  const open: Record<string, OpenCondition> = {};

  for (const condition of conditions) {
    const was = priorOpen?.[condition.key] ?? null;
    const priorObservation: PriorObservation | null =
      was === null ? null : { value: was.metric, at: was.measuredAt };

    // THE THREE WAYS A CONDITION IS NEWS. The third is the one that was
    // missing: still true, unchanged, and nobody ever told the founder.
    //
    // A worsening is checked LAST but suppresses nothing — a condition inside
    // its dismissal window that materially worsens is a different fact and is
    // raised immediately.
    const trigger: PulseFinding["trigger"] | null =
      was === null
        ? "crossed"
        : !was.announced && !withinDismissalWindow(was, sense.at)
          ? "unreported"
          : materiallyWorse(condition, was.metric)
            ? "worsened"
            : null;

    // A condition whose value could not be measured this pass keeps the last
    // real measurement and its date, rather than overwriting a known number
    // with `null` and dating it now.
    const measured = condition.value !== null;
    open[condition.key] = {
      since: was?.since ?? sense.at,
      metric: measured ? condition.value : (was?.metric ?? null),
      measuredAt: measured ? sense.at : (was?.measuredAt ?? sense.at),
      // Carried, never set from "we derived it" — `pulse.ts` sets both of these
      // from what happened to the finding downstream.
      announced: was?.announced ?? false,
      dismissedAt: was?.dismissedAt ?? null,
    };
    if (trigger === null) continue;

    findings.push({
      key: condition.key,
      domain: condition.domain,
      department: condition.department,
      severity: condition.severity,
      subject: condition.subject,
      title: condition.title,
      observation: {
        metric: condition.metric,
        value: condition.value,
        priorValue: priorObservation?.value ?? null,
        priorMeasuredAt: priorObservation?.value === undefined || priorObservation?.value === null
          ? null
          : priorObservation.at,
        evidence: condition.evidence(priorObservation),
      },
      trigger,
    });
  }

  // ── Carry forward what could NOT be re-derived this pass ──────────────────
  //
  // Two ways a condition goes un-re-derived, and both must remember:
  //   · its whole DOMAIN went dark (a failed read);
  //   · its domain answered but the FIELD the condition is built on came back
  //     unknown — a product page with no velocity, a supplier with no delay
  //     figure, a truncated catalogue that no longer contains the product.
  // Dropping either would report every one of them as newly crossed on the next
  // healthy pulse — announced as a "(first sighting)" of something that has
  // been continuously true — and lose the `since` stamps.
  if (priorOpen) {
    const undeterminable = undeterminableKeys(sense, Object.keys(priorOpen));
    for (const [key, state] of Object.entries(priorOpen)) {
      if (key in open) continue;
      if (!domainAnswered(sense, domainOfKey(key)) || undeterminable.has(key)) open[key] = state;
    }
  }

  const departments = [...new Set(findings.map((f) => f.department))];
  return { findings, open, departments, quiet: findings.length === 0 };
}

/**
 * Condition keys this pass COULD NOT DECIDE — the read answered, the input did
 * not.
 *
 * This is the field-granularity half of the degradation contract. Without it, a
 * `200 OK` product page missing `weeklyVelocity` silently closes every open
 * stock-out condition on the store: nothing re-derives them, so they leave the
 * open set as though the problem had been solved.
 *
 * A key in here is neither open nor closed — it is UNKNOWN, and unknown keeps
 * whatever the last pulse knew.
 */
export function undeterminableKeys(sense: StoreSense, priorKeys: readonly string[] = []): Set<string> {
  const out = new Set<string>();

  if (sense.products.ok) {
    const onPage = new Set<string>();
    for (const p of sense.products.value) {
      onPage.add(p.id);
      // Cover needs a velocity above the floor AND a lead time.
      if (p.daysOfCover === null || p.leadTimeDays === null) out.add(`inventory:cover:${p.id}`);
      // Dead stock needs a velocity, a cost for the cash figure, and a reorder
      // point to measure overhang from (`0` is dakio-api's "no source").
      if (p.velocity === null || p.cost === null || p.reorderPoint <= 0) out.add(`inventory:dead:${p.id}`);
      if (p.marginPct === null) out.add(`margin:${p.id}`);
    }
    // A TRUNCATED catalogue did not look at every product, so a previously open
    // condition about a product that is not on this page was not examined. It
    // is unknown, not solved — the 601st SKU does not stop having a problem
    // because the page stopped at 200.
    if (sense.partial.products) {
      for (const key of priorKeys) {
        const id = productIdOfKey(key);
        if (id !== null && !onPage.has(id)) out.add(key);
      }
    }
  }

  if (sense.suppliers.ok) {
    for (const s of sense.suppliers.value) {
      if (s.currentDelayDays === null) out.add(`supplier:${s.id}`);
    }
  }

  // ── Courier: the read answered, the ROW could not decide ─────────────────
  //
  // Three ways a courier condition is unknown rather than solved, and all three
  // are the ordinary state of a small store: the rate is null (nothing
  // resolved), the base is below the evidence floor, or the delivery-time
  // sample is too thin for a mean. Without this, a courier that crossed 20% RTO
  // last week and has since had its parcels drop under the floor would leave
  // the open set as though the returns had stopped — and re-announce itself as
  // a "(first sighting)" the next time it has 25 resolved parcels.
  //
  // A courier that vanished from the list entirely is NOT here: it booked
  // nothing in the window, which is a real change of state, and its condition
  // closing is honest. This is only about rows that answered and could not say.
  if (sense.courier.ok) {
    for (const c of sense.courier.value.couriers) {
      if (c.rtoRate === null || !c.sufficientEvidence) out.add(`courier:rto:${c.id}`);
      if (
        c.avgDaysToDeliver === null ||
        !c.sufficientEvidence ||
        c.deliveryTimeSample < PULSE_THRESHOLDS.courierDeliverySample
      ) {
        out.add(`courier:slow:${c.id}`);
      }
    }
  }

  // A revenue comparison that cannot be computed (truncated page, or no prior
  // week) leaves the condition where it was rather than closing it.
  if (sense.sales.ok && (sense.sales.value.partial || sense.sales.value.revenuePrior7d <= 0)) {
    out.add("sales:revenue_drop");
  }

  return out;
}

/** The product id inside a per-product condition key, or `null`. */
function productIdOfKey(key: string): string | null {
  for (const prefix of ["inventory:cover:", "inventory:dead:", "margin:"]) {
    if (key.startsWith(prefix)) return key.slice(prefix.length);
  }
  return null;
}

/** Is this condition still inside the window a judge's dismissal bought? */
function withinDismissalWindow(state: OpenCondition, at: string): boolean {
  if (state.dismissedAt === null) return false;
  const dismissedMs = Date.parse(state.dismissedAt);
  if (!Number.isFinite(dismissedMs)) return false;
  return Date.parse(at) - dismissedMs < DISMISSAL_QUIET_MS;
}

/** The domain a condition key belongs to — the prefix before the first colon. */
function domainOfKey(key: string): PulseDomain | null {
  const head = key.split(":")[0];
  return (["inventory", "sales", "carts", "margin", "supplier", "courier"] as const).find((d) => d === head) ?? null;
}

/** Did the sense that produces this domain's conditions answer this pass? */
function domainAnswered(sense: StoreSense, domain: PulseDomain | null): boolean {
  switch (domain) {
    case "inventory":
    case "margin":
      return sense.products.ok;
    case "sales":
      return sense.sales.ok;
    case "carts":
      return sense.carts.ok;
    case "supplier":
      return sense.suppliers.ok;
    case "courier":
      return sense.courier.ok;
    default:
      // An unrecognised key belongs to no domain this build knows about — a
      // snapshot written by a newer version, or a renamed condition. Treat it
      // as unanswered so it is preserved rather than silently dropped.
      return false;
  }
}

/**
 * The snapshot to store after this pulse.
 *
 * The rule that matters is in the `??` chains: A DOMAIN THAT DID NOT ANSWER
 * KEEPS ITS PRIOR VALUE. Writing `null` for an unreadable domain would make the
 * next pulse treat everything in it as a first sighting, and one API blip would
 * become a wall of alerts an hour later — the pulse alarming about its own
 * outage, in the founder's inbox.
 */
export function nextSnapshot(
  sense: StoreSense,
  prior: PulseSnapshot | null,
  comparison: PulseComparison,
  /** Max `receivedAt` of the events this pulse took into account. */
  inboxCursor: string | null,
  /**
   * WHAT HAPPENED TO THE FINDINGS after they were derived — the half the
   * snapshot used to assume.
   *
   * `announced`: keys that made it into a filed report or onto a Decision card.
   * `dismissed`: keys whose department the judge said was not worth waking the
   * founder for. Everything mentioned in neither stays unreported and is news
   * again next pulse, which is the safe default for a caller that forgets.
   */
  outcome: {
    announced?: ReadonlySet<string>;
    dismissed?: ReadonlySet<string>;
    blindSpots?: Record<string, BlindSpotState>;
  } = {},
): PulseSnapshot {
  const announced = outcome.announced ?? new Set<string>();
  const dismissed = outcome.dismissed ?? new Set<string>();
  const blind = outcome.blindSpots ?? {};
  const products: Record<string, ProductState> | null = sense.products.ok
    ? Object.fromEntries(
        sense.products.value.map((p) => [
          p.id,
          { stock: p.stock, velocity: p.velocity, daysOfCover: p.daysOfCover, marginPct: p.marginPct },
        ]),
      )
    : (prior?.products ?? null);

  const openFindings = Object.fromEntries(
    Object.entries(comparison.open).map(([key, state]) => [
      key,
      announced.has(key)
        ? { ...state, announced: true, dismissedAt: null }
        : dismissed.has(key)
          ? { ...state, dismissedAt: sense.at }
          : state,
    ]),
  );

  return {
    at: sense.at,
    products,
    supplierDelayDays: sense.suppliers.ok
      ? Object.fromEntries(sense.suppliers.value.map((s) => [s.id, s.currentDelayDays]))
      : (prior?.supplierDelayDays ?? null),
    revenue7d: sense.sales.ok ? sense.sales.value.revenue7d : (prior?.revenue7d ?? null),
    revenuePrior7d: sense.sales.ok ? sense.sales.value.revenuePrior7d : (prior?.revenuePrior7d ?? null),
    carts: sense.carts.ok ? { count: sense.carts.value.count, value: sense.carts.value.value } : (prior?.carts ?? null),
    // The cursor only ever moves forward: a failed inbox read leaves it where
    // it was, so the events it could not see are still unseen next time.
    inboxCursor: inboxCursor ?? prior?.inboxCursor ?? null,
    openFindings,
    blindSpots: blind,
  };
}

// ---------------------------------------------------------------------------
// Blindness, compared the same way findings are
// ---------------------------------------------------------------------------

/**
 * Which blind spots are NEWS this pass.
 *
 * Newly dark ⇒ news. Still dark and last announced more than
 * {@link BLIND_REANNOUNCE_MS} ago ⇒ news again. Still dark and told recently ⇒
 * silence, so a broken read does not become an hourly alarm.
 *
 * The middle case is the one that matters: pure edge-triggering is exactly how
 * four-of-five senses dark became an indefinite `quiet: true` after the first
 * pass, and a store that has been blind for a week must not look like a store
 * with nothing to report.
 */
export function blindSpotNews(current: BlindSpot[], prior: PulseSnapshot | null, at: string): BlindSpot[] {
  const known = prior?.blindSpots ?? {};
  const nowMs = Date.parse(at);
  return current.filter((spot) => {
    const was = known[spot.key];
    if (!was || was.announcedAt === null) return true;
    const toldMs = Date.parse(was.announcedAt);
    return !Number.isFinite(toldMs) || nowMs - toldMs >= BLIND_REANNOUNCE_MS;
  });
}

/**
 * The blind-spot memory to store: `since` carried from the first sighting,
 * `announcedAt` advanced only for the ones the founder was actually told about
 * this pass. A spot that cleared is dropped — its next appearance is news.
 */
export function nextBlindSpots(
  current: BlindSpot[],
  prior: PulseSnapshot | null,
  at: string,
  announced: ReadonlySet<string>,
): Record<string, BlindSpotState> {
  const known = prior?.blindSpots ?? {};
  const out: Record<string, BlindSpotState> = {};
  for (const spot of current) {
    const was = known[spot.key];
    out[spot.key] = {
      since: was?.since ?? at,
      announcedAt: announced.has(spot.key) ? at : (was?.announcedAt ?? null),
    };
  }
  return out;
}
