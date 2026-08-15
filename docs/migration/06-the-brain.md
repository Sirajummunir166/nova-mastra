# 06 — The brain: Nova working while the founder sleeps

> **The concept: one founder, one employee, a successful business.**
> Nova is not built to talk. Nova is built to make the business succeed.
> The chatbox and the inbox are the two *doors* into Nova. The employee
> itself is the brain: awake 24/7, checking the business every hour,
> deciding the next best move for every department and for the store as a
> whole, doing what it is trusted to do, queueing what needs the founder,
> and scheduling its own future check-ins. This doc designs that brain on
> Mastra — and shows why it becomes *more* active there, not just cheaper.

## What the brain already is in nova-ai (so we port truth, not wishes)

Grounded in the inventory (doc 01):

- **The heartbeat** — a dispatcher ticks every minute, claims due work per
  tenant from `nova_jobs` in dakio-api, each tenant through its own token.
- **The senses & moves** — job kinds: `pulse` (how is the business doing
  right now), `restock_check`, `cart_sweep`, `courier_intervention`,
  `followup` (a check-in Nova scheduled for itself, due 30 minutes before a
  promise), `morning_report`, `night_ops` (graded departments with backing
  metrics, a plan board, WAITING_ON_YOU), `weekly_strategy`, `reflection`
  (nightly: distill the day into ≤10 memories).
- **The shared board** — everything the brain does or plans lives as rows in
  dakio-api: NovaAction (done/doing), Decisions (waiting on the founder),
  promises, plan items, department boards, duty roster. **This is how "each
  can see what is completed and what is pending" works — one board, read by
  the brain, the founder UI, and the evals alike.**
- **The trust system** — autonomy levels per action class decide what Nova
  may do alone; everything else becomes a Decision card. Every act leaves a
  ledger receipt.

All of that state stays exactly where it is. The migration changes the
*engine* that reads and writes it.

## The brain's loop, on Mastra

One cycle, per tenant, repeated forever:

```
        SENSE (code, free)
   orders · stock · carts · couriers
   inbox SLAs · ad spend · goals
              │
        COMPARE (code, free)
   what changed since the last pulse?
   (delta store: last-known state per signal)
              │  nothing changed → sleep. 0 model calls.
              ▼  something changed:
        DECIDE per department (code + small model only for judgment)
   "stock of the best seller crossed reorder point"
   "3 carts > ৳2000 abandoned tonight"
              │
      ┌───────┼──────────────┐
      ▼       ▼              ▼
   DO NOW   ASK FOUNDER   SCHEDULE LATER
   (within  (suspend →    (write a followup
   autonomy) Decision      row with dueAt —
   + ledger  card)         the brain's own
   receipt)                future check-in)
              │
        RECORD (board rows in dakio-api)
   done / waiting / scheduled — visible to everyone
```

Each stage is a workflow step. The expensive part of eve's brain — a full
agent turn re-reading a ~26K register just to discover *nothing changed* —
becomes a code path that costs nothing.

**The pieces, concretely:**

- **Pulse** = a scheduled workflow per tenant. SENSE and COMPARE are
  `StoreClient` reads plus a small delta store (last pulse's snapshot —
  same pattern the front-office observation cache already uses). The model
  is invited only into DECIDE, and only for the departments whose signals
  moved, with a ~200-token "what changed" card — the same state-card
  discipline as the customer lane.
- **Department checks** = one small check-workflow per department, sharing
  the SENSE data from the pulse (fetched once, not nine times — in eve,
  each department subagent re-read its own context). Each writes its own
  board rows: completed, pending, scheduled next check.
- **CEO layer** = a workflow that reads all department boards + store goals
  and picks the store-level priorities: what got done overnight, the single
  most important WAITING_ON_YOU, what is scheduled. Its output *is* the
  morning report — the report is the brain's state made readable, not a
  separate feature.
- **Scheduled future checks** = `followup` rows with `dueAt`, exactly as
  today. The rows stay the authority (visible on the board, auditable,
  survives anything); the dispatcher makes them fire. Mastra's evented
  workflows can sleep-until too, but a board row the founder can *see*
  beats an invisible sleeping process — so rows it is.
- **Night shift & weekly strategy** = deeper evented workflows: analysis in
  code, model calls only for the judgment steps (grading, prioritizing,
  writing the plan).
- **Acting** = every DO-NOW/ASK path goes through the same approval gate as
  doc 04: autonomy level decides suspend-or-execute; every act mints its
  ledger receipt. The brain gets no new powers in this migration — it gets
  more *attention*.

## Why the brain gets BETTER on Mastra — the frequency argument

This is the core of the ownership claim, in numbers:

| | eve today | Mastra design |
|---|---|---|
| A pulse where nothing changed | a full agent turn (~26K+ tokens) | **0 model calls** — code compares deltas and goes back to sleep |
| A pulse where one thing changed | full agent turn, model rediscovers context | 1 small judgment call (~1–2K tokens) on the delta card |
| 9 departments checking | 9 subagent contexts, each re-reading its own | 1 shared SENSE + 9 cheap decide steps |
| Affordable pulse frequency | rare — every tick costs real money | **hourly, per tenant, per department** — the concept as stated, actually affordable |

eve's cost forced the brain to be *careful about waking up*. That is
backwards — a good employee checks often and speaks rarely. When sensing is
free, checking often costs nothing, and the model spends its tokens only on
the moments that deserve thought. **Same total spend buys perhaps 10× the
watchfulness.** That, not the invoice, is why this migration serves "one
founder, one employee, a successful business."

## What the founder experiences

Sleeps at midnight. Overnight: the pulse notices a courier failure spike in
Sylhet and opens an intervention (autonomy: allowed — done, receipted); the
cart sweep drafts two recovery messages (autonomy: not yet — two Decision
cards); the restock check schedules a supplier follow-up for 10:00; night
ops grades all departments. At 7:00 the morning report reads the board:
**what I did, what I need from you (one thing, pinned), what is scheduled.**
The founder taps Approve twice over breakfast. The employee never slept.

Every piece of that paragraph exists in nova-ai today — the migration's job
is to keep it true while making the checks cheap enough to run all the
time, and every claim in it auditable on the board.

## Scheduling: one clock, alarms as data (decided after spike 3)

The brain needs exactly **one** scheduled trigger: a minute-level
dispatcher tick — now a Mastra scheduled workflow (spike 3), so every
heartbeat is a traced, watchable run in Studio. Everything else stays
**data with a due time**, owned by dakio-api:

- Cadenced jobs (morning report, pulse…) expand from **founder-editable
  defs** in dakio-api — one source of truth, tenant timezone, DST handled.
  Mastra never holds a second copy of a cadence.
- Followups/promises are rows with `dueAt`; event jobs are minted when the
  event happens. No crons for any of them.
- Overlapping ticks are safe by construction: dakio-api's `SKIP LOCKED` +
  lease tokens make double-claiming impossible — the safety lives in the
  database, not in the scheduler.
- Operational rule (spike 3's lesson): schedules fire only after
  `startWorkers()`. The express server calls it; any worker-only process
  must call it itself or the brain silently never wakes.

**One resilience fix (phase E):** today the model-free server sweeps run
only when Nova calls the claim endpoint — so a Nova outage also stops the
order-confirm backstop and SLA updates, which message *customers*. Give
dakio-api its own internal timer for its own sweeps (it already runs
courierSync that way). A Nova outage must mean "the brain is asleep",
never "customers stopped hearing back."

**Do we need a queue system like BullMQ? No — but we should build what
its dashboards give.** The `NovaJob` table already *is* a job queue:
priorities, leases with fencing tokens, attempts with backoff, dedupe
keys, `due | leased | done | failed | skipped`. Swapping it for
BullMQ would add Redis, move the queue out of the founder-visible board,
and re-buy machinery the evals already pin — for throughput Nova does not
need (BullMQ shines at thousands of jobs/second; the brain runs dozens of
jobs/minute across the whole fleet). What we *should* copy from BullMQ is
its **management console**, as a thin admin view over the existing rows
(dakio-admin, reading dakio-api):

- queue depth + oldest due job, per tenant and per kind;
- failed jobs with their stored error and a one-tap **retry** (re-due);
- stuck leases (the watchdog already re-dues them — show it happening);
- pause/resume a job kind per tenant (the `enabled` flag already exists);
- a link from any job row to its Mastra Studio trace ("why did it fail"
  in steps, not logs).

Founders keep the simple schedule surface they already have (rename
times, pause a duty); the console above is for **admins/ops** only —
internal sweeps stay invisible to founders, as today.

## What ports, what we build

- ♻️ **Port**: the dispatcher loop, job kinds and lease contract, the NBA
  and reach math, board/ledger/decision writes, duty definitions, the
  `jobs`/`fleet`/`night`/`duties` eval suites.
- 🔨 **Build**: the pulse delta store (last-known state per signal), the
  per-department check workflows, the CEO board-reader, and Studio traces
  for every brain cycle (today the brain's thinking is invisible; every
  pulse becomes a step timeline you can open).
- 🗑 **Dissolve**: departments-as-subagents (doc 04) — the brain's
  departments are parallel check workflows writing to one board, wearing
  their signatures as data.

## Where this lands in the plan

The brain is phase E of doc 05 — but this doc upgrades phase E's meaning:
not "port the jobs", but "stand up the brain loop". Its gate grows one
clause: **on the demo store, one simulated night must produce the morning
experience above** — receipts, decisions, scheduled follow-ups, and the
report — with the model-call count for the whole night measured and small.
