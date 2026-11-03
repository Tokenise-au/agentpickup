import { test } from "node:test";
import assert from "node:assert/strict";
import type { OutgoingMail } from "../src/index.js";
import { agentBuys, makeAgent, setupShop } from "./helpers.js";

function recordingMailer() {
  const sent: OutgoingMail[] = [];
  return { sent, mailer: { delivers: true, send: async (m: OutgoingMail) => (sent.push(m), { id: String(sent.length) }) } };
}

async function testOrder(shop: ReturnType<typeof setupShop>) {
  const res = await shop.post("/api/orders", { items: [{ id: "flat-white", qty: 2 }], email: "robin@example.com", rail: "test" });
  assert.equal(res.status, 201, await res.clone().text());
  return ((await res.json()) as { order: { id: string } }).order.id;
}

test("receipt then QR: the first email is a receipt with no QR, and the QR comes when the order is ready", async () => {
  const { sent, mailer } = recordingMailer();
  const shop = setupShop({
    mailer,
    qrEmail: "when-ready",
    merchant: { name: "Test Café", fromEmail: "orders@shop.test", taxId: "ABN 51 824 753 556", location: { name: "Front counter" } },
  });
  const orderId = await testOrder(shop);
  const order = (await shop.store.getOrder(orderId))!;

  assert.equal(sent.length, 1);
  const [receipt] = sent;
  assert.equal(receipt.subject, "Receipt: your Test Café order");
  assert.equal(receipt.attachments, undefined, "no QR attached");
  assert.doesNotMatch(receipt.html, /cid:pickup-qr|Pickup code/);
  assert.doesNotMatch(receipt.text!, new RegExp(order.pickupCode!), "and no pickup code in it");
  assert.match(receipt.html, /We&#39;ll email your pickup QR when it&#39;s ready to collect from Front counter\./);
  assert.match(receipt.text!, /Paid with Test payment: no money moved/);
  assert.match(receipt.text!, new RegExp(`Order ${orderId}, `));
  assert.match(receipt.text!, /ABN 51 824 753 556/);
  assert.match(receipt.html, />Track my order</);

  // The pass page says it's being made, and still lets them collect.
  const page = await (await shop.call(new URL(shop.collect.passUrl(order)).pathname)).text();
  assert.match(page, /Being prepared/);
  assert.match(page, /alt="Pickup QR code"/);

  await shop.collect.markReady(orderId);
  assert.equal(sent.length, 2);
  const ready = sent[1];
  assert.equal(ready.subject, "Ready to collect: Test Café order");
  assert.match(ready.html, /src="cid:pickup-qr"/);
  assert.match(ready.text!, new RegExp(`Pickup code: ${order.pickupCode}`));
  assert.equal(ready.attachments?.[0].contentId, "pickup-qr");
  assert.doesNotMatch(ready.text!, /Paid with|ABN/, "the receipt details aren't repeated");
  shop.collect.stop();
});

test("receipt then QR: if nobody marks the order ready, the QR goes out anyway, once", async () => {
  const { sent, mailer } = recordingMailer();
  const shop = setupShop({ mailer, qrEmail: "when-ready", qrFallbackMinutes: 15 });
  const orderId = await testOrder(shop);
  await shop.collect.sweep();
  assert.equal(sent.length, 1, "too early: just the receipt");

  await shop.store.updateOrder(orderId, { paidAt: Date.now() - 16 * 60_000 });
  await shop.collect.sweep();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].subject, "Your Test Café pickup QR");
  assert.match(sent[1].html, /src="cid:pickup-qr"/);
  await shop.collect.sweep();
  assert.equal(sent.length, 2, "not sent twice");

  // Marked ready later still says so, with the QR.
  await shop.collect.markReady(orderId);
  assert.equal(sent[2].subject, "Ready to collect: Test Café order");
  const kinds = (await shop.store.listEvents(orderId)).filter((e) => e.type === "pass.emailed").map((e) => e.data?.kind);
  assert.deepEqual(kinds, ["receipt", "qr", "ready"]);
  shop.collect.stop();
});

test("by default the first email is the receipt with the QR in it", async () => {
  const { sent, mailer } = recordingMailer();
  const shop = setupShop({ mailer });
  const orderId = await testOrder(shop);
  const [first] = sent;
  assert.equal(first.subject, "Your Test Café order: show this QR to collect");
  assert.match(first.html, /src="cid:pickup-qr"/);
  assert.match(first.text!, /Paid with Test payment: no money moved/);
  assert.match(first.text!, new RegExp(`Order ${orderId}`));
  const page = await (await shop.call(new URL(shop.collect.passUrl((await shop.store.getOrder(orderId))!)).pathname)).text();
  assert.doesNotMatch(page, /Being prepared/);

  // Nothing waits on a fallback.
  await shop.store.updateOrder(orderId, { paidAt: Date.now() - 60 * 60_000 });
  await shop.collect.sweep();
  assert.equal(sent.length, 1);
  shop.collect.stop();
});

test("an x402 receipt links the payment on the block explorer", async () => {
  const { sent, mailer } = recordingMailer();
  const shop = setupShop({ mailer, qrEmail: "when-ready" });
  const { paid } = await agentBuys(shop, makeAgent());
  assert.equal(paid.status, 200, await paid.clone().text());
  const receipt = sent[0];
  assert.match(receipt.text!, /Paid with USDC on Base Sepolia \(testnet\): https:\/\/sepolia\.basescan\.org\/tx\/0x0{63}1/);
  assert.match(receipt.html, /<a href="https:\/\/sepolia\.basescan\.org\/tx\/0x0{63}1"[^>]*>USDC on Base Sepolia \(testnet\)<\/a>/);
  shop.collect.stop();
});
