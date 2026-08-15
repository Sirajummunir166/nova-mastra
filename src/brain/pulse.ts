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

import { doorFor, gateOrFile, type GateReceiptInput } from "../front-office/actions.js";
import { senseStore, senseFailures, SENSE_GAPS, type StoreSense } from "../lib/snapshot.js";
import { storeFor } from "../store/resolve.js";
import type { StoreClient } from "../store/client.js";
import type { ActionType, NovaDepartment } from "../store/types.js";
import { laneFor } from "./registry.js";
import { comparePulse, nextSnapshot, type PulseFinding } from "./pulse-compare.js";
import { loadPulseState, savePulseState } from "./pulse-state.js";

/** This lane's kind — every registry lookup below is keyed on it. */
const KIND = "pulse" as const;

/** The duty keys `registry.ts` binds this lane to. The runtime capability bound. */
function laneDuties(): readonly string[] {
  return laneFor(KIND)?.duties ?? [];
}

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
  /** The duty this act would be performed under. Checked against the lane. */
  dutyKey: string;
  department: NovaDepartment;
  title: string;
  paramsLine: string;
  payload: Record<string, unknown>;
}

export type RemedyFn = (finding: PulseFinding, sense: StoreSense) => Remedy | null;

/**
 * THE PRODUCTION REMEDY TABLE — and every entry in it is out of this lane's
 * duties today. That is the finding, not a bug in the table.
 *
 * Each remedy names the verb that would fix the thing and the duty that verb
 * belongs to. `settleFinding` then checks that duty against the registry, and
 * because none of them is in the pulse's lane, all of them surface as
 * {@link CapabilityGap}s. Cross-referenced with `registry.ts`:
 *
 *  · reorder      → `inventory.reorder_drafts`, held by `night_ops`.
 *  · clearance    → `inventory.dead_stock_clearance`, in UNCLAIMED
 *                   ("pulse SENSES dead stock but nothing acts").
 *  · reprice      → `finance.expense_flagging`, in UNCLAIMED (the margin sense
 *                   is real; no duty on the roster describes it).
 *  · supplier     → `operations.supplier_switching`, in UNCLAIMED
 *                   ("`switch_supplier` is a shipped verb with no lane").
 *  · cart recovery→ `sales.abandoned_checkout_emails`, held by `cart_sweep` —
 *                   and DIVISION OF LABOUR, not a gap to close here: doc 07 B2
 *                   is explicit that one cart worked by two lanes is how a
 *                   customer gets nudged twice in one evening.
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
      dutyKey: "finance.expense_flagging",
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

/** A remedy this lane may not perform. Surfaced, never acted on. */
export interface CapabilityGap {
  findingKey: string;
  verb: ActionType;
  wantedDuty: string;
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
   * the verb. See {@link settleFinding} — the honest outcome, not a hidden one.
   */
  | { kind: "no_executor"; verb: ActionType };

export interface SettledFinding {
  finding: PulseFinding;
  headline: string;
  note: string;
  outcome: FindingOutcome;
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

  // ── The inbox bookkeeping, as CODE ───────────────────────────────────────
  //
  // Under eve this was model steps: one `mark_event_processed` tool call per
  // event, inside a paid turn. It decides nothing, so it is a loop. Failures
  // are swallowed per event: an event that cannot be marked will be re-read
  // next hour, which is free, and letting it fail the pulse would let one
  // stuck row stop the watchdog.
  const events = sense.inbox.ok ? sense.inbox.value : [];
  let eventsProcessed = 0;
  let cursor: string | null = null;
  for (const event of events) {
    if (cursor === null || Date.parse(event.receivedAt) > Date.parse(cursor)) cursor = event.receivedAt;
    try {
      await client.markEventProcessed(event.id);
      eventsProcessed += 1;
    } catch (err) {
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
    for (const finding of findings) {
      const outcome = await settleFinding(client, finding, sense, remedyFor, judgement);
      if (outcome.kind === "capability_gap") gaps.push(outcome.gap);
      settled.push({ finding, headline: judgement.headline, note: judgement.note, outcome });
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
      body: pulseBody(settled, gaps, dark, opts.jobId),
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
 *   2. the remedy's duty is not in THIS LANE's registry entry ⇒ surface it and
 *      stop. Not a soft warning — the gate is never even consulted, because
 *      consulting it would mean this lane had decided it might act;
 *   3. only then the gate, which is the front office's `gateOrFile` →
 *      `evaluateAuthority`. There is exactly one authority gate in this repo
 *      and this lane uses it rather than growing a second opinion.
 */
async function settleFinding(
  client: StoreClient,
  finding: PulseFinding,
  sense: StoreSense,
  remedyFor: RemedyFn,
  judgement: PulseJudgement,
): Promise<FindingOutcome> {
  const remedy = remedyFor(finding, sense);
  if (!remedy) return { kind: "reported" };

  const duties = laneDuties();
  if (!duties.includes(remedy.dutyKey)) {
    return {
      kind: "capability_gap",
      gap: {
        findingKey: finding.key,
        verb: remedy.type,
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
    expectedImpact: judgement.note,
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
    ],
  };

  const step = await gateOrFile(client, {
    verb: remedy.type,
    department: remedy.department,
    dutyRef: remedy.dutyKey,
    // Recorded, never trusted for permission — but a job-driven action must not
    // file itself as a chat one.
    origin: "job",
    door: doorFor(remedy.department),
    title: remedy.title,
    paramsLine: remedy.paramsLine,
    payload: { ...remedy.payload, novaActionId: novaActionIdFor(finding) },
    receipt,
    preparedDetail: (delivered) =>
      delivered
        ? "Nova prepared this and put it on your desk."
        : "Nova prepared this, but the card did not reach your desk — it is on the action ledger.",
  });

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
  // Unreachable in production today (every production remedy is out of lane and
  // returns above), and named rather than silently dropped so the day a duty
  // moves into this lane, the missing piece has a name.
  console.warn(
    `[pulse] authority allows ${remedy.type} for ${finding.key}, but the pulse lane has no executor for it — ` +
      `nothing ran. Give the verb an executor, or move the duty to a lane that has one.`,
  );
  return { kind: "no_executor", verb: remedy.type };
}

/**
 * The at-most-once key for a filed action.
 *
 * Keyed on the CONDITION, not on the sighting: two pulses that both decide to
 * act on the same crossed condition file one row, not two. `nm:` matches the
 * customer lane's deterministic-id convention.
 */
function novaActionIdFor(finding: PulseFinding): string {
  return `nm:pulse:${finding.key}`;
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
      ...gaps.map((g) => `- \`${g.verb}\` needs the duty \`${g.wantedDuty}\`, which the pulse does not hold.`),
      "",
    );
  }
  if (dark.length > 0) {
    lines.push("**Blind spots this pass**", ...dark.map((d) => `- ${d}`), "");
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
      return `Not acted on: needs the duty \`${outcome.gap.wantedDuty}\`, which this lane does not hold.`;
    case "decision_filed":
      return `Prepared for your approval (${outcome.rule}).`;
    case "refused":
      return `Nova was not allowed to do this (${outcome.rule}).`;
    case "replayed":
      return "Already filed under this key by an earlier pulse.";
    case "no_executor":
      return `Allowed, but nothing ran — no executor for \`${outcome.verb}\` on this lane.`;
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
    capabilityGaps: z.array(z.object({ verb: z.string(), wantedDuty: z.string() })),
    senseFailures: z.array(z.string()),
    eventsProcessed: z.number(),
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
      capabilityGaps: result.capabilityGaps.map((g) => ({ verb: g.verb, wantedDuty: g.wantedDuty })),
      senseFailures: result.senseFailures,
      eventsProcessed: result.eventsProcessed,
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
