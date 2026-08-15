/**
 * Request-deadline suite (I3) — a hung dakio-api never parks a brain job.
 *
 * `DakioStoreClient.request` called `fetch` with no `signal`, and
 * `withGatewayRetry` layers retries without a budget. A dakio-api that accepts
 * the connection and then says nothing therefore held the promise open
 * FOREVER: past the job's 10-minute lease (so the watchdog re-dues the row and
 * the work runs twice), and — because the dispatcher awaits its tenants with
 * `Promise.all` — holding every other tenant's tick open with it.
 *
 * The repo already knew the pattern (`fleet.ts` AbortSignal.timeout(8_000),
 * `tenants.ts` PROFILE_TIMEOUT_MS); the client just never used it. These cases
 * are written against a fetch that hangs until aborted, so a regression here
 * fails as a TEST TIMEOUT rather than passing quietly.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NOVA_STORE_BACKEND = "dakio";
process.env.NOVA_SERVICE_SECRET = "test-nova-service-secret";

import { DakioStoreClient, DakioTimeoutError } from "./dakio.js";

/**
 * A fetch that never answers — it only ever settles by being aborted.
 *
 * It holds a ref'd timer for the same reason a real hung request holds a
 * socket: something must keep the process alive while the call is pending.
 * (`AbortSignal.timeout`'s own timer is unref'd, so without this the test
 * process would simply exit instead of exercising the deadline.)
 */
function hangingFetch(): { impl: typeof fetch; calls: () => number } {
  let calls = 0;
  const impl = ((_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      calls += 1;
      const socket = setTimeout(() => {}, 60_000); // stands in for the open connection
      const settle = (err: unknown) => {
        clearTimeout(socket);
        reject(err as Error);
      };
      const signal = init?.signal;
      if (!signal) return; // no signal ⇒ hangs forever, which is the bug
      if (signal.aborted) return settle(signal.reason);
      signal.addEventListener("abort", () => settle(signal.reason), { once: true });
    })) as unknown as typeof fetch;
  return { impl, calls: () => calls };
}

function client(overrides: { timeoutMs?: number; deadlineMs?: number; maxRetries?: number } = {}) {
  return new DakioStoreClient("store-x", {
    baseUrl: "http://dakio.test",
    token: () => "t",
    timeoutMs: 60,
    deadlineMs: 300,
    maxRetries: 3,
    ...overrides,
  });
}

test("a hung read rejects on the deadline instead of parking forever", async () => {
  const { impl, calls } = hangingFetch();
  const saved = globalThis.fetch;
  globalThis.fetch = impl;
  const startedAt = Date.now();
  try {
    await assert.rejects(
      () => client().listProducts(),
      (err: unknown) => {
        assert.ok(err instanceof DakioTimeoutError, `a typed timeout, got ${String(err)}`);
        assert.match(String((err as Error).message), /timed out|deadline/i, "says what happened");
        assert.match(String((err as Error).message), /GET/, "names the call the caller made");
        return true;
      },
    );
  } finally {
    globalThis.fetch = saved;
  }
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 5_000, `bounded (took ${elapsed}ms)`);
  assert.ok(calls() >= 1, "it did try");
});

test("the deadline caps the WHOLE call, not each attempt — retries cannot stack past it", async () => {
  const { impl } = hangingFetch();
  const saved = globalThis.fetch;
  globalThis.fetch = impl;
  const startedAt = Date.now();
  try {
    // 4 attempts × 100ms would be 400ms+ of hanging alone; the 250ms deadline wins.
    await assert.rejects(() => client({ timeoutMs: 100, deadlineMs: 250, maxRetries: 3 }).listProducts());
  } finally {
    globalThis.fetch = saved;
  }
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 1_000, `the whole call is bounded by the deadline (took ${elapsed}ms)`);
});

test("a hung WRITE is bounded too — a stuck settle must not outlive the lease", async () => {
  const { impl } = hangingFetch();
  const saved = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    await assert.rejects(
      () => client().completeJob("job_1", "tok"),
      (err: unknown) => err instanceof DakioTimeoutError,
    );
  } finally {
    globalThis.fetch = saved;
  }
});

test("a response that arrives inside the budget is NOT killed", async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = (async () => {
    await new Promise((r) => setTimeout(r, 30));
    return new Response(JSON.stringify({ products: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  try {
    assert.deepEqual(await client({ timeoutMs: 400, deadlineMs: 1_000 }).listProducts(), []);
  } finally {
    globalThis.fetch = saved;
  }
});

test("the defaults are generous enough for a slow read and far short of a 10-minute lease", async () => {
  const { defaultRequestTimeoutMs, defaultRequestDeadlineMs } = await import("./dakio.js");
  const timeout = defaultRequestTimeoutMs();
  const deadline = defaultRequestDeadlineMs();
  assert.ok(timeout >= 10_000, `a normal slow read survives (${timeout}ms per attempt)`);
  assert.ok(deadline >= timeout, "the deadline is at least one attempt");
  assert.ok(deadline <= 120_000, `the whole call ends well inside a 10-minute lease (${deadline}ms)`);
});

test("both bounds are overridable by env for an operator who needs a longer rope", async () => {
  const { defaultRequestTimeoutMs, defaultRequestDeadlineMs } = await import("./dakio.js");
  const saved = [process.env.NOVA_STORE_TIMEOUT_MS, process.env.NOVA_STORE_DEADLINE_MS] as const;
  try {
    process.env.NOVA_STORE_TIMEOUT_MS = "31000";
    process.env.NOVA_STORE_DEADLINE_MS = "62000";
    assert.equal(defaultRequestTimeoutMs(), 31_000);
    assert.equal(defaultRequestDeadlineMs(), 62_000);

    // Garbage never silently disables the bound.
    process.env.NOVA_STORE_TIMEOUT_MS = "banana";
    process.env.NOVA_STORE_DEADLINE_MS = "0";
    assert.ok(defaultRequestTimeoutMs() >= 10_000, "a bad value falls back to the default");
    assert.ok(defaultRequestDeadlineMs() >= 10_000, "zero is not 'no deadline'");
  } finally {
    if (saved[0] === undefined) delete process.env.NOVA_STORE_TIMEOUT_MS;
    else process.env.NOVA_STORE_TIMEOUT_MS = saved[0];
    if (saved[1] === undefined) delete process.env.NOVA_STORE_DEADLINE_MS;
    else process.env.NOVA_STORE_DEADLINE_MS = saved[1];
  }
});

test("withGatewayRetry can be given a deadline so its retries stop costing time", async () => {
  const { withGatewayRetry } = await import("../lib/gateway-retry.js");

  // Without a deadline: unchanged behaviour — 3 attempts, all of them made.
  let attempts = 0;
  await assert.rejects(() =>
    withGatewayRetry(async () => {
      attempts += 1;
      throw new Error("Service temporarily unavailable");
    }, 3),
  );
  assert.equal(attempts, 3, "the existing contract is untouched when no deadline is passed");

  // With one: the budget stops the retry loop rather than sleeping through it.
  attempts = 0;
  const startedAt = Date.now();
  await assert.rejects(() =>
    withGatewayRetry(
      async () => {
        attempts += 1;
        throw new Error("Service temporarily unavailable");
      },
      5,
      { deadlineMs: 50 },
    ),
  );
  assert.ok(attempts < 5, `gave up early (${attempts} attempts)`);
  assert.ok(Date.now() - startedAt < 3_000, "and did not sleep out the full backoff ladder");
});
