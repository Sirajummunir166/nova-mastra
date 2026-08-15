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

/**
 * Test-only overrides, restored in phase E (the phase A port dropped them and
 * the fleet + service-token suites are written against them).
 *
 * Every field is optional and every default is the production one, so
 * `mintServiceToken(id)` behaves exactly as it did with no second argument.
 * They exist so a suite can drive the cache deterministically — freeze `nowMs`
 * across two mints and the ONLY difference is the tenant id; shrink `ttlSec`
 * and the refresh-skew boundary is reachable without a mocked clock; pass
 * `secret` and a case never has to mutate `process.env` under a parallel
 * runner.
 */
export interface MintOptions {
  /** Override the secret (tests). Defaults to `NOVA_SERVICE_SECRET`. */
  secret?: string;
  /** Token lifetime in seconds. Default 1h. */
  ttlSec?: number;
  /** Override "now" (epoch ms) — tests only. */
  nowMs?: number;
}

export function mintServiceToken(tenantId: string, opts: MintOptions = {}): string {
  const secret = opts.secret ?? process.env.NOVA_SERVICE_SECRET;
  if (!secret) {
    throw new Error(
      `Cannot mint a service token for '${tenantId}': set NOVA_SERVICE_SECRET ` +
        `(must equal dakio-api's NOVA_SERVICE_SECRET).`,
    );
  }
  const nowMs = opts.nowMs ?? Date.now();
  const ttlSec = opts.ttlSec ?? DEFAULT_TTL_SEC;

  const cached = cache.get(tenantId);
  if (cached && cached.expMs - REFRESH_SKEW_MS > nowMs) return cached.token;

  const iat = Math.floor(nowMs / 1000);
  const exp = iat + ttlSec;
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ type: "service", sub: "nova", tenantId, iat, exp }));
  const signingInput = `${header}.${payload}`;
  const signature = b64url(createHmac("sha256", secret).update(signingInput).digest());
  const token = `${signingInput}.${signature}`;

  cache.set(tenantId, { token, expMs: exp * 1000 });
  return token;
}

/**
 * The fleet-listing token — the one deliberately tenantless credential.
 * Same secret, DIFFERENT `sub` (`nova-fleet`, no `tenantId`): dakio-api's
 * `authenticateNovaFleet` accepts only this shape on `GET /store/fleet`, and
 * its tenant-scoped routes refuse it (`sub !== 'nova'`), so the credential
 * that can list stores can never read any store's data — and vice versa.
 * Cached under a key no real tenant id can collide with (ids are cuids/slugs,
 * never colons).
 */
const FLEET_CACHE_KEY = "::fleet::";

export function mintFleetToken(opts: MintOptions = {}): string {
  const secret = opts.secret ?? process.env.NOVA_SERVICE_SECRET;
  if (!secret) {
    throw new Error("Fleet listing needs NOVA_SERVICE_SECRET (NOVA_STORE_BACKEND=dakio).");
  }
  const nowMs = opts.nowMs ?? Date.now();
  const ttlSec = opts.ttlSec ?? DEFAULT_TTL_SEC;

  const cached = cache.get(FLEET_CACHE_KEY);
  if (cached && cached.expMs - REFRESH_SKEW_MS > nowMs) return cached.token;

  const iat = Math.floor(nowMs / 1000);
  const exp = iat + ttlSec;
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ type: "service", sub: "nova-fleet", iat, exp }));
  const signingInput = `${header}.${payload}`;
  const signature = b64url(createHmac("sha256", secret).update(signingInput).digest());
  const token = `${signingInput}.${signature}`;

  cache.set(FLEET_CACHE_KEY, { token, expMs: exp * 1000 });
  return token;
}

/**
 * Clear the mint cache — tests, or a forced rotation after the secret changes.
 *
 * Clears `tokenMapCache` too, and that half is the one that matters outside
 * tests: `NOVA_SERVICE_TOKENS` is parsed ONCE and memoised, so a process that
 * has already answered one `serviceTokenFor` call will keep serving the old
 * map for its lifetime unless this is called.
 */
export function resetServiceTokenCache(): void {
  cache.clear();
  tokenMapCache = null;
  legacyRefusalWarned.clear();
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

/** Stores already warned about a mis-scoped legacy token — one warn per store. */
const legacyRefusalWarned = new Set<string>();

/** Test-only: let a suite re-observe a warning it has already triggered. */
export function resetLegacyTokenWarnings(): void {
  legacyRefusalWarned.clear();
}

/**
 * Read a service token's own `tenantId` claim without verifying it.
 *
 * Unverified is fine and deliberate: this is not an authorisation decision. It
 * answers "which store did whoever minted this INTEND it for", purely so we
 * can decline to send it anywhere else. dakio-api still verifies the signature
 * and derives the real tenant from it — a forged claim here can only ever
 * cause us to self-mint instead, never to widen access.
 */
function declaredTenantOf(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString()) as {
      tenantId?: unknown;
    };
    return typeof payload.tenantId === "string" && payload.tenantId.length > 0
      ? payload.tenantId
      : null;
  } catch {
    return null;
  }
}

/**
 * The legacy single-store `NOVA_SERVICE_TOKEN`, but ONLY for the store it
 * actually belongs to.
 *
 * It used to be an unconditional `?? process.env.NOVA_SERVICE_TOKEN` between
 * the per-store map and the self-mint, which meant that in any deployment
 * where the var was still set — a leftover from the one-dev-store era, exactly
 * the kind of thing nobody removes — EVERY per-tenant client the dispatcher
 * built carried one tenant's credential. dakio-api derives the tenant from the
 * token, so store B's "isolated" client would read and WRITE store A's data.
 * Per-tenant isolation is the assumption the entire fleet design rests on, and
 * one stale env var quietly inverted it.
 *
 * It is bound rather than deleted because deleting it would silently change
 * behaviour for any deployment still relying on it (and the mint path needs
 * `NOVA_SERVICE_SECRET`, which such a deployment may not have set) — a
 * single-store install that today works would start failing closed at the
 * first request, with nothing pointing at the cause. Binding keeps that install
 * working, makes the cross-tenant case impossible, and says out loud what to
 * fix. `tenants.ts` already had to defend against this leak downstream, with a
 * profile storeId identity check whose comment names "the legacy single
 * NOVA_SERVICE_TOKEN fallback" as the hazard; this closes it at the source.
 *
 * Which store it belongs to comes from `NOVA_SERVICE_TOKEN_STORE_ID` if the
 * operator declared one, otherwise from the token's own `tenantId` claim
 * (dakio-api's fixed token shape carries it, so a real service token is
 * self-describing). A token that is neither declared nor self-describing
 * cannot be bound to anyone and is therefore used for no one.
 */
function legacyTokenFor(storeId: string): string | null {
  const token = process.env.NOVA_SERVICE_TOKEN;
  if (!token) return null;

  const declared = process.env.NOVA_SERVICE_TOKEN_STORE_ID?.trim() || declaredTenantOf(token);
  if (declared === storeId) return token;

  if (!legacyRefusalWarned.has(storeId)) {
    legacyRefusalWarned.add(storeId);
    console.warn(
      `[service-token] NOVA_SERVICE_TOKEN is ${
        declared ? `scoped to '${declared}'` : "not bound to any store"
      } — REFUSING it for '${storeId}' and self-minting that store's own token instead. ` +
        `Sending it would authenticate ${storeId} as ${declared ?? "another tenant"} on dakio-api. ` +
        `Use NOVA_SERVICE_TOKENS ({"storeId":"jwt"}) for per-store pins, or set ` +
        `NOVA_SERVICE_TOKEN_STORE_ID to declare which store NOVA_SERVICE_TOKEN belongs to.`,
    );
  }
  return null;
}

/**
 * Resolve the service token for a tenant, in precedence order:
 *   1. explicit pre-minted token in `NOVA_SERVICE_TOKENS` (per-store pin)
 *   2. legacy `NOVA_SERVICE_TOKEN` — only for the ONE store it is bound to
 *   3. self-mint from `NOVA_SERVICE_SECRET` — the fleet-scale default
 *
 * Every branch returns a token scoped to `storeId` and nothing else.
 */
export function serviceTokenFor(storeId: string): string {
  return tokenMap()[storeId] ?? legacyTokenFor(storeId) ?? mintServiceToken(storeId);
}
