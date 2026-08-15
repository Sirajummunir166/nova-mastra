/**
 * The one command that answers "does Nova's model layer work, and what does
 * it cost?" — with NO local stack. No Postgres, no dakio-api, no server.
 * Everything it needs is baked in: a real store profile and a real CEO
 * snapshot, both copied from the seeded demo store.
 *
 *   cd nova-mastra
 *   npm install                       # if you have not already
 *   node --env-file=.env --import tsx scripts/smoke-model.mjs
 *
 * Needs AI_GATEWAY_API_KEY and NOVA_MODEL in .env. Prints token counts and
 * latency per turn; paste the whole output back.
 *
 * ── IF EVERY CALL FAILS WITH "Host not in allowlist" ───────────────────────
 *
 * Two DIFFERENT things have to be true to reach the gateway from a sandboxed
 * environment, and the error message only names the first one:
 *
 *  1. `ai-gateway.vercel.sh` must be on the environment's egress allowlist.
 *     In Claude Code cloud sessions that is claude.ai/code → the cloud icon
 *     above the message box → the environment's gear → Network access:
 *     **Custom** → Allowed domains. Tick "also include default list of common
 *     package managers", or npm stops working.
 *  2. Node's `fetch` must actually USE the proxy that enforces that
 *     allowlist — and by default it does not. `./src/boot.js` below fixes
 *     this; the long version is in `src/lib/egress.ts`.
 *
 * Get (1) right and skip (2) and you see the same 403 as before, which reads
 * like the allowlist did not save. It did.
 */

// FIRST — see src/boot.ts. Routes fetch through the environment's proxy.
import "../src/boot.js";

import { Agent } from "@mastra/core/agent";
import { gateway } from "@ai-sdk/gateway";
import { z } from "zod";
import { novaInstructions } from "../src/lib/context.js";
import { selectTools } from "../src/tools/select.js";

const MODEL = process.env.NOVA_MODEL ?? "anthropic/claude-sonnet-5";
if (!process.env.AI_GATEWAY_API_KEY) {
  console.error("AI_GATEWAY_API_KEY is not set in .env — nothing to test.");
  process.exit(1);
}

console.log(`model: ${MODEL}`);
console.log(`gateway key: ${process.env.AI_GATEWAY_API_KEY.slice(0, 6)}…${process.env.AI_GATEWAY_API_KEY.slice(-4)}\n`);

/** The seeded demo store, verbatim — so this needs no dakio-api. */
const STORE = {
  storeId: "cmst34v0v0001tslnkcz8io0h",
  name: "Dakio Demo Store",
  vertical: "general commerce",
  currency: "BDT",
  locale: "en-BD",
  timezone: "Asia/Dhaka",
  status: "active",
  plan: "starter",
};

/** A real snapshot, as buildCeoSnapshot produced it against that store. */
const SNAPSHOT = [
  "## Live store snapshot (real data, just pulled)",
  "- Orders 30d: 12 (revenue BDT 18,650) · last 7d: 7 (BDT 10,470)",
  "- Order status: placed 2, delivered 7, fulfilled 3",
  "- Top sellers 30d: Premium Oxford Shirt — White (4 pcs), Classic Polo T-Shirt — Black (4 pcs), Eid Special Panjabi — White (3 pcs)",
  "- Catalog: 8 products (8 active)",
  "- LOW STOCK (at/below reorder point): Casual Shirt — Sale (0 left)",
  "- Customers: 5 on file · combined LTV BDT 11,500",
  "- Abandoned carts: none open",
].join("\n");

const agent = new Agent({
  id: "nova-smoke",
  name: "nova-smoke",
  description: "Nova — smoke test",
  instructions: "You are Nova, the AI business operator for a Dakio commerce store.",
  model: gateway(MODEL),
});

let failures = 0;
const line = (s) => console.log(s);

async function turn(label, message, opts = {}) {
  const instructions = novaInstructions(STORE, { snapshot: SNAPSHOT });
  const picked = selectTools(message);
  const started = Date.now();
  try {
    const result = await agent.generate(message, { instructions, maxSteps: 4, ...opts });
    const ms = Date.now() - started;
    const u = result.usage ?? {};
    const inTok = u.inputTokens ?? u.promptTokens ?? "?";
    const outTok = u.outputTokens ?? u.completionTokens ?? "?";
    line(`\n── ${label} ─────────────────────────────────────────`);
    line(`   asked:  "${message}"`);
    line(`   tools this turn: [${picked.tools.join(", ") || "none"}] (${picked.reason})`);
    line(`   ${ms} ms · in ${inTok} tokens · out ${outTok} tokens · model ${result.response?.modelId ?? MODEL}`);
    line(`   reply:\n${(result.text ?? "").split("\n").map((l) => "     " + l).join("\n")}`);
    return { ms, inTok, outTok, text: result.text ?? "" };
  } catch (err) {
    failures += 1;
    line(`\n── ${label} — FAILED ────────────────────────────────`);
    line(`   ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// 1. The opener. Rules attach ZERO tools here — the snapshot already answers
//    it — so this is the cheapest turn Nova has, and the one eve spent 26K+
//    tokens on.
const hello = await turn("TURN 1 · the founder's opener", "hello");

// 2. A question the snapshot alone cannot answer precisely — this is where a
//    real deployment would attach get_orders. Watch whether the model stays
//    grounded or invents an order number.
await turn("TURN 2 · grounding under pressure", "which orders are pending, and what are they worth?");

// 3. Bangla. The customer lane is Bangladesh-first; the founder lane must not
//    fall apart when the founder switches language.
await turn("TURN 3 · Bangla", "ei mash e amar business kemon cholche?");

// 4. The pulse's judge: structured output, the one model call a whole hour of
//    watching is allowed to make. Schema shape mirrors src/brain/pulse.ts.
line(`\n── TURN 4 · the pulse judge (structured output) ─────`);
try {
  const started = Date.now();
  const judged = await agent.generate(
    [
      "You are judging whether one change in a store is worth waking the founder for.",
      "",
      "WHAT CHANGED (inventory):",
      "- Casual Shirt — Sale: margin fell from 44.4% to 9.1% (price BDT 275, cost BDT 250)",
      "",
      "Answer honestly. Never invent a number, a cause or a name.",
    ].join("\n"),
    {
      structuredOutput: {
        schema: z.object({
          worthWaking: z.boolean(),
          headline: z.string(),
          note: z.string(),
        }),
      },
      maxSteps: 2,
    },
  );
  const ms = Date.now() - started;
  const u = judged.usage ?? {};
  line(`   ${ms} ms · in ${u.inputTokens ?? u.promptTokens ?? "?"} · out ${u.outputTokens ?? u.completionTokens ?? "?"}`);
  line(`   ${JSON.stringify(judged.object ?? judged.text, null, 2).split("\n").map((l) => "   " + l).join("\n")}`);
} catch (err) {
  failures += 1;
  line(`   FAILED: ${err instanceof Error ? err.message : String(err)}`);
}

// ── The verdict ────────────────────────────────────────────────────────────
line(`\n${"═".repeat(60)}`);
if (failures > 0) {
  line(`${failures} call(s) FAILED — paste the errors above; the model layer is not working yet.`);
  process.exit(1);
}
line("ALL MODEL CALLS SUCCEEDED.");
if (hello) {
  line(`\nThe number that matters: the founder's opener cost ${hello.inTok} input tokens.`);
  line(`eve's measured baseline for the same kind of turn was p50 26,666 input tokens,`);
  line(`because it shipped all 67 tool schemas whether or not the turn could use one.`);
}
line("\nPaste this whole output back.");
process.exit(0);
