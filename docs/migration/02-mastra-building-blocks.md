# 02 — Mastra building blocks, in simple English

This is the learning doc. Each block: what it is, a tiny code sketch, and
where Nova uses it. Grounded in the installed package (`@mastra/core` v1.57 —
we read its types and docs, not a blog post).

The deepest difference from eve, first:

> **eve is a framework for ONE agent per app. Mastra is a toolbox for MANY
> agents and workflows per app.**
>
> Nova's ugliest eve code exists only because of that "one": the customer/
> founder register checks, the stub tools, the 62% dead schema weight. In
> Mastra, the founder lane and the customer lane are simply **two different
> code paths**. The register problem does not get *solved* — it stops
> existing.

---

## 1. The Mastra instance — the registry

One object that holds your agents, workflows, storage, and observability.
Ours lives in `src/mastra/index.ts`. Express mounts it (`@mastra/express`),
which also gives us Studio at `/studio` and HTTP endpoints for every agent
and workflow — that part already runs.

## 2. Agent — when the model decides

```ts
const nova = new Agent({
  id: "nova",
  instructions: "base persona only",   // real instructions come per call
  model: gateway("anthropic/claude-sonnet-5"),
});
```

An agent is model + instructions + tools, looped: the model reads, acts,
reads again, until it answers. That freedom is exactly right for open-ended
questions — and exactly what made eve expensive everywhere else.

**Nova uses an agent for: the founder chatbox. Almost nothing else.**

Two per-call powers matter enormously:

- **`instructions` per call** — the system prompt is an argument, not a
  file. Our `novaInstructions(store, {snapshot})` already builds ~380 tokens
  per turn. This replaces eve's whole `defineDynamic` layer system with
  plain function calls.
- **`maxSteps`** — a built-in cap on loop steps. eve had no per-turn cap;
  nova-ai wrote a guard hook after a 39-tool-call runaway. Here it is a
  number in the options.

## 3. Tools and Toolsets — the fix for eve's biggest pain

A tool is the same idea as eve's (`createTool`: description + zod schema +
execute). The difference is **who gets it, when**:

```ts
await agent.stream(messages, {
  instructions: novaInstructions(store, { snapshot }),
  toolsets: pickedForThisTurn,   // ← per CALL. Absent = zero tools.
});
```

eve: every authored tool ships to every session, forever; removal is
impossible; nova-ai stubbed 49 tools to claw back tokens.
Mastra: **a turn has only the tools you hand it.** "Hello" gets none. A
stock question gets one. Our `src/tools/select.ts` already does this with
cheap rules — no model call to decide what the model gets.

And tenancy: our tools close over the `storeId` at build time. The model
cannot even *express* "read another store" — there is no parameter for it.

## 4. Workflow — when WE decide

```ts
createWorkflow({ id: "customer-turn", inputSchema, outputSchema })
  .then(classifyStep)     // rules first — no model for ~60% of turns
  .then(hydrateStep)      // fetch product/stock in code
  .then(decideStep)       // pick the action — code, not model
  .then(writeStep)        // ONE small model call words the reply
  .commit();
```

A workflow is steps written in code. Deterministic order, typed data between
steps, branching, and **a model call only inside steps that need one** —
with a context we built by hand for that step.

**Nova uses workflows for: the customer sale, every scheduled job, the
daily brief, and most "departments".** The front-office prototype in
`src/front-office/` is this exact shape and already runs in Studio.

Why this kills the 7.7× problem: eve's agent re-read the conversation via a
tool on every loop step. A workflow hydrates the thread **once**, in code,
and each model step sees only the ~120-token state card we hand it.

## 5. Suspend & resume — the approval gate, native

Tools and workflow steps can declare `suspendSchema`/`resumeSchema`: the
execution **pauses**, durably, and continues when someone answers.

This is eve's parking (`ask_question`, tool `approval`) — but usable inside
workflows too. Nova's flow becomes:

1. Customer confirms the order → `create_order_from_chat` step **suspends**.
2. The suspend payload becomes a Decision card in dakio-api (same rows,
   same founder UI as today).
3. Founder taps Approve → we **resume** with the approval → the step places
   the order via dakio-api (which prices every line itself — unchanged).

Same safety, same UI, less machinery: the "unsatisfiable without
`confirmedByCustomer: true`" schema trick ports as-is.

## 6. Memory & Storage — conversations that survive restarts

- **Memory** (`@mastra/core/memory`): conversation **threads** (per
  founder, per customer conversation) plus **working memory** — a small
  structured note the runtime keeps updated ("customer wants: panjabi,
  size M, Sylhet"). That note is the same idea as our front-office Live
  Context card, and the same idea nova-ai's ~120-token "state brief" proved.
- **Storage** (`@mastra/pg`): persists threads/state/suspended runs to
  Postgres — **the same Postgres Dakio already runs**. This closes our
  branch's honest gap ("sessions die with the server") and replaces eve's
  hidden workflow-state world with tables we can read.
- `@mastra/pg` also does **vector storage** — relevant later for semantic
  memory recall (nova-ai scores `0.6·cosine + 0.25·recency + 0.15·weight`;
  that formula is ours and ports as plain code).

Business truth (orders, decisions, memory-of-record) **stays in dakio-api**,
exactly as today. Mastra storage holds only conversation mechanics.

## 7. Schedules — cron without a dispatcher hack?

`@mastra/core/schedules` schedules agents *and* workflows (cron per entry,
managed at runtime — not one static file per cron like eve).

Honest note: this module is newer and we have not exercised it yet. And
nova-ai's dispatcher (claim jobs per tenant from dakio-api, with leases and
backoff) is *good* framework-independent code. So the plan (doc 05) keeps
the dispatcher loop and only swaps what a job *runs* — a Mastra workflow
instead of an eve agent session. Mastra Schedules is a spike, not a bet.

## 8. Processors — guards on the pipe

Input/output processors wrap the model call: trim history, filter tool
chatter, mask PII, enforce budgets. This is where eve-hook-style guardrails
live when they are about the *stream* (nova-ai's Langfuse PII redaction has
a natural home here). Tenant pinning and the kill switch stay in ordinary
request auth — they were never really "hooks", eve just had no other seam.

## 9. Scorers / Evals — grading answers

Mastra has native scorers (can attach to agents, run on traces). nova-ai's
real eval treasure — 39 framework-independent `tsx` suites — ports as-is;
scorers add the model-judged layer (grounding: "did Nova invent a number?")
on top. The 9 eve-harness evals get rewritten against our HTTP surface.

## 10. Studio & Observability — already running

Studio at `/studio` (agents, workflows, traces) — we already host it, gated
by `NOVA_STUDIO_TOKEN`. Every workflow step and model call is traced; this
replaces "grep Langfuse and guess" with "look at the step timeline". The
customer-turn workflow already returns per-step `timings` — that discipline
stays.

## The shelf — real features we are deliberately NOT using yet

| Feature | What it is | Why not now |
|---|---|---|
| Vector / RAG | semantic search over documents | Later: FAQ/policy answers, product photo matching. Needs the memory base first. |
| Voice / TTS | speech in/out | The ElevenLabs lane comes after text parity. |
| MCP | connect external tool servers | Nova's tools are all dakio-api; no third-party tools yet. |
| A2A / agent-network | agent-to-agent protocols, dynamic routing | Departments become workflows first (doc 04); revisit only if a real second agent appears. |
| Durable agents | background agents surviving restarts | Evented workflows cover our job shapes; simpler. |
| Skills | progressive-disclosure instruction packs | Our per-turn instruction assembly is already smaller than a skill system. Revisit if instructions grow. |

Next: [03 — the map](03-eve-to-mastra-map.md), where every eve concept gets
its Mastra answer on one page.
