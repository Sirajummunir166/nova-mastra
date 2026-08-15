/**
 * The ONE reading of `NOVA_STORE_BACKEND`.
 *
 * This exists because the same env var was being read three different ways:
 * `resolve.ts` said `=== "demo" ? demo : dakio` (unset ⇒ LIVE clients) while
 * `fleet.ts` and `tenants.ts` said `=== "dakio" ? dakio : demo` (unset ⇒ the
 * hard-coded seed list). With the variable unset — which is exactly what a
 * deployment that forgets it looks like — the dispatcher iterated the
 * in-process demo tenants while every client it built talked to the real
 * dakio-api: the brain ticking for stores that do not exist, and never
 * ticking for the ones that do. A split brain that no single file could show
 * you, because each file was individually correct.
 *
 * So: one function, zero imports (nothing can make this a cycle), and every
 * branch on the backend calls it.
 *
 * Which way the default points is a deliberate choice, kept from `resolve.ts`:
 * the worse failure is a deployment that forgets the var and silently serves
 * the seeded in-memory store as if it were the founder's real business, so
 * anything that is not an explicit `demo` means `dakio`. The deterministic
 * demo store is the explicit opt-in the eval suites set themselves.
 *
 * Whitespace and case are normalised — `NOVA_STORE_BACKEND=" Demo"` from a
 * hand-edited env file means demo, and the one direction leniency can move
 * things is toward the offline store, never toward live merchant data.
 */

export type StoreBackendMode = "demo" | "dakio";

/** Unrecognised values already warned about — one line per distinct value. */
const warned = new Set<string>();

/**
 * Which store backend this process talks to.
 *
 * `demo` only for an explicit `NOVA_STORE_BACKEND=demo` (case/space
 * insensitive). Unset, empty, or anything unrecognised ⇒ `dakio`.
 */
export function storeBackendMode(): StoreBackendMode {
  const raw = process.env.NOVA_STORE_BACKEND;
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (value === "demo") return "demo";
  if (value !== "" && value !== "dakio" && !warned.has(value)) {
    warned.add(value);
    console.warn(
      `[store] NOVA_STORE_BACKEND="${raw}" is not "demo" or "dakio" — treating it as "dakio" (live). ` +
        `Set NOVA_STORE_BACKEND=demo if you meant the in-process demo store.`,
    );
  }
  return "dakio";
}

/** Convenience predicates, so call sites read as intent rather than string compare. */
export function isDemoBackend(): boolean {
  return storeBackendMode() === "demo";
}

export function isDakioBackend(): boolean {
  return storeBackendMode() === "dakio";
}

/** Tests only — lets a suite re-observe the warn for a value it already used. */
export function resetStoreBackendModeWarnings(): void {
  warned.clear();
}
