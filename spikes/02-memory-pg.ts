/**
 * Phase 0 · Spike 2 — conversations that survive restarts.
 *
 * Question: do Memory threads + messages persist in Postgres so a founder
 * chat session survives a server restart? (Today's honest gap: eve-compat
 * sessions are in-process and die with the server.)
 *
 *   npx tsx spikes/02-memory-pg.ts write            → creates thread, saves messages
 *   npx tsx spikes/02-memory-pg.ts read <threadId>  → NEW process, reads them back
 */

import { Memory } from "@mastra/memory";
import { PostgresStore } from "@mastra/pg";

const DB = process.env.SPIKE_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/mastra_spike";

const memory = new Memory({
  storage: new PostgresStore({ id: "spike-mem", connectionString: DB }),
});

const RESOURCE = "founder:demo-store"; // per-founder identity, like our session storeId

const mode = process.argv[2];

if (mode === "write") {
  const thread = await memory.createThread({
    resourceId: RESOURCE,
    title: "founder chat — spike",
  });
  await memory.saveMessages({
    messages: [
      {
        id: "spike-msg-1",
        threadId: thread.id,
        resourceId: RESOURCE,
        role: "user",
        content: { format: 2, parts: [{ type: "text", text: "which orders are pending?" }] },
        createdAt: new Date(),
        type: "text",
      },
      {
        id: "spike-msg-2",
        threadId: thread.id,
        resourceId: RESOURCE,
        role: "assistant",
        content: { format: 2, parts: [{ type: "text", text: "2 orders pending: Eid Panjabi (৳1,710) and Polo ×2." }] },
        createdAt: new Date(Date.now() + 1000),
        type: "text",
      },
    ] as any,
  });
  console.log(`threadId: ${thread.id}`);
  console.log("\nNow, from a DIFFERENT process:");
  console.log(`  npx tsx spikes/02-memory-pg.ts read ${thread.id}`);
} else if (mode === "read") {
  const threadId = process.argv[3];
  if (!threadId) throw new Error("pass the threadId printed by write");
  const thread = await memory.getThreadById({ threadId });
  console.log(`thread: ${thread?.title} (resource ${thread?.resourceId})`);
  const recalled = await memory.recall({ threadId, resourceId: RESOURCE });
  for (const m of recalled.messages) {
    const text = Array.isArray((m as any).content?.parts)
      ? (m as any).content.parts.map((p: any) => p.text ?? "").join("")
      : JSON.stringify((m as any).content).slice(0, 80);
    console.log(`  [${m.role}] ${text}`);
  }
  console.log(`messages recalled: ${recalled.messages.length}`);
} else {
  console.log("usage: write | read <threadId>");
}

process.exit(0);
