/**
 * The order gate — a lane-appropriate port of nova-ai's `performAction`
 * (agent/lib/nova/actions.ts), scoped to the ONE verb the customer lane can
 * reach: `create_order_from_chat`.
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
