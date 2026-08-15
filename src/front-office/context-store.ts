/**
 * Live-context persistence — the storage seam behind `loadContext`/`saveContext`.
 *
 * Two backends behind the SAME exported API:
 *
 *   - Postgres (NOVA_PG_URL set): one row per (store_id, conversation_id,
 *     epoch) in `nova_conversation_state`. The EPOCH IS PART OF THE PRIMARY
 *     KEY — that is how dakio-api's session roll partitions state, exactly
 *     like nova-ai's `inbox:<conv>:<model>:e<epoch>` continuation token: a
 *     rolled conversation loads a fresh context and the old epoch's row is
 *     never touched again. Same pool/create-if-missing/serialized-write
 *     pattern as `eve-compat/persistence.ts`.
 *   - Files (NOVA_PG_URL unset): one JSON file per conversation under
 *     .data/live-context/, the original backend, kept as the fallback.
 *     Epoch 0 keeps the legacy filename so pre-epoch state still loads.
 *
 * `loadContext` stays SYNCHRONOUS over the in-process map (callers were built
 * on that); the pg cold-load is `primeContext`, awaited by the turn engine
 * before it reads. Writes are fire-and-forget but serialized per key, so two
 * saves for one conversation can never land out of order.
 *
 * Turn discipline (PRD §04): one in-flight turn per conversation — enforced
 * here with a per-conv promise chain so later messages queue in order.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { newLiveContext, type NovaLiveContext } from "./state.js";

const DATA_DIR = join(process.cwd(), ".data", "live-context");

const PG_URL = process.env.NOVA_PG_URL;

function fileFor(storeId: string, convId: string, epoch = 0): string {
  const safe = (s: string) => s.replace(/[^\w.-]/g, "_");
  // Epoch 0 renders NOTHING (same rule as nova-ai's continuation token): every
  // conversation persisted before the roll shipped keeps its exact filename.
  const suffix = Number.isFinite(epoch) && epoch > 0 ? `__e${Math.floor(epoch)}` : "";
  return join(DATA_DIR, `${safe(storeId)}__${safe(convId)}${suffix}.json`);
}

const memory = new Map<string, NovaLiveContext>();

const keyOf = (storeId: string, convId: string, epoch: number) => `${storeId}:${convId}:e${epoch}`;

// ---------------------------------------------------------------------------
// Postgres backend (lazy pool, create-if-missing — eve-compat/persistence.ts style)
// ---------------------------------------------------------------------------

let pool: pg.Pool | null = null;
let ready: Promise<void> | null = null;

function ensureReady(): Promise<void> {
  if (!ready) {
    pool = new pg.Pool({ connectionString: PG_URL });
    ready = pool
      .query(
        `CREATE TABLE IF NOT EXISTS nova_conversation_state (
           store_id text NOT NULL,
           conversation_id text NOT NULL,
           epoch integer NOT NULL DEFAULT 0,
           state jsonb NOT NULL,
           updated_at timestamptz NOT NULL DEFAULT now(),
           PRIMARY KEY (store_id, conversation_id, epoch)
         )`,
      )
      .then(() => undefined);
  }
  return ready;
}

// Per-key write chains — two fire-and-forget saves never land out of order.
const writeChains = new Map<string, Promise<void>>();

function enqueue(key: string, write: () => Promise<void>): Promise<void> {
  const chained = (writeChains.get(key) ?? Promise.resolve()).catch(() => undefined).then(write);
  writeChains.set(key, chained);
  void chained.finally(() => {
    if (writeChains.get(key) === chained) writeChains.delete(key);
  });
  return chained;
}

// ---------------------------------------------------------------------------
// The exported API — unchanged names/roles; `epoch` is additive and defaults 0
// ---------------------------------------------------------------------------

/**
 * Async cold-load ahead of the sync `loadContext`: hydrate the in-process map
 * from Postgres if the row exists there. No-op with NOVA_PG_URL unset (the
 * file backend loads synchronously inside `loadContext`) or on a memory hit.
 * The turn engine awaits this once per turn, inside the turn lock.
 */
export async function primeContext(storeId: string, convId: string, epoch = 0): Promise<void> {
  if (!PG_URL) return;
  const key = keyOf(storeId, convId, epoch);
  if (memory.has(key)) return;
  try {
    await ensureReady();
    const result = await pool!.query<{ state: NovaLiveContext }>(
      "SELECT state FROM nova_conversation_state WHERE store_id = $1 AND conversation_id = $2 AND epoch = $3",
      [storeId, convId, epoch],
    );
    const row = result.rows[0];
    if (row?.state) {
      const ctx = row.state;
      ctx.epoch = epoch; // rows written before the field existed
      memory.set(key, ctx);
    }
  } catch (err) {
    // A dead Postgres must not drop a customer turn — degrade to a fresh
    // in-memory context (the pre-persistence behavior), loudly.
    console.warn(`[context-store] pg load failed for ${key} — starting from memory:`, err);
  }
}

export function loadContext(storeId: string, convId: string, channel = "chat", epoch = 0): NovaLiveContext {
  const key = keyOf(storeId, convId, epoch);
  const cached = memory.get(key);
  if (cached) return cached;
  if (!PG_URL) {
    const file = fileFor(storeId, convId, epoch);
    if (existsSync(file)) {
      try {
        const ctx = JSON.parse(readFileSync(file, "utf8")) as NovaLiveContext;
        ctx.epoch = ctx.epoch ?? epoch; // legacy files predate the field
        memory.set(key, ctx);
        return ctx;
      } catch {
        // corrupt file — start fresh rather than dying
      }
    }
  }
  const ctx = newLiveContext(convId, storeId, channel, epoch);
  memory.set(key, ctx);
  return ctx;
}

export function saveContext(ctx: NovaLiveContext): void {
  const epoch = ctx.epoch ?? 0;
  if (PG_URL) {
    // Snapshot NOW — the caller mutates ctx on the next turn.
    const snapshot = JSON.stringify(ctx);
    const key = keyOf(ctx.storeId, ctx.convId, epoch);
    void enqueue(key, async () => {
      await ensureReady();
      await pool!.query(
        `INSERT INTO nova_conversation_state (store_id, conversation_id, epoch, state, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, now())
         ON CONFLICT (store_id, conversation_id, epoch)
         DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
        [ctx.storeId, ctx.convId, epoch, snapshot],
      );
    }).catch((err) => console.warn(`[context-store] pg save failed for ${key}:`, err));
    return;
  }
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(fileFor(ctx.storeId, ctx.convId, epoch), JSON.stringify(ctx, null, 1), "utf8");
}

/**
 * Wipe a conversation's state. With `epoch` given, only that epoch's
 * partition; omitted, every epoch (the pre-epoch behavior callers expect
 * from "start this conversation over").
 */
export function resetContext(storeId: string, convId: string, epoch?: number): void {
  const prefix = `${storeId}:${convId}:e`;
  for (const key of [...memory.keys()]) {
    if (epoch !== undefined ? key === keyOf(storeId, convId, epoch) : key.startsWith(prefix)) {
      memory.delete(key);
    }
  }
  if (PG_URL) {
    const where = epoch !== undefined ? " AND epoch = $3" : "";
    const params = epoch !== undefined ? [storeId, convId, epoch] : [storeId, convId];
    void ensureReady()
      .then(() =>
        pool!.query(`DELETE FROM nova_conversation_state WHERE store_id = $1 AND conversation_id = $2${where}`, params),
      )
      .catch((err) => console.warn(`[context-store] pg reset failed for ${storeId}:${convId}:`, err));
    return;
  }
  if (epoch !== undefined) {
    rmSync(fileFor(storeId, convId, epoch), { force: true });
  } else {
    // Legacy file (epoch 0) — rolled epochs' files are best-effort swept too.
    rmSync(fileFor(storeId, convId, 0), { force: true });
    for (let e = 1; e <= 64; e++) rmSync(fileFor(storeId, convId, e), { force: true });
  }
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
