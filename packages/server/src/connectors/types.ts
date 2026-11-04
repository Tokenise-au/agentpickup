// The contract between agentPickup and the systems a venue already runs (a POS, an ordering platform,
// an order aggregator). A connector pulls the menu in, sends each paid order to the venue's own screens,
// and passes status back, so agent orders arrive where staff already work.
import type { Hono } from "hono";
import type { CollectEvent, Order } from "@agentpickup/core";
import type { CatalogItem, PickupLocation } from "../config.js";

export interface ConnectorContext {
  baseUrl: string;
  /** The shop's currency, lower case ("aud"). Menu prices in any other currency are skipped. */
  currency: string;
  getOrder(id: string): Promise<Order | null>;
  /** Mark a paid order ready to collect, as staff do; the customer gets the "ready" email. */
  markReady(orderId: string): Promise<unknown>;
  /** A connector that took the payment itself (cardPayments) records it; the receipt email follows. */
  markPaid(orderId: string, payment: { paymentRef: string; email?: string | null; meta?: Record<string, unknown> }): Promise<Order>;
  /** A page in the shop's name, colours and logo, for a connector's own screens (a checkout page). */
  page(o: { title: string; body: string; scripts?: string[]; inlineScript?: string }): string;
  /** Replace the menu. Orders already placed keep the prices they were placed at. */
  setCatalog(items: CatalogItem[]): Promise<void>;
  /** Remember which platform record an order became, in both directions. */
  link(orderId: string, externalId: string, data?: Record<string, unknown>): Promise<void>;
  linked(orderId: string): Promise<({ externalId: string } & Record<string, unknown>) | null>;
  orderFor(externalId: string): Promise<string | null>;
}

/** What a platform knows about the venue. It fills in whatever the shop's own settings leave out. */
export interface ShopProfile {
  name?: string;
  logoUrl?: string;
  /** "#rrggbb", for headers and buttons. */
  brandColor?: string;
  supportEmail?: string;
  shopUrl?: string;
  phone?: string;
  /** IANA zone, e.g. "Australia/Sydney". */
  timeZone?: string;
  location?: Partial<PickupLocation>;
}

export interface PickupConnector {
  /** Short, URL-safe name: "square". Routes mount at /connect/<name>/. */
  name: string;
  /** Pull the venue's menu from the platform. Runs at start and on POST /connect/v1/catalog/sync. */
  fetchCatalog?(ctx: ConnectorContext): Promise<CatalogItem[]>;
  /** Pull the venue's name, logo, address, hours and map position. Runs at start, hourly and on sync. */
  fetchProfile?(ctx: ConnectorContext): Promise<ShopProfile>;
  /** React to an order event: send a paid order to the venue's screens, close it out when collected. */
  onEvent?(event: CollectEvent, order: Order, ctx: ConnectorContext): Promise<void>;
  /** Routes the platform calls back on, such as a webhook receiver, under /connect/<name>/. */
  routes?(app: Hono, ctx: ConnectorContext): void;
  /**
   * The platform takes card payments itself (the "square" rail): the buyer pays on the connector's checkout
   * page, the money lands in the venue's own account there, and a no-show is refunded through it.
   */
  cardPayments?: {
    /** Real money: false in a sandbox. */
    live: boolean;
    /** Where the buyer pays for this order. */
    checkoutUrl(order: Order, ctx: ConnectorContext): string;
    /** Give an uncollected order's money back. */
    refund(order: Order, ctx: ConnectorContext): Promise<void>;
  };
}
