# Phase B gate — founder lane to parity · PART-PROVEN, part waits on the key

*(Commits `71031d3` and below. Simple summary of what is proven now and
what cannot be proven until a model credential exists.)*

## Proven now (no model needed)

1. **Sessions survive restarts.** The founder's chat no longer dies with
   the server. Session state (history, continuation token, event cursor
   base) persists in Postgres (`nova_eve_sessions`); a killed and
   restarted server accepts the same session id and token — verified by a
   six-step automated drill (`scripts/smoke-restart.mjs`), including the
   tricky stream-cursor arithmetic after restore.
2. **Persistence can never break a turn** — writes are fire-and-forget;
   with `NOVA_PG_URL` unset the layer is a no-op with a loud warning
   (tests and casual local runs unaffected).
3. **The runaway fuse is set** — `maxSteps: 8` on the founder agent
   (eve needed an incident and a custom hook for this).
4. **The whole read path runs through StoreClient** (phase A) with live
   parity proven against the seeded store.
5. Protocol compatibility continuously re-verified: `smoke-eve-compat`
   passes in degraded mode after every change.

## What CANNOT be proven without the gateway key

- Real model turns: answer quality, grounded numbers, tool-call
  narration in the real UI, measured tokens/latency per turn (the
  before/after against eve's p50 26.6K tokens).
- The plan's full phase-B gate — "same founder questions on both stacks,
  side-by-side" — needs real turns on a staging merchant app, which also
  needs the `VITE_NOVA_AGENT_URL` flip (a deployed-environment switch —
  yours).

## The ask (two items, whenever you're back)

1. `AI_GATEWAY_API_KEY` — in this sandbox `.env` if the network allows
   the gateway, otherwise run `node --env-file=.env
   scripts/smoke-eve-compat.mjs` on your machine and paste the output.
2. When ready to compare stacks for real: point a staging merchant app at
   nova-mastra.

Until then, per the standing agreement, work continues into Phase C
(customer lane, shadow-first) — nothing in C's build depends on B's
model-side gate.
