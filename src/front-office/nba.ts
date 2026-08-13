/**
 * Next Best Action — deterministic, computed from stage + missing[] + intent.
 * The app picks the move; the model only words it. (PRD §02/§04: "the model
 * never picks the move, only names the message".)
 */

import type { Intent } from "./classify.js";
import { computeMissing, type NovaLiveContext } from "./state.js";

export type NextAction =
  | "GREET"
  | "ASK_PRODUCT"
  | "ANSWER_PRICE"
  | "ANSWER_STOCK"
  | "ANSWER_DELIVERY_FAQ"
  | "ASK_SIZE"
  | "ASK_QTY"
  | "ASK_ZONE"
  | "ASK_PHONE_ADDR"
  | "PRESENT_SUMMARY"
  | "CREATE_ORDER"
  | "DECLINE_DISCOUNT_ONCE"
  | "OFFER_ALTERNATIVE"
  | "ANSWER_ORDER_STATUS"
  | "ESCALATE"
  | "ACKNOWLEDGE_REJECT"
  | "CLARIFY";

/**
 * Order of asks on the checkout ladder: variant → qty → zone → phone/addr →
 * one summary → confirm → mutate. Ask ONLY for missing fields, one at a time.
 */
export function nextBestAction(ctx: NovaLiveContext, intent: Intent): NextAction {
  // Intent-forced branches first — judgment/authority moves beat the ladder.
  if (intent === "human_ask" || intent === "complaint") return "ESCALATE";
  if (intent === "order_status_q") return "ANSWER_ORDER_STATUS";
  if (intent === "discount_ask") return "DECLINE_DISCOUNT_ONCE";
  if (intent === "faq_delivery") return "ANSWER_DELIVERY_FAQ";
  if (intent === "reject") return "ACKNOWLEDGE_REJECT";

  const missing = computeMissing(ctx);

  if (intent === "confirm" && ctx.purchase.confirmSent) return "CREATE_ORDER";

  if (!ctx.products.focusId) {
    if (intent === "greeting") return "GREET";
    if (intent === "product_query" || intent === "buy_intent" || intent === "price_q" || intent === "stock_q")
      return "ASK_PRODUCT"; // caller resolves product first; falls back here if not found
    return "CLARIFY";
  }

  // Focused product: answer the asked question first ("answer first, then one
  // step forward" — the writer does both in one message).
  if (intent === "price_q") return "ANSWER_PRICE";
  if (intent === "stock_q") return "ANSWER_STOCK";

  const infoMissing = missing.filter((m) => m !== "confirmation");
  if (infoMissing.includes("variant")) return "ASK_SIZE";
  if (infoMissing.includes("qty")) return "ASK_QTY";
  if (infoMissing.includes("zone")) return "ASK_ZONE";
  if (infoMissing.includes("phone") || infoMissing.includes("address")) return "ASK_PHONE_ADDR";

  // Everything known → ONE summary, then await the confirm.
  return "PRESENT_SUMMARY";
}
