import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { agentBuys, makeAgent, setupShop } from "./helpers.js";
import { refundNonce } from "../src/rails/x402.js";

type Auth = { from: string; to: string; value: string; nonce: string };
const authOf = (settled: { payload: { payload: unknown } }) => (settled.payload.payload as { authorization: Auth }).authorization;

async function noShow(extra: Parameters<typeof setupShop>[0] = {}, x402Extra: Parameters<typeof setupShop>[1] = {}) {
  const shop = setupShop(extra, x402Extra);
  const agent = makeAgent();
  const { orderId } = await agentBuys(shop, agent, [{ id: "flat-white", qty: 2 }]);
  await shop.store.updateOrder(orderId, { collectBy: Date.now() - 1 });
  return { shop, agent, orderId };
}

test("an uncollected x402 order is paid back to the wallet that paid it", async () => {
  const refundKey = generatePrivateKey();
  const { shop, agent, orderId } = await noShow({}, { refunds: { privateKey: refundKey } });
  await shop.collect.sweep();

  const order = (await shop.store.getOrder(orderId))!;
  assert.equal(order.status, "expired");
  assert.equal(order.refundDue, false);
  assert.equal(shop.facilitator.settled.length, 2, "the payment, then the refund");
  const refund = authOf(shop.facilitator.settled[1]);
  assert.equal(refund.from.toLowerCase(), privateKeyToAccount(refundKey).address.toLowerCase());
  assert.equal(refund.to.toLowerCase(), agent.address.toLowerCase());
  assert.equal(refund.value, "9000000", "the same $9.00 that was paid");
  assert.equal(refund.nonce, refundNonce(orderId));

  const events = await shop.store.listEvents(orderId);
  const refunded = events.find((e) => e.type === "order.refunded");
  assert.equal(refunded?.data?.transaction, `0x${"2".padStart(64, "0")}`);
  assert.equal(events.find((e) => e.type === "order.expired")?.data?.outcome, "refunding");
});

test("a refund that fails is tried again on the next sweep", async () => {
  const { shop, orderId } = await noShow({}, { refunds: { privateKey: generatePrivateKey() } });
  shop.facilitator.failSettle = true;
  await shop.collect.sweep();
  assert.equal((await shop.store.getOrder(orderId))!.refundDue, true);

  shop.facilitator.failSettle = false;
  await shop.collect.sweep();
  assert.equal((await shop.store.getOrder(orderId))!.refundDue, false);
  assert.equal(shop.facilitator.settled.length, 2);
});

test("the same order can't be refunded twice, even by two servers at once", async () => {
  const { shop, orderId } = await noShow({}, { refunds: { privateKey: generatePrivateKey() } });
  shop.facilitator.failSettle = true;
  await shop.collect.sweep(); // expired, refund still due
  shop.facilitator.failSettle = false;

  const results = await Promise.allSettled([shop.collect.refundX402(orderId), shop.collect.refundX402(orderId)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.match(String((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason), /already_used/);
  assert.equal(shop.facilitator.settled.length, 2, "one payment, one refund");
  await assert.rejects(shop.collect.refundX402(orderId), /No x402 refund is due/);
});

test("an AUD shop refunds the USDC that was actually paid", async () => {
  const { shop, orderId } = await noShow(
    { currency: "aud" },
    { refunds: { privateKey: generatePrivateKey() }, toUsdCents: (cents) => cents * 0.65 },
  );
  await shop.collect.sweep();
  assert.equal(authOf(shop.facilitator.settled[1]).value, "5850000");
});

test("with no refund wallet, no-shows are flagged for the shop to settle", async () => {
  const { shop, orderId } = await noShow();
  await shop.collect.sweep();
  const order = (await shop.store.getOrder(orderId))!;
  assert.equal(order.refundDue, true);
  assert.equal(shop.facilitator.settled.length, 1);
  await assert.rejects(shop.collect.refundX402(orderId), /refunds aren't set up/);
});

test("noShowPolicy keep: nothing is paid back", async () => {
  const { shop, orderId } = await noShow({ noShowPolicy: "keep" }, { refunds: { privateKey: generatePrivateKey() } });
  await shop.collect.sweep();
  assert.equal((await shop.store.getOrder(orderId))!.refundDue, false);
  assert.equal(shop.facilitator.settled.length, 1);
});
