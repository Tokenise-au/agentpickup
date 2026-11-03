import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { generateSigningKeyPem } from "@agentpickup/core";
import { createCollect, outboxMailer, squareConnector, type Store } from "../src/index.js";
import { agentBuys, makeAgent, setupShop, testStore } from "./helpers.js";
import { generatePrivateKey } from "viem/accounts";

const TOKEN = "EAAAtest-token";
const LOCATION = "L_TEST_LOCATION";
const SIGNATURE_KEY = "sig-key-test";
const BASE = "https://shop.test";

type Fulfillment = { uid: string; type: string; state: string; pickup_details?: Record<string, unknown> };
type SqOrder = {
  id: string;
  version: number;
  state: string;
  location_id: string;
  reference_id?: string;
  source?: { name: string };
  ticket_name?: string;
  /** Paid with no payment: Square's PayOrder on a $0 order. */
  paidWithoutPayment?: boolean;
  line_items: { catalog_object_id?: string; name?: string; quantity: string; base_price_money?: { amount: number } }[];
  fulfillments: Fulfillment[];
  total_money: { amount: number; currency: string };
};

const STEPS = ["PROPOSED", "RESERVED", "PREPARED", "COMPLETED"];

/** Enough of Square's API to test against: auth, versions, idempotency, one-step pickup states, external payments. */
class FakeSquare {
  orders = new Map<string, SqOrder>();
  payments: Record<string, unknown>[] = [];
  refunds: Record<string, unknown>[] = [];
  calls: string[] = [];
  failNext = 0;
  /** The seller's online checkout button colour; Square's blue until they change it. */
  checkoutColour = "#006aff";
  private idem = new Map<string, unknown>();
  catalog: unknown[] = [
    {
      type: "ITEM",
      id: "ITEM_FW",
      item_data: {
        name: "Flat white",
        description_plaintext: "Double shot",
        variations: [
          { type: "ITEM_VARIATION", id: "VAR_FW_REG", item_variation_data: { name: "Regular", pricing_type: "FIXED_PRICING", price_money: { amount: 520, currency: "AUD" } } },
          { type: "ITEM_VARIATION", id: "VAR_FW_LRG", item_variation_data: { name: "Large", pricing_type: "FIXED_PRICING", price_money: { amount: 620, currency: "AUD" } } },
        ],
      },
    },
    {
      type: "ITEM",
      id: "ITEM_CR",
      item_data: {
        name: "Croissant",
        variations: [{ type: "ITEM_VARIATION", id: "VAR_CR", item_variation_data: { name: "Regular", pricing_type: "FIXED_PRICING", price_money: { amount: 600, currency: "AUD" } } }],
      },
    },
    // Skipped: another currency, deleted, not at this location, priced at the counter.
    { type: "ITEM", id: "ITEM_USD", item_data: { name: "Import", variations: [{ id: "VAR_USD", item_variation_data: { price_money: { amount: 900, currency: "USD" } } }] } },
    { type: "ITEM", id: "ITEM_DEL", is_deleted: true, item_data: { name: "Old", variations: [{ id: "VAR_DEL", item_variation_data: { price_money: { amount: 100, currency: "AUD" } } }] } },
    { type: "ITEM", id: "ITEM_ELSE", present_at_all_locations: false, present_at_location_ids: ["L_OTHER"], item_data: { name: "Elsewhere", variations: [{ id: "VAR_ELSE", item_variation_data: { price_money: { amount: 100, currency: "AUD" } } }] } },
    { type: "ITEM", id: "ITEM_VAR", item_data: { name: "Market fish", variations: [{ id: "VAR_FISH", item_variation_data: { pricing_type: "VARIABLE_PRICING" } }] } },
  ];

  location: Record<string, unknown> = {
    id: LOCATION,
    name: "Crown St",
    business_name: "Corner Café",
    business_email: "hello@cornercafe.test",
    website_url: "https://cornercafe.test",
    phone_number: "+61 2 9000 0000",
    logo_url: "https://images.square.test/logo-square.png",
    full_format_logo_url: "https://images.square.test/logo-wide.png",
    timezone: "Australia/Sydney",
    coordinates: { latitude: -33.8836, longitude: 151.2149 },
    address: { address_line_1: "12 Crown St", locality: "Surry Hills", administrative_district_level_1: "NSW", postal_code: "2010", country: "AU" },
    business_hours: {
      periods: [
        ...["MON", "TUE", "WED", "THU", "FRI"].map((d) => ({ day_of_week: d, start_local_time: "07:00:00", end_local_time: "15:00:00" })),
        { day_of_week: "SAT", start_local_time: "08:00:00", end_local_time: "13:30:00" },
      ],
    },
  };

  private priceOf(id: string) {
    for (const item of this.catalog as { item_data?: { variations?: { id: string; item_variation_data?: { price_money?: { amount: number } } }[] } }[]) {
      const v = item.item_data?.variations?.find((x) => x.id === id);
      if (v) return v.item_variation_data?.price_money?.amount ?? 0;
    }
    return null;
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    this.calls.push(`${method} ${url.pathname}`);
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    const error = (status: number, code: string, detail: string) => reply(status, { errors: [{ category: "INVALID_REQUEST_ERROR", code, detail }] });
    if (url.host !== "connect.squareupsandbox.com") return error(404, "NOT_FOUND", "wrong host");
    if (headers.get("Authorization") !== `Bearer ${TOKEN}`) return error(401, "UNAUTHORIZED", "bad token");
    if (!headers.get("Square-Version")) return error(400, "BAD_REQUEST", "missing Square-Version");
    if (this.failNext > 0) {
      this.failNext--;
      return error(500, "INTERNAL_SERVER_ERROR", "try again");
    }
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const replay = body.idempotency_key ? this.idem.get(`${method} ${url.pathname} ${body.idempotency_key}`) : undefined;
    if (replay) return reply(200, replay);
    const remember = (result: unknown) => {
      if (body.idempotency_key) this.idem.set(`${method} ${url.pathname} ${body.idempotency_key}`, result);
      return reply(200, result);
    };

    if (method === "GET" && url.pathname === `/v2/locations/${LOCATION}`) return reply(200, { location: this.location });
    if (method === "GET" && url.pathname === `/v2/online-checkout/location-settings/${LOCATION}`) {
      return reply(200, { location_settings: { location_id: LOCATION, branding: { header_type: "BUSINESS_NAME", button_color: this.checkoutColour, button_shape: "ROUNDED" } } });
    }
    if (method === "GET" && url.pathname === "/v2/catalog/list") {
      // Two pages, to exercise the cursor.
      const cursor = url.searchParams.get("cursor");
      return cursor === "page2" ? reply(200, { objects: this.catalog.slice(3) }) : reply(200, { objects: this.catalog.slice(0, 3), cursor: "page2" });
    }
    if (method === "POST" && url.pathname === "/v2/orders") {
      const o = body.order;
      if (o.location_id !== LOCATION) return error(400, "INVALID_VALUE", "location_id");
      let total = 0;
      for (const li of o.line_items) {
        const unit = li.catalog_object_id ? this.priceOf(li.catalog_object_id) : li.base_price_money?.amount;
        if (unit === null || unit === undefined) return error(400, "NOT_FOUND", `catalog object ${li.catalog_object_id}`);
        total += unit * Number(li.quantity);
      }
      const id = `SQ_ORDER_${this.orders.size + 1}`;
      const order: SqOrder = {
        ...o,
        id,
        version: 1,
        state: "OPEN",
        fulfillments: o.fulfillments.map((f: Fulfillment, i: number) => ({ ...f, uid: `F${i + 1}` })),
        total_money: { amount: total, currency: "AUD" },
      };
      this.orders.set(id, order);
      return remember({ order });
    }
    const pay = url.pathname.match(/^\/v2\/orders\/([^/]+)\/pay$/);
    if (pay && method === "POST") {
      const order = this.orders.get(pay[1]);
      if (!order) return error(404, "NOT_FOUND", "order");
      if (body.order_version !== undefined && body.order_version !== order.version) return error(400, "VERSION_MISMATCH", "stale version");
      // As Square answers: only a $0 order can be paid without a payment.
      if (!body.payment_ids?.length && order.total_money.amount !== 0) return error(400, "BAD_REQUEST", "payment_ids are required for a non-zero order");
      order.paidWithoutPayment = true;
      order.version++;
      return remember({ order });
    }
    const m = url.pathname.match(/^\/v2\/orders\/([^/]+)$/);
    if (m && method === "GET") {
      const order = this.orders.get(m[1]);
      return order ? reply(200, { order }) : error(404, "NOT_FOUND", "order");
    }
    if (m && method === "PUT") {
      const order = this.orders.get(m[1]);
      if (!order) return error(404, "NOT_FOUND", "order");
      if (body.order.version !== order.version) return error(400, "VERSION_MISMATCH", "stale version");
      // As the real sandbox answers: a paid order can be closed but not cancelled.
      if (body.order.state === "CANCELED" && this.payments.some((p) => p.order_id === order.id)) {
        return error(400, "BAD_REQUEST", "Orders cannot be canceled after payments have been processed.");
      }
      if (body.order.state) order.state = body.order.state;
      for (const change of body.order.fulfillments ?? []) {
        const f = order.fulfillments.find((x) => x.uid === change.uid);
        if (!f) return error(400, "NOT_FOUND", "fulfillment");
        const ok = change.state === "CANCELED" ? f.state !== "COMPLETED" : STEPS.indexOf(change.state) === STEPS.indexOf(f.state) + 1;
        if (!ok) return error(400, "INVALID_STATE_TRANSITION", `${f.state} to ${change.state}`);
        f.state = change.state;
      }
      order.version++;
      return remember({ order });
    }
    if (method === "POST" && url.pathname === "/v2/payments") {
      const order = this.orders.get(body.order_id);
      if (body.source_id !== "EXTERNAL" || !body.external_details?.type || !body.external_details?.source) return error(400, "INVALID_VALUE", "external_details");
      if (!order || body.amount_money?.amount !== order.total_money.amount) return error(400, "INVALID_VALUE", "amount must match the order total");
      const payment = { id: `PAY_${this.payments.length + 1}`, ...body, status: "COMPLETED" };
      this.payments.push(payment);
      return remember({ payment });
    }
    if (method === "POST" && url.pathname === "/v2/refunds") {
      const payment = this.payments.find((p) => p.id === body.payment_id) as { amount_money: { amount: number } } | undefined;
      if (!payment) return error(404, "NOT_FOUND", "payment");
      if (body.amount_money?.amount > payment.amount_money.amount) return error(400, "INVALID_VALUE", "more than was paid");
      const refund = { id: `REF_${this.refunds.length + 1}`, ...body, status: "PENDING" };
      this.refunds.push(refund);
      return remember({ refund });
    }
    return error(404, "NOT_FOUND", `${method} ${url.pathname}`);
  };

  signed(event: unknown, url = `${BASE}/connect/square/webhook`) {
    const body = JSON.stringify(event);
    return { body, signature: createHmac("sha256", SIGNATURE_KEY).update(url + body).digest("base64") };
  }
}

function squareShop(extra: Record<string, unknown> = {}) {
  const square = new FakeSquare();
  const shop = setupShop({
    currency: "aud",
    payments: { test: true, card: undefined },
    connectors: [squareConnector({ accessToken: TOKEN, locationId: LOCATION, fetch: square.fetch, webhookSignatureKey: SIGNATURE_KEY })],
    connect: { apiKeys: ["platform-key"] },
    ...extra,
  });
  return { square, shop };
}

async function testOrder(shop: ReturnType<typeof setupShop>, items = [{ id: "VAR_FW_LRG", qty: 2 }]) {
  const res = await shop.post("/api/orders", { items, email: "robin@example.com", name: "Robin", rail: "test" });
  assert.equal(res.status, 201, await res.clone().text());
  return ((await res.json()) as { order: { id: string } }).order.id;
}

test("square: the venue's Square menu becomes the shop's menu", async () => {
  const { shop } = squareShop();
  await shop.collect.ready;
  const catalog = (await (await shop.call("/api/catalog")).json()) as { items: { id: string; name: string; priceCents: number }[] };
  assert.deepEqual(
    catalog.items.map((i) => [i.id, i.name, i.priceCents]),
    [
      ["VAR_FW_REG", "Flat white (Regular)", 520],
      ["VAR_FW_LRG", "Flat white (Large)", 620],
      ["VAR_CR", "Croissant", 600],
    ],
    "other currencies, deleted items, other locations and counter-priced items are left out",
  );
});

test("square: a test order shows in Square as a paid pickup order at $0, marked TEST, so it isn't a sale", async () => {
  const { square, shop } = squareShop();
  await shop.collect.ready;
  const orderId = await testOrder(shop, [{ id: "VAR_FW_LRG", qty: 2 }, { id: "VAR_CR", qty: 1 }]);
  await shop.collect.flushConnectors();

  const [sq] = [...square.orders.values()];
  assert.equal(sq.reference_id, orderId);
  assert.equal(sq.source?.name, "agentPickup");
  assert.equal(sq.ticket_name, "TEST · agentPickup");
  assert.deepEqual(
    sq.line_items.map((l) => [l.catalog_object_id, l.name, l.quantity, l.base_price_money?.amount]),
    [[undefined, "Flat white (Large)", "2", 0], [undefined, "Croissant", "1", 0]],
    "custom $0 lines, so the venue's sales, tax and stock counts don't move",
  );
  assert.equal(sq.total_money.amount, 0);
  assert.equal(sq.fulfillments[0].type, "PICKUP");
  assert.equal(sq.fulfillments[0].state, "PROPOSED");
  const order = (await shop.store.getOrder(orderId))!;
  assert.deepEqual((sq.fulfillments[0].pickup_details as { recipient: { display_name: string } }).recipient, { display_name: "Robin" });
  const note = String((sq.fulfillments[0].pickup_details as { note: string }).note);
  assert.match(note, /^TEST ORDER: no money moved\./);
  assert.match(note, new RegExp(order.pickupCode!));

  assert.equal(square.payments.length, 0, "no payment recorded");
  assert.equal(sq.paidWithoutPayment, true, "but paid, so it shows in Square POS as ready to make");
});

test("square: an agent's USDC payment is recorded in Square as crypto", async () => {
  const square = new FakeSquare();
  // An AUD shop needs a USD price for x402; the agent pays it.
  const usdShop = setupShop(
    { currency: "aud", connectors: [squareConnector({ accessToken: TOKEN, locationId: LOCATION, fetch: square.fetch })] },
    { toUsdCents: (c) => c * 0.65 },
  );
  await usdShop.collect.ready;
  const { orderId, paid } = await agentBuys(usdShop, makeAgent(), [{ id: "VAR_CR", qty: 1 }]);
  assert.equal(paid.status, 200);
  await usdShop.collect.flushConnectors();
  const [sq] = [...square.orders.values()];
  assert.deepEqual(sq.line_items.map((l) => [l.catalog_object_id, l.quantity]), [["VAR_CR", "1"]], "real orders use the venue's own menu items");
  assert.equal(sq.ticket_name, undefined);
  const pay = square.payments.at(-1) as { external_details: { type: string; source_id: string }; reference_id: string; amount_money: { amount: number } };
  assert.equal(pay.reference_id, orderId);
  assert.equal(pay.amount_money.amount, 600, "the full price, recorded as paid outside Square");
  assert.equal(pay.external_details.type, "CRYPTO");
  assert.match(pay.external_details.source_id, /^0x[0-9a-f]{64}$/, "the settlement transaction");
});

test("square: marking it ready in Square POS emails the customer", async () => {
  const { square, shop } = squareShop();
  await shop.collect.ready;
  const orderId = await testOrder(shop);
  await shop.collect.flushConnectors();
  const [sq] = [...square.orders.values()];

  const event = {
    type: "order.fulfillment.updated",
    data: {
      id: sq.id,
      object: { order_fulfillment_updated: { order_id: sq.id, location_id: LOCATION, fulfillment_update: [{ fulfillment_uid: "F1", old_state: "RESERVED", new_state: "PREPARED" }] } },
    },
  };
  const forged = await shop.call("/connect/square/webhook", { method: "POST", headers: { "x-square-hmacsha256-signature": "bm9wZQ==" }, body: JSON.stringify(event) });
  assert.equal(forged.status, 401);
  assert.equal((await shop.store.getOrder(orderId))!.status, "paid");

  const { body, signature } = square.signed(event);
  const ok = await shop.call("/connect/square/webhook", { method: "POST", headers: { "x-square-hmacsha256-signature": signature }, body });
  assert.equal(ok.status, 200);
  assert.equal((await shop.store.getOrder(orderId))!.status, "ready");
  assert.match((await shop.store.getLatestEmail(orderId))!.subject, /ready/i);

  // Square sends the same event again: nothing changes, nothing breaks.
  const again = await shop.call("/connect/square/webhook", { method: "POST", headers: { "x-square-hmacsha256-signature": signature }, body });
  assert.equal(again.status, 200);
});

test("square: scanning the QR completes the order in Square, stepping through its states", async () => {
  const { square, shop } = squareShop();
  await shop.collect.ready;
  const orderId = await testOrder(shop);
  await shop.collect.flushConnectors();
  const order = (await shop.store.getOrder(orderId))!;
  const result = await shop.collect.collect(shop.collect.collectLink(order));
  assert.equal(result.ok, true);
  await shop.collect.flushConnectors();
  const [sq] = [...square.orders.values()];
  assert.equal(sq.fulfillments[0].state, "COMPLETED");
  assert.equal(sq.state, "COMPLETED");
});

test("square: marking ready in agentPickup moves Square to prepared, and a no-show is cancelled there", async () => {
  const { square, shop } = squareShop();
  await shop.collect.ready;
  const readyId = await testOrder(shop);
  const goneId = await testOrder(shop, [{ id: "VAR_CR", qty: 1 }]);
  await shop.collect.flushConnectors();
  await shop.collect.markReady(readyId);
  await shop.store.updateOrder(goneId, { collectBy: Date.now() - 1 });
  await shop.collect.sweep();
  await shop.collect.flushConnectors();
  const byRef = (id: string) => [...square.orders.values()].find((o) => o.reference_id === id)!;
  assert.equal(byRef(readyId).fulfillments[0].state, "PREPARED");
  assert.equal(byRef(readyId).state, "OPEN");
  assert.equal(byRef(goneId).fulfillments[0].state, "CANCELED");
  assert.equal(byRef(goneId).state, "COMPLETED", "closed, since Square won't cancel a paid order");
  assert.equal(square.refunds.length, 0, "a test payment took no money, so there's nothing to refund");
});

test("square: a USDC no-show paid back by agentPickup shows as refunded in Square", async () => {
  const square = new FakeSquare();
  const shop = setupShop(
    { currency: "aud", connectors: [squareConnector({ accessToken: TOKEN, locationId: LOCATION, fetch: square.fetch })] },
    { toUsdCents: (c) => c * 0.65, refunds: { privateKey: generatePrivateKey() } },
  );
  await shop.collect.ready;
  const { orderId } = await agentBuys(shop, makeAgent(), [{ id: "VAR_FW_REG", qty: 1 }]);
  await shop.collect.flushConnectors();
  await shop.store.updateOrder(orderId, { collectBy: Date.now() - 1 });
  await shop.collect.sweep();
  await shop.collect.flushConnectors();
  const [sq] = [...square.orders.values()];
  assert.equal(sq.fulfillments[0].state, "CANCELED");
  assert.equal(sq.state, "COMPLETED");
  assert.equal(square.refunds.length, 1, "recorded once, when the USDC refund settled");
  assert.deepEqual((square.refunds[0] as { amount_money: unknown }).amount_money, { amount: 520, currency: "AUD" });
});

test("square: when Square is down, the customer is unaffected and the order still reaches Square once", async () => {
  const { square, shop } = squareShop();
  await shop.collect.ready;
  square.failNext = 1;
  const orderId = await testOrder(shop);
  assert.equal((await shop.store.getOrder(orderId))!.status, "paid", "paid before Square answered");
  await shop.collect.flushConnectors();
  assert.equal(square.orders.size, 1);
  assert.equal([...square.orders.values()][0].paidWithoutPayment, true);
});

test("connector API: a platform pushes the menu, reads paid orders and marks them ready", async () => {
  const { shop } = squareShop({ connectors: [] });
  const auth = { Authorization: "Bearer platform-key" };
  assert.equal((await shop.call("/connect/v1/orders")).status, 401);

  const bad = await shop.call("/connect/v1/catalog", { method: "PUT", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ items: [{ id: "x", name: "", priceCents: 1 }] }) });
  assert.equal(bad.status, 400);
  const put = await shop.call("/connect/v1/catalog", {
    method: "PUT",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ items: [{ id: "pos-123", name: "Long black", priceCents: 450 }] }),
  });
  assert.equal(put.status, 200);
  const menu = (await (await shop.call("/api/catalog")).json()) as { items: { id: string }[] };
  assert.deepEqual(menu.items.map((i) => i.id), ["pos-123"]);

  const orderId = await testOrder(shop, [{ id: "pos-123", qty: 1 }]);
  const list = (await (await shop.call("/connect/v1/orders?status=paid", { headers: auth })).json()) as { orders: Record<string, unknown>[] };
  assert.equal(list.orders.length, 1);
  assert.equal(list.orders[0].id, orderId);
  assert.match(String(list.orders[0].pickupCode), /^[2-9A-HJKMNP-Z]{6}$/);
  assert.equal(list.orders[0].customerEmail, undefined, "platforms get no email address");

  const ready = await shop.call(`/connect/v1/orders/${orderId}/ready`, { method: "POST", headers: auth });
  assert.equal(ready.status, 200);
  assert.equal((await shop.store.getOrder(orderId))!.status, "ready");

  const revert = await shop.call("/connect/v1/catalog", { method: "DELETE", headers: auth });
  assert.equal(revert.status, 200);
  const original = (await (await shop.call("/api/catalog")).json()) as { items: { id: string }[] };
  assert.deepEqual(original.items.map((i) => i.id), ["flat-white", "croissant"]);
});

test("connector API: a pushed menu survives a restart", async () => {
  const store: Store = testStore();
  const make = () =>
    createCollect({
      baseUrl: BASE,
      merchant: { name: "Test Café", fromEmail: "orders@shop.test" },
      catalog: [{ id: "config-item", name: "From config", priceCents: 100 }],
      store,
      mailer: outboxMailer(),
      signingKeyPem: generateSigningKeyPem(),
      payments: { test: true },
      connect: { apiKeys: ["k"] },
    });
  const first = make();
  await first.app.request(`${BASE}/connect/v1/catalog`, {
    method: "PUT",
    headers: { Authorization: "Bearer k", "Content-Type": "application/json" },
    body: JSON.stringify({ items: [{ id: "pos-1", name: "From the POS", priceCents: 500 }] }),
  });
  first.stop();
  const second = make();
  await second.ready;
  const menu = (await (await second.app.request(`${BASE}/api/catalog`)).json()) as { items: { id: string }[] };
  assert.deepEqual(menu.items.map((i) => i.id), ["pos-1"]);
  second.stop();
});

test("square: the venue's logo, address, hours, contact details and map position come from its Square location", async () => {
  const { square, shop } = squareShop();
  await shop.collect.ready;
  const { merchant } = (await (await shop.call("/api/catalog")).json()) as {
    merchant: { name: string; logoUrl?: string; location: Record<string, unknown> };
  };
  assert.equal(merchant.name, "Test Café", "the shop's own name stays");
  assert.equal(merchant.logoUrl, "https://images.square.test/logo-wide.png", "the wide logo suits the email header");
  assert.deepEqual(merchant.location, {
    name: "Front counter",
    address: "12 Crown St, Surry Hills NSW 2010",
    hours: "Mon-Fri 7am-3pm, Sat 8am-1:30pm",
    openingHours: [
      ...[1, 2, 3, 4, 5].map((day) => ({ day, open: "07:00", close: "15:00" })),
      { day: 6, open: "08:00", close: "13:30" },
    ],
    lat: -33.8836,
    lng: 151.2149,
  });
  const listing = await shop.collect.listing();
  assert.equal(listing.timeZone, "Australia/Sydney");
  assert.equal(square.calls.filter((c) => c === `GET /v2/locations/${LOCATION}`).length, 1);

  // Emails use it: replies go to Square's business email, and the address is in the receipt.
  const orderId = await testOrder(shop);
  const email = (await shop.store.getLatestEmail(orderId))!;
  assert.match(email.html, /12 Crown St, Surry Hills NSW 2010/);
  assert.match(email.html, /mailto:hello@cornercafe\.test/);
  assert.match(email.html, /<img src="https:\/\/images\.square\.test\/logo-wide\.png"/);
});

test("square: the brand colour comes from the seller's Square checkout, unless it's still Square's blue or the shop set its own", async () => {
  const colourOf = async (checkoutColour: string, own?: string) => {
    const square = new FakeSquare();
    square.checkoutColour = checkoutColour;
    const shop = setupShop({
      currency: "aud",
      payments: { test: true, card: undefined },
      ...(own ? { merchant: { name: "Test Café", fromEmail: "orders@shop.test", brandColor: own } } : {}),
      connectors: [squareConnector({ accessToken: TOKEN, locationId: LOCATION, fetch: square.fetch })],
    });
    await shop.collect.ready;
    const { merchant } = (await (await shop.call("/api/catalog")).json()) as { merchant: { brandColor?: string } };
    shop.collect.stop();
    return merchant.brandColor ?? null;
  };
  assert.equal(await colourOf("#006AFF"), null, "Square's default blue isn't the seller's colour");
  assert.equal(await colourOf("#9A3412"), "#9a3412");
  assert.equal(await colourOf("#9A3412", "#14532d"), "#14532d", "a colour the shop set wins");
});

test("square: the shop's own settings win over Square's, and the synced profile survives a restart", async () => {
  const square = new FakeSquare();
  const store = testStore();
  const own = {
    name: "My Café",
    fromEmail: "orders@shop.test",
    supportEmail: "me@mycafe.test",
    location: { name: "Side window", hours: "Whenever we feel like it" },
  };
  const first = createCollect({
    baseUrl: BASE,
    merchant: own,
    catalog: [],
    currency: "aud",
    store,
    mailer: outboxMailer(),
    signingKeyPem: generateSigningKeyPem(),
    payments: { test: true },
    connectors: [squareConnector({ accessToken: TOKEN, locationId: LOCATION, fetch: square.fetch })],
  });
  await first.ready;
  const read = async (shop: ReturnType<typeof createCollect>) =>
    ((await (await shop.app.request(`${BASE}/api/catalog`)).json()) as { merchant: { location: { name: string; hours?: string; address?: string } } }).merchant;
  const synced = await read(first);
  assert.equal(synced.location.name, "Side window");
  assert.equal(synced.location.hours, "Whenever we feel like it");
  assert.equal(synced.location.address, "12 Crown St, Surry Hills NSW 2010", "Square fills what the shop left out");
  first.stop();

  // Square is down after a restart: the saved profile still shows.
  square.failNext = 100;
  const second = createCollect({
    baseUrl: BASE,
    merchant: own,
    catalog: [],
    currency: "aud",
    store,
    mailer: outboxMailer(),
    signingKeyPem: generateSigningKeyPem(),
    payments: { test: true },
    connectors: [squareConnector({ accessToken: TOKEN, locationId: LOCATION, fetch: square.fetch })],
  });
  await second.ready;
  assert.equal((await read(second)).location.address, "12 Crown St, Surry Hills NSW 2010");
  second.stop();
});

test("square: with a webhook, staff marking it ready in Square sends the QR after the receipt", async () => {
  const { square, shop } = squareShop({ qrEmail: "when-ready" });
  await shop.collect.ready;
  const orderId = await testOrder(shop);
  await shop.collect.flushConnectors();
  assert.match((await shop.store.getLatestEmail(orderId))!.subject, /^Receipt: /);
  const [sq] = [...square.orders.values()];
  const { body, signature } = square.signed({
    type: "order.fulfillment.updated",
    data: { object: { order_fulfillment_updated: { order_id: sq.id, location_id: LOCATION, fulfillment_update: [{ new_state: "PREPARED" }] } } },
  });
  const res = await shop.call("/connect/square/webhook", { method: "POST", headers: { "x-square-hmacsha256-signature": signature }, body });
  assert.equal(res.status, 200);
  const ready = (await shop.store.getLatestEmail(orderId))!;
  assert.match(ready.subject, /^Ready to collect: /);
  assert.match(ready.html, /alt="Pickup QR code"/);
});

test("square: a group order reaches Square once, as one pickup order with each line marked for whom", async () => {
  const { square, shop } = squareShop();
  await shop.collect.ready;
  const started = (await (await shop.post("/api/groups", { name: "Robin", email: "robin@example.com", title: "Coffee run" })).json()) as {
    group: { code: string };
    organiserKey: string;
  };
  for (const [name, id] of [["Sam", "VAR_FW_REG"], ["Alex", "VAR_CR"]]) {
    const res = await shop.post(`/api/groups/${started.group.code}/orders`, { items: [{ id, qty: 1 }], email: `${name}@example.com`, name, rail: "test" });
    assert.equal(res.status, 201, await res.clone().text());
  }
  await shop.collect.flushConnectors();
  assert.equal(square.orders.size, 0, "shares don't reach Square on their own");
  await shop.post(`/api/groups/${started.group.code}/close`, { organiserKey: started.organiserKey });
  await shop.collect.flushConnectors();
  assert.equal(square.orders.size, 1);
  const [sq] = [...square.orders.values()];
  assert.deepEqual(
    sq.line_items.map((l) => [l.name, (l as { note?: string }).note, l.base_price_money?.amount]),
    [
      ["Flat white (Regular)", "for Sam", 0],
      ["Croissant", "for Alex", 0],
    ],
  );
  assert.equal((sq.fulfillments[0].pickup_details as { recipient: { display_name: string } }).recipient.display_name, "Coffee run (Robin)");
  assert.equal(sq.ticket_name, "TEST · agentPickup", "every share was a test payment, so the group's order is a test too");
  assert.equal(square.payments.length, 0);
});
