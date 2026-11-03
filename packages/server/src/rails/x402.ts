import type { MiddlewareHandler } from "hono";
import { sign } from "node:crypto";
import type { SigningKey } from "@agentpickup/core";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { PaymentPayload } from "@x402/core/types";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import {
  createJWSOfferReceiptIssuer,
  createOfferReceiptExtension,
  declareOfferReceiptExtension,
} from "@x402/extensions/offer-receipt";
import {
  declarePaymentIdentifierExtension,
  extractPaymentIdentifier,
  PAYMENT_IDENTIFIER,
  paymentIdentifierResourceServerExtension,
} from "@x402/extensions/payment-identifier";
import type { X402RailConfig } from "../config.js";

export const X402_PAY_ROUTE = "/api/orders/:id/pay";

export function orderIdFromPayPath(path: string): string | null {
  return path.match(/\/api\/orders\/([^/]+)\/pay$/)?.[1] ?? null;
}

/** did:web identifier for the merchant origin, e.g. did:web:shop.example or did:web:localhost%3A8402. */
export function didWebFor(baseUrl: string): string {
  return `did:web:${encodeURIComponent(new URL(baseUrl).host)}`;
}

/**
 * x402 "exact" payment for one order, priced from the order itself, with:
 * - bazaar discovery metadata, so facilitator catalogs can describe the route
 * - signed offers in the 402 and signed receipts on settlement (JWS, the pass-signing key, did:web kid)
 * - payment-identifier, so an agent retrying with the same id gets its original result back
 *
 * The public facilitator settles exact on Base and Base Sepolia; it does not yet relay
 * auth-capture holds, so agent payments are charged at order time.
 */
export function x402PayMiddleware(
  config: X402RailConfig,
  deps: { priceFor: (orderId: string) => Promise<string | null> | string | null; key: SigningKey; baseUrl: string },
): MiddlewareHandler {
  const network = config.network ?? "eip155:84532";
  const facilitator =
    config.facilitator ?? new HTTPFacilitatorClient({ url: config.facilitatorUrl ?? "https://x402.org/facilitator" });
  const kid = `${didWebFor(deps.baseUrl)}#${deps.key.kid}`;
  const issuer = createJWSOfferReceiptIssuer(kid, {
    kid,
    format: "jws",
    algorithm: "EdDSA",
    sign: async (input) => sign(null, input, deps.key.privateKey).toString("base64url"),
  });
  const server = new x402ResourceServer(facilitator)
    .register(network, new ExactEvmScheme())
    .registerExtension(bazaarResourceServerExtension)
    .registerExtension(createOfferReceiptExtension(issuer))
    .registerExtension(paymentIdentifierResourceServerExtension);
  return paymentMiddleware(
    {
      [`POST ${X402_PAY_ROUTE}`]: {
        accepts: [
          {
            scheme: "exact",
            network,
            payTo: config.payTo,
            maxTimeoutSeconds: 120,
            price: async (ctx) => {
              const id = orderIdFromPayPath(ctx.path);
              const price = id ? await deps.priceFor(id) : null;
              if (!price) throw new Error("order is not awaiting payment");
              return price;
            },
          },
        ],
        description: "Pay for a click-and-collect order. The pickup QR is emailed to the customer once the payment settles.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            bodyType: "json",
            input: {},
            pathParams: { id: "ord_7HkQ2mXc9aRt" },
            pathParamsSchema: {
              type: "object",
              properties: { id: { type: "string", description: "Order id returned by POST /api/orders" } },
              required: ["id"],
            },
            output: {
              example: {
                order: { id: "ord_7HkQ2mXc9aRt", status: "paid", totalCents: 450, currency: "usd" },
                passUrl: "https://shop.example/p/Ya7qVHjkKI7bn4gU",
                emailedTo: "customer@example.com",
              },
            },
          }),
          ...declareOfferReceiptExtension({ includeTxHash: true }),
          [PAYMENT_IDENTIFIER]: declarePaymentIdentifierExtension(false),
        },
      },
    },
    server,
  );
}

export interface Settlement {
  success: boolean;
  transaction: string;
  network: string;
  payer?: string;
  extensions?: Record<string, unknown>;
}

/** Read the facilitator's settlement result off a paid response. */
export function readSettlement(res: Response): Settlement | null {
  const header = res.headers.get("PAYMENT-RESPONSE") ?? res.headers.get("X-PAYMENT-RESPONSE");
  if (!header) return null;
  try {
    return JSON.parse(Buffer.from(header, "base64").toString("utf8")) as Settlement;
  } catch {
    return null;
  }
}

/** The signed receipt the offer-receipt extension put on the settlement, if any. */
export function receiptFrom(settlement: Settlement): unknown {
  const ext = settlement.extensions?.["offer-receipt"] as { info?: { receipt?: unknown } } | undefined;
  return ext?.info?.receipt ?? null;
}

/** The payment-identifier an agent attached to its payment, if any and if valid. */
export function paymentIdFromRequest(headers: Headers): string | null {
  const raw = headers.get("PAYMENT-SIGNATURE") ?? headers.get("X-PAYMENT");
  if (!raw) return null;
  try {
    const payload = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as PaymentPayload;
    return extractPaymentIdentifier(payload, true);
  } catch {
    return null;
  }
}
