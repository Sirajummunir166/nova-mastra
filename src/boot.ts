/**
 * Process bootstrap — the things that must happen before ANY other module is
 * evaluated. Import this FIRST, as a bare side-effect import:
 *
 *   import "./boot.js";
 *   import { mastra } from "./mastra/index.js";
 *
 * It exists because of an ES modules rule that quietly defeats the obvious
 * spelling. Imports are HOISTED: every `import` in a file is resolved and
 * evaluated before the first statement of that file runs. So this
 *
 *   import { installProxyFromEnv } from "./lib/egress.js";
 *   installProxyFromEnv();          // ← looks first, runs LAST
 *   import { mastra } from "./mastra/index.js";
 *
 * does not do what it reads like: every other module is already evaluated by
 * the time that call happens. Putting the side effect INSIDE a module and
 * importing that module first makes the ordering a fact of the module graph
 * rather than a comment someone has to keep true.
 */

import "dotenv/config";
import { installProxyFromEnv } from "./lib/egress.js";

installProxyFromEnv();
