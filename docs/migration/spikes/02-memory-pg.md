# Spike 2 findings — Memory threads in Postgres · ✅ PASSED

**Question:** do conversation threads + messages persist in Postgres so a
founder chat survives a server restart? (Today's honest gap: eve-compat
sessions live in process memory and die with the server.)

**Answer: yes.** Script: `spikes/02-memory-pg.ts`.

## What was tested

1. **Process 1**: `Memory` (from `@mastra/memory`) on `PostgresStore`.
   Created a thread for resource `founder:demo-store`, saved a user
   message and an assistant message.
2. **Process 2** (fresh process): `getThreadById` + `recall({threadId})`
   returned the thread and both messages, in order, intact — including
   the `৳` currency symbol (encoding survives).

## What this means for the design

- Phase B's restart-safe founder sessions are real: eve-compat's session
  store keeps the wire protocol (tokens, cursors), while the *history*
  moves into Memory threads keyed by founder/store. A server restart
  keeps the conversation.
- `resourceId` is the natural per-founder key (`founder:<storeId>`), and
  for the customer lane later, `customer:<conversationId>` — one
  mechanism, both doors.
- Semantic recall and working memory exist on the same API but need a
  model/embedder — deferred to phases B/F, as planned.

## Notes

- `@mastra/memory` is a separate package from core (core only ships the
  abstract base). Both it and `@mastra/pg` are currently installed
  `--no-save`; they enter `package.json` when phase B starts.
- npm gotcha that cost 5 minutes: two separate `--no-save` installs prune
  each other — install them in one command.
- Message shape is the v2 format (`content: { format: 2, parts: [...] }`).
