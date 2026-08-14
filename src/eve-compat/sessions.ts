/**
 * In-memory session store for the eve compatibility layer.
 *
 * The merchant app's `novaAgentClient.js` speaks eve's session protocol:
 * a session id + a continuation token that rotates every turn, and an
 * append-only NDJSON event log addressed by index (`stream?startIndex=N`).
 * The client counts every non-empty line it consumes and resumes from that
 * cursor next turn, so the event log ordering is load-bearing: events are
 * append-only and never reordered or dropped.
 */

import { EventEmitter } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { loadSession, saveSession, deleteSession, persistenceEnabled } from "./persistence.js";

export interface EveEvent {
  type: string;
  data?: Record<string, unknown>;
}

export type ChatMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string };

export interface EveSession {
  id: string;
  storeId: string;
  userId: string;
  role: string;
  continuationToken: string;
  events: EveEvent[];
  history: ChatMessage[];
  turnActive: boolean;
  lastActivityMs: number;
  /**
   * Number of events the client may already have consumed under this session
   * id BEFORE this process's `events` array existed. 0 for sessions created
   * in-process; after a pg restore it is the persisted `event_base`, and the
   * stream handler maps the client's cursor to `startIndex - eventBase` so an
   * old cursor lands on the fresh (empty) array's origin instead of waiting
   * forever for indexes that will never fill in.
   */
  eventBase: number;
  /** Emits "event" after each append — stream responses subscribe here. */
  emitter: EventEmitter;
}

/** Event types after which a turn is settled and a stream read can end. */
export const SETTLE_TYPES = new Set([
  "session.waiting",
  "turn.failed",
  "session.failed",
  "session.completed",
]);

const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2h idle → evicted

const sessions = new Map<string, EveSession>();

function newToken(): string {
  return `nm:${randomBytes(24).toString("base64url")}`;
}

export function createSession(auth: { storeId: string; userId: string; role: string }): EveSession {
  const session: EveSession = {
    id: `ses_${randomUUID().replaceAll("-", "")}`,
    storeId: auth.storeId,
    userId: auth.userId,
    role: auth.role,
    continuationToken: newToken(),
    events: [],
    history: [],
    turnActive: false,
    lastActivityMs: Date.now(),
    eventBase: 0,
    emitter: new EventEmitter(),
  };
  session.emitter.setMaxListeners(50);
  sessions.set(session.id, session);
  return session;
}

export function getSession(id: string): EveSession | undefined {
  const session = sessions.get(id);
  if (session) session.lastActivityMs = Date.now();
  return session;
}

/**
 * In-memory hit, or fall back to the pg row (survives a restart). The
 * restored session gets a fresh emitter and an EMPTY events array — replaying
 * old events into memory would grow without bound — with `eventBase` carrying
 * the persisted event count so the client's cursor still resolves (see the
 * field's doc above).
 */
export async function getOrRestoreSession(id: string): Promise<EveSession | undefined> {
  const inMemory = getSession(id);
  if (inMemory) return inMemory;
  if (!persistenceEnabled()) return undefined;
  const row = await loadSession(id).catch((err) => {
    console.error(`[eve-compat] failed to load session ${id} from pg:`, err);
    return null;
  });
  if (!row) return undefined;
  // Another request may have restored it while we awaited — keep the winner.
  const raced = sessions.get(id);
  if (raced) return raced;
  const session: EveSession = {
    id: row.id,
    storeId: row.store_id,
    userId: row.user_id ?? "",
    role: row.role ?? "",
    continuationToken: row.continuation_token,
    events: [],
    history: row.history ?? [],
    turnActive: false,
    lastActivityMs: Date.now(),
    eventBase: row.event_base,
    emitter: new EventEmitter(),
  };
  session.emitter.setMaxListeners(50);
  sessions.set(session.id, session);
  return session;
}

export function rotateToken(session: EveSession): string {
  session.continuationToken = newToken();
  // Fire-and-forget — persistence must never break a turn.
  saveSession(session).catch(console.error);
  return session.continuationToken;
}

export function appendEvent(session: EveSession, event: EveEvent): void {
  session.events.push(event);
  session.lastActivityMs = Date.now();
  session.emitter.emit("event", event, session.events.length - 1);
  // Persist at settle points only — one write per turn, not per token delta.
  if (SETTLE_TYPES.has(event.type)) saveSession(session).catch(console.error);
}

// Idle-session GC. `unref()` so the interval never holds the process open.
setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, session] of sessions) {
    if (session.lastActivityMs < cutoff && !session.turnActive) {
      sessions.delete(id);
      deleteSession(id).catch(console.error);
    }
  }
}, 10 * 60 * 1000).unref();
