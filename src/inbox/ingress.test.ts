/**
 * Wire-contract suite for the shadow ingress (no Postgres, no network beyond
 * loopback, no model): the router is built with an injected `runShadow` stub,
 * so every arm of the dakio-api delivery contract is assertable hermetically —
 * HMAC + timestamp binding, freshness, replay, body validation, tenant
 * refusal, busy continuation, and the 202 dispatch itself.
 */

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import express from "express";
import {
  createInboxRouter,
  inboxSessionKey,
  modelTokenSegment,
  replaySeen,
  resetReplayGuard,
  signatureMatches,
  timestampFresh,
  TIMESTAMP_SKEW_MS,
  type InboxDelivery,
} from "./ingress.js";

const SECRET = "test-inbox-secret";

// Demo backend: the tenant registry answers from its seeded rows with zero
// network, and "store-aurora" is active.
process.env.NOVA_STORE_BACKEND = "demo";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function sign(timestamp: string, rawBody: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

test("signatureMatches: accepts the Stripe-style MAC and rejects drift", () => {
  const ts = new Date().toISOString();
  const body = JSON.stringify({ a: 1 });
  const sig = sign(ts, body);
  assert.equal(signatureMatches(ts, body, sig, SECRET), true);
  assert.equal(signatureMatches(ts, body + " ", sig, SECRET), false, "body drift");
  assert.equal(signatureMatches(new Date(Date.now() + 1).toISOString(), body, sig, SECRET), false, "timestamp drift");
  assert.equal(signatureMatches(ts, body, sig, "other-secret"), false, "wrong secret");
  assert.equal(signatureMatches(ts, body, null, SECRET), false, "missing signature");
  assert.equal(signatureMatches(null, body, sig, SECRET), false, "missing timestamp");
  assert.equal(signatureMatches(ts, body, "zz-not-hex", SECRET), false, "malformed hex");
});

test("timestampFresh: ±5 minute window", () => {
  const now = Date.now();
  assert.equal(timestampFresh(new Date(now).toISOString(), now), true);
  assert.equal(timestampFresh(new Date(now - TIMESTAMP_SKEW_MS).toISOString(), now), true);
  assert.equal(timestampFresh(new Date(now - TIMESTAMP_SKEW_MS - 1000).toISOString(), now), false);
  assert.equal(timestampFresh(new Date(now + TIMESTAMP_SKEW_MS + 1000).toISOString(), now), false, "future skew");
  assert.equal(timestampFresh("not-a-date", now), false);
  assert.equal(timestampFresh(null, now), false);
});

test("inboxSessionKey: epoch 0 renders nothing (nova-ai token discipline)", () => {
  assert.equal(inboxSessionKey("c1"), "inbox:c1");
  assert.equal(inboxSessionKey("c1", "default"), "inbox:c1:default");
  assert.equal(inboxSessionKey("c1", "default", 0), "inbox:c1:default");
  assert.equal(inboxSessionKey("c1", "default", 3), "inbox:c1:default:e3");
  assert.equal(inboxSessionKey("c1", "default", -2), "inbox:c1:default", "negative → 0");
  assert.equal(modelTokenSegment(undefined), "default");
  assert.equal(modelTokenSegment("zai/glm-4.6v-flash"), "zai-glm-4.6v-flash");
});

test("replaySeen: first sight registers, second is a replay, expiry prunes", () => {
  resetReplayGuard();
  const now = Date.now();
  assert.equal(replaySeen("sig-a", now), false);
  assert.equal(replaySeen("sig-a", now + 1000), true);
  // Past the retention window the entry is pruned — but by then the
  // timestamp-freshness check rejects the replay anyway.
  assert.equal(replaySeen("sig-a", now + TIMESTAMP_SKEW_MS * 2 + 1000), false);
  resetReplayGuard();
});

// ---------------------------------------------------------------------------
// The route, end to end over loopback
// ---------------------------------------------------------------------------

interface Dispatched {
  delivery: InboxDelivery;
  release: () => void;
}

const dispatched: Dispatched[] = [];
let holdDispatch = false;

async function stubRunShadow(delivery: InboxDelivery): Promise<void> {
  if (!holdDispatch) {
    dispatched.push({ delivery, release: () => {} });
    return;
  }
  await new Promise<void>((resolve) => {
    dispatched.push({ delivery, release: resolve });
  });
}

let server: ReturnType<express.Express["listen"]>;
let baseUrl = "";

before(async () => {
  const app = express();
  app.use(createInboxRouter({ runShadow: stubRunShadow }));
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server?.close();
});

beforeEach(() => {
  process.env.NOVA_INBOX_SHARED_SECRET = SECRET;
  resetReplayGuard();
  dispatched.length = 0;
  holdDispatch = false;
});

function validBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    storeId: "store-aurora",
    conversationId: "conv-1",
    platform: "messenger",
    messageIds: ["m1"],
    ...overrides,
  });
}

async function post(rawBody: string, opts: { timestamp?: string; signature?: string } = {}): Promise<Response> {
  const timestamp = opts.timestamp ?? new Date().toISOString();
  const signature = opts.signature ?? sign(timestamp, rawBody);
  return fetch(`${baseUrl}/customer/message`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-nova-signature": signature,
      "x-nova-timestamp": timestamp,
    },
    body: rawBody,
  });
}

async function settle(): Promise<void> {
  // let the fire-and-forget dispatch chain run
  await new Promise((r) => setTimeout(r, 20));
}

test("unset shared secret → 503 fail-closed (never an open door)", async () => {
  delete process.env.NOVA_INBOX_SHARED_SECRET;
  const res = await post(validBody());
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "nova_inbox_unconfigured" });
});

test("valid delivery → 202 and exactly one shadow dispatch", async () => {
  const res = await post(validBody());
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { status: "accepted", sessionId: null });
  await settle();
  assert.equal(dispatched.length, 1);
  assert.deepEqual(dispatched[0]!.delivery, {
    storeId: "store-aurora",
    conversationId: "conv-1",
    platform: "messenger",
    messageIds: ["m1"],
  });
});

test("bad signature → 401, nothing dispatched", async () => {
  const res = await post(validBody(), { signature: "0".repeat(64) });
  assert.equal(res.status, 401);
  await settle();
  assert.equal(dispatched.length, 0);
});

test("stale timestamp (>5 min), correctly signed → 401", async () => {
  const stale = new Date(Date.now() - TIMESTAMP_SKEW_MS - 60_000).toISOString();
  const res = await post(validBody(), { timestamp: stale });
  assert.equal(res.status, 401);
  await settle();
  assert.equal(dispatched.length, 0);
});

test("replayed (timestamp, body) pair → 409 duplicate, single dispatch", async () => {
  const timestamp = new Date().toISOString();
  const body = validBody();
  const first = await post(body, { timestamp });
  assert.equal(first.status, 202);
  const replay = await post(body, { timestamp });
  assert.equal(replay.status, 409);
  assert.deepEqual(await replay.json(), { status: "duplicate" });
  await settle();
  assert.equal(dispatched.length, 1);
});

test("malformed body → 400 (valid signature over garbage is deploy drift, said loudly)", async () => {
  const res = await post("{not json");
  assert.equal(res.status, 400);
  const missingIds = await post(validBody({ messageIds: [] }));
  assert.equal(missingIds.status, 400);
  const badPlatform = await post(validBody({ platform: "whatsapp" }));
  assert.equal(badPlatform.status, 400);
  await settle();
  assert.equal(dispatched.length, 0);
});

test("unknown/paused tenant → 409 refused, events stay unprocessed", async () => {
  const res = await post(validBody({ storeId: "store-that-does-not-exist" }));
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { status: "refused", reason: "tenant_inactive" });
  await settle();
  assert.equal(dispatched.length, 0);
});

test("busy continuation → 409 while a dispatch is in flight, free afterwards", async () => {
  holdDispatch = true;
  const first = await post(validBody({ messageIds: ["m1"] }));
  assert.equal(first.status, 202);
  await settle();
  assert.equal(dispatched.length, 1);

  const second = await post(validBody({ messageIds: ["m2"] }));
  assert.equal(second.status, 409);
  assert.deepEqual(await second.json(), { status: "busy" });

  dispatched[0]!.release();
  await settle();

  holdDispatch = false;
  const third = await post(validBody({ messageIds: ["m3"] }));
  assert.equal(third.status, 202);
  await settle();
  assert.equal(dispatched.length, 2);
});
