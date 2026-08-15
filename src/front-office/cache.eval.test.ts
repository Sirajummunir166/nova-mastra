/**
 * The observation cache — ported from nova-ai's inbox evals: freshness.ts
 * (doc 05 Phase 3 step 5: "prove with tests that repeated turns do NOT refetch
 * unchanged data unnecessarily", with Scenario E as the worked example) and
 * timing.ts's restraint principles (a failed call is recorded, not hidden).
 * Re-anchored from eve's productSnapshot/turnTiming seams onto observe() and
 * the TTL table — our lane's freshness classes are executable here, not prose.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { observe, TTL } from "./cache.js";
import { newLiveContext } from "./state.js";

function counter<T>(value: T): { calls: number; fetch: () => Promise<T> } {
  const c = { calls: 0, fetch: async () => (c.calls += 1, value) };
  return c;
}

// ---------------------------------------------------------------------------
// Scenario E — repeated turns do not refetch unchanged data
// ---------------------------------------------------------------------------

test("Scenario E: stock checked 20 sec ago answers 'fabric kemon?' with ZERO network", async () => {
  const ctx = newLiveContext("conv-e", "store-1");
  const f = counter([{ id: "p1", stock: 3 }]);

  const first = await observe(ctx, "list_products", { status: "active" }, f.fetch, TTL.stock);
  assert.equal(first.cacheHit, false, "the first read is a real fetch");
  assert.equal(f.calls, 1);

  // 20 seconds later the customer asks about fabric — nothing that turn needs
  // depends on re-reading stock, and the cache is what makes that free.
  const second = await observe(ctx, "list_products", { status: "active" }, f.fetch, TTL.stock, Date.now() + 20_000);
  assert.equal(second.cacheHit, true, "within TTL → served from the ledger");
  assert.equal(f.calls, 1, "no second network call");
  assert.equal(second.calledAt, first.calledAt, "freshness stays the AGE of the ORIGINAL observation — a cache hit never re-stamps it");
  assert.deepEqual(second.raw, first.raw);
});

test("a stale observation is refetched — the window is the contract", async () => {
  // NOTE: on a miss, observe() stamps the ledger with the REAL wall clock
  // (calledAt = Date.now()), while staleness compares against the caller's
  // `now`. So staleness must be simulated forward from the wall clock.
  const ctx = newLiveContext("conv-stale", "store-1");
  const f = counter("v1");
  await observe(ctx, "list_products", {}, f.fetch, TTL.stock);
  const later = await observe(ctx, "list_products", {}, f.fetch, TTL.stock, Date.now() + TTL.stock + 60_000);
  assert.equal(later.cacheHit, false, "past the window → real fetch");
  assert.equal(f.calls, 2);
});

test("dedup is per (tool, args) — different args are different observations", async () => {
  const ctx = newLiveContext("conv-args", "store-1");
  const f = counter("x");
  await observe(ctx, "list_products", { status: "active" }, f.fetch, TTL.product);
  await observe(ctx, "list_products", { status: "draft" }, f.fetch, TTL.product);
  assert.equal(f.calls, 2, "different args never share a cache row");
  await observe(ctx, "get_store_settings", {}, f.fetch, TTL.settings);
  assert.equal(f.calls, 3, "different tools never share one either");
});

test("every observation lands in the ledger — the audit trail is the cache's backing store", async () => {
  const ctx = newLiveContext("conv-ledger", "store-1");
  const f = counter(42);
  await observe(ctx, "get_store_settings", {}, f.fetch, TTL.settings);
  await observe(ctx, "get_store_settings", {}, f.fetch, TTL.settings, Date.now() + 1000);
  assert.equal(ctx.toolLedger.length, 1, "a cache hit adds no ledger row — one call happened, one row exists");
  assert.equal(ctx.toolLedger[0]?.ok, true);
  assert.equal(ctx.toolLedger[0]?.tool, "get_store_settings");
});

// ---------------------------------------------------------------------------
// Failure honesty — a failed call is written down, and never served as truth
// ---------------------------------------------------------------------------

test("a failed fetch is ledgered ok:false, rethrown, and NEVER served as a cache hit", async () => {
  const ctx = newLiveContext("conv-fail", "store-1");
  let calls = 0;
  const flaky = async () => {
    calls += 1;
    if (calls === 1) throw new Error("dakio-api 502");
    return "recovered";
  };

  await assert.rejects(() => observe(ctx, "list_products", {}, flaky, TTL.stock), /502/);
  assert.equal(ctx.toolLedger.length, 1, "the failure is a ledger row, never silence");
  assert.equal(ctx.toolLedger[0]?.ok, false);
  assert.deepEqual(ctx.toolLedger[0]?.raw, { error: "dakio-api 502" });

  // The very next read within the TTL window must refetch — an error is not
  // an observation, and serving it as one would answer the customer from a 502.
  const retry = await observe(ctx, "list_products", {}, flaky, TTL.stock, Date.now() + 1000);
  assert.equal(retry.cacheHit, false);
  assert.equal(retry.raw, "recovered");
});

test("latest wins per key: a newer stale entry hides an older fresh-looking one", async () => {
  // The tail-scan breaks at the NEWEST matching entry. If that one is stale we
  // refetch, even when an ancient row would technically sit inside some window
  // — the newest observation is the only honest one to reason from.
  const ctx = newLiveContext("conv-latest", "store-1");
  const f = counter("v");
  await observe(ctx, "list_products", {}, f.fetch, TTL.stock);
  await observe(ctx, "list_products", {}, f.fetch, TTL.stock, Date.now() + TTL.stock + 60_000); // refetch → 2nd row
  assert.equal(f.calls, 2);
  const third = await observe(ctx, "list_products", {}, f.fetch, TTL.stock, Date.now() + 2 * (TTL.stock + 60_000));
  assert.equal(third.cacheHit, false, "the newest row is stale → fetch again, never fall back to the older row");
  assert.equal(f.calls, 3);
});

// ---------------------------------------------------------------------------
// The TTL table — freshness classes from real Dakio update cadence
// ---------------------------------------------------------------------------

test("the freshness ladder is ordered by volatility: stock < price < settings < product", () => {
  assert.ok(TTL.stock < TTL.price, "stock moves faster than price");
  assert.ok(TTL.price < TTL.settings, "price moves faster than policies");
  assert.ok(TTL.settings < TTL.product, "product identity is the stable class");
});

test("the volatile class is minutes, the stable class is the conversation's day", () => {
  // Pinned values, so a casual edit to the cadence is loud: stock 2 min,
  // price 5 min, settings 30 min, product identity 24 h.
  assert.equal(TTL.stock, 120_000);
  assert.equal(TTL.price, 300_000);
  assert.equal(TTL.settings, 30 * 60_000);
  assert.equal(TTL.product, 24 * 60 * 60_000);
});
