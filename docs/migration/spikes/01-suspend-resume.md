# Spike 1 findings — suspend/resume in Postgres · ✅ PASSED

**Question:** can the approval gate work the way doc 04 designed it —
a workflow step pauses with a typed payload, waits in Postgres, and a
completely different process resumes it later with the founder's answer?

**Answer: yes, first try, both directions.** Script: `spikes/01-suspend-resume.ts`.

## What was tested (the real order-approval shape)

1. A workflow with two steps: `approval` (has `suspendSchema` +
   `resumeSchema`) then `place`.
2. **Process 1** starts the run. The step calls `suspend({reason,
   customerName, orderTotal})`. Run status: `suspended`. Process exits.
3. The suspended run sits in Postgres — table `mastra_workflow_snapshot`,
   one row per run, holding the full state.
4. **Process 2** (fresh Node process, hours could pass) rebuilds the run
   handle from just the `runId` — `wf.createRun({ runId })` — and calls
   `run.resume({ step: "approval", resumeData: { approved: true,
   approver: "founder" } })`.
5. The step continues from where it stopped, the next step runs, final
   output: `ORDER PLACED (approved by founder)`. Status: `success`.
6. Reject path tested the same way on a second run:
   `order NOT placed (rejected by founder)`. Status: `success`.

## What this means for the design

- **The suspend payload is the Decision card.** It is typed (zod), so the
  card's content (what, for whom, why) is a schema, not loose text.
- **The resume payload is the founder's answer**, also typed.
- Resume works from any process that has the Mastra instance + the runId —
  so the flow "customer confirms → suspend → Decision row in dakio-api →
  founder taps Approve in the dashboard → dakio-api calls nova-mastra →
  resume" needs nothing exotic: the Approve endpoint just calls
  `resume(runId, answer)`.
- Survives restarts by construction: the state lives in Postgres, not in
  the process. (Process 2 proved this — it shared nothing with process 1.)

## Notes / small facts learned

- `@mastra/pg`'s `PostgresStore` auto-creates its tables on first use
  (~40 `mastra_*` tables; the one that matters here is
  `mastra_workflow_snapshot`).
- The step's `execute` sees `resumeData` as `undefined` on the first pass
  and filled after resume — one function, two passes, clean to read.
- `return await suspend(payload)` is the whole parking call.
- Nothing here needed a model or a network — the gate is pure machinery.

## Follow-up for phase D (not blockers)

- Decide the resume trigger path precisely: dakio-api Decision executor →
  HTTP call to nova-mastra (mirror of today's flow, recommended) vs
  nova-mastra polling decisions. Recommendation: HTTP push, same as the
  merchant app's other calls.
- Timeout policy: what happens to a suspended run the founder never
  answers (expire after N days → auto-reject + polite close in the
  thread). Mastra suspend accepts options; policy is ours to define.
