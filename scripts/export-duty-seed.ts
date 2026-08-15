/**
 * Export the canonical duty registry for dakio-api to mirror per tenant.
 *
 * Ported from nova-ai `scripts/export-duty-seed.ts` (phase E prerequisite).
 * dakio-api needs the same rows this repo's `src/store/duties.ts` holds, to
 * build its authority state and serve the founder's roster. Rather than
 * maintain two lists that can disagree, this GENERATES the backend's copy —
 * and `check-duty-seed-sync.ts` re-runs the same projection to prove the
 * committed copy is still current.
 *
 * ⚠️ THE MIGRATION HAZARD, WRITTEN DOWN BECAUSE IT IS NEW.
 * In nova-ai this script had exactly one upstream: nova-ai's own
 * `agent/lib/duties.ts`. During the Mastra migration there are TWO repos
 * carrying a `DUTIES` array — nova-ai's and this one — and dakio-api's JSON
 * mirrors whichever exported LAST. So an export from here is not just a
 * regeneration; it is a claim that this repo is now the source of truth for
 * that roster. Do not run it to "fix" a diff you have not read: if the
 * checker reports a mismatch, find out which side moved first. Silently
 * overwriting the mirror is how the two rosters end up permanently forked
 * with no record of which one the backend is actually enforcing.
 *
 * Run:  npx -y tsx scripts/export-duty-seed.ts             # writes the mirror
 *       npx -y tsx scripts/export-duty-seed.ts --dry-run   # prints, writes nothing
 *       npx -y tsx scripts/export-duty-seed.ts <path>      # explicit target
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { DUTIES, DOORS } from "../src/store/duties.js";

/**
 * The seed projection — the EXACT field set and order dakio-api's
 * `novaDutySeed.json` carries. Kept in one place so the exporter and the
 * checker can never disagree about what "in sync" means (in nova-ai the two
 * scripts held two hand-copied copies of this map).
 */
export interface DutySeedRow {
  key: string;
  department: string;
  name: string;
  nameBn: string;
  doorModule: string;
  doorExists: boolean;
  minLevel: number;
}

export function dutySeedRows(): DutySeedRow[] {
  return DUTIES.map((d) => ({
    key: d.key,
    department: d.department,
    name: d.name,
    nameBn: d.nameBn,
    doorModule: d.door,
    doorExists: DOORS[d.door]?.exists ?? false,
    minLevel: d.minLevel,
  }));
}

/**
 * dakio-api is a SEPARATE repo checked out beside this one. Resolved from this
 * file's own location rather than `process.cwd()` so the path means the same
 * thing whether the script is run via npm, tsx, or from a subdirectory.
 */
export const DEFAULT_SEED_TARGET = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../dakio-api/src/lib/novaDutySeed.json",
);

/** Byte-for-byte what the mirror file should contain. */
export function serializeSeed(rows: DutySeedRow[]): string {
  return JSON.stringify(rows, null, 2) + "\n";
}

// `tsx scripts/export-duty-seed.ts` runs this; importing the module (the
// checker does) runs nothing.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const target = args.find((a) => !a.startsWith("--")) ?? DEFAULT_SEED_TARGET;

  const seed = dutySeedRows();
  const awaitingDoors = seed.filter((d) => !d.doorExists).length;

  if (dryRun) {
    process.stdout.write(serializeSeed(seed));
    console.error(
      `○ DRY RUN — ${seed.length} duties (${awaitingDoors} awaiting doors). Nothing written to ${target}.`,
    );
  } else {
    writeFileSync(target, serializeSeed(seed), "utf8");
    console.log(`Wrote ${seed.length} duties to ${target} (${awaitingDoors} awaiting doors)`);
  }
}
