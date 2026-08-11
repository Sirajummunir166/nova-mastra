import { Mastra } from "@mastra/core";
import { novaAgent } from "./agents/nova.js";

export const mastra = new Mastra({
  agents: { nova: novaAgent },
});
