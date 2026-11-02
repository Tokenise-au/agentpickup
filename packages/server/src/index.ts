import { Hono, type Context, type MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import QRCode from "qrcode";
import {
  extractToken,
  loadSigningKey,
  newId,
  newPickupCode,
  signPass,
  toJwks,
  verifyPass,
  type CollectEvent,
  type CollectEventType,
  type Order,
  type OrderItem,
  type PaymentRail,
} from "@agentpickup/core";
import type { CollectConfig } from "./config.js";
import { renderPassEmail } from "./mail.js";
import { formatMoney, formatTime } from "./format.js";
import { messagePage, passPage, scannerPage, staffLoginPage, thanksPage } from "./pages.js";
import { stripeCardRail } from "./rails/stripe.js";
import { X402_PAY_ROUTE, paymentIdFromRequest, readSettlement, receiptFrom, x402PayMiddleware } from "./rails/x402.js";
import { createSiwxGate } from "./siwx.js";
import { didDocument, openApiDocument } from "./discovery.js";

export type { CollectConfig, MerchantProfile, CatalogItem, StripeRailConfig, X402RailConfig } from "./config.js";
export { SqliteStore, type Store, type StoredEmail } from "./store.js";
export { resendMailer, outboxMailer, renderPassEmail, type Mailer, type OutgoingMail } from "./mail.js";

const UNPAID_TIMEOUT_MS = 60 * 60_000;
const STAFF_COOKIE = "collect_staff";

export interface OrderInput {
  items: { id: string; qty: number }[];
  email?: string;
  name?: string;
  rail: PaymentRail;
}

class InputError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
  }
}

/** The fields anyone holding an order id may see. No pass, code or email. */
export function publicOrder(o: Order) {
  return {
    id: o.id,
    status: o.status,
    rail: o.rail,
    items: o.items,
    totalCents: o.totalCents,
    currency: o.currency,
    collectBy: o.collectBy,
    createdAt: o.createdAt,
    paidAt: o.paidAt,
    readyAt: o.readyAt,
    collectedAt: o.collectedAt,
  };
}

export function createCollect(config: CollectConfig) {
  const { store, merchant } = config;
  const key = loadSigningKey(config.signingKeyPem);
  const base = config.baseUrl.replace(/\/$/, "");
  const currency = (config.currency ?? "usd").toLowerCase();
  const windowMs = (config.collectWindowMinutes ?? 24 * 60) * 60_000;
  const card = config.payments.card ? stripeCardRail(config.payments.card) : null;
  const x402 = config.payments.x402 ?? null;
  if (x402 && currency !== "usd") {
    throw new Error("x402 prices are in USD (USDC). Set currency to 'usd' or leave x402 off.");
  }
  const catalog = new Map(config.catalog.map((item) => [item.id, item]));

  const staffToken = config.staffKey
    ? createHmac("sha256", config.staffKey).update("collect-staff-v1").digest("base64url")
    : null;

  // ---------- passes ----------

  const passUrl = (o: Order) => `${base}/p/${o.passId}`;
  const collectLink = (o: Order) =>
    `${base}/c/${signPass({ v: 1, oid: o.id, pid: o.passId!, exp: Math.floor(o.collectBy / 1000) }, key)}`;
  const qrOptions = { errorCorrectionLevel: "M" as const, margin: 1, width: 480 };
  const qrPng = (o: Order) => QRCode.toBuffer(collectLink(o), qrOptions);
  const qrDataUri = (o: Order) => QRCode.toDataURL(collectLink(o), qrOptions);

  // ---------- events ----------

  async function emit(type: CollectEventType, order: Order, data?: Record<string, unknown>) {
    const event: CollectEvent = { id: newId("evt"), type, orderId: order.id, at: Date.now(), data };
    store.addEvent(event);
    try {
      await config.onEvent?.(event, order);
    } catch (err) {
      console.error(`[collect] onEvent ${type} failed:`, err);
    }
    if (config.webhook) {
      const body = JSON.stringify({ event, order: publicOrder(order) });
      const ts = Math.floor(Date.now() / 1000);
      const sig = createHmac("sha256", config.webhook.secret).update(`${ts}.${body}`).digest("hex");
      fetch(config.webhook.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Collect-Signature": `t=${ts},v1=${sig}` },
        body,
      }).catch((err) => console.error(`[collect] webhook ${type} failed:`, err));
    }
  }

  async function sendPassEmail(order: Order, kind: "paid" | "ready") {
    if (!order.customerEmail) return;
    const common = { order, merchant, passUrl: passUrl(order), kind, timeZone: config.timeZone, poweredBy: config.poweredBy };
    const preview = renderPassEmail({ ...common, qrSrc: await qrDataUri(order) });
    store.saveEmail({ id: newId("eml"), orderId: order.id, to: order.customerEmail, subject: preview.subject, html: preview.html, at: Date.now() });
    try {
      if (config.mailer.delivers) {
        const mail = renderPassEmail({ ...common, qrSrc: "cid:pickup-qr" });
        await config.mailer.send({
          from: merchant.fromEmail,
          to: order.customerEmail,
          subject: mail.subject,
          html: mail.html,
          attachments: [{ filename: "pickup-qr.png", content: await qrPng(order), contentId: "pickup-qr" }],
        });
      }
      await emit("pass.emailed", order, { kind, to: order.customerEmail, delivered: config.mailer.delivers });
    } catch (err) {
      console.error("[collect] email failed:", err);
      await emit("pass.emailed", order, { kind, to: order.customerEmail, delivered: false, error: String(err) });
    }
  }

  // ---------- order lifecycle ----------

  function createOrder(input: OrderInput): Order {
    if (!input || !Array.isArray(input.items) || input.items.length === 0 || input.items.length > 20) {
      throw new InputError("Add between 1 and 20 items.");
    }
    const rail = input.rail;
    if (rail === "card" && !card) throw new InputError("Card payments aren't set up.");
    if (rail === "x402" && !x402) throw new InputError("Agent payments aren't set up.");
    if (rail === "test" && !config.payments.test) throw new InputError("Test payments are off.");
    if (!["card", "x402", "test"].includes(rail)) throw new InputError("Unknown payment method.");

    const email = input.email?.trim() || null;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new InputError("That email doesn't look right.");
    if (!email && rail !== "card") throw new InputError("An email is needed to send the pickup QR.");

    const items: OrderItem[] = input.items.map(({ id, qty }) => {
      const product = catalog.get(id);
      if (!product) throw new InputError(`Unknown item ${id}.`);
      if (!Number.isInteger(qty) || qty < 1 || qty > 20) throw new InputError("Quantities must be 1 to 20.");
      return { id, name: product.name, qty, unitCents: product.priceCents };
    });
    const now = Date.now();
    const order: Order = {
      id: newId("ord"),
      status: "awaiting_payment",
      rail,
      captureMode: rail === "x402" ? "charge" : rail === "card" ? (config.payments.card?.captureMode ?? "hold") : "hold",
      items,
      totalCents: items.reduce((sum, i) => sum + i.qty * i.unitCents, 0),
      currency,
      customerEmail: email,
      customerName: input.name?.trim().slice(0, 60) || null,
      paymentRef: null,
      payer: null,
      passId: null,
      pickupCode: null,
      collectBy: now + UNPAID_TIMEOUT_MS,
      createdAt: now,
      paidAt: null,
      readyAt: null,
      collectedAt: null,
      refundDue: false,
    };
    store.insertOrder(order);
    void emit("order.created", order);
    return order;
  }

  function freshPickupCode(): string {
    for (let i = 0; i < 5; i++) {
      const code = newPickupCode();
      if (!store.getOrderByPickupCode(code)) return code;
    }
    return newPickupCode(8);
  }

  /** Idempotent: a second confirmation of the same payment returns the order unchanged. */
  async function markPaid(
    orderId: string,
    payment: { paymentRef: string; payer?: string | null; email?: string | null; meta?: Record<string, unknown> },
  ) {
    const existing = store.getOrder(orderId);
    if (!existing) throw new InputError("Order not found.", 404);
    if (existing.status !== "awaiting_payment" && existing.status !== "cancelled") return existing;
    const now = Date.now();
    // A payment that lands after the unpaid timeout still counts: the customer paid.
    const order = store.transition(orderId, ["awaiting_payment", "cancelled"], "paid", {
      paymentRef: payment.paymentRef,
      payer: payment.payer ?? null,
      paidAt: now,
      collectBy: now + windowMs,
      passId: randomBytes(12).toString("base64url"),
      pickupCode: freshPickupCode(),
      customerEmail: existing.customerEmail ?? payment.email ?? null,
    });
    if (!order) return store.getOrder(orderId)!;
    await emit("order.paid", order, { paymentRef: payment.paymentRef, payer: payment.payer ?? undefined, ...payment.meta });
    await sendPassEmail(order, "paid");
    return order;
  }

  async function markReady(orderId: string) {
    const order = store.transition(orderId, ["paid"], "ready", { readyAt: Date.now() });
    if (!order) throw new InputError("Only paid orders can be marked ready.", 409);
    await emit("order.ready", order);
    await sendPassEmail(order, "ready");
    return order;
  }

  type Resolved = { order: Order } | { error: { title: string; detail: string; status: 400 | 404 } };

  function resolveScan(scan: unknown): Resolved {
    if (typeof scan !== "string" || !scan.trim()) {
      return { error: { title: "Nothing scanned", detail: "Scan a QR or type a pickup code.", status: 400 } };
    }
    const token = extractToken(scan);
    if (token) {
      const result = verifyPass(token, [key]);
      if (!result.ok) {
        const detail =
          result.reason === "expired" ? "This pass has expired." : "This QR wasn't issued by this shop, or it was altered.";
        return { error: { title: "Not a valid pass", detail, status: 400 } };
      }
      const order = store.getOrderByPassId(result.claims.pid);
      if (!order || order.id !== result.claims.oid) {
        return { error: { title: "Order not found", detail: "No order matches this pass.", status: 404 } };
      }
      return { order };
    }
    const code = scan.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const order = /^[2-9A-HJKMNP-Z]{6,8}$/.test(code) ? store.getOrderByPickupCode(code) : null;
    if (order) return { order };
    return { error: { title: "Not found", detail: "No open order has that code.", status: 404 } };
  }

  function paymentLabel(o: Order): string {
    if (o.rail === "card") return o.captureMode === "hold" ? "Card on hold: taken at handover" : "Paid by card";
    if (o.rail === "x402") return "Paid by agent in USDC";
    return "Test payment: no money moves";
  }

  function blockedReason(o: Order): string | undefined {
    if (o.status === "collected") return `Already collected ${formatTime(o.collectedAt ?? 0, config.timeZone)}.`;
    if (o.status === "expired") return "This order expired before it was collected.";
    if (o.status === "cancelled") return "This order was cancelled.";
    if (o.status === "awaiting_payment") return "This order hasn't been paid.";
    return undefined;
  }

  function staffView(o: Order) {
    return { ...publicOrder(o), customerName: o.customerName, pickupCode: o.pickupCode };
  }

  async function collect(scan: unknown) {
    const resolved = resolveScan(scan);
    if ("error" in resolved) return { ok: false as const, ...resolved.error };
    const before = resolved.order;
    const reason = blockedReason(before);
    if (reason) return { ok: false as const, status: 409 as const, title: "Can't hand over", detail: reason };
    // Claim the order first so two scanners can't both hand it over.
    const claimed = store.transition(before.id, ["paid", "ready"], "collected", { collectedAt: Date.now() });
    if (!claimed) return { ok: false as const, status: 409 as const, title: "Can't hand over", detail: "Already collected." };
    let captured = false;
    if (before.rail === "card" && before.captureMode === "hold" && card && before.paymentRef) {
      try {
        await card.capture(before.paymentRef);
        captured = true;
      } catch (err) {
        store.transition(before.id, ["collected"], before.status, { collectedAt: null });
        return { ok: false as const, status: 409 as const, title: "Payment couldn't be taken", detail: String((err as Error).message) };
      }
    }
    await emit("order.collected", claimed, { captured });
    const amount = formatMoney(claimed.totalCents, claimed.currency);
    const message = captured
      ? `${amount} taken from the card hold.`
      : claimed.rail === "x402"
        ? `${amount} was paid by agent at order time.`
        : claimed.rail === "card"
          ? `${amount} was paid by card at order time.`
          : `${amount} test order: no money moved.`;
    return { ok: true as const, order: claimed, message };
  }

  async function sweep() {
    const now = Date.now();
    for (const o of store.listExpirable(now)) {
      try {
        if (o.status === "awaiting_payment") {
          const cancelled = store.transition(o.id, ["awaiting_payment"], "cancelled");
          if (cancelled) await emit("order.cancelled", cancelled, { reason: "unpaid" });
          continue;
        }
        let outcome = "none";
        let refundDue = false;
        if (o.rail === "card" && card && o.paymentRef) {
          if (config.noShowPolicy === "keep") {
            await card.capture(o.paymentRef);
            outcome = "kept";
          } else {
            outcome = await card.release(o.paymentRef);
          }
        } else if (o.rail === "x402") {
          refundDue = config.noShowPolicy !== "keep";
          outcome = refundDue ? "refund_due" : "kept";
        }
        const expired = store.transition(o.id, ["paid", "ready"], "expired", { refundDue });
        if (expired) await emit("order.expired", expired, { outcome });
      } catch (err) {
        console.error(`[collect] expiring ${o.id} failed:`, err);
      }
    }
  }

  // ---------- HTTP ----------

  const isStaffDevice = (c: Context) => {
    const cookie = getCookie(c, STAFF_COOKIE);
    if (!staffToken) return Boolean(cookie);
    return Boolean(cookie) && safeEqual(cookie!, staffToken);
  };

  const staffOnly: MiddlewareHandler = async (c, next) => {
    if (!staffToken) return next();
    const header = c.req.header("x-collect-staff-key");
    const fromHeader = header ? createHmac("sha256", header).update("collect-staff-v1").digest("base64url") : null;
    if (isStaffDevice(c) || (fromHeader && safeEqual(fromHeader, staffToken))) return next();
    return c.json({ title: "Staff only", detail: "Sign in on /staff first." }, 401);
  };

  const app = new Hono();
  const require = createRequire(import.meta.url);
  const jsqr = readFileSync(require.resolve("jsqr/dist/jsQR.js"));
  const scannerJs = readFileSync(new URL("../static/scanner.js", import.meta.url));
  const asset = (body: Buffer) => (c: Context) =>
    c.body(new Uint8Array(body), 200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=3600" });
  app.get("/collect-assets/jsQR.js", asset(jsqr));
  app.get("/collect-assets/scanner.js", asset(scannerJs));
  app.get("/.well-known/collect-keys.json", (c) => c.json(toJwks([key])));
  app.get("/.well-known/did.json", (c) => c.json(didDocument(base, key)));
  app.get("/openapi.json", (c) =>
    c.json(
      openApiDocument({
        merchant,
        catalog: config.catalog,
        currency,
        rails: { card: Boolean(card), x402: Boolean(x402), test: Boolean(config.payments.test) },
      }),
    ),
  );

  app.onError((err, c) => {
    if (err instanceof InputError) return c.json({ error: err.message }, err.status);
    console.error("[collect]", err);
    return c.json({ error: "Something went wrong." }, 500);
  });

  app.get("/api/catalog", (c) =>
    c.json({
      merchant: { name: merchant.name, brandColor: merchant.brandColor, logoUrl: merchant.logoUrl, location: merchant.location },
      currency,
      items: config.catalog,
      payments: {
        card: Boolean(card),
        x402: x402 ? { network: x402.network ?? "eip155:84532", payTo: x402.payTo } : null,
        test: Boolean(config.payments.test),
      },
    }),
  );

  app.post("/api/orders", async (c) => {
    const input = (await c.req.json().catch(() => null)) as OrderInput | null;
    if (!input) throw new InputError("Send JSON: { items, email, rail }.");
    const order = createOrder(input);
    if (order.rail === "card") {
      const checkout = await card!.createCheckout(order, {
        success: `${base}/orders/${order.id}/thanks?session_id={CHECKOUT_SESSION_ID}`,
        cancel: `${base}/orders/${order.id}/cancelled`,
        expiresAt: order.collectBy,
      });
      return c.json({ order: publicOrder(order), next: { type: "redirect", url: checkout.url } }, 201);
    }
    if (order.rail === "x402") {
      return c.json(
        {
          order: publicOrder(order),
          next: {
            type: "x402",
            method: "POST",
            url: `${base}/api/orders/${order.id}/pay`,
            note: "POST with an x402 client. The pickup QR is emailed to the customer once the payment settles.",
          },
        },
        201,
      );
    }
    const paid = await markPaid(order.id, { paymentRef: `test_${order.id}` });
    return c.json({ order: publicOrder(paid), next: { type: "done", passUrl: passUrl(paid) } }, 201);
  });

  app.get("/api/orders/:id", (c) => {
    const order = store.getOrder(c.req.param("id"));
    if (!order) throw new InputError("Order not found.", 404);
    return c.json({ order: publicOrder(order) });
  });

  if (config.exposeEmailPreview) {
    app.get("/api/orders/:id/email-preview", (c) => {
      const email = store.getLatestEmail(c.req.param("id"));
      if (!email) return c.text("No email yet.", 404);
      return c.html(email.html);
    });
  }

  if (x402) {
    // Guard and finalise around the x402 middleware: it settles after the handler,
    // so the order is only marked paid once the settlement header is on the response.
    const paidBody = (o: Order, receipt: unknown, replayed = false) => ({
      order: publicOrder(o),
      passUrl: passUrl(o),
      emailedTo: o.customerEmail,
      receipt,
      ...(replayed ? { replayed: true } : {}),
    });

    app.use(X402_PAY_ROUTE, async (c, next) => {
      const id = c.req.param("id")!;
      const order = store.getOrder(id);
      if (!order || order.rail !== "x402") return c.json({ error: "Order not found." }, 404);
      const paymentId = paymentIdFromRequest(c.req.raw.headers);
      if (order.status !== "awaiting_payment") {
        // payment-identifier: the same payment retried gets its original result, not a conflict.
        const paidEvent = paymentId
          ? store.listEvents(id).find((e) => e.type === "order.paid" && e.data?.paymentId === paymentId)
          : undefined;
        if (paidEvent) return c.json(paidBody(order, paidEvent.data?.receipt ?? null, true), 200);
        return c.json({ error: `Order is ${order.status}.`, order: publicOrder(order) }, 409);
      }
      await next();
      const settlement = c.res.status === 200 ? readSettlement(c.res) : null;
      if (!settlement?.success) return;
      const receipt = receiptFrom(settlement);
      const paid = await markPaid(id, {
        paymentRef: settlement.transaction,
        payer: settlement.payer,
        meta: { network: settlement.network, ...(paymentId ? { paymentId } : {}), ...(receipt ? { receipt } : {}) },
      });
      const headers = new Headers(c.res.headers);
      headers.set("Content-Type", "application/json");
      headers.delete("Content-Length");
      c.res = new Response(JSON.stringify(paidBody(paid, receipt)), { status: 200, headers });
    });
    app.use(
      X402_PAY_ROUTE,
      x402PayMiddleware(x402, {
        key,
        baseUrl: base,
        priceFor: (id) => {
          const o = store.getOrder(id);
          return o && o.status === "awaiting_payment" && o.rail === "x402" ? `$${(o.totalCents / 100).toFixed(2)}` : null;
        },
      }),
    );
    app.post(X402_PAY_ROUTE, (c) => c.json({ ok: true }));

    // Sign-In-With-X: the wallet that paid can fetch the pass again, with no account.
    const siwx = createSiwxGate({ baseUrl: base, network: x402.network ?? "eip155:84532" });
    app.get("/api/orders/:id/pass", async (c) => {
      const order = store.getOrder(c.req.param("id"));
      if (!order || order.rail !== "x402" || !order.payer || !order.passId) {
        return c.json({ error: "No agent-paid pass for this order." }, 404);
      }
      const header = c.req.header("SIGN-IN-WITH-X");
      if (!header) {
        const body = siwx.challenge(order.id, `${base}/api/orders/${order.id}/pass`);
        c.header("PAYMENT-REQUIRED", Buffer.from(JSON.stringify(body)).toString("base64"));
        return c.json(body, 402);
      }
      const result = await siwx.verify(header, order.id);
      if (!result.ok) return c.json({ error: result.reason }, 401);
      if (result.address.toLowerCase() !== order.payer.toLowerCase()) {
        return c.json({ error: "Signed in, but this wallet didn't pay for the order." }, 403);
      }
      return c.json({
        order: publicOrder(order),
        passUrl: passUrl(order),
        pickupCode: order.pickupCode,
        qrContent: collectLink(order),
      });
    });
  }

  app.get("/orders/:id/thanks", async (c) => {
    let order = store.getOrder(c.req.param("id"));
    if (!order) return c.html(messagePage(merchant, "Order not found", "Check the link in your email."), 404);
    const sessionId = c.req.query("session_id");
    if (order.status === "awaiting_payment" && sessionId && card) {
      const confirmed = await card.confirmSession(sessionId);
      if (confirmed && confirmed.orderId === order.id) {
        order = await markPaid(order.id, { paymentRef: confirmed.paymentIntentId, email: confirmed.email });
      }
    }
    if (order.status === "awaiting_payment") {
      return c.html(messagePage(merchant, "Payment processing", "We're waiting for your payment to confirm. Refresh in a moment."));
    }
    return c.html(thanksPage({ order, merchant, passUrl: passUrl(order) }));
  });

  app.get("/orders/:id/cancelled", (c) =>
    c.html(messagePage(merchant, "Payment cancelled", "Nothing was charged. You can close this page and order again.")),
  );

  app.post("/api/stripe/webhook", async (c) => {
    if (!card) return c.json({ error: "Card payments aren't set up." }, 404);
    let event;
    try {
      event = card.parseWebhook(await c.req.text(), c.req.header("stripe-signature") ?? "");
    } catch {
      return c.json({ error: "Bad signature." }, 400);
    }
    if (!event) return c.json({ error: "Webhook secret not configured." }, 400);
    if (event.type === "checkout.session.completed") {
      const confirmed = await card.confirmSession(event.data.object.id);
      if (confirmed) await markPaid(confirmed.orderId, { paymentRef: confirmed.paymentIntentId, email: confirmed.email });
    }
    return c.json({ received: true });
  });

  app.get("/p/:passId", async (c) => {
    const order = store.getOrderByPassId(c.req.param("passId"));
    if (!order) return c.html(messagePage(merchant, "Pass not found", "Check the link in your email."), 404);
    return c.html(passPage({ order, merchant, qrDataUri: await qrDataUri(order), timeZone: config.timeZone }));
  });

  // Where the QR points. Staff phones (signed in on /staff) land on the hand-over
  // screen, so any camera app works as a scanner; everyone else sees their pass.
  app.get("/c/:token", (c) => {
    const token = c.req.param("token");
    if (isStaffDevice(c)) return c.redirect(`/staff?scan=${encodeURIComponent(token)}`);
    const pid = (() => {
      try {
        return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).pid as string;
      } catch {
        return null;
      }
    })();
    const order = pid ? store.getOrderByPassId(pid) : null;
    if (!order || !verifyPass(token, [key], 0).ok) {
      return c.html(messagePage(merchant, "Pass not found", "This code wasn't issued by this shop."), 404);
    }
    return c.redirect(`/p/${pid}`);
  });

  app.get("/staff", (c) => {
    if (staffToken && !isStaffDevice(c)) return c.html(staffLoginPage(merchant));
    if (!staffToken) setCookie(c, STAFF_COOKIE, "open", { path: "/", sameSite: "Lax", httpOnly: true, maxAge: 60 * 60 * 24 * 30 });
    return c.html(scannerPage({ merchant, open: !staffToken, prefill: c.req.query("scan") }));
  });

  app.post("/staff/login", async (c) => {
    const form = await c.req.parseBody();
    const given = typeof form.key === "string" ? form.key : "";
    const hashed = createHmac("sha256", given).update("collect-staff-v1").digest("base64url");
    if (!staffToken || !safeEqual(hashed, staffToken)) return c.html(staffLoginPage(merchant, true), 401);
    setCookie(c, STAFF_COOKIE, staffToken, {
      path: "/",
      sameSite: "Lax",
      httpOnly: true,
      secure: base.startsWith("https://"),
      maxAge: 60 * 60 * 24 * 30,
    });
    return c.redirect("/staff");
  });

  app.post("/api/staff/lookup", staffOnly, async (c) => {
    const { scan } = (await c.req.json().catch(() => ({}))) as { scan?: unknown };
    const resolved = resolveScan(scan);
    if ("error" in resolved) return c.json(resolved.error, resolved.error.status);
    const o = resolved.order;
    return c.json({
      order: staffView(o),
      statusLabel: { awaiting_payment: "Not paid", paid: "Paid", ready: "Ready", collected: "Collected", expired: "Expired", cancelled: "Cancelled" }[o.status],
      paymentLabel: paymentLabel(o),
      blockedReason: blockedReason(o),
    });
  });

  app.post("/api/staff/collect", staffOnly, async (c) => {
    const { scan } = (await c.req.json().catch(() => ({}))) as { scan?: unknown };
    const result = await collect(scan);
    if (!result.ok) return c.json({ title: result.title, detail: result.detail }, result.status);
    return c.json({ order: staffView(result.order), message: result.message });
  });

  app.post("/api/staff/ready", staffOnly, async (c) => {
    const { orderId } = (await c.req.json().catch(() => ({}))) as { orderId?: string };
    const order = await markReady(String(orderId ?? ""));
    return c.json({ order: staffView(order) });
  });

  app.get("/api/staff/orders", staffOnly, (c) =>
    c.json({ orders: store.listOrders({ statuses: ["paid", "ready"], limit: 50 }).map(staffView) }),
  );

  const timer = setInterval(() => void sweep(), 60_000);
  timer.unref();

  return {
    app,
    createOrder,
    markPaid,
    markReady,
    collect,
    sweep,
    passUrl,
    collectLink,
    stop: () => clearInterval(timer),
  };
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
