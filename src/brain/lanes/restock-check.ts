/**
 * RESTOCK CHECK — what is ACTUALLY on order, written down where the answer to a
 * waiting customer gets composed from.
 *
 * ── WHERE THE WORK COMES FROM ───────────────────────────────────────────────
 *
 * A customer asks for something that is out of stock, the front office opens a
 * `restock_wait` case, and on the NEW-case edge (never on a join — one case is
 * one restock question however many people ask) dakio-api's
 * `mintRestockCheckJob` writes one row here. Payload: ids only.
 *
 *   { caseId, productId, conversationId, customerId, triggeredBy: "case.opened" }
 *
 * ── THE HONESTY FORK IS THE WHOLE JOB ───────────────────────────────────────
 *
 * nova-ai's prompt states it and this lane makes it arithmetic:
 *
 *   · A purchase order with a real expected date ⇒ you may give that date.
 *   · Nothing on order ⇒ you may NOT invent "next week". Say soon, promise to
 *     tell them the moment it lands, and mean it.
 *
 *     *"A date you made up is a second disappointment on top of the first."*
 *
 * ── WHY THIS LANE MAKES ZERO MODEL CALLS, AND THAT IS THE DESIGN ────────────
 *
 * The fork above is a `find` over open purchase orders. The count of people
 * waiting is `refs.conversationIds.length`. The sentence that gets written onto
 * the case is a statement of those two facts. There is no judgement left to buy
 * — and inviting a model to word a supply position it cannot check is EXACTLY
 * how "should be back next week" gets written next to a product nobody has
 * ordered. So the model is not invited: the honesty rule is structural here
 * rather than a line in a prompt that a model may or may not honour, which is
 * the same reason the pulse derives its report title in code.
 *
 * (The pulse's rule is "spend a model only on the departments that MOVED". This
 * lane's is the same rule at its limit: nothing here moves.)
 *
 * ── WHAT IT WRITES, AND WHAT IT DELIBERATELY DOES NOT ───────────────────────
 *
 *  · THE CASE gets one appended fact: the supply position, in facts. That is
 *    the material `case_update` composes the customer's answer from, and it is
 *    append-only server-side, so nothing this lane writes can erase what a
 *    courier poll or a founder wrote.
 *  · A FOUNDER REPORT, but only when there is a decision to make: several
 *    people waiting for one product ("three customers asking is a restock
 *    decision, not a coincidence"), or nothing on order at all. A case whose
 *    product is already on a purchase order with one person waiting needs no
 *    report — the fact on the case is the whole answer.
 *  · IT DOES NOT MESSAGE THE CUSTOMER. `send_inbox_reply` is governed by
 *    `support.inbox_replies`, which this lane does not hold; telling them is
 *    the `case_update` lane's work, on the customer's own thread, through the
 *    ordinary send gate. Surfaced as a capability gap rather than left as an
 *    absence.
 *  · IT DOES NOT DRAFT THE PURCHASE ORDER. `create_purchase_order` needs
 *    `inventory.reorder_drafts`, which `night_ops` holds. The restock DECISION
 *    is raised for the founder; the PO is not drafted here. Also a gap.
 */

import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";

import { storeFor } from "../../store/resolve.js";
import type { StoreClient } from "../../store/client.js";
import type { NovaCaseView, Product, PurchaseOrder } from "../../store/types.js";
import { classifyRemedy, readOr, type LaneBlindSpot, type LaneGap } from "./gaps.js";

/** This lane's kind — every registry lookup below is keyed on it. */
const KIND = "restock_check" as const;

/** The case kind this lane answers. Anything else is a malformed producer. */
const CASE_KIND = "restock_wait";

/** Case statuses that mean the question is over. dakio-api's terminal set. */
const TERMINAL = ["resolved", "closed_unresolved", "expired"];

/**
 * How many waiting threads make a restock a DECISION rather than a data point.
 *
 * Three, because that is the number nova-ai's own prompt uses — "three
 * customers asking is a restock decision, not a coincidence" — and a threshold
 * a founder will one day ask about should be the number they were promised, in
 * a named constant, not an inequality buried in a branch.
 */
export const RESTOCK_DECISION_WAITERS = 3;

/** The source stamped on every fact this lane appends. */
export const FACT_SOURCE = "nova:restock_check";

/** The rule, in the words it is kept by. Quoted on the report it files. */
export const RESTOCK_HONESTY =
  "A date you made up is a second disappointment on top of the first.";

/**
 * Purchase-order statuses that mean the stock is ACTUALLY COMING.
 *
 * `draft` is deliberately absent and it is the whole point of the list: a draft
 * PO is a piece of paper nobody has sent to a supplier. Reading a date off one
 * and telling a customer is precisely the invented promise this lane exists to
 * prevent — the difference between "we ordered it" and "we thought about
 * ordering it" is invisible in the field and total to the person waiting.
 */
const ON_ORDER: readonly PurchaseOrder["status"][] = ["placed", "in_transit"];

// ---------------------------------------------------------------------------
// The supply position — the fork, as arithmetic
// ---------------------------------------------------------------------------

export type SupplyFork =
  /** It is already back. The best answer there is, and it needs no date. */
  | "back_in_stock"
  /** On order, with a date the supplier gave. The one case where a date is honest. */
  | "on_order"
  /** On order, but its expected date has already passed. On order; NO date. */
  | "on_order_overdue"
  /** Nothing on order. "Soon", and the promise to tell them the moment it lands. */
  | "nothing_on_order"
  /** Nova could not check. Says so; never fills the hole with a guess. */
  | "unknown";

export interface SupplyPosition {
  fork: SupplyFork;
  productId: string | null;
  productName: string | null;
  stock: number | null;
  /** The purchase order the answer rests on, when there is one. */
  po: { id: string; quantity: number; expectedAt: string } | null;
  /**
   * THE ONLY PLACE A DATE MAY COME FROM. `null` on every fork except
   * `on_order`, and the tests pin that: a date on any other fork is an
   * invention by definition, because nothing measured one.
   */
  date: string | null;
  /** The facts, in one sentence, as it will be quoted. */
  note: string;
}

/**
 * Read the supply position off what was actually found. PURE — same inputs,
 * same answer, no clock of its own beyond the `now` it is handed.
 */
export function supplyPosition(input: {
  product: Product | null;
  purchaseOrders: PurchaseOrder[] | null;
  productId: string | null;
  now: string;
  /** Why the product or the PO list is missing, when it is. */
  unknownReason?: string;
}): SupplyPosition {
  const { product, purchaseOrders, productId, now } = input;
  const name = product?.name ?? null;

  // A STOCK COUNT NOVA CANNOT READ IS NOT ZERO. `Product.stock` is typed as a
  // number and the live backend does not always carry one — `GET /products/:id`
  // strips it deliberately (it is the customer-safe read and answers with an
  // `availability` band instead), which is why this lane reads the founder-plane
  // LIST. If a count still does not arrive, the honest answer is "could not
  // check": telling a waiting customer a product is out of stock because a field
  // was missing is the same class of lie as inventing a date.
  const countable = product !== null && Number.isFinite(product.stock);

  if (!product || purchaseOrders === null || !countable) {
    return {
      fork: "unknown",
      productId,
      productName: name,
      stock: countable ? product!.stock : null,
      po: null,
      date: null,
      note:
        `Supply check could not run: ${
          product && !countable
            ? `no stock count came back for ${product.name}`
            : (input.unknownReason ?? "Nova could not read the product or its purchase orders")
        }. No date can be given, and none has been guessed.`,
    };
  }

  if (product.stock > 0) {
    return {
      fork: "back_in_stock",
      productId,
      productName: name,
      stock: product.stock,
      po: null,
      date: null,
      note: `Supply check: ${product.name} is back in stock — ${product.stock} available right now.`,
    };
  }

  // The EARLIEST real arrival, not the newest PO: what a waiting customer cares
  // about is when the next units land, whoever ordered them.
  const open = purchaseOrders
    .filter((po) => po.productId === product.id && ON_ORDER.includes(po.status))
    .sort((a, b) => Date.parse(a.expectedAt) - Date.parse(b.expectedAt));
  const first = open[0];

  if (!first) {
    return {
      fork: "nothing_on_order",
      productId,
      productName: name,
      stock: product.stock,
      po: null,
      date: null,
      note:
        `Supply check: ${product.name} is out of stock (${product.stock}) and NOTHING is on order — no placed or ` +
        `in-transit purchase order exists for it. There is no date to give.`,
    };
  }

  const overdue = Date.parse(first.expectedAt) < Date.parse(now);
  const po = { id: first.id, quantity: first.quantity, expectedAt: first.expectedAt };
  if (overdue) {
    return {
      fork: "on_order_overdue",
      productId,
      productName: name,
      stock: product.stock,
      po,
      // NO DATE. The one on the PO has already passed, so repeating it is a
      // promise that has already been broken once.
      date: null,
      note:
        `Supply check: ${product.name} is out of stock (${product.stock}). It IS on order (${first.quantity} units, ` +
        `PO ${first.id}) but the expected date has already passed — there is no new date to give until the ` +
        `supplier gives one.`,
    };
  }

  return {
    fork: "on_order",
    productId,
    productName: name,
    stock: product.stock,
    po,
    date: first.expectedAt,
    note:
      `Supply check: ${product.name} is out of stock (${product.stock}). ${first.quantity} units are on order ` +
      `(PO ${first.id}), expected ${first.expectedAt.slice(0, 10)}. That date is the purchase order's, not an estimate.`,
  };
}

// ---------------------------------------------------------------------------
// The lane
// ---------------------------------------------------------------------------

export interface RestockCheckInput {
  caseId: string;
  productId?: string | null;
  conversationId?: string | null;
  customerId?: string | null;
}

export interface RestockCheckOptions {
  client?: StoreClient;
  /** The job row's dedupe key, so a re-leased rerun re-files the SAME report. */
  dedupeKey?: string | null;
  jobId?: string;
}

export interface RestockCheckResult {
  storeId: string;
  at: string;
  caseId: string;
  /** True when nothing needed the founder — the fact went on the case and stopped there. */
  quiet: boolean;
  /** ZERO, always, and asserted as such. See this file's header. */
  modelCalls: number;
  position: SupplyPosition;
  /** How many threads are waiting on this one case. */
  waiting: number;
  /** Did this run append a fact to the case? False when the same fact was already there. */
  factWritten: boolean;
  /** Set when the case fact could not be written — the answer did not land. */
  factFailed?: string;
  /** The founder report, when the run raised a decision. */
  reportId?: string;
  reportFailed?: string;
  /** A real, complete answer: the case was already over. */
  skipped?: string;
  blindSpots: LaneBlindSpot[];
  gaps: LaneGap[];
}

/**
 * Run one restock check for one waiting case.
 *
 * THE RUN PATH; the workflow below is the Studio surface over it.
 *
 * THROWS when the job cannot be done — no `caseId`, no such case, a case of
 * another kind. A throw releases the row with the reason on it. It never
 * completes quietly, and it never writes a supply answer it could not check.
 */
export async function runRestockCheck(
  storeId: string,
  input: RestockCheckInput,
  opts: RestockCheckOptions = {},
): Promise<RestockCheckResult> {
  const client = opts.client ?? storeFor(storeId);
  const at = client.now();
  const blindSpots: LaneBlindSpot[] = [];

  if (!input.caseId) {
    throw new Error(
      `restock_check has no payload.caseId — the producer (mintRestockCheckJob) keys its whole dedupe on the ` +
        `case id, so a row without one is a malformed producer. There is no waiting customer to answer.`,
    );
  }

  // ── GATHER ───────────────────────────────────────────────────────────────
  const caseRow = await client.getCase(input.caseId);
  if (!caseRow) {
    throw new Error(
      `restock_check: case ${input.caseId} does not exist for ${storeId}. The producer writes the job AFTER the ` +
        `case row commits, so a missing case is not a race — refusing to invent a supply answer for a question ` +
        `nobody asked.`,
    );
  }
  if (caseRow.kind !== CASE_KIND) {
    throw new Error(
      `restock_check: case ${input.caseId} is a "${caseRow.kind}" case, not "${CASE_KIND}". This lane answers a ` +
        `supply question; answering a delivery case with a stock position would put the wrong facts on the row ` +
        `that gets quoted to a customer.`,
    );
  }

  const waiting = waitersOn(caseRow, input.conversationId ?? null);

  if (TERMINAL.includes(caseRow.status)) {
    // NOT a failure, and not a lie either: the question is over, so the honest
    // whole response is to write nothing at all.
    return {
      storeId,
      at,
      caseId: caseRow.id,
      quiet: true,
      modelCalls: 0,
      position: supplyPosition({
        product: null,
        purchaseOrders: null,
        productId: input.productId ?? null,
        now: at,
        unknownReason: `the case is already ${caseRow.status}`,
      }),
      waiting,
      factWritten: false,
      skipped: `case ${caseRow.id} is already ${caseRow.status} — nobody is waiting on this answer`,
      blindSpots,
      gaps: [],
    };
  }

  const productId = input.productId ?? null;
  if (!productId) {
    // Legal: the producer defaults `productId` to null, and `NovaCaseView` has
    // no product column to fall back on. Nova cannot check a supply position
    // for a product nobody named — so it says exactly that, on the case, and
    // gives no date.
    blindSpots.push({
      key: "field:product",
      detail:
        "this restock case names no product, so there is nothing to look up — no stock, no purchase order, no date",
    });
  }

  // ── WHY THE LIST AND NOT `getProduct` ────────────────────────────────────
  //
  // `GET /products/:id` is dakio-api's CUSTOMER-SAFE detail read and it strips
  // the stock count on purpose (`productDetailOut`: "the detail read is free to
  // become the customer-safe one"), answering with an `availability` band the
  // `Product` type does not carry. Reading it here produced
  // `is out of stock (undefined)` on the live stack — a sentence bound for a
  // waiting customer, asserting a thing nobody measured. The founder-plane LIST
  // is the read that computes stock across warehouses and variants
  // (`resolveTotalStock`), and this is founder-plane work.
  const [productRead, poRead] = await Promise.all([
    productId ? readOr(() => client.listProducts()) : Promise.resolve(null),
    productId ? readOr(() => client.listPurchaseOrders()) : Promise.resolve(null),
  ]);
  if (productRead && !productRead.ok) {
    blindSpots.push({ key: "read:product", detail: `the catalogue did not answer (${productRead.reason})` });
  }
  const found = productRead?.ok ? (productRead.value.find((p) => p.id === productId) ?? null) : null;
  if (productRead?.ok && !found) {
    blindSpots.push({
      key: "field:product",
      detail: `product ${productId} is on the case but not in the catalogue read — nothing to check`,
    });
  }
  if (found && !Number.isFinite(found.stock)) {
    blindSpots.push({
      key: "field:stock",
      detail: `no stock count came back for ${found.name} — an unreadable count is not a count of zero`,
    });
  }
  if (poRead && !poRead.ok) {
    blindSpots.push({
      key: "read:purchase_orders",
      detail:
        `the purchase orders did not answer (${poRead.reason}) — Nova cannot tell what is on order, and must ` +
        `not answer as though nothing is`,
    });
  }

  const product = found;
  const purchaseOrders = poRead?.ok ? poRead.value : null;

  const position = supplyPosition({
    product,
    purchaseOrders,
    productId,
    now: at,
    unknownReason: blindSpots.map((b) => b.detail).join("; ") || "no product was named on this case",
  });

  // ── WRITE THE ANSWER ONTO THE CASE ───────────────────────────────────────
  //
  // The one write this lane makes, and it does NOT pass the authority gate —
  // for the same reason the pulse's inbox drain does not, and the reason is
  // stated rather than assumed: NO VERB IN `ActionType` EXPRESSES IT and no
  // duty on the roster governs it, so there is nothing for the gate to judge
  // and nothing to perform it under. What it touches is Nova's own working
  // record of a question a customer asked: append-only server-side, no money,
  // no message, nothing a customer sees — the thread only moves when
  // `case_update` composes a reply and passes the ordinary send gate, which is
  // where the founder's level, mode and pause switch still stand. It is
  // surfaced as a `no_verb` capability gap on every run, so the hole is
  // visible rather than implied.
  let factWritten = false;
  let factFailed: string | undefined;
  if (alreadyRecorded(caseRow, position.note)) {
    // A re-leased rerun that finds the same position writes nothing. A rerun
    // that finds a DIFFERENT one writes the new truth, which is what
    // append-only facts are for.
    factWritten = false;
  } else {
    try {
      await client.patchCase(caseRow.id, {
        appendFacts: [
          {
            source: FACT_SOURCE,
            note: position.note,
            data: {
              fork: position.fork,
              stock: position.stock,
              poId: position.po?.id ?? null,
              // The ONLY date that may travel. Null on every other fork.
              expectedAt: position.date,
              waiting,
            },
          },
        ],
      });
      factWritten = true;
    } catch (err) {
      // The answer did not land where the reply is composed from. Not fatal to
      // the run (the founder report below still carries it), but it must not be
      // silent: a case_update composed without this fact answers from the
      // thread alone.
      factFailed = err instanceof Error ? err.message : String(err);
      console.warn(`[restock_check] could not write the supply fact onto case ${caseRow.id}:`, err);
    }
  }

  // ── THE FOUNDER'S DECISION, WHEN THERE IS ONE ────────────────────────────
  const decision = restockDecision(position, waiting);
  const gaps = restockGaps(Boolean(input.conversationId), decision !== null);

  let reportId: string | undefined;
  let reportFailed: string | undefined;
  if (decision) {
    try {
      const report = await client.addReport({
        kind: "custom",
        title: decision.title,
        body: restockBody({ position, waiting, decision, gaps, factWritten, factFailed, jobId: opts.jobId }),
        // A re-leased rerun re-files the SAME row rather than a duplicate.
        dedupeKey: opts.dedupeKey ?? null,
      });
      reportId = report.id;
    } catch (err) {
      reportFailed = err instanceof Error ? err.message : String(err);
      console.error(`[restock_check] could not file the restock report for case ${caseRow.id}:`, err);
    }
  }

  return {
    storeId,
    at,
    caseId: caseRow.id,
    quiet: decision === null,
    modelCalls: 0,
    position,
    waiting,
    factWritten,
    ...(factFailed ? { factFailed } : {}),
    ...(reportId ? { reportId } : {}),
    ...(reportFailed ? { reportFailed } : {}),
    blindSpots,
    gaps,
  };
}

/**
 * How many threads are waiting on this one case.
 *
 * `refs.conversationIds` is the join list dakio-api appends to every time
 * another thread asks about the same product — one case, N askers, which is why
 * the producer mints on the NEW-case edge only. The payload's own conversation
 * is unioned in because a server that predates the ref list still tells us
 * about one waiter, and reporting "0 people are waiting" on a case somebody
 * just opened would be worse than reporting one.
 */
export function waitersOn(caseRow: NovaCaseView, payloadConversationId: string | null): number {
  const ids = new Set<string>(caseRow.refs?.conversationIds ?? []);
  if (caseRow.conversationId) ids.add(caseRow.conversationId);
  if (payloadConversationId) ids.add(payloadConversationId);
  return ids.size;
}

/** Has this exact supply position already been recorded on the case? */
function alreadyRecorded(caseRow: NovaCaseView, note: string): boolean {
  return caseRow.facts.some((f) => f.source === FACT_SOURCE && f.note === note);
}

export interface RestockDecision {
  reason: "several_waiting" | "nothing_on_order";
  title: string;
}

/**
 * Is there something for the FOUNDER here, or is the case fact the whole
 * answer?
 *
 * Two triggers, and each is a decision a person has to make:
 *  · several people waiting for one product — the prompt's own line, "three
 *    customers asking is a restock decision, not a coincidence";
 *  · nothing on order at all — somebody is waiting for stock that nobody has
 *    ordered, which is not a fact that fixes itself.
 *
 * A product already on a purchase order with one person waiting raises NOTHING.
 * That is the quiet, correct case, and a report about it would be the founder's
 * inbox filling with news that the system is working.
 */
export function restockDecision(position: SupplyPosition, waiting: number): RestockDecision | null {
  const name = position.productName ?? position.productId ?? "this product";
  if (waiting >= RESTOCK_DECISION_WAITERS) {
    return {
      reason: "several_waiting",
      title:
        `${waiting} customers are waiting for ${name}` +
        (position.date ? ` — ${position.date.slice(0, 10)} is the only date Nova can give` : " — nothing is on order"),
    };
  }
  if (position.fork === "nothing_on_order") {
    return {
      reason: "nothing_on_order",
      title: `A customer is waiting for ${name} and nothing is on order`,
    };
  }
  return null;
}

/** The report body. Every line traces to something read this run. */
function restockBody(input: {
  position: SupplyPosition;
  waiting: number;
  decision: RestockDecision;
  gaps: LaneGap[];
  factWritten: boolean;
  factFailed?: string;
  jobId?: string;
}): string {
  const { position, waiting, decision, gaps, factWritten, factFailed, jobId } = input;
  const lines: string[] = [
    `**${position.productName ?? position.productId ?? "Unnamed product"}**`,
    `- ${position.note}`,
    `- ${waiting} conversation(s) waiting on this case.`,
  ];
  if (decision.reason === "several_waiting") {
    lines.push(
      `- ${waiting} customers asking about one product is a restock decision, not a coincidence.`,
      "",
    );
  } else {
    lines.push("", `_${RESTOCK_HONESTY}_ Nova told this customer nothing it could not check.`, "");
  }
  lines.push(
    "**What the customer will be told**",
    position.date
      ? `- The purchase order's own date (${position.date.slice(0, 10)}). Nothing was rounded and nothing was added.`
      : `- That it is coming soon, and that they will hear the moment it lands. NO DATE — nothing on order means ` +
        `there is no date to give, and ${RESTOCK_HONESTY.toLowerCase()}`,
    "",
  );
  if (gaps.length > 0) {
    lines.push(
      "**What Nova could not do about it**",
      ...gaps
        .filter((g) => g.kind !== "no_verb")
        .map((g) =>
          g.wantedDuty === null
            ? `- \`${g.verb}\` would answer it, and no duty on your roster covers it.`
            : `- \`${g.verb}\` needs \`${g.wantedDuty}\`, which the restock lane does not hold.`,
        ),
      "",
    );
  }
  lines.push(
    factWritten
      ? "_The supply position above is on the case, so the reply the customer eventually gets is composed from it._"
      : factFailed
        ? `_⚠ The supply position could NOT be written onto the case (${factFailed}) — the reply will be composed without it._`
        : "_The case already carried this exact supply position; nothing was appended twice._",
  );
  if (jobId) lines.push(`_Restock check job ${jobId}._`);
  return lines.join("\n");
}

/**
 * The two things this lane wants and may not do, plus the one it does that
 * nothing governs.
 *
 * All three are surfaced every run, because each of them is otherwise an
 * ABSENCE — and an absence is indistinguishable from a bug.
 */
function restockGaps(hasThread: boolean, raisedDecision: boolean): LaneGap[] {
  const gaps: LaneGap[] = [];
  if (hasThread) {
    const reply = classifyRemedy(
      KIND,
      "send_inbox_reply",
      "The answer is on the case; telling the customer is the `case_update` lane's work, on their own thread, " +
        "through the ordinary send gate. Two lanes answering one waiting customer is one customer told twice.",
    );
    if (reply) gaps.push(reply);
  }
  if (raisedDecision) {
    const po = classifyRemedy(
      KIND,
      "create_purchase_order",
      "The restock DECISION is the founder's; `night_ops` holds the drafting duty. This lane raises the " +
        "decision and does not draft the order — a PO drafted by a lane whose whole input is one waiting " +
        "customer is a supply decision made from a sample of one.",
    );
    if (po) gaps.push(po);
  }
  gaps.push({
    kind: "no_verb",
    verb: "record_case_fact",
    wantedDuty: null,
    reason:
      "Writing what Nova learned onto a case has NO verb in `ActionType` and no duty on the roster, so it " +
      "cannot pass the authority gate and the founder has no switch for it. It is append-only, touches no " +
      "money and sends no message — the send gate still stands between it and the customer — but the hole is " +
      "real and this is where it is recorded.",
  });
  return gaps;
}

// ---------------------------------------------------------------------------
// The Studio surface
// ---------------------------------------------------------------------------

const restockStep = createStep({
  id: "restock-check",
  inputSchema: z.object({
    storeId: z.string().optional().describe("Tenant id; defaults to NOVA_DEV_STORE_ID"),
    caseId: z.string().describe("The restock_wait case a customer is waiting on"),
    productId: z.string().optional(),
    conversationId: z.string().optional(),
  }),
  outputSchema: z.object({
    quiet: z.boolean().describe("true = the fact went on the case and no founder decision was raised"),
    modelCalls: z.number().describe("Always 0 — the honesty fork is arithmetic, not judgement"),
    fork: z.string(),
    date: z.string().nullable().describe("Only ever a purchase order's own date; null on every other fork"),
    waiting: z.number(),
    factWritten: z.boolean(),
    reportId: z.string().optional(),
    skipped: z.string().optional(),
    blindSpots: z.array(z.object({ key: z.string(), detail: z.string() })),
    gaps: z.array(z.object({ verb: z.string(), kind: z.string(), wantedDuty: z.string().nullable() })),
  }),
  execute: async ({ inputData }) => {
    const storeId = inputData.storeId || process.env.NOVA_DEV_STORE_ID;
    if (!storeId) throw new Error("storeId required (or set NOVA_DEV_STORE_ID)");
    const result = await runRestockCheck(storeId, {
      caseId: inputData.caseId,
      productId: inputData.productId ?? null,
      conversationId: inputData.conversationId ?? null,
    });
    return {
      quiet: result.quiet,
      modelCalls: result.modelCalls,
      fork: result.position.fork,
      date: result.position.date,
      waiting: result.waiting,
      factWritten: result.factWritten,
      ...(result.reportId ? { reportId: result.reportId } : {}),
      ...(result.skipped ? { skipped: result.skipped } : {}),
      blindSpots: result.blindSpots,
      gaps: result.gaps.map((g) => ({ verb: g.verb, kind: g.kind, wantedDuty: g.wantedDuty })),
    };
  },
});

/**
 * The lane as a Mastra workflow: the id `registry.ts` names, and the surface an
 * operator (or Studio) can run one check from.
 *
 * NO SCHEDULE — event-driven, minted by dakio-api when a `restock_wait` case
 * opens. The brain has one clock and this is not it.
 */
export const restockCheckWorkflow = createWorkflow({
  id: "brain-restock-check",
  description:
    "A customer is waiting for stock: find what is ACTUALLY on order (open purchase orders, real supply position), write it onto the case in facts, and raise a restock decision when several customers are waiting. Never invents a date — zero model calls, because the honesty fork is arithmetic.",
  inputSchema: restockStep.inputSchema,
  outputSchema: restockStep.outputSchema,
})
  .then(restockStep)
  .commit();
