# Phase C gate — customer lane in shadow · BUILD COMPLETE, gate needs your switch

*(Commits `a339f82` → `862e574` on nova-mastra, plus the shadow mirror on
dakio-api's branch. Simple summary.)*

## Built and proven (no model, no deployment needed)

1. **The ingress** — `POST /customer/message` on nova-mastra replicates
   nova-ai's wire contract byte-for-byte (HMAC over the raw bytes, ±5 min
   skew, 202/401/400/409 with the same strings, tenant-inactive refused
   before dispatch). dakio-api will need only a URL change at cutover.
2. **Shadow is enforced in code, not policy** — the customer turn runs in
   `mode: "shadow"` by default: drafts recorded, nothing sent, the one
   order-creating call site gated. The 8-check drill proves a full turn
   yields a draft row and **zero orders**, twice.
3. **The mirror** (dakio-api branch) — set `NOVA_SHADOW_AGENT_URL` and
   every real inbox push is duplicated fire-and-forget to nova-mastra;
   env unset = byte-for-byte old behavior, pinned by test. The mirror
   structurally cannot affect the primary delivery.
4. **State survives and rolls** — conversation state lives in Postgres
   keyed by (store, conversation, **epoch**); a session roll creates a
   fresh row and leaves the old one byte-identical.
5. **The eval corpus** — 7 of 16 nova-ai inbox suites ported with their
   Bangla/Banglish phrases verbatim (the other 9 classified with reasons).
   Suite: **114 tests, 114 pass.**
6. **Four real bugs found by that corpus and fixed** — the dead
   Bangla-script L0 arm (pure-Bangla customers always paid the resolver),
   variant lookups indexing a record as an array (dead sizes reported the
   product's total stock; orders without variant ids), a full phone
   leaking into the state card via MEMO folding, and Banglish phrases
   flipping the language preference to English. Each fix flipped a
   failing marker into a passing test.

## What the full gate still needs (your switches)

- **Real shadow traffic**: set `NOVA_SHADOW_AGENT_URL` on the deployed
  dakio-api → real customer messages flow to a deployed nova-mastra in
  shadow. Both are deployed-environment switches — yours.
- **Draft quality**: shadow drafts diff against nova-ai's real replies —
  needs the model key, since drafts without a writer model record intent/
  action but no wording.
- The shadow-diff dataset (`nova_shadow_turns`) is already collecting
  everything needed for that comparison, including per-turn model-call
  counts and timings.

## The ask

Nothing new — same two items: the gateway key, and (when you want real
shadow traffic) the two env switches. Meanwhile, per standing approval,
Phase D (writes + the approval gate on suspend/resume) starts next.
