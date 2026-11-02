// ACP (Agentic Commerce Protocol, version 2026-04-17): discovery at /.well-known/acp.json
// and the checkout session endpoints under /acp, with the `pickup` fulfilment option.
// Payment is a Stripe Shared Payment Token (delegated payment) or a test instrument;
// the order's permalink_url is the pickup pass, and order events go to the platform's webhook.
import type { Context, Hono } from "hono";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { CollectEvent, Order } from "@agentpickup/core";
import { priceLines, type ProtocolCore } from "./protocol.js";
import { chargeSpt } from "./rails/spt.js";
import type { StripeLike } from "./rails/mpp.js";

export const ACP_VERSION = "2026-04-17";
const PICKUP_OPTION_ID = "pickup_counter";
const SPT_HANDLER_ID = "card_tokenized";
const TEST_HANDLER_ID = "agentpickup_test";

export interface AcpConfig {
  /** Bearer API keys issued to agent platforms. Requests without one are refused. */
  apiKeys: string[];
  /** Platform webhook for order events (POST, signed with Merchant-Signature). */
  webhook?: { url: string; secret: string };
}

type Status = "not_ready_for_payment" | "ready_for_payment" | "completed" | "canceled";

interface Session {
  id: string;
  status: Status;
  platform: string;
  lines: { lineId: string; id: string; title: string; priceCents: number; qty: number }[];
  email: string | null;
  name: string | null;
  orderId: string | null;
  createdAt: number;
  updatedAt: number;
}

interface MessageError {
  type: "error";
  code: string;
  param?: string;
  content_type: "plain";
  content: string;
  severity?: "low" | "medium" | "high";
  resolution?: "recoverable" | "requires_buyer_input" | "requires_buyer_review";
}

const id = (prefix: string) => `${prefix}_${randomBytes(9).toString("base64url")}`;
const sha = (s: string) => createHash("sha256").update(s).digest("base64url");

export function mountAcp(app: Hono, core: ProtocolCore, config: AcpConfig, stripe: StripeLike | null) {
  if (!config.apiKeys?.length) throw new Error("ACP needs at least one API key for agent platforms.");
  const keyHashes = config.apiKeys.map((k) => sha(k));

  app.get("/.well-known/acp.json", (c) =>
    c.json({
      protocol: { name: "acp", version: ACP_VERSION, supported_versions: [ACP_VERSION] },
      api_base_url: `${core.base}/acp`,
      transports: ["rest"],
      capabilities: { services: ["checkout", "orders"] },
    }),
  );

  // ---------- rendering ----------

  const handlers = () => [
    ...(stripe
      ? [
          {
            id: SPT_HANDLER_ID,
            name: "dev.acp.tokenized.card",
            display_name: "Card",
            version: "2026-01-22",
            spec: "https://acp.dev/handlers/tokenized.card",
            requires_delegate_payment: true,
            requires_pci_compliance: false,
            psp: "stripe",
          },
        ]
      : []),
    ...(core.testPayments
      ? [{ id: TEST_HANDLER_ID, name: "dev.agentpickup.test", display_name: "Test payment", version: ACP_VERSION, requires_delegate_payment: false }]
      : []),
  ];

  const address = () => ({
    name: core.merchant.location.name,
    line_one: core.merchant.location.address ?? core.merchant.location.name,
    city: "",
    state: "",
    country: "",
    postal_code: "",
  });

  function problemsFor(s: Session): MessageError[] {
    const out: MessageError[] = [];
    if (!s.lines.length) out.push({ type: "error", code: "missing", param: "$.line_items", content_type: "plain", content: "Add at least one item.", resolution: "recoverable" });
    if (!s.email) {
      out.push({
        type: "error",
        code: "missing",
        param: "$.buyer.email",
        content_type: "plain",
        content: "An email is needed: the pickup QR is sent there.",
        resolution: "requires_buyer_input",
      });
    }
    return out;
  }

  function settle(s: Session) {
    if (s.status === "completed" || s.status === "canceled") return;
    s.status = problemsFor(s).length ? "not_ready_for_payment" : "ready_for_payment";
  }

  function render(s: Session, extra: MessageError[] = []) {
    const total = s.lines.reduce((sum, l) => sum + l.priceCents * l.qty, 0);
    const lineIds = s.lines.map((l) => l.lineId);
    const order = s.orderId ? core.store.getOrder(s.orderId) : null;
    return {
      id: s.id,
      protocol: { version: ACP_VERSION },
      capabilities: { payment: { handlers: handlers() } },
      ...(s.email ? { buyer: { email: s.email, ...(s.name ? { first_name: s.name } : {}) } } : {}),
      status: s.status,
      currency: core.currency.toLowerCase(),
      line_items: s.lines.map((l) => ({
        id: l.lineId,
        item: { id: l.id },
        quantity: l.qty,
        name: l.title,
        unit_amount: l.priceCents,
        totals: [
          { type: "items_base_amount", display_text: "Base amount", amount: l.priceCents * l.qty },
          { type: "subtotal", display_text: "Subtotal", amount: l.priceCents * l.qty },
          { type: "total", display_text: "Total", amount: l.priceCents * l.qty },
        ],
      })),
      fulfillment_options: [
        {
          type: "pickup",
          id: PICKUP_OPTION_ID,
          title: "Collect at the counter",
          description: "Show the emailed QR code at the counter",
          location: { name: core.merchant.location.name, address: address(), instructions: "Show the QR code from your email at the counter." },
          pickup_type: "in_store",
          totals: [{ type: "total", display_text: "Pickup", amount: 0 }],
        },
      ],
      selected_fulfillment_options: s.lines.length ? [{ type: "pickup", option_id: PICKUP_OPTION_ID, item_ids: lineIds }] : [],
      totals: [
        { type: "items_base_amount", display_text: "Item(s) total", amount: total },
        { type: "subtotal", display_text: "Subtotal", amount: total },
        { type: "total", display_text: "Total", amount: total },
      ],
      messages: [...extra, ...(s.status === "not_ready_for_payment" ? problemsFor(s) : [])],
      links: [
        ...(core.merchant.termsUrl ? [{ type: "terms_of_use", url: core.merchant.termsUrl }] : []),
        ...(core.merchant.privacyUrl ? [{ type: "privacy_policy", url: core.merchant.privacyUrl }] : []),
      ],
      created_at: new Date(s.createdAt).toISOString(),
      updated_at: new Date(s.updatedAt).toISOString(),
      ...(order ? { order: orderObject(order, s.id) } : {}),
    };
  }

  function orderObject(order: Order, checkoutSessionId: string) {
    const status =
      order.status === "collected" ? "completed" : order.status === "expired" || order.status === "cancelled" ? "canceled" : "confirmed";
    return {
      type: "order",
      id: order.id,
      checkout_session_id: checkoutSessionId,
      order_number: order.pickupCode ?? order.id,
      permalink_url: core.passUrl(order),
      status,
      confirmation: {
        confirmation_number: order.pickupCode ?? order.id,
        confirmation_email_sent: Boolean(order.customerEmail),
        receipt_url: core.passUrl(order),
      },
    };
  }

  const fail = (c: Context, status: 400 | 401 | 404 | 409 | 422, code: string, message: string) =>
    c.json({ type: "invalid_request", code, message }, status);

  // ---------- request plumbing ----------

  /** Bearer API key, API-Version, and Idempotency-Key on every POST, replayed or refused on conflict. */
  async function guarded(c: Context, run: (platform: string, rawBody: string) => Promise<Response>): Promise<Response> {
    const auth = c.req.header("Authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const hash = sha(token);
    const platform = keyHashes.find((h) => token && timingSafeEqual(Buffer.from(h), Buffer.from(hash)));
    if (!platform) return fail(c, 401, "unauthorized", "A valid Bearer API key is required.");
    if (!c.req.header("API-Version")) return fail(c, 400, "missing_api_version", "The API-Version header is required.");
    c.header("API-Version", ACP_VERSION);
    const requestId = c.req.header("Request-Id");
    if (requestId) c.header("Request-Id", requestId);
    const raw = c.req.method === "POST" ? await c.req.text() : "";
    if (c.req.method !== "POST") return run(platform, raw);

    const key = c.req.header("Idempotency-Key");
    if (!key) return fail(c, 400, "idempotency_key_required", "Idempotency-Key header is required");
    if (key.length > 255) return fail(c, 400, "invalid", "Idempotency-Key is too long.");
    const scoped = `acp:${platform}:${key}`;
    const fingerprint = sha(`${c.req.path}\n${raw}`);
    const seen = core.store.getIdempotent(scoped);
    if (seen) {
      const stored = JSON.parse(seen.body) as { fingerprint: string; body: string };
      if (stored.fingerprint !== fingerprint) {
        return fail(c, 422, "idempotency_conflict", "This Idempotency-Key was used with a different request.");
      }
      return c.body(stored.body, seen.status as 200, { "Content-Type": "application/json", "Idempotent-Replayed": "true" });
    }
    const res = await run(platform, raw);
    if (res.status < 500) core.store.putIdempotent(scoped, res.status, JSON.stringify({ fingerprint, body: await res.clone().text() }));
    return res;
  }

  const load = (sessionId: string, platform: string) => {
    const s = core.store.getDoc<Session>("acp_checkout", sessionId);
    return s && s.platform === platform ? s : null;
  };
  const save = (s: Session) => {
    s.updatedAt = Date.now();
    core.store.putDoc("acp_checkout", s.id, s);
  };

  const parse = (raw: string) => {
    try {
      return JSON.parse(raw || "{}") as Record<string, unknown>;
    } catch {
      return null;
    }
  };

  function applyBody(s: Session, body: Record<string, unknown>): MessageError[] {
    const problems: MessageError[] = [];
    if (Array.isArray(body.line_items)) {
      // 2026-04-17 items carry no quantity; repeated ids (or a legacy `quantity`) add up.
      const counts = new Map<string, number>();
      for (const it of body.line_items as { id?: string; quantity?: number }[]) {
        const itemId = String(it?.id ?? "");
        counts.set(itemId, (counts.get(itemId) ?? 0) + (Number.isInteger(it?.quantity) ? Number(it.quantity) : 1));
      }
      const lines = [...counts].map(([itemId, qty]) => ({ id: itemId, qty }));
      if (lines.length > 20 || lines.some((l) => l.qty < 1 || l.qty > 20)) {
        problems.push({ type: "error", code: "quantity_exceeded", param: "$.line_items", content_type: "plain", content: "Up to 20 items, quantities 1 to 20.", resolution: "recoverable" });
      } else {
        const { priced, unknown } = priceLines(core.catalog, lines);
        for (const u of unknown) {
          problems.push({ type: "error", code: "not_found", param: "$.line_items", content_type: "plain", content: `Unknown item ${u}.`, resolution: "recoverable" });
        }
        if (!unknown.length) s.lines = priced.map((p, i) => ({ lineId: `li_${i + 1}`, ...p }));
      }
    }
    const buyer = body.buyer as { email?: string; first_name?: string } | undefined;
    const details = body.fulfillment_details as { email?: string; name?: string } | undefined;
    const email = buyer?.email ?? details?.email;
    if (email !== undefined) {
      const clean = String(email).trim();
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean) && clean.length <= 200) s.email = clean;
      else problems.push({ type: "error", code: "invalid", param: "$.buyer.email", content_type: "plain", content: "That email doesn't look right.", resolution: "requires_buyer_input" });
    }
    const name = buyer?.first_name ?? details?.name;
    if (name) s.name = String(name).slice(0, 60);
    const selected = body.selected_fulfillment_options as { type?: string }[] | undefined;
    if (selected?.some((o) => o.type && o.type !== "pickup")) {
      problems.push({ type: "error", code: "unsupported", param: "$.selected_fulfillment_options", content_type: "plain", content: "Only pickup is offered.", resolution: "recoverable" });
    }
    return problems;
  }

  // ---------- endpoints ----------

  app.post("/acp/checkout_sessions", (c) =>
    guarded(c, async (platform, raw) => {
      const body = parse(raw);
      if (!body) return fail(c, 400, "invalid_json", "Send a JSON checkout session.");
      const now = Date.now();
      const s: Session = { id: id("cs"), status: "not_ready_for_payment", platform, lines: [], email: null, name: null, orderId: null, createdAt: now, updatedAt: now };
      const problems = applyBody(s, body);
      settle(s);
      save(s);
      return c.json(render(s, problems), 201);
    }),
  );

  app.get("/acp/checkout_sessions/:id", (c) =>
    guarded(c, async (platform) => {
      const s = load(c.req.param("id"), platform);
      return s ? c.json(render(s)) : fail(c, 404, "not_found", "Checkout session not found.");
    }),
  );

  app.post("/acp/checkout_sessions/:id", (c) =>
    guarded(c, async (platform, raw) => {
      const s = load(c.req.param("id"), platform);
      if (!s) return fail(c, 404, "not_found", "Checkout session not found.");
      if (s.status === "completed" || s.status === "canceled") return fail(c, 409, "conflict", `Checkout session is ${s.status}.`);
      const body = parse(raw);
      if (!body) return fail(c, 400, "invalid_json", "Send a JSON checkout session.");
      const problems = applyBody(s, body);
      settle(s);
      save(s);
      return c.json(render(s, problems));
    }),
  );

  app.post("/acp/checkout_sessions/:id/complete", (c) =>
    guarded(c, async (platform, raw) => {
      const s = load(c.req.param("id"), platform);
      if (!s) return fail(c, 404, "not_found", "Checkout session not found.");
      if (s.status === "completed") return c.json(render(s));
      if (s.status === "canceled") return fail(c, 409, "conflict", "Checkout session is canceled.");
      const body = parse(raw);
      if (!body) return fail(c, 400, "invalid_json", "Send a JSON body.");
      const problems = applyBody(s, body);
      settle(s);
      if (s.status !== "ready_for_payment") return c.json(render(s, problems));

      const payment = body.payment_data as { handler_id?: string; instrument?: { type?: string; credential?: { type?: string; token?: string } } } | undefined;
      const declined = (content: string): MessageError => ({ type: "error", code: "payment_declined", param: "$.payment_data", content_type: "plain", content, resolution: "requires_buyer_input" });
      if (!payment?.handler_id) return c.json(render(s, [declined("Send payment_data with a handler_id.")]));

      const order = core.createOrder({ items: s.lines.map((l) => ({ id: l.id, qty: l.qty })), email: s.email!, name: s.name ?? undefined, rail: "acp" });
      let paymentRef: string;
      try {
        if (payment.handler_id === SPT_HANDLER_ID && stripe) {
          const cred = payment.instrument?.credential;
          if (cred?.type !== "spt" || !cred.token) throw new Error("Expected an spt credential.");
          ({ paymentIntentId: paymentRef } = await chargeSpt(stripe, {
            amountCents: order.totalCents,
            currency: order.currency,
            spt: cred.token,
            orderId: order.id,
            idempotencyKey: `acp_${s.id}_${cred.token}`,
            receiptEmail: order.customerEmail,
          }));
        } else if (payment.handler_id === TEST_HANDLER_ID && core.testPayments) {
          paymentRef = `test_${order.id}`;
        } else {
          throw new Error(`Unsupported payment handler ${payment.handler_id}.`);
        }
      } catch (err) {
        core.cancelUnpaid(order.id);
        save(s);
        return c.json(render(s, [declined(String((err as Error).message))]));
      }
      await core.markPaid(order.id, { paymentRef, meta: { protocol: "acp", checkoutId: s.id, handler: payment.handler_id } });
      s.status = "completed";
      s.orderId = order.id;
      save(s);
      return c.json(render(s));
    }),
  );

  app.post("/acp/checkout_sessions/:id/cancel", (c) =>
    guarded(c, async (platform) => {
      const s = load(c.req.param("id"), platform);
      if (!s) return fail(c, 404, "not_found", "Checkout session not found.");
      if (s.status === "completed") return fail(c, 409, "conflict", "Checkout session is already completed.");
      s.status = "canceled";
      save(s);
      return c.json(render(s));
    }),
  );

  // ---------- order events to the platform ----------

  /** Forward order lifecycle changes for ACP orders to the platform webhook. */
  async function onEvent(event: CollectEvent, order: Order) {
    if (!config.webhook || order.rail !== "acp") return;
    const paid = core.store.listEvents(order.id).find((e) => e.type === "order.paid");
    const checkoutId = String(paid?.data?.checkoutId ?? "");
    const type = event.type === "order.paid" ? "order_create" : ["order.ready", "order.collected", "order.expired"].includes(event.type) ? "order_update" : null;
    if (!type || !checkoutId) return;
    const refunded = event.type === "order.expired" && event.data?.outcome === "refunded";
    const body = JSON.stringify({
      type,
      data: {
        ...orderObject(order, checkoutId),
        refunds: refunded ? [{ type: "original_payment", amount: order.totalCents }] : [],
      },
    });
    const timestamp = new Date().toISOString();
    const signature = createHmac("sha256", config.webhook.secret).update(`${timestamp}.${body}`).digest("base64url");
    await fetch(config.webhook.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Merchant-Signature": signature, Timestamp: timestamp, "Request-Id": id("req") },
      body,
    }).catch((err) => console.error("[collect] ACP webhook failed:", err));
  }

  return { onEvent };
}
