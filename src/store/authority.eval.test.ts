/**
 * The authority seam's two silent halves — the verb↔duty binding, and the
 * guardrail arms that were never reached.
 *
 * Everything here was found by reading the code against what it claimed, and
 * every case below was RUN against the demo backend before it was fixed:
 *
 *  · C-1  the duty key a caller presents was unchecked, and it is what selects
 *         the door, the minLevel and the founder's pause switch. Measured: a
 *         `create_purchase_order` filed under `inventory.low_stock_alerts` came
 *         back `suggest` at level 1, where the honest `inventory.reorder_drafts`
 *         was refused `duty:min_level`.
 *  · C-4  `send_customer_message` had NO arm in the guardrail switch, so it fell
 *         to `default: allow` — risk class low, no spend — and would have been
 *         SENT, unreviewed, at L3/L4 from a background job.
 *  · C-5  four canonical money caps were read off the PLATFORM bag, which on a
 *         live tenant carries only `inbox.*` keys. `total > undefined` is false,
 *         so the ৳300,000 auto-PO cap, the ±15% price-change cap, the 25%
 *         margin floor and the ±50% budget cap could not fire at all.
 *
 * Demo backend, no network, no model.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { storeFor, resetStores } from "./resolve.js";
import { evaluateAuthority } from "./authority.js";
import {
  DEFAULT_GUARDRAILS,
  checkGuardrailsForAuthority,
} from "./autonomy.js";
import {
  DUTIES,
  DUTY_BY_KEY,
  UNGOVERNED_VERBS,
  VERB_DUTIES,
  assertVerbDutiesExist,
  dutyGovernsVerb,
  governingDuties,
} from "./duties.js";
import type { ActionType, Guardrails } from "./types.js";

process.env.NOVA_STORE_BACKEND = "demo";
delete process.env.NOVA_PG_URL;

const A = "store-aurora";

beforeEach(() => {
  process.env.NOVA_STORE_BACKEND = "demo";
});
afterEach(() => resetStores());

/**
 * The platform bag as a LIVE tenant sends it: the flat `inbox.*` namespace and
 * nothing else. The type says otherwise, which is the whole trap.
 */
const INBOX_ONLY_BAG = { "inbox.orderAuto": false } as unknown as Guardrails;

// ---------------------------------------------------------------------------
// C-1 — the verb↔duty binding
// ---------------------------------------------------------------------------

test("every duty in the verb↔duty binding is on the founder's roster", () => {
  // The same posture as registry.ts's lane check: an off-roster key would make
  // `evaluateAuthority` refuse 100% of that verb's work with `duty:unknown`, so
  // it must fail at import rather than at 02:00.
  assert.doesNotThrow(() => assertVerbDutiesExist(VERB_DUTIES));
  assert.throws(
    () => assertVerbDutiesExist({ create_purchase_order: ["inventory.no_such_duty"] }),
    /not on Nova's roster/,
  );
});

test("the binding is total over ActionType — a new verb cannot ship unbound", () => {
  // `VERB_DUTIES` is a `Record<ActionType, …>`, so tsc already forces the row;
  // this pins the OTHER half: a row that is empty must be a written capability
  // gap, not an oversight.
  for (const [verb, keys] of Object.entries(VERB_DUTIES)) {
    if (keys.length > 0) continue;
    assert.ok(
      UNGOVERNED_VERBS[verb],
      `${verb} is governed by no duty and carries no reason. An empty row is a claim that the founder's ` +
        `roster has nothing for this verb — it has to say so, and why.`,
    );
    assert.ok(UNGOVERNED_VERBS[verb]!.length > 60, `${verb}'s reason must be a reason, not a TODO`);
  }
});

test("the three ungoverned verbs are the ones the code's own gap lists already named", () => {
  assert.deepEqual(
    Object.keys(UNGOVERNED_VERBS).sort(),
    ["merge_customer_records", "resolve_ticket", "update_price"],
    "each is documented elsewhere in the codebase: the merge card doc 07 names as shipping with no duty, " +
      "the 'HONESTY CASE' ticket desk that belongs to Dakio and not the merchant, and the reprice whose " +
      "nearest duty registry.ts calls 'not close enough'",
  );
  for (const verb of Object.keys(UNGOVERNED_VERBS)) {
    assert.deepEqual(governingDuties(verb), [], `${verb} must have no governing duty`);
  }
});

test("the binding never invents a duty that would be judged more leniently than the honest one", async () => {
  const client = storeFor(A);
  // THE MEASUREMENT THAT STARTED THIS. Both keys are on the roster, both are
  // enabled, and only one of them governs a purchase order.
  await client.setAutonomy({ level: 1, guardrails: DEFAULT_GUARDRAILS, updatedAt: client.now() });
  const payload = { supplierId: "sup-artisan", productId: "prod-candle-amber", quantity: 2, unitCost: 100 };

  const honest = await evaluateAuthority(client, {
    type: "create_purchase_order",
    payload,
    dutyKey: "inventory.reorder_drafts",
    origin: "job",
  });
  const watching = await evaluateAuthority(client, {
    type: "create_purchase_order",
    payload,
    dutyKey: "inventory.low_stock_alerts",
    origin: "job",
  });

  assert.equal(honest.verdict, "refuse");
  assert.equal(honest.rule, "duty:min_level", "the real duty needs level 2; the store is at 1");
  assert.equal(watching.verdict, "suggest", "the watching duty's minLevel 0 waves it through — this is the hole");
  assert.equal(
    dutyGovernsVerb("create_purchase_order", "inventory.low_stock_alerts"),
    false,
    "so the binding refuses the pair before the seam is ever asked to judge it",
  );
  assert.equal(dutyGovernsVerb("create_purchase_order", "inventory.reorder_drafts"), true);
});

test("a duty that governs a verb always sits at or above the door that verb writes to", () => {
  // Not a rule the code enforces — a sanity read on the table. A duty whose
  // door is a WATCHING surface cannot govern a verb that writes money.
  const moneyVerbs: ActionType[] = ["create_purchase_order", "create_discount", "create_campaign"];
  for (const verb of moneyVerbs) {
    for (const key of governingDuties(verb)) {
      const duty = DUTY_BY_KEY.get(key)!;
      assert.ok(duty.minLevel >= 2, `${verb} → ${key} sits at minLevel ${duty.minLevel}; a write is never a level-0 act`);
    }
  }
  // And every governing key is a real roster row (belt and braces over the
  // boot assertion, from the data side).
  const roster = new Set(DUTIES.map((d) => d.key));
  for (const keys of Object.values(VERB_DUTIES)) for (const k of keys) assert.ok(roster.has(k));
});

// ---------------------------------------------------------------------------
// C-4 — a message to a real customer, from a job
// ---------------------------------------------------------------------------

test("send_customer_message never auto-sends — not even at Acting CEO", async () => {
  const client = storeFor(A);
  await client.setAutonomy({ level: 4, guardrails: DEFAULT_GUARDRAILS, updatedAt: client.now() });

  const decision = await evaluateAuthority(client, {
    type: "send_customer_message",
    payload: { customerId: "cust-1", channel: "sms", purpose: "cart_recovery", body: "your cart is waiting" },
    dutyKey: "sales.abandoned_checkout_emails",
    origin: "job",
  });

  assert.equal(decision.verdict, "draft", "a customer-visible message from a job is prepared, never sent unreviewed");
  assert.equal(decision.rule, "guardrail:customer_message_not_auto");
  assert.notEqual(decision.rule, "level:acting_ceo", "the dial alone must not be what decides this");
});

test("send_customer_message drafts when it cannot tell who the message is for", async () => {
  const client = storeFor(A);
  const bag = { "outbound.customerMessageAuto": true } as unknown as Guardrails;

  const withRecipient = await checkGuardrailsForAuthority(client, bag, "send_customer_message", {
    customerId: "cust-1",
    body: "hello",
  });
  assert.deepEqual(withRecipient, { result: "allow" }, "the switch is the founder's to turn on");

  const blind = await checkGuardrailsForAuthority(client, bag, "send_customer_message", { body: "hello" });
  assert.equal(blind.result, "needs_approval");
  assert.equal(blind.result === "needs_approval" && blind.rule, "guardrail:customer_message_no_recipient");
});

test("a verb with no guardrail arm DRAFTS — the default no longer allows", async () => {
  const client = storeFor(A);
  // `switch_supplier`: high risk, no arm, and at level 4 it used to execute.
  const check = await checkGuardrailsForAuthority(client, DEFAULT_GUARDRAILS, "switch_supplier", {
    productId: "p",
    newSupplierId: "s",
  });
  assert.equal(check.result, "needs_approval");
  assert.equal(check.result === "needs_approval" && check.rule, "guardrail:no_arm");

  // The exceptions are a WRITTEN list, and these three are shipped product
  // decisions that a blanket flip would have reversed silently.
  for (const verb of ["schedule_follow_up", "open_case", "confirm_order_intent"] as const) {
    const allowed = await checkGuardrailsForAuthority(client, DEFAULT_GUARDRAILS, verb, {});
    assert.deepEqual(allowed, { result: "allow" }, `${verb} is on the written exception list, with a reason`);
  }
});

// ---------------------------------------------------------------------------
// C-5 — the money caps that could not fire
// ---------------------------------------------------------------------------

test("the auto-PO cap fails closed when the platform bag does not carry it", async () => {
  const client = storeFor(A);

  // With the cap present it does its job, both ways.
  const under = await checkGuardrailsForAuthority(client, DEFAULT_GUARDRAILS, "create_purchase_order", {
    quantity: 10,
    unitCost: 100,
  });
  assert.deepEqual(under, { result: "allow" }, "৳1,000 is well inside the ৳300,000 cap");
  const over = await checkGuardrailsForAuthority(client, DEFAULT_GUARDRAILS, "create_purchase_order", {
    quantity: 100,
    unitCost: 9_999,
  });
  assert.equal(over.result, "needs_approval");
  assert.equal(over.result === "needs_approval" && over.rule, "max_auto_purchase_order_total");

  // And with the bag a live tenant actually sends, it does not silently allow.
  const live = await checkGuardrailsForAuthority(client, INBOX_ONLY_BAG, "create_purchase_order", {
    quantity: 100,
    unitCost: 9_999,
  });
  assert.notDeepEqual(live, { result: "allow" }, "৳999,900 must never come back `allow` for want of a number");
  assert.equal(live.result === "needs_approval" && live.rule, "no_auto_purchase_order_cap");
});

test("the price-change cap and the margin FLOOR fail closed the same way", async () => {
  const client = storeFor(A);
  const product = await client.getProduct("prod-candle-amber");
  assert.ok(product, "precondition: the seeded product reads");

  // The floor is a BLOCK, and it exists nowhere else — no canonical mirror.
  const priced = await checkGuardrailsForAuthority(client, DEFAULT_GUARDRAILS, "update_price", {
    productId: product!.id,
    newPrice: Math.round(product!.cost * 1.01),
  });
  assert.notDeepEqual(priced, { result: "allow" }, "a taka above cost is not inside a 25% margin floor");

  const live = await checkGuardrailsForAuthority(client, INBOX_ONLY_BAG, "update_price", {
    productId: product!.id,
    newPrice: 1,
  });
  assert.equal(live.result, "needs_approval");
  assert.equal(live.result === "needs_approval" && live.rule, "no_price_change_cap");
});

test("the budget-change cap fails closed; create_discount deliberately does not", async () => {
  const client = storeFor(A);

  const budget = await checkGuardrailsForAuthority(client, INBOX_ONLY_BAG, "update_campaign", {
    campaignId: "cmp-1",
    dailyBudget: 5000,
  });
  assert.equal(budget.result, "needs_approval");
  assert.equal(budget.result === "needs_approval" && budget.rule, "no_budget_change_cap");

  // `create_discount` is the ONE arm that may allow on a missing cap, because
  // the canonical trio in authority.ts has already checked the same number
  // against the same payload. Pinned so the exception stays deliberate.
  const discount = await checkGuardrailsForAuthority(client, INBOX_ONLY_BAG, "create_discount", { percentOff: 90 });
  assert.deepEqual(discount, { result: "allow" }, "the platform copy is a duplicate of an enforced check");
  // Level 4, because `inventory.dead_stock_clearance` needs level 3 and a
  // `duty:min_level` refusal would prove nothing about the ceiling.
  await client.setAutonomy({ level: 4, guardrails: DEFAULT_GUARDRAILS, updatedAt: client.now() });
  const enforced = await evaluateAuthority(client, {
    type: "create_discount",
    payload: { percentOff: 90 },
    dutyKey: "inventory.dead_stock_clearance",
    origin: "job",
  });
  assert.equal(enforced.verdict, "refuse", "and the enforced one really does refuse");
  assert.equal(enforced.rule, "guardrail:max_discount_pct");
});
