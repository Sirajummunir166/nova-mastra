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

export function rotateToken(session: EveSession): string {
  session.continuationToken = newToken();
  return session.continuationToken;
}

export function appendEvent(session: EveSession, event: EveEvent): void {
  session.events.push(event);
  session.lastActivityMs = Date.now();
  session.emitter.emit("event", event, session.events.length - 1);
}

// Idle-session GC. `unref()` so the interval never holds the process open.
setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, session] of sessions) {
    if (session.lastActivityMs < cutoff && !session.turnActive) sessions.delete(id);
  }
}, 10 * 60 * 1000).unref();
