/**
 * Front-office acceptance smoke — the PRD's "Hasan Mahmud regression"
 * (scenario A, minus Product Vision): discovery → price → stock → size →
 * qty → zone → contact → ONE summary → "ji" → real order in the demo store.
 *
 * Run: npx tsx scripts/smoke-front-office.ts [convId]
 * Needs dakio-api on DAKIO_API_URL and NOVA_DEV_STORE_ID set.
 */

import "dotenv/config";
import { runCustomerTurn } from "../src/front-office/turn.js";
import { resetContext } from "../src/front-office/context-store.js";
import { listProducts } from "../src/front-office/dakio.js";

const storeId = process.env.NOVA_DEV_STORE_ID;
if (!storeId) throw new Error("NOVA_DEV_STORE_ID not set");
const convId = process.argv[2] ?? `smoke-${Math.random().toString(36).slice(2, 8)}`;

const catalog = await listProducts(storeId);
console.log(`store ${storeId} · catalog: ${catalog.map((p) => `${p.name} (৳${p.price}, stock ${p.stock}${p.variantNames?.length ? `, ${p.variantNames.join("/")}` : ""})`).join(" · ")}\n`);

resetContext(storeId, convId);

const TURNS = [
  "assalamu alaikum",
  "polo shirt er dam koto?",
  "eita ase to stock e?",
  "acha nibo, 2 ta",
  "Savar",
  "01712345678, House 5 Road 2, Savar",
  "ji confirm koren",
];

let failed = false;
for (const msg of TURNS) {
  console.log(`CUSTOMER: ${msg}`);
  try {
    const r = await runCustomerTurn(storeId, convId, msg);
    console.log(`NOVA (${r.action} · rung ${r.rung} · stage ${r.stage} · ${r.timings.sentMs}ms): ${r.reply}`);
    if (r.order) console.log(`>>> ORDER CREATED: #${r.order.orderNumber} · ৳${r.order.total}`);
    console.log(`   [missing: ${r.missing.join(",") || "none"} · v${r.version} · ledger ${r.cacheHits}]\n`);
  } catch (err) {
    failed = true;
    console.error(`TURN FAILED: ${err instanceof Error ? err.message : err}\n`);
  }
}

console.log(failed ? "SMOKE: FAILURES ABOVE" : "SMOKE: ALL TURNS COMPLETED");
process.exit(failed ? 1 : 0);
