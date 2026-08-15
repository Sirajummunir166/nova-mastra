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
 *
 * ── THE FOUNDER DOES NOT ONLY TYPE ENGLISH ─────────────────────────────────
 *
 * These rules were English-only, and the first real model run caught it: the
 * founder asked *"ei mash e amar business kemon cholche?"* — a plain check-in —
 * and it fell all the way through to `default`, paying for five schemas to
 * answer a question the snapshot answers on its own. The English twin, "how is
 * my business doing?", is an opener and costs nothing. Same question, same
 * store, different price, for no reason but the alphabet.
 *
 * So each rule now carries two patterns, and they are SEPARATE ON PURPOSE:
 *
 *   `re` — Latin script, word-bounded with `\b`.
 *   `bn` — Bangla script, NO `\b` ANYWHERE.
 *
 * `\b` in JavaScript is defined against ASCII `\w`, with or without the `u`
 * flag. Every Bangla codepoint is a non-word character to it, so `/\bবিক্রি\b/`
 * does not mean "the word বিক্রি" — it means something that never matches the
 * way the author expected. That exact assumption shipped once already in this
 * migration (the dead Bangla arm in the front-office classifier), so the two
 * alphabets are kept in two fields rather than one clever regex, where the
 * rule is visible instead of remembered.
 *
 * Banglish (Bangla words typed in Latin letters) rides in `re`, because that is
 * literally what it is on the wire — `bikri` and `taka` are ASCII.
 */

import { ALL_TOOL_NAMES, type StoreToolName } from "./store-reads.js";

/**
 * An opener: greeting, or the "how are we doing" check-in. Length-bounded the
 * same way classify.ts bounds its greeting rule — "hello, why did order 4412
 * bounce?" opens with a greeting but is not an opener.
 */
const OPENER_RE =
  /^(?:hi|hello|hey|yo|slm|salam|assalamu?(?:\s*'?alaikum)?|আসসালামু(?:\s*আলাইকুম)?|সালাম|good (?:morning|afternoon|evening)|how(?:'s| is| are)\b[^?]{0,24}|what'?s up|kemon acho|ki khobor)[\s!.,?]*$/i;

/**
 * The check-in: "how's it going", asked in Bangla or Banglish. Unlike
 * {@link OPENER_RE} this is anchored only at the END, because the Bangla word
 * order puts the subject first — *"ei mash e amar business **kemon cholche**?"*
 * — where English puts it after the verb.
 *
 * Letting the front of the string float is safe HERE and would not be safe in
 * OPENER_RE, for two reasons that both have to hold:
 *
 *   1. Topic rules run FIRST. "amar order gulo kemon cholche?" names orders, so
 *      it never reaches this line. Only a message with no topic at all can.
 *   2. The ≤40-character bound still applies. A long message that happens to
 *      trail off with "kemon cholche" is not a check-in and does not get here.
 *
 * So what this matches is precisely a short, topic-free "how are things?" —
 * which is what the snapshot in the instructions already answers in full.
 */
const CHECKIN_RE =
  /(?:kemon (?:cholche|cholchhe|chole|jacche|ache|acho|achen)|ki obostha|kemon obostha|কেমন (?:চলছে|যাচ্ছে|আছে)|কি (?:খবর|অবস্থা))[\s!.,?]*$/i;

export const TOPIC_RULES: Array<{ tools: StoreToolName[]; re: RegExp; bn?: RegExp }> = [
  {
    tools: ["get_orders"],
    // Banglish in `re`: `bikri`/`bikroy` (sales), `order`/`ordar`, `delivery`.
    re: /\b(order|orders|ordar|sale|sales|revenue|sold|selling|pending|shipped|delivered|delivery|cancelled|returned|rto|courier|fulfil|fulfill|bikri|bikroy|bikry)\w*\b/i,
    // NO `\b` — see the header. Bangla codepoints are not ASCII word chars.
    bn: /(বিক্রি|অর্ডার|ডেলিভারি|কুরিয়ার|আয়|রাজস্ব)/,
  },
  {
    tools: ["get_products"],
    re: /\b(product|products|stock|stok|inventory|restock|reorder|sku|catalog|catalogue|price|pricing|out of stock|low stock|ponno|pon|mojud|dam)\w*\b/i,
    bn: /(পণ্য|প্রোডাক্ট|স্টক|মজুদ|মজুত|দাম|মূল্য)/,
  },
  {
    tools: ["get_customers"],
    re: /\b(customer|customers|buyer|buyers|vip|repeat|retention|ltv|lifetime|churn|khodder|khoddher|creta)\w*\b/i,
    bn: /(গ্রাহক|ক্রেতা|কাস্টমার|খদ্দের)/,
  },
  {
    tools: ["get_abandoned_carts"],
    re: /\b(cart|carts|abandon|checkout|recover|recovery)\w*\b/i,
    bn: /(কার্ট|চেকআউট)/,
  },
  {
    tools: ["get_finance_overview"],
    // `taka` earns its place — it is how a founder says "money" here. `labh`
    // (profit), `khoroch` (cost), `munafa` (margin) likewise.
    re: /\b(cash|money|profit|loss|margin|expense|payable|receivable|ledger|finance|financial|p&l|pnl|taka|labh|munafa|khoroch|hisab|hishab)\w*\b/i,
    bn: /(টাকা|লাভ|মুনাফা|খরচ|ব্যয়|হিসাব|ক্ষতি|লোকসান)/,
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
    if (rule.re.test(trimmed) || rule.bn?.test(trimmed)) {
      for (const tool of rule.tools) matched.add(tool);
    }
  }
  if (matched.size > 0) return { tools: [...matched], reason: "topic" };

  if (trimmed.length <= 40 && (OPENER_RE.test(trimmed) || CHECKIN_RE.test(trimmed))) {
    return { tools: [], reason: "opener" };
  }

  return { tools: [...ALL_TOOL_NAMES], reason: "default" };
}
