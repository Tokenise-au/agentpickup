// What the agent checkout protocols (UCP, ACP) need from the core server.
import type { Order, PaymentRail } from "@agentpickup/core";
import type { CatalogItem, MerchantProfile } from "./config.js";
import type { Store } from "./store.js";

export interface OrderInput {
  items: { id: string; qty: number }[];
  email?: string;
  name?: string;
  rail: PaymentRail;
}

export interface ProtocolCore {
  store: Store;
  merchant: MerchantProfile;
  catalog: CatalogItem[];
  currency: string;
  base: string;
  testPayments: boolean;
  createOrder(input: OrderInput): Order;
  markPaid(orderId: string, payment: { paymentRef: string; payer?: string | null; email?: string | null; meta?: Record<string, unknown> }): Promise<Order>;
  cancelUnpaid(orderId: string): void;
  passUrl(order: Order): string;
}

/** Line items priced from the catalog; unknown ids are reported, never trusted. */
export function priceLines(catalog: CatalogItem[], lines: { id: string; qty: number }[]) {
  const byId = new Map(catalog.map((c) => [c.id, c]));
  const unknown: string[] = [];
  const priced = [] as { id: string; title: string; priceCents: number; qty: number }[];
  for (const l of lines) {
    const item = byId.get(l.id);
    if (!item) unknown.push(l.id);
    else priced.push({ id: item.id, title: item.name, priceCents: item.priceCents, qty: l.qty });
  }
  return { priced, unknown, totalCents: priced.reduce((s, l) => s + l.priceCents * l.qty, 0) };
}
