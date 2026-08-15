/**
 * The `duties` eval suite — the roster is a promise, so it is checked like one.
 *
 * ── WHAT THE ROSTER IS ─────────────────────────────────────────────────────
 *
 * 72 rows, each one a sentence a founder can read: *"Nova drafts my reorders"*,
 * *"Nova replies to my customers"*. The founder sets an autonomy level and
 * pauses individual duties; the roster is the contract that says what those
 * switches control. Every row therefore has to be true, reachable, and
 * spelled the same way tomorrow as today.
 *
 * ── THE FOUR PROPERTIES WORTH BREAKING A BUILD OVER ────────────────────────
 *
 *  1. **Identity is permanent.** A duty key is written into stored actions,
 *     ledger rows and the founder's pause switches. Renaming one does not
 *     rename the history — it orphans it, and a paused duty silently
 *     un-pauses. Section 2.
 *  2. **Every duty has a door.** A duty whose screen does not exist is a
 *     promise with nowhere to land. The roster is allowed to contain them, but
 *     only when it SAYS SO (`NEEDS_DOOR`) rather than reading as ACTIVE.
 *     Section 3.
 *  3. **A verb may only be performed under a duty that governs it.** This is
 *     the laundering fix, and it is the sharpest rule here: `evaluateAuthority`
 *     reads the duty key to pick the door, the minimum level, and the founder's
 *     pause switch. Left unchecked, a purchase order filed under "Low-stock
 *     alerts" is judged at minLevel 0, under the wrong door, and is
 *     **unstoppable by a founder who explicitly paused reorder drafts**.
 *     Section 5.
 *  4. **Status is computed and honest** — including the deliberate ordering
 *     that reports a missing door BEFORE a level lock, because "we have not
 *     built the screen" is the true answer and "raise your autonomy" is not.
 *     Section 6.
 *
 * ── ON THE HARD-CODED COUNTS ───────────────────────────────────────────────
 *
 * The totals below are pinned on purpose. The roster should only ever grow
 * because someone decided to add a duty, and that decision should cost one
 * line in this file. A roster that can drift silently is one where "Nova does
 * 72 things for you" quietly becomes 71.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DUTIES,
  DOORS,
  DUTY_BY_KEY,
  NEEDS_DOOR_DUTIES,
  VERB_DUTIES,
  UNGOVERNED_VERBS,
  dutyStatus,
  dutyRollup,
  governingDuties,
  dutyGovernsVerb,
  assertVerbDutiesExist,
} from "./duties.js";
import { NOVA_DEPARTMENTS } from "./types.js";

/**
 * 65 mined from the merchant prototype, plus 7 Front Office additions
 * (2 inbox + 3 selling + 2 delivery). Every increment is a decision.
 */
const MINED_TOTAL = 65;
const FRONT_OFFICE_DUTIES = 7;
const EXPECTED_TOTAL = MINED_TOTAL + FRONT_OFFICE_DUTIES;

const EXPECTED_COUNTS: Record<string, number> = {
  ceo: 6,
  marketing: 10,
  sales: 11,
  support: 8,
  product_research: 7,
  inventory: 5,
  shipping: 7,
  finance: 7,
  operations: 5,
  growth: 6,
};

// ── 1. Shape ──────────────────────────────────────────────────────────────

test(`the roster is exactly ${EXPECTED_TOTAL} duties, and the departments add up`, () => {
  assert.equal(DUTIES.length, EXPECTED_TOTAL, "roster size changed — was that on purpose?");
  const actual = Object.fromEntries(
    Object.keys(EXPECTED_COUNTS).map((d) => [d, DUTIES.filter((x) => x.department === d).length]),
  );
  assert.deepEqual(actual, EXPECTED_COUNTS);
  assert.equal(
    Object.values(EXPECTED_COUNTS).reduce((a, b) => a + b, 0),
    EXPECTED_TOTAL,
    "the per-department fixture must itself sum to the total",
  );
});

test("every department is real, and every department has work", () => {
  for (const duty of DUTIES) {
    assert.ok(
      (NOVA_DEPARTMENTS as readonly string[]).includes(duty.department),
      `${duty.key} names a department that does not exist`,
    );
  }
  for (const department of NOVA_DEPARTMENTS) {
    assert.ok(
      DUTIES.some((d) => d.department === department),
      `${department} has no duties — an empty room in the founder's Nova`,
    );
  }
});

// ── 2. Identity is permanent ──────────────────────────────────────────────

test("duty keys are unique, well-formed, and agree with their department", () => {
  const keys = DUTIES.map((d) => d.key);
  assert.equal(new Set(keys).size, keys.length, "duplicate duty key — two rows sharing one pause switch");
  for (const duty of DUTIES) {
    assert.match(duty.key, /^[a-z_]+\.[a-z0-9_]+$/, `${duty.key} is not <department>.<snake_case>`);
    assert.ok(
      duty.key.startsWith(`${duty.department}.`),
      `${duty.key} claims department ${duty.department} — a lookup by prefix would miss it`,
    );
  }
  assert.equal(DUTY_BY_KEY.size, DUTIES.length, "the lookup map lost a row");
});

test("every duty is named in both languages, and the Bangla is really Bangla", () => {
  // The roster is what a Bangladeshi founder reads. An untranslated row is a
  // row they cannot act on, and copying the English into `nameBn` is the
  // failure mode that looks complete from the outside.
  for (const duty of DUTIES) {
    assert.ok(duty.name.trim().length > 0, `${duty.key} has no English name`);
    assert.ok(duty.nameBn.trim().length > 0, `${duty.key} has no Bangla name`);
    assert.match(duty.nameBn, /[ঀ-৿]/, `${duty.key}'s Bangla name contains no Bengali script`);
    assert.notEqual(duty.nameBn, duty.name, `${duty.key}'s Bangla name is a copy of the English`);
  }
});

// ── 3. Every duty has a door, or says it does not ─────────────────────────

test("every duty points at a registered door, and every door is used", () => {
  const unregistered = DUTIES.filter((d) => DOORS[d.door] === undefined);
  assert.deepEqual(unregistered.map((d) => `${d.key}→${d.door}`), [], "duty points at an unregistered door");

  const unused = Object.keys(DOORS).filter((door) => !DUTIES.some((d) => d.door === door));
  assert.deepEqual(unused, [], "registered door nothing uses — dead weight in the roster");
});

test("a door that does not exist yet names the phase that builds it", () => {
  for (const [name, spec] of Object.entries(DOORS)) {
    if (spec.exists) continue;
    assert.ok(spec.buildPhase, `door "${name}" does not exist and does not say when it will`);
  }
});

test("zero duties are stranded without a door today", () => {
  // Stage 6 shipped the last four (Rate Compare, RTO Analytics, P&L Reports,
  // RFQ Compare). If this ever fails, the roster gained a promise with nowhere
  // to land — which is allowed, but must be a decision, and must read as
  // NEEDS_DOOR to the founder rather than as ACTIVE.
  assert.deepEqual(
    NEEDS_DOOR_DUTIES.map((d) => d.key),
    [],
    "duties with no built door — they must surface as NEEDS_DOOR, not silently as active",
  );
  for (const formerly of ["shipping.rate_compare", "shipping.rto_reduction", "finance.pnl_reports", "operations.rfq_compare"]) {
    const duty = DUTY_BY_KEY.get(formerly);
    assert.ok(duty, `${formerly} vanished from the roster`);
    assert.equal(DOORS[duty.door]?.exists, true, `${formerly} lost its door again`);
  }
});

test("every existing door has a route a founder can actually open", () => {
  for (const [name, spec] of Object.entries(DOORS)) {
    if (!spec.exists) continue;
    assert.match(spec.route ?? "", /^\//, `door "${name}" exists but has no route to open`);
  }
});

// ── 4. The autonomy ladder ────────────────────────────────────────────────

test("minLevel sits on the 0–4 ladder, and the irreversible money duties sit at the top", () => {
  for (const duty of DUTIES) {
    assert.ok(
      Number.isInteger(duty.minLevel) && duty.minLevel >= 0 && duty.minLevel <= 4,
      `${duty.key} has minLevel ${duty.minLevel}`,
    );
  }
  // Refunds and negotiated payment terms move real money and cannot be undone
  // by Nova. They are L4 or they are a liability.
  for (const key of ["support.refund_processing", "operations.payment_terms_negotiation"]) {
    assert.equal(DUTY_BY_KEY.get(key)?.minLevel, 4, `${key} must require full autonomy`);
  }
});

test("only WATCHING duties sit at level 0", () => {
  // L0 is "Nova may do this even at the lowest autonomy". Anything that writes
  // does not belong there. The name is the check because the name is what the
  // founder reads when deciding.
  for (const duty of DUTIES.filter((d) => d.minLevel === 0)) {
    assert.match(
      duty.name,
      /monitor|alert|oversight|watch/i,
      `${duty.key} ("${duty.name}") is level 0 but does not read as a watching duty`,
    );
  }
});

// ── 5. THE LAUNDERING FIX — a verb may only run under a duty that governs it

test("every duty named in the verb table actually exists on the roster", () => {
  // A `dutyRef` pointing at a key that is not on the roster makes
  // `evaluateAuthority` refuse with `duty:unknown` at every tier — which is
  // safe, but it means a shipped verb can never run and nothing says why.
  assert.doesNotThrow(() => assertVerbDutiesExist(VERB_DUTIES));
  for (const [verb, keys] of Object.entries(VERB_DUTIES)) {
    for (const key of keys) {
      assert.ok(DUTY_BY_KEY.has(key), `${verb} is governed by ${key}, which is not on the roster`);
    }
  }
});

test("the laundering case is refused: a purchase order under a low-stock ALERT duty", () => {
  // The measured original: `create_purchase_order` (minLevel 2, door
  // Purchases, high risk) filed under `inventory.low_stock_alerts` (minLevel 0,
  // door Products, a watching duty) was judged at minLevel 0, under the wrong
  // door's ceiling, and could not be stopped by a founder who had paused
  // "Reorder drafts".
  assert.equal(
    dutyGovernsVerb("create_purchase_order", "inventory.low_stock_alerts"),
    false,
    "the laundered pair must be refused",
  );
  assert.equal(
    dutyGovernsVerb("create_purchase_order", "inventory.reorder_drafts"),
    true,
    "the honest pair must be allowed",
  );
  // And the two duties really do differ in the ways that made it exploitable.
  const alert = DUTY_BY_KEY.get("inventory.low_stock_alerts")!;
  const drafts = DUTY_BY_KEY.get("inventory.reorder_drafts")!;
  assert.ok(drafts.minLevel > alert.minLevel, "the exploit only mattered because the levels differ");
  assert.notEqual(drafts.door, alert.door, "…and because the doors differ");
});

test("a verb governed by nobody is refused, and says WHY in writing", () => {
  // `update_price` is the live example: the margin sense is real and the verb
  // is shipped, but no duty on the founder's roster describes "Nova changes a
  // price". Naming the nearest one would be exactly the laundering above, so
  // the roster gap is surfaced as a gap.
  for (const [verb, reason] of Object.entries(UNGOVERNED_VERBS)) {
    assert.deepEqual(governingDuties(verb), [], `${verb} must have no governing duty`);
    assert.ok(reason.trim().length > 20, `${verb} is ungoverned without a written reason`);
    for (const key of DUTY_BY_KEY.keys()) {
      assert.equal(dutyGovernsVerb(verb, key), false, `${verb} must not be performable under ${key}`);
    }
  }
});

test("the two tables agree — an ungoverned verb is ungoverned in both, with a reason", () => {
  // `VERB_DUTIES` is TOTAL over the action vocabulary: an ungoverned verb is
  // present with an empty list, and `UNGOVERNED_VERBS` carries the reason. The
  // failure this guards is the two drifting apart — an empty list with no
  // written reason reads as an oversight, and a reason with no empty list
  // means the verb is quietly governed after all.
  const emptyInTable = Object.entries(VERB_DUTIES)
    .filter(([, keys]) => keys.length === 0)
    .map(([verb]) => verb)
    .sort();
  assert.deepEqual(
    emptyInTable,
    Object.keys(UNGOVERNED_VERBS).sort(),
    "every verb with no governing duty must carry a written reason, and vice versa",
  );
});

test("the verb table is TOTAL — no shipped verb can be missing from it", () => {
  // A verb absent from the table has no governing duty and no recorded reason,
  // so nothing refuses it and nothing explains it. Totality is what makes
  // "which duty governs this?" a question with an answer for every verb.
  for (const [verb, keys] of Object.entries(VERB_DUTIES)) {
    assert.ok(Array.isArray(keys), `${verb} has no entry`);
    assert.equal(new Set(keys).size, keys.length, `${verb} lists a duty twice`);
  }
  assert.ok(Object.keys(VERB_DUTIES).length >= 20, "the action vocabulary looks truncated");
});

// ── 6. Status is computed, and honest ─────────────────────────────────────

test("status reports a missing door BEFORE a level lock — the ordering is the honesty", () => {
  // Told "raise your autonomy level", a founder would raise it and the duty
  // still would not work. The true answer is that the screen does not exist.
  const noDoor = { door: "Nonexistent Door", minLevel: 4 };
  assert.equal(dutyStatus(noDoor, { effectiveLevel: 0 }), "NEEDS_DOOR");
  assert.equal(dutyStatus(noDoor, { effectiveLevel: 4 }), "NEEDS_DOOR", "a built-out level cannot conjure a screen");
  assert.equal(dutyStatus(noDoor, { effectiveLevel: 4, enabled: false }), "NEEDS_DOOR");
});

test("a real duty moves LOCKED → ACTIVE → PAUSED exactly as the founder's switches say", () => {
  const refund = DUTY_BY_KEY.get("support.refund_processing")!;
  assert.equal(dutyStatus(refund, { effectiveLevel: 3 }), "LOCKED", "below its minimum level");
  assert.equal(dutyStatus(refund, { effectiveLevel: 4 }), "ACTIVE", "at its minimum level");
  assert.equal(dutyStatus(refund, { effectiveLevel: 4, enabled: false }), "PAUSED", "the founder's own switch wins");

  const watching = DUTY_BY_KEY.get("inventory.stock_monitoring")!;
  assert.equal(dutyStatus(watching, { effectiveLevel: 0 }), "ACTIVE", "a level-0 watching duty works at level 0");
});

test("the rollup covers every department and never invents or loses a duty", () => {
  const atL4 = dutyRollup(DUTIES, 4);
  assert.equal(Object.keys(atL4).length, NOVA_DEPARTMENTS.length);
  assert.equal(
    Object.values(atL4).reduce((s, r) => s + r.total, 0),
    EXPECTED_TOTAL,
    "the rollup's totals must account for the whole roster",
  );
  assert.equal(
    Object.values(atL4).reduce((s, r) => s + r.active, 0),
    EXPECTED_TOTAL,
    "with every door built, full autonomy should activate the whole roster",
  );

  const atL0 = dutyRollup(DUTIES, 0);
  const activeAtL0 = Object.values(atL0).reduce((s, r) => s + r.active, 0);
  assert.ok(activeAtL0 > 0, "level 0 must still let Nova watch");
  assert.ok(activeAtL0 < EXPECTED_TOTAL, "level 0 must not activate everything — the ladder would be decorative");
});

test("the rollup honours a per-duty pause", () => {
  const paused = DUTIES.map((d) => (d.key === "inventory.reorder_drafts" ? { ...d, enabled: false } : d));
  const before = dutyRollup(DUTIES, 4).inventory.active;
  const after = dutyRollup(paused, 4).inventory.active;
  assert.equal(after, before - 1, "pausing one duty must remove exactly one from its department's active count");
});
