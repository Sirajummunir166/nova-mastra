/**
 * Front Office inbox constants — the closed intent set, the deterministic
 * intent→department map, and the shared numeric contracts.
 *
 * One source, three consumers (canonical §2.6, module 09 D3): the customer
 * runtime picks the intent, the autonomy branch reads the safe-intent
 * allowlist against it, and attribution derives the department from it. The
 * map is DATA, never model-adjustable: the classifier proposes an intent, the
 * table decides which room the work lands in. Same invariant as
 * `authority.ts` — model output can propose, never authorize.
 *
 * Module 09 owns the canonical table; the copy here is the shipped one that
 * modules 02+ import. Department strings are real {@link NovaDepartment}
 * members only.
 */

import type { NovaDepartment } from "./types.js";

/**
 * The closed intent slug set (canonical §2.6). `general` is the FALLBACK —
 * the honest "I could not classify this", never a guess dressed up as one.
 */
export const INBOX_INTENTS = [
  // sales
  "price_query",
  "product_question",
  "availability_check",
  "checkout_help",
  "cart_recovery",
  "lead_followup",
  "upsell",
  "winback",
  // support
  "order_status",
  "complaint",
  "return_refund",
  "general",
  "review_ask",
  // shipping
  "delivery_eta",
  "delivery_issue",
  "address_confirm",
  "cod_confirm",
  // finance
  "payment_claim",
  // marketing (Click-to-Messenger ad / boosted-post origin)
  "ad_reply",
] as const;

export type InboxIntent = (typeof INBOX_INTENTS)[number];

/**
 * Intent → department. Deterministic given the intent, so two surfaces can
 * never disagree about which room a reply belongs to.
 *
 * Split rationale (module 09 D3), because the boundaries look arbitrary until
 * you have stood in a BD merchant's inbox: an order placed but not shipped is
 * support's ("is it confirmed?"); a parcel already with the courier is
 * shipping's ("where is it?"); courier problems and failed attempts are
 * `delivery_issue`, also shipping; money claims are finance's.
 */
export const DEPARTMENT_BY_INTENT: Record<InboxIntent, NovaDepartment> = {
  price_query: "sales",
  product_question: "sales",
  availability_check: "sales",
  checkout_help: "sales",
  cart_recovery: "sales",
  lead_followup: "sales",
  upsell: "sales",
  winback: "sales",

  order_status: "support",
  complaint: "support",
  return_refund: "support",
  general: "support",
  review_ask: "support",

  delivery_eta: "shipping",
  delivery_issue: "shipping",
  address_confirm: "shipping",
  cod_confirm: "shipping",

  payment_claim: "finance",

  ad_reply: "marketing",
};

/**
 * Below this receipt confidence a turn counts toward the `lost` escalation
 * streak (module 08 trigger 5). Shared so the runtime, the escalation
 * detector, and attribution all mean the same number by "not sure".
 */
export const INBOX_LOW_CONFIDENCE = 0.55;

/**
 * Reply-loop breaker: at most this many consecutive Nova messages since the
 * last customer inbound (module 01 D6 layer 4). dakio-api's `/reply` route is
 * where it is ENFORCED (409 `LOOP_GUARD` + a receipted blocked row); the
 * constant lives here so the demo backend and the agent-side reasoning use the
 * same number instead of a second, drifting copy.
 */
export const NOVA_MAX_CONSECUTIVE_OUTBOUND = 5;

// Mastra port: `pinnedConversationId`/`scopedConversationId` (eve customer-session
// scoping via `customer/principal`) were not ported — only the intent tables and
// shared numeric contracts above are framework-independent.
