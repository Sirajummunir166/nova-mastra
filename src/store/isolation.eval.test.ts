/**
 * Tenant-isolation suite — re-expresses nova-ai `evals/isolation/run.ts` at
 * the StoreClient layer: two seeded tenants (store-aurora / store-beacon)
 * side by side in one process, and NO read or write ever returns or touches
 * the other tenant's data.
 *
 * The original drove eve tools with a synthetic verified auth context.
 * Tool-layer isolation in nova-mastra is structural instead — tools close
 * over exactly one storeId at build time (see `src/tools/store-reads.ts`),
 * so there is no per-call tenant argument to forge. What remains to prove
 * dynamically is the storage layer itself, which is what this file does
 * against the DEMO backend (deterministic, no network, no model):
 *
 *   1. Reads  — products / orders / customers / campaigns / memory from A
 *               never contain B's ids, SKUs, names or keys (and vice versa).
 *   2. Writes — a memory, prepared action, or campaign created through A's
 *               client is invisible through B's; reaching for B's record by
 *               id from A's client fails and leaves B untouched.
 *   3. Tokens — serviceTokenFor(A) !== serviceTokenFor(B), each payload
 *               carrying its own tenantId (the credential is scoped too).
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { storeFor, resetStores } from "./resolve.js";
import { serviceTokenFor } from "../lib/service-token.js";
import type { StoreClient } from "./client.js";

const AURORA = "store-aurora";
const BEACON = "store-beacon";

// All of these are read lazily (resolve.ts `backendMode()`, service-token.ts
// at mint time), never at import — so setting them in the module body, after
// ESM import hoisting, still lands before any client or token is built.
process.env.NOVA_STORE_BACKEND = "demo";
process.env.NOVA_SERVICE_SECRET = "isolation-suite-secret";
delete process.env.NOVA_SERVICE_TOKEN;
delete process.env.NOVA_SERVICE_TOKENS;

let a: StoreClient;
let b: StoreClient;

before(() => {
  resetStores();
  a = storeFor(AURORA);
  b = storeFor(BEACON);
});

function disjoint(xs: Iterable<string>, ys: Iterable<string>): boolean {
  const set = new Set(ys);
  return [...xs].every((x) => !set.has(x));
}

test("storeFor is stable per tenant and distinct across tenants", () => {
  assert.equal(storeFor(AURORA), a, "same tenant resolves the same backend");
  assert.equal(storeFor(BEACON), b);
  assert.notEqual(a, b, "two tenants never share a backend instance");
});

test("data isolation — products: ids and SKUs never cross", async () => {
  const aProducts = await a.listProducts();
  const bProducts = await b.listProducts();
  assert.ok(aProducts.length > 0 && bProducts.length > 0, "both tenants see products");
  assert.ok(
    disjoint(aProducts.map((p) => p.id), bProducts.map((p) => p.id)),
    "no product id appears in both tenants",
  );
  assert.ok(
    disjoint(aProducts.map((p) => p.sku), bProducts.map((p) => p.sku)),
    "no SKU appears in both tenants",
  );
  assert.ok(
    aProducts.every((p) => p.sku.startsWith("AUR-")),
    "A's products are all Aurora SKUs",
  );
  assert.ok(
    bProducts.every((p) => p.sku.startsWith("BCN-")),
    "B's products are all Beacon SKUs",
  );
  assert.ok(
    disjoint(aProducts.map((p) => p.name), bProducts.map((p) => p.name)),
    "no product name appears in both tenants",
  );
});

test("data isolation — orders: id spaces never cross", async () => {
  const aOrders = await a.listOrders();
  const bOrders = await b.listOrders();
  assert.ok(aOrders.length > 0 && bOrders.length > 0, "both tenants see orders");
  assert.ok(
    disjoint(aOrders.map((o) => o.id), bOrders.map((o) => o.id)),
    "no order id appears in both tenants",
  );
  assert.ok(
    disjoint(aOrders.map((o) => o.customerId), bOrders.map((o) => o.customerId)),
    "no order references the other tenant's customer",
  );
});

test("data isolation — customers: ids and names never cross", async () => {
  const aCustomers = await a.listCustomers();
  const bCustomers = await b.listCustomers();
  assert.ok(aCustomers.length > 0 && bCustomers.length > 0, "both tenants see customers");
  assert.ok(
    disjoint(aCustomers.map((c) => c.id), bCustomers.map((c) => c.id)),
    "no customer id appears in both tenants",
  );
  assert.ok(
    disjoint(aCustomers.map((c) => c.name), bCustomers.map((c) => c.name)),
    "no customer name appears in both tenants",
  );
});

test("data isolation — campaigns: id spaces never cross", async () => {
  const aCampaigns = await a.listCampaigns();
  const bCampaigns = await b.listCampaigns();
  assert.ok(aCampaigns.length > 0 && bCampaigns.length > 0, "both tenants see campaigns");
  assert.ok(
    disjoint(aCampaigns.map((c) => c.id), bCampaigns.map((c) => c.id)),
    "no campaign id appears in both tenants",
  );
});

test("data isolation — seeded memory/profile: each tenant only knows its own", async () => {
  const aMemory = await a.listMemory();
  const bMemory = await b.listMemory();
  const aKeys = aMemory.map((m) => m.key);
  const bKeys = bMemory.map((m) => m.key);
  // Seeded tenant-specific facts (see seed.ts / seed-beacon.ts).
  assert.ok(aKeys.includes("amelia-chen"), "A knows its own customer memory");
  assert.ok(!bKeys.includes("amelia-chen"), "B cannot see A's customer memory");
  assert.ok(bKeys.includes("summit-facilities"), "B knows its own customer memory");
  assert.ok(!aKeys.includes("summit-facilities"), "A cannot see B's customer memory");
  // The shared key "voice" (brand namespace) exists in both seeds but must
  // carry each tenant's OWN value — same key, never the same profile.
  const aVoice = aMemory.find((m) => m.namespace === "brand" && m.key === "voice");
  const bVoice = bMemory.find((m) => m.namespace === "brand" && m.key === "voice");
  assert.ok(aVoice && bVoice, "both tenants have a brand voice");
  assert.notEqual(aVoice?.value, bVoice?.value, "brand profiles are genuinely distinct");
});

test("write isolation — a memory written via A is invisible via B (and vice versa)", async () => {
  await a.upsertMemory({
    namespace: "insights",
    key: "iso-secret-a",
    value: "Aurora-only secret insight.",
  });
  await b.upsertMemory({
    namespace: "insights",
    key: "iso-secret-b",
    value: "Beacon-only secret insight.",
  });
  const aKeys = (await a.listMemory()).map((m) => m.key);
  const bKeys = (await b.listMemory()).map((m) => m.key);
  assert.ok(aKeys.includes("iso-secret-a"), "A can recall its own new memory");
  assert.ok(!bKeys.includes("iso-secret-a"), "B cannot see A's new memory");
  assert.ok(bKeys.includes("iso-secret-b"), "B can recall its own new memory");
  assert.ok(!aKeys.includes("iso-secret-b"), "A cannot see B's new memory");
});

test("write isolation — an action prepared via A never appears in B's queue", async () => {
  const receipt = {
    reason: "Isolation test: create a prepared action under Aurora only.",
    expectedImpact: "None — test artifact.",
    confidence: 0.5,
    evidence: [{ source: "eval-fixture", note: "isolation-suite probe" }],
    before: null,
    after: null,
  };
  const created = await a.addAction({
    type: "create_campaign",
    department: "marketing",
    title: "Isolation Probe Campaign",
    payload: { name: "Isolation Probe Campaign", channel: "meta", dailyBudget: 3000 },
    justification: {
      reason: receipt.reason,
      expectedImpact: receipt.expectedImpact,
      confidence: receipt.confidence,
    },
    receipt,
    riskClass: "low",
    status: "prepared",
    outcome: null,
    undoable: false,
    undoData: null,
    actor: "nova",
    targetRef: null,
    agentId: null,
    dutyRef: null,
    undoDeadline: null,
    undoneAt: null,
    decidedAt: null,
    executedAt: null,
  });
  assert.ok(created.id.length > 0, "A's write produced an action");
  const aActionIds = (await a.listActions()).map((x) => x.id);
  const bActionIds = (await b.listActions()).map((x) => x.id);
  assert.ok(aActionIds.includes(created.id), "the new action is in A's queue");
  assert.ok(!bActionIds.includes(created.id), "the new action is NOT in B's queue");
  assert.ok(disjoint(aActionIds, bActionIds), "A and B action queues share no ids");
});

test("write isolation — a campaign created via A is invisible via B; reaching for B's by id from A fails and leaves B untouched", async () => {
  const aProducts = await a.listProducts();
  const created = await a.createCampaign({
    name: "Isolation Probe Campaign",
    channel: "meta",
    status: "active",
    dailyBudget: 3000,
    productIds: [aProducts[0].id],
    startedAt: a.now(),
    notes: "isolation-suite probe",
  });
  assert.equal(await a.getCampaign(created.id).then((c) => c?.id), created.id);
  assert.equal(await b.getCampaign(created.id), null, "B cannot read A's new campaign");
  assert.ok(
    !(await b.listCampaigns()).some((c) => c.id === created.id),
    "A's new campaign never appears in B's list",
  );

  // Cross-tenant reach by id: "bcmp-search" is B's seeded active campaign.
  // A's client must fail to find it, and B's copy must be untouched after.
  const before = await b.getCampaign("bcmp-search");
  assert.equal(before?.status, "active", "precondition: B's campaign is active");
  await assert.rejects(
    a.updateCampaign("bcmp-search", { status: "paused" }),
    "A updating B's campaign id fails (id not in A's store)",
  );
  const after = await b.getCampaign("bcmp-search");
  assert.equal(after?.status, "active", "B's campaign is unchanged after the attempt");
});

test("credential isolation — service tokens are per-tenant, payload carries its own tenantId", () => {
  const ta = serviceTokenFor(AURORA);
  const tb = serviceTokenFor(BEACON);
  assert.notEqual(ta, tb, "distinct tenants get distinct service tokens");
  const payloadOf = (token: string): Record<string, unknown> =>
    JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()) as Record<string, unknown>;
  const pa = payloadOf(ta);
  const pb = payloadOf(tb);
  assert.equal(pa.tenantId, AURORA, "A's token is scoped to A");
  assert.equal(pb.tenantId, BEACON, "B's token is scoped to B");
  assert.equal(pa.type, "service");
  assert.equal(pa.sub, "nova");
  assert.equal(pb.type, "service");
  assert.equal(pb.sub, "nova");
});
