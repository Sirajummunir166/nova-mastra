/**
 * The two model rungs above the rules (PRD §04):
 *
 * L1 RESOLVER — small model, runs only when L0 rules miss. Returns JSON:
 *   intent from the closed enum + entities. Never free text, never picks
 *   the reply.
 * L2 WRITER — every outbound sentence. ~300 tokens in, ~60 out. Gets the
 *   decided ACTION; it words the move, it does not choose it. System block
 *   is stable per store → prompt-cacheable.
 */

import { Agent } from "@mastra/core/agent";
import { gateway } from "@ai-sdk/gateway";
import { z } from "zod";

const RESOLVER_MODEL = process.env.NOVA_MODEL_RESOLVER ?? process.env.NOVA_MODEL ?? "anthropic/claude-haiku-4-5-20251001";
const WRITER_MODEL = process.env.NOVA_MODEL_WRITER ?? process.env.NOVA_MODEL ?? "anthropic/claude-sonnet-5";

export const resolverSchema = z.object({
  intent: z.enum([
    "greeting",
    "product_query",
    "price_q",
    "stock_q",
    "size_pick",
    "qty_pick",
    "zone_pick",
    "phone_give",
    "address_give",
    "buy_intent",
    "confirm",
    "reject",
    "discount_ask",
    "faq_delivery",
    "order_status_q",
    "complaint",
    "human_ask",
    "other",
  ]),
  entities: z.object({
    size: z.string().optional(),
    qty: z.number().int().positive().optional(),
    zone: z.string().optional(),
    phone: z.string().optional(),
    address: z.string().optional(),
    productText: z.string().optional(),
  }),
  confidence: z.number().min(0).max(1),
});

export const resolverAgent = new Agent({
  id: "fo-resolver",
  name: "fo-resolver",
  description: "Front office L1 resolver — classifies ONE customer chat turn into a closed intent enum. JSON only.",
  instructions: [
    "Classify ONE e-commerce chat turn from a Bangladeshi customer (Bangla, Banglish or English).",
    "Return JSON only: intent from the given enum + extracted entities.",
    "You never write replies, never invent facts, never choose actions.",
    'entities.productText = the customer\'s own words naming/describing a product, when present.',
    "If nothing fits, intent = other with your best confidence.",
  ].join("\n"),
  model: gateway(RESOLVER_MODEL),
});

export const writerAgent = new Agent({
  id: "fo-writer",
  name: "fo-writer",
  description: "Front office L2 writer — words ONE decided action as the store's salesperson. ≤2 sentences.",
  // The per-store system block (voice, language rules) is passed per call via
  // `instructions` so it stays stable per tenant and prompt-cacheable.
  instructions: "You are a store's chat salesperson. Word the decided ACTION. Never invent facts.",
  model: gateway(WRITER_MODEL),
});

export function writerSystem(store: { name: string; currency: string }): string {
  return [
    `You are Nova, ${store.name}'s chat salesperson on Facebook Messenger.`,
    "",
    "LANGUAGE: If the customer writes Bangla or Banglish, reply in বাংলা script.",
    "If they write English, reply in English. Never switch without a customer reason.",
    "",
    "STYLE: Warm, direct, ≤2 sentences. No bot phrases, no corporate filler.",
    "Answer the customer's question FIRST, then move one step forward.",
    "Digits ALWAYS Latin (1250, never ১২৫০) — including prices and order numbers.",
    "Emoji: at most the customer's own level, mirrored down; none for complaints or payments.",
    "Never use an en/em dash in a reply (hyphen is fine).",
    "",
    "TRUTH: Use ONLY the facts in the state card and ACTION line — never invent",
    "price, stock, delivery time or policy. Never re-ask a field the card already",
    "shows. Prices in ৳ (taka).",
    "",
    "You word the decided ACTION. You do not choose the move.",
  ].join("\n");
}
