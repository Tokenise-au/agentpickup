import Stripe from "stripe";
import type { Order } from "@agentpickup/core";
import type { StripeRailConfig } from "../config.js";

export interface CardRail {
  createCheckout(
    order: Order,
    opts: { success: string; cancel: string; expiresAt: number },
  ): Promise<{ url: string; sessionId: string }>;
  /** Returns the PaymentIntent id once the customer has paid (or the hold is in place). */
  confirmSession(sessionId: string): Promise<{ orderId: string; paymentIntentId: string; email: string | null } | null>;
  /** Take the held money at handover. A no-op for already-charged payments. */
  capture(paymentIntentId: string, amountCents?: number): Promise<void>;
  /** Release a hold, or refund a charge, when an order is never collected. Returns what happened. */
  release(paymentIntentId: string): Promise<"hold_released" | "refunded" | "nothing_to_do">;
  parseWebhook(rawBody: string, signature: string): Stripe.Event | null;
}

export function stripeCardRail(config: StripeRailConfig): CardRail {
  const stripe = new Stripe(config.secretKey);
  const hold = (config.captureMode ?? "hold") === "hold";

  async function paymentIntentFor(sessionId: string) {
    const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ["payment_intent"] });
    const pi = session.payment_intent as Stripe.PaymentIntent | null;
    return { session, pi };
  }

  return {
    async createCheckout(order, opts) {
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        customer_email: order.customerEmail ?? undefined,
        line_items: order.items.map((item) => ({
          quantity: item.qty,
          price_data: {
            currency: order.currency,
            unit_amount: item.unitCents,
            product_data: { name: item.name },
          },
        })),
        payment_intent_data: {
          capture_method: hold ? "manual" : "automatic",
          metadata: { collect_order_id: order.id },
        },
        metadata: { collect_order_id: order.id },
        client_reference_id: order.id,
        success_url: opts.success,
        cancel_url: opts.cancel,
        // Stripe allows 30 minutes to 24 hours; unpaid orders are cancelled at the same moment.
        expires_at: Math.floor(opts.expiresAt / 1000),
      });
      if (!session.url) throw new Error("Stripe returned no checkout URL");
      return { url: session.url, sessionId: session.id };
    },

    async confirmSession(sessionId) {
      const { session, pi } = await paymentIntentFor(sessionId);
      const orderId = session.metadata?.collect_order_id ?? session.client_reference_id;
      if (!orderId || session.status !== "complete" || !pi) return null;
      if (pi.status !== "requires_capture" && pi.status !== "succeeded") return null;
      return { orderId, paymentIntentId: pi.id, email: session.customer_details?.email ?? null };
    },

    async capture(paymentIntentId, amountCents) {
      const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
      if (pi.status === "succeeded") return;
      if (pi.status !== "requires_capture") throw new Error(`payment ${pi.id} is ${pi.status}, cannot capture`);
      await stripe.paymentIntents.capture(paymentIntentId, amountCents ? { amount_to_capture: amountCents } : {});
    },

    async release(paymentIntentId) {
      const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
      if (pi.status === "requires_capture") {
        await stripe.paymentIntents.cancel(paymentIntentId, { cancellation_reason: "abandoned" });
        return "hold_released";
      }
      if (pi.status === "succeeded") {
        await stripe.refunds.create({ payment_intent: paymentIntentId, reason: "requested_by_customer" });
        return "refunded";
      }
      return "nothing_to_do";
    },

    parseWebhook(rawBody, signature) {
      if (!config.webhookSecret) return null;
      return stripe.webhooks.constructEvent(rawBody, signature, config.webhookSecret);
    },
  };
}
