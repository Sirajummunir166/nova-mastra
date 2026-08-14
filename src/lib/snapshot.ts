/**
 * CEO snapshot — the numbers behind the hello turn. Pulls the store's live
 * data in parallel through the tenant's `StoreClient` (`storeFor`) and
 * compresses it into a small text block (~300 tokens) for the per-turn
 * instructions. This is the token discipline: aggregate server-side, never
 * hand the model raw row dumps.
 */

import { storeFor } from "../store/resolve.js";

// Lite views of the client's return shapes — only the fields the snapshot
// aggregates. The full `store/types.js` rows are structurally assignable.

interface OrderItem {
  productName: string;
  quantity: number;
}

interface Order {
  total: number;
  status: string;
  placedAt: string;
  items: OrderItem[];
}

interface Product {
  name: string;
  price: number;
  stock: number;
  reorderPoint: number;
  status: string;
}

interface Customer {
  segment: string;
  lifetimeValue: number;
}

interface Cart {
  value: number;
  recoveryState: string;
}

/**
 * One guarded client call. A failed source answers `null` so its section can
 * degrade to "(unavailable)" instead of killing the whole snapshot.
 */
async function pull<T>(storeId: string, label: string, call: () => Promise<T>): Promise<T | null> {
  try {
    return await call();
  } catch (err) {
    console.warn(`[snapshot] ${label} for ${storeId} failed:`, err instanceof Error ? err.message : err);
    return null;
  }
}

function money(n: number, currency: string): string {
  return `${currency} ${Math.round(n).toLocaleString("en-US")}`;
}

/**
 * Build the snapshot block, one section per data source. A failed source
 * degrades to a "(unavailable)" line — the report must never block the turn.
 */
export async function buildCeoSnapshot(storeId: string, currency: string): Promise<string> {
  const client = storeFor(storeId);
  const [orders, products, customers, carts, finance] = await Promise.all([
    pull<Order[]>(storeId, "orders", () => client.listOrders({ sinceDays: 30 })),
    pull<Product[]>(storeId, "products", () => client.listProducts()),
    pull<Customer[]>(storeId, "customers", () => client.listCustomers()),
    pull<Cart[]>(storeId, "carts", () => client.listAbandonedCarts()),
    pull<Record<string, unknown>>(
      storeId,
      "finance/overview",
      async () => (await client.getFinanceOverview()) as unknown as Record<string, unknown>,
    ),
  ]);

  const lines: string[] = ["## Live store snapshot (real data, just pulled)"];
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;

  if (orders) {
    const last7 = orders.filter((o) => now - Date.parse(o.placedAt) <= 7 * DAY);
    const revenue = (list: Order[]) =>
      list.filter((o) => o.status !== "cancelled" && o.status !== "returned")
        .reduce((sum, o) => sum + (o.total || 0), 0);
    const byStatus = new Map<string, number>();
    for (const o of orders) byStatus.set(o.status, (byStatus.get(o.status) ?? 0) + 1);
    const statusStr = [...byStatus.entries()].map(([s, n]) => `${s} ${n}`).join(", ");

    const soldByProduct = new Map<string, number>();
    for (const o of orders) {
      for (const item of o.items ?? []) {
        soldByProduct.set(item.productName, (soldByProduct.get(item.productName) ?? 0) + item.quantity);
      }
    }
    const top = [...soldByProduct.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);

    lines.push(
      `- Orders 30d: ${orders.length} (revenue ${money(revenue(orders), currency)}) · last 7d: ${last7.length} (${money(revenue(last7), currency)})`,
      `- Order status: ${statusStr || "none"}`,
    );
    if (top.length > 0) {
      lines.push(`- Top sellers 30d: ${top.map(([name, qty]) => `${name} (${qty} pcs)`).join(", ")}`);
    }
  } else {
    lines.push("- Orders: (unavailable)");
  }

  if (products) {
    const active = products.filter((p) => p.status === "active");
    const low = products.filter((p) => p.stock <= p.reorderPoint);
    lines.push(`- Catalog: ${products.length} products (${active.length} active)`);
    if (low.length > 0) {
      lines.push(
        `- LOW STOCK (at/below reorder point): ${low.slice(0, 5).map((p) => `${p.name} (${p.stock} left)`).join(", ")}${low.length > 5 ? ` +${low.length - 5} more` : ""}`,
      );
    }
  } else {
    lines.push("- Catalog: (unavailable)");
  }

  if (customers) {
    const ltv = customers.reduce((sum, c) => sum + (c.lifetimeValue || 0), 0);
    lines.push(`- Customers: ${customers.length} on file · combined LTV ${money(ltv, currency)}`);
  } else {
    lines.push("- Customers: (unavailable)");
  }

  if (carts) {
    const open = carts.filter((c) => c.recoveryState !== "recovered" && c.recoveryState !== "lost");
    if (open.length > 0) {
      lines.push(`- Abandoned carts: ${open.length} open, ${money(open.reduce((s, c) => s + (c.value || 0), 0), currency)} recoverable`);
    } else {
      lines.push("- Abandoned carts: none open");
    }
  }

  if (finance && finance.ledgerActive === true) {
    // Ledger is onboarded — surface whatever headline figures the overview carries.
    const nums = Object.entries(finance)
      .filter(([k, v]) => typeof v === "number" && k !== "ledgerActive")
      .slice(0, 6)
      .map(([k, v]) => `${k} ${money(v as number, currency)}`);
    if (nums.length > 0) lines.push(`- Finance (ledger): ${nums.join(" · ")}`);
  }

  return lines.join("\n");
}
