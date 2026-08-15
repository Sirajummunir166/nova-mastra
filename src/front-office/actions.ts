/**
 * The customer-lane write gates — lane-appropriate ports of nova-ai's
 * `performAction` (agent/lib/nova/actions.ts), one exported function per verb:
 *
 *   performCreateOrder    create_order_from_chat   sales    · Orders door
 *   performOfferDiscount  offer_chat_discount      sales    · Coupons door
 *   performCancelOrder    cancel_order_from_chat   sales    · Orders door
 *   performUpdateContact  update_order_contact     shipping · Courier door
 *   performOpenCase       open_case                derived  · by department
 *   performFlagHandover   escalate_conversation    routed   · server's card
 *
 * The order gate below is the reference implementation; the other five are in
 * the section that follows it and share its two non-executing branches through
 * `gateOrFile`. Read this header first — everything it says about receipts,
 * idempotency and FD-3 is true of all six.
 *
 * Design as found, and deliberately followed rather than reinvented:
 *
 *  - nova-ai `performAction`: consult `evaluateAuthority`, then execute /
 *    prepare / block — every verdict lands as a receipted ledger row via
 *    `client.addAction`, and a prepared row is surfaced to the founder as a
 *    Decision (`client.addDecision(authorDecision(…))`). The gate rule rides
 *    as `authority_gate` evidence on EVERY row, whatever the verdict.
 *  - nova-ai `create_order_from_chat` tool: department is the constant
 *    "sales", dutyRef "sales.inbox_orders", and the title says WHAT and WHERE
 *    (`Chat order: 2 items to Savar, Dhaka`) — never the phone, never the
 *    street line, because the title outlives the card.
 *  - nova-ai executor `executors.create_order_from_chat`: the server prices
 *    everything (the payload carries no `unitPrice`/`total`/`discount`/`paid`),
 *    `productName` is match-and-display only, refusals propagate as
 *    `InboxSendRefused` (the customer is owed the answer), and the executed
 *    row's undoData is `{kind:"cancel_chat_order", orderId, orderNumber}` —
 *    the key dakio-api's `UNDO` map dispatches on.
 *  - dakio-api `novaExecutors.js create_order_from_chat`: what an APPROVED
 *    Decision executes. It reads the prepared action's payload field by field
 *    (conversationId, customerName/Phone/City/District/Address, items
 *    productId/variantId/qty, couponCode, confirmedByCustomer===true) and
 *    creates the order with `novaActionId = action.id`. Filing exactly that
 *    payload shape is therefore the whole contract of the prepared tier.
 *
 * ── FD-3, restated for this lane ───────────────────────────────────────────
 * `inbox.orderAuto` ships FALSE, so on a default store EVERY chat order lands
 * here as a prepared Decision the founder approves. That is the product
 * decision, not a failure: the customer is told the order is going in, and it
 * does — after the shop's own confirmation, exactly as in a shop where the
 * owner is at the counter. The reply must carry that stance (normal flow,
 * never an apology) and must never invent an order number for an order that
 * does not exist yet.
 *
 * ── Idempotency (deviation from nova-ai's direct path, kept from turn.ts) ──
 * nova-ai's direct path mints a fresh uuid per call; this lane's turn already
 * derives a DETERMINISTIC key (`nm:<conv>:order-<n>`) so a redelivered turn
 * replays instead of double-ordering. That key rides IN the payload
 * (`payload.novaActionId`) so the gate can dedupe the PREPARED tier too:
 * a redelivery finds the existing prepared/executed row by key and returns it
 * instead of filing a second card. dakio-api's approve executor ignores the
 * extra payload field (it maps fields explicitly and uses `action.id` as the
 * server-side order key), so the wire contract is untouched.
 *
 * Note the asymmetry on executed replays: a row executed via the DIRECT path
 * carries the order snapshot in `receipt.after` (same as nova-ai's executor);
 * a row executed via the APPROVE path was keyed `action.id` server-side, so
 * replaying `createChatOrder` with the `nm:` key would create a SECOND order.
 * Replays therefore answer from the ledger row and never re-call the write.
 */

import { storeFor } from "../store/resolve.js";
import { evaluateAuthority } from "../store/authority.js";
import type { StoreClient } from "../store/client.js";
import type {
  ActionReceipt,
  ActionRecord,
  AuthorityDecision,
  ChatOrderResult,
  DecisionRecord,
  NovaDepartment,
  OrderStatus,
  ReceiptEvidence,
  RiskClass,
} from "../store/types.js";
import { maskPhonesIn } from "./state.js";

/** The verb, the department and the duty are constants — a chat order is the
 *  sales room's work whatever the thread was about a turn ago. */
const VERB = "create_order_from_chat" as const;
const DEPARTMENT = "sales" as const;
const DUTY_REF = "sales.inbox_orders" as const;

/**
 * Byte-compatible with nova-ai's `createOrderFromChatPayload` (schemas.ts):
 * no price fields anywhere, `confirmedByCustomer` is the literal `true`
 * (unsatisfiable otherwise — the type is the assertion that the customer said
 * yes to the itemized total), `productName` required per item so a founder's
 * no-touch lock has a word to match on. Plus one rider this lane adds:
 * `novaActionId`, the at-most-once key (see the header).
 */
export interface ChatOrderGatePayload {
  /** At-most-once key, stable across redeliveries of the same decided order. */
  novaActionId: string;
  conversationId: string;
  customerName: string;
  /** As the customer typed it — the server normalizes and validates. */
  customerPhone: string;
  customerCity: string;
  /** Decides the shipping charge server-side (inside vs outside Dhaka). */
  customerDistrict: string;
  customerAddress?: string;
  items: Array<{ productId: string; variantId?: string; productName: string; qty: number }>;
  /** Re-validated server-side; never applied on trust. */
  couponCode?: string;
  confirmedByCustomer: true;
}

/** The model/turn-authored half of the E-8 receipt (nova-ai `receiptSchema`). */
export interface OrderReceiptInput {
  reason: string;
  expectedImpact: string;
  /** 0–1. */
  confidence: number;
  evidence: ReceiptEvidence[];
}

export type OrderGateOutcome =
  | {
      status: "executed";
      actionId: string;
      /** Founder-facing outcome line (also the ledger row's `outcome`). */
      detail: string;
      /** Null only on a replay whose row predates the snapshot — detail still names the order. */
      order: ChatOrderResult | null;
      /** True when a redelivered key answered from the ledger, not a fresh write. */
      replayed: boolean;
    }
  | {
      status: "prepared";
      actionId: string;
      /** FD-3 wording: the order is going in — the shop confirms it first. */
      detail: string;
      rule: string;
      replayed: boolean;
    }
  | { status: "blocked"; actionId: string; detail: string; rule: string };

/**
 * Gate, then execute / file / block — the customer lane's `performAction`.
 *
 * Refusals from the WRITE (stock-out, fake-order guard, coupon that does not
 * hold) propagate as `InboxSendRefused`, exactly as nova-ai's executor lets
 * them: an order the server declined must never be reported as one Nova
 * placed — the customer is waiting for a number.
 */
export async function performCreateOrder(
  storeId: string,
  request: { payload: ChatOrderGatePayload; receipt: OrderReceiptInput },
): Promise<OrderGateOutcome> {
  const client = storeFor(storeId);
  const { payload, receipt } = request;

  // ── At-most-once: a redelivered key answers from the ledger. ─────────────
  // Blocked rows deliberately do NOT dedupe — the founder may lift a lock or
  // raise the dial, and a fresh attempt must be re-judged (nova-ai files a new
  // blocked row per attempt for the same reason).
  const existing = await findByKey(client, VERB, payload.novaActionId);
  if (existing) {
    if (existing.status === "executed") {
      return {
        status: "executed",
        actionId: existing.id,
        detail: existing.outcome ?? "Order already placed for this confirmation.",
        order: orderFromRecord(existing),
        replayed: true,
      };
    }
    return {
      status: "prepared",
      actionId: existing.id,
      detail: preparedDetail(),
      rule: gateRuleOf(existing) ?? "replay",
      replayed: true,
    };
  }

  const authority = await evaluateAuthority(client, {
    type: VERB,
    payload: payload as unknown as Record<string, unknown>,
    dutyKey: DUTY_REF,
    origin: "chat",
  });

  const title = orderTitle(payload);
  const gateEvidence: ReceiptEvidence = {
    source: "authority_gate",
    note: authority.explanation,
    metric: "rule",
    value: authority.rule,
  };

  if (authority.verdict === "refuse") {
    // A refusal is an explained, receipted event — its evidence is the rule
    // that fired (nova-ai performAction, PRD §13).
    const record = await client.addAction({
      type: VERB,
      department: DEPARTMENT,
      title,
      payload: payload as unknown as Record<string, unknown>,
      justification: justificationOf(receipt),
      receipt: buildReceipt(receipt, null, null, [gateEvidence]),
      riskClass: authority.riskClass,
      status: "blocked",
      outcome: authority.explanation,
      undoable: false,
      undoData: null,
      actor: "nova",
      targetRef: null,
      agentId: null,
      dutyRef: DUTY_REF,
      undoDeadline: null,
      undoneAt: null,
      decidedAt: client.now(),
      executedAt: null,
    });
    // Only escalation-flagged refusals become desk cards — ordinary guardrail
    // trims must not fill the desk with noise. Best-effort: the refusal is
    // already recorded and enforced.
    if (authority.escalation) {
      await client.addDecision(authorOrderDecision(client, record, authority)).catch(() => {});
    }
    return { status: "blocked", actionId: record.id, detail: authority.explanation, rule: authority.rule };
  }

  if (authority.verdict === "draft" || authority.verdict === "suggest") {
    // The prepared row IS what dakio-api's approve executor reads — payload
    // field for field. The gate rule rides as evidence (nova-ai's 2026-08-10
    // lesson: prepared rows that don't name their rule cost a diagnosis hours).
    const record = await client.addAction({
      type: VERB,
      department: DEPARTMENT,
      title,
      payload: payload as unknown as Record<string, unknown>,
      justification: justificationOf(receipt),
      receipt: buildReceipt(receipt, null, null, [gateEvidence]),
      riskClass: authority.riskClass,
      status: "prepared",
      outcome: authority.verdict === "suggest" ? "suggestion" : null,
      undoable: false,
      undoData: null,
      actor: "nova",
      targetRef: null,
      agentId: null,
      dutyRef: DUTY_REF,
      undoDeadline: null,
      undoneAt: null,
      decidedAt: null,
      executedAt: null,
    });
    // The founder answers a Decision, not a raw prepared row. Best-effort: a
    // desk-card failure must not lose the work Nova already did.
    await client.addDecision(authorOrderDecision(client, record, authority)).catch(() => {});
    return {
      status: "prepared",
      actionId: record.id,
      detail: preparedDetail(),
      rule: authority.rule,
      replayed: false,
    };
  }

  // ── Auto tier: exactly the pre-gate live path — the server prices it. ────
  const order = await client.createChatOrder({
    novaActionId: payload.novaActionId,
    sourceConversationId: payload.conversationId,
    customerName: payload.customerName,
    customerPhone: payload.customerPhone,
    customerCity: payload.customerCity,
    customerDistrict: payload.customerDistrict,
    ...(payload.customerAddress ? { customerAddress: payload.customerAddress } : {}),
    // `productName` dropped on the wire, kept on the ledger payload — it is
    // lock-match/display text, never a selector (nova-ai executor, dakio-api
    // executor both drop it the same way).
    items: payload.items.map((item) => ({
      productId: item.productId,
      ...(item.variantId ? { variantId: item.variantId } : {}),
      qty: item.qty,
    })),
    ...(payload.couponCode ? { couponCode: payload.couponCode } : {}),
  });

  const units = payload.items.reduce((sum, item) => sum + item.qty, 0);
  const outcome =
    `Order ${order.orderNumber} — ৳${order.codAmount} to collect on delivery, ` +
    `${units} item${units === 1 ? "" : "s"} to ${payload.customerCity}, ${payload.customerDistrict} ` +
    `(order total ৳${order.total}, delivery ৳${order.shippingCharge}` +
    (payload.couponCode ? `, coupon ${payload.couponCode}` : "") +
    `).`;

  const record = await client.addAction({
    type: VERB,
    department: DEPARTMENT,
    title,
    payload: payload as unknown as Record<string, unknown>,
    justification: justificationOf(receipt),
    receipt: buildReceipt(
      receipt,
      null,
      {
        orderNumber: order.orderNumber,
        shippingCharge: order.shippingCharge,
        total: order.total,
        codAmount: order.codAmount,
        status: order.status,
        customerId: order.customerId,
        trackingUrl: order.trackingUrl,
      },
      [gateEvidence],
    ),
    riskClass: authority.riskClass,
    status: "executed",
    outcome,
    undoable: true,
    undoData: { kind: "cancel_chat_order", orderId: order.id, orderNumber: order.orderNumber },
    actor: "nova",
    targetRef: `order:${order.id}`,
    agentId: null,
    dutyRef: DUTY_REF,
    undoDeadline: null,
    undoneAt: null,
    decidedAt: client.now(),
    executedAt: client.now(),
  });

  // Metadata, never authority — the order exists; neither the by:nova stamp
  // nor the activity line may fail an already-executed sale.
  await client.attributeDoorRecord(`order:${order.id}`, record.id).catch(() => {});
  await client
    .addActivity({
      department: DEPARTMENT,
      kind: "action",
      title,
      detail: outcome,
      minutesSaved: 12, // MINUTES_BY_ACTION parity — same figure both surfaces write
      revenueInfluence: order.total,
      actionId: record.id,
      relatedId: order.id,
      revenueBasis: "estimated", // module 09: COD is not collected money; the sweep re-bases on delivery
      revenueProvenance: `chat_order:${order.id}`,
    })
    .catch(() => {});

  return { status: "executed", actionId: record.id, detail: outcome, order, replayed: false };
}

/* ── helpers ──────────────────────────────────────────────────────────────── */

/**
 * The tool's title rule, verbatim: WHAT and WHERE — the two things that decide
 * whether the founder approves. No phone and no street line: the title
 * outlives the card, and the 360 masks the number everywhere else precisely so
 * it does not end up in a row like this one.
 */
export function orderTitle(payload: ChatOrderGatePayload): string {
  const units = payload.items.reduce((sum, item) => sum + item.qty, 0);
  return `Chat order: ${units} item${units === 1 ? "" : "s"} to ${payload.customerCity}, ${payload.customerDistrict}`;
}

/** FD-3 in one line — the normal flow, never an apology. */
function preparedDetail(): string {
  return (
    "The order is going in — the shop confirms each chat order before dispatch. " +
    "It is fully prepared on the owner's desk and will be placed as approved."
  );
}

function justificationOf(receipt: OrderReceiptInput) {
  return { reason: receipt.reason, expectedImpact: receipt.expectedImpact, confidence: receipt.confidence };
}

function buildReceipt(
  input: OrderReceiptInput,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  extraEvidence: ReceiptEvidence[],
): ActionReceipt {
  return {
    reason: input.reason,
    expectedImpact: input.expectedImpact,
    confidence: input.confidence,
    evidence: [...input.evidence, ...extraEvidence],
    before,
    after,
  };
}

/**
 * Find the prepared/executed row this key already produced, if any.
 *
 * BLOCKED rows deliberately never match: the founder may lift a lock or raise
 * the dial, and the next attempt must be re-judged rather than answered from a
 * refusal. Shared by every verb in this file — the dedupe rule is the same one
 * whatever is being written.
 */
async function findByKey(client: StoreClient, type: string, novaActionId: string): Promise<ActionRecord | null> {
  const rows = await client.listActions();
  return (
    rows.find(
      (r) =>
        r.type === type &&
        (r.status === "prepared" || r.status === "executed") &&
        (r.payload as Record<string, unknown> | null)?.novaActionId === novaActionId,
    ) ?? null
  );
}

/** The authority rule stamped on the row's receipt evidence, if present. */
function gateRuleOf(record: ActionRecord): string | null {
  const hit = record.receipt?.evidence?.find((e) => e.source === "authority_gate" && e.metric === "rule");
  return typeof hit?.value === "string" ? hit.value : null;
}

/**
 * Rebuild what the customer was told from the ledger row. Direct-path rows
 * carry the full snapshot in `receipt.after`; approve-path rows (executed by
 * dakio-api) carry at least `undoData.orderNumber`. NEVER re-calls the write —
 * see the header on why a replayed `nm:` key after an approve-path execution
 * would place a second parcel.
 */
function orderFromRecord(record: ActionRecord): ChatOrderResult | null {
  const after = (record.receipt?.after ?? null) as Record<string, unknown> | null;
  const undo = (record.undoData ?? null) as Record<string, unknown> | null;
  const orderNumber = (after?.orderNumber ?? undo?.orderNumber) as string | undefined;
  if (!orderNumber) return null;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : NaN);
  const total = num(after?.total);
  if (!Number.isFinite(total)) return null;
  return {
    id: String(undo?.orderId ?? record.targetRef?.replace(/^order:/, "") ?? ""),
    orderNumber,
    total,
    shippingCharge: num(after?.shippingCharge) || 0,
    codAmount: Number.isFinite(num(after?.codAmount)) ? num(after?.codAmount) : total,
    status: typeof after?.status === "string" ? after.status : "placed",
    customerId: typeof after?.customerId === "string" ? after.customerId : null,
    trackingUrl: typeof after?.trackingUrl === "string" ? after.trackingUrl : null,
  };
}

/* ── Decision authoring — trimmed port of nova-ai decisions.ts ────────────── */

/** How long an unanswered ask stays useful, by risk (nova-ai TTL_HOURS). */
const TTL_HOURS: Record<RiskClass, number> = { high: 24, medium: 72, low: 168 };

/**
 * The card's scannable params line — nova-ai `paramsLineFor`'s
 * `create_order_from_chat` case, verbatim in behavior: goods and destination,
 * two names then a count, coupon named because it is the only way this path
 * sells below list. Deliberately NO phone, NO address line, NO customer name —
 * the summary is the copy that gets logged and re-rendered in places nobody
 * re-audits; the founder opens the card for the address.
 */
export function orderParamsLine(payload: ChatOrderGatePayload): string {
  const parts: string[] = [];
  const named = payload.items
    .map((it) => {
      const name = it.productName?.trim();
      if (!name) return "";
      return Number.isFinite(it.qty) && it.qty > 1 ? `${name} ×${it.qty}` : name;
    })
    .filter(Boolean);
  if (named.length > 2) parts.push(`${named.slice(0, 2).join(", ")} +${named.length - 2} more`);
  else if (named.length) parts.push(named.join(", "));
  else if (payload.items.length) parts.push(`${payload.items.length} item${payload.items.length === 1 ? "" : "s"}`);
  if (payload.customerDistrict) parts.push(`to ${payload.customerDistrict}`);
  if (payload.couponCode) parts.push(`coupon ${payload.couponCode}`);
  return parts.join(" · ");
}

/**
 * Project the gated action into the Decision the founder answers (nova-ai
 * `authorDecision`, scoped to this verb): kind follows the VERDICT (a flagged
 * refusal is an escalation, a draft is a proposal), the door override is
 * `door:orders` — a chat order surfaces under Orders, not the sales
 * department's Coupons door (nova-ai `DOOR_BY_ACTION_TYPE`).
 */
function authorOrderDecision(
  client: StoreClient,
  action: ActionRecord,
  authority: GateVerdict,
): DecisionInput {
  return authorGateDecision(client, action, authority, {
    tag: DEPARTMENT,
    // The per-verb OVERRIDE nova-ai's `DOOR_BY_ACTION_TYPE` carries for exactly
    // one verb. Every other verb in this file takes its door from the
    // department (`DOOR_BY_DEPARTMENT`) — do not copy this line.
    door: "orders",
    paramsLine: orderParamsLine(action.payload as unknown as ChatOrderGatePayload),
  });
}

/** What `client.addDecision` accepts — the store owns queue position and status. */
type DecisionInput = Omit<
  DecisionRecord,
  "id" | "createdAt" | "queuePos" | "status" | "decidedBy" | "decidedAt" | "bundleRef" | "frozenByLock"
>;

/** The half of an `AuthorityDecision` the card is shaped from. */
type GateVerdict = Pick<AuthorityDecision, "verdict" | "riskClass">;

/**
 * Department → door, nova-ai `DOOR_BY_DEPARTMENT`. Only the five rows the
 * ported verbs can reach are pinned here; `marketing → campaigns` is inferred
 * from the door registry (`duties.ts DOORS`) rather than copied, and is marked
 * as such because no ported verb routes there today.
 */
const DOOR_BY_DEPARTMENT: Partial<Record<NovaDepartment, string>> = {
  sales: "coupons",
  support: "inbox",
  shipping: "courier",
  finance: "accounts",
  inventory: "products",
  marketing: "campaigns", // inferred — no ported verb lands here yet
};

function doorFor(department: NovaDepartment): string {
  return DOOR_BY_DEPARTMENT[department] ?? "inbox";
}

/**
 * Project a gated action into the Decision the founder answers.
 *
 * `kind` follows the VERDICT (a flagged refusal is an escalation, a draft is a
 * proposal); the door is the department's unless the verb earned an override;
 * the TTL is the risk class's. The impact label is the only field clipped —
 * a params line is a verb's own business (a cancellation's reason, for one, is
 * deliberately unabridged).
 */
function authorGateDecision(
  client: StoreClient,
  action: ActionRecord,
  authority: GateVerdict,
  shape: { tag: NovaDepartment; door: string; paramsLine: string },
): DecisionInput {
  const isEscalation = authority.verdict === "refuse";
  const impact = action.receipt?.expectedImpact?.trim() ?? "";
  const ttl = TTL_HOURS[authority.riskClass] ?? 72;
  return {
    tag: shape.tag,
    kind: isEscalation ? "escalation" : "proposal",
    impactLabel: impact ? (impact.length > 90 ? `${impact.slice(0, 87)}…` : impact) : "Impact not quantified",
    title: action.title,
    paramsLine: shape.paramsLine,
    why: action.receipt?.reason ?? "No reason recorded",
    actionId: action.id,
    priority: isEscalation || authority.riskClass === "high" ? 1 : 5,
    surfacedIn: ["desk", `room:${shape.tag}`, `door:${shape.door}`],
    expiresAt: new Date(Date.parse(client.now()) + ttl * 3600 * 1000).toISOString(),
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
 * The remaining customer-lane write verbs
 *
 * Five more verbs, each a lane-appropriate port of its nova-ai tool +
 * executor pair, and each built on exactly the shape `performCreateOrder`
 * established above: dedupe on the action key → `evaluateAuthority` → execute /
 * prepare-with-a-Decision / block-with-an-escalation, every row receipted with
 * `authority_gate` evidence naming the rule that decided it.
 *
 * ── What is DELIBERATELY absent, so nobody adds it back by reflex ──────────
 *
 *  - `defineTool` / `inputSchema` / `ctx`. nova-ai's customer plane is a
 *    tool-calling agent; this lane is a deterministic pipeline (classify →
 *    hydrate → NBA → gate → writer). There is no tool for the model to choose,
 *    so every rule that lived in a tool DESCRIPTION ("decline first", "reach
 *    for free delivery", "say the admin is confirming it") has to be a
 *    precondition in `nba.ts`/`turn.ts` or a writer instruction — never a
 *    comment claiming the model was told something.
 *  - `scopedConversationId(ctx, …)`. nova-ai pins the thread off an eve
 *    customer-session principal so a crafted `conversationId` cannot reach
 *    another buyer's parcel or coupon. That seam was NOT ported (see
 *    `src/store/inboxIntents.ts`), and faking it with a no-op would read as a
 *    guard being present. The equivalent guarantee here is structural:
 *    `conversationId` MUST be `ctx.convId` — supplied by the HMAC-verified
 *    ingress as an argument of `runCustomerTurn(storeId, convId, …)` — and an
 *    `orderId` MUST come from this conversation's own state, never from
 *    customer free text and never from model output.
 *  - `ExecutionContext.approvedActionId`. Nothing in this repo approves an
 *    action (the founder approves inside dakio-api), so the direct path keys
 *    every write on the deterministic `nm:<conv>:<verb>-<n>` id and says so
 *    rather than modelling an approve lane that does not exist.
 *  - An undo registry. There is no `undoers` map and no `performUndo` here;
 *    `undoData` is filed as a WIRE payload for dakio-api's kind-keyed `UNDO`
 *    map, and `undoDeadline` is left null for the backend to stamp.
 * ═════════════════════════════════════════════════════════════════════════ */

/** Same shape for every verb: the turn authors the E-8 receipt, not a model. */
export type GateReceiptInput = OrderReceiptInput;

/** What a gated verb answers with once the gate has settled it. */
export type SettledGateOutcome =
  | { status: "executed"; actionId: string; detail: string; replayed: true; record: ActionRecord }
  | { status: "prepared"; actionId: string; detail: string; rule: string; replayed: boolean }
  | { status: "blocked"; actionId: string; detail: string; rule: string };

interface GateSpec {
  verb: ActionRecord["type"];
  department: NovaDepartment;
  dutyRef: string;
  /** Decision-card door, WITHOUT the `door:` prefix. */
  door: string;
  /** Founder-facing row + card title. Phones are masked before it is stored. */
  title: string;
  /** The card's scannable line. Masked for the same reason. */
  paramsLine: string;
  payload: Record<string, unknown>;
  receipt: GateReceiptInput;
  /** FD-3 wording for the prepared tier — the honest thing to tell a customer. */
  preparedDetail: string;
}

type GateStep =
  | { proceed: false; outcome: SettledGateOutcome }
  | { proceed: true; authority: AuthorityDecision; gateEvidence: ReceiptEvidence; title: string; paramsLine: string };

/**
 * Dedupe, judge, and file everything that is NOT an execution.
 *
 * The two non-executing branches are byte-for-byte the same argument for every
 * verb — a refusal is a receipted event whose evidence is the rule that fired;
 * a draft is the payload dakio-api's approve executor will read field by field
 * — so they live here once instead of in five drifting copies. Each verb keeps
 * what is genuinely its own: the title rule, the params line, the door, the
 * duty, the department, and the whole execute path.
 *
 * The 2026-08-10 lesson is honoured on every branch: prepared and blocked rows
 * name their rule as `authority_gate` evidence, because 102 prepared rows that
 * did not cost a production diagnosis hours.
 */
async function gateOrFile(client: StoreClient, spec: GateSpec): Promise<GateStep> {
  const key = String(spec.payload.novaActionId ?? "");
  if (!key) throw new Error(`${spec.verb}: payload.novaActionId is required — it is the at-most-once key`);

  // At-most-once. Blocked rows deliberately do NOT dedupe (see `findByKey`).
  const existing = await findByKey(client, spec.verb, key);
  if (existing) {
    if (existing.status === "executed") {
      return {
        proceed: false,
        outcome: {
          status: "executed",
          actionId: existing.id,
          detail: existing.outcome ?? "This was already done for this conversation.",
          replayed: true,
          record: existing,
        },
      };
    }
    return {
      proceed: false,
      outcome: {
        status: "prepared",
        actionId: existing.id,
        detail: spec.preparedDetail,
        rule: gateRuleOf(existing) ?? "replay",
        replayed: true,
      },
    };
  }

  const authority = await evaluateAuthority(client, {
    type: spec.verb,
    payload: spec.payload,
    dutyKey: spec.dutyRef,
    origin: "chat",
  });

  // The title and the params line outlive the card and are re-rendered in logs
  // nobody re-audits. In nova-ai these strings are model-authored inside a tool
  // whose payload structurally cannot hold a phone; here the turn composes them
  // from state, so the masker runs once, in the one place every verb passes
  // through. It is a floor, not a licence to put PII in a title.
  const title = maskPhonesIn(spec.title);
  const paramsLine = maskPhonesIn(spec.paramsLine);
  const gateEvidence: ReceiptEvidence = {
    source: "authority_gate",
    note: authority.explanation,
    metric: "rule",
    value: authority.rule,
  };

  if (authority.verdict === "refuse") {
    const record = await client.addAction({
      type: spec.verb,
      department: spec.department,
      title,
      payload: spec.payload,
      justification: justificationOf(spec.receipt),
      receipt: buildReceipt(spec.receipt, null, null, [gateEvidence]),
      riskClass: authority.riskClass,
      status: "blocked",
      outcome: authority.explanation,
      undoable: false,
      undoData: null,
      actor: "nova",
      targetRef: null,
      agentId: null,
      dutyRef: spec.dutyRef,
      undoDeadline: null,
      undoneAt: null,
      decidedAt: client.now(),
      executedAt: null,
    });
    // Only escalation-flagged refusals become desk cards; an ordinary guardrail
    // trim files its row and stops, or the desk fills with noise.
    if (authority.escalation) {
      await client
        .addDecision(authorGateDecision(client, record, authority, { tag: spec.department, door: spec.door, paramsLine }))
        .catch(() => {});
    }
    return {
      proceed: false,
      outcome: { status: "blocked", actionId: record.id, detail: authority.explanation, rule: authority.rule },
    };
  }

  if (authority.verdict === "draft" || authority.verdict === "suggest") {
    const record = await client.addAction({
      type: spec.verb,
      department: spec.department,
      title,
      payload: spec.payload,
      justification: justificationOf(spec.receipt),
      receipt: buildReceipt(spec.receipt, null, null, [gateEvidence]),
      riskClass: authority.riskClass,
      status: "prepared",
      outcome: authority.verdict === "suggest" ? "suggestion" : null,
      undoable: false,
      undoData: null,
      actor: "nova",
      targetRef: null,
      agentId: null,
      dutyRef: spec.dutyRef,
      undoDeadline: null,
      undoneAt: null,
      decidedAt: null,
      executedAt: null,
    });
    // Best-effort: a desk-card failure must not lose the work already done.
    await client
      .addDecision(authorGateDecision(client, record, authority, { tag: spec.department, door: spec.door, paramsLine }))
      .catch(() => {});
    return {
      proceed: false,
      outcome: {
        status: "prepared",
        actionId: record.id,
        detail: spec.preparedDetail,
        rule: authority.rule,
        replayed: false,
      },
    };
  }

  return { proceed: true, authority, gateEvidence, title, paramsLine };
}

/** Read a field back off a replayed executed row's `receipt.after`. */
function afterOf(record: ActionRecord): Record<string, unknown> {
  return (record.receipt?.after ?? {}) as Record<string, unknown>;
}

/* ── 1. offer_chat_discount ────────────────────────────────────────────────
 *
 * The ONLY way Nova may sell below list, and it is a Coupon row — never a
 * reprice. Repricing to close one haggle silently discounts every other buyer
 * that day and no receipt anywhere records that it was meant for one person,
 * so nothing on this path may reach a price-writing method.
 *
 * Shipping default: `inbox.discountAuto` ships FALSE in dakio-api's
 * `PLATFORM_DEFAULTS`, so every offer is a Decision the founder approves. On a
 * default nova-mastra store the observable behaviour is the same but the RULE
 * STRING differs, and that is worth knowing before reading a receipt:
 * `DEFAULT_GUARDRAILS` carries no `inbox.*` key at all, so a percent offer
 * comes back `guardrail:inbox_discount_no_ceiling` (there is no ceiling to
 * check it against) rather than `guardrail:inbox_discount_auto_off`. Tests set
 * the platform keys explicitly, exactly as the order suite does.
 *
 * Not in FOUNDER_ONLY, NEVER_GATED or ALWAYS_DRAFT, and it must stay out of all
 * three: its holding force is the guardrail branch plus the shipped-false flag.
 */

const DISCOUNT_VERB = "offer_chat_discount" as const;
const DISCOUNT_DEPARTMENT = "sales" as const;
const DISCOUNT_DUTY_REF = "sales.inbox_discounts" as const;

export type ChatDiscountMechanism = "percent" | "fixed" | "free_delivery";

/**
 * Byte-compatible with nova-ai's `offerChatDiscountPayload`, plus this lane's
 * `novaActionId` rider.
 *
 * NOTE WHAT IS NOT HERE. There is no `code`: a model-chosen code is a
 * model-chosen collision with the founder's own campaign coupons, and
 * `@@unique([tenantId, code])` is case-SENSITIVE in Postgres — the code is
 * minted at execution and never named by the turn. No `maxUses`/`expiresAt`/
 * `active` either (the executor fixes `maxUses: 1` and computes `expiresAt`),
 * no amount on `free_delivery` (the server resolves the shop's own delivery
 * charge), and no phone, name or address — which is what lets the title rule
 * below be a rule rather than a hope.
 */
export interface ChatDiscountGatePayload {
  novaActionId: string;
  /** MUST be `ctx.convId` from the signed ingress — never a model-emitted id. */
  conversationId: string;
  /**
   * From the 360 block when the thread is linked. It is the ONLY thing the
   * once-per-N-days frequency guard can match on besides the conversation, and
   * omitting both means the guard silently never fires for this customer.
   */
  customerId?: string;
  /** `free_delivery` first: it is the BD shopkeeper's move and costs the least margin. */
  mechanism: ChatDiscountMechanism;
  /** Whole percent, required for `percent`. The ceiling is server-enforced. */
  percentOff?: number;
  /** WHOLE TAKA, required for `fixed`. 100 = ৳100. There is no ×100 on this path. */
  amount?: number;
  /** 1–168. A coupon with no deadline is a permanent discount. */
  expiresHours: number;
  /** Nova's own sentence about this negotiation — the founder reads it on the card. */
  reason: string;
}

export type DiscountGateOutcome =
  | {
      status: "executed";
      actionId: string;
      detail: string;
      /** The minted code — the ONLY tier on which a code may be said out loud. */
      code: string | null;
      discountId: string | null;
      expiresHours: number;
      replayed: boolean;
    }
  | { status: "prepared"; actionId: string; detail: string; rule: string; replayed: boolean }
  | { status: "blocked"; actionId: string; detail: string; rule: string };

/**
 * nova-ai's alphabet (`executors.ts`), not dakio-api's.
 *
 * The two repos already differ — dakio-api's approve path drops `S` and keeps
 * `L`; this one drops `0/O/1/I/L` because the customer reads the code off a
 * Messenger bubble and types it into a storefront checkout. Picking nova-ai's
 * for the agent-side path keeps the DIRECT tier byte-identical to the one it is
 * a port of, and the divergence is recorded here rather than resolved by
 * inventing a third alphabet.
 */
const CHAT_DISCOUNT_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_MINT_ATTEMPTS = 3;

function mintChatDiscountCode(): string {
  let code = "NOVA";
  for (let i = 0; i < 6; i += 1) {
    code += CHAT_DISCOUNT_ALPHABET[Math.floor(Math.random() * CHAT_DISCOUNT_ALPHABET.length)];
  }
  return code;
}

/**
 * A minted-code collision is retried; a guardrail refusal is NEVER retried.
 *
 * dakio-api draws the line by HTTP shape — a thrown 409 is the P2002 collision,
 * a RETURNED `{status:409, code:'guardrail:…'}` is the ceiling or the frequency
 * window. This repo's client has no `refusalOn` list for discounts, so both
 * arrive as thrown errors and the line has to be drawn on the message. Erring
 * toward NOT retrying is the safe side: retrying a frequency refusal with a
 * fresh code would be this function defeating the guard it exists to honour.
 */
function isCodeCollision(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (/guardrail/i.test(message)) return false;
  return /already exists/i.test(message) || /P2002/i.test(message) || /unique constraint/i.test(message);
}

/**
 * The three `.refine()` guards from nova-ai's zod payload, re-asserted as
 * runtime throws.
 *
 * They live in zod there because "an unsatisfiable payload is a validation
 * error the model can fix on the same turn, while a missing amount discovered
 * server-side is a failed action the customer waits through". This lane composes
 * the payload deterministically and has no zod seam, so the checks have to be
 * here — particularly the third, whose whole purpose is that no surface can
 * quote a delivery figure it guessed.
 */
export function assertChatDiscountPayload(p: ChatDiscountGatePayload): void {
  if (!p.conversationId) throw new Error("offer_chat_discount: conversationId is required");
  if (!p.reason || p.reason.trim().length < 5) throw new Error("offer_chat_discount: reason must be at least 5 characters");
  if (!Number.isInteger(p.expiresHours) || p.expiresHours < 1 || p.expiresHours > 168) {
    throw new Error("offer_chat_discount: expiresHours must be a whole number of hours between 1 and 168");
  }
  if (p.mechanism === "percent") {
    if (p.percentOff == null) throw new Error("mechanism 'percent' requires percentOff");
    if (!Number.isInteger(p.percentOff) || p.percentOff < 1 || p.percentOff > 100) {
      throw new Error("offer_chat_discount: percentOff must be a whole percent between 1 and 100");
    }
  } else if (p.mechanism === "fixed") {
    if (p.amount == null) throw new Error("mechanism 'fixed' requires amount (whole taka)");
    if (!(p.amount > 0)) throw new Error("offer_chat_discount: amount must be a positive number of taka");
  } else if (p.mechanism === "free_delivery") {
    if (p.percentOff != null || p.amount != null) {
      throw new Error("mechanism 'free_delivery' takes no amount — the server resolves the district's shipping charge");
    }
  } else {
    throw new Error(`offer_chat_discount: unknown mechanism ${String(p.mechanism)}`);
  }
}

/**
 * WHAT is being given — the half a founder weighs first.
 *
 * `free_delivery` renders WITHOUT a number here and WITH one on the executed
 * outcome line. That split is the rule, not an inconsistency: the title must
 * never carry a figure the turn could have guessed, and by outcome time the
 * server has resolved the shop's own delivery charge.
 */
export function discountOffer(p: ChatDiscountGatePayload): string {
  if (p.mechanism === "percent") return `${p.percentOff}% off`;
  if (p.mechanism === "fixed") return `৳${p.amount} off`;
  return "free delivery";
}

/** `Chat discount: <offer> — <reason>`: WHAT is being given and WHY, in that order. */
export function discountTitle(p: ChatDiscountGatePayload): string {
  return `Chat discount: ${discountOffer(p)} — ${p.reason}`;
}

/**
 * The card's params line. `reason` is LAST and UNABRIDGED: the ceiling and the
 * frequency window are already enforced server-side, so the only thing left for
 * a human to judge is whether this customer had earned it.
 */
export function discountParamsLine(p: ChatDiscountGatePayload): string {
  return [discountOffer(p), `expires in ${p.expiresHours}h`, p.reason].join(" · ");
}

/** FD-3 for a discount: being confirmed, never already theirs, and no code. */
function discountPreparedDetail(): string {
  return (
    "The offer is with the shop to confirm — the owner signs off on every discount given in chat. " +
    "There is no code yet; it is issued when they confirm."
  );
}

export async function performOfferDiscount(
  storeId: string,
  request: { payload: ChatDiscountGatePayload; receipt: GateReceiptInput },
): Promise<DiscountGateOutcome> {
  const client = storeFor(storeId);
  const { payload, receipt } = request;
  // Before ANY ledger row: an unsatisfiable payload is a validation error, not
  // a card the founder taps into an error hours later.
  assertChatDiscountPayload(payload);

  const step = await gateOrFile(client, {
    verb: DISCOUNT_VERB,
    department: DISCOUNT_DEPARTMENT,
    dutyRef: DISCOUNT_DUTY_REF,
    // NOT `door:orders` — `offer_chat_discount` is deliberately absent from
    // nova-ai's per-verb door override map: a coupon in the Coupons door is
    // where it belongs.
    door: doorFor(DISCOUNT_DEPARTMENT),
    title: discountTitle(payload),
    paramsLine: discountParamsLine(payload),
    payload: payload as unknown as Record<string, unknown>,
    receipt,
    preparedDetail: discountPreparedDetail(),
  });

  if (!step.proceed) {
    const o = step.outcome;
    if (o.status === "executed") {
      const after = afterOf(o.record);
      return {
        status: "executed",
        actionId: o.actionId,
        detail: o.detail,
        code: typeof after.code === "string" ? after.code : null,
        discountId: String((o.record.undoData as Record<string, unknown> | null)?.couponId ?? "") || null,
        expiresHours: payload.expiresHours,
        replayed: true,
      };
    }
    return o;
  }

  // ── Auto tier ────────────────────────────────────────────────────────────
  // EXPIRY IS COUNTED FROM EXECUTION, never from draft time — which is why the
  // prepared row stores `expiresHours` and not a materialized `expiresAt`. A
  // card that sat on the desk overnight would otherwise mint a coupon that is
  // already expired, and the customer would be sent a code that fails at
  // checkout with no explanation anyone could give them.
  const expiresAt = new Date(Date.parse(client.now()) + payload.expiresHours * 3600 * 1000).toISOString();

  let resolvedAmount: number | undefined;
  if (payload.mechanism === "free_delivery") {
    // A discount is offered mid-negotiation, BEFORE the address exists, so
    // there is no district to look up. Covering the LARGER of the two charges
    // means the promise holds wherever the customer turns out to live.
    //
    // DIVERGENCE, chosen on purpose: nova-ai's agent-side executor reads
    // `deliveryOutsideDhaka` alone; dakio-api's approve path takes
    // `Math.max(inside, outside)` because nothing stops a merchant setting them
    // the other way round. `Math.max` is used here so the direct tier and the
    // approve tier issue the SAME coupon for the same payload.
    const settings = await client.getStoreSettings();
    resolvedAmount = Math.max(settings.deliveryInsideDhaka ?? 0, settings.deliveryOutsideDhaka ?? 0);
    if (!(resolvedAmount > 0)) {
      throw new Error(
        "this store has no delivery charge configured, so 'free delivery' would be a coupon worth nothing — set a delivery charge in Settings first",
      );
    }
  } else if (payload.mechanism === "fixed") {
    // Straight through, WHOLE TAKA. Introducing a ×100 here would give away a
    // 100× discount.
    resolvedAmount = payload.amount;
  }

  // Mint-and-retry. The IDEMPOTENCY note that matters: this repo's
  // `DakioStoreClient.createDiscount` sends no `Idempotency-Key` (unlike
  // `createChatOrder`, which keys on `novaActionId`), so a retried auto-tier
  // discount could mint a SECOND coupon server-side. The chosen resolution is
  // the second one the analysis offers — the ledger dedupe in `gateOrFile`
  // strictly PRECEDES this write, so a redelivered turn never reaches here.
  // The one-line client fix (passing `idempotencyKey: payload.novaActionId`)
  // belongs in `src/store/dakio.ts` and is out of scope for this change.
  let discount: Awaited<ReturnType<StoreClient["createDiscount"]>> | null = null;
  let code = "";
  let lastError: unknown = null;
  for (let attempt = 0; attempt < CODE_MINT_ATTEMPTS; attempt += 1) {
    code = mintChatDiscountCode();
    try {
      discount = await client.createDiscount({
        code,
        type: payload.mechanism === "percent" ? "PERCENT" : "FIXED",
        ...(payload.mechanism === "percent" ? { percentOff: payload.percentOff } : { amount: resolvedAmount }),
        expiresAt,
        active: true,
        // NON-NEGOTIABLE, and it is how "issued to this customer" is expressed:
        // `Coupon` has NO customerId column, so a chat coupon any customer
        // could use is a public discount minted in a private negotiation.
        maxUses: 1,
        novaActionId: payload.novaActionId,
        ...(payload.customerId ? { customerId: payload.customerId } : {}),
        // The frequency guard's identity key when there is no linked customer.
        conversationId: payload.conversationId,
      });
      break;
    } catch (error) {
      lastError = error;
      if (!isCodeCollision(error)) throw error;
    }
  }
  if (!discount) {
    throw new Error(
      `offer_chat_discount: could not mint a free coupon code after ${CODE_MINT_ATTEMPTS} attempts (${
        lastError instanceof Error ? lastError.message : String(lastError)
      })`,
    );
  }

  const mechanismNote =
    payload.mechanism === "free_delivery" ? `free delivery (৳${resolvedAmount} off)` : discountOffer(payload);
  const outcome = `Issued coupon ${discount.code} — ${mechanismNote}, one use, expires in ${payload.expiresHours}h. ${payload.reason}`;

  const record = await client.addAction({
    type: DISCOUNT_VERB,
    department: DISCOUNT_DEPARTMENT,
    title: step.title,
    payload: payload as unknown as Record<string, unknown>,
    justification: justificationOf(receipt),
    receipt: buildReceipt(
      receipt,
      null,
      {
        code: discount.code,
        mechanism: payload.mechanism,
        percentOff: payload.percentOff ?? null,
        amount: resolvedAmount ?? null,
        expiresAt,
        maxUses: 1,
      },
      [step.gateEvidence],
    ),
    riskClass: step.authority.riskClass,
    status: "executed",
    outcome,
    undoable: true,
    // WIRE CONTRACT: `couponId`, NOT this repo's usual `discountId`.
    // dakio-api's `UNDO.deactivate_chat_discount` destructures `{ couponId }`
    // and throws on anything else — the wrong field name has already shipped
    // twice. The inverse DEACTIVATES and never deletes: if the code was already
    // redeemed the discount happened, and erasing the row would erase the
    // receipt explaining a sale short by exactly that amount.
    undoData: { kind: "deactivate_chat_discount", couponId: discount.id, code: discount.code },
    actor: "nova",
    targetRef: `coupon:${discount.id}`,
    agentId: null,
    dutyRef: DISCOUNT_DUTY_REF,
    undoDeadline: null,
    undoneAt: null,
    decidedAt: client.now(),
    executedAt: client.now(),
  });

  await client.attributeDoorRecord(`coupon:${discount.id}`, record.id).catch(() => {});
  await client
    .addActivity({
      department: DISCOUNT_DEPARTMENT,
      kind: "action",
      title: step.title,
      detail: outcome,
      minutesSaved: 10,
      // A coupon sells nothing by existing. The order it may help close claims
      // its own revenue through `create_order_from_chat`; crediting both would
      // count one sale twice.
      revenueInfluence: 0,
      actionId: record.id,
      relatedId: payload.conversationId,
      revenueBasis: "estimated",
    })
    .catch(() => {});

  return {
    status: "executed",
    actionId: record.id,
    detail: outcome,
    code: discount.code,
    discountId: discount.id,
    expiresHours: payload.expiresHours,
    replayed: false,
  };
}

/* ── 2. cancel_order_from_chat ─────────────────────────────────────────────
 *
 * Unwinding a sale is the same room's work as making one, which is why the
 * department is `sales` and the duty is the ORDER duty: a founder who paused
 * chat orders would rightly expect chat cancellations to be paused with them.
 *
 * Shipping default: `inbox.cancelAuto` is absent from `DEFAULT_GUARDRAILS` and
 * from the demo seed, so `guardrails["inbox.cancelAuto"] !== true` holds and
 * every cancel is PREPARED with rule `guardrail:inbox_cancel_auto_off` while
 * the order status stays exactly as it was.
 *
 * NO STOCK MOVES, in either direction. dakio-api's cancel executor returns
 * nothing to inventory and `UNDO.uncancel_chat_order` deliberately does not
 * re-decrement — adding a "give the stock back" convenience here would make the
 * undo remove units the cancel never returned.
 *
 * TERMINAL-STATE REFUSAL BELONGS TO THE SERVER. dakio-api claims the row
 * conditionally over PENDING/APPROVED/PROCESSING and refuses anything else
 * ("Handle it from the Orders door"); this function does not pre-judge
 * cancellability, it lets the refusal propagate so the customer is told.
 */

const CANCEL_VERB = "cancel_order_from_chat" as const;
const CANCEL_DEPARTMENT = "sales" as const;
const CANCEL_DUTY_REF = "sales.inbox_orders" as const;

/**
 * Three fields and the rider — and the smallness is the safety argument.
 *
 * There is no customer name/phone/city/address, no orderNumber, no refund or
 * amount or `paid` field, no courier or tracking field, and no status (the
 * executor decides the target status). The payload is structurally incapable of
 * carrying PII or a money lever; the only free text is `reason`.
 */
export interface CancelOrderGatePayload {
  novaActionId: string;
  /**
   * The dakio Order id (cuid), resolved from THIS conversation's own state.
   * Never parsed out of customer free text ("cancel order 1234") — dakio-api
   * scopes the lookup by tenant alone, so a cancellation scoped to another
   * thread would destroy a stranger's order on the word of someone who never
   * placed it.
   */
  orderId: string;
  /** MUST be `ctx.convId` from the signed ingress. */
  conversationId: string;
  /** Why they want it cancelled, in their words. The only record of why a sale went away. */
  reason: string;
}

export type CancelGateOutcome =
  | {
      status: "executed";
      actionId: string;
      detail: string;
      orderId: string;
      previousStatus: OrderStatus | null;
      replayed: boolean;
    }
  | { status: "prepared"; actionId: string; detail: string; rule: string; replayed: boolean }
  | { status: "blocked"; actionId: string; detail: string; rule: string };

/**
 * The customer's reason, verbatim, IS the title — the opposite shape from the
 * order verb's WHAT + WHERE, and deliberately so: the reason is the only record
 * of why a sale went away and the owner reads it.
 *
 * Never enriched. Do NOT join the order or the conversation to decorate this
 * with a customer name, a phone, an address or the COD amount; the payload
 * carries none of them and the title outlives the card.
 */
export function cancelTitle(p: CancelOrderGatePayload): string {
  return `Cancel an order — ${p.reason}`;
}

/** The reason, unabridged, and nothing else. Not truncated, not paraphrased. */
export function cancelParamsLine(p: CancelOrderGatePayload): string {
  return p.reason;
}

/**
 * The delicate prepared line: the order is STILL LIVE and may still ship, so
 * this must not say "cancelled" and must not imply the parcel is stopped. The
 * inverse of FD-3's order wording, in the same register — normal flow, never an
 * apology, and never an invented cancellation reference.
 */
function cancelPreparedDetail(): string {
  return (
    "The cancellation request is with the shop and they will confirm it — nothing has shipped on it in the meantime. " +
    "The order is not cancelled yet."
  );
}

export async function performCancelOrder(
  storeId: string,
  request: { payload: CancelOrderGatePayload; receipt: GateReceiptInput },
): Promise<CancelGateOutcome> {
  const client = storeFor(storeId);
  const { payload, receipt } = request;
  if (!payload.orderId) throw new Error("cancel_order_from_chat: orderId is required");
  if (!payload.conversationId) throw new Error("cancel_order_from_chat: conversationId is required");
  if (!payload.reason || payload.reason.trim().length < 5) {
    throw new Error("cancel_order_from_chat: reason must be at least 5 characters — it is the only record of why a sale went away");
  }

  const step = await gateOrFile(client, {
    verb: CANCEL_VERB,
    department: CANCEL_DEPARTMENT,
    dutyRef: CANCEL_DUTY_REF,
    // DEVIATION FROM nova-ai, recorded rather than silent: its
    // `DOOR_BY_ACTION_TYPE` has only `create_order_from_chat`, so a cancel would
    // fall through to `DOOR_BY_DEPARTMENT.sales` = Coupons. A cancellation card
    // under Coupons is the exact mismatch the order override was created to fix
    // (the founder goes to Orders, finds nothing, the card ages out).
    door: "orders",
    title: cancelTitle(payload),
    paramsLine: cancelParamsLine(payload),
    payload: payload as unknown as Record<string, unknown>,
    receipt,
    preparedDetail: cancelPreparedDetail(),
  });

  if (!step.proceed) {
    const o = step.outcome;
    if (o.status === "executed") {
      const after = afterOf(o.record);
      const before = (o.record.receipt?.before ?? {}) as Record<string, unknown>;
      return {
        status: "executed",
        actionId: o.actionId,
        detail: o.detail,
        orderId: typeof after.orderId === "string" ? after.orderId : payload.orderId,
        previousStatus: (typeof before.status === "string" ? before.status : null) as OrderStatus | null,
        replayed: true,
      };
    }
    return o;
  }

  // ── Auto tier ────────────────────────────────────────────────────────────
  // The before-snapshot is what `undoData.previousStatus` restores. This is the
  // FOUNDER-plane read used inside the customer lane, and it is named as such:
  // the customer-plane `getOrderStatus` returns a humanized `displayStatus`
  // string, not an `OrderStatus`, so feeding it into `previousStatus` would
  // write a value `updateOrder` cannot restore.
  const before = await client.getOrder(payload.orderId);
  const previousStatus: OrderStatus = before?.status ?? "placed";

  await client.updateOrderDelivery(payload.orderId, { status: "cancelled" });

  const outcome =
    `Cancelled order ${payload.orderId} at the customer's request: "${payload.reason}". ` +
    "If it was already booked with the courier, cancel the parcel with them too — Dakio has not.";

  const record = await client.addAction({
    type: CANCEL_VERB,
    department: CANCEL_DEPARTMENT,
    title: step.title,
    payload: payload as unknown as Record<string, unknown>,
    justification: justificationOf(receipt),
    receipt: buildReceipt(
      receipt,
      { status: previousStatus },
      { orderId: payload.orderId, status: "cancelled", reason: payload.reason },
      [step.gateEvidence],
    ),
    riskClass: step.authority.riskClass,
    status: "executed",
    outcome,
    undoable: true,
    // `uncancel_chat_order` is the literal string dakio-api's kind-keyed UNDO
    // map dispatches on; a wrong slug reaches a founder as "No inverse is
    // defined for undefined", which has shipped twice. `orderId` is
    // unconditional — it is the one field that UNDO reads.
    undoData: { kind: "uncancel_chat_order", orderId: payload.orderId, previousStatus },
    actor: "nova",
    targetRef: `order:${payload.orderId}`,
    agentId: null,
    dutyRef: CANCEL_DUTY_REF,
    undoDeadline: null,
    undoneAt: null,
    decidedAt: client.now(),
    executedAt: client.now(),
  });

  await client.attributeDoorRecord(`order:${payload.orderId}`, record.id).catch(() => {});
  await client
    .addActivity({
      // KNOWN, DELIBERATE ASYMMETRY, left as found: the ledger row's department
      // is `sales`, while dakio-api's approve path files its ACTIVITY under
      // `support`. The direct path writes the action's own department, so
      // `sales` here keeps symmetry with `performCreateOrder` — the divergence
      // is recorded rather than silently aligned.
      department: CANCEL_DEPARTMENT,
      kind: "action",
      title: step.title,
      detail: outcome,
      minutesSaved: 6,
      // A cancellation influences no revenue. Do NOT record the lost order
      // total as negative revenue.
      revenueInfluence: 0,
      actionId: record.id,
      relatedId: payload.conversationId,
    })
    .catch(() => {});

  return {
    status: "executed",
    actionId: record.id,
    detail: outcome,
    orderId: payload.orderId,
    previousStatus,
    replayed: false,
  };
}

/* ── 3. update_order_contact ───────────────────────────────────────────────
 *
 * Fix where a parcel is going — pre-dispatch only.
 *
 * Shipping default: `inbox.addressEditAuto` is absent, so the arm returns
 * `needs_approval` with rule `guardrail:inbox_address_edit_auto_off` and every
 * correction waits for a founder tap. That arm was FIRST WRITTEN as an
 * unconditional `allow` on the reasoning that the server already refuses
 * post-dispatch; the empty-platform eval caught it and was right. The address
 * is where a COD parcel worth real money goes, and "whoever is typing in this
 * thread" is not the same claim as "the person who placed the order". A
 * redirect is a fraud shape, not only a typo fix. The honest cost is stated
 * rather than hidden: a typo'd address waits for a tap.
 *
 * NO PRICE FIELD, ANYWHERE. Changing the district re-prices the order and the
 * SERVER recomputes it; nothing on this path may carry or quote a total.
 *
 * PRE-DISPATCH IS THE SERVER'S FENCE, not a local predicate: `patchStoreOrder`
 * answers 409 and the client maps it to `InboxSendRefused`. Reading
 * `getOrderStatus().courierSentAt` first to CHOOSE the case route instead of
 * the edit route is fine; treating that read as the authority is not.
 */

const CONTACT_VERB = "update_order_contact" as const;
const CONTACT_DEPARTMENT = "shipping" as const;
const CONTACT_DUTY_REF = "shipping.delivery_cases" as const;

/** The four editable fields, in the order every surface renders them. */
export const CONTACT_FIELDS = ["address", "city", "district", "phone"] as const;
export type ContactField = (typeof CONTACT_FIELDS)[number];

export interface UpdateContactGatePayload {
  novaActionId: string;
  /** The dakio Order id (cuid) — dakio-api PATCHes `params:{id}`, not an order number. */
  orderId: string;
  /** MUST be `ctx.convId` from the signed ingress. */
  conversationId: string;
  /** The full new address as they typed it. */
  address?: string;
  city?: string;
  /** The district decides the delivery charge, so changing it re-prices the order. */
  district?: string;
  /** A corrected contact number. */
  phone?: string;
}

export type ContactGateOutcome =
  | { status: "executed"; actionId: string; detail: string; changed: ContactField[]; replayed: boolean }
  | { status: "prepared"; actionId: string; detail: string; rule: string; replayed: boolean }
  | { status: "blocked"; actionId: string; detail: string; rule: string };

/**
 * nova-ai's `atLeastOneContactField`, authored ONCE.
 *
 * It exists as a shared predicate there precisely so the tool boundary and the
 * executor cannot disagree, and dakio-api enforces the same rule independently
 * ("nothing to change"). One export, called at the gate entrypoint, before any
 * ledger row is filed — a prepared card the approve path will refuse is a
 * founder tap that ends in an error.
 */
export function changedContactFields(p: UpdateContactGatePayload): ContactField[] {
  // `!== undefined`, not truthiness — the same test both executors make.
  return CONTACT_FIELDS.filter((f) => p[f] !== undefined);
}

/**
 * WHAT MOVED, never the new value.
 *
 * Note the asymmetry with the order verb, which names the destination city and
 * district: that is a NEW order with no address on file yet, while here the
 * destination IS the sensitive change. The founder opens the card to read the
 * address; a one-line summary carrying a customer's home address travels into
 * logs and lists nobody re-audits.
 */
export function contactTitle(p: UpdateContactGatePayload): string {
  return `Change ${changedContactFields(p).join(" + ")} on an order`;
}

/** `address + district · re-prices delivery` — the one consequence not obvious from "address". */
export function contactParamsLine(p: UpdateContactGatePayload): string {
  const parts: string[] = [];
  const moved = changedContactFields(p);
  if (moved.length) parts.push(moved.join(" + "));
  if (p.district) parts.push("re-prices delivery");
  return parts.join(" · ");
}

/** Never "I've changed it" for a change that has not happened, and never a total. */
function contactPreparedDetail(): string {
  return (
    "The corrected delivery details are with the shop to confirm before the parcel goes out. " +
    "They will confirm the change — and the amount due at the door, if the area changed."
  );
}

export async function performUpdateContact(
  storeId: string,
  request: { payload: UpdateContactGatePayload; receipt: GateReceiptInput },
): Promise<ContactGateOutcome> {
  const client = storeFor(storeId);
  const { payload, receipt } = request;
  if (!payload.orderId) throw new Error("update_order_contact: orderId is required");
  if (!payload.conversationId) throw new Error("update_order_contact: conversationId is required");
  const changed = changedContactFields(payload);
  if (changed.length === 0) {
    throw new Error("Give at least one field to change — an update that changes nothing is not an update.");
  }

  const step = await gateOrFile(client, {
    verb: CONTACT_VERB,
    department: CONTACT_DEPARTMENT,
    dutyRef: CONTACT_DUTY_REF,
    // Parity with nova-ai: no per-verb override exists, so the door comes from
    // the department — `shipping → courier`. Do NOT copy the order path's
    // hardcoded `door:orders`; that string is an override the order verb earned
    // with its own rationale. If "courier" is the wrong home for an order edit
    // that is a product question to raise, not a value to invent here.
    door: doorFor(CONTACT_DEPARTMENT),
    title: contactTitle(payload),
    paramsLine: contactParamsLine(payload),
    payload: payload as unknown as Record<string, unknown>,
    receipt,
    preparedDetail: contactPreparedDetail(),
  });

  if (!step.proceed) {
    const o = step.outcome;
    if (o.status === "executed") {
      const after = afterOf(o.record);
      return {
        status: "executed",
        actionId: o.actionId,
        detail: o.detail,
        changed: Array.isArray(after.changed) ? (after.changed as ContactField[]) : changed,
        replayed: true,
      };
    }
    return o;
  }

  // ── Auto tier ────────────────────────────────────────────────────────────
  // Only the changed fields are forwarded; nothing else from the payload
  // reaches the order. `confirm` belongs to `confirm_order_intent` and `status`
  // only to the cancel path, so neither is sent here.
  await client.updateOrderDelivery(payload.orderId, {
    ...(payload.address !== undefined ? { address: payload.address } : {}),
    ...(payload.city !== undefined ? { city: payload.city } : {}),
    ...(payload.district !== undefined ? { district: payload.district } : {}),
    ...(payload.phone !== undefined ? { phone: payload.phone } : {}),
  });

  const outcome =
    `Updated ${changed.join(", ")} on the order before dispatch.` +
    (payload.district ? " The district changed, so the delivery charge and total were recalculated." : "") +
    " The confirmation was reset — re-confirm with the customer before it ships.";

  const record = await client.addAction({
    type: CONTACT_VERB,
    department: CONTACT_DEPARTMENT,
    title: step.title,
    payload: payload as unknown as Record<string, unknown>,
    justification: justificationOf(receipt),
    // `before` is null even on the executed tier — parity with nova-ai, which
    // deliberately takes no snapshot for this verb.
    receipt: buildReceipt(receipt, null, { orderId: payload.orderId, changed }, [step.gateEvidence]),
    riskClass: step.authority.riskClass,
    status: "executed",
    outcome,
    // NO INVERSE, on every tier. The previous address is in the case facts, and
    // "undo" would mean shipping to an address the customer has already told us
    // is wrong. Do not invent an undoData.kind slug: dakio-api's UNDO map has
    // no entry, and a wrong slug reaches a founder as "No inverse is defined
    // for undefined".
    undoable: false,
    undoData: null,
    actor: "nova",
    targetRef: `order:${payload.orderId}`,
    agentId: null,
    dutyRef: CONTACT_DUTY_REF,
    undoDeadline: null,
    undoneAt: null,
    decidedAt: client.now(),
    executedAt: client.now(),
  });

  await client.attributeDoorRecord(`order:${payload.orderId}`, record.id).catch(() => {});
  await client
    .addActivity({
      department: CONTACT_DEPARTMENT,
      kind: "action",
      title: step.title,
      detail: `Changed ${changed.join(", ")}.`,
      minutesSaved: 5,
      revenueInfluence: 0,
      actionId: record.id,
      relatedId: payload.conversationId,
    })
    .catch(() => {});

  return { status: "executed", actionId: record.id, detail: outcome, changed, replayed: false };
}

/* ── 4. open_case ──────────────────────────────────────────────────────────
 *
 * Book a problem so a room owns it. One row, no money, nothing a customer can
 * see — but still on the dial, because opening a case ENQUEUES department work
 * whose last step speaks to a customer.
 *
 * THERE IS NO GUARDRAIL FLAG FOR THIS VERB and none may be invented here.
 * `checkGuardrails` has no `open_case` arm, so it falls to `default: allow`,
 * and what actually gates it is the duty floor plus the dial:
 * `shipping.delivery_cases` minLevel 2, door Inbox, `assisted` mode ceiling 2 →
 * `verdictForLevel(2, "low") = draft`. So the SHIPPING DEFAULT IS DRAFT: on a
 * default store every case is prepared with rule `level:draft` and a founder
 * Decision. Auto-execute needs effective level 3+. If a future change wants a
 * creation gate it must land in BOTH `autonomy.ts` and dakio-api's
 * `PLATFORM_DEFAULTS` in the same commit, seeded in the REFUSING direction.
 *
 * OPENING TWICE IS NOT AN ERROR. `joined` is server truth — dakio-api mints the
 * case id before the upsert precisely because a pre-read races and a
 * createdAt/updatedAt compare collides inside one millisecond — and it is never
 * inferred client-side.
 */

const CASE_VERB = "open_case" as const;
/** Constant for EVERY kind, including the finance/support/inventory ones: one
 *  duty governs "may Nova book problems at all", the kind decides the room. */
const CASE_DUTY_REF = "shipping.delivery_cases" as const;

/**
 * The closed kind set. Byte-identical to dakio-api's `CASE_KINDS`.
 *
 * `wholesale_inquiry` is DELIBERATELY absent: v1 treats a wholesale ask as a
 * plain sales escalation, and a kind nothing can open reads as supported to the
 * next reader.
 */
export const CASE_KINDS = [
  "delivery_stuck",
  "failed_attempt",
  "payment_unverified",
  "damaged_item",
  "address_change_postdispatch",
  "restock_wait",
] as const;
export type CaseKind = (typeof CASE_KINDS)[number];

/**
 * kind → department, DERIVED and never caller-supplied. This mirror exists only
 * so the founder's Decision card lands on the same desk the case itself lands
 * on — a shipping case whose approval card sits in support is one the shipping
 * room never sees. The SERVER still decides the case's own department; this
 * copy never travels on the wire, and it must stay byte-identical to
 * dakio-api's `DEPARTMENT_BY_KIND`.
 */
export const DEPARTMENT_BY_CASE_KIND: Record<CaseKind, NovaDepartment> = {
  delivery_stuck: "shipping",
  failed_attempt: "shipping",
  address_change_postdispatch: "shipping",
  payment_unverified: "finance",
  damaged_item: "support",
  restock_wait: "inventory",
};

export interface OpenCaseGatePayload {
  novaActionId: string;
  /** Decides which room owns it — the turn does not choose the department. */
  kind: CaseKind;
  /** MUST be `ctx.convId` from the signed ingress. */
  conversationId: string;
  /** The dedupe lever: supply it whenever known so a second person asking about
   *  the SAME parcel JOINS this case instead of opening a duplicate. */
  orderId?: string;
  /** For `restock_wait`. */
  productId?: string;
  /** One line a founder reads on their desk. 5–160 chars. */
  title: string;
  /** What is known right now, including the customer's own words. 3–600 chars. */
  factsNote: string;
}

export type CaseGateOutcome =
  | {
      status: "executed";
      actionId: string;
      detail: string;
      caseId: string | null;
      /** Server truth. `true` means work was ALREADY under way — say "kaj cholche". */
      joined: boolean;
      department: NovaDepartment;
      replayed: boolean;
    }
  | { status: "prepared"; actionId: string; detail: string; rule: string; replayed: boolean }
  | { status: "blocked"; actionId: string; detail: string; rule: string };

/**
 * The founder's line. Composed from server-known facts only — never the
 * customer's verbatim text (that is what `factsNote` is for), never a name,
 * phone or street line, never the department (it is derived, and repeating it
 * invites a mismatch with the server's), and NEVER a date, ETA or "by
 * tomorrow": opening a case is not a promise about when it will be fixed.
 */
export function caseParamsLine(p: OpenCaseGatePayload): string {
  const kind = p.kind.replace(/_/g, " ");
  // The orderId is NOT repeated (the title carries it) and `factsNote` is NOT
  // rendered — it is a paragraph and this is a scannable line. The third branch
  // is a real signal, not filler: a subject-less case cannot be deduped.
  if (p.orderId) return `${kind} · on an order`;
  if (p.productId) return `${kind} · on a product`;
  return `${kind} · thread only — may duplicate`;
}

/** No case id, no `joined` state, no timeline — none of the three is known yet. */
function casePreparedDetail(): string {
  return "The problem is written down and the shop is picking it up from here.";
}

export async function performOpenCase(
  storeId: string,
  request: { payload: OpenCaseGatePayload; receipt: GateReceiptInput },
): Promise<CaseGateOutcome> {
  const client = storeFor(storeId);
  const { payload, receipt } = request;
  const department = DEPARTMENT_BY_CASE_KIND[payload.kind];
  if (!department) throw new Error(`open_case: unknown case kind ${String(payload.kind)}`);
  if (!payload.conversationId) throw new Error("open_case: conversationId is required");
  const title = payload.title?.trim() ?? "";
  if (title.length < 5 || title.length > 160) {
    throw new Error("open_case: title must be 5–160 characters — it is what the founder reads on the card");
  }
  const factsNote = payload.factsNote?.trim() ?? "";
  if (factsNote.length < 3 || factsNote.length > 600) {
    throw new Error("open_case: factsNote must be 3–600 characters — it is quoted back to whoever asks next");
  }

  const step = await gateOrFile(client, {
    verb: CASE_VERB,
    department,
    dutyRef: CASE_DUTY_REF,
    // Computed from the DERIVED department, not hardcoded: shipping → courier,
    // finance → accounts, support → inbox, inventory → products.
    door: doorFor(department),
    title: payload.title,
    paramsLine: caseParamsLine(payload),
    // The prepared row's payload IS the approve executor's input, read key by
    // key. File exactly kind/conversationId/orderId/productId/title/factsNote
    // (+ the harmless novaActionId rider): a renamed or nested key is a card
    // that 422s on approval, hours later, in front of a founder.
    payload: payload as unknown as Record<string, unknown>,
    receipt,
    preparedDetail: casePreparedDetail(),
  });

  if (!step.proceed) {
    const o = step.outcome;
    if (o.status === "executed") {
      const after = afterOf(o.record);
      return {
        status: "executed",
        actionId: o.actionId,
        detail: o.detail,
        caseId: typeof after.caseId === "string" ? after.caseId : null,
        joined: after.joined === true,
        department,
        replayed: true,
      };
    }
    return o;
  }

  // ── Auto tier ────────────────────────────────────────────────────────────
  // Note `DakioStoreClient.openCase` declares no `refusalOn`, so the server's
  // 404 ("That order is not on this store") and its 422s surface as PLAIN
  // thrown errors rather than `InboxSendRefused`. Neither is retryable and
  // neither may be reported to the customer as a case that WAS opened; the
  // decision to add `refusalOn: [404, 422]` belongs in `src/store/dakio.ts` and
  // is deliberately not made silently here.
  const { case: row, joined } = await client.openCase({
    kind: payload.kind,
    conversationId: payload.conversationId,
    ...(payload.orderId ? { orderId: payload.orderId } : {}),
    ...(payload.productId ? { productId: payload.productId } : {}),
    title: payload.title,
    factsNote: payload.factsNote,
    factsSource: "conversation",
    novaActionId: payload.novaActionId,
  });

  const asking = row.refs?.conversationIds?.length ?? 0;
  const outcome = joined
    ? `Joined the open case for this — ${row.title}. Nothing duplicated; the ${row.department} room already had it` +
      (asking > 1 ? `, with ${asking} conversations now asking about it, and they all get the same answer.` : ".")
    : `Opened a ${payload.kind.replace(/_/g, " ")} case with the ${row.department} room: ${row.title}.`;

  const record = await client.addAction({
    type: CASE_VERB,
    department,
    title: step.title,
    payload: payload as unknown as Record<string, unknown>,
    justification: justificationOf(receipt),
    receipt: buildReceipt(
      receipt,
      null,
      { caseId: row.id, kind: row.kind, department: row.department, status: row.status, joined },
      [step.gateEvidence],
    ),
    riskClass: step.authority.riskClass,
    status: "executed",
    outcome,
    // A case is CLOSED with a resolution sentence, never deleted. An undo that
    // erased the record of a problem is the one kind this system must not offer.
    undoable: false,
    undoData: null,
    actor: "nova",
    // `case:` is NOT in dakio-api's ATTRIBUTABLE map, so attribution no-ops.
    // The real receipt link is `NovaCase.openedByActionId`; nothing in the
    // outcome claims a by:nova stamp.
    targetRef: `case:${row.id}`,
    agentId: null,
    dutyRef: CASE_DUTY_REF,
    undoDeadline: null,
    undoneAt: null,
    decidedAt: client.now(),
    executedAt: client.now(),
  });

  await client.attributeDoorRecord(`case:${row.id}`, record.id).catch(() => {});
  await client
    .addActivity({
      department,
      // `kind: "action"` — this repo's ActivityEntry union is
      // action|analysis|communication|report|alert. dakio-api writes
      // `case_opened`, which is its own activity vocabulary, not this one's.
      kind: "action",
      title: joined ? `Joined an open case (${payload.kind})` : `Opened a case (${payload.kind})`,
      detail: row.title,
      minutesSaved: 3,
      revenueInfluence: 0,
      actionId: record.id,
      relatedId: row.id,
    })
    .catch(() => {});

  return {
    status: "executed",
    actionId: record.id,
    detail: outcome,
    caseId: row.id,
    joined,
    department,
    replayed: false,
  };
}

/* ── 5. escalate_conversation (the hand-over) ──────────────────────────────
 *
 * THE GATE IS SET MEMBERSHIP, NOT A FLAG. `escalate_conversation` is in
 * `NEVER_GATED`, and that check returns `{verdict:"execute",
 * rule:"never_gated:escalate_conversation"}` BEFORE the level ladder, before
 * the duty minLevel check and before the guardrail seam. SHIPPING DEFAULT:
 * always execute, at every tier including T0 Shadow and `manual` mode — asking
 * for a human has to work at the lowest autonomy setting, or the safest thing
 * Nova can do becomes the slowest. Escalation sends nothing the model authored
 * and hands authority AWAY.
 *
 * What still binds, because it is checked earlier: no-touch locks (a founder
 * lock on "REFUND" CAN block a handover whose summary mentions a refund — that
 * is nova-ai's accepted behaviour, not a bug to fix here), an unknown duty, a
 * paused duty, and the fail-closed `authority:unavailable`. `support.inbox_
 * escalations`' minLevel 2 is UNREACHABLE for this verb.
 *
 * ONE handover write path, ever. Two voices in one conversation is the failure
 * the ADVISORY carve-out exists to prevent, so this function is the only caller
 * of `client.handoverConversation` in the repo.
 *
 * NO LOCAL DECISION ON THE EXECUTE PATH — and this is where the verb diverges
 * from `performCreateOrder`, deliberately. dakio-api's `handoverHandler`
 * authors the escalation card itself (`kind:'escalation'`, `priority: 1`
 * pinned) inside the same transaction; a second locally-authored Decision would
 * be two asks on one desk for one thread. A BLOCKED handover still files its
 * card, because in that case no server card exists.
 */

const HANDOVER_VERB = "escalate_conversation" as const;
const HANDOVER_DUTY_REF = "support.inbox_escalations" as const;

/**
 * The closed taxonomy, in dakio-api's exact ORDER — order is pinned, not just
 * membership, and new slugs are APPENDED never inserted. `handoverHandler` 422s
 * an unknown slug, so a half-landed widening fails at runtime on a real thread
 * rather than at build time.
 */
export const ESCALATION_REASONS = [
  "human_ask",
  "anger",
  "payment_dispute",
  "legal",
  "lost",
  "negotiation",
  "vip",
  "tool_failure",
  "fraud_risk",
  "guardrail_blocked",
  "policy_gap",
  "catalog_gap",
] as const;
export type EscalationReason = (typeof ESCALATION_REASONS)[number];

/**
 * Exactly the RANGE of `DEPARTMENT_BY_INTENT`, never the full NovaDepartment
 * union: a customer hand-off never lands in `inventory` or `ceo`. Widen this
 * and the intent map together, or the same thread routes one way on reply and
 * another on handover.
 */
export const HANDOVER_DEPARTMENTS = ["support", "sales", "finance", "shipping", "marketing"] as const;
export type HandoverDepartment = (typeof HANDOVER_DEPARTMENTS)[number];

export interface HandoverGatePayload {
  /** `nm:<conv>:handover` — one open escalation per conversation is the server's own rule. */
  novaActionId: string;
  /** MUST be `ctx.convId` from the signed ingress. */
  conversationId: string;
  reason: EscalationReason;
  /** Routed by who should PICK IT UP, which is not always the room the thread started in. */
  department: HandoverDepartment;
  /** English brief the founder can act on without re-reading the thread. ≥10 chars. */
  summary: string;
  /** The same brief in Bangla. REQUIRED — a transliteration or a copy of the English is not one. */
  summaryBn: string;
  /** A DRAFT for the founder. It never auto-sends. */
  suggestedReply?: string;
  suggestedAction?: string;
  /** What was verified before escalating, so the founder does not re-check it. */
  factsChecked: Array<{ source: string; note: string }>;
}

export type HandoverGateOutcome =
  | {
      status: "executed";
      actionId: string;
      detail: string;
      /** Only when this is TRUE may anything claim the customer was told something. */
      holdingSent: boolean;
      alreadyEscalated: boolean;
      decisionId: string | null;
      replayed: boolean;
    }
  | { status: "prepared"; actionId: string; detail: string; rule: string; replayed: boolean }
  | { status: "blocked"; actionId: string; detail: string; rule: string };

/**
 * A fixed sentence plus the raw taxonomy slug, and nothing else.
 *
 * Never the customer's name, phone, address, order number, the summary text,
 * the suggestedReply, or any guardrail rule name. dakio-api composes a richer
 * title for its OWN card inside the tenant boundary; the agent-side ledger
 * title stays this PII-free constant and must not copy the server's.
 */
export function handoverTitle(p: HandoverGatePayload): string {
  return `Hand a customer conversation to you (${p.reason})`;
}

/** The room it is going to, and the brief. No rule name, no phone. */
export function handoverParamsLine(p: HandoverGatePayload): string {
  return [p.reason.replace(/_/g, " "), `to ${p.department}`, p.summary].join(" · ");
}

export async function performFlagHandover(
  storeId: string,
  request: { payload: HandoverGatePayload; receipt: GateReceiptInput },
): Promise<HandoverGateOutcome> {
  const client = storeFor(storeId);
  const { payload, receipt } = request;
  if (!payload.conversationId) throw new Error("escalate_conversation: conversationId is required");
  if (!ESCALATION_REASONS.includes(payload.reason)) {
    throw new Error(`escalate_conversation: unknown reason ${String(payload.reason)}`);
  }
  if (!HANDOVER_DEPARTMENTS.includes(payload.department)) {
    throw new Error(`escalate_conversation: ${String(payload.department)} is not a hand-off department`);
  }
  if (!payload.summary || payload.summary.trim().length < 10) {
    throw new Error("escalate_conversation: summary must be at least 10 characters");
  }
  if (!payload.summaryBn || payload.summaryBn.trim().length < 5) {
    throw new Error("escalate_conversation: summaryBn is required — the founder reads whichever half they prefer");
  }

  const step = await gateOrFile(client, {
    verb: HANDOVER_VERB,
    department: payload.department,
    dutyRef: HANDOVER_DUTY_REF,
    // Only reached on a BLOCKED handover (the execute path authors no local
    // card). Department's own door, per `DOOR_BY_DEPARTMENT`.
    door: doorFor(payload.department),
    title: handoverTitle(payload),
    paramsLine: handoverParamsLine(payload),
    payload: payload as unknown as Record<string, unknown>,
    receipt,
    // Unreachable in practice — NEVER_GATED returns `execute`. If a port ever
    // produces a prepared handover that is a bug in the gate, not a tier, and
    // this line is what a reader will see when it happens.
    preparedDetail: "The thread is being handed to the shop.",
  });

  if (!step.proceed) {
    const o = step.outcome;
    if (o.status === "executed") {
      const after = afterOf(o.record);
      return {
        status: "executed",
        actionId: o.actionId,
        detail: o.detail,
        holdingSent: after.holdingSent === true,
        alreadyEscalated: after.alreadyEscalated === true,
        decisionId: typeof after.decisionId === "string" ? after.decisionId : null,
        replayed: true,
      };
    }
    return o;
  }

  // ── Execute (the only verdict that normally happens) ─────────────────────
  const result = await client.handoverConversation(payload.conversationId, {
    novaActionId: payload.novaActionId,
    reason: payload.reason,
    department: payload.department,
    summary: payload.summary,
    summaryBn: payload.summaryBn,
    ...(payload.suggestedReply ? { suggestedReply: payload.suggestedReply } : {}),
    ...(payload.suggestedAction ? { suggestedAction: payload.suggestedAction } : {}),
    factsChecked: payload.factsChecked,
  });

  // THREE STATES, not two. `briefUpdated` absent means "the route never said",
  // which is not `false` — so it is compared with `=== true` / `=== false` and
  // never for truthiness.
  //
  // TYPE RESIDUE, named rather than hidden: `InboxHandoverResult`
  // (src/store/types.ts) has no `briefUpdated` field, so the read goes through
  // a local widening. The right fix is a `briefUpdated?: boolean` on that
  // interface; `src/store/` is out of scope for this change, so the cast stays
  // with this note on it instead of quietly becoming the pattern.
  const briefUpdated = (result as { briefUpdated?: boolean }).briefUpdated;
  const alreadyEscalated = result.alreadyEscalated === true;
  const holdingSent = result.holdingSent === true;

  const outcome = alreadyEscalated
    ? briefUpdated === true
      ? `Conversation ${payload.conversationId} was already with you (${payload.reason}); the brief was updated rather than asking twice.`
      : briefUpdated === false
        ? `Conversation ${payload.conversationId} was already with you (${payload.reason}); there was no open card left to update, so nothing was changed.`
        : `Conversation ${payload.conversationId} was already with you (${payload.reason}); I did not ask twice.`
    : `Handed conversation ${payload.conversationId} to you — ${payload.reason}, ${payload.department}.` +
      (holdingSent ? " The customer was told someone is looking at it." : "");

  const record = await client.addAction({
    type: HANDOVER_VERB,
    department: payload.department,
    title: step.title,
    payload: payload as unknown as Record<string, unknown>,
    justification: justificationOf(receipt),
    receipt: buildReceipt(
      receipt,
      null,
      {
        reason: payload.reason,
        department: payload.department,
        decisionId: result.decisionId ?? null,
        holdingSent,
        alreadyEscalated,
        briefUpdated: briefUpdated ?? null,
      },
      [step.gateEvidence],
    ),
    riskClass: step.authority.riskClass,
    status: "executed",
    outcome,
    // Never undoable: a holding line has gone to a customer and a thread has
    // been locked. There is nothing to reverse.
    undoable: false,
    undoData: null,
    actor: "nova",
    targetRef: `inbox_conversation:${payload.conversationId}`,
    agentId: null,
    dutyRef: HANDOVER_DUTY_REF,
    undoDeadline: null,
    undoneAt: null,
    decidedAt: client.now(),
    executedAt: client.now(),
  });

  // No `addDecision` here — see the header. The escalation card is the server's.
  await client
    .addActivity({
      department: payload.department,
      kind: "action",
      title: step.title,
      detail: outcome,
      // 2, not the generic advisory zero: the minutes spent reading the thread
      // and working out it needed a human, not the conversation the founder now
      // has. Shipping this as the zero-minute fallback once undercounted every
      // escalation the product ever raised.
      minutesSaved: 2,
      revenueInfluence: 0,
      actionId: record.id,
      relatedId: payload.conversationId,
    })
    .catch(() => {});

  return {
    status: "executed",
    actionId: record.id,
    detail: outcome,
    holdingSent,
    alreadyEscalated,
    decisionId: result.decisionId ?? null,
    replayed: false,
  };
}
