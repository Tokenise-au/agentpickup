// Machine-readable descriptions of the shop for agents and indexers:
// a did:web document for the signing key, and an OpenAPI document in the shape x402scan reads.
import { toJwks, type SigningKey } from "@agentpickup/core";
import type { CatalogItem, MerchantProfile } from "./config.js";
import { didWebFor } from "./rails/x402.js";

export function didDocument(baseUrl: string, key: SigningKey) {
  const did = didWebFor(baseUrl);
  const vm = `${did}#${key.kid}`;
  const [jwk] = toJwks([key]).keys;
  return {
    "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/suites/jws-2020/v1"],
    id: did,
    verificationMethod: [{ id: vm, type: "JsonWebKey2020", controller: did, publicKeyJwk: jwk }],
    assertionMethod: [vm],
  };
}

export function openApiDocument(o: {
  merchant: MerchantProfile;
  catalog: CatalogItem[];
  currency: string;
  rails: { card: boolean; x402: boolean; mpp: boolean; test: boolean };
}) {
  const prices = o.catalog.map((i) => i.priceCents);
  const usd = (cents: number) => (cents / 100).toFixed(2);
  const free = { security: [] as unknown[] };
  const json = (schema: Record<string, unknown>) => ({ content: { "application/json": { schema } } });
  const rails = [o.rails.card && "card", o.rails.x402 && "x402", o.rails.mpp && "mpp", o.rails.test && "test"].filter(Boolean);

  const paths: Record<string, unknown> = {
    "/api/catalog": {
      get: { ...free, operationId: "getCatalog", summary: "Menu, merchant details and enabled payment methods", responses: { 200: { description: "Catalog" } } },
    },
    "/api/orders": {
      post: {
        ...free,
        operationId: "createOrder",
        summary: "Create a pickup order. Prices come from the catalog.",
        requestBody: {
          required: true,
          ...json({
            type: "object",
            properties: {
              items: {
                type: "array",
                minItems: 1,
                maxItems: 20,
                items: {
                  type: "object",
                  properties: { id: { type: "string", enum: o.catalog.map((i) => i.id) }, qty: { type: "integer", minimum: 1, maximum: 20 } },
                  required: ["id", "qty"],
                },
              },
              email: { type: "string", format: "email", description: "Where the pickup QR is sent" },
              name: { type: "string", maxLength: 60 },
              rail: { type: "string", enum: rails },
            },
            required: ["items", "rail"],
          }),
        },
        responses: { 201: { description: "Order created, with the next step (redirect, x402 pay link, or done)" } },
      },
    },
    "/api/orders/{id}": {
      get: {
        ...free,
        operationId: "getOrder",
        summary: "Order status. No pass, code or email.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { 200: { description: "Order status" } },
      },
    },
  };

  if (o.rails.x402) {
    paths["/api/orders/{id}/pay"] = {
      post: {
        operationId: "payOrder",
        summary: "Pay for an order over x402. The pickup QR is emailed once the payment settles.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        "x-payment-info": {
          price: { mode: "dynamic", currency: "USD", min: usd(Math.min(...prices)), max: usd(Math.max(...prices) * 20 * 20) },
          protocols: [{ x402: {} }],
        },
        responses: {
          200: { description: "Paid. Returns the order, the pass link and a signed receipt." },
          402: { description: "Payment Required" },
          409: { description: "The order is not awaiting payment" },
        },
      },
    };
    paths["/api/orders/{id}/pass"] = {
      get: {
        security: [{ siwx: [] }],
        operationId: "getPass",
        summary: "Fetch the pickup pass again by signing in with the wallet that paid",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { 200: { description: "Pass link and pickup code" }, 402: { description: "Sign-in challenge" }, 403: { description: "Signed in, but not the payer" } },
      },
    };
  }

  if (o.rails.mpp) {
    paths["/api/orders/{id}/mpp"] = {
      post: {
        operationId: "payOrderMpp",
        summary: "Pay for an order over MPP: card or Link through a Stripe Shared Payment Token.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        // MPP discovery: one offer per method; the amount depends on the order, so it is null here.
        "x-payment-info": {
          offers: [{ amount: null, currency: o.currency, intent: "charge", method: "stripe", description: "Pickup order" }],
        },
        responses: {
          200: { description: "Paid. Returns the order and the pass link, with a Payment-Receipt header." },
          402: { description: "Payment Required (WWW-Authenticate: Payment)" },
          409: { description: "The order is not awaiting payment" },
        },
      },
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: `${o.merchant.name} pickup orders`,
      version: "1.0.0",
      description: `Order ahead from ${o.merchant.name} and collect at ${o.merchant.location.name}.`,
      "x-guidance":
        "GET /api/catalog for the menu. POST /api/orders with items, the customer's email and rail 'x402'. " +
        "Then POST the returned pay link with an x402 payment (USDC). The customer receives a QR by email and shows it at the counter. " +
        "To fetch the pass again later, GET /api/orders/{id}/pass and sign in with the paying wallet.",
      ...(o.merchant.supportEmail ? { contact: { email: o.merchant.supportEmail } } : {}),
    },
    paths,
    components: {
      securitySchemes: { siwx: { type: "apiKey", in: "header", name: "SIGN-IN-WITH-X", description: "x402 Sign-In-With-X (CAIP-122) proof" } },
    },
  };
}
