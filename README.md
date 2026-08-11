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

Not yet ported (tracked for the real chatbox contract): Dakio JWT auth +
`{userId, tenantId}` claim normalisation, NDJSON session/stream protocol the
merchant app speaks, tools, autonomy gate, memory layers.

## Run

```bash
cp .env.example .env   # fill AI_GATEWAY_API_KEY, NOVA_SERVICE_SECRET, NOVA_DEV_STORE_ID
npm install
npm run dev            # tsx watch, port 2100
```

Needs dakio-api reachable at `DAKIO_API_URL` (local: `npm run dev` in dakio-api,
port 5001) with a matching `NOVA_SERVICE_SECRET`.

## Layout

```
src/index.ts               Express server + MastraServer + /chat route
src/mastra/index.ts        Mastra instance
src/mastra/agents/nova.ts  Nova agent (gateway model)
src/lib/service-token.ts   per-tenant HS256 service token mint (port of nova-ai)
src/lib/store.ts           GET /api/v1/store/profile client, identity-checked
src/lib/context.ts         per-turn instruction assembly (the token-lean seam)
```
