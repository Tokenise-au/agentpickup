import type { CaptureMode, CollectEvent, Order } from "@agentpickup/core";
import type { FacilitatorClient } from "@x402/core/server";
import type { MppRailConfig } from "./rails/mpp.js";
import type { SptStripeConfig } from "./rails/spt.js";
import type { AcpConfig } from "./acp.js";
import type { Ap2Config } from "./ap2.js";
import type { AgentSignatureConfig } from "./agent-signatures.js";
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
  /** Shown to agent platforms (UCP links). */
  termsUrl?: string;
  privacyUrl?: string;
  location: { name: string; address?: string; hours?: string };
}

/** What a shop passes in. `location` defaults to the shop's own name, for a shop with one counter. */
export type MerchantConfig = Omit<MerchantProfile, "location"> & { location?: MerchantProfile["location"] };

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
  /** A facilitator client of your own (a self-hosted facilitator, or a fake in tests). Overrides facilitatorUrl. */
  facilitator?: FacilitatorClient;
  /**
   * For shops that price in another currency: convert an order total to US cents for USDC, from whatever
   * rate source you trust. Called once when an x402 order is created; the result is fixed on the order, so
   * the quote and the payment always agree. Required when `currency` isn't "usd".
   */
  toUsdCents?: (amountCents: number, currency: string) => number | Promise<number>;
}

export interface CollectConfig {
  /** Public origin the QR links point at, e.g. "https://orders.yourshop.com". */
  baseUrl: string;
  merchant: MerchantConfig;
  catalog: CatalogItem[];
  /** ISO currency the catalog is priced in. x402 settles in USDC: see payments.x402.toUsdCents for other currencies. */
  currency?: string;
  store: Store;
  mailer: Mailer;
  /** PKCS#8 PEM for the Ed25519 key that signs passes. */
  signingKeyPem: string;
  payments: {
    card?: StripeRailConfig;
    x402?: X402RailConfig;
    /** MPP (Machine Payments Protocol): agents pay by card or Link through Stripe Shared Payment Tokens. */
    mpp?: MppRailConfig;
    /** Instant pretend payments for demos and local work. Never enable on a real shop. */
    test?: boolean;
  };
  /** UCP (Universal Commerce Protocol): checkout sessions with the pickup fulfilment method, at /ucp/v1. */
  ucp?: {
    stripe?: SptStripeConfig;
    /** AP2 mandates: sign every checkout and require a checkout mandate from platforms that support AP2. */
    ap2?: Ap2Config;
  };
  /** ACP (Agentic Commerce Protocol): checkout sessions with the pickup option, at /acp. */
  acp?: AcpConfig & { stripe?: SptStripeConfig };
  /**
   * Agent request signatures (RFC 9421: Visa Trusted Agent Protocol, Mastercard Agent Pay,
   * Web Bot Auth) on agent payment routes: x402 and MPP pay links, UCP and ACP.
   */
  agentSignatures?: AgentSignatureConfig;
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
  /** Shared secret for the staff scanner and staff API. */
  staffKey?: string;
  /** Run staff pages with no key at all. Demos only: without staffKey and this flag, staff routes are closed. */
  allowOpenStaff?: boolean;
  /** Called for every order event, e.g. to push into a POS or kitchen screen. */
  onEvent?: (event: CollectEvent, order: Order) => void | Promise<void>;
  /** POSTed a signed JSON copy of every event. */
  webhook?: { url: string; secret: string };
}
