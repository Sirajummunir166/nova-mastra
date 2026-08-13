/**
 * Live-context persistence: one JSON file per conversation under
 * .data/live-context/. Survives Studio/server restarts, trivially
 * inspectable while we iterate. Swap for Postgres later without touching
 * callers (load/save seam only).
 *
 * Turn discipline (PRD §04): one in-flight turn per conversation — enforced
 * here with a per-conv promise chain so later messages queue in order.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { newLiveContext, type NovaLiveContext } from "./state.js";

const DATA_DIR = join(process.cwd(), ".data", "live-context");

function fileFor(storeId: string, convId: string): string {
  const safe = (s: string) => s.replace(/[^\w.-]/g, "_");
  return join(DATA_DIR, `${safe(storeId)}__${safe(convId)}.json`);
}

const memory = new Map<string, NovaLiveContext>();

export function loadContext(storeId: string, convId: string, channel = "chat"): NovaLiveContext {
  const key = `${storeId}:${convId}`;
  const cached = memory.get(key);
  if (cached) return cached;
  const file = fileFor(storeId, convId);
  if (existsSync(file)) {
    try {
      const ctx = JSON.parse(readFileSync(file, "utf8")) as NovaLiveContext;
      memory.set(key, ctx);
      return ctx;
    } catch {
      // corrupt file — start fresh rather than dying
    }
  }
  const ctx = newLiveContext(convId, storeId, channel);
  memory.set(key, ctx);
  return ctx;
}

export function saveContext(ctx: NovaLiveContext): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(fileFor(ctx.storeId, ctx.convId), JSON.stringify(ctx, null, 1), "utf8");
}

export function resetContext(storeId: string, convId: string): void {
  memory.delete(`${storeId}:${convId}`);
  rmSync(fileFor(storeId, convId), { force: true });
}

// ---------------------------------------------------------------------------
// One in-flight turn per conversation — later messages queue and apply in order
// ---------------------------------------------------------------------------

const turnChains = new Map<string, Promise<unknown>>();

export function withTurnLock<T>(storeId: string, convId: string, run: () => Promise<T>): Promise<T> {
  const key = `${storeId}:${convId}`;
  const prev = turnChains.get(key) ?? Promise.resolve();
  const next = prev.then(run, run);
  turnChains.set(
    key,
    next.catch(() => {}),
  );
  return next;
}
