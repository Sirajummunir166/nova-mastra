/**
 * The shadow-diff dataset — one row per shadow customer turn.
 *
 * Phase C runs the front-office pipeline against real inbox traffic in
 * OBSERVE-ONLY mode; this table is what the phase gate reads to compare
 * Nova-mastra's drafts against what nova-ai actually sent. Same optional-pg
 * pattern as `eve-compat/persistence.ts`: pool + create-if-missing on first
 * use via NOVA_PG_URL, and a warned no-op when it is unset — a missing
 * database must never break the ingress, only the dataset.
 *
 * Nothing in this module sends anything anywhere. It is a write-only audit.
 */

import pg from "pg";

export interface ShadowTurnRow {
  storeId: string;
  conversationId: string;
  /** dakio-api's session roll — the state partition this turn ran in. */
  epoch: number;
  inboundText: string | null;
  draftReply: string | null;
  intent: string | null;
  rung: number | null;
  action: string | null;
  stage: string | null;
  /**
   * The write the turn decided on but (being shadow) did not perform — plus
   * any degradation worth diffing (`modelFailure`, `skipped`, `error`).
   */
  wouldHaveDone: Record<string, unknown> | null;
  timings: Record<string, number> | null;
  modelCalls: number;
}

const PG_URL = process.env.NOVA_PG_URL;

let pool: pg.Pool | null = null;
let ready: Promise<void> | null = null;
let unsetWarned = false;

export function shadowLogEnabled(): boolean {
  return Boolean(PG_URL);
}

/** Lazily create the pool + table; resolves when the table exists. */
function ensureReady(): Promise<void> {
  if (!ready) {
    pool = new pg.Pool({ connectionString: PG_URL });
    ready = pool
      .query(
        `CREATE TABLE IF NOT EXISTS nova_shadow_turns (
           id serial PRIMARY KEY,
           store_id text NOT NULL,
           conversation_id text NOT NULL,
           epoch integer NOT NULL DEFAULT 0,
           inbound_text text,
           draft_reply text,
           intent text,
           rung integer,
           action text,
           stage text,
           would_have_done jsonb,
           timings jsonb,
           model_calls integer NOT NULL DEFAULT 0,
           created_at timestamptz NOT NULL DEFAULT now()
         )`,
      )
      .then(() => undefined);
  }
  return ready;
}

/**
 * Append one shadow-turn row. Never throws: the ingress already 202'd and a
 * logging failure must not look like a turn failure — it is logged and the
 * row is lost, which is a MISSED observation, never a wrong one.
 */
export async function recordShadowTurn(row: ShadowTurnRow): Promise<void> {
  if (!PG_URL) {
    if (!unsetWarned) {
      unsetWarned = true;
      console.warn("[shadow-log] NOVA_PG_URL not set — shadow turns are NOT being recorded (the phase C gate reads this dataset)");
    }
    return;
  }
  try {
    await ensureReady();
    await pool!.query(
      `INSERT INTO nova_shadow_turns
         (store_id, conversation_id, epoch, inbound_text, draft_reply, intent, rung, action, stage,
          would_have_done, timings, model_calls)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12)`,
      [
        row.storeId,
        row.conversationId,
        row.epoch,
        row.inboundText,
        row.draftReply,
        row.intent,
        row.rung,
        row.action,
        row.stage,
        row.wouldHaveDone ? JSON.stringify(row.wouldHaveDone) : null,
        row.timings ? JSON.stringify(row.timings) : null,
        row.modelCalls,
      ],
    );
  } catch (err) {
    console.warn(`[shadow-log] failed to record shadow turn for ${row.storeId}:${row.conversationId}:`, err);
  }
}
