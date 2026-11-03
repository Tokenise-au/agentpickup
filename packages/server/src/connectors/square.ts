// Square POS connector. The venue's Square menu becomes the agentPickup menu; each paid order appears in
// Square as a pickup order with the payment recorded as taken outside Square; marking it ready in Square
// tells agentPickup (which emails the customer); scanning the QR completes it in Square.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Order } from "@agentpickup/core";
import type { CatalogItem } from "../config.js";
import type { ConnectorContext, PickupConnector } from "./types.js";

export interface SquareConnectorConfig {
  /** A Square access token for the seller (a sandbox token while testing). */
  accessToken: string;
  /** The Square location orders go to. */
  locationId: string;
  /** Default "sandbox". */
  environment?: "sandbox" | "production";
  /** Pull the menu from Square at start. Default true. */
  syncCatalog?: boolean;
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

  /** Move the order's pickup to `target` in Square, through any states it hasn't reached yet. */
  async function advance(order: Order, target: "PREPARED" | "COMPLETED" | "CANCELED", ctx: ConnectorContext) {
    const link = await ctx.linked(order.id);
    if (!link) return;
    const { order: sq } = await call<{ order: SquareOrder }>("GET", `/v2/orders/${encodeURIComponent(link.externalId)}`);
    const f = sq.fulfillments?.find((x) => x.uid === link.fulfillmentUid) ?? sq.fulfillments?.[0];
    if (!f || f.state === target || f.state === "COMPLETED" || f.state === "CANCELED" || f.state === "FAILED") return;
    const from = PICKUP_STEPS.indexOf(f.state);
    const steps = target === "CANCELED" ? ["CANCELED"] : PICKUP_STEPS.slice(from + 1, PICKUP_STEPS.indexOf(target) + 1);
    let current = sq.version;
    for (const state of steps) {
      const res = await call<{ order: SquareOrder }>("PUT", `/v2/orders/${encodeURIComponent(sq.id)}`, {
        idempotency_key: `agentpickup-${order.id}-${state}`,
        order: { location_id: cfg.locationId, version: current, fulfillments: [{ uid: f.uid, state }] },
      });
      current = res.order.version;
    }
  }

  return {
    name: "square",
    fetchCatalog: cfg.syncCatalog === false ? undefined : fetchCatalog,

    async onEvent(event, order, ctx) {
      if (event.type === "order.paid") await sendOrder(order, ctx);
      else if (event.type === "order.ready") await advance(order, "PREPARED", ctx);
      else if (event.type === "order.collected") await advance(order, "COMPLETED", ctx);
      else if (event.type === "order.expired" || event.type === "order.cancelled") await advance(order, "CANCELED", ctx);
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
