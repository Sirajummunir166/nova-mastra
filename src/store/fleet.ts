/**
 * Fleet resolution for the per-minute dispatcher — WHICH stores to claim
 * jobs for.
 *
 * This replaces the dispatcher's old `listTenants()` loop, which iterated the
 * in-process seed map: two demo stores and two local-dev stores that do not
 * exist in the production database, burning four guaranteed-403 HTTP round
 * trips against dakio-api every minute forever, while any real merchant NOT
 * hard-coded into the seed map was invisible to the job system entirely. The
 * registry seeds remain (evals, cold-start fallbacks for other paths) — the
 * dispatcher just no longer treats them as the fleet.
 *
 * In `dakio` mode the fleet is asked of the system that actually knows it:
 * `GET /api/v1/store/fleet` on dakio-api (hired + active + unexpired-plan
 * store ids), authenticated with the tenantless `nova-fleet` token. Every
 * subsequent claim still goes through that store's own per-tenant token, so
 * per-tenant isolation is unchanged — the fleet credential only ever learns
 * ids. In demo mode the registry seeds ARE the fleet, unchanged, so the eval
 * suites keep running two stores with zero network.
 *
 * Failure posture: serve the last successful list stale (a dakio-api blip
 * must not stop job claims for every store), fail EMPTY only when there has
 * never been a successful fetch — an empty tick claims nothing and retries
 * next minute, which beats hammering known-dead ids.
 */

import { ensureTenant, isTenantActive, listTenants, type TenantRecord } from "./tenants.js";
import { mintFleetToken } from "../lib/service-token.js";
import { storeBackendMode } from "./mode.js";

/** Re-fetch cadence. The dispatcher ticks every minute; a fresh-enough fleet
 * once a minute is plenty, and one fleet call per tick is the worst case. */
const FLEET_TTL_MS = 60 * 1000;
const FLEET_TIMEOUT_MS = 8_000;

let cachedIds: string[] | null = null;
let fetchedAtMs = 0;

/** Tests only. */
export function resetFleetCache(): void {
  cachedIds = null;
  fetchedAtMs = 0;
}

export interface FleetOptions {
  /** Override fetch (tests). */
  fetchImpl?: typeof fetch;
  /** Override "now" (tests). */
  nowMs?: number;
}

async function fetchFleetIds(opts: FleetOptions): Promise<string[] | null> {
  const baseUrl = process.env.DAKIO_API_URL;
  if (!baseUrl) return null;
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const response = await doFetch(`${baseUrl}/api/v1/store/fleet`, {
      headers: { Authorization: `Bearer ${mintFleetToken()}` },
      signal: AbortSignal.timeout(FLEET_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { storeIds?: unknown };
    if (!Array.isArray(body.storeIds)) return null;
    return body.storeIds.filter((id): id is string => typeof id === "string" && id.length > 0);
  } catch {
    return null;
  }
}

/**
 * The store ids the dispatcher should claim for this tick (dakio mode).
 * Fresh within {@link FLEET_TTL_MS}; stale-on-error; empty only when no fetch
 * has ever succeeded.
 */
export async function listFleetStoreIds(opts: FleetOptions = {}): Promise<string[]> {
  const nowMs = opts.nowMs ?? Date.now();
  if (cachedIds !== null && nowMs - fetchedAtMs < FLEET_TTL_MS) return cachedIds;

  const fetched = await fetchFleetIds(opts);
  if (fetched !== null) {
    cachedIds = fetched;
    fetchedAtMs = nowMs;
    return fetched;
  }
  return cachedIds ?? [];
}

/**
 * The dispatcher's tenant set for one tick.
 *
 * - demo mode: the registry seeds, exactly as before.
 * - dakio mode: the fleet list, each id run through `ensureTenant` (which
 *   refreshes status/plan from the store's own profile — so a store paused on
 *   dakio-api between fleet fetches is dropped here, not discovered via a 403)
 *   and then the `isTenantActive` gate.
 */
export async function resolveDispatchTenants(opts: FleetOptions = {}): Promise<TenantRecord[]> {
  // The mode comes from `storeBackendMode()`, never from a local env read.
  // This branch used to say `!== "dakio"` while `resolve.ts` said `=== "demo"`,
  // so an unset var made this loop the seed list while the clients it fed
  // pointed at the live API.
  if (storeBackendMode() === "demo") {
    return listTenants().filter((t) => isTenantActive(t.storeId));
  }

  const ids = await listFleetStoreIds(opts);
  const records = await Promise.all(ids.map((id) => ensureTenant(id, { nowMs: opts.nowMs })));
  return records.filter(
    (record): record is TenantRecord => record !== null && isTenantActive(record.storeId),
  );
}
