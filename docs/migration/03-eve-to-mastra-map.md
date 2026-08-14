# 03 — The map: every eve concept → its Mastra answer

One row per eve concept nova-ai actually uses. **Status** says how it lands:
- ✅ **native** — Mastra has it, we configure it
- 🔨 **build** — we write it ourselves (usually: we already did, or it's plain code)
- ♻️ **port** — nova-ai code that is framework-independent and moves almost as-is
- 🗑 **dissolve** — the problem stops existing in Mastra's shape

| eve concept (as nova-ai uses it) | Mastra answer | Status |
|---|---|---|
| One root agent (`defineAgent`) | Many agents/workflows; founder lane = one small agent | ✅ |
| Agent loop with per-session model choice | `agent.stream(msgs, {instructions, toolsets, maxSteps})`; model per call/plan | ✅ |
| Dynamic instruction layers (`defineDynamic`, alphabetical dirs, register gating) | A function per lane builds the prompt per call (`lib/context.ts` today) | 🔨 built |
| Two registers on one agent (`isCustomerSession` everywhere) | Two lanes = two code paths. No predicate, no gating | 🗑 |
| Tools (file name = tool name, all ship always) | `createTool` + **toolsets per call**; rules pick per turn (`src/tools/`) | ✅ + 🔨 built |
| `customer_scope.ts` stub-override hack (49 stubs) | Not needed — a customer workflow simply never receives founder tools | 🗑 |
| `CUSTOMER_SLIM_TOOLS` + `requireFounderSession` guards | The allowlist becomes "what the customer workflow imports". Server-side guards in dakio-api stay untouched | 🗑 / ♻️ |
| Durable sessions + continuation tokens (founder chat) | Protocol: our `src/eve-compat/` (built, smoke-tested). Durability: Memory threads on `@mastra/pg` | 🔨 built + ✅ |
| Durable customer sessions (`inbox:<conv>:<model>:<epoch>`) | Conversation state per `conversationId` in storage; the **epoch/session-roll stays** (dakio-api already owns it) | ✅ + ♻️ |
| Parking: `ask_question`, tool `approval` | `suspendSchema`/`resumeSchema` on tools & workflow steps → Decision rows in dakio-api | ✅ + 🔨 |
| Channels: `eve.ts` (founder JWT auth) | Express routes + `lib/dakio-jwt.ts` (built) | 🔨 built |
| Channels: `customer.ts` (HMAC ingress from dakio-api) | An Express route with the same HMAC contract (±5 min skew, 202/401/409) feeding the customer workflow | 🔨 |
| Channels: `internal.ts` (job routing) | Dispatcher hands jobs to workflows by kind; conversation-bound kinds load that conversation's state first | ♻️ + 🔨 |
| Channels: `trial.ts` (model trial run) | A parameter — workflows/agents take a model override per run | 🗑 mostly |
| Schedules (static cron) + dispatcher + `nova_jobs` leases | **Keep the dispatcher loop** (it's ours, it's good); jobs run workflows. Mastra Schedules = spike for the tick itself | ♻️ |
| Server sweeps (`promise_sweep`, `conversation_distill`, …) | Live entirely in dakio-api — **untouched by this migration** | ♻️ |
| 9 department subagents (own tools, fresh child sessions) | Mostly workflows wearing name tags; signature/department stays a field on the reply envelope (dakio-api already validates it) | 🗑 mostly |
| Skills (6; 5 flat + 1 dynamic) | Their *content* becomes workflow prompts (morning report, cart recovery…) — loaded exactly when that workflow runs, which is better disclosure than skills | 🗑 |
| Hook: `tenant-guard` (kill switch, tenant pinning) | Request auth: JWT/HMAC verify + per-request tenant status check *before* any lane runs | 🔨 |
| Hook: `turn-guard` (20-tool-call cap) | `maxSteps` on the founder agent; workflows are bounded by construction | ✅ / 🗑 |
| Session token limits, compaction 0.7 | Memory thread trimming + our own budget checks; the session roll stays as backstop | ✅ + ♻️ |
| `defineState` (barely used) | Working memory / workflow state | ✅ |
| Memory service (vector recall, reflection) → dakio-api `/agent-data/*` | Same service, same formulas, same dakio-api storage — called from workflows instead of eve layers | ♻️ |
| Store client (`StoreClient`, demo + dakio backends, service tokens) | Port it whole. Our four hand-rolled fetch files should collapse into it | ♻️ (important) |
| Evals: 39 `tsx` script suites | Port nearly as-is (they test lib functions + HTTP handlers) | ♻️ |
| Evals: 9 eve-harness `.eval.ts` | Rewrite against our HTTP surface + Mastra scorers | 🔨 |
| Langfuse tracing + PII redaction | Mastra observability + an output processor carrying the same redaction rules | ✅ + ♻️ |

## The three rows that deserve a warning

**1. Durability is the one thing eve did for free.**
eve made *every turn* a durable workflow — crash mid-turn, nothing lost.
Mastra gives us durable storage (`@mastra/pg`) and evented workflows, but a
plain `agent.stream` call is not a durable run. Our answer, honestly:
- Founder chat: acceptable — a crashed turn shows `turn.failed`, the founder
  retries; the token deliberately does not rotate on failure (already true
  in eve-compat).
- Customer turn: the workflow writes its state after each step (the
  front-office context store already does); a re-delivered message replays
  safely because dakio-api's `novaActionId` idempotency (at-most-once
  orders) exists *server-side* — the strongest guarantee survives anyway.
- Suspended approvals: must persist — that is exactly what storage-backed
  suspend/resume is for, and it is in the spike list (doc 05).

**2. The dispatcher stays.**
Per-tenant claiming through per-tenant tokens (never one cross-tenant
credential) is a *security* choice, not an eve artifact. We keep that loop
byte-for-byte where possible and only change what a claimed job executes.

**3. `StoreClient` should be ported early, not late.**
nova-mastra currently has four separate hand-rolled dakio-api fetch files
(`lib/store.ts`, `lib/snapshot.ts`, `front-office/dakio.ts`,
`tools/store-reads.ts`). nova-ai solved this years better: one `StoreClient`
interface with a live backend and a **seeded demo backend** — which is also
what makes evals runnable without a real store. Porting it is the first
"boring" task with compounding payoff.

Next: [04 — the design](04-nova-on-mastra-design.md) — lanes, scenarios,
and the before/after token math.
