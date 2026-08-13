/**
 * The observation cache (PRD §03). Every tool call is written down twice:
 * raw payload + call time into the conversation's tool ledger, distilled
 * facts into the state envelopes with checkedAt = calledAt. Dedup by
 * (tool, args) within TTL → cache hit, zero network. Failed calls are
 * ledgered too (ok:false) so the NBA can back off. Mutations are NEVER
 * cached — they bypass this module entirely.
 */

import type { NovaLiveContext, ToolLedgerEntry } from "./state.js";

function keyOf(tool: string, args: unknown): string {
  return `${tool}:${JSON.stringify(args ?? {})}`;
}

export interface ObserveResult<T> {
  raw: T;
  /** true when served from the ledger without a network call. */
  cacheHit: boolean;
  calledAt: number;
}

/**
 * Read-through cache over the tool ledger. `ttlMs` is the freshness window
 * for THIS read; the caller distills `raw` into envelopes afterwards.
 */
export async function observe<T>(
  ctx: NovaLiveContext,
  tool: string,
  args: unknown,
  fetcher: () => Promise<T>,
  ttlMs: number,
  now = Date.now(),
): Promise<ObserveResult<T>> {
  const key = keyOf(tool, args);
  // Latest wins per key — scan from the tail.
  for (let i = ctx.toolLedger.length - 1; i >= 0; i--) {
    const entry = ctx.toolLedger[i] as ToolLedgerEntry;
    if (!entry.ok) continue;
    if (keyOf(entry.tool, entry.args) !== key) continue;
    if (now - entry.calledAt <= ttlMs) {
      return { raw: entry.raw as T, cacheHit: true, calledAt: entry.calledAt };
    }
    break; // newest matching entry is stale — refetch
  }

  const calledAt = Date.now();
  try {
    const raw = await fetcher();
    ctx.toolLedger.push({ tool, args, raw, calledAt, ok: true });
    return { raw, cacheHit: false, calledAt };
  } catch (err) {
    ctx.toolLedger.push({
      tool,
      args,
      raw: { error: err instanceof Error ? err.message : String(err) },
      calledAt,
      ok: false,
    });
    throw err;
  }
}

/** TTLs from real Dakio update cadence (PRD freshness classes). */
export const TTL = {
  /** stock / price — volatile, hard-revalidated before any mutation anyway */
  stock: 120_000,
  price: 300_000,
  /** store settings / policies — near-stable */
  settings: 30 * 60_000,
  /** product identity (name/desc/options) — stable for the conversation */
  product: 24 * 60 * 60_000,
} as const;
