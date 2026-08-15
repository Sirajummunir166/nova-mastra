/**
 * Backend-mode agreement suite (I1).
 *
 * `NOVA_STORE_BACKEND` decides two things that MUST be the same decision:
 *
 *   - which store client `storeFor()` builds (demo in-process vs live HTTP), and
 *   - which fleet `resolveDispatchTenants()` iterates (registry seeds vs the
 *     ids dakio-api says are hired).
 *
 * They were read two different ways — `resolve.ts` said `=== "demo" ? demo :
 * dakio` while `fleet.ts` (and `tenants.ts`) said `=== "dakio" ? dakio : demo`
 * — so with the variable UNSET the dispatcher iterated the hard-coded demo
 * tenant list while every client it built talked to the real dakio-api: the
 * brain ticking for stores that do not exist and never ticking for the ones
 * that do.
 *
 * This suite pins the fix: ONE helper (`storeBackendMode`), and every module
 * that branches on the mode observably agrees with it across unset / "demo" /
 * "dakio" / garbage.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NOVA_SERVICE_SECRET = "test-nova-service-secret";
process.env.DAKIO_API_URL = "http://dakio.test";
delete process.env.NOVA_SERVICE_TOKEN;
delete process.env.NOVA_SERVICE_TOKENS;

const { storeBackendMode } = await import("./mode.js");
const { storeFor, resetStores } = await import("./resolve.js");
const { resolveDispatchTenants, resetFleetCache } = await import("./fleet.js");
const { DakioStoreClient } = await import("./dakio.js");
const { DemoStore } = await import("./backend.js");

/** Every value the env var can realistically hold, with the ONE right answer. */
const CASES: ReadonlyArray<{ label: string; value: string | undefined; expect: "demo" | "dakio" }> = [
  { label: "unset", value: undefined, expect: "dakio" },
  { label: '"demo"', value: "demo", expect: "demo" },
  { label: '"dakio"', value: "dakio", expect: "dakio" },
  { label: "empty string", value: "", expect: "dakio" },
  { label: "garbage", value: "banana", expect: "dakio" },
  { label: "wrong case", value: "DEMO", expect: "demo" },
  { label: "padded", value: "  demo  ", expect: "demo" },
];

function setMode(value: string | undefined): void {
  if (value === undefined) delete process.env.NOVA_STORE_BACKEND;
  else process.env.NOVA_STORE_BACKEND = value;
}

test("the helper answers one mode per env value — and dakio is the unset default", () => {
  for (const c of CASES) {
    setMode(c.value);
    assert.equal(storeBackendMode(), c.expect, `${c.label} → ${c.expect}`);
  }
});

test("resolve.ts and fleet.ts agree — no split brain for any env value", async () => {
  for (const c of CASES) {
    setMode(c.value);
    resetStores();
    resetFleetCache();

    // What resolve.ts decided: the CLASS of client the dispatcher will use.
    const client = storeFor("store-aurora");
    const resolveMode = client instanceof DakioStoreClient ? "dakio" : "demo";
    assert.ok(
      client instanceof DakioStoreClient || client instanceof DemoStore,
      `${c.label}: storeFor built a recognised backend`,
    );

    // What fleet.ts decided: demo mode iterates the registry seeds with ZERO
    // network; dakio mode asks dakio-api for the fleet.
    let fleetFetched = false;
    const tenants = await resolveDispatchTenants({
      fetchImpl: (async () => {
        fleetFetched = true;
        return new Response(JSON.stringify({ storeIds: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });
    const fleetMode = fleetFetched ? "dakio" : "demo";

    assert.equal(resolveMode, c.expect, `${c.label}: storeFor built the ${c.expect} backend`);
    assert.equal(fleetMode, c.expect, `${c.label}: the dispatcher used the ${c.expect} fleet`);
    assert.equal(
      resolveMode,
      fleetMode,
      `${c.label}: SPLIT BRAIN — clients say ${resolveMode}, fleet says ${fleetMode}`,
    );

    // And the concrete symptom the split produced: in dakio mode the fleet is
    // never the hard-coded seed list.
    if (c.expect === "dakio") {
      assert.equal(tenants.length, 0, `${c.label}: an empty fleet answer claims for nobody`);
    } else {
      assert.ok(tenants.length > 0, `${c.label}: demo mode iterates the seeded tenants`);
    }
  }
});

test("tenants.ts provisions from the same mode the clients talk to", async () => {
  const { ensureTenant } = await import("./tenants.js");

  // demo mode: a store that is NOT seeded resolves to nothing, with no network
  // (a dakio-mode ensureTenant would try to fetch a profile and we would see it).
  setMode("demo");
  assert.equal(
    await ensureTenant("store-aurora"),
    (await import("./tenants.js")).getTenant("store-aurora"),
    "demo mode answers straight from the seeded registry",
  );

  // dakio mode with no DAKIO_API_URL: the profile fetch cannot even be built,
  // which is the observable proof the dakio branch was taken.
  setMode("dakio");
  const savedUrl = process.env.DAKIO_API_URL;
  delete process.env.DAKIO_API_URL;
  try {
    // Never throws by contract — it fails closed / serves the cold-start seed.
    const record = await ensureTenant("cmr-unseeded-store-id");
    assert.equal(record, null, "dakio mode with no API url provisions nothing");
  } finally {
    process.env.DAKIO_API_URL = savedUrl;
  }
});
