# 04 — Nova on Mastra: the design

The whole system on one page, then each lane, then the scenarios with real
token math. This is the doc that has to convince you.

## The big picture

```
                         ┌──────────────────────────────────────────────┐
 merchant app ── eve/v1 ─▶  FOUNDER LANE      one small AGENT           │
 (NovaChat)                │  per-turn instructions + rule-picked tools │
                           ├──────────────────────────────────────────────┤
 dakio-api ── HMAC push ──▶  CUSTOMER LANE    the sale WORKFLOW         │
 (inbox events)            │  rules → hydrate → decide → write          │
                           ├──────────────────────────────────────────────┤
 dispatcher (1-min tick) ─▶  JOB LANE         one WORKFLOW per job kind │
                           │  morning report · cart sweep · night ops…  │
                           ├──────────────────────────────────────────────┤
                           │  SHARED FLOOR                               │
                           │  StoreClient (dakio-api, per-tenant tokens) │
                           │  Memory + @mastra/pg (threads, suspends)    │
                           │  suspend/resume → Decision rows (approvals) │
                           │  processors (PII, budgets) · Studio traces  │
                           └──────────────────────────────────────────────┘
```

Three lanes, one shared floor. No lane can see another lane's tools —
not because a guard blocks it, but because the code never hands them over.

What does **not** change, at all:
- dakio-api stays the system of record (orders, decisions, memory, jobs).
- The server prices every order line; Nova never sends a price.
- Tenancy comes only from verified tokens; tools close over one `storeId`.
- The wire protocols: eve/v1 for the chatbox, HMAC push for the inbox,
  `nova_jobs` leases for jobs. **The merchant app and dakio-api must not
  notice the swap.**
- The honesty rules: numbers come from tools/data, never memory; unavailable
  sources are said out loud; the numbered HARD RULES keep their numbers.

---

## Lane 1 — Founder chatbox (the only real agent)

**Why an agent:** the founder can ask anything. This is the one place we
cannot write the steps down in advance.

**How a turn runs** (most of this is already on the branch):

1. Verify the merchant JWT → `storeId` (tenancy pinned; kill switch checked).
2. Build instructions **for this turn**: persona + store profile + CEO
   snapshot (live numbers, aggregated server-side) ≈ **380 tokens**.
3. **Rules pick the toolsets** (`src/tools/select.ts`): opener → none;
   topic → that topic's tool; unclear → all five reads (~2K tokens of
   schemas, vs eve's ~29K).
4. `agent.stream(history, { instructions, toolsets, maxSteps: 8 })`.
5. Tool calls stream to the UI as narration events (built); the reply
   streams as deltas (built).
6. The thread persists via Memory + `@mastra/pg` (phase B).

**Budget per turn:** worst case ≈ 3–6K input tokens. eve founder baseline:
p50 26.6K. **~5–8× smaller before any model even answers.**

## Lane 2 — Customer inbox (the sale is a workflow)

**Why a workflow:** a sale has a known shape. The customer picks a product,
a variant, a quantity, gives address + phone, confirms. Bengali, Banglish or
English — the *shape* is the same. The front-office prototype
(`src/front-office/`) already walks it.

**How one message runs:**

```
dakio-api ──HMAC──▶ ingress route (same contract as eve's customer.ts)
                        │
                 load conversation state (one read — not 7.7 re-reads)
                        │
                 L0: rules classify        ~60% of turns END here:
                 (sizes, qty, phone,       state update + templated/
                  confirms, greetings)     writer reply, 0–1 model calls
                        │ miss
                 L1: resolver (small model, JSON only: intent + entities)
                        │
                 hydrate: product/stock/price via StoreClient (code)
                        │
                 decide: next best action (code + guardrails)
                        │──── needs approval? ──▶ SUSPEND → Decision card
                        │                          founder approves → RESUME
                 write: ONE model call words the reply
                 (~120-token state card in, ~60 tokens out)
                        │
                 reply_in_thread via dakio-api · state saved · trace done
```

**The invariants ride along unchanged:** `confirmedByCustomer: z.literal(true)`
(the schema is impossible to satisfy without real confirmation), server-side
pricing, `novaActionId` idempotency, the RTO/risk guardrails, PII masking.
The ~3.7K-token shopkeeper register shrinks to: hard rules that are *code*
in the decide step (most of them are "never do X" — code does not need to be
told twice), plus a short persona block for the writer call.

**Budget:** a state-known turn ≈ **0 model calls**; a resolver turn ≈ one
small-model JSON call + one ~400-token writer call. eve customer baseline:
~29K tool JSON + register on every call, several loop steps, p50 29.4s.
Target: state-known reply well under 2s, live-lookup reply in the 2–4s a
single writer call costs.

## Lane 3 — Jobs (scheduled workflows)

The dispatcher loop ports as-is (per-tenant claims, leases, backoff). What
changes is only what a claimed job *runs*:

| Job kind | Was (eve) | Becomes |
|---|---|---|
| `morning_report` | agent turn with a skill + full register | workflow: gather numbers in code → one writer call |
| `cart_sweep` | agent turn | workflow: list carts (code) → guardrail check → one writer call per message → suspends if approval needed |
| `inbox_reply` / `followup` / `case_update` | rejoin durable eve session | run the **customer workflow** with that conversation's state |
| `night_ops`, `weekly_strategy` | long agent sessions | evented workflow: analysis in code, model only for judgment steps |
| `reflection` | agent + skill | port the existing service (it's already mostly deterministic code) |
| server sweeps | dakio-api | dakio-api — untouched |

Departments: a job's output keeps its department signature (`sales`,
`inventory`…) as **a field**, validated by dakio-api exactly as today. The
9 subagent directories with copied tools do not come along — a department
whose steps we can write down was always a workflow with a name tag.

## Departments (cross-cutting) — no subagent per department

Taken apart, an eve "department" is three separate things:

1. **A signature** — the "— Sales" tag on a reply. dakio-api validates it as
   a plain field (`NOVA_DEPARTMENTS`, `novaChat.js`); the UI renders it.
   Stays as data.
2. **A scoped set of reads** — marketing questions need campaign data. In
   eve, giving a context *fewer* tools required a subagent — that was the
   only scoping mechanism. In Mastra, **toolsets already scope per turn**,
   so this reason for subagents disappears.
3. **Procedures** — "evaluate the campaign", "plan the week". Known shape →
   workflows.

**A department question in the chatbox** ("Marketing kemon cholche? Ad
spend beshi hoye jacche?"):

- eve today: root agent (full ~26K register) → routing layer → `marketing`
  subagent tool → a **fresh child session** re-reads its own full context
  (subagents inherit nothing) → child agent-loops over 12 tools → returns →
  root re-reads everything and wraps. **Two full agent contexts** for one
  question.
- Mastra: the **same one founder agent**, wearing marketing's hat for this
  turn — rules attach the marketing read-toolset instead of the default
  five, and the turn's instructions add one line: *answer as Marketing,
  sign `— Marketing`*. One small context (~3–4K tokens). The founder sees
  the same signed, grounded answer.

**When the department must *do* something** (not just answer): a workflow is
exposed to the agent **as a tool** — a tool's `execute` simply runs the
workflow and returns its typed result. "Which campaigns should I kill?"
becomes: agent calls `run_campaign_analysis` → workflow fetches + computes
(code; nova-ai's reach math ports as-is) → one small judge call → agent
words the result and signs it. The agent stays small; the heavy lifting
runs at workflow prices.

**Dept rooms and daily briefs in the merchant UI** never talked to a live
department — they read rows jobs wrote into dakio-api. Those jobs become
workflows writing the same rows; the UI does not notice.

**The escape hatch:** if a future department genuinely needs open-ended
multi-step reasoning a workflow cannot express, Mastra supports real
sub-agents (and agent networks — doc 02's shelf). The rule: a department
must **earn** a second model loop with evidence. In eve the default was the
opposite — nine departments each got one whether they needed it or not.

## The approval gate (cross-cutting)

One pattern everywhere a write is risky:

1. The step/tool **suspends** with a typed payload (what, for whom, why).
2. The suspend payload is written to dakio-api as the same Decision row the
   founder already sees today (card UI unchanged).
3. Approve → **resume** with the answer → the write executes.
4. Reject → resume with rejection → the lane says so honestly.

Autonomy levels stay data in dakio-api: "T2 for discounts" just means the
decide step skips suspension for that action class. The trust plane
(`configure_autonomy`) remains founder-only — it is a founder-lane tool, so
the customer lane *cannot contain it*.

---

## Scenarios — before and after

**S1 · Founder: "hello"**
- eve: full founder register + 67 schemas ≈ 26K+ tokens, agent loop, seconds.
- Mastra: snapshot already in instructions, **zero tools**, one call,
  ~1.7K in / ~200 out. *Status: built, measured on the branch.*

**S2 · Founder: "which orders are pending?"**
- eve: same 26K+ context; model picks `get_orders` among 67.
- Mastra: rules attach only `get_orders` (~400-token schema); one tool call
  (capped, projected rows); one answer. ~3K in total. *Status: built —
  awaiting a model credential to measure end-to-end.*

**S3 · Customer: "panjabi ta koto?"**
- eve: `get_conversation` (up to 50 messages + 360 + NBA) → think → maybe
  re-read → reply. ~29K tool JSON + 3.7K register, p50 29.4s.
- Mastra: L0 matches "panjabi" against the catalog (code, already works on
  the demo store) → price+stock hydrated → writer call words one Bangla
  line. **One small model call.** *Status: prototype runs in Studio.*

**S4 · Customer: "M size, 2 ta" then "confirm"**
- eve: two more full agent turns.
- Mastra: two state updates by rules (**0 model calls**), then the confirm
  runs the order step → suspends → founder's Decision card → approve →
  order placed by dakio-api at server prices. *Status: designed; suspend is
  the phase-D spike.*

**S5 · 2 AM: cart sweep for 40 tenants**
- eve: 40 agent sessions, each with the full register.
- Mastra: 40 small workflow runs; model calls only for tenants with carts
  worth messaging, one short writer call each. *Status: designed.*

**S6 · A runaway** (the $10–12 incident, replayed)
- eve: 150 steps × ~51K cached prompt until a 40M session cap.
- Mastra: founder lane dies at `maxSteps: 8`; customer lane *cannot* loop —
  a workflow has exactly the steps we wrote; a job retries only per the
  dispatcher's lease/backoff contract. The failure mode is deleted, not
  capped.

---

## What could go wrong (so we watch it)

- **Losing eve's per-turn durability** — covered honestly in doc 03; the
  strongest guarantees (order idempotency, session roll) live server-side
  and survive regardless.
- **Rules mis-route a turn** (starve the founder agent of a tool, or L0
  misreads a customer). Mitigation: unmatched always widens (founder), the
  resolver rung exists (customer), selection reasons are logged, and the
  eval corpus replays real conversations.
- **The writer call drifts off-persona** without the big register.
  Mitigation: persona block stays in the writer prompt; the brand-voice
  evals port; scorers grade grounding on traces.
- **Suspend/resume through our own eve/v1 protocol** needs a careful join
  (a suspended customer turn must not block the thread). That is spike #1.

Next: [05 — the plan](05-migration-plan.md), where each phase has a gate
that must go green before the next starts.
