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
import { loadContext, saveContext, withTurnLock } from "./context-store.js";
import { observe, TTL } from "./cache.js";
import {
  addMemo,
  bump,
  computeMissing,
  computeStage,
  fact,
  isFresh,
  pushMessage,
  type NovaLiveContext,
} from "./state.js";
import { feeForZone, focusProduct, hydratePolicies, resolveProduct, variantIdFor, variantStock } from "./hydrate.js";
import { listProducts, createChatOrder, type DakioProduct } from "./dakio.js";
import { getStoreProfile } from "../lib/store.js";
import { resolverAgent, resolverSchema, writerAgent, writerSystem } from "./agents.js";

export interface TurnResult {
  reply: string;
  intent: Intent;
  rung: 0 | 1;
  action: NextAction | "ORDER_CONFIRMED";
  stage: string;
  missing: string[];
  stateCard: string;
  order?: { orderNumber: string; total: number };
  timings: Record<string, number>;
  cacheHits: number;
  version: number;
}

export function runCustomerTurn(storeId: string, convId: string, message: string): Promise<TurnResult> {
  return withTurnLock(storeId, convId, () => executeTurn(storeId, convId, message));
}

/**
 * The zai provider on the gateway throws transient 503s ("Service temporarily
 * unavailable") with no configured fallbacks. Retry model calls a couple of
 * times before failing the turn.
 */
async function withGatewayRetry<T>(call: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await call();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (!/temporarily unavailable|503|overloaded/i.test(msg)) throw err;
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw lastErr;
}

async function executeTurn(storeId: string, convId: string, message: string): Promise<TurnResult> {
  const t0 = Date.now();
  const timings: Record<string, number> = { receivedAt: t0 };

  const ctx = loadContext(storeId, convId);
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
    };
  }

  // ---- Classify: L0 rules, else L1 resolver --------------------------------
  const awaiting = ctx.purchase.confirmSent ? "confirm" : ctx.conversation.nextAction === "ASK_QTY" ? "qty" : null;
  let classified: Classified | null = classifyL0(message, { awaiting });
  if (!classified) {
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

  // ---- Mutation gate: CREATE_ORDER — hard revalidation, always live ---------
  let order: TurnResult["order"];
  let facts = "";
  if (action === "CREATE_ORDER") {
    const gate = await hardValidateAndCreate(ctx);
    if (gate.ok) {
      order = { orderNumber: gate.orderNumber!, total: gate.total! };
      action = "ORDER_CONFIRMED" as never;
      facts = `Order #${gate.orderNumber} created — total ৳${gate.total} COD (product ৳${gate.subtotal} + delivery ৳${gate.shipping}).`;
    } else {
      action = gate.fallback;
      facts = gate.reason;
    }
  }

  // ---- Reducer-derived stage + NBA persistence ------------------------------
  if (action === ("ORDER_CONFIRMED" as never)) {
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

  const writeRes = await withGatewayRetry(() =>
    writerAgent.generate(
      [{ role: "user", content: `${card}\n\nLAST MESSAGES:\n${renderRecent(ctx)}\n\nACTION: ${actionLine}\nWrite the reply.` }],
      { instructions: writerSystem({ name: store.name, currency: store.currency }) },
    ),
  );
  const reply = writeRes.text.trim();

  pushMessage(ctx, { role: "nova", text: reply, at: Date.now() });
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
    timings,
    cacheHits,
    version: ctx.version,
  };
}

// ---------------------------------------------------------------------------
// Mutation gate
// ---------------------------------------------------------------------------

interface GateResult {
  ok: boolean;
  orderNumber?: string;
  total?: number;
  subtotal?: number;
  shipping?: number;
  reason: string;
  fallback: NextAction;
}

/**
 * HARD validation before the only mutation: stock ✓ price ✓ delivery ✓ — all
 * LIVE reads (never the cache), then the server-priced order create.
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
  const result = await createChatOrder(ctx.storeId, {
    // Deterministic per Nth order of this conversation: a retried turn replays
    // the same order instead of creating a second parcel at a real doorstep.
    novaActionId: `nm:${ctx.convId}:order-${ctx.orders.length}`,
    conversationId: ctx.convId,
    customerName: ctx.customer.name?.value ?? "Messenger Customer",
    customerPhone: ctx.customer.phone.value,
    customerCity: zone,
    customerDistrict: inside ? "Dhaka" : zone,
    customerAddress: ctx.customer.addr.value,
    items: [
      {
        productId: product.id,
        variantId: variantIdFor(product, p.variant),
        productName: product.name,
        qty: p.qty,
      },
    ],
    confirmedByCustomer: true,
  });
  ctx.toolLedger.push({ tool: "create_chat_order", args: { productId: product.id, qty: p.qty }, raw: result, calledAt: Date.now(), ok: true });

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
    orderNumber: result.orderNumber,
    total: result.total,
    subtotal: result.total - result.shippingCharge,
    shipping: result.shippingCharge,
    reason: "",
    fallback: "PRESENT_SUMMARY",
  };
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
    case "ANSWER_ORDER_STATUS":
      bits.push(ctx.orders.length ? `orders on file: ${ctx.orders.map((o) => `#${o.no}`).join(", ")} — status lookup not wired yet, be honest` : "no order found in this conversation — ask for the order number");
      break;
  }
  return bits.filter(Boolean).join(" · ");
}
