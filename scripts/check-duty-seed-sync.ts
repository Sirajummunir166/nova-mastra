/**
 * CI check: dakio-api's mirrored duty seed must match this repo's registry.
 *
 * Ported from nova-ai `scripts/check-duty-seed-sync.ts` (phase E prerequisite —
 * the spec's section E will not let lane→duty links be built on an unverified
 * roster).
 *
 * The backend needs the same duties this repo holds, to build authority state
 * and serve the roster. Two hand-maintained lists would drift, and the drift
 * would be SILENT — a duty the backend thinks is L2 and the agent thinks is L4.
 * So the JSON is GENERATED (`export-duty-seed.ts`), and this proves the
 * committed copy is still current.
 *
 * What changed in the port, and why:
 *  - The projection is imported from the exporter instead of hand-copied, so
 *    the two scripts cannot disagree about what "in sync" means.
 *  - A mismatch prints a FIELD-LEVEL diff (missing / extra / changed), not just
 *    "stale, and the counts differ". During the migration a mismatch is a
 *    question — which repo moved? — not a chore, and the answer is in the diff.
 *  - It does NOT tell you to just re-export. There are two upstream `DUTIES`
 *    arrays during the migration (nova-ai's and this repo's) and the mirror
 *    reflects whichever exported last; re-exporting without reading the diff is
 *    how the rosters fork silently. See the header of `export-duty-seed.ts`.
 *
 * Run:  npx -y tsx scripts/check-duty-seed-sync.ts
 */
import { readFileSync } from "node:fs";
import { DEFAULT_SEED_TARGET, dutySeedRows, type DutySeedRow } from "./export-duty-seed.js";

const TARGET = process.argv[2] ?? DEFAULT_SEED_TARGET;

const expected = dutySeedRows();

let raw: string;
try {
  raw = readFileSync(TARGET, "utf8");
} catch {
  // dakio-api is a SEPARATE repo checked out beside this one. On a CI runner
  // it isn't there, and that is not a failure — this check only has something
  // to compare against in a full local workspace. Skipping loudly beats
  // failing a build for a file that was never supposed to exist there.
  console.warn(`○ SKIPPED: ${TARGET} not present (dakio-api not checked out beside this repo).`);
  console.warn("  The mirror is only verifiable in a full local workspace.");
  process.exit(0);
}

let parsed: unknown;
try {
  parsed = JSON.parse(raw);
} catch (error) {
  console.error(`✗ ${TARGET} is not valid JSON: ${String(error)}`);
  process.exit(1);
}

if (!Array.isArray(parsed)) {
  console.error(`✗ ${TARGET} is not a JSON array of duty rows.`);
  process.exit(1);
}
const actual = parsed as DutySeedRow[];

if (JSON.stringify(actual) === JSON.stringify(expected)) {
  console.log(`DUTY SEED SYNC PASSED — dakio-api mirrors all ${expected.length} duties.`);
  process.exit(0);
}

// ── Mismatch: say exactly what differs, in the order a reader needs it. ──────
const FIELDS: (keyof DutySeedRow)[] = [
  "department",
  "name",
  "nameBn",
  "doorModule",
  "doorExists",
  "minLevel",
];

const mirrorByKey = new Map(actual.map((d) => [d.key, d]));
const registryByKey = new Map(expected.map((d) => [d.key, d]));

const missing = expected.filter((d) => !mirrorByKey.has(d.key)); // registry has, mirror lacks
const extra = actual.filter((d) => !registryByKey.has(d.key)); // mirror has, registry lacks
const changed: string[] = [];
for (const want of expected) {
  const got = mirrorByKey.get(want.key);
  if (!got) continue;
  for (const f of FIELDS) {
    if (JSON.stringify(got[f]) !== JSON.stringify(want[f])) {
      changed.push(`${want.key}.${f}: mirror=${JSON.stringify(got[f])} registry=${JSON.stringify(want[f])}`);
    }
  }
}
// Same membership and same fields, different array order — real, and worth
// naming separately: the mirror is a generated file, so an order-only diff
// means someone hand-edited it or an export ran from a differently-ordered
// upstream.
const orderOnly =
  missing.length === 0 &&
  extra.length === 0 &&
  changed.length === 0 &&
  actual.map((d) => d.key).join(",") !== expected.map((d) => d.key).join(",");

console.error("✗ DUTY SEED OUT OF SYNC — the registry and dakio-api's mirror disagree.");
console.error(`  mirror:   ${TARGET} (${actual.length} duties)`);
console.error(`  registry: src/store/duties.ts (${expected.length} duties)`);
if (missing.length > 0) {
  console.error(`\n  IN REGISTRY, NOT IN MIRROR (${missing.length}):`);
  for (const d of missing) console.error(`    + ${d.key}`);
}
if (extra.length > 0) {
  console.error(`\n  IN MIRROR, NOT IN REGISTRY (${extra.length}):`);
  for (const d of extra) console.error(`    - ${d.key}`);
}
if (changed.length > 0) {
  console.error(`\n  SAME KEY, DIFFERENT FIELD (${changed.length}):`);
  for (const line of changed) console.error(`    ~ ${line}`);
}
if (orderOnly) {
  console.error("\n  ORDER ONLY: same duties, same fields, different row order.");
}
console.error(
  "\n  Do NOT reflexively re-export. Two repos carry a DUTIES array during the\n" +
    "  migration (nova-ai and this one) and the mirror reflects whichever ran\n" +
    "  `export-duty-seed.ts` last. Work out which side moved, then export from\n" +
    "  the side that is right.",
);
process.exit(1);
