/**
 * Executes every founder-lane tool against the live dakio-api and prints what
 * the model would see.
 *
 * The tool layer's real risk is not the model — it is the seam under it: a
 * wrong path, a renamed field, a projection that quietly drops the number the
 * founder asked for. All of that is checkable with no model credential at
 * all, so it is checked here rather than discovered in a chat turn.
 *
 * Usage: node --env-file=.env --import tsx scripts/smoke-tools.ts [storeId]
 */

import { storeReadTools, ALL_TOOL_NAMES } from "../src/tools/store-reads.js";
import { selectTools } from "../src/tools/select.js";

const storeId = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? process.env.NOVA_DEV_STORE_ID;
if (!storeId) throw new Error("pass a storeId or set NOVA_DEV_STORE_ID");

const tools = storeReadTools(storeId);
const inputs: Record<string, unknown> = {
  get_orders: { sinceDays: 30 },
  get_products: { lowStockOnly: false },
  get_customers: {},
  get_abandoned_carts: {},
  get_finance_overview: {},
};

console.log(`store ${storeId}\n`);

let failed = 0;
for (const name of ALL_TOOL_NAMES) {
  const tool = tools[name];
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await (tool as any).execute(inputs[name], {});
    const json = JSON.stringify(out);
    console.log(`✓ ${name} — ${json.length} chars ≈ ${Math.round(json.length / 4)} tokens`);
    console.log(`  ${json.slice(0, 320)}${json.length > 320 ? "…" : ""}\n`);
  } catch (err) {
    failed += 1;
    console.error(`✗ ${name} — ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

console.log("--- selection ---");
for (const message of [
  "hello",
  "how are my orders doing?",
  "what needs restocking?",
  "what's my cash position?",
  "should I open a second outlet?",
]) {
  const { tools: picked, reason } = selectTools(message);
  console.log(`  "${message}" → [${picked.join(", ") || "none"}] (${reason})`);
}

if (failed > 0) {
  console.error(`\n${failed} tool(s) FAILED against dakio-api`);
  process.exit(1);
}
console.log("\nALL TOOLS OK");
