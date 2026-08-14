# 07 — The job atlas: what the brain actually does, reviewed

Three questions from the founder of this project, answered in order:
**(A)** do we understand what Nova does under each job — as a product, not
code? **(B)** which jobs repeat work and need review? **(C)** what is
missing that would make a founder unable to imagine a successful business
without Nova?

Grounded in three full reads: nova-ai's job prompts and skills, dakio-api's
seeded definitions and server sweeps, and the PRD Master Build vs the
capability matrix. File citations are in those sources; this doc speaks
product.

---

## Part A — The atlas

### One night at Nova (every store, every night, tenant timezone)

```
01:00  reflection        learns: turns today's rejections & outcomes into ≤10
                         traceable memories; corrects revenue estimates
01:30  night_shift*      grades: every department scored from real rows;
                         scorecard + plan board reconciled
02:00  night_ops         works: ads reviewed, purchase orders drafted,
                         tickets resolved, one content draft — using the grades
03:00  promise_sweep*    conscience: overdue promises marked broken → founder card
03:30  identity_merge*   housekeeping: duplicate customers → merge cards
04:00  conversation_     memory retention clock refreshed
       distill*          (fact-extraction half missing — see Part C)
04:30  journey_sweep*    customer journeys advance on time: stuck delivery →
                         at-risk, dormancy, repeat-purchase windows
05:00  inbox_attribution* honesty: chat-order revenue flips "estimated" →
                         "measured" only when the parcel truly delivered
06:00  morning_report    the face: 120 words max on the founder's phone —
                         what happened, what needs you, today's one move
```
`*` = model-free server sweep inside dakio-api. The others are model
turns. **The order is designed on purpose — it matters**: the morning
report *reads* reflection's "I learned…" note; night_ops *reads* the
grades night_shift wrote half an hour earlier; attribution runs after
journeys so that "measured" really means measured.

### The daytime

- **pulse** (hourly, 9:00–21:00) — the watchdog. Its designed success is
  *silence*: "no critical findings → stop, never spam the owner." Acts and
  files one report only when something is truly wrong. Lowest priority —
  under load it sheds first, correctly.
- **cart_sweep** (every 4h) — founder-plane cart recovery by email/SMS:
  personal messages naming the actual items; discounts a last resort (≤10%,
  big carts only); never contacts a cart the in-thread lane already nudged.
- **weekly_strategy** (Monday 9:00) — the CEO hour: goal pace, three things
  that worked and three that didn't (with numbers), three ranked moves, one
  new experiment, a plan board where DONE is *computed by the system, never
  claimed by the model*.

### Event-driven (no cadence — something happens, a job is minted)

- **inbox_reply** (priority 1, the fast lane) — fallback so no customer
  message is ever lost if live delivery fails.
- **followup** — the brain's own future check-ins, three producers, one
  discipline: promise repayment fires 30 minutes *before* the promised
  time; NBA nudges; in-thread cart nudges. Every one passes five fire-time
  re-checks: thread ownership, the Meta 24h window, staleness, quiet
  hours, the weekly touch budget. A customer writing back cancels a nudge —
  but never settles a promise.
- **case_update** — closes the loop in the customer's own thread. It
  re-reads the thread and the order *now*, because "a parcel can move
  again". Bad news is said plainly. No empty apologies, and no new promise
  unless a tool gave something real to promise.
- **catalog_vision** — gives Nova eyes: captions + embeds up to 100 product
  photos per run so customer-sent photos can be matched to products. One
  run = one billed task, enforced.

### Always-on loops (not jobs, same brain)

**courierSync** polls the couriers every 5 minutes and writes real delivery
states; **inboxSenderSweep** re-arms queued sends and enforces the promise
rule "an unsent promise was never made"; **inbox_sla_sweep** sends ONE
polite holding update when the founder sits on an escalated thread past its
SLA; **order_confirm_sweep** is the 20-minute backstop that confirms a chat
order the model somehow never confirmed.

### The two dark lanes — written, never run

- **courier_intervention** — do the founder's homework on a stuck parcel:
  last scan, dwell time, what the customer was told, *the one question to
  ask the courier* — honest that Dakio itself cannot reschedule a parcel.
- **restock_check** — answer a waiting customer honestly: a real PO date
  may be promised; nothing on order means "soon, and I'll tell you the
  moment it lands" — *"a date you made up is a second disappointment."*
  Three customers waiting = a restock decision for the founder.

Both have complete, well-designed prompts. **Neither has ever executed:
nothing in either repo creates a job of these kinds.** See Part B.

---

## Part B — The review: repeated work, honestly judged

Going in, I suspected merges (pulse/night_ops/morning_report;
cart_sweep/followup; three courier watchers). The evidence changed my mind
in places — most "overlap" turned out to be deliberate division of labor.
Verdicts:

**B1 · The cadenced six — KEEP ALL, restructure the cost.**
Each has a distinct product job and they compose into the night pipeline.
The problem is never *what* they do, it is that each is a full ~26K-token
agent turn. Doc 06's sense→delta→decide makes each a workflow. The
extreme case: **pulse runs 13×/day/tenant and is *designed* to usually do
nothing — under eve, ~13 full agent turns to decide "all quiet."** Under
Mastra a quiet pulse is zero model calls. Also: pulse currently spends
model steps marking inbox events processed — bookkeeping; becomes code.

**B2 · Cart recovery — NOT useless repetition, but the one place where
double work can really happen. UNIFY.** One abandoned cart is worked by
two lanes: an email/SMS lane and an in-chat nudge lane, with three
different places creating the work. The scenario that scares me: today the
two lanes avoid messaging the same customer twice only because one prompt
line says "skip carts that already have a conversation" — and the server
update that should also protect this was **never shipped**. Change that
prompt line by accident, and a customer gets the same nudge twice, from
the same store, in one evening. Migration fix: **one cart-recovery
workflow, two delivery arms, one shared "already contacted" list, all in
one place.**

**B3 · Courier watching — four watchers on one parcel. CONNECT, don't
add.** courierSync polls the couriers every 5 minutes; webhooks push
updates in; journey_sweep marks stuck deliveries "at risk" every night;
and courier_intervention would poll the courier *again* on its own. Mostly
this is healthy: one collects, one interprets, one investigates. But the
extra poll is waste — and courier_intervention never runs anyway (Part A:
no trigger). Fix both with one move: **the missing trigger already exists
as data.** When journey_sweep marks a delivery "at risk", start the
intervention workflow, reading the state courierSync already wrote. Same
for restock_check: start it when a customer opens a "waiting for restock"
case. Both dark lanes light up without any new machinery.

**B4 · Duties vs jobs — a gap nobody asked about, found while looking.
LINK THEM.** The founder sees a roster of 72 duties ("what Nova does in
each department, at what trust level"). The jobs do the actual work. But
**nothing connects a duty to the job that fulfils it** — the two systems
share only department names. Why this matters: it is exactly how a product
slowly starts *promising* things its machinery does not *do*. (It already
happens once: a merge card ships with no duty reference because its duty
was never added to the roster.) Migration rule: **every brain workflow
names the duty keys it serves.** Then "what Nova says it does" and "what
Nova actually does" become one checkable list.

**B5 · Two night_shifts — DELETE ONE.** dakio-api's night_shift is the
real grader; nova-ai also carries a `runNightShift` that is a canned demo
explicitly marked never-run-on-real-tenants. The migration ports the real
one and does not bring the name collision along.

**B6 · What I will not touch.** The honesty engine (inbox_attribution is
the *only* thing allowed to call revenue "measured"), the promise
lifecycle, the five checks before any followup fires, quiet hours and
touch budgets, the order-confirm and SLA backstops. This is mature,
model-free, and correct. It stays in dakio-api, unchanged.

---

## Part C — What's missing

Honest split. The PRD turned out to already name most of what I would have
proposed — so Tier 1 is *owed*, Tier 2 is *new*.

### Tier 1 — Promised by the PRD, not yet real (finish these first)

1. **The Stage-3 milestone itself**: night shift runs alone → 06:00 brief →
   founder approves → live result → undo, witnessed end-to-end by a
   non-builder. Machine-verified today, gate unsigned. *The PRD's own words:
   Nova isn't "working" until this passes.* Phase E's gate (doc 05) is this.
2. **The watchdog that reaches the founder** — spend spike / stockout /
   courier failure should *call or push*, not wait in a card. Engines
   built; real telephony/push missing.
3. **Seasonal playbooks, ≥3 weeks ahead, one approval runs the month** —
   this IS the Eid planner. Engine built; the bundle executor (the runner)
   missing. For a Bangladesh fashion store this is the single most
   impressive promise in the whole PRD.
4. **Real hands for night_ops' biggest moves.** Today, ad changes are
   propose-only (ads access is deliberately read-only; campaign writes are
   a named gap), and cart_sweep's email/SMS lane has **no send provider
   behind it**. So tonight, night_ops *describes* pausing a bleeding ad —
   but no ad is paused, and no email is truly sent. Until these connect,
   parts of the night are only words. Founders will notice sooner or
   later, and it will cost trust.
5. Smaller owed items: model-mode reflection (distiller is deterministic
   today), playbook promotion, memory transparency UI, and
   **conversation_distill's missing half** — the sweep refreshes memory
   clocks but extracts no facts (metered as `distill_unavailable`). Under
   eve, a model in that lane was unaffordable; under Mastra it is one tiny
   extraction step. *Cheapness retires this debt.*

### Tier 2 — Not in the PRD; my additions ("find money · prevent loss · see ahead")

Each uses data already in the schema, and each is designed as a founder
moment — one line in the morning report with a ৳ number and a receipt.

6. **The stockout money counter** (find money). Nova knows each product's
   sales velocity and stock. When a seller sits at zero, count the bleed:
   *"Oxford Shirt out of stock 4 days — that is ~৳9,000 not earned. PO
   drafted, needs your approval."* Turns restocking from a chore into a
   number that hurts. (Our own demo store has a sold-out product today.)
7. **RTO defense** (prevent loss). Per-order risk exists at order time;
   nobody looks at the *pattern*. Weekly: which areas, products and
   couriers drive returns, and the action — *"Kushtia COD returns 31%
   this month; propose advance-payment-only there. Est. save ৳6,500/mo."*
   COD returns are the silent killer of BD e-commerce; the store that
   fixes them credits Nova forever.
8. **The courier scorecard** (prevent loss). courierSync has months of
   per-courier outcomes; aggregate them: *"RedX averages 4.8 days to
   Sylhet, Steadfast 2.1 — switching Sylhet saves ~11 late parcels/mo."*
   Data collected for years, never once summed.
9. **Winback rhythm → a morning line** (find money). The machinery mostly
   exists (journey repeat-purchase windows + NBA + followups) — what is
   missing is the *product surface*: "3 regulars are past their usual
   reorder time, combined typical order ৳4,100 — nudges queued." Elevate,
   don't rebuild.
10. **Daily goal pace with the gap named** (see ahead). weekly_strategy
    paces goals weekly; the morning report should carry it daily with the
    driver: *"18% behind the month's goal; the gap is Polo restock ×
    ad fatigue."* Small addition to an existing report — large "my
    employee gets it" effect.
11. **Price & margin review** (find money). Cost, price and velocity are
    all known: monthly, name the underpriced fast-seller and the
    overpriced shelf-sitter, with the suggested move as a one-tap decision.

Deliberately NOT proposed: competitor/market watch (no data source —
would violate the never-fabricate floor) and social auto-posting beyond
the existing draft flow (brand risk before brand trust).

### The principle behind all of it

The morning report is Nova's face. Every job in this atlas earns its
place the same way: **one checkable line with a ৳ number in that brief** —
money found, loss prevented, or something seen ahead. Under eve, checking
was expensive, so Nova could not afford to check often. After the
migration (doc 06), checking is nearly free. So the brain can check
everything, all day — and speak only when it has a number worth saying.
That — not chat — is what makes a founder unable to imagine the business
without Nova.
