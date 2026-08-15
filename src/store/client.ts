/**
 * The boundary between Nova and the Dakio store.
 *
 * Nova only ever talks to a `StoreClient`. Today that resolves to a
 * per-tenant in-memory demo backend (`backend.ts`), one seeded dataset per
 * store. When the real Express store API is ready, implement this same
 * interface with `fetch()` calls and swap the constructor in
 * `storeFor` (`resolve.ts`) — no tool, subagent, or schedule changes required.
 *
 * The store persists Nova's own data too (memory, activity, prepared
 * actions, reports), matching the Dakio design where the store server saves
 * all agent data.
 *
 * Every data-access method is async (a real implementation is a network
 * call). `now()` is the one exception — it is a local clock read, not a
 * request, so callers can build timestamps without awaiting a round trip.
 *
 * There is no process-wide client. A `StoreClient` is always tenant-bound and
 * resolved per call via `storeFor(ctx)` in `resolve.ts` — see `requireStore`
 * in `lib/tenant.ts` for how the tenant is derived from verified auth.
 */

import type {
  AbandonedCart,
  ActionRecord,
  ActionStatus,
  ActivityEntry,
  AuthorityState,
  AutonomyConfig,
  BrandProfile,
  Campaign,
  CartRecoveryState,
  ChatOrderRequest,
  ChatOrderResult,
  ContentDraftInput,
  ContentItem,
  Courier,
  CouponValidation,
  CreateDiscountInput,
  Customer,
  CustomerMessage,
  CustomerRiskView,
  NovaCaseView,
  OrderStatusView,
  OpenCaseRequest,
  PatchCaseRequest,
  UpdateOrderDeliveryRequest,
  DecisionRecord,
  DepartmentGrade,
  Discount,
  ExpenseEntry,
  AccountStatement,
  FinanceAccounts,
  FinanceOverview,
  FinancePnl,
  GrowBroadcast,
  GrowCampaign,
  GrowGoal,
  GrowIdea,
  GrowPost,
  InboxEvent,
  InboxHandoverRequest,
  InboxHandoverResult,
  InboxPromise,
  InboxReplyRequest,
  InboxReplyResult,
  InboxThread,
  IntentObservedRequest,
  IntentObservedResult,
  JobKind,
  JobSettleResult,
  LinkCustomerRequest,
  LinkCustomerResult,
  MemoryEntry,
  MemoryNamespace,
  MemoryUpsert,
  NbaBlock,
  NovaExperiment,
  NovaJob,
  NovaJobDef,
  MorningBrief,
  NovaPlaybook,
  NovaReport,
  Order,
  OrderStatus,
  PlanItem,
  Product,
  PromiseSettleRequest,
  PurchaseOrder,
  ScheduleFollowupRequest,
  ScheduleFollowupResult,
  SocialPost,
  StoreSettings,
  Supplier,
  SupportTicket,
  TicketStatus,
  TrendingProduct,
} from "./types.js";

/**
 * The inbox reply route's refusal codes (module 02 D10 guard ladder). Every
 * one of them is a 409 with a receipted **blocked** ledger row on the server —
 * a refused send is never silence.
 *
 *  THREAD_OFF     the founder switched Nova off for this thread
 *  LOCKED         the founder holds the thread (takeover, or answered first)
 *  STALE          the customer wrote again — re-read before answering
 *  WINDOW_CLOSED  outside Meta's 24h window; v1 refuses honestly, never tags
 *  LOOP_GUARD     too many consecutive Nova messages since the last inbound
 */
export type InboxRefusalCode =
  | "THREAD_OFF"
  | "LOCKED"
  | "STALE"
  | "WINDOW_CLOSED"
  | "LOOP_GUARD"
  | "RATE_LIMITED";

/**
 * A send the server refused. Thrown (never swallowed into a fake success) so
 * the turn cannot report a message the customer will never see. The model is
 * instructed not to retry `LOCKED` — a founder-held thread stays the founder's.
 */
export class InboxSendRefused extends Error {
  readonly code: InboxRefusalCode | string;
  readonly status: number;
  constructor(code: InboxRefusalCode | string, message: string, status = 409) {
    super(message);
    this.name = "InboxSendRefused";
    this.code = code;
    this.status = status;
  }
}

/**
 * What FILING an action answers with: the row that now owns the at-most-once
 * key, plus whether the store answered from a row that ALREADY owned it instead
 * of inserting the one just handed to it.
 *
 * dakio-api's `NovaAction` carries `@@unique([tenantId, type, dedupeKey])` and
 * fills `dedupeKey` from `payload.novaActionId`, so a second POST under a key
 * the tenant's ledger already owns returns that row rather than a second one.
 * Without a discriminator the caller cannot tell that answer from a fresh
 * insert, and every "and then do the side effect" that follows a filing runs
 * twice on the same action id — a second live coupon, a doubled activity line,
 * a `previousStatus` snapshot re-read after another attempt's write already
 * landed.
 *
 * `replayed` is OPTIONAL on purpose. A dakio-api that predates the
 * discriminator simply does not send the key, and "this server does not report
 * replays" has to stay distinguishable from "this filing was a fresh insert" —
 * the first is a server without the floor, the second is a fact. Callers
 * therefore branch on `=== true` and read `undefined` as "not known to be a
 * replay", which is the pre-discriminator behaviour: assuming a replay would
 * SKIP a side effect that never happened, which is the worse of the two errors.
 */
export type FiledAction = ActionRecord & { replayed?: boolean };

export interface StoreClient {
  /** Local clock read, ISO 8601. Not a request — safe to call without awaiting. */
  now(): string;

  // Catalog
  listProducts(filter?: { status?: Product["status"]; category?: string }): Promise<Product[]>;
  getProduct(id: string): Promise<Product | null>;
  createProduct(product: Omit<Product, "id" | "createdAt">): Promise<Product>;
  updateProduct(
    id: string,
    patch: Partial<
      Pick<Product, "price" | "compareAtPrice" | "stock" | "status" | "supplierId" | "cost">
    >,
  ): Promise<Product>;
  listTrendingProducts(): Promise<TrendingProduct[]>;

  // Customers
  listCustomers(filter?: { segment?: Customer["segment"] }): Promise<Customer[]>;
  getCustomer(id: string): Promise<Customer | null>;

  // Orders
  /**
   * `customerId` is module 07 D5.1 — one customer's own history, which is what
   * a reorder or a returns conversation is about. Scoped by tenant server-side,
   * so an id from another store matches nothing rather than refusing: the shape
   * of a refusal is itself a probe for whether an id exists.
   */
  listOrders(filter?: { sinceDays?: number; status?: OrderStatus; customerId?: string }): Promise<Order[]>;
  getOrder(id: string): Promise<Order | null>;
  updateOrder(patch: { id: string; status?: OrderStatus; courierId?: string }): Promise<Order>;

  // Abandoned carts
  listAbandonedCarts(state?: CartRecoveryState): Promise<AbandonedCart[]>;
  /**
   * Patch a cart's recovery state and/or the message prepared for it.
   *
   * `recoveryMessage` was accepted and DROPPED until module 05: the PATCH
   * handler never referenced the field and the read serializer hardcoded null,
   * so a prepared nudge round-tripped as nothing. It is persisted now (module
   * 05 D8, dakio-api `routes/novaStore.js`), which means a caller that writes
   * `recoveryState: "message_prepared"` without a `recoveryMessage` is now
   * recording a prepared message that does not exist — write both or neither.
   */
  updateCart(
    id: string,
    patch: { recoveryState?: CartRecoveryState; recoveryMessage?: string | null },
  ): Promise<AbandonedCart>;

  // Marketing
  listCampaigns(status?: Campaign["status"]): Promise<Campaign[]>;
  getCampaign(id: string): Promise<Campaign | null>;
  createCampaign(campaign: Omit<Campaign, "id" | "dailyStats">): Promise<Campaign>;
  updateCampaign(
    id: string,
    patch: Partial<Pick<Campaign, "status" | "dailyBudget" | "notes">>,
  ): Promise<Campaign>;
  listSocialPosts(status?: SocialPost["status"]): Promise<SocialPost[]>;
  createSocialPost(post: Omit<SocialPost, "id">): Promise<SocialPost>;
  updateSocialPost(
    id: string,
    patch: Partial<Pick<SocialPost, "status" | "scheduledFor" | "publishedAt">>,
  ): Promise<SocialPost>;
  listDiscounts(activeOnly?: boolean): Promise<Discount[]>;
  /**
   * Mint a coupon. Extended in module 05 from PERCENT-only to the FIXED arm
   * plus `minOrder`/`maxUses`/`mechanism` — one method for one route, because
   * two client methods pointing at `POST /api/v1/store/discounts` is how two
   * callers drift about what that route accepts.
   *
   * THE CODE MUST BE UPPER-CASE. Every redemption path uppercases its input
   * before lookup (`store.js`, `coupons.js`, dakio-api's own `create_coupon`
   * executor), `@@unique([tenantId, code])` is case-SENSITIVE in Postgres, and
   * the route stored `code.trim()` with no fold until module 05 — so a
   * lower-case code was silently unredeemable at checkout AND could coexist
   * with its upper-case twin as a second row the P2002 handler never saw.
   */
  createDiscount(discount: CreateDiscountInput): Promise<Discount>;
  updateDiscount(id: string, patch: { active: boolean }): Promise<Discount>;
  /**
   * Check a coupon against a cart subtotal, WITHOUT redeeming it (module 05 D6).
   *
   * A read, so it may be called from a customer turn before anything is
   * committed — which is the point: an invalid coupon at checkout is SILENT on
   * the storefront path today (unknown, inactive, expired and exhausted codes
   * all leave the buyer paying full price with no error), and the shopkeeper
   * script's whole job is to say so in the thread instead.
   *
   * `subtotal` is WHOLE TAKA and required. See {@link CouponValidationRequest}.
   */
  validateCoupon(code: string, subtotal: number): Promise<CouponValidation>;

  // ---- Grow Lab (read-only, Phase 06) ----
  //
  // The six founder-facing Grow modules. Read-only here on purpose: Grow
  // WRITES land through the action pipeline into the store's shared
  // `growService`, so a Nova-authored campaign obeys exactly the same rules a
  // founder's does. Wiring those writes is Stage 3+ (phases 09–12); until
  // then Nova can see the doors and reason about them, not act in them.
  //
  // Every row carries `createdBy`/`novaActionId` — Nova must be able to tell
  // its own rows from the founder's before it proposes anything.

  listGrowCampaigns(status?: GrowCampaign["status"]): Promise<GrowCampaign[]>;
  listGrowPosts(status?: GrowPost["status"]): Promise<GrowPost[]>;
  listGrowBroadcasts(): Promise<GrowBroadcast[]>;
  listGrowIdeas(status?: GrowIdea["status"]): Promise<GrowIdea[]>;
  /** The target for `month` ('YYYY-MM'), or the current month when omitted. */
  getGrowGoal(month?: string): Promise<GrowGoal | null>;

  // Support & messaging
  listSupportTickets(status?: TicketStatus): Promise<SupportTicket[]>;
  getSupportTicket(id: string): Promise<SupportTicket | null>;
  addTicketMessage(
    ticketId: string,
    message: { from: "nova" | "owner"; text: string },
  ): Promise<SupportTicket>;
  updateTicketStatus(ticketId: string, status: TicketStatus): Promise<SupportTicket>;
  listCustomerMessages(filter?: {
    purpose?: CustomerMessage["purpose"];
    sinceDays?: number;
  }): Promise<CustomerMessage[]>;
  addCustomerMessage(message: Omit<CustomerMessage, "id" | "sentAt">): Promise<CustomerMessage>;

  // Suppliers & logistics
  listSuppliers(): Promise<Supplier[]>;
  getSupplier(id: string): Promise<Supplier | null>;
  listPurchaseOrders(status?: PurchaseOrder["status"]): Promise<PurchaseOrder[]>;
  createPurchaseOrder(
    po: Omit<PurchaseOrder, "id" | "createdAt" | "total">,
  ): Promise<PurchaseOrder>;
  updatePurchaseOrder(id: string, patch: { status: PurchaseOrder["status"] }): Promise<PurchaseOrder>;
  listCouriers(): Promise<Courier[]>;
  getCourier(id: string): Promise<Courier | null>;

  // Finance
  listExpenses(sinceDays?: number): Promise<ExpenseEntry[]>;

  // ---- Ledger-backed finance (DAKIO_FINANCE_PRD §12.3) ----
  //
  // Reads over the merchant's double-entry ledger: reconciled truth, never an
  // estimate. Every implementation answers `{ ledgerActive: false }` for a
  // tenant whose ledger isn't onboarded — callers MUST branch on that and
  // label any heuristic fallback as an estimate. Reads only: the books are
  // written solely as side effects of domain actions, by design.

  /** Cash, receivables, payables, stock value and month P&L in one call. */
  getFinanceOverview(): Promise<FinanceOverview>;
  /** Ledger P&L over a window (YYYY-MM-DD, Dhaka days); `compare` adds the immediately-preceding same-length window. */
  getFinancePnl(opts?: { from?: string; to?: string; compare?: boolean }): Promise<FinancePnl>;
  /** Chart of accounts grouped by type with the Dr==Cr proof (doubles as the balance sheet). */
  getFinanceAccounts(): Promise<FinanceAccounts>;
  /** Running-balance statement for one account; null = no such account. */
  getAccountStatement(
    code: string,
    opts?: { from?: string; to?: string; limit?: number },
  ): Promise<AccountStatement | null>;

  // ---- Nova agent data (the store persists these too) ----

  getAutonomy(): Promise<AutonomyConfig>;
  /**
   * Stage 1: everything the authority seam needs, composed in ONE read per
   * turn — level, earned ceiling, guardrails (versioned), door modes, duty
   * states, and today's committed spend. Implementations MUST throw rather
   * than return a partial state: `evaluateAuthority` fails closed on error,
   * and a silently-empty state would read as "no locks, no limits".
   */
  getAuthority(): Promise<AuthorityState>;
  /**
   * Replace the no-touch lock list, writing a NEW guardrails version.
   * Guardrail rows are immutable so a receipt can always be re-read against
   * the limits that judged it; this never edits the current row in place.
   */
  setNoTouch(locks: string[]): Promise<string[]>;

  // ---- Decisions (E-9, Stage 2) ----
  //
  // One record per gated action, rendered on every surface. The store owns
  // queue position and status transitions so two surfaces cannot disagree.
  listDecisions(filter?: { status?: DecisionRecord["status"]; tag?: string; limit?: number }): Promise<DecisionRecord[]>;
  addDecision(decision: Omit<DecisionRecord, "id" | "createdAt" | "queuePos" | "status" | "decidedBy" | "decidedAt" | "bundleRef" | "frozenByLock">): Promise<DecisionRecord>;
  updateDecision(id: string, patch: Partial<Pick<DecisionRecord, "status" | "surfacedIn" | "queuePos" | "frozenByLock" | "decidedBy" | "decidedAt">>): Promise<DecisionRecord>;
  setAutonomy(config: AutonomyConfig): Promise<AutonomyConfig>;

  listMemory(namespace?: MemoryNamespace): Promise<MemoryEntry[]>;
  upsertMemory(entry: MemoryUpsert): Promise<MemoryEntry>;
  deleteMemory(namespace: MemoryNamespace, key: string): Promise<boolean>;
  /**
   * Attach an embedding to an existing entry without touching its value or
   * `updatedAt` — the embed worker's write-back for the retrieval index.
   */
  setMemoryEmbedding(
    namespace: MemoryNamespace,
    key: string,
    embedding: number[],
  ): Promise<boolean>;

  listActivity(filter?: {
    sinceDays?: number;
    department?: ActivityEntry["department"];
  }): Promise<ActivityEntry[]>;
  addActivity(entry: Omit<ActivityEntry, "id" | "at">): Promise<ActivityEntry>;
  /** Update an activity in place — used by the nightly attribution pass. */
  updateActivity(
    id: string,
    patch: Partial<Pick<ActivityEntry, "revenueInfluence" | "revenueBasis" | "revenueProvenance">>,
  ): Promise<ActivityEntry>;

  // ---- Night shift outputs (E-4/E-6/E-7/E-16, Stage 3) ----
  /** Upsert a department's grade AND replace its day's score metrics in one call. */
  setDepartment(dept: DepartmentGrade): Promise<DepartmentGrade>;
  /** All department rows (grade/statusLine/now/next/memo) — the board the CEO
   *  weekly merge reads (blueprint 17 R2). */
  listDepartments(): Promise<DepartmentGrade[]>;
  /** Author a plan-board row (WAITING_ON_YOU items carry a decisionRef). */
  addPlanItem(item: Omit<PlanItem, "id">): Promise<PlanItem>;
  /** File the morning brief; tiles are computed server-side from real rows. */
  fileBrief(input: { day?: string; narrative?: string }): Promise<MorningBrief>;
  /** The structured brand voice (E-12) a draft is scored against. Returns
   *  sensible defaults when the founder hasn't configured one yet. */
  getBrandProfile(): Promise<BrandProfile>;
  /** File a scored content draft (E-11). `id` present = a regeneration round. */
  fileContent(input: ContentDraftInput): Promise<ContentItem>;

  // Procedural memory — playbooks (reflection proposes, owner promotes)
  listPlaybooks(status?: NovaPlaybook["status"]): Promise<NovaPlaybook[]>;
  upsertPlaybook(playbook: Omit<NovaPlaybook, "id" | "createdAt"> & { id?: string }): Promise<NovaPlaybook>;
  updatePlaybookStatus(id: string, status: NovaPlaybook["status"]): Promise<NovaPlaybook>;

  // Experiments — hypotheses evaluated against actuals
  listExperiments(status?: NovaExperiment["status"]): Promise<NovaExperiment[]>;
  getExperiment(id: string): Promise<NovaExperiment | null>;
  createExperiment(experiment: Omit<NovaExperiment, "id" | "startedAt">): Promise<NovaExperiment>;
  updateExperiment(
    id: string,
    patch: Partial<Pick<NovaExperiment, "actual" | "status" | "evaluatedAt" | "actionIds">>,
  ): Promise<NovaExperiment>;

  listActions(status?: ActionStatus): Promise<ActionRecord[]>;
  getAction(id: string): Promise<ActionRecord | null>;
  addAction(record: Omit<ActionRecord, "id" | "createdAt">): Promise<FiledAction>;
  updateAction(
    id: string,
    patch: Partial<
      Pick<ActionRecord, "status" | "outcome" | "undoData" | "undoable" | "decidedAt" | "executedAt">
    >,
  ): Promise<ActionRecord>;
  /**
   * Approve-time execution for verbs the agent has NO local executor for —
   * the backend owns executors for advisory verbs and its own doors (grow
   * campaigns, coupons). Runs the backend approve pipeline: claims the linked
   * Decision (so a chat approve can't race a Desk tap into a double
   * execution), executes through the backend registry, and reports honestly
   * whether anything ran. Throws with the backend's reason on a settled or
   * frozen decision.
   */
  executePreparedAction(actionId: string): Promise<{ executed: boolean; note: string }>;
  /**
   * by:nova attribution (Stage 0): stamp the door record a just-executed
   * action touched (`targetRef` = "type:id") with the action id, so the door
   * UI can render the chip + receipt drawer. Metadata, never authority —
   * implementations must not throw on unattributable refs.
   */
  attributeDoorRecord(targetRef: string, actionId: string): Promise<void>;

  listReports(filter?: { kind?: NovaReport["kind"]; limit?: number }): Promise<NovaReport[]>;
  addReport(report: Omit<NovaReport, "id" | "createdAt">): Promise<NovaReport>;

  // Inbox — inbound store events (Phase 2.3)
  listInboxEvents(filter?: { processed?: boolean }): Promise<InboxEvent[]>;
  markEventProcessed(id: string): Promise<InboxEvent>;

  // ---- Front Office — customer conversations (Stage 10, module 02) ----
  //
  // Three calls, one rule: dakio-api decides. It owns the thread lock, the
  // 24h window, the loop cap, the pacing engine and the Meta credentials, so
  // Nova can propose a reply and can be told no — it can never send.

  /**
   * Read the thread: conversation state, the last `messages` (≤50, newest
   * last), and the server-assembled customer block. The transcript is CUSTOMER
   * TEXT and every caller must frame it `untrusted()` before it reaches the
   * model. Returns null when the conversation does not exist for this tenant.
   */
  getInboxConversation(conversationId: string, opts?: { messages?: number }): Promise<InboxThread | null>;
  /**
   * Tell dakio-api which product a PHOTO turned out to be (Sales-Engine Phase
   * 3b). Every other identification is derived from something the server
   * already holds — a name the customer typed, an order that was created. A
   * photo match is resolved inside a vision call HERE, so the server can only
   * learn it by being told.
   *
   * Advisory: the server records it as `inferred`, below anything the customer
   * actually typed, and refuses outright when the state guardrail is off. The
   * reply must never wait on it and must never fail because of it.
   */
  noteProductIdentified(conversationId: string, productId: string): Promise<void>;
  /**
   * Which eve session this conversation is currently on (Stage 11).
   *
   * The server owns the number because BOTH dispatch lanes derive the
   * continuation token from it, and two lanes computing different tokens means
   * the customer is answered twice from two contexts — see `inboxTokenFor`.
   * A value derived independently on each side can drift; a stored one cannot.
   *
   * Never throws: an unreachable server answers 0, which is the same answer it
   * gives both lanes, so they still agree with each other.
   */
  getSessionEpoch(conversationId: string): Promise<number>;
  /**
   * Queue a reply. Success means QUEUED, not delivered — the human-timing
   * engine schedules each bubble and the outbound ledger records what actually
   * happened. Throws {@link InboxSendRefused} when a guard says no.
   */
  replyInThread(conversationId: string, input: InboxReplyRequest): Promise<InboxReplyResult>;
  /**
   * Hand the thread to the founder: locks Nova out, sends the deterministic
   * holding line, and files the brief as a Decision. Never gated at any tier —
   * escalation must always be possible.
   */
  handoverConversation(conversationId: string, input: InboxHandoverRequest): Promise<InboxHandoverResult>;

  // ---- Front Office — identity and promises (Stage 10, module 03) ----
  //
  // Same rule, one layer down: the SERVER owns identity. Nova asserts what the
  // customer said; dakio-api normalizes, variant-matches and decides. A
  // `matched:false` is an answer, not a fault — the honest default for a thread
  // is unlinked, and nothing here may invent a Customer to make a turn tidier.

  /**
   * Assert a self-stated phone, or submit a digit check. Success means the
   * SERVER decided — read `matched`: false with `mergeProposed` means two
   * records collide and the thread deliberately stays unlinked. Never creates a
   * Customer. Idempotent server-side on `novaActionId`.
   */
  linkCustomer(conversationId: string, input: LinkCustomerRequest): Promise<LinkCustomerResult>;
  /**
   * Reverse a link: clears the join and KEEPS the verified channel address
   * (D4). The address is a fact that was established; forgetting it to undo a
   * join would forget something true.
   */
  unlinkCustomer(conversationId: string): Promise<{ unlinked: boolean }>;
  /**
   * Read the commitments ledger. `status` defaults to open server-side; the
   * nightly sweep and the founder brief are the two readers.
   */
  listPromises(filter?: { status?: string; customerId?: string; limit?: number }): Promise<InboxPromise[]>;
  /**
   * Settle a promise. `kept` is only honest after a message actually SENT — a
   * draft sitting unapproved keeps nothing. `broken` is sweep-only and the
   * route rejects it here. Transitions are validated server-side (open → kept |
   * released only), so a replayed settle is a no-op, not a second transition,
   * and losing the race to the sweep is a refusal rather than an overwrite.
   */
  settlePromise(promiseId: string, input: PromiseSettleRequest): Promise<{ ok: boolean; promise: InboxPromise }>;
  /**
   * Merge two Customer rows in one transaction. The SURVIVOR is chosen
   * server-side (more orders; tie → older) — the caller names the pair, not the
   * winner. Not reversible; only ever reached through an approved Decision.
   */
  mergeCustomers(input: { customerIdA: string; customerIdB: string; basis: string }): Promise<{
    survivorCustomerId: string;
    mergedCustomerId: string;
    ordersMoved: number;
    channelsMoved: number;
    conversationsMoved: number;
    promisesMoved: number;
  }>;

  // ---- Front Office — lifecycle & NBA (Stage 10, module 04) ----
  //
  // Same rule again, one layer up: the SERVER decides what forward means. The
  // journey stage is a deterministic reducer's output and the eligible-candidate
  // list is computed from it, so Nova reads a scaffold it did not build and
  // chooses INSIDE it. Nothing here sets a stage, and nothing here sends: the
  // one write that touches a customer books a job for later, and the reply that
  // job eventually composes goes through `replyInThread` and the full gate like
  // any other.

  /**
   * Read the D6 NBA block for a thread: stage, goal, window, quiet hours, touch
   * budget, the eligible candidates and why the rest are not.
   *
   * ⚠️ RESERVED SURFACE — NO CALLER TODAY, and saying so is the alternative to a
   * method that looks wired. The live path is INLINE: every turn, including a
   * fired follow-up's, reads `get_conversation` → `thread.nba`, which dakio-api
   * re-assembles fresh on that read, so nothing in this repo needs a second
   * fetch. The route (`GET /api/v1/inbox/nba/:conversationId`) is mounted,
   * tested and named as a consumed contract by module 07 — it is kept for the
   * caller that wants "what is legal on this thread right now?" without opening
   * the whole conversation. Wire it or leave it; do not read its existence as
   * evidence that some turn depends on it.
   *
   * `null` is a real answer, not a fault, and it means one of two honest
   * things — this thread has no journey row yet (nothing real has happened to
   * it), or this server predates module 04. A caller must treat a missing block
   * as "no scaffold, answer the person anyway", never as a reason to refuse: a
   * customer waiting for a price does not care that the lifecycle engine is
   * down.
   */
  getNba(conversationId: string): Promise<NbaBlock | null>;
  /**
   * Book a follow-up: a `followup` NovaJob at `now + delay`, quiet-hour
   * shifted, superseding this conversation's existing NBA nudge if it has one.
   *
   * The server validates the delay against the journey's stage and rejects a
   * chain past `chainCount` 2 — after two unanswered follow-ups Nova stops
   * until the customer comes back. Those refusals arrive as
   * {@link InboxSendRefused}, because they are ANSWERS about what is legal, not
   * transport faults to retry.
   */
  scheduleFollowup(input: ScheduleFollowupRequest): Promise<ScheduleFollowupResult>;
  /**
   * Cancel a booked follow-up — the inverse of `scheduleFollowup`, and the only
   * thing the `schedule_follow_up` undoer can call.
   *
   * `cancelled:false` means the row was already settled (fired, superseded, or
   * cancelled by the customer writing back). That is an outcome, not an error:
   * the commitment is gone either way, which is what the founder asked for.
   *
   * The service-plane `POST /api/v1/inbox/followups/:jobId/cancel` IS built and
   * mounted (dakio-api `routes/novaInbox.js`), beside module 04's merchant-plane
   * `POST /api/nova/followups/:jobId/cancel` — same `updateMany`,
   * `lastError:'cancelled:undo'`. This carried a "SERVER COUNTERPART NOT YET
   * BUILT" warning until that landed and kept it afterwards; the undo has been
   * end-to-end since. `schedule_follow_up` returns `undoable:true` and
   * `scripts/check-undo-coverage.ts` requires an engineered inverse, not a
   * comment promising one — and now it has one.
   */
  cancelFollowup(jobId: string): Promise<{ cancelled: boolean }>;
  /**
   * Report the turn back to the reducer (D5 pass 2, D12): the intent the model
   * classified and the NBA candidate it chose.
   *
   * This is the ONLY way a model judgement becomes a stage transition, and it
   * still never sets one — the server's table reads the intent slug and decides.
   * Posting `nbaAction: "do_nothing"` is what makes chosen silence a counted
   * row rather than a turn that looks dropped.
   */
  postIntentObserved(journeyId: string, input: IntentObservedRequest): Promise<IntentObservedResult>;

  // ---- Front Office — selling & conversion (Stage 10, module 05) ----
  //
  // Same rule as every layer above: the SERVER decides. It prices the order
  // from the catalogue, resolves the shipping charge from the district, judges
  // the coupon and decrements the stock — all inside one transaction. Nova
  // hands over what the customer said and is told what was written.
  //
  // Nothing here carries money the model chose. There is no `discount`, no
  // `paid`, no `unitPrice` and no `total` on the way IN, and every figure on
  // the way OUT is in WHOLE TAKA.

  /**
   * Create a COD order agreed in a chat (module 05 D4).
   *
   * ONE ORDER, EVER, per `novaActionId`, and the guarantee is NOT the `w()`
   * wrapper: `w()` does findUnique → run → create, so two concurrent requests
   * with the same key both miss the cache and both run the handler. The real
   * at-most-once control is the route's conditional read-back on
   * `Order.novaActionId` before insert. Callers must therefore pass an id that
   * is STABLE across retries — the approved Decision's id on the approve path,
   * one minted uuid held for the duration of the call on the direct path —
   * because a fresh id per attempt defeats both layers at once.
   *
   * Throws on refusal. A stock-out, a fake-order block, a plan cap or a coupon
   * the server would not honour are ANSWERS about what is legal, and a chat
   * order that was refused must never be reported as one Nova placed: the
   * customer is standing at the other end of the thread being told an order
   * number.
   */
  createChatOrder(input: ChatOrderRequest): Promise<ChatOrderResult>;

  /**
   * The shop's own configured facts: delivery charges, COD, and the policies
   * the merchant has written down (module 05 D2).
   *
   * ⚠️ RESERVED SURFACE — the only caller today is the auto-order cap inside
   * `checkGuardrails`, which reads the delivery charge to size an order against
   * `inbox.maxAutoOrder`. Nothing renders `policies` yet. Saying so is the
   * alternative to a method that looks wired: the `policy_gap` escalation
   * reason already exists for the case where a policy row is absent, and the
   * D2 script that consumes this read lands with the merchant-side CRUD that
   * writes `TenantPolicy` — which has no route yet, so `policies` is `[]` for
   * every tenant on the day this ships. Empty is the honest "the merchant has
   * not told me", not an outage.
   *
   * Money is WHOLE TAKA. See {@link StoreSettings}.
   */
  getStoreSettings(): Promise<StoreSettings>;

  /**
   * This phone's order history, scored (module 05 D4.2).
   *
   * A customer with no history is `level: "NEW"` with zero counts — an ANSWER,
   * not an absence. This THROWS instead when the read cannot be made at all (an
   * unusable phone is a 422; an older server has no such route), and callers
   * must fail CLOSED on the throw: the auto-order guardrail compares `rtoCount`
   * against `inbox.rtoShadowThreshold`, and reading `undefined` off a shape
   * that never arrived compares false with `>=` — which lets every RTO-history
   * customer auto-order at the top of the dial.
   */
  getCustomerRisk(phone: string): Promise<CustomerRiskView>;

  // ---- Front Office delivery coordination (Stage 10 module 06) ----

  /**
   * Open a case, or JOIN the one already open for this subject.
   *
   * `joined` is not decoration. One parcel gets one case however many people ask
   * about it — a Facebook thread and an Instagram thread, or a husband and a
   * wife — and a caller that treats a join as a creation books the founder a
   * second courier card for one problem. The server decides which happened,
   * atomically, off a unique claim; nothing here may infer it.
   */
/**
   * Where a customer's parcel is, in words a customer can hear.
   *
   * Deliberately NOT `getOrder`: that returns the founder-plane shape. This one
   * carries no tracking id, no raw courier scan and no address, because it is
   * the only order read a CUSTOMER session may call.
   */
  getOrderStatus(orderId: string): Promise<OrderStatusView | null>;
  openCase(input: OpenCaseRequest): Promise<{ case: NovaCaseView; joined: boolean }>;
  getCase(caseId: string): Promise<NovaCaseView | null>;
  /**
   * Append facts, move status, or close with a resolution.
   *
   * Facts are APPEND-ONLY server-side and the request cannot express a
   * replacement — a shortened list must never erase what a courier poll found,
   * because those facts get quoted back to a customer. Promise fields are not
   * patchable at all: `keptAt` is stamped only after Graph confirms a real
   * bubble, which is the only reason kept-rate is a number Nova cannot inflate.
   */
  patchCase(caseId: string, patch: PatchCaseRequest): Promise<NovaCaseView>;
  /**
   * Confirm an order against the customer's own yes, or correct its contact
   * details. PRE-DISPATCH ONLY — the server answers 409 once `courierSentAt` is
   * set, because after that the address on the label belongs to the courier.
   * Any contact change RESETS the confirmation: the customer said yes to a
   * specific address and a specific total, and changing either makes that yes
   * about something that no longer exists.
   */
  updateOrderDelivery(orderId: string, patch: UpdateOrderDeliveryRequest): Promise<Order>;

  // ---- Proactive job queue (Phase 05) ----

  listJobDefs(): Promise<NovaJobDef[]>;
  upsertJobDef(
    kind: JobKind,
    input: { cadence: string; tz: string; enabled?: boolean; config?: Record<string, unknown> },
  ): Promise<NovaJobDef>;
  /** Expands due job-defs and drains debounced events into jobs, then atomically leases up to `limit` due rows for this tenant. Each returned job carries its own fresh `leaseToken`. */
  claimDueJobs(limit: number): Promise<NovaJob[]>;
  /**
   * `leaseToken` must be the value the job was claimed with — a stale
   * (superseded) lease's call is a safe no-op, never overwriting a newer
   * lease's outcome.
   *
   * Resolves `{ ok: true, stale }`. `stale: true` means the no-op happened:
   * this lease was already recovered by the watchdog (or the row is already
   * done/failed), nothing was written, and the work this caller just finished
   * may be running again somewhere else. It is NOT an error and must not be
   * retried — but it is the only notice a caller ever gets, so swallowing it
   * is how duplicate side effects go unnoticed.
   */
  completeJob(id: string, leaseToken: string, sessionId?: string): Promise<JobSettleResult>;
  /** Requeues with backoff below the attempts cap, or marks `failed` at the cap. Same stale-lease-safe contract and `JobSettleResult` as completeJob. */
  releaseJob(id: string, leaseToken: string, error: string): Promise<JobSettleResult>;

  // ---- Catalog photo memory (Stage 11 Phase 3 — product vision) ----
  //
  // The caption-fingerprint index. Rows live in dakio-api
  // (ProductImageMemory, `caption == null` = pending outbox); the vision +
  // embedding calls happen on THIS side (lib/catalog/visionIndex.ts), so
  // these three are plain data doors: hand out pending work, store results,
  // read the finished index. Identity only throughout — a fingerprint never
  // carries price or stock (PRD §4: money answers come from the live
  // product read, never from memory).

  /** Up to 100 photos still awaiting a caption, oldest first, with the product name for caption context. */
  listPendingCatalogPhotos(limit?: number): Promise<{ photos: CatalogPhotoPending[]; pendingTotal: number }>;
  /** Store a batch of caption results; a result without caption+embedding counts a failed attempt (3 strikes parks the photo). */
  recordCatalogPhotoReadings(
    results: CatalogPhotoResult[],
  ): Promise<{ captioned: number; failed: number; pendingAfter: number }>;
  /** Every captioned fingerprint (PUBLISHED products only), variant link included when a merchant linked the photo. */
  listCatalogPhotoFingerprints(): Promise<{ fingerprints: CatalogPhotoFingerprint[] }>;

  // ---- Per-turn run audit (NovaRun) ----
  //
  // Written by every channel's turn-lifecycle handlers (lib/runs.ts). Both
  // are idempotent upserts on (sessionId, turnId) server-side, so redelivery
  // is safe; both are best-effort at the call site — an audit write must
  // never fail a turn.

  recordRunStart(input: RunStartInput): Promise<void>;
  recordRunFinish(input: RunFinishInput): Promise<void>;
}

export interface CatalogPhotoPending {
  id: string;
  productId: string;
  productName: string;
  url: string;
  attempts: number;
}

export interface CatalogPhotoResult {
  id: string;
  caption?: string;
  embedding?: number[];
  error?: string;
}

export interface CatalogPhotoFingerprint {
  id: string;
  productId: string;
  productName: string;
  url: string;
  caption: string;
  embedding: number[] | null;
  variantName: string | null;
}

export interface RunStartInput {
  sessionId: string;
  turnId: string;
  kind: "customer_turn" | "founder_turn" | "job_turn";
  lane: "customer" | "founder";
  conversationId?: string;
  jobId?: string;
}

export interface RunFinishInput extends RunStartInput {
  outcome: "completed" | "failed" | "cancelled";
  error?: string;
  /**
   * Sales-Engine Phase 1. All three are optional on purpose: the server treats
   * an absent block as "no measurement" and settles the run exactly as it did
   * before, so either repo can be rolled back without breaking the other.
   *
   * `timing` values are millisecond offsets on THIS process's clock (except
   * `originAt`), never timestamps to be subtracted against a dakio-api or
   * Postgres stamp. `actionIds` closes the run↔action join the customer lane
   * has never had.
   */
  timing?: Record<string, number | string | string[]>;
  usage?: Record<string, number | string>;
  actionIds?: string[];
}
