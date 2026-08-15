# Phase D gate — writes + the approval gate · READY FOR YOUR YES/NO

*(nova-mastra `90f4f17` → `a14c544`; dakio-api `415acaf`. Simple summary,
then the known issues, which are the part worth reading.)*

## What Phase D was

Let Nova actually *do* things — place a chat order, offer a discount,
cancel, correct an address, open a case, hand a thread to a person — with
the founder's authority gate in front of every one, and nothing able to
slip through twice.

## What is proven

1. **The gate works end to end, on real data.** A confirmed chat order
   files a prepared action plus a founder Decision, creating **no order
   and touching no stock**. The founder approves through dakio-api's real
   endpoint and a real order appears at **server prices** (৳1360 = 2×৳650
   + ৳60 delivery, stock 24→22). Redelivering the same message replays
   instead of filing again; approving twice answers 409. Automated as
   `scripts/smoke-order-gate.mjs` and re-run green after every change.
2. **All six verbs go through the same path** — dedupe, authority, then
   execute / prepare-with-Decision / block-with-escalation, every row
   receipted with the rule that decided it.
3. **Shadow mode cannot write.** Pinned by a test per verb.
4. **The at-most-once key has a database floor** (dakio-api `415acaf`):
   `NovaAction.dedupeKey`, unique per tenant and type. Before it, two
   concurrent redeliveries of one customer message could become two
   prepared actions and — after approval — **two real orders for one
   confirmation**.
5. **231 tests green**, including a test double that finally models the
   server's uniqueness (before, every replay assertion was vacuous).

## What adversarial review changed

Three reviewers tried to break this on safety, idempotency and honesty —
twice. They found real defects both times, including three I would have
shipped: the order title was the *one* verb skipping the phone masker
while carrying a phone and a street; a **blocked** handover still marked
the thread escalated, which muted Nova for the rest of the session on
behalf of a hand-off that never happened; and a founder's **rejected**
order was reported to the customer as still pending, forever.

The second round found the root cause under several of them: the server
answered a duplicate action identically to a fresh create, so the agent
could not tell "I did this" from "someone else did, and I got their row".
All twelve criticals are now closed with file-and-line evidence.

## Known issues (accepted, not fixed — the stopping rule)

The rule set before the last round: fix criticals and highs, write the
rest down rather than iterate forever. These are the rest.

1. **A blocked order cannot be re-judged from the same thread.** If a
   founder lifts a no-touch lock, the customer's order cannot be
   re-attempted in that conversation — the key never advances past a
   blocked attempt. *Product impact: a lifted lock needs a new
   conversation or a manual order.* Worth fixing early in a follow-up.
2. Blocked rows own the key on the agent but not on the server (the
   server leaves `dedupeKey` null for blocked), so two concurrent
   redeliveries of a *refused* action can file two blocked rows and two
   escalation cards. Noise, never money.
3. The client discards the PATCH route's new `replayed` flag, so a lost
   finalize can still re-run attribution — a minutes miscount, never
   money (revenue influence is credited once).
4. A tight finalize race can surface the server's 409 as a thrown error
   that nothing reconciles yet.
5. `DemoStore.updateAction` does not model the server's settled-row 409,
   so finalize-race handling is untested against that floor.
6. The phone masker is BD-mobile-shaped only: spaced, hyphenated,
   landline and non-BD numbers pass through founder-facing text, and it
   masks phones only — a street typed into a free-text reason still
   travels with that reason (deliberate: it is the founder's only record
   of why a sale was lost).
7. The dedupe read still pulls the whole tenant ledger per gated call.
   dakio-api shipped a point lookup (`GET /actions?dedupeKey=&type=`) in
   the same commit; the agent does not use it yet. O(ledger) per write.
8. Pre-existing, unrelated: one dakio-api integration test
   (`nova.decisions.integration`) fails identically before this work —
   its fixtures reuse one coupon code.

## The ask

Say **"phase D approved"**, or push back on any known issue you want
fixed before Phase E's brain starts. Item 1 is the one I would pick.

Meanwhile, per standing approval, Phase E begins: the dispatcher tick,
per the spec in [phase-E-spec.md](../phase-E-spec.md).
