/**
 * Minimal store-profile client against dakio-api — the "connect with store"
 * seam. Mirrors nova-ai's `ensureTenant` contract (GET /api/v1/store/profile
 * with a per-tenant self-minted service token, storeId identity check, fail
 * closed on 401/403/404) without the stale-cache machinery yet.
 */

import { serviceTokenFor } from "./service-token.js";

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

const FRESH_TTL_MS = 5 * 60 * 1000;
const PROFILE_TIMEOUT_MS = 8000;

const cache = new Map<string, { profile: StoreProfile; fetchedAt: number }>();

function str(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

export async function getStoreProfile(storeId: string): Promise<StoreProfile | null> {
  const cached = cache.get(storeId);
  if (cached && Date.now() - cached.fetchedAt < FRESH_TTL_MS) return cached.profile;

  const baseUrl = process.env.DAKIO_API_URL;
  if (!baseUrl) throw new Error("DAKIO_API_URL is not set");

  const response = await fetch(`${baseUrl}/api/v1/store/profile`, {
    headers: { Authorization: `Bearer ${serviceTokenFor(storeId)}` },
    signal: AbortSignal.timeout(PROFILE_TIMEOUT_MS),
  });

  if (!response.ok) {
    console.warn(`[store] profile fetch for ${storeId} failed: HTTP ${response.status}`);
    return null;
  }

  const p = (await response.json()) as Record<string, unknown>;

  // Identity check: dakio-api derives the tenant from the TOKEN. A mis-scoped
  // token returns ANOTHER tenant's profile — refuse rather than serve it.
  if (typeof p.storeId === "string" && p.storeId.length > 0 && p.storeId !== storeId) {
    console.warn(`[store] profile storeId mismatch for ${storeId} (got ${p.storeId}) — refusing.`);
    return null;
  }

  const profile: StoreProfile = {
    storeId,
    name: str(p.name, storeId),
    vertical: str(p.vertical, "general commerce"),
    currency: str(p.currency, "BDT"),
    locale: str(p.locale, "en-BD"),
    timezone: str(p.timezone, "Asia/Dhaka"),
    status: p.status === "active" ? "active" : "paused",
    plan: str(p.plan, "starter"),
  };

  cache.set(storeId, { profile, fetchedAt: Date.now() });
  return profile;
}
