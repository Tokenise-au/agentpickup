import { test } from "node:test";
import assert from "node:assert/strict";
import { agentBuys, makeAgent, PAY_TO, setupShop } from "./helpers.js";

test("an agent pays over x402 and the pickup pass is issued", async () => {
  const shop = setupShop();
  const agent = makeAgent();
  const { orderId, challenge, required, paid } = await agentBuys(shop, agent, [{ id: "flat-white", qty: 2 }]);

  assert.equal(challenge.status, 402);
  const accept = required.accepts[0];
  assert.equal(accept.amount, "9000000", "$9.00 in USDC's six decimals, priced from the catalog");
  assert.equal(accept.payTo.toLowerCase(), PAY_TO);

  assert.equal(paid.status, 200);
  const body = (await paid.json()) as { order: { status: string }; passUrl: string; emailedTo: string };
  assert.equal(body.order.status, "paid");
  assert.match(body.passUrl, /^https:\/\/shop\.test\/p\//);
  assert.equal(body.emailedTo, "agent-owner@example.com");

  const order = (await shop.store.getOrder(orderId))!;
  assert.equal(order.status, "paid");
  assert.equal(order.payer?.toLowerCase(), agent.address.toLowerCase());
  assert.match(order.paymentRef!, /^0x[0-9a-f]{64}$/);
  assert.equal(shop.facilitator.settled.length, 1);
});

test("a paid order can't be paid again", async () => {
  const shop = setupShop();
  const agent = makeAgent();
  const { path, payload } = await agentBuys(shop, agent);
  const again = await shop.call(path, { method: "POST", headers: agent.http.encodePaymentSignatureHeader(payload) });
  assert.equal(again.status, 409);
  assert.equal(shop.facilitator.settled.length, 1);
});

test("a payment for the wrong amount is refused and nothing is issued", async () => {
  const shop = setupShop();
  const agent = makeAgent();
  const created = await shop.post("/api/orders", { items: [{ id: "croissant", qty: 3 }], email: "a@b.co", rail: "x402" });
  const { order, next } = (await created.json()) as { order: { id: string }; next: { url: string } };
  const path = new URL(next.url).pathname;
  const challenge = await shop.call(path, { method: "POST" });
  const required = agent.http.getPaymentRequiredResponse((n) => challenge.headers.get(n));
  // The agent tries to pay for one croissant instead of three.
  required.accepts[0] = { ...required.accepts[0], amount: "5000000" };
  const payload = await agent.http.createPaymentPayload(required);
  const res = await shop.call(path, { method: "POST", headers: agent.http.encodePaymentSignatureHeader(payload) });
  assert.notEqual(res.status, 200);
  assert.equal((await shop.store.getOrder(order.id))!.status, "awaiting_payment");
  assert.equal(shop.facilitator.settled.length, 0);
});

test("a failed settlement leaves the order unpaid", async () => {
  const shop = setupShop();
  shop.facilitator.failSettle = true;
  const { orderId, paid } = await agentBuys(shop, makeAgent());
  assert.notEqual(paid.status, 200);
  assert.equal((await shop.store.getOrder(orderId))!.status, "awaiting_payment");
});

test("the pay link only exists for x402 orders awaiting payment", async () => {
  const shop = setupShop();
  assert.equal((await shop.call("/api/orders/ord_nope/pay", { method: "POST" })).status, 404);
  const created = await shop.post("/api/orders", { items: [{ id: "croissant", qty: 1 }], email: "a@b.co", rail: "test" });
  const { order } = (await created.json()) as { order: { id: string } };
  assert.equal((await shop.call(`/api/orders/${order.id}/pay`, { method: "POST" })).status, 404);
});

test("an agent-paid order is collected with one scan", async () => {
  const shop = setupShop();
  const { orderId } = await agentBuys(shop, makeAgent());
  const scan = shop.collect.collectLink((await shop.store.getOrder(orderId))!);
  const res = await shop.post("/api/staff/collect", { scan });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { message: string };
  assert.match(body.message, /paid by agent/);
});
