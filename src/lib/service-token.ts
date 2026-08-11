/**
 * Nova service-token minting — ported from nova-ai `agent/lib/store/service-token.ts`.
 *
 * dakio-api authenticates Nova with a dedicated secret (`NOVA_SERVICE_SECRET`,
 * verified by dakio-api `src/middleware/novaAuth.js`) and a fixed token shape:
 *
 *   { type: "service", sub: "nova", tenantId, iat, exp }   // HS256
 *
 * Holding that one secret, this service signs its own per-tenant token on
 * demand. Tokens are cached per tenant and re-minted before expiry so an
 * in-flight request never carries a just-expired token.
 */

import { createHmac } from "node:crypto";

const DEFAULT_TTL_SEC = 60 * 60; // 1 hour
const REFRESH_SKEW_MS = 5 * 60 * 1000; // re-mint 5 minutes before expiry

interface CacheEntry {
  token: string;
  expMs: number;
}

const cache = new Map<string, CacheEntry>();

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

export function mintServiceToken(tenantId: string): string {
  const secret = process.env.NOVA_SERVICE_SECRET;
  if (!secret) {
    throw new Error(
      `Cannot mint a service token for '${tenantId}': set NOVA_SERVICE_SECRET ` +
        `(must equal dakio-api's NOVA_SERVICE_SECRET).`,
    );
  }
  const nowMs = Date.now();

  const cached = cache.get(tenantId);
  if (cached && cached.expMs - REFRESH_SKEW_MS > nowMs) return cached.token;

  const iat = Math.floor(nowMs / 1000);
  const exp = iat + DEFAULT_TTL_SEC;
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ type: "service", sub: "nova", tenantId, iat, exp }));
  const signingInput = `${header}.${payload}`;
  const signature = b64url(createHmac("sha256", secret).update(signingInput).digest());
  const token = `${signingInput}.${signature}`;

  cache.set(tenantId, { token, expMs: exp * 1000 });
  return token;
}

let tokenMapCache: Record<string, string> | null = null;

function tokenMap(): Record<string, string> {
  if (tokenMapCache) return tokenMapCache;
  const raw = process.env.NOVA_SERVICE_TOKENS;
  if (!raw) {
    tokenMapCache = {};
    return tokenMapCache;
  }
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error('NOVA_SERVICE_TOKENS must be a JSON object of { "storeId": "token" }');
  }
  tokenMapCache = parsed as Record<string, string>;
  return tokenMapCache;
}

/**
 * Resolve the service token for a tenant, in precedence order:
 *   1. explicit pre-minted token in `NOVA_SERVICE_TOKENS` (pin/override)
 *   2. single-tenant `NOVA_SERVICE_TOKEN` (legacy one-dev-store fallback)
 *   3. self-mint from `NOVA_SERVICE_SECRET` — the fleet-scale default
 */
export function serviceTokenFor(storeId: string): string {
  return tokenMap()[storeId] ?? process.env.NOVA_SERVICE_TOKEN ?? mintServiceToken(storeId);
}
