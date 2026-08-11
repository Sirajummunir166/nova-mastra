import { Mastra } from "@mastra/core";
import {
  Observability,
  MastraStorageExporter,
  MastraPlatformExporter,
  SensitiveDataFilter,
} from "@mastra/observability";
import { novaAgent } from "./agents/nova.js";

export const mastra = new Mastra({
  agents: { nova: novaAgent },
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
