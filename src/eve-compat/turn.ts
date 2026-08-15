/**
 * Turn execution: one founder message in, a streamed reply out, as eve
 * protocol events on the session's log.
 *
 * Event order per turn (the client settles on the last one):
 *   message.appended*  { messageDelta }        — token stream
 *   actions.requested  { actions: [...] }      — a tool call started
 *   action.result      { result, status }      — that tool call finished
 *   message.completed  { message }             — the authoritative block
 *   session.waiting    { continuationToken }   — turn settled, token rotated
 * On failure: turn.failed { message } instead of session.waiting — the token
 * is NOT rotated, so the client's existing token stays valid for a retry.
 *
 * The two action events are what NovaChat's WorkingNarration renders: one
 * checklist row per tool call, checked off when its result lands. `callId` is
 * the join between them, and the narration hangs on an unfinished row
 * forever if a started call never reports — so a tool that ERRORS must still
 * emit `action.result`, with status "failed".
 */

import { mastra } from "../mastra/index.js";
import { getStoreProfile } from "../lib/store.js";
import { buildCeoSnapshot } from "../lib/snapshot.js";
import { novaInstructions, type TurnContext } from "../lib/context.js";
import { toolsForTurn } from "../tools/index.js";
import { appendEvent, rotateToken, type EveSession } from "./sessions.js";

export interface TurnInput {
  message?: string;
  /** eve ask_question answers — we never park, but accept the shape. */
  inputResponses?: Array<{ requestId?: string; optionId?: string; text?: string }>;
  clientContext?: TurnContext["clientContext"];
}

function userTextFrom(input: TurnInput): string {
  if (typeof input.message === "string" && input.message.trim()) return input.message;
  if (Array.isArray(input.inputResponses) && input.inputResponses.length > 0) {
    return input.inputResponses
      .map((r) => r.text ?? r.optionId ?? "")
      .filter(Boolean)
      .join("; ");
  }
  return "Hello.";
}

/**
 * Fire-and-forget from the POST handler: events land on the session log and
 * the client picks them up on its stream read. Never throws.
 */
export async function runTurn(session: EveSession, input: TurnInput): Promise<void> {
  session.turnActive = true;
  try {
    const userText = userTextFrom(input);
    session.history.push({ role: "user", content: userText });

    const store = await getStoreProfile(session.storeId);
    if (!store) throw new Error(`store ${session.storeId} unavailable from dakio-api`);
    if (store.status !== "active") throw new Error(`store ${session.storeId} is not active`);

    // Live numbers every turn — server-side aggregation keeps this ~300 tokens.
    const snapshot = await buildCeoSnapshot(session.storeId, store.currency);

    // Rules pick the tools before the model sees anything — an opener gets
    // none, since the snapshot above already answers it.
    const { toolsets, selection } = toolsForTurn(session.storeId, userText);
    console.log(`[eve-compat] ${session.id} tools=${selection.tools.join(",") || "none"} (${selection.reason})`);

    const agent = mastra.getAgent("nova");
    const stream = await agent.stream(session.history, {
      instructions: novaInstructions(store, { snapshot, clientContext: input.clientContext }),
      // Runaway fuse (doc 02): a turn may chain at most 8 model steps.
      maxSteps: 8,
      ...(toolsets ? { toolsets } : {}),
    });

    // fullStream rather than textStream: same text deltas, plus the tool-call
    // chunks the narration needs. Anything not mapped here is ignored.
    let full = "";
    for await (const chunk of stream.fullStream) {
      switch (chunk.type) {
        case "text-delta": {
          const delta = chunk.payload.text;
          if (!delta) break;
          full += delta;
          appendEvent(session, { type: "message.appended", data: { messageDelta: delta } });
          break;
        }
        case "tool-call":
          appendEvent(session, {
            type: "actions.requested",
            data: {
              actions: [{ callId: chunk.payload.toolCallId, kind: "tool-call", toolName: chunk.payload.toolName }],
            },
          });
          break;
        case "tool-result":
          appendEvent(session, {
            type: "action.result",
            data: {
              result: { callId: chunk.payload.toolCallId },
              status: chunk.payload.isError ? "failed" : "completed",
            },
          });
          break;
        case "tool-error":
          appendEvent(session, {
            type: "action.result",
            data: { result: { callId: chunk.payload.toolCallId }, status: "failed" },
          });
          break;
        default:
          break;
      }
    }

    // Mastra swallows provider errors into the stream result instead of
    // throwing from textStream — a gateway auth failure otherwise looks like
    // a successful empty turn. Surface it as turn.failed.
    if (!full.trim()) {
      const finishReason = await Promise.resolve(stream.finishReason).catch(() => undefined);
      const error = await Promise.resolve(stream.error).catch(() => undefined);
      const detail =
        error instanceof Error ? error.message : typeof error === "string" ? error : `finishReason=${finishReason ?? "unknown"}`;
      throw new Error(`model returned no output — ${detail}`);
    }

    session.history.push({ role: "assistant", content: full });
    appendEvent(session, { type: "message.completed", data: { message: full } });
    appendEvent(session, { type: "session.waiting", data: { continuationToken: rotateToken(session) } });
  } catch (err) {
    console.error(`[eve-compat] turn failed on ${session.id}:`, err);
    appendEvent(session, {
      type: "turn.failed",
      data: { message: err instanceof Error ? err.message : "Nova hit an internal error." },
    });
  } finally {
    session.turnActive = false;
  }
}
