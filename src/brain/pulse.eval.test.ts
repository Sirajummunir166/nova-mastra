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
 *  · no finding is EVER produced for ads or support, and the pulse does not
 *    even read them (they are dead at the source; a finding would be a lie).
 *    COURIER used to be third on that list and is not any more: dakio-api's
 *    `GET /couriers` became a real aggregate, so the domain is sensed — under
 *    four rules pinned at the bottom of this file (no rate without the source's
 *    own evidence flag, no number out of a null, no period claim from a capped
 *    window, no on-time claim ever);
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
  boundJudgeText,
  boundJudgement,
  changeCard,
  pulseTitle,
  runPulse,
  productionRemedy,
  scopeJudgement,
  settleFinding,
  HEADLINE_MAX_CHARS,
  PULSE_RECEIPT_CONFIDENCE,
  type DecideFn,
  type PulseJudgement,
} from "./pulse.js";
import { loadPulseState, resetPulseState } from "./pulse-state.js";
import { blindSpotNews, comparePulse, PULSE_THRESHOLDS, type PulseFinding } from "./pulse-compare.js";
import { LIST_PAGE_CAP, senseStore, SENSE_GAPS } from "../lib/snapshot.js";
import type { CourierSignal, StoreSense } from "../lib/snapshot.js";
import type { AbandonedCart, Order, Product, Supplier } from "../store/types.js";
import { storeFor, resetStores } from "../store/resolve.js";
import { laneFor } from "./registry.js";
import { gateOrFile, originOf } from "../front-office/actions.js";
import { dutyGovernsVerb, governingDuties, UNGOVERNED_VERBS } from "../store/duties.js";
import { DEFAULT_GUARDRAILS } from "../store/autonomy.js";
import type { StoreSeed } from "../store/types.js";

process.env.NOVA_STORE_BACKEND = "demo";
// The file backend, deliberately: this suite must not need a Postgres.
delete process.env.NOVA_PG_URL;

/**
 * THIS SUITE'S OWN TENANT, and the id is load-bearing.
 *
 * It was `store-aurora` — the same id `dispatcher.eval.test.ts` enqueues pulse
 * jobs against. `node --test` runs the two FILES CONCURRENTLY, in separate
 * processes, over one shared `.data/pulse-state/store-aurora.json`, so the
 * dispatcher's pulse could overwrite this suite's snapshot between its two
 * passes: "a condition that is already open is not news again" failed roughly
 * one whole-suite run in five, from a race in the fixture rather than anything
 * about the pulse. A flaky test quietly discounts every claim the suite makes.
 *
 * `resolve.ts` seeds any unknown store id with the same Aurora dataset
 * (`SEEDERS[storeId] ?? createSeed`), so the store is identical and the state
 * file is this suite's alone.
 */
const A = "store-pulse-eval";

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

  // WHY they do not re-fire, stated: every one of them REACHED the founder, in
  // the first pass's report. "Open" is a claim about what was told, not about
  // what was worked out — see the D12/D13 cases below.
  for (const [key, state] of Object.entries(stored!.openFindings!)) {
    assert.equal(state.announced, true, `${key} was in the report the first pass filed`);
  }
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
  // SIX reads now, not five: `listCouriers` joined the sense layer, and a store
  // where five of six answer is a DEGRADE, not a blind pulse. Leaving it out
  // here is what makes this case honest — the guard asks `SENSE_DOMAINS`, so
  // the list is what has to be exhausted, not a number.
  for (const method of ["listProducts", "listSuppliers", "listOrders", "listAbandonedCarts", "listCouriers", "listInboxEvents"]) {
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

test("no finding is ever produced for ads or support — and the pulse does not even read them", async () => {
  // COURIER LEFT THIS LIST, and that is the news. It used to be watched here
  // beside campaigns and tickets, with `listCouriers` asserted NEVER CALLED —
  // correct while the route was a hardcoded `{ couriers: [] }`, and precisely
  // wrong now that it aggregates real parcels. Ads and support are unchanged:
  // still dead at the source, still never read.
  const touched = watch(A, ["listCampaigns", "listSupportTickets"]);
  const result = await runPulse(A, { decide: countingJudge().decide });

  assert.ok(result.findings.length > 0, "precondition: this pass found things, so the check is not vacuous");
  const honest = new Set(["inventory", "sales", "carts", "margin", "supplier", "courier"]);
  for (const f of result.findings) {
    assert.ok(honest.has(f.finding.domain), `${f.finding.domain} is not a domain this layer senses`);
  }
  assert.deepEqual([...touched], [], "the dead sources are not read at all — an empty [] is not a measurement");

  // The gap is written down where a reader trips over it, with a reason each —
  // and the entry for a domain that gained a real read is DELETED, not left
  // standing as a disclaimer the code has outgrown.
  assert.deepEqual(SENSE_GAPS.map((g) => g.domain).sort(), ["ads", "support"]);
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
  assert.match(report!.body, /Not checked: ads, support/, "courier is checked now, so the footer no longer disclaims it");
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

// ===========================================================================
// THE HONESTY DEFECTS
//
// Everything below was found by an adversarial review that PROBED this lane,
// and every one of them passed the suite above. That is the part worth keeping
// in mind while reading these cases: the claims were "tested" by asserting
// properties the demo seed makes true by construction — the sales domain never
// fired because the seeded revenue is up, the nullable-velocity fix had no test
// at all because every demo product ships eight real weeks, and no test ever
// looked at a report title or stubbed `addReport` to throw.
//
// So these cases bring their OWN world: a judge that lies, a backend that 500s,
// a read that succeeds and returns nothing useful, a page that fills up.
// ===========================================================================

/** The report this pulse filed — by id, never by "the newest one". */
async function reportOf(result: { reportId?: string }, storeId = A) {
  assert.ok(result.reportId, "precondition: this pulse filed a report");
  const report = (await storeFor(storeId).listReports({ kind: "pulse" })).find((r) => r.id === result.reportId);
  assert.ok(report, "and it is on the store");
  return report!;
}

/** Swap a client method and hand back the restore — for cases that need BOTH halves. */
function swap(storeId: string, method: string, impl: (...args: never[]) => unknown): () => void {
  const client = storeFor(storeId) as unknown as Record<string, unknown>;
  const original = client[method];
  client[method] = impl;
  return () => {
    client[method] = original;
  };
}

const DAY_MS = 86_400_000;

/** A demo-shaped order, for the sales domain the seed never exercises. */
function order(patch: Partial<Order> & { id: string }): Order {
  const template = demo(A).data.orders[0]!;
  return { ...template, items: [], ...patch };
}

// ---------------------------------------------------------------------------
// D1 — the judge's free text was the founder's headline
// ---------------------------------------------------------------------------

/**
 * THE PROBE THAT FOUND THIS produced, live:
 *
 *   ⚠ Sales are down because your courier is losing parcels and ad spend is wasted
 *
 * as the TITLE of a report whose own footer says Nova makes no claim about
 * courier or ads. `settled[0].headline` — an unvalidated model string — was the
 * title, and the change card never told the judge which domains are unknowable.
 */
test("the report title is DERIVED from the findings — a judge cannot title the report", async () => {
  await baseline();
  demo(A).data.products.find((p) => p.id === "prod-candle-amber")!.stock = 2;

  const liar = countingJudge({
    headline: "Sales are down because your courier is losing parcels and ad spend is wasted",
    note: "Pause the ad campaigns and switch courier today.",
  });
  const result = await runPulse(A, { decide: liar.decide });
  const report = await reportOf(result);

  assert.doesNotMatch(report.title, /courier|ad spend|campaign/i, "the fabricated cause is nowhere near the title");
  assert.match(report.title, /Amber & Oak Soy Candle will stock out before a reorder can arrive/);
  assert.match(report.title, /^⚠ /, "the badge is arithmetic over the findings that carry it");
  assert.doesNotMatch(report.body, /losing parcels/, "and the body will not carry it either");
  assert.doesNotMatch(report.body, /Pause the ad campaigns/);
  assert.match(report.body, /wording for inventory was set aside/, "the founder is told the wording was refused");

  // The measurement itself survives untouched — a refused sentence must not
  // cost the founder the finding.
  assert.match(report.body, /2 units left/);
  assert.match(result.findings[0]!.note, /the measurement stands/);
});

test("the title leads with the finding the ⚠ belongs to — one department's headline, another's severity", () => {
  // D14 as a unit, because the production condition set happens to order
  // inventory first and hides it. `settled[0].headline` + a severity counted
  // across ALL departments is a badge that can belong to a different finding
  // than the sentence beside it.
  const settled = (severity: PulseFinding["severity"], title: string) => ({
    finding: { severity, title } as PulseFinding,
    headline: `the model's line about ${title}`,
    note: "n",
    outcome: { kind: "reported" as const },
  });
  const title = pulseTitle([
    settled("info", "Ceramic Vase Set looks like dead stock"),
    settled("critical", "Portable Blender Pro will stock out before a reorder can arrive"),
  ]);

  assert.match(title, /^⚠ Portable Blender Pro will stock out/, "the ⚠ and the sentence are the same finding");
  assert.match(title, /\(\+1 more finding\)/);
  assert.doesNotMatch(title, /the model's line/, "no model prose reaches the title at all");
  assert.ok(title.length <= 120);

  // A pass with no findings still has one honest thing to say.
  assert.match(pulseTitle([], [{ key: "sense:products", detail: "x" }]), /could not see part of your store/);
});

test("nothing the judge writes reaches a founder unchecked", () => {
  const card =
    "DEPARTMENT: sales\n- [warning] Revenue is down 22.4% week over week\n" +
    "  ৳12,000 over the last 7 days against ৳16,000 the week before";
  const fallback = "Revenue is down 22.4% week over week";
  const bound = (raw: string) => boundJudgeText(raw, { card, fallback, maxLen: HEADLINE_MAX_CHARS });

  const honest = bound("Revenue is down 22.4%: ৳12,000 against ৳16,000 the week before");
  assert.equal(honest.rejected, null, "a line written from the card survives verbatim");

  const invented = bound("Revenue is down 43% week over week");
  assert.match(invented.rejected!, /cites 43/, "a number nobody measured");
  assert.equal(invented.text, fallback);

  for (const [line, domain] of [
    ["Sales are down because ad spend is wasted", "ads"],
    ["Support tickets are piling up", "support"],
  ] as const) {
    const rejected = bound(line);
    assert.match(rejected.rejected!, new RegExp(domain), `${domain} has no data source — it may not be named`);
    assert.equal(rejected.text, fallback, "and the measurement replaces it");
  }

  // ── AND THE BOUND LET GO OF ONE WORD ────────────────────────────────────
  //
  // "Your courier is losing parcels" was rejected here, and had to be: nobody
  // was measuring couriers, so the sentence came from the model's imagination.
  // The scorecard read exists now, so the vocabulary bound must not censor the
  // one department whose findings are entirely about parcels — a judge whose
  // every line was replaced by the fallback is a judge nobody is buying.
  //
  // The wall that caught the original lie is still standing, and it is the one
  // that never depended on this table: a NUMBER the card does not carry is
  // still refused, whatever domain it belongs to.
  const permitted = bound("Your courier is losing parcels");
  assert.equal(permitted.rejected, null, "courier is measured now — naming it is not a fabrication");
  assert.equal(permitted.text, "Your courier is losing parcels");
  assert.match(
    bound("Your courier returned 31% of parcels").rejected!,
    /cites 31/,
    "but a courier NUMBER that is not in the card is refused exactly like any other",
  );

  assert.match(bound("x".repeat(HEADLINE_MAX_CHARS + 1)).rejected!, /over 120 characters/);
  assert.match(bound("   ").rejected!, /empty/);
});

test("the change card tells the judge which domains are UNKNOWABLE, not only this pass's failures", async () => {
  const judge = countingJudge();
  await runPulse(A, { decide: judge.decide });
  const card = judge.cards[0]!;

  assert.match(card, /NOVA CANNOT SEE/);
  for (const gap of SENSE_GAPS) assert.match(card, new RegExp(gap.domain));
  assert.match(card, /do not explain anything with them/);
  assert.ok(card.length < 1400, "and it is still a card, not a register");

  // The same instruction, on the function, so it cannot be an accident of this
  // store's data.
  const bare = changeCard({ department: "sales", findings: [], eventsSeen: 0, senseDark: [] });
  assert.match(bare, /NOVA CANNOT SEE \(no data source[^)]*\): ads, support/);
  assert.doesNotMatch(bare, /: ads, courier/, "a domain with a real read is not declared off-limits to the judge");
});

/**
 * D1's second path, and D8. The judge's `note` becomes `receipt.expectedImpact`
 * on a Decision card — the line a founder reads as Nova's reason for a write.
 * Driven as `night_ops` because that is the only lane that may reach the gate
 * (see the rehearsal fixture above).
 */
test("a judge line naming an unmeasured domain never reaches a Decision card — and the receipt's confidence is honest", async () => {
  const client = storeFor(A);
  const { sense, finding } = await coverFinding();
  const card = changeCard({ department: "inventory", findings: [finding], eventsSeen: 0, senseDark: [] });

  // ADS, not courier: courier is a measured domain now and its vocabulary is no
  // longer fenced off (see the bound's own test above). The property under test
  // was never about the word "courier" — it is that a line reaching for a
  // domain with NO data source never reaches a founder's Decision card, and ads
  // is exactly such a domain.
  const bounded = boundJudgement(
    {
      worthWaking: true,
      headline: "Stock is fine, the ad campaigns are the problem",
      note: "Sales are down because ad spend is wasted — pause the campaigns before reordering.",
    },
    { department: "inventory", findings: [finding], card },
  );
  assert.deepEqual(
    bounded.rejections.map((r) => r.split(" ")[0]),
    ["headline", "note"],
    "both lines reached for a domain nobody measured",
  );

  const outcome = await settleFinding(client, finding, sense, reorderRemedy, scopeJudgement(bounded, "inventory", 1), "night_ops");
  const row = (await client.listActions()).find((a) => a.id === (outcome as { actionId: string }).actionId)!;

  assert.doesNotMatch(row.receipt.expectedImpact, /ad spend|campaign/i, "the card carries no cause Nova cannot see");
  assert.match(row.receipt.expectedImpact, /the measurement stands/);
  assert.match(row.receipt.reason, /days of cover/, "the reason is still the observation");

  // D8: 0.9 for critical and 0.7 otherwise was a severity flag wearing a
  // probability's clothes. One constant, and a row that says what it is.
  assert.equal(row.receipt.confidence, PULSE_RECEIPT_CONFIDENCE);
  const stated = row.receipt.evidence.find((e) => e.source === "pulse:confidence");
  assert.ok(stated, "the constant is labelled as one on the card itself");
  assert.match(stated!.note, /Not a probability/);
});

// ---------------------------------------------------------------------------
// D12 + D13 — findings buried forever
// ---------------------------------------------------------------------------

/**
 * Probed: "Shenzhen HomeGoods is 4 days late" dropped by one Haiku call and
 * never mentioned again. Only `inventory:cover:` findings are ever critical, so
 * every revenue drop, supplier delay, margin and cart finding was suppressible
 * once — and forever, because an open condition only returns if it worsens 25%.
 */
test("a dismissed finding is DEFERRED, not retired — and the snapshot says which of the two happened", async () => {
  await baseline();
  const key = "supplier:sup-vista";
  demo(A).data.suppliers.find((s) => s.id === "sup-vista")!.currentDelayDays = 6;

  const dismissive = countingJudge({ worthWaking: false });
  const dropped = await runPulse(A, { decide: dismissive.decide });
  assert.equal(dismissive.calls(), 1, "the judgement was bought");
  assert.equal(dropped.quiet, true, "and it said no — a legitimate answer, for a while");
  assert.equal(dropped.reportId, undefined);

  const stored = await loadPulseState(A)!;
  assert.equal(
    stored!.openFindings![key]!.announced,
    false,
    "DERIVED IS NOT TOLD: the snapshot records that nobody heard about this",
  );
  assert.ok(stored!.openFindings![key]!.dismissedAt, "and that a judgement, not an accident, is why");

  // Within the window: the same card would buy the same answer, so it is not
  // re-asked. This is the half that keeps the hourly cost claim intact.
  const soon = countingJudge();
  const held = await runPulse(A, { decide: soon.decide });
  assert.equal(soon.calls(), 0, "a dismissal holds for a day, not for an hour");
  assert.equal(held.quiet, true);

  // A dismissal is not a burial: once the window passes, an unreported
  // condition is news again. Asserted at COMPARE level, because the window is a
  // day and this suite runs in milliseconds.
  const sense = await senseStore(A);
  const yesterday = new Date(Date.parse(sense.at) - 25 * 3600 * 1000).toISOString();
  const stale = comparePulse(sense, {
    ...(await loadPulseState(A))!,
    openFindings: { [key]: { since: yesterday, metric: 6, measuredAt: yesterday, announced: false, dismissedAt: yesterday } },
  });
  const back = stale.findings.find((f) => f.key === key);
  assert.ok(back, "the delay never stopped being true and the founder was never told");
  assert.equal(back!.trigger, "unreported");

  // And a WORSENING cuts through the window immediately — a dismissal covers
  // the fact that was judged, not every future version of it.
  demo(A).data.suppliers.find((s) => s.id === "sup-vista")!.currentDelayDays = 8;
  const worse = countingJudge();
  const raised = await runPulse(A, { decide: worse.decide });
  assert.ok(worse.calls() >= 1, "the worsening is judged");
  assert.ok(raised.departments.includes("operations"));
  assert.equal(raised.findings.find((f) => f.finding.key === key)?.finding.trigger, "worsened");
  assert.ok(raised.reportId);
  assert.equal((await loadPulseState(A))!.openFindings![key]!.announced, true, "and NOW it has reached them");
  assert.equal((await loadPulseState(A))!.openFindings![key]!.dismissedAt, null, "an announcement clears the deferral");

  // The zero-model-call property, intact: an announced condition that has not
  // moved does not buy another judgement.
  const after = countingJudge();
  const quiet = await runPulse(A, { decide: after.decide });
  assert.equal(after.calls(), 0);
  assert.equal(quiet.quiet, true);
});

/**
 * Probed: one 500 on `POST /reports` erased six findings including two critical
 * stock-outs. The failure was caught, logged, and the snapshot written anyway —
 * with every condition marked open, meaning "told".
 */
test("a report that could not be filed loses nothing — the next pulse says it all again", async () => {
  await baseline();
  demo(A).data.products.find((p) => p.id === "prod-candle-amber")!.stock = 2;
  const key = "inventory:cover:prod-candle-amber";

  const restore = swap(A, "addReport", async () => {
    throw new Error("dakio-api 500 on /reports");
  });
  const lost = await runPulse(A, { decide: countingJudge().decide });
  restore();

  assert.equal(lost.reportId, undefined);
  assert.match(lost.reportFailed!, /500 on \/reports/, "the failure rides on the result, not only in a log line");
  assert.equal(lost.findings[0]!.finding.severity, "critical");
  assert.equal(lost.snapshotWritten, true, "the snapshot still lands — the memory of the NUMBERS is not the problem");
  assert.equal(
    (await loadPulseState(A))!.openFindings![key]!.announced,
    false,
    "but nothing is marked as told, because nothing was",
  );

  const retry = await runPulse(A, { decide: countingJudge().decide });
  assert.equal(retry.findings.length, 1);
  assert.equal(retry.findings[0]!.finding.key, key);
  assert.ok(retry.reportId, "the second attempt reaches the founder");
  assert.equal((await loadPulseState(A))!.openFindings![key]!.announced, true);
});

// ---------------------------------------------------------------------------
// D15 + D10 — blindness reported as quiet
// ---------------------------------------------------------------------------

test("four of five senses dark is NOT a quiet pulse — a blind store must not look like a healthy one", async () => {
  await baseline();
  const blind = async () => {
    throw new Error("dakio-api 503");
  };
  for (const method of ["listProducts", "listOrders", "listAbandonedCarts", "listInboxEvents"]) stub(A, method, blind);

  const judge = countingJudge();
  const result = await runPulse(A, { decide: judge.decide });

  assert.equal(judge.calls(), 0, "nothing moved — there was nothing left that could move");
  assert.equal(result.modelCalls, 0);
  assert.equal(result.quiet, false, "THE DEFECT: this answered `quiet: true` and completed the job row");
  assert.equal(result.senseFailures.length, 4);
  assert.ok(result.reportId, "the founder is told, because a week of this is otherwise invisible");
  for (const key of ["sense:products", "sense:sales", "sense:carts", "sense:inbox"]) {
    assert.ok(result.blindSpotsReported.includes(key), `${key} was reported`);
  }

  const report = await reportOf(result);
  assert.match(report.title, /could not see 4 parts of your store/);
  assert.match(report.body, /Nova could not see this/);
  assert.match(report.body, /not good news/, "the report says what the silence does NOT mean");

  // An hour later, still dark, nothing new: silence, not an hourly alarm.
  const again = await runPulse(A, { decide: countingJudge().decide });
  assert.equal(again.quiet, true);
  assert.equal(again.reportId, undefined);
  assert.equal(
    again.blindSpots.length,
    5,
    "still blind, and the result still says so to whoever is watching — four dark reads plus the seeded " +
      "courier whose two resolved parcels are not evidence of anything",
  );
});

/**
 * THE SIXTH SENSE AND THE ALL-BLIND GUARD, together.
 *
 * `pulse.ts` used to ask `dark.length === 5`. It asks `allSensesDark(sense)`
 * now, which is a question about `SENSE_DOMAINS` — and the day courier joined
 * that list is the day the old form would have gone quietly unreachable: five
 * dark reads out of six, guard off, a fully blind store completing its job row
 * as "quiet". Both halves are pinned here because only one of them fails
 * loudly.
 */
test("with SIX senses, five dark still degrades and six still refuses", async () => {
  const blind = async () => {
    throw new Error("dakio-api 503");
  };
  const all = ["listProducts", "listSuppliers", "listOrders", "listAbandonedCarts", "listCouriers", "listInboxEvents"];

  for (const method of all.slice(0, 5)) stub(A, method, blind);
  const degraded = await runPulse(A, { decide: countingJudge().decide });
  assert.equal(degraded.senseFailures.length, 5, "five senses are gone");
  assert.equal(degraded.quiet, false, "and the founder is told, loudly");
  assert.ok(degraded.reportId, "but the pulse RAN — one sense answering is not a blind watchdog");

  await resetPulseState(A);
  resetStores();
  for (const method of all) stub(A, method, blind);
  await assert.rejects(() => runPulse(A, { decide: countingJudge().decide }), /could not read ANY sense/);
});

test("blindness is news when it appears, again after a day, and silent in between", () => {
  const spot = [{ key: "sense:products", detail: "products could not be read" }];
  const t0 = "2026-08-15T09:00:00.000Z";
  const at = (hours: number) => new Date(Date.parse(t0) + hours * 3_600_000).toISOString();
  const prior = (announcedAt: string | null) =>
    ({
      at: t0,
      products: null,
      supplierDelayDays: null,
      revenue7d: null,
      revenuePrior7d: null,
      carts: null,
      inboxCursor: null,
      openFindings: null,
      blindSpots: { "sense:products": { since: t0, announcedAt } },
    });

  assert.equal(blindSpotNews(spot, null, t0).length, 1, "newly dark is news");
  assert.equal(blindSpotNews(spot, prior(t0), at(1)).length, 0, "an hour later it is not news again");
  assert.equal(blindSpotNews(spot, prior(t0), at(25)).length, 1, "a day later it is — a week of dark is not one line");
  assert.equal(blindSpotNews(spot, prior(null), at(1)).length, 1, "derived but never told is always still news");
});

/**
 * D10 — the same failure one level down, and the one that looked healthiest: a
 * product read that SUCCEEDS and comes back with no velocity. Nothing re-derives
 * the cover conditions, so they leave the open set as though the stock-out had
 * been solved — and when the field returns, the evidence announces a condition
 * that was continuously true as "(first sighting)".
 */
test("a field that goes dark does not close an open condition — and it does not return as a 'first sighting'", async () => {
  demo(A).data.products.find((p) => p.id === "prod-candle-amber")!.stock = 2;
  await baseline();
  const key = "inventory:cover:prod-candle-amber";
  assert.equal((await loadPulseState(A))!.openFindings![key]!.announced, true, "precondition: open, and told");

  const client = storeFor(A) as unknown as { listProducts: (f?: unknown) => Promise<Product[]> };
  const real = client.listProducts.bind(client);
  const restore = swap(A, "listProducts", async (filter?: never) =>
    (await real(filter)).map((p) => ({ ...p, weeklyVelocity: [] })),
  );

  const dark = await runPulse(A, { decide: countingJudge().decide });
  assert.equal(dark.senseFailures.length, 0, "THE READ SUCCEEDED — this is the case that looks perfectly healthy");
  assert.ok(dark.blindSpots.some((b) => b.key === "field:velocity"));
  assert.equal(dark.quiet, false, "a load-bearing field going dark is not a quiet hour");
  assert.ok(
    (await loadPulseState(A))!.openFindings![key],
    "and the open CRITICAL condition survived a dark field, as it survives a dark read",
  );

  restore();
  const back = countingJudge();
  const after = await runPulse(A, { decide: back.decide });
  assert.equal(back.calls(), 0, "the condition never stopped being true, so its return is not news");
  assert.deepEqual(after.findings, []);
  assert.equal(after.quiet, true);
});

// ---------------------------------------------------------------------------
// D3/D4 — margin, the velocity bug one field over
// ---------------------------------------------------------------------------

test("a product Nova cannot cost produces NO margin claim — not a 100% margin, and not NaN%", async () => {
  await baseline();
  const client = storeFor(A) as unknown as { listProducts: (f?: unknown) => Promise<Product[]> };
  const real = client.listProducts.bind(client);
  // dakio-api's two shapes: `num(null) = 0`, and a cost that is not a number.
  swap(A, "listProducts", async (filter?: never) =>
    (await real(filter)).map((p) =>
      p.id === "prod-candle-amber" ? { ...p, cost: NaN } : p.id === "prod-mug-set" ? { ...p, cost: 0 } : p,
    ),
  );

  const result = await runPulse(A, { decide: countingJudge().decide });

  for (const f of result.findings) {
    assert.doesNotMatch(f.finding.observation.evidence, /NaN/, "a confident `NaN% margin at ৳3,959 on ৳NaN cost`");
  }
  assert.equal(
    result.findings.some((f) => f.finding.key === "margin:prod-candle-amber"),
    false,
    "an unreadable cost is not a margin",
  );
  assert.equal(result.findings.some((f) => f.finding.key === "margin:prod-mug-set"), false);

  // And the founder is TOLD the cost is missing, rather than told nothing —
  // "Nova checked my margins and found nothing" about a catalogue it cannot
  // cost is the belief this creates.
  const cost = result.blindSpots.find((b) => b.key === "field:cost");
  assert.ok(cost, "the gap is reported");
  assert.match(cost!.detail, /is NOT a 100% margin/);
  assert.match((await reportOf(result)).body, /no unit cost for 2 of/);
});

// ---------------------------------------------------------------------------
// D5/D6/D7 — truncated pages presented as measurements
// ---------------------------------------------------------------------------

/**
 * THE SALES DOMAIN, FIRING. It never had: the demo seed's revenue is up, so the
 * revenue-drop condition, its threshold, its denominator and its wording had
 * never once run under an assertion.
 */
test("a real week-over-week drop is measured, named, and worded so the founder can check it", async () => {
  await baseline();
  const now = Date.now();
  stub(A, "listOrders", async () => [
    order({ id: "o-new-1", total: 8000, placedAt: new Date(now - 1 * DAY_MS).toISOString() }),
    order({ id: "o-new-2", total: 4000, placedAt: new Date(now - 3 * DAY_MS).toISOString() }),
    order({ id: "o-old-1", total: 30000, placedAt: new Date(now - 9 * DAY_MS).toISOString() }),
    order({ id: "o-old-2", total: 10000, placedAt: new Date(now - 11 * DAY_MS).toISOString() }),
    // A cancelled order counts toward neither week.
    order({ id: "o-void", total: 99999, status: "cancelled", placedAt: new Date(now - 2 * DAY_MS).toISOString() }),
  ]);

  const judge = countingJudge();
  const result = await runPulse(A, { decide: judge.decide });
  const sales = result.findings.find((f) => f.finding.domain === "sales");

  assert.ok(sales, "৳12,000 against ৳40,000 is a 70% drop, and the threshold is 15%");
  assert.equal(sales!.finding.key, "sales:revenue_drop");
  assert.equal(sales!.finding.department, "sales");
  assert.equal(sales!.finding.severity, "warning");
  assert.equal(sales!.finding.observation.value, -70);
  assert.match(sales!.finding.title, /Revenue is down 70% week over week/);
  assert.match(sales!.finding.observation.evidence, /৳12,000 over the last 7 days against ৳40,000 the week before/);
  assert.match(
    sales!.finding.observation.evidence,
    /cancelled, refunded and returned orders excluded from both weeks/,
    "the maturity bias is named, because the founder's own dashboard will not match otherwise",
  );
  assert.equal(sales!.outcome.kind, "reported", "no verb in ActionType fixes a revenue decline — the report IS the response");
});

test("a truncated order page produces NO week-over-week claim — the denominator is what falls off", async () => {
  await baseline();
  const now = Date.now();
  // 200 rows: the newest week is dense and cheap, last week's rows are the ones
  // a real cap would drop. The arithmetic here would read as a 96% collapse.
  stub(A, "listOrders", async () =>
    Array.from({ length: LIST_PAGE_CAP }, (_, i) =>
      order({
        id: `o${i}`,
        total: i < 150 ? 10 : 1000,
        placedAt: new Date(now - (i < 150 ? 1 : 9) * DAY_MS).toISOString(),
      }),
    ),
  );

  const result = await runPulse(A, { decide: countingJudge().decide });
  assert.equal(
    result.findings.some((f) => f.finding.domain === "sales"),
    false,
    "a percentage the founder can check and find wrong is worse than no percentage",
  );
  assert.ok(result.blindSpots.some((b) => b.key === "page:orders"));
  assert.match((await reportOf(result)).body, /week-over-week revenue cannot be measured/);
});

test("a full page of leads is reported as a FLOOR — never as the number of abandoned carts", async () => {
  // No baseline: the cart condition is a first sighting here, so the case is
  // about the WORDING of the total rather than about a delta.
  stub(A, "listAbandonedCarts", async () =>
    Array.from({ length: LIST_PAGE_CAP }, (_, i) => ({
      id: `lead-${i}`,
      customerId: "",
      items: [],
      // Three leads with no cart value: dakio-api's `num(null) = 0`.
      value: i < 3 ? 0 : 500,
      abandonedAt: new Date().toISOString(),
      recoveryState: "none",
      recoveryMessage: null,
    })) as AbandonedCart[],
  );

  const result = await runPulse(A, { decide: countingJudge().decide });
  const carts = result.findings.find((f) => f.finding.domain === "carts");
  assert.ok(carts, "the cart total moved");
  assert.match(carts!.finding.title, /^at least 200 abandoned carts/, "200 is where the page stopped, not where the carts stop");
  assert.match(carts!.finding.observation.evidence, /floor, not a total/);
  assert.match(carts!.finding.observation.evidence, /3 of them with no cart value recorded/);
  assert.equal(carts!.finding.observation.value, 98_500, "the ৳0 leads are counted, not priced at ৳0");
  assert.ok(result.blindSpots.some((b) => b.key === "page:carts"));
});

test("a catalogue that fills the page says so — and a condition about a product that fell off it is not 'solved'", async () => {
  demo(A).data.products.find((p) => p.id === "prod-candle-amber")!.stock = 2;
  await baseline();
  const key = "inventory:cover:prod-candle-amber";
  assert.ok((await loadPulseState(A))!.openFindings![key], "precondition: the candle has an open stock-out condition");

  const template = demo(A).data.products[0]!;
  stub(A, "listProducts", async () =>
    Array.from({ length: LIST_PAGE_CAP }, (_, i) => ({
      ...template,
      id: `filler-${i}`,
      name: `Filler ${i}`,
      // Nothing derivable, so this case is only about the page, not the rows.
      weeklyVelocity: [],
      cost: 0,
      reorderPoint: 0,
      supplierId: "",
    })) as Product[],
  );

  const result = await runPulse(A, { decide: countingJudge().decide });
  const page = result.blindSpots.find((b) => b.key === "page:products");
  assert.ok(page, "a store with 800 SKUs had 600 never watched and nothing said so");
  assert.match(page!.detail, /stopped there/);
  assert.ok(
    (await loadPulseState(A))!.openFindings![key],
    "and the 601st SKU does not stop having a problem because the page stopped at 200",
  );
});

// ---------------------------------------------------------------------------
// D9, D11, D17 — the smaller ones, each with the sentence it changes
// ---------------------------------------------------------------------------

test("a velocity averaged over ONE week says one week — not four", async () => {
  await baseline();
  const client = storeFor(A) as unknown as { listProducts: (f?: unknown) => Promise<Product[]> };
  const real = client.listProducts.bind(client);
  swap(A, "listProducts", async (filter?: never) =>
    (await real(filter)).map((p) => (p.id === "prod-candle-amber" ? { ...p, weeklyVelocity: [30], stock: 2 } : p)),
  );

  const result = await runPulse(A, { decide: countingJudge().decide });
  const cover = result.findings.find((f) => f.finding.key === "inventory:cover:prod-candle-amber");
  assert.ok(cover);
  assert.match(
    cover!.finding.observation.evidence,
    /\(1 week of sales\)/,
    "'selling ~4.29/day' reads as settled demand; over one bucket it is one week divided by seven",
  );
});

test("a supplier that reports nothing is never stored as on time", async () => {
  stub(A, "listSuppliers", async (): Promise<Supplier[]> => [
    { ...demo(A).data.suppliers[0]!, id: "sup-quiet", currentDelayDays: undefined as unknown as number },
  ]);

  const result = await runPulse(A, { decide: countingJudge().decide });
  assert.equal(
    result.findings.some((f) => f.finding.domain === "supplier"),
    false,
    "unknown produces no finding — and no on-time observation either",
  );
  const stored = await loadPulseState(A);
  assert.equal(
    stored!.supplierDelayDays!["sup-quiet"],
    null,
    "`currentDelayDays ?? 0` stored a MEASURED zero for a supplier nobody has heard from",
  );
  assert.ok(result.blindSpots.some((b) => b.key === "field:supplierDelay"));
});

test("'was X' names WHEN X was measured — never a pulse that did not observe it", async () => {
  demo(A).data.products.find((p) => p.id === "prod-candle-amber")!.stock = 2;
  const sense = await senseStore(A);
  const key = "inventory:cover:prod-candle-amber";

  // A value measured two weeks ago, carried forward through pulses whose
  // product read was dark. The old wording called it "the last pulse".
  const measuredAt = "2026-08-01T09:00:00.000Z";
  const comparison = comparePulse(sense, {
    at: "2026-08-14T09:00:00.000Z",
    products: null,
    supplierDelayDays: null,
    revenue7d: null,
    revenuePrior7d: null,
    carts: null,
    inboxCursor: null,
    openFindings: { [key]: { since: measuredAt, metric: 30, measuredAt, announced: true, dismissedAt: null } },
    blindSpots: null,
  });

  const finding = comparison.findings.find((f) => f.key === key);
  assert.ok(finding, "30 days of cover down to under one is a material worsening");
  assert.equal(finding!.trigger, "worsened");
  assert.equal(finding!.observation.priorMeasuredAt, measuredAt);
  assert.match(finding!.observation.evidence, /was 30 days, measured 2026-08-01/);
  assert.doesNotMatch(finding!.observation.evidence, /at the last pulse/);
});

// ---------------------------------------------------------------------------
// COURIER — the sixth sense, and the four rules that keep it honest
// ---------------------------------------------------------------------------

/**
 * A `StoreSense` with only the courier domain answering.
 *
 * Every other domain is `ok: false`, which is exactly right for these cases:
 * `comparePulse` must produce courier findings from a courier read alone, and
 * an inventory condition leaking into a courier assertion would make the count
 * assertions below meaningless. It also proves the degradation contract from
 * the new side — five dark domains do not stop the sixth from being sensed.
 */
function courierSense(
  couriers: CourierSignal[],
  opts: { truncated?: boolean; at?: string } = {},
): StoreSense {
  const dark = { ok: false as const, reason: "not part of this case" };
  return {
    storeId: A,
    at: opts.at ?? "2026-08-15T09:00:00.000Z",
    products: dark,
    sales: dark,
    carts: dark,
    suppliers: dark,
    inbox: dark,
    courier: {
      ok: true,
      value: { couriers, windowDays: 30, truncated: opts.truncated === true },
    },
    partial: { products: false, orders: false, carts: false },
  };
}

/** One sensed courier row, built from counts the way the route builds them. */
function courierSignal(patch: {
  id: string;
  name?: string;
  delivered?: number;
  rto?: number;
  failed?: number;
  cancelled?: number;
  inFlight?: number;
  inFlightStagnant?: number;
  avgDaysToDeliver?: number | null;
  deliveryTimeSample?: number;
}): CourierSignal {
  const delivered = patch.delivered ?? 0;
  const rto = patch.rto ?? 0;
  const failed = patch.failed ?? 0;
  const cancelled = patch.cancelled ?? 0;
  const inFlight = patch.inFlight ?? 0;
  const resolved = delivered + rto + failed;
  const parcels = resolved + inFlight + cancelled;
  const rate = (n: number) => (resolved > 0 ? Math.round((n / resolved) * 10000) / 10000 : null);
  return {
    id: patch.id,
    name: patch.name ?? `Courier ${patch.id}`,
    parcels, resolved, delivered, rto, failed, cancelled, inFlight,
    inFlightStagnant: patch.inFlightStagnant ?? 0,
    rtoRate: rate(rto),
    deliveredRate: rate(delivered),
    failedRate: rate(failed),
    onTimeRate: null,
    onTimeBasis: "unavailable: Dakio records no promised-delivery date",
    avgDaysToDeliver: patch.avgDaysToDeliver ?? null,
    deliveryTimeSample: patch.deliveryTimeSample ?? 0,
    sufficientEvidence: resolved >= 25,
    basis: `${resolved} resolved of ${parcels} dispatched`,
  };
}

test("an RTO rate over enough resolved parcels FIRES — and the evidence line names the basis, never a bare percentage", async () => {
  const sense = courierSense([
    courierSignal({ id: "steadfast", name: "Steadfast", delivered: 27, rto: 13, failed: 2, cancelled: 3, inFlight: 9 }),
  ]);
  const findings = comparePulse(sense, null).findings.filter((f) => f.domain === "courier");

  assert.equal(findings.length, 1, "one condition crossed: 31% of resolved parcels came back");
  const rto = findings[0]!;
  assert.equal(rto.key, "courier:rto:steadfast");
  assert.equal(rto.department, "shipping", "shipping is where a founder answers a courier question");
  assert.equal(rto.severity, "warning");
  assert.equal(rto.trigger, "crossed");
  assert.equal(rto.observation.metric, "rtoRatePct");
  assert.equal(rto.observation.value, 31);

  // THE HONESTY RULE, and the reason this test exists: a percentage a founder
  // cannot check is a percentage they will one day catch being wrong. The line
  // carries the numerator, the denominator, and what was left out of it.
  const evidence = rto.observation.evidence;
  assert.match(evidence, /31(\.0)?% RTO over 42 resolved parcels/);
  assert.match(evidence, /13 came back/);
  assert.match(evidence, /42 resolved of 54 dispatched/, "the route's own basis sentence travels");
  assert.match(evidence, /9 still in flight and 3 cancelled are excluded from the rate/);

  // And the threshold is a line on a measurement, not a mood: 19% is not news.
  const under = comparePulse(
    courierSense([courierSignal({ id: "redx", delivered: 41, rto: 9 })]),
    null,
  ).findings.filter((f) => f.domain === "courier");
  assert.deepEqual(under, [], "18% over 50 resolved is below the threshold and says nothing");
});

test("a courier with 2 resolved parcels produces NO rate finding — 50% RTO over two parcels is not evidence", async () => {
  // THE REGRESSION THIS PINS: dropping `sufficientEvidence` from the guard. The
  // arithmetic is real — one of this courier's two finished parcels came back,
  // which IS 50% — and it is the worst-looking number a small store can
  // produce. Reporting it tells a founder to fire a courier over one return.
  const thin = courierSignal({ id: "zip", name: "ZipParcel", delivered: 1, rto: 1, inFlight: 3, cancelled: 1 });
  assert.equal(thin.rtoRate, 0.5, "precondition: the rate really is 50%");
  assert.equal(thin.sufficientEvidence, false, "and it really is not evidence");

  const findings = comparePulse(courierSense([thin]), null).findings;
  assert.deepEqual(findings, [], "no finding at any severity, not a quieter one");

  // Nor may it be reported once it has a base of NON-resolved parcels: 24
  // resolved is still under the floor, however many are in flight.
  const almost = courierSignal({ id: "zip", delivered: 12, rto: 12, inFlight: 400 });
  assert.equal(almost.sufficientEvidence, false);
  assert.deepEqual(comparePulse(courierSense([almost]), null).findings, []);

  // One parcel over the floor, same 50%, and now it is news. The gate is the
  // BASE, not the number.
  const enough = courierSignal({ id: "zip", delivered: 13, rto: 12 });
  assert.equal(enough.sufficientEvidence, true);
  const fired = comparePulse(courierSense([enough]), null).findings;
  assert.equal(fired.length, 1);
  assert.match(fired[0]!.observation.evidence, /over 25 resolved parcels/);

  // AND THE THIN ROW IS NOT SOLVED, IT IS UNKNOWN. Without this, a courier that
  // crossed 20% last week and has since dropped under the floor would leave the
  // open set as though its returns had stopped — and announce itself as a
  // "(first sighting)" the next time it has 25 parcels.
  const prior = {
    at: "2026-08-14T09:00:00.000Z",
    products: null, supplierDelayDays: null, revenue7d: null, revenuePrior7d: null, carts: null,
    inboxCursor: null,
    openFindings: {
      "courier:rto:zip": { since: "2026-08-01T09:00:00.000Z", metric: 42, measuredAt: "2026-08-14T09:00:00.000Z", announced: true, dismissedAt: null },
    },
    blindSpots: null,
  };
  const carried = comparePulse(courierSense([thin]), prior);
  assert.ok(carried.open["courier:rto:zip"], "the condition is carried forward, not closed");
  assert.equal(carried.open["courier:rto:zip"]!.metric, 42, "with the last REAL measurement, undated by this pass");
});

test("a null rate never becomes a number, and a null onTimeRate never becomes a finding", async () => {
  // A courier whose parcels are all still moving: every rate is null, because
  // nothing has resolved. `0` here would read as a flawless record.
  const fresh = courierSignal({ id: "fresh", inFlight: 40, cancelled: 2 });
  assert.equal(fresh.rtoRate, null);
  assert.equal(fresh.deliveredRate, null);
  assert.deepEqual(comparePulse(courierSense([fresh]), null).findings, [], "no rate, no finding — in either direction");

  // ON-TIME IS THE PERMANENT NULL. There is no promised-delivery date anywhere
  // in Dakio's schema, so no threshold, no condition and no sentence may exist
  // about lateness — not even on a courier with hundreds of resolved parcels.
  const busy = courierSignal({
    id: "busy", name: "Busy Courier", delivered: 300, rto: 20, avgDaysToDeliver: 6.2, deliveryTimeSample: 280,
  });
  assert.equal(busy.onTimeRate, null, "precondition: null on the wire");
  const findings = comparePulse(courierSense([busy]), null).findings;
  for (const f of findings) {
    assert.notEqual(f.observation.metric, "onTimeRate", "no condition may be built on a measurement that cannot exist");
    assert.doesNotMatch(f.observation.evidence, /on[- ]time/i, "and no line may imply one was");
    assert.doesNotMatch(f.title, /\blate\b/i, "'slow' is a duration; 'late' is a missed promise nobody made");
  }
  // What it says instead: how long parcels took, over how many of them.
  const slow = findings.find((f) => f.key === "courier:slow:busy");
  assert.ok(slow, "the honest substitute still fires");
  assert.equal(slow!.observation.metric, "avgDaysToDeliver");
  assert.match(slow!.observation.evidence, /averaged over 280 delivered parcels/);
  assert.match(slow!.observation.evidence, /No delivery promise is recorded/);

  // A mean over a thin SAMPLE is an anecdote, whatever the resolved count says.
  const anecdote = courierSignal({ id: "anec", delivered: 60, rto: 2, avgDaysToDeliver: 9, deliveryTimeSample: 3 });
  assert.equal(anecdote.sufficientEvidence, true, "resolved is over the floor…");
  assert.equal(
    comparePulse(courierSense([anecdote]), null).findings.some((f) => f.key.startsWith("courier:slow:")),
    false,
    "…but three timed deliveries is not a delivery time",
  );
});

test("a truncated courier window makes no claim about a period — counts become floors and say so", async () => {
  const rows = [
    courierSignal({ id: "steadfast", name: "Steadfast", delivered: 2600, rto: 900, failed: 100, inFlight: 400, inFlightStagnant: 55 }),
  ];
  const capped = comparePulse(courierSense(rows, { truncated: true }), null).findings;
  const whole = comparePulse(courierSense(rows), null).findings;

  assert.equal(capped.length, whole.length, "a capped read still reports — it words itself differently");

  const stagnant = capped.find((f) => f.key.startsWith("courier:stagnant:"))!;
  // THE RULE: the rows are the most recent N dispatches, so 55 stagnant parcels
  // is a FLOOR. A founder who reads it as "55 in the last 30 days" has been
  // handed a total that was never counted.
  assert.match(stagnant.title, /^at least 55 /);
  assert.match(stagnant.observation.evidence, /^at least 55 /);
  for (const f of capped) {
    assert.match(
      f.observation.evidence,
      /most recent dispatches only, so this is a floor, not the period's total/,
      `${f.key} must disclose that its window was capped`,
    );
  }

  // The uncapped pass says none of that, because none of it is true there.
  for (const f of whole) {
    assert.doesNotMatch(f.observation.evidence, /floor/);
    assert.doesNotMatch(f.title, /at least/);
  }
});

test("the demo store's courier history flows end to end — one department, one judgement, gaps surfaced", async () => {
  // Through `runPulse` on the seeded backend rather than a literal sense, so
  // the whole chain is exercised: DemoStore's envelope → senseStore → compare →
  // one judgement for the shipping department → the remedy table → the report.
  const judge = countingJudge();
  const result = await runPulse(A, { decide: judge.decide });

  const courier = result.findings.filter((f) => f.finding.domain === "courier");
  assert.ok(courier.length > 0, "the seed carries a courier with 13 of 42 resolved parcels returned");
  assert.ok(
    result.departments.includes("shipping"),
    "and it wakes the shipping department, which no pulse could do before the read existed",
  );
  assert.equal(
    courier.every((f) => f.finding.subject !== "cour-zip"),
    true,
    "but never the 2-parcel courier, whose 50% RTO is the worst number in the store",
  );

  // The remedy that exists is out of lane, exactly like every other row.
  const stagnant = courier.find((f) => f.finding.key.startsWith("courier:stagnant:"));
  assert.ok(stagnant, "SwiftShip has 4 parcels that have stopped moving");
  assert.equal(stagnant!.outcome.kind, "capability_gap");
  const gap = result.capabilityGaps.find((g) => g.findingKey === stagnant!.finding.key)!;
  assert.equal(gap.verb, "flag_courier_issue");
  assert.equal(gap.kind, "out_of_lane");
  assert.equal(gap.wantedDuty, "shipping.delay_chasing");
  assert.ok(
    dutyGovernsVerb(gap.verb, gap.wantedDuty!),
    "the gap names a duty that GOVERNS the verb, not the one that would be judged most leniently",
  );
  assert.equal(laneFor("pulse")!.duties.includes(gap.wantedDuty!), false, "and the pulse lane genuinely does not hold it");

  // The RTO finding has NO remedy at all: the roster has a duty for it
  // (`shipping.rto_reduction`) and `ActionType` has no verb that changes which
  // courier a store routes to. The report is the whole response.
  const rto = courier.find((f) => f.finding.key.startsWith("courier:rto:"))!;
  assert.equal(rto.outcome.kind, "reported");
  assert.equal(productionRemedy(rto.finding, await senseStore(A)), null);

  // And the footer no longer disclaims a domain Nova now measures — while the
  // one thing inside it that cannot be measured is stated where it could
  // otherwise mislead.
  const report = await reportOf(result);
  assert.match(report.body, /Not checked: ads, support/);
  assert.doesNotMatch(report.body, /Not checked:[^\n]*courier/);
  assert.match(report.body, /On-time delivery is not measured/);
  assert.match(report.body, /13 came back/, "the measurement itself is in the body");
});
