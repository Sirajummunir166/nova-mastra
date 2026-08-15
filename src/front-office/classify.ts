/**
 * Turn classification — the model routing ladder's bottom rungs.
 *
 * L0: deterministic rules — sizes, quantities, zones, phones, confirms,
 *     greetings. ~60% of turns decide here, zero model cost.
 * L1: resolver (small model) — runs ONLY when rules miss. Returns JSON:
 *     intent from a closed enum + entities. Never free text, never picks
 *     the reply. Wired in resolver.ts; this module is pure rules.
 */

export type Intent =
  | "greeting"
  | "product_query" // names/describes a product they want
  | "price_q"
  | "stock_q"
  | "size_pick"
  | "qty_pick"
  | "zone_pick"
  | "phone_give"
  | "address_give"
  | "buy_intent"
  | "confirm"
  | "reject"
  | "discount_ask"
  | "faq_delivery"
  | "order_status_q"
  | "complaint"
  | "human_ask" // wants a person
  | "other";

export interface Classified {
  intent: Intent;
  entities: {
    size?: string;
    qty?: number;
    zone?: string;
    phone?: string;
    address?: string;
    productText?: string;
  };
  /** Which rung decided: 0 = rules, 1 = resolver model. */
  rung: 0 | 1;
  confidence: number;
}

export type { DetectedLang } from "./state.js";
import type { DetectedLang } from "./state.js";

// ---------------------------------------------------------------------------
// Language detection — Bangla script / Banglish / English
// ---------------------------------------------------------------------------

const BANGLA_RANGE = /[ঀ-৿]/;
// Everyday Banglish tokens. Only words that are NOT common English belong here
// ("er"/"pore" stay out) — a false banglish hit on an English customer breaks
// the mirror rule in the other direction.
const BANGLISH_HINTS =
  /\b(bhai|vai|apu|koto|kotO|dam|lagbe|nibo|niben|ase|ache|asche|kobe|taka|tk|dhonnobad|koren|korben|hobe|parbo|chai|dekhen|bhalo|valo|amar|apni|ki|obostha|achha|accha|dekhi|janai|keno|eto)\b/i;

export function detectLang(text: string): { detected: DetectedLang; conf: number } {
  if (BANGLA_RANGE.test(text)) return { detected: "bn", conf: 0.95 };
  if (BANGLISH_HINTS.test(text)) return { detected: "banglish", conf: 0.8 };
  return { detected: "en", conf: 0.7 };
}

// ---------------------------------------------------------------------------
// L0 rules
// ---------------------------------------------------------------------------

// JS `\b` is ASCII-word-based — it NEVER matches adjacent to Bangla letters,
// which left every Bangla alternate below unreachable (the whole Bangla-script
// arm of L0 fell to the paid resolver). These lookarounds are Unicode-aware
// boundaries: identical to `\b` on ASCII (letters, digits, `_`) and extended
// to any script. `\p{M}` is included so an alternate can't fire inside a
// longer Bangla word ("দাম" must not match inside "দামী", "নিব" not inside
// "নিবো" — the vowel signs are combining marks, not letters).
//   left  boundary: (?<![\p{L}\p{M}\p{N}_])
//   right boundary: (?![\p{L}\p{M}\p{N}_])
const SIZE_RE = /(?:^|\s)(xxs|xs|s|m|l|xl|xxl|2xl|3xl)(?:\s|$|[.,!?])/i;
const QTY_RE = /(\d{1,3})\s*(?:ta|টা|pcs?|pieces?|gula|gulo|খানা)/i;
const BARE_NUM_RE = /^\s*(\d{1,3})\s*$/;
const PHONE_RE = /(?:\+?88)?(01[3-9]\d{8})/;
const CONFIRM_RE = /^(?:ji|জি|জ্বি|hae|হ্যাঁ|hmm|হুম|yes|ok(?:ay)?|confirm(?: koren| korlam)?|done|নিব|nibo|sure)(?![\p{L}\p{M}\p{N}_])[.!\s]*$/iu;
const REJECT_RE = /^(?:na|না|no|lagbe na|bad den|cancel|thak)(?![\p{L}\p{M}\p{N}_])/iu;
const GREET_RE = /^(?:hi|hello|hey|salam|আসসালামু|assalamu|সালাম|slm)(?![\p{L}\p{M}\p{N}_])/iu;
const PRICE_RE = /(?<![\p{L}\p{M}\p{N}_])(price|dam|koto|কত|দাম|rate|koto kore|last price|লাস্ট)(?![\p{L}\p{M}\p{N}_])/iu;
const STOCK_RE = /(?<![\p{L}\p{M}\p{N}_])(stock|available|ase|আছে|ache|pawa jabe|পাওয়া)(?![\p{L}\p{M}\p{N}_])/iu;
const DISCOUNT_RE = /(?<![\p{L}\p{M}\p{N}_])(discount|kom|কম|offer|less|komano|চালান)(?![\p{L}\p{M}\p{N}_])/iu;
const DELIVERY_FAQ_RE = /(?<![\p{L}\p{M}\p{N}_])(delivery|charge|shipping|kotodin|কতদিন|dite parben|courier|ডেলিভারি)(?![\p{L}\p{M}\p{N}_])/iu;
const ORDER_STATUS_RE = /(?<![\p{L}\p{M}\p{N}_])(order (?:kothay|status)|track|tracking|আমার অর্ডার|amar order)(?![\p{L}\p{M}\p{N}_])/iu;
const HUMAN_RE = /(?<![\p{L}\p{M}\p{N}_])(manush|admin|owner|call (?:me|den)|kotha bolbo|আসল মানুষ|human|agent)(?![\p{L}\p{M}\p{N}_])/iu;
const COMPLAINT_RE = /(?<![\p{L}\p{M}\p{N}_])(vanga|ভাঙা|kharap|খারাপ|nosto|নষ্ট|refund|ferot|complain|problem|wrong|onno product)(?![\p{L}\p{M}\p{N}_])/iu;
const BUY_RE = /(?<![\p{L}\p{M}\p{N}_])(nibo|নিব|kinbo|কিনব|order (?:korbo|koren|dibo|din)|নেব|buy|purchase)(?![\p{L}\p{M}\p{N}_])/iu;

/** Zone detection needs the store's own zone lexicon; inside/outside Dhaka is the baseline. */
const ZONE_RE = /(?<![\p{L}\p{M}\p{N}_])(dhaka|ঢাকা|savar|সাভার|gazipur|গাজীপুর|narayanganj|chattogram|chittagong|চট্টগ্রাম|sylhet|সিলেট|khulna|খুলনা|rajshahi|রাজশাহী|barishal|বরিশাল|rangpur|রংপুর|mymensingh|ময়মনসিংহ|comilla|cumilla|কুমিল্লা)(?![\p{L}\p{M}\p{N}_])/iu;

/** Contextual agreement while a summary is pending — no forced keyword (R8). */
const CONFIRM_LOOSE_RE = /(?<![\p{L}\p{M}\p{N}_])(confirm|কনফার্ম|ji|জি|জ্বি|hae|হ্যাঁ|ok(?:ay)?|thik ase|ঠিক আছে|kore den|করে দিন|den|দেন|koren|করেন|nibo|নিব)(?![\p{L}\p{M}\p{N}_])/iu;

export function classifyL0(text: string, opts: { awaiting?: "qty" | "size" | "confirm" | null } = {}): Classified | null {
  const t = text.trim();

  const confirm = CONFIRM_RE.test(t) || (opts.awaiting === "confirm" && !REJECT_RE.test(t) && CONFIRM_LOOSE_RE.test(t) && t.length <= 40);
  if (confirm) return { intent: "confirm", entities: {}, rung: 0, confidence: 0.95 };
  if (REJECT_RE.test(t)) return { intent: "reject", entities: {}, rung: 0, confidence: 0.9 };

  const phone = PHONE_RE.exec(t)?.[1];
  if (phone) {
    // A phone number often arrives inside an address line — keep both.
    const stripped = t.replace(PHONE_RE, "").trim();
    return {
      intent: "phone_give",
      entities: { phone, address: stripped.length >= 12 ? stripped : undefined },
      rung: 0,
      confidence: 0.95,
    };
  }

  const size = SIZE_RE.exec(t)?.[1]?.toUpperCase();
  const qty = QTY_RE.exec(t)?.[1] ?? (opts.awaiting === "qty" ? BARE_NUM_RE.exec(t)?.[1] : undefined);
  const zone = ZONE_RE.exec(t)?.[1];
  if (size && !PRICE_RE.test(t) && !STOCK_RE.test(t)) {
    return { intent: "size_pick", entities: { size, qty: qty ? Number(qty) : undefined }, rung: 0, confidence: 0.9 };
  }
  if (qty) return { intent: "qty_pick", entities: { qty: Number(qty) }, rung: 0, confidence: 0.9 };
  if (zone && t.length <= 40) return { intent: "zone_pick", entities: { zone: zone.toLowerCase() }, rung: 0, confidence: 0.8 };

  if (GREET_RE.test(t) && t.length <= 30) return { intent: "greeting", entities: {}, rung: 0, confidence: 0.9 };
  // Explicit language switch — the turn engine reads the same signal to move
  // lang.pref; classifying here keeps it off the resolver.
  if (/(?<![\p{L}\p{M}\p{N}_])(english please|in english|speak english|talk in english|banglay bolen|বাংলায় বলেন|bangla(?:y|te)? (?:bolen|bolun|likhen))(?![\p{L}\p{M}\p{N}_])/iu.test(t)) {
    return { intent: "other", entities: {}, rung: 0, confidence: 0.9 };
  }
  if (ORDER_STATUS_RE.test(t)) return { intent: "order_status_q", entities: {}, rung: 0, confidence: 0.85 };
  if (HUMAN_RE.test(t)) return { intent: "human_ask", entities: {}, rung: 0, confidence: 0.8 };
  if (COMPLAINT_RE.test(t)) return { intent: "complaint", entities: {}, rung: 0, confidence: 0.7 };
  if (DISCOUNT_RE.test(t) && PRICE_RE.test(t)) return { intent: "discount_ask", entities: {}, rung: 0, confidence: 0.8 };
  if (DELIVERY_FAQ_RE.test(t)) return { intent: "faq_delivery", entities: {}, rung: 0, confidence: 0.75 };
  if (BUY_RE.test(t)) return { intent: "buy_intent", entities: { productText: t }, rung: 0, confidence: 0.75 };
  if (PRICE_RE.test(t)) return { intent: "price_q", entities: { productText: t }, rung: 0, confidence: 0.75 };
  if (STOCK_RE.test(t)) return { intent: "stock_q", entities: { productText: t }, rung: 0, confidence: 0.7 };

  return null; // rules miss → L1 resolver
}
