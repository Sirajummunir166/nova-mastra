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

import type { NovaDepartment } from "./types.js";

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
