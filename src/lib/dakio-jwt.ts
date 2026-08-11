/**
 * Dakio JWT verification — ported from nova-ai `agent/lib/auth/dakio-jwt.ts`.
 *
 * Tenancy comes ONLY from a Dakio-signed JWT verified here. The merchant
 * dashboard sends `Authorization: Bearer <jwt>`; on success the session is
 * pinned to the token's tenant. Dev uses a shared HMAC secret
 * (`DAKIO_JWT_SECRET`, HS256 — must equal dakio-api's `JWT_SECRET`); prod can
 * use `DAKIO_JWT_PUBLIC_KEY` (RS256/ES256). With neither configured,
 * verification fails closed.
 */

import { createHmac, createVerify, timingSafeEqual } from "node:crypto";

export interface DakioClaims {
  sub: string;
  storeId: string;
  role: string;
  plan?: string;
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  [claim: string]: unknown;
}

interface DakioJwtConfig {
  issuer?: string;
  audience?: string;
  secret?: string;
  publicKey?: string;
  clockToleranceSec?: number;
}

function configFromEnv(): DakioJwtConfig {
  return {
    issuer: process.env.DAKIO_JWT_ISSUER,
    audience: process.env.DAKIO_JWT_AUDIENCE,
    secret: process.env.DAKIO_JWT_SECRET,
    publicKey: process.env.DAKIO_JWT_PUBLIC_KEY,
  };
}

function verifySignature(
  alg: string,
  signingInput: string,
  signature: Buffer,
  config: DakioJwtConfig,
): boolean {
  if (alg === "HS256") {
    if (!config.secret) return false;
    const expected = createHmac("sha256", config.secret).update(signingInput).digest();
    return expected.length === signature.length && timingSafeEqual(expected, signature);
  }
  if (alg === "RS256") {
    if (!config.publicKey) return false;
    return createVerify("RSA-SHA256").update(signingInput).verify(config.publicKey, signature);
  }
  if (alg === "ES256") {
    if (!config.publicKey) return false;
    // ES256 JWT signatures are IEEE-P1363 (r||s), not DER.
    return createVerify("SHA256").update(signingInput).verify(
      { key: config.publicKey, dsaEncoding: "ieee-p1363" },
      signature,
    );
  }
  return false; // unsupported alg (incl. "none") → reject
}

/**
 * Verify a Dakio JWT and return its claims, or `null` if the token is
 * malformed, unsigned/badly-signed, expired, or fails an issuer/audience/
 * storeId check. Never throws on an untrusted token — callers fail closed on
 * `null`.
 */
export function verifyDakioJwt(token: string | null | undefined): DakioClaims | null {
  if (!token) return null;
  const config = configFromEnv();

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts;

  let header: { alg?: string };
  let claims: DakioClaims;
  try {
    header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  const alg = header.alg;
  if (typeof alg !== "string") return null;
  if (!config.secret && !config.publicKey) return null;

  const signature = Buffer.from(signatureB64, "base64url");
  if (!verifySignature(alg, `${headerB64}.${payloadB64}`, signature, config)) return null;

  const now = Math.floor(Date.now() / 1000);
  const skew = config.clockToleranceSec ?? 60;
  // Require an expiry: a token with no `exp` would never die. Fail closed.
  if (typeof claims.exp !== "number") return null;
  if (now > claims.exp + skew) return null;
  if (typeof claims.nbf === "number" && now + skew < claims.nbf) return null;

  if (config.issuer && claims.iss !== config.issuer) return null;
  if (config.audience) {
    const aud = claims.aud;
    const ok = Array.isArray(aud) ? aud.includes(config.audience) : aud === config.audience;
    if (!ok) return null;
  }

  // Dakio's live merchant tokens (dakio-api src/routes/auth.js) carry
  // `{userId, tenantId, role}` rather than `{sub, storeId}`, and role is
  // uppercase (`OWNER`). Normalize AFTER signature verification, BEFORE the
  // fail-closed tenancy checks, so both token dialects pass the same gate.
  if (typeof claims.sub !== "string" || claims.sub.length === 0) {
    if (typeof claims.userId === "string" && claims.userId.length > 0) claims.sub = claims.userId;
  }
  if (typeof claims.storeId !== "string" || claims.storeId.length === 0) {
    if (typeof claims.tenantId === "string" && claims.tenantId.length > 0) claims.storeId = claims.tenantId;
  }
  if (typeof claims.role === "string") claims.role = claims.role.toLowerCase();

  // Tenancy is mandatory: a token with no storeId is useless and unsafe.
  if (typeof claims.storeId !== "string" || claims.storeId.length === 0) return null;
  if (typeof claims.sub !== "string" || claims.sub.length === 0) return null;

  return claims;
}

export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : null;
}
