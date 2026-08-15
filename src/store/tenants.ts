/**
 * The tenant registry — Nova's `nova_tenants` table.
 *
 * One row per store: kill-switch status, plan (→ model tier), timezone, and
 * the identity facts the context engine renders into the L1 tenant profile.
 * The in-process map is seeded with the static demo/dev tenants (so the eval
 * suites run two stores on one deployment with no network), and — in `dakio`
 * backend mode — grows dynamically: `ensureTenant` provisions ANY production
 * store by fetching `GET /api/v1/store/profile` from dakio-api with that
 * tenant's own self-minted service token. Only the two DEMO stores are pinned
 * (never fetched); real Dakio seed rows are cold-start fallbacks that refresh
 * dynamically, so a plan lapse on dakio-api pauses them too. Dynamic rows are
 * cached 5 minutes fresh and served up to 24h stale when dakio-api is
 * unreachable, after which they fail closed.
 *
 * The sync readers (`getTenant`/`isTenantActive`/`listTenants`) stay sync over
 * the cache — every guard that needs a fresh answer awaits `ensureTenant`
 * first (turn guard, inbox pre-dispatch, model resolver), then reads sync.
 *
 * Nothing tenant-specific lives on disk as prompt text. A store's
 * "personality" is data: the row below plus its brand/goals memory.
 */

import { serviceTokenFor } from "../lib/service-token.js";
import { storeBackendMode } from "./mode.js";
import { dakioBaseUrl } from "../lib/dakio-base.js";

export type TenantStatus = "active" | "paused";

/** Billing plan → model tier. Selection happens once at session start. */
export type TenantPlan = "starter" | "growth" | "scale";

export interface TenantRecord {
  readonly storeId: string;
  /** Storefront display name, rendered into the L1 profile. */
  readonly name: string;
  /** Commerce vertical, e.g. "Home & lifestyle DTC". */
  readonly vertical: string;
  readonly currency: string;
  readonly locale: string;
  readonly timezone: string;
  /** Kill switch. `paused` ⇒ every turn is refused before any model spend. */
  status: TenantStatus;
  readonly plan: TenantPlan;
  /** One-line brand voice summary for the profile header (full voice lives in brand memory). */
  readonly voiceSummary: string;
  /** The signature the store signs customer messages with. */
  readonly signature: string;
  /**
   * Admin-selected model override (Nova Ops → Models), resolved by dakio-api
   * (per-store override, else the global one) and carried on `/profile`.
   * Undefined ⇒ no override ⇒ the plan ladder in `lib/models.ts` decides.
   * Trusted only in shape (`provider/model`) — a bad id fails at the gateway
   * per-request, same failure mode as a bad NOVA_MODEL env value.
   */
  readonly novaModel?: string;
}

/* The plan → model mapping (`modelForPlan`) lives in `lib/models.ts`, the one
 * registry for every model id in the repo. `TenantPlan` above is its key. */

/** The two seeded demo tenants. Store ids match the keys in `resolve.ts`. */
const TENANTS = new Map<string, TenantRecord>([
  [
    "store-aurora",
    {
      storeId: "store-aurora",
      name: "Aurora Living",
      vertical: "Home & lifestyle DTC",
      currency: "USD",
      locale: "en-US",
      timezone: "America/Los_Angeles",
      status: "active",
      plan: "growth",
      voiceSummary: "Warm, unhurried, quietly premium — no exclamation marks or emoji.",
      signature: "Nova at Aurora Living",
    },
  ],
  [
    "store-beacon",
    {
      storeId: "store-beacon",
      name: "Beacon Supply Co",
      vertical: "B2B industrial & janitorial supply",
      currency: "USD",
      locale: "en-US",
      timezone: "America/New_York",
      status: "active",
      plan: "scale",
      voiceSummary: "Direct, efficient, spec-driven — built for busy facilities buyers.",
      signature: "Nova — Beacon Supply Co",
    },
  ],
  // Live Dakio dev tenant (Phase 02, local TUI testing against a real store).
  [
    "cmrl3wa6s0000132q7mdev915",
    {
      storeId: "cmrl3wa6s0000132q7mdev915",
      name: "Mayer Doya Store",
      vertical: "General commerce",
      currency: "BDT",
      locale: "en-BD",
      timezone: "Asia/Dhaka",
      status: "active",
      plan: "growth",
      voiceSummary: "Default voice — replace once the store's brand memory is set.",
      signature: "Nova at Mayer Doya Store",
    },
  ],
  // Second live Dakio dev tenant (admin.dakio@gmail.com) — provisioned so the
  // founder can drive Nova from that store's dashboard. Its own scoped service
  // token lives in NOVA_SERVICE_TOKENS (never the Mayer Doya fallback).
  [
    "cmrm6rzoz0003stc0uxugcq1d",
    {
      storeId: "cmrm6rzoz0003stc0uxugcq1d",
      name: "Dakio",
      vertical: "General commerce",
      currency: "BDT",
      locale: "en-BD",
      timezone: "Asia/Dhaka",
      status: "active",
      plan: "growth",
      voiceSummary: "Default voice — replace once the store's brand memory is set.",
      signature: "Nova at Dakio",
    },
  ],
  // Live Dakio PRODUCTION tenant (first real merchant on the Vercel deployment).
  // Cold-start seed only: in dakio mode `ensureTenant` refreshes name/status/plan
  // from dakio-api's /profile, so this row never overrides live billing state.
  [
    "cmrafcjt503h3pm0cnyjpnqp3",
    {
      storeId: "cmrafcjt503h3pm0cnyjpnqp3",
      name: "Dakio Store",
      vertical: "General commerce",
      currency: "BDT",
      locale: "en-BD",
      timezone: "Asia/Dhaka",
      status: "active",
      plan: "growth",
      voiceSummary: "Default voice — replace once the store's brand memory is set.",
      signature: "Nova at Dakio Store",
    },
  ],
]);

/** Every known tenant (for the isolation suite and fleet-wide dev tooling). */
export function listTenants(): TenantRecord[] {
  return [...TENANTS.values()];
}

/** Look up a tenant row, or `null` for an unknown store. */
export function getTenant(storeId: string): TenantRecord | null {
  return TENANTS.get(storeId) ?? null;
}

/**
 * The kill switch. A store is servable only when it exists and is `active`.
 * Called before any model spend by the `turn.started` guard hook.
 */
export function isTenantActive(storeId: string): boolean {
  return TENANTS.get(storeId)?.status === "active";
}

/**
 * Flip a tenant's kill switch. Returns the new status, or `null` if the store
 * is unknown. (In production this writes the `nova_tenants.status` column and
 * busts the `t:{storeId}:paused` flag; here it mutates the in-process row.)
 */
export function setTenantStatus(storeId: string, status: TenantStatus): TenantStatus | null {
  const record = TENANTS.get(storeId);
  if (!record) return null;
  record.status = status;
  return status;
}

// --- dynamic provisioning (dakio backend mode) ------------------------------

/**
 * Only the two DEMO stores are pinned (never fetched, never evicted) — the
 * eval suites depend on them resolving with zero network. Every REAL Dakio
 * tenant id — including the seeded dev/production rows above — goes through
 * the dynamic fetch in `dakio` mode, so a plan lapse or suspension on
 * dakio-api actually pauses Nova for them (the billing kill switch). Their
 * seed rows act as cold-start fallbacks: served when dakio-api is unreachable
 * before the first successful refresh.
 */
const STATIC_IDS: ReadonlySet<string> = new Set(["store-aurora", "store-beacon"]);

/** Every id seeded at module init — seed rows may serve as fetch-failure fallbacks. */
const SEED_IDS: ReadonlySet<string> = new Set(TENANTS.keys());
/** Immutable copies of the seed rows so `resetDynamicTenants` can restore them. */
const SEED_ROWS: readonly TenantRecord[] = [...TENANTS.values()].map((r) => ({ ...r }));

/** A dynamic row is fresh this long; within it `ensureTenant` never refetches. */
const FRESH_TTL_MS = 5 * 60 * 1000;
/** On fetch failure a dynamic row is served stale up to this long, then fails closed. */
const STALE_MAX_MS = 24 * 60 * 60 * 1000;
/** Profile fetch timeout. */
const PROFILE_TIMEOUT_MS = 8000;
/**
 * After a failed refresh, skip re-fetching this long and serve stale/null
 * directly. Without it, an outage makes every awaiting call site (customer
 * pre-dispatch + turn guard + model resolver) pay the full 8s timeout each —
 * enough to blow a serverless function budget on a single message.
 */
const FAILURE_BACKOFF_MS = 45 * 1000;

/** When each dynamic row was last fetched (static seeds carry no entry). */
const dynamicFetchedAt = new Map<string, number>();
/** When each store's last fetch FAILED — drives `FAILURE_BACKOFF_MS`. */
const lastFailureAt = new Map<string, number>();
/** In-flight refreshes, one shared promise per store (thundering-herd guard). */
const inFlight = new Map<string, Promise<TenantRecord | null>>();
/** Stores already warned about stale serving — one warn per store per process. */
const staleWarned = new Set<string>();
/** Stores already warned about failing closed — one warn per store per process. */
const failClosedWarned = new Set<string>();

/* Which backend `ensureTenant` provisions from comes from `mode.ts`. It was a
 * "deliberate local duplicate" of `resolve.ts`'s one-liner — and the duplicate
 * had the OPPOSITE default, which is precisely how the split brain happened.
 * `mode.ts` imports nothing, so the cycle the duplicate was avoiding
 * (`tenants.ts → resolve.ts → store clients`) does not exist. */

const PLANS: readonly TenantPlan[] = ["starter", "growth", "scale"];

/** Map a dakio-api `/api/v1/store/profile` body to a registry row (defensive clamps). */
function recordFromProfile(storeId: string, profile: unknown): TenantRecord {
  const p = (typeof profile === "object" && profile !== null ? profile : {}) as Record<string, unknown>;
  const str = (v: unknown, fallback: string): string =>
    typeof v === "string" && v.length > 0 ? v : fallback;
  const name = str(p.name, storeId);
  return {
    storeId,
    name,
    vertical: "General commerce",
    currency: str(p.currency, "BDT"),
    locale: str(p.locale, "en-BD"),
    timezone: str(p.timezone, "Asia/Dhaka"),
    // Fail closed on any unexpected status string — only "active" serves.
    status: p.status === "active" ? "active" : "paused",
    // Client-side clamp: an unknown plan name must never crash model tiering.
    plan: PLANS.includes(p.plan as TenantPlan) ? (p.plan as TenantPlan) : "starter",
    voiceSummary: "Default voice — replace once the store's brand memory is set.",
    signature: `Nova at ${name}`,
    // Shape clamp only (`provider/model`): the admin console validates against
    // the live gateway catalog before writing, and the gateway rejects unknown
    // ids per-request — a malformed value must not crash profile refresh.
    ...(typeof p.novaModel === "string" && /^[\w.:-]+\/[\w.:-]+$/.test(p.novaModel)
      ? { novaModel: p.novaModel }
      : {}),
  };
}

/** Drop a dynamic row so the sync readers agree with a fail-closed `ensureTenant`. */
function evictDynamic(storeId: string): void {
  if (STATIC_IDS.has(storeId)) return;
  TENANTS.delete(storeId);
  dynamicFetchedAt.delete(storeId);
  staleWarned.delete(storeId);
}

/** Serve the ≤24h-stale cached row on fetch failure, else fail closed (and evict). */
function staleOrNull(storeId: string, nowMs: number, error: unknown): TenantRecord | null {
  const cached = TENANTS.get(storeId);
  const fetchedAt = dynamicFetchedAt.get(storeId);
  // A never-refreshed SEED row (fetchedAt undefined) is a valid cold-start
  // fallback: dakio-api being down at boot must not kill a known tenant.
  const withinWindow =
    fetchedAt !== undefined ? nowMs - fetchedAt <= STALE_MAX_MS : SEED_IDS.has(storeId);
  if (cached && withinWindow) {
    if (!staleWarned.has(storeId)) {
      staleWarned.add(storeId);
      console.warn(
        `[tenants] profile refresh failed for ${storeId} — serving cached row (stale ≤ 24h): ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
    return cached;
  }
  // Beyond the stale window (or never cached): the row must not keep serving
  // through the sync readers either. Log it — a missing NOVA_SERVICE_SECRET or
  // DAKIO_API_URL lands here for EVERY store, and silence would make a config
  // error look like per-tenant provisioning failures.
  if (!failClosedWarned.has(storeId)) {
    failClosedWarned.add(storeId);
    console.warn(
      `[tenants] profile fetch failed for ${storeId} with no cached row in the stale window — failing closed: ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  evictDynamic(storeId);
  return null;
}

async function fetchStoreProfile(storeId: string): Promise<Response> {
  // See the note in fleet.ts: normalized once, centrally, so a scheme-less
  // paste from a hosting dashboard cannot silently break every store read.
  const baseUrl = dakioBaseUrl();
  return fetch(`${baseUrl}/api/v1/store/profile`, {
    headers: { Authorization: `Bearer ${serviceTokenFor(storeId)}` },
    signal: AbortSignal.timeout(PROFILE_TIMEOUT_MS),
  });
}

/**
 * Provision (or refresh) a tenant row before a sync read. Never throws.
 *
 *  - Demo mode: pure cache lookup — evals must never touch the network.
 *  - Static seeds: pinned rows, returned as-is even in `dakio` mode.
 *  - Dakio mode, dynamic store: serve the row while fresh (5 min); else fetch
 *    `GET /api/v1/store/profile` with the tenant's own service token. 200
 *    caches + returns; 404/401/403 evict and return `null` (fail closed);
 *    network errors / 5xx serve the cached row up to 24h stale, then `null`.
 *
 * `opts.nowMs` overrides "now" — tests only.
 */
export async function ensureTenant(
  storeId: string,
  opts: { nowMs?: number } = {},
): Promise<TenantRecord | null> {
  if (storeBackendMode() !== "dakio") return TENANTS.get(storeId) ?? null;
  if (STATIC_IDS.has(storeId)) return TENANTS.get(storeId) ?? null;

  const nowMs = opts.nowMs ?? Date.now();
  const cached = TENANTS.get(storeId);
  const fetchedAt = dynamicFetchedAt.get(storeId);
  if (cached && fetchedAt !== undefined && nowMs - fetchedAt < FRESH_TTL_MS) return cached;

  // Failure backoff: within the window after a failed refresh, don't pay the
  // fetch (and its up-to-8s timeout) again — serve stale or fail closed now.
  const failedAt = lastFailureAt.get(storeId);
  if (failedAt !== undefined && nowMs - failedAt < FAILURE_BACKOFF_MS) {
    return staleOrNull(storeId, nowMs, new Error("refresh backoff after recent failure"));
  }

  // Thundering-herd guard: concurrent calls for one store share one refresh.
  const pending = inFlight.get(storeId);
  if (pending) return pending;

  const refresh = refreshTenant(storeId, nowMs).finally(() => {
    inFlight.delete(storeId);
  });
  inFlight.set(storeId, refresh);
  return refresh;
}

/** The actual network refresh behind `ensureTenant` — one caller per store at a time. */
async function refreshTenant(storeId: string, nowMs: number): Promise<TenantRecord | null> {
  let response: Response;
  try {
    response = await fetchStoreProfile(storeId);
  } catch (error) {
    lastFailureAt.set(storeId, nowMs);
    return staleOrNull(storeId, nowMs, error);
  }

  if (response.status === 404) {
    // dakio-api does not know this tenant — unknown store, fail closed.
    evictDynamic(storeId);
    return null;
  }
  if (response.status === 401 || response.status === 403) {
    // A 403 is either a rejected service token OR requireTenant refusing the
    // tenant itself (admin suspension `account_suspended`, vanished row).
    // Same fail-closed outcome, very different operator action — log which.
    let bodyError = "";
    try {
      const body = (await response.json()) as Record<string, unknown> | null;
      if (body && typeof body.error === "string") bodyError = body.error;
    } catch {
      /* no JSON body — keep the generic message */
    }
    console.warn(
      bodyError === "account_suspended"
        ? `[tenants] tenant ${storeId} is suspended on dakio-api — refusing service.`
        : `[tenants] dakio-api rejected Nova's service token for ${storeId} (HTTP ${response.status}${bodyError ? `, ${bodyError}` : ""}) — treating as unprovisioned.`,
    );
    evictDynamic(storeId);
    return null;
  }
  if (!response.ok) {
    lastFailureAt.set(storeId, nowMs);
    return staleOrNull(storeId, nowMs, new Error(`profile fetch returned HTTP ${response.status}`));
  }

  let profile: unknown;
  try {
    profile = await response.json();
  } catch (error) {
    lastFailureAt.set(storeId, nowMs);
    return staleOrNull(storeId, nowMs, error);
  }

  // Identity check: dakio-api derives the tenant from the TOKEN, so a
  // mis-scoped token (e.g. the legacy single NOVA_SERVICE_TOKEN fallback
  // covering an arbitrary storeId) returns ANOTHER tenant's profile. Caching
  // it here would hand this storeId that tenant's name, plan, and — worst —
  // its active status, voiding the kill switch. Refuse instead.
  const bodyStoreId =
    typeof profile === "object" && profile !== null
      ? (profile as Record<string, unknown>).storeId
      : undefined;
  if (typeof bodyStoreId === "string" && bodyStoreId.length > 0 && bodyStoreId !== storeId) {
    console.warn(
      `[tenants] profile storeId mismatch for ${storeId} (got ${bodyStoreId} — service token likely scoped to another tenant) — treating as unprovisioned.`,
    );
    evictDynamic(storeId);
    return null;
  }

  const record = recordFromProfile(storeId, profile);
  TENANTS.set(storeId, record);
  dynamicFetchedAt.set(storeId, nowMs);
  lastFailureAt.delete(storeId);
  staleWarned.delete(storeId);
  failClosedWarned.delete(storeId);
  return record;
}

/** Test-only: restore the registry to its module-init seed state. */
export function resetDynamicTenants(): void {
  TENANTS.clear();
  for (const row of SEED_ROWS) TENANTS.set(row.storeId, { ...row });
  dynamicFetchedAt.clear();
  lastFailureAt.clear();
  inFlight.clear();
  staleWarned.clear();
  failClosedWarned.clear();
}
