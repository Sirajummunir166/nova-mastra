# nova-mastra

Nova's chat service on **Mastra + Express**, replacing the eve framework for the
founder chatbox (and later the cron lanes). Motivation: eve's single-entry
routing plus its always-on instruction layers and full 67-tool schema payload
burn ~26K+ input tokens per model call and add real latency. This service builds
a small, explicit context per request instead.

- Model: Vercel AI Gateway (`AI_GATEWAY_API_KEY`), default `anthropic/claude-sonnet-5`
- Backend: dakio-api via per-tenant self-minted HS256 service tokens (`NOVA_SERVICE_SECRET`)

## Status

MVP: store connect + hello-with-store-context. One endpoint:

```
POST /chat  { "message": "hello", "storeId": "<optional, defaults NOVA_DEV_STORE_ID>" }
→ { ok, store: {id, name, plan}, reply }
```

`GET /health` for probes. Mastra's own endpoints (`/api/agents/nova/generate`)
are also mounted via `@mastra/express`.

Not yet ported (tracked for the real chatbox contract): the autonomy gate
(eve's `input.requested` parking — nothing here ever parks), durable memory
(sessions are in-process and die with the server), and every WRITE tool. Nova
can read this store; it cannot yet change it.

## Tools (founder lane)

The founder chatbox gets a small read surface over dakio-api — `get_orders`,
`get_products`, `get_customers`, `get_abandoned_carts`,
`get_finance_overview` — and which of them the model sees is decided **per
turn, by rules, before the model is called** (`src/tools/select.ts`):

| turn | tools attached |
|---|---|
| an opener ("hello", "how are we doing?") | **none** — `buildCeoSnapshot` already answered it |
| a recognised topic ("what needs restocking?") | that topic's tool |
| anything else | all five |

That is the same discipline as the instruction assembly, applied to schemas:
eve shipped 67 tool definitions on every call, including the openers that
could never use one. Selection widens rather than narrows when it fails to
parse a question — a starved turn is a wrong answer, five small schemas are a
rounding error.

Tools are attached per call via Mastra `toolsets`, so the agent itself stays
tool-free and each turn's payload is its own decision. Every tool aggregates
and caps its rows (`ROW_CAP`) instead of forwarding what dakio-api returns,
and none takes a store id — tenancy is closed over from the session, never a
model-supplied argument.

Two things verify without a model credential:

```bash
npm test                                                   # selection rules
node --env-file=.env --import tsx scripts/smoke-tools.ts   # every tool against the live API
```

The second one exists because the failure it catches is invisible: dakio-api's
Nova projection renames fields (`region`, not `district`; `ordersCount`, not
`orderCount`) and drops others entirely (an order has no `orderNumber` on this
surface). A wrong name is `undefined`, `JSON.stringify` drops it, and the model
simply never sees the field — no error anywhere.

While the model is reachable, `scripts/smoke-eve-compat.mjs` additionally
asserts that every `actions.requested` gets a matching `action.result`:
NovaChat opens a narration row per tool call and closes it on that result, so
an unmatched `callId` is a row that hangs on the founder's screen.

## Tracing

The delta loop makes **no LLM tool calls** — that is the design, and the reason
a turn costs ~300 input tokens instead of ~26K. The app classifies with rules,
decides the next action itself, and calls dakio-api directly; the model only
words the reply. So Mastra's automatic instrumentation (which traces agent
runs, workflow steps and LLM-issued tool calls) had nothing to show, and Studio
showed an empty workflow run.

`src/front-office/trace.ts` emits the spans instead. One turn now reads:

```
workflow run: 'customer-turn'
  classify: qty_pick          rung=0 decidedBy="rules (no model)"
  decide: ASK_ZONE            stage="checkout" missing=[...]
  get_store_settings          [tool_call] cacheHit=false 13ms
  list_products (cache hit)   [tool_call] cacheHit=true ageMs=41000
  agent run: 'fo-writer'
    llm: 'anthropic/claude-sonnet-5'
```

Two gotchas worth knowing if you extend it:

- The span a step receives is a `workflow_step` span; anchoring children to it
  is fine, but agent calls start their OWN trace unless you pass
  `tracingOptions: { traceId, parentSpanId }` — that is what `modelTracing()`
  does, and why the writer used to appear as an orphan trace.
- `GET /api/observability/traces` lists **traces** (root spans only). The tree
  lives at `GET /api/observability/traces/:traceId`. In Studio, click a trace
  row to open it — the top-level list never shows children.

The conversation's own audit trail is separate and survives restarts: every
dakio-api call is appended to `toolLedger` in `.data/live-context/<store>__<conv>.json`
with its raw payload and timestamp.

## Studio

Mastra Studio (agents, workflows, traces) is served by this app at **`/studio`** —
locally `http://localhost:2100/studio`, and on any deployment the same path on
its own domain. The SPA auto-detects its origin, so nothing is hardcoded.

Access is gated by `NOVA_STUDIO_TOKEN`: the browser asks for HTTP Basic
credentials — **any username, the token as the password** — then keeps a
session cookie that also authorizes Studio's `/api` calls. Set that variable on
every deployed environment: Studio can run the `customer-turn` workflow, which
creates **real orders** in whatever store `DAKIO_API_URL` points at.

`npm run studio` still runs the CLI's own dev Studio on :4111 against a local
Mastra dev server; `npm run studio:prod` runs the Studio UI locally against the
Railway API. Neither is needed now that `/studio` is hosted.

## Run

```bash
cp .env.example .env   # fill AI_GATEWAY_API_KEY, NOVA_SERVICE_SECRET, NOVA_DEV_STORE_ID
npm install
npm run dev            # tsx watch, port 2100
```

Needs dakio-api reachable at `DAKIO_API_URL` (local: `npm run dev` in dakio-api,
port 5001) with a matching `NOVA_SERVICE_SECRET`.

### Local stack in one command

`scripts/local-stack.sh` brings up everything Nova reads from — local Postgres,
dakio-api's schema, a seeded demo store (8 products, 5 customers, 12 orders),
dakio-api on :5001 — and writes the seeded store's id into `.env` as
`NOVA_DEV_STORE_ID`. That id is a cuid minted at seed time, so it can't be
hardcoded; the script discovers it. Re-running is safe.

```bash
./scripts/local-stack.sh                            # dakio-api assumed at ../dakio-api
DAKIO_API_DIR=/path/to/dakio-api ./scripts/local-stack.sh
npm run dev                                         # then Nova on :2100
```

The one thing it can't supply is a model credential — put `AI_GATEWAY_API_KEY`
in `.env` before the first `/chat`, or the turn 401s at the gateway with the
store context already assembled.

## Layout

```
src/index.ts               Express server + MastraServer + /chat route
src/mastra/index.ts        Mastra instance
src/mastra/agents/nova.ts  Nova agent (gateway model)
src/lib/service-token.ts   per-tenant HS256 service token mint (port of nova-ai)
src/lib/store.ts           GET /api/v1/store/profile client, identity-checked
src/lib/context.ts         per-turn instruction assembly (the token-lean seam)
src/lib/snapshot.ts        CEO snapshot — live store numbers, ~300 tokens
src/tools/store-reads.ts   founder-lane read tools over dakio-api
src/tools/select.ts        which tools this turn gets — rules, no model call
src/eve-compat/            the eve/v1 protocol surface NovaChat speaks
```
