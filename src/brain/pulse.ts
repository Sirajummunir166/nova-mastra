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
 *            each independently guarded. Four honest domains plus supplier
 *            delay; ads/courier/support are NOT sensed and `SENSE_GAPS` says
 *            why, in the code, where a reader trips over it.
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
 *   RECORD   one consolidated `pulse` report, only when something survived.
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
import { senseStore, senseFailures, SENSE_GAPS, type StoreSense } from "../lib/snapshot.js";
import { storeFor } from "../store/resolve.js";
import { UNGOVERNED_VERBS } from "../store/duties.js";
import type { StoreClient } from "../store/client.js";
import type { ActionType, JobKind, NovaDepartment } from "../store/types.js";
import { laneFor } from "./registry.js";
import { comparePulse, nextSnapshot, type PulseFinding } from "./pulse-compare.js";
import { loadPulseState, savePulseState } from "./pulse-state.js";

/** This lane's kind — every registry lookup below is keyed on it. */
const KIND = "pulse" as const;

// ---------------------------------------------------------------------------
// DECIDE — the only model in the lane
// ---------------------------------------------------------------------------

const JUDGE_MODEL =
  process.env.NOVA_MODEL_PULSE ?? process.env.NOVA_MODEL_RESOLVER ?? "anthropic/claude-haiku-4-5-20251001";

export const pulseJudgeSchema = z.object({
  /**
   * Is this worth interrupting the founder's day for, right now? `false` is a
   * real answer and the lane's preferred one.
   */
  worthWaking: z.boolean(),
  /** One line the founder reads first. ≤ 120 chars, no invented numbers. */
  headline: z.string(),
  /** What you would do about it, in one sentence. */
  note: z.string(),
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
    "- worthWaking = false is the RIGHT answer for anything the owner would not act on today.",
    "  Silence is success; a report about a quiet hour is spam.",
    "- headline: one line, plain, leading with the fact. No greetings, no filler.",
    "- note: the single most useful next move, or why it can wait.",
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
  if (input.senseDark.length > 0) {
    // A dark sense is stated so the judgement is made knowing what it cannot
    // see, rather than reading absence as good news.
    lines.push(`BLIND SPOTS THIS PASS: ${input.senseDark.join("; ")}`);
  }
  return lines.join("\n");
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
  /** True = nothing crossed a threshold. The success case. */
  quiet: boolean;
  /** THE HEADLINE NUMBER. Zero on a quiet pulse, one per moved department otherwise. */
  modelCalls: number;
  departments: NovaDepartment[];
  findings: SettledFinding[];
  capabilityGaps: CapabilityGap[];
  /** Senses that did not answer this pass, with their reasons. */
  senseFailures: string[];
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
  if (dark.length === 5) {
    throw new Error(
      `pulse for ${storeId} could not read ANY sense this pass — ${dark.join("; ")}. A blind pulse is not a ` +
        `quiet one; refusing to complete the job or overwrite the last snapshot.`,
    );
  }

  // ── COMPARE (code, free) ─────────────────────────────────────────────────
  const prior = await loadPulseState(storeId);
  const comparison = comparePulse(sense, prior);
  const snapshot = nextSnapshot(sense, prior, comparison, cursor);

  // ── STOP. Nothing crossed a threshold. ───────────────────────────────────
  //
  // The snapshot is still written — that is what makes the NEXT pulse cheap
  // too — and nothing else happens. No report, no card, no model, no row.
  if (comparison.quiet) {
    const snapshotWritten = await writeSnapshot(storeId, snapshot);
    return {
      storeId,
      at: sense.at,
      quiet: true,
      modelCalls: 0,
      departments: [],
      findings: [],
      capabilityGaps: [],
      senseFailures: dark,
      eventsProcessed,
      eventDrainFailures: drainFailures,
      inboxCursor: snapshot.inboxCursor,
      snapshotWritten,
    };
  }

  // ── DECIDE — one call per MOVED department, and only the moved ones ──────
  const settled: SettledFinding[] = [];
  const gaps: CapabilityGap[] = [];
  const departmentsWithFindings: NovaDepartment[] = [];

  for (const department of comparison.departments) {
    const findings = comparison.findings.filter((f) => f.department === department);
    const card = changeCard({ department, findings, eventsSeen: events.length, senseDark: dark });

    let judgement: PulseJudgement;
    try {
      modelCalls += 1;
      judgement = await decide({ storeId, department, findings, card });
    } catch (err) {
      // A DEAD MODEL MUST NOT LOSE A CRITICAL FINDING. The numbers were
      // measured by code and are already in hand; only the wording and the
      // "is this worth it" judgement are missing. Fall back to the
      // deterministic title and treat everything as worth waking — the
      // fail-open direction here is the safe one, because the alternative is a
      // silent watchdog.
      console.warn(`[pulse] judge failed for ${storeId}/${department} — falling back to the observation:`, err);
      judgement = {
        worthWaking: true,
        headline: findings[0]?.title ?? `${department}: signals moved`,
        note: "Judgement unavailable this pass (the model call failed); the measurements above stand on their own.",
      };
    }

    // A CRITICAL FINDING IS NOT SUPPRESSIBLE. The model may judge whether a
    // warning or an info line deserves the founder's attention; it may not
    // decide that a stock-out that lands before the reorder does is fine.
    const hasCritical = findings.some((f) => f.severity === "critical");
    if (!judgement.worthWaking && !hasCritical) continue;

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

  // Every department's findings were judged not worth waking: still silence,
  // and still no report. The conditions stay OPEN in the snapshot, so they do
  // not re-fire next hour unless they materially worsen.
  if (settled.length === 0) {
    const snapshotWritten = await writeSnapshot(storeId, snapshot);
    return {
      storeId,
      at: sense.at,
      quiet: true,
      modelCalls,
      departments: [],
      findings: [],
      capabilityGaps: [],
      senseFailures: dark,
      eventsProcessed,
      eventDrainFailures: drainFailures,
      inboxCursor: snapshot.inboxCursor,
      snapshotWritten,
    };
  }

  // ── RECORD — ONE consolidated report, never one per finding ──────────────
  let reportId: string | undefined;
  try {
    const report = await client.addReport({
      kind: "pulse",
      title: pulseTitle(settled),
      body: pulseBody(settled, gaps, dark, drainFailures, opts.jobId),
      // A re-leased rerun re-files the SAME row rather than a duplicate
      // (dakio-api returns the original on a dedupeKey collision).
      dedupeKey: opts.dedupeKey ?? null,
    });
    reportId = report.id;
  } catch (err) {
    // The findings are already acted on or filed; losing the report is bad but
    // not a reason to release the job and redo the gate work.
    console.error(`[pulse] could not file the pulse report for ${storeId}:`, err);
  }

  const snapshotWritten = await writeSnapshot(storeId, snapshot);
  return {
    storeId,
    at: sense.at,
    quiet: false,
    modelCalls,
    departments: departmentsWithFindings,
    findings: settled,
    capabilityGaps: gaps,
    senseFailures: dark,
    eventsProcessed,
    eventDrainFailures: drainFailures,
    inboxCursor: snapshot.inboxCursor,
    snapshotWritten,
    ...(reportId ? { reportId } : {}),
  };
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
    // Not the model's self-rated confidence: the finding is a measurement, and
    // a measurement that crossed a threshold is not a guess.
    confidence: finding.severity === "critical" ? 0.9 : 0.7,
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

function pulseTitle(settled: SettledFinding[]): string {
  const critical = settled.filter((s) => s.finding.severity === "critical").length;
  const head = settled[0]?.headline ?? "Pulse";
  return critical > 0 ? `⚠ ${head}` : head;
}

function pulseBody(
  settled: SettledFinding[],
  gaps: CapabilityGap[],
  dark: string[],
  drainFailures: string[],
  jobId?: string,
): string {
  const lines: string[] = [];
  for (const s of settled) {
    lines.push(
      `**${s.finding.title}**`,
      `- ${s.finding.observation.evidence}`,
      `- ${outcomeLine(s.outcome)}`,
      "",
    );
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
  if (dark.length > 0) {
    lines.push("**Blind spots this pass**", ...dark.map((d) => `- ${d}`), "");
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
    eventsProcessed: z.number(),
    eventDrainFailures: z.array(z.string()),
    snapshotWritten: z.boolean(),
    reportId: z.string().optional(),
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
      eventsProcessed: result.eventsProcessed,
      eventDrainFailures: result.eventDrainFailures,
      snapshotWritten: result.snapshotWritten,
      ...(result.reportId ? { reportId: result.reportId } : {}),
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
