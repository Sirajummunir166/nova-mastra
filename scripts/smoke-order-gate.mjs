#!/usr/bin/env node
/**
 * Order-gate drill (phase D unit 1) — proves the approval-gated LIVE order
 * path end-to-end against the LOCAL stack (postgres + dakio-api on :5001,
 * seeded demo store):
 *
 *   1. build a fully-specified confirmed-order state for a REAL seeded
 *      product (same context seams the hermetic turn test uses; the decide
 *      path is deterministic — no model needed for classify/gate)
 *   2. run `runCustomerTurn` in LIVE mode on the confirm message
 *   3. predict the tier from the store's ACTUAL autonomy config
 *      (`evaluateAuthority` over the exact payload) and assert it fired:
 *        - approval tier → a prepared NovaAction + queued NovaDecision exist
 *          in dakio-api, and NO Order row was created
 *        - auto tier     → the Order exists immediately
 *   4. redeliver the same novaActionId → no double-file
 *   5. mint a founder JWT (shared local JWT_SECRET) and approve the Decision
 *      via POST /api/nova/decisions/:id/approve → the REAL Order exists at
 *      server prices, stock decremented, action executed
 *   6. redeliver again after approval → still ONE order, no re-file
 *   7. a second approve of the same decision → 409
 *
 * Run:  node --import tsx scripts/smoke-order-gate.mjs
 * (The script re-executes itself under tsx when launched with plain node.)
 */

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import pg from "pg";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---- self-bootstrap under tsx (the src imports below are TypeScript) -------
if (!process.env.SMOKE_ORDER_GATE_TSX) {
  const probe = await import("../src/front-office/turn.js").catch(() => null);
  if (!probe) {
    const r = spawnSync(
      process.execPath,
      ["--import", "tsx", fileURLToPath(import.meta.url)],
      { stdio: "inherit", cwd: ROOT, env: { ...process.env, SMOKE_ORDER_GATE_TSX: "1" } },
    );
    process.exit(r.status ?? 1);
  }
}

// ---- env (BEFORE importing src modules — context-store reads NOVA_PG_URL at load)
function loadEnv() {
  try {
    for (const line of readFileSync(join(ROOT, ".env"), "utf8").split("\n")) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
    }
  } catch {
    /* rely on process env */
  }
}
loadEnv();
process.env.NOVA_STORE_BACKEND = "dakio";

const STORE_ID = process.env.NOVA_DEV_STORE_ID;
const DAKIO_URL = process.env.DAKIO_API_URL ?? "http://localhost:5001";
const JWT_SECRET = process.env.DAKIO_JWT_SECRET;
const DAKIO_DB_URL = process.env.DAKIO_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/dakio_db";

let passed = 0;
function fail(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}
function ok(msg) {
  passed += 1;
  console.log(`✓ ${msg}`);
}
function assert(cond, msg) {
  if (!cond) fail(msg);
}

if (!STORE_ID) fail("NOVA_DEV_STORE_ID missing (run dakio-api scripts/seed-local-demo.mjs / local-stack.sh first)");
if (!JWT_SECRET) fail("DAKIO_JWT_SECRET missing — needed to mint the founder JWT for the approve leg");

const { storeFor } = await import("../src/store/resolve.js");
const { evaluateAuthority } = await import("../src/store/authority.js");
const { performCreateOrder } = await import("../src/front-office/actions.js");
const { runCustomerTurn } = await import("../src/front-office/turn.js");
const { loadContext, primeContext, saveContext } = await import("../src/front-office/context-store.js");
const { focusProduct } = await import("../src/front-office/hydrate.js");
const { fact } = await import("../src/front-office/state.js");

const CONV = `nova-order-gate-smoke-${Date.now()}`;
const KEY = `nm:${CONV}:order-0`;
const PHONE = "01712345678";
const QTY = 2;

const db = new pg.Client({ connectionString: DAKIO_DB_URL });

function b64(s) {
  return Buffer.from(JSON.stringify(s)).toString("base64url");
}
function mintFounderJwt(userId) {
  // Same claims style as smoke-eve-compat.mjs: merchant-dialect
  // {userId, tenantId, role}, HS256 over the shared local JWT_SECRET.
  const header = b64({ alg: "HS256", typ: "JWT" });
  const payload = b64({ userId, tenantId: STORE_ID, role: "OWNER", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 });
  const sig = createHmac("sha256", JWT_SECRET).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${sig}`;
}

async function actionRows() {
  const { rows } = await db.query(
    `SELECT id, status, payload, outcome, "undoData", "dutyRef", department, title
       FROM "NovaAction"
      WHERE "tenantId" = $1 AND type = 'create_order_from_chat'
        AND payload->>'novaActionId' = $2
      ORDER BY "createdAt"`,
    [STORE_ID, KEY],
  );
  return rows;
}
async function orderRows() {
  const { rows } = await db.query(
    `SELECT id, "orderNumber", total, "shippingCharge", discount, "novaActionId", "sourceConversationId"
       FROM "Order" WHERE "sourceConversationId" = $1`,
    [CONV],
  );
  return rows;
}

try {
  // 0. stack up?
  const health = await fetch(`${DAKIO_URL}/api/health`).catch(() => null);
  assert(health?.ok, `dakio-api not reachable at ${DAKIO_URL} — start it (see scripts/local-stack.sh)`);
  await db.connect();

  // sweep prior runs + seed the conversation row (the order write resolves
  // sourceChannel from it; same seed as the shadow drill)
  await db.query(`DELETE FROM "InboxConversation" WHERE id LIKE 'nova-order-gate-smoke-%'`);
  await db.query(
    `INSERT INTO "InboxConversation" (id, "tenantId", platform, "senderId", "senderName", "novaSessionEpoch")
     VALUES ($1, $2, 'messenger', 'order-gate-psid', 'Order Gate Smoke', 0)`,
    [CONV, STORE_ID],
  );

  // 1. real seeded product + confirmable state through the same seams
  const client = storeFor(STORE_ID);
  const products = await client.listProducts({ status: "active" });
  const product = products.find((p) => p.stock >= QTY + 1 && !(p.variantNames?.length)) ?? products.find((p) => p.stock >= QTY + 1);
  assert(product, "no seeded active product with enough stock");
  const stockBefore = product.stock;
  console.log(`store ${STORE_ID} · product "${product.name}" (${product.id}) ৳${product.price}, stock ${stockBefore}\n`);

  await primeContext(STORE_ID, CONV, 0);
  const ctx = loadContext(STORE_ID, CONV, "chat", 0);
  focusProduct(ctx, product);
  ctx.products.tracked[product.id] = "wants_to_buy";
  ctx.purchase.qty = QTY;
  ctx.purchase.zone = "dhaka";
  ctx.purchase.confirmSent = true;
  ctx.customer.name = fact("Order Gate Smoke", "customer");
  ctx.customer.phone = fact(PHONE, "customer");
  ctx.customer.addr = fact("House 5, Road 2, Dhanmondi, Dhaka", "customer");
  saveContext(ctx);

  // 2. predict the tier from the store's ACTUAL autonomy config
  const payload = {
    novaActionId: KEY,
    conversationId: CONV,
    customerName: "Order Gate Smoke",
    customerPhone: PHONE,
    customerCity: "dhaka",
    customerDistrict: "Dhaka",
    customerAddress: "House 5, Road 2, Dhanmondi, Dhaka",
    items: [{ productId: product.id, productName: product.name, qty: QTY }],
    confirmedByCustomer: true,
  };
  const authority = await evaluateAuthority(client, {
    type: "create_order_from_chat",
    payload,
    dutyKey: "sales.inbox_orders",
    origin: "chat",
  });
  const expectGated = authority.verdict !== "execute";
  assert(authority.verdict !== "refuse", `store config REFUSES chat orders outright (${authority.rule}) — drill cannot proceed`);
  ok(`authority (store's actual config): verdict=${authority.verdict} rule=${authority.rule} → expecting ${expectGated ? "APPROVAL tier (prepared)" : "AUTO tier (executed)"}`);

  // 3. the LIVE confirm turn. Without AI_GATEWAY_API_KEY the WRITER throws in
  // live mode (today's contract, unchanged) — the gate has already fired by
  // then, which is exactly what this drill asserts on.
  let turnErr = null;
  let turnResult = null;
  try {
    turnResult = await runCustomerTurn(STORE_ID, CONV, "confirm koren", { mode: "live" });
  } catch (err) {
    turnErr = err;
  }
  if (turnResult) {
    ok(`live turn completed with a model: action=${turnResult.action}${turnResult.pendingActionId ? ` pendingActionId=${turnResult.pendingActionId}` : ""}${turnResult.order ? ` order=#${turnResult.order.orderNumber}` : ""} reply="${(turnResult.reply ?? "").slice(0, 80)}"`);
  } else {
    ok(`live turn threw at the writer as expected without a model key (${String(turnErr?.message ?? turnErr).slice(0, 90)}…) — gate already fired`);
  }

  let actionId;
  let decisionId;
  if (expectGated) {
    // 4a. prepared NovaAction + queued NovaDecision in dakio-api, NO Order
    const rows = await actionRows();
    assert(rows.length === 1, `expected exactly 1 prepared NovaAction for ${KEY}, found ${rows.length}`);
    assert(rows[0].status === "prepared", `NovaAction status ${rows[0].status}, expected prepared`);
    assert(rows[0].dutyRef === "sales.inbox_orders" && rows[0].department === "sales", "dutyRef/department contract");
    const p = rows[0].payload;
    assert(p.confirmedByCustomer === true, "payload.confirmedByCustomer must be literal true");
    assert(p.conversationId === CONV, "payload.conversationId joins the thread");
    for (const k of ["unitPrice", "total", "discount", "paid", "price"]) {
      assert(!(k in p) && !(p.items?.[0] && k in p.items[0]), `payload must not carry ${k}`);
    }
    actionId = rows[0].id;
    ok(`prepared NovaAction ${actionId} filed — title "${rows[0].title}", payload carries no price fields`);

    const { rows: decs } = await db.query(
      `SELECT id, status, kind, tag, title, "paramsLine", "surfacedIn" FROM "NovaDecision" WHERE "tenantId" = $1 AND "actionId" = $2`,
      [STORE_ID, actionId],
    );
    assert(decs.length === 1 && decs[0].status === "queued", "exactly one QUEUED NovaDecision for the prepared action");
    assert(decs[0].kind === "proposal" && decs[0].tag === "sales", "decision kind/tag contract");
    assert(JSON.stringify(decs[0].surfacedIn).includes("door:orders"), "decision surfaces under door:orders");
    assert(!decs[0].title.includes(PHONE) && !decs[0].paramsLine.includes(PHONE), "no phone on the card");
    decisionId = decs[0].id;
    ok(`queued NovaDecision ${decisionId} — "${decs[0].title}" · ${decs[0].paramsLine}`);

    assert((await orderRows()).length === 0, "NO Order row may exist on the approval tier");
    const fresh = await client.listProducts({ status: "active" });
    assert(fresh.find((x) => x.id === product.id).stock === stockBefore, "stock untouched on the approval tier");
    ok("no Order row created, stock untouched — the gate held");

    // 5. redeliver the same novaActionId → no double-file
    const replay = await performCreateOrder(STORE_ID, {
      payload,
      receipt: {
        reason: "Redelivery of the same confirmed order (drill).",
        expectedImpact: "No new filing expected.",
        confidence: 0.9,
        evidence: [{ source: "drill", note: "same novaActionId redelivered" }],
      },
    });
    assert(replay.status === "prepared" && replay.replayed === true && replay.actionId === actionId, "redelivery must replay the existing prepared action");
    assert((await actionRows()).length === 1, "still exactly one NovaAction after redelivery");
    const { rows: decs2 } = await db.query(`SELECT id FROM "NovaDecision" WHERE "tenantId" = $1 AND "actionId" = $2`, [STORE_ID, actionId]);
    assert(decs2.length === 1, "still exactly one NovaDecision after redelivery");
    ok("redelivered novaActionId → replayed, no double-file");

    // 6. founder approves → real Order at server prices, stock decremented
    const { rows: users } = await db.query(`SELECT id FROM "User" WHERE "tenantId" = $1 AND role = 'OWNER' LIMIT 1`, [STORE_ID]);
    assert(users.length === 1, "no OWNER user seeded for the tenant");
    const jwt = mintFounderJwt(users[0].id);
    const res = await fetch(`${DAKIO_URL}/api/nova/decisions/${decisionId}/approve`, {
      method: "POST",
      headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
      body: "{}",
    });
    const body = await res.json().catch(() => ({}));
    assert(res.status === 200, `approve expected 200, got ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
    assert(body.executed === true, `approve ran the executor (note: ${body.note})`);
    ok(`founder approved via /api/nova/decisions/:id/approve — ${body.note}`);

    const orders = await orderRows();
    assert(orders.length === 1, `exactly one Order for the conversation, found ${orders.length}`);
    const order = orders[0];
    assert(order.novaActionId === actionId, "Order.novaActionId is the approved action's id (server-side at-most-once key)");
    const goods = Number(order.total) - Number(order.shippingCharge) + Number(order.discount ?? 0);
    assert(goods === product.price * QTY, `server-priced goods ৳${goods} == catalogue ৳${product.price} × ${QTY}`);
    const after = await client.listProducts({ status: "active" });
    const stockAfter = after.find((x) => x.id === product.id).stock;
    assert(stockAfter === stockBefore - QTY, `stock decremented ${stockBefore} → ${stockAfter} (expected -${QTY})`);
    const { rows: acted } = await db.query(`SELECT status FROM "NovaAction" WHERE id = $1`, [actionId]);
    assert(acted[0].status === "executed", "NovaAction flipped to executed");
    ok(`real Order ${order.orderNumber} exists at server prices (total ৳${order.total}, delivery ৳${order.shippingCharge}); stock ${stockBefore}→${stockAfter}`);

    // 7. redeliver AFTER approval → answered from the ledger, still one order
    const replay2 = await performCreateOrder(STORE_ID, {
      payload,
      receipt: {
        reason: "Redelivery after approval (drill).",
        expectedImpact: "No second order expected.",
        confidence: 0.9,
        evidence: [{ source: "drill", note: "same novaActionId after approve" }],
      },
    });
    assert(replay2.status === "executed" && replay2.replayed === true, "post-approve redelivery answers executed from the ledger");
    assert((await orderRows()).length === 1, "STILL exactly one Order — no double-order");
    assert((await actionRows()).length === 1, "no re-file after execution");
    ok("redelivered after approval → one order, ever");

    // 8. second approve → 409
    const res2 = await fetch(`${DAKIO_URL}/api/nova/decisions/${decisionId}/approve`, {
      method: "POST",
      headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
      body: "{}",
    });
    assert(res2.status === 409, `second approve expected 409, got ${res2.status}`);
    ok("second approve of the same decision → 409 (already settled)");
  } else {
    // AUTO tier (config has inbox.orderAuto true + caps satisfied)
    const orders = await orderRows();
    assert(orders.length === 1, `auto tier: expected the Order immediately, found ${orders.length}`);
    assert(orders[0].novaActionId === KEY, "auto tier: Order.novaActionId is the turn's deterministic key");
    const after = await client.listProducts({ status: "active" });
    assert(after.find((x) => x.id === product.id).stock === stockBefore - QTY, "stock decremented");
    const rows = await actionRows();
    assert(rows.length === 1 && rows[0].status === "executed", "one executed NovaAction");
    ok(`auto tier fired: Order ${orders[0].orderNumber} at server prices, executed ledger row`);

    const replay = await performCreateOrder(STORE_ID, {
      payload,
      receipt: { reason: "Redelivery (drill).", expectedImpact: "No second order.", confidence: 0.9, evidence: [{ source: "drill", note: "replay" }] },
    });
    assert(replay.status === "executed" && replay.replayed === true, "redelivery replays");
    assert((await orderRows()).length === 1, "one order, ever");
    ok("auto tier redelivery → one order, ever");
  }

  console.log(`\nall ${passed} checks passed — the live order gate is approval-aware end-to-end`);
} finally {
  await db.end().catch(() => {});
}
process.exit(0);
