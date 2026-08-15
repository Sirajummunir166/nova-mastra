# Phase E build spec — the brain on Mastra

*Researched from the live code in all three repos. The design decisions are in
[doc 06](06-the-brain.md) and [doc 07](07-job-atlas.md); this is the how.*

## Headline

**The lease contract is already 100% ported** — `claimDueJobs`, `completeJob`,
`releaseJob`, `listJobDefs`, `upsertJobDef` are present on the interface, the
live dakio backend *and* DemoStore. On the store side phase E is **wiring, not
porting**. Everything *above* the client is missing and must be built.

**But three of the pulse's seven sense domains are dead at the source** (see C).
The pulse can ship honestly on four; claiming the other three would be exactly
the false promise doc 07 warns about.

---

## A. The claim/lease contract

### The tick, per tenant
`resolveDispatchTenants()` → per tenant `storeFor(id).claimDueJobs(10)` → per
job `dispatchJobToChannel` → **two-argument `.then(ok, fail)`**, deliberately
not `.then().catch()`:
- success → `completeJob(id, leaseToken, sessionId?)`, and an ACK failure is
  swallowed — the work already succeeded; releasing finished work would requeue
  it. The watchdog reconciles.
- failure → `releaseJob(id, leaseToken, message)`.

A thrown claim for one tenant is swallowed so it can never block another
tenant's tick (dakio-api counts it as `nova.claim.failed`).

### What one claim does server-side
Inside one 30s transaction: watchdog re-dues expired leases → drain events to
jobs → advance journeys → seed default defs (hired tenants only) → expand cron
occurrences (`dedupeKey = kind:occurrenceISO`) → **lease server sweeps off the
queue first** → recheck due followups (five fire-time checks, allow-list) →
budget shed → `SELECT … FOR UPDATE SKIP LOCKED ORDER BY priority, dueAt` →
**per-row** update to `leased` with a fresh `leaseToken` (never `updateMany`).

Wire shape of a claimed job:
`{id, kind, payload, dueAt, priority, status, attempts, lastError, dedupeKey,
leaseUntil, department, leaseToken}`.

Constants: `LEASE_MINUTES=10`, `MAX_ATTEMPTS=5`, backoff `min(30, 2^attempts)`.

### The invariant phase E must not break
**The token, not the id, is the fence.** A workflow outliving its 10-minute
lease finds its complete/release silently no-op'd (`{ok:true, stale:true}`,
HTTP 200 — a stale caller's belated complete is not an error). So brain
workflows need sub-10-minute steps or their own re-lease story.

### Fleet resolution and the security rule
Two distinct credentials off one secret: `mintFleetToken()` carries **no
tenantId** and only ever learns *ids*; `serviceTokenFor(storeId)` carries one
tenant and rides every claim/complete/release. Stated three times in the code
and non-negotiable:

> There is no credential that could claim across the fleet in one HTTP call —
> minting one would be a new, more dangerous kind of cross-tenant credential
> this codebase has never had.

Keep N small per-tenant claims per tick. It shards the same way `SKIP LOCKED`
does. Fleet list is cached 60s and served stale on error.

### Operational rule (spike 3)
The tick is a Mastra scheduled workflow (`* * * * *`). Schedules fire only after
`startWorkers()`; `@mastra/express`'s `server.init()` already calls it in our
process, but **any future worker-only brain runner must call it or the brain
silently never wakes.** ~10s lateness on a minute cron is normal.

---

## B. Job → lane routing

**Rejoin the customer conversation** (the existing front-office pipeline):
- `inbox_reply` — ids only, content never rides the job bus; the *same* prompt
  builder as the live lane, because both feed one durable conversation.
- `followup` — discriminated by **the conversation, not the debt**. Promise-backed
  → pre-check the promise is still open (answers "still open" on read failure,
  deliberately). Cart recovery → keyed on `triggeredBy === 'cart_recovery'`;
  this is the *only* seam carrying the basket snapshot, without which the model
  improvises "you left something in your cart". NBA nudge → owes the customer
  nothing; **silence is a real answer**.
- `case_update` — `conversationId` legally absent (a webhook can open a case on
  an order never discussed); threadless falls to the founder plane.

**New workflows to build** (founder plane), cadences already seeded per tenant
in their own timezone by dakio-api — Mastra holds no copy:
`pulse` (hourly 9–21, pri 9) · `morning_report` (06:00) · `night_ops` (02:00) ·
`weekly_strategy` (Mon 09:00) · `reflection` (01:00) · `cart_sweep` (every 4h) ·
`catalog_vision` · `courier_intervention` · `restock_check`.

**Never reach nova-mastra** — leased server-side inside the claim transaction:
the nine sweeps. They stay in the kind union as **routing tripwires**: a lane
reaching a model with an `undefined` prompt burns five failed attempts nightly,
forever.

### Two seam problems to solve, not paper over
1. **Kind-union drift**: dakio-api knows 21 kinds, the ported type has 17
   (missing four server sweeps). Harmless today since they never lease, but any
   `Record<JobKind, …>` router table will not be exhaustive over what the server
   can mint. Add them with tripwire bodies **or** make the router's default
   branch loud.
2. **`runCustomerTurn` takes a customer message**, but `inbox_reply` /
   `followup` / `case_update` are *system instructions to a turn*. There is no
   parameter for that today. Add a proper entry point — **do not pass the
   instruction as `message`**, or the classifier treats Nova's own instruction
   as customer speech.

---

## C. The pulse's sense layer — and the honesty problem

The prompt's real sequence: read unprocessed inbox events for awareness → mark
them processed (**bookkeeping → becomes code**) → detect anomalies → **no
critical findings ⇒ STOP, never spam the owner** → else act through gated tools
and file ONE consolidated report.

`detectAnomalies` reads seven domains. Against a real dakio tenant today:

| domain | status |
|---|---|
| inventory (days-of-cover, dead stock) | ✅ real |
| sales (revenue WoW) | ✅ real |
| carts (unrecovered) | ✅ real (the "prepared" half is always empty) |
| margin (under 25%) | ✅ real |
| supplier delay | ✅ real |
| **ads** (burn, CPA, ROAS) | ❌ route returns `campaigns: []` — connection status only |
| **courier** (on-time, RTO) | ❌ route returns `couriers: []` |
| **support** (unanswered tickets) | ❌ client-side stub returns `[]` |

**Verdict: build the pulse now on the four honest domains.** Do not claim the
other three.

Two of the gaps are worth closing *as product*, not plumbing:
- **Courier** — `CourierConsignment` + `Order.courierStatus/At` already hold
  months of per-parcel outcomes written every 5 minutes by `courierSync`. A read
  that aggregates on-time rate, average days and RTO per courier **is doc 07's
  Tier-2 "courier scorecard"**. One read serves the pulse *and* ships a founder
  feature.
- **Support** — dakio-api's `SupportTicket` is the *Dakio platform* desk
  (merchant↔Dakio), not the merchant's customer support. The honest fix is to
  re-point this domain at **cases + escalated inbox conversations**, never the
  platform ticket table.

### SENSE layer decision
**Grow `src/lib/snapshot.ts` into the sense layer; do not port `analytics.ts`.**
Reason: `snapshot.ts` already degrades per source (a failed read becomes one
"(unavailable)" line), while `detectAnomalies` uses a single `Promise.all` that
fails the entire scan on any one read failure — unacceptable for a loop meant to
run hourly forever.

Delta store: a sibling of `context-store.ts` — `nova_pulse_state` keyed by
store, holding per-product `{stock, velocity, daysOfCover, margin}`, supplier
delay, `revenue7d` vs prior, cart totals, and an inbox **cursor** (not a list).
COMPARE = which entries crossed a threshold; DECIDE only for departments whose
entries moved. The `observe()` + TTL cache is the right shape for the reads.

---

## D. The two never-run lanes — exact hook points

Both confirmed dark: nothing in either repo mints these rows. nova-ai's own
audit script says so in words: *"HONEST STATUS: that lane has NO PRODUCER."*

**`courier_intervention` ← delivery stagnation.**
Hook: `dakio-api/src/lib/novaJourney.js:2150`, where `tick(j,
'sweep.stagnation', …)` returns **true only when a transition actually
happened** — precisely the "this parcel just became at_risk" edge, already
deduped per journey per day. Thresholds already tuned (4 days sent, 48h
unchanged) and watched on `courierStatusAt`, the column added because
`courierSync` rewrites `courierStatus` on every poll so `updatedAt` reads fresh
on a parcel that has not moved in a week.
Mint `{kind:'courier_intervention', priority:3, dedupeKey:
'courier_intervention:<orderId>:<ymd>', department:'shipping', payload:{orderId,
journeyId, triggeredBy:'sweep.stagnation', riskReason:'delivery_stagnation'}}`.
⚠️ Do **not** import `PRIORITY_BY_KIND` from `routes/novaJobs.js` into the lib —
that closes an ES-module cycle the repo already documents as a boot-time
killer. Put the constant in the lib or hard-code 3 with a comment.
This settles doc 07 B3: the intervention *reads what courierSync already
wrote* — it does not re-poll.

**`restock_check` ← the restock_wait case.**
Hook: `dakio-api/src/lib/novaCase.js:487`, guarded on `!joined && kind ===
'restock_wait'`. The `joined` discriminator is already computed, and the
handler's own comment states the intent verbatim: *"a join must NOT enqueue a
second department job."* The seam was designed and never filled. Customers open
these cases **today** and nothing listens.
Mint `{kind:'restock_check', priority:5, dedupeKey:'restock_check:<caseId>',
department:'inventory', payload:{caseId, productId, conversationId, customerId,
triggeredBy:'case.opened'}}`.

Both mints land in a sweep/handler transaction, so they become claimable on the
next tick — the same latency `case_update` already accepts.

---

## E. Duties ↔ jobs — the missing link

**Today:** 72 duty keys (`<department>.<slug>`) shown to the founder as "what
Nova does per room, at what authority"; jobs know only their *department*. The
only join is a 10-value enum, so nothing connects a duty to the job that
fulfils it. The one live enforcement is that an **unknown** duty key refuses at
every tier, 100% of the time.

**Proposed:** `src/brain/registry.ts` — one `BrainLane` per kind carrying
`{kind, department, duties[], workflow?}`, typed against `DUTY_BY_KEY`.

Asserted in three places, cheapest first:
1. **Module load** — an unknown duty key throws at boot, not at 02:00 (same
   posture as the authority refusal).
2. **A two-way coverage eval** — every claimed duty exists in the roster (the
   exact bug doc 07 names, where a merge card shipped with no duty because its
   duty was never added); every roster duty is claimed by a lane, a front-office
   action, **or** an explicit `UNCLAIMED` array with a written reason. That
   array *is* the honest capability gap, reviewed like the existing
   `NEEDS_DOOR` list. It will be large on day one — that is the point.
3. **Runtime** — a brain workflow may only pass a `dutyKey` drawn from its own
   lane. That turns the registry from documentation into a capability bound: a
   pulse cannot quietly start pausing ad sets.

Keep this out of dakio-api: `departmentForJob` stamps a column at row creation
and stays server-side; the *duty claim* is about what the workflow does, so it
lives beside the workflow.

⚠️ **Prerequisite:** `src/store/duties.ts` is now a second source of truth
alongside nova-ai's copy, with the JSON seed mirroring whichever repo last
exported. Port `check-duty-seed-sync.ts` + `export-duty-seed.ts` **before**
building lane→duty links on an unverified roster.

---

## The build order (dependency-sorted)

1. Port the duty-seed sync scripts; restore `resetServiceTokenCache` /
   `MintOptions` (test seams the fleet + service-token evals need).
2. Add `department` to the ported `NovaJob`; reconcile the 17-vs-21 kind union.
3. Port `departmentForJob`, `tenantAppPrincipal`, `customerPrincipal`,
   `turnRunRecorder` (the NovaRun audit the phase gate requires).
4. **The dispatcher** as a Mastra scheduled workflow → fleet → per-tenant
   `claimDueJobs(10)` → router → `.then(complete, release)`. Per-tenant tokens.
5. `src/brain/registry.ts` + its coverage eval — *before* any lane workflow.
6. Grow `snapshot.ts` into SENSE; add the `nova_pulse_state` delta store; build
   the pulse on the four honest domains.
7. Wire the two dark lanes (D).
8. Port `evals/{jobs,fleet,night,duties}` — the phase gate.
9. Doc 06's resilience fix: dakio-api gets its own internal timer for the server
   sweeps (precedent: `courierSync`), so a Nova outage means "the brain is
   asleep", never "customers stopped hearing back."
