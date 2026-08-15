# 01 — How eve works, and what Nova built on it

This doc is the honest inventory. Two halves: what the **eve framework**
gives us, and what **nova-ai** built with it. Then the important part: *why*
the token cost is baked into eve's shape, not a bug we could patch.

Sources: eve's own docs (`nova-ai/node_modules/eve/docs/`) and the nova-ai
code. Every claim cites a file.

---

## Part A — eve in one page

eve is a framework for **one durable agent per app**. You describe the agent
with files in fixed places, and eve runs it:

| You put a file in… | eve turns it into… |
|---|---|
| `agent/agent.ts` | The agent: model, limits, compaction (`defineAgent`) |
| `agent/instructions.md` + `agent/instructions/*` | The system prompt, layers combined alphabetically |
| `agent/tools/<name>.ts` | One tool; the **filename is the tool's name** |
| `agent/channels/<name>.ts` | An HTTP edge (routes, auth, delivery) |
| `agent/schedules/<name>.ts` | A cron job — **one static cron, per deployment, not per tenant** |
| `agent/subagents/<dept>/` | A department: its own agent + instructions + tools, shown to the root model as one tool |
| `agent/skills/<name>.md` | A skill: description always advertised, body loaded on demand |
| `agent/hooks/<name>.ts` | Event listeners; a hook that **throws** fails the turn (nova-ai uses this as a guard) |

Key mechanics that shaped everything nova-ai built:

- **Sessions are durable.** Every turn runs as a durable workflow; a session
  has a `continuationToken` that rotates every turn. Completed steps replay
  instead of re-running. This is eve's best feature — crash-safe
  conversations for free.
- **Dynamic = resolve, never remove.** Instruction layers, tools and skills
  can be *resolved* per session/turn (`defineDynamic`), and a dynamic tool
  can *override* an authored tool by name — **but nothing can remove a tool
  from the schema payload.** Every authored tool ships to every session.
- **The agent loop.** A turn is: model reads context → picks a tool → result
  is appended → model reads context *again* → … Every step re-reads
  everything, including all tool schemas.
- **Parking.** A tool can require approval, and a built-in `ask_question`
  pauses the turn durably until a human answers (`input.requested` →
  `session.waiting`).

---

## Part B — what nova-ai built (the full surface)

This is what "identical behavior" must cover. Counts from the repo walk:

**4 channels** (`agent/channels/`):
- `customer.ts` — dakio-api pushes each customer message here (HMAC-signed,
  ±5 min clock skew). Session key `inbox:<conversationId>:<model>:<epoch>` —
  the *epoch* is the "session roll": when a thread grows too big, dakio-api
  bumps the epoch and Nova starts a fresh session on the same conversation.
- `eve.ts` — founder chatbox auth: verifies the merchant's Dakio JWT;
  tenancy comes **only** from the token.
- `internal.ts` — receives dispatched jobs. `inbox_reply` / `followup` /
  `case_update` jobs rejoin the customer's durable session; other jobs get a
  throwaway `job:<id>` session.
- `trial.ts` — admin lane to test a new model on one real turn before the
  fleet uses it.

**67 callable tools + 2 meta files** (`agent/tools/`): ~30 reads, ~37 writes.
The 2 meta files are eve workarounds, and they matter:
- `agent.ts` — *disables* eve's built-in self-clone tool.
- `customer_scope.ts` — overrides ~49 founder tools with ~120-byte refusing
  stubs for customer sessions. Why: eve cannot remove tools, and the founder
  tools' schemas alone were **71K chars of dead weight on every customer
  call** (`agent/tools/customer_scope.ts:13-17`).

**Customer tool allowlist** — `CUSTOMER_SLIM_TOOLS` (18 tools,
`agent/lib/customer/session.ts`). Every founder tool also has a runtime guard
(`requireFounderSession`) — the stub is an optimization *in front of* the
gate, never the gate. An eval walks the tools directory and proves list and
guards agree.

**The two-register instruction system** (`agent/instructions/`): one agent
must serve two different jobs, so every layer is gated on "is this a customer
session?":
- Founder register: `05-founder-core` (role), `10-tenant-profile` (~400
  tokens, cached 24h), `20-live-ops` (~300 tokens, rebuilt every turn),
  `30-memory` (~500 tokens, vector recall), `40-routing` (department table).
- Customer register: `50-customer-inbox` — the shopkeeper playbook,
  **~3.7K tokens**, with numbered HARD RULES (rule numbers are frozen; evals
  cite them).

**9 department subagents** (`finance`, `growth`, `inventory`, `marketing`,
`operations`, `product_research`, `sales`, `shipping`, `support`) — each with
its own instructions and its own copies of 5–12 tools. A delegation spawns a
fresh child session that re-reads its own full context.

**2 guard hooks**: `tenant-guard.ts` (kill switch + tenant pinning — throws
before any model spend) and `turn-guard.ts` (max 20 tool calls per customer
turn — added after a runaway did 39).

**1 schedule + the job system.** eve crons are static and per-deployment, so
nova-ai built its own: a single every-minute dispatcher that, per active
tenant, claims due jobs from dakio-api (`nova_jobs` rows) and routes them.
Model-turn job kinds: `morning_report`, `pulse`, `cart_sweep`, `night_ops`,
`weekly_strategy`, `reflection`, `inbox_reply`, `followup`,
`courier_intervention`, `case_update`, `restock_check`, `catalog_vision`.
Server-sweep kinds (run entirely inside dakio-api, model-free):
`promise_sweep`, `identity_merge_sweep`, `conversation_distill`,
`journey_sweep`, `inbox_attribution`.

**Memory.** Nova has **no database of its own** — every durable thing lives
in dakio-api behind `/api/v1/agent-data/*` (memory with embeddings, actions,
decisions, activity, reports, jobs). The memory service does vector recall
(`0.6·cosine + 0.25·recency + 0.15·weight`, top-8) and a nightly
"reflection" distills the day into ≤10 semantic memories.

**Evals.** 48 files. Only 9 use eve's eval harness; the rest are plain
`tsx` scripts asserting on lib functions and channel handlers — **framework-
independent, so they port to Mastra almost as-is.** They protect the rules
that matter: tenant isolation, the customer tool gate, grounded numbers,
PII, the approval ladder, HMAC auth, lease semantics.

---

## Part C — why the cost is structural

This is the section that explains why we migrate instead of patch.

**1. One agent per app → the register problem.**
eve gives you exactly one root agent. Nova needs two very different workers
(founder assistant, customer shopkeeper). So every instruction layer, every
tool, every skill carries an "am I in a customer session?" check, and the
schemas of the wrong register still ship on every call. The 62% dead tool
JSON *is* this design. In production: **115,291 chars of tool JSON per
customer request** (`customer_scope.ts:13-17`) — and that is *after* the
stub optimization.

**2. The agent loop re-reads everything, every step.**
A customer reply averages several steps, and `get_conversation` (the
mandated first tool, up to 50 messages + customer profile) is re-read
**≈7.7× per delivered reply** (`05c-phase-1-baseline.md`). A single broken
job looped ~150 steps re-reading a ~51K-token prompt each step, and stopped
only at the **40M-token session cap: $10–12 for one job**
(`agent/agent.ts:16-29`). Another runaway: **66 model calls, 39 tool calls,
17.5 minutes**, prompt growing 47K → 114K until the provider refused
(`agent/hooks/turn-guard.ts:5-11`).

**3. Sessions only grow.**
A durable inbox session grew **~9.7K tokens per turn — 26,949 → 114,972 over
ten turns** (`docs/prd/capability-matrix.md`). The fix (dakio-api bumps an
"epoch" to roll the session) is a workaround for context eve keeps by
default and nova-ai cannot trim precisely.

**4. Model calls where no model is needed.**
"Customer picked size M" is a state update. In eve, the only way to handle
*any* message is a full agent turn against the full register. The blueprint's
own target was "a state-known reply under ~2s" — while a *single* eve model
call already costs p50 2.0s, and a full customer turn **p50 29.4s**.

**5. Scheduling was rebuilt outside the framework anyway.**
The dispatcher/job system deliberately uses eve for nothing but a
once-a-minute tick. That code is framework-independent — which is good news:
it ports cleanly.

**What eve gave us that we must not lose:** durable conversations,
per-tenant service auth, the approval/parking flow, the honesty rules, and
the eval discipline. The next doc shows where each of these lives in Mastra.
