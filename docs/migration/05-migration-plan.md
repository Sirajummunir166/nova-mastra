# 05 — The migration plan

Phases in order. Each phase has a **gate**: measurable proof it worked,
checked against the eve baseline (doc 01, part C). We do not start a phase
until you approve its design, and we do not call one done until its gate is
green. eve keeps running in production until phase G says otherwise — this
is a parallel build, not a rewrite-in-place.

## Phase 0 — Spikes (answer the unknowns first, cheaply)

Small throwaway experiments, no production code:

1. **Suspend/resume**: suspend a workflow step, persist it in `@mastra/pg`,
   resume it from a plain HTTP call (simulating the founder's Approve).
   *This is the approval gate's foundation — if it fights us, phase D
   redesigns around dakio-api-held state instead.*
2. **Memory + pg**: threads persisted, server restarted, conversation
   continues. Measure what Memory actually adds to the prompt per turn.
3. **Schedules**: one cron entry firing one workflow — decide dispatcher
   tick vs Mastra Schedules on evidence.
4. **Model reality check**: with a real `AI_GATEWAY_API_KEY`, run the
   founder smoke test end-to-end; record tokens + latency per turn as our
   first "after" datapoint. *The one spike we cannot run alone: it needs
   the key from you — and if the cloud sandbox's network blocks the
   gateway, this spike runs on your machine instead.*

Spikes 1–3 need no credential and start immediately.

**Gate:** a one-page findings note per spike, in this docs folder.

## Phase A — Foundation: StoreClient + auth floor

Port `StoreClient` (interface + dakio backend + **demo backend**) from
nova-ai; collapse our four hand-rolled fetch files onto it. Port the
tenant-guard semantics into request auth (kill switch, tenant pinning).
Port the service-token evals.

**Gate:** existing branch behavior unchanged (smoke tests pass); the
`service-token` and `isolation`-class eval suites run green against the
demo backend.

## Phase B — Founder lane to parity

Memory threads on `@mastra/pg` (restart-safe sessions). The remaining
founder reads Nova actually needs (business snapshot, reports). `maxSteps`.
Flip a staging merchant app to nova-mastra (`VITE_NOVA_AGENT_URL`).

**Gate:** side-by-side week: same founder questions on both stacks —
answers equally grounded (spot-check + ported evals), tokens/turn ≤ ⅕ of
eve's p50 26.6K, latency clearly better. You use it yourself and sign off.

## Phase C — Customer lane, read-only first

The HMAC ingress route (same contract as eve's `customer.ts`, same 202/401/
409 semantics). Front-office workflow hardened from prototype to lane:
state per `conversationId` in storage, the session-roll epoch honored,
`reply_in_thread` via dakio-api. **Shadow mode first**: nova-mastra receives
real events, *drafts* replies, does not send — eve still answers. Then
answer-mode for reads only (prices, stock, delivery FAQs); order-taking
still eve's.

**Gate:** shadow-diff on real traffic — drafted replies match eve's in
correctness (persona evals + your read of real threads); ported inbox eval
suites green; measured cost/turn and latency vs the 29.4s baseline.

## Phase D — Writes + the approval gate

`create_order_from_chat`, `offer_chat_discount`, `cancel_order_from_chat`,
`update_order_contact`, `open_case`, `flag_handover` — each via
suspend/resume → Decision rows. Autonomy levels read from dakio-api decide
what suspends. The schema invariants (`confirmedByCustomer: z.literal(true)`,
no price fields) port byte-for-byte.

**Gate:** the authority/decisions eval corpus green; a full seeded-store
sale walked in Studio: confirm → suspend → approve → real order at server
prices; idempotent under redelivery (`novaActionId` proven by test).

## Phase E — The brain (doc 06)

Not "port the jobs" — stand up the brain loop. Dispatcher ported unchanged;
claimed jobs run workflows: the pulse (sense → delta → decide), the
per-department check workflows writing the shared board, the CEO
board-reader whose output is the morning report, followup rows as the
brain's scheduled future check-ins. Conversation-bound kinds
(`inbox_reply`, `followup`, `case_update`) load the conversation state.
Server sweeps untouched. Job runs audited as NovaRun rows, same as today.

Phase E also carries the four fixes the job atlas (doc 07, Part B) found:
**unify cart recovery** (one workflow, two delivery arms, one shared
"already contacted" list), **link duties to workflows** (every brain
workflow names the duty keys it serves), **wire the two never-run lanes**
(courier_intervention triggered by journey "at risk", restock_check by the
restock-wait case — no new sensing needed), and **port only the real
night_shift** (dakio-api's grader; nova-ai's demo copy stays behind).

**Gate:** `jobs` + `fleet` + `night` + `duties` eval suites green (lease
contract, tz/DST occurrences, per-tenant claiming, report shape); one week
of staging cron traffic with zero orphaned leases; **one simulated night on
the demo store produces the full morning experience** — receipts, Decision
cards, scheduled follow-ups, the report — with the night's total model-call
count measured and small; cost per pulse measured vs eve's job-lane
numbers.

## Phase F — Memory layers + reflection

Semantic recall (the `0.6·cosine + 0.25·recency + 0.15·weight` formula)
called from the founder lane's instruction builder; nightly reflection as a
scheduled workflow (≤10 writes, provenance kept); customer memory stays
server-distilled (unchanged rule: customers cannot dictate memories).

**Gate:** `memory` eval suite green; recall visible in founder answers on
the demo store; reflection writes auditable in dakio-api.

## Phase G — Departments, evals, cutover

Department jobs get their workflow homes (night shift, weekly strategy).
The 39 portable eval suites all wired into CI; scorers on traces for
grounding. Then the cutover ladder, one switch at a time, each reversible:
staging founder → prod founder → prod customer shadow → prod customer
answer → prod writes → jobs. eve stays warm until a full week after the
last switch.

**Gate (final):** two dashboards side by side over the same week — cost per
conversation, tokens per turn, latency percentiles, eval pass rate. The
migration is done when nova-mastra is strictly better on cost and latency
and not worse on any eval.

## What we deliberately do NOT do

- No behavior "improvements" during migration phases — parity first. The
  improvement list already exists: doc 07 Part C. Tier 1 (owed by the PRD)
  lands inside the phases above; Tier 2 (stockout money counter, RTO
  defense, courier scorecard, winback surface, goal pace, margin review)
  is the backlog that starts the day after the final gate holds.
- No cross-tenant credentials, ever — the per-tenant claiming loop stays.
- No model-chooses-tools for the customer lane — rules and workflow shape
  decide; the model words things and classifies at most.
- No deleting nova-ai until the final gate has held for an agreed period.

---

*Working agreement: docs live in this folder and evolve with the code;
every phase ends with its gate results written down here. You approve a
phase before its code starts.*
