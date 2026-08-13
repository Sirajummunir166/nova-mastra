/**
 * dakio-api reads/writes the front office needs — thin typed fetchers over
 * the same service-token auth the rest of nova-mastra uses.
 *
 * Invariant carried over from nova-ai: NO write payload ever carries a
 * price. The server prices every line, resolves the delivery charge from
 * the district, re-validates coupons, and decrements stock in one
 * transaction (dakio-api novaStore.js createChatOrder).
 */

import { serviceTokenFor } from "../lib/service-token.js";
import { dakioBaseUrl } from "../lib/dakio-base.js";

const TIMEOUT_MS = 10_000;

async function api<T>(storeId: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${dakioBaseUrl()}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${serviceTokenFor(storeId)}`,
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = JSON.stringify(await res.json()).slice(0, 300);
    } catch {
      /* no body */
    }
    throw new Error(`dakio-api ${init.method ?? "GET"} ${path} → ${res.status}${detail ? ` ${detail}` : ""}`);
  }
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Products — customer projection (novaStore.js): no cost/margin/supplier
// ---------------------------------------------------------------------------

export interface DakioProduct {
  id: string;
  sku: string;
  name: string;
  category: string;
  price: number;
  compareAtPrice: number | null;
  stock: number;
  status: string;
  variantNames?: string[];
  variantStock?: number[];
  variantIds?: string[];
}

export async function listProducts(storeId: string): Promise<DakioProduct[]> {
  const { products } = await api<{ products: DakioProduct[] }>(storeId, "/api/v1/store/products?status=active");
  return products;
}

// ---------------------------------------------------------------------------
// Store settings — delivery charges, COD, policies
// ---------------------------------------------------------------------------

export interface DakioSettings {
  storeName: string;
  storefrontUrl?: string | null;
  deliveryInsideDhaka: number;
  deliveryOutsideDhaka: number;
  codAvailable: boolean;
  policies: Array<{ key: string; textBn?: string | null; textEn?: string | null }>;
}

export function getSettings(storeId: string): Promise<DakioSettings> {
  return api<DakioSettings>(storeId, "/api/v1/store/settings");
}

// ---------------------------------------------------------------------------
// Chat order — server prices everything; confirmedByCustomer is a literal true
// ---------------------------------------------------------------------------

export interface ChatOrderInput {
  /** At-most-once key + ledger receipt — server replays the existing order on a hit. */
  novaActionId: string;
  conversationId?: string;
  customerName: string;
  customerPhone: string;
  customerCity: string;
  customerDistrict: string;
  customerAddress?: string;
  items: Array<{ productId: string; variantId?: string; productName: string; qty: number }>;
  couponCode?: string;
  confirmedByCustomer: true;
}

export interface ChatOrderResult {
  id: string;
  orderNumber: string;
  total: number;
  shippingCharge: number;
  codAmount: number;
  status: string;
  customerId?: string;
  trackingUrl?: string;
}

export function createChatOrder(storeId: string, input: ChatOrderInput): Promise<ChatOrderResult> {
  return api<ChatOrderResult>(storeId, "/api/v1/store/orders", { method: "POST", body: input });
}
