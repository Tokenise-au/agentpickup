// Square POS connector. The venue's Square menu becomes the agentPickup menu; each paid order appears in
// Square as a pickup order with the payment recorded as taken outside Square; marking it ready in Square
// tells agentPickup (which emails the customer); scanning the QR completes it in Square. Square won't
// cancel an order once a payment is recorded, so a no-show cancels the pickup, records a refund when the
// money actually went back, and closes the order. Test orders reach Square at $0 and labelled TEST, so staff
// see them but the venue's sales and tax don't. The venue's Square location supplies its logo, address,
// opening hours, contact details and map position. With cardPayments, buyers pay by card on a checkout page
// here: the charge is made on the Square order itself, so it shows on the venue's screens as paid by card,
// and an uncollected order is refunded through Square.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Order } from "@agentpickup/core";
import type { CatalogItem, OpeningPeriod } from "../config.js";
import { formatHours } from "../directory.js";
import { esc, formatMoney } from "../format.js";
import type { ConnectorContext, PickupConnector, ShopProfile } from "./types.js";

export interface SquareConnectorConfig {
  /** A Square access token for the seller (a sandbox token while testing). */
  accessToken: string;
  /** The Square location orders go to. */
  locationId: string;
  /** Default "sandbox". */
  environment?: "sandbox" | "production";
  /** Pull the menu from Square at start. Default true. */
  syncCatalog?: boolean;
  /** Fill in the venue's logo, address, hours and contact details from the Square location. Default true. */
  syncProfile?: boolean;
  /**
   * Square → agentPickup status. Subscribe to order.fulfillment.updated in the Square Developer Console at
   * <baseUrl>/connect/square/webhook and paste the subscription's signature key here.
   */
  webhookSignatureKey?: string;
  /** The notification URL exactly as entered in Square, if it differs from <baseUrl>/connect/square/webhook. */
  webhookUrl?: string;
  /**
   * Take card payments through the seller's Square (the "square" rail): your Square application's ID, for the
   * card form on the checkout page. The access token needs PAYMENTS_WRITE.
   */
  cardPayments?: { applicationId: string };
  /** For tests, or a proxy. */
  fetch?: typeof fetch;
  /** Square API version header. */
  squareVersion?: string;
}

/** A Square API error, with Square's error codes (CARD_DECLINED and the like). */
class SquareApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly codes: string[],
  ) {
    super(message);
  }
}

/** What a buyer sees when Square turns a card down. */
const DECLINES: Record<string, string> = {
  CARD_DECLINED: "Your card was declined. Try another card.",
  GENERIC_DECLINE: "Your card was declined. Try another card.",
  INSUFFICIENT_FUNDS: "Your card was declined: not enough funds.",
  CVV_FAILURE: "The security code didn't match. Check it and try again.",
  VERIFY_CVV_FAILURE: "The security code didn't match. Check it and try again.",
  ADDRESS_VERIFICATION_FAILURE: "The postcode didn't match the card. Check it and try again.",
  VERIFY_AVS_FAILURE: "The postcode didn't match the card. Check it and try again.",
  INVALID_EXPIRATION: "The expiry date isn't right. Check it and try again.",
  CARD_EXPIRED: "That card has expired. Try another card.",
  INVALID_CARD: "Those card details aren't valid. Check them and try again.",
  INVALID_CARD_DATA: "Those card details aren't valid. Check them and try again.",
  TRANSACTION_LIMIT: "That's over the card's limit. Try another card.",
  CARD_NOT_SUPPORTED: "That card can't be used here. Try another card.",
  CARD_DECLINED_VERIFICATION_REQUIRED: "Your bank needs to confirm this payment. Try again and follow its steps.",
};

/** Square's amount as the card form wants it: "9.40", or "940" in a currency without cents. */
const ZERO_DECIMAL = new Set(["JPY"]);
const amountText = (money: Money) => (ZERO_DECIMAL.has(money.currency) ? String(money.amount) : (money.amount / 100).toFixed(2));
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Money = { amount: number; currency: string };
type SquareFulfillment = { uid: string; type: string; state: string };
type SquareOrder = { id: string; version: number; state: string; total_money?: Money; fulfillments?: SquareFulfillment[] };

/** The order a pickup moves through in Square; later states are reached one step at a time. */
const PICKUP_STEPS = ["PROPOSED", "RESERVED", "PREPARED", "COMPLETED"];

/** No-show outcomes where agentPickup gave the money back at expiry. A USDC refund that settles later
 * arrives as its own order.refunded event. */
const RETURNED_AT_EXPIRY = new Set(["hold_released", "refunded"]);

const DAYS: Record<string, number> = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };

type SquareLocation = {
  name?: string;
  country?: string;
  business_name?: string;
  business_email?: string;
  website_url?: string;
  phone_number?: string;
  logo_url?: string;
  full_format_logo_url?: string;
  timezone?: string;
  coordinates?: { latitude?: number; longitude?: number };
  address?: { address_line_1?: string; address_line_2?: string; locality?: string; administrative_district_level_1?: string; postal_code?: string };
  business_hours?: { periods?: { day_of_week?: string; start_local_time?: string; end_local_time?: string }[] };
};

/** A Square location as an agentPickup profile. */
export function profileFromSquare(l: SquareLocation): ShopProfile {
  const a = l.address ?? {};
  const town = [a.locality, a.administrative_district_level_1, a.postal_code].filter(Boolean).join(" ");
  const address = [a.address_line_1, a.address_line_2, town].filter(Boolean).join(", ");
  const openingHours: OpeningPeriod[] = (l.business_hours?.periods ?? [])
    .filter((p) => p.day_of_week && p.day_of_week in DAYS && p.start_local_time && p.end_local_time)
    .map((p) => ({ day: DAYS[p.day_of_week!], open: p.start_local_time!.slice(0, 5), close: p.end_local_time!.slice(0, 5) }));
  const lat = l.coordinates?.latitude;
  const lng = l.coordinates?.longitude;
  return {
    name: l.business_name || l.name,
    logoUrl: l.full_format_logo_url || l.logo_url || undefined,
    supportEmail: l.business_email || undefined,
    shopUrl: l.website_url || undefined,
    phone: l.phone_number || undefined,
    timeZone: l.timezone || undefined,
    location: {
      name: l.name || l.business_name,
      ...(address ? { address } : {}),
      ...(openingHours.length ? { openingHours, hours: formatHours(openingHours) } : {}),
      ...(typeof lat === "number" && typeof lng === "number" ? { lat, lng } : {}),
    },
  };
}

/** The button colour of an online checkout nobody has branded yet: Square's own blue, not the seller's. */
const SQUARE_BLUE = "#006aff";

const EXTERNAL_TYPE: Record<string, string> = { x402: "CRYPTO", card: "CARD", mpp: "CARD", ucp: "CARD", acp: "CARD", test: "OTHER", group: "OTHER" };

export function squareConnector(cfg: SquareConnectorConfig): PickupConnector {
  const host = cfg.environment === "production" ? "https://connect.squareup.com" : "https://connect.squareupsandbox.com";
  const doFetch = cfg.fetch ?? fetch;
  const version = cfg.squareVersion ?? "2026-09-16";
  // Square variation ids from the last menu sync, so orders reference Square's own items.
  const squareIds = new Set<string>();

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await doFetch(`${host}${path}`, {
      method,
      headers: { Authorization: `Bearer ${cfg.accessToken}`, "Square-Version": version, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as { errors?: { code: string; detail?: string }[] };
    if (!res.ok) {
      const detail = json.errors?.map((e) => `${e.code}${e.detail ? `: ${e.detail}` : ""}`).join("; ") ?? "";
      throw new SquareApiError(`Square ${method} ${path.split("?")[0]} answered ${res.status}${detail ? ` (${detail})` : ""}`, res.status, json.errors?.map((e) => e.code) ?? []);
    }
    return json as T;
  }

  const atLocation = (o: { present_at_all_locations?: boolean; present_at_location_ids?: string[]; absent_at_location_ids?: string[] }) =>
    o.present_at_all_locations === false
      ? (o.present_at_location_ids ?? []).includes(cfg.locationId)
      : !(o.absent_at_location_ids ?? []).includes(cfg.locationId);

  async function fetchCatalog(ctx: ConnectorContext): Promise<CatalogItem[]> {
    type Obj = {
      id: string;
      type: string;
      is_deleted?: boolean;
      present_at_all_locations?: boolean;
      present_at_location_ids?: string[];
      absent_at_location_ids?: string[];
      item_data?: {
        name: string;
        description?: string;
        description_plaintext?: string;
        variations?: (Obj & { item_variation_data?: { name?: string; pricing_type?: string; price_money?: Money } })[];
      };
    };
    const items: CatalogItem[] = [];
    let skipped = 0;
    let cursor: string | undefined;
    do {
      const page = await call<{ objects?: Obj[]; cursor?: string }>(
        "GET",
        `/v2/catalog/list?types=ITEM${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      for (const obj of page.objects ?? []) {
        if (obj.type !== "ITEM" || obj.is_deleted || !obj.item_data || !atLocation(obj)) continue;
        const item = obj.item_data;
        const variations = (item.variations ?? []).filter((v) => !v.is_deleted && atLocation(v));
        for (const v of variations) {
          const data = v.item_variation_data;
          const price = data?.price_money;
          if (!price?.amount || data?.pricing_type === "VARIABLE_PRICING") continue;
          if (price.currency.toLowerCase() !== ctx.currency) {
            skipped++;
            continue;
          }
          const name = variations.length > 1 && data?.name ? `${item.name} (${data.name})` : item.name;
          const description = (item.description_plaintext ?? item.description ?? "").trim().slice(0, 500);
          items.push({ id: v.id, name: name.slice(0, 120), priceCents: Number(price.amount), ...(description ? { description } : {}) });
        }
      }
      cursor = page.cursor;
    } while (cursor);
    if (skipped) console.warn(`[collect] square: skipped ${skipped} menu prices not in ${ctx.currency.toUpperCase()}`);
    squareIds.clear();
    for (const i of items) squareIds.add(i.id);
    return items;
  }

  /**
   * The order as a paid pickup order in Square. A test order (no money moved) goes in at $0 with a TEST ticket:
   * custom $0 lines rather than menu items, so it adds nothing to the venue's sales, tax or stock counts.
   */
  async function sendOrder(order: Order, ctx: ConnectorContext, test: boolean) {
    if (await ctx.linked(order.id)) return; // already in Square
    const currency = ctx.currency.toUpperCase();
    const sq = await createSquareOrder(order, ctx, test);
    if (test) {
      // Square marks a $0 order paid with no payment at all, so it shows as paid and ready to make.
      await call("POST", `/v2/orders/${encodeURIComponent(sq.id)}/pay`, { idempotency_key: `agentpickup-pay-${order.id}`, order_version: sq.version });
      await ctx.link(order.id, sq.id, { fulfillmentUid: sq.fulfillments?.[0]?.uid ?? null, paymentId: null, squareTotal: 0 });
      return;
    }
    // Record the money agentPickup already took, so the order shows as paid in Square POS.
    const total = sq.total_money ?? { amount: order.totalCents, currency };
    const payment = await call<{ payment?: { id: string } }>("POST", "/v2/payments", {
      idempotency_key: `agentpickup-pay-${order.id}`,
      source_id: "EXTERNAL",
      amount_money: total,
      order_id: sq.id,
      location_id: cfg.locationId,
      reference_id: order.id,
      external_details: {
        type: EXTERNAL_TYPE[order.rail] ?? "EXTERNAL",
        source: "agentPickup",
        ...(order.paymentRef ? { source_id: order.paymentRef.slice(0, 255) } : {}),
      },
      note: `Paid through agentPickup (${order.rail}).`,
    });
    await ctx.link(order.id, sq.id, {
      fulfillmentUid: sq.fulfillments?.[0]?.uid ?? null,
      paymentId: payment.payment?.id ?? null,
      squareTotal: total.amount,
    });
  }

  /** The order in Square: a pickup order for the customer's name. Made once per order, however often asked. */
  async function createSquareOrder(order: Order, ctx: ConnectorContext, test: boolean): Promise<SquareOrder> {
    const currency = ctx.currency.toUpperCase();
    const created = await call<{ order: SquareOrder }>("POST", "/v2/orders", {
      idempotency_key: `agentpickup-order-${order.id}`,
      order: {
        location_id: cfg.locationId,
        reference_id: order.id,
        source: { name: "agentPickup" },
        ...(test ? { ticket_name: "TEST · agentPickup" } : {}),
        line_items: order.items.map((i) => ({
          ...(test
            ? { name: i.name, quantity: String(i.qty), base_price_money: { amount: 0, currency } }
            : squareIds.has(i.id)
              ? { catalog_object_id: i.id, quantity: String(i.qty) }
              : { name: i.name, quantity: String(i.qty), base_price_money: { amount: i.unitCents, currency } }),
          // A group order's lines say whose each one is.
          ...(i.note ? { note: i.note.slice(0, 2000) } : {}),
        })),
        fulfillments: [
          {
            type: "PICKUP",
            state: "PROPOSED",
            pickup_details: {
              recipient: { display_name: (order.customerName || "agentPickup customer").slice(0, 255) },
              schedule_type: "ASAP",
              note: `${test ? "TEST ORDER: no money moved. " : ""}agentPickup order. Pickup code ${order.pickupCode}: scan the customer's QR to hand over.`,
            },
          },
        ],
      },
    });
    return created.order;
  }

  /**
   * Move the order's pickup to `target` in Square, through any states it hasn't reached yet. After a
   * completed or cancelled pickup, close the order itself so it leaves the venue's open orders.
   */
  async function advance(order: Order, target: "PREPARED" | "COMPLETED" | "CANCELED", ctx: ConnectorContext) {
    const link = await ctx.linked(order.id);
    if (!link) return;
    let { order: sq } = await call<{ order: SquareOrder }>("GET", `/v2/orders/${encodeURIComponent(link.externalId)}`);
    const f = sq.fulfillments?.find((x) => x.uid === link.fulfillmentUid) ?? sq.fulfillments?.[0];
    if (!f) return;
    const done = f.state === "COMPLETED" || f.state === "CANCELED" || f.state === "FAILED";
    if (!done && f.state !== target) {
      const from = PICKUP_STEPS.indexOf(f.state);
      const steps = target === "CANCELED" ? ["CANCELED"] : PICKUP_STEPS.slice(from + 1, PICKUP_STEPS.indexOf(target) + 1);
      for (const state of steps) {
        ({ order: sq } = await call<{ order: SquareOrder }>("PUT", `/v2/orders/${encodeURIComponent(sq.id)}`, {
          idempotency_key: `agentpickup-${order.id}-${state}`,
          order: { location_id: cfg.locationId, version: sq.version, fulfillments: [{ uid: f.uid, state }] },
        }));
      }
    }
    if (target !== "PREPARED" && sq.state === "OPEN") {
      await call("PUT", `/v2/orders/${encodeURIComponent(sq.id)}`, {
        idempotency_key: `agentpickup-${order.id}-close`,
        order: { location_id: cfg.locationId, version: sq.version, state: "COMPLETED" },
      });
    }
  }

  /** Record in Square that the money for this order went back to the customer. */
  async function recordRefund(order: Order, ctx: ConnectorContext) {
    const link = await ctx.linked(order.id);
    if (!link?.paymentId) return;
    await call("POST", "/v2/refunds", {
      idempotency_key: `agentpickup-refund-${order.id}`,
      payment_id: link.paymentId,
      amount_money: { amount: Number(link.squareTotal ?? order.totalCents), currency: ctx.currency.toUpperCase() },
      reason: "agentPickup: not collected, money returned",
    });
  }

  /**
   * Apple Pay on the Web: register the checkout's domain with Square, with this seller's token, once. Square
   * then validates it against the file at /.well-known/apple-developer-merchantid-domain-association. A failure
   * is tried again an hour later.
   */
  let applePay: { at: number; done: boolean; pending?: Promise<void> } | null = null;
  function registerApplePay(baseUrl: string) {
    const { protocol, hostname } = new URL(baseUrl);
    // Apple Pay needs HTTPS on a real domain.
    if (protocol !== "https:" || hostname === "localhost" || /^[\d.]+$|^\[/.test(hostname)) return;
    if (applePay && (applePay.done || applePay.pending || Date.now() - applePay.at < 3600_000)) return;
    const pending = call<{ status?: string }>("POST", "/v2/apple-pay/domains", { domain_name: hostname })
      .then((r) => {
        applePay = { at: Date.now(), done: true };
        console.log(`[collect] square: Apple Pay registered for ${hostname} (${r.status ?? "ok"})`);
      })
      .catch((err) => {
        applePay = { at: Date.now(), done: false };
        console.error(`[collect] square: registering ${hostname} for Apple Pay failed:`, err);
      });
    applePay = { at: Date.now(), done: false, pending };
  }

  /** GET /connect/square/pay/:id shows the card form; POST charges the card on the Square order. */
  function mountCheckout(app: Parameters<NonNullable<PickupConnector["routes"]>>[0], ctx: ConnectorContext, applicationId: string) {
    const sdk = cfg.environment === "production" ? "https://web.squarecdn.com/v1/square.js" : "https://sandbox.web.squarecdn.com/v1/square.js";
    const thanks = (id: string) => `${ctx.baseUrl}/orders/${encodeURIComponent(id)}/thanks`;
    const notFoundPage = () => ctx.page({ title: "Order not found", body: `<div class="card"><h1>Order not found</h1><p class="muted">Check the link you were sent.</p></div>` });

    app.get("/pay/:id", async (c) => {
      const order = await ctx.getOrder(c.req.param("id"));
      if (!order || order.rail !== "square") return c.html(notFoundPage(), 404);
      if (order.status !== "awaiting_payment") return c.redirect(thanks(order.id));
      registerApplePay(ctx.baseUrl);
      // Square prices the order, its taxes included, so the page shows exactly what the card is charged.
      const sq = await createSquareOrder(order, ctx, false);
      const total = sq.total_money ?? { amount: order.totalCents, currency: ctx.currency.toUpperCase() };
      const price = formatMoney(total.amount, total.currency.toLowerCase());
      const items = order.items.map((i) => `${i.qty} × ${esc(i.name)}${i.note ? ` <span class="muted">(${esc(i.note)})</span>` : ""}`).join("<br>");
      const body = `
<div class="card">
  <h1>Pay ${esc(price)}</h1>
  <p class="muted">${items}</p>
  ${order.customerEmail ? "" : `<label class="label" for="payEmail" style="display:block;text-align:left;margin-top:14px">Email for your pickup QR</label>
  <input type="email" id="payEmail" placeholder="you@example.com" autocomplete="email" required style="margin-top:6px">`}
  <button id="apple-pay" type="button" hidden aria-label="Pay with Apple Pay" style="display:block;width:100%;height:48px;margin:16px 0 0;border-radius:12px;-webkit-appearance:-apple-pay-button;-apple-pay-button-type:plain;-apple-pay-button-style:black"></button>
  <div id="google-pay" style="margin:12px 0 0"></div>
  <div id="card-container" style="margin-top:14px;min-height:96px"></div>
  <button class="btn block" id="pay" type="button" disabled>Pay ${esc(price)}</button>
  <p class="muted" id="payMsg" role="status" style="margin-top:10px">Loading the card form…</p>
</div>
<p class="muted" style="text-align:center">The card is charged by this shop, through Square.</p>`;
      return c.html(
        ctx.page({
          title: "Pay for your order",
          body,
          scripts: [sdk, `${ctx.baseUrl}/collect-assets/square-pay.js`],
          inlineScript: `window.__squarePay=${JSON.stringify({
            appId: applicationId,
            locationId: cfg.locationId,
            amount: amountText(total),
            currency: total.currency,
            country: await locationCountry().catch(() => "AU"),
            payUrl: `${ctx.baseUrl}/connect/square/pay/${encodeURIComponent(order.id)}`,
            needsEmail: !order.customerEmail,
          })};`,
        }),
      );
    });

    app.post("/pay/:id", async (c) => {
      const order = await ctx.getOrder(c.req.param("id"));
      if (!order || order.rail !== "square") return c.json({ error: "Order not found." }, 404);
      if (order.status !== "awaiting_payment") {
        return ["paid", "ready", "collected"].includes(order.status) ? c.json({ ok: true, thanksUrl: thanks(order.id) }) : c.json({ error: "This order can't be paid any more." }, 409);
      }
      const input = (await c.req.json().catch(() => ({}))) as { sourceId?: unknown; email?: unknown };
      const sourceId = typeof input.sourceId === "string" ? input.sourceId.trim() : "";
      if (!sourceId || sourceId.length > 500) return c.json({ error: "The card details didn't come through. Try again." }, 400);
      const email = (typeof input.email === "string" && input.email.trim()) || order.customerEmail;
      if (!email || !EMAIL.test(email)) return c.json({ error: "Add your email: your pickup QR goes there." }, 400);
      const sq = await createSquareOrder(order, ctx, false);
      let payment: { id: string; status: string; amount_money: Money; card_details?: { card?: { card_brand?: string; last_4?: string } } };
      try {
        ({ payment } = await call<{ payment: typeof payment }>("POST", "/v2/payments", {
          // One try per card token, so a retry with the same card can't charge twice. Square allows 45 characters.
          idempotency_key: `ap-${order.id}-${createHash("sha256").update(sourceId).digest("hex").slice(0, 16)}`,
          source_id: sourceId,
          amount_money: sq.total_money ?? { amount: order.totalCents, currency: ctx.currency.toUpperCase() },
          order_id: sq.id,
          location_id: cfg.locationId,
          reference_id: order.id,
          autocomplete: true,
          buyer_email_address: email,
          note: `agentPickup order ${order.id}`,
        }));
      } catch (err) {
        const declined = err instanceof SquareApiError ? err.codes.map((code) => DECLINES[code]).find(Boolean) : undefined;
        if (declined) return c.json({ error: declined }, 402);
        console.error(`[collect] square: card payment for ${order.id} failed:`, err);
        return c.json({ error: "Square didn't take the payment just now. Nothing was charged; try again in a moment." }, 502);
      }
      if (payment.status !== "COMPLETED") return c.json({ error: "The payment didn't complete. Try again or use another card." }, 402);
      await ctx.link(order.id, sq.id, { fulfillmentUid: sq.fulfillments?.[0]?.uid ?? null, paymentId: payment.id, squareTotal: payment.amount_money.amount });
      const card = payment.card_details?.card;
      await ctx.markPaid(order.id, {
        paymentRef: payment.id,
        email,
        meta: { squareOrderId: sq.id, ...(card ? { card: `${card.card_brand ?? "Card"} ${card.last_4 ?? ""}`.trim() } : {}) },
      });
      return c.json({ ok: true, thanksUrl: thanks(order.id) });
    });
  }

  /** The location's country, for the wallet buttons on the checkout page. */
  let country: string | null = null;
  async function locationCountry(): Promise<string> {
    if (!country) {
      const { location } = await call<{ location: SquareLocation }>("GET", `/v2/locations/${encodeURIComponent(cfg.locationId)}`);
      country = location.country ?? "AU";
    }
    return country;
  }

  async function fetchProfile(): Promise<ShopProfile> {
    const { location } = await call<{ location: SquareLocation }>("GET", `/v2/locations/${encodeURIComponent(cfg.locationId)}`);
    if (location.country) country = location.country;
    const brandColor = await checkoutColour().catch(() => undefined);
    return { ...profileFromSquare(location), ...(brandColor ? { brandColor } : {}) };
  }

  /** The colour the seller gave their Square online checkout, if they changed it from Square's blue. */
  async function checkoutColour() {
    const { location_settings } = await call<{ location_settings?: { branding?: { button_color?: string } } }>(
      "GET",
      `/v2/online-checkout/location-settings/${encodeURIComponent(cfg.locationId)}`,
    );
    const colour = location_settings?.branding?.button_color?.toLowerCase();
    return colour && /^#[0-9a-f]{6}$/.test(colour) && colour !== SQUARE_BLUE ? colour : undefined;
  }

  return {
    name: "square",
    fetchCatalog: cfg.syncCatalog === false ? undefined : fetchCatalog,
    fetchProfile: cfg.syncProfile === false ? undefined : fetchProfile,

    async onEvent(event, order, ctx) {
      // One person's share of a group order arrives inside the group's combined order instead.
      if (event.type === "order.paid" && event.data?.groupMember) return;
      // No money moved for a test payment, or for a group whose shares were all test payments.
      const test = order.rail === "test" || (order.rail === "group" && event.data?.testOnly === true);
      if (event.type === "order.paid") await sendOrder(order, ctx, test);
      else if (event.type === "order.ready") await advance(order, "PREPARED", ctx);
      else if (event.type === "order.collected") await advance(order, "COMPLETED", ctx);
      else if (event.type === "order.expired") {
        // A card paid through Square was refunded at expiry already (cardPayments.refund).
        if (RETURNED_AT_EXPIRY.has(String(event.data?.outcome)) && order.rail !== "square") await recordRefund(order, ctx);
        await advance(order, "CANCELED", ctx);
      } else if (event.type === "order.refunded") await recordRefund(order, ctx);
    },

    ...(cfg.cardPayments
      ? {
          cardPayments: {
            live: cfg.environment === "production",
            checkoutUrl: (order: Order, ctx: ConnectorContext) => `${ctx.baseUrl}/connect/square/pay/${encodeURIComponent(order.id)}`,
            refund: async (order: Order, ctx: ConnectorContext) => {
              const link = await ctx.linked(order.id);
              if (!link?.paymentId) throw new Error(`No Square card payment is recorded for ${order.id}.`);
              await recordRefund(order, ctx);
            },
          },
        }
      : {}),

    routes(app, ctx) {
      if (cfg.cardPayments) mountCheckout(app, ctx, cfg.cardPayments.applicationId);
      app.post("/webhook", async (c) => {
        if (!cfg.webhookSignatureKey) return c.json({ error: "Square webhooks aren't set up on this shop." }, 404);
        const raw = await c.req.text();
        const url = cfg.webhookUrl ?? `${ctx.baseUrl}/connect/square/webhook`;
        const expected = Buffer.from(createHmac("sha256", cfg.webhookSignatureKey).update(url + raw).digest("base64"));
        const given = Buffer.from(c.req.header("x-square-hmacsha256-signature") ?? "");
        if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
          return c.json({ error: "Signature doesn't match." }, 401);
        }
        const event = JSON.parse(raw) as {
          type?: string;
          data?: { object?: { order_fulfillment_updated?: { order_id?: string; location_id?: string; fulfillment_update?: { new_state?: string }[] } } };
        };
        const update = event.data?.object?.order_fulfillment_updated;
        if (event.type === "order.fulfillment.updated" && update?.order_id && (!update.location_id || update.location_id === cfg.locationId)) {
          const orderId = await ctx.orderFor(update.order_id);
          const order = orderId ? await ctx.getOrder(orderId) : null;
          // Staff marked it ready in Square POS: tell the customer.
          if (order?.status === "paid" && update.fulfillment_update?.some((u) => u.new_state === "PREPARED")) {
            await ctx.markReady(order.id);
          }
        }
        return c.json({ ok: true });
      });
    },
  };
}
