/**
 * Optional Postgres persistence for eve-compat sessions.
 *
 * Enabled when NOVA_PG_URL is set; otherwise every export is a no-op and
 * sessions live only in the process Map (a restart loses them — the
 * pre-persistence behavior). One table, created on first use:
 *
 *   nova_eve_sessions(id, store_id, user_id, role, continuation_token,
 *                     history jsonb, events jsonb, turn_active,
 *                     last_activity, event_base)
 *
 * `event_base` is the restart-cursor bridge: it records how many events the
 * client could have consumed at last save (eventBase + events.length). After
 * a restore the in-memory events array starts EMPTY, and the stream handler
 * subtracts event_base from the client's cursor so an old cursor maps onto
 * the fresh array's origin (see sessions.ts / router.ts).
 *
 * Writes are serialized per session id: saveSession snapshots the row
 * synchronously and chains the write onto the previous one, so two
 * fire-and-forget saves can never land out of order.
 */

import pg from "pg";
import type { EveSession, ChatMessage, EveEvent } from "./sessions.js";

export interface SessionRow {
  id: string;
  store_id: string;
  user_id: string | null;
  role: string | null;
  continuation_token: string;
  history: ChatMessage[];
  events: EveEvent[];
  turn_active: boolean;
  last_activity: Date;
  event_base: number;
}

const PG_URL = process.env.NOVA_PG_URL;

let pool: pg.Pool | null = null;
let ready: Promise<void> | null = null;

if (!PG_URL) {
  console.warn("[eve-compat] NOVA_PG_URL not set — sessions are in-memory only and will not survive a restart");
}

export function persistenceEnabled(): boolean {
  return Boolean(PG_URL);
}

/** Lazily create the pool + table; resolves when the table exists. */
function ensureReady(): Promise<void> {
  if (!ready) {
    pool = new pg.Pool({ connectionString: PG_URL });
    ready = pool
      .query(
        `CREATE TABLE IF NOT EXISTS nova_eve_sessions (
           id text PRIMARY KEY,
           store_id text NOT NULL,
           user_id text,
           role text,
           continuation_token text NOT NULL,
           history jsonb NOT NULL DEFAULT '[]',
           events jsonb NOT NULL DEFAULT '[]',
           turn_active boolean NOT NULL DEFAULT false,
           last_activity timestamptz NOT NULL,
           event_base integer NOT NULL DEFAULT 0
         )`,
      )
      .then(() => undefined);
  }
  return ready;
}

export async function loadSession(id: string): Promise<SessionRow | null> {
  if (!PG_URL) return null;
  await ensureReady();
  const result = await pool!.query<SessionRow>("SELECT * FROM nova_eve_sessions WHERE id = $1", [id]);
  return result.rows[0] ?? null;
}

// Per-session write chains — see module doc.
const writeChains = new Map<string, Promise<void>>();

function enqueue(id: string, write: () => Promise<void>): Promise<void> {
  const chained = (writeChains.get(id) ?? Promise.resolve()).catch(() => undefined).then(write);
  writeChains.set(id, chained);
  // Drop the chain entry once this write is the tail and has settled.
  void chained.finally(() => {
    if (writeChains.get(id) === chained) writeChains.delete(id);
  });
  return chained;
}

/** Upsert the full session row. Snapshot is taken synchronously at call time. */
export function saveSession(session: EveSession): Promise<void> {
  if (!PG_URL) return Promise.resolve();
  const row = {
    id: session.id,
    storeId: session.storeId,
    userId: session.userId,
    role: session.role,
    continuationToken: session.continuationToken,
    history: JSON.stringify(session.history),
    events: JSON.stringify(session.events),
    turnActive: session.turnActive,
    lastActivity: new Date(session.lastActivityMs),
    eventBase: session.eventBase + session.events.length,
  };
  return enqueue(session.id, async () => {
    await ensureReady();
    await pool!.query(
      `INSERT INTO nova_eve_sessions
         (id, store_id, user_id, role, continuation_token, history, events, turn_active, last_activity, event_base)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10)
       ON CONFLICT (id) DO UPDATE SET
         store_id = EXCLUDED.store_id,
         user_id = EXCLUDED.user_id,
         role = EXCLUDED.role,
         continuation_token = EXCLUDED.continuation_token,
         history = EXCLUDED.history,
         events = EXCLUDED.events,
         turn_active = EXCLUDED.turn_active,
         last_activity = EXCLUDED.last_activity,
         event_base = EXCLUDED.event_base`,
      [
        row.id,
        row.storeId,
        row.userId,
        row.role,
        row.continuationToken,
        row.history,
        row.events,
        row.turnActive,
        row.lastActivity,
        row.eventBase,
      ],
    );
  });
}

export function deleteSession(id: string): Promise<void> {
  if (!PG_URL) return Promise.resolve();
  return enqueue(id, async () => {
    await ensureReady();
    await pool!.query("DELETE FROM nova_eve_sessions WHERE id = $1", [id]);
  });
}
