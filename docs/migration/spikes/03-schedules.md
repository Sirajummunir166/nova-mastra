# Spike 3 findings — Mastra schedules · ✅ PASSED (with one lesson)

**Question:** can a workflow declared with `schedule: { cron }` be fired by
Mastra's own in-process scheduler, persisted in Postgres — i.e. could the
brain's tick eventually be a Mastra schedule instead of a `setInterval`?

**Answer: yes — after one lesson.** Script: `spikes/03-schedules.ts`.

## What was tested

1. A workflow declared `schedule: { cron: "* * * * *" }`, Mastra on
   `PostgresStore`.
2. First run: **FAIL — nothing fired.** Declaring a schedule is not
   enough: the tick loop lives in Mastra's *workers*.
3. Added `await mastra.startWorkers()`. Second run: the cron fired at the
   next minute boundary (21:34:04 for the 21:34:00 slot — the scheduler
   ticks every 10s, so up to ~10s lateness is normal). **PASS.**

## What this means for the design

- **The decision doc 05 asked for:** the dispatcher loop stays (per-tenant
  claiming with per-tenant tokens is security design, not plumbing), but
  its *tick* can be a Mastra scheduled workflow instead of a bare
  `setInterval` — giving us Studio visibility and Postgres-backed schedule
  rows for free. Low risk either way; not urgent.
- **The operational lesson matters more than the feature:** in our
  production app, `@mastra/express`'s `server.init()` starts the workers —
  but any future worker-style process (a brain runner without the HTTP
  server) must call `mastra.startWorkers()` itself, or every schedule
  silently never fires. Silent is the dangerous part. Phase E's checklist
  gets this line.
- Scheduler granularity is 10s ticks, minute-level crons — same
  granularity as today's dispatcher. Fine for the brain; anything faster
  stays event-driven (as it already is).

## Notes

- Schedules can also be managed imperatively (`mastra.schedules.create/
  pause/resume/delete`) — useful later if founders get schedule controls
  that must apply without a deploy (dakio-api's cadence editing stays the
  source of truth for tenant job defs regardless).
