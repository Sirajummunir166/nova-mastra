/**
 * Phase 0 · Spike 1 — the approval gate's foundation.
 *
 * Question: can a Mastra workflow step SUSPEND with a typed payload, have
 * that suspended run PERSIST in Postgres, and be RESUMED by a completely
 * separate process (simulating the founder tapping Approve hours later)?
 *
 * This is throwaway code. It models the real flow shape-for-shape:
 * a chat order that needs founder approval before it is placed.
 *
 *   npx tsx spikes/01-suspend-resume.ts start          → prints runId, exits SUSPENDED
 *   npx tsx spikes/01-suspend-resume.ts resume <runId> → new process, approves, completes
 *   npx tsx spikes/01-suspend-resume.ts reject <runId> → new process, rejects, completes
 */

import { Mastra } from "@mastra/core";
import { PostgresStore } from "@mastra/pg";
import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";

const DB = process.env.SPIKE_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/mastra_spike";

// The suspend payload IS the Decision card's content — what, for whom, why.
const suspendSchema = z.object({
  reason: z.string(),
  customerName: z.string(),
  orderTotal: z.number(),
});
// The resume payload IS the founder's answer.
const resumeSchema = z.object({
  approved: z.boolean(),
  approver: z.string(),
});

const approvalStep = createStep({
  id: "approval",
  inputSchema: z.object({ customerName: z.string(), orderTotal: z.number() }),
  outputSchema: z.object({ placed: z.boolean(), decidedBy: z.string() }),
  suspendSchema,
  resumeSchema,
  execute: async ({ inputData, resumeData, suspend }) => {
    if (!resumeData) {
      // First pass: park. In the real system this payload becomes a
      // Decision row in dakio-api.
      return await suspend({
        reason: "chat order needs founder approval",
        customerName: inputData.customerName,
        orderTotal: inputData.orderTotal,
      });
    }
    // Second pass, after resume: act on the founder's answer.
    return { placed: resumeData.approved, decidedBy: resumeData.approver };
  },
});

const placeStep = createStep({
  id: "place",
  inputSchema: z.object({ placed: z.boolean(), decidedBy: z.string() }),
  outputSchema: z.object({ message: z.string() }),
  execute: async ({ inputData }) => ({
    message: inputData.placed
      ? `ORDER PLACED (approved by ${inputData.decidedBy})`
      : `order NOT placed (rejected by ${inputData.decidedBy})`,
  }),
});

const spikeWorkflow = createWorkflow({
  id: "spike-approval",
  inputSchema: z.object({ customerName: z.string(), orderTotal: z.number() }),
  outputSchema: z.object({ message: z.string() }),
})
  .then(approvalStep)
  .then(placeStep)
  .commit();

const mastra = new Mastra({
  storage: new PostgresStore({ id: "spike", connectionString: DB }),
  workflows: { "spike-approval": spikeWorkflow },
});

const wf = mastra.getWorkflow("spike-approval");
const mode = process.argv[2];

if (mode === "start") {
  const run = await wf.createRun();
  const result = await run.start({ inputData: { customerName: "Rahim Uddin", orderTotal: 1710 } });
  console.log(`status: ${result.status}`);
  if (result.status === "suspended") {
    const stepResult = (result.steps as Record<string, any>)["approval"];
    console.log(`suspend payload: ${JSON.stringify(stepResult?.suspendPayload ?? null)}`);
    console.log(`runId: ${run.runId}`);
    console.log("\nNow, from a DIFFERENT process:");
    console.log(`  npx tsx spikes/01-suspend-resume.ts resume ${run.runId}`);
  } else {
    console.error("EXPECTED suspended, got:", JSON.stringify(result, null, 2).slice(0, 800));
    process.exit(1);
  }
} else if (mode === "resume" || mode === "reject") {
  const runId = process.argv[3];
  if (!runId) throw new Error("pass the runId printed by start");
  const run = await wf.createRun({ runId });
  const result = await run.resume({
    step: "approval",
    resumeData: { approved: mode === "resume", approver: "founder" },
  });
  console.log(`status: ${result.status}`);
  console.log(`result: ${JSON.stringify(result.status === "success" ? result.result : result, null, 2).slice(0, 500)}`);
} else {
  console.log("usage: start | resume <runId> | reject <runId>");
}

process.exit(0);
