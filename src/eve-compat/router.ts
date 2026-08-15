/**
 * eve/v1 protocol surface — byte-compatible with what the merchant app's
 * `novaAgentClient.js` expects, so NovaChat connects to nova-mastra by
 * flipping VITE_NOVA_AGENT_URL and nothing else:
 *
 *   POST /eve/v1/session                    {message}                        → {ok, sessionId, continuationToken}
 *   POST /eve/v1/session/:id                {continuationToken, message}     → {ok}
 *   GET  /eve/v1/session/:id/stream?startIndex=N                            → NDJSON events
 *   GET  /eve/v1/health · GET /eve/v1/info
 *
 * Auth: the merchant's own dakio-api login JWT as Bearer (shared trust root,
 * DAKIO_JWT_SECRET). Sessions are pinned to the token's tenant.
 */

import { Router, type Request, type Response } from "express";
import { verifyDakioJwt, extractBearerToken, type DakioClaims } from "../lib/dakio-jwt.js";
import { createSession, getOrRestoreSession, SETTLE_TYPES, type EveSession, type EveEvent } from "./sessions.js";
import { runTurn, type TurnInput } from "./turn.js";

function authenticate(req: Request, res: Response): DakioClaims | null {
  const claims = verifyDakioJwt(extractBearerToken(req.headers.authorization));
  if (!claims) {
    res.status(401).json({ ok: false, error: "invalid or missing Dakio JWT" });
    return null;
  }
  return claims;
}

/**
 * Session lookup + tenant pinning: the token's store must own the session.
 * Falls back to the pg row when the id isn't in memory (post-restart), so
 * 404 means neither memory nor pg knows the session.
 */
async function authorizedSession(req: Request, res: Response): Promise<EveSession | null> {
  const claims = authenticate(req, res);
  if (!claims) return null;
  const session = await getOrRestoreSession(req.params.id as string);
  if (!session) {
    res.status(404).json({ ok: false, error: "unknown session" });
    return null;
  }
  if (session.storeId !== claims.storeId) {
    res.status(403).json({ ok: false, error: "session belongs to another store" });
    return null;
  }
  return session;
}

function parseClientContext(req: Request): TurnInput["clientContext"] {
  const raw = req.headers["x-dakio-client-context"];
  if (typeof raw !== "string" || !raw) return null;
  try {
    return JSON.parse(raw) as TurnInput["clientContext"];
  } catch {
    return null;
  }
}

export const eveRouter = Router();

eveRouter.get("/health", (_req, res) => {
  res.json({ ok: true, service: "nova-mastra", protocol: "eve/v1" });
});

eveRouter.get("/info", (_req, res) => {
  res.json({ ok: true, service: "nova-mastra", protocol: "eve/v1" });
});

eveRouter.post("/session", (req, res) => {
  const claims = authenticate(req, res);
  if (!claims) return;
  const session = createSession({ storeId: claims.storeId, userId: claims.sub, role: claims.role });
  const body = (req.body ?? {}) as TurnInput;
  void runTurn(session, { ...body, clientContext: parseClientContext(req) });
  res.setHeader("x-eve-session-id", session.id);
  res.json({ ok: true, sessionId: session.id, continuationToken: session.continuationToken });
});

eveRouter.post("/session/:id", async (req, res) => {
  const session = await authorizedSession(req, res);
  if (!session) return;
  const body = (req.body ?? {}) as TurnInput & { continuationToken?: string };
  if (body.continuationToken !== session.continuationToken) {
    res.status(409).json({ ok: false, error: "stale continuationToken" });
    return;
  }
  if (session.turnActive) {
    res.status(409).json({ ok: false, error: "a turn is already running" });
    return;
  }
  void runTurn(session, { ...body, clientContext: parseClientContext(req) });
  res.json({ ok: true });
});

eveRouter.get("/session/:id/stream", async (req, res) => {
  const session = await authorizedSession(req, res);
  if (!session) return;

  const startIndex = Math.max(0, Number.parseInt(String(req.query.startIndex ?? "0"), 10) || 0);
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.flushHeaders?.();

  // Pump pattern: drain the log from `next`, then sleep until the next
  // append wakes us. Single code path, no backfill/live race — an event
  // appended while we drain is picked up by the same while loop.
  //
  // `eventBase` maps the client's cursor into this process's events array:
  // the client counts every line it has ever consumed under this session id,
  // but after a pg restore the array restarts empty. Its old cursor (==
  // eventBase at last settle) lands on index 0 of the fresh array, exactly
  // where the next turn's events will appear. 0 for non-restored sessions.
  let next = Math.max(0, startIndex - session.eventBase);
  let closed = false;

  const wake = () => {
    if (!closed) pump();
  };

  const finish = () => {
    if (closed) return;
    closed = true;
    session!.emitter.removeListener("event", wake);
    res.end();
  };

  function pump() {
    while (next < session!.events.length) {
      const event = session!.events[next] as EveEvent;
      next += 1;
      res.write(`${JSON.stringify(event)}\n`);
      if (SETTLE_TYPES.has(event.type)) {
        finish();
        return;
      }
    }
  }

  session.emitter.on("event", wake);
  res.on("close", () => {
    closed = true;
    session.emitter.removeListener("event", wake);
  });
  pump();
});
