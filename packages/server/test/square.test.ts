import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { generateSigningKeyPem } from "@agentpickup/core";
import { createCollect, outboxMailer, squareConnector, type Store } from "../src/index.js";
import { agentBuys, makeAgent, setupShop, testStore } from "./helpers.js";

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
  line_items: { catalog_object_id?: string; name?: string; quantity: string; base_price_money?: { amount: number } }[];
  fulfillments: Fulfillment[];
  total_money: { amount: number; currency: string };
};

const STEPS = ["PROPOSED", "RESERVED", "PREPARED", "COMPLETED"];

/** Enough of Square's API to test against: auth, versions, idempotency, one-step pickup states, external payments. */
class FakeSquare {
  orders = new Map<string, SqOrder>();
  payments: Record<string, unknown>[] = [];
  calls: string[] = [];
  failNext = 0;
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
    const m = url.pathname.match(/^\/v2\/orders\/([^/]+)$/);
    if (m && method === "GET") {
      const order = this.orders.get(m[1]);
      return order ? reply(200, { order }) : error(404, "NOT_FOUND", "order");
    }
    if (m && method === "PUT") {
      const order = this.orders.get(m[1]);
      if (!order) return error(404, "NOT_FOUND", "order");
      if (body.order.version !== order.version) return error(400, "VERSION_MISMATCH", "stale version");
      for (const change of body.order.fulfillments ?? []) {
        const f = order.fulfillments.find((x) => x.uid === change.uid);
        if (!f) return error(400, "NOT_FOUND", "fulfillment");
        const ok = change.state === "CANCELED" ? f.state !== "COMPLETED" : STEPS.indexOf(change.state) === STEPS.indexOf(f.state) + 1;
        if (!ok) return error(400, "INVALID_STATE_TRANSITION", `${f.state} to ${change.state}`);
        f.state = change.state;
      }
      order.version++;
      if (order.fulfillments.every((f) => f.state === "COMPLETED")) order.state = "COMPLETED";
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

test("square: a paid order shows in Square as a paid pickup order", async () => {
  const { square, shop } = squareShop();
  await shop.collect.ready;
  const orderId = await testOrder(shop, [{ id: "VAR_FW_LRG", qty: 2 }, { id: "VAR_CR", qty: 1 }]);
  await shop.collect.flushConnectors();

  const [sq] = [...square.orders.values()];
  assert.equal(sq.reference_id, orderId);
  assert.equal(sq.source?.name, "agentPickup");
  assert.deepEqual(sq.line_items.map((l) => [l.catalog_object_id, l.quantity]), [["VAR_FW_LRG", "2"], ["VAR_CR", "1"]]);
  assert.equal(sq.fulfillments[0].type, "PICKUP");
  assert.equal(sq.fulfillments[0].state, "PROPOSED");
  const order = (await shop.store.getOrder(orderId))!;
  assert.deepEqual((sq.fulfillments[0].pickup_details as { recipient: { display_name: string } }).recipient, { display_name: "Robin" });
  assert.match(String((sq.fulfillments[0].pickup_details as { note: string }).note), new RegExp(order.pickupCode!));

  assert.equal(square.payments.length, 1);
  const pay = square.payments[0] as { source_id: string; amount_money: { amount: number }; external_details: { type: string; source: string } };
  assert.equal(pay.source_id, "EXTERNAL");
  assert.equal(pay.amount_money.amount, 1840);
  assert.deepEqual([pay.external_details.type, pay.external_details.source], ["OTHER", "agentPickup"]);
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
  const pay = square.payments.at(-1) as { external_details: { type: string; source_id: string }; reference_id: string };
  assert.equal(pay.reference_id, orderId);
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
  assert.equal(byRef(goneId).fulfillments[0].state, "CANCELED");
});

test("square: when Square is down, the customer is unaffected and the order still reaches Square once", async () => {
  const { square, shop } = squareShop();
  await shop.collect.ready;
  square.failNext = 1;
  const orderId = await testOrder(shop);
  assert.equal((await shop.store.getOrder(orderId))!.status, "paid", "paid before Square answered");
  await shop.collect.flushConnectors();
  assert.equal(square.orders.size, 1);
  assert.equal(square.payments.length, 1);
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
