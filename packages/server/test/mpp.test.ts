import { test } from "node:test";
import assert from "node:assert/strict";
import { Mppx as MppxClient, stripe as stripeClient } from "mppx/client";
import type { StripeLike } from "../src/index.js";
import { setupShop } from "./helpers.js";

/** Records PaymentIntents and refunds; replays by idempotency key like Stripe does. */
class FakeStripe implements StripeLike {
  intents: { params: Record<string, unknown>; options: Record<string, unknown> }[] = [];
  refunded: string[] = [];
  nextStatus = "succeeded";
  private byKey = new Map<string, string>();

  paymentIntents = {
    create: async (params: unknown, options?: unknown) => {
      const key = (options as { idempotencyKey?: string })?.idempotencyKey ?? "";
      const seen = this.byKey.get(key);
      if (seen) return { id: seen, status: "succeeded", lastResponse: { headers: { "idempotent-replayed": "true" } } };
      this.intents.push({ params: params as Record<string, unknown>, options: options as Record<string, unknown> });
      const id = `pi_fake_${this.intents.length}`;
      if (this.nextStatus === "succeeded") this.byKey.set(key, id);
      return { id, status: this.nextStatus, lastResponse: { headers: {} } };
    },
  };

  refunds = {
    create: async (params: { payment_intent: string }) => {
      this.refunded.push(params.payment_intent);
      return { id: `re_${params.payment_intent}` };
    },
  };
}

function mppShop() {
  const stripe = new FakeStripe();
  const shop = setupShop({
    payments: {
      test: true,
      mpp: { networkId: "internal", challengeSecret: "test-challenge-secret-0123456789abcdef", stripeClient: stripe },
    },
  });
  return { ...shop, stripe };
}

const agentWallet = () =>
  MppxClient.create({
    methods: [stripeClient.charge({ createToken: async () => "spt_test_granted_token", paymentMethod: "pm_card_visa" })],
    polyfill: false,
  });

async function createMppOrder(shop: ReturnType<typeof mppShop>, qty = 2) {
  const res = await shop.post("/api/orders", { items: [{ id: "flat-white", qty }], email: "owner@example.com", rail: "mpp" });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { order: { id: string }; next: { type: string; url: string } };
  assert.equal(body.next.type, "mpp");
  return { id: body.order.id, path: new URL(body.next.url).pathname };
}

test("an agent pays by card over MPP and the money goes through the merchant's Stripe", async () => {
  const shop = mppShop();
  const { id, path } = await createMppOrder(shop);
  const challenge = await shop.call(path, { method: "POST" });
  assert.equal(challenge.status, 402);
  const www = challenge.headers.get("WWW-Authenticate") ?? "";
  assert.match(www, /^Payment /);
  assert.match(www, /method="stripe"/);
  assert.match(www, /intent="charge"/);

  const credential = await agentWallet().createCredential(challenge);
  const paid = await shop.call(path, { method: "POST", headers: { Authorization: credential } });
  assert.equal(paid.status, 200);
  assert.ok(paid.headers.get("Payment-Receipt"));
  const body = (await paid.json()) as { passUrl: string };
  assert.match(body.passUrl, /\/p\//);

  const order = (await shop.store.getOrder(id))!;
  assert.equal(order.status, "paid");
  assert.equal(order.paymentRef, "pi_fake_1");
  const [intent] = shop.stripe.intents;
  assert.equal(intent.params.amount, 900);
  assert.equal(intent.params.currency, "usd");
  assert.equal(intent.params.shared_payment_granted_token, "spt_test_granted_token");
  assert.equal((intent.params.metadata as Record<string, string>).agentpickup_order_id, id);
});

test("an MPP credential for one order can't pay for another", async () => {
  const shop = mppShop();
  const a = await createMppOrder(shop, 1);
  const b = await createMppOrder(shop, 1);
  const challengeA = await shop.call(a.path, { method: "POST" });
  const credentialA = await agentWallet().createCredential(challengeA);
  const res = await shop.call(b.path, { method: "POST", headers: { Authorization: credentialA } });
  assert.notEqual(res.status, 200);
  assert.equal((await shop.store.getOrder(b.id))!.status, "awaiting_payment");
  assert.equal(shop.stripe.intents.length, 0);
});

test("retrying the same MPP credential after success returns the original result", async () => {
  const shop = mppShop();
  const { path } = await createMppOrder(shop);
  const credential = await agentWallet().createCredential(await shop.call(path, { method: "POST" }));
  assert.equal((await shop.call(path, { method: "POST", headers: { Authorization: credential } })).status, 200);
  const retry = await shop.call(path, { method: "POST", headers: { Authorization: credential } });
  assert.equal(retry.status, 200);
  assert.equal(((await retry.json()) as { replayed: boolean }).replayed, true);
  assert.equal(shop.stripe.intents.length, 1);
});

test("a card that needs extra authentication leaves the order unpaid", async () => {
  const shop = mppShop();
  shop.stripe.nextStatus = "requires_action";
  const { id, path } = await createMppOrder(shop);
  const credential = await agentWallet().createCredential(await shop.call(path, { method: "POST" }));
  const res = await shop.call(path, { method: "POST", headers: { Authorization: credential } });
  assert.notEqual(res.status, 200);
  assert.equal((await shop.store.getOrder(id))!.status, "awaiting_payment");
});

test("an uncollected MPP order is refunded through Stripe", async () => {
  const shop = mppShop();
  const { id, path } = await createMppOrder(shop);
  const credential = await agentWallet().createCredential(await shop.call(path, { method: "POST" }));
  await shop.call(path, { method: "POST", headers: { Authorization: credential } });
  await shop.store.updateOrder(id, { collectBy: Date.now() - 1 });
  await shop.collect.sweep();
  assert.equal((await shop.store.getOrder(id))!.status, "expired");
  assert.deepEqual(shop.stripe.refunded, ["pi_fake_1"]);
});

test("openapi.json advertises the MPP route with an MPP offer", async () => {
  const shop = mppShop();
  const doc = (await (await shop.call("/openapi.json")).json()) as { paths: Record<string, Record<string, Record<string, unknown>>> };
  const op = doc.paths["/api/orders/{id}/mpp"].post;
  const info = op["x-payment-info"] as { offers: { method: string; intent: string }[] };
  assert.equal(info.offers[0].method, "stripe");
  assert.equal(info.offers[0].intent, "charge");
});
