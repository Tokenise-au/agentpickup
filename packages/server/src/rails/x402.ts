import type { MiddlewareHandler } from "hono";
import { sign } from "node:crypto";
import type { Order, SigningKey } from "@agentpickup/core";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload } from "@x402/core/types";
import { getAddress, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
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
/** Order and pay in one call, at an address that stays the same, so x402 catalogues can list the shop. */
export const X402_ORDER_ROUTE = "/api/x402/order";

export function orderIdFromPayPath(path: string): string | null {
  return path.match(/\/api\/orders\/([^/]+)\/pay$/)?.[1] ?? null;
}

/** did:web identifier for the merchant origin, e.g. did:web:shop.example or did:web:localhost%3A8402. */
/** did:web for the shop: did:web:host, or did:web:host:v:cafe for a shop under a path (its document at /v/cafe/did.json). */
export function didWebFor(baseUrl: string): string {
  const url = new URL(baseUrl);
  const path = url.pathname.split("/").filter(Boolean).map(encodeURIComponent);
  return ["did:web", encodeURIComponent(url.host), ...path].join(":");
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
  // The x402 middleware matches the full request path, so a shop under a path registers its prefix.
): MiddlewareHandler {
  const network = config.network ?? "eip155:84532";
  const server = resourceServer(config, deps.key, deps.baseUrl);
  return paymentMiddleware(
    {
      [`POST ${new URL(deps.baseUrl).pathname.replace(/\/+$/, "")}${X402_PAY_ROUTE}`]: {
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

/** The x402 resource server for a shop: its facilitator, plus bazaar, signed offers/receipts and payment-identifier. */
function resourceServer(config: X402RailConfig, key: SigningKey, baseUrl: string) {
  const facilitator =
    config.facilitator ?? new HTTPFacilitatorClient({ url: config.facilitatorUrl ?? "https://x402.org/facilitator" });
  const kid = `${didWebFor(baseUrl)}#${key.kid}`;
  const issuer = createJWSOfferReceiptIssuer(kid, {
    kid,
    format: "jws",
    algorithm: "EdDSA",
    sign: async (input) => sign(null, input, key.privateKey).toString("base64url"),
  });
  return new x402ResourceServer(facilitator)
    .register(config.network ?? "eip155:84532", new ExactEvmScheme())
    .registerExtension(bazaarResourceServerExtension)
    .registerExtension(createOfferReceiptExtension(issuer))
    .registerExtension(paymentIdentifierResourceServerExtension);
}

export interface OrderRouteListing {
  /** What the catalogue shows: the shop, where to collect, how it's paid. */
  description: string;
  serviceName: string;
  tags: string[];
  iconUrl?: string;
  /** An item id from the menu, for the examples. */
  exampleItem: string;
}

/**
 * The one-step order at a fixed address: GET <shop>/api/x402/order?items=id:qty,... (what catalogue checks call,
 * and agents that only GET), or POST with { items, email?, name? } for a QR by email too. Priced from the items
 * on every request; with no items, one of the first menu item.
 */
export function x402OrderMiddleware(
  config: X402RailConfig,
  deps: { quote: (ctx: { query: (name: string) => string | undefined; body: () => Promise<unknown> }) => Promise<string | null>; key: SigningKey; baseUrl: string; listing: OrderRouteListing },
): MiddlewareHandler {
  const network = config.network ?? "eip155:84532";
  const server = resourceServer(config, deps.key, deps.baseUrl);
  const path = `${new URL(deps.baseUrl).pathname.replace(/\/+$/, "")}${X402_ORDER_ROUTE}`;
  const accepts = [
    {
      scheme: "exact" as const,
      network,
      payTo: config.payTo,
      maxTimeoutSeconds: 120,
      price: async (ctx: { adapter: { getQueryParam?(name: string): string | string[] | undefined; getBody?(): unknown } }) => {
        const price = await deps.quote({
          query: (name) => {
            const v = ctx.adapter.getQueryParam?.(name);
            return Array.isArray(v) ? v[0] : v;
          },
          body: async () => (ctx.adapter.getBody ? await ctx.adapter.getBody() : undefined),
        });
        if (!price) throw new Error("nothing to order");
        return price;
      },
    },
  ];
  const { description, serviceName, tags, iconUrl, exampleItem } = deps.listing;
  const output = {
    example: {
      order: { id: "ord_7HkQ2mXc9aRt", status: "paid", items: [{ id: exampleItem, name: serviceName, qty: 1 }], currency: "usd" },
      passUrl: `${deps.baseUrl}/p/Ya7qVHjkKI7bn4gU`,
      emailedTo: null,
    },
  };
  const common = { accepts, description, mimeType: "application/json", serviceName, tags, ...(iconUrl ? { iconUrl } : {}) };
  const others = { ...declareOfferReceiptExtension({ includeTxHash: true }), [PAYMENT_IDENTIFIER]: declarePaymentIdentifierExtension(false) };
  return paymentMiddleware(
    {
      [`GET ${path}`]: {
        ...common,
        extensions: {
          ...declareDiscoveryExtension({
            input: { items: `${exampleItem}:1` },
            inputSchema: {
              type: "object",
              properties: {
                items: { type: "string", description: "Items as id:qty pairs, comma-separated. Defaults to one of the first menu item." },
                name: { type: "string", description: "Name on the order, shown to staff" },
              },
            },
            output,
          }),
          ...others,
        },
      },
      [`POST ${path}`]: {
        ...common,
        extensions: {
          ...declareDiscoveryExtension({
            bodyType: "json",
            input: { items: [{ id: exampleItem, qty: 1 }], email: "customer@example.com", name: "Sam" },
            inputSchema: {
              type: "object",
              properties: {
                items: { type: "array", items: { type: "object", properties: { id: { type: "string" }, qty: { type: "integer", minimum: 1, maximum: 20 } }, required: ["id", "qty"] } },
                email: { type: "string", description: "Where the shop also emails the pickup QR" },
                name: { type: "string", description: "Name on the order, shown to staff" },
              },
              required: ["items"],
            },
            output,
          }),
          ...others,
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


/**
 * Pays an uncollected x402 order back to the wallet that paid it, from the shop's refund wallet, as an
 * EIP-3009 transfer the facilitator settles (and pays the gas for). The authorization's nonce comes from
 * the order id, so the USDC contract itself refuses a second refund of the same order, even if two
 * servers sweep at once.
 */
export function createX402Refunder(config: X402RailConfig, baseUrl: string) {
  if (!config.refunds) return null;
  const network = config.network ?? "eip155:84532";
  const facilitator: FacilitatorClient =
    config.facilitator ?? new HTTPFacilitatorClient({ url: config.facilitatorUrl ?? "https://x402.org/facilitator" });
  const account = privateKeyToAccount(config.refunds.privateKey);
  // The resource server knows each network's USDC contract and EIP-712 domain.
  const server = new x402ResourceServer(facilitator).register(network, new ExactEvmScheme());
  let ready: Promise<void> | null = null;

  return {
    address: account.address,
    async refund(order: Order): Promise<{ transaction: string; amount: string; to: string }> {
      if (!order.payer) throw new Error("no paying wallet on record");
      ready ??= server.initialize();
      await ready;
      const cents = order.usdCents ?? order.totalCents;
      const [requirements] = await server.buildPaymentRequirements({
        scheme: "exact",
        network,
        payTo: order.payer,
        price: `$${(cents / 100).toFixed(2)}`,
        maxTimeoutSeconds: 300,
      });
      const { name, version } = requirements.extra as { name: string; version: string };
      const authorization = {
        from: account.address,
        to: getAddress(order.payer),
        value: requirements.amount,
        validAfter: "0",
        validBefore: String(Math.floor(Date.now() / 1000) + 300),
        nonce: refundNonce(order.id),
      };
      const signature = await account.signTypedData({
        domain: { name, version, chainId: Number(network.split(":")[1]), verifyingContract: getAddress(requirements.asset) },
        types: {
          TransferWithAuthorization: [
            { name: "from", type: "address" },
            { name: "to", type: "address" },
            { name: "value", type: "uint256" },
            { name: "validAfter", type: "uint256" },
            { name: "validBefore", type: "uint256" },
            { name: "nonce", type: "bytes32" },
          ],
        },
        primaryType: "TransferWithAuthorization",
        message: {
          ...authorization,
          value: BigInt(authorization.value),
          validAfter: 0n,
          validBefore: BigInt(authorization.validBefore),
        },
      });
      const payload: PaymentPayload = {
        x402Version: 2,
        resource: { url: `${baseUrl}/api/orders/${order.id}`, description: "Refund for an uncollected pickup order" },
        accepted: requirements,
        payload: { authorization, signature },
      };
      const verified = await facilitator.verify(payload, requirements);
      if (!verified.isValid) throw new Error(`refund rejected: ${verified.invalidReason ?? "invalid"}`);
      const settled = await facilitator.settle(payload, requirements);
      if (!settled.success) throw new Error(`refund didn't settle: ${settled.errorReason ?? "unknown"}`);
      return { transaction: settled.transaction, amount: requirements.amount, to: authorization.to };
    },
  };
}

/** One nonce per order: the USDC contract won't accept the same refund authorization twice. */
export function refundNonce(orderId: string): `0x${string}` {
  return keccak256(toHex(`agentpickup:refund:${orderId}`));
}
