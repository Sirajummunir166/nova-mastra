/**
 * THE DELTA STORE — what the last pulse saw.
 *
 * This tiny table is what makes a quiet pulse free. Under eve, "has anything
 * changed?" was answered by a full agent turn re-reading a ~26K-token register,
 * 13 times a day per tenant, and the answer was almost always "no". Here the
 * answer is a row comparison in `pulse-compare.ts`, and the row lives here.
 *
 * ── SAME TWO BACKENDS AS `front-office/context-store.ts` ────────────────────
 *
 * Postgres when `NOVA_PG_URL` is set (one row per store in `nova_pulse_state`,
 * created if missing, serialized writes per key), a JSON file under
 * `.data/pulse-state/` otherwise. The pattern is deliberately the same one the
 * live-context store already uses: one persistence idiom in this repo, not two.
 *
 * ── ONE DIFFERENCE, AND IT IS ON PURPOSE ────────────────────────────────────
 *
 * `loadContext` is SYNCHRONOUS over an in-process map because a customer turn
 * cannot wait; the pulse is a scheduled workflow that can await, so
 * {@link loadPulseState} is async and {@link savePulseState} is AWAITED rather
 * than fire-and-forget. A pulse that reported a change and then failed to store
 * the new snapshot would report the same change again on the next tick, hourly,
 * forever — the exact "spam the owner" failure the lane exists to avoid. The
 * write is part of the work, so it is awaited and its failure is visible.
 *
 * ── THE INBOX FIELD IS A CURSOR, NOT A LIST ─────────────────────────────────
 *
 * {@link PulseSnapshot.inboxCursor} holds the MAX `receivedAt` the pulse has
 * taken into account — one string. Storing the processed event IDS would grow
 * without bound on a busy store, and dakio-api already owns per-event
 * `processedAt`; the cursor is the cheap local answer to "is there anything I
 * have not seen?" and survives a pulse that dies between marking and saving
 * (it re-reads a couple of already-processed events, which is free).
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

const DATA_DIR = join(process.cwd(), ".data", "pulse-state");

const PG_URL = process.env.NOVA_PG_URL;

/** Per-product state, keyed by product id. Four numbers, nothing else. */
export interface ProductState {
  stock: number;
  /** null = no velocity source for this product (see `snapshot.ts`). */
  velocity: number | null;
  /** null = velocity at/below the near-zero floor (see `snapshot.ts`). */
  daysOfCover: number | null;
  marginPct: number | null;
}

/**
 * Everything the last pulse observed, in the shape COMPARE needs.
 *
 * `null` on a domain means THAT DOMAIN WAS NOT OBSERVED last time — a failed
 * read, or a pulse that ran before the domain existed. It is not zero, and
 * compare must never read it as one: "revenue went from unknown to ৳0" is not
 * a collapse, it is a first sighting.
 */
export interface PulseSnapshot {
  /** When the sense that produced this ran (the store's clock). */
  at: string;
  products: Record<string, ProductState> | null;
  supplierDelayDays: Record<string, number> | null;
  revenue7d: number | null;
  revenuePrior7d: number | null;
  carts: { count: number; value: number } | null;
  /** Max `receivedAt` of the events this pulse took into account. */
  inboxCursor: string | null;
  /**
   * Conditions that were already TRUE last time, by finding key. This is what
   * makes findings EDGE-TRIGGERED: a stock-out risk that has been true for six
   * hours is not news six times. See `pulse-compare.ts`.
   */
  openFindings: Record<string, { since: string; metric: number | null }> | null;
}

function fileFor(storeId: string): string {
  return join(DATA_DIR, `${storeId.replace(/[^\w.-]/g, "_")}.json`);
}

// ---------------------------------------------------------------------------
// Postgres backend (lazy pool, create-if-missing — context-store.ts style)
// ---------------------------------------------------------------------------

let pool: pg.Pool | null = null;
let ready: Promise<void> | null = null;

function ensureReady(): Promise<void> {
  if (!ready) {
    pool = new pg.Pool({ connectionString: PG_URL });
    ready = pool
      .query(
        `CREATE TABLE IF NOT EXISTS nova_pulse_state (
           store_id text PRIMARY KEY,
           state jsonb NOT NULL,
           updated_at timestamptz NOT NULL DEFAULT now()
         )`,
      )
      .then(() => undefined);
  }
  return ready;
}

/** Per-store write chains — two saves for one store never land out of order. */
const writeChains = new Map<string, Promise<void>>();

function enqueue(storeId: string, write: () => Promise<void>): Promise<void> {
  const chained = (writeChains.get(storeId) ?? Promise.resolve()).catch(() => undefined).then(write);
  writeChains.set(storeId, chained);
  void chained.finally(() => {
    if (writeChains.get(storeId) === chained) writeChains.delete(storeId);
  });
  return chained;
}

// ---------------------------------------------------------------------------
// The API
// ---------------------------------------------------------------------------

/**
 * The last pulse's snapshot, or `null` when this store has never been sensed.
 *
 * A read failure ALSO answers `null`, loudly. That is the safe direction: a
 * null prior means "first sighting", so every currently-true condition is
 * reported once — noisy, and recoverable by the founder. Treating an
 * unreadable prior as "nothing changed" would mean a Postgres outage silences
 * the watchdog, which is the failure nobody would notice.
 */
export async function loadPulseState(storeId: string): Promise<PulseSnapshot | null> {
  if (PG_URL) {
    try {
      await ensureReady();
      const result = await pool!.query<{ state: PulseSnapshot }>(
        "SELECT state FROM nova_pulse_state WHERE store_id = $1",
        [storeId],
      );
      return result.rows[0]?.state ?? null;
    } catch (err) {
      console.warn(`[pulse-state] pg load failed for ${storeId} — treating as first sighting:`, err);
      return null;
    }
  }
  const file = fileFor(storeId);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as PulseSnapshot;
  } catch {
    // Corrupt file — same answer as no file. Deliberately not deleted: a
    // human may want to look at what was written.
    console.warn(`[pulse-state] unreadable snapshot for ${storeId} — treating as first sighting`);
    return null;
  }
}

/**
 * Store this pulse's snapshot. AWAITED by the caller — see the header. Throws
 * on failure rather than swallowing: the pulse's own report says whether its
 * memory was written, because a pulse that cannot remember repeats itself.
 */
export async function savePulseState(storeId: string, snapshot: PulseSnapshot): Promise<void> {
  if (PG_URL) {
    const json = JSON.stringify(snapshot);
    await enqueue(storeId, async () => {
      await ensureReady();
      await pool!.query(
        `INSERT INTO nova_pulse_state (store_id, state, updated_at)
         VALUES ($1, $2::jsonb, now())
         ON CONFLICT (store_id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
        [storeId, json],
      );
    });
    return;
  }
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(fileFor(storeId), JSON.stringify(snapshot, null, 1), "utf8");
}

/**
 * Forget everything about a store's pulse history.
 *
 * Test seam, and an operator one: after a data migration that rewrites product
 * ids, the stored snapshot describes products that no longer exist and every
 * one of them would read as a first sighting anyway — clearing is the honest
 * way to say "start over".
 */
export async function resetPulseState(storeId: string): Promise<void> {
  if (PG_URL) {
    try {
      await ensureReady();
      await pool!.query("DELETE FROM nova_pulse_state WHERE store_id = $1", [storeId]);
    } catch (err) {
      console.warn(`[pulse-state] pg reset failed for ${storeId}:`, err);
    }
    return;
  }
  rmSync(fileFor(storeId), { force: true });
}
