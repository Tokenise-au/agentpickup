import { test } from "node:test";
import assert from "node:assert/strict";
import type { Order } from "@agentpickup/core";
import type { OutgoingMail } from "../src/index.js";
import { makeAgent, setupShop } from "./helpers.js";

function recordingShop() {
  const sent: OutgoingMail[] = [];
  const shop = setupShop({ mailer: { delivers: true, send: async (m: OutgoingMail) => (sent.push(m), { id: String(sent.length) }) } });
  return { shop, sent };
}

async function start(shop: ReturnType<typeof setupShop>, minutes = 15) {
  const res = await shop.post("/api/groups", { name: "Robin", email: "robin@example.com", title: "Friday coffee run", closesInMinutes: minutes });
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json()) as { group: { code: string }; organiserKey: string };
}

async function join(shop: ReturnType<typeof setupShop>, code: string, name: string, rail: "test" | "x402", items = [{ id: "flat-white", qty: 1 }]) {
  const res = await shop.post(`/api/groups/${code}/orders`, { items, email: `${name.toLowerCase()}@example.com`, name, rail });
  return { res, body: (await res.json()) as { order: Order; next: { type: string; url?: string }; group: { members: unknown[] } } & { error?: string } };
}

/** An agent pays an order's x402 link, as the MCP's pay_order does. */
async function payLink(shop: ReturnType<typeof setupShop>, url: string) {
  const agent = makeAgent();
  const path = new URL(url).pathname;
  const challenge = await shop.call(path, { method: "POST" });
  if (challenge.status !== 402) return challenge;
  const required = agent.http.getPaymentRequiredResponse((n) => challenge.headers.get(n), await challenge.clone().json().catch(() => undefined));
  const payload = await agent.http.createPaymentPayload(required);
  return shop.call(path, { method: "POST", headers: agent.http.encodePaymentSignatureHeader(payload) });
}

const combinedOf = async (shop: ReturnType<typeof setupShop>) =>
  (await shop.store.listOrders({ statuses: ["paid", "ready", "collected", "expired"], limit: 50 })).find((o) => o.rail === "group");

test("group order: everyone's agent pays its own share, the shop gets one combined order, the organiser one QR", async () => {
  const { shop, sent } = recordingShop();
  const { group, organiserKey } = await start(shop);

  const sam = await join(shop, group.code, "Sam", "test");
  assert.equal(sam.res.status, 201, JSON.stringify(sam.body));
  assert.equal(sam.body.order.status, "paid");
  const alex = await join(shop, group.code, "Alex", "x402", [{ id: "croissant", qty: 2 }]);
  assert.equal(alex.body.order.status, "awaiting_payment");
  const paid = await payLink(shop, alex.body.next.url!);
  assert.equal(paid.status, 200, await paid.clone().text());
  const jo = await join(shop, group.code, "Jo", "x402");
  assert.equal(jo.body.order.status, "awaiting_payment", "Jo's agent never pays");

  const view = await (await shop.call(`/api/groups/${group.code}`)).text();
  assert.match(view, /"name":"Sam"/);
  assert.doesNotMatch(view, /@example\.com/, "anyone with the code sees names and items, never emails");

  // Shares get a receipt, not a QR, and reach no one's screens on their own.
  const samMail = sent.find((m) => m.to === "sam@example.com")!;
  assert.equal(samMail.subject, "Receipt: your part of Friday coffee run");
  assert.equal(samMail.attachments, undefined);
  assert.match(samMail.text!, /Your order is part of Friday coffee run\. Robin collects everything from Front counter\./);
  assert.deepEqual((await (await shop.call("/api/staff/orders")).json() as { orders: unknown[] }).orders, []);

  assert.equal((await shop.post(`/api/groups/${group.code}/close`, { organiserKey: "not-it" })).status, 403);
  const closed = (await (await shop.post(`/api/groups/${group.code}/close`, { organiserKey })).json()) as { group: { status: string } };
  assert.equal(closed.group.status, "sent");

  assert.equal((await shop.store.getOrder(jo.body.order.id))!.status, "cancelled", "the unpaid share is left out");
  assert.equal((await payLink(shop, jo.body.next.url!)).status, 409, "and can't be paid after the group closed");
  assert.equal((await join(shop, group.code, "Late", "test")).res.status, 409);

  const combined = (await combinedOf(shop))!;
  assert.deepEqual(
    combined.items.map((i) => [i.name, i.qty, i.note]),
    [
      ["Flat white", 1, "for Sam"],
      ["Croissant", 2, "for Alex"],
    ],
  );
  assert.equal(combined.totalCents, 450 + 2 * 500);
  assert.equal(combined.customerEmail, "robin@example.com");
  const robinMail = sent.find((m) => m.to === "robin@example.com")!;
  assert.match(robinMail.html, /cid:pickup-qr/, "the organiser gets the group's QR");
  assert.match(robinMail.text!, /1 x Flat white \(for Sam\)/);
  assert.match(robinMail.text!, /Each person paid their own share/);
  const staffSees = (await (await shop.call("/api/staff/orders")).json()) as { orders: { id: string }[] };
  assert.deepEqual(staffSees.orders.map((o) => o.id), [combined.id], "staff see the combined order only");

  // A share can't be collected on its own; the combined order hands over everyone's.
  const samOrder = (await shop.store.getOrder(sam.body.order.id))!;
  const samPage = await (await shop.call(`/p/${samOrder.passId}`)).text();
  assert.match(samPage, /Part of Friday coffee run/);
  assert.doesNotMatch(samPage, /alt="Pickup QR code"/);
  const refused = await shop.post("/api/staff/collect", { scan: samOrder.pickupCode });
  assert.equal(refused.status, 409);
  assert.match(((await refused.json()) as { title: string }).title, /Part of a group order/);
  const handed = await shop.collect.collect(shop.collect.collectLink(combined));
  assert.equal(handed.ok, true);
  for (const id of [sam.body.order.id, alex.body.order.id]) assert.equal((await shop.store.getOrder(id))!.status, "collected");
  const after = (await (await shop.call(`/api/groups/${group.code}`)).json()) as { group: { combined: { status: string } } };
  assert.equal(after.group.combined.status, "collected");
  shop.collect.stop();
});

test("group order: it closes by itself at its time, and with nobody paid it's cancelled", async () => {
  const { shop } = recordingShop();
  const backdate = async (code: string) => {
    const ref = (await shop.store.getDoc<{ id: string }>("group-code", code))!;
    const g = (await shop.store.getDoc<Record<string, unknown>>("group", ref.id))!;
    await shop.store.putDoc("group", ref.id, { ...g, closesAt: Date.now() - 1000 });
  };

  const empty = await start(shop);
  const unpaid = await join(shop, empty.group.code, "Jo", "x402");
  await backdate(empty.group.code);
  await shop.collect.sweep();
  const gone = (await (await shop.call(`/api/groups/${empty.group.code}`)).json()) as { group: { status: string } };
  assert.equal(gone.group.status, "cancelled");
  assert.equal((await shop.store.getOrder(unpaid.body.order.id))!.status, "cancelled");
  assert.equal(await combinedOf(shop), undefined);

  const run = await start(shop);
  await join(shop, run.group.code, "Sam", "test");
  await backdate(run.group.code);
  await shop.collect.sweep();
  const done = (await (await shop.call(`/api/groups/${run.group.code}`)).json()) as { group: { status: string; combined: { status: string } } };
  assert.deepEqual([done.group.status, done.group.combined.status], ["sent", "paid"]);
  shop.collect.stop();
});

test("group order: starting one needs the organiser's name and email, and a sensible closing time", async () => {
  const { shop } = recordingShop();
  assert.equal((await shop.post("/api/groups", { name: "Robin" })).status, 400);
  assert.equal((await shop.post("/api/groups", { email: "robin@example.com" })).status, 400);
  assert.equal((await shop.post("/api/groups", { name: "Robin", email: "robin@example.com", closesInMinutes: 1 })).status, 400);
  assert.equal((await shop.call("/api/groups/NOPE99")).status, 404);
  const { group } = await start(shop);
  const card = await shop.post(`/api/groups/${group.code}/orders`, { items: [{ id: "flat-white", qty: 1 }], email: "a@example.com", name: "A", rail: "card" });
  assert.equal(card.status, 400, "shares are paid by agent");
  shop.collect.stop();
});
