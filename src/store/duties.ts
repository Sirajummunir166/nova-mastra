/**
 * The duty registry (PRD E-5, §6) — what Nova claims it does, and where each
 * claim lands.
 *
 * This file is the SOURCE OF TRUTH. dakio-api mirrors it per tenant into
 * `NovaDuty` so a founder can toggle individual duties, but the roster itself
 * is checked in here and reviewed like code.
 *
 * Why it exists: a list of 65 capabilities is a promise. Without a registry,
 * "Nova handles RTO reduction" is a sentence in a pitch deck; with one, it is a
 * row that names the door it writes to, the autonomy level it needs, and —
 * critically — whether that door has actually been built yet. `doorExists:
 * false` is the honesty mechanism. Four duties carry it today, and the roster
 * says so rather than quietly implying a surface the founder can't open.
 *
 * Status is COMPUTED, never stored (see {@link dutyStatus}), because it depends
 * on the tenant's current level, which changes independently of this file.
 */

import type { ActionType, NovaDepartment } from "./types.js";

/** A founder-facing surface a duty writes into. */
export interface DoorSpec {
  /** Is there a screen a founder can actually open today? */
  exists: boolean;
  /** For doors that don't exist yet: the phase that builds them. */
  buildPhase?: string;
  /** Where it lives, for the roster's "open the door" link. */
  route?: string;
}

/**
 * Every door the roster references.
 *
 * The six Grow Lab modules (Campaigns, Content Studio, Broadcast, Research,
 * Growth, Goals) shipped ahead of Nova, so they are `exists: true` from day
 * one — Nova is moving into rooms the founder already uses, not building new
 * ones. The four `exists: false` entries are the PRD's named NEEDS DOOR set.
 */
export const DOORS: Record<string, DoorSpec> = {
  "Nova HQ": { exists: true, route: "/nova" },
  // Grow Lab — shipped modules.
  Goals: { exists: true, route: "/grow/goals" },
  Campaigns: { exists: true, route: "/grow/campaigns" },
  "Content Studio": { exists: true, route: "/grow/posts" },
  Broadcast: { exists: true, route: "/grow/broadcasts" },
  Research: { exists: true, route: "/grow/ideas" },
  Growth: { exists: true, route: "/grow/opportunities" },
  // Core merchant modules.
  Inbox: { exists: true, route: "/inbox" },
  Orders: { exists: true, route: "/orders" },
  Products: { exists: true, route: "/products" },
  Coupons: { exists: true, route: "/coupons" },
  Purchases: { exists: true, route: "/purchases" },
  Delivery: { exists: true, route: "/courier" },
  Accounts: { exists: true, route: "/accounts" },
  Reports: { exists: true, route: "/reports" },
  "Store Studio": { exists: true, route: "/store-studio" },
  Dropshipping: { exists: true, route: "/dropshipping" },
  // Stage 6 (Phase 12) shipped these four sub-view doors as read-model surfaces
  // on the merchant Reach page (/nova/reach), backed by /api/nova/doors/*. Zero
  // NEEDS DOOR remain — every duty now has a real door or an honest locked state.
  "Rate Compare": { exists: true, route: "/nova/reach" },
  "RTO Analytics": { exists: true, route: "/nova/reach" },
  "P&L Reports": { exists: true, route: "/nova/reach" },
  "RFQ Compare": { exists: true, route: "/nova/reach" },
};

export interface DutySpec {
  /** Stable identity, `<department>.<slug>`. Never renamed once shipped. */
  key: string;
  department: NovaDepartment;
  name: string;
  /** Founder-facing Bangla name — the roster is bn+en (§14 NFR). */
  nameBn: string;
  /** Key into {@link DOORS}. */
  door: string;
  /** Lowest autonomy level at which Nova may perform this duty at all. */
  minLevel: number;
}

/**
 * The duty roster — 65 mined duties plus the Front Office additions: two in
 * Stage 10 module 02 (`support.inbox_replies`, `support.inbox_escalations`) and
 * three in module 05 (`sales.inbox_orders`, `sales.inbox_discounts`,
 * `sales.inbox_cart_recovery`). 70 rows.
 *
 * `evals/duties/run.ts` records each phase's addition against the mined 65, so
 * the total is never a mystery; adding a duty here without updating that count
 * fails `npm run test:duties`, and without re-running
 * `scripts/export-duty-seed.ts` it fails `npm run check:duty-seed` — which sits
 * THIRD in the `&&`-chained `npm test`, so everything after it stops running.
 *
 * Mined from the merchant prototype's `DEPT_ROOMS` roster (which totals exactly
 * 65) and the PRD §6 charters, with four deliberate curation edits — recorded
 * here because the parity fixture checks them and a future reader will
 * otherwise think the seed drifted:
 *
 *  1. Finance's "Weekly P&L" + "Cashflow forecast" merge into one
 *     `finance.pnl_reports` — the prototype split one door across two rows.
 *  2. Operations' "Quote comparison" + "Supplier scorecards" merge into
 *     `operations.rfq_compare`, same reason. It keeps the LOWER of the two
 *     minLevels (1), because scorecards are a read.
 *  3. `operations.supplier_switching` is ADDED — the prototype omitted it, but
 *     `switch_supplier` is a shipped verb, so Nova was doing work no duty
 *     claimed.
 *  4. `shipping.delay_prediction` is ADDED from the PRD §6 shipping charter.
 *
 * Plus three re-doorings, so no duty points at a door that doesn't exist unless
 * it is one of the four NEEDS DOOR entries: Support's "Review responses" moves
 * from a non-existent Reviews screen to Inbox, and Marketing's two door-less ad
 * duties move to Campaigns.
 */
export const DUTIES: DutySpec[] = [
  // ── CEO (6) — root Nova's own work; there is no `ceo` subagent. ──────────
  { key: "ceo.daily_business_brief", department: "ceo", name: "Daily business brief", nameBn: "দৈনিক ব্যবসা ব্রিফ", door: "Nova HQ", minLevel: 1 },
  { key: "ceo.department_oversight", department: "ceo", name: "Department oversight", nameBn: "বিভাগ তদারকি", door: "Nova HQ", minLevel: 0 },
  { key: "ceo.risk_alerts", department: "ceo", name: "Risk alerts", nameBn: "ঝুঁকি সতর্কতা", door: "Nova HQ", minLevel: 0 },
  { key: "ceo.goal_tracking", department: "ceo", name: "Goal & target tracking", nameBn: "লক্ষ্য ও টার্গেট ট্র্যাকিং", door: "Goals", minLevel: 1 },
  { key: "ceo.revenue_forecasting", department: "ceo", name: "Revenue forecasting", nameBn: "আয়ের পূর্বাভাস", door: "Goals", minLevel: 2 },
  { key: "ceo.weekly_strategy_memo", department: "ceo", name: "Weekly strategy memo", nameBn: "সাপ্তাহিক কৌশল মেমো", door: "Goals", minLevel: 2 },

  // ── Marketing (10) ───────────────────────────────────────────────────────
  { key: "marketing.ad_budget_optimization", department: "marketing", name: "Ad budget optimization", nameBn: "বিজ্ঞাপন বাজেট অপ্টিমাইজেশন", door: "Campaigns", minLevel: 3 },
  { key: "marketing.pause_weak_ad_sets", department: "marketing", name: "Pause weak ad sets", nameBn: "দুর্বল অ্যাড সেট বন্ধ করা", door: "Campaigns", minLevel: 3 },
  { key: "marketing.ad_copywriting", department: "marketing", name: "Ad copywriting", nameBn: "বিজ্ঞাপনের কপি লেখা", door: "Content Studio", minLevel: 2 },
  { key: "marketing.email_campaigns", department: "marketing", name: "Email campaigns", nameBn: "ইমেইল ক্যাম্পেইন", door: "Broadcast", minLevel: 3 },
  { key: "marketing.sms_campaigns", department: "marketing", name: "SMS campaigns", nameBn: "এসএমএস ক্যাম্পেইন", door: "Broadcast", minLevel: 3 },
  { key: "marketing.push_notifications", department: "marketing", name: "Push notifications", nameBn: "পুশ নোটিফিকেশন", door: "Broadcast", minLevel: 3 },
  { key: "marketing.social_posts", department: "marketing", name: "Social posts (FB/IG)", nameBn: "সোশ্যাল পোস্ট (FB/IG)", door: "Content Studio", minLevel: 3 },
  { key: "marketing.reels_and_stories", department: "marketing", name: "Reels & stories", nameBn: "রিলস ও স্টোরি", door: "Content Studio", minLevel: 3 },
  { key: "marketing.seasonal_promotions", department: "marketing", name: "Seasonal promotions", nameBn: "মৌসুমি প্রোমোশন", door: "Campaigns", minLevel: 3 },
  { key: "marketing.campaign_scaling", department: "marketing", name: "Campaign scale up/down", nameBn: "ক্যাম্পেইন বাড়ানো/কমানো", door: "Campaigns", minLevel: 3 },

  // ── Sales (8) ────────────────────────────────────────────────────────────
  { key: "sales.whatsapp_cart_recovery", department: "sales", name: "WhatsApp cart recovery", nameBn: "হোয়াটসঅ্যাপে কার্ট রিকভারি", door: "Inbox", minLevel: 3 },
  { key: "sales.lead_followups", department: "sales", name: "Lead follow-ups", nameBn: "লিড ফলো-আপ", door: "Inbox", minLevel: 3 },
  { key: "sales.bulk_buyer_quotes", department: "sales", name: "Bulk-buyer quotes", nameBn: "পাইকারি ক্রেতার কোটেশন", door: "Orders", minLevel: 2 },
  { key: "sales.payment_chasing", department: "sales", name: "Payment chasing", nameBn: "পেমেন্টের তাগাদা", door: "Orders", minLevel: 3 },
  { key: "sales.upsell_offers", department: "sales", name: "Upsell offers", nameBn: "আপসেল অফার", door: "Coupons", minLevel: 3 },
  { key: "sales.sms_cart_recovery", department: "sales", name: "SMS cart recovery", nameBn: "এসএমএসে কার্ট রিকভারি", door: "Broadcast", minLevel: 3 },
  { key: "sales.abandoned_checkout_emails", department: "sales", name: "Abandoned-checkout emails", nameBn: "অসমাপ্ত চেকআউট ইমেইল", door: "Broadcast", minLevel: 3 },
  { key: "sales.winback_campaigns", department: "sales", name: "Win-back campaigns", nameBn: "উইন-ব্যাক ক্যাম্পেইন", door: "Broadcast", minLevel: 3 },
  // ADDED (Stage 10 module 05): the three selling verbs answer to duties of
  // their own, so a founder can stop Nova taking orders in chat without also
  // silencing its replies. Registering them is not bookkeeping — an off-roster
  // `dutyRef` is not a soft failure: `evaluateAuthority` returns `refuse` with
  // rule `duty:unknown` PLUS an escalation, 100% of the time, at every tier,
  // BEFORE the never-gated and always-draft branches. Ship the verbs against
  // these keys before the keys exist and every chat order is refused, with a
  // receipt telling the founder the duty is not on Nova's roster.
  //
  // All three `minLevel: 2`, matching the two module-02 inbox duties above and
  // for the same reason: Shadow (assisted mode, effective level 2) must be able
  // to DRAFT a chat order, because watching Nova draft orders it cannot send is
  // the entire content of the shadow week. A minLevel of 3 would make the
  // shadow week show nothing.
  //
  // Door "Inbox" for all three, including cart recovery — the founder answers
  // these where the conversation is. `sales.whatsapp_cart_recovery` above is a
  // DIFFERENT duty (a Broadcast/WhatsApp blast at minLevel 3); this one is the
  // in-thread nudge module 05 D8 books as a follow-up.
  { key: "sales.inbox_orders", department: "sales", name: "Orders taken in chat", nameBn: "চ্যাটে অর্ডার নেওয়া", door: "Inbox", minLevel: 2 },
  { key: "sales.inbox_discounts", department: "sales", name: "Discounts offered in chat", nameBn: "চ্যাটে ছাড় দেওয়া", door: "Inbox", minLevel: 2 },
  { key: "sales.inbox_cart_recovery", department: "sales", name: "Abandoned-cart nudges in chat", nameBn: "চ্যাটে অসমাপ্ত কার্টের তাগাদা", door: "Inbox", minLevel: 2 },

  // ── Support (6) ──────────────────────────────────────────────────────────
  { key: "support.customer_replies", department: "support", name: "Customer replies", nameBn: "ক্রেতার উত্তর", door: "Inbox", minLevel: 2 },
  { key: "support.complaint_resolution", department: "support", name: "Complaint resolution", nameBn: "অভিযোগ নিষ্পত্তি", door: "Inbox", minLevel: 3 },
  { key: "support.faq_policy_updates", department: "support", name: "FAQ & policy updates", nameBn: "FAQ ও পলিসি হালনাগাদ", door: "Store Studio", minLevel: 2 },
  { key: "support.refund_processing", department: "support", name: "Refund processing", nameBn: "রিফান্ড প্রক্রিয়া", door: "Orders", minLevel: 4 },
  { key: "support.replacement_shipments", department: "support", name: "Replacement shipments", nameBn: "বদলি পণ্য পাঠানো", door: "Orders", minLevel: 4 },
  // Re-doored: the prototype pointed this at a Reviews screen that doesn't exist.
  { key: "support.review_responses", department: "support", name: "Review responses", nameBn: "রিভিউয়ের উত্তর", door: "Inbox", minLevel: 2 },
  // ADDED (Stage 10 module 02): the two Front Office verbs answer to duties of
  // their own, so a founder can pause Nova's inbox replies without touching
  // anything else. Both `minLevel: 2` so Shadow — assisted mode, effective
  // level 2 — can still DRAFT every reply; the drafting is the whole point of
  // the shadow week.
  { key: "support.inbox_replies", department: "support", name: "Inbox replies (Messenger/Instagram)", nameBn: "ইনবক্সে উত্তর (মেসেঞ্জার/ইনস্টাগ্রাম)", door: "Inbox", minLevel: 2 },
  { key: "support.inbox_escalations", department: "support", name: "Inbox escalations to you", nameBn: "আপনার কাছে ইনবক্স হস্তান্তর", door: "Inbox", minLevel: 2 },

  // ── Product research (7) ─────────────────────────────────────────────────
  { key: "product_research.winning_product_imports", department: "product_research", name: "Winning-product imports", nameBn: "সেরা পণ্য ইম্পোর্ট", door: "Dropshipping", minLevel: 3 },
  { key: "product_research.pricing_research", department: "product_research", name: "Pricing research", nameBn: "দাম নিয়ে গবেষণা", door: "Reports", minLevel: 1 },
  { key: "product_research.supplier_sourcing", department: "product_research", name: "Supplier sourcing (new SKUs)", nameBn: "নতুন পণ্যের সরবরাহকারী খোঁজা", door: "Purchases", minLevel: 2 },
  { key: "product_research.product_page_generation", department: "product_research", name: "Product page generation", nameBn: "পণ্যের পেজ তৈরি", door: "Store Studio", minLevel: 2 },
  { key: "product_research.trend_scouting", department: "product_research", name: "Trend scouting", nameBn: "ট্রেন্ড খোঁজা", door: "Research", minLevel: 1 },
  { key: "product_research.competitor_tracking", department: "product_research", name: "Competitor tracking", nameBn: "প্রতিযোগী পর্যবেক্ষণ", door: "Research", minLevel: 1 },
  { key: "product_research.demand_validation", department: "product_research", name: "Demand validation tests", nameBn: "চাহিদা যাচাইয়ের পরীক্ষা", door: "Growth", minLevel: 3 },

  // ── Inventory (5) ────────────────────────────────────────────────────────
  { key: "inventory.stock_monitoring", department: "inventory", name: "Stock monitoring", nameBn: "স্টক পর্যবেক্ষণ", door: "Products", minLevel: 0 },
  { key: "inventory.low_stock_alerts", department: "inventory", name: "Low-stock alerts", nameBn: "স্টক কমের সতর্কতা", door: "Products", minLevel: 0 },
  { key: "inventory.reorder_drafts", department: "inventory", name: "Reorder drafts", nameBn: "পুনঃঅর্ডারের খসড়া", door: "Purchases", minLevel: 2 },
  { key: "inventory.dead_stock_clearance", department: "inventory", name: "Dead-stock clearance", nameBn: "অবিক্রীত স্টক ছাড়", door: "Coupons", minLevel: 3 },
  { key: "inventory.multi_channel_sync", department: "inventory", name: "Multi-channel sync", nameBn: "মাল্টি-চ্যানেল সিঙ্ক", door: "Products", minLevel: 3 },

  // ── Shipping (7) ─────────────────────────────────────────────────────────
  //
  // The two module-06 duties sit in the **Inbox** door rather than Delivery, and
  // that is deliberate: `CASE_INSENSITIVE_DOOR_SCOPES` in `authority.ts` contains
  // only "Inbox", so a `door:delivery` mode does nothing today — a duty parked
  // there would look configurable on the dial and silently ignore it. They are
  // inbox work anyway; the customer is in a thread, waiting.
  //
  // minLevel 2, so a T0 Shadow store can DRAFT them. The whole orchestra runs at
  // T0 — only the last inch, anything a customer can see, is held back.
  { key: "shipping.delivery_cases", department: "shipping", name: "Delivery cases", nameBn: "ডেলিভারি কেস", door: "Inbox", minLevel: 2 },
  { key: "shipping.predispatch_confirms", department: "shipping", name: "Pre-dispatch confirmations", nameBn: "পাঠানোর আগে নিশ্চিতকরণ", door: "Inbox", minLevel: 2 },
  { key: "shipping.pickup_booking", department: "shipping", name: "Pickup booking", nameBn: "পিকআপ বুকিং", door: "Delivery", minLevel: 3 },
  { key: "shipping.delay_chasing", department: "shipping", name: "Delay chasing", nameBn: "দেরির তাগাদা", door: "Delivery", minLevel: 3 },
  { key: "shipping.rate_compare", department: "shipping", name: "Courier rate comparison", nameBn: "কুরিয়ার রেট তুলনা", door: "Rate Compare", minLevel: 2 },
  { key: "shipping.rto_reduction", department: "shipping", name: "RTO reduction", nameBn: "ফেরত (RTO) কমানো", door: "RTO Analytics", minLevel: 2 },
  // ADDED from the PRD §6 shipping charter.
  { key: "shipping.delay_prediction", department: "shipping", name: "Delay prediction", nameBn: "দেরির পূর্বাভাস", door: "Delivery", minLevel: 2 },

  // ── Finance (7) ──────────────────────────────────────────────────────────
  { key: "finance.cod_reconciliation", department: "finance", name: "COD reconciliation", nameBn: "ক্যাশ-অন-ডেলিভারি মিলকরণ", door: "Accounts", minLevel: 3 },
  { key: "finance.invoice_logging", department: "finance", name: "Invoice logging", nameBn: "ইনভয়েস নথিভুক্তি", door: "Accounts", minLevel: 2 },
  { key: "finance.expense_flagging", department: "finance", name: "Expense flagging", nameBn: "অস্বাভাবিক খরচ চিহ্নিতকরণ", door: "Accounts", minLevel: 1 },
  { key: "finance.ad_spend_audit", department: "finance", name: "Ad-spend audit", nameBn: "বিজ্ঞাপন খরচের নিরীক্ষা", door: "Reports", minLevel: 1 },
  { key: "finance.refund_ledger", department: "finance", name: "Refund ledger", nameBn: "রিফান্ড লেজার", door: "Accounts", minLevel: 2 },
  // MERGED: the prototype split one door across "Weekly P&L" + "Cashflow forecast".
  { key: "finance.pnl_reports", department: "finance", name: "P&L and cashflow reports", nameBn: "লাভ-ক্ষতি ও নগদ প্রবাহ রিপোর্ট", door: "P&L Reports", minLevel: 2 },
  { key: "finance.tax_export", department: "finance", name: "Tax-time export", nameBn: "কর মৌসুমের এক্সপোর্ট", door: "Reports", minLevel: 4 },

  // ── Operations (5) ───────────────────────────────────────────────────────
  { key: "operations.rfq_requests", department: "operations", name: "Quote requests (RFQs)", nameBn: "দরপত্রের অনুরোধ (RFQ)", door: "Purchases", minLevel: 2 },
  { key: "operations.po_drafting", department: "operations", name: "PO drafting", nameBn: "ক্রয়াদেশের খসড়া", door: "Purchases", minLevel: 2 },
  // MERGED: "Quote comparison" + "Supplier scorecards" — same door, one duty.
  // Keeps the LOWER minLevel of the two, because scorecards are a read.
  { key: "operations.rfq_compare", department: "operations", name: "Quote comparison & supplier scorecards", nameBn: "দর তুলনা ও সরবরাহকারীর স্কোরকার্ড", door: "RFQ Compare", minLevel: 1 },
  // ADDED: `switch_supplier` is a shipped verb, so Nova was doing work that no
  // duty on the roster claimed.
  { key: "operations.supplier_switching", department: "operations", name: "Supplier switching", nameBn: "সরবরাহকারী পরিবর্তন", door: "Purchases", minLevel: 3 },
  { key: "operations.payment_terms_negotiation", department: "operations", name: "Payment-terms negotiation", nameBn: "পেমেন্ট শর্ত নিয়ে আলোচনা", door: "Purchases", minLevel: 4 },

  // ── Growth (6) ───────────────────────────────────────────────────────────
  { key: "growth.bundle_offers", department: "growth", name: "Bundle offers", nameBn: "বান্ডল অফার", door: "Coupons", minLevel: 3 },
  { key: "growth.landing_page_variants", department: "growth", name: "Landing-page variants", nameBn: "ল্যান্ডিং পেজের ভ্যারিয়েন্ট", door: "Store Studio", minLevel: 2 },
  { key: "growth.ab_testing", department: "growth", name: "A/B testing", nameBn: "এ/বি টেস্টিং", door: "Growth", minLevel: 3 },
  { key: "growth.hypothesis_backlog", department: "growth", name: "Hypothesis backlog", nameBn: "পরীক্ষার তালিকা", door: "Growth", minLevel: 1 },
  { key: "growth.competitor_benchmarks", department: "growth", name: "Competitor benchmarks", nameBn: "প্রতিযোগীর সাথে তুলনা", door: "Research", minLevel: 1 },
  { key: "growth.seasonal_planning", department: "growth", name: "Seasonal (Eid) planning", nameBn: "ঈদ ও মৌসুমি পরিকল্পনা", door: "Campaigns", minLevel: 2 },
];

/** Duty status as a founder sees it. Computed — never stored. */
export type DutyStatus = "ACTIVE" | "NEEDS_DOOR" | "LOCKED" | "PAUSED";

/**
 * Order matters and is deliberate: a duty with no door reads NEEDS DOOR even
 * if the level would also lock it, because "we haven't built the screen" is a
 * more honest answer to the founder than "raise your autonomy level" — raising
 * it would not make the duty usable.
 */
export function dutyStatus(
  duty: Pick<DutySpec, "door" | "minLevel">,
  opts: { effectiveLevel: number; enabled?: boolean },
): DutyStatus {
  if (!(DOORS[duty.door]?.exists ?? false)) return "NEEDS_DOOR";
  if (opts.enabled === false) return "PAUSED";
  if (duty.minLevel > opts.effectiveLevel) return "LOCKED";
  return "ACTIVE";
}

/** Roster rollup per department — `{active, total}`, as the room headers show. */
export function dutyRollup(
  duties: readonly (DutySpec & { enabled?: boolean })[],
  effectiveLevel: number,
): Record<string, { active: number; total: number }> {
  const out: Record<string, { active: number; total: number }> = {};
  for (const d of duties) {
    const row = out[d.department] ?? (out[d.department] = { active: 0, total: 0 });
    row.total += 1;
    if (dutyStatus(d, { effectiveLevel, enabled: d.enabled }) === "ACTIVE") row.active += 1;
  }
  return out;
}

export const DUTY_BY_KEY: ReadonlyMap<string, DutySpec> = new Map(DUTIES.map((d) => [d.key, d]));

/** Duties whose door isn't built yet — the roster's honest minority. */
export const NEEDS_DOOR_DUTIES: readonly DutySpec[] = DUTIES.filter((d) => !DOORS[d.door]?.exists);

/* ═══════════════════════════════════════════════════════════════════════════
 * WHICH DUTY MAY A VERB BE PERFORMED UNDER
 *
 * ── The hole this closes ───────────────────────────────────────────────────
 *
 * `evaluateAuthority` takes the verb and the duty key as INDEPENDENT inputs,
 * and the duty key is what selects the door (⇒ the mode ceiling), the minimum
 * level, and the founder's per-duty pause switch. Nothing anywhere checked that
 * the duty had anything to do with the verb. So a caller could file a
 * `create_purchase_order` (minLevel 2, door Purchases, `high` risk) under
 * `inventory.low_stock_alerts` (minLevel 0, door Products, a WATCHING duty) and
 * have it judged at minLevel 0, under the wrong door's mode, unstoppable by a
 * founder who paused "Reorder drafts", and land on the ledger attributed to
 * "Low-stock alerts". Measured, not theorised: at level 1 the honest pair is
 * refused `duty:min_level` and the laundered pair comes back `suggest`.
 *
 * This table is that missing edge. It is enforced at the ONE seam every lane
 * files through (`gateOrFile` in front-office/actions.ts) and at
 * `performCreateOrder`, which keeps its own copy of that seam.
 *
 * ── Where each row comes from. Nothing here is invented. ───────────────────
 *
 *  1. nova-ai's tools each declare a `dutyRef` on their `performAction` call
 *     (`agent/tools/*.ts`) — twelve verbs, taken verbatim.
 *  2. This repo's front-office verbs declare theirs as `*_DUTY_REF` constants
 *     in `front-office/actions.ts`.
 *  3. For the founder-plane verbs, which predate the duty registry and declare
 *     nothing, the roster above plus `brain/registry.ts` (the lane claims and,
 *     more usefully, the WRITTEN REASONS in `UNCLAIMED`) say which duty
 *     describes the act. Those reasons are evidence in both directions —
 *     `operations.supplier_switching`'s reads "`switch_supplier` is a shipped
 *     verb with no lane that calls it", which names the pair; and
 *     `finance.expense_flagging`'s reads "no duty on the roster describes it …
 *     Closest neighbour, and not close enough", which REFUSES the pair the
 *     pulse's remedy table had been filing `update_price` under.
 *
 * ── An empty list is a capability gap, not a free pass ─────────────────────
 *
 * Four shipped verbs are governed by NO duty on the founder's roster. That is
 * the same honesty mechanism as `doorExists: false` and `UNCLAIMED`: the verb
 * exists, nothing on the roster claims it, and the founder therefore has no row
 * to read, no level to set and no switch to pause. Until a duty is added, the
 * seam refuses them — a verb nobody promised is not a verb Nova may perform.
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * ActionType → the duty key(s) that legitimately govern it.
 *
 * A verb may have SEVERAL governing duties (one act, several promises a founder
 * reads: a chat reply is both `support.inbox_replies` and the mined
 * `support.customer_replies`, and `brain/registry.ts` explains why a lane that
 * named only one would keep replying after the founder paused the other). It
 * may also have none — see {@link UNGOVERNED_VERBS}.
 *
 * Every value is checked against the roster at module load.
 */
export const VERB_DUTIES: Readonly<Record<ActionType, readonly string[]>> = {
  // ── Front Office, from the tools' own `dutyRef` (nova-ai + actions.ts) ────
  /** `create_order_from_chat.ts` → "sales.inbox_orders". */
  create_order_from_chat: ["sales.inbox_orders"],
  /** `cancel_order_from_chat.ts` → "sales.inbox_orders" — pausing chat orders pauses chat cancels. */
  cancel_order_from_chat: ["sales.inbox_orders"],
  /** `offer_chat_discount.ts` → "sales.inbox_discounts". */
  offer_chat_discount: ["sales.inbox_discounts"],
  /**
   * `reply_in_thread.ts` → "support.inbox_replies". The mined
   * `support.customer_replies` rides with it for the reason `registry.ts` gives
   * on the `inbox_reply` lane: the roster carries two rows for one act.
   */
  send_inbox_reply: ["support.inbox_replies", "support.customer_replies"],
  /** `flag_handover.ts` → "support.inbox_escalations". */
  escalate_conversation: ["support.inbox_escalations"],
  /** `link_customer.ts` → "support.inbox_replies". */
  link_customer_identity: ["support.inbox_replies"],
  /**
   * `schedule_follow_up.ts` → "support.inbox_replies". The two nudge duties
   * `registry.ts` names on the `followup` lane are the other two producers of
   * the same row (in-thread cart nudges, NBA nudges).
   */
  schedule_follow_up: ["support.inbox_replies", "sales.inbox_cart_recovery", "sales.lead_followups"],
  /** `verify_payment_slip.ts` → "support.inbox_replies" ("the duty is the thread's"). */
  verify_payment_slip: ["support.inbox_replies"],
  /** `open_case.ts` → "shipping.delivery_cases". */
  open_case: ["shipping.delivery_cases"],
  /** `update_order_contact.ts` → "shipping.delivery_cases". */
  update_order_contact: ["shipping.delivery_cases"],
  /** `confirm_order_intent.ts` → "shipping.predispatch_confirms". */
  confirm_order_intent: ["shipping.predispatch_confirms"],
  /** `bulk_refund.ts` → "support.refund_processing" (founder-only either way). */
  bulk_refund: ["support.refund_processing"],
  /**
   * Module 06's verb has no nova-ai tool to copy from (module 06 never shipped
   * there). `registry.ts`'s `courier_intervention` lane is the producer and
   * claims exactly these two: the parcel is late (`delay_chasing`) and the
   * customer is waiting in a case (`delivery_cases`).
   */
  flag_courier_issue: ["shipping.delay_chasing", "shipping.delivery_cases"],

  // ── Founder plane: no tool declares a duty, so the roster decides ─────────
  /**
   * `night_ops` claims BOTH for "purchase orders drafted", and both sit at the
   * Purchases door, minLevel 2. Either is an honest attribution for a PO.
   */
  create_purchase_order: ["inventory.reorder_drafts", "operations.po_drafting"],
  /** UNCLAIMED: "`switch_supplier` is a shipped verb with no lane that calls it." */
  switch_supplier: ["operations.supplier_switching"],
  /**
   * The three Coupons-door duties, and the gap list names the verb in each:
   * "minting a clearance coupon is a Coupons write", "No lane mints an upsell
   * coupon", "No lane builds a bundle".
   */
  create_discount: ["inventory.dead_stock_clearance", "sales.upsell_offers", "growth.bundle_offers"],
  /**
   * One message to one customer, on the founder plane. The six purposes the
   * payload allows (`cart_recovery`, `winback`, `upsell`, `sales_reply`,
   * `support_reply`, `order_update`) line up with these roster rows, and the
   * gap list names the verb from the other side ("no lane messages a lapsed
   * customer", "Nothing reads payment state and schedules a chase").
   *
   * The two Broadcast CAMPAIGN duties are deliberately NOT here: UNCLAIMED
   * rules explicitly that "cart_sweep's email is cart recovery, not campaigns",
   * and there is no campaign-send verb in `ActionType` at all.
   */
  send_customer_message: [
    "sales.abandoned_checkout_emails",
    "sales.sms_cart_recovery",
    "sales.winback_campaigns",
    "sales.upsell_offers",
    "sales.payment_chasing",
    "sales.lead_followups",
    "support.customer_replies",
  ],
  /** The three ad-account duties `night_ops` claims for "ads reviewed". */
  update_campaign: [
    "marketing.ad_budget_optimization",
    "marketing.pause_weak_ad_sets",
    "marketing.campaign_scaling",
  ],
  /**
   * The THINNEST row in this table, and it is flagged rather than dressed up:
   * `marketing.seasonal_promotions` is the only roster duty that describes a
   * campaign being brought into existence rather than tuned. A lane that wants
   * to launch a non-seasonal campaign needs a roster row first — that is a
   * roster edit, reviewed, not a widening here.
   */
  create_campaign: ["marketing.seasonal_promotions"],
  /** UNCLAIMED: "nothing publishes to FB/IG" / "No lane produces video/story assets". */
  publish_social_post: ["marketing.social_posts", "marketing.reels_and_stories"],
  /** UNCLAIMED: "No lane touches the dropship marketplace" — this is that verb. */
  import_product: ["product_research.winning_product_imports"],
  /**
   * Assigning the parcel to a courier IS the pickup booking, and the roster has
   * exactly one Delivery-door duty for it. (`shipping.rate_compare` is a
   * comparison; comparing is not assigning.)
   */
  assign_courier: ["shipping.pickup_booking"],

  // ── Governed by nothing on the roster. See UNGOVERNED_VERBS. ─────────────
  update_price: [],
  resolve_ticket: [],
  merge_customer_records: [],
} as const;

/**
 * The four shipped verbs no duty on the founder's roster governs, each with the
 * reason — the same posture as `UNCLAIMED` and `doorExists: false`.
 *
 * These are not "allow by default": the seam refuses them, loudly, because a
 * verb the founder was never promised is a verb they cannot level, pause or
 * read on the roster. Each leaves this list by a ROSTER EDIT (reviewed, and
 * mirrored to dakio-api's `NovaDuty` seed), never by being quietly attached to
 * whichever neighbour looks close.
 */
export const UNGOVERNED_VERBS: Readonly<Record<string, string>> = {
  update_price:
    "No duty on the roster describes Nova changing a price. `product_research.pricing_research` is " +
    "RESEARCH at the Reports door, and registry.ts's gap list has already ruled on the nearest " +
    "neighbour: `finance.expense_flagging` is 'closest neighbour, and not close enough'. The pulse's " +
    "margin sense is real and the remedy has nowhere to land — a roster gap, not a verb to launder.",
  resolve_ticket:
    "registry.ts calls this THE HONESTY CASE: dakio-api's SupportTicket is the DAKIO PLATFORM desk " +
    "(merchant ↔ Dakio), not the merchant's customer support, so filing it under " +
    "`support.complaint_resolution` would tell a founder Nova resolves THEIR customers' complaints. " +
    "It does not.",
  merge_customer_records:
    "The bug doc 07 names, still open: 'a merge card shipped with no duty reference because its duty " +
    "was never added to the roster'. Identity merging is real work with no roster row; " +
    "`identity_merge_sweep` is a server sweep and cannot claim one.",
};

/** The duty keys that may govern `verb`. Empty ⇒ ungoverned (see above). */
export function governingDuties(verb: string): readonly string[] {
  return VERB_DUTIES[verb as ActionType] ?? [];
}

/**
 * Does `dutyKey` legitimately govern `verb`? Everything unknown answers false —
 * an unknown verb has no governing duty by definition, and an unknown duty key
 * is `evaluateAuthority`'s own hard refusal.
 */
export function dutyGovernsVerb(verb: string, dutyKey: string): boolean {
  return governingDuties(verb).includes(dutyKey);
}

/**
 * Boot-time check, same posture as `registry.ts`'s `assertLaneDutiesExist`: a
 * binding that names a duty which is not on the roster would refuse 100% of
 * that verb's work at runtime with `duty:unknown`, so it fails at import
 * instead. Exported so a test can drive it with a deliberately broken table.
 */
export function assertVerbDutiesExist(table: Readonly<Record<string, readonly string[]>>): void {
  const unknown: string[] = [];
  for (const [verb, keys] of Object.entries(table)) {
    for (const key of keys) if (!DUTY_BY_KEY.has(key)) unknown.push(`${verb} → "${key}"`);
  }
  if (unknown.length > 0) {
    throw new Error(
      `[nova:duties] VERB_DUTIES binds a verb to a duty that is not on Nova's roster: ${unknown.join(", ")}. ` +
        `An off-roster duty is a hard refusal at every authority tier (evaluateAuthority → refuse, rule ` +
        `"duty:unknown"), so the binding would authorise nothing. Fix the key, or add the duty to DUTIES.`,
    );
  }
}

assertVerbDutiesExist(VERB_DUTIES);
