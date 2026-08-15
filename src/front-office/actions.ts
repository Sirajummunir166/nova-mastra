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
 *
 * ── What the key alone does NOT buy, and what carries the rest ─────────────
 *
 * A key is only half an idempotency story, and the missing halves are filed
 * ON the row rather than assumed:
 *
 *  - PAYLOAD FINGERPRINT. `findByKey` matches `(type, novaActionId)`; it cannot
 *    tell a redelivery from a DIFFERENT request that reused the key. Every row
 *    this file writes therefore carries a `payload_fingerprint` evidence line,
 *    and a key hit whose fingerprint disagrees is refused loudly instead of
 *    answered from the older row's outcome (`assertSameRequest`).
 *  - CLAIM ROWS. Where the write is irreversible AND the client sends no
 *    server-side idempotency key, the ledger row is filed BEFORE the write and
 *    finalized after it (`fileClaim` → write → `finalizeClaim`). That is the
 *    discount path (`createDiscount` stamps a fresh uuid per POST) and the
 *    cancel path (whose "before" snapshot is destroyed by its own write). The
 *    order path needs none: `DakioStoreClient.createChatOrder` sends
 *    `idempotencyKey: novaActionId`, so its write is already at-most-once and
 *    the ledger row can follow it.
 *  - DECISION HEALING. `addDecision` is best-effort after `addAction`, so a
 *    prepared row can exist with no card. A replay that finds a prepared row
 *    re-checks for the card and files the missing one (`healDecision`) rather
 *    than returning a founder ask nobody can see.
 *
 * A server-side unique floor on `(tenant, novaActionId)` is being added in
 * dakio-api in parallel. Nothing here assumes it: the claim rows and the
 * fingerprint are the agent-side floor and compose with it (a server that
 * refuses a duplicate key surfaces as a thrown write, which a claim row has
 * already recorded).
 */

import { createHash } from "node:crypto";

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
    // The key matched; the REQUEST still has to. A different payload under the
    // same key is a caller bug, not a redelivery, and answering it from this
    // row would report someone else's order as this customer's.
    assertSameRequest(VERB, existing, payload as unknown as Record<string, unknown>);
    if (existing.status === "executed") {
      return {
        status: "executed",
        actionId: existing.id,
        detail: existing.outcome ?? "Order already placed for this confirmation.",
        order: orderFromRecord(existing),
        replayed: true,
      };
    }
    // A prepared row with no Decision is work the founder cannot see. The
    // replay is the only moment anything looks again, so it heals it.
    await healDecision(client, existing, {
      tag: DEPARTMENT,
      door: "orders",
      paramsLine: maskPhonesIn(orderParamsLine(existing.payload as unknown as ChatOrderGatePayload)),
    });
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

  // THE MASKER RUNS HERE TOO. The other five verbs get it from `gateOrFile`;
  // this one does not pass through that helper, and it is the ONE verb whose
  // payload provably carries a customer phone and a street line — so the title
  // rule below stayed a hope on exactly the path that needed it to be a rule.
  // `orderTitle`/`orderParamsLine` compose from `customerCity`/`customerDistrict`,
  // which are customer-typed free text ("Savar, ring me on 01…"), not a
  // catalog constant.
  const title = maskPhonesIn(orderTitle(payload));
  const gateEvidence: ReceiptEvidence = {
    source: "authority_gate",
    note: authority.explanation,
    metric: "rule",
    value: authority.rule,
  };
  // The other half of at-most-once: WHICH request this key stands for.
  const keyEvidence = fingerprintEvidence(payload as unknown as Record<string, unknown>);

  if (authority.verdict === "refuse") {
    // A refusal is an explained, receipted event — its evidence is the rule
    // that fired (nova-ai performAction, PRD §13).
    const record = await client.addAction({
      type: VERB,
      department: DEPARTMENT,
      title,
      payload: payload as unknown as Record<string, unknown>,
      justification: justificationOf(receipt),
      receipt: buildReceipt(receipt, null, null, [gateEvidence, keyEvidence]),
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
      receipt: buildReceipt(receipt, null, null, [gateEvidence, keyEvidence]),
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
      [gateEvidence, keyEvidence],
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

/**
 * FD-3 in one line — the normal flow, never an apology.
 *
 * It does NOT say the order will be placed. The founder may reject it, and an
 * unanswered Decision expires on its TTL (`TTL_HOURS`); the only determined
 * fact at this moment is that the request is on their desk. "Will be placed as
 * approved" read as a promise Nova has no standing to make, and the customer
 * would have been told an order was coming that may never exist.
 */
function preparedDetail(): string {
  return (
    "The order is going in — the shop confirms each chat order before dispatch. " +
    "It is fully prepared and has gone to them for that confirmation."
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

/* ── Idempotency floor, shared by every verb ─────────────────────────────────
 *
 * `findByKey` answers "has this key been used?". These three answer the
 * questions a key alone cannot: was it used for the SAME request, did the row
 * get the founder card it was supposed to, and did the irreversible write
 * either side of the row actually happen.
 * ────────────────────────────────────────────────────────────────────────── */

/** Evidence `source` for everything this floor stamps — one namespace to grep. */
const IDEMPOTENCY_SOURCE = "idempotency";

/** Key order does not change a request, so it must not change its fingerprint. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) out[key] = canonicalize(src[key]);
    return out;
  }
  return value;
}

/**
 * WHICH request a `novaActionId` stands for.
 *
 * Exported for the suite that pins it. Truncated to 16 hex chars because this
 * is an equality check between two rows of one tenant's ledger, not a security
 * boundary — and it rides on a founder-readable receipt line.
 */
export function payloadFingerprint(payload: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(payload)) ?? "").digest("hex").slice(0, 16);
}

function fingerprintEvidence(payload: Record<string, unknown>): ReceiptEvidence {
  return {
    source: IDEMPOTENCY_SOURCE,
    note: "fingerprint of the payload this at-most-once key was filed for",
    metric: "payload_fingerprint",
    value: payloadFingerprint(payload),
  };
}

function fingerprintOf(record: ActionRecord): string | null {
  const hit = record.receipt?.evidence?.find(
    (e) => e.source === IDEMPOTENCY_SOURCE && e.metric === "payload_fingerprint",
  );
  return typeof hit?.value === "string" ? hit.value : null;
}

/**
 * A key hit is only a replay if the REQUEST matches.
 *
 * `findByKey` compares `(type, novaActionId)` and nothing else, so a caller
 * that reuses a key for a different payload — a redelivery composed from state
 * that moved, a key derived from a counter that did not advance — would be
 * handed the older row's outcome as if it were this request's answer, and the
 * customer would be told about somebody else's order. There is no safe way to
 * guess which of the two the caller meant, so this refuses loudly.
 *
 * Rows filed before the fingerprint existed carry none; those still replay,
 * because refusing every pre-existing row would break more than the hole it
 * closes. New rows all carry one.
 */
function assertSameRequest(verb: string, record: ActionRecord, payload: Record<string, unknown>): void {
  const filed = fingerprintOf(record);
  if (!filed) return;
  const incoming = payloadFingerprint(payload);
  if (filed === incoming) return;
  throw new Error(
    `${verb}: novaActionId ${String(payload.novaActionId)} was already filed for a DIFFERENT payload ` +
      `(row ${record.id} fingerprint ${filed}, this request ${incoming}). An at-most-once key names ONE request; ` +
      "refusing to answer this one from that row.",
  );
}

/**
 * The marker that says "this row was filed BEFORE its write, and the write may
 * or may not have happened yet".
 *
 * It stays true after the row is finalized — it describes how the row was
 * filed, not what state it is in — which is what lets `isClaimRow` be read
 * together with `status` rather than being cleared by a patch the store's
 * `updateAction` surface (src/store/client.ts) cannot express anyway.
 */
function claimEvidence(novaActionId: string): ReceiptEvidence {
  return {
    source: IDEMPOTENCY_SOURCE,
    note: "row filed before the irreversible write and finalized after it — a crash cannot leave the write unrecorded",
    metric: "claim",
    value: novaActionId,
  };
}

function isClaimRow(record: ActionRecord): boolean {
  return (record.receipt?.evidence ?? []).some((e) => e.source === IDEMPOTENCY_SOURCE && e.metric === "claim");
}

/**
 * File the claim row: everything known BEFORE the write, including the
 * `before` snapshot the write is about to destroy.
 *
 * Status is `prepared` because the store's `ActionStatus` union has no
 * in-flight member and inventing one belongs in `src/store/`, not here. A
 * claim row is invisible on the founder's desk for the reason the file states
 * elsewhere — the desk renders DECISIONS, and a claim files none.
 */
async function fileClaim(
  client: StoreClient,
  input: Omit<Parameters<StoreClient["addAction"]>[0], "status" | "outcome" | "executedAt" | "decidedAt">,
): Promise<ActionRecord> {
  return client.addAction({
    ...input,
    status: "prepared",
    outcome: null,
    decidedAt: client.now(),
    executedAt: null,
  });
}

/** Turn a claim row into the executed receipt, once the write has returned. */
async function finalizeClaim(
  client: StoreClient,
  claim: ActionRecord,
  patch: { outcome: string; undoable: boolean; undoData: Record<string, unknown> | null },
): Promise<ActionRecord> {
  return client.updateAction(claim.id, {
    status: "executed",
    outcome: patch.outcome,
    undoable: patch.undoable,
    undoData: patch.undoData,
    executedAt: client.now(),
  });
}

/**
 * A prepared row the founder cannot see is work that silently never happened.
 *
 * `addDecision` is best-effort after `addAction` (deliberately — a desk-card
 * failure must not lose the work), so the two can come apart. `findByKey`
 * matches the row and returns, which means the replay is the ONLY moment
 * anything looks at the pair again. It looks.
 *
 * Best-effort in both directions: a `listDecisions` that fails files nothing
 * (a second card on a guess is worse than a late one), and a failed
 * `addDecision` still returns the prepared outcome the caller already has.
 */
async function healDecision(
  client: StoreClient,
  record: ActionRecord,
  shape: { tag: NovaDepartment; door: string; paramsLine: string },
): Promise<void> {
  const cards = await client.listDecisions().catch(() => null);
  if (!cards) return;
  if (cards.some((d) => d.actionId === record.id)) return;
  // Blocked rows never reach a replay (`findByKey`), so a replayed row is
  // always a draft/suggest one — `proposal`, never `escalation`.
  await client
    .addDecision(authorGateDecision(client, record, { verdict: "draft", riskClass: record.riskClass }, shape))
    .catch(() => {});
}

/* ── Conversation scoping — the guarantee, made structural ──────────────────
 *
 * nova-ai pins the thread off an eve customer-session principal
 * (`scopedConversationId`) so a crafted id cannot reach another buyer's
 * parcel. That seam is NOT ported (see `src/store/inboxIntents.ts`), and the
 * verbs that MUTATE a caller-named order — `cancel_order_from_chat` and
 * `update_order_contact` — cannot rebuild it from a read either:
 *
 *   - `Order` (src/store/types.ts) has no conversation field, so `getOrder`
 *     cannot say which thread an order belongs to. The WRITE records it
 *     (`createChatOrder` sends `sourceConversationId`); no read returns it.
 *   - `getOrderStatus(orderId)` is the customer-plane read and is scoped by
 *     TENANT alone — it answers for any order in the shop.
 *   - This lane's own state holds order NUMBERS (`ctx.orders[].no`) and
 *     prepared action ids, never dakio Order ids.
 *
 * So there is nothing here that can verify the claim, and a comment asserting
 * it would be exactly the kind of unenforced guarantee this file must not
 * carry. What IS enforced instead: the two mutating verbs will not accept a
 * bare string. They take a `ConversationOrderRef`, which can only be minted by
 * `conversationOrderRef()` — and that mint refuses any id the caller cannot
 * show among the ids THIS conversation owns. The proof obligation is moved to
 * the caller and made checkable by the compiler.
 * ────────────────────────────────────────────────────────────────────────── */

/** Not exported: an object with this key cannot be written outside this module. */
const CONVERSATION_SCOPED: unique symbol = Symbol("nova.conversationOrderRef");

/**
 * An order id together with the conversation that was shown to own it.
 *
 * The two travel as ONE value on purpose: a branded id alone could be minted
 * against thread A and filed with `conversationId` B, which is the very
 * substitution the brand exists to prevent.
 */
export interface ConversationOrderRef {
  readonly orderId: string;
  readonly conversationId: string;
  readonly [CONVERSATION_SCOPED]: true;
}

/**
 * The ONLY way to make one.
 *
 * `conversationOrderIds` must be the dakio Order ids this conversation's own
 * state holds — from the 360 block of `getInboxConversation(convId)`, or from
 * orders this lane itself placed in this thread. It must NEVER be assembled
 * from the customer's message text ("cancel order 1234") or from model output;
 * dakio-api scopes the cancel by tenant alone, so an id from either source is
 * a stranger's parcel destroyed on the word of someone who never bought it.
 */
export function conversationOrderRef(input: {
  conversationId: string;
  orderId: string;
  conversationOrderIds: readonly string[];
}): ConversationOrderRef {
  const conversationId = input.conversationId?.trim() ?? "";
  const orderId = input.orderId?.trim() ?? "";
  if (!conversationId) throw new Error("conversationOrderRef: conversationId is required");
  if (!orderId) throw new Error("conversationOrderRef: orderId is required");
  if (!input.conversationOrderIds?.includes(orderId)) {
    throw new Error(
      `conversationOrderRef: order ${orderId} is not one of conversation ${conversationId}'s own orders — ` +
        "a chat write may only touch an order this thread is known to own",
    );
  }
  return { orderId, conversationId, [CONVERSATION_SCOPED]: true };
}

/** The runtime half of the brand, for callers that reach this file from JS. */
function assertScopedOrder(verb: string, ref: ConversationOrderRef | undefined): ConversationOrderRef {
  if (!ref || typeof ref !== "object" || (ref as { [CONVERSATION_SCOPED]?: unknown })[CONVERSATION_SCOPED] !== true) {
    throw new Error(
      `${verb}: order must be a ConversationOrderRef from conversationOrderRef() — ` +
        "this verb mutates an order and will not take an id it cannot see scoped to a conversation",
    );
  }
  return ref;
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
    // Masked for the same reason the title is, and by the same masker: the
    // params line is the copy that gets logged and re-rendered where nobody
    // re-audits it (see `gateOrFile`, which does this for the other five).
    paramsLine: maskPhonesIn(orderParamsLine(action.payload as unknown as ChatOrderGatePayload)),
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
 *    guard being present. What holds instead, stated as what the CODE does:
 *    `conversationId` is supplied by the HMAC-verified ingress as an argument
 *    of `runCustomerTurn(storeId, convId, …)`, and the two verbs that mutate a
 *    caller-named order refuse a bare id — they take a `ConversationOrderRef`
 *    that only `conversationOrderRef()` can mint, and that mint refuses any id
 *    the caller cannot show among the ids the conversation owns. See the
 *    "Conversation scoping" block above `conversationOrderRef` for why no read
 *    in this repo can verify ownership server-side today.
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
  /**
   * How this verb resolves ITS OWN unfinished claim row (see `fileClaim`).
   * Only verbs that file claims supply one; for everyone else a prepared row
   * carrying the claim marker is impossible, and the absence is a throw rather
   * than a shrug.
   */
  onClaimReplay?: (claim: ActionRecord) => Promise<SettledGateOutcome>;
}

type GateStep =
  | { proceed: false; outcome: SettledGateOutcome }
  | {
      proceed: true;
      authority: AuthorityDecision;
      /** Every evidence line the gate adds to whatever row the verb files. */
      rowEvidence: ReceiptEvidence[];
      title: string;
      paramsLine: string;
    };

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
    // Same key is not yet the same request — check WHICH request it was.
    assertSameRequest(spec.verb, existing, spec.payload);
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
    // A prepared row carrying the claim marker is NOT a founder ask — it is a
    // previous attempt that filed its row and then did or did not complete its
    // write. Only the verb knows how to find out which.
    if (isClaimRow(existing)) {
      if (!spec.onClaimReplay) {
        throw new Error(
          `${spec.verb}: ${key} has an unfinished claim row (${existing.id}) and this verb files no claims — ` +
            "refusing to guess whether its write landed",
        );
      }
      return { proceed: false, outcome: await spec.onClaimReplay(existing) };
    }
    // A genuine prepared row: make sure the founder can actually see it.
    await healDecision(client, existing, {
      tag: spec.department,
      door: spec.door,
      paramsLine: maskPhonesIn(spec.paramsLine),
    });
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
  const rowEvidence: ReceiptEvidence[] = [
    {
      source: "authority_gate",
      note: authority.explanation,
      metric: "rule",
      value: authority.rule,
    },
    fingerprintEvidence(spec.payload),
  ];

  if (authority.verdict === "refuse") {
    const record = await client.addAction({
      type: spec.verb,
      department: spec.department,
      title,
      payload: spec.payload,
      justification: justificationOf(spec.receipt),
      receipt: buildReceipt(spec.receipt, null, null, rowEvidence),
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
      receipt: buildReceipt(spec.receipt, null, null, rowEvidence),
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

  return { proceed: true, authority, rowEvidence, title, paramsLine };
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
    onClaimReplay: (claim) => resolveDiscountClaim(client, claim, payload),
  });

  if (!step.proceed) {
    const o = step.outcome;
    if (o.status === "executed") return executedDiscountOutcome(o.actionId, o.detail, o.record, payload, true);
    return o;
  }

  // ── Auto tier ────────────────────────────────────────────────────────────
  // EXPIRY IS COUNTED FROM EXECUTION, never from draft time — which is why the
  // prepared row stores `expiresHours` and not a materialized `expiresAt`. A
  // card that sat on the desk overnight would otherwise mint a coupon that is
  // already expired, and the customer would be sent a code that fails at
  // checkout with no explanation anyone could give them.
  const expiresAt = new Date(Date.parse(client.now()) + payload.expiresHours * 3600 * 1000).toISOString();
  const { amount: resolvedAmount, evidence: amountEvidence } = await resolveDiscountAmount(client, payload);

  // ── Claim BEFORE the mint ────────────────────────────────────────────────
  // Minting a coupon is irreversible (the inverse DEACTIVATES; it cannot
  // un-issue) and `DakioStoreClient.createDiscount` sends a FRESH uuid
  // `Idempotency-Key` per POST (src/store/dakio.ts) — unlike `createChatOrder`,
  // which keys on `novaActionId`. So the ledger dedupe preceding the write is
  // not enough: a crash between the mint and `addAction` left a live coupon
  // with no record, and the next delivery of the same turn found no row and
  // minted a SECOND one. The row is therefore filed FIRST, carrying the codes
  // this attempt is allowed to use, and finalized after the mint returns.
  //
  // Codes are reserved up front rather than drawn inside the retry loop for
  // exactly that reason: they are what makes the claim recoverable — a replay
  // asks the store which of them exists (`resolveDiscountClaim`) instead of
  // guessing whether the write landed.
  const reservedCodes = Array.from({ length: CODE_MINT_ATTEMPTS }, () => mintChatDiscountCode());
  const claim = await fileClaim(client, {
    type: DISCOUNT_VERB,
    department: DISCOUNT_DEPARTMENT,
    title: step.title,
    payload: payload as unknown as Record<string, unknown>,
    justification: justificationOf(receipt),
    receipt: buildReceipt(
      receipt,
      null,
      // Everything about the coupon that is known BEFORE it exists. The code
      // and the coupon id land on `undoData` at finalize time, because the
      // store's `updateAction` patch surface (src/store/client.ts) cannot
      // rewrite a receipt and `src/store/` is out of scope here.
      {
        mechanism: payload.mechanism,
        percentOff: payload.percentOff ?? null,
        amount: resolvedAmount ?? null,
        expiresAt,
        maxUses: 1,
      },
      [...step.rowEvidence, claimEvidence(payload.novaActionId), ...(amountEvidence ? [amountEvidence] : [])],
    ),
    riskClass: step.authority.riskClass,
    undoable: false,
    undoData: { kind: "chat_discount_claim", codes: reservedCodes },
    actor: "nova",
    // THE ONE COST OF CLAIMING FIRST, named rather than discovered later: the
    // row is INSERTED before the coupon exists, so it cannot carry
    // `coupon:<id>` — and nothing can add it afterwards. `updateAction`'s patch
    // surface (src/store/client.ts) does not include `targetRef`, and neither
    // does the route behind it: dakio-api's `PATCH /api/v1/agent-data/actions/:id`
    // (src/routes/nova.js) whitelists status/outcome/undoData/undoable/
    // decidedAt/executedAt and 409s anything frozen at insert.
    //
    // What carries the link instead, both of them exercised below:
    //  - `attributeDoorRecord("coupon:<id>", row.id)` stamps the DOOR record
    //    itself, which is what renders the by:nova chip and the receipt drawer;
    //    `targetRef` on the row is the denormalized copy, not the source.
    //  - `undoData.couponId` — the field dakio-api's UNDO map actually reads
    //    (`runUndo` dispatches on `undoData.kind`, never on `targetRef`).
    // A live coupon nobody has a record of is the worse failure of the two.
    targetRef: null,
    agentId: null,
    dutyRef: DISCOUNT_DUTY_REF,
    undoDeadline: null,
    undoneAt: null,
  });

  const discount = await mintReservedCoupon(client, payload, {
    codes: reservedCodes,
    expiresAt,
    amount: resolvedAmount,
  });
  return finalizeDiscount(client, claim, discount, payload, resolvedAmount);
}

/**
 * The money figure on a `free_delivery` coupon, and why the agent computes one
 * at all.
 *
 * THE FILE'S RULE IS "the server prices everything", and this is the one place
 * that cannot honour it — not a licence, a named server gap:
 *
 *   dakio-api `POST /api/v1/store/discounts` (src/routes/novaStore.js
 *   `createStoreDiscount`, mounted at `router.post('/discounts', …)`) accepts
 *   `type` ∈ {PERCENT, FIXED} ONLY, and 422s a FIXED coupon without a positive
 *   whole-taka `amount`. There is no free-delivery mechanism on that route, so
 *   "send the mechanism and let the server resolve it" is not expressible on
 *   the DIRECT tier. The APPROVE tier does exactly that — the prepared payload
 *   carries `mechanism: "free_delivery"` and NO amount, and dakio-api's
 *   `EXECUTORS.offer_chat_discount` (src/lib/novaExecutors.js) reads the
 *   tenant's own `deliveryInsideDhaka`/`deliveryOutsideDhaka` and takes their
 *   `Math.max`. This function reproduces that server-side arithmetic against
 *   `getStoreSettings()` so the two tiers issue the SAME coupon.
 *
 * Two things follow, and both are enforced rather than trusted:
 *  - the number is READ from the store, never estimated. There is no fallback
 *    figure: an unconfigured delivery charge throws instead of guessing one.
 *  - the receipt says so. The evidence line names `get_store_settings` as the
 *    source and the route as the reason, so nobody reading the ledger later
 *    concludes the server priced this coupon.
 *
 * Closing the gap properly means a `FREE_DELIVERY` kind on that route (or an
 * `amount: null` + `mechanism` body it resolves itself); until then this stays
 * the one agent-side money computation in the file, and it stays labelled.
 */
export async function resolveDiscountAmount(
  client: StoreClient,
  payload: ChatDiscountGatePayload,
): Promise<{ amount: number | undefined; evidence: ReceiptEvidence | null }> {
  if (payload.mechanism === "fixed") {
    // Straight through, WHOLE TAKA. Introducing a ×100 here would give away a
    // 100× discount. The founder chose this figure; nothing is computed.
    return { amount: payload.amount, evidence: null };
  }
  if (payload.mechanism !== "free_delivery") return { amount: undefined, evidence: null };

  const settings = await client.getStoreSettings();
  const amount = Math.max(settings.deliveryInsideDhaka ?? 0, settings.deliveryOutsideDhaka ?? 0);
  if (!(amount > 0)) {
    throw new Error(
      "this store has no delivery charge configured, so 'free delivery' would be a coupon worth nothing — set a delivery charge in Settings first",
    );
  }
  return {
    amount,
    evidence: {
      source: "tool:get_store_settings",
      note:
        "free delivery priced agent-side from the store's own two delivery charges (larger of the two, as dakio-api's approve executor does) — " +
        "POST /api/v1/store/discounts takes PERCENT|FIXED only and has no free-delivery mechanism",
      metric: "server_gap",
      value: amount,
    },
  };
}

/**
 * Mint against the RESERVED codes.
 *
 * A collision moves to the next reserved code rather than drawing a fresh one,
 * so the claim row's list stays the complete set of codes this key could ever
 * have created — which is the whole basis on which a replay can tell whether
 * the write landed. A guardrail refusal is never retried (see `isCodeCollision`).
 */
async function mintReservedCoupon(
  client: StoreClient,
  payload: ChatDiscountGatePayload,
  opts: { codes: string[]; expiresAt: string; amount: number | undefined },
): Promise<Awaited<ReturnType<StoreClient["createDiscount"]>>> {
  let lastError: unknown = null;
  for (const code of opts.codes) {
    try {
      return await client.createDiscount({
        code,
        type: payload.mechanism === "percent" ? "PERCENT" : "FIXED",
        ...(payload.mechanism === "percent" ? { percentOff: payload.percentOff } : { amount: opts.amount }),
        expiresAt: opts.expiresAt,
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
    } catch (error) {
      lastError = error;
      if (!isCodeCollision(error)) throw error;
    }
  }
  throw new Error(
    `offer_chat_discount: could not mint a free coupon code after ${opts.codes.length} attempts (${
      lastError instanceof Error ? lastError.message : String(lastError)
    })`,
  );
}

/** Claim row + minted coupon → the executed receipt, the door stamp and the activity line. */
async function finalizeDiscount(
  client: StoreClient,
  claim: ActionRecord,
  discount: Awaited<ReturnType<StoreClient["createDiscount"]>>,
  payload: ChatDiscountGatePayload,
  resolvedAmount: number | undefined,
): Promise<DiscountGateOutcome> {
  const mechanismNote =
    payload.mechanism === "free_delivery" ? `free delivery (৳${resolvedAmount} off)` : discountOffer(payload);
  const outcome = `Issued coupon ${discount.code} — ${mechanismNote}, one use, expires in ${payload.expiresHours}h. ${payload.reason}`;

  const record = await finalizeClaim(client, claim, {
    outcome,
    undoable: true,
    // WIRE CONTRACT: `couponId`, NOT this repo's usual `discountId`.
    // dakio-api's `UNDO.deactivate_chat_discount` destructures `{ couponId }`
    // and throws on anything else — the wrong field name has already shipped
    // twice. The inverse DEACTIVATES and never deletes: if the code was already
    // redeemed the discount happened, and erasing the row would erase the
    // receipt explaining a sale short by exactly that amount.
    //
    // It is also where the minted code lives: the claim row's receipt was
    // written before the code existed and `updateAction` cannot rewrite a
    // receipt, so `undoData.code` is the authoritative read (see
    // `executedDiscountOutcome`).
    undoData: { kind: "deactivate_chat_discount", couponId: discount.id, code: discount.code },
  });

  await client.attributeDoorRecord(`coupon:${discount.id}`, record.id).catch(() => {});
  await client
    .addActivity({
      department: DISCOUNT_DEPARTMENT,
      kind: "action",
      title: record.title,
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

/**
 * Read a settled discount row back into an outcome.
 *
 * `undoData.code` first: on a finalized claim row the receipt predates the
 * code. `receipt.after.code` is the fallback for rows filed by the pre-claim
 * shape, which are still in ledgers.
 */
function executedDiscountOutcome(
  actionId: string,
  detail: string,
  record: ActionRecord,
  payload: ChatDiscountGatePayload,
  replayed: boolean,
): DiscountGateOutcome {
  const after = afterOf(record);
  const undo = (record.undoData ?? {}) as Record<string, unknown>;
  return {
    status: "executed",
    actionId,
    detail,
    code: typeof undo.code === "string" ? undo.code : typeof after.code === "string" ? after.code : null,
    discountId: String(undo.couponId ?? "") || null,
    expiresHours: payload.expiresHours,
    replayed,
  };
}

/**
 * A previous attempt filed its claim row and then stopped — did its coupon get
 * minted or not?
 *
 * This is the question the claim exists to make ANSWERABLE rather than guessed:
 * the row names every code that attempt could have used, so the store is asked
 * which of them exists. Found → the mint landed and only the finalize was lost,
 * so the row is finalized and the customer keeps the ONE code they were issued.
 * Not found → the mint never landed, and the same claim row is reused for it.
 * Neither branch mints a second coupon for one negotiation.
 */
async function resolveDiscountClaim(
  client: StoreClient,
  claim: ActionRecord,
  payload: ChatDiscountGatePayload,
): Promise<SettledGateOutcome> {
  const codes = ((claim.undoData as Record<string, unknown> | null)?.codes ?? []) as string[];
  const minted = (await client.listDiscounts()).find((d) => codes.includes(d.code));
  const claimed = afterOf(claim);
  const resolvedAmount = typeof claimed.amount === "number" ? claimed.amount : undefined;

  const settled = minted
    ? await finalizeDiscount(client, claim, minted, payload, resolvedAmount)
    : await finalizeDiscount(
        client,
        claim,
        await mintReservedCoupon(client, payload, {
          codes,
          // Expiry is counted from EXECUTION, and this attempt is the execution.
          expiresAt: new Date(Date.parse(client.now()) + payload.expiresHours * 3600 * 1000).toISOString(),
          amount: resolvedAmount,
        }),
        payload,
        resolvedAmount,
      );

  if (settled.status !== "executed") throw new Error("offer_chat_discount: a finalized claim is always executed");
  const record = await client.getAction(settled.actionId);
  return {
    status: "executed",
    actionId: settled.actionId,
    detail: settled.detail,
    // The row the caller replays from, so the outcome reads identically
    // whichever attempt produced it. The request's own receipt is NOT re-filed:
    // the claim row already carries the one this key was filed with.
    record: record ?? { ...claim, status: "executed", outcome: settled.detail },
    replayed: true,
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
   * The order AND the conversation shown to own it, as one value that only
   * `conversationOrderRef()` can mint — never a bare id.
   *
   * This is the type doing the work the header used to claim in prose:
   * dakio-api scopes the cancel by TENANT alone, so an id parsed out of
   * customer free text ("cancel order 1234") or emitted by a model would
   * destroy a stranger's order on the word of someone who never placed it, and
   * nothing in this repo can detect that after the fact (see the
   * "Conversation scoping" block above `conversationOrderRef`).
   *
   * The two ids are filed on the wire payload as `orderId` and
   * `conversationId`, exactly as dakio-api's approve executor reads them.
   */
  order: ConversationOrderRef;
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
 *
 * TWO CLAIMS WERE REMOVED FROM IT, and both for the same reason:
 *  - "nothing has shipped on it in the meantime" — the prepared path makes NO
 *    read of the order (the gate settles before any `getOrder`), so this was a
 *    statement about the parcel's state written by code that had not looked. A
 *    parcel that went out an hour ago would have been described as still here.
 *  - "they will confirm it" — the founder may reject the card, and an
 *    unanswered Decision expires on its TTL. What is determined is that the
 *    request reached them; what they do with it is not.
 */
function cancelPreparedDetail(): string {
  return (
    "The cancellation request has gone to the shop for confirmation. " +
    "The order is not cancelled yet, so it may still move until they answer."
  );
}

export async function performCancelOrder(
  storeId: string,
  request: { payload: CancelOrderGatePayload; receipt: GateReceiptInput },
): Promise<CancelGateOutcome> {
  const client = storeFor(storeId);
  const { payload, receipt } = request;
  // The brand is checked at runtime too: a JS caller, or a TS one that reached
  // for `as`, must not be able to hand this verb an unscoped id.
  const order = assertScopedOrder(CANCEL_VERB, payload.order);
  if (!payload.reason || payload.reason.trim().length < 5) {
    throw new Error("cancel_order_from_chat: reason must be at least 5 characters — it is the only record of why a sale went away");
  }
  // The WIRE payload, built explicitly: `orderId` + `conversationId` are the
  // keys dakio-api's approve executor reads, and the ref is a lane-side type
  // that must not travel.
  const wire: Record<string, unknown> = {
    novaActionId: payload.novaActionId,
    orderId: order.orderId,
    conversationId: order.conversationId,
    reason: payload.reason,
  };

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
    payload: wire,
    receipt,
    preparedDetail: cancelPreparedDetail(),
    onClaimReplay: (claim) => resolveCancelClaim(client, claim, order, payload.reason),
  });

  if (!step.proceed) {
    const o = step.outcome;
    if (o.status === "executed") return executedCancelOutcome(o.actionId, o.detail, o.record, order.orderId, true);
    return o;
  }

  // ── Auto tier ────────────────────────────────────────────────────────────
  // The before-snapshot is what `undoData.previousStatus` restores. This is the
  // FOUNDER-plane read used inside the customer lane, and it is named as such:
  // the customer-plane `getOrderStatus` returns a humanized `displayStatus`
  // string, not an `OrderStatus`, so feeding it into `previousStatus` would
  // write a value `updateOrder` cannot restore.
  //
  // IT IS READ AND PERSISTED BEFORE THE WRITE, which is the whole reason this
  // path files a claim row. The write destroys the very fact the undo needs: a
  // first attempt that cancelled the order and then failed before filing its
  // row left the world at `cancelled`, and the next attempt read THAT as the
  // state to restore — an undo that restores 'cancelled' is an undo that does
  // nothing, and the founder's one way back was gone.
  const before = await client.getOrder(order.orderId);
  const previousStatus: OrderStatus = before?.status ?? "placed";

  const claim = await fileClaim(client, {
    type: CANCEL_VERB,
    department: CANCEL_DEPARTMENT,
    title: step.title,
    payload: wire,
    justification: justificationOf(receipt),
    receipt: buildReceipt(
      receipt,
      { status: previousStatus },
      { orderId: order.orderId, status: "cancelled", reason: payload.reason },
      [...step.rowEvidence, claimEvidence(payload.novaActionId)],
    ),
    riskClass: step.authority.riskClass,
    // The inverse is already complete at claim time — `previousStatus` is the
    // only thing it needs and it has just been read. `undoable` flips true at
    // finalize, because a claim row's write may not have happened yet.
    undoable: false,
    undoData: { kind: "uncancel_chat_order", orderId: order.orderId, previousStatus },
    actor: "nova",
    targetRef: `order:${order.orderId}`,
    agentId: null,
    dutyRef: CANCEL_DUTY_REF,
    undoDeadline: null,
    undoneAt: null,
  });

  await client.updateOrderDelivery(order.orderId, { status: "cancelled" });
  return finalizeCancel(client, claim, order, payload.reason, previousStatus);
}

/** Claim row + completed write → the executed receipt and the activity line. */
async function finalizeCancel(
  client: StoreClient,
  claim: ActionRecord,
  order: ConversationOrderRef,
  reason: string,
  previousStatus: OrderStatus,
): Promise<CancelGateOutcome> {
  const outcome =
    `Cancelled order ${order.orderId} at the customer's request: "${reason}". ` +
    "If it was already booked with the courier, cancel the parcel with them too — Dakio has not.";

  const record = await finalizeClaim(client, claim, {
    outcome,
    undoable: true,
    // `uncancel_chat_order` is the literal string dakio-api's kind-keyed UNDO
    // map dispatches on; a wrong slug reaches a founder as "No inverse is
    // defined for undefined", which has shipped twice. `orderId` is
    // unconditional — it is the one field that UNDO reads. `previousStatus`
    // is the claim's, never a re-read: see `performCancelOrder`.
    undoData: { kind: "uncancel_chat_order", orderId: order.orderId, previousStatus },
  });

  await client.attributeDoorRecord(`order:${order.orderId}`, record.id).catch(() => {});
  await client
    .addActivity({
      // KNOWN, DELIBERATE ASYMMETRY, left as found: the ledger row's department
      // is `sales`, while dakio-api's approve path files its ACTIVITY under
      // `support`. The direct path writes the action's own department, so
      // `sales` here keeps symmetry with `performCreateOrder` — the divergence
      // is recorded rather than silently aligned.
      department: CANCEL_DEPARTMENT,
      kind: "action",
      title: record.title,
      detail: outcome,
      minutesSaved: 6,
      // A cancellation influences no revenue. Do NOT record the lost order
      // total as negative revenue.
      revenueInfluence: 0,
      actionId: record.id,
      relatedId: order.conversationId,
    })
    .catch(() => {});

  return {
    status: "executed",
    actionId: record.id,
    detail: outcome,
    orderId: order.orderId,
    previousStatus,
    replayed: false,
  };
}

/** Read a settled cancel row back into an outcome — `before.status` is the undo anchor. */
function executedCancelOutcome(
  actionId: string,
  detail: string,
  record: ActionRecord,
  fallbackOrderId: string,
  replayed: boolean,
): CancelGateOutcome {
  const after = afterOf(record);
  const before = (record.receipt?.before ?? {}) as Record<string, unknown>;
  return {
    status: "executed",
    actionId,
    detail,
    orderId: typeof after.orderId === "string" ? after.orderId : fallbackOrderId,
    previousStatus: (typeof before.status === "string" ? before.status : null) as OrderStatus | null,
    replayed,
  };
}

/**
 * A previous cancel attempt filed its claim and stopped.
 *
 * The status to restore comes off the CLAIM (`receipt.before.status`), never
 * from a fresh read — that read is exactly what a re-execution corrupts. The
 * only thing the world is asked is whether the write landed, and an order that
 * is already `cancelled` needs no second patch.
 */
async function resolveCancelClaim(
  client: StoreClient,
  claim: ActionRecord,
  order: ConversationOrderRef,
  reason: string,
): Promise<SettledGateOutcome> {
  const before = (claim.receipt?.before ?? {}) as Record<string, unknown>;
  const previousStatus = (typeof before.status === "string" ? before.status : "placed") as OrderStatus;
  const current = await client.getOrder(order.orderId);
  if (current && current.status !== "cancelled") {
    await client.updateOrderDelivery(order.orderId, { status: "cancelled" });
  }
  const settled = await finalizeCancel(client, claim, order, reason, previousStatus);
  const record = await client.getAction(settled.actionId);
  return {
    status: "executed",
    actionId: settled.actionId,
    detail: settled.detail,
    record: record ?? { ...claim, status: "executed", outcome: settled.detail },
    replayed: true,
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
  /**
   * The order AND the conversation shown to own it — a `ConversationOrderRef`,
   * never a bare id, for the reason spelled out on `CancelOrderGatePayload`.
   * Redirecting a COD parcel is the fraud shape this verb's own header names;
   * "whoever is typing in this thread" is not the same claim as "the person
   * who placed the order", and an unscoped id makes even the first claim
   * unverifiable. Filed on the wire as `orderId` (dakio-api PATCHes
   * `params:{id}`, not an order number) and `conversationId`.
   */
  order: ConversationOrderRef;
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

/**
 * Never "I've changed it" for a change that has not happened, and never a total.
 *
 * TWO CLAIMS WERE REMOVED, for the same reasons as the cancel line:
 *  - "before the parcel goes out" asserted a pre-dispatch state nothing on this
 *    path read. This verb's own header says the pre-dispatch fence belongs to
 *    the SERVER (`patchStoreOrder` answers 409) — which means the agent does
 *    not know, at the moment it says this, whether the parcel is still here.
 *  - "They will confirm the change" promised the founder's answer. They may
 *    reject it; an unanswered Decision expires on its TTL.
 * What is determined: the correction reached them, and if the area changed the
 * amount due at the door moves with it.
 */
function contactPreparedDetail(): string {
  return (
    "The corrected delivery details have gone to the shop to confirm. " +
    "Until they answer, the order still carries the old ones — and if the area changed, the amount due at the door changes with it."
  );
}

export async function performUpdateContact(
  storeId: string,
  request: { payload: UpdateContactGatePayload; receipt: GateReceiptInput },
): Promise<ContactGateOutcome> {
  const client = storeFor(storeId);
  const { payload, receipt } = request;
  // Runtime half of the brand — see `performCancelOrder`.
  const order = assertScopedOrder(CONTACT_VERB, payload.order);
  const changed = changedContactFields(payload);
  if (changed.length === 0) {
    throw new Error("Give at least one field to change — an update that changes nothing is not an update.");
  }
  // The WIRE payload, built explicitly: the ref is lane-side and must not
  // travel; `orderId` + `conversationId` are what dakio-api's executor reads.
  const wire: Record<string, unknown> = {
    novaActionId: payload.novaActionId,
    orderId: order.orderId,
    conversationId: order.conversationId,
    ...(payload.address !== undefined ? { address: payload.address } : {}),
    ...(payload.city !== undefined ? { city: payload.city } : {}),
    ...(payload.district !== undefined ? { district: payload.district } : {}),
    ...(payload.phone !== undefined ? { phone: payload.phone } : {}),
  };

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
    payload: wire,
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
  await client.updateOrderDelivery(order.orderId, {
    ...(payload.address !== undefined ? { address: payload.address } : {}),
    ...(payload.city !== undefined ? { city: payload.city } : {}),
    ...(payload.district !== undefined ? { district: payload.district } : {}),
    ...(payload.phone !== undefined ? { phone: payload.phone } : {}),
  });

  // "before dispatch" is safe HERE and only here: the write above RETURNED,
  // and the server's pre-dispatch fence (409 → `InboxSendRefused`) is what let
  // it. The prepared line may not borrow this sentence — nothing has been
  // asked of the server on that path.
  const outcome =
    `Updated ${changed.join(", ")} on the order before dispatch.` +
    (payload.district ? " The district changed, so the delivery charge and total were recalculated." : "") +
    " The confirmation was reset — re-confirm with the customer before it ships.";

  const record = await client.addAction({
    type: CONTACT_VERB,
    department: CONTACT_DEPARTMENT,
    title: step.title,
    payload: wire,
    justification: justificationOf(receipt),
    // `before` is null even on the executed tier — parity with nova-ai, which
    // deliberately takes no snapshot for this verb.
    receipt: buildReceipt(receipt, null, { orderId: order.orderId, changed }, step.rowEvidence),
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
    targetRef: `order:${order.orderId}`,
    agentId: null,
    dutyRef: CONTACT_DUTY_REF,
    undoDeadline: null,
    undoneAt: null,
    decidedAt: client.now(),
    executedAt: client.now(),
  });

  await client.attributeDoorRecord(`order:${order.orderId}`, record.id).catch(() => {});
  await client
    .addActivity({
      department: CONTACT_DEPARTMENT,
      kind: "action",
      title: step.title,
      detail: `Changed ${changed.join(", ")}.`,
      minutesSaved: 5,
      revenueInfluence: 0,
      actionId: record.id,
      relatedId: order.conversationId,
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

/**
 * No case id, no `joined` state, no timeline — none of the three is known yet,
 * and NO CLAIM THAT ANYONE HAS STARTED. "The shop is picking it up from here"
 * described work in progress when all that exists is a card waiting for a tap;
 * the executed tier is the only one that may speak about a room having it
 * (`joined` is server truth, and it exists only after the write returns).
 */
function casePreparedDetail(): string {
  return "The problem is written down and it has gone to the shop.";
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
      step.rowEvidence,
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

/**
 * The ask is WAITING, not under way: a prepared row has moved nothing, no
 * holding line has gone out, and the thread is still Nova's. "The thread is
 * being handed to the shop" described a transfer in progress that had not
 * started.
 */
function handoverPreparedDetail(): string {
  return "The request to hand this thread over is waiting on the shop; it has not moved yet.";
}

/**
 * Every verb's prepared-tier line, in ONE table.
 *
 * They answer to ONE rule — never assert an outcome that is not determined,
 * never assert state that was not read, never imply queued work is under way —
 * and a rule that applies to six strings is worth being able to test over six
 * strings. Each entry is the same function the verb itself calls, so the table
 * cannot drift from what a customer is actually told; the reasoning for each
 * line lives on that function.
 *
 * The handover's line is reachable only through this table today (NEVER_GATED
 * means its prepared tier never fires), which is exactly why it is here: an
 * unreachable string is the one most likely to rot.
 */
export const PREPARED_DETAIL_BY_VERB = {
  create_order_from_chat: preparedDetail,
  offer_chat_discount: discountPreparedDetail,
  cancel_order_from_chat: cancelPreparedDetail,
  update_order_contact: contactPreparedDetail,
  open_case: casePreparedDetail,
  escalate_conversation: handoverPreparedDetail,
} as const satisfies Record<string, () => string>;

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
    preparedDetail: handoverPreparedDetail(),
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
      step.rowEvidence,
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
