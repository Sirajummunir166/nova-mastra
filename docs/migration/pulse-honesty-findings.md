# Pulse honesty review — findings to fix

*Adversarial review of the pulse lane, verified with live probes against the
demo backend. **Every defect below passes the current 15-test suite.** Queued
behind the authority fix (both touch `pulse.ts`).*

## The three to fix before this runs against a real tenant

**D1 (severe) — the judge's free text is the report title, unvalidated.**
`pulse.ts:688` takes `settled[0].headline` — an unvalidated model string — and
`pulse.ts:517` makes it the founder's report title. The schema has no length
bound, no vocabulary bound, and no check against the observation set. The
change card never tells the judge which domains are *unknowable* (it lists only
this pass's read failures, never `SENSE_GAPS`). Probed live, it produced:

> ⚠ Sales are down because your courier is losing parcels and ad spend is wasted

in a report whose footer disclaims ads, courier and support. **This defeats
`SENSE_GAPS` through the one line the founder reads first.** Fix: derive the
title from the findings, or constrain and validate the headline against the
observations. Same string also lands on the Decision card as
`receipt.expectedImpact` (`pulse.ts:609` → `actions.ts:1162`) — unreachable
today only because every remedy is out of lane.

**D12 + D13 (severe) — a lost report or one dismissive model call marks
conditions open forever.**
`pulse-compare.ts:344` writes every condition into `open` *before* any judging.
So: (D12) a `worthWaking:false` from the judge (`pulse.ts:481`) drops a
department's findings, and since only `inventory:cover:` is ever `critical`,
**every revenue drop, supplier delay, margin and cart finding is fully
suppressible — once, and forever** (it only returns if it worsens ≥25%).
Probed: "Shenzhen HomeGoods is 4 days late" dropped by one Haiku call, never
mentioned again. And (D13) `pulse.ts:514-528` catches a failed `addReport` and
continues to write the snapshot — probed, one 500 on `/reports` erased six
findings including two critical stock-outs, permanently. **Fix: write the open
set from what actually reached the founder, not from what was derived.**

**D15 + D10 (severe) — blindness reported as quiet.**
Probed: four of five senses dark → `quiet: true`, `modelCalls: 0`, no report,
and the run row completes; `dispatcher.ts:302` forwards only `{modelCalls,
quiet}` and drops `senseFailures`. A store blind for a week is
indistinguishable from a healthy one. Same failure at field granularity (D10):
a product read that *succeeds* but returns no velocity is not "dark", so its
open critical cover conditions silently close — and when the field returns the
evidence says *"(first sighting)"* about a condition that was continuously
true. **Fix: `quiet: true` must be unreachable while a sense, or a load-bearing
field inside one, is dark and unreported.**

## Same class as the velocity bug, one field over

**D3/D4 — `marginPctOf` guards price but not cost** (`snapshot.ts:361`).
dakio-api's mapper is `cost: num(p.purchasePrice)` with `num(null) = 0`, so a
product with no purchase price arrives as `cost: 0` → **margin 100%** → the
thin-margin finding is silently dropped. Founder belief: "Nova checked my
margins and found nothing" — for a catalogue where Nova cannot see cost at all.
A non-numeric cost yields a confident `NaN% margin at ৳3,959 on ৳NaN cost`.
This is exactly the bug the nullable-velocity fix was written to kill, still
live one field over, and equally untested.

## Truncated pages presented as measurements

- **D5** — week-over-week revenue splits a `sinceDays:14` page with **no lower
  bound** on the prior week, over a 200-row cap ordered newest-first, and
  `revenueEligible` strips cancelled/RTO statuses that last week has had time
  to reach and this week has not. Both biases inflate the ratio. Usually a
  *missed* alarm — but when it fires, the stated percentage is one the founder
  can check against their own dashboard and find wrong.
- **D6** — carts are the unrecovered subset *of the 200 newest leads of any
  status, of all time*, with unpriced leads counted at ৳0, reported as a total.
  The count can never exceed 200 no matter how bad it gets.
- **D7** — the inventory sweep silently covers only 200 products; a store with
  800 SKUs has 600 never watched, and nothing says so.

## Smaller

- **D8** — `confidence` on the receipt is a constant (0.9/0.7) rendered as a
  measurement.
- **D9** — `velocityOf` averages over however many buckets exist; one week of
  data reads as "selling ~0.14/day" as if four weeks were observed.
- **D11** — `currentDelayDays ?? 0`: an unreported supplier delay becomes a
  *measured* on-time observation and is stored as one.
- **D14** — the title mixes one department's headline with a severity computed
  across all of them.
- **D16** — `dark.length === 5` is a hard-coded count; add a sixth sense and the
  all-blind guard silently stops firing.
- **D17** — "was X at the last pulse" can compare against a pulse that never
  observed that number (values carry forward across dark passes).

## What the review says about the tests — the part that matters most

> The suite is well-built for what it covers, but **every defect above passes
> it.**

- No test asserts on the report title or any judge wording (D1/D2/D14 unguarded).
- No test stubs `addReport` to throw (D13).
- Only 1/5 and 5/5 blindness are covered — never 4/5 (D15), never a field going
  null inside a healthy read (D10).
- **The nullable-velocity fix has no test at all.** Every demo product ships 8
  real weeks, so the `weeks.length === 0` branch never executes. Changing
  `velocityOf` to `return 0` — the precise regression the build was told to
  prevent — **fails zero tests.**
- The **entire sales domain** never fires: the demo seed's revenue is up, so the
  revenue-drop condition, threshold, denominator and wording have never run
  under assertion.
- `snapshot.ts` has no test file at all.

The honesty claims were largely "tested" by asserting properties the demo seed
makes true by construction. Fixing these means fixing the fixtures too.

## Clean, for the record

The direct ads/courier/support path (closed domain enum, no client calls, pinned
by test); quiet-hour discipline (no report, action, decision or ledger row); the
nullable-velocity fix *at the sense layer* (probed with an empty catalogue —
zero inventory findings); and the capability-gap wording, which the reviewer
called the best-built part of the lane.
