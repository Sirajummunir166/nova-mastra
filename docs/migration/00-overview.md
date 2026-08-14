# Nova on Mastra — the migration, from the top

> **How to read these docs.** Start here, then read 01 → 05 in order. Simple
> English on purpose. Every number in these docs is a real, measured number
> from production, with the file it came from. Nothing is a guess.

## What Nova is

**One founder, one employee, a successful business.** Nova is Dakio's AI
Business Operator — a digital employee per commerce store whose job is not
to talk, but to make the business succeed. It works 24/7: an hourly pulse
checks how the business is doing; each department works out its best next
move; Nova as CEO sets the top-level priorities; completed, pending and
scheduled work all live on one shared board; and while the founder sleeps,
Nova acts within its trust level, queues what needs the founder, and
schedules its own future check-ins. That proactive brain is the product —
designed in [doc 06](06-the-brain.md).

The brain has two *doors* where conversations happen:

- **The founder** (the store owner), in the merchant dashboard chatbox.
- **The customer**, in the Messenger/Instagram inbox — answering prices,
  taking orders, handling complaints.

Today Nova runs on the **eve** framework (repo `nova-ai`). We are moving it
to **Mastra** (repo `nova-mastra`). Same behavior outside. Much cheaper and
faster inside.

## Why we are moving — the numbers

These are from 7 days of real production traffic (2026-08-04 → 08-11),
measured in Langfuse (`nova-ai/docs/blueprint/17-commerce-context/05c-phase-1-baseline.md`):

| What | Measured |
|---|---|
| Model calls in 7 days | 6,504 |
| Cost in 7 days | **$272.70** |
| Tokens per model call | p50 **26,666** · p90 63,471 · max 116,485 |
| Tool JSON sent per customer request | **115,291 chars (~29K tokens)** — 62% of it founder tools the customer session is *forbidden* to call anyway |
| One customer reply, wall-clock | p50 **29.4s** · p90 41.4s |
| `get_conversation` re-reads per one delivered reply | **≈7.7×** |
| Worst incident | one broken job burned **$10–12** before hitting eve's 40M-token session cap |

("p50" means: half of all calls were at or below this number. "p90" means 90%
were at or below it.)

The important thing: **these costs are not bugs. They are eve's design.**
Doc 01 explains why. That is also why we cannot fix them inside eve — nova-ai
already tried (stub tools, caps, guards, session rolls) and the baseline
above is *after* those fixes.

## The goal, in one line each

1. **Identical behavior.** The merchant app and dakio-api must not notice the
   swap. Same protocols, same safety rules, same honesty rules.
2. **Small context per turn.** Each turn gets only the instructions and tools
   *that turn* needs. "Hello" gets zero tools.
3. **Model calls only where a model is needed.** Most of a sale has a known
   shape — code should walk it, and the model should only speak.

## The one rule that drives every design choice

> **If we can write the steps down before the conversation happens, it is a
> workflow. If we cannot, it is an agent.**

An **agent** lets the model decide the next step — and re-reads its whole
context on every step. That is where eve's cost lives.
A **workflow** is steps we wrote in code — the model is called only inside
the steps that truly need it, with a small, hand-built context.

Only one part of Nova truly needs an agent: the founder chatbox, because a
founder can ask anything. Almost everything else — the customer sale, the
jobs, the reports — has a known shape.

## The documents

| Doc | What it teaches |
|---|---|
| [01 — How eve works and what we built](01-how-eve-works-and-what-we-built.md) | eve's concepts, nova-ai's full inventory, and *why* the cost is structural |
| [02 — Mastra building blocks](02-mastra-building-blocks.md) | Every Mastra piece we will use, in simple English, with where Nova uses it |
| [03 — The map: eve → Mastra](03-eve-to-mastra-map.md) | Every eve concept and its Mastra answer — native, build-ourselves, or drop |
| [04 — Nova on Mastra: the design](04-nova-on-mastra-design.md) | The target architecture, lane by lane, with scenarios and token budgets |
| [05 — The migration plan](05-migration-plan.md) | Phases, each with a "prove it" gate, plus the spikes we run first |
| [06 — The brain](06-the-brain.md) | The 24/7 proactive engine — pulse, departments, the shared board — and why it gets *more* active on Mastra |

## What is already true on this branch

Not everything is future. Already built and verified in `nova-mastra`:

- The **eve/v1 wire protocol** the merchant chatbox speaks (sessions,
  continuation tokens, NDJSON streaming) — `src/eve-compat/`, with a smoke
  test that drives it exactly like the real client.
- **Per-turn tool selection by rules** — "hello" gets zero tools, a topic
  question gets that topic's tool — `src/tools/select.ts`, with tests.
- **Five read tools** over dakio-api, each capping and shrinking its output —
  `src/tools/store-reads.ts`.
- The **customer-turn workflow prototype** ("front office"): classify →
  hydrate → decide → write, where ~60% of turns need zero model calls —
  `src/front-office/`.
- A **one-command local stack** with a seeded demo store — `scripts/local-stack.sh`.

So the claim "this design works" is not only on paper — the two most
important patterns (per-turn tools, sale-as-workflow) already run.
