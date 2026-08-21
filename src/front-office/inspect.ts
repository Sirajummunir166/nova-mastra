/**
 * Two READ-ONLY Studio surfaces: watch the conversation state, and watch the
 * context Nova is actually given.
 *
 * ── WHY THESE EXIST ────────────────────────────────────────────────────────
 *
 * Running `customer-turn` once tells you what Nova said. It does not tell you
 * what Nova now BELIEVES, and the belief is the interesting part: which facts
 * are held with what confidence, which language got locked in, which product
 * is in focus, what is still missing before an order can be placed. That
 * state is the whole delta-loop design, and until now the only way to see it
 * was to run another turn — which CHANGES it. Observing a system by poking it
 * is how you end up debugging your own probe.
 *
 * So: `fo-inspect` reads the state and writes nothing. Zero model calls, zero
 * mutations, safe to run between every message.
 *
 * `nova-context` answers the other half — "what context did we actually apply
 * to Nova?" — for the FOUNDER lane, and it answers it without spending a
 * model call, because the instructions are assembled by code. You see the
 * exact system prompt, the exact snapshot, and the exact tools the rules
 * picked for that message, with the reason they were picked.
 */

import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";

import { loadContext, primeContext } from "./context-store.js";
import { getStoreProfile } from "../lib/store.js";
import { buildCeoSnapshot } from "../lib/snapshot.js";
import { novaInstructions } from "../lib/context.js";
import { selectTools } from "../tools/select.js";

// ───────────────────────────────────────────────────────────────────────────
// fo-inspect — what does Nova believe about this conversation right now?
// ───────────────────────────────────────────────────────────────────────────

const inspectInput = z.object({
  convId: z.string().min(1).default("studio-1").describe("Conversation id — the same one you ran customer-turn with"),
  storeId: z.string().optional().describe("Tenant id; defaults to NOVA_DEV_STORE_ID"),
  epoch: z.number().default(0).describe("Session epoch. Part of the storage key — a rolled conversation has a different one"),
});

const inspectOutput = z.object({
  found: z.boolean().describe("false = nothing stored yet for this (store, conversation, epoch)"),
  version: z.number().describe("Turn counter — how many turns this conversation has had"),
  updatedAt: z.string(),
  epoch: z.number(),
  language: z.object({
    preferred: z.string(),
    detected: z.string(),
    confidence: z.number(),
    lockedByRequest: z.boolean().describe("true = the customer explicitly asked for this language; detection may not override it"),
  }),
  sentiment: z.string(),
  customer: z.record(z.string(), z.unknown()).describe("Known facts, each with how it was learned"),
  productFocus: z.string().nullable(),
  productsTracked: z.array(z.string()),
  orders: z.array(z.unknown()),
  raw: z.string().describe("The whole state object, pretty-printed"),
});

/** Facts carry provenance; render it rather than flattening to a value. */
function factSummary(fact: unknown): unknown {
  if (fact && typeof fact === "object" && "value" in (fact as Record<string, unknown>)) {
    const f = fact as Record<string, unknown>;
    return { value: f.value, source: f.source ?? null, confidence: f.confidence ?? null };
  }
  return fact ?? null;
}

const inspectStep = createStep({
  id: "inspect-state",
  inputSchema: inspectInput,
  outputSchema: inspectOutput,
  execute: async ({ inputData }) => {
    const storeId = inputData.storeId || process.env.NOVA_DEV_STORE_ID;
    if (!storeId) throw new Error("storeId required (or set NOVA_DEV_STORE_ID)");

    // `loadContext` is synchronous over an in-process map; `primeContext` is
    // the Postgres cold-load. Studio may hit a fresh process, so prime first
    // or a conversation that exists in the database reads as empty.
    await primeContext(storeId, inputData.convId, inputData.epoch);
    const ctx = loadContext(storeId, inputData.convId, "chat", inputData.epoch);

    // version 0 with no updatedAt means `newLiveContext` just minted a blank —
    // report that honestly rather than showing an empty shell as if it were
    // stored history.
    const found = ctx.version > 0;

    return {
      found,
      version: ctx.version,
      updatedAt: ctx.updatedAt ? new Date(ctx.updatedAt).toISOString() : "never",
      epoch: ctx.epoch,
      language: {
        preferred: String(ctx.customer.lang?.pref ?? "unknown"),
        detected: String(ctx.customer.lang?.detected ?? "unknown"),
        confidence: Number(ctx.customer.lang?.conf ?? 0),
        lockedByRequest: Boolean(ctx.customer.lang?.lockedByRequest),
      },
      sentiment: String(ctx.customer.sentiment ?? "neutral"),
      customer: {
        id: ctx.customer.id ?? null,
        name: factSummary(ctx.customer.name),
        phone: factSummary(ctx.customer.phone),
        addr: factSummary(ctx.customer.addr),
        channel: ctx.customer.channel,
      },
      productFocus: ctx.products?.focusId ?? null,
      productsTracked: Object.keys(ctx.products?.tracked ?? {}),
      orders: (ctx as unknown as { orders?: unknown[] }).orders ?? [],
      raw: JSON.stringify(ctx, null, 2),
    };
  },
});

export const inspectStateWorkflow = createWorkflow({
  id: "fo-inspect",
  description:
    "READ-ONLY. What Nova believes about one conversation right now — facts, language lock, product focus, turn count. No model call, no writes: safe to run between every customer-turn.",
  inputSchema: inspectInput,
  outputSchema: inspectOutput,
})
  .then(inspectStep)
  .commit();

// ───────────────────────────────────────────────────────────────────────────
// nova-context — what context is applied to the FOUNDER lane?
// ───────────────────────────────────────────────────────────────────────────

const contextInput = z.object({
  message: z.string().min(1).default("hello").describe("The founder's message — tool selection depends on it"),
  storeId: z.string().optional().describe("Tenant id; defaults to NOVA_DEV_STORE_ID"),
  includeSnapshot: z
    .boolean()
    .default(true)
    .describe("Pull the live CEO snapshot. Costs several dakio-api reads, no model call"),
});

const contextOutput = z.object({
  store: z.record(z.string(), z.unknown()),
  toolsSelected: z.array(z.string()),
  toolSelectionReason: z.string().describe("opener = the snapshot answers it, so ZERO tools are attached"),
  snapshot: z.string().describe("The live store snapshot, exactly as it is pasted into the instructions"),
  instructions: z.string().describe("THE SYSTEM PROMPT — byte for byte what the model receives"),
  instructionChars: z.number(),
  approxTokens: z.number().describe("Rough: characters ÷ 4. For scale, not billing"),
  modelCalls: z.number().describe("Always 0 — this surface is assembled by code"),
});

const contextStep = createStep({
  id: "build-context",
  inputSchema: contextInput,
  outputSchema: contextOutput,
  execute: async ({ inputData }) => {
    const storeId = inputData.storeId || process.env.NOVA_DEV_STORE_ID;
    if (!storeId) throw new Error("storeId required (or set NOVA_DEV_STORE_ID)");

    const store = await getStoreProfile(storeId);
    if (!store) throw new Error(`store ${storeId} unavailable from dakio-api`);

    const snapshot = inputData.includeSnapshot
      ? await buildCeoSnapshot(storeId, store.currency)
      : "";
    const picked = selectTools(inputData.message);
    const instructions = novaInstructions(store, snapshot ? { snapshot } : {});

    return {
      store: { id: store.storeId, name: store.name, plan: store.plan, status: store.status, currency: store.currency },
      toolsSelected: picked.tools,
      toolSelectionReason: picked.reason,
      snapshot: snapshot || "(not requested)",
      instructions,
      instructionChars: instructions.length,
      approxTokens: Math.round(instructions.length / 4),
      modelCalls: 0,
    };
  },
});

export const novaContextWorkflow = createWorkflow({
  id: "nova-context",
  description:
    "READ-ONLY. The exact system prompt, live snapshot and per-turn tool selection the founder lane would use for a message. Zero model calls — this is the context, not an answer.",
  inputSchema: contextInput,
  outputSchema: contextOutput,
})
  .then(contextStep)
  .commit();
