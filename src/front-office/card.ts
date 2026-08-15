/**
 * The state card — ~120 tokens, rebuilt per turn. One serializer, two
 * consumers: the model's turn packet and the founder sidebar render the SAME
 * card, so they can never disagree. (PRD §04.)
 *
 * Inclusion rules: focus product only (tracked others = one line each);
 * policy lines only when the action needs them; never full phone/address;
 * MEMO ≤ 60 tokens.
 */

// maskPhone lives in state.ts so there is ONE masker: the card header and the
// MEMO folding (pushMessage) can never drift apart on the last-3 convention.
import { ageSec, computeMissing, maskPhone, type NovaLiveContext } from "./state.js";

function shortAddr(addr: string): string {
  return addr.length > 28 ? `${addr.slice(0, 28)}…` : addr;
}

export function renderStateCard(ctx: NovaLiveContext, now = Date.now()): string {
  const lines: string[] = [];
  const c = ctx.customer;

  lines.push(`CONV ${ctx.convId} v${ctx.version} · ${c.channel}`);
  lines.push(`LANG ${c.lang.pref} (${c.lang.detected}-in) · SENTIMENT ${c.sentiment}`);
  lines.push(`STAGE ${ctx.conversation.stage} · CONF ${ctx.conversation.confidence}`);

  const custBits: string[] = [];
  if (c.name) custBits.push(`${c.name.value}${c.name.confidence === "confirmed" ? " ✓" : " (unconfirmed)"}`);
  if (c.phone) custBits.push(`phone ${c.phone.confidence === "confirmed" ? "✓ " : "? "}${maskPhone(c.phone.value)}`);
  if (custBits.length) lines.push(`CUSTOMER ${custBits.join(" · ")}`);
  if (c.addr) {
    lines.push(`  addr ${shortAddr(c.addr.value)}${c.addr.confidence === "confirmed" ? "" : ` — ${c.addr.source}, unconfirmed`}`);
  }

  const focus = ctx.hydrated.product?.value;
  if (focus && ctx.products.focusId) {
    lines.push(`FOCUS ${focus.name} #${focus.id.slice(-6)} · ৳${focus.price}`);
    const stockF = ctx.hydrated.stock;
    const priceF = ctx.hydrated.price;
    const bits: string[] = [];
    if (stockF) bits.push(`stock ${stockF.value} (${ageSec(stockF, now)}s)`);
    if (priceF) bits.push(`price ৳${priceF.value} (${ageSec(priceF, now)}s)`);
    if (focus.options?.length) bits.push(`options ${focus.options.join("/")}`);
    if (bits.length) lines.push(`  ${bits.join(" · ")}`);
  }

  for (const [id, status] of Object.entries(ctx.products.tracked)) {
    if (id === ctx.products.focusId) continue;
    const saved = ctx.products.items[id];
    const savedBits = saved ? ` (${[saved.variant, saved.qty ? `qty ${saved.qty}` : null].filter(Boolean).join(" · ")})` : "";
    lines.push(`ALSO #${id.slice(-6)} = ${status}${savedBits}`);
  }

  const p = ctx.purchase;
  const pBits: string[] = [];
  if (p.variant) pBits.push(p.variant);
  if (p.qty) pBits.push(`× ${p.qty}`);
  if (p.fee !== undefined && p.zone) pBits.push(`fee ৳${p.fee.value} ${p.zone}`);
  else if (p.zone) pBits.push(p.zone);
  pBits.push(p.payment.toUpperCase());
  if (pBits.length > 1) lines.push(`PURCHASE ${pBits.join(" · ")}`);

  const missing = computeMissing(ctx);
  lines.push(`MISSING ${missing.length ? missing.join(", ") : "nothing"}`);

  if (ctx.orders.length) {
    lines.push(`ORDERS ${ctx.orders.map((o) => `#${o.no} ৳${o.total}`).join(" · ")}`);
  }
  // No number and no total on purpose — no order exists yet (FD-3: the shop
  // confirms each chat order; the card must not let a later turn invent one).
  if (ctx.pendingOrders?.length) {
    lines.push(`PENDING SHOP CONFIRM ${ctx.pendingOrders.map((o) => o.title).join(" · ")}`);
  }
  if (ctx.conversation.summary) lines.push(`MEMO ${ctx.conversation.summary}`);

  return lines.join("\n");
}

/** The verbatim tail that rides with the card (PRD: last 2–3 for the writer). */
export function renderRecent(ctx: NovaLiveContext, count = 3): string {
  return ctx.recent
    .slice(-count)
    .map((m) => `${m.role === "customer" ? "CUSTOMER" : "NOVA"}: ${m.text}`)
    .join("\n");
}
