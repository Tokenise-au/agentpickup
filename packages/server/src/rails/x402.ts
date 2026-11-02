import type { MiddlewareHandler } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { X402RailConfig } from "../config.js";

export const X402_PAY_ROUTE = "/api/orders/:id/pay";

export function orderIdFromPayPath(path: string): string | null {
  return path.match(/\/api\/orders\/([^/]+)\/pay$/)?.[1] ?? null;
}

/**
 * x402 "exact" payment for one order, priced from the order itself. The public
 * facilitator settles exact on Base and Base Sepolia; it does not yet relay
 * auth-capture holds, so agent payments are charged at order time.
 */
export function x402PayMiddleware(
  config: X402RailConfig,
  priceFor: (orderId: string) => string | null,
): MiddlewareHandler {
  const network = config.network ?? "eip155:84532";
  const facilitator = new HTTPFacilitatorClient({ url: config.facilitatorUrl ?? "https://x402.org/facilitator" });
  const server = new x402ResourceServer(facilitator).register(network, new ExactEvmScheme());
  return paymentMiddleware(
    {
      [`POST ${X402_PAY_ROUTE}`]: {
        accepts: [
          {
            scheme: "exact",
            network,
            payTo: config.payTo,
            maxTimeoutSeconds: 120,
            price: (ctx) => {
              const id = orderIdFromPayPath(ctx.path);
              const price = id ? priceFor(id) : null;
              if (!price) throw new Error("order is not awaiting payment");
              return price;
            },
          },
        ],
        description: "Click-and-collect order. The pickup QR is emailed to the customer once paid.",
        mimeType: "application/json",
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
