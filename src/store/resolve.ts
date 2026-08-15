/**
 * Tenant-scoped store resolution — the replacement for the old ambient
 * `getStoreClient()` singleton.
 *
 * `storeFor(storeId)` returns the `StoreClient` bound to exactly one store.
 * The backend comes from `storeBackendMode()` (`mode.ts`), the single reading
 * of `NOVA_STORE_BACKEND`:
 *
 *   - `demo` (explicit opt-in): a keyed map of `DemoStore` instances (one
 *     seeded dataset per tenant), so two tenants live side by side in one
 *     process and the isolation suite can prove they never cross.
 *     Deterministic, no network.
 *   - `dakio` (the default, including when the var is unset): a
 *     `DakioStoreClient` per tenant, pinned to the tenant's Nova service
 *     token, talking to the live Dakio Express backend over HTTPS. No tool,
 *     executor, or context-layer changes — the interface held.
 *
 * Callers get the store id from `requireStore(ctx)` (verified auth) and pass
 * it here. `storeFor` never reads ambient state, so nothing can accidentally
 * resolve the "current" tenant from a global.
 */

import type { StoreSeed } from "./types.js";
import type { StoreClient } from "./client.js";
import { DemoStore } from "./backend.js";
import { DakioStoreClient } from "./dakio.js";
import { serviceTokenFor } from "../lib/service-token.js";
import { storeBackendMode } from "./mode.js";
import { createSeed } from "./seed.js";
import { createBeaconSeed } from "./seed-beacon.js";

/** Per-tenant seed builders, keyed by store id (see `tenants.ts` registry). */
const SEEDERS: Record<string, (nowMs: number) => StoreSeed> = {
  "store-aurora": createSeed,
  "store-beacon": createBeaconSeed,
};

/** Live per-store backends, created lazily on first access. */
const instances = new Map<string, StoreClient>();

/* Which backend `storeFor` builds is decided by `storeBackendMode()` in
 * `mode.ts` — the one reading of `NOVA_STORE_BACKEND` in the repo. It used to
 * be a local one-liner here and another, OPPOSITE one-liner in `fleet.ts`, so
 * an unset env var gave the dispatcher demo tenants and live clients at the
 * same time. Never re-derive the mode from the env here. */

/* Token precedence (`NOVA_SERVICE_TOKENS` map → `NOVA_SERVICE_TOKEN` →
 * self-mint) lives in `service-token.ts` (`serviceTokenFor`), shared with the
 * tenant registry's dynamic provisioning fetch. */

/** Build the live Dakio HTTP client for a tenant, pinned to THAT tenant's own service token. */
function makeDakioClient(storeId: string): DakioStoreClient {
  const baseUrl = process.env.DAKIO_API_URL;
  if (!baseUrl) throw new Error("NOVA_STORE_BACKEND=dakio requires DAKIO_API_URL");
  // Token resolved lazily per request: explicit env token, else self-minted.
  return new DakioStoreClient(storeId, { baseUrl, token: () => serviceTokenFor(storeId) });
}

function makeClient(storeId: string): StoreClient {
  if (storeBackendMode() === "dakio") return makeDakioClient(storeId);
  const seeder = SEEDERS[storeId] ?? createSeed;
  return new DemoStore(seeder(Date.now()));
}

/**
 * Resolve the store for a specific tenant. Pass a store id (from
 * `requireStore`) or a `SessionContext` (which resolves the id from auth).
 * Each store keeps its own isolated backend for the life of the process.
 */
// Mastra port: the eve-session `TenantContext` overload (requireStore(ctx))
// was dropped — callers resolve the store id from their own auth and pass it.
export function storeFor(storeId: string): StoreClient {
  let instance = instances.get(storeId);
  if (!instance) {
    instance = makeClient(storeId);
    instances.set(storeId, instance);
  }
  return instance;
}

/**
 * Drop cached backends. Test-only: lets the isolation suite start each case
 * from freshly seeded, independent tenants.
 */
export function resetStores(): void {
  instances.clear();
}
