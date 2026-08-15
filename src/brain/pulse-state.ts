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
 * One condition that is currently TRUE, as the last pulse left it.
 *
 * ── `announced` IS THE FIELD THE WHOLE EDGE-TRIGGER RESTS ON ───────────────
 *
 * It used to be absent, and every derived condition was written into the open
 * set BEFORE anything was judged or filed. Two probed consequences: one
 * `worthWaking: false` from the judge dropped a department's findings and — the
 * conditions now counted as "open" — they never came back (only a ≥25% worsening
 * can re-raise an open condition, and only stock-out conditions are ever
 * critical, so every revenue drop, supplier delay, margin and cart finding was
 * suppressible once and forever); and one 500 on `POST /reports` erased six
 * findings including two critical stock-outs, permanently, because the snapshot
 * was written anyway.
 *
 * So the open set is now written from WHAT ACTUALLY REACHED THE FOUNDER. A
 * condition Nova derived but never told anyone about stays `announced: false`
 * and is news again next hour; one that reached a report or a Decision card is
 * `announced: true` and stays quiet until it materially worsens.
 */
export interface OpenCondition {
  /** When this condition first became true (carried across passes). */
  since: string;
  /** The last MEASURED value of its metric. `null` = it was never measurable. */
  metric: number | null;
  /**
   * When that metric was measured. NOT the same as the last pulse's `at`: a
   * value survives passes where its domain (or its field) was dark, so
   * "was X at the last pulse" could name a pulse that never observed X. The
   * evidence line reads this instead of assuming.
   */
  measuredAt: string;
  /** Did this condition actually reach the founder? See the type doc. */
  announced: boolean;
  /**
   * When the JUDGE decided this was not worth waking the founder for.
   *
   * A dismissal is not an announcement — nobody was told — but it is also not
   * an accident, and the two unreported cases deserve different answers. A lost
   * report is re-raised on the very next pulse (nothing decided anything); a
   * finding Nova looked at and judged "not today" is re-raised after
   * `DISMISSAL_QUIET_MS`, so a department that keeps being judged unremarkable
   * costs at most one judgement a day instead of one an hour — and, unlike
   * before, it is never silenced for the life of the product.
   */
  dismissedAt: string | null;
}

/**
 * A blind spot the last pulse carried, by {@link import("../lib/snapshot.js").BlindSpot} key.
 *
 * Blindness is edge-triggered like a finding — announced when it appears,
 * re-announced daily while it lasts — so that "Nova cannot see your catalogue"
 * is said once an hour after it starts and once a day after that, instead of
 * either spamming or (the defect this replaces) being silently folded into a
 * `quiet: true`.
 */
export interface BlindSpotState {
  since: string;
  /** When the founder was last told. `null` = derived but never reported. */
  announcedAt: string | null;
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
  /** Per-supplier delay. `null` inside the map = the supplier reported none. */
  supplierDelayDays: Record<string, number | null> | null;
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
  openFindings: Record<string, OpenCondition> | null;
  /** Blind spots carried from the last pulse, by key. */
  blindSpots: Record<string, BlindSpotState> | null;
}

function fileFor(storeId: string): string {
  return join(DATA_DIR, `${storeId.replace(/[^\w.-]/g, "_")}.json`);
}

/**
 * Bring a stored snapshot up to the current shape.
 *
 * ONE PLACE, on the way IN, so `pulse-compare.ts` never has to guess whether a
 * field is missing because the domain was dark or because an older build wrote
 * the row. Both backends go through it.
 *
 * `announced` defaults to FALSE for a row written before the field existed —
 * every condition in an old snapshot was recorded as open whether or not the
 * founder was ever told, so the honest reading of those rows is "unknown, and
 * unknown means say it once". The cost is bounded and self-clearing: the first
 * pulse after an upgrade re-raises whatever is still true, in ONE report, and
 * from then on the flag is real.
 */
export function normalizeSnapshot(raw: PulseSnapshot | null): PulseSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const openFindings = raw.openFindings
    ? Object.fromEntries(
        Object.entries(raw.openFindings).map(([key, state]) => [
          key,
          {
            since: state?.since ?? raw.at,
            metric: state?.metric ?? null,
            measuredAt: state?.measuredAt ?? state?.since ?? raw.at,
            announced: state?.announced === true,
            dismissedAt: state?.dismissedAt ?? null,
          } satisfies OpenCondition,
        ]),
      )
    : null;
  return { ...raw, openFindings, blindSpots: raw.blindSpots ?? null };
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
      return normalizeSnapshot(result.rows[0]?.state ?? null);
    } catch (err) {
      console.warn(`[pulse-state] pg load failed for ${storeId} — treating as first sighting:`, err);
      return null;
    }
  }
  const file = fileFor(storeId);
  if (!existsSync(file)) return null;
  try {
    return normalizeSnapshot(JSON.parse(readFileSync(file, "utf8")) as PulseSnapshot);
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
