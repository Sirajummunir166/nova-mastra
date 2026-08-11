/**
 * CEO snapshot — the numbers behind the hello turn. Pulls the store's live
 * data from dakio-api in parallel and compresses it into a small text block
 * (~300 tokens) for the per-turn instructions. This is the token discipline:
 * aggregate server-side, never hand the model raw row dumps.
 */

import { serviceTokenFor } from "./service-token.js";

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

const SNAPSHOT_TIMEOUT_MS = 8000;

async function apiGet<T>(storeId: string, path: string): Promise<T | null> {
  const baseUrl = process.env.DAKIO_API_URL;
  if (!baseUrl) throw new Error("DAKIO_API_URL is not set");
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${serviceTokenFor(storeId)}` },
      signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[snapshot] ${path} for ${storeId}: HTTP ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.warn(`[snapshot] ${path} for ${storeId} failed:`, err instanceof Error ? err.message : err);
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
  const [ordersRes, productsRes, customersRes, cartsRes, financeRes] = await Promise.all([
    apiGet<{ orders: Order[] }>(storeId, "/api/v1/store/orders?sinceDays=30"),
    apiGet<{ products: Product[] }>(storeId, "/api/v1/store/products"),
    apiGet<{ customers: Customer[] }>(storeId, "/api/v1/store/customers"),
    apiGet<{ carts: Cart[] }>(storeId, "/api/v1/store/carts"),
    apiGet<Record<string, unknown>>(storeId, "/api/v1/store/finance/overview"),
  ]);

  const lines: string[] = ["## Live store snapshot (real data, just pulled)"];
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;

  if (ordersRes?.orders) {
    const orders = ordersRes.orders;
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

  if (productsRes?.products) {
    const products = productsRes.products;
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

  if (customersRes?.customers) {
    const customers = customersRes.customers;
    const ltv = customers.reduce((sum, c) => sum + (c.lifetimeValue || 0), 0);
    lines.push(`- Customers: ${customers.length} on file · combined LTV ${money(ltv, currency)}`);
  } else {
    lines.push("- Customers: (unavailable)");
  }

  if (cartsRes?.carts) {
    const open = cartsRes.carts.filter((c) => c.recoveryState !== "recovered" && c.recoveryState !== "lost");
    if (open.length > 0) {
      lines.push(`- Abandoned carts: ${open.length} open, ${money(open.reduce((s, c) => s + (c.value || 0), 0), currency)} recoverable`);
    } else {
      lines.push("- Abandoned carts: none open");
    }
  }

  if (financeRes && financeRes.ledgerActive === true) {
    // Ledger is onboarded — surface whatever headline figures the overview carries.
    const nums = Object.entries(financeRes)
      .filter(([k, v]) => typeof v === "number" && k !== "ledgerActive")
      .slice(0, 6)
      .map(([k, v]) => `${k} ${money(v as number, currency)}`);
    if (nums.length > 0) lines.push(`- Finance (ledger): ${nums.join(" · ")}`);
  }

  return lines.join("\n");
}
