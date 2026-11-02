// Charging a Stripe Shared Payment Token (SPT) handed over by an agent platform, as UCP's
// com.stripe.payments handler and ACP's delegated payment both do. The PaymentIntent is
// created in the merchant's own Stripe account and confirmed straight away.
import Stripe from "stripe";
import type { StripeLike } from "./mpp.js";

export interface SptStripeConfig {
  /** Merchant's Stripe secret key (a restricted key with PaymentIntents write is enough), or pass `client`. */
  secretKey?: string;
  client?: StripeLike;
  /** Stripe profile id (profile_*), advertised to UCP platforms. */
  businessProfile?: string;
  environment?: "testmode" | "livemode";
}

export function sptClient(config: SptStripeConfig): StripeLike {
  if (config.client) return config.client;
  if (config.secretKey) return new Stripe(config.secretKey) as unknown as StripeLike;
  throw new Error("Stripe SPT payments need secretKey or client.");
}

export async function chargeSpt(
  client: StripeLike,
  o: { amountCents: number; currency: string; spt: string; orderId: string; idempotencyKey: string; receiptEmail?: string | null },
): Promise<{ paymentIntentId: string }> {
  const pi = (await client.paymentIntents.create(
    {
      amount: o.amountCents,
      currency: o.currency.toLowerCase(),
      payment_method_data: { shared_payment_granted_token: o.spt },
      confirm: true,
      automatic_payment_methods: { enabled: true, allow_redirects: "never" },
      metadata: { agentpickup_order_id: o.orderId },
      ...(o.receiptEmail ? { receipt_email: o.receiptEmail } : {}),
    },
    { idempotencyKey: o.idempotencyKey },
  )) as { id: string; status: string };
  if (pi.status !== "succeeded") throw new Error(`Stripe PaymentIntent is ${pi.status}`);
  return { paymentIntentId: pi.id };
}
