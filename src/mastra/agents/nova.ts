import { Agent } from "@mastra/core/agent";
import { gateway } from "@ai-sdk/gateway";

/**
 * Model resolution mirrors nova-ai `agent/lib/models.ts`: a bare
 * `provider/model` string routed through the Vercel AI Gateway, credential
 * from `AI_GATEWAY_API_KEY` (or `VERCEL_OIDC_TOKEN` on Vercel).
 */
export const NOVA_MODEL = process.env.NOVA_MODEL ?? "anthropic/claude-sonnet-5";

export const novaAgent = new Agent({
  id: "nova",
  name: "nova",
  description: "Nova — Dakio's AI business operator (founder chat lane).",
  // Base persona only. The real per-turn instructions (store context, answer
  // rules) are injected per request in the /chat route — see lib/context.ts.
  instructions: "You are Nova, the AI business operator for a Dakio commerce store.",
  model: gateway(NOVA_MODEL),
});
