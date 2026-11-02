// MPP (Machine Payments Protocol, Stripe + Tempo): agents pay an order by card or Link
// through a Stripe Shared Payment Token, and the money lands in the merchant's own Stripe.
// mppx confirms the PaymentIntent immediately, so MPP orders are charged at order time.
import Stripe from "stripe";
import { Credential } from "mppx";
import { Mppx, stripe } from "mppx/server";
import type { Order } from "@agentpickup/core";

/** The slice of the Stripe SDK MPP needs: creating SPT PaymentIntents, and refunds for no-shows. */
export interface StripeLike {
  paymentIntents: { create(params: unknown, options?: unknown): Promise<unknown> };
  refunds: { create(params: { payment_intent: string; reason?: string }): Promise<unknown> };
}

export interface MppRailConfig {
  /** Stripe MPP network (profile) id from the Stripe dashboard. */
  networkId: string;
  /** Secret that binds MPP challenges to their contents. 32+ random characters. */
  challengeSecret: string;
  /** Merchant's Stripe secret key, or pass `stripeClient`. */
  stripeSecretKey?: string;
  /** A Stripe SDK instance (or a test double). Overrides stripeSecretKey. */
  stripeClient?: StripeLike;
  /** Defaults to card and Link. */
  paymentMethodTypes?: string[];
}

export const MPP_PAY_ROUTE = "/api/orders/:id/mpp";

export type MppResult =
  | { kind: "challenge"; response: Response }
  | { kind: "paid"; paymentIntentId: string; challengeId: string; respond: (res: Response) => Response };

export function createMppRail(config: MppRailConfig, opts: { realm: string; currency: string; merchantName: string }) {
  if (!config.networkId) throw new Error("MPP needs a Stripe networkId.");
  if (!config.challengeSecret || config.challengeSecret.length < 32) {
    throw new Error("MPP challengeSecret must be at least 32 characters.");
  }
  const client = config.stripeClient ?? (config.stripeSecretKey ? (new Stripe(config.stripeSecretKey) as unknown as StripeLike) : null);
  if (!client) throw new Error("MPP needs stripeSecretKey or stripeClient.");

  const mppx = Mppx.create({
    methods: [
      stripe.charge({
        client: client as never,
        networkId: config.networkId,
        paymentMethodTypes: config.paymentMethodTypes ?? ["card", "link"],
      }),
    ],
    secretKey: config.challengeSecret,
    realm: opts.realm,
  });

  return {
    /** Issue a challenge, or verify the credential on the request and charge the order. */
    async charge(request: Request, order: Order): Promise<MppResult> {
      const result = await mppx.charge({
        amount: (order.totalCents / 100).toFixed(2),
        currency: opts.currency,
        decimals: 2,
        description: `${opts.merchantName} pickup order ${order.id}`,
        // Binds the credential to this order, so it can't be spent on another one.
        externalId: order.id,
        paymentIntentOptions: {
          metadata: { agentpickup_order_id: order.id },
          ...(order.customerEmail ? { receipt_email: order.customerEmail } : {}),
        },
      })(request);
      if (result.status === 402) return { kind: "challenge", response: result.challenge as Response };
      const probe = result.withReceipt(new Response(null));
      const receipt = JSON.parse(Buffer.from(probe.headers.get("Payment-Receipt") ?? "", "base64url").toString("utf8")) as {
        reference: string;
      };
      return {
        kind: "paid",
        paymentIntentId: receipt.reference,
        challengeId: challengeIdOf(request.headers.get("Authorization")) ?? "",
        respond: (res) => result.withReceipt(res),
      };
    },

    /** Refund an MPP charge when nobody collects. */
    async refund(paymentIntentId: string) {
      await client.refunds.create({ payment_intent: paymentIntentId, reason: "requested_by_customer" });
    },
  };
}

/** The challenge id inside an `Authorization: Payment ...` credential, if it parses. */
export function challengeIdOf(authorization: string | null | undefined): string | null {
  if (!authorization) return null;
  try {
    return Credential.deserialize(authorization).challenge.id;
  } catch {
    return null;
  }
}
