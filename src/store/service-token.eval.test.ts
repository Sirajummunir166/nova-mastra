/**
 * Service-token mint suite — ported from nova-ai `evals/service-token/run.ts`.
 *
 * Proves Nova's self-minted per-tenant tokens are byte-compatible with
 * dakio-api's `novaAuth` verify (HS256, shape `{ type:"service", sub:"nova",
 * tenantId, iat, exp }`), that the per-tenant cache refreshes BEFORE expiry,
 * and that distinct tenants get distinct tokens. No network, no model.
 *
 * Port notes: the mastra `service-token.ts` dropped the original's test-only
 * `{ secret, nowMs }` overrides and `resetServiceTokenCache()`. Same
 * invariants hold here via the env secret (read lazily at mint time),
 * node:test's mocked `Date`, and a fresh tenant id per case (the mint cache
 * is keyed per tenant, so unique ids substitute for a cache reset).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mintServiceToken } from "../lib/service-token.js";

const SECRET = "test-nova-service-secret";
// service-token.ts reads env lazily inside each function (never at import
// time), so setting it in the module body — after ESM import hoisting — is
// still "before any mint".
process.env.NOVA_SERVICE_SECRET = SECRET;
delete process.env.NOVA_SERVICE_TOKEN;
delete process.env.NOVA_SERVICE_TOKENS;

function decode(token: string): {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: string;
  signature: string;
} {
  const [h, p, s] = token.split(".");
  return {
    header: JSON.parse(Buffer.from(h, "base64url").toString()) as Record<string, unknown>,
    payload: JSON.parse(Buffer.from(p, "base64url").toString()) as Record<string, unknown>,
    signingInput: `${h}.${p}`,
    signature: s,
  };
}

test("shape + signature — what dakio-api's jwt.verify(HS256) will accept", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const token = mintServiceToken("tenant-A");
  const d = decode(token);

  assert.equal(token.split(".").length, 3, "three-part JWT");
  assert.equal(d.header.alg, "HS256");
  assert.equal(d.header.typ, "JWT");
  assert.equal(d.payload.type, "service");
  assert.equal(d.payload.sub, "nova");
  assert.equal(d.payload.tenantId, "tenant-A", "tenantId scoped");
  assert.equal(typeof d.payload.iat, "number", "iat is a number");
  assert.equal(typeof d.payload.exp, "number", "exp is a number");
  assert.equal(
    (d.payload.exp as number) - (d.payload.iat as number),
    3600,
    "exp = iat + 1h default",
  );

  const goodSig = Buffer.from(
    createHmac("sha256", SECRET).update(d.signingInput).digest(),
  ).toString("base64url");
  assert.equal(d.signature, goodSig, "signature verifies with the shared secret");

  const badSig = Buffer.from(
    createHmac("sha256", "wrong-secret").update(d.signingInput).digest(),
  ).toString("base64url");
  assert.notEqual(d.signature, badSig, "signature fails with the wrong secret");
});

test("cache — same token inside TTL, re-mint BEFORE expiry (refresh skew)", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const b1 = mintServiceToken("tenant-cache-skew");
  t.mock.timers.setTime(1_000_000 + 60_000); // +1 minute
  const b2 = mintServiceToken("tenant-cache-skew");
  assert.equal(b2, b1, "cached within TTL");

  // 56 minutes in: still 4 minutes BEFORE the 1h expiry, but inside the
  // 5-minute refresh skew — an in-flight request never carries a
  // just-expired token, so a fresh one must be minted here already.
  t.mock.timers.setTime(1_000_000 + 56 * 60_000);
  const b3 = mintServiceToken("tenant-cache-skew");
  assert.notEqual(b3, b1, "re-mints before expiry (inside the refresh skew)");
  assert.equal(
    decode(b3).payload.iat,
    Math.floor((1_000_000 + 56 * 60_000) / 1000),
    "re-minted token carries the new iat",
  );
});

test("cache — a token at/after its expiry is never served", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const c1 = mintServiceToken("tenant-cache-expiry");
  t.mock.timers.setTime(1_000_000 + 3_600_000); // exactly the 1h expiry
  const c2 = mintServiceToken("tenant-cache-expiry");
  assert.notEqual(c2, c1, "re-mints near/at expiry");
});

test("per-tenant token isolation — distinct tenants, distinct scoped tokens", (t) => {
  // Same frozen clock for both mints: the ONLY difference is the tenantId.
  t.mock.timers.enable({ apis: ["Date"], now: 2_000_000 });
  const ta = mintServiceToken("tenant-iso-A");
  const tb = mintServiceToken("tenant-iso-B");
  assert.notEqual(ta, tb, "distinct tenants get distinct tokens");
  assert.equal(decode(ta).payload.tenantId, "tenant-iso-A", "token A scoped to A");
  assert.equal(decode(tb).payload.tenantId, "tenant-iso-B", "token B scoped to B");
});

test("fail-closed — minting without NOVA_SERVICE_SECRET throws", () => {
  const saved = process.env.NOVA_SERVICE_SECRET;
  delete process.env.NOVA_SERVICE_SECRET;
  try {
    // A tenant id no other case has minted, so the cache cannot answer.
    assert.throws(() => mintServiceToken("tenant-no-secret"));
  } finally {
    if (saved !== undefined) process.env.NOVA_SERVICE_SECRET = saved;
  }
});
