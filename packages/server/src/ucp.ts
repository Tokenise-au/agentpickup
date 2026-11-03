// UCP (Universal Commerce Protocol, version 2026-08-25): a business profile at /.well-known/ucp
// and the REST checkout, with the `pickup` fulfilment method and the pickup pass as the
// order's permalink. Payment is a Stripe Shared Payment Token through com.stripe.payments,
// or a test instrument when test payments are on.
import type { Context, Hono } from "hono";
import { randomBytes } from "node:crypto";
import type { Order } from "@agentpickup/core";
import { priceLines, type ProtocolCore } from "./protocol.js";
import { chargeSpt, sptClient, type SptStripeConfig } from "./rails/spt.js";
import type { StripeLike } from "./rails/mpp.js";
import { AP2_CAPABILITY, Ap2Error, type Ap2 } from "./ap2.js";

export const UCP_VERSION = "2026-08-25";
const SPEC = `https://ucp.dev/${UCP_VERSION}`;
const LOCATION_ID = "loc_main";
const STRIPE_HANDLER_ID = "stripe_payments";
const TEST_HANDLER_ID = "agentpickup_test";

type Status = "incomplete" | "ready_for_complete" | "completed" | "canceled";

interface Session {
  id: string;
  status: Status;
  agent: string;
  lines: { lineId: string; id: string; title: string; priceCents: number; qty: number }[];
  email: string | null;
  name: string | null;
  methodId: string;
  selectedDestinationId: string | null;
  orderId: string | null;
  createdAt: number;
  /** AP2 mandates negotiated: every response is signed and completing needs a checkout mandate. */
  ap2?: boolean;
}

interface Message {
  type: "error" | "warning" | "info";
  code: string;
  content: string;
  path?: string;
  severity?: "recoverable" | "requires_buyer_input" | "unrecoverable";
}

const id = (prefix: string) => `${prefix}_${randomBytes(9).toString("base64url")}`;

export function mountUcp(app: Hono, core: ProtocolCore, config: { stripe?: SptStripeConfig; ap2?: Ap2 | null }) {
  const ap2 = config.ap2 ?? null;
  const stripe: StripeLike | null = config.stripe ? sptClient(config.stripe) : null;
  const endpoint = `${core.base}/ucp/v1`;
  const CURRENCY = core.currency.toUpperCase();

  const paymentHandlers = () => ({
    ...(stripe
      ? {
          "com.stripe.payments": [
            {
              id: STRIPE_HANDLER_ID,
              version: "2026-06-25",
              spec: "https://docs.stripe.com/agentic-commerce/protocols/ucp/stripe-payments-handler",
              schema: "https://ucp.stripe.com/payments/2026-06-25/schema.json",
              available_instruments: [{ type: "card" }],
              config: {
                environment: config.stripe?.environment ?? "testmode",
                ...(config.stripe?.businessProfile ? { business_profile: config.stripe.businessProfile } : {}),
              },
            },
          ],
        }
      : {}),
    ...(core.testPayments
      ? {
          "dev.agentpickup.test": [
            {
              id: TEST_HANDLER_ID,
              version: UCP_VERSION,
              spec: `${core.base}/openapi.json`,
              available_instruments: [{ type: "test" }],
            },
          ],
        }
      : {}),
  });

  app.get("/.well-known/ucp", (c) =>
    c.json({
      ucp: {
        version: UCP_VERSION,
        services: {
          "dev.ucp.shopping": [
            {
              version: UCP_VERSION,
              spec: `${SPEC}/specification/overview/`,
              transport: "rest",
              endpoint,
              schema: `${SPEC}/services/shopping/rest.openapi.json`,
            },
          ],
        },
        capabilities: {
          "dev.ucp.shopping.checkout": [
            { version: UCP_VERSION, spec: `${SPEC}/specification/shopping/checkout`, schema: `${SPEC}/schemas/shopping/checkout.json` },
          ],
          "dev.ucp.shopping.fulfillment": [
            {
              version: UCP_VERSION,
              spec: `${SPEC}/specification/shopping/extensions/fulfillment`,
              schema: `${SPEC}/schemas/shopping/fulfillment.json`,
              extends: "dev.ucp.shopping.checkout",
            },
          ],
          "dev.ucp.shopping.order": [
            { version: UCP_VERSION, spec: `${SPEC}/specification/shopping/order`, schema: `${SPEC}/schemas/shopping/order.json` },
          ],
          ...(ap2
            ? {
                [AP2_CAPABILITY]: [
                  {
                    version: UCP_VERSION,
                    spec: `${SPEC}/specification/payment/extensions/ap2-mandates`,
                    schema: `${SPEC}/schemas/common/payment_ap2_mandate.json`,
                    extends: "dev.ucp.shopping.checkout",
                    config: { vp_formats_supported: { "dc+sd-jwt": {} } },
                  },
                ],
              }
            : {}),
        },
        payment_handlers: paymentHandlers(),
      },
      ...(ap2 ? { keys: [ap2.publicJwk] } : {}),
    }),
  );

  // ---------- rendering ----------

  const location = () => ({
    type: "business_location",
    id: LOCATION_ID,
    name: core.merchant.location.name,
    ...(core.merchant.location.address ? { address: { street_address: core.merchant.location.address } } : {}),
  });

  function messagesFor(s: Session): Message[] {
    const out: Message[] = [];
    if (!s.lines.length) out.push({ type: "error", code: "missing", path: "$.line_items", content: "Add at least one item.", severity: "recoverable" });
    if (!s.email) {
      out.push({
        type: "error",
        code: "missing",
        path: "$.buyer.email",
        content: "Buyer email is required: the pickup QR is sent there.",
        severity: "requires_buyer_input",
      });
    }
    if (s.selectedDestinationId !== LOCATION_ID) {
      out.push({
        type: "error",
        code: "missing",
        path: "$.fulfillment.methods[0].selected_destination_id",
        content: `Select the pickup location ${LOCATION_ID}.`,
        severity: "recoverable",
      });
    }
    return out;
  }

  function settle(s: Session) {
    if (s.status === "completed" || s.status === "canceled") return;
    s.status = messagesFor(s).length ? "incomplete" : "ready_for_complete";
  }

  function render(s: Session, problems: Message[] = []) {
    const total = s.lines.reduce((sum, l) => sum + l.priceCents * l.qty, 0);
    const lineIds = s.lines.map((l) => l.lineId);
    const body: Record<string, unknown> = {
      ucp: {
        version: UCP_VERSION,
        status: "success",
        capabilities: {
          "dev.ucp.shopping.checkout": [{ version: UCP_VERSION }],
          "dev.ucp.shopping.fulfillment": [{ version: UCP_VERSION }],
        },
        payment_handlers: paymentHandlers(),
      },
      id: s.id,
      status: s.status,
      currency: CURRENCY,
      line_items: s.lines.map((l) => ({
        id: l.lineId,
        item: { id: l.id, title: l.title, price: l.priceCents },
        quantity: l.qty,
        totals: [
          { type: "subtotal", amount: l.priceCents * l.qty },
          { type: "total", amount: l.priceCents * l.qty },
        ],
      })),
      totals: [
        { type: "subtotal", amount: total },
        { type: "total", amount: total },
      ],
      links: [
        ...(core.merchant.termsUrl ? [{ type: "terms_of_service", url: core.merchant.termsUrl }] : []),
        ...(core.merchant.privacyUrl ? [{ type: "privacy_policy", url: core.merchant.privacyUrl }] : []),
      ],
      fulfillment: {
        methods: [
          {
            id: s.methodId,
            type: "pickup",
            line_item_ids: lineIds,
            destinations: [location()],
            selected_destination_id: s.selectedDestinationId,
            groups: [
              {
                id: "grp_pickup",
                line_item_ids: lineIds,
                options: [
                  {
                    id: "opt_counter",
                    title: "Collect at the counter",
                    description: "Show the emailed QR code at the counter",
                    totals: [{ type: "total", amount: 0 }],
                  },
                ],
                selected_option_id: "opt_counter",
              },
            ],
          },
        ],
      },
      ...(s.email ? { buyer: { email: s.email, ...(s.name ? { first_name: s.name } : {}) } } : {}),
    };
    const messages = [...problems, ...(s.status === "incomplete" ? messagesFor(s) : [])];
    if (messages.length) body.messages = messages;
    if (s.orderId) {
      const order = core.store.getOrder(s.orderId);
      if (order) body.order = { id: order.id, label: `Pickup ${order.pickupCode ?? ""}`.trim(), permalink_url: core.passUrl(order) };
    }
    if (s.ap2 && ap2) {
      (body.ucp as { capabilities: Record<string, unknown> }).capabilities[AP2_CAPABILITY] = [{ version: UCP_VERSION }];
      // Signed last, over everything the platform sees except `ap2` itself.
      body.ap2 = { merchant_authorization: ap2.merchantAuthorization(body) };
    }
    return body;
  }

  /** The terms a checkout mandate must match: id, totals and line items as we render them now. */
  const terms = (s: Session) => {
    const body = render(s);
    return { id: s.id, totals: body.totals, line_items: body.line_items };
  };

  const error = (c: Context, status: 400 | 404 | 409 | 402, code: string, content: string) =>
    c.json({ ucp: { version: UCP_VERSION, status: "error" }, messages: [{ type: "error", code, content, severity: "unrecoverable" }] }, status);

  // ---------- request plumbing ----------

  /** UCP-Agent is required on every call; mutations also need Idempotency-Key, and replay their first response. */
  async function guarded(c: Context, mutation: boolean, run: (agent: string) => Promise<Response>): Promise<Response> {
    const agent = c.req.header("UCP-Agent");
    if (!agent) return error(c, 400, "missing_header", "The UCP-Agent header is required.");
    const requestId = c.req.header("Request-Id");
    if (requestId) c.header("Request-Id", requestId);
    if (!mutation) return run(agent);
    const key = c.req.header("Idempotency-Key");
    if (!key) return error(c, 400, "missing_header", "The Idempotency-Key header is required.");
    const scoped = `ucp:${agent}:${c.req.method}:${c.req.path}:${key}`;
    const seen = core.store.getIdempotent(scoped);
    if (seen) return c.body(seen.body, seen.status as 200, { "Content-Type": "application/json" });
    const res = await run(agent);
    if (res.status < 500) core.store.putIdempotent(scoped, res.status, await res.clone().text());
    return res;
  }

  const load = (sessionId: string, agent: string) => {
    const s = core.store.getDoc<Session>("ucp_checkout", sessionId);
    // Sessions belong to the platform that opened them.
    return s && s.agent === agent ? s : null;
  };
  const save = (s: Session) => core.store.putDoc("ucp_checkout", s.id, s);

  type LineInput = { item?: { id?: string }; quantity?: number };
  function applyBody(s: Session, body: Record<string, unknown>): Message[] {
    const problems: Message[] = [];
    if (Array.isArray(body.line_items)) {
      const lines = (body.line_items as LineInput[]).map((l) => ({ id: String(l.item?.id ?? ""), qty: Number(l.quantity) }));
      if (lines.length > 20 || lines.some((l) => !Number.isInteger(l.qty) || l.qty < 1 || l.qty > 20)) {
        problems.push({ type: "error", code: "invalid", path: "$.line_items", content: "Up to 20 lines, quantities 1 to 20.", severity: "recoverable" });
      } else {
        const { priced, unknown } = priceLines(core.catalog, lines);
        for (const u of unknown) {
          problems.push({ type: "error", code: "not_found", path: "$.line_items", content: `Unknown item ${u}.`, severity: "recoverable" });
        }
        if (!unknown.length) s.lines = priced.map((p, i) => ({ lineId: `li_${i + 1}`, ...p }));
      }
    }
    const buyer = body.buyer as { email?: string; first_name?: string } | undefined;
    if (buyer?.email !== undefined) {
      const email = String(buyer.email).trim();
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 200) s.email = email;
      else problems.push({ type: "error", code: "invalid", path: "$.buyer.email", content: "That email doesn't look right.", severity: "requires_buyer_input" });
    }
    if (buyer?.first_name) s.name = String(buyer.first_name).slice(0, 60);
    const methods = (body.fulfillment as { methods?: { type?: string; selected_destination_id?: string | null }[] } | undefined)?.methods;
    if (methods?.length) {
      const pickup = methods.find((m) => m.type === undefined || m.type === "pickup");
      if (!pickup) problems.push({ type: "error", code: "unsupported", path: "$.fulfillment.methods", content: "Only pickup is offered.", severity: "recoverable" });
      else if (pickup.selected_destination_id !== undefined) s.selectedDestinationId = pickup.selected_destination_id;
    }
    return problems;
  }

  const withProblems = (s: Session, problems: Message[]) => render(s, problems);

  // ---------- endpoints ----------

  app.post("/ucp/v1/checkout-sessions", (c) =>
    guarded(c, true, async (agent) => {
      const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
      if (!body) return error(c, 400, "invalid", "Send a JSON checkout.");
      const s: Session = {
        id: id("chk"),
        status: "incomplete",
        agent,
        lines: [],
        email: null,
        name: null,
        methodId: "ful_pickup",
        selectedDestinationId: null,
        orderId: null,
        createdAt: Date.now(),
        // AP2 locks the session when both sides support mandates.
        ap2: ap2 ? await ap2.negotiated(agent) : false,
      };
      const problems = applyBody(s, body);
      settle(s);
      save(s);
      return c.json(withProblems(s, problems), 201);
    }),
  );

  app.get("/ucp/v1/checkout-sessions/:id", (c) =>
    guarded(c, false, async (agent) => {
      const s = load(c.req.param("id"), agent);
      return s ? c.json(render(s)) : error(c, 404, "not_found", "Checkout session not found.");
    }),
  );

  app.put("/ucp/v1/checkout-sessions/:id", (c) =>
    guarded(c, true, async (agent) => {
      const s = load(c.req.param("id"), agent);
      if (!s) return error(c, 404, "not_found", "Checkout session not found.");
      if (s.status === "completed" || s.status === "canceled") return error(c, 409, "invalid_state", `Checkout is ${s.status}.`);
      const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
      if (!body) return error(c, 400, "invalid", "Send a JSON checkout.");
      const problems = applyBody(s, body);
      settle(s);
      save(s);
      return c.json(withProblems(s, problems));
    }),
  );

  app.post("/ucp/v1/checkout-sessions/:id/complete", (c) =>
    guarded(c, true, async (agent) => {
      const s = load(c.req.param("id"), agent);
      if (!s) return error(c, 404, "not_found", "Checkout session not found.");
      if (s.status === "completed") return c.json(render(s));
      settle(s);
      if (s.status !== "ready_for_complete") return c.json(withProblems(s, []), 409);
      const body = ((await c.req.json().catch(() => null)) ?? {}) as {
        payment?: { instruments?: { id?: string; handler_id?: string; type?: string; selected?: boolean; credential?: { type?: string; token?: string } }[] };
        ap2?: { checkout_mandate?: string };
      };
      const instruments = body.payment?.instruments ?? [];
      const chosen = instruments.find((i) => i.selected) ?? instruments[0];
      if (!chosen) return error(c, 402, "payment_required", "Send payment.instruments with the selected instrument.");

      let mandate: { raw: string; checkoutHash: string } | null = null;
      if (s.ap2 && ap2) {
        const raw = body.ap2?.checkout_mandate;
        if (!raw) return error(c, 400, "mandate_required", "This checkout needs ap2.checkout_mandate.");
        try {
          const verified = await ap2.verifyCheckoutMandate(raw, { ucpAgent: agent, audience: core.base, expect: terms(s) });
          mandate = { raw, checkoutHash: verified.checkoutHash! };
        } catch (err) {
          if (err instanceof Ap2Error) return error(c, 400, err.code, err.message);
          throw err;
        }
      }

      const order = core.createOrder({ items: s.lines.map((l) => ({ id: l.id, qty: l.qty })), email: s.email!, name: s.name ?? undefined, rail: "ucp" });
      let paymentRef: string;
      try {
        if (chosen.handler_id === STRIPE_HANDLER_ID && stripe) {
          if (chosen.credential?.type !== "stripe_payment_token" || !chosen.credential.token) {
            throw new Error("Expected a stripe_payment_token credential.");
          }
          ({ paymentIntentId: paymentRef } = await chargeSpt(stripe, {
            amountCents: order.totalCents,
            currency: order.currency,
            spt: chosen.credential.token,
            orderId: order.id,
            idempotencyKey: `ucp_${s.id}_${chosen.credential.token}`,
            receiptEmail: order.customerEmail,
          }));
        } else if (chosen.handler_id === TEST_HANDLER_ID && core.testPayments) {
          paymentRef = `test_${order.id}`;
        } else {
          throw new Error(`Unsupported payment handler ${chosen.handler_id ?? "(none)"}.`);
        }
      } catch (err) {
        core.cancelUnpaid(order.id);
        return error(c, 402, "payment_declined", String((err as Error).message));
      }
      await core.markPaid(order.id, {
        paymentRef,
        meta: {
          protocol: "ucp",
          checkoutId: s.id,
          handler: chosen.handler_id,
          agent,
          // Kept as evidence that the buyer authorised exactly these terms.
          ...(mandate ? { ap2CheckoutMandate: mandate.raw, ap2CheckoutHash: mandate.checkoutHash } : {}),
        },
      });
      s.status = "completed";
      s.orderId = order.id;
      save(s);
      return c.json(render(s));
    }),
  );

  app.post("/ucp/v1/checkout-sessions/:id/cancel", (c) =>
    guarded(c, true, async (agent) => {
      const s = load(c.req.param("id"), agent);
      if (!s) return error(c, 404, "not_found", "Checkout session not found.");
      if (s.status === "completed") return error(c, 409, "invalid_state", "Checkout is already completed.");
      s.status = "canceled";
      save(s);
      return c.json(render(s));
    }),
  );

  app.get("/ucp/v1/orders/:id", (c) =>
    guarded(c, false, async (agent) => {
      const order = core.store.getOrder(c.req.param("id"));
      const paid = order ? core.store.listEvents(order.id).find((e) => e.type === "order.paid") : undefined;
      // Only the platform that completed the checkout sees the order (and its pickup pass).
      if (!order || order.rail !== "ucp" || paid?.data?.agent !== agent) return error(c, 404, "not_found", "Order not found.");
      return c.json(renderOrder(order, String(paid.data?.checkoutId ?? "")));
    }),
  );

  function renderOrder(order: Order, checkoutId: string) {
    const collected = order.status === "collected";
    const lines = order.items.map((it, i) => ({
      id: `li_${i + 1}`,
      item: { id: it.id, title: it.name, price: it.unitCents },
      quantity: { total: it.qty, fulfilled: collected ? it.qty : 0 },
      totals: [
        { type: "subtotal", amount: it.unitCents * it.qty },
        { type: "total", amount: it.unitCents * it.qty },
      ],
      status: collected ? "fulfilled" : order.status === "expired" || order.status === "cancelled" ? "canceled" : "processing",
    }));
    const lineRefs = lines.map((l) => ({ id: l.id, quantity: l.quantity.total }));
    const events = [
      ...(order.readyAt
        ? [{ id: "evt_ready", occurred_at: new Date(order.readyAt).toISOString(), type: "ready_for_pickup", line_items: lineRefs, description: "Ready at the counter" }]
        : []),
      ...(order.collectedAt
        ? [{ id: "evt_collected", occurred_at: new Date(order.collectedAt).toISOString(), type: "delivered", line_items: lineRefs, description: "Collected at the counter" }]
        : []),
    ];
    return {
      ucp: { version: UCP_VERSION, capabilities: { "dev.ucp.shopping.order": [{ version: UCP_VERSION }] } },
      id: order.id,
      label: `Pickup ${order.pickupCode ?? ""}`.trim(),
      checkout_id: checkoutId,
      permalink_url: core.passUrl(order),
      currency: order.currency.toUpperCase(),
      line_items: lines,
      fulfillment: {
        expectations: [
          {
            id: "exp_pickup",
            line_items: lineRefs,
            method_type: "pickup",
            destination: core.merchant.location.address ? { street_address: core.merchant.location.address } : {},
            description: `Show the QR at ${core.merchant.location.name} by ${new Date(order.collectBy).toISOString()}`,
            fulfillable_on: "now",
          },
        ],
        events,
      },
      totals: [
        { type: "subtotal", amount: order.totalCents },
        { type: "total", amount: order.totalCents },
      ],
    };
  }
}
