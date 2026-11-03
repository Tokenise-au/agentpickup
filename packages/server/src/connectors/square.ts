// Square POS connector. The venue's Square menu becomes the agentPickup menu; each paid order appears in
// Square as a pickup order with the payment recorded as taken outside Square; marking it ready in Square
// tells agentPickup (which emails the customer); scanning the QR completes it in Square. Square won't
// cancel an order once a payment is recorded, so a no-show cancels the pickup, records a refund when the
// money actually went back, and closes the order. The venue's Square location supplies its logo, address,
// opening hours, contact details and map position.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Order } from "@agentpickup/core";
import type { CatalogItem, OpeningPeriod } from "../config.js";
import { formatHours } from "../directory.js";
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
  /** For tests, or a proxy. */
  fetch?: typeof fetch;
  /** Square API version header. */
  squareVersion?: string;
}

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

const EXTERNAL_TYPE: Record<string, string> = { x402: "CRYPTO", card: "CARD", mpp: "CARD", ucp: "CARD", acp: "CARD", test: "OTHER" };

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
      throw new Error(`Square ${method} ${path.split("?")[0]} answered ${res.status}${detail ? ` (${detail})` : ""}`);
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

  async function sendOrder(order: Order, ctx: ConnectorContext) {
    if (await ctx.linked(order.id)) return; // already in Square
    const currency = ctx.currency.toUpperCase();
    const created = await call<{ order: SquareOrder }>("POST", "/v2/orders", {
      idempotency_key: `agentpickup-order-${order.id}`,
      order: {
        location_id: cfg.locationId,
        reference_id: order.id,
        source: { name: "agentPickup" },
        line_items: order.items.map((i) =>
          squareIds.has(i.id)
            ? { catalog_object_id: i.id, quantity: String(i.qty) }
            : { name: i.name, quantity: String(i.qty), base_price_money: { amount: i.unitCents, currency } },
        ),
        fulfillments: [
          {
            type: "PICKUP",
            state: "PROPOSED",
            pickup_details: {
              recipient: { display_name: (order.customerName || "agentPickup customer").slice(0, 255) },
              schedule_type: "ASAP",
              note: `agentPickup order. Pickup code ${order.pickupCode}: scan the customer's QR to hand over.`,
            },
          },
        ],
      },
    });
    const sq = created.order;
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

  async function fetchProfile(): Promise<ShopProfile> {
    const { location } = await call<{ location: SquareLocation }>("GET", `/v2/locations/${encodeURIComponent(cfg.locationId)}`);
    return profileFromSquare(location);
  }

  return {
    name: "square",
    fetchCatalog: cfg.syncCatalog === false ? undefined : fetchCatalog,
    fetchProfile: cfg.syncProfile === false ? undefined : fetchProfile,

    async onEvent(event, order, ctx) {
      if (event.type === "order.paid") await sendOrder(order, ctx);
      else if (event.type === "order.ready") await advance(order, "PREPARED", ctx);
      else if (event.type === "order.collected") await advance(order, "COMPLETED", ctx);
      else if (event.type === "order.expired") {
        if (RETURNED_AT_EXPIRY.has(String(event.data?.outcome))) await recordRefund(order, ctx);
        await advance(order, "CANCELED", ctx);
      } else if (event.type === "order.refunded") await recordRefund(order, ctx);
    },

    routes(app, ctx) {
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
