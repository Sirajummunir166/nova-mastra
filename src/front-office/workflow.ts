/**
 * Studio surface for the front office: one workflow = one customer turn.
 * Run it repeatedly with the same convId to hold a conversation; state
 * persists in .data/live-context/. `reset: true` starts the conversation
 * over. storeId defaults to NOVA_DEV_STORE_ID (testing mode — direct store
 * id, no customer auth lane yet).
 */

import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { runCustomerTurn } from "./turn.js";
import { resetContext } from "./context-store.js";

const inputSchema = z.object({
  message: z.string().min(1).describe("The customer's chat message (bn / banglish / en)"),
  convId: z.string().min(1).default("studio-1").describe("Conversation id — reuse to continue the same conversation"),
  storeId: z.string().optional().describe("Tenant id; defaults to NOVA_DEV_STORE_ID"),
  reset: z.boolean().default(false).describe("Wipe this conversation's live context first"),
});

const outputSchema = z.object({
  reply: z.string(),
  intent: z.string(),
  rung: z.number().describe("0 = rules decided (no model), 1 = resolver model"),
  action: z.string(),
  stage: z.string(),
  missing: z.array(z.string()),
  stateCard: z.string().describe("The ~120-token card — exactly what the writer saw"),
  order: z.object({ orderNumber: z.string(), total: z.number() }).optional(),
  timings: z.record(z.string(), z.number()),
  cacheHits: z.number(),
  version: z.number(),
});

const customerTurnStep = createStep({
  id: "run-turn",
  inputSchema,
  outputSchema,
  execute: async ({ inputData }) => {
    const storeId = inputData.storeId || process.env.NOVA_DEV_STORE_ID;
    if (!storeId) throw new Error("storeId required (or set NOVA_DEV_STORE_ID)");
    if (inputData.reset) resetContext(storeId, inputData.convId);
    // Explicit LIVE: this workflow predates the shadow gate and is the Studio
    // lane whose guard (index.ts) already warns it can create real orders.
    // `runCustomerTurn` itself now defaults to shadow, so live is opt-in here.
    return runCustomerTurn(storeId, inputData.convId, inputData.message, { mode: "live" });
  },
});

export const customerTurnWorkflow = createWorkflow({
  id: "customer-turn",
  description: "Front office delta loop: one customer message → classified delta → NBA → worded reply. State persists per convId.",
  inputSchema,
  outputSchema,
})
  .then(customerTurnStep)
  .commit();
