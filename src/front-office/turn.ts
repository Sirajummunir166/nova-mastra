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
import { isNextAction, nextBestAction, type NextAction } from "./nba.js";
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
import { storeFor } from "../store/resolve.js";
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

/* ───────────────────────────────────────────────────────────────────────────
 * THE INSTRUCTION SEAM — Nova's own words are not the customer's
 * (phase E spec §B, problem 2: "do not paper over it")
 *
 * `runCustomerTurn(storeId, convId, message)` takes CUSTOMER SPEECH. The three
 * conversation-bound job kinds are not that:
 *
 *   inbox_reply  "re-read the unprocessed events on this thread and reply"
 *   followup     "a promise you made is coming due — pay it off"
 *   case_update  "case X moved; tell them what happened"
 *
 * Those are instructions TO a turn. Passing one as `message` — the shortcut the
 * spec names — would hand Nova's own sentence to `classifyL0`/the resolver as
 * if the customer had typed it. The damage is not cosmetic: "A promise you made
 * on this conversation is coming due" contains no product, no size, no zone and
 * no confirm, so L0 misses, the paid resolver runs on Nova's own prose, and the
 * NBA ladder then plans the next customer step from an intent the customer never
 * expressed. It would also be PUSHED INTO `ctx.recent` as `role: "customer"`,
 * i.e. written into the durable thread state as something the customer said —
 * which every later turn, every state card and every escalation brief would
 * then read back as fact.
 *
 * ── WHY A SECOND ENTRY POINT, NOT AN `instruction` FIELD ON `TurnOptions` ────
 *
 * Both were on the table. `runInstructedTurn` won on three counts:
 *
 * 1. THE SIGNATURE STOPS THE MISTAKE. An options field leaves
 *    `runCustomerTurn(store, conv, "pay off promise p_1")` a legal call that
 *    type-checks and silently does the wrong thing. `runInstructedTurn` has no
 *    `message` parameter AT ALL — the customer's words are not the caller's to
 *    supply, because the seam re-reads them from the store itself. A wrong call
 *    is not available to write.
 * 2. THE CUSTOMER TEXT COMES FROM A DIFFERENT PLACE. A live turn is handed the
 *    message by the ingress (dakio-api just delivered it). An instructed turn
 *    must RE-READ the thread — nova-ai's ids-only discipline: content never
 *    rides the job bus, because what a job carries is what was true when the
 *    job was minted, and the whole point of re-reading is that the world moved.
 *    That is a different data flow, not a different flag on the same one.
 * 3. THE OUTCOME CONTRACT DIFFERS. A live turn always owes an answer. An
 *    instructed turn may legitimately end in SILENCE (an NBA nudge that finds
 *    nothing worth saying) or in NO TURN AT ALL (a promise whose debt is gone).
 *    `TurnResult.silent`/`skipped` exist for that, and only this entry point
 *    can produce them.
 *
 * What the instruction is allowed to do, exactly:
 *   • it decides WHAT THE TURN IS FOR (the ACTION label the writer is briefed
 *     with, when Nova is the one opening its mouth);
 *   • it reaches the writer prompt as a clearly-fenced NOVA'S OWN DIRECTIVE
 *     block, never inside the LAST MESSAGES transcript;
 *   • it is NEVER classified, never language-detected, never pushed into
 *     `ctx.recent`, and never counted as a customer turn.
 *
 * SHADOW STILL HOLDS. An instructed turn inherits the same default (`shadow`)
 * and the same gates: the order gate is unreachable in shadow, the hand-over
 * gate is unreachable in shadow, and nothing in this file has ever sent a
 * message to a customer in either mode — this lane DRAFTS (phase C/D). An
 * instructed turn therefore writes nothing a live one would not.
 * ─────────────────────────────────────────────────────────────────────────── */

/** The three conversation-bound job kinds — the only things that may instruct a turn. */
export type InstructedJobKind = "inbox_reply" | "followup" | "case_update";

/**
 * The sub-mode, which is finer than the kind because `followup` carries three
 * different jobs of work behind one row (nova-ai Stage 10 modules 03/04/05):
 *
 *   promise        — Nova owes a specific answer at a specific time. Pre-checked
 *                    by the router: if the debt is gone there is no turn at all.
 *   cart_recovery  — the ONLY seam that carries a payload snapshot (the basket),
 *                    because ids-only would leave the model unable to name the
 *                    item and "you left something in your cart" is a blast.
 *   nba_nudge      — Nova owes NOTHING. Silence is a legitimate outcome.
 */
export type InstructedTurnMode =
  | "inbox_reply"
  | "promise"
  | "cart_recovery"
  | "nba_nudge"
  | "case_update";

/**
 * The four action labels that exist ONLY because Nova opened its own mouth.
 * Each is the meaning of one `InstructedTurnMode` — see `ACTION_FOR_MODE`.
 */
export type InstructedAction = "PAY_PROMISE" | "CART_NUDGE" | "NBA_NUDGE" | "CASE_UPDATE";

/**
 * The ONE action each Nova-speaks-first mode means. `inbox_reply` is absent on
 * purpose: it IS a customer turn, so the deterministic ladder picks its move and
 * the instruction's label is never read.
 */
const ACTION_FOR_MODE: Record<Exclude<InstructedTurnMode, "inbox_reply">, InstructedAction> = {
  promise: "PAY_PROMISE",
  cart_recovery: "CART_NUDGE",
  nba_nudge: "NBA_NUDGE",
  case_update: "CASE_UPDATE",
};

const INSTRUCTED_MODES: ReadonlySet<string> = new Set<InstructedTurnMode>([
  "inbox_reply",
  "promise",
  "cart_recovery",
  "nba_nudge",
  "case_update",
]);

/**
 * The two actions that reach a dakio-api MUTATION (`hardValidateAndCreate` →
 * `create_order_from_chat`, and `performFlagHandover` → `escalate_conversation`).
 * An instruction may never name either — see `validateInstructedAction`.
 */
const WRITE_ACTIONS: ReadonlySet<string> = new Set<NextAction>(["CREATE_ORDER", "ESCALATE"]);

export interface TurnInstruction {
  jobKind: InstructedJobKind;
  mode: InstructedTurnMode;
  /**
   * Nova's own directive, in Nova's own voice. Rendered to the writer under its
   * own fenced heading; never classified, never stored as customer speech.
   */
  directive: string;
  /**
   * The ACTION label the writer is briefed with WHEN NOVA SPEAKS FIRST (no new
   * customer message to answer). When there IS fresh customer text, the
   * deterministic NBA ladder decides the action exactly as on the live lane —
   * an instruction may say what a turn is for, never what the customer needs.
   *
   * TYPED AS `string` ON PURPOSE, and validated at the seam
   * (`validateInstructedAction`): this field is filled from a JOB PAYLOAD, i.e.
   * from outside this process, where a union buys nothing at all. The closed set
   * it is checked against is `NEXT_ACTIONS` ∪ the four instructed labels, minus
   * the two write actions.
   */
  action: string;
  /**
   * Does someone expect an answer? `false` ⇒ a turn that says nothing is a
   * SUCCESS, not a failure — the NBA-nudge contract.
   */
  owesReply: boolean;
  /** ids-only: the inbound messages that triggered this job (inbox_reply). */
  messageIds?: string[];
  /** Audit/observability only — never authorization. */
  jobId?: string;
  /**
   * WHICH debt this turn is meant to pay (`mode: "promise"`). An id ALONE does
   * not say which thread it is owed on, which is why {@link TurnInstruction.promise}
   * exists — see `assertPromiseOwedHere`.
   */
  promiseId?: string;
  /**
   * THE PROMISE ROW ITSELF, as the router read it — the thing an id cannot be.
   *
   * `conversationId` is the field that matters: a promise is a debt owed to a
   * person ON A THREAD, and a job that pairs promise P with conversation B pays
   * A's debt into B's thread. The router's guard rail only checks that SOME
   * conversationId is present on the payload; the row's own is the one that
   * decides. Supply it and the seam enforces it without a second read; omit it
   * and the seam reads the promise back itself (a fallback, not the contract).
   */
  promise?: { id: string; conversationId: string | null };
}

export interface TurnResult {
  reply: string;
  intent: Intent;
  rung: 0 | 1;
  action: NextAction | InstructedAction | "ORDER_CONFIRMED" | "ORDER_PENDING_APPROVAL";
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

  /* ── Instructed turns only (`runInstructedTurn`) ─────────────────────────── */
  /** What asked for this turn, and what the classifier actually saw. */
  instructed?: {
    jobKind: InstructedJobKind;
    mode: InstructedTurnMode;
    jobId?: string;
    owesReply: boolean;
    /**
     * The customer's latest inbound as re-read from the store — `null` when
     * Nova opened its own mouth (nothing new to classify). NEVER the directive.
     */
    classifiedInbound: string | null;
  };
  /**
   * The turn deliberately produced no customer-visible words. Only an honest
   * answer when `instructed.owesReply` is false, or when the thread is locked.
   */
  silent?: boolean;
  /** The turn did nothing at all — and spent no model call doing it. */
  skipped?: "no_inbound" | "already_answered" | "thread_locked";
}

/* ── At-most-once keys — ONE derivation per verb ────────────────────────────
 *
 * Shadow and live must agree on the key or the shadow dataset is a record of a
 * write the live path would never have made. They drifted once already: the
 * shadow branch counted `ctx.orders.length` while `hardValidateAndCreate`
 * counted `ctx.orders.length + ctx.pendingOrders.length`, so the moment one
 * order was awaiting the founder every shadow row named a `novaActionId` that
 * belonged to an order already on the desk. These two functions are the only
 * place either key is spelled, so the halves cannot drift again.
 *
 * THE EPOCH RIDES IN THE KEY. dakio-api's session roll partitions the context
 * store (`context-store.ts`: the epoch is part of the primary key, and a rolled
 * conversation loads a FRESH context). Without it here, a rolled thread starts
 * counting orders from zero again and its first new order replays the previous
 * session's row — and a thread handed back by the founder could never escalate
 * a second time, because `nm:<conv>:handover` was constant for the life of the
 * conversation. The suffix is omitted at epoch 0, mirroring `fileFor()` in the
 * context store, so keys already in ledgers keep matching.
 *
 * ── ONE EPOCH, AND NO WAY TO PASS A SECOND ────────────────────────────────
 *
 * The first version of this fix moved both halves onto one helper and left the
 * divergence where it started: `executeTurn` held TWO values that mean the same
 * thing — its `epoch` parameter (the ingress's, used for the storage partition
 * and reported on the result) and `ctx.epoch` (used to mint every key) — and
 * nothing ever compared them. On top of that the helper read `ctx.epoch ?? 0`,
 * so a context that reached a key function without the field minted the
 * EPOCH-0 key in silence: the exact collision the epoch was added to prevent,
 * on a rolled thread, replaying the previous session's row.
 *
 * Both holes are closed the same way. The key functions take the CONTEXT and
 * nothing else — there is no overload, and no argument, through which a caller
 * could offer a different epoch — and `epochOf` refuses a context that has no
 * usable one rather than defaulting. `executeTurn` stamps the ingress epoch
 * onto the context once, before any key can be minted, and reads `ctx.epoch`
 * everywhere after that, so the function no longer holds a second copy.
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * THE epoch a key is minted under. One field, one reader, no default.
 *
 * A context with no usable epoch is a storage bug, and the two ways of coping
 * with it are not equal: minting the epoch-0 key REPLAYS another session's row
 * (a customer who cannot order, a thread that can never reach a human twice),
 * while refusing is one loud failed turn. It refuses.
 */
function epochOf(ctx: NovaLiveContext): number {
  const epoch = ctx.epoch;
  if (!Number.isInteger(epoch) || epoch < 0) {
    throw new Error(
      `nova key: conversation ${ctx.convId} has no usable session epoch (${String(epoch)}) — ` +
        "an at-most-once key minted without one silently replays another session's row",
    );
  }
  return epoch;
}

function epochSuffix(ctx: NovaLiveContext): string {
  const epoch = epochOf(ctx);
  return epoch > 0 ? `:e${epoch}` : "";
}

/**
 * Bind the context to the epoch the ingress asked for, before any key exists.
 *
 * The epoch is part of the context store's PRIMARY KEY, so a context loaded for
 * partition N is partition N's by construction and this is an assertion made
 * true rather than a value chosen. A context that disagrees came from somewhere
 * that cannot be reasoned about, and minting keys under either value would be a
 * guess — so that is the one case that throws.
 */
function bindEpoch(ctx: NovaLiveContext, epoch: number): void {
  if (ctx.epoch === undefined || ctx.epoch === null) {
    ctx.epoch = epoch;
    return;
  }
  if (ctx.epoch !== epoch) {
    throw new Error(
      `nova turn: conversation ${ctx.convId} was loaded for epoch ${epoch} but its state carries epoch ` +
        `${String(ctx.epoch)} — the context store returned the wrong session partition`,
    );
  }
}

/**
 * The Nth chat order of this conversation. Placed AND pending both count: a
 * second product sold while the first awaits approval must mint a fresh key
 * rather than dedupe into the first.
 */
export function orderActionKey(ctx: NovaLiveContext): string {
  return `nm:${ctx.convId}${epochSuffix(ctx)}:order-${ctx.orders.length + (ctx.pendingOrders?.length ?? 0)}`;
}

/**
 * One hand-over per conversation PER SESSION.
 *
 * Constant within a session, so a redelivered turn dedupes; advanced by the
 * session roll, so a thread the founder answered and handed back can be
 * escalated again. dakio-api's one-open-card rule still dedupes inside a
 * session — `handoverConversation` answers `alreadyEscalated` rather than
 * raising a second card.
 */
export function handoverActionKey(ctx: NovaLiveContext): string {
  return `nm:${ctx.convId}${epochSuffix(ctx)}:handover`;
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

/**
 * One turn on a customer thread that NOVA asked for — the entry point the three
 * conversation-bound job kinds use. See the seam block above `TurnInstruction`
 * for why this is a separate function and not a flag.
 *
 * There is no `message` parameter on purpose: the customer's latest inbound is
 * RE-READ from the store here (`getInboxConversation`, the same read the shadow
 * ingress uses), because ids-only means the job row cannot be trusted to carry
 * what was said — only which thread it was said on.
 */
export async function runInstructedTurn(
  storeId: string,
  convId: string,
  instruction: TurnInstruction,
  opts: TurnOptions = {},
): Promise<TurnResult> {
  // THE BOUNDARY CHECK, before a lock is taken, a thread is read or a model is
  // paid: everything on `instruction` came from a job payload, and the two
  // fields that can select real-world consequences (the action label and the
  // promise this turn claims to be paying) are checked here or nowhere.
  const action = validateInstructedAction(instruction);
  if (instruction.mode === "promise") await assertPromiseOwedHere(storeId, convId, instruction);

  const mode: TurnMode = opts.mode ?? "shadow";
  // The epoch is READ, never computed (Stage 11 discipline, same as the shadow
  // ingress): dakio-api's session roll partitions the persisted context, and a
  // turn that guessed 0 on a rolled thread would mint at-most-once keys that
  // replay the previous session's rows. `getSessionEpoch` answers 0 rather than
  // throwing on an unreachable server; the catch covers a client that does not.
  const epoch =
    Number.isFinite(opts.epoch) && (opts.epoch as number) > 0
      ? Math.floor(opts.epoch as number)
      : await storeFor(storeId)
          .getSessionEpoch(convId)
          .catch(() => 0);

  const inbound = await readLatestInbound(storeId, convId, instruction.messageIds);
  return withTurnLock(storeId, convId, () =>
    executeTurn(storeId, convId, inbound.text, mode, epoch, { instruction, inbound, action }),
  );
}

/** What an instructed turn carries into `executeTurn` beyond the customer text. */
interface InstructedInput {
  instruction: TurnInstruction;
  inbound: { text: string; ids: string[] };
  /** The VALIDATED action label — the only one `executeTurn` may read. */
  action: NextAction | InstructedAction;
}

/* ── D1: the action label is data from a job, so it is validated like data ───
 *
 * `instruction.action` used to be cast (`as NextAction`) straight into the
 * variable that drives BOTH write gates. A typo'd or hostile label therefore
 * selected a write path with nothing in between: `CREATE_ORDER` walked into the
 * order gate (live: a real dakio-api order, or a prepared card on the founder's
 * desk; shadow: a `create_chat_order` row minted under this conversation's own
 * at-most-once key), and `ESCALATE` walked into the hand-over gate, which locks
 * the thread for the rest of the epoch and raises a card for a human.
 *
 * ── MAY AN INSTRUCTED TURN SELECT THE ORDER GATE AT ALL? NO. ────────────────
 *
 * A job saying "place the order" and a customer saying "hae" are not the same
 * trust statement, and the gate is built on the second one. Everything it sends
 * to dakio-api asserts the customer: the payload's `confirmedByCustomer: true`,
 * the receipt's "customer replied yes to the final order summary", the
 * conversation-sourced evidence row. A job payload can assert none of that — it
 * knows only that some scheduler woke up. Worse, the ladder-side precondition
 * (`intent === "confirm" && ctx.purchase.confirmSent`) is exactly what the
 * instructed path SKIPS: on a Nova-speaks-first turn the label bypasses
 * `nextBestAction`, so an instruction naming CREATE_ORDER is an order placed
 * with no summary presented and no confirmation given.
 *
 * The same holds one gate over: an instruction naming ESCALATE would hand a live
 * thread to a person, and mute Nova on it, because a job payload said so.
 *
 * What this does NOT touch: an `inbox_reply` turn IS a customer turn, and the
 * ladder may still decide CREATE_ORDER or ESCALATE from the customer's own
 * re-read words. That decision comes from `nextBestAction` on customer speech,
 * which is precisely the trust statement the gate is built on.
 */
function validateInstructedAction(instruction: TurnInstruction): NextAction | InstructedAction {
  const { mode, action } = instruction;
  if (!INSTRUCTED_MODES.has(mode)) {
    throw new Error(
      `nova instructed turn: unknown instruction mode ${JSON.stringify(mode)} — the seam accepts only ` +
        `${[...INSTRUCTED_MODES].join(" | ")}`,
    );
  }
  if (typeof action !== "string" || action.length === 0) {
    throw new Error(`nova instructed turn: instruction (mode ${mode}) carries no action label`);
  }
  if (WRITE_ACTIONS.has(action)) {
    throw new Error(
      `nova instructed turn: an instruction may not select the write action ${action} — ` +
        "a job asking for it is not a customer confirming one, and the gate's whole safety argument " +
        "is the customer's own words (see the note above `validateInstructedAction`)",
    );
  }
  if (mode === "inbox_reply") {
    // The label is a fallback name only — the ladder decides this lane's move —
    // but an unknown string in a field this file reads is still a bug worth
    // failing on rather than carrying.
    if (!isNextAction(action)) {
      throw new Error(
        `nova instructed turn: inbox_reply carries action ${JSON.stringify(action)}, which is not a known action`,
      );
    }
    return action;
  }
  const expected = ACTION_FOR_MODE[mode];
  if (action !== expected) {
    throw new Error(
      `nova instructed turn: mode ${mode} means ${expected}, but the instruction carries ` +
        `${JSON.stringify(action)} — the mode names the work, and the label may not disagree with it`,
    );
  }
  return expected;
}

/* ── D3: a promise is paid on the thread it is owed on, or not at all ───────
 *
 * The router's guard rail checks that the follow-up payload HAS a
 * conversationId. That stops the worst version (a promise answered into the
 * founder's own chat) and misses the one underneath it: the `InboxPromise` row
 * carries its OWN `conversationId`, and nothing compared the two. A job pairing
 * promise P (owed on thread A) with conversation B therefore pays A's debt into
 * B's thread — the exact failure the guard rail exists to prevent, one level
 * deeper.
 *
 * THE CONTRACT THIS SEAM WANTS (and what it does without it):
 *
 *   • `instruction.promise` — the promise ROW the router already read when it
 *     asked "is this debt still open?" (`promiseStillOpen` iterates the rows and
 *     throws the matched one away). Supplied, this is authoritative and free:
 *     `promise.conversationId` must equal the conversation being turned on.
 *   • Absent, this reads the open list back itself. That read is best-effort by
 *     nature — one page, and a shop may hold more open promises than a page —
 *     so a promise NOT on the page is unverifiable rather than wrong, and the
 *     turn proceeds with a loud warning naming the missing contract. What is
 *     never allowed is the case the read CAN see: a row that names another
 *     thread, which throws.
 */
async function assertPromiseOwedHere(
  storeId: string,
  convId: string,
  instruction: TurnInstruction,
): Promise<void> {
  const promiseId = instruction.promiseId ?? instruction.promise?.id;
  if (!promiseId) {
    throw new Error(
      `nova instructed turn: a promise turn on conversation ${convId} names no promise — ` +
        "'pay off the promise' with no promise identifies no debt on any thread",
    );
  }

  const refuse = (owedOn: string | null): never => {
    throw new Error(
      `nova instructed turn: promise ${promiseId} is owed on conversation ${owedOn ?? "(none)"} but this turn ` +
        `runs on ${convId} — paying one thread's debt into another's is the failure the router's ` +
        "conversation guard rail exists to prevent",
    );
  };

  const verified = instruction.promise;
  if (verified) {
    if (verified.id !== promiseId) {
      throw new Error(
        `nova instructed turn: instruction names promise ${promiseId} but carries the row for ` +
          `${verified.id} — one of the two is about a debt this turn is not paying`,
      );
    }
    if (verified.conversationId !== convId) refuse(verified.conversationId);
    return;
  }

  let row: { id: string; conversationId: string | null } | undefined;
  try {
    const open = await storeFor(storeId).listPromises({ status: "open", limit: PROMISE_SCAN_LIMIT });
    row = open.find((p) => p.id === promiseId);
  } catch (err) {
    console.warn(`[nova:turn] promise read failed for ${storeId}/${promiseId}:`, err);
  }
  if (row) {
    if (row.conversationId !== convId) refuse(row.conversationId);
    return;
  }
  console.warn(
    `[nova:turn] promise ${promiseId} could not be verified against conversation ${convId}: the caller ` +
      "supplied no `instruction.promise` row and the open-promise page did not contain it — " +
      "wire the router to pass the row it already read",
  );
}

/** One page of open promises, the same bound the router's own check uses. */
const PROMISE_SCAN_LIMIT = 50;

/**
 * The customer's latest inbound, read back from dakio-api's own thread view.
 *
 * `messageIds` (inbox_reply's payload) narrows to the exact batch the job was
 * minted for; if none of those ids are on the thread — the read failed, the
 * batch aged out of the 50-message window, Meta deleted them — the fallback is
 * the LATEST inbound rather than nothing, because "what is the customer waiting
 * on" is answered by the thread, and a turn that classified nothing would plan
 * from an empty state card.
 *
 * A failed read yields empty text, which the caller treats as "no customer
 * words" — never as an excuse to classify the directive.
 */
async function readLatestInbound(
  storeId: string,
  convId: string,
  messageIds?: string[],
): Promise<{ text: string; ids: string[] }> {
  let inbound: Array<{ id: string; text: string }> = [];
  try {
    const thread = await storeFor(storeId).getInboxConversation(convId, { messages: 50 });
    inbound = (thread?.messages ?? [])
      .filter((m) => m.direction === "in" && typeof m.text === "string" && m.text.length > 0)
      .map((m) => ({ id: m.id, text: m.text as string }));
  } catch (err) {
    console.warn(`[nova:turn] thread read failed for ${storeId}/${convId}:`, err);
    return { text: "", ids: [] };
  }
  if (messageIds?.length) {
    const wanted = new Set(messageIds);
    const picked = inbound.filter((m) => wanted.has(m.id));
    if (picked.length > 0) {
      return { text: picked.map((m) => m.text).join("\n"), ids: picked.map((m) => m.id) };
    }
  }
  const last = inbound.at(-1);
  return last ? { text: last.text, ids: [last.id] } : { text: "", ids: [] };
}


/* ── D6: what "this thread already answered that" actually means ────────────
 *
 * The ids `readLatestInbound` collected were threaded in and then dropped, and
 * the staleness test fell back to comparing TEXT with the last customer line.
 * Text is not identity: a customer who types "hello", gets an answer, and types
 * "hello" again has sent TWO messages, and the second one was being skipped as
 * "already answered" — a lost customer message on the very lane that exists so
 * no customer message is lost.
 *
 * So: when the job carried ids AND this thread has an id-stamped customer line
 * to compare them against, the ids decide — a batch is absorbed only if every
 * id in it is. Otherwise (the live lane wrote the line, and the live ingress is
 * handed text without an id) the text comparison stands, which is what keeps a
 * fallback `inbox_reply` for a message the live lane already answered a free
 * no-op.
 */
function threadHasAbsorbed(ctx: NovaLiveContext, message: string, ids: string[]): boolean {
  const absorbed = new Set<string>();
  for (const m of ctx.recent) {
    if (m.role !== "customer") continue;
    for (const id of m.ids ?? []) absorbed.add(id);
  }
  if (ids.length > 0 && absorbed.size > 0) return ids.every((id) => absorbed.has(id));
  return [...ctx.recent].reverse().find((m) => m.role === "customer")?.text === message;
}

async function executeTurn(
  storeId: string,
  convId: string,
  message: string,
  mode: TurnMode,
  epoch: number,
  instructed?: InstructedInput,
): Promise<TurnResult> {
  const t0 = Date.now();
  const timings: Record<string, number> = { receivedAt: t0 };
  let modelCalls = 0;
  let modelFailure: string | undefined;
  let wouldHaveDone: Record<string, unknown> | undefined;

  await primeContext(storeId, convId, epoch);
  const ctx = loadContext(storeId, convId, "chat", epoch);
  // From here on `ctx.epoch` is THE epoch — the parameter is not read again, so
  // the two halves of the turn cannot mint keys under different ones.
  bindEpoch(ctx, epoch);
  timings.stateLoadedMs = Date.now() - t0;

  const store = await getStoreProfile(storeId);
  if (!store) throw new Error(`store ${storeId} unavailable from dakio-api`);
  if (store.status !== "active") throw new Error(`store ${storeId} is not active`);

  // Before anything reads the state: an order card the founder answered days
  // ago is not "awaiting confirmation" any more, and this is the only moment
  // anything looks (see `reconcilePendingOrders`).
  await reconcilePendingOrders(ctx);

  /* ── Whose turn is this, really? ──────────────────────────────────────────
   *
   * A live delivery is always the customer's turn: dakio-api just handed us the
   * words. An INSTRUCTED turn re-read the thread, and what it holds depends on
   * the kind:
   *
   *   inbox_reply            IS a customer turn — the same message the live lane
   *                          would have delivered, arriving by the job bus
   *                          because delivery failed. Same builder, same ladder.
   *   followup / case_update NOVA SPEAKS FIRST. The customer's latest inbound is
   *                          CONTEXT (what they last wanted, in their own
   *                          words) — it is not a new turn, it was answered
   *                          already, and re-answering it is not what this job
   *                          asked for.
   *
   * `treatAsCustomerTurn` gates the four things only a real, unanswered customer
   * message may do: enter `ctx.recent` as a customer line, move the language
   * preference, apply its entity DELTA to the state, and be worth the paid L1
   * resolver. It never gates CLASSIFICATION itself — the customer's latest
   * inbound is always what gets classified, and the directive never is.
   *
   * The staleness test is the thread state, not a timestamp — see
   * `threadHasAbsorbed` for what "already seen" means and why message IDS
   * decide it whenever they are known. */
  const isNewToThread = message.length > 0 && !threadHasAbsorbed(ctx, message, instructed?.inbound.ids ?? []);
  const novaSpeaksFirst = !!instructed && instructed.instruction.mode !== "inbox_reply";
  const treatAsCustomerTurn = !instructed || (!novaSpeaksFirst && isNewToThread);

  if (instructed && instructed.instruction.mode === "inbox_reply" && !isNewToThread) {
    // D7 — the fallback lane's cheap no-op. `inbox_reply` exists so no customer
    // message is lost when live delivery fails; if the live lane got there
    // first (or an earlier attempt of this same job did), there is nothing to
    // answer. Not a failure, and not worth a model call.
    return skippedTurn(ctx, mode, instructed, message.length === 0 ? "no_inbound" : "already_answered", t0);
  }

  if (treatAsCustomerTurn) {
    // The ids ride WITH the line when they are known (the instructed lane
    // re-read the thread and holds them), so the next turn can tell "the same
    // message again" from "the same words again" — see `threadHasAbsorbed`.
    const ids = instructed?.inbound.ids ?? [];
    pushMessage(ctx, { role: "customer", text: message, at: t0, ...(ids.length > 0 ? { ids } : {}) });

    // Language: detected every turn; preference only moves with a customer
    // reason, and an EXPLICIT request locks it until another explicit request.
    // Nova's own directive is deliberately NOT run through this — a directive is
    // written in English and would flip a Bangla thread to English replies.
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
  }

  // Hard lock after handover: the thread belongs to a person now. One line of
  // silence, no model spend (register R14/R19 — never re-greet, never retry).
  //
  // An INSTRUCTED turn obeys the same lock, and it matters more here: a
  // follow-up, a cart nudge or a case update firing into a thread a human took
  // over is Nova talking over its own colleague. `skipped: "thread_locked"`
  // says so, so the dispatcher completes the job truthfully instead of
  // recording a reply that was never owed.
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
      // `ctx.epoch`, not the parameter: one epoch per turn, and it is the one
      // every key was minted under.
      epoch: ctx.epoch,
      modelCalls,
      ...(instructed
        ? { instructed: instructedStamp(instructed, null), silent: true, skipped: "thread_locked" as const }
        : {}),
    };
  }

  // ---- Classify: L0 rules, else L1 resolver --------------------------------
  //
  // WHAT GETS CLASSIFIED IS THE CUSTOMER'S LATEST INBOUND — always, and only.
  // The directive is never handed to `classifyL0` or to the resolver: it is
  // Nova's own sentence, and classifying it would put an intent the customer
  // never expressed into the state, the state card and every later turn.
  //
  // With no inbound at all (a thread where the customer has said nothing that
  // survives, or a failed read) there is simply nothing to classify — and the
  // honest floor is `other`/rung 0, NOT "classify whatever text is around".
  //
  // The paid L1 resolver runs only for a real, unanswered customer message.
  // Spending it to re-read a message a previous turn already answered would buy
  // nothing: the state it would produce is the state that turn already applied.
  const awaiting = ctx.purchase.confirmSent ? "confirm" : ctx.conversation.nextAction === "ASK_QTY" ? "qty" : null;
  let classified: Classified | null =
    message.length > 0 ? classifyL0(message, { awaiting }) : { intent: "other", entities: {}, rung: 0, confidence: 0 };
  if (!classified && !treatAsCustomerTurn) {
    classified = { intent: "other", entities: {}, rung: 0, confidence: 0 };
  }
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
  //
  // ONLY FOR A MESSAGE THIS THREAD HAS NOT ALREADY ABSORBED. When Nova speaks
  // first, the inbound above was classified for CONTEXT — its entities were
  // applied by the turn that answered it, and re-applying them here would
  // re-fire the side effects: `confirmSent = false` voids a summary the
  // customer is looking at, and a re-read `qty` writes a "qty corrected" memo
  // for a correction nobody made.
  const e = treatAsCustomerTurn ? classified.entities : {};
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
  if (treatAsCustomerTurn && classified.intent === "buy_intent" && ctx.products.focusId) {
    ctx.products.tracked[ctx.products.focusId] = "wants_to_buy";
  }

  // Product resolution — when the message names a product (or nothing is focused).
  const wantsProduct =
    treatAsCustomerTurn &&
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
  //
  // WHO PICKS THE MOVE. When the customer is the one who spoke — a live turn or
  // an `inbox_reply`, which IS a customer turn that came in by the job bus
  // instead of the delivery POST — the deterministic NBA ladder decides, exactly
  // as nova-ai routes that kind through the same builder as the live lane. When
  // NOVA opened its own mouth (a follow-up, a nudge, a case update), the ladder
  // has no question to answer, so the INSTRUCTION names what the turn is for:
  // PAY_PROMISE / CART_NUDGE / NBA_NUDGE / CASE_UPDATE.
  //
  // The instructed label is `instructed.action` — the one `runInstructedTurn`
  // VALIDATED against the closed set at the seam — never `instruction.action`,
  // which is raw payload data and may name a write gate or nothing at all.
  let action: NextAction | InstructedAction = novaSpeaksFirst
    ? instructed!.action
    : nextBestAction(ctx, classified.intent);

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
  /**
   * What the hand-over gate actually did, when it ran. `undefined` means it did
   * not run (shadow, or no ESCALATE this turn) — which is NOT the same as
   * "blocked", and the writer instruction below depends on the difference.
   */
  let handoverOutcome: "executed" | "blocked" | undefined;
  /** True when this turn's ESCALATE came from the order gate refusing, not from
   *  the customer asking — it decides the escalation reason below. */
  let orderGateBlocked = false;
  if (action === "CREATE_ORDER") {
    if (mode === "shadow") {
      wouldHaveDone = {
        type: "create_chat_order",
        // The SAME derivation the live path uses (`hardValidateAndCreate`) —
        // a shadow row that named a different key would be a record of a write
        // live never makes.
        novaActionId: orderActionKey(ctx),
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
          facts = ORDER_FACTS.created({
            orderNumber: gate.orderNumber,
            total: gate.total,
            subtotal: gate.subtotal,
            shipping: gate.shipping,
          });
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
    const key = handoverActionKey(ctx);
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
      handoverOutcome = hand.status === "executed" ? "executed" : "blocked";
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
      // the ledger row — the customer never hears it — and, since NOTHING was
      // handed over, the draft may not say a person is taking the thread. That
      // is what `handoverOutcome` carries into `buildActionLine`.
    }
  }

  // ---- Reducer-derived stage + NBA persistence ------------------------------
  //
  // `escalated` IS THE HANDOVER LOCK, and only an executed handover may set it.
  // The stage is read at the top of the next turn and returns an EMPTY reply
  // for the rest of the epoch — correct when a person really has the thread,
  // and a double failure otherwise. It used to be set for EVERY ESCALATE,
  // including one the gate BLOCKED: the turn wrote down the exact claim its own
  // wording carefully refuses to make ("the hand-off did not go through,
  // promise NO person"), and then muted Nova for a customer nobody was handed —
  // no card, no holding line, no answer, on a thread Nova was still supposed to
  // be answering. Shadow lands here too, and for the same reason: a shadow turn
  // hands nothing over, so a shadow thread that fell silent afterwards would
  // record a conversation live never has.
  if (action === ("ORDER_CONFIRMED" as never) || action === ("ORDER_PENDING_APPROVAL" as never)) {
    ctx.conversation.stage = "ordered";
  } else if (action === "ESCALATE" && handoverOutcome === "executed") {
    ctx.conversation.stage = "escalated";
    addMemo(ctx, `escalated: ${classified.intent}`);
  } else if (action === "ESCALATE" && handoverOutcome === "blocked") {
    // Nova still owns the thread and still owes an answer. The stage falls
    // through to whatever the state supports, and the memo records that the
    // hand-off was refused — never that it happened.
    addMemo(ctx, `hand-off refused (${classified.intent}); Nova still on the thread`);
    ctx.conversation.stage = computeStage(ctx);
  } else {
    if (ctx.conversation.stage === "ordered" || ctx.conversation.stage === "post_order") {
      // A new product interest re-opens the funnel.
      if (wantsProduct && ctx.products.focusId) ctx.conversation.stage = "product_interest";
      else ctx.conversation.stage = "post_order";
    } else {
      ctx.conversation.stage = computeStage(ctx);
    }
  }
  /* ── D2: NOVA SPEAKING FIRST DOES NOT ANSWER FOR THE CUSTOMER ──────────────
   *
   * `conversation.nextAction` is not a log line — it is the customer ladder's
   * PENDING-ASK state, read back at the top of the next turn as `awaiting`
   * ("...nextAction === 'ASK_QTY' ? 'qty' : null") so that a bare "2" is
   * understood as the answer to the question Nova asked. A follow-up, a cart
   * nudge or a case update that overwrote it with its own label ("NBA_NUDGE")
   * silently broke the NEXT REAL CUSTOMER TURN: the same "2" no longer
   * classifies at L0, falls through to the paid resolver, and arrives with no
   * idea which question it answers.
   *
   * The instruction says what THIS turn is for; it does not know, and may not
   * answer, what the customer was last asked. So the ladder's own state is
   * written only when the ladder decided this turn — the same test that governs
   * the delta, the transcript and the language preference. `confidence` rides
   * with it for the same reason: on a Nova-speaks-first turn it grades a re-read
   * of a message some earlier turn already graded (or, with no inbound at all,
   * the `other`/0 floor), and writing that over the customer's last real turn
   * would make the state card report a certainty nobody measured. */
  if (!novaSpeaksFirst) {
    ctx.conversation.nextAction = action;
    ctx.conversation.confidence =
      classified.confidence >= 0.85 ? "high" : classified.confidence >= 0.6 ? "med" : "low";
  }
  if (action === "PRESENT_SUMMARY") ctx.purchase.confirmSent = true;
  if (action === "DECLINE_DISCOUNT_ONCE") {
    ctx.purchase.objRound += 1;
    addMemo(ctx, "no discount promised");
  }

  // ---- Writer: word the decided action (~300 tokens in) ---------------------
  const actionLine = buildActionLine(ctx, action, facts, { handoverOutcome });
  const card = renderStateCard(ctx);
  const genStart = Date.now();
  timings.genStartMs = genStart - t0;

  let reply = "";
  if (!draftSuppressed) {
    modelCalls += 1;
    try {
      const writeRes = await withGatewayRetry(() =>
        writerAgent.generate(
          [
            {
              role: "user",
              content:
                `${card}\n\nLAST MESSAGES:\n${renderRecent(ctx)}` +
                /* ── D5: THE ONE FACT THAT BUYS SILENCE ────────────────────
                 *
                 * When Nova speaks first, the customer's latest inbound was
                 * re-read and classified for CONTEXT — but it is NOT pushed
                 * into `ctx.recent` (it is not a new customer turn), so the
                 * transcript block above could not contain it, and the writer
                 * was nudging blind about the single fact that should stop it:
                 * the customer already said something that makes the nudge
                 * wrong ("I want to cancel", "already bought it elsewhere").
                 *
                 * It is included as THEIR WORDS, under its own heading, and
                 * fenced the other way from the directive: not a question this
                 * turn was sent to answer, and never the classified message —
                 * `treatAsCustomerTurn` is still false, no delta is applied, no
                 * transcript line is written and the ladder is still not
                 * consulted. It is evidence for whether to say less, or
                 * nothing. */
                (novaSpeaksFirst && message.length > 0
                  ? `\n\nCUSTOMER'S LATEST MESSAGE ON THIS THREAD (the customer's own words, re-read from the ` +
                    `thread just now — this is NOT a new question you were asked to answer, and it was not ` +
                    `sent in reply to you; if it makes what you were about to say wrong, unnecessary or ` +
                    `ill-timed, say less or say nothing):\n${message}`
                  : "") +
                // THE FENCE. The directive is Nova's own, and it is rendered
                // OUTSIDE the transcript with the boundary stated in words, so
                // no wording of it can read as something the customer said.
                (instructed
                  ? `\n\nNOVA'S OWN DIRECTIVE (your instruction from the store's own system — the customer did NOT say any of this, do not answer it, do not quote it):\n${instructed.instruction.directive}`
                  : "") +
                `\n\nACTION: ${actionLine}\nWrite the reply.`,
            },
          ],
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
    epoch: ctx.epoch,
    modelCalls,
    ...(wouldHaveDone ? { wouldHaveDone } : {}),
    ...(modelFailure ? { modelFailure } : {}),
    ...(instructed
      ? {
          // What the classifier actually saw — the customer's latest inbound,
          // or `null` when the thread held none. Never the directive.
          instructed: instructedStamp(instructed, message.length > 0 ? message : null),
          /* SILENT MEANS THE TURN PRODUCED NOTHING AT ALL — no words and no
           * artifact. It is deliberately NOT "the reply string is empty":
           *   • a shadow turn that decided an order suppressed its draft on
           *     purpose and has `wouldHaveDone` to show for it;
           *   • an executed hand-over suppressed its draft because the SERVER
           *     sends the holding line, and has `handoverActionId`.
           * Both are successes. Folding them in here would make the dispatcher
           * release finished work, five times, on a job that did its job.
           * What is left is the real thing: a nudge that chose to say nothing
           * (a success, `owesReply: false`) or a turn that owed an answer and
           * produced none (a failure the dispatcher must see). */
          ...(reply === "" && !wouldHaveDone && !order && !pendingActionId && !handoverActionId
            ? { silent: true }
            : {}),
        }
      : {}),
  };
}

/** The `instructed` block on a result — one shape, one place. */
function instructedStamp(
  instructed: InstructedInput,
  classifiedInbound: string | null,
): NonNullable<TurnResult["instructed"]> {
  const { jobKind, mode, jobId, owesReply } = instructed.instruction;
  return { jobKind, mode, ...(jobId ? { jobId } : {}), owesReply, classifiedInbound };
}

/**
 * A turn that did nothing, spent nothing, and wrote nothing — the honest shape
 * for "there was no work here after all".
 *
 * State is deliberately NOT saved: nothing about the conversation changed, and
 * bumping the version on a no-op would make the context store's own history lie
 * about how many turns this thread has had.
 */
function skippedTurn(
  ctx: NovaLiveContext,
  mode: TurnMode,
  instructed: InstructedInput,
  skipped: NonNullable<TurnResult["skipped"]>,
  t0: number,
): TurnResult {
  return {
    reply: "",
    intent: "other",
    rung: 0,
    // The pending ask as the LADDER left it (an instructed turn no longer
    // overwrites it — see the D2 note). Widened rather than narrowed: state
    // persisted before that fix can still hold an instructed label, and
    // reporting it as a ladder step it never was would be the same lie one
    // layer down.
    action: ctx.conversation.nextAction as NextAction | InstructedAction,
    stage: ctx.conversation.stage,
    missing: computeMissing(ctx),
    stateCard: renderStateCard(ctx),
    timings: { receivedAt: t0, sentMs: Date.now() - t0 },
    cacheHits: ctx.toolLedger.length,
    version: ctx.version,
    mode,
    epoch: ctx.epoch,
    modelCalls: 0,
    instructed: instructedStamp(instructed, null),
    silent: true,
    skipped,
  };
}

// ---------------------------------------------------------------------------
// Pending orders — reconciled against the ledger, never assumed
// ---------------------------------------------------------------------------

/**
 * What the shop actually did with the cards this thread is waiting on.
 *
 * `ctx.pendingOrders` was APPEND-ONLY: `hardValidateAndCreate` pushed an entry
 * when it filed a prepared row and nothing ever took one out or moved one on.
 * The two readers both treat every entry as still awaiting the founder — the
 * state card renders `PENDING SHOP CONFIRM`, and `ANSWER_ORDER_STATUS` tells
 * the customer their order "is with the shop for confirmation" — so a card the
 * founder REJECTED three days ago, or one that expired on its TTL, is reported
 * as pending forever, and every later "where is my order?" gets the same false
 * answer. The customer waits for an order that is never coming.
 *
 * A read is the only way to know, and this is the only place that reads. It is
 * best-effort in the safe direction: an unreadable row stays pending (a
 * transient store failure must not delete a real ask), and only a row that
 * actually says otherwise moves an entry.
 */
async function reconcilePendingOrders(ctx: NovaLiveContext): Promise<void> {
  const pending = ctx.pendingOrders;
  if (!pending?.length) return;
  const client = storeFor(ctx.storeId);
  for (const entry of pending) {
    if ((entry.state ?? "pending") !== "pending") continue;
    const row = await client.getAction(entry.actionId).catch(() => null);
    if (!row || row.status === "prepared") continue; // still on the desk, or unreadable
    if (row.status === "executed") {
      entry.state = "placed";
      // The number if the row names one — direct-path rows carry it on
      // `receipt.after`, approve-path rows on the undo payload. No total: the
      // approve path prices server-side and nothing here may guess one.
      const after = (row.receipt?.after ?? {}) as Record<string, unknown>;
      const undo = (row.undoData ?? {}) as Record<string, unknown>;
      const no = after.orderNumber ?? undo.orderNumber;
      if (typeof no === "string" && no) entry.no = no;
      addMemo(ctx, `shop confirmed: ${entry.title}${entry.no ? ` (${entry.no})` : ""}`);
    } else {
      // blocked | rejected | undone — whatever the reason, it is not waiting on
      // anyone and no order stands from it.
      entry.state = "closed";
      addMemo(ctx, `order request closed without an order: ${entry.title}`);
    }
  }
}

/** Entries still genuinely awaiting the founder. */
export function awaitingShopConfirm(ctx: NovaLiveContext): Array<{ actionId: string; title: string }> {
  return (ctx.pendingOrders ?? []).filter((o) => (o.state ?? "pending") === "pending");
}

/** Entries the shop approved — real orders, named by number when one is known. */
export function confirmedPendingOrders(ctx: NovaLiveContext): Array<{ title: string; no?: string }> {
  return (ctx.pendingOrders ?? []).filter((o) => o.state === "placed");
}

/** Entries that ended without an order — rejected, blocked or undone. */
export function closedPendingOrders(ctx: NovaLiveContext): Array<{ title: string }> {
  return (ctx.pendingOrders ?? []).filter((o) => o.state === "closed");
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
    novaActionId: orderActionKey(ctx),
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
    return { ok: false, actionId: gate.actionId, reason: ORDER_FACTS.blocked(), fallback: "ESCALATE" };
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
      reason: ORDER_FACTS.pending({ productName: product.name, variant, qty, estimate }),
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

/**
 * The `facts` half of the writer instruction, in ONE table.
 *
 * These three strings are composed on the order path and handed to
 * `buildActionLine`, which joins them into the prompt the writer words the
 * customer's reply from — the same destination as every `ACTION:` line and
 * every prepared-tier `detail`. They were composed inline, which meant the
 * honesty suite could not see them: it ran over `PREPARED_DETAIL_BY_VERB` and
 * `buildActionLine`, and the sentences that actually reach the writer alongside
 * them were not enumerable anywhere. Same rule, same table, same test.
 */
export const ORDER_FACTS = {
  /** Auto tier: the order exists and the server priced it. Figures are real. */
  created(o: { orderNumber: string; total: number; subtotal?: number; shipping?: number }): string {
    return `Order #${o.orderNumber} created — total ৳${o.total} COD (product ৳${o.subtotal} + delivery ৳${o.shipping}).`;
  },
  /**
   * Approval tier. NO order number and NO final total — neither exists yet —
   * and the estimate is named as one. "the shop confirms it before dispatch" is
   * the determined fact; nothing here says they will.
   */
  pending(o: { productName: string; variant?: string; qty: number; estimate: number }): string {
    return (
      `order request recorded (${o.productName}${o.variant ? ` ${o.variant}` : ""} × ${o.qty}, ` +
      `COD ≈৳${o.estimate}) — the shop confirms it before dispatch`
    );
  },
  /**
   * Gate BLOCK. The rule that fired is the shop's own business and stays on the
   * ledger row; the customer hears only that a person is taking it.
   */
  blocked(): string {
    return "the shop needs to handle this order directly";
  },
} as const;

/**
 * The instruction the writer words the reply from — i.e. the last place this
 * lane decides what a customer is going to be told.
 *
 * THE RULE IT ENFORCES: never assert an outcome that is not determined, never
 * assert state that was not read, never imply queued work is under way. The
 * prepared-tier lines in `actions.ts` answer to the same rule; this is its
 * other half, because a `detail` string that is careful and an ACTION line
 * that promises the world still ends in one over-promising bubble.
 *
 * Exported so the suite can assert on the wording directly. It has to be: the
 * writer is a model call, so an end-to-end test cannot see the sentence, and
 * the blocked-handover reply went untested for exactly that reason.
 */
export function buildActionLine(
  ctx: NovaLiveContext,
  action: string,
  facts: string,
  opts: { handoverOutcome?: "executed" | "blocked" } = {},
): string {
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
      //
      // NO TIMEFRAME. "will confirm shortly" was a promise about the founder's
      // response time that nothing bounds: the card sits until they tap it or
      // its TTL expires, and a customer told "shortly" who hears nothing for a
      // day was mis-set by this line, not by the shop.
      bits.push(
        "confirm warmly that the order is being placed — the shop double-checks every chat order before dispatch; this is the normal flow, not a problem, so no apology; give NO timeframe for the shop's answer, and do NOT invent an order number or a final total",
      );
      break;
    case "ESCALATE":
      // Three states, and only one of them may promise a person.
      if (opts.handoverOutcome === "blocked") {
        // The hand-over was REFUSED (a founder's no-touch lock, a paused duty,
        // an unavailable authority). Nobody has been told anything, no card
        // exists, and Nova still owns the thread — so a line about someone
        // taking over would be untrue on every clause. The rule that refused
        // it is the shop's own business and never reaches the customer.
        bits.push(
          "the hand-off did not go through, so promise NO person, NO callback and NO answer from anyone else; answer the customer yourself from what the state above supports, say plainly if it is something you cannot settle here, and never mention the shop's internal rules",
        );
      } else {
        // Executed hand-overs suppress the draft entirely (the server sends its
        // own holding line), so this is the shadow lane's wording: what live
        // WOULD have said if it drafted. No timeframe — nothing bounds when a
        // person picks the thread up.
        bits.push("tell the customer a person from the shop is taking this over; do not promise when; one line, then stop");
      }
      break;
    case "ACKNOWLEDGE_REJECT":
      bits.push("accept gracefully, leave the door open, no pressure");
      break;

    /* ── Instructed turns: Nova opened its own mouth ────────────────────────
     *
     * These four labels are reachable ONLY through `runInstructedTurn`, and the
     * substance of each turn is in the fenced NOVA'S OWN DIRECTIVE block that
     * rides alongside this line (see `brain/router.ts`). What is added here is
     * only the part that belongs with every other action's wording rule: what
     * the reply may and may not claim. */
    case "PAY_PROMISE":
      bits.push(
        "answer the exact thing you promised, in one message; if you still cannot answer it, say that plainly and say what you are waiting on — never invent the answer, and never apologise twice for one delay",
      );
      break;
    case "CART_NUDGE":
      bits.push(
        "ONE short personal message naming the item(s) in the directive, or nothing at all; no price, no total and no discount you have not just looked up, and no claim about stock",
      );
      break;
    case "NBA_NUDGE":
      bits.push(
        "you booked this yourself and nobody is waiting: one short message only if the thread still supports one, otherwise write nothing at all",
      );
      break;
    case "CASE_UPDATE":
      bits.push(
        "one message: what happened on the case and what comes next, using only what the state above supports; name no date, no courier action and no outcome that is not already recorded",
      );
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
      // Every branch reads the RECONCILED lists (`reconcilePendingOrders`).
      // "is with the shop for confirmation" is a claim about a card that may
      // have been answered days ago, and it used to be made for every entry
      // this array had ever held.
      const waiting = awaitingShopConfirm(ctx);
      const confirmed = confirmedPendingOrders(ctx);
      const closed = closedPendingOrders(ctx);
      const placed = [
        ...ctx.orders.map((o) => `#${o.no}`),
        ...confirmed.map((o) => (o.no ? `#${o.no}` : o.title)),
      ];
      if (placed.length) {
        bits.push(`orders on file: ${placed.join(", ")} — status lookup not wired yet, be honest`);
      }
      if (waiting.length) {
        bits.push(
          `order (${waiting.map((o) => o.title).join(", ")}) is with the shop for confirmation — normal flow, no order number yet, be honest`,
        );
      }
      if (closed.length && !placed.length && !waiting.length) {
        bits.push(
          `the earlier request (${closed.map((o) => o.title).join(", ")}) is no longer with the shop and no order stands from it — ` +
            "say that plainly, do not guess why, and offer to place it again",
        );
      }
      if (!placed.length && !waiting.length && !closed.length) {
        bits.push("no order found in this conversation — ask for the order number");
      }
      break;
    }
  }
  return bits.filter(Boolean).join(" · ");
}
