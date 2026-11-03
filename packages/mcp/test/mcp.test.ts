import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { setupShop, NETWORK } from "../../server/test/helpers.js";
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
  assert.deepEqual(tools.map((t) => t.name).sort(), ["create_pickup_order", "get_pickup_pass", "get_shop", "order_status", "pay_order"]);
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
  assert.equal(shop.store.getOrder(orderId)!.payer?.toLowerCase(), privateKeyToAccount(key).address.toLowerCase());

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
  const same = await local.call("get_shop", { shop_url: "https://shop.test/anything" });
  assert.equal(same.isError, false);
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
  assert.equal(tools.result.tools.length, 5);
});
