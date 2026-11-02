import type { CaptureMode, CollectEvent, Order } from "@agentpickup/core";
import type { Mailer } from "./mail.js";
import type { Store } from "./store.js";

/** Everything a shopper or staff member sees comes from here, never from us. */
export interface MerchantProfile {
  name: string;
  /** Hex colour for buttons and the email header. */
  brandColor?: string;
  logoUrl?: string;
  /** "Orders <orders@yourshop.com>"; must be a sender your mail provider has verified. */
  fromEmail: string;
  supportEmail?: string;
  /** Where "Back to shop" links go after checkout. */
  shopUrl?: string;
  location: { name: string; address?: string; hours?: string };
}

export interface CatalogItem {
  id: string;
  name: string;
  priceCents: number;
  description?: string;
}

export interface StripeRailConfig {
  secretKey: string;
  /** Signing secret for /api/stripe/webhook. Without it the thanks page still confirms the order. */
  webhookSecret?: string;
  /**
   * "hold" authorises the card at checkout and captures when the pass is scanned.
   * Card holds lapse after about 7 days, so use "charge" for longer pickup windows.
   */
  captureMode?: CaptureMode;
}

export interface X402RailConfig {
  /** Wallet that receives USDC. */
  payTo: string;
  /** CAIP-2 network. Base Sepolia (eip155:84532) for testing, Base (eip155:8453) for real money. */
  network?: `${string}:${string}`;
  facilitatorUrl?: string;
}

export interface CollectConfig {
  /** Public origin the QR links point at, e.g. "https://orders.yourshop.com". */
  baseUrl: string;
  merchant: MerchantProfile;
  catalog: CatalogItem[];
  /** ISO currency for card payments. x402 prices are in USD (USDC). */
  currency?: string;
  store: Store;
  mailer: Mailer;
  /** PKCS#8 PEM for the Ed25519 key that signs passes. */
  signingKeyPem: string;
  payments: {
    card?: StripeRailConfig;
    x402?: X402RailConfig;
    /** Instant pretend payments for demos and local work. Never enable on a real shop. */
    test?: boolean;
  };
  /** IANA zone for times in emails and pages, e.g. "Australia/Brisbane". */
  timeZone?: string;
  /** Optional footer link in emails. Off by default: shoppers see only the merchant. */
  poweredBy?: { label: string; url: string };
  /** Minutes a paid order stays collectable. Default 24 hours. */
  collectWindowMinutes?: number;
  /**
   * What happens to the money when nobody collects in time. "release" (default) cancels a card
   * hold or refunds a card charge, and flags x402 payments for a manual refund. "keep" captures it.
   */
  noShowPolicy?: "release" | "keep";
  /** Lets /api/orders/:id/email-preview show the last email. For demos only. */
  exposeEmailPreview?: boolean;
  /** Shared secret for the staff scanner. Without it staff pages are open, which is only for demos. */
  staffKey?: string;
  /** Called for every order event, e.g. to push into a POS or kitchen screen. */
  onEvent?: (event: CollectEvent, order: Order) => void | Promise<void>;
  /** POSTed a signed JSON copy of every event. */
  webhook?: { url: string; secret: string };
}
