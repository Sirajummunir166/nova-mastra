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

export const mastra = new Mastra({
  agents: { nova: novaAgent, "fo-resolver": resolverAgent, "fo-writer": writerAgent },
  workflows: { "customer-turn": customerTurnWorkflow },
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
