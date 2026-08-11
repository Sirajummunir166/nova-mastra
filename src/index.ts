import "dotenv/config";
import express, { type Request, type Response } from "express";
import { MastraServer } from "@mastra/express";
import { mastra } from "./mastra/index.js";
import { getStoreProfile } from "./lib/store.js";
import { novaInstructions } from "./lib/context.js";
import { eveRouter } from "./eve-compat/router.js";

const app = express();
const PORT = Number(process.env.PORT) || 2100;

// CORS — mirrors nova-ai channels/eve.ts: origins from NOVA_CORS_ORIGINS
// (comma-separated, * if unset), the client-context header allowed, the
// session id exposed.
const ORIGINS = (process.env.NOVA_CORS_ORIGINS ?? "*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowed = ORIGINS.includes("*") ? (origin ?? "*") : origin && ORIGINS.includes(origin) ? origin : null;
  if (allowed) {
    res.setHeader("Access-Control-Allow-Origin", allowed);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "authorization, content-type, x-dakio-client-context");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Expose-Headers", "x-eve-session-id");
  }
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

app.use(express.json());

// The eve protocol surface NovaChat speaks (novaAgentClient.js).
app.use("/eve/v1", eveRouter);

// Registers Mastra's own endpoints (/api/agents/nova/generate etc.).
const server = new MastraServer({ app, mastra });
await server.init();

app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true, service: "nova-mastra" });
});

/**
 * The chatbox seam. Body: { message?: string, storeId?: string }.
 * storeId falls back to NOVA_DEV_STORE_ID for local dev; in production the
 * caller's Dakio JWT will carry tenancy (same as nova-ai) — auth lands with
 * the real chat contract.
 */
app.post("/chat", async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as { message?: string; storeId?: string };
    const storeId = body.storeId || process.env.NOVA_DEV_STORE_ID;
    const message = body.message || "Introduce yourself to the founder.";
    if (!storeId) {
      res.status(400).json({ ok: false, error: "storeId required (or set NOVA_DEV_STORE_ID)" });
      return;
    }

    const store = await getStoreProfile(storeId);
    if (!store) {
      res.status(502).json({ ok: false, error: `store ${storeId} unavailable from dakio-api` });
      return;
    }
    if (store.status !== "active") {
      res.status(403).json({ ok: false, error: `store ${storeId} is not active` });
      return;
    }

    const agent = mastra.getAgent("nova");
    const result = await agent.generate(message, {
      instructions: novaInstructions(store),
    });

    res.json({
      ok: true,
      store: { id: store.storeId, name: store.name, plan: store.plan },
      model: result.response?.modelId,
      usage: result.usage,
      reply: result.text,
    });
  } catch (err) {
    console.error("[chat]", err);
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`nova-mastra listening on http://localhost:${PORT}`);
});
