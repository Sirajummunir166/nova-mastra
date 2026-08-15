/**
 * The job router — which lane runs a claimed job.
 *
 * Ported from nova-ai `agent/channels/internal.ts`'s `dispatchJobToChannel`
 * (lines 160–357), with one structural change: there, routing and RUNNING were
 * the same call — the function decided a lane and immediately opened a session
 * on it, so the only way to test the decision was to run a model turn. Here the
 * two are split:
 *
 *   planJob(job)            PURE. No I/O, no clock, no store. The routing table
 *                           and every guard rail, decidable from the row alone.
 *   routeJob(storeId, job)  planJob + the one read a decision genuinely needs
 *                           (is this promise still owed?) + the directive text.
 *
 * Nothing here runs a turn. The dispatcher does that, so a route is a value a
 * test can assert on and a reviewer can read.
 *
 * ── THE REGISTRY IS THE SOURCE OF TRUTH ─────────────────────────────────────
 *
 * `laneFor(kind)` (registry.ts) answers "what IS this kind" — a model lane, or
 * `null` for a server sweep dakio-api runs itself. This file never re-decides
 * that. The consequence is the one the spec asked for: a 22nd job kind cannot be
 * silently unrouted, because `LANES` is an exhaustive `Record<JobKind, …>` and
 * adding a kind to the union fails to compile THERE. What it can be is
 * *unbuilt* — and an unbuilt lane is a loud, named, releasing outcome here, not
 * a silent success.
 *
 * ── THE THREE GUARD RAILS, ALL LOAD-BEARING ─────────────────────────────────
 *
 * 1. `inbox_reply` REQUIRES a `conversationId`. dakio-api's drain (D5) always
 *    writes one; a row without one is malformed and there is no thread to
 *    answer. THROW.
 * 2. A `followup` carrying a `promiseId` but NO `conversationId` THROWS. This
 *    is the guard with teeth: falling through would open a founder-plane
 *    session and answer *the customer's promise into the founder's chat*. The
 *    debt is owed to a person on a thread; with no thread there is nobody to
 *    pay, and the safe failure is a released lease with a visible `lastError`.
 *    2b. AND THE HALF UNDERNEATH IT (D3): "has a conversationId" is not "has
 *    THE conversationId". The `InboxPromise` row names the thread the debt is
 *    owed on, and `routeJob` refuses to run when the job pairs a promise with a
 *    different thread — otherwise a real customer receives a stranger's
 *    commitment. The row travels on to the turn (`instruction.promise`) so the
 *    seam enforces the same rule without a weaker second read.
 * 3. `case_update`'s `conversationId` is LEGALLY ABSENT — a courier webhook or
 *    the stagnation sweep can open a case on an order nobody ever discussed in
 *    chat. There is real department work to do and simply nobody to tell, so it
 *    falls to the founder plane rather than throwing. (Its `caseId`, by
 *    contrast, is not optional: a case update naming no case is malformed.)
 *
 * ── AND THE TRIPWIRE ────────────────────────────────────────────────────────
 *
 * The nine SERVER SWEEPS must never reach a model lane. dakio-api leases them
 * inside its own claim transaction, off the queue, before the candidate query
 * runs — so being handed one means the routing broke on the server side. It is
 * a LOUD ERROR here (throw + console.error), because the quiet version costs
 * five failed attempts a night forever and a failed sweep looks exactly like a
 * flaky one.
 */

import type {
  InstructedJobKind,
  InstructedTurnMode,
  TurnInstruction,
} from "../front-office/turn.js";
import { storeFor } from "../store/resolve.js";
import type { InboxPromise, JobKind, NovaDepartment, NovaJob } from "../store/types.js";
import { departmentForJob } from "./departments.js";
import { laneFor, SERVER_SWEEP_KINDS } from "./registry.js";

/** The three kinds that belong to a customer thread. */
const CONVERSATION_BOUND: readonly JobKind[] = ["inbox_reply", "followup", "case_update"];

/** dakio-api's `cart_sweep` conversation-match branch stamps this on the row. */
const CART_RECOVERY_TRIGGER = "cart_recovery";

/**
 * The cap `GET /promises` applies server-side. Read back so a FULL page can be
 * recognised as possibly-truncated rather than mistaken for the whole ledger —
 * see {@link promiseStillOpen}.
 */
const PROMISE_SCAN_LIMIT = 50;

// ---------------------------------------------------------------------------
// The plan — pure, and the whole routing table
// ---------------------------------------------------------------------------

/**
 * A customer-thread turn: rejoin the thread the work belongs to.
 * `mode` is the sub-discipline (promise / cart recovery / nudge / reply / case).
 */
export interface CustomerTurnPlan {
  lane: "customer_turn";
  kind: InstructedJobKind;
  conversationId: string;
  platform: string;
  mode: InstructedTurnMode;
  promiseId?: string;
}

/**
 * Founder-plane work. `workflow` is the registry's lane workflow id — ABSENT
 * means the lane is not built yet, which the dispatcher must treat as "this job
 * did not happen", never as a success.
 */
export interface FounderPlanePlan {
  lane: "founder_plane";
  kind: JobKind;
  department: NovaDepartment | null;
  workflow?: string;
  /** Why a conversation-bound kind ended up here, when it did. */
  fellThrough?: "case_without_thread" | "followup_without_thread";
}

export type JobPlan = CustomerTurnPlan | FounderPlanePlan;

/**
 * A SERVER SWEEP was leased to us. Typed, rather than a bare `Error`, because
 * the dispatcher has to settle it differently from every other refusal: a
 * sweep is not ours to run AND not ours to fail, so releasing it — the normal
 * "this job did not happen" answer — would walk the server's own bookkeeping
 * row up its retry ladder to `failed`. See the settle path in dispatcher.ts.
 */
export class ServerSweepError extends Error {
  constructor(
    readonly kind: JobKind,
    detail: string,
  ) {
    super(detail);
    this.name = "ServerSweepError";
  }
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** `messenger` is dakio-api's own default when a producer omits the platform. */
function platformOf(payload: Record<string, unknown>): string {
  return str(payload.platform) ?? "messenger";
}

/**
 * Decide the lane for one claimed job. Pure: same row in, same plan out.
 *
 * Throws — never returns — for a job that must not run: a server sweep, or a
 * malformed row whose guard rail exists to stop a wrong message reaching a
 * person. The dispatcher's `.then(ok, fail)` turns every throw here into
 * `releaseJob(..., message)`, so the fault lands on the row as `lastError`
 * where an operator can read it.
 */
export function planJob(job: NovaJob): JobPlan {
  const lane = laneFor(job.kind);

  // The tripwire, first: a sweep is not work this side may do, whatever its
  // payload says.
  if (!lane) {
    const message =
      `[nova:brain] job ${job.id} is kind "${job.kind}", a SERVER SWEEP — dakio-api leases and runs ` +
      `these inside its own claim transaction, before the candidate query. Being handed one means ` +
      `\`leaseServerSweeps\` did not claim it and the routing broke server-side. Nothing here has a ` +
      `prompt for it, and a lane that improvised one would burn five failed attempts nightly, ` +
      `forever. Server sweeps: ${SERVER_SWEEP_KINDS.join(", ")}.`;
    console.error(message);
    throw new ServerSweepError(job.kind, message);
  }

  const payload = job.payload ?? {};

  if (job.kind === "inbox_reply") {
    // Guard rail 1. The drain always writes a conversationId; without one there
    // is no thread, and "reply to nobody" is not a job.
    const conversationId = str(payload.conversationId);
    if (!conversationId) {
      throw new Error(`inbox_reply job ${job.id} has no payload.conversationId`);
    }
    return {
      lane: "customer_turn",
      kind: "inbox_reply",
      conversationId,
      platform: platformOf(payload),
      mode: "inbox_reply",
    };
  }

  if (job.kind === "followup") {
    // `!= null`, not `!== undefined`: a producer that spells "no promise" as an
    // explicit `promiseId: null` is describing an NBA nudge, not a malformed
    // promise job, and must not be thrown at for punctuation.
    const rawPromise = payload.promiseId;
    const hasPromise = rawPromise != null;
    if (hasPromise && !str(rawPromise)) {
      throw new Error(`followup job ${job.id} has a non-string or empty payload.promiseId`);
    }
    const conversationId = str(payload.conversationId);

    // Guard rail 2 — the one that prevents answering a customer's promise into
    // the founder's chat.
    if (hasPromise && !conversationId) {
      throw new Error(
        `followup job ${job.id} carries promiseId ${String(rawPromise)} but no payload.conversationId — ` +
          `a debt is owed to a person on a thread, and a threadless promise turn would pay it into the ` +
          `founder's chat`,
      );
    }

    if (conversationId) {
      // THE DISCRIMINATOR IS THE CONVERSATION, NOT THE DEBT (nova-ai module 04
      // widened module 03's branch here, and the widening is the point): an NBA
      // nudge is Nova going back to a specific customer on a specific thread —
      // the same shape of work as a promise repayment, and the opposite of
      // founder-plane work.
      const mode: InstructedTurnMode = hasPromise
        ? "promise"
        : payload.triggeredBy === CART_RECOVERY_TRIGGER
          ? "cart_recovery"
          : "nba_nudge";
      return {
        lane: "customer_turn",
        kind: "followup",
        conversationId,
        platform: platformOf(payload),
        mode,
        ...(hasPromise ? { promiseId: String(rawPromise) } : {}),
      };
    }

    // Threadless AND promiseless: malformed, but harmlessly so — there is no
    // customer this could reach. nova-ai let it fall to a founder-plane session
    // whose template was a fault report; here it falls to the founder plane the
    // same way and is named, so an operator sees the malformed producer.
    return {
      lane: "founder_plane",
      kind: job.kind,
      department: departmentForJob(job.kind, payload),
      ...(lane.workflow ? { workflow: lane.workflow } : {}),
      fellThrough: "followup_without_thread",
    };
  }

  if (job.kind === "case_update") {
    const caseId = str(payload.caseId);
    if (!caseId) {
      throw new Error(`case_update job ${job.id} has no payload.caseId`);
    }
    const conversationId = str(payload.conversationId);
    if (conversationId) {
      return {
        lane: "customer_turn",
        kind: "case_update",
        conversationId,
        platform: platformOf(payload),
        mode: "case_update",
      };
    }
    // Guard rail 3: legally threadless. Real work, nobody to tell.
    return {
      lane: "founder_plane",
      kind: job.kind,
      department: departmentForJob(job.kind, payload),
      ...(lane.workflow ? { workflow: lane.workflow } : {}),
      fellThrough: "case_without_thread",
    };
  }

  // Everything else the registry knows is founder-plane work: the cadenced six
  // plus the event lanes. They arrive in later units of phase E; until then the
  // registry's missing `workflow` is what says so.
  return {
    lane: "founder_plane",
    kind: job.kind,
    department: departmentForJob(job.kind, payload),
    ...(lane.workflow ? { workflow: lane.workflow } : {}),
  };
}

/** Is this kind one of the three that belong to a customer thread? */
export function isConversationBound(kind: JobKind): boolean {
  return CONVERSATION_BOUND.includes(kind);
}

// ---------------------------------------------------------------------------
// The route — plan + the one read a decision needs + the directive
// ---------------------------------------------------------------------------

export type RouteOutcome =
  /** Run this instructed turn on the customer's own thread. */
  | {
      lane: "customer_turn";
      kind: InstructedJobKind;
      conversationId: string;
      platform: string;
      instruction: TurnInstruction;
    }
  /** Founder-plane work whose lane is not built yet — NOT a success. */
  | { lane: "not_built"; kind: JobKind; department: NovaDepartment | null; detail: string }
  /** There was genuinely nothing to do, and nothing went wrong. */
  | { lane: "none"; kind: JobKind; reason: string };

/**
 * Route one claimed job. Async so that every guard-rail throw becomes a
 * REJECTION: the dispatcher builds its `.then(ok, fail)` chain around this call,
 * and a synchronous throw would escape that chain — the release path would never
 * run and sibling jobs in the same claimed batch would keep dangling leases
 * until the watchdog.
 */
export async function routeJob(storeId: string, job: NovaJob): Promise<RouteOutcome> {
  const plan = planJob(job);

  if (plan.lane === "founder_plane") {
    // Deliberately NOT a fake success. A job that "succeeds" without doing
    // anything is worse than one that releases: the row goes `done`, the
    // founder's board says the pulse ran, and nobody ever finds out. Releasing
    // spends attempts and eventually fails the row — with an error that names
    // exactly which lane is missing.
    const why = plan.fellThrough
      ? plan.fellThrough === "case_without_thread"
        ? "case has no conversation (a webhook can open one on an order never discussed), so it is founder-plane work"
        : "follow-up carries neither a conversation nor a promise — malformed producer"
      : "cadenced/event lane, arrives in a later phase E unit";
    // A registry lane that HAS a workflow id gets a different sentence, aimed
    // at the person who just built it: the missing piece is the founder-plane
    // runner here, not their lane. Without this they would read "not built"
    // about a workflow they can see in the registry and go looking in the
    // wrong file.
    const detail = plan.workflow
      ? `lane_not_wired:${plan.kind} — the registry declares workflow "${plan.workflow}", but this dispatcher ` +
        `has no founder-plane runner yet; wire it into performJob (dispatcher.ts), the one run path`
      : `lane_not_built:${plan.kind} — ${why}`;
    return { lane: "not_built", kind: plan.kind, department: plan.department, detail };
  }

  // ── Promise-backed follow-up: is the debt still owed? ─────────────────────
  //
  // dakio-api's `deletePromisesForOutbound` deletes a promise when its send is
  // cancelled, and skips the follow-up job only while that job is still `due` —
  // a job already LEASED when the cancel lands is not the server's to touch. So
  // a fulfilment turn can arrive for a commitment the customer never received,
  // on a live thread, and open with an apology for a promise that was never
  // made. This is where that case ends: as a clean completion, not a turn.
  let promiseRow: InboxPromise | undefined;
  if (plan.mode === "promise" && plan.promiseId) {
    const check = await promiseStillOpen(storeId, plan.promiseId);
    if (!check.open) {
      return {
        lane: "none",
        kind: plan.kind,
        reason: `promise ${plan.promiseId} is no longer open — nothing left to pay off`,
      };
    }

    // ── D3: A PROMISE IS PAID ON THE THREAD IT IS OWED ON, OR NOT AT ALL ────
    //
    // Guard rail 2 (planJob) only checks that the payload HAS a conversationId.
    // That stops the worst version — a customer's promise answered into the
    // founder's chat — and misses the one underneath it: the `InboxPromise` row
    // carries its OWN conversationId, and this function used to read that row
    // and throw it away. A job pairing promise P (owed on thread A) with
    // conversation B therefore paid A's debt into B's thread: the same failure
    // the guard rail exists to prevent, one level deeper, and worse — it reaches
    // a real customer with a stranger's commitment.
    //
    // The comparison happens HERE, before a turn is opened, because this is
    // where the row is already in hand. It is deliberately strict about `null`:
    // a promise owed on no thread is not owed on THIS one either, so it refuses
    // the same way. (The turn seam re-asserts the same rule — see
    // `assertPromiseOwedHere` — because a router is not an enforcement point for
    // a turn that other callers can reach.)
    //
    // A row we could NOT see is a different case and is not refused: an
    // unverified check is the deliberate degrade below, and turning a transient
    // read failure into a refused promise trades a rare barge-in for a routine
    // broken promise.
    if (check.promise && check.promise.conversationId !== plan.conversationId) {
      throw new Error(
        `followup job ${job.id} pairs promise ${plan.promiseId} with conversation ${plan.conversationId}, but ` +
          `that promise is owed on conversation ${check.promise.conversationId ?? "(none)"} — paying one ` +
          `thread's debt into another's is the failure the conversation guard rail exists to prevent, and a ` +
          `mismatched pairing is a malformed producer, not a transient fault`,
      );
    }
    promiseRow = check.promise;
  }

  return {
    lane: "customer_turn",
    kind: plan.kind,
    conversationId: plan.conversationId,
    platform: plan.platform,
    instruction: instructionFor(job, plan, promiseRow),
  };
}

/**
 * The answer to "is this debt still owed?", and the ROW that answered it.
 *
 * `open` alone was the old return, and it threw away the one field that decides
 * whether the turn may run at all (the promise's own `conversationId`) — see the
 * D3 block in {@link routeJob}. `verified` separates "a row said so" from the
 * two deliberate degrades below, so a caller can tell an ANSWER from an
 * ASSUMPTION rather than reading `open: true` as confirmation.
 */
export interface PromiseCheck {
  /** Is the debt still owed? `true` is also both degrade answers — see `verified`. */
  open: boolean;
  /** The matched row, present only when the read actually found it. */
  promise?: InboxPromise;
  /** `false` when `open` was ASSUMED rather than read off a row. */
  verified: boolean;
}

/**
 * Is this debt still owed?
 *
 * Two ways it deliberately answers OPEN rather than "gone" — both with
 * `verified: false`, because neither saw the row:
 *
 *  - THE READ FAILED. This is belt-and-braces on top of a server-side skip, and
 *    the reply ladder (window, lock, thread switch, loop cap) still stands
 *    between this turn and the customer. Turning a transient read error into a
 *    silently dropped debt would trade a rare barge-in for a routine broken
 *    promise, which is the worse of the two.
 *  - THE PAGE CAME BACK FULL, so the ledger may be longer than one page. A busy
 *    shop can hold more than `PROMISE_SCAN_LIMIT` open promises, and "not in the
 *    first 50" is not "gone". Absence only counts when the whole list was seen.
 */
export async function promiseStillOpen(storeId: string, promiseId: string): Promise<PromiseCheck> {
  try {
    const open = await storeFor(storeId).listPromises({ status: "open", limit: PROMISE_SCAN_LIMIT });
    const promise = open.find((p) => p.id === promiseId);
    if (promise) return { open: true, promise, verified: true };
    // The whole ledger was visible and the debt is not on it: genuinely gone.
    if (open.length < PROMISE_SCAN_LIMIT) return { open: false, verified: true };
    return { open: true, verified: false };
  } catch {
    return { open: true, verified: false };
  }
}

// ---------------------------------------------------------------------------
// The directives — Nova's own words, and the only place they are written
// ---------------------------------------------------------------------------

/**
 * Build the instruction for one routed job.
 *
 * Every directive below is IDS-ONLY except the cart snapshot (argued at
 * {@link cartRecoveryDirective}): no promise text, no follow-up note, no case
 * narrative rides the job bus. The turn re-reads what can have changed, which
 * is the whole reason the job carries ids in the first place.
 */
export function instructionFor(
  job: NovaJob,
  plan: CustomerTurnPlan,
  /**
   * The promise ROW, when {@link promiseStillOpen} actually saw it. Carried on
   * the instruction so the turn seam enforces "paid on the thread it is owed on"
   * against the row this router already read, instead of paying for a second
   * read that can only ever be a weaker answer (one page, best effort). Omitted
   * when the check degraded — the seam then re-reads and warns, which is the
   * fallback, not the contract.
   */
  promise?: InboxPromise,
): TurnInstruction {
  const payload = job.payload ?? {};
  const base = { jobKind: plan.kind, jobId: job.id, messageIds: messageIdsOf(payload) };

  switch (plan.mode) {
    case "inbox_reply":
      return {
        ...base,
        mode: "inbox_reply",
        owesReply: true,
        // The action is decided by the NBA ladder on the re-read message — this
        // label is only reached if the ladder has nothing to answer, which for
        // this kind means the message was already handled (and the turn is
        // skipped before it gets here). Named honestly rather than left blank.
        action: "CLARIFY",
        directive:
          `Fallback delivery: this customer's message(s) reached you through the job queue because live ` +
          `delivery failed, not because anything new happened. Answer the customer's latest message ` +
          `above exactly as you would have on the live lane — same thread, same register, no apology ` +
          `for the delay you were not asked about, and no mention of the delivery failure.`,
      };

    case "promise":
      return {
        ...base,
        mode: "promise",
        promiseId: plan.promiseId,
        // IDS-ONLY STILL HOLDS: this is the promise's identity and the thread it
        // belongs to — no promise TEXT rides the job bus, and the turn re-reads
        // what it needs. The id says which debt; this says whose thread it is
        // owed on, which an id cannot.
        ...(promise ? { promise: { id: promise.id, conversationId: promise.conversationId } } : {}),
        owesReply: true,
        action: "PAY_PROMISE",
        directive:
          `A promise you made on this conversation is coming due (promise ${plan.promiseId}). It is still ` +
          `open — the router checked before waking you. Re-read the thread above before you answer: the ` +
          `world moved since you made it. Answer the thing you actually promised, in one message. If you ` +
          `still cannot answer it, say so plainly and say when — do NOT invent the answer, and do not ` +
          `apologise twice for one delay.`,
      };

    case "cart_recovery":
      return {
        ...base,
        mode: "cart_recovery",
        owesReply: false,
        action: "CART_NUDGE",
        directive: cartRecoveryDirective(payload),
      };

    case "nba_nudge":
      return {
        ...base,
        mode: "nba_nudge",
        owesReply: false,
        action: "NBA_NUDGE",
        directive:
          `A follow-up you scheduled on this conversation is due (job ${job.id}). NOBODY IS WAITING ON ` +
          `YOU — you booked this yourself. Re-read the thread first: the world moved since you booked ` +
          `it. The customer may have written back, the owner may have taken the thread, and the reason ` +
          `you wrote down when you booked it is the owner's to read, not yours to get back — so the ` +
          `thread itself is what has to tell you whether this still matters. If there is nothing worth ` +
          `saying now, SAY NOTHING: silence is a real answer here, and a nudge nobody asked for is worse ` +
          `than a late one.`,
      };

    case "case_update":
      return {
        ...base,
        mode: "case_update",
        owesReply: true,
        action: "CASE_UPDATE",
        directive:
          `Case ${str(payload.caseId) ?? "(unnamed)"} on this conversation has moved, and the customer is ` +
          `owed the news. Whatever triggered this may already be out of date — a message quoting a stale ` +
          `fact tells someone their parcel reached a place it has since left — so say only what the state ` +
          `above supports. One message: what happened, and what comes next. If the owner has taken this ` +
          `thread, leave it to them rather than talking over them.`,
      };
  }
}

function messageIdsOf(payload: Record<string, unknown>): string[] | undefined {
  const raw = payload.messageIds;
  if (!Array.isArray(raw)) return undefined;
  const ids = raw.filter((id): id is string => typeof id === "string" && id.length > 0);
  return ids.length > 0 ? ids : undefined;
}

interface CartNudgeItem {
  name: string;
  qty: number;
}

function cartNudgeItems(payload: Record<string, unknown>): CartNudgeItem[] {
  const raw = payload.cartItems;
  if (!Array.isArray(raw)) return [];
  const items: CartNudgeItem[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const name = (entry as { name?: unknown }).name;
    if (typeof name !== "string" || name.trim().length === 0) continue;
    const qty = Number((entry as { qty?: unknown }).qty);
    items.push({ name: name.trim(), qty: Number.isFinite(qty) && qty > 0 ? Math.trunc(qty) : 1 });
  }
  return items;
}

/**
 * THE ONE SEAM THAT CARRIES A PAYLOAD SNAPSHOT, and why.
 *
 * The ids-only rule exists so a turn re-reads what can have CHANGED, and so no
 * free text passes a second redaction point. Neither applies to a basket: the
 * cart is not a fact about the world that moved, it is the reason this message
 * exists at all — and no cart read is on the customer plane. Ids-only here would
 * mean the one sentence the nudge exists to say ("the Jamdani sharee") could not
 * be said, leaving the model to improvise "you left something in your cart",
 * which is the blast this whole lane is fenced against.
 *
 * WHAT IS DELIBERATELY NOT CARRIED: no price, no cart total, no stock. The
 * payload is a SNAPSHOT of what the basket held when it was abandoned —
 * dakio-api's `cartNudgeItems` strips prices for exactly this reason, because a
 * price read out of an hours-old copy is a number the store may no longer
 * honour and one a customer will hold Nova to. "Still there" is true of their
 * CART, never of the warehouse.
 */
export function cartRecoveryDirective(payload: Record<string, unknown>): string {
  const items = cartNudgeItems(payload);
  const named =
    items.length === 0 ? null : items.map((it) => (it.qty > 1 ? `${it.name} ×${it.qty}` : it.name)).join(", ");

  if (!named) {
    // dakio-api refuses to book a nameless cart, so this means the payload was
    // malformed in transit. Ask for nothing rather than inviting a generic
    // "something in your cart".
    return (
      `This cart-recovery follow-up arrived with NO item names in its payload, which should not happen — ` +
      `the server does not book a nameless cart. Do not improvise a generic cart reminder: a nudge that ` +
      `cannot say what the basket held is a blast. Say nothing to the customer.`
    );
  }

  return (
    `This customer left these in their cart and did not check out: ${named}. Their conversation window is ` +
    `still open, so you may write ONE short, personal message about it — read the thread first, because ` +
    `the world moved since the basket was left. Name the actual item(s) above; that is the entire licence ` +
    `for this message. Ask once whether they still want it and open a door for the obvious objection ` +
    `(size, delivery charge, delivery time) — do not stack a second ask, and never write anything that ` +
    `would read the same to a hundred people.\n` +
    `The item list is a SNAPSHOT of the basket as it was left: it is not a stock check and carries no ` +
    `prices. "Still there" is true of their cart, never of your warehouse — do not quote a price, a total ` +
    `or a discount you have not just looked up. If the thread has moved on (they already bought, they ` +
    `said no, the owner stepped in) send nothing: silence is a real answer here.`
  );
}

// ---------------------------------------------------------------------------
// THERE IS EXACTLY ONE RUN PATH, AND IT IS NOT HERE
// ---------------------------------------------------------------------------
//
// This file used to end with `routeAndRun(storeId, job, {mode})` — route, then
// call `runInstructedTurn`. It was a SECOND copy of the run path, and it had
// already drifted from the real one (`performJob` in dispatcher.ts):
//
//   • it defaulted to `mode: "shadow"` from its own argument and never read
//     `NOVA_BRAIN_TURN_MODE`, so the one operator switch that decides whether
//     Nova speaks to customers did not apply to it;
//   • it applied NONE of the honesty checks — no `modelFailure` throw, no
//     silent-but-owed-a-reply throw, no committed-write check. A turn that
//     produced nothing came back as `{outcome, turn}` with no signal at all,
//     so any future caller would have completed the job and told the founder's
//     board that a customer had been answered.
//
// Nothing called it. It stayed compiling and stayed wrong, which is the exact
// shape of the bug that eventually gets used. The router decides lanes; the
// dispatcher runs them, once, with the leases and the honesty checks in one
// place. If a founder-plane runner is wired up later, wire it into
// `performJob` — not into a second copy here.
