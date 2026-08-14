/**
 * Per-turn tool selection — the token-lean seam, applied to tools.
 *
 * eve handed the model all 67 tool schemas on every call. That payload is
 * paid for whether or not the turn could ever use a tool, and the most common
 * founder turn of all — the opener — never can: `buildCeoSnapshot` has already
 * put the headline numbers in the instructions, so a "hello" that arrives with
 * five tool schemas attached pays for five tools to answer a question the
 * context already answers.
 *
 * So selection runs on rules, in the L0 spirit of front-office `classify.ts`:
 * cheap, deterministic, no model call to decide what the model gets.
 *
 *   opener            → NO tools (the snapshot is the answer)
 *   recognised topic  → that topic's tools
 *   anything else     → the whole set (5 schemas, not 67)
 *
 * The unmatched case deliberately widens rather than narrows: a founder
 * question this file failed to parse must still be answerable. Starving the
 * model of a tool it needed is a wrong answer; handing it five small schemas
 * is a rounding error next to what this service replaced.
 */

import { ALL_TOOL_NAMES, type StoreToolName } from "./store-reads.js";

/**
 * An opener: greeting, or the "how are we doing" check-in. Length-bounded the
 * same way classify.ts bounds its greeting rule — "hello, why did order 4412
 * bounce?" opens with a greeting but is not an opener.
 */
const OPENER_RE =
  /^(?:hi|hello|hey|yo|slm|salam|assalamu?(?:\s*'?alaikum)?|আসসালামু(?:\s*আলাইকুম)?|সালাম|good (?:morning|afternoon|evening)|how(?:'s| is| are)\b[^?]{0,24}|what'?s up|kemon acho|ki khobor)[\s!.,?]*$/i;

const TOPIC_RULES: Array<{ tools: StoreToolName[]; re: RegExp }> = [
  {
    tools: ["get_orders"],
    re: /\b(order|orders|sale|sales|revenue|sold|selling|pending|shipped|delivered|cancelled|returned|rto|courier|fulfil|fulfill)\w*\b/i,
  },
  {
    tools: ["get_products"],
    re: /\b(product|products|stock|inventory|restock|reorder|sku|catalog|catalogue|price|pricing|out of stock|low stock)\w*\b/i,
  },
  {
    tools: ["get_customers"],
    re: /\b(customer|customers|buyer|buyers|vip|repeat|retention|ltv|lifetime|churn)\w*\b/i,
  },
  {
    tools: ["get_abandoned_carts"],
    re: /\b(cart|carts|abandon|checkout|recover|recovery)\w*\b/i,
  },
  {
    tools: ["get_finance_overview"],
    re: /\b(cash|money|profit|loss|margin|expense|payable|receivable|ledger|finance|financial|p&l|pnl)\w*\b/i,
  },
];

export interface Selection {
  tools: StoreToolName[];
  /** Why this set — carried into logs so a starved turn is diagnosable. */
  reason: "opener" | "topic" | "default";
}

/**
 * Pick the tools for one founder turn. `text` is the founder's message; on a
 * follow-up it is that follow-up alone, which is the point — "and the money
 * side?" selects finance without dragging the previous turn's tools along.
 */
export function selectTools(text: string): Selection {
  const trimmed = text.trim();

  // Topic BEFORE opener, and the order is load-bearing: "how are my orders
  // doing?" is short and opens like a greeting, but it names a topic and must
  // get that topic's tool. Only a message with no topic at all is an opener.
  const matched = new Set<StoreToolName>();
  for (const rule of TOPIC_RULES) {
    if (rule.re.test(trimmed)) for (const tool of rule.tools) matched.add(tool);
  }
  if (matched.size > 0) return { tools: [...matched], reason: "topic" };

  if (trimmed.length <= 40 && OPENER_RE.test(trimmed)) return { tools: [], reason: "opener" };

  return { tools: [...ALL_TOOL_NAMES], reason: "default" };
}
