/**
 * Edge scenarios: discount decline, resolver (L1) fallback on a fuzzy
 * message, English language policy, escalation on human ask.
 *
 * Run: npx tsx scripts/smoke-fo-edge.ts
 */

import "dotenv/config";
import { runCustomerTurn } from "../src/front-office/turn.js";
import { resetContext } from "../src/front-office/context-store.js";

const storeId = process.env.NOVA_DEV_STORE_ID;
if (!storeId) throw new Error("NOVA_DEV_STORE_ID not set");
const convId = `edge-${Math.random().toString(36).slice(2, 8)}`;
resetContext(storeId, convId);

const TURNS = [
  "panjabi ta koto?", // focus panjabi, price
  "last koto rakhte parben bhai?", // discount ask → decline once, no promise
  "amar kache onno dokane 1500 e dey", // fuzzy negotiation — resolver territory
  "I want to talk in english please", // explicit language switch → persists
  "do you have this in stock?", // stock answer, now in English
  "amake manush er sathe kotha bolan", // human ask → escalate + lock
];

for (const msg of TURNS) {
  console.log(`CUSTOMER: ${msg}`);
  try {
    const r = await runCustomerTurn(storeId, convId, msg);
    console.log(`NOVA (${r.intent} → ${r.action} · rung ${r.rung} · stage ${r.stage} · ${r.timings.sentMs}ms): ${r.reply}\n`);
  } catch (err) {
    console.error(`TURN FAILED: ${err instanceof Error ? err.message : err}\n`);
  }
}
