// FIRST, and it must stay first — see src/boot.ts.
//
// This file has TWO entry points and only one of them is `src/index.ts`.
// `mastra dev` (npm run studio) loads THIS module directly, so a bootstrap
// that lives only in `src/index.ts` never runs under Studio: every model call
// from the Studio playground then leaves without the proxy and comes back
// "Host not in allowlist", which reads like a credential problem and is not.
// Found by making a real agent call through Studio's own API after the
// server-side path was already fixed.
//
// `installProxyFromEnv()` is idempotent, so both entry points importing this
// is free.
import "../boot.js";

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
import { inspectStateWorkflow, novaContextWorkflow } from "../front-office/inspect.js";
import { brainDispatchWorkflow } from "../brain/dispatcher.js";
import { pulseWorkflow } from "../brain/pulse.js";
import { courierInterventionWorkflow } from "../brain/lanes/courier-intervention.js";
import { restockCheckWorkflow } from "../brain/lanes/restock-check.js";

export const mastra = new Mastra({
  agents: { nova: novaAgent, "fo-resolver": resolverAgent, "fo-writer": writerAgent },
  // `brain-dispatch` carries `schedule: { cron: "* * * * *" }` — the brain's one
  // clock. It fires only once Mastra's WORKERS are running; `@mastra/express`'s
  // `server.init()` (src/index.ts) calls `startWorkers()` in this process. A
  // future worker-only runner must call it itself or the brain silently never
  // wakes (spike 3). `NOVA_BRAIN_DISPATCH=off` stops the tick without a deploy.
  // `brain-pulse` carries NO schedule: the brain has one clock (above) and the
  // pulse's cadence is data — a founder-editable `nova_job_defs` row in
  // dakio-api, in the tenant's own timezone. It is registered so Studio can run
  // one pulse on demand and trace it; the dispatcher runs it through
  // FOUNDER_PLANE_RUNNERS.
  // The two EVENT lanes carry no schedule either, and for a sharper reason than
  // the pulse's: their cadence is not a cadence at all. dakio-api mints
  // `courier_intervention` on the journey sweep's stagnation edge and
  // `restock_check` when a `restock_wait` case opens, so the only clock they
  // have is a customer's or a courier's. Registered so Studio can run one on
  // demand and trace it; the dispatcher runs them through FOUNDER_PLANE_RUNNERS.
  workflows: {
    "customer-turn": customerTurnWorkflow,
    // Read-only companions to customer-turn. Neither calls a model and neither
    // writes, so they can be run between every message without disturbing the
    // thing being observed.
    "fo-inspect": inspectStateWorkflow,
    "nova-context": novaContextWorkflow,
    "brain-dispatch": brainDispatchWorkflow,
    "brain-pulse": pulseWorkflow,
    "brain-courier-intervention": courierInterventionWorkflow,
    "brain-restock-check": restockCheckWorkflow,
  },
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
