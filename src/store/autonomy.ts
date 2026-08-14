/**
 * The autonomy gate — decides, for every action Nova wants to take, whether
 * it executes immediately, is queued for owner approval, or is blocked.
 *
 * PRD autonomy levels:
 *   0 observation only — no actions, only reports
 *   1 recommendations  — every action becomes an approval task
 *   2 prepared actions — Nova drafts the full action, owner approves
 *   3 autonomous       — low-risk actions run automatically, owner notified
 *   4 business operator — runs operations within owner-set guardrails
 */

import type {
  ActionType,
  AutonomyConfig,
  Guardrails,
  RiskClass,
} from "./types.js";
import type { StoreClient } from "./client.js";

/**
 * Guardrails come in two kinds, and the difference matters whenever the demo
 * data or a store's currency changes:
 *
 *  - PERCENTAGE guardrails are currency-invariant. They mean the same thing at
 *    any denomination.
 *  - MONEY guardrails are denominated in ৳ (BDT, Dakio's currency). They must
 *    be re-denominated in lockstep with the data they are compared against, or
 *    the gate silently changes behaviour — every purchase order flipping from
 *    "execute" to "needs approval" while every test still passes.
 *    `scripts/money-audit.ts` is the check for that.
 */
export const DEFAULT_GUARDRAILS: Guardrails = {
  // Percentages — currency-invariant.
  maxDiscountPct: 20,
  maxPriceChangePct: 15,
  maxBudgetChangePct: 50,
  minMarginPct: 25,
  // ৳ amounts — must move with the data.
  maxAutoPurchaseOrderTotal: 300_000,
  /**
   * NOT ENFORCED TODAY. There is no refund action in `ActionType`, and no
   * branch of `checkGuardrails` reads this, so setting it changes nothing —
   * it is a promise the code does not keep. Kept (and re-denominated) because
   * the owner-facing config already exposes it and dropping it would silently
   * discard a stored setting; wire it up when a refund action lands.
   */
  maxAutoRefundTotal: 12_000,
};

/** Inherent risk of each action type, before guardrails are considered. */
export const RISK_CLASS: Record<ActionType, RiskClass> = {
  send_customer_message: "low",
  resolve_ticket: "low",
  // Front Office. Both are `low` deliberately: the risk control on a customer
  // reply is the fail-closed guardrail branch below (safe-intent allowlist +
  // thread state), not a risk class that would force every "1250 tk" answer
  // through the founder. Escalation is low because stepping back is never the
  // dangerous move.
  send_inbox_reply: "low",
  escalate_conversation: "low",
  // Module 03. Linking is `low` because it is deterministic, self-asserted and
  // reversible: the SERVER matched the number, not the model, and the undo
  // clears the join. It is also in NEVER_GATED, so this class is advisory for
  // it — the risk statement still belongs here for the ledger and the card.
  link_customer_identity: "low",
  // Module 04. `low` because scheduling books a job row and nothing else: the
  // reply it eventually composes is a separate `send_inbox_reply` through the
  // full gate, and the undo cancels the job cleanly. Unlike the link above,
  // this class is NOT advisory — `schedule_follow_up` is deliberately absent
  // from `NEVER_GATED` (OD-6), so the tier dial and the guardrail branch really
  // do judge it, and this is the risk they judge it at.
  schedule_follow_up: "low",
  // Module 05 (C-2, and this ruling was checked against `verdictForLevel`
  // rather than inherited). `low` for both selling verbs, which reads wrong
  // until you see what `medium` would actually do: at level 3 a `medium` verb
  // drafts, so every chat order would stay a card until the WHOLE STORE reached
  // L4 — the inbox tier dial would be unable to move on its own, which is the
  // one thing the tier ladder exists to do. What holds a chat order back is not
  // this row: it is `inbox.orderAuto`, which ships FALSE and is refused upward
  // by `tierMoveDecision` until module 11 (FD-3), plus the fail-closed guardrail
  // branch below. Two controls that a founder can see and turn, instead of a
  // risk class that couples two dials together.
  create_order_from_chat: "low",
  offer_chat_discount: "low",
  publish_social_post: "low",
  update_campaign: "medium",
  create_campaign: "medium",
  create_discount: "medium",
  update_price: "medium",
  import_product: "medium",
  assign_courier: "medium",
  create_purchase_order: "high",
  switch_supplier: "high",
  // Module 03. `high` because merging rewires orders, channels, conversations
  // and promises across two Customer rows and there is no inverse. Note that
  // `high` alone does NOT deliver D5's "always drafts": `verdictForLevel`
  // returns `execute` for every risk class at level 4. `ALWAYS_DRAFT` in
  // authority.ts is what makes the promise true; this row states the risk.
  merge_customer_records: "high",
  // Module 05 D7. `high` because the founder is being asked to rule on whether
  // money arrived, off a screenshot no code in this system can read. Note what
  // this row does NOT deliver, because the module doc claimed it did: `high`
  // does not mean "always drafts, at every tier, forever". `verdictForLevel`
  // returns `execute` for EVERY risk class at level 4, and level 4 is reachable
  // (`novaTrust.js` promotes `earnedLevel` on a good record). `ALWAYS_DRAFT` in
  // authority.ts — mirrored in dakio-api's `novaAuthority.js` — is the
  // mechanism that makes the promise true. This row states the risk; that set
  // enforces it. Exactly the same pairing as `merge_customer_records` above.
  verify_payment_slip: "high",
  // ── Module 06 ───────────────────────────────────────────────────────────
  // `open_case` is bookkeeping in the honest sense: one row, no money, nothing
  // a customer can see. It is still `low` rather than absent from the gate,
  // because opening a case ENQUEUES department work whose last step speaks to a
  // customer, and `NEVER_GATED` — the only mechanism that would bypass the dial
  // — is reserved for verbs that cannot spend, send, or choose.
  open_case: "low",
  // A proposal on a founder's desk. Low risk BECAUSE it executes nothing; what
  // makes it always-ask is `ALWAYS_DRAFT`, not this row.
  flag_courier_issue: "low",
  // Writes `confirmedAt` off the customer's own yes. Low, and deliberately
  // auto-able at T1+: a confirmation ping that needs approving is a confirmation
  // that arrives after the parcel has already gone.
  confirm_order_intent: "low",
  // Changes where a parcel is going. Pre-dispatch only — the executor refuses
  // once `courierSentAt` is set, because after that the address on the label is
  // the courier's, not ours.
  update_order_contact: "medium",
  // Cancels a real order. `medium` states the risk; `inbox.cancelAuto` (shipped
  // false) is what actually gates it.
  cancel_order_from_chat: "medium",
  bulk_refund: "high",
};

export interface GateDecision {
  verdict: "execute" | "prepare" | "block";
  riskClass: RiskClass;
  /** Why this verdict — always safe to show the owner. */
  explanation: string;
}

type GuardrailCheck =
  | { result: "allow" }
  | { result: "needs_approval"; why: string; rule: string; whyBn?: string }
  | { result: "block"; why: string; rule: string; whyBn?: string };

/**
 * What a chat order will cost, in WHOLE TAKA, for the auto-order cap only.
 *
 * The payload carries NO money — no `unitPrice`, no `total`, deliberately (see
 * module 05's payload header in `nova/schemas.ts`) — so the cap has to price the
 * order itself. It prices from the CATALOGUE, never from anything the model
 * wrote, which is the whole reason the payload is shaped that way.
 *
 * `null` means UNPRICEABLE and the caller must draft. Returning 0 for a product
 * that would not read would be a total under every cap.
 *
 * TWO DELIBERATE OVER-ESTIMATES, both in the fail-closed direction:
 *
 *  - delivery is charged at the OUTSIDE-Dhaka rate, always. The real charge
 *    depends on an inside/outside-Dhaka test that lives in dakio-api, and
 *    restating that predicate here would be a second copy of a rule that
 *    decides money — the failure this repo has already had to fix twice.
 *    Taking the larger of the two can only push an order OVER the cap, which
 *    drafts; guessing the smaller could let one under it.
 *  - a coupon is ignored. It lowers the real total, so ignoring it can only
 *    over-state — and the coupon is re-validated server-side and may not hold
 *    at all, so subtracting a discount the order might not get would be sizing
 *    against a price nobody was charged.
 *
 * So this is an upper bound on what the customer will be asked to pay, and the
 * cap is a bound on what Nova may commit alone. Comparing the two is the
 * conservative pairing.
 */
async function estimateChatOrderTotal(
  client: StoreClient,
  payload: Record<string, unknown>,
): Promise<number | null> {
  const items = payload.items;
  if (!Array.isArray(items) || items.length === 0) return null;
  let goods = 0;
  for (const raw of items) {
    if (!raw || typeof raw !== "object") return null;
    const line = raw as Record<string, unknown>;
    const qty = Number(line.qty ?? NaN);
    if (!Number.isFinite(qty) || qty <= 0) return null;
    let product: Awaited<ReturnType<StoreClient["getProduct"]>>;
    try {
      product = await client.getProduct(String(line.productId ?? ""));
    } catch {
      return null;
    }
    if (!product || !Number.isFinite(product.price)) return null;
    // The VARIANT's price override is not applied — this backend boundary has
    // no variant read, and a variant is priced at or above the product's own
    // price in practice, so the product price is the lower of the two. That
    // makes this one over-estimate that does NOT hold, and it is called out
    // rather than hidden: an XL that costs more than the base product could
    // size just under a cap the real order clears. It is bounded by the
    // variant premium, and the cap is a soft control with a founder behind it.
    goods += product.price * qty;
  }
  let delivery = 0;
  try {
    const settings = await client.getStoreSettings();
    delivery = Math.max(settings.deliveryInsideDhaka, settings.deliveryOutsideDhaka);
  } catch {
    // Unreadable settings ⇒ unsizeable order. Charging zero delivery would be
    // the fail-open version of this.
    return null;
  }
  if (!Number.isFinite(delivery)) return null;
  return goods + delivery;
}

/**
 * Hard business limits. "block" means Nova may never do it, even with
 * approval — the owner must change the guardrail itself. "needs_approval"
 * means the action is legitimate but exceeds what Nova may do alone.
 */
async function checkGuardrails(
  client: StoreClient,
  guardrails: Guardrails,
  type: ActionType,
  payload: Record<string, unknown>,
): Promise<GuardrailCheck> {
  switch (type) {
    case "create_discount": {
      const percentOff = Number(payload.percentOff ?? 0);
      if (percentOff > guardrails.maxDiscountPct) {
        return {
          result: "block",
          rule: "max_discount_pct",
          why: `Discount of ${percentOff}% exceeds the ${guardrails.maxDiscountPct}% guardrail.`,
        };
      }
      return { result: "allow" };
    }
    case "update_price": {
      const productId = String(payload.productId ?? "");
      const newPrice = Number(payload.newPrice ?? 0);
      const product = await client.getProduct(productId);
      if (!product) {
        return { result: "block", rule: "unknown_product", why: `Unknown product: ${productId}` };
      }
      const changePct = Math.abs((newPrice - product.price) / product.price) * 100;
      if (changePct > guardrails.maxPriceChangePct) {
        return {
          result: "needs_approval",
          rule: "max_price_change_pct",
          why: `Price change of ${changePct.toFixed(1)}% exceeds the ${guardrails.maxPriceChangePct}% autonomous limit.`,
        };
      }
      const marginPct = ((newPrice - product.cost) / newPrice) * 100;
      if (marginPct < guardrails.minMarginPct) {
        return {
          result: "block",
          rule: "min_margin_pct",
          why: `New price leaves ${marginPct.toFixed(1)}% margin, below the ${guardrails.minMarginPct}% floor.`,
        };
      }
      return { result: "allow" };
    }
    case "update_campaign": {
      const budget = payload.dailyBudget;
      if (budget === undefined || budget === null) return { result: "allow" };
      const campaign = await client.getCampaign(String(payload.campaignId ?? ""));
      if (!campaign) {
        return { result: "block", rule: "unknown_campaign", why: `Unknown campaign: ${String(payload.campaignId)}` };
      }
      const changePct =
        campaign.dailyBudget > 0
          ? (Math.abs(Number(budget) - campaign.dailyBudget) / campaign.dailyBudget) * 100
          : 100;
      if (changePct > guardrails.maxBudgetChangePct) {
        return {
          result: "needs_approval",
          rule: "max_budget_change_pct",
          why: `Budget change of ${changePct.toFixed(0)}% exceeds the ${guardrails.maxBudgetChangePct}% autonomous limit.`,
        };
      }
      return { result: "allow" };
    }
    /**
     * Front Office reply gate (module 02 D9). FIVE checks (the header said
     * "four" from the day it shipped and the numbered list below has always had
     * five — the count was the typo, not the code), EVERY read fail closed — a
     * missing platform key reads as absent and downgrades to approval, never up
     * to autosend. This is the branch that makes "the model never sends" true at
     * the tier dial rather than only at the route.
     *
     * Thread state is read from the SERVER, never from the payload: the model
     * writes the payload, and a payload that could assert "the founder isn't
     * here" would be a lock the model can talk its way past.
     *
     * **MODULE 08 IS THE SPEC AUTHORITY FOR THIS BRANCH AND CHANGED NOT ONE LINE
     * OF IT.** Write that down so the next reader does not re-derive it from the
     * doc. Module 08 owns the semantics — fail-closed `inbox.*` guardrails, the
     * escalation-draft rule, silent drafting while the founder is active — and
     * module 02 implemented every one of them here first, because it needed them
     * to ship a reply path at all. Checked one at a time against doc 08's
     * "new `AuthorityDecision.rule` strings" list: `guardrail:inbox_escalated`
     * (check 1) and `guardrail:inbox_intent_not_auto` (check 2) are emitted
     * here; `duty:thread_off` (check 4) is emitted here as a BLOCK, which is
     * stronger than the doc's downgrade and deliberately so;
     * `concurrency:founder_active` and `concurrency:stale_reply` are dakio-api's
     * `/reply` ladder, not this branch (see the naming note below); the six
     * `inbox_order_*`/`inbox_discount_*`/`inbox_cancel_*` strings gate verbs
     * that exist in NO repo, and a `case` arm for an absent verb is unreachable
     * code that reads as coverage — modules 05/06 add each arm with the verb it
     * gates, in the same change.
     *
     * On the two names for one condition: this branch returns
     * `guardrail:inbox_founder_active` (check 5) where the server returns
     * `concurrency:founder_active`. That is a deliberate split, not drift. This
     * one is a DOWNGRADE TO DRAFT decided before anything was attempted; the
     * server's is a REFUSAL of an attempted send, receipted on a blocked row. A
     * founder reading a receipt needs to know which happened, so the two names
     * stay distinct — and nobody mints a third.
     */
    case "send_inbox_reply": {
      // 1. An escalation draft is a message for the founder to look at, not to
      //    send. It can never auto-execute — at any tier, in any mode.
      if (String(payload.purpose ?? "") === "escalation_draft") {
        return {
          result: "needs_approval",
          rule: "guardrail:inbox_escalated",
          why: "This reply is attached to an escalation, so the founder sends it — Nova never auto-sends an escalation draft.",
          whyBn: "এই উত্তরটি একটি এস্কেলেশনের অংশ, তাই এটি আপনি পাঠাবেন — নোভা নিজে থেকে পাঠায় না।",
        };
      }
      // 2. Safe-intent allowlist. Missing/!Array key ⇒ nothing is auto.
      const intent = String(payload.intent ?? "");
      const autoIntents = guardrails["inbox.autoIntents"];
      const isAuto = Array.isArray(autoIntents) && autoIntents.some((i) => String(i) === intent);
      if (!isAuto) {
        return {
          result: "needs_approval",
          rule: "guardrail:inbox_intent_not_auto",
          why: `"${intent || "unclassified"}" isn't on your auto-reply list, so Nova wrote the reply and left the send to you.`,
          whyBn: `"${intent || "unclassified"}" আপনার স্বয়ংক্রিয় উত্তরের তালিকায় নেই, তাই নোভা উত্তরটি লিখে আপনার জন্য রেখেছে।`,
        };
      }
      // 3. Thread state, read fresh. Unreadable ⇒ draft (fail closed): we
      //    cannot prove the founder isn't mid-conversation.
      const conversationId = String(payload.conversationId ?? "");
      let thread: Awaited<ReturnType<StoreClient["getInboxConversation"]>>;
      try {
        thread = await client.getInboxConversation(conversationId, { messages: 1 });
      } catch {
        thread = null;
      }
      if (!thread) {
        return {
          result: "needs_approval",
          rule: "guardrail:inbox_thread_unreadable",
          why: `Nova couldn't read the state of conversation ${conversationId}, so it prepared the reply instead of sending it.`,
          whyBn: `নোভা এই কথোপকথনের অবস্থা পড়তে পারেনি, তাই উত্তরটি না পাঠিয়ে প্রস্তুত করে রেখেছে।`,
        };
      }
      // 4. Per-thread switch is a refusal, not a downgrade: the founder said
      //    "not this thread", and a draft would still ask them about it.
      if (thread.conversation.novaEnabled !== true) {
        return {
          result: "block",
          rule: "duty:thread_off",
          why: "You switched Nova off for this conversation, so it wrote nothing.",
          whyBn: "আপনি এই কথোপকথনে নোভা বন্ধ রেখেছেন, তাই এটি কিছু লেখেনি।",
        };
      }
      // 5. Founder-held thread: draft silently, never send. The server's lock
      //    check is the guarantee; this just avoids the doomed attempt.
      if (thread.conversation.novaLockedAt !== null || thread.conversation.handledBy === "founder") {
        return {
          result: "needs_approval",
          rule: "guardrail:inbox_founder_active",
          why: "You have this conversation, so Nova drafted the reply instead of sending it.",
          whyBn: "এই কথোপকথনটি এখন আপনার হাতে, তাই নোভা উত্তরটি খসড়া হিসেবে রেখেছে।",
        };
      }
      return { result: "allow" };
    }
    /**
     * Chat order (module 05 D5). FOUR checks, EVERY read fail closed.
     *
     * ── THE FAIL-OPEN TRAP THIS BRANCH IS WRITTEN AROUND. ─────────────────
     * `evaluateAuthority` calls `checkGuardrailsForAuthority(client,
     * state.guardrails.platform, …)`, so the parameter named `guardrails` in
     * this function is ONLY the flat `inbox.*` bag. Its declared type says the
     * canonical trio is there; at runtime it is not. So `guardrails.maxDiscountPct`
     * COMPILES and is `undefined`, `pct > undefined` is `false`, and the clause
     * allows everything — which is not hypothetical: the `create_discount` block
     * at the top of this switch is already dead for exactly this reason, and is
     * masked only by the separate canonical-trio check in `authority.ts`.
     * Every key below is therefore BRACKET-INDEXED under its `inbox.` name and
     * every comparison is written so that a missing key DENIES.
     *
     * ── WHY IT IS BUILT AT ALL, GIVEN IT CANNOT FIRE. ────────────────────
     * `inbox.orderAuto` ships FALSE and `tierMoveDecision` refuses every upward
     * move to T2/T3 until module 11, so check 1 stops every chat order today
     * and the founder approves each one. That is the product decision (FD-3),
     * not a gap. The branch is written correctly anyway because the day the
     * flag flips is the wrong day to discover which comparison was inverted.
     *
     * ── WHAT IT DOES NOT CHECK, AND WHY NOT HERE. ────────────────────────
     * Stock, the ±1 price rule, the fake-order guard and the plan cap all live
     * in `lib/orderCreate.js` and answer at write time with a refusal the
     * customer is told about. A second copy of "may this be sold" in the gate
     * would drift from the first on the next rule either side adds.
     */
    case "create_order_from_chat": {
      // 1. The founder's switch. `!== true` and not `=== false`: a missing key,
      //    a string "true", a 1 — none of them is permission.
      if (guardrails["inbox.orderAuto"] !== true) {
        return {
          result: "needs_approval",
          rule: "guardrail:inbox_order_auto_off",
          why: "Nova doesn't place chat orders on its own, so it prepared this one for you to confirm.",
          whyBn: "নোভা নিজে থেকে চ্যাট অর্ডার বসায় না, তাই এটি আপনার অনুমোদনের জন্য তৈরি করে রেখেছে।",
        };
      }
      // 2. The customer's own yes. The schema makes `confirmedByCustomer`
      //    unsatisfiable except as literal `true`, so this cannot fail through
      //    the tool — it can only fail on a hand-built or replayed payload, and
      //    a COD parcel nobody agreed to is refused at the door and returned at
      //    the shop's cost.
      if (payload.confirmedByCustomer !== true) {
        return {
          result: "needs_approval",
          rule: "guardrail:inbox_order_needs_review",
          why: "This order doesn't carry the customer's explicit confirmation, so Nova left it for you rather than sending a parcel nobody agreed to.",
          whyBn: "এই অর্ডারে ক্রেতার স্পষ্ট সম্মতি নেই, তাই নোভা নিজে না পাঠিয়ে আপনার জন্য রেখেছে।",
        };
      }
      // 3. The size cap, in WHOLE TAKA. `inbox.maxAutoOrder` is taka — it was
      //    `inbox.maxAutoOrderMinor` in the module doc, and comparing a ৳1,780
      //    order against 500000 makes a ৳5,000 cap behave like ৳500,000 and
      //    nothing ever drafts. There is no ×100 anywhere on this path.
      const cap = guardrails["inbox.maxAutoOrder"];
      if (typeof cap !== "number" || !Number.isFinite(cap)) {
        return {
          result: "needs_approval",
          rule: "guardrail:inbox_order_needs_review",
          why: "Nova has no order-size limit to check this against, so it prepared the order instead of placing it.",
          whyBn: "কত টাকার অর্ডার নিজে বসাতে পারবে তার সীমা নোভার কাছে নেই, তাই অর্ডারটি না বসিয়ে প্রস্তুত করেছে।",
        };
      }
      const estimate = await estimateChatOrderTotal(client, payload);
      if (estimate === null) {
        // Unpriceable ⇒ unsizeable ⇒ draft. A product that will not read is
        // also a product the write path is about to refuse, but the gate must
        // not be the layer that guessed a total was under the cap.
        return {
          result: "needs_approval",
          rule: "guardrail:inbox_order_needs_review",
          why: "Nova couldn't price this order from the catalogue, so it couldn't tell whether it is inside your limit — prepared for you instead.",
          whyBn: "ক্যাটালগ থেকে অর্ডারটির দাম বের করা যায়নি, তাই এটি আপনার সীমার মধ্যে কিনা নোভা বুঝতে পারেনি — আপনার জন্য প্রস্তুত করেছে।",
        };
      }
      if (estimate > cap) {
        return {
          result: "needs_approval",
          rule: "guardrail:inbox_order_over_cap",
          why: `This order comes to about ৳${Math.round(estimate).toLocaleString("en-IN")}, over the ৳${Math.round(cap).toLocaleString("en-IN")} Nova may place on its own.`,
          whyBn: `এই অর্ডারটি প্রায় ৳${Math.round(estimate).toLocaleString("en-IN")}, যা নোভা নিজে বসাতে পারে এমন ৳${Math.round(cap).toLocaleString("en-IN")} সীমার বেশি।`,
        };
      }
      // 4. RTO shadow. The threshold is read from the registry and the count
      //    from the server; either one unreadable means Nova cannot prove this
      //    buyer is not a repeat refuser, and "cannot prove" is a draft.
      const rtoLimit = guardrails["inbox.rtoShadowThreshold"];
      if (typeof rtoLimit !== "number" || !Number.isFinite(rtoLimit)) {
        return {
          result: "needs_approval",
          rule: "guardrail:inbox_order_needs_review",
          why: "Nova has no return-history limit to check this buyer against, so it prepared the order for you.",
          whyBn: "ক্রেতার ফেরত-ইতিহাসের কোনো সীমা নোভার কাছে নেই, তাই অর্ডারটি আপনার জন্য প্রস্তুত করেছে।",
        };
      }
      let rtoCount: number | null = null;
      try {
        // `rtoCount` is RETURNED-only and comes from its own groupBy. It is NOT
        // `cancelledOrders`, which lumps RETURNED in with CANCELLED for risk
        // SCORING — reading the shadow threshold off that would draft an order
        // for someone who once changed their mind.
        const risk = await client.getCustomerRisk(String(payload.customerPhone ?? ""));
        rtoCount = typeof risk?.rtoCount === "number" ? risk.rtoCount : null;
      } catch {
        rtoCount = null;
      }
      if (rtoCount === null) {
        return {
          result: "needs_approval",
          rule: "guardrail:inbox_order_needs_review",
          why: "Nova couldn't read this buyer's delivery history, so it prepared the order rather than assuming they are a safe one.",
          whyBn: "এই ক্রেতার আগের ডেলিভারির রেকর্ড নোভা পড়তে পারেনি, তাই ঝুঁকি না নিয়ে অর্ডারটি আপনার জন্য প্রস্তুত করেছে।",
        };
      }
      if (rtoCount >= rtoLimit) {
        return {
          result: "needs_approval",
          rule: "guardrail:inbox_order_needs_review",
          // The COUNT, never a label. "Risky customer" on a founder's card is a
          // judgement; "2 returned parcels" is the fact they decide from.
          why: `This buyer has ${rtoCount} returned parcel${rtoCount === 1 ? "" : "s"} on record, so Nova prepared the order instead of placing it.`,
          whyBn: `এই ক্রেতার ${rtoCount}টি ফেরত আসা পার্সেল রেকর্ডে আছে, তাই নোভা অর্ডারটি নিজে না বসিয়ে প্রস্তুত করেছে।`,
        };
      }
      return { result: "allow" };
    }
    /**
     * Chat discount (module 05 D6). THREE checks, every read fail closed, same
     * bracket-indexing discipline and the same trap as the order branch above.
     *
     * THE SERVER IS THE AUTHORITY on the frequency rule, not this. `POST
     * /api/v1/store/discounts` runs the NovaAction-ledger lookup and answers 409
     * `guardrail:inbox_discount_frequency`; that 409 is what actually prevents
     * the coupon row. This branch deliberately does NOT re-run that query:
     * `listActions` takes no window and no limit, dakio-api caps the page, and a
     * truncated page would silently answer "no prior discount" — a fail-OPEN in
     * the one check that exists to stop a customer being paid to haggle twice.
     * What it can honestly check is that the guard has something to match on and
     * a window to match it in.
     */
    case "offer_chat_discount": {
      const mechanism = String(payload.mechanism ?? "");
      // 1. THE CEILING, BEFORE THE AUTO SWITCH — and that order is the whole
      //    check, not a style preference.
      //
      //    It used to run after `inbox.discountAuto`, which ships FALSE and stays
      //    false until module 11. So the early return fired first on every tenant
      //    alive, every percentage offer came back `needs_approval`, and the
      //    ceiling clause below was unreachable code. Not merely dead: a 90%
      //    offer became an ordinary approve-me card reading "Nova doesn't hand
      //    out discounts on its own" — no mention of the founder's own 15% limit
      //    — and one tap executed it. The ceiling was bypassable by approval,
      //    which is the same as not having one.
      //
      //    BLOCK and NEEDS_APPROVAL are different verdicts and the difference is
      //    exactly this: needs_approval says "you decide", block says "Nova may
      //    not, and neither does one tap". A number past the founder's own limit
      //    is the second kind. Ordering it first is what makes it so.
      if (mechanism === "percent") {
        // The INBOX ceiling, bracket-indexed. `guardrails.maxDiscountPct` would
        // compile here and be undefined — see the trap note on the order branch.
        const ceiling = guardrails["inbox.maxDiscountPct"];
        if (typeof ceiling !== "number" || !Number.isFinite(ceiling)) {
          return {
            result: "needs_approval",
            rule: "guardrail:inbox_discount_no_ceiling",
            why: "Nova has no discount ceiling to check this against, so it prepared the offer for you.",
            whyBn: "ছাড়ের কোনো সর্বোচ্চ সীমা নোভার কাছে নেই, তাই অফারটি আপনার জন্য প্রস্তুত করেছে।",
          };
        }
        const pct = Number(payload.percentOff ?? NaN);
        if (!Number.isFinite(pct) || pct > ceiling) {
          // Named `inbox_max_discount_pct` rather than reusing
          // `max_discount_pct` for the same reason `guardrail:inbox_founder_active`
          // and `concurrency:founder_active` stay distinct: a founder reading a
          // receipt needs to know WHICH ceiling fired — the inbox one or the
          // store-wide one.
          return {
            result: "block",
            rule: "guardrail:inbox_max_discount_pct",
            why: `A ${Number.isFinite(pct) ? pct : "?"}% discount is over the ${ceiling}% Nova may offer in a chat, so it wasn't issued.`,
            whyBn: `${Number.isFinite(pct) ? pct : "?"}% ছাড় চ্যাটে নোভার দেওয়ার সীমা ${ceiling}%-এর বেশি, তাই এটি দেওয়া হয়নি।`,
          };
        }
      } else {
        // A FIXED or free-delivery coupon has NO ceiling in the registry: both
        // enforcement sites in this repo compare `payload.percentOff` only, so a
        // taka discount passes them untouched. Rather than let that read as
        // "allowed", it drafts — and the rule name says the ceiling is missing
        // rather than pretending a switch is off.
        return {
          result: "needs_approval",
          rule: "guardrail:inbox_discount_no_ceiling",
          why: "Your discount limit is set as a percentage, and this offer is a taka amount — Nova has no ceiling to check it against, so it prepared it for you.",
          whyBn: "আপনার ছাড়ের সীমা শতাংশে দেওয়া, আর এই অফারটি টাকায় — মেলানোর মতো কোনো সীমা না থাকায় নোভা এটি আপনার জন্য প্রস্তুত করেছে।",
        };
      }
      // 2. only now the auto switch.
      if (guardrails["inbox.discountAuto"] !== true) {
        return {
          result: "needs_approval",
          rule: "guardrail:inbox_discount_auto_off",
          why: "Nova doesn't hand out discounts on its own, so it prepared this offer for you to approve.",
          whyBn: "নোভা নিজে থেকে ছাড় দেয় না, তাই এই অফারটি আপনার অনুমোদনের জন্য তৈরি করে রেখেছে।",
        };
      }
      const windowDays = guardrails["inbox.discountPerCustomerDays"];
      if (typeof windowDays !== "number" || !Number.isFinite(windowDays)) {
        return {
          result: "needs_approval",
          rule: "guardrail:inbox_discount_frequency",
          why: "Nova has no rule for how often one customer may be given a discount, so it prepared this offer for you.",
          whyBn: "একজন ক্রেতাকে কত দিন পরপর ছাড় দেওয়া যাবে তার নিয়ম নোভার কাছে নেই, তাই অফারটি আপনার জন্য প্রস্তুত করেছে।",
        };
      }
      // Something to match the window against. `Coupon` has no `customerId`
      // column at all, so the only record of who a Nova coupon went to is the
      // NovaAction payload — with neither key the server's guard passes every
      // time and the rule is enforced against nobody.
      const hasIdentity =
        (typeof payload.customerId === "string" && payload.customerId.length > 0) ||
        (typeof payload.conversationId === "string" && payload.conversationId.length > 0);
      if (!hasIdentity) {
        return {
          result: "needs_approval",
          rule: "guardrail:inbox_discount_frequency",
          why: "Nova couldn't tell who this discount is for, so it can't check your once-per-customer rule — prepared for you instead.",
          whyBn: "এই ছাড়টি কার জন্য নোভা বুঝতে পারেনি, তাই আপনার একবার-প্রতি-ক্রেতা নিয়মটি মেলাতে পারেনি — আপনার জন্য প্রস্তুত করেছে।",
        };
      }
      return { result: "allow" };
    }
    case "create_purchase_order": {
      const quantity = Number(payload.quantity ?? 0);
      const unitCost = Number(payload.unitCost ?? 0);
      const total = quantity * unitCost;
      if (total > guardrails.maxAutoPurchaseOrderTotal) {
        return {
          result: "needs_approval",
          why: `PO total ৳${total.toFixed(2)} exceeds the ৳${guardrails.maxAutoPurchaseOrderTotal} autonomous limit.`, rule: "max_auto_purchase_order_total",
        };
      }
      return { result: "allow" };
    }
    /**
     * Cancelling an order from a chat (module 06). One switch, fail-closed,
     * bracket-indexed like every other `inbox.*` key — `guardrails.cancelAuto`
     * would compile here and be `undefined` at runtime, which is the trap
     * `create_discount`'s dead arm above is still sitting in.
     *
     * `!== true`, never `=== false`: a missing key, a string "true", or a 1 are
     * none of them permission.
     */
    case "cancel_order_from_chat": {
      if (guardrails["inbox.cancelAuto"] !== true) {
        return {
          result: "needs_approval",
          rule: "guardrail:inbox_cancel_auto_off",
          why: "Nova doesn't cancel orders on its own, so it prepared this for you to confirm.",
          whyBn: "নোভা নিজে থেকে অর্ডার বাতিল করে না, তাই এটি আপনার অনুমোদনের জন্য প্রস্তুত করেছে।",
        };
      }
      return { result: "allow" };
    }
    /**
     * Changing where a parcel is going (module 06).
     *
     * THIS ARM WAS FIRST WRITTEN AS AN UNCONDITIONAL `allow`, on the reasoning
     * that the server already refuses any change once `courierSentAt` is set and
     * that a pre-dispatch correction is just the customer fixing details they
     * gave a minute ago. `evals/inbox/run.ts`'s empty-platform check caught it,
     * and the check is right: the address is where a COD parcel worth real money
     * goes, and "whoever is typing in this thread" is not the same claim as
     * "the person who placed the order". A redirect is a fraud shape, not only a
     * typo fix.
     *
     * So it gets its own switch, shipped false, and the honest cost is stated:
     * a typo'd address waits for a founder tap. That is the right side to err on
     * when the alternative is Nova silently re-pointing a parcel.
     */
    case "update_order_contact": {
      if (guardrails["inbox.addressEditAuto"] !== true) {
        return {
          result: "needs_approval",
          rule: "guardrail:inbox_address_edit_auto_off",
          why: "Nova doesn't change a delivery address on its own, so it prepared this correction for you to confirm.",
          whyBn: "নোভা নিজে থেকে ডেলিভারি ঠিকানা বদলায় না, তাই সংশোধনটি আপনার অনুমোদনের জন্য প্রস্তুত করেছে।",
        };
      }
      return { result: "allow" };
    }
    default:
      return { result: "allow" };
  }
}

/**
 * The platform superset, exposed to the Stage 1 authority seam.
 *
 * These six numeric caps predate the canonical guardrail trio and remain the
 * outermost bound a tenant cannot loosen past. `evaluateAuthority` calls this
 * LAST, inside itself — deliberately not as a second gate running alongside,
 * which is how two gates drift into disagreeing about the same action.
 */
export async function checkGuardrailsForAuthority(
  client: StoreClient,
  guardrails: Guardrails,
  type: ActionType,
  payload: Record<string, unknown>,
): Promise<GuardrailCheck> {
  return checkGuardrails(client, guardrails, type, payload);
}

/**
 * Decide what happens to an action under the current autonomy config.
 *
 * @deprecated Stage 1 replaced this with `evaluateAuthority` in `authority.ts`,
 * which judges level × mode × guardrails × no-touch × founder-only verb × duty
 * in one place and names the rule that fired. Kept while the older callers and
 * the demo-backend path migrate; do not add new callers.
 */
export async function gateAction(
  client: StoreClient,
  config: AutonomyConfig,
  type: ActionType,
  payload: Record<string, unknown>,
): Promise<GateDecision> {
  const riskClass = RISK_CLASS[type];
  const guardrail = await checkGuardrails(client, config.guardrails, type, payload);

  if (guardrail.result === "block") {
    return { verdict: "block", riskClass, explanation: guardrail.why };
  }

  if (config.level === 0) {
    return {
      verdict: "block",
      riskClass,
      explanation:
        "Autonomy level 0 (observation only): Nova reports and recommends but takes no actions. Raise the autonomy level to enable actions.",
    };
  }

  if (guardrail.result === "needs_approval") {
    return {
      verdict: "prepare",
      riskClass,
      explanation: `${guardrail.why} Prepared for owner approval.`,
    };
  }

  const autoExecute =
    (config.level === 3 && riskClass === "low") || config.level === 4;

  if (autoExecute) {
    return {
      verdict: "execute",
      riskClass,
      explanation: `Within autonomy level ${config.level} and all guardrails.`,
    };
  }

  return {
    verdict: "prepare",
    riskClass,
    explanation: `Autonomy level ${config.level} requires owner approval for ${riskClass}-risk actions.`,
  };
}
