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
  mode: z
    .enum(["shadow", "live"])
    .default("shadow")
    .describe(
      "shadow = draft only, NOTHING is created (safe to poke). live = the order gate really fires and a real order can be created in a real store.",
    ),
});

const outputSchema = z.object({
  mode: z.string().describe("Which mode this turn actually ran in — read it before believing an order number"),
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
    // DEFAULT SHADOW, and this used to be a hardcoded `mode: "live"`.
    //
    // The reason it changed: this is the surface a person opens to *poke at*
    // the customer lane — type a message, look at the state, type another.
    // Hardcoded live, "ami 2 ta shirt nibo" typed into a form to see what
    // happens CREATES A REAL ORDER in a real store. The exploratory posture
    // and the destructive default were pointed in opposite directions.
    //
    // Shadow runs the identical pipeline — classify, hydrate, decide, word the
    // reply, persist state — and stops at the one place that would write.
    // Live is now a deliberate choice in the form, and the mode comes back in
    // the OUTPUT so a reader can never mistake a drafted order for a placed
    // one.
    const result = await runCustomerTurn(storeId, inputData.convId, inputData.message, {
      mode: inputData.mode,
    });
    return { ...result, mode: inputData.mode };
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
