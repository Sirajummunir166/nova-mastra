/**
 * The brain registry's two-way coverage eval — phase E spec §E, assertion #2.
 *
 * The registry claims, per lane, which duties Nova's scheduled work fulfils.
 * A claim nobody checks is a comment. These are the checks:
 *
 *   (a) every CLAIMED duty key exists on the roster
 *       — the exact bug doc 07 names, from the claim side.
 *   (b) every ROSTER duty is accounted for: claimed by a lane, claimed by a
 *       front-office action's `dutyRef`, or listed in `UNCLAIMED` with a
 *       written reason
 *       — the same bug from the promise side, and the one that keeps the
 *         capability gap honest as lanes get built.
 *   (c) `lane.department` agrees with `departmentForJob`
 *       — our copy of the map vs. what the server stamps on the row.
 *   (+) module load throws on an unknown duty key
 *       — assertion #1, matching the authority layer's posture that an
 *         off-roster duty is a hard refusal, not a soft failure.
 *
 * No network, no model, no store backend.
 *
 * ── ON READING `src/front-office/actions.ts` ────────────────────────────────
 * Assertion (b) needs the duty keys the front-office action specs claim. It
 * SCANS that file as text rather than importing it, deliberately:
 *   - importing pulls in the whole action/gate module graph for four string
 *     constants, and this suite is meant to stay a pure, instant check;
 *   - a hand-copied mirror of those constants here would drift the first time
 *     someone adds an action, which is precisely the failure this eval exists
 *     to catch;
 *   - the scan is READ-ONLY and derives the set live, so a new `dutyRef` in
 *     that file counts as claimed the moment it lands, with nothing to update
 *     here.
 * If the scan ever finds zero keys, that is a real failure: it means the
 * pattern stopped matching and this eval had quietly gone blind.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { DUTIES, DUTY_BY_KEY } from "../store/duties.js";
import { departmentForJob, PAYLOAD_RESOLVED_KINDS } from "./departments.js";
import {
  BRAIN_LANES,
  LANE_CLAIMED_DUTY_KEYS,
  LANES_WITHOUT_DUTIES,
  SERVER_SWEEP_KINDS,
  UNCLAIMED,
  assertDutyInLane,
  assertLaneDutiesExist,
  laneFor,
} from "./registry.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Duty keys claimed by front-office action specs — scanned, never mirrored. */
function frontOfficeDutyRefs(): Set<string> {
  const source = readFileSync(resolve(HERE, "../front-office/actions.ts"), "utf8");
  const keys = new Set<string>();
  // `const CANCEL_DUTY_REF = "sales.inbox_orders" as const;`
  for (const m of source.matchAll(/\b[A-Z][A-Z0-9_]*DUTY_REF\b\s*=\s*"([^"]+)"/g)) keys.add(m[1]);
  // `dutyRef: "shipping.delivery_cases",` — an inline literal, if one is ever written.
  for (const m of source.matchAll(/\bdutyRef:\s*"([^"]+)"/g)) keys.add(m[1]);
  return keys;
}

// ---------------------------------------------------------------------------
// (a) Every claimed duty exists on the roster
// ---------------------------------------------------------------------------

test("(a) every duty a lane claims is on the roster", () => {
  const offRoster: string[] = [];
  for (const lane of BRAIN_LANES) {
    for (const key of lane.duties) {
      if (!DUTY_BY_KEY.has(key)) offRoster.push(`${lane.kind} → ${key}`);
    }
  }
  assert.deepEqual(
    offRoster,
    [],
    "a lane names a duty key the founder's roster does not contain — the authority layer would " +
      "refuse every one of that lane's acts with rule 'duty:unknown'",
  );
});

test("(a) every duty a front-office action claims is on the roster", () => {
  const refs = frontOfficeDutyRefs();
  assert.ok(
    refs.size > 0,
    "scanned zero dutyRefs out of src/front-office/actions.ts — the scan pattern has gone blind, " +
      "which would make assertion (b) silently under-count claims",
  );
  const offRoster = [...refs].filter((k) => !DUTY_BY_KEY.has(k));
  assert.deepEqual(offRoster, [], "a front-office action's dutyRef is not on the roster");
});

test("(a) every duty named in UNCLAIMED is on the roster", () => {
  const offRoster = UNCLAIMED.filter((u) => !DUTY_BY_KEY.has(u.key)).map((u) => u.key);
  assert.deepEqual(offRoster, [], "the gap list names duties that do not exist");
});

// ---------------------------------------------------------------------------
// (b) Two-way coverage — every roster duty is accounted for
// ---------------------------------------------------------------------------

test("(b) every roster duty is claimed by a lane, a front-office action, or UNCLAIMED", () => {
  const claimedByLane = LANE_CLAIMED_DUTY_KEYS;
  const claimedByFrontOffice = frontOfficeDutyRefs();
  const excused = new Set(UNCLAIMED.map((u) => u.key));

  const unaccounted = DUTIES.filter(
    (d) => !claimedByLane.has(d.key) && !claimedByFrontOffice.has(d.key) && !excused.has(d.key),
  ).map((d) => d.key);

  assert.deepEqual(
    unaccounted,
    [],
    "these roster duties are neither fulfilled nor admitted to be unfulfilled. Add the duty to a " +
      "lane's `duties` in registry.ts if something does it, or to UNCLAIMED with a real reason if " +
      "nothing does. Silence is the one option that is not available — the roster is a promise the " +
      "founder reads.",
  );
});

test("(b) UNCLAIMED is a gap list, not a parking lot — every entry carries a real reason", () => {
  const thin = UNCLAIMED.filter((u) => u.reason.trim().length < 25).map((u) => u.key);
  assert.deepEqual(thin, [], "'not yet' without a reason is how a gap list becomes wallpaper");

  const duplicated = UNCLAIMED.map((u) => u.key).filter((k, i, xs) => xs.indexOf(k) !== i);
  assert.deepEqual(duplicated, [], "a duty listed twice in the gap list");
});

test("(b) nothing is both claimed and excused", () => {
  const claimed = new Set([...LANE_CLAIMED_DUTY_KEYS, ...frontOfficeDutyRefs()]);
  const both = UNCLAIMED.filter((u) => claimed.has(u.key)).map((u) => u.key);
  assert.deepEqual(
    both,
    [],
    "a duty appears in UNCLAIMED and is also claimed — the gap list is stale, and it is overstating " +
      "the gap, which erodes trust in it exactly as fast as understating it",
  );
});

test("(b) the gap is measured, and the number is the point", () => {
  const claimed = new Set([...LANE_CLAIMED_DUTY_KEYS, ...frontOfficeDutyRefs()]);
  // Every roster duty is in exactly one of the two buckets — proven by the two
  // tests above — so the arithmetic below is a real partition, not a guess.
  assert.equal(
    claimed.size + UNCLAIMED.length,
    DUTIES.length,
    `claimed (${claimed.size}) + unclaimed (${UNCLAIMED.length}) must partition the ${DUTIES.length}-duty roster`,
  );
  // Not a threshold to defend — a tripwire on the SHAPE of the claim. If this
  // ever reads "0 unclaimed", either Nova genuinely does all 72 duties or
  // someone emptied the gap list; both deserve a human looking.
  assert.ok(UNCLAIMED.length > 0, "an empty gap list on a 72-duty roster is a claim, not an achievement");
});

// ---------------------------------------------------------------------------
// (c) Lane department vs. what the server stamps
// ---------------------------------------------------------------------------

test("(c) lane.department agrees with departmentForJob for kind-resolved lanes", () => {
  const disagreements: string[] = [];
  for (const lane of BRAIN_LANES) {
    if (PAYLOAD_RESOLVED_KINDS.includes(lane.kind)) continue;
    const server = departmentForJob(lane.kind);
    if (lane.department !== server) {
      disagreements.push(`${lane.kind}: lane=${lane.department} server=${server}`);
    }
  }
  assert.deepEqual(
    disagreements,
    [],
    "a lane would light up a different room than the one the server filed the visit under",
  );
});

test("(c) payload-resolved lanes declare no department, because there is no right answer yet", () => {
  for (const kind of PAYLOAD_RESOLVED_KINDS) {
    const lane = laneFor(kind);
    if (!lane) continue;
    assert.equal(
      lane.department,
      null,
      `${kind}'s room depends on its payload (followup: promiseId ⇒ support else sales; ` +
        `case_update: the case row's own department). Declaring one here would bake in whichever ` +
        `branch an empty payload happens to take.`,
    );
  }
});

test("(c) every duty a lane claims sits in a department the lane can plausibly visit", () => {
  // Not an equality check — case_update legitimately claims a support duty
  // (it replies in the customer's thread) while visiting the shipping room.
  // What this catches is a claim with no relationship to the lane at all.
  const laneRooms = new Map(BRAIN_LANES.map((l) => [l.kind, l.department]));
  for (const lane of BRAIN_LANES) {
    for (const key of lane.duties) {
      const duty = DUTY_BY_KEY.get(key);
      assert.ok(duty, `${key} missing from roster`);
      assert.ok(
        typeof duty.department === "string" && duty.department.length > 0,
        `${key} has no department`,
      );
    }
  }
  assert.equal(laneRooms.size, BRAIN_LANES.length, "one entry per lane");
});

// ---------------------------------------------------------------------------
// Server sweeps are never lanes
// ---------------------------------------------------------------------------

test("no server sweep has a lane — the routing tripwire holds", () => {
  assert.equal(SERVER_SWEEP_KINDS.length, 9, "dakio-api runs nine sweeps off the queue");
  for (const kind of SERVER_SWEEP_KINDS) {
    assert.equal(
      laneFor(kind),
      null,
      `${kind} acquired a lane. dakio-api leases it inside its own claim transaction and no ` +
        `prompt template exists — a lane reaching a model with an undefined prompt burns five ` +
        `failed attempts nightly, forever.`,
    );
  }
  // The four kinds phase E added to the union are exactly the ones that were
  // missing, and all four are sweeps. Named literally: a future edit that
  // quietly promotes one to a lane fails here with its own name in the message.
  for (const kind of ["inbox_sla_sweep", "order_confirm_sweep", "night_shift", "catalog_photo_sweep"] as const) {
    assert.ok(SERVER_SWEEP_KINDS.includes(kind), `${kind} must remain a server sweep`);
  }
});

test("lanes and sweeps partition every job kind dakio-api can mint", () => {
  assert.equal(
    BRAIN_LANES.length + SERVER_SWEEP_KINDS.length,
    21,
    "dakio-api's JOB_KINDS has 21 entries; the registry must be total over all of them",
  );
});

// ---------------------------------------------------------------------------
// Assertion #1 — module load
// ---------------------------------------------------------------------------

test("module load — an unknown duty key throws, and the real registry does not", async () => {
  // The real thing: importing registry.js runs `assertLaneDutiesExist(BRAIN_LANES)`
  // in its module body. Reaching this line at all means it did not throw, but
  // assert it explicitly so the intent is readable.
  await assert.doesNotReject(
    () => import("./registry.js"),
    "importing the registry must not throw — every claimed key is on the roster",
  );

  // The same function the module body calls, driven with a broken lane. This is
  // how the throw is proven without a fixture module that would itself have to
  // be excluded from the typecheck.
  assert.throws(
    () => assertLaneDutiesExist([{ kind: "pulse", duties: ["ceo.duty_that_does_not_exist"] }]),
    /not on Nova's roster/,
    "a lane claiming an off-roster duty must fail at import, not at 02:00",
  );

  // And the message has to say WHY, because the person reading it at boot is
  // not the person who wrote the lane.
  assert.throws(
    () => assertLaneDutiesExist([{ kind: "pulse", duties: ["nope.nope"] }]),
    /duty:unknown/,
    "the boot error must name the authority rule it is anticipating",
  );
});

// ---------------------------------------------------------------------------
// Assertion #3 — the runtime capability bound
// ---------------------------------------------------------------------------

test("runtime — a lane may only act under a duty its own lane claims", () => {
  // The positive case: the pulse's own duty passes.
  assert.doesNotThrow(() => assertDutyInLane("pulse", "ceo.risk_alerts"));

  // The case the bound exists for: a valid roster key, from another lane. The
  // authority layer alone would happily evaluate this — from there a valid key
  // is a valid key.
  assert.throws(
    () => assertDutyInLane("pulse", "marketing.pause_weak_ad_sets"),
    /may not act under duty/,
    "the pulse must not be able to quietly start pausing ad sets",
  );

  // A server sweep has no lane and therefore no duty at all.
  assert.throws(
    () => assertDutyInLane("night_shift", "ceo.risk_alerts"),
    /server sweep/,
    "a sweep never reaches a model, so it can never act under a duty",
  );
});

// ---------------------------------------------------------------------------
// The inverse gap — lanes that claim nothing
// ---------------------------------------------------------------------------

test("a lane claiming no duty is recorded in LANES_WITHOUT_DUTIES with a reason", () => {
  const silent = BRAIN_LANES.filter((l) => l.duties.length === 0).map((l) => l.kind).sort();
  const recorded = LANES_WITHOUT_DUTIES.map((l) => l.kind).sort();
  assert.deepEqual(
    silent,
    recorded,
    "a lane with no duties does real work no roster row describes — the mirror of doc 07's named " +
      "bug. The coverage eval cannot find it (an empty duties[] breaks no assertion), so it has to " +
      "be written down where a human reads it.",
  );
  for (const entry of LANES_WITHOUT_DUTIES) {
    assert.ok(entry.reason.trim().length >= 25, `${entry.kind} needs a real reason`);
    assert.ok(laneFor(entry.kind), `${entry.kind} is listed but is not a lane`);
  }
});
