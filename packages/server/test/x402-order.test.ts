import { test } from "node:test";
import assert from "node:assert/strict";
import { makeAgent, setupShop } from "./helpers.js";

const required = (res: Response) => JSON.parse(Buffer.from(res.headers.get("PAYMENT-REQUIRED")!, "base64").toString("utf8"));

/** An agent pays a request to the fixed order address, as any x402 client would. */
async function pay(shop: ReturnType<typeof setupShop>, path: string, init: RequestInit = {}) {
  const agent = makeAgent();
  const challenge = await shop.call(path, init);
  assert.equal(challenge.status, 402, await challenge.clone().text());
  const req = agent.http.getPaymentRequiredResponse((n) => challenge.headers.get(n), await challenge.clone().json().catch(() => undefined));
  const payload = await agent.http.createPaymentPayload(req);
  const headers = { ...(init.headers as Record<string, string> | undefined), ...agent.http.encodePaymentSignatureHeader(payload) };
  return { paid: await shop.call(path, { ...init, headers }), headers, agent };
}

test("x402 order address: an unpaid GET gets a priced 402 with the shop's catalogue listing", async () => {
  const shop = setupShop();
  const res = await shop.call("/api/x402/order?items=flat-white:2,croissant:1");
  assert.equal(res.status, 402);
  const r = required(res);
  assert.equal(r.accepts[0].amount, String((2 * 450 + 500) * 10_000), "priced from the items, in USDC units");
  assert.match(r.resource.description, /^Test Café: order ahead and collect in person at Front counter\. Paid in USDC on a test network/);
  assert.equal(r.resource.serviceName, "Test Café");
  assert.deepEqual(r.resource.tags, ["pickup", "click-and-collect", "agentpickup"]);
  assert.ok(r.extensions.bazaar, "carries the bazaar declaration catalogues index");
  assert.match(JSON.stringify(r.extensions.bazaar.info.input), /"items":"flat-white:1"/, "with an example input agents can copy");

  const bare = await shop.call("/api/x402/order");
  assert.equal(bare.status, 402, "a catalogue's read-only check gets a 402 too");
  assert.equal(required(bare).accepts[0].amount, String(450 * 10_000), "for one of the first menu item");
  const bad = await shop.call("/api/x402/order?items=caviar:1");
  assert.equal(bad.status, 400);
  assert.match(((await bad.json()) as { error: string }).error, /Unknown item caviar/);
  shop.collect.stop();
});

test("x402 order address: paying a GET makes the order and hands back the pass; a replayed payment makes no second order", async () => {
  const shop = setupShop();
  const { paid, headers } = await pay(shop, "/api/x402/order?items=flat-white:2&name=Sam");
  assert.equal(paid.status, 200, await paid.clone().text());
  const body = (await paid.json()) as { order: { id: string; status: string; items: { id: string; qty: number }[] }; passUrl: string; emailedTo: string | null };
  assert.equal(body.order.status, "paid");
  assert.deepEqual(body.order.items.map((i) => [i.id, i.qty]), [["flat-white", 2]]);
  assert.match(body.passUrl, /^https:\/\/shop\.test\/p\//);
  assert.equal(body.emailedTo, null, "no email needed: the agent has the pass");
  const saved = (await shop.store.getOrder(body.order.id))!;
  assert.equal(saved.customerName, "Sam");
  assert.equal(saved.rail, "x402");
  assert.equal(shop.facilitator.settled.length, 1);

  const again = await shop.call("/api/x402/order?items=flat-white:2&name=Sam", { headers });
  assert.notEqual(again.status, 200, "the same signed payment can't buy twice");
  const paidOrders = (await shop.store.listOrders({ statuses: ["paid"], limit: 10 })).filter((o) => o.rail === "x402");
  assert.equal(paidOrders.length, 1);
  shop.collect.stop();
});

test("x402 order address: a POST with an email gets the pass in the reply and the QR by email", async () => {
  const shop = setupShop();
  const init = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items: [{ id: "croissant", qty: 3 }], email: "robin@example.com", name: "Robin" }),
  };
  const { paid } = await pay(shop, "/api/x402/order", init);
  assert.equal(paid.status, 200, await paid.clone().text());
  const body = (await paid.json()) as { order: { id: string; totalCents: number }; emailedTo: string };
  assert.equal(body.order.totalCents, 1500);
  assert.equal(body.emailedTo, "robin@example.com");
  const email = (await shop.store.getLatestEmail(body.order.id))!;
  assert.match(email.subject, /show this QR to collect/);
  const badEmail = await shop.call("/api/x402/order", { ...init, body: JSON.stringify({ items: [{ id: "croissant", qty: 1 }], email: "nope" }) });
  assert.equal(badEmail.status, 400);
  shop.collect.stop();
});
