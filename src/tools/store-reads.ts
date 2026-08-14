/**
 * The founder lane's tool surface — read tools over the tenant's
 * `StoreClient` (`storeFor`), which fronts dakio-api's Nova store endpoints.
 *
 * Two rules hold every tool here to the same discipline the snapshot follows:
 *
 * 1. AGGREGATE, DON'T DUMP. dakio-api caps a list read at LIST_CAP rows and
 *    every row carries fields the founder never asked about. A tool that
 *    returned those verbatim would put thousands of tokens into the context
 *    for a question like "what's low on stock" — the exact cost this service
 *    exists to avoid. Each tool projects to the few fields its question needs
 *    and caps its own output.
 * 2. TENANCY IS NOT A PARAMETER. The store id comes from the session, closed
 *    over at build time — never from a tool argument. A model that could name
 *    the store it reads is a model that can be talked into naming another one.
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { storeFor } from "../store/resolve.js";
import type { AbandonedCart, Customer, OrderStatus } from "../store/types.js";

/** Rows returned to the model per tool call. Above this, it gets a count. */
const ROW_CAP = 15;

/** `{shown, of, rows}` — the model can see when a list was truncated. */
function capped<T>(rows: T[]): { shown: number; of: number; rows: T[] } {
  return { shown: Math.min(rows.length, ROW_CAP), of: rows.length, rows: rows.slice(0, ROW_CAP) };
}

/**
 * Rows arrive in dakio-api's `orderOut`/`productOut`/`customerOut` shapes
 * (typed in `store/types.ts`). Note what is NOT there: the merchant's human
 * `orderNumber` is dropped by `orderOut`, so this surface can only name an
 * order by id. Keep the projected field names in sync with the mapper — an
 * assumed name silently becomes `undefined` and JSON.stringify drops it, so
 * the model just never sees the field. `scripts/smoke-tools.ts` is what
 * catches that.
 */

/**
 * `cartOut` carries neither of these today — they project to null — but the
 * output shape predates the StoreClient port and is kept stable for the model.
 */
type ApiCart = AbandonedCart & { customerName?: string | null; createdAt?: string };

/**
 * Build the tool set for ONE store. Called per turn with the session's store
 * id, so the returned tools are already scoped — see rule 2 above.
 */
export function storeReadTools(storeId: string) {
  return {
    get_orders: createTool({
      id: "get_orders",
      description:
        "Orders for this store, newest first. Use for questions about sales, what is pending/shipped/delivered, or which orders need attention.",
      inputSchema: z.object({
        status: z
          .enum(["placed", "confirmed", "packed", "fulfilled", "delivered", "cancelled", "returned"])
          .optional()
          .describe("Filter to one status; omit for all"),
        sinceDays: z.number().int().positive().max(365).default(30).describe("Look-back window in days"),
      }),
      execute: async ({ sinceDays, status }) => {
        // The tool's status vocabulary predates the typed OrderStatus; it is
        // passed through verbatim, exactly as the query param always was.
        const orders = await storeFor(storeId).listOrders({
          sinceDays,
          status: status as OrderStatus | undefined,
        });
        const revenue = orders
          .filter((o) => o.status !== "cancelled" && (o.status as string) !== "returned")
          .reduce((sum, o) => sum + (o.total || 0), 0);
        return {
          ...capped(
            orders.map((o) => ({
              id: o.id,
              status: o.status,
              total: o.total,
              placedAt: o.placedAt,
              region: o.region || null,
              items: (o.items ?? []).map((i) => `${i.productName} ×${i.quantity}`),
            })),
          ),
          revenue,
        };
      },
    }),

    get_products: createTool({
      id: "get_products",
      description:
        "Catalog with live stock. Use for stock questions, restock decisions, pricing, or to find a product by name.",
      inputSchema: z.object({
        lowStockOnly: z.boolean().default(false).describe("Only products at or below their reorder point"),
        search: z.string().optional().describe("Case-insensitive substring of the product name or SKU"),
      }),
      execute: async ({ lowStockOnly, search }) => {
        const products = await storeFor(storeId).listProducts();
        let rows = products;
        if (lowStockOnly) rows = rows.filter((p) => p.stock <= p.reorderPoint);
        if (search) {
          const q = search.toLowerCase();
          rows = rows.filter((p) => p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q));
        }
        return capped(
          rows.map((p) => ({
            sku: p.sku,
            name: p.name,
            category: p.category,
            price: p.price,
            stock: p.stock,
            reorderPoint: p.reorderPoint,
            status: p.status,
          })),
        );
      },
    }),

    get_customers: createTool({
      id: "get_customers",
      description: "Customers on file with lifetime value and segment. Use for retention, VIP or repeat-buyer questions.",
      inputSchema: z.object({
        segment: z.string().optional().describe("Filter to one segment (e.g. vip, repeat, new)"),
      }),
      execute: async ({ segment }) => {
        // `customerOut` carries no phone on this surface, by design. Free-form
        // segment strings pass through as the query param always did.
        const customers = await storeFor(storeId).listCustomers(
          segment ? { segment: segment as Customer["segment"] } : undefined,
        );
        // Highest-value first: "who are my best customers" is the question
        // this tool is actually asked, and the cap should keep those.
        const sorted = [...customers].sort((a, b) => (b.lifetimeValue || 0) - (a.lifetimeValue || 0));
        return {
          ...capped(
            sorted.map((c) => ({
              name: c.name ?? null,
              segment: c.segment,
              lifetimeValue: c.lifetimeValue,
              orders: c.ordersCount ?? 0,
              lastOrderAt: c.lastOrderAt ?? null,
            })),
          ),
          combinedLifetimeValue: customers.reduce((sum, c) => sum + (c.lifetimeValue || 0), 0),
        };
      },
    }),

    get_abandoned_carts: createTool({
      id: "get_abandoned_carts",
      description: "Abandoned checkouts still open, with their recoverable value. Use for cart-recovery questions.",
      inputSchema: z.object({}),
      execute: async () => {
        const carts: ApiCart[] = await storeFor(storeId).listAbandonedCarts();
        const open = carts.filter((c) => c.recoveryState !== "recovered" && c.recoveryState !== "lost");
        return {
          ...capped(
            open.map((c) => ({
              customerName: c.customerName ?? null,
              value: c.value,
              recoveryState: c.recoveryState,
              createdAt: c.createdAt ?? null,
            })),
          ),
          recoverableValue: open.reduce((sum, c) => sum + (c.value || 0), 0),
        };
      },
    }),

    get_finance_overview: createTool({
      id: "get_finance_overview",
      description:
        "Cash, receivables, payables, stock value and month P&L from the ledger. Use for money questions. Returns ledgerActive=false when the store has not onboarded the ledger — say so rather than inferring the numbers from orders.",
      inputSchema: z.object({}),
      execute: async () => storeFor(storeId).getFinanceOverview(),
    }),
  };
}

export type StoreReadTools = ReturnType<typeof storeReadTools>;
export type StoreToolName = keyof StoreReadTools;

export const ALL_TOOL_NAMES: StoreToolName[] = [
  "get_orders",
  "get_products",
  "get_customers",
  "get_abandoned_carts",
  "get_finance_overview",
];
