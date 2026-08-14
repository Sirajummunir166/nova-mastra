/**
 * dakio-api reads/writes the front office needs — thin typed adapters over
 * the tenant's `StoreClient` (`storeFor`), which carries the same
 * service-token auth the rest of nova-mastra uses.
 *
 * Invariant carried over from nova-ai: NO write payload ever carries a
 * price. The server prices every line, resolves the delivery charge from
 * the district, re-validates coupons, and decrements stock in one
 * transaction (dakio-api novaStore.js createChatOrder).
 */

import { storeFor } from "../store/resolve.js";

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
  const products = await storeFor(storeId).listProducts({ status: "active" });
  // Same `productOut` rows as before the StoreClient port. NOTE: at runtime
  // `variantStock`/`variantIds` are name-keyed records (see `store/types.ts`
  // Product), not the arrays this interface has always declared — the typing
  // predates the port and is kept verbatim so callers (hydrate.ts) need no
  // changes.
  return products as unknown as DakioProduct[];
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
  return storeFor(storeId).getStoreSettings();
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
  /**
   * The caller's attestation that the customer said yes. Part of this
   * module's contract with `turn.ts`; the wire body (`ChatOrderRequest`)
   * doesn't carry it — the server never read it.
   */
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

export async function createChatOrder(storeId: string, input: ChatOrderInput): Promise<ChatOrderResult> {
  // Maps onto the client's `ChatOrderRequest`: `conversationId` rides as
  // `sourceConversationId` (the field the route actually reads — it lands on
  // `Order.sourceConversationId` and resolves `sourceChannel` from the
  // thread). Still no price anywhere on the way in, by design.
  const result = await storeFor(storeId).createChatOrder({
    novaActionId: input.novaActionId,
    sourceConversationId: input.conversationId ?? "",
    customerName: input.customerName,
    customerPhone: input.customerPhone,
    customerCity: input.customerCity,
    customerDistrict: input.customerDistrict,
    customerAddress: input.customerAddress,
    items: input.items,
    couponCode: input.couponCode,
  });
  return {
    id: result.id,
    orderNumber: result.orderNumber,
    total: result.total,
    shippingCharge: result.shippingCharge,
    codAmount: result.codAmount,
    status: result.status,
    customerId: result.customerId ?? undefined,
    trackingUrl: result.trackingUrl ?? undefined,
  };
}
