/**
 * One place that turns "a founder said this" into the tools the model gets.
 *
 * Mastra takes per-call tools as `toolsets` — a named group handed to
 * `agent.stream`/`agent.generate` for that call only, which is what keeps the
 * agent itself tool-free and every turn's payload its own decision.
 */

import { storeReadTools, type StoreReadTools } from "./store-reads.js";
import { selectTools, type Selection } from "./select.js";

export { selectTools, type Selection } from "./select.js";
export { ALL_TOOL_NAMES, type StoreToolName } from "./store-reads.js";

export interface TurnTools {
  /** Pass straight into `agent.stream(..., { toolsets })`. Undefined = no tools. */
  toolsets: { store: Partial<StoreReadTools> } | undefined;
  selection: Selection;
}

export function toolsForTurn(storeId: string, text: string): TurnTools {
  const selection = selectTools(text);
  if (selection.tools.length === 0) return { toolsets: undefined, selection };

  const all = storeReadTools(storeId);
  const store = Object.fromEntries(selection.tools.map((name) => [name, all[name]])) as Partial<StoreReadTools>;
  return { toolsets: { store }, selection };
}
