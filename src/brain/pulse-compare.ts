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
 * Here a condition is news exactly twice:
 *   1. when it CROSSES — it was not true at the last pulse and it is now
 *      (a store with no stored snapshot at all is a first sighting: every true
 *      condition crosses, once, and then goes quiet);
 *   2. when it materially WORSENS — the metric behind an already-open condition
 *      moved by at least {@link MATERIAL_CHANGE_PCT} in the bad direction.
 *      "12 days of cover became 3" is a different fact from "12 days of cover
 *      is still 11".
 *
 * A condition that CLOSES is deliberately NOT a finding. Silence is the
 * designed success of this lane, and "the thing I warned you about is fine now"
 * is the most tempting kind of spam there is. It leaves the open set, and the
 * next time it crosses it is news again.
 *
 * ── A DOMAIN THAT DID NOT ANSWER PRODUCES NOTHING, AND FORGETS NOTHING ─────
 *
 * An unreadable sense produces no findings (see {@link comparePulse}) AND its
 * prior state is carried forward into the next snapshot by
 * {@link nextSnapshot}. Both halves matter: without the first, a failed read
 * would read as "all conditions cleared"; without the second, the pulse after
 * a blip would see every condition as a first sighting and alert on all of
 * them at once.
 */

import type { NovaDepartment } from "../store/types.js";
import type { ProductSignal, StoreSense } from "../lib/snapshot.js";
import type { PulseSnapshot, ProductState } from "./pulse-state.js";

/** The five domains the sense layer actually reads. Nothing else may appear. */
export type PulseDomain = "inventory" | "sales" | "carts" | "margin" | "supplier";

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
} as const;

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
    /** The same metric at the last pulse. `null` = first sighting. */
    priorValue: number | null;
    /** One line a founder can check against their own dashboard. */
    evidence: string;
  };
  /** `crossed` = newly true. `worsened` = open, and materially worse. */
  trigger: "crossed" | "worsened";
}

/** What COMPARE decided. `quiet` is the success case, and it is the common one. */
export interface PulseComparison {
  findings: PulseFinding[];
  /** Conditions currently true, for the next snapshot's `openFindings`. */
  open: Record<string, { since: string; metric: number | null }>;
  /** Departments with at least one finding — the only ones DECIDE may wake. */
  departments: NovaDepartment[];
  quiet: boolean;
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
  evidence: (priorValue: number | null) => string;
}

const round = (n: number, dp = 2): number => Math.round(n * 10 ** dp) / 10 ** dp;
const money = (n: number): string => `৳${Math.round(n).toLocaleString("en-IN")}`;

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
          `${p.stock} units left selling ~${round(p.velocity ?? 0)}/day = ${Math.floor(p.daysOfCover!)} days of cover, ` +
          `against a ${p.leadTimeDays}-day wait from ${p.supplierName ?? p.supplierId}` +
          (prior === null ? " (first sighting)" : ` (was ${round(prior)} days at the last pulse)`),
      });
    }
    // DEAD STOCK NEEDS BOTH INPUTS TO BE REAL. A live dakio tenant answers
    // `weeklyVelocity: []` and `reorderPoint: 0` (documented gaps in
    // novaStore.js), and reading those as "sells nothing" and "reorder at zero"
    // would declare the ENTIRE catalogue dead stock, confidently, every hour.
    // Unknown is not a measurement.
    if (
      p.velocity !== null &&
      p.reorderPoint > 0 &&
      p.stock > PULSE_THRESHOLDS.deadStockOverhangMultiple * p.reorderPoint &&
      p.velocity < PULSE_THRESHOLDS.deadStockVelocity
    ) {
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
        value: round(p.stock * p.cost),
        worseWhen: "higher",
        evidence: (prior) =>
          `${p.stock} units on hand (reorder point ${p.reorderPoint}) selling ~${round(p.velocity ?? 0)}/day — ` +
          `${money(p.stock * p.cost)} tied up` +
          (prior === null ? " (first sighting)" : ` (was ${money(prior)})`),
      });
    }
  }
  return out;
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
      evidence: (prior) =>
        `${round(p.marginPct!)}% margin at ${money(p.price)} on ${money(p.cost)} cost` +
        (prior === null ? " (first sighting)" : ` (was ${round(prior)}%)`),
    });
  }
  return out;
}

/** Sales — revenue over the last 7 days against the 7 before it. */
function salesConditions(sales: { revenue7d: number; revenuePrior7d: number }): Condition[] {
  // No prior week to compare against ⇒ no claim. A first-week store is not a
  // store whose revenue collapsed.
  if (sales.revenuePrior7d <= 0) return [];
  const changePct = ((sales.revenue7d - sales.revenuePrior7d) / sales.revenuePrior7d) * 100;
  if (changePct > PULSE_THRESHOLDS.revenueDropPct) return [];
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
        (prior === null ? " (first sighting)" : ` (the gap was ${round(prior, 1)}%)`),
    },
  ];
}

/** Carts — what is sitting unrecovered, measured in money. */
function cartConditions(carts: { count: number; value: number }): Condition[] {
  if (carts.count <= 0) return [];
  return [
    {
      key: "carts:unrecovered",
      domain: "carts",
      department: "sales",
      severity: "info",
      subject: "carts",
      title: `${carts.count} abandoned cart${carts.count === 1 ? "" : "s"} awaiting recovery`,
      metric: "unrecoveredValue",
      value: round(carts.value),
      worseWhen: "higher",
      evidence: (prior) =>
        `${carts.count} cart${carts.count === 1 ? "" : "s"} worth ${money(carts.value)} with no recovery message sent` +
        (prior === null ? " (first sighting)" : ` (was ${money(prior)})`),
    },
  ];
}

/** Supplier — days late on open POs, as the supplier itself reports them. */
function supplierConditions(suppliers: { id: string; name: string; currentDelayDays: number }[]): Condition[] {
  return suppliers
    .filter((s) => s.currentDelayDays > 0)
    .map((s) => ({
      key: `supplier:${s.id}`,
      domain: "supplier" as const,
      department: "operations" as const,
      severity: "warning" as const,
      subject: s.id,
      title: `${s.name} is running ${s.currentDelayDays} day${s.currentDelayDays === 1 ? "" : "s"} late`,
      metric: "currentDelayDays",
      value: s.currentDelayDays,
      worseWhen: "higher" as const,
      evidence: (prior: number | null) =>
        `${s.name} reports ${s.currentDelayDays} day${s.currentDelayDays === 1 ? "" : "s"} of delay on open POs` +
        (prior === null ? " (first sighting)" : ` (was ${prior})`),
    }));
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

  const priorOpen = prior?.openFindings ?? null;
  const findings: PulseFinding[] = [];
  const open: Record<string, { since: string; metric: number | null }> = {};

  for (const condition of conditions) {
    const was = priorOpen?.[condition.key] ?? null;
    const priorValue = was?.metric ?? null;
    const trigger: PulseFinding["trigger"] | null =
      was === null ? "crossed" : materiallyWorse(condition, priorValue) ? "worsened" : null;

    open[condition.key] = { since: was?.since ?? sense.at, metric: condition.value };
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
        priorValue,
        evidence: condition.evidence(priorValue),
      },
      trigger,
    });
  }

  // ── Carry forward the open set of any domain that went dark ───────────────
  //
  // Its conditions were not re-derived this pass, so dropping them would (a)
  // report every one of them as newly crossed on the next healthy pulse and (b)
  // lose the `since` stamps. A blind domain remembers; it does not forget.
  if (priorOpen) {
    for (const [key, state] of Object.entries(priorOpen)) {
      if (key in open) continue;
      if (!domainAnswered(sense, domainOfKey(key))) open[key] = state;
    }
  }

  const departments = [...new Set(findings.map((f) => f.department))];
  return { findings, open, departments, quiet: findings.length === 0 };
}

/** The domain a condition key belongs to — the prefix before the first colon. */
function domainOfKey(key: string): PulseDomain | null {
  const head = key.split(":")[0];
  return (["inventory", "sales", "carts", "margin", "supplier"] as const).find((d) => d === head) ?? null;
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
): PulseSnapshot {
  const products: Record<string, ProductState> | null = sense.products.ok
    ? Object.fromEntries(
        sense.products.value.map((p) => [
          p.id,
          { stock: p.stock, velocity: p.velocity, daysOfCover: p.daysOfCover, marginPct: p.marginPct },
        ]),
      )
    : (prior?.products ?? null);

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
    openFindings: comparison.open,
  };
}
