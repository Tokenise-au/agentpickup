import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createVenueHost, outboxMailer } from "../../server/src/index.js";
import { setupShop, NETWORK, testStore } from "../../server/test/helpers.js";
import { createMcpHandler, createPickupMcpServer, walletPayer, type PickupMcpOptions } from "../src/index.js";

async function connect(opts: Partial<PickupMcpOptions> = {}) {
  const shop = setupShop();
  const server = createPickupMcpServer({ shopUrl: "https://shop.test", fetch: (req) => shop.collect.app.fetch(req), ...opts });
  const client = new Client({ name: "test", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    const text = res.content[0].text;
    const json = text.includes("\n\n") ? JSON.parse(text.slice(text.indexOf("\n\n") + 2)) : null;
    return { text, json, isError: Boolean(res.isError) };
  };
  return { shop, client, call };
}

test("lists the pickup tools and reads the shop", async () => {
  const { client, call } = await connect();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    "close_group_order",
    "create_pickup_order",
    "get_pickup_pass",
    "get_shop",
    "group_order_status",
    "join_group_order",
    "order_status",
    "pay_order",
    "start_group_order",
  ]);
  assert.equal(tools.find((t) => t.name === "get_shop")!.annotations?.readOnlyHint, true);

  const shop = await call("get_shop");
  assert.equal(shop.isError, false);
  assert.match(shop.text, /^Test Café, collect at Front counter\. Takes USDC over x402/);
  assert.deepEqual(shop.json.items.map((i: { id: string }) => i.id), ["flat-white", "croissant"]);
  assert.equal(shop.json.items[0].price, "$4.50");
});

test("an agent with a wallet orders, pays, and gets the pass back with Sign-In-With-X", async () => {
  const key = generatePrivateKey();
  const { shop, call } = await connect({ payer: walletPayer({ privateKey: key, maxPerOrder: "$20", networks: [NETWORK] }) });

  const created = await call("create_pickup_order", { items: [{ id: "flat-white", qty: 2 }], email: "robin@example.com" });
  assert.equal(created.isError, false, created.text);
  assert.equal(created.json.total, "$9.00");
  const orderId = created.json.orderId;

  const paid = await call("pay_order", { order_id: orderId });
  assert.equal(paid.isError, false, paid.text);
  assert.equal(paid.json.amount, "9.00");
  assert.match(paid.json.passUrl, /^https:\/\/shop\.test\/p\//);
  assert.match(paid.json.explorer, /^https:\/\/sepolia\.basescan\.org\/tx\/0x/);
  assert.equal(shop.facilitator.settled.length, 1);
  assert.equal((await shop.store.getOrder(orderId))!.payer?.toLowerCase(), privateKeyToAccount(key).address.toLowerCase());

  const again = await call("pay_order", { order_id: orderId });
  assert.equal(again.isError, true, "a paid order isn't paid twice");
  assert.equal(shop.facilitator.settled.length, 1);

  const status = await call("order_status", { order_id: orderId });
  assert.match(status.text, /is paid and being prepared/);

  const pass = await call("get_pickup_pass", { order_id: orderId });
  assert.equal(pass.isError, false, pass.text);
  assert.match(pass.json.pickupCode, /^[2-9A-HJKMNP-Z]{6}$/);
  assert.equal(pass.json.passUrl, paid.json.passUrl);
});

test("the wallet's spend cap holds", async () => {
  const { shop, call } = await connect({ payer: walletPayer({ privateKey: generatePrivateKey(), maxPerOrder: "$5", networks: [NETWORK] }) });
  const created = await call("create_pickup_order", { items: [{ id: "croissant", qty: 3 }], email: "robin@example.com" });
  const paid = await call("pay_order", { order_id: created.json.orderId });
  assert.equal(paid.isError, true);
  assert.match(paid.text, /won't pay/);
  assert.equal(shop.facilitator.settled.length, 0);
});

test("without a wallet, pay_order hands back the price and pay link", async () => {
  const { call } = await connect();
  const created = await call("create_pickup_order", { items: [{ id: "flat-white", qty: 1 }], email: "robin@example.com" });
  const quote = await call("pay_order", { order_id: created.json.orderId });
  assert.equal(quote.isError, false, quote.text);
  assert.equal(quote.json.amount, "4.50");
  assert.equal(quote.json.network, NETWORK);
  assert.equal(quote.json.payUrl, `https://shop.test/api/orders/${created.json.orderId}/pay`);

  const pass = await call("get_pickup_pass", { order_id: created.json.orderId });
  assert.equal(pass.isError, true);
});

test("a hosted server stays on its own shop; a local one can be pointed elsewhere", async () => {
  const hosted = await connect();
  const { tools } = await hosted.client.listTools();
  assert.equal((tools[0].inputSchema.properties as Record<string, unknown>).shop_url, undefined);
  const elsewhere = await hosted.call("get_shop", { shop_url: "https://evil.test" });
  assert.equal(elsewhere.json.shop, "https://shop.test", "unknown arguments are ignored, so it still reads its own shop");

  const local = await connect({ allowOtherShops: true });
  const other = await local.call("get_shop", { shop_url: "http://other.test" });
  assert.equal(other.isError, true);
  assert.match(other.text, /https/);
  const pasted = await local.call("get_shop", { shop_url: "https://shop.test/api/catalog" });
  assert.equal(pasted.isError, false, "a pasted API link finds its shop");
  assert.equal(pasted.json.shop, "https://shop.test");
});

test("find_shops searches the directory, and the other tools order from a venue it found", async () => {
  const home = setupShop();
  const host = createVenueHost({
    baseUrl: "https://shop.test",
    store: testStore(),
    storeFor: () => testStore(),
    mailer: outboxMailer(),
    secretKey: "x".repeat(40),
    adminKeys: ["k"],
    alsoList: [home.collect],
  });
  await host.app.request("https://shop.test/host/v1/venues/corner", {
    method: "PUT",
    headers: { Authorization: "Bearer k", "Content-Type": "application/json" },
    body: JSON.stringify({
      merchant: { name: "Corner Café", fromEmail: "o@shop.test", location: { name: "Counter", address: "12 Crown St, Surry Hills", lat: -33.8836, lng: 151.2149 } },
      catalog: [{ id: "fw", name: "Flat white", priceCents: 520 }, { id: "sd", name: "Sourdough", priceCents: 900 }],
      currency: "aud",
      payments: { test: true },
    }),
  });
  // As agentpickup.app routes it: venues and the directory to the venue host, everything else to the home shop.
  const fetch = (req: Request) => (/^\/(v|directory)\//.test(new URL(req.url).pathname) ? host.app.fetch(req) : home.collect.app.fetch(req));
  const server = createPickupMcpServer({ shopUrl: "https://shop.test", fetch, directoryUrl: "https://shop.test/directory/v1/shops" });
  const client = new Client({ name: "test", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    const text = res.content[0].text;
    return { text, json: text.includes("\n\n{") ? JSON.parse(text.slice(text.indexOf("\n\n{") + 2)) : null, isError: Boolean(res.isError) };
  };

  const { tools } = await client.listTools();
  assert.ok(tools.some((t) => t.name === "find_shops"));
  assert.ok((tools.find((t) => t.name === "get_shop")!.inputSchema.properties as Record<string, unknown>).shop_url, "shop_url is offered");

  const found = await call("find_shops", { lat: -33.884, lng: 151.21, query: "flat white" });
  assert.equal(found.isError, false, found.text);
  assert.match(found.text, /^1 shop:\n- Corner Café \(0\.5 km, test shop, no real money\), 12 Crown St, Surry Hills: Flat white A\$5\.20/);
  const [corner] = found.json.shops;
  assert.equal(corner.shop_url, "https://shop.test/v/corner");
  assert.deepEqual(corner.items, [{ id: "fw", name: "Flat white", price: "A$5.20" }]);
  assert.equal(corner.moreItems, 1);

  const everywhere = await call("find_shops", {});
  assert.deepEqual(everywhere.json.shops.map((s: { name: string }) => s.name).sort(), ["Corner Café", "Test Café"]);
  assert.match((await call("find_shops", { query: "caviar" })).text, /^No agentPickup shops match/);
  assert.equal((await call("find_shops", { lat: 1 })).isError, true);

  const menu = await call("get_shop", { shop_url: corner.shop_url });
  assert.match(menu.text, /^Corner Café, collect at Counter\. A test shop/);

  const order = await call("create_pickup_order", { shop_url: corner.shop_url, items: [{ id: "fw", qty: 2 }], email: "robin@example.com" });
  assert.equal(order.isError, false, order.text);
  assert.equal(order.json.test, true);
  assert.equal(order.json.status, "paid");
  assert.match(order.json.passUrl, /^https:\/\/shop\.test\/v\/corner\/p\//);
  const status = await call("order_status", { order_id: order.json.orderId, shop_url: corner.shop_url });
  assert.match(status.text, /is paid and being prepared/);

  const elsewhere = await call("get_shop", { shop_url: "https://evil.test" });
  assert.equal(elsewhere.isError, true);
  assert.match(elsewhere.text, /shops on https:\/\/shop\.test only/);
  host.stop();
});

test("bad input comes back as a tool error the model can read", async () => {
  const { call } = await connect();
  const unknown = await call("create_pickup_order", { items: [{ id: "caviar", qty: 1 }], email: "robin@example.com" });
  assert.equal(unknown.isError, true);
  const missing = await call("order_status", { order_id: "ord_nope" });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /not found/i);
});

test("the Streamable HTTP handler answers initialize and tools/list", async () => {
  const shop = setupShop();
  const handle = createMcpHandler({ shopUrl: "https://shop.test", fetch: (req) => shop.collect.app.fetch(req) });
  const rpc = (body: unknown) =>
    handle(
      new Request("https://shop.test/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify(body),
      }),
    );
  const init = await rpc({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
  });
  assert.equal(init.status, 200);
  const info = (await init.json()) as { result: { serverInfo: { name: string }; instructions: string } };
  assert.equal(info.result.serverInfo.name, "agentpickup");
  assert.match(info.result.instructions, /pay_order/);

  const list = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const tools = (await list.json()) as { result: { tools: { name: string }[] } };
  assert.equal(tools.result.tools.length, 9);
});

test("group orders through the MCP: start, two agents join and pay, close, and the organiser's QR is on its way", async () => {
  const { shop, call } = await connect({ payer: walletPayer({ privateKey: generatePrivateKey(), maxPerOrder: "$20", networks: [NETWORK] }) });
  const started = await call("start_group_order", { organiser_name: "Robin", organiser_email: "robin@example.com", title: "Coffee run" });
  assert.equal(started.isError, false, started.text);
  const { code, organiser_key } = started.json;
  assert.match(started.text, new RegExp(`share code ${code}`));

  const sam = await call("join_group_order", { code, items: [{ id: "flat-white", qty: 1 }], email: "sam@example.com", name: "Sam" });
  assert.equal(sam.isError, false, sam.text);
  assert.match(sam.text, /pay it with pay_order/);
  const paid = await call("pay_order", { order_id: sam.json.orderId });
  assert.equal(paid.isError, false, paid.text);
  const alex = await call("join_group_order", { code, items: [{ id: "croissant", qty: 1 }], email: "alex@example.com", name: "Alex" });
  await call("pay_order", { order_id: alex.json.orderId });

  const status = await call("group_order_status", { code });
  assert.match(status.text, /Coffee run \(code [A-Z0-9]+\), closes in \d+ min: 2 of 2 paid, \$9\.50 so far\./);
  assert.equal((await call("close_group_order", { code, organiser_key: "wrong-key" })).isError, true);
  const closed = await call("close_group_order", { code, organiser_key });
  assert.match(closed.text, /^Closed: .* The shop has the combined order/);
  const combined = (await shop.store.listOrders({ statuses: ["paid"], limit: 10 })).find((o) => o.rail === "group")!;
  assert.deepEqual(combined.items.map((i) => i.note), ["for Sam", "for Alex"]);
});
