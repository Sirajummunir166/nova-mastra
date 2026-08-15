/**
 * The `fleet` eval suite — WHICH stores the dispatcher claims for.
 *
 * ── THE INCIDENT THIS MODULE EXISTS TO PREVENT ─────────────────────────────
 *
 * The per-minute dispatcher used to loop the in-process seed map: two demo
 * stores and two local-dev store ids that do not exist in the production
 * database. Against a live dakio-api that is **four guaranteed 403s every
 * minute, forever** — and, far worse, every real merchant who was not
 * hard-coded into that map was **invisible to the job system entirely**. Nova
 * was not failing loudly for those stores. Nova was simply never waking up for
 * them, and nothing in any log said so.
 *
 * So the two halves of this file are not equally important. The cache and TTL
 * checks are hygiene. The checks in section 3 are the incident: *the seeds are
 * never dispatched in dakio mode*, and *an outage claims nothing rather than
 * falling back to dead ids*.
 *
 * ── THE FAILURE POSTURE, AND WHY IT IS ASYMMETRIC ──────────────────────────
 *
 * A dakio-api blip must not stop job claims for every store on the platform,
 * so a failed fetch serves the **last good list stale**. But a process that
 * has never had a successful fetch has no idea who its tenants are, and the
 * honest answer there is **nothing** — an empty tick that retries next minute.
 * The tempting alternative (fall back to the seeds) is precisely the incident.
 *
 * ── ISOLATION NOTE ─────────────────────────────────────────────────────────
 *
 * The fleet token is TENANTLESS by design: it learns store ids and nothing
 * else. Every actual claim still goes through that store's own per-tenant
 * token. Section 1 pins that separation, because a fleet credential that
 * carried a `tenantId` — or that worked on tenant routes — would quietly
 * become a master key.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { listFleetStoreIds, resolveDispatchTenants, resetFleetCache } from "./fleet.js";
import { mintFleetToken, mintServiceToken, resetServiceTokenCache } from "../lib/service-token.js";
import { resetDynamicTenants } from "./tenants.js";
import { resetStoreBackendModeWarnings } from "./mode.js";

const decodeJwtPayload = (token: string) =>
  JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()) as Record<string, unknown>;

/**
 * Run `body` with a temporary environment, restoring every touched key
 * afterwards — including keys that were UNSET, which a naive save/restore
 * turns into the string "undefined".
 */
async function withEnv(patch: Record<string, string | undefined>, body: () => Promise<void> | void): Promise<void> {
  const keys = Object.keys(patch);
  const saved = new Map(keys.map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetServiceTokenCache();
  resetFleetCache();
  resetStoreBackendModeWarnings();
  try {
    await body();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetServiceTokenCache();
    resetFleetCache();
    resetDynamicTenants();
    resetStoreBackendModeWarnings();
  }
}

/** A fetch stub that records the URLs it was called with. */
function stubFetch(handler: (url: string, init?: RequestInit) => { status: number; body?: unknown }) {
  const calls: Array<{ url: string; auth: string | undefined }> = [];
  const impl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, auth: headers.Authorization });
    const { status, body } = handler(url, init);
    return new Response(JSON.stringify(body ?? {}), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { impl, calls };
}

const BASE = { DAKIO_API_URL: "http://dakio.test", NOVA_SERVICE_SECRET: "fleet-eval-secret" };

// ── 1. The fleet credential is not a master key ───────────────────────────

test("the fleet token is tenantless and cannot pose as a tenant token", async () => {
  await withEnv({ ...BASE, NOVA_SERVICE_TOKEN: undefined, NOVA_SERVICE_TOKENS: undefined }, () => {
    const fleet = decodeJwtPayload(mintFleetToken({ nowMs: 1_700_000_000_000 }));
    assert.equal(fleet.sub, "nova-fleet", "the fleet token's subject names it as the fleet reader");
    assert.equal(fleet.type, "service");
    assert.ok(!("tenantId" in fleet), "a fleet token carrying a tenantId would be usable on tenant routes");

    // And a real tenant token is a different thing entirely — this is the
    // separation the whole isolation story rests on.
    const tenant = decodeJwtPayload(mintServiceToken("store-aurora", { nowMs: 1_700_000_000_000 }));
    assert.equal(tenant.tenantId, "store-aurora");
    assert.notEqual(tenant.sub, fleet.sub);
  });
});

test("minting a fleet token without a signing secret fails closed", async () => {
  await withEnv({ ...BASE, NOVA_SERVICE_SECRET: undefined }, () => {
    assert.throws(() => mintFleetToken(), "an unsigned fleet token must never be produced");
  });
});

// ── 2. Fetch, cache, and the stale-on-error posture ───────────────────────

test("the fleet comes from GET /api/v1/store/fleet, authenticated as the fleet", async () => {
  await withEnv(BASE, async () => {
    const { impl, calls } = stubFetch((url) => {
      if (!url.endsWith("/api/v1/store/fleet")) return { status: 404 };
      return { status: 200, body: { storeIds: ["store-real-1", "store-real-2"] } };
    });
    const ids = await listFleetStoreIds({ fetchImpl: impl, nowMs: 1_700_000_000_000 });
    assert.deepEqual(ids, ["store-real-1", "store-real-2"]);
    assert.equal(calls[0].url, "http://dakio.test/api/v1/store/fleet");
    const payload = decodeJwtPayload((calls[0].auth ?? "").replace("Bearer ", ""));
    assert.equal(payload.sub, "nova-fleet", "the fleet call must use the FLEET token, not a tenant's");
  });
});

test("within the TTL the list is cached — one fleet call per tick at worst", async () => {
  await withEnv(BASE, async () => {
    const { impl, calls } = stubFetch(() => ({ status: 200, body: { storeIds: ["s1"] } }));
    const t0 = 1_700_000_000_000;
    await listFleetStoreIds({ fetchImpl: impl, nowMs: t0 });
    await listFleetStoreIds({ fetchImpl: impl, nowMs: t0 + 30_000 });
    assert.equal(calls.length, 1, "a second call inside the TTL should not hit the network");
    await listFleetStoreIds({ fetchImpl: impl, nowMs: t0 + 61_000 });
    assert.equal(calls.length, 2, "past the TTL the list must be refreshed");
  });
});

test("a dakio-api failure serves the last good list stale — claims keep flowing", async () => {
  await withEnv(BASE, async () => {
    const t0 = 1_700_000_000_000;
    const good = stubFetch(() => ({ status: 200, body: { storeIds: ["store-real-1"] } }));
    await listFleetStoreIds({ fetchImpl: good.impl, nowMs: t0 });

    for (const failure of [500, 503, 403, 200]) {
      const bad = stubFetch(() => (failure === 200 ? { status: 200, body: { notStoreIds: true } } : { status: failure }));
      const stale = await listFleetStoreIds({ fetchImpl: bad.impl, nowMs: t0 + 200_000 });
      assert.deepEqual(stale, ["store-real-1"], `a ${failure} response should serve the cached fleet`);
    }
  });
});

test("with no successful fetch EVER, the fleet is empty — not the dead seeds", async () => {
  await withEnv(BASE, async () => {
    const { impl } = stubFetch(() => ({ status: 500 }));
    const ids = await listFleetStoreIds({ fetchImpl: impl, nowMs: 1_700_000_000_000 });
    assert.deepEqual(ids, [], "an unknown fleet must claim nothing rather than guess");
  });
});

test("a network throw is handled like a failure, not propagated into the tick", async () => {
  await withEnv(BASE, async () => {
    const throwing = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const ids = await listFleetStoreIds({ fetchImpl: throwing, nowMs: 1_700_000_000_000 });
    assert.deepEqual(ids, [], "a thrown fetch must not take the dispatcher's minute down");
  });
});

test("garbage in the response is filtered, not trusted", async () => {
  await withEnv(BASE, async () => {
    const { impl } = stubFetch(() => ({ status: 200, body: { storeIds: [42, "", null, "store-ok", { id: "x" }] } }));
    const ids = await listFleetStoreIds({ fetchImpl: impl, nowMs: 1_700_000_000_000 });
    assert.deepEqual(ids, ["store-ok"], "non-string and empty ids must be dropped");
  });
});

test("without DAKIO_API_URL there is nothing to ask, and nothing is claimed", async () => {
  await withEnv({ ...BASE, DAKIO_API_URL: undefined }, async () => {
    const { impl, calls } = stubFetch(() => ({ status: 200, body: { storeIds: ["s1"] } }));
    const ids = await listFleetStoreIds({ fetchImpl: impl, nowMs: 1_700_000_000_000 });
    assert.deepEqual(ids, []);
    assert.equal(calls.length, 0, "with no base URL configured, no call should be attempted");
  });
});

// ── 3. THE INCIDENT — what resolveDispatchTenants may and may not dispatch ─

test("demo mode dispatches the registry seeds, so the eval suites keep running offline", async () => {
  await withEnv({ ...BASE, NOVA_STORE_BACKEND: "demo" }, async () => {
    const tenants = await resolveDispatchTenants();
    const ids = tenants.map((t) => t.storeId);
    assert.ok(ids.length > 0, "demo mode must still have a fleet");
    assert.ok(ids.includes("store-aurora"), `expected the seeds, got ${JSON.stringify(ids)}`);
  });
});

test("dakio mode dispatches the FLEET — and never the seeds (the 4×403/min incident)", async () => {
  await withEnv({ ...BASE, NOVA_STORE_BACKEND: "dakio" }, async () => {
    const { impl } = stubFetch((url) => {
      if (url.endsWith("/api/v1/store/fleet")) return { status: 200, body: { storeIds: ["store-live-9"] } };
      // ensureTenant asks for the store's own profile before dispatching it.
      return {
        status: 200,
        body: {
          storeId: "store-live-9",
          name: "Live Nine",
          status: "active",
          plan: "growth",
          currency: "BDT",
          locale: "en-BD",
          timezone: "Asia/Dhaka",
        },
      };
    });
    // `ensureTenant` reaches for global fetch; patch it for this section only.
    const realFetch = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      const ids = (await resolveDispatchTenants({ fetchImpl: impl, nowMs: 1_700_000_100_000 })).map((t) => t.storeId);
      assert.ok(ids.includes("store-live-9"), `the live store must be dispatched, got ${JSON.stringify(ids)}`);
      assert.ok(!ids.includes("store-aurora"), "demo seeds must never be dispatched against the live API");
      assert.ok(!ids.includes("store-beacon"), "demo seeds must never be dispatched against the live API");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

test("a fleet outage with no cache dispatches NOTHING rather than falling back to seeds", async () => {
  await withEnv({ ...BASE, NOVA_STORE_BACKEND: "dakio" }, async () => {
    const { impl } = stubFetch(() => ({ status: 503 }));
    const realFetch = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      const tenants = await resolveDispatchTenants({ fetchImpl: impl, nowMs: 1_700_000_200_000 });
      assert.equal(tenants.length, 0, "an empty tick is the honest answer; the seed loop is the incident");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

test("a store the fleet lists but whose profile is gone is dropped, not dispatched blind", async () => {
  // The fleet list and the profile read can disagree — a store deleted between
  // the two. Dispatching it anyway is how you get the 403-per-minute loop back
  // one id at a time.
  await withEnv({ ...BASE, NOVA_STORE_BACKEND: "dakio" }, async () => {
    const { impl } = stubFetch((url) => {
      if (url.endsWith("/api/v1/store/fleet")) return { status: 200, body: { storeIds: ["store-vanished"] } };
      return { status: 404 };
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      const tenants = await resolveDispatchTenants({ fetchImpl: impl, nowMs: 1_700_000_300_000 });
      assert.equal(tenants.length, 0, "a store with no readable profile must not be dispatched");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

test("a store the fleet lists but that is PAUSED is dropped before any claim", async () => {
  // Discovering a paused store via a 403 on its claim is the slow, noisy way.
  // The profile already says so.
  await withEnv({ ...BASE, NOVA_STORE_BACKEND: "dakio" }, async () => {
    const { impl } = stubFetch((url) => {
      if (url.endsWith("/api/v1/store/fleet")) return { status: 200, body: { storeIds: ["store-paused-1"] } };
      return {
        status: 200,
        body: {
          storeId: "store-paused-1",
          name: "Paused One",
          status: "paused",
          plan: "starter",
          currency: "BDT",
          locale: "en-BD",
          timezone: "Asia/Dhaka",
        },
      };
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      const tenants = await resolveDispatchTenants({ fetchImpl: impl, nowMs: 1_700_000_400_000 });
      assert.equal(tenants.length, 0, "a paused store must not be claimed for");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
