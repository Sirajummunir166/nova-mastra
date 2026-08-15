/**
 * Legacy-token scoping suite (I4).
 *
 * `serviceTokenFor` used to end in:
 *
 *   tokenMap()[storeId] ?? process.env.NOVA_SERVICE_TOKEN ?? mintServiceToken(storeId)
 *
 * — an unconditional fallback. A deployment with the legacy single-store
 * `NOVA_SERVICE_TOKEN` set therefore handed THAT ONE TENANT'S credential to
 * every per-tenant client the dispatcher built, so store B's client
 * authenticated as store A and dakio-api (which derives the tenant from the
 * TOKEN, not from anything Nova sends) answered with store A's data. That
 * voids the per-tenant isolation the whole fleet design rests on, silently,
 * from one env var nobody thought was still live.
 *
 * The legacy var still works — for the ONE store it belongs to, declared
 * either explicitly (`NOVA_SERVICE_TOKEN_STORE_ID`) or by the token's own
 * `tenantId` claim. For any other store it is refused, loudly, and that store
 * gets its own correctly-scoped self-minted token instead.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

const SECRET = "test-nova-service-secret";
process.env.NOVA_SERVICE_SECRET = SECRET;
delete process.env.NOVA_SERVICE_TOKEN;
delete process.env.NOVA_SERVICE_TOKENS;
delete process.env.NOVA_SERVICE_TOKEN_STORE_ID;

import { serviceTokenFor, resetServiceTokenCache } from "./service-token.js";

const A = "store-alpha";
const B = "store-bravo";

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

/** A token in dakio-api's exact shape, scoped to one tenant. */
function tokenFor(tenantId: string): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({ type: "service", sub: "nova", tenantId, iat: 1, exp: 2 ** 31 }),
  );
  const sig = b64url(createHmac("sha256", SECRET).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${sig}`;
}

function tenantOf(token: string): unknown {
  const payload = token.split(".")[1];
  const decoded = JSON.parse(Buffer.from(payload!, "base64url").toString()) as { tenantId?: unknown };
  return decoded.tenantId;
}

function reset(): void {
  resetServiceTokenCache();
  delete process.env.NOVA_SERVICE_TOKEN;
  delete process.env.NOVA_SERVICE_TOKENS;
  delete process.env.NOVA_SERVICE_TOKEN_STORE_ID;
}

test("THE LEAK: a legacy token is never handed to a store it does not belong to", () => {
  reset();
  const legacy = tokenFor(A);
  process.env.NOVA_SERVICE_TOKEN = legacy;

  // Its own store still gets it — the legacy single-store setup keeps working.
  assert.equal(serviceTokenFor(A), legacy, "the declared store still uses the pinned token");

  // Any other store does NOT.
  const bToken = serviceTokenFor(B);
  assert.notEqual(bToken, legacy, "store B never carries store A's credential");
  assert.equal(tenantOf(bToken), B, "store B gets a token scoped to store B");
});

test("an explicitly declared store id binds the legacy token, even for an opaque one", () => {
  reset();
  process.env.NOVA_SERVICE_TOKEN = "an-opaque-pre-minted-token";
  process.env.NOVA_SERVICE_TOKEN_STORE_ID = A;

  assert.equal(serviceTokenFor(A), "an-opaque-pre-minted-token");
  assert.equal(tenantOf(serviceTokenFor(B)), B, "and only that one store");
});

test("an UNBINDABLE legacy token is refused for everyone rather than guessed at", () => {
  reset();
  // No declared id, and nothing in the token says who it belongs to.
  process.env.NOVA_SERVICE_TOKEN = "an-opaque-pre-minted-token";

  for (const id of [A, B]) {
    const token = serviceTokenFor(id);
    assert.notEqual(token, "an-opaque-pre-minted-token", `${id} does not get the unscoped token`);
    assert.equal(tenantOf(token), id, `${id} gets its own scoped token`);
  }
});

test("the explicit declaration beats the token's own claim (an operator's word is final)", () => {
  reset();
  process.env.NOVA_SERVICE_TOKEN = tokenFor(A);
  process.env.NOVA_SERVICE_TOKEN_STORE_ID = B;

  assert.equal(serviceTokenFor(B), process.env.NOVA_SERVICE_TOKEN, "declared store B gets it");
  assert.equal(tenantOf(serviceTokenFor(A)), A, "store A now self-mints instead");
});

test("the per-store map still outranks the legacy token, for the map's own store", () => {
  reset();
  process.env.NOVA_SERVICE_TOKENS = JSON.stringify({ [A]: "map-token-A" });
  process.env.NOVA_SERVICE_TOKEN = tokenFor(A);

  assert.equal(serviceTokenFor(A), "map-token-A", "the explicit per-store pin wins");
  assert.equal(tenantOf(serviceTokenFor(B)), B, "and B is untouched by either");
});

test("with no legacy token set at all, nothing changed — every store self-mints its own", () => {
  reset();
  assert.equal(tenantOf(serviceTokenFor(A)), A);
  assert.equal(tenantOf(serviceTokenFor(B)), B);
  assert.notEqual(serviceTokenFor(A), serviceTokenFor(B));
});

test("the refusal is LOUD — a mis-scoped legacy token warns rather than passing silently", () => {
  reset();
  const warnings: string[] = [];
  const saved = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
  try {
    process.env.NOVA_SERVICE_TOKEN = tokenFor(A);
    serviceTokenFor(B);
    serviceTokenFor(B); // repeated calls must not spam the log
  } finally {
    console.warn = saved;
  }
  assert.equal(warnings.length, 1, "one warning per store, not one per call");
  assert.match(warnings[0]!, /NOVA_SERVICE_TOKEN/, "names the variable an operator must fix");
  assert.match(warnings[0]!, new RegExp(B), "names the store that was refused");
});
