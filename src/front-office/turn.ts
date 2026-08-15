/**
 * The customer turn — the PRD's delta loop:
 *
 *   load state (one row) → classify (L0 rules / L1 resolver) → apply DELTA →
 *   selective validation (only TTL-expired fields the action touches) →
 *   deterministic NBA from missing[] → short generation (~300 tokens in) →
 *   reply · state persisted.
 *
 * Every turn stamps its timeline — latency is measured, never claimed.
 */

import { classifyL0, detectLang, type Classified, type Intent } from "./classify.js";
import { nextBestAction, type NextAction } from "./nba.js";
import { renderStateCard, renderRecent } from "./card.js";
import { loadContext, primeContext, saveContext, withTurnLock } from "./context-store.js";
import { observe, TTL } from "./cache.js";
import {
  addMemo,
  bump,
  computeMissing,
  computeStage,
  fact,
  isFresh,
  maskPhonesIn,
  pushMessage,
  type NovaLiveContext,
} from "./state.js";
import { feeForZone, focusProduct, hydratePolicies, resolveProduct, variantIdFor, variantStock } from "./hydrate.js";
import { listProducts, type DakioProduct } from "./dakio.js";
import {
  performCreateOrder,
  performFlagHandover,
  type ChatOrderGatePayload,
  type EscalationReason,
  type HandoverDepartment,
} from "./actions.js";
import { getStoreProfile } from "../lib/store.js";
import { resolverAgent, resolverSchema, writerAgent, writerSystem } from "./agents.js";
import { withGatewayRetry } from "../lib/gateway-retry.js";

/**
 * SHADOW vs LIVE — the phase-C gate.
 *
 * `shadow` (the DEFAULT — no caller can reach a customer-visible write by
 * accident): the full delta loop runs and state persists, but the turn only
 * DRAFTS. The one mutation in this pipeline — `createChatOrder` — is never
 * called; a decided CREATE_ORDER is recorded as `wouldHaveDone` and the turn
 * stops there (no invented order number, no confirmation draft). Model
 * failures degrade to a recorded `modelFailure` instead of throwing, so the
 * shadow-diff dataset still gets the deterministic half of the turn (intent,
 * rung, action, state delta) when no gateway credential is present.
 *
 * `live`: the order gate really fires and model failures throw. Since phase D
 * unit 1 the gate is APPROVAL-AWARE (the way nova-ai does it): a decided
 * CREATE_ORDER consults the store's autonomy/authority through
 * `performCreateOrder` (actions.ts). On the auto tier it calls
 * `createChatOrder` exactly as before; on the approval tier (the shipping
 * default — `inbox.orderAuto` FALSE) it files the fully-prepared action +
 * Decision for the founder and the reply says honestly that the shop confirms
 * the order first (FD-3: the normal flow, never an apology). Call sites must
 * opt in explicitly (workflow.ts does).
 */
export type TurnMode = "shadow" | "live";

export interface TurnOptions {
  mode?: TurnMode;
  /** dakio-api's session roll — partitions persisted state (context-store key). */
  epoch?: number;
}

export interface TurnResult {
  reply: string;
  intent: Intent;
  rung: 0 | 1;
  action: NextAction | "ORDER_CONFIRMED" | "ORDER_PENDING_APPROVAL";
  stage: string;
  missing: string[];
  stateCard: string;
  order?: { orderNumber: string; total: number };
  /** Live, approval tier: the prepared `create_order_from_chat` action on the founder's desk. */
  pendingActionId?: string;
  /** Live: the executed (or blocked) `escalate_conversation` row for this thread. */
  handoverActionId?: string;
  timings: Record<string, number>;
  cacheHits: number;
  version: number;
  mode: TurnMode;
  epoch: number;
  /** Model generations ATTEMPTED this turn (resolver and/or writer). */
  modelCalls: number;
  /** Shadow only: the write the turn decided on but did not perform. */
  wouldHaveDone?: Record<string, unknown>;
  /** Shadow only: model call(s) that failed; the turn still returned its deterministic half. */
  modelFailure?: string;
}

export function runCustomerTurn(
  storeId: string,
  convId: string,
  message: string,
  opts: TurnOptions = {},
): Promise<TurnResult> {
  const mode: TurnMode = opts.mode ?? "shadow";
  const epoch = Number.isFinite(opts.epoch) && (opts.epoch as number) > 0 ? Math.floor(opts.epoch as number) : 0;
  return withTurnLock(storeId, convId, () => executeTurn(storeId, convId, message, mode, epoch));
}


async function executeTurn(
  storeId: string,
  convId: string,
  message: string,
  mode: TurnMode,
  epoch: number,
): Promise<TurnResult> {
  const t0 = Date.now();
  const timings: Record<string, number> = { receivedAt: t0 };
  let modelCalls = 0;
  let modelFailure: string | undefined;
  let wouldHaveDone: Record<string, unknown> | undefined;

  await primeContext(storeId, convId, epoch);
  const ctx = loadContext(storeId, convId, "chat", epoch);
  timings.stateLoadedMs = Date.now() - t0;

  const store = await getStoreProfile(storeId);
  if (!store) throw new Error(`store ${storeId} unavailable from dakio-api`);
  if (store.status !== "active") throw new Error(`store ${storeId} is not active`);

  pushMessage(ctx, { role: "customer", text: message, at: t0 });

  // Language: detected every turn; preference only moves with a customer
  // reason, and an EXPLICIT request locks it until another explicit request.
  const lang = detectLang(message);
  ctx.customer.lang.detected = lang.detected;
  ctx.customer.lang.conf = lang.conf;
  if (/\b(english please|in english|speak english|talk in english)\b/i.test(message)) {
    ctx.customer.lang.pref = "en";
    ctx.customer.lang.lockedByRequest = true;
  } else if (/banglay bolen|বাংলায় বলেন|bangla(?:y|te)? (?:bolen|bolun|likhen)/i.test(message)) {
    ctx.customer.lang.pref = "bn";
    ctx.customer.lang.lockedByRequest = true;
  } else if (!ctx.customer.lang.lockedByRequest && lang.detected !== "en") {
    ctx.customer.lang.pref = "bn";
  } else if (!ctx.customer.lang.lockedByRequest && lang.detected === "en" && lang.conf >= 0.7) {
    ctx.customer.lang.pref = "en";
  }

  // Hard lock after handover: the thread belongs to a person now. One line of
  // silence, no model spend (register R14/R19 — never re-greet, never retry).
  if (ctx.conversation.stage === "escalated") {
    bump(ctx);
    saveContext(ctx);
    return {
      reply: "",
      intent: "other",
      rung: 0,
      action: "ESCALATE",
      stage: "escalated",
      missing: computeMissing(ctx),
      stateCard: renderStateCard(ctx),
      timings: { receivedAt: t0, sentMs: Date.now() - t0 },
      cacheHits: ctx.toolLedger.length,
      version: ctx.version,
      mode,
      epoch,
      modelCalls,
    };
  }

  // ---- Classify: L0 rules, else L1 resolver --------------------------------
  const awaiting = ctx.purchase.confirmSent ? "confirm" : ctx.conversation.nextAction === "ASK_QTY" ? "qty" : null;
  let classified: Classified | null = classifyL0(message, { awaiting });
  if (!classified) {
    modelCalls += 1;
    try {
      const res = await withGatewayRetry(() =>
        resolverAgent.generate(
          [{ role: "user", content: `STATE:\n${renderStateCard(ctx)}\n\nCUSTOMER MESSAGE: ${message}` }],
          { structuredOutput: { schema: resolverSchema } },
        ),
      );
      const obj = res.object;
      classified = obj
        ? { intent: obj.intent, entities: obj.entities ?? {}, rung: 1, confidence: obj.confidence }
        : { intent: "other", entities: {}, rung: 1, confidence: 0.3 };
    } catch (err) {
      // Live keeps today's contract (the caller sees the failure). Shadow is
      // observe-only: record the failure and continue with the honest floor,
      // so the shadow row still carries a rung/intent instead of vanishing.
      if (mode === "live") throw err;
      modelFailure = `resolver: ${err instanceof Error ? err.message : String(err)}`;
      classified = { intent: "other", entities: {}, rung: 1, confidence: 0 };
    }
  }
  timings.resolvedMs = Date.now() - t0;

  // ---- Apply the delta ------------------------------------------------------
  const e = classified.entities;
  if (e.size) {
    ctx.purchase.variant = e.size;
    if (ctx.products.focusId) ctx.products.tracked[ctx.products.focusId] = "wants_to_buy";
  }
  if (e.qty) {
    if (ctx.purchase.qty && ctx.purchase.qty !== e.qty) addMemo(ctx, `qty corrected ${ctx.purchase.qty}→${e.qty}`);
    ctx.purchase.qty = e.qty;
    if (ctx.products.focusId) ctx.products.tracked[ctx.products.focusId] = "wants_to_buy";
    ctx.purchase.confirmSent = false; // any purchase change voids a pending summary
  }
  if (e.zone) {
    ctx.purchase.zone = e.zone;
    ctx.purchase.confirmSent = false;
  }
  if (e.phone) ctx.customer.phone = fact(e.phone, "customer");
  if (e.address) ctx.customer.addr = fact(e.address, "customer");
  if (classified.intent === "buy_intent" && ctx.products.focusId) {
    ctx.products.tracked[ctx.products.focusId] = "wants_to_buy";
  }

  // Product resolution — when the message names a product (or nothing is focused).
  const wantsProduct =
    (classified.intent === "product_query" || classified.intent === "buy_intent" || classified.intent === "price_q" || classified.intent === "stock_q") &&
    !!e.productText;
  if (wantsProduct) {
    const match = await resolveProduct(ctx, e.productText!);
    if (match && match.id !== ctx.products.focusId) {
      focusProduct(ctx, match);
      addMemo(ctx, `focus → ${match.name}`);
    }
  }

  // ---- Selective validation: only what the action touches -------------------
  let action = nextBestAction(ctx, classified.intent);

  const needsFee = (action === "ASK_PHONE_ADDR" || action === "PRESENT_SUMMARY" || action === "CREATE_ORDER" || action === "ANSWER_DELIVERY_FAQ") && !!ctx.purchase.zone;
  if (needsFee || action === "ANSWER_DELIVERY_FAQ") {
    if (!isFresh(ctx.hydrated.policies)) await hydratePolicies(ctx);
    if (ctx.purchase.zone) {
      const fee = feeForZone(ctx, ctx.purchase.zone);
      if (fee !== undefined) ctx.purchase.fee = fact(fee, "tool:get_store_settings", { ttlMs: TTL.settings });
    }
  }

  const needsStock = action === "ANSWER_STOCK" || action === "ASK_QTY" || action === "PRESENT_SUMMARY" || action === "CREATE_ORDER";
  let focusRaw: DakioProduct | undefined;
  if (needsStock && ctx.products.focusId && !isFresh(ctx.hydrated.stock)) {
    const { raw, calledAt } = await observe(ctx, "list_products", { status: "active" }, () => listProducts(ctx.storeId), TTL.stock);
    focusRaw = raw.find((p) => p.id === ctx.products.focusId);
    if (focusRaw) {
      ctx.hydrated.stock = fact(variantStock(focusRaw, ctx.purchase.variant), "tool:list_products", { ttlMs: TTL.stock, at: calledAt });
      ctx.hydrated.price = fact(focusRaw.price, "tool:list_products", { ttlMs: TTL.price, at: calledAt });
    }
  }
  timings.validatedMs = Date.now() - t0;

  // ---- Mutation gate: CREATE_ORDER ------------------------------------------
  // The ONE write in this pipeline that goes beyond drafting, and this branch
  // is its only call site (via `hardValidateAndCreate` → `performCreateOrder`).
  // SHADOW never enters the gate: the decided placement is recorded as
  // `wouldHaveDone` and the turn stops there — no dakio-api write, no invented
  // order number, no confirmation draft. LIVE consults autonomy/authority:
  // auto tier executes (today's path), approval tier files the prepared
  // action/Decision and the reply carries FD-3 honestly.
  let order: TurnResult["order"];
  let pendingActionId: string | undefined;
  let handoverActionId: string | undefined;
  let facts = "";
  let draftSuppressed = false;
  /** True when this turn's ESCALATE came from the order gate refusing, not from
   *  the customer asking — it decides the escalation reason below. */
  let orderGateBlocked = false;
  if (action === "CREATE_ORDER") {
    if (mode === "shadow") {
      wouldHaveDone = {
        type: "create_chat_order",
        novaActionId: `nm:${ctx.convId}:order-${ctx.orders.length}`,
        productId: ctx.products.focusId ?? null,
        productName: ctx.hydrated.product?.value?.name ?? null,
        variant: ctx.purchase.variant ?? null,
        qty: ctx.purchase.qty ?? null,
        zone: ctx.purchase.zone ?? null,
        phone: ctx.customer.phone?.value ?? null,
        address: ctx.customer.addr?.value ?? null,
      };
      draftSuppressed = true; // a confirmation for an order that does not exist is a lie
    } else {
      const gate = await hardValidateAndCreate(ctx);
      if (gate.ok) {
        if (gate.orderNumber !== undefined && gate.total !== undefined) {
          order = { orderNumber: gate.orderNumber, total: gate.total };
          facts = `Order #${gate.orderNumber} created — total ৳${gate.total} COD (product ৳${gate.subtotal} + delivery ৳${gate.shipping}).`;
        } else {
          // Replayed execution whose row predates the snapshot: the ledger's
          // own outcome line still names the order and the total.
          facts = gate.reason;
        }
        action = "ORDER_CONFIRMED" as never;
      } else if (gate.pending) {
        pendingActionId = gate.actionId;
        action = "ORDER_PENDING_APPROVAL" as never;
        facts = gate.reason;
      } else {
        action = gate.fallback;
        facts = gate.reason;
        // `hardValidateAndCreate` returns fallback ESCALATE only for a gate
        // BLOCK (a founder lock or a rule Nova may not cross). Every other
        // fallback is an ordinary ladder step.
        if (gate.fallback === "ESCALATE") orderGateBlocked = true;
      }
    }
  }

  // ---- Hand-over gate: ESCALATE ---------------------------------------------
  // The second write this pipeline can reach, and the only other call site of a
  // dakio-api mutation in this file. `escalate_conversation` is NEVER_GATED, so
  // in live mode it executes at every tier — asking for a human has to work at
  // the lowest autonomy setting. SHADOW never enters the gate: a handover locks
  // a real thread and queues a real customer message, so the decided hand-off
  // is recorded as `wouldHaveDone` and nothing is called.
  if (action === "ESCALATE") {
    const route = handoverRoute(classified.intent, orderGateBlocked);
    const key = `nm:${ctx.convId}:handover`;
    if (mode === "shadow") {
      wouldHaveDone = {
        type: "escalate_conversation",
        novaActionId: key,
        conversationId: ctx.convId,
        reason: route.reason,
        department: route.department,
      };
    } else {
      const brief = escalationBrief(ctx, route.reason);
      const hand = await performFlagHandover(ctx.storeId, {
        payload: {
          novaActionId: key,
          // Taken from the turn envelope, never from model output: this lane has
          // no `scopedConversationId` seam and must not pretend to one.
          conversationId: ctx.convId,
          reason: route.reason,
          department: route.department,
          summary: brief.summary,
          summaryBn: brief.summaryBn,
          // `factsChecked` comes from real reads only — the tool ledger this
          // turn actually wrote. Nothing is synthesized.
          factsChecked: factsCheckedFrom(ctx),
        },
        receipt: {
          reason: brief.summary,
          expectedImpact: "A person from the shop takes this thread over.",
          confidence: classified.confidence,
          evidence: [
            {
              source: "conversation",
              note: `intent ${classified.intent} at stage ${ctx.conversation.stage}`,
              metric: "reason",
              value: route.reason,
            },
          ],
        },
      });
      handoverActionId = hand.actionId;
      ctx.toolLedger.push({
        tool: "escalate_conversation",
        args: { reason: route.reason, department: route.department, gate: hand.status },
        raw: hand.detail,
        calledAt: Date.now(),
        ok: hand.status === "executed",
      });
      if (hand.status === "executed") {
        // The SERVER owns the holding line (a deterministic template chosen by
        // reason — and deliberately NO line at all for `fraud_risk`, where a
        // holding bubble would be both untrue and a tip-off). A writer draft on
        // top of it is a second bubble at best; suppress it, exactly as the
        // post-handover lock path above already returns an empty reply.
        draftSuppressed = true;
      }
      // A BLOCKED handover is the other case: Nova is still on the thread and
      // still owes an answer, so the draft stands. The founder's rule stays on
      // the ledger row — the customer never hears it.
    }
  }

  // ---- Reducer-derived stage + NBA persistence ------------------------------
  if (action === ("ORDER_CONFIRMED" as never) || action === ("ORDER_PENDING_APPROVAL" as never)) {
    ctx.conversation.stage = "ordered";
  } else if (action === "ESCALATE") {
    ctx.conversation.stage = "escalated";
    addMemo(ctx, `escalated: ${classified.intent}`);
  } else {
    if (ctx.conversation.stage === "ordered" || ctx.conversation.stage === "post_order") {
      // A new product interest re-opens the funnel.
      if (wantsProduct && ctx.products.focusId) ctx.conversation.stage = "product_interest";
      else ctx.conversation.stage = "post_order";
    } else {
      ctx.conversation.stage = computeStage(ctx);
    }
  }
  ctx.conversation.nextAction = action;
  ctx.conversation.confidence = classified.confidence >= 0.85 ? "high" : classified.confidence >= 0.6 ? "med" : "low";
  if (action === "PRESENT_SUMMARY") ctx.purchase.confirmSent = true;
  if (action === "DECLINE_DISCOUNT_ONCE") {
    ctx.purchase.objRound += 1;
    addMemo(ctx, "no discount promised");
  }

  // ---- Writer: word the decided action (~300 tokens in) ---------------------
  const actionLine = buildActionLine(ctx, action, facts);
  const card = renderStateCard(ctx);
  const genStart = Date.now();
  timings.genStartMs = genStart - t0;

  let reply = "";
  if (!draftSuppressed) {
    modelCalls += 1;
    try {
      const writeRes = await withGatewayRetry(() =>
        writerAgent.generate(
          [{ role: "user", content: `${card}\n\nLAST MESSAGES:\n${renderRecent(ctx)}\n\nACTION: ${actionLine}\nWrite the reply.` }],
          { instructions: writerSystem({ name: store.name, currency: store.currency }) },
        ),
      );
      reply = writeRes.text.trim();
    } catch (err) {
      // Same asymmetry as the resolver above: live throws, shadow records.
      if (mode === "live") throw err;
      modelFailure = `${modelFailure ? `${modelFailure}; ` : ""}writer: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (reply) pushMessage(ctx, { role: "nova", text: reply, at: Date.now() });
  bump(ctx);
  saveContext(ctx);
  timings.sentMs = Date.now() - t0;

  const cacheHits = ctx.toolLedger.length; // ledger size for inspection; hits visible in Studio output
  return {
    reply,
    intent: classified.intent,
    rung: classified.rung,
    action,
    stage: ctx.conversation.stage,
    missing: computeMissing(ctx),
    stateCard: renderStateCard(ctx),
    order,
    ...(pendingActionId ? { pendingActionId } : {}),
    ...(handoverActionId ? { handoverActionId } : {}),
    timings,
    cacheHits,
    version: ctx.version,
    mode,
    epoch,
    modelCalls,
    ...(wouldHaveDone ? { wouldHaveDone } : {}),
    ...(modelFailure ? { modelFailure } : {}),
  };
}

// ---------------------------------------------------------------------------
// Mutation gate
// ---------------------------------------------------------------------------

interface GateResult {
  ok: boolean;
  /** Approval tier: the order is filed, not placed — `actionId` names the card. */
  pending?: boolean;
  actionId?: string;
  orderNumber?: string;
  total?: number;
  subtotal?: number;
  shipping?: number;
  reason: string;
  fallback: NextAction;
}

/**
 * HARD validation before the only mutation: stock ✓ price ✓ delivery ✓ — all
 * LIVE reads (never the cache) — then the authority-gated order pipeline
 * (`performCreateOrder`): auto tier executes the server-priced create exactly
 * as before; approval tier files the prepared action + Decision instead.
 */
async function hardValidateAndCreate(ctx: NovaLiveContext): Promise<GateResult> {
  const focusId = ctx.products.focusId;
  const p = ctx.purchase;
  if (!focusId || !p.qty || !ctx.customer.phone || !ctx.customer.addr || !p.zone) {
    return { ok: false, reason: "order fields incomplete", fallback: "ASK_PHONE_ADDR" };
  }

  // Live product read — bypasses TTL by design (mutations are never cached).
  const products = await listProducts(ctx.storeId);
  ctx.toolLedger.push({ tool: "list_products", args: { status: "active", live: true }, raw: products.length, calledAt: Date.now(), ok: true });
  const product = products.find((x) => x.id === focusId);
  if (!product) return { ok: false, reason: "product no longer available", fallback: "OFFER_ALTERNATIVE" };

  const stock = variantStock(product, p.variant);
  if (stock < p.qty) {
    ctx.hydrated.stock = fact(stock, "tool:list_products", { ttlMs: TTL.stock });
    return { ok: false, reason: `only ${stock} in stock for ${p.variant ?? product.name}`, fallback: "OFFER_ALTERNATIVE" };
  }

  const knownPrice = ctx.hydrated.price?.value;
  if (knownPrice !== undefined && product.price !== knownPrice) {
    ctx.hydrated.price = fact(product.price, "tool:list_products", { ttlMs: TTL.price });
    ctx.purchase.confirmSent = false;
    return { ok: false, reason: `price changed ৳${knownPrice} → ৳${product.price} — re-present the summary honestly`, fallback: "PRESENT_SUMMARY" };
  }

  if (!isFresh(ctx.hydrated.policies)) await hydratePolicies(ctx);

  const zone = p.zone;
  const inside = zone.toLowerCase().includes("dhaka") || zone.includes("ঢাকা");
  const qty = p.qty;
  const variant = p.variant;

  // Byte-compatible with nova-ai's createOrderFromChatPayload: no price
  // fields, `confirmedByCustomer` the literal true, `productName` per item for
  // the founder's no-touch locks. `novaActionId` is deterministic per Nth
  // order of this conversation (placed + pending both count) so a retried
  // turn replays instead of double-filing or double-ordering.
  const payload: ChatOrderGatePayload = {
    novaActionId: `nm:${ctx.convId}:order-${ctx.orders.length + (ctx.pendingOrders?.length ?? 0)}`,
    conversationId: ctx.convId,
    customerName: ctx.customer.name?.value ?? "Messenger Customer",
    customerPhone: ctx.customer.phone.value,
    customerCity: zone,
    customerDistrict: inside ? "Dhaka" : zone,
    customerAddress: ctx.customer.addr.value,
    items: [
      {
        productId: product.id,
        variantId: variantIdFor(product, variant),
        productName: product.name,
        qty,
      },
    ],
    confirmedByCustomer: true,
  };

  // The turn-authored half of the E-8 receipt: deterministic, grounded in the
  // live read this function just made. Estimates only — the server prices the
  // final figures, which is the whole safety argument.
  const fee = ctx.purchase.fee?.value;
  const estimate = product.price * qty + (fee ?? 0);
  const gate = await performCreateOrder(ctx.storeId, {
    payload,
    receipt: {
      reason:
        `Customer confirmed the itemized order in this thread: ${product.name}` +
        `${variant ? ` ${variant}` : ""} × ${qty} to ${zone}. Phone and delivery address were given in the thread.`,
      expectedImpact: `≈৳${estimate} COD order (server prices finally${fee === undefined ? "; delivery not yet quoted" : ""}).`,
      confidence: 0.9,
      evidence: [
        { source: "conversation", note: "customer replied yes to the final order summary", metric: "confirmSent", value: "true" },
        {
          source: "list_products",
          note: `live read: ${product.name} price ৳${product.price}, stock ${stock}`,
          metric: "stock",
          value: stock,
        },
      ],
    },
  });

  if (gate.status === "blocked") {
    // Founder-facing rule stays on the ledger row; the customer never hears it
    // (register discipline — locks and dials are the shop's own business).
    ctx.toolLedger.push({ tool: "create_order_from_chat", args: { productId: product.id, qty, gate: "blocked", rule: gate.rule }, raw: gate.detail, calledAt: Date.now(), ok: false });
    return { ok: false, actionId: gate.actionId, reason: "the shop needs to handle this order directly", fallback: "ESCALATE" };
  }

  if (gate.status === "prepared") {
    ctx.toolLedger.push({ tool: "create_order_from_chat", args: { productId: product.id, qty, gate: "prepared", rule: gate.rule }, raw: gate.actionId, calledAt: Date.now(), ok: true });
    // FILED: the product leaves tracking and lives in pendingOrders[] — no
    // order number, no total, because no order exists yet (FD-3).
    delete ctx.products.tracked[focusId];
    delete ctx.products.items[focusId];
    (ctx.pendingOrders ??= []).push({ actionId: gate.actionId, title: product.name });
    ctx.purchase.confirmSent = false;
    ctx.purchase.qty = undefined;
    ctx.purchase.variant = undefined;
    addMemo(ctx, `order filed for shop confirm: ${product.name} × ${qty}`);
    return {
      ok: false,
      pending: true,
      actionId: gate.actionId,
      reason: `order request recorded (${product.name}${variant ? ` ${variant}` : ""} × ${qty}, COD ≈৳${estimate}) — the shop confirms it before dispatch`,
      fallback: "PRESENT_SUMMARY",
    };
  }

  // Auto tier (or a replayed execution) — same ledger entry and state moves as
  // the pre-gate live path.
  const result = gate.order;
  ctx.toolLedger.push({ tool: "create_chat_order", args: { productId: product.id, qty }, raw: result ?? gate.detail, calledAt: Date.now(), ok: true });
  if (!result) {
    // Replay without a snapshot: the outcome line still names the order.
    return { ok: true, actionId: gate.actionId, reason: gate.detail, fallback: "PRESENT_SUMMARY" };
  }

  // ORDERED: the product leaves tracking and lives in orders[].
  delete ctx.products.tracked[focusId];
  delete ctx.products.items[focusId];
  ctx.orders.push({ no: result.orderNumber, title: product.name, total: result.total });
  ctx.purchase.confirmSent = false;
  ctx.purchase.qty = undefined;
  ctx.purchase.variant = undefined;
  addMemo(ctx, `order #${result.orderNumber} ৳${result.total}`);

  return {
    ok: true,
    actionId: gate.actionId,
    orderNumber: result.orderNumber,
    total: result.total,
    subtotal: result.total - result.shippingCharge,
    shipping: result.shippingCharge,
    reason: "",
    fallback: "PRESENT_SUMMARY",
  };
}

// ---------------------------------------------------------------------------
// Hand-over composition — deterministic, from state, never from model output
// ---------------------------------------------------------------------------

/**
 * Which slug and which room, decided by the app.
 *
 * `tool_failure` is NOT a catch-all and is deliberately unreachable from here:
 * it maps to the "Nova is not sure" holding template and its founder label
 * reads "Nova could not check", so using it for anything but a tool that
 * actually errored is the wrong sentence twice over. A blocked order gate is
 * `guardrail_blocked`; a complaint Nova cannot settle is `anger`; anything else
 * that reaches ESCALATE is honestly `lost`.
 *
 * `anger` for the `complaint` intent is a JUDGEMENT worth naming: the L0
 * classifier fires on vanga/nosto/kharap/refund/problem/wrong, i.e. a
 * dissatisfied customer, and `anger` is the taxonomy's bucket for that. A finer
 * classifier that could tell "the box arrived broken" from "you charged me
 * twice" would route the first to `open_case(damaged_item)` and the second to
 * `payment_dispute`; neither distinction exists in `classify.ts` today, and
 * inventing one here would be the app guessing rather than deciding.
 */
function handoverRoute(
  intent: Intent,
  orderGateBlocked: boolean,
): { reason: EscalationReason; department: HandoverDepartment } {
  if (orderGateBlocked) return { reason: "guardrail_blocked", department: "sales" };
  if (intent === "human_ask") return { reason: "human_ask", department: "support" };
  if (intent === "complaint") return { reason: "anger", department: "support" };
  return { reason: "lost", department: "support" };
}

/**
 * The founder's brief, in both halves.
 *
 * Composed from STATE, not from the customer's message text: in nova-ai this
 * summary is model-authored inside a tool whose payload cannot hold a phone,
 * and the equivalent discipline here is to build it from facts the app already
 * owns. `summaryBn` is a real Bangla sentence — not the English text, not a
 * transliteration, and not a placeholder to satisfy the length check.
 *
 * The guardrail case never names the rule. That stays on the ledger row.
 */
function escalationBrief(ctx: NovaLiveContext, reason: EscalationReason): { summary: string; summaryBn: string } {
  const focus = ctx.hydrated.product?.value?.name;
  const focusEn = focus ? `Product in focus: ${focus}.` : "No product in focus.";
  const focusBn = focus ? `আলোচিত পণ্য: ${focus}।` : "কোনো পণ্য নির্দিষ্ট হয়নি।";
  const orders = ctx.orders.map((o) => `#${o.no}`).join(", ");
  const ordersEn = orders ? ` Orders in this thread: ${orders}.` : "";
  const ordersBn = orders ? ` এই থ্রেডের অর্ডার: ${orders}।` : "";
  const stageEn = ` Stage: ${ctx.conversation.stage}.`;

  const lead: Record<EscalationReason, [string, string]> = {
    human_ask: [
      "Customer asked to speak to a person.",
      "ক্রেতা একজন মানুষের সাথে কথা বলতে চেয়েছেন।",
    ],
    anger: [
      "Customer raised a complaint Nova cannot settle from the thread.",
      "ক্রেতা এমন একটি অভিযোগ করেছেন যা নোভা থ্রেড থেকে মীমাংসা করতে পারে না।",
    ],
    guardrail_blocked: [
      "A chat order could not be placed under this shop's own rules, so the thread needs you.",
      "দোকানের নিজের নিয়মের কারণে চ্যাট অর্ডারটি বসানো যায়নি, তাই থ্রেডটি আপনাকে দেখতে হবে।",
    ],
    lost: [
      "Nova could not carry this conversation further on its own.",
      "নোভা নিজে থেকে এই কথোপকথনটি আর এগিয়ে নিতে পারছে না।",
    ],
    // Reachable only if `handoverRoute` grows a branch for them; the pairs are
    // here so a new branch cannot ship with an English-only brief.
    payment_dispute: ["Customer disputes a payment on this thread.", "ক্রেতা এই থ্রেডে একটি পেমেন্ট নিয়ে আপত্তি তুলেছেন।"],
    legal: ["This thread raises a legal matter.", "এই থ্রেডে একটি আইনি বিষয় উঠে এসেছে।"],
    negotiation: ["Customer is negotiating beyond what Nova may offer.", "ক্রেতা এমন দর-কষাকষি করছেন যা নোভার সীমার বাইরে।"],
    vip: ["A priority customer is on this thread.", "এই থ্রেডে একজন গুরুত্বপূর্ণ ক্রেতা আছেন।"],
    tool_failure: ["A tool Nova needed did not answer.", "নোভার প্রয়োজনীয় একটি টুল সাড়া দেয়নি।"],
    fraud_risk: ["This thread looks like a fraud risk.", "এই থ্রেডটি প্রতারণার ঝুঁকির মতো দেখাচ্ছে।"],
    policy_gap: ["The shop has no written rule covering what was asked.", "যা জানতে চাওয়া হয়েছে তার কোনো লিখিত নিয়ম দোকানের নেই।"],
    catalog_gap: ["The shop does not carry what was asked for.", "যা চাওয়া হয়েছে দোকানে তা নেই।"],
  };

  const [en, bnText] = lead[reason];
  return {
    summary: `${en} ${focusEn}${ordersEn}${stageEn}`,
    summaryBn: `${bnText} ${focusBn}${ordersBn}`,
  };
}

/** Real reads only — the tool ledger this turn actually wrote, phones masked. */
function factsCheckedFrom(ctx: NovaLiveContext): Array<{ source: string; note: string }> {
  return ctx.toolLedger.slice(-6).map((entry) => {
    let args = "";
    try {
      args = JSON.stringify(entry.args) ?? "";
    } catch {
      args = "(unserializable args)";
    }
    return {
      source: entry.tool,
      note: maskPhonesIn(`${entry.ok ? "checked ok" : "did not succeed"}: ${args}`).slice(0, 200),
    };
  });
}

// ---------------------------------------------------------------------------

function buildActionLine(ctx: NovaLiveContext, action: string, facts: string): string {
  const focus = ctx.hydrated.product?.value;
  const bits: string[] = [action];
  if (facts) bits.push(facts);
  switch (action) {
    case "ASK_SIZE":
      if (focus?.options?.length) bits.push(`in-stock options: ${focus.options.join("/")}`);
      break;
    case "ASK_QTY":
      if (ctx.hydrated.stock) bits.push(`${ctx.purchase.variant ?? ""} stock ${ctx.hydrated.stock.value}`.trim());
      break;
    case "ANSWER_PRICE":
      if (focus) bits.push(`${focus.name} price ৳${ctx.hydrated.price?.value ?? focus.price}`);
      break;
    case "ANSWER_STOCK":
      if (ctx.hydrated.stock) bits.push(`stock ${ctx.hydrated.stock.value}`);
      break;
    case "ANSWER_DELIVERY_FAQ": {
      const pol = ctx.hydrated.policies?.value;
      if (pol) bits.push(`delivery ৳${pol.deliveryFeeInside} inside Dhaka / ৳${pol.deliveryFeeOutside} outside · COD ${pol.codAvailable ? "available" : "not available"}`);
      break;
    }
    case "PRESENT_SUMMARY": {
      if (focus && ctx.purchase.qty) {
        const unit = ctx.hydrated.price?.value ?? focus.price;
        const sub = unit * ctx.purchase.qty;
        const fee = ctx.purchase.fee?.value;
        bits.push(
          `ONE order summary: ${focus.name}${ctx.purchase.variant ? ` ${ctx.purchase.variant}` : ""} × ${ctx.purchase.qty} = ৳${sub}${fee !== undefined ? ` + delivery ৳${fee} = ৳${sub + fee}` : ""} COD. Ask for the customer's clear confirmation.`,
        );
      }
      break;
    }
    case "DECLINE_DISCOUNT_ONCE":
      bits.push("politely hold the price (no discount authority); do not repeat an apology");
      break;
    case "ORDER_PENDING_APPROVAL":
      // FD-3 stance: the normal flow, never an apology — and never a number
      // for an order that does not exist yet.
      bits.push(
        "confirm warmly that the order is being placed — the shop double-checks every chat order before dispatch and will confirm shortly; this is the normal flow, not a problem, so no apology; do NOT invent an order number or a final total",
      );
      break;
    case "ESCALATE":
      bits.push("tell the customer a person from the shop will take over shortly; one line, then stop");
      break;
    case "ACKNOWLEDGE_REJECT":
      bits.push("accept gracefully, leave the door open, no pressure");
      break;
    case "GREET":
      bits.push("greet back briefly as the shop, invite them to say what they're looking for");
      break;
    case "ASK_PRODUCT":
      bits.push("ask (once, naturally) which product they mean; do not list the whole catalog");
      break;
    case "ASK_ZONE":
      bits.push("ask which area they want delivery to (Dhaka or outside)");
      break;
    case "ASK_PHONE_ADDR":
      bits.push("ask for delivery details in ONE natural ask: name if unknown, phone, full address with thana/district");
      break;
    case "ANSWER_ORDER_STATUS": {
      const pending = ctx.pendingOrders ?? [];
      if (ctx.orders.length) {
        bits.push(`orders on file: ${ctx.orders.map((o) => `#${o.no}`).join(", ")} — status lookup not wired yet, be honest`);
      } else if (pending.length) {
        bits.push(`order (${pending.map((o) => o.title).join(", ")}) is with the shop for confirmation — normal flow, no order number yet, be honest`);
      } else {
        bits.push("no order found in this conversation — ask for the order number");
      }
      break;
    }
  }
  return bits.filter(Boolean).join(" · ");
}
