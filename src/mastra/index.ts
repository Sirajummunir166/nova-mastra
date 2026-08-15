import { Mastra } from "@mastra/core";
import {
  Observability,
  MastraStorageExporter,
  MastraPlatformExporter,
  SensitiveDataFilter,
} from "@mastra/observability";
import { novaAgent } from "./agents/nova.js";
import { resolverAgent, writerAgent } from "../front-office/agents.js";
import { customerTurnWorkflow } from "../front-office/workflow.js";
import { brainDispatchWorkflow } from "../brain/dispatcher.js";

export const mastra = new Mastra({
  agents: { nova: novaAgent, "fo-resolver": resolverAgent, "fo-writer": writerAgent },
  // `brain-dispatch` carries `schedule: { cron: "* * * * *" }` — the brain's one
  // clock. It fires only once Mastra's WORKERS are running; `@mastra/express`'s
  // `server.init()` (src/index.ts) calls `startWorkers()` in this process. A
  // future worker-only runner must call it itself or the brain silently never
  // wakes (spike 3). `NOVA_BRAIN_DISPATCH=off` stops the tick without a deploy.
  workflows: { "customer-turn": customerTurnWorkflow, "brain-dispatch": brainDispatchWorkflow },
  // Port for `mastra dev` (Studio) only — the production HTTP surface is our
  // own Express server in src/index.ts (PORT env, default 2100).
  server: { port: 4111 },
  observability: new Observability({
    configs: {
      default: {
        serviceName: "nova-mastra",
        exporters: [new MastraStorageExporter(), new MastraPlatformExporter()],
        spanOutputProcessors: [new SensitiveDataFilter()],
      },
    },
  }),
});
