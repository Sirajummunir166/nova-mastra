/**
 * THE BRAIN'S HEARTBEAT — one tick a minute, per tenant, through that tenant's
 * own credential.
 *
 * Ported from nova-ai `agent/schedules/dispatcher.ts`. The loop is unchanged
 * because the loop is security design, not plumbing; what changed is the clock
 * (a Mastra scheduled workflow instead of an eve schedule) and the lanes it
 * hands work to (`brain/router.ts`).
 *
 * ── THE SECURITY RULE, STATED HERE AS IT IS IN THE SOURCE ───────────────────
 *
 * Every Nova service token is scoped to exactly ONE tenant (dakio-api's
 * `authenticateNovaService`).
 *
 *   > There is no credential that could claim across the fleet in one HTTP
 *   > call — minting one would be a new, more dangerous kind of cross-tenant
 *   > credential this codebase has never had.
 *
 * So: `resolveDispatchTenants()` (the tenantless `nova-fleet` token, which only
 * ever learns IDS) → then one `storeFor(id).claimDueJobs(10)` per tenant,
 * through THAT TENANT'S OWN token. N small round trips a minute instead of one
 * big one, and it shards the same way `SKIP LOCKED` does. Never collapse this
 * into a single fleet-wide claim, and never let one tenant's client touch
 * another tenant's row.
 *
 * ANY fault for one tenant is contained so it can never block another tenant's
 * tick — not just a thrown claim (dakio-api counts that one as
 * `nova.claim.failed`), and not just the claim call. The fan-out is
 * `allSettled` and the per-tenant body is total: a client that RESOLVES with
 * garbage is the failure that actually happened, and it used to reject the
 * whole tick from a line outside the try. That tenant retries next minute; the
 * others never notice.
 *
 * ── THE LEASE IS TEN MINUTES AND THE TOKEN IS THE FENCE ─────────────────────
 *
 * `claimDueJobs` leases each row for `LEASE_MINUTES = 10` and stamps a FRESH
 * `leaseToken` per lease. Complete/release are checked against that token, so a
 * step that outlives its lease finds its complete/release no-op'd — HTTP 200
 * `{ok:true, stale:true}` — while the watchdog has already re-dued the row and
 * another dispatcher may already own it.
 *
 * THAT FLAG IS THE ONLY WAY WE EVER LEARN IT, so this file reads it on both
 * verbs (`wasStale`) and refuses to count a stale settlement as a completion or
 * a release: the work is orphaned, possibly duplicated, and the run audit is
 * amended to say so. A 200 read as plain success is how the signal disappears.
 *
 * And a job that arrives WITHOUT a lease token is refused before it runs. The
 * server 422s an empty token on both verbs, so such a job could be worked and
 * never settled — which the ack-failure arm would swallow, leaving the row to
 * the watchdog and the customer to a second answer.
 *
 * ── NEVER RE-RUN A TURN THAT ALREADY WROTE ──────────────────────────────────
 *
 * `runInstructedTurn` commits its irreversible halves (the order gate, an
 * executed hand-over) BEFORE its last model call, and in LIVE mode a writer
 * failure is re-thrown after them. So "the turn threw" does not mean "nothing
 * happened", and releasing such a job re-runs a turn whose order is already
 * placed. `TurnCommittedError` marks those: they COMPLETE with the failure in
 * the audit, never release for retry. Only a turn that provably wrote nothing
 * releases.
 *
 *   FUTURE LANE AUTHORS: keep the work a job turn can reach comfortably under
 *   ten minutes, or give your lane its own re-lease story. A pulse that fans
 *   out to nine departments and a model call each is exactly the shape that
 *   quietly crosses this line, and the symptom is not an error — it is a job
 *   that runs twice and a report filed twice.
 *
 * ── SPIKE 3's LESSON ────────────────────────────────────────────────────────
 *
 * Declaring `schedule: { cron }` is NOT enough: the tick loop lives in Mastra's
 * WORKERS. `@mastra/express`'s `server.init()` calls `startWorkers()` in this
 * process (src/index.ts), which is why the schedule fires here. ANY future
 * worker-only brain runner — a process without the HTTP server — MUST call
 * `mastra.startWorkers()` itself or the brain silently never wakes. Silent is
 * the dangerous part: nothing errors, jobs simply pile up `due` forever.
 * ~10s lateness on a minute cron is normal (the scheduler ticks every 10s).
 */

import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { resolveDispatchTenants } from "../store/fleet.js";
import { storeFor } from "../store/resolve.js";
import type { StoreClient } from "../store/client.js";
import type { JobKind, NovaJob } from "../store/types.js";
import type { TurnMode, TurnResult } from "../front-office/turn.js";
import { customerPrincipal, tenantAppPrincipal, type NovaSessionContext } from "./principal.js";
import { turnRunRecorder } from "./runs.js";
import { planJob, routeJob, ServerSweepError, type JobPlan } from "./router.js";
import { runInstructedTurn } from "../front-office/turn.js";
import { runPulse } from "./pulse.js";

/** Same as nova-ai. The server caps a claim at 50; 10 keeps a tick bounded. */
export const JOBS_PER_TENANT_PER_TICK = 10;

/**
 * The turn mode job-driven customer turns run in.
 *
 * DEFAULTS TO SHADOW, like every other customer path in this repo (phase C):
 * the brain waking up must not be the thing that flips live traffic on. Set
 * `NOVA_BRAIN_TURN_MODE=live` deliberately, once the phase C/D switches are
 * flipped, and the same gates the live lane already passes apply — the order
 * gate consults authority, the hand-over gate files a real card.
 */
function turnMode(): TurnMode {
  return process.env.NOVA_BRAIN_TURN_MODE === "live" ? "live" : "shadow";
}

/** A lane the registry knows about but nobody has built yet. Releases, never completes. */
export class LaneNotBuiltError extends Error {
  constructor(
    readonly kind: JobKind,
    detail: string,
  ) {
    super(detail);
    this.name = "LaneNotBuiltError";
  }
}

/** A turn that ran but produced nothing because the model call failed. */
export class TurnProducedNothingError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "TurnProducedNothingError";
  }
}

/**
 * THE TURN FAILED WITH ITS WRITES ALREADY ON THE SERVER — so this job may never
 * be retried.
 *
 * `runInstructedTurn` commits its two irreversible halves BEFORE its last model
 * call: the order gate (`hardValidateAndCreate` → a real chat order, or a
 * prepared action on the founder's desk) and `escalate_conversation` (which
 * locks a live thread and queues a real message to a person). In LIVE mode a
 * writer-model failure is re-thrown after both — `front-office/turn.ts` — so a
 * thrown live turn tells us nothing about whether an order was placed.
 *
 * A release requeues the row, and the retry re-runs the whole turn: a second
 * order, or a second hand-over on a thread a person already owns. That is the
 * one outcome this dispatcher may never produce.
 */
export class TurnCommittedError extends Error {
  constructor(detail: string, options?: { cause?: unknown }) {
    super(detail, options);
    this.name = "TurnCommittedError";
  }
}

/**
 * Did this turn put something on the server that a retry would duplicate?
 *
 * All three fields are LIVE-ONLY artifacts of a committed write (shadow records
 * its decision in `wouldHaveDone` and calls nothing): a placed order, the
 * prepared `create_order_from_chat` action awaiting approval, and the executed
 * or blocked `escalate_conversation` row. Exported so the rule can be asserted
 * on its own, without a model.
 */
export function turnCommittedAWrite(
  turn: Pick<TurnResult, "order" | "pendingActionId" | "handoverActionId">,
): boolean {
  return Boolean(turn.order ?? turn.pendingActionId ?? turn.handoverActionId);
}

export interface JobReport {
  storeId: string;
  jobId: string;
  kind: JobKind;
  /** `unleased`: nothing was planned at all, because the row arrived without its fence. */
  lane: "customer_turn" | "founder_plane" | "not_built" | "none" | "routing_fault" | "unleased";
  /** Founder-plane lanes report what their run cost. 0 on a quiet pulse. */
  modelCalls?: number;
  /**
   * A founder-plane lane that found nothing worth saying. Distinct from
   * `silent` (the customer nudge contract) because they are different claims:
   * one is "no message was owed", this one is "the business is fine".
   */
  quiet?: boolean;
  settled:
    | "completed"
    /** The work happened; the server said our lease had already been recovered. NOT a success. */
    | "completed_stale"
    /** The turn failed with writes possibly committed — completed so it can never re-run. */
    | "completed_not_retryable"
    /** A server sweep we refused: completed so the refusal does not spend the row's attempts. */
    | "completed_not_ours"
    | "ack_failed"
    | "released"
    /** The release was a no-op: the row had already moved on to another lease. */
    | "released_stale"
    | "release_failed"
    /** Never ran and never settled — the row arrived without a lease token. */
    | "refused";
  /** dakio-api answered `{ok:true, stale:true}`: this lease was superseded before we settled it. */
  stale?: boolean;
  /** The reply was empty and nothing was owed — the nudge contract. */
  silent?: boolean;
  /** The turn did nothing at all (already answered, thread locked, no inbound). */
  skipped?: string;
  error?: string;
}

export interface TickReport {
  startedAt: string;
  durationMs: number;
  tenants: number;
  /** Tenants whose claim threw or answered with something that is not a job list. */
  claimFailures: number;
  /** Tenants that claimed and then failed OUTSIDE any single job — leases may be dangling. */
  tenantFailures: number;
  claimed: number;
  completed: number;
  released: number;
  /**
   * Settlements the server refused as stale. Each one means the watchdog re-dued
   * a row we still believed we owned — so our work may be duplicated by whoever
   * holds the lease now. A number that stops being zero is a lease-budget alarm.
   */
  stale: number;
  /** Jobs we declined to run at all: no lease token, or a server sweep. */
  refused: number;
  jobs: JobReport[];
  /** Set when the tick did not run at all. */
  skipped?: "disabled";
}

// ---------------------------------------------------------------------------
// One job
// ---------------------------------------------------------------------------

/**
 * The session context a job turn runs under.
 *
 * TWO PRINCIPALS, ON PURPOSE. eve kept `initiator` (who opened the session) and
 * `current` (who is acting) apart because they can legitimately differ, and a
 * job-driven customer turn is the textbook case: the SCHEDULER initiated it, the
 * CUSTOMER conversation is what is current. Reading order is current-then-
 * initiator (`principalAttr`), so the run row gets `storeId`/`conversationId`
 * off the customer principal and `jobId` off the scheduler principal — the
 * mid-run job↔run join (blueprint 17 R1), stamped at turn START rather than
 * waiting for the dispatcher's complete-time `sessionId`.
 *
 * Both principals are non-`"user"` (`customer` / `runtime`), which is what keeps
 * a job turn structurally out of the trust plane whatever a transcript says.
 */
function sessionContextFor(
  storeId: string,
  job: NovaJob,
  plan: JobPlan,
  sessionId: string,
): NovaSessionContext {
  const scheduler = tenantAppPrincipal(storeId, job.id, job.kind);
  if (plan.lane === "customer_turn") {
    return {
      session: {
        id: sessionId,
        auth: {
          current: customerPrincipal(storeId, plan.conversationId, plan.platform),
          initiator: scheduler,
        },
      },
    };
  }
  return { session: { id: sessionId, auth: { current: scheduler, initiator: scheduler } } };
}

/**
 * WHAT A FOUNDER-PLANE LANE REPORTS BACK.
 *
 * Deliberately tiny: the dispatcher settles job rows, it does not summarise
 * business findings. `modelCalls` rides along because it is the number phase E
 * exists to move, and a tick report that carries it makes "a quiet pulse costs
 * nothing" an OBSERVED fact in production rather than a claim in a doc.
 */
interface FounderPlaneRun {
  modelCalls: number;
  /** Nothing worth telling the founder. The pulse's designed success. */
  quiet: boolean;
}

/**
 * The founder-plane runner table, keyed by the registry's workflow id.
 *
 * THE ONE RUN PATH for founder-plane work, exactly as `runInstructedTurn` is
 * the one run path for customer work. A lane that is in `registry.ts` with a
 * `workflow` id but absent here is a LOUD failure (`lane_not_wired`), never a
 * quiet success — a job that completes without running is a row on the
 * founder's board saying the pulse ran.
 *
 * The runners are called directly rather than through
 * `mastra.getWorkflow(id).createRunAsync()`, for two reasons: the workflow
 * module registry imports this file (a cycle), and the customer lane already
 * sets the precedent — the workflow is the Studio surface over the function,
 * and both call the same code.
 *
 * ⚠️ THE TEN-MINUTE LEASE APPLIES HERE TOO. A founder-plane lane that fans out
 * past `LEASE_MINUTES` gets its complete silently no-op'd while the watchdog
 * re-dues the row and another dispatcher re-runs it. The pulse is built to stay
 * far inside that (one round of reads, one small model call per moved
 * department); a lane that cannot be must bring its own re-lease story.
 */
const FOUNDER_PLANE_RUNNERS: Record<string, (storeId: string, job: NovaJob) => Promise<FounderPlaneRun>> = {
  "brain-pulse": async (storeId, job) => {
    const result = await runPulse(storeId, {
      // The job row's dedupe key travels so a re-leased rerun re-files the SAME
      // report row instead of a second one on the founder's dashboard.
      dedupeKey: job.dedupeKey,
      jobId: job.id,
    });
    return { modelCalls: result.modelCalls, quiet: result.quiet };
  },
};

/**
 * Do one claimed job. Resolves with what happened; REJECTS when the job did not
 * happen, which is what the dispatcher's release arm keys on.
 *
 * `async` so a synchronous guard-rail throw becomes a rejection: the caller
 * builds its `.then(ok, fail)` chain around this call, and a sync throw would
 * escape the chain — the release path would never run and sibling jobs in the
 * same claimed batch would keep dangling leases until the watchdog.
 */
/**
 * The audit handle for a turn that has already been settled once. Handed back so
 * the dispatcher can AMEND the run row when the server refuses the settlement —
 * a run that says `completed` about work dakio-api never accepted is exactly the
 * kind of comfortable lie this audit exists to prevent.
 */
interface RunAudit {
  amendFailed: (code: string, message: string) => void;
}

async function performJob(
  storeId: string,
  job: NovaJob,
): Promise<{ sessionId?: string; audit: RunAudit; report: Omit<JobReport, "settled"> }> {
  // Plan first, and PURELY. A throw here is a server sweep or a guard rail —
  // nothing ran, so no run row is opened; the row's own `lastError` is the
  // record. (`routeJob` re-plans below: `planJob` is pure, so the second call
  // costs a switch statement and buys the run audit a lane to be recorded on.)
  const plan = planJob(job);
  const isCustomerLane = plan.lane === "customer_turn";

  // One session per job row (nova-ai's `job:<id>` continuation token), one turn
  // per ATTEMPT — a re-leased retry is a different turn on the same session, and
  // the run audit should show both rather than overwrite the first.
  const sessionId = `job:${job.id}`;
  const turnId = `${job.id}#${job.attempts}`;
  const ctx = sessionContextFor(storeId, job, plan, sessionId);

  // The NovaRun audit (brain/runs.ts). Every handler is fire-and-forget with its
  // own catch — THE AUDIT MUST NEVER FAIL, SLOW OR PARK A TURN — so none of
  // these calls is awaited and none can throw into the work below.
  const runs = turnRunRecorder("job_turn", isCustomerLane ? "customer" : "founder");
  runs.started({ turnId }, ctx);
  // `/runs/finish` is an upsert on (tenant, session, turn), so a second finish
  // REWRITES this turn's outcome rather than adding a row — which is what makes
  // amending honest instead of duplicative. (The usage meter fires on the first
  // `completed` and is not refunded: the turn really did burn the tokens. What
  // changes is the story the row tells about the OUTCOME.)
  const audit: RunAudit = {
    amendFailed: (code, message) => runs.failed({ turnId, code, message }, ctx),
  };

  try {
    const outcome = await routeJob(storeId, job);

    if (outcome.lane === "not_built") {
      // NOT a fake success. Releasing spends an attempt and eventually fails the
      // row with an error naming the missing lane; completing would put "done"
      // on a job nobody did, and the founder's board would say the pulse ran.
      throw new LaneNotBuiltError(outcome.kind, outcome.detail);
    }

    if (outcome.lane === "founder_plane") {
      const run = FOUNDER_PLANE_RUNNERS[outcome.workflow];
      if (!run) {
        // The registry says this lane exists and the dispatcher cannot run it.
        // Same settlement as an unbuilt lane (release, spend an attempt, put the
        // reason on the row), different sentence: the missing half is HERE.
        throw new LaneNotBuiltError(
          outcome.kind,
          `lane_not_wired:${outcome.kind} — the registry declares workflow "${outcome.workflow}", but this ` +
            `dispatcher has no runner for it; add it to FOUNDER_PLANE_RUNNERS (dispatcher.ts), the one run path`,
        );
      }
      // A throw here releases the row with the reason on it, which is right:
      // founder-plane work writes through the same authority gate as everything
      // else, so a lane that failed mid-run has either filed its rows or not —
      // and every row it files is keyed at-most-once, so a retry re-files
      // nothing. (The customer lane's `TurnCommittedError` problem does not
      // arise: nothing here sends a message to a person.)
      const founder = await run(storeId, job);
      runs.completed({ turnId }, ctx);
      return {
        sessionId,
        audit,
        report: {
          storeId,
          jobId: job.id,
          kind: job.kind,
          lane: "founder_plane",
          modelCalls: founder.modelCalls,
          ...(founder.quiet ? { quiet: true } : {}),
        },
      };
    }

    if (outcome.lane === "none") {
      // Nothing left to do and nothing went wrong — a promise-backed follow-up
      // whose debt is gone. Completed WITHOUT a sessionId, exactly as nova-ai
      // completes a `null` dispatch: no session existed, so none is claimed.
      //
      // The run is CANCELLED, not completed: a turn was opened and then called
      // off. "Completed" would put a row in the audit claiming a turn ran, and
      // an audit that says work happened when it did not is worse than no row.
      runs.cancelled({ turnId }, ctx);
      return { audit, report: { storeId, jobId: job.id, kind: job.kind, lane: "none" } };
    }

    const mode = turnMode();
    let turn: TurnResult;
    try {
      turn = await runInstructedTurn(storeId, outcome.conversationId, outcome.instruction, {
        mode,
      });
    } catch (error) {
      // ── THE INVARIANT: NEVER RE-RUN A TURN THAT ALREADY PLACED AN ORDER OR
      //    HANDED A THREAD TO A PERSON. ────────────────────────────────────────
      //
      // A thrown turn carries no result, so there is nothing to inspect — the
      // question is only ever "could it have written?".
      //
      //   SHADOW: provably not. Neither gate is reachable in shadow (turn.ts
      //   records both decisions as `wouldHaveDone` and calls nothing), so a
      //   retry can duplicate nothing. Release it, spend the attempt, let the
      //   row carry the reason. This is the existing behaviour and it stays.
      //
      //   LIVE: not provable, and the two failure modes are not symmetric. The
      //   live writer throw at turn.ts is raised AFTER the order gate and after
      //   an executed `escalate_conversation`. Releasing costs, at worst, a
      //   duplicate order against a customer's money or a second hand-over on a
      //   thread a person is already holding — irreversible, and it reaches
      //   people. Completing costs, at worst, one job that never gets a second
      //   run: the customer goes unanswered on THIS row while the run audit says
      //   `failed` with the real error and the tick report counts it. That is
      //   recoverable by a human and visible to one; the other is neither.
      //
      // So: live throw ⇒ complete-with-error, never release. If turn.ts ever
      // grows a typed "nothing was committed" failure, narrow this — the rule is
      // "release only when it PROVABLY wrote nothing", not "release on shadow".
      //
      // THE ONE CLASS THIS OVER-CATCHES, and why it is acceptable: the seam's
      // BOUNDARY REJECTIONS (`nova instructed turn: …` — an unknown action, an
      // instruction selecting a write gate, a promise not owed on this thread)
      // are raised before a lock is taken, a thread is read or a model is paid,
      // so they provably wrote nothing and would ideally release. They are
      // caught here anyway, and it costs almost nothing:
      //   · they are DETERMINISTIC. A malformed payload does not become
      //     well-formed on the retry, so releasing spends five attempts to reach
      //     the same `failed` row; completing reaches it now.
      //   · the reason is not swallowed either way — the run audit carries it
      //     (`turn_committed_then_failed` plus the seam's own message) and so
      //     does this tick report.
      //   · the router already catches the reachable ones EARLIER, where they
      //     release properly: a mispaired promise throws in `routeJob` (D3) and
      //     the router's action labels are exactly the seam's closed set, so an
      //     instruction from this dispatcher cannot select a write gate.
      // A typed pre-flight rejection from turn.ts would let this branch release
      // them; until there is one, guessing from a message prefix would be a
      // coupling that fails in the dangerous direction the first time the
      // wording changes.
      if (mode === "live") {
        throw new TurnCommittedError(
          `live turn on conversation ${outcome.conversationId} failed after its gates could already have ` +
            `committed (order and/or hand-over) — completing without retry: ` +
            `${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      throw error;
    }

    // The same invariant, for a turn that RETURNED. This mirrors the two throw
    // conditions below EXACTLY, so it can only ever intercept a job that was
    // about to be released — never one that was about to complete normally.
    //
    // Belt-and-braces today: turn.ts sets `silent` only when there is no
    // artifact either, so a turn holding an order/pending/hand-over id cannot
    // reach those throws. But that coupling lives in another file, and these are
    // the only two places a committed write could be thrown away as "nothing
    // happened" — this file must not depend on another file's invariant to keep
    // from re-placing an order.
    const wouldBeReleased =
      Boolean(turn.modelFailure) ||
      Boolean(turn.silent && !turn.skipped && outcome.instruction.owesReply);
    if (wouldBeReleased && turnCommittedAWrite(turn)) {
      throw new TurnCommittedError(
        `turn on conversation ${outcome.conversationId} produced no reply but had already written ` +
          `(${[turn.order && "order", turn.pendingActionId && "pending order action", turn.handoverActionId && "hand-over"]
            .filter(Boolean)
            .join(", ")}) — completing without retry: ${turn.modelFailure ?? "silent"}`,
      );
    }

    // THE HONESTY SEAM between a shadow turn and a job row. In shadow, a model
    // failure is RECORDED rather than thrown, so the shadow dataset keeps the
    // deterministic half of the turn (intent, rung, action, state delta). A JOB
    // row cannot be that generous: a job completed on a turn that produced
    // nothing is a row that says "answered" about a customer who heard nothing,
    // forever. So the turn keeps its record and the job releases.
    if (turn.modelFailure) {
      throw new TurnProducedNothingError(`turn produced no reply — ${turn.modelFailure}`);
    }

    // The same rule one step further out: a turn that OWED an answer and
    // produced nothing at all did not do its job, even though nothing threw.
    // `skipped` is the exception, and the honest one — an already-answered
    // batch or a thread a human took over is work that correctly did not
    // happen. (`silent` is only set when there is no artifact either; see the
    // block that sets it in turn.ts.)
    if (turn.silent && !turn.skipped && outcome.instruction.owesReply) {
      throw new TurnProducedNothingError(
        `turn owed a reply on conversation ${outcome.conversationId} and produced none`,
      );
    }

    runs.completed({ turnId }, ctx);
    return {
      sessionId,
      audit,
      report: {
        storeId,
        jobId: job.id,
        kind: job.kind,
        lane: "customer_turn",
        ...(turn.silent ? { silent: true } : {}),
        ...(turn.skipped ? { skipped: turn.skipped } : {}),
      },
    };
  } catch (error) {
    runs.failed(
      {
        turnId,
        code:
          error instanceof LaneNotBuiltError
            ? "lane_not_built"
            : error instanceof TurnCommittedError
              ? "turn_committed_then_failed"
              : "job_turn_failed",
        message: error instanceof Error ? error.message : String(error),
      },
      ctx,
    );
    throw error;
  }
}

// ---------------------------------------------------------------------------
// One tick
// ---------------------------------------------------------------------------

export interface TickOptions {
  /** Test seam: run a fixed tenant set instead of resolving the fleet. */
  tenantIds?: string[];
  /** Test seam: resolve clients through something other than `storeFor`. */
  clientFor?: (storeId: string) => StoreClient;
  limit?: number;
}

/**
 * Did dakio-api answer this settlement with `{ok:true, stale:true}`?
 *
 * THE SERVER'S ONLY WAY OF TELLING US OUR LEASE IS GONE. Both `complete` and
 * `release` answer HTTP 200 with `stale:true` when the row no longer carries our
 * fencing token (novaJobs.js ~:1970 and ~:2018) — the watchdog re-dued it while
 * we were working, and another dispatcher may already own it. A 200 that reads
 * as success is exactly how this signal gets dropped, which is what happened
 * one layer down.
 *
 * `StoreClient.completeJob`/`releaseJob` now resolve `JobSettleResult`
 * (`{ok:true, stale}`), which is what this reads. It is written STRUCTURALLY
 * rather than as `settlement.stale` so that a client which cannot tell us —
 * anything still resolving `void`, in this repo or a test double — reads as
 * "not stale" instead of throwing on a property access. Absence of the flag is
 * the only safe default: it settles the row the way the caller intended.
 */
function wasStale(settlement: unknown): boolean {
  return (
    typeof settlement === "object" &&
    settlement !== null &&
    (settlement as { stale?: unknown }).stale === true
  );
}

/** The durable record for a job we refused to run — see the two call sites. */
function recordRefusal(storeId: string, job: NovaJob, code: string, message: string): void {
  // Console alone reaches nobody in production (no CaptureConsole integration
  // on either side), and BOTH refusals below leave the job row itself unable to
  // carry the reason: an unleased row cannot be written to at all, and a refused
  // sweep is completed, which takes no `error`. So the run audit is the only
  // durable place this fact can live.
  // The FOUNDER lane, deliberately, even for a conversation-bound kind: no
  // customer turn was opened, and dakio-api keys its failed-customer-turn
  // recovery off `kind: customer_turn` + `lane: customer` (novaRuns.js). A
  // refusal must not look like a customer turn that died holding a message.
  const scheduler = tenantAppPrincipal(storeId, job.id, job.kind);
  const ctx: NovaSessionContext = {
    session: { id: `job:${job.id}`, auth: { current: scheduler, initiator: scheduler } },
  };
  turnRunRecorder("job_turn", "founder").failed({ turnId: `${job.id}#${job.attempts}`, code, message }, ctx);
}

/**
 * One heartbeat. Exported so tests and the live drill can run exactly one tick
 * without waiting on a cron, and so a future worker-only runner has something
 * to call.
 */
export async function runDispatchTick(opts: TickOptions = {}): Promise<TickReport> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const report: TickReport = {
    startedAt,
    durationMs: 0,
    tenants: 0,
    claimFailures: 0,
    tenantFailures: 0,
    claimed: 0,
    completed: 0,
    released: 0,
    stale: 0,
    refused: 0,
    jobs: [],
  };

  // An operator switch that needs no deploy. A scheduled workflow starts
  // claiming the moment it ships, and "turn the brain off" must not mean
  // "revert the service".
  if (process.env.NOVA_BRAIN_DISPATCH === "off") {
    report.skipped = "disabled";
    report.durationMs = Date.now() - t0;
    return report;
  }

  const clientFor = opts.clientFor ?? storeFor;
  const limit = opts.limit ?? JOBS_PER_TENANT_PER_TICK;
  const tenantIds = opts.tenantIds ?? (await resolveDispatchTenants()).map((t) => t.storeId);
  report.tenants = tenantIds.length;

  // ── FAULT ISOLATION IS PER TENANT, AND IT IS THE WHOLE BODY ────────────────
  //
  // `allSettled`, not `all`. `Promise.all` rejects on the FIRST rejection, so a
  // single tenant's fault used to abort `runDispatchTick` itself and every other
  // tenant's due jobs went unclaimed for that minute — the fleet losing a
  // heartbeat because one store answered badly. The reproduction was not even a
  // throw: a client that RESOLVED with a non-array made `jobs.length` NaN and
  // `jobs.map` a TypeError, both of which sat OUTSIDE the try that guarded the
  // claim. The isolation therefore has to cover the whole per-tenant body, not
  // the one call that was expected to fail; anything narrower is a promise that
  // the next unexpected shape will break again.
  const settled = await Promise.allSettled(
    tenantIds.map((storeId) => runTenantTick(storeId, clientFor, limit, report)),
  );
  for (const outcome of settled) {
    // Belt and braces: `runTenantTick` is total by construction. If that ever
    // stops being true, the fleet still finishes its tick and says so.
    if (outcome.status === "rejected") {
      report.tenantFailures += 1;
      console.error("[nova:brain] tenant tick rejected — this should be unreachable:", outcome.reason);
    }
  }

  report.durationMs = Date.now() - t0;
  return report;
}

/**
 * One tenant's whole tick: claim through THAT TENANT'S OWN client, then settle
 * each claimed job. Total — it records faults on the report and never rejects,
 * because a sibling tenant's minute must not depend on this one.
 */
async function runTenantTick(
  storeId: string,
  clientFor: (storeId: string) => StoreClient,
  limit: number,
  report: TickReport,
): Promise<void> {
  // THIS TENANT'S OWN CLIENT, hence this tenant's own service token. One claim
  // per tenant; nothing here ever holds two tenants' credentials.
  const client = clientFor(storeId);
  let jobs: NovaJob[];
  try {
    jobs = await client.claimDueJobs(limit);
    // A claim that answers with something that is not a job list is a broken
    // contract, and it is CAUGHT LIKE A THROWN CLAIM rather than trusted one
    // line later: the whole point of validating here is that the failure lands
    // as this tenant's counted claim failure instead of the fleet's exception.
    if (!Array.isArray(jobs)) {
      throw new TypeError(
        `claimDueJobs answered with ${jobs === null ? "null" : typeof jobs}, not an array of jobs`,
      );
    }
  } catch (error) {
    // Swallowed on purpose: a transient failure for one tenant must never block
    // another tenant's tick. Retried next minute (dakio-api counts it as
    // `nova.claim.failed`).
    report.claimFailures += 1;
    console.warn(`[nova:brain] claim failed for ${storeId} (other tenants unaffected):`, error);
    return;
  }

  report.claimed += jobs.length;

  try {
    // `allSettled` again, one level down and for the same reason: `settleJob` is
    // total, but a sibling job in this batch must not lose its settlement — and
    // an unsettled job means a lease dangling until the watchdog.
    const done = await Promise.allSettled(jobs.map((job) => settleJob(storeId, client, job, report)));
    for (const outcome of done) {
      if (outcome.status === "rejected") {
        report.tenantFailures += 1;
        console.error(`[nova:brain] job settlement rejected for ${storeId} (unreachable):`, outcome.reason);
      }
    }
  } catch (error) {
    // Reached only if `jobs.map` itself throws (a claim answering with an
    // array-like of hostile getters). The leases this tenant just took are
    // dangling until the watchdog; that is a counted fault, not a fleet outage.
    report.tenantFailures += 1;
    console.error(`[nova:brain] tenant tick failed after claiming for ${storeId}:`, error);
  }
}

/**
 * Run one claimed job and settle it truthfully. Total: every path ends in a
 * `report.jobs` entry, and nothing here rejects.
 */
async function settleJob(
  storeId: string,
  client: StoreClient,
  job: NovaJob,
  report: TickReport,
): Promise<void> {
  // ── THE FENCE HAS TO EXIST BEFORE THE WORK RUNS ───────────────────────────
  //
  // `NovaJob.leaseToken` is `string | null`, and dakio-api hard-rejects an empty
  // token with 422 on BOTH complete and release. The old `job.leaseToken ?? ""`
  // ran the turn anyway and then discovered it could not report the outcome —
  // and the ok-arm swallows a failed complete as `ack_failed` by design, so the
  // symptom was invisible: the row stays leased, the watchdog re-dues it, and
  // the customer is answered a second time by the next dispatcher.
  //
  // A claimed job without its fencing token is a broken contract on the claim
  // response. Refuse it: do not run work we are structurally unable to settle,
  // and say so where somebody can see it.
  const leaseToken = job.leaseToken;
  if (typeof leaseToken !== "string" || leaseToken.length === 0) {
    const message =
      `[nova:brain] job ${job.id} (${job.kind}) was claimed for ${storeId} WITHOUT a lease token. ` +
      `The token is the fence: complete and release both 422 without it, so this job could be run but ` +
      `never settled — the row would stay leased until the watchdog re-dued it and the work would be ` +
      `done twice. Refusing to run it. dakio-api's claim always stamps a fresh token, so this is a ` +
      `claim-response contract violation, not a transient fault.`;
    console.error(message);
    recordRefusal(storeId, job, "job_without_lease_token", message);
    report.refused += 1;
    report.jobs.push({
      storeId,
      jobId: job.id,
      kind: job.kind,
      lane: "unleased",
      settled: "refused",
      error: message,
    });
    return;
  }

  // THE TRY WRAPS ONLY THE WORK — NEVER THE ACK. (This was a two-argument
  // `.then(ok, fail)` for the same reason.) Collapsing the two would route an
  // ACK FAILURE into the release arm: `completeJob` rejecting means dakio-api
  // was unreachable for a moment, NOT that the work failed — the turn already
  // happened and the customer already has the draft. Releasing finished work
  // requeues it (or fails it at the attempts cap), so the customer gets answered
  // twice for a network blip.
  let done: Awaited<ReturnType<typeof performJob>>;
  try {
    done = await performJob(storeId, job);
  } catch (error) {
    await settleFailedJob(storeId, client, job, leaseToken, error, report);
    return;
  }

  const { sessionId, audit, report: base } = done;
  try {
    const ack = await client.completeJob(job.id, leaseToken, sessionId);
    if (wasStale(ack)) {
      // OUR LEASE WAS RECOVERED WHILE WE WORKED. The row moved on: it was
      // re-dued and may already have been re-run by another dispatcher, so this
      // turn's work is orphaned and possibly duplicated. It is emphatically not
      // a completion — the server did not accept our outcome — and the run row
      // is amended from `completed` to say so, because "completed" here means
      // "the audit and the job table disagree about whether this customer was
      // answered once or twice".
      report.stale += 1;
      const message =
        `job ${job.id} completed against a SUPERSEDED lease (server answered stale) — the watchdog ` +
        `re-dued this row mid-turn; any work this turn did may be duplicated by whoever holds the ` +
        `lease now`;
      audit.amendFailed("lease_lost", message);
      report.jobs.push({ ...base, settled: "completed_stale", stale: true, error: message });
      console.warn(`[nova:brain] ${message}`);
      return;
    }
    report.completed += 1;
    report.jobs.push({ ...base, settled: "completed" });
  } catch (error) {
    // SWALLOWED. See above — the work succeeded.
    report.jobs.push({
      ...base,
      settled: "ack_failed",
      error: error instanceof Error ? error.message : String(error),
    });
    console.warn(`[nova:brain] complete ACK failed for job ${job.id} (work already done):`, error);
  }
}

/**
 * Settle a job whose turn did NOT happen — or happened and may not be repeated.
 *
 * Three answers, and which one applies is a property of the error, never of the
 * job kind:
 *
 *  · RELEASE — the default and the honest one. Nothing ran (a guard rail, an
 *    unbuilt lane) or the turn provably wrote nothing, so spend an attempt, put
 *    the reason on the row where an operator reads it, and let it come back.
 *  · COMPLETE, NOT OURS — a server sweep. See below.
 *  · COMPLETE, NOT RETRYABLE — the turn may already have placed an order or
 *    handed the thread to a person (`TurnCommittedError`). Retrying is the one
 *    outcome worse than not retrying.
 */
async function settleFailedJob(
  storeId: string,
  client: StoreClient,
  job: NovaJob,
  leaseToken: string,
  error: unknown,
  report: TickReport,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const lane: JobReport["lane"] =
    error instanceof LaneNotBuiltError
      ? "not_built"
      : error instanceof TurnProducedNothingError || error instanceof TurnCommittedError
        ? "customer_turn"
        : "routing_fault";
  const base = { storeId, jobId: job.id, kind: job.kind, lane, error: message };

  /**
   * Settle a failure by COMPLETING the row — the two cases below where releasing
   * would do harm. The failure itself is already recorded (run audit + `base`);
   * this decides only that the row must not come back.
   */
  const completeInstead = async (
    settled: "completed_not_ours" | "completed_not_retryable",
    whenUnsettled: string,
  ): Promise<void> => {
    try {
      const ack = await client.completeJob(job.id, leaseToken);
      if (wasStale(ack)) {
        // The row was already somebody else's — which for both cases below means
        // the decision was made for us, and not the way we wanted it.
        report.stale += 1;
        report.jobs.push({ ...base, settled: "completed_stale", stale: true });
        return;
      }
      report.jobs.push({ ...base, settled });
    } catch (completeError) {
      report.jobs.push({
        ...base,
        settled: "ack_failed",
        error: `${message} (complete also failed: ${
          completeError instanceof Error ? completeError.message : String(completeError)
        })`,
      });
      console.error(`[nova:brain] ${whenUnsettled}`, completeError);
    }
  };

  // ── A SWEEP IS NOT OURS TO RUN — AND NOT OURS TO FAIL ─────────────────────
  //
  // dakio-api leases the nine server sweeps inside its own claim transaction and
  // runs them itself; one reaching this dispatcher means the routing broke
  // server-side. Refusing loudly is right. RELEASING the refusal was not:
  // `attempts` is incremented at CLAIM time and `release` never gives it back
  // (novaJobs.js ~:2014 re-dues with backoff, and at `attempts >= MAX_ATTEMPTS`
  // marks the row `failed`). So a mis-routed sweep we release is re-claimed,
  // re-refused and re-released every backoff until the server's own bookkeeping
  // row dies `failed` with our error on it — we would be corrupting the
  // server's ladder to report that the server has a bug, and the resulting
  // `failed` sweep row looks exactly like a sweep that genuinely broke.
  //
  // Complete instead. It costs that ONE occurrence (the next cadence mints a
  // fresh row under a new `dedupeKey`), it is invisible on the founder's board
  // (sweeps map to `department: null`, so dakio-api emits no room event for
  // them and the room feed never lights up), and it leaves the ladder exactly
  // where the server put it. The loudness moves to where it survives: the
  // router's `console.error`, the run audit row written here, and this tick
  // report — none of which is a fake sweep alarm.
  if (error instanceof ServerSweepError) {
    console.error(`[nova:brain] refusing server sweep ${job.kind} (job ${job.id}) — completing as not-ours`);
    recordRefusal(storeId, job, "server_sweep_misrouted", message);
    report.refused += 1;
    // Not settling is the tolerable failure here: the lease expires, the
    // watchdog re-dues the row, and the sweep is back where it started rather
    // than one attempt closer to `failed`.
    await completeInstead("completed_not_ours", `sweep refusal could not be settled for job ${job.id}:`);
    return;
  }

  // A turn whose writes are already on the server. Completing is not a claim
  // that the work succeeded — the run audit carries `turn_committed_then_failed`
  // and the real error, and this report carries it too. It is a claim that this
  // row must never run again.
  if (error instanceof TurnCommittedError) {
    console.error(`[nova:brain] job ${job.id} failed AFTER committing — completing without retry: ${message}`);
    // A complete we cannot land leaves the lease to expire, and the watchdog
    // re-dues the row — which is the very retry this branch exists to prevent.
    // Nothing better is available from this side (the server owns the row), so
    // it is logged at error level rather than warned.
    await completeInstead(
      "completed_not_retryable",
      `job ${job.id} committed writes and could NOT be completed — the watchdog will re-due it:`,
    );
    return;
  }

  try {
    const ack = await client.releaseJob(job.id, leaseToken, message);
    if (wasStale(ack)) {
      // Nothing was requeued: the row had already been recovered and re-dued by
      // the watchdog, so counting this as a release would overstate the retry
      // ladder. The run audit already records this turn as failed — accurately —
      // so there is nothing there to amend, unlike the complete path.
      report.stale += 1;
      report.jobs.push({ ...base, settled: "released_stale", stale: true });
      console.warn(`[nova:brain] release for job ${job.id} was stale — the row moved on without us`);
      return;
    }
    report.released += 1;
    report.jobs.push({ ...base, settled: "released" });
  } catch (releaseError) {
    // The lease simply expires and the watchdog re-dues the row — there is
    // nothing better to do, and throwing here would take out the whole tenant's
    // batch.
    report.jobs.push({
      ...base,
      settled: "release_failed",
      error: `${message} (release also failed: ${
        releaseError instanceof Error ? releaseError.message : String(releaseError)
      })`,
    });
    console.error(`[nova:brain] release failed for job ${job.id}:`, releaseError);
  }
}

// ---------------------------------------------------------------------------
// The Mastra scheduled workflow — the one clock the brain has
// ---------------------------------------------------------------------------

const tickStep = createStep({
  id: "tick",
  inputSchema: z.object({}).passthrough(),
  outputSchema: z.object({
    startedAt: z.string(),
    durationMs: z.number(),
    tenants: z.number(),
    claimFailures: z.number(),
    tenantFailures: z.number(),
    claimed: z.number(),
    completed: z.number(),
    released: z.number(),
    stale: z.number(),
    refused: z.number(),
    skipped: z.string().optional(),
  }),
  execute: async () => {
    const report = await runDispatchTick();
    // The per-job detail stays out of the workflow output on purpose: it is
    // per-tenant data, and a Studio run record is a fleet-wide surface.
    const { jobs: _jobs, ...summary } = report;
    if (summary.claimed > 0 || summary.claimFailures > 0 || summary.tenantFailures > 0) {
      console.info(
        `[nova:brain] tick: ${summary.tenants} tenants, ${summary.claimed} claimed, ` +
          `${summary.completed} completed, ${summary.released} released, ` +
          `${summary.stale} stale, ${summary.refused} refused, ` +
          `${summary.claimFailures} claim failures, ${summary.tenantFailures} tenant failures, ` +
          `${summary.durationMs}ms`,
      );
    }
    // Counted separately from the line above because each one is a fleet-level
    // alarm rather than a job outcome: a stale settlement means work is being
    // done against leases we no longer hold, and a refusal means the claim
    // handed us something we may not run.
    if (summary.stale > 0 || summary.refused > 0) {
      console.error(
        `[nova:brain] tick: ${summary.stale} settlement(s) refused as STALE (lease recovered mid-turn), ` +
          `${summary.refused} job(s) refused (no lease token, or a server sweep)`,
      );
    }
    return summary;
  },
});

/**
 * The dispatcher tick. ONE scheduled trigger for the whole brain — everything
 * else is data with a due time, owned by dakio-api (doc 06: cadences live in
 * founder-editable `nova_job_defs`, in the tenant's own timezone; Mastra never
 * holds a second copy).
 *
 * Overlapping ticks are safe BY CONSTRUCTION, not by scheduler politeness:
 * dakio-api's `SELECT … FOR UPDATE SKIP LOCKED` plus per-lease fencing tokens
 * make double-claiming impossible. The safety lives in the database.
 */
export const brainDispatchWorkflow = createWorkflow({
  id: "brain-dispatch",
  description:
    "The brain's heartbeat: every minute, per tenant, claim due jobs through that tenant's own token and route each to its lane.",
  inputSchema: z.object({}).passthrough(),
  outputSchema: tickStep.outputSchema,
  schedule: { cron: "* * * * *" },
})
  .then(tickStep)
  .commit();
