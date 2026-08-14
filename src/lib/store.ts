/**
 * Minimal store-profile facade — the "connect with store" seam. Since the
 * StoreClient port this delegates to the tenant registry's `ensureTenant`
 * (`src/store/tenants.ts`), which owns the `GET /api/v1/store/profile` fetch
 * and already covers the old inline fetch's contract: the same 5-minute fresh
 * TTL, the same storeId identity check (a mis-scoped token returning ANOTHER
 * tenant's profile is refused, never served), and fail-closed on 401/403/404.
 * It adds what this module never had: stale-serving ≤24h on transient
 * failures, refresh backoff, and a thundering-herd guard. In `demo` backend
 * mode the registry answers from its seeded rows with zero network.
 */

import { ensureTenant } from "../store/tenants.js";

export interface StoreProfile {
  storeId: string;
  name: string;
  vertical: string;
  currency: string;
  locale: string;
  timezone: string;
  status: "active" | "paused";
  plan: string;
}

export async function getStoreProfile(storeId: string): Promise<StoreProfile | null> {
  const record = await ensureTenant(storeId);
  if (!record) return null;
  return {
    storeId: record.storeId,
    name: record.name,
    vertical: record.vertical,
    currency: record.currency,
    locale: record.locale,
    timezone: record.timezone,
    status: record.status,
    plan: record.plan,
  };
}
