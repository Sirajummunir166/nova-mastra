/**
 * Lease-settlement suite (I2) — the `stale` signal survives the round trip.
 *
 * dakio-api answers a SUPERSEDED lease with HTTP 200 `{ok:true, stale:true}`
 * on both `/jobs/:id/complete` and `/jobs/:id/release` (novaJobs.js). That
 * boolean is the only way a caller ever learns the watchdog took its lease
 * back and re-leased the row — i.e. that the work it just did may now be
 * running twice. Both backends used to answer `Promise<void>`, so the signal
 * arrived on the wire and was thrown on the floor.
 *
 * The contract now: `completeJob`/`releaseJob` resolve to
 * `{ ok: true, stale: boolean }` (`JobSettleResult`). `stale: true` means
 * NOTHING was written — the row moved on without this caller.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NOVA_STORE_BACKEND = "demo";
process.env.NOVA_SERVICE_SECRET = "test-nova-service-secret";
delete process.env.NOVA_SERVICE_TOKEN;
delete process.env.NOVA_SERVICE_TOKENS;

import { DemoStore } from "./backend.js";
import { DakioStoreClient } from "./dakio.js";
import { createSeed } from "./seed.js";
import type { JobKind, JobSettleResult, NovaJob, StoreSeed } from "./types.js";

// --- demo backend ----------------------------------------------------------

/** The demo backend plus the one seam a lease test needs: its job table. */
interface DemoUnderTest {
  data: StoreSeed;
  claimDueJobs: (limit: number) => Promise<NovaJob[]>;
  completeJob: (id: string, leaseToken: string, sessionId?: string) => Promise<JobSettleResult>;
  releaseJob: (id: string, leaseToken: string, error: string) => Promise<JobSettleResult>;
}

function store(): DemoUnderTest {
  return new DemoStore(createSeed(Date.now())) as unknown as DemoUnderTest;
}

let seq = 0;
function enqueue(s: { data: StoreSeed }, kind: JobKind = "pulse"): string {
  const id = `job_${++seq}`;
  (s.data.jobs ??= []).push({
    id,
    kind,
    payload: {},
    dueAt: new Date(Date.now() - 1000).toISOString(),
    priority: 3,
    status: "due",
    attempts: 0,
    lastError: null,
    dedupeKey: `${kind}:${id}`,
    leaseUntil: null,
    department: null,
    leaseToken: null,
  });
  return id;
}

function row(s: { data: StoreSeed }, id: string): NovaJob {
  const found = (s.data.jobs ?? []).find((j) => j.id === id);
  assert.ok(found, `job ${id} exists`);
  return found;
}

/** Force the watchdog path: expire the current lease so the next claim re-leases the row. */
function expireLease(job: NovaJob): void {
  job.leaseUntil = new Date(Date.now() - 60_000).toISOString();
}

test("demo: a held lease completes for real — stale is false", async () => {
  const s = store();
  const id = enqueue(s);
  const [job] = await s.claimDueJobs(10);
  assert.equal(job!.id, id);

  const result = await s.completeJob(id, job!.leaseToken!);
  assert.deepEqual(result, { ok: true, stale: false });
  assert.equal(row(s, id).status, "done");
});

test("demo: a SUPERSEDED complete answers stale and mutates nothing", async () => {
  const s = store();
  const id = enqueue(s);
  const [first] = await s.claimDueJobs(10);
  const staleToken = first!.leaseToken!;

  // The watchdog reclaims it and a second dispatcher takes the row.
  expireLease(row(s, id));
  const [second] = await s.claimDueJobs(10);
  const liveToken = second!.leaseToken!;
  assert.notEqual(liveToken, staleToken, "a re-lease mints a fresh fencing token");

  const result = await s.completeJob(id, staleToken);
  assert.deepEqual(result, { ok: true, stale: true }, "the loser learns its work may be duplicated");
  assert.equal(row(s, id).status, "leased", "the newer lease still owns the row");
  assert.equal(row(s, id).leaseToken, liveToken, "the stale caller did not overwrite the token");

  // And the live holder still settles normally.
  assert.deepEqual(await s.completeJob(id, liveToken), { ok: true, stale: false });
  assert.equal(row(s, id).status, "done");
});

test("demo: a SUPERSEDED release answers stale and leaves the row alone", async () => {
  const s = store();
  const id = enqueue(s);
  const [first] = await s.claimDueJobs(10);
  const staleToken = first!.leaseToken!;

  expireLease(row(s, id));
  const [second] = await s.claimDueJobs(10);

  const result = await s.releaseJob(id, staleToken, "boom");
  assert.deepEqual(result, { ok: true, stale: true });
  assert.equal(row(s, id).status, "leased", "not requeued out from under the live holder");
  assert.equal(row(s, id).lastError, null, "a stale caller's error never lands on the row");
  assert.equal(row(s, id).leaseToken, second!.leaseToken);
});

test("demo: a real release requeues and reports stale:false", async () => {
  const s = store();
  const id = enqueue(s);
  const [job] = await s.claimDueJobs(10);

  const result = await s.releaseJob(id, job!.leaseToken!, "transient");
  assert.deepEqual(result, { ok: true, stale: false });
  assert.equal(row(s, id).status, "due");
  assert.equal(row(s, id).lastError, "transient");
});

test("demo: an unknown job id, a wrong token, and an already-done row all read stale", async () => {
  const s = store();
  const id = enqueue(s);
  const [job] = await s.claimDueJobs(10);
  const token = job!.leaseToken!;

  assert.deepEqual(await s.completeJob("job_does_not_exist", token), { ok: true, stale: true });
  assert.deepEqual(await s.completeJob(id, "not-the-token"), { ok: true, stale: true });
  assert.deepEqual(await s.releaseJob(id, "not-the-token", "x"), { ok: true, stale: true });

  await s.completeJob(id, token);
  assert.deepEqual(
    await s.completeJob(id, token),
    { ok: true, stale: true },
    "replaying a settle on a finished row is stale, not a second completion",
  );
});

// --- dakio client ----------------------------------------------------------

function stubbedClient(body: unknown): { client: DakioStoreClient; restore: () => void } {
  const saved = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  return {
    client: new DakioStoreClient("store-x", { baseUrl: "http://dakio.test", token: () => "t" }),
    restore: () => {
      globalThis.fetch = saved;
    },
  };
}

test("dakio: the server's stale:true is passed through, not swallowed", async () => {
  const { client, restore } = stubbedClient({ ok: true, stale: true });
  try {
    assert.deepEqual(await client.completeJob("j1", "tok"), { ok: true, stale: true });
    assert.deepEqual(await client.releaseJob("j1", "tok", "err"), { ok: true, stale: true });
  } finally {
    restore();
  }
});

test("dakio: a normal 200 with no stale flag reads as stale:false", async () => {
  const { client, restore } = stubbedClient({ ok: true });
  try {
    assert.deepEqual(await client.completeJob("j1", "tok"), { ok: true, stale: false });
    assert.deepEqual(await client.releaseJob("j1", "tok", "err"), { ok: true, stale: false });
  } finally {
    restore();
  }
});

test("dakio: release's terminal answer (`status: failed`) is still stale:false", async () => {
  const { client, restore } = stubbedClient({ ok: true, status: "failed" });
  try {
    assert.deepEqual(await client.releaseJob("j1", "tok", "err"), { ok: true, stale: false });
  } finally {
    restore();
  }
});
