/**
 * Customer-message ingress — SHADOW mode (phase C unit 1).
 *
 * Replicates the dakio-api → nova-ai delivery contract byte-for-byte
 * (nova-ai `agent/channels/customer.ts`, module doc D5/D9; sender:
 * dakio-api `src/lib/inboxDelivery.js`), so dakio-api can be pointed at
 * nova-mastra later with only a NOVA_AGENT_URL change:
 *
 *   POST /customer/message
 *   Headers: x-nova-signature  = hex(HMAC-SHA256(`${x-nova-timestamp}.${rawBody}`,
 *                                    NOVA_INBOX_SHARED_SECRET))
 *            x-nova-timestamp  = ISO-8601, rejected outside ±5 minutes —
 *                                bound into the MAC (Stripe-style), so the
 *                                freshness window actually bounds replay
 *   Body:    { storeId, conversationId, platform: "messenger"|"instagram",
 *              messageIds: [...] }
 *   → 202 accepted (shadow turn dispatched)      → dakio-api stamps processedAt
 *   → 401 bad signature / stale timestamp        → dakio-api alarms, no retry
 *   → 409 busy / duplicate / tenant paused       → events stay unprocessed
 *   → 503 NOVA_INBOX_SHARED_SECRET unset         → fail-closed misconfiguration
 *                                                  (dakio-api's retry ladder
 *                                                  treats it as transient)
 *
 * One deliberate deviation from customer.ts: an UNSET shared secret answers
 * 503 (`novaAuth.js`-style loud misconfiguration) where nova-ai folded it
 * into the 401 arm. Everything the sender can observe with a correctly
 * configured pair is identical.
 *
 * SHADOW MEANS OBSERVE-ONLY. An accepted delivery runs the front-office
 * customer turn with `mode: "shadow"` — the pipeline classifies, hydrates,
 * decides and DRAFTS, state persists per (store, conversation, EPOCH) — but
 * nothing is ever sent to a customer and no order is ever created; the one
 * decided write is recorded as `wouldHaveDone` in `nova_shadow_turns`
 * (shadow-log.ts), the dataset the phase C gate reads.
 *
 * Session key discipline (nova-ai §2.5 + Stage 11): the state partition is
 * `inbox:<conversationId>:<modelKey>:<epoch>` where the EPOCH is dakio-api's
 * session roll (`GET /conversations/:id/session-epoch` — READ, never
 * computed). Here the epoch keys `nova_conversation_state` rows, which is the
 * same partition the continuation token gave eve sessions.
 *
 * Auth is the HMAC — this router is mounted OUTSIDE the NOVA_STUDIO_TOKEN
 * guard (which only covers /api/* and /chat) and BEFORE express.json(),
 * because the MAC covers the raw bytes.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import express, { Router } from "express";
import type { Request, Response } from "express";
import { ensureTenant, getTenant, isTenantActive } from "../store/tenants.js";
import { storeFor } from "../store/resolve.js";
import { runCustomerTurn } from "../front-office/turn.js";
import { recordShadowTurn } from "./shadow-log.js";

/** ±5 minutes — the timestamp freshness window (module doc D5). */
export const TIMESTAMP_SKEW_MS = 5 * 60 * 1000;

const PLATFORMS = new Set(["messenger", "instagram"]);

/**
 * Constant-time signature check — verbatim from customer.ts.
 * `Buffer.from(hex, "hex")` silently truncates at the first invalid pair, so
 * the length comparison also rejects malformed hex; `timingSafeEqual`
 * requires equal lengths, hence the guard.
 */
export function signatureMatches(
  timestamp: string | null,
  rawBody: string,
  signature: string | null,
  secret: string,
): boolean {
  if (!signature || !timestamp) return false;
  // The MAC covers `${timestamp}.${rawBody}` (Stripe-webhook construction) —
  // dakio-api's inboxDelivery.js signs identically.
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest();
  const provided = Buffer.from(signature, "hex");
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

export function timestampFresh(timestamp: string | null, nowMs = Date.now()): boolean {
  if (!timestamp) return false;
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return false;
  return Math.abs(nowMs - parsed) <= TIMESTAMP_SKEW_MS;
}

/** A gateway model id as one token-safe segment — verbatim from customer.ts. */
export function modelTokenSegment(model: string | undefined): string {
  const raw = model?.trim().toLowerCase();
  if (!raw) return "default";
  return raw.replace(/[^a-z0-9._-]+/g, "-");
}

/**
 * The session key this delivery's state runs under — nova-ai's
 * `inboxContinuationToken` byte-for-byte: epoch 0 renders NOTHING so every
 * pre-roll conversation keeps the key it already had.
 */
export function inboxSessionKey(conversationId: string, modelKey?: string, epoch?: number): string {
  const base = `inbox:${conversationId}`;
  const keyed = modelKey ? `${base}:${modelKey}` : base;
  const e = Number(epoch);
  return Number.isFinite(e) && e > 0 ? `${keyed}:e${Math.floor(e)}` : keyed;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

// ---------------------------------------------------------------------------
// Replay guard — duplicate (timestamp, body) pairs answer 409
// ---------------------------------------------------------------------------
//
// The signature IS the (timestamp, body) identity (the MAC covers both), so
// remembering accepted signatures for 2× the freshness window makes an exact
// replay a 409 instead of a second dispatched turn. Purely in-process
// (single-instance posture, same as nova-ai's inFlightDispatch): durability
// never depends on it — a replay that slips past a restart just re-runs a
// shadow turn, which sends nothing. dakio-api never legitimately repeats a
// (timestamp, body) pair: every retry re-collects and re-stamps a fresh
// timestamp.

const seenSignatures = new Map<string, number>(); // signature -> expiresAtMs
const SEEN_MAX = 10_000;

export function replaySeen(signature: string, nowMs = Date.now()): boolean {
  for (const [sig, expiresAt] of seenSignatures) {
    if (expiresAt <= nowMs) seenSignatures.delete(sig);
  }
  if (seenSignatures.has(signature)) return true;
  if (seenSignatures.size >= SEEN_MAX) {
    const oldest = seenSignatures.keys().next();
    if (!oldest.done) seenSignatures.delete(oldest.value);
  }
  seenSignatures.set(signature, nowMs + TIMESTAMP_SKEW_MS * 2);
  return false;
}

/** Test seam: the suites replay the same signed body across cases. */
export function resetReplayGuard(): void {
  seenSignatures.clear();
}

// ---------------------------------------------------------------------------
// In-flight dispatch guard — one turn per conversation at a time (409 busy)
// ---------------------------------------------------------------------------

const inFlightDispatch = new Set<string>();

// ---------------------------------------------------------------------------
// The shadow turn
// ---------------------------------------------------------------------------

export interface InboxDelivery {
  storeId: string;
  conversationId: string;
  platform: string;
  messageIds: string[];
}

/**
 * Run one delivery through the front-office pipeline in SHADOW mode and
 * record the result. Message CONTENT never rides the wire (the body carries
 * ids — nova-ai's untrusted() boundary discipline), so the text is read back
 * from dakio-api's own thread view, same as nova-ai's `get_conversation`.
 *
 * Every path writes exactly one `nova_shadow_turns` row; nothing here ever
 * calls a send/reply endpoint, and the turn runs with `mode: "shadow"` so
 * `createChatOrder` is unreachable (see front-office/turn.ts).
 */
export async function runShadowTurn(delivery: InboxDelivery): Promise<void> {
  const { storeId, conversationId, messageIds } = delivery;
  const t0 = Date.now();
  const store = storeFor(storeId);

  // The epoch is READ, never computed (Stage 11 discipline) — dakio-api's
  // session roll partitions state, and `getSessionEpoch` never throws (0 on
  // an unreachable server).
  const epoch = await store.getSessionEpoch(conversationId);
  const sessionKey = inboxSessionKey(conversationId, modelTokenSegment(getTenant(storeId)?.novaModel), epoch);

  let inboundText = "";
  try {
    const thread = await store.getInboxConversation(conversationId, { messages: 50 });
    const wanted = new Set(messageIds);
    inboundText = (thread?.messages ?? [])
      .filter((m) => wanted.has(m.id) && m.direction === "in" && isNonEmptyString(m.text))
      .map((m) => m.text as string)
      .join("\n");
  } catch (err) {
    console.warn(`[inbox] thread read failed for ${sessionKey}:`, err);
  }

  if (!inboundText) {
    await recordShadowTurn({
      storeId,
      conversationId,
      epoch,
      inboundText: null,
      draftReply: null,
      intent: null,
      rung: null,
      action: null,
      stage: null,
      wouldHaveDone: { skipped: "no_inbound_text", messageIds },
      timings: { totalMs: Date.now() - t0 },
      modelCalls: 0,
    });
    return;
  }

  try {
    const result = await runCustomerTurn(storeId, conversationId, inboundText, { mode: "shadow", epoch });
    const wouldHaveDone: Record<string, unknown> = {
      ...(result.wouldHaveDone ?? {}),
      ...(result.modelFailure ? { modelFailure: result.modelFailure } : {}),
    };
    await recordShadowTurn({
      storeId,
      conversationId,
      epoch,
      inboundText,
      draftReply: result.reply || null,
      intent: result.intent,
      rung: result.rung,
      action: String(result.action),
      stage: result.stage,
      wouldHaveDone: Object.keys(wouldHaveDone).length > 0 ? wouldHaveDone : null,
      timings: result.timings,
      modelCalls: result.modelCalls,
    });
    console.info(
      `[inbox] shadow turn recorded session=${sessionKey} intent=${result.intent} rung=${result.rung} action=${String(result.action)} draft=${result.reply ? `${result.reply.length} chars` : "none"}`,
    );
  } catch (err) {
    // The pipeline itself failed (store unreachable, etc.). Record the fact —
    // a shadow dataset with silent holes cannot pass a gate honestly.
    console.error(`[inbox] shadow turn failed for ${sessionKey}:`, err);
    await recordShadowTurn({
      storeId,
      conversationId,
      epoch,
      inboundText,
      draftReply: null,
      intent: null,
      rung: null,
      action: null,
      stage: null,
      wouldHaveDone: { error: err instanceof Error ? err.message : String(err) },
      timings: { totalMs: Date.now() - t0 },
      modelCalls: 0,
    });
  }
}

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

/**
 * Build the ingress router. `deps.runShadow` is the dispatch seam — tests
 * inject a stub so the wire contract is assertable without a store backend.
 */
export function createInboxRouter(deps: { runShadow?: (delivery: InboxDelivery) => Promise<void> } = {}): Router {
  const runShadow = deps.runShadow ?? runShadowTurn;
  const router = Router();

  // express.raw, not express.json: the MAC covers the raw bytes, so this
  // route must see them before any parser. (index.ts mounts this router
  // ahead of the global express.json() for the same reason.)
  router.post("/customer/message", express.raw({ type: () => true, limit: "1mb" }), (req: Request, res: Response) => {
    // 1. Authenticate the caller (dakio-api itself) — fail closed. A missing
    //    secret is a misconfiguration, not an auth failure: 503, like
    //    dakio-api's own novaAuth (nova-ai folded this into 401 — see the
    //    module doc for the deviation).
    const secret = process.env.NOVA_INBOX_SHARED_SECRET ?? "";
    if (secret.length === 0) {
      res.status(503).json({ error: "nova_inbox_unconfigured" });
      return;
    }
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
    const timestamp = req.get("x-nova-timestamp") ?? null;
    const signature = req.get("x-nova-signature") ?? null;
    if (!signatureMatches(timestamp, rawBody, signature, secret) || !timestampFresh(timestamp)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    // 2. Replay: the same signed (timestamp, body) pair dispatches once.
    if (replaySeen(signature!)) {
      res.status(409).json({ status: "duplicate" });
      return;
    }

    // 3. Parse + validate the body. Both sides are ours, so a valid-signature
    //    malformed body is a deploy-drift bug — 400 makes it loud instead of
    //    silently dropping messages. (Messages verbatim from customer.ts.)
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      res.status(400).json({ error: "invalid JSON body" });
      return;
    }
    const { storeId, conversationId, platform } = body;
    const messageIds = Array.isArray(body.messageIds) ? body.messageIds.filter(isNonEmptyString) : [];
    if (
      !isNonEmptyString(storeId) ||
      !isNonEmptyString(conversationId) ||
      !isNonEmptyString(platform) ||
      !PLATFORMS.has(platform) ||
      messageIds.length === 0
    ) {
      res
        .status(400)
        .json({ error: "body must be {storeId, conversationId, platform: messenger|instagram, messageIds: [..]}" });
      return;
    }

    void (async () => {
      // 4. Kill switch, pre-dispatch: a paused or unprovisioned tenant's
      //    events must stay unprocessed on dakio-api's side (a 202 would
      //    stamp processedAt and lose them).
      await ensureTenant(storeId);
      if (!isTenantActive(storeId)) {
        res.status(409).json({ status: "refused", reason: "tenant_inactive" });
        return;
      }

      // 5. Busy continuation → 409, events re-coalesce on dakio-api's side.
      if (inFlightDispatch.has(conversationId)) {
        res.status(409).json({ status: "busy" });
        return;
      }

      // 6. Accept, then run the shadow turn off the request path — same
      //    semantics as nova-ai's dispatch-into-durable-session: 202 means
      //    "queued", and dakio-api stamps processedAt on it. `sessionId` is
      //    null exactly as nova-ai answers when no eve session id exists;
      //    dakio-api only reads the status code.
      inFlightDispatch.add(conversationId);
      const delivery: InboxDelivery = { storeId, conversationId, platform, messageIds };
      void runShadow(delivery)
        .catch((err) => console.error(`[inbox] shadow dispatch crashed for ${conversationId}:`, err))
        .finally(() => inFlightDispatch.delete(conversationId));
      res.status(202).json({ status: "accepted", sessionId: null });
    })().catch((err) => {
      console.error("[inbox] ingress failed:", err);
      if (!res.headersSent) res.status(500).json({ error: "internal" });
    });
  });

  return router;
}

/** The production router index.ts mounts (real shadow dispatch). */
export const inboxRouter = createInboxRouter();
