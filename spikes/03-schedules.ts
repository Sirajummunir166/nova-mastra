/**
 * Phase 0 · Spike 3 — can Mastra's own scheduler replace the dispatcher tick?
 *
 * Question: a workflow declared with `schedule: { cron }` — does Mastra fire
 * it on time from an in-process scheduler, persisted in Postgres?
 *
 * What this decides (doc 05 phase 0): the brain KEEPS nova-ai's per-tenant
 * job dispatcher (leases, backoff, per-tenant tokens — that part is security
 * design). The question here is only whether the *tick* that drives it can be
 * a Mastra schedule instead of a setInterval.
 *
 *   npx tsx spikes/03-schedules.ts    → waits ~90s for a `* * * * *` cron to fire
 */

import { Mastra } from "@mastra/core";
import { PostgresStore } from "@mastra/pg";
import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";

const DB = process.env.SPIKE_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/mastra_spike";

let fires = 0;

const tickStep = createStep({
  id: "tick",
  inputSchema: z.object({}).passthrough(),
  outputSchema: z.object({ firedAt: z.string() }),
  execute: async () => {
    fires += 1;
    const firedAt = new Date().toISOString();
    console.log(`  TICK #${fires} fired at ${firedAt}`);
    return { firedAt };
  },
});

const tickWorkflow = createWorkflow({
  id: "spike-tick",
  inputSchema: z.object({}).passthrough(),
  outputSchema: z.object({ firedAt: z.string() }),
  // Declarative schedule — the thing under test.
  schedule: { cron: "* * * * *" },
})
  .then(tickStep)
  .commit();

const mastra = new Mastra({
  storage: new PostgresStore({ id: "spike-sched", connectionString: DB }),
  workflows: { "spike-tick": tickWorkflow },
});

// The lesson of this spike's first FAIL: declaring a schedule is not enough.
// The tick loop lives in Mastra's workers, started by `startWorkers()` —
// which @mastra/express's `server.init()` does in our production app, but a
// bare script (or a cron-less worker process) must do itself.
await mastra.startWorkers();

console.log(`started ${new Date().toISOString()} — waiting up to 90s for the minute cron…`);

const deadline = Date.now() + 90_000;
while (Date.now() < deadline && fires === 0) {
  await new Promise((r) => setTimeout(r, 2_000));
}
// Give a fire in progress a moment to log.
await new Promise((r) => setTimeout(r, 3_000));

if (fires > 0) {
  console.log(`PASS — schedule fired ${fires}× from the in-process scheduler.`);
  process.exit(0);
} else {
  console.log("FAIL — no fire within 90s. Scheduler may need explicit enabling or a worker.");
  process.exit(1);
}
