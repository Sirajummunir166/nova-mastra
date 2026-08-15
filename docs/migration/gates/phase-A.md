# Phase A gate — StoreClient + auth floor · READY FOR YOUR YES/NO

*(One page, as promised. Everything below is on the branch, commits
`7c8c2ab` → `418029b`.)*

## What Phase A was

Port nova-ai's `StoreClient` (the one store contract, with a live dakio
backend and a seeded demo backend), put the auth floor under it, and make
our four hand-rolled fetch modules use it — with behavior unchanged.

## What happened

1. **The library ported whole** — 11,480 lines into `src/store/`:
   interface, dakio HTTP backend, DemoStore + seeds, fleet, resolve,
   `types.ts` byte-identical, plus the deps the sources really reach
   (authority, duties, cron, tenants). All comments preserved — they carry
   incident history. Two documented adaptations only.
2. **The gate evals run green** — 22 tests, no network, no model:
   service-token byte-compat with dakio-api's verifier (mocked clocks,
   refresh-before-expiry, fail-closed), and two-tenant isolation at the
   StoreClient layer (reads never cross; writes invisible through the
   other tenant's client; tokens scoped). Invariants that could NOT carry
   over from eve are listed in the test header as visible debt.
3. **The four fetchers collapsed onto the client** — public signatures
   frozen, zero raw fetches remain. Live parity proven against the seeded
   demo store: all 5 tools OK, CEO snapshot with real numbers and no
   "(unavailable)" rows, eve-compat protocol smoke passes.

## Found along the way (the port paying for itself)

- **A real silent bug, fixed**: chat orders posted `conversationId`, but
  the server reads `sourceConversationId` — the order↔thread join was
  being lost on every chat order. Restored.
- **A production footgun, fixed**: `storeFor` defaulted to the *demo*
  backend (an eve-dev habit). A deployment that forgot one env var would
  have silently served a fake store as the founder's real business. The
  default is now the real backend; demo is the explicit opt-in.
- **A latent bug, flagged not fixed** (front-office, outside A's scope):
  `variantStock`/`variantIds` are typed as arrays but arrive as
  name-keyed records, so variant lookup can never succeed at runtime.
  Queued for phase C, where that file gets rebuilt anyway.

## Accepted deltas (small, deliberate)

- Old per-call 8–10s timeouts → the client's 3-retry backoff policy.
- Profile `vertical` fallback capitalization ("General commerce").

## The ask

Say **"phase A approved"** (or object to anything above). Per our
agreement I am continuing into Phase B meanwhile — restart-safe founder
sessions on `@mastra/pg` — since nothing in B depends on re-judging A.
