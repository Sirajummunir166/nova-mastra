/**
 * DakioStoreClient — the live HTTP implementation of {@link StoreClient}
 * (Phase 02). It talks to the Dakio Express backend over HTTPS:
 *
 *   - agent data (config/memory/activity/actions/reports/experiments/playbooks/
 *     inbox) ↔ `/api/v1/agent-data/*`
 *   - commerce reads (products/customers/orders/carts/discounts/expenses/
 *     suppliers/purchase-orders/campaigns/couriers/trending) ← `/api/v1/store/*`
 *   - Grow Lab reads (campaigns/posts/broadcasts/ideas/goals) ←
 *     `/api/v1/store/grow/*` (Phase 06; writes stay with the action pipeline)
 *
 * The backend returns already-Nova-shaped JSON, so this client is a thin
 * adapter: fetch → unwrap. All impedance (Decimal→number, status maps, derived
 * customer segment/LTV, stock summing) lives server-side in `routes/novaStore.js`.
 *
 * SCOPE — Phase 2.1 shipped read-only commerce + full agent-data. Phase 2.2
 * adds commerce mutations: products, orders (status/courier), abandoned-cart
 * recovery state, discounts, purchase orders. Campaign writes, social posts,
 * support-ticket status, and customer messaging remain {@link NotImplementedError}
 * — not oversights but gaps with no honest Dakio backing (campaigns are a
 * read-only product decision; the rest have no ticket-status store or
 * customer↔Meta-conversation link to write through). A mis-configured
 * autonomy level fails loudly on these rather than pretending to act. Gap
 * groups with no live source yet (couriers, trending, campaign insights) read
 * as empty. See `docs/blueprint/02-findings-live-dakio.md`.
 *
 * Auth: a per-tenant Nova service token (Bearer). Tenancy is enforced server-
 * side from the token; this client never sends a store id in the body.
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
  LinkCustomerRequest,
  LinkCustomerResult,
  MemoryEntry,
  MemoryNamespace,
  MemoryUpsert,
  MorningBrief,
  NbaBlock,
  NovaExperiment,
  NovaJob,
  NovaJobDef,
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
import type {
  StoreClient,
  FiledAction,
  RunStartInput,
  RunFinishInput,
  CatalogPhotoPending,
  CatalogPhotoResult,
  CatalogPhotoFingerprint,
} from "./client.js";
import { InboxSendRefused } from "./client.js";
import { DEFAULT_GUARDRAILS } from "./autonomy.js";

export class NotImplementedError extends Error {
  constructor(method: string) {
    super(`${method} is not available until Phase 2.2 (live commerce mutations).`);
    this.name = "NotImplementedError";
  }
}

export interface DakioClientConfig {
  baseUrl: string;
  /**
   * Per-tenant Nova service token (Bearer). Either a static string or a
   * provider called once per request — pass a provider for self-minted tokens
   * so a short-TTL credential refreshes without rebuilding the cached client.
   */
  token: string | (() => string);
  /** Retry budget for 429/5xx. Default 3. */
  maxRetries?: number;
}

interface RequestOptions {
  method?: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Return null instead of throwing on 404 (for get-by-id). */
  nullOn404?: boolean;
  /**
   * Use THIS as the Idempotency-Key instead of a fresh uuid, so a caller that
   * already owns a stable id for the logical write (the inbox reply's
   * `novaActionId`) gets replay protection across process restarts too, not
   * just across this call's own retries.
   */
  idempotencyKey?: string;
  /**
   * Statuses whose JSON body carries a machine-readable refusal
   * (`{error|code}`) rather than a server fault — surfaced as
   * {@link InboxSendRefused} so callers can act on the CODE instead of
   * regex-ing an error string. Never retried: a 409 is an answer.
   */
  refusalOn?: number[];
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export class DakioStoreClient implements StoreClient {
  private readonly base: string;
  private readonly tokenProvider: () => string;
  private readonly maxRetries: number;

  constructor(
    private readonly storeId: string,
    config: DakioClientConfig,
  ) {
    this.base = config.baseUrl.replace(/\/+$/, "");
    this.tokenProvider = typeof config.token === "function" ? config.token : () => config.token as string;
    this.maxRetries = config.maxRetries ?? 3;
  }

  now(): string {
    return new Date().toISOString();
  }

  // --- HTTP core ------------------------------------------------------------

  private url(path: string, query?: RequestOptions["query"]): string {
    const u = new URL(this.base + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) u.searchParams.set(k, String(v));
      }
    }
    return u.toString();
  }

  private async request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const method = opts.method ?? "GET";
    const isWrite = method !== "GET" && method !== "HEAD";
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.tokenProvider()}`,
      accept: "application/json",
    };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    // Stable idempotency key per logical call, reused across retries so a
    // replayed write is deduped server-side (blueprint §Idempotency).
    if (isWrite) headers["idempotency-key"] = opts.idempotencyKey ?? crypto.randomUUID();

    const url = this.url(path, opts.query);
    let lastErr: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers,
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        });
      } catch (err) {
        // Network error — retry with backoff.
        lastErr = err;
        if (attempt < this.maxRetries) {
          await this.backoff(attempt);
          continue;
        }
        throw new Error(`Dakio ${method} ${path} failed: ${String(err)}`);
      }

      if (res.status === 404 && opts.nullOn404) {
        return null as T;
      }
      // A declared refusal is an ANSWER, not a fault: never retried, and
      // carried to the caller with its code intact.
      if (opts.refusalOn?.includes(res.status)) {
        const detail = await res.text().catch(() => "");
        let code = String(res.status);
        let message = detail.slice(0, 300);
        try {
          const parsed = JSON.parse(detail) as { error?: unknown; code?: unknown; message?: unknown };
          code = String(parsed.code ?? parsed.error ?? code);
          message = String(parsed.message ?? parsed.error ?? message);
        } catch {
          /* Non-JSON body: keep the raw text as the message. */
        }
        throw new InboxSendRefused(code, `Dakio ${method} ${path} refused: ${code} — ${message}`, res.status);
      }
      if (res.ok) {
        if (res.status === 204) return undefined as T;
        return (await res.json()) as T;
      }
      if (RETRYABLE.has(res.status) && attempt < this.maxRetries) {
        lastErr = new Error(`HTTP ${res.status}`);
        await this.backoff(attempt);
        continue;
      }
      // Non-retryable (or budget exhausted): surface the taxonomy.
      const detail = await res.text().catch(() => "");
      throw new Error(`Dakio ${method} ${path} → ${res.status}: ${detail.slice(0, 300)}`);
    }
    throw new Error(`Dakio ${method} ${path} exhausted retries: ${String(lastErr)}`);
  }

  private backoff(attempt: number): Promise<void> {
    // Exponential + jitter: ~150ms, 300ms, 600ms …
    const base = 150 * 2 ** attempt;
    const jitter = base * 0.25 * Math.random();
    return new Promise((r) => setTimeout(r, base + jitter));
  }

  private get<T>(path: string, query?: RequestOptions["query"], nullOn404 = false): Promise<T> {
    return this.request<T>(path, { query, nullOn404 });
  }

  // ==========================================================================
  // Catalog (read)
  // ==========================================================================

  async listProducts(filter?: { status?: Product["status"]; category?: string }): Promise<Product[]> {
    const { products } = await this.get<{ products: Product[] }>("/api/v1/store/products", {
      status: filter?.status,
      category: filter?.category,
    });
    return products;
  }

  async getProduct(id: string): Promise<Product | null> {
    return this.get<Product | null>(`/api/v1/store/products/${encodeURIComponent(id)}`, undefined, true);
  }

  async createProduct(product: Omit<Product, "id" | "createdAt">): Promise<Product> {
    return this.request<Product>("/api/v1/store/products", { method: "POST", body: product });
  }

  async updateProduct(
    id: string,
    patch: Partial<Pick<Product, "price" | "compareAtPrice" | "stock" | "status" | "supplierId" | "cost">>,
  ): Promise<Product> {
    return this.request<Product>(`/api/v1/store/products/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: patch,
    });
  }

  async listTrendingProducts(): Promise<TrendingProduct[]> {
    const { trending } = await this.get<{ trending: TrendingProduct[] }>("/api/v1/store/trending");
    return trending;
  }

  // ==========================================================================
  // Customers (read)
  // ==========================================================================

  async listCustomers(filter?: { segment?: Customer["segment"] }): Promise<Customer[]> {
    const { customers } = await this.get<{ customers: Customer[] }>("/api/v1/store/customers", {
      segment: filter?.segment,
    });
    return customers;
  }

  async getCustomer(id: string): Promise<Customer | null> {
    return this.get<Customer | null>(`/api/v1/store/customers/${encodeURIComponent(id)}`, undefined, true);
  }

  // ==========================================================================
  // Orders (read; status/courier mutations are Phase 2.2)
  // ==========================================================================

  async listOrders(filter?: { sinceDays?: number; status?: OrderStatus; customerId?: string }): Promise<Order[]> {
    const { orders } = await this.get<{ orders: Order[] }>("/api/v1/store/orders", {
      sinceDays: filter?.sinceDays,
      status: filter?.status,
      customerId: filter?.customerId,
    });
    return orders;
  }

  async getOrder(id: string): Promise<Order | null> {
    return this.get<Order | null>(`/api/v1/store/orders/${encodeURIComponent(id)}`, undefined, true);
  }

  async updateOrder(patch: { id: string; status?: OrderStatus; courierId?: string }): Promise<Order> {
    const { id, ...body } = patch;
    return this.request<Order>(`/api/v1/store/orders/${encodeURIComponent(id)}`, { method: "PATCH", body });
  }

  // ==========================================================================
  // Abandoned carts (read; recovery mutation is Phase 2.2)
  // ==========================================================================

  async listAbandonedCarts(state?: CartRecoveryState): Promise<AbandonedCart[]> {
    const { carts } = await this.get<{ carts: AbandonedCart[] }>("/api/v1/store/carts");
    return state === undefined ? carts : carts.filter((c) => c.recoveryState === state);
  }

  async updateCart(
    id: string,
    patch: { recoveryState?: CartRecoveryState; recoveryMessage?: string | null },
  ): Promise<AbandonedCart> {
    return this.request<AbandonedCart>(`/api/v1/store/carts/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: patch,
    });
  }

  // ==========================================================================
  // Marketing (campaigns read-only Meta; social posts are a gap)
  // ==========================================================================

  async listCampaigns(status?: Campaign["status"]): Promise<Campaign[]> {
    const { campaigns } = await this.get<{ campaigns: Campaign[] }>("/api/v1/store/campaigns");
    return status === undefined ? campaigns : campaigns.filter((c) => c.status === status);
  }

  async getCampaign(id: string): Promise<Campaign | null> {
    const campaigns = await this.listCampaigns();
    return campaigns.find((c) => c.id === id) ?? null;
  }

  async createCampaign(): Promise<Campaign> {
    throw new NotImplementedError("createCampaign");
  }

  async updateCampaign(): Promise<Campaign> {
    throw new NotImplementedError("updateCampaign");
  }

  // Social posts: no live Dakio source (Meta content-publishing not integrated).
  async listSocialPosts(): Promise<SocialPost[]> {
    return [];
  }

  async createSocialPost(): Promise<SocialPost> {
    throw new NotImplementedError("createSocialPost");
  }

  async updateSocialPost(): Promise<SocialPost> {
    throw new NotImplementedError("updateSocialPost");
  }

  async listDiscounts(activeOnly?: boolean): Promise<Discount[]> {
    const { discounts } = await this.get<{ discounts: Discount[] }>("/api/v1/store/discounts", {
      activeOnly: activeOnly === true ? true : undefined,
    });
    return discounts;
  }

  async createDiscount(discount: CreateDiscountInput): Promise<Discount> {
    // The code is upper-cased HERE as well as server-side, and the redundancy
    // is deliberate: `@@unique([tenantId, code])` is case-sensitive in
    // Postgres, so "save10" and "SAVE10" coexist as two rows and the route's
    // P2002 collision handler never fires on the pair. Folding on the way out
    // means a caller cannot mint the second row by accident even against a
    // server that has not shipped module 05's fold yet.
    return this.request<Discount>("/api/v1/store/discounts", {
      method: "POST",
      body: { ...discount, code: discount.code.trim().toUpperCase() },
    });
  }

  async validateCoupon(code: string, subtotal: number): Promise<CouponValidation> {
    // POST, not GET, and a route of its own rather than `coupons.js`'s: that one
    // resolves the tenant by storefront SLUG, and this router is authenticated
    // by the per-tenant service token. Same discount math, different doorway.
    //
    // `subtotal` always rides the body, even when it is 0. Sending it
    // conditionally would reproduce the exact hole module 05 declined to port —
    // an absent subtotal skips the `minOrder` check and answers `valid: true`.
    //
    // No `idempotencyKey`, on purpose, even though `request()` treats any POST
    // as a write and stamps one: the default is a FRESH uuid per call, which is
    // what a check whose answer depends on the subtotal needs. `NovaIdempotency`
    // has no TTL and no sweeper, so a stable key here would pin one verdict for
    // this code forever — the customer removes an item, drops below `minOrder`,
    // and is still told the coupon holds.
    return this.request<CouponValidation>("/api/v1/store/discounts/validate", {
      method: "POST",
      body: { code: code.trim().toUpperCase(), subtotal },
    });
  }

  async updateDiscount(id: string, patch: { active: boolean }): Promise<Discount> {
    return this.request<Discount>(`/api/v1/store/discounts/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: patch,
    });
  }

  // ==========================================================================
  // Grow Lab (read) — the six founder-facing modules, live from Dakio.
  //
  // Read-only by design; Grow writes go through the action pipeline into the
  // backend's shared `growService`, so a Nova-authored row obeys the same
  // rules a founder's does. Filtering is server-side (the backend indexes
  // `[tenantId, status]`), so the status argument is a query param, not a
  // client-side filter over a full fetch.
  // ==========================================================================

  async listGrowCampaigns(status?: GrowCampaign["status"]): Promise<GrowCampaign[]> {
    const { campaigns } = await this.get<{ campaigns: GrowCampaign[] }>("/api/v1/store/grow/campaigns", { status });
    return campaigns;
  }

  async listGrowPosts(status?: GrowPost["status"]): Promise<GrowPost[]> {
    const { posts } = await this.get<{ posts: GrowPost[] }>("/api/v1/store/grow/posts", { status });
    return posts;
  }

  async listGrowBroadcasts(): Promise<GrowBroadcast[]> {
    const { broadcasts } = await this.get<{ broadcasts: GrowBroadcast[] }>("/api/v1/store/grow/broadcasts");
    return broadcasts;
  }

  async listGrowIdeas(status?: GrowIdea["status"]): Promise<GrowIdea[]> {
    const { ideas } = await this.get<{ ideas: GrowIdea[] }>("/api/v1/store/grow/ideas", { status });
    return ideas;
  }

  async getGrowGoal(month?: string): Promise<GrowGoal | null> {
    const { goal } = await this.get<{ goal: GrowGoal | null }>("/api/v1/store/grow/goals", { month });
    return goal;
  }

  // ==========================================================================
  // Support & messaging — Phase 2.2 (map to Meta inbox + email). Reads empty.
  // ==========================================================================

  async listSupportTickets(): Promise<SupportTicket[]> {
    return [];
  }

  async getSupportTicket(): Promise<SupportTicket | null> {
    return null;
  }

  async addTicketMessage(): Promise<SupportTicket> {
    throw new NotImplementedError("addTicketMessage");
  }

  async updateTicketStatus(): Promise<SupportTicket> {
    throw new NotImplementedError("updateTicketStatus");
  }

  async listCustomerMessages(): Promise<CustomerMessage[]> {
    return [];
  }

  async addCustomerMessage(): Promise<CustomerMessage> {
    throw new NotImplementedError("addCustomerMessage");
  }

  // ==========================================================================
  // Suppliers & logistics (read; couriers are a gap)
  // ==========================================================================

  async listSuppliers(): Promise<Supplier[]> {
    const { suppliers } = await this.get<{ suppliers: Supplier[] }>("/api/v1/store/suppliers");
    return suppliers;
  }

  async getSupplier(id: string): Promise<Supplier | null> {
    return this.get<Supplier | null>(`/api/v1/store/suppliers/${encodeURIComponent(id)}`, undefined, true);
  }

  async listPurchaseOrders(status?: PurchaseOrder["status"]): Promise<PurchaseOrder[]> {
    const { purchaseOrders } = await this.get<{ purchaseOrders: PurchaseOrder[] }>(
      "/api/v1/store/purchase-orders",
      { status },
    );
    return purchaseOrders;
  }

  async createPurchaseOrder(po: Omit<PurchaseOrder, "id" | "createdAt" | "total">): Promise<PurchaseOrder> {
    return this.request<PurchaseOrder>("/api/v1/store/purchase-orders", { method: "POST", body: po });
  }

  async updatePurchaseOrder(id: string, patch: { status: PurchaseOrder["status"] }): Promise<PurchaseOrder> {
    return this.request<PurchaseOrder>(`/api/v1/store/purchase-orders/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: patch,
    });
  }

  async listCouriers(): Promise<Courier[]> {
    const { couriers } = await this.get<{ couriers: Courier[] }>("/api/v1/store/couriers");
    return couriers;
  }

  async getCourier(id: string): Promise<Courier | null> {
    const couriers = await this.listCouriers();
    return couriers.find((c) => c.id === id) ?? null;
  }

  // ==========================================================================
  // Finance (read)
  // ==========================================================================

  async listExpenses(sinceDays?: number): Promise<ExpenseEntry[]> {
    const { expenses } = await this.get<{ expenses: ExpenseEntry[] }>("/api/v1/store/expenses", { sinceDays });
    return expenses;
  }

  // ---- Ledger-backed finance (`/api/v1/store/finance/*`) --------------------
  // The grounding seam (DAKIO_FINANCE_PRD §12.3): sums over journal lines,
  // shaped server-side by the same views the merchant's Money screens render.
  // `{ ledgerActive: false }` rides through untouched — the caller owns the
  // honest-fallback branch, not this adapter.

  async getFinanceOverview(): Promise<FinanceOverview> {
    return this.get<FinanceOverview>("/api/v1/store/finance/overview");
  }

  async getFinancePnl(opts?: { from?: string; to?: string; compare?: boolean }): Promise<FinancePnl> {
    return this.get<FinancePnl>("/api/v1/store/finance/pnl", {
      from: opts?.from,
      to: opts?.to,
      compare: opts?.compare ? "1" : undefined,
    });
  }

  async getFinanceAccounts(): Promise<FinanceAccounts> {
    return this.get<FinanceAccounts>("/api/v1/store/finance/accounts");
  }

  async getAccountStatement(
    code: string,
    opts?: { from?: string; to?: string; limit?: number },
  ): Promise<AccountStatement | null> {
    return this.get<AccountStatement | null>(
      `/api/v1/store/finance/accounts/${encodeURIComponent(code)}/ledger`,
      { from: opts?.from, to: opts?.to, limit: opts?.limit },
      true, // 404 → null: an unknown code is an answer, not an outage
    );
  }

  // ==========================================================================
  // Nova agent data (persisted in Dakio via /api/v1/agent-data/*)
  // ==========================================================================

  async getAutonomy(): Promise<AutonomyConfig> {
    const { autonomy } = await this.get<{ autonomy: AutonomyConfig | null }>("/api/v1/agent-data/config");
    return autonomy ?? { level: 2, guardrails: DEFAULT_GUARDRAILS, updatedAt: this.now() };
  }

  /**
   * Stage 1 authority state — one composed read per turn.
   *
   * Deliberately NOT defensive: if the backend can't answer, this throws and
   * `evaluateAuthority` fails closed. Substituting a default here would mean
   * an outage silently reads as "no locks, no limits", which is the one
   * failure mode this whole seam exists to prevent.
   */
  async getAuthority(): Promise<AuthorityState> {
    const { authority } = await this.get<{ authority: AuthorityState }>("/api/v1/agent-data/authority");
    if (!authority || typeof authority.level !== "number" || !authority.guardrails) {
      throw new Error("Dakio returned an incomplete authority state");
    }
    return authority;
  }

  // ==========================================================================
  // Decisions (E-9, Stage 2)
  // ==========================================================================

  async listDecisions(filter?: { status?: DecisionRecord["status"]; tag?: string; limit?: number }): Promise<DecisionRecord[]> {
    const { decisions } = await this.get<{ decisions: DecisionRecord[] }>("/api/v1/agent-data/decisions", {
      status: filter?.status,
      tag: filter?.tag,
      limit: filter?.limit,
    });
    return decisions;
  }

  async addDecision(decision: Omit<DecisionRecord, "id" | "createdAt" | "queuePos" | "status" | "decidedBy" | "decidedAt" | "bundleRef" | "frozenByLock">): Promise<DecisionRecord> {
    return this.request<DecisionRecord>("/api/v1/agent-data/decisions", { method: "POST", body: decision });
  }

  async updateDecision(id: string, patch: Partial<Pick<DecisionRecord, "status" | "surfacedIn" | "queuePos" | "frozenByLock" | "decidedBy" | "decidedAt">>): Promise<DecisionRecord> {
    return this.request<DecisionRecord>(`/api/v1/agent-data/decisions/${encodeURIComponent(id)}`, { method: "PATCH", body: patch });
  }

  async setNoTouch(locks: string[]): Promise<string[]> {
    const { noTouch } = await this.request<{ noTouch: string[] }>("/api/v1/agent-data/authority/no-touch", {
      method: "PUT",
      body: { noTouch: locks },
    });
    return noTouch;
  }

  async setAutonomy(config: AutonomyConfig): Promise<AutonomyConfig> {
    const { autonomy } = await this.request<{ autonomy: AutonomyConfig }>("/api/v1/agent-data/config", {
      method: "PUT",
      body: { autonomy: config },
    });
    return autonomy;
  }

  async listMemory(namespace?: MemoryNamespace): Promise<MemoryEntry[]> {
    const { entries } = await this.get<{ entries: MemoryEntry[] }>("/api/v1/agent-data/memory", { namespace });
    return entries;
  }

  async upsertMemory(entry: MemoryUpsert): Promise<MemoryEntry> {
    // 422 is the redaction guard saying no (Stage 10 module 03, D10): the
    // server refuses values carrying an NID, a card PAN or a one-time code.
    // Declaring it a REFUSAL is what stops it being retried three times on the
    // way to becoming an opaque transport error — the guard will never say yes,
    // and `asMemoryRefusal` (agent/lib/memory/service.ts) needs the server's own
    // code to build the sentence that tells the model why and not to try again.
    return this.request<MemoryEntry>("/api/v1/agent-data/memory", {
      method: "POST",
      body: entry,
      refusalOn: [422],
    });
  }

  async deleteMemory(namespace: MemoryNamespace, key: string): Promise<boolean> {
    const { deleted } = await this.request<{ deleted: boolean }>("/api/v1/agent-data/memory", {
      method: "DELETE",
      body: { namespace, key },
    });
    return deleted;
  }

  async setMemoryEmbedding(namespace: MemoryNamespace, key: string, embedding: number[]): Promise<boolean> {
    const { ok } = await this.request<{ ok: boolean }>("/api/v1/agent-data/memory/embedding", {
      method: "POST",
      body: { namespace, key, embedding },
    });
    return ok;
  }

  async listActivity(filter?: {
    sinceDays?: number;
    department?: ActivityEntry["department"];
  }): Promise<ActivityEntry[]> {
    const { entries } = await this.get<{ entries: ActivityEntry[] }>("/api/v1/agent-data/activity", {
      sinceDays: filter?.sinceDays,
      department: filter?.department,
    });
    return entries;
  }

  async addActivity(entry: Omit<ActivityEntry, "id" | "at">): Promise<ActivityEntry> {
    return this.request<ActivityEntry>("/api/v1/agent-data/activity", { method: "POST", body: entry });
  }

  async updateActivity(
    id: string,
    patch: Partial<Pick<ActivityEntry, "revenueInfluence" | "revenueBasis" | "revenueProvenance">>,
  ): Promise<ActivityEntry> {
    return this.request<ActivityEntry>(`/api/v1/agent-data/activity/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: patch,
    });
  }

  // ---- Night shift outputs (E-4/E-6/E-7/E-16, Stage 3) ----
  async setDepartment(dept: DepartmentGrade): Promise<DepartmentGrade> {
    return this.request<DepartmentGrade>("/api/v1/agent-data/departments", { method: "POST", body: dept });
  }

  async listDepartments(): Promise<DepartmentGrade[]> {
    const { departments } = await this.get<{ departments: DepartmentGrade[] }>("/api/v1/agent-data/departments");
    return departments;
  }

  async addPlanItem(item: Omit<PlanItem, "id">): Promise<PlanItem> {
    return this.request<PlanItem>("/api/v1/agent-data/plan-items", { method: "POST", body: item });
  }

  async fileBrief(input: { day?: string; narrative?: string }): Promise<MorningBrief> {
    return this.request<MorningBrief>("/api/v1/agent-data/briefs", { method: "POST", body: input });
  }

  async getBrandProfile(): Promise<BrandProfile> {
    const { brand } = await this.get<{ brand: BrandProfile }>("/api/v1/agent-data/brand");
    return brand;
  }

  async fileContent(input: ContentDraftInput): Promise<ContentItem> {
    return this.request<ContentItem>("/api/v1/agent-data/content", { method: "POST", body: input });
  }

  async listPlaybooks(status?: NovaPlaybook["status"]): Promise<NovaPlaybook[]> {
    const { playbooks } = await this.get<{ playbooks: NovaPlaybook[] }>("/api/v1/agent-data/playbooks", { status });
    return playbooks;
  }

  async upsertPlaybook(
    playbook: Omit<NovaPlaybook, "id" | "createdAt"> & { id?: string },
  ): Promise<NovaPlaybook> {
    return this.request<NovaPlaybook>("/api/v1/agent-data/playbooks", { method: "POST", body: playbook });
  }

  async updatePlaybookStatus(id: string, status: NovaPlaybook["status"]): Promise<NovaPlaybook> {
    return this.request<NovaPlaybook>(`/api/v1/agent-data/playbooks/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: { status },
    });
  }

  async listExperiments(status?: NovaExperiment["status"]): Promise<NovaExperiment[]> {
    const { experiments } = await this.get<{ experiments: NovaExperiment[] }>("/api/v1/agent-data/experiments", {
      status,
    });
    return experiments;
  }

  async getExperiment(id: string): Promise<NovaExperiment | null> {
    return this.get<NovaExperiment | null>(
      `/api/v1/agent-data/experiments/${encodeURIComponent(id)}`,
      undefined,
      true,
    );
  }

  async createExperiment(experiment: Omit<NovaExperiment, "id" | "startedAt">): Promise<NovaExperiment> {
    return this.request<NovaExperiment>("/api/v1/agent-data/experiments", { method: "POST", body: experiment });
  }

  async updateExperiment(
    id: string,
    patch: Partial<Pick<NovaExperiment, "actual" | "status" | "evaluatedAt" | "actionIds">>,
  ): Promise<NovaExperiment> {
    return this.request<NovaExperiment>(`/api/v1/agent-data/experiments/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: patch,
    });
  }

  // The dakio-api receipt wire shape uses `expected_impact` (PRD §12 naming);
  // TypeScript uses `expectedImpact` everywhere. Map at the boundary only.
  private receiptToWire(receipt: ActionRecord["receipt"]): Record<string, unknown> {
    const { expectedImpact, ...rest } = receipt;
    return { ...rest, expected_impact: expectedImpact };
  }

  private actionFromWire(row: Record<string, unknown>): ActionRecord {
    const wire = row.receipt as (Record<string, unknown> & { expected_impact?: string }) | null;
    const receipt = wire
      ? (() => {
          const { expected_impact, ...rest } = wire;
          return { ...rest, expectedImpact: expected_impact ?? "" };
        })()
      : null;
    return { ...(row as unknown as ActionRecord), receipt: receipt as ActionRecord["receipt"] };
  }

  async listActions(status?: ActionStatus): Promise<ActionRecord[]> {
    const { actions } = await this.get<{ actions: Record<string, unknown>[] }>("/api/v1/agent-data/actions", { status });
    return actions.map((a) => this.actionFromWire(a));
  }

  async getAction(id: string): Promise<ActionRecord | null> {
    const row = await this.get<Record<string, unknown> | null>(
      `/api/v1/agent-data/actions/${encodeURIComponent(id)}`,
      undefined,
      true,
    );
    return row ? this.actionFromWire(row) : null;
  }

  /**
   * File an action. The response's `replayed` discriminator rides through
   * UNTOUCHED when the server sends one, and is dropped entirely when it does
   * not — see `FiledAction` in client.ts for why "the server did not say" must
   * not collapse into `false`. Anything other than a real boolean is treated as
   * "did not say": a truthy string from an older route would otherwise read as
   * a replay and silently skip a side effect that never ran.
   */
  async addAction(record: Omit<ActionRecord, "id" | "createdAt">): Promise<FiledAction> {
    const body = { ...record, receipt: this.receiptToWire(record.receipt) };
    const row = await this.request<Record<string, unknown>>("/api/v1/agent-data/actions", { method: "POST", body });
    const filed = this.actionFromWire(row) as FiledAction;
    if (typeof row.replayed === "boolean") return { ...filed, replayed: row.replayed };
    delete filed.replayed;
    return filed;
  }

  async updateAction(
    id: string,
    patch: Partial<Pick<ActionRecord, "status" | "outcome" | "undoData" | "undoable" | "decidedAt" | "executedAt">>,
  ): Promise<ActionRecord> {
    const row = await this.request<Record<string, unknown>>(`/api/v1/agent-data/actions/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: patch,
    });
    return this.actionFromWire(row);
  }

  async executePreparedAction(actionId: string): Promise<{ executed: boolean; note: string }> {
    const res = await this.request<{ executed: boolean; note: string }>(
      `/api/v1/agent-data/actions/${encodeURIComponent(actionId)}/approve`,
      { method: "POST", body: {} },
    );
    return { executed: res.executed, note: res.note };
  }

  async attributeDoorRecord(targetRef: string, actionId: string): Promise<void> {
    await this.request("/api/v1/agent-data/attribute", {
      method: "POST",
      body: { targetRef, novaActionId: actionId },
    });
  }

  async listReports(filter?: { kind?: NovaReport["kind"]; limit?: number }): Promise<NovaReport[]> {
    const { reports } = await this.get<{ reports: NovaReport[] }>("/api/v1/agent-data/reports", {
      kind: filter?.kind,
      limit: filter?.limit,
    });
    return reports;
  }

  async addReport(report: Omit<NovaReport, "id" | "createdAt">): Promise<NovaReport> {
    return this.request<NovaReport>("/api/v1/agent-data/reports", { method: "POST", body: report });
  }

  // ==========================================================================
  // Inbox — inbound store events (Phase 2.3)
  // ==========================================================================

  async listInboxEvents(filter?: { processed?: boolean }): Promise<InboxEvent[]> {
    const { events } = await this.get<{ events: InboxEvent[] }>("/api/v1/agent-data/inbox", {
      processed: filter?.processed,
    });
    return events;
  }

  async markEventProcessed(id: string): Promise<InboxEvent> {
    return this.request<InboxEvent>(`/api/v1/agent-data/inbox/${encodeURIComponent(id)}`, { method: "PATCH" });
  }

  // ==========================================================================
  // Front Office — customer conversations (Stage 10, `/api/v1/inbox/*`)
  //
  // A separate router from `/api/v1/store` and `/api/v1/agent-data`, same
  // per-tenant service token. The reply and handover routes are `w()`
  // idempotent server-side keyed on the Idempotency-Key header, which is why
  // both writes pass their `novaActionId` as the key rather than letting
  // `request()` mint a throwaway uuid: a retry after a network timeout must
  // not queue the message twice.
  // ==========================================================================

  async getInboxConversation(
    conversationId: string,
    opts?: { messages?: number },
  ): Promise<InboxThread | null> {
    return this.get<InboxThread | null>(
      `/api/v1/inbox/conversations/${encodeURIComponent(conversationId)}`,
      { messages: opts?.messages },
      true,
    );
  }

  async getSessionEpoch(conversationId: string): Promise<number> {
    // Total on purpose. This read sits on the dispatch path in front of a 202,
    // and a throw here would drop a real customer message. Degrading to 0 is
    // safe because BOTH lanes degrade identically: they still agree with each
    // other, and the worst case is one extra session roll — which costs nothing
    // on this lane, since the model re-reads the thread every turn anyway.
    try {
      const res = await this.get<{ epoch?: number } | null>(
        `/api/v1/inbox/conversations/${encodeURIComponent(conversationId)}/session-epoch`,
        {},
        true,
      );
      const epoch = Number(res?.epoch);
      return Number.isFinite(epoch) && epoch > 0 ? Math.floor(epoch) : 0;
    } catch {
      return 0;
    }
  }

  async noteProductIdentified(conversationId: string, productId: string): Promise<void> {
    await this.request<{ ok: boolean }>(
      `/api/v1/inbox/conversations/${encodeURIComponent(conversationId)}/product-identified`,
      { method: "POST", body: { productId } },
    );
  }

  async replyInThread(conversationId: string, input: InboxReplyRequest): Promise<InboxReplyResult> {
    return this.request<InboxReplyResult>(
      `/api/v1/inbox/conversations/${encodeURIComponent(conversationId)}/reply`,
      {
        method: "POST",
        body: input,
        idempotencyKey: input.novaActionId,
        // The guard ladder answers 409 with a code; the server has already
        // written the receipted blocked row by then.
        //
        // 429 joins them even though it is in {@link RETRYABLE}, because on
        // THIS route it is not a transient: the server already did the D10
        // rung-7 in-process re-take and, having failed it, wrote a receipted
        // `rate:nova_send_budget` blocked row. Retrying past that would land a
        // reply the ledger has already recorded as held back — one conversation
        // with both a blocked row and a sent message is a lie either way round.
        // `RATE_LIMITED` is a declared refusal code for exactly this reason.
        refusalOn: [409, 429],
      },
    );
  }

  async handoverConversation(
    conversationId: string,
    input: InboxHandoverRequest,
  ): Promise<InboxHandoverResult> {
    return this.request<InboxHandoverResult>(
      `/api/v1/inbox/conversations/${encodeURIComponent(conversationId)}/handover`,
      { method: "POST", body: input, idempotencyKey: input.novaActionId },
    );
  }

  // ==========================================================================
  // Front Office — identity and promises (Stage 10 module 03, `/api/v1/inbox/*`)
  //
  // Same router, same per-tenant service token. `linkCustomer` passes its
  // `novaActionId` as the Idempotency-Key for the same reason the reply does:
  // a retry after a network timeout must not write the join twice and mint two
  // receipts for one assertion.
  // ==========================================================================

  async linkCustomer(conversationId: string, input: LinkCustomerRequest): Promise<LinkCustomerResult> {
    return this.request<LinkCustomerResult>(
      `/api/v1/inbox/conversations/${encodeURIComponent(conversationId)}/link-customer`,
      { method: "POST", body: input, idempotencyKey: input.novaActionId },
    );
  }

  async unlinkCustomer(conversationId: string): Promise<{ unlinked: boolean }> {
    // The undo rides the PATCH route rather than a dedicated endpoint, so that
    // route must accept an EXPLICIT `customerId: null` and distinguish it from
    // an absent key — a PATCH that treats "not sent" and "sent as null" alike
    // turns this call into a silent no-op and leaves the join in place.
    return this.request<{ unlinked: boolean }>(
      `/api/v1/inbox/conversations/${encodeURIComponent(conversationId)}`,
      { method: "PATCH", body: { customerId: null } },
    );
  }

  async listPromises(filter?: { status?: string; customerId?: string; limit?: number }): Promise<InboxPromise[]> {
    const { promises } = await this.get<{ promises: InboxPromise[] }>("/api/v1/inbox/promises", {
      status: filter?.status,
      customerId: filter?.customerId,
      limit: filter?.limit,
    });
    return promises;
  }

  async settlePromise(
    promiseId: string,
    input: PromiseSettleRequest,
  ): Promise<{ ok: boolean; promise: InboxPromise }> {
    return this.request<{ ok: boolean; promise: InboxPromise }>(
      `/api/v1/inbox/promises/${encodeURIComponent(promiseId)}`,
      {
        method: "PATCH",
        body: input,
        // `keptActionId` exists only on the `kept` path; a `released` settle
        // falls back to a minted uuid, so the ROUTE must make repeat releases
        // idempotent by state (open → released only), not by key.
        idempotencyKey: input.keptActionId,
        // The route rejects `broken` and any transition out of an already
        // settled row with a 409. That is an ANSWER — usually "the sweep got
        // there first" — not a fault to retry, so it is declared rather than
        // thrown as an opaque string the model can only respond to by retrying.
        refusalOn: [409],
      },
    );
  }

  async mergeCustomers(input: { customerIdA: string; customerIdB: string; basis: string }): Promise<{
    survivorCustomerId: string;
    mergedCustomerId: string;
    ordersMoved: number;
    channelsMoved: number;
    conversationsMoved: number;
    promisesMoved: number;
  }> {
    return this.request("/api/v1/inbox/customers/merge", { method: "POST", body: input });
  }

  // ==========================================================================
  // Front Office — lifecycle & NBA (Stage 10 module 04, `/api/v1/inbox/*`)
  //
  // Same router, same per-tenant service token. One read and three writes, and
  // the writes are keyed the way this router's other writes are: on an id the
  // CALLER already owns, so a retry after a network timeout re-books nothing.
  // dakio-api's `w()` reads the `Idempotency-Key` HEADER (novaIdempotency.js) —
  // a body field of the same name would key nothing, which is why
  // `scheduledByActionId` is passed as `idempotencyKey` here and not just sent.
  // ==========================================================================

  async getNba(conversationId: string): Promise<NbaBlock | null> {
    // 404 → null, like `getInboxConversation`: a thread with no journey row is
    // a normal state (nothing real has happened to that person yet), and it
    // must not read as an outage that stops Nova answering them.
    return this.get<NbaBlock | null>(
      `/api/v1/inbox/nba/${encodeURIComponent(conversationId)}`,
      undefined,
      true,
    );
  }

  // ==========================================================================
  // Front Office — delivery coordination (Stage 10 module 06, `/api/v1/inbox/*`)
  // ==========================================================================

  async getOrderStatus(orderId: string): Promise<OrderStatusView | null> {
    return this.get<OrderStatusView | null>(
      `/api/v1/inbox/orders/${encodeURIComponent(orderId)}/status`,
      undefined,
      true,
    );
  }

  async openCase(input: OpenCaseRequest): Promise<{ case: NovaCaseView; joined: boolean }> {
    return this.request<{ case: NovaCaseView; joined: boolean }>("/api/v1/inbox/cases", {
      method: "POST",
      body: input,
      // The activeKey claim already makes a retry safe at the database level —
      // a second attempt JOINS rather than creating a second case. This is what
      // makes the retry return the same ANSWER, including the same `joined`, so
      // a caller does not see "created" once and "joined" once for one logical
      // request and book a department job on the strength of the first.
      idempotencyKey: input.novaActionId,
    });
  }

  async getCase(caseId: string): Promise<NovaCaseView | null> {
    const res = await this.get<{ case: NovaCaseView } | null>(
      `/api/v1/inbox/cases/${encodeURIComponent(caseId)}`,
      undefined,
      true,
    );
    return res?.case ?? null;
  }

  async patchCase(caseId: string, patch: PatchCaseRequest): Promise<NovaCaseView> {
    const { case: updated } = await this.request<{ case: NovaCaseView }>(
      `/api/v1/inbox/cases/${encodeURIComponent(caseId)}`,
      {
        method: "PATCH",
        body: patch,
        // 409 is the server saying this case is already closed and its key was
        // released — another case may hold that key now, so reopening is
        // refused. An answer to read, not a fault to retry.
        refusalOn: [409],
      },
    );
    return updated;
  }

  async updateOrderDelivery(orderId: string, patch: UpdateOrderDeliveryRequest): Promise<Order> {
    return this.request<Order>(`/api/v1/store/orders/${encodeURIComponent(orderId)}`, {
      method: "PATCH",
      body: patch,
      // 409 is "already with the courier", and it is the honest boundary of this
      // whole module: Dakio can book, cancel, poll and receive webhooks at the
      // three providers — it cannot edit a parcel already in their hands.
      // Retrying will not change that; the flow's answer is to open an
      // address_change_postdispatch case instead.
      refusalOn: [409],
    });
  }

  async scheduleFollowup(input: ScheduleFollowupRequest): Promise<ScheduleFollowupResult> {
    return this.request<ScheduleFollowupResult>("/api/v1/inbox/followups", {
      method: "POST",
      body: input,
      idempotencyKey: input.scheduledByActionId,
      // 409 is the route saying what is LEGAL: a delay outside the stage's
      // `allowedDelays`, or a chain already at 2. Both are answers the model
      // should read and respect — retrying either would be arguing with the
      // rule that stops Nova nagging a customer who has stopped replying.
      refusalOn: [409],
    });
  }

  async cancelFollowup(jobId: string): Promise<{ cancelled: boolean }> {
    return this.request<{ cancelled: boolean }>(
      `/api/v1/inbox/followups/${encodeURIComponent(jobId)}/cancel`,
      {
        method: "POST",
        body: {},
        // The jobId IS the logical write — cancelling twice is the same cancel,
        // so it keys itself rather than minting a throwaway uuid per attempt.
        idempotencyKey: `followup-cancel:${jobId}`,
      },
    );
  }

  async postIntentObserved(
    journeyId: string,
    input: IntentObservedRequest,
  ): Promise<IntentObservedResult> {
    return this.request<IntentObservedResult>(
      `/api/v1/inbox/journeys/${encodeURIComponent(journeyId)}/intent-observed`,
      {
        method: "POST",
        body: input,
        // Idempotent per (journeyId, messageId): one turn answers one inbound,
        // so a retried callback must not post a second observation of the same
        // turn — the reducer treats each post as evidence and a double-post
        // would count one choice twice.
        //
        // NOT because `journey.silences_chosen` counts the rows: that metric is
        // explicitly NOT IMPLEMENTED on this side (`DO_NOTHING_REPORTING` in
        // `agent/channels/customer.ts`), because silence calls no verb and there
        // is no customer-plane way for the model to DECLARE it — so nothing here
        // ever posts `nbaAction: "do_nothing"` in the first place. The key is
        // right; the older rationale over-claimed a counter that does not exist.
        idempotencyKey: `${journeyId}:${input.messageId}`,
      },
    );
  }

  // ==========================================================================
  // Front Office — selling & conversion (Stage 10 module 05, `/api/v1/store/*`)
  //
  // Back on the STORE router, not the inbox one, and that is the right seam:
  // an order is a commerce record that happens to have been agreed in a chat.
  // The conversation id rides the body so the server can join the two, but the
  // Order, the Coupon and the stock decrement all belong to the store.
  // ==========================================================================

  async createChatOrder(input: ChatOrderRequest): Promise<ChatOrderResult> {
    return this.request<ChatOrderResult>("/api/v1/store/orders", {
      method: "POST",
      body: input,
      // The caller's own stable id, for the reason the reply and the follow-up
      // pass theirs: a retry after a network timeout must not place a second
      // COD parcel. It matters more here than on either of those, because the
      // failure is not a duplicate message — it is two couriers at one door and
      // a shop paying two returns.
      idempotencyKey: input.novaActionId,
      // 409 is the route saying what is LEGAL: out of stock, the fake-order
      // guard, the free-plan daily cap, a coupon that does not hold. Every one
      // of those is an answer the model must read and tell the customer about,
      // and retrying any of them would be arguing with a rule. 422 joins them
      // because that is the coupon refusal's status.
      refusalOn: [409, 422],
    });
  }

  async getStoreSettings(): Promise<StoreSettings> {
    return this.get<StoreSettings>("/api/v1/store/settings");
  }

  async getCustomerRisk(phone: string): Promise<CustomerRiskView> {
    // No `nullOn404`, deliberately. An unknown phone answers 200 with
    // `level: "NEW"` and zero counts, because "no history" is a real risk
    // answer; a 404 or a 422 means the read could not be made, and swallowing
    // either into `null` would hand the auto-order guardrail something that
    // reads exactly like a clean customer.
    return this.get<CustomerRiskView>("/api/v1/store/customers/risk", { phone });
  }

  // ==========================================================================
  // Proactive job queue (Phase 05)
  //
  // No Idempotency-Key header on these — unlike commerce mutations, claim/
  // complete/release are idempotent by construction: claim only leases
  // currently-due rows (a retry just finds fewer or none left), and
  // complete/release both recompute their result from the job's current
  // server-side state rather than from client-supplied deltas, so replaying
  // either is a harmless no-op / re-application of the same outcome.
  // ==========================================================================

  async listJobDefs(): Promise<NovaJobDef[]> {
    const { jobDefs } = await this.get<{ jobDefs: NovaJobDef[] }>("/api/v1/agent-data/job-defs");
    return jobDefs;
  }

  async upsertJobDef(
    kind: JobKind,
    input: { cadence: string; tz: string; enabled?: boolean; config?: Record<string, unknown> },
  ): Promise<NovaJobDef> {
    return this.request<NovaJobDef>(`/api/v1/agent-data/job-defs/${encodeURIComponent(kind)}`, {
      method: "PUT",
      body: input,
    });
  }

  async claimDueJobs(limit: number): Promise<NovaJob[]> {
    const { jobs } = await this.request<{ jobs: NovaJob[] }>("/api/v1/agent-data/jobs/claim", {
      method: "POST",
      body: { limit },
    });
    return jobs;
  }

  async completeJob(id: string, leaseToken: string, sessionId?: string): Promise<void> {
    await this.request(`/api/v1/agent-data/jobs/${encodeURIComponent(id)}/complete`, {
      method: "POST",
      body: { leaseToken, sessionId },
    });
  }

  async releaseJob(id: string, leaseToken: string, error: string): Promise<void> {
    await this.request(`/api/v1/agent-data/jobs/${encodeURIComponent(id)}/release`, {
      method: "POST",
      body: { leaseToken, error },
    });
  }

  // ---- Catalog photo memory (Stage 11 Phase 3) ----

  async listPendingCatalogPhotos(
    limit?: number,
  ): Promise<{ photos: CatalogPhotoPending[]; pendingTotal: number }> {
    return this.get<{ photos: CatalogPhotoPending[]; pendingTotal: number }>(
      "/api/v1/store/catalog-photos/pending",
      { limit },
    );
  }

  async recordCatalogPhotoReadings(
    results: CatalogPhotoResult[],
  ): Promise<{ captioned: number; failed: number; pendingAfter: number }> {
    return this.request<{ captioned: number; failed: number; pendingAfter: number }>(
      "/api/v1/store/catalog-photos",
      { method: "PATCH", body: { results } },
    );
  }

  async listCatalogPhotoFingerprints(): Promise<{ fingerprints: CatalogPhotoFingerprint[] }> {
    return this.get<{ fingerprints: CatalogPhotoFingerprint[] }>("/api/v1/store/catalog-photos/fingerprints");
  }

  async recordRunStart(input: RunStartInput): Promise<void> {
    await this.request("/api/v1/agent-data/runs", { method: "POST", body: { ...input } });
  }

  async recordRunFinish(input: RunFinishInput): Promise<void> {
    await this.request("/api/v1/agent-data/runs/finish", { method: "POST", body: { ...input } });
  }
}
