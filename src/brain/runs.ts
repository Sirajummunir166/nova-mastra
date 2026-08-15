/**
 * The per-turn run audit — this service's half of the NovaRun table.
 * Ported from nova-ai `agent/lib/runs.ts`.
 *
 * Every lane wires these handlers into its turn lifecycle, so the lifecycle
 * itself is what writes the audit: `started` opens a `running` row,
 * `completed|failed|cancelled` settles it. This is the record the ledger
 * tables cannot provide — NovaAction only sees gated mutations and
 * NovaActivity only notable outcomes, so without this a customer turn that
 * crashed or chose silence leaves ZERO rows anywhere (in eve, `turn.failed`
 * was literally discarded).
 *
 * Every write is fire-and-forget with its own catch: THE AUDIT MUST NEVER
 * FAIL, SLOW, OR PARK A TURN. A `running` row whose finish write was lost is
 * the honest record of exactly that — the server side deliberately never
 * reaps them.
 *
 * The join key is the session id: NovaJob.sessionId (stamped by the dispatcher
 * at complete time) ties a run to its scheduled job — job rows, ledger rows
 * and traces become one story.
 *
 * ── PORT NOTES ──────────────────────────────────────────────────────────────
 *
 * 1. eve's `SessionContext` → `NovaSessionContext` (brain/principal.ts), the
 *    plain `{session:{id, auth}}` object our dispatcher passes. The attribute
 *    reader (current-then-initiator, string-or-single-element-array) moved to
 *    `principalAttr` there rather than being duplicated here as it was in
 *    nova-ai.
 *
 * 2. `turnTiming.ts` IS NOT PORTED YET, so `beginTurn`/`finishTurn` and the
 *    `measured()` fold have no counterpart. Rather than fake the measurement
 *    block, the recorder takes an optional `measure` hook: give it one and the
 *    timing/usage/actionIds ride along exactly as before; give it nothing and
 *    the finish payload simply omits them. That is not a downgrade in
 *    correctness — dakio-api treats an absent block as "no measurement" and
 *    settles the run exactly as it did before (see `RunFinishInput`'s comment
 *    in store/client.ts, written so either repo can roll back independently).
 *    What IS lost until `turnTiming` ports is the data, and this comment is
 *    the record of that debt.
 *
 * 3. eve called the four handlers with `(data, ctx)`; nothing here depends on
 *    that calling convention beyond the shape of `data`, so the returned object
 *    is a plain map of four functions any dispatcher can call directly.
 */

import { storeFor } from "../store/resolve.js";
import type { StoreClient, RunFinishInput } from "../store/client.js";
import { principalAttr, type NovaSessionContext } from "./principal.js";

export type RunKind = "customer_turn" | "founder_turn" | "job_turn";
export type RunLane = "customer" | "founder";

/**
 * Optional per-turn measurement, the seam nova-ai's `turnTiming.ts` fills.
 *
 * Returning `null` (or having no hook at all) means "no measurement" and is a
 * first-class answer, not an error path. A hook that throws is caught by the
 * caller below and treated as `null` — a broken measurement must not cost a
 * run row, let alone a turn.
 */
export type TurnMeasure = (turnId: string) => Partial<RunFinishInput> | null;

export interface RunRecorderOptions {
  /** Called on turn open, before the audit write is scheduled. */
  onTurnStart?: (turnId: string) => void;
  /** Called on turn settle, BEFORE the write is scheduled — see `finish` below. */
  measure?: TurnMeasure;
}

/**
 * Schedule one audit write. Total: it never throws, never returns a promise the
 * turn could await, and never rejects — the two catch sites below are the whole
 * point of this function existing separately from its callers.
 */
function record(
  ctx: NovaSessionContext,
  write: (
    client: StoreClient,
    base: { sessionId: string; conversationId?: string; jobId?: string },
  ) => Promise<void>,
): void {
  try {
    const storeId = principalAttr(ctx.session.auth, "storeId");
    if (!storeId) return; // no tenant, no tenant-scoped audit row — nothing to write against
    const conversationId = principalAttr(ctx.session.auth, "conversationId");
    // Stamped from the scheduler principal's attributes (blueprint 17 R1):
    // NovaRun.jobId is the mid-run job↔run join — the dispatcher's own
    // sessionId stamp on the job row only lands at complete time.
    const jobId = principalAttr(ctx.session.auth, "jobId");
    void write(storeFor(storeId), {
      sessionId: ctx.session.id,
      ...(conversationId ? { conversationId } : {}),
      ...(jobId ? { jobId } : {}),
    }).catch((error) => {
      console.warn("[nova:runs] audit write failed (turn unaffected)", error);
    });
  } catch (error) {
    // Covers everything synchronous: a missing/misconfigured backend in
    // `storeFor` (which throws when DAKIO_API_URL is unset), a malformed auth
    // bag, a `write` that throws before returning its promise.
    console.warn("[nova:runs] audit write skipped", error);
  }
}

/** Run the optional measure hook without letting it reach the turn. */
function measured(turnId: string, measure?: TurnMeasure): Partial<RunFinishInput> {
  if (!measure) return {};
  try {
    return measure(turnId) ?? {};
  } catch (error) {
    console.warn("[nova:runs] turn measurement failed (run still recorded)", error);
    return {};
  }
}

/**
 * Build the four turn-lifecycle handlers for one lane. Spread the result into
 * (or call from) the lane's own lifecycle — handlers are additive and never
 * throw, so composing them with a lane's existing handlers is safe.
 */
export function turnRunRecorder(kind: RunKind, lane: RunLane, opts: RunRecorderOptions = {}) {
  const finish = (
    outcome: "completed" | "failed" | "cancelled",
    data: { turnId: string },
    ctx: NovaSessionContext,
    extra: Partial<RunFinishInput> = {},
  ): void => {
    // Read BEFORE the write is scheduled: `record` is fire-and-forget, and the
    // report must be captured on this tick regardless of what the network does
    // afterwards.
    const report = measured(data.turnId, opts.measure);
    record(ctx, (client, base) =>
      client.recordRunFinish({
        ...base,
        turnId: data.turnId,
        kind,
        lane,
        outcome,
        ...extra,
        ...report,
      }),
    );
  };

  return {
    started(data: { turnId: string }, ctx: NovaSessionContext): void {
      // Open the measurement scratch on the same event that opens the audit
      // row, so the two can never describe different turns.
      try {
        opts.onTurnStart?.(data.turnId);
      } catch (error) {
        console.warn("[nova:runs] turn-start hook failed (run still recorded)", error);
      }
      record(ctx, (client, base) =>
        client.recordRunStart({ ...base, turnId: data.turnId, kind, lane }),
      );
    },
    completed(data: { turnId: string }, ctx: NovaSessionContext): void {
      finish("completed", data, ctx);
    },
    failed(data: { turnId: string; code: string; message: string }, ctx: NovaSessionContext): void {
      // A failed turn is measured too. Doc 05 Part I wants to know where time
      // goes, and a turn that burned 40s before dying is exactly the case the
      // ladder exists to surface.
      finish("failed", data, ctx, { error: `${data.code}: ${data.message}`.slice(0, 2000) });
    },
    cancelled(data: { turnId: string }, ctx: NovaSessionContext): void {
      finish("cancelled", data, ctx);
    },
  };
}
