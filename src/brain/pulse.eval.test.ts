/**
 * The pulse's contract — and the one number the whole migration is about.
 *
 * THE HEADLINE (first test): a pulse where nothing changed makes ZERO model
 * calls and still writes its snapshot. It is asserted on a COUNTING FAKE, not
 * on a comment: the fake is the only thing DECIDE can reach, so a future
 * refactor that quietly reintroduces a model step fails here. Under eve this
 * same hour cost a full ~26K-token agent turn, 13 times a day per tenant, to
 * conclude "all quiet".
 *
 * The rest of the suite pins the properties that make that number honest
 * rather than merely small:
 *
 *  · a crossed threshold wakes exactly ONE department — the one that moved;
 *  · a failed read degrades ONE domain — the reason this repo grew
 *    `snapshot.ts` into a sense layer instead of porting nova-ai's
 *    `analytics.ts`, whose single `Promise.all` fails the entire scan;
 *  · no finding is EVER produced for ads, courier or support, and the pulse
 *    does not even read them (they are dead at the source; a finding would be
 *    a lie);
 *  · a finding whose remedy needs a duty this lane does not hold SURFACES
 *    rather than acts — which today is every remedy there is;
 *  · autonomy decides: a gated action becomes a Decision card, and an allowed
 *    one never invents a write path this lane does not have.
 *
 * Demo backend, no network, no model: `decide` is injected in every case.
 */

import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  runPulse,
  productionRemedy,
  scopeJudgement,
  settleFinding,
  type DecideFn,
  type PulseJudgement,
} from "./pulse.js";
import { loadPulseState, resetPulseState } from "./pulse-state.js";
import { comparePulse, PULSE_THRESHOLDS } from "./pulse-compare.js";
import { senseStore, SENSE_GAPS } from "../lib/snapshot.js";
import { storeFor, resetStores } from "../store/resolve.js";
import { laneFor } from "./registry.js";
import { gateOrFile, originOf } from "../front-office/actions.js";
import { dutyGovernsVerb, governingDuties, UNGOVERNED_VERBS } from "../store/duties.js";
import { DEFAULT_GUARDRAILS } from "../store/autonomy.js";
import type { StoreSeed } from "../store/types.js";

process.env.NOVA_STORE_BACKEND = "demo";
// The file backend, deliberately: this suite must not need a Postgres.
delete process.env.NOVA_PG_URL;

const A = "store-aurora";

/** The demo backend's own data, the seam a test needs to move the world. */
function demo(storeId: string) {
  return storeFor(storeId) as unknown as {
    data: StoreSeed;
  };
}

/** A DECIDE that counts. THE instrument of the headline assertion. */
function countingJudge(judgement: Partial<PulseJudgement> = {}): { decide: DecideFn; calls: () => number; cards: string[] } {
  let calls = 0;
  const cards: string[] = [];
  return {
    decide: async ({ card }) => {
      calls += 1;
      cards.push(card);
      return { worthWaking: true, headline: "something moved", note: "look at it", ...judgement };
    },
    calls: () => calls,
    cards,
  };
}

/** Replace one client method for this case. `resetStores` throws the client away after. */
function stub(storeId: string, method: string, impl: (...args: never[]) => unknown): void {
  (storeFor(storeId) as unknown as Record<string, unknown>)[method] = impl;
}

/** Record which client methods were called, keeping the real behaviour. */
function watch(storeId: string, methods: string[]): Set<string> {
  const seen = new Set<string>();
  const client = storeFor(storeId) as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const method of methods) {
    const original = client[method]!.bind(client);
    client[method] = (...args: unknown[]) => {
      seen.add(method);
      return original(...args);
    };
  }
  return seen;
}

/** Run one pulse to establish the baseline snapshot — the "I have seen this store" pass. */
async function baseline(storeId = A): Promise<void> {
  await runPulse(storeId, { decide: countingJudge().decide });
}

before(async () => {
  resetStores();
  await resetPulseState(A);
});

beforeEach(() => {
  process.env.NOVA_STORE_BACKEND = "demo";
});

afterEach(async () => {
  await resetPulseState(A);
  resetStores();
});

// ---------------------------------------------------------------------------
// THE HEADLINE
// ---------------------------------------------------------------------------

test("a pulse where nothing changed costs ZERO model calls — and still writes its snapshot", async () => {
  // First pass: every currently-true condition is a first sighting, so this one
  // does spend. That is the point of having a memory at all.
  const first = countingJudge();
  const opening = await runPulse(A, { decide: first.decide });
  assert.equal(opening.quiet, false, "the seeded store has real conditions to find on first sight");
  assert.ok(first.calls() > 0, "and it pays for a judgement on each department that moved");

  // Second pass, same store, nothing touched.
  const judge = countingJudge();
  const quiet = await runPulse(A, { decide: judge.decide });

  assert.equal(judge.calls(), 0, "THE NUMBER: a quiet pulse must not reach a model at all");
  assert.equal(quiet.modelCalls, 0, "and it must say so on the result the dispatcher reports");
  assert.equal(quiet.quiet, true);
  assert.deepEqual(quiet.findings, [], "silence is the designed success of this lane");
  assert.deepEqual(quiet.departments, []);
  assert.equal(quiet.reportId, undefined, "a report about a quiet hour is spam, not diligence");

  // The snapshot is what keeps the NEXT hour cheap, so a quiet pulse still writes it.
  assert.equal(quiet.snapshotWritten, true);
  const stored = await loadPulseState(A);
  assert.ok(stored, "the snapshot is on disk");
  assert.equal(stored!.at, quiet.at);
  assert.ok(Object.keys(stored!.products ?? {}).length > 0, "with the per-product state COMPARE needs");
  assert.ok(Object.keys(stored!.openFindings ?? {}).length > 0, "and the open conditions, so they do not re-fire");
});

// ---------------------------------------------------------------------------
// What moved, and only what moved
// ---------------------------------------------------------------------------

test("a crossed threshold produces exactly one finding, for the right department — and wakes nobody else", async () => {
  await baseline();

  // A product that had 34 days of cover now has half a day. Nothing else in the
  // store is touched.
  const product = demo(A).data.products.find((p) => p.id === "prod-candle-amber")!;
  assert.ok(product.stock > 3, "precondition: this product was comfortably stocked");
  product.stock = 2;

  const judge = countingJudge();
  const result = await runPulse(A, { decide: judge.decide });

  assert.equal(result.quiet, false);
  assert.equal(result.findings.length, 1, "one condition crossed, so one finding");
  assert.equal(result.findings[0]!.finding.key, "inventory:cover:prod-candle-amber");
  assert.deepEqual(result.departments, ["inventory"], "and only the inventory room was woken");
  assert.equal(judge.calls(), 1, "ONE judgement call: per moved department, never per finding");
  assert.equal(result.modelCalls, 1);

  // The card the model saw carries the delta and nothing else — no catalogue,
  // no order history, no re-read of a business that did not change.
  assert.match(judge.cards[0]!, /DEPARTMENT: inventory/);
  assert.match(judge.cards[0]!, /candle/i);
  assert.ok(judge.cards[0]!.length < 1200, "the change card stays a card (~200 tokens), not a register");

  // Every finding names the observation it came from — no finding may be
  // narrated into existence.
  const observation = result.findings[0]!.finding.observation;
  assert.equal(observation.metric, "daysOfCover");
  assert.ok(typeof observation.value === "number");
  assert.match(observation.evidence, /2 units left/);
});

test("a condition that is already open is not news again — it must materially worsen", async () => {
  await baseline();
  const product = demo(A).data.products.find((p) => p.id === "prod-candle-amber")!;
  const perDay = product.weeklyVelocity.slice(-4).reduce((a, b) => a + b, 0) / 4 / 7;

  product.stock = 20; // crosses (20 / ~4.1 per day ≈ 5 days of cover, under the lead time)
  const first = await runPulse(A, { decide: countingJudge().decide });
  assert.equal(first.findings.length, 1, "the crossing is news once");

  // A trivial drift — one unit sold. Same condition, same story.
  product.stock = 19;
  const drift = countingJudge();
  const quiet = await runPulse(A, { decide: drift.decide });
  assert.equal(quiet.quiet, true, "an open condition that barely moved is not a second alert");
  assert.equal(drift.calls(), 0, "and it costs nothing to decide that");

  // A real collapse — cover down by well over the material threshold.
  product.stock = Math.max(1, Math.floor(19 * (1 - PULSE_THRESHOLDS.materialChangePct / 100) - perDay));
  const worse = await runPulse(A, { decide: countingJudge().decide });
  assert.equal(worse.findings.length, 1, "a materially worse number IS a different fact");
  assert.equal(worse.findings[0]!.finding.trigger, "worsened");
});

test("a condition that CLOSES is not a finding — Nova does not report good news it was never asked for", async () => {
  await baseline();
  const product = demo(A).data.products.find((p) => p.id === "prod-candle-amber")!;
  product.stock = 2;
  await runPulse(A, { decide: countingJudge().decide });

  product.stock = 500; // problem solved
  const judge = countingJudge();
  const after = await runPulse(A, { decide: judge.decide });
  assert.equal(after.quiet, true);
  assert.equal(judge.calls(), 0);
  const stored = await loadPulseState(A);
  assert.equal(
    stored!.openFindings!["inventory:cover:prod-candle-amber"],
    undefined,
    "and it leaves the open set, so the next crossing is news again",
  );
});

// ---------------------------------------------------------------------------
// Degradation — the reason this is a sense layer and not a ported Promise.all
// ---------------------------------------------------------------------------

test("a failed read blinds ONE domain; the rest of the pulse still runs", async () => {
  stub(A, "listProducts", async () => {
    throw new Error("dakio-api 503 on /products");
  });

  const judge = countingJudge();
  const result = await runPulse(A, { decide: judge.decide });

  // The failure is named, not swallowed into an empty catalogue.
  assert.equal(result.senseFailures.length, 1);
  assert.match(result.senseFailures[0]!, /^products \(products: dakio-api 503/);

  // And everything else still senses. The seeded store has a late supplier and
  // unrecovered carts; both are found without the catalogue.
  const domains = new Set(result.findings.map((f) => f.finding.domain));
  assert.ok(domains.has("supplier"), "the supplier domain answered");
  assert.ok(domains.has("carts"), "so did carts");
  assert.equal(domains.has("inventory"), false, "and NOTHING was inferred from the domain that went dark");
  assert.equal(domains.has("margin"), false, "including margin, which rides the same product read");
  assert.equal(result.snapshotWritten, true, "the pulse still remembers what it could see");
});

test("a pulse that can see NOTHING refuses — a blind watchdog is not a quiet business", async () => {
  const blind = async () => {
    throw new Error("dakio-api is down");
  };
  for (const method of ["listProducts", "listSuppliers", "listOrders", "listAbandonedCarts", "listInboxEvents"]) {
    stub(A, method, blind);
  }
  await assert.rejects(
    () => runPulse(A, { decide: countingJudge().decide }),
    /could not read ANY sense/,
    "it throws, so the job row releases with the reason instead of completing as 'all quiet'",
  );
  assert.equal(await loadPulseState(A), null, "and the last good snapshot is not overwritten with nothing");
});

test("a blind domain REMEMBERS: the next healthy pulse does not re-alert everything at once", async () => {
  await baseline();
  const before = await loadPulseState(A);
  const openInventory = Object.keys(before!.openFindings!).filter((k) => k.startsWith("inventory:"));
  assert.ok(openInventory.length > 0, "precondition: the baseline found inventory conditions");

  stub(A, "listProducts", async () => {
    throw new Error("dakio-api 503 on /products");
  });
  await runPulse(A, { decide: countingJudge().decide });

  const after = await loadPulseState(A);
  for (const key of openInventory) {
    assert.ok(after!.openFindings![key], `${key} survived the blind pass`);
  }
  assert.deepEqual(after!.products, before!.products, "and the per-product state was carried forward, not nulled");
});

// ---------------------------------------------------------------------------
// Honesty — the three domains that are NOT sensed
// ---------------------------------------------------------------------------

test("no finding is ever produced for ads, courier or support — and the pulse does not even read them", async () => {
  const touched = watch(A, ["listCampaigns", "listCouriers", "listSupportTickets"]);
  const result = await runPulse(A, { decide: countingJudge().decide });

  assert.ok(result.findings.length > 0, "precondition: this pass found things, so the check is not vacuous");
  const honest = new Set(["inventory", "sales", "carts", "margin", "supplier"]);
  for (const f of result.findings) {
    assert.ok(honest.has(f.finding.domain), `${f.finding.domain} is not a domain this layer senses`);
  }
  assert.deepEqual([...touched], [], "the dead sources are not read at all — an empty [] is not a measurement");

  // The gap is written down where a reader trips over it, with a reason each.
  assert.deepEqual(SENSE_GAPS.map((g) => g.domain).sort(), ["ads", "courier", "support"]);
  for (const gap of SENSE_GAPS) assert.ok(gap.reason.length > 60, `${gap.domain} names WHY, not "TODO"`);
});

// ---------------------------------------------------------------------------
// The registry bound — what this lane may act on
// ---------------------------------------------------------------------------

test("a finding whose remedy needs a duty this lane does not hold SURFACES — it never acts", async () => {
  const client = storeFor(A);
  // The seeded store already has a ledger and a desk, so the assertion is about
  // what THIS PULSE added, not about emptiness.
  const actionsBefore = (await client.listActions()).length;
  const decisionsBefore = (await client.listDecisions()).length;
  const result = await runPulse(A, { decide: countingJudge().decide });

  assert.ok(result.capabilityGaps.length > 0);
  const duties = laneFor("pulse")!.duties;
  for (const gap of result.capabilityGaps) {
    if (gap.wantedDuty === null) {
      // The other honest kind: the verb is shipped and NO duty on the roster
      // governs it, so there is no duty to hold. `update_price` is the one.
      assert.equal(gap.kind, "ungoverned_verb");
      assert.deepEqual(governingDuties(gap.verb), [], `${gap.verb} is genuinely governed by nothing`);
      assert.match(gap.reason, /NO duty on Nova's roster/);
      continue;
    }
    assert.equal(gap.kind, "out_of_lane");
    assert.equal(duties.includes(gap.wantedDuty), false, `${gap.wantedDuty} is genuinely outside the lane`);
    assert.ok(
      dutyGovernsVerb(gap.verb, gap.wantedDuty),
      `${gap.wantedDuty} must be a duty that GOVERNS ${gap.verb} — a gap names the duty the verb ` +
        `really answers to, never whichever key would have been judged most leniently`,
    );
    assert.match(gap.reason, /not one of its lane's duties/);
  }

  // TODAY THIS IS EVERY REMEDY THERE IS. Nothing was filed, nothing was gated,
  // nothing was executed — the report is the whole response.
  assert.equal((await client.listActions()).length, actionsBefore, "no action row was filed under an out-of-lane duty");
  assert.equal((await client.listDecisions()).length, decisionsBefore, "and no card went to the founder's desk");

  // The founder still hears about it: one consolidated report, naming what Nova
  // could not do and the three domains it never looked at.
  assert.ok(result.reportId, "the pulse filed ONE report");
  const [report] = await client.listReports({ kind: "pulse" });
  assert.match(report!.body, /needs the duty/);
  assert.match(report!.body, /Not checked: ads, courier, support/);
});

test("the production remedy table proposes real verbs — the gap is the DUTY, not a missing idea", async () => {
  const sense = await senseStore(A);
  const comparison = comparePulse(sense, null);
  const proposed = comparison.findings
    .map((f) => productionRemedy(f, sense))
    .filter((r): r is NonNullable<typeof r> => r !== null);

  assert.ok(proposed.length > 0);
  const duties = laneFor("pulse")!.duties;
  for (const remedy of proposed) {
    if (remedy.dutyKey === null) continue; // an ungoverned verb — pinned below
    assert.equal(duties.includes(remedy.dutyKey), false, `${remedy.type} → ${remedy.dutyKey} is out of lane, as documented`);
  }
});

/**
 * C-1, THE BINDING, FROM THE TABLE'S SIDE.
 *
 * Every remedy names a verb AND the duty it would be performed under, and the
 * second one is a fact about the verb — not a choice. Before `VERB_DUTIES` this
 * table could pair any verb with any key, and the authority seam would judge the
 * act under that key's door, minLevel and pause switch. The margin remedy really
 * did file `update_price` under `finance.expense_flagging`, a duty registry.ts's
 * own gap list had already ruled "not close enough".
 */
test("every production remedy names a duty that GOVERNS its verb — or names none, honestly", async () => {
  const sense = await senseStore(A);
  const proposed = comparePulse(sense, null)
    .findings.map((f) => productionRemedy(f, sense))
    .filter((r): r is NonNullable<typeof r> => r !== null);

  assert.ok(proposed.length > 0, "precondition: the seeded store proposes remedies");
  for (const remedy of proposed) {
    if (remedy.dutyKey === null) {
      assert.deepEqual(
        governingDuties(remedy.type),
        [],
        `${remedy.type} is filed as ungoverned, so the roster must genuinely have no duty for it`,
      );
      assert.ok(UNGOVERNED_VERBS[remedy.type], `${remedy.type} must carry a written reason in UNGOVERNED_VERBS`);
      continue;
    }
    assert.ok(
      dutyGovernsVerb(remedy.type, remedy.dutyKey),
      `${remedy.type} may not be performed under ${remedy.dutyKey} — that duty does not govern it, and the ` +
        `duty key is what picks the door, the minimum level and the founder's pause switch`,
    );
  }

  // The specific pair the table used to ship, named so the regression cannot
  // come back quietly.
  assert.equal(
    dutyGovernsVerb("update_price", "finance.expense_flagging"),
    false,
    "registry.ts's gap list already ruled on this one: 'Closest neighbour, and not close enough'",
  );
  const margin = proposed.find((r) => r.type === "update_price");
  assert.ok(margin, "the seeded store still produces the margin remedy");
  assert.equal(margin!.dutyKey, null, "and it now names no duty, because none governs a reprice");
});

/**
 * C-1, THE BINDING, FROM THE GATE'S SIDE — the assertion that makes the table's
 * discipline unnecessary to trust.
 *
 * `inLaneReorder` (the fixture this suite used to carry) filed a
 * `create_purchase_order` under `inventory.low_stock_alerts`: a duty the pulse
 * genuinely holds, minLevel 0, door Products, a WATCHING duty. Measured on this
 * very store, that construction bought a real difference — at level 1 the honest
 * duty is refused `duty:min_level` while the laundered one comes back `suggest`.
 * The seam now refuses the pair outright.
 */
test("the gate REFUSES a verb filed under a duty that does not govern it — at every tier", async () => {
  const client = storeFor(A);
  const actionsBefore = (await client.listActions()).length;

  const laundered = {
    verb: "create_purchase_order" as const,
    department: "inventory" as const,
    // In lane, on the roster, enabled, minLevel 0 — and it does not govern a PO.
    dutyRef: "inventory.low_stock_alerts",
    lane: "pulse" as const,
    origin: "job" as const,
    door: "products",
    title: "Reorder before the shelf empties",
    paramsLine: "2 units",
    payload: { novaActionId: "nm:test:laundered", supplierId: "s", productId: "p", quantity: 2, unitCost: 100 },
    receipt: { reason: "r", expectedImpact: "i", confidence: 0.5, evidence: [] },
    preparedDetail: () => "prepared",
  };

  await assert.rejects(
    () => gateOrFile(client, laundered),
    (err: Error) => {
      assert.equal(err.name, "DutyBindingError");
      assert.match(err.message, /does not govern/);
      // The refusal names the duties that DO govern it, so the fix is obvious.
      assert.match(err.message, /inventory\.reorder_drafts/);
      return true;
    },
    "a purchase order may not be judged under a watching duty's minLevel, door and pause switch",
  );

  // Refused BEFORE anything was judged, filed or spent.
  assert.equal((await client.listActions()).length, actionsBefore, "nothing reached the ledger");

  // Every tier, not just this store's: the check runs before `getAuthority` is
  // even read, so the dial cannot change the answer.
  await client.setAutonomy({ level: 4, guardrails: DEFAULT_GUARDRAILS, updatedAt: client.now() });
  await assert.rejects(() => gateOrFile(client, laundered), /does not govern/, "including at Acting CEO");

  // And the honest pair is accepted by the binding (it fails the LANE check
  // instead, which is the next assertion's subject).
  assert.ok(dutyGovernsVerb("create_purchase_order", "inventory.reorder_drafts"));
});

/**
 * C-2 — the registry's assertion #3 was advertised as "the runtime capability
 * bound" and called from nowhere but its own test. The pulse re-implemented it
 * inline, so the bound held by convention in one file. It is now the seam's.
 */
test("the gate REFUSES a duty outside the filing lane — assertion #3 runs on the production path", async () => {
  const client = storeFor(A);
  await assert.rejects(
    () =>
      gateOrFile(client, {
        verb: "create_purchase_order",
        department: "inventory",
        // Governs the verb, and belongs to night_ops — not to the pulse.
        dutyRef: "inventory.reorder_drafts",
        lane: "pulse",
        origin: "job",
        door: "products",
        title: "Reorder",
        paramsLine: "2 units",
        payload: { novaActionId: "nm:test:out-of-lane", quantity: 2, unitCost: 100 },
        receipt: { reason: "r", expectedImpact: "i", confidence: 0.5, evidence: [] },
        preparedDetail: () => "prepared",
      }),
    /may not act under duty/,
    "the lane bound is enforced at the seam every lane goes through, not by each lane remembering",
  );
});

/**
 * C-3 — `origin` was a declared parameter that nothing read and nothing stored,
 * while two files claimed in comments that it was "RECORDED … so a job-driven
 * action does not file itself as chat". A pulse row and a chat row were
 * indistinguishable on the ledger.
 */
test("a job-filed row RECORDS that a job filed it", async () => {
  const client = storeFor(A);
  await client.setAutonomy({ level: 2, guardrails: DEFAULT_GUARDRAILS, updatedAt: client.now() });

  const step = await gateOrFile(client, {
    verb: "create_purchase_order",
    department: "inventory",
    dutyRef: "inventory.reorder_drafts",
    // night_ops legitimately holds the duty AND the duty governs the verb.
    lane: "night_ops",
    origin: "job",
    door: "purchases",
    title: "Reorder before the shelf empties",
    paramsLine: "2 units",
    payload: { novaActionId: "nm:test:origin", supplierId: "s", productId: "p", quantity: 2, unitCost: 100 },
    receipt: { reason: "r", expectedImpact: "i", confidence: 0.5, evidence: [] },
    preparedDetail: () => "prepared",
  });
  assert.equal(step.proceed, false, "level 2 drafts it");

  const row = (await client.listActions()).find(
    (r) => (r.payload as Record<string, unknown>).novaActionId === "nm:test:origin",
  );
  assert.ok(row, "the row is on the ledger");
  assert.equal(originOf(row!), "job", "and it says a job decided it, not a conversation");
  assert.match(
    row!.receipt.evidence.find((e) => e.source === "origin")!.note,
    /night_ops/,
    "naming the lane, so an auditor can tell WHICH job",
  );
});

// ---------------------------------------------------------------------------
// Autonomy — the same gate the customer lane passes
// ---------------------------------------------------------------------------

/**
 * THE REHEARSAL FIXTURE — a legitimate reorder, exercised as the lane that
 * legitimately holds it.
 *
 * This replaces a fixture that filed the same `create_purchase_order` under
 * `inventory.low_stock_alerts` "because the subject here is the GATE, not the
 * choice of verb". It was not a harmless stand-in: that pair is exactly the
 * laundering the binding now refuses, and shipping it as a blessed fixture
 * taught the suite that the violation was the intended shape.
 *
 * The honest way to reach the gate path is to be a lane that may: `night_ops`
 * holds `inventory.reorder_drafts`, and that duty governs a purchase order. So
 * these two cases drive `settleFinding` AS night_ops — which is precisely the
 * "the day a duty moves into this lane" rehearsal the act path exists for, with
 * nothing pretended. `runPulse` itself always passes its own lane; there is no
 * option to override it.
 */
const reorderRemedy = () => ({
  type: "create_purchase_order" as const,
  dutyKey: "inventory.reorder_drafts",
  department: "inventory" as const,
  title: "Reorder before the shelf empties",
  paramsLine: "2 units · test supplier",
  payload: { supplierId: "sup-artisan", productId: "prod-candle-amber", quantity: 2, unitCost: 100 },
});

/** One real finding off the seeded store, for the two gate-path cases. */
async function coverFinding() {
  demo(A).data.products.find((p) => p.id === "prod-candle-amber")!.stock = 2;
  const sense = await senseStore(A);
  const finding = comparePulse(sense, null).findings.find((f) => f.key.startsWith("inventory:cover:"));
  assert.ok(finding, "precondition: a stock-out condition is open on the seeded store");
  return { sense, finding: finding! };
}

const oneJudgement = { note: "order it today", findingCount: 1, scopedNote: "order it today" };

test("autonomy decides: a gated action becomes a Decision card, not an execution", async () => {
  const client = storeFor(A);
  assert.equal((await client.getAutonomy()).level, 2, "the demo store ships at level 2 — prepared actions");
  const { sense, finding } = await coverFinding();

  const outcome = await settleFinding(client, finding, sense, reorderRemedy, oneJudgement, "night_ops");
  assert.equal(outcome.kind, "decision_filed");

  const action = (await client.listActions("prepared")).find((a) => a.dutyRef === "inventory.reorder_drafts");
  assert.ok(action, "the action is on the ledger as PREPARED, never executed");
  assert.equal(action!.type, "create_purchase_order");
  // The receipt traces the row back to the number this pulse measured.
  assert.ok(action!.receipt.evidence.some((e) => e.source.startsWith("pulse:")));
  assert.match(action!.receipt.reason, /days of cover/);
  assert.equal(originOf(action!), "job", "a job filed it, and the row says so");

  const decision = (await client.listDecisions()).find((d) => d.actionId === action!.id);
  assert.ok(decision, "and the founder has a card to answer");
  assert.equal(decision!.tag, "inventory");
});

/**
 * C-6. The gate says EXECUTE and the lane has no executor. It used to throw the
 * whole gate step away — `step.settle`, `step.rowEvidence`, the masked title and
 * params line — and file NOTHING, so no ledger row recorded that Nova had been
 * authorized and had not acted, and the seam a future author was invited to fill
 * had already discarded the replay protocol.
 */
test("even when the gate says EXECUTE, the pulse files the authorized-but-unexecuted fact", async () => {
  const client = storeFor(A);
  // Acting CEO: the dial itself would allow this one.
  await client.setAutonomy({ level: 4, guardrails: DEFAULT_GUARDRAILS, updatedAt: client.now() });
  const { sense, finding } = await coverFinding();

  const outcome = await settleFinding(client, finding, sense, reorderRemedy, oneJudgement, "night_ops");
  assert.equal(outcome.kind, "no_executor", "founder-plane verbs have no executor on this side — say so, do not fake one");

  const row = (await client.listActions()).find((a) => a.id === (outcome as { actionId: string }).actionId);
  assert.ok(row, "and the fact is ON THE LEDGER, not only in a console.warn");
  assert.equal(row!.status, "prepared", "prepared, because that is what happened: complete, and not performed");
  assert.notEqual(row!.status, "executed", "nothing ran");
  assert.match(row!.outcome ?? "", /no executor/);
  assert.ok(
    row!.receipt.evidence.some((e) => e.source === "executor" && e.value === "create_purchase_order"),
    "the missing executor is named as evidence, beside the authority rule that allowed the act",
  );
  assert.ok(
    row!.receipt.evidence.some((e) => e.source === "authority_gate" && e.value === "level:acting_ceo"),
    "and the gate's own rule survives — the two reasons are distinguishable",
  );
  assert.ok(
    (await client.listDecisions()).some((d) => d.actionId === row!.id),
    "the founder gets the card, so they can do in one tap what Nova was allowed to do and could not",
  );

  // The replay protocol survived too: a re-leased rerun answers from the row
  // that owns the key instead of filing a second purchase order. (It reads back
  // as `decision_filed` because that is what the row IS — prepared, on the
  // desk; what matters is that it is the SAME row.)
  const rowsBefore = (await client.listActions()).length;
  const again = await settleFinding(client, finding, sense, reorderRemedy, oneJudgement, "night_ops");
  assert.equal((again as { actionId: string }).actionId, row!.id, "the same row answers, not a second PO");
  assert.equal((await client.listActions()).length, rowsBefore, "and nothing new was filed");
});

/**
 * C-7. `nm:pulse:<condition>` was the whole key, and `findByKey` matches at ANY
 * status: one founder tapping Reject made that condition permanently unfileable
 * for the product's life — every later pulse, including one raised because the
 * condition had materially worsened, answered `replay:rejected`.
 */
test("a rejected condition can be raised again the next day — but not twice in one", async () => {
  const client = storeFor(A);
  const { sense, finding } = await coverFinding();

  const first = await settleFinding(client, finding, sense, reorderRemedy, oneJudgement, "night_ops");
  assert.equal(first.kind, "decision_filed");
  const rowId = (first as { actionId: string }).actionId;

  // The founder says no.
  const rows = (storeFor(A) as unknown as { data: { actions: { id: string; status: string }[] } }).data.actions;
  rows.find((r) => r.id === rowId)!.status = "rejected";

  // Same day, same condition: still one row. A pulse that dies after filing and
  // is re-leased must not file a second purchase order.
  const sameDay = await settleFinding(client, finding, sense, reorderRemedy, oneJudgement, "night_ops");
  assert.equal(sameDay.kind, "refused", "the spent key answers from the row that owns it");
  assert.equal((sameDay as { actionId: string }).actionId, rowId);

  // Tomorrow, with the condition news again: a key nobody has spent.
  const tomorrow = { ...sense, at: new Date(Date.parse(sense.at) + 24 * 3600 * 1000).toISOString() };
  const nextDay = await settleFinding(client, finding, tomorrow, reorderRemedy, oneJudgement, "night_ops");
  assert.equal(nextDay.kind, "decision_filed", "a genuinely recurring condition is not silenced forever by one no");
  assert.notEqual((nextDay as { actionId: string }).actionId, rowId);
});

/**
 * The other half of C-7's sibling defect: ONE judgement is bought per moved
 * department, and it used to be pasted onto every finding's receipt — so
 * finding B's Decision card could carry the note the model wrote about A.
 */
test("a department-level note is labelled as one, never presented as this finding's own", async () => {
  const client = storeFor(A);
  const { sense, finding } = await coverFinding();
  const shared = scopeJudgement(
    { worthWaking: true, headline: "h", note: "reorder the amber candle" },
    "inventory",
    3,
  );

  const outcome = await settleFinding(client, finding, sense, reorderRemedy, shared, "night_ops");
  const row = (await client.listActions()).find((a) => a.id === (outcome as { actionId: string }).actionId)!;
  assert.match(
    row.receipt.expectedImpact,
    /all 3 inventory findings this pass/,
    "the impact label says whose note it is",
  );
  assert.ok(
    row.receipt.evidence.some((e) => e.source === "pulse:judgement" && String(e.value).includes("all 3")),
    "and the scope rides as evidence beside the note itself",
  );

  // A department with ONE finding is the case where the note really is about it.
  assert.equal(scopeJudgement({ worthWaking: true, headline: "h", note: "n" }, "inventory", 1).scopedNote, "n");
});

// ---------------------------------------------------------------------------
// Bookkeeping, and the judge's limits
// ---------------------------------------------------------------------------

test("inbox events are marked processed by CODE, and what is stored is a cursor", async () => {
  const client = storeFor(A);
  const now = Date.parse(client.now());
  demo(A).data.inboxEvents = [
    { id: "evt-1", eventType: "order.created", payload: {}, receivedAt: new Date(now - 60_000).toISOString(), processedAt: null },
    { id: "evt-2", eventType: "cart.abandoned", payload: {}, receivedAt: new Date(now - 30_000).toISOString(), processedAt: null },
  ];
  await baseline();

  const judge = countingJudge();
  const quiet = await runPulse(A, { decide: judge.decide });

  assert.equal(quiet.eventsProcessed, 0, "the baseline pass already drained them");
  assert.equal(judge.calls(), 0, "AND events alone never wake a model — they are awareness, not findings");
  const stored = await loadPulseState(A);
  assert.equal(stored!.inboxCursor, new Date(now - 30_000).toISOString(), "one cursor, not a list of ids");
  assert.deepEqual(await client.listInboxEvents({ processed: false }), []);
});

test("a critical finding is never suppressed by the judge's opinion", async () => {
  await baseline();
  demo(A).data.products.find((p) => p.id === "prod-candle-amber")!.stock = 2;

  const dismissive = countingJudge({ worthWaking: false });
  const result = await runPulse(A, { decide: dismissive.decide });

  assert.equal(dismissive.calls(), 1);
  assert.equal(result.quiet, false, "the model may word a critical finding; it may not overrule the measurement");
  assert.equal(result.findings[0]!.finding.severity, "critical");
  assert.ok(result.reportId);
});

test("a judge that is DOWN does not silence the watchdog", async () => {
  await baseline();
  demo(A).data.products.find((p) => p.id === "prod-candle-amber")!.stock = 2;

  const result = await runPulse(A, {
    decide: async () => {
      throw new Error("gateway 503");
    },
  });

  assert.equal(result.quiet, false, "the numbers were measured by code and stand on their own");
  assert.equal(result.modelCalls, 1, "the attempt is still counted — it was made and it cost the call");
  assert.match(result.findings[0]!.note, /Judgement unavailable/);
});
