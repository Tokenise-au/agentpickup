import { test } from "node:test";
import assert from "node:assert/strict";
import type { StripeLike } from "../src/index.js";
import { setupShop } from "./helpers.js";

class FakeStripe implements StripeLike {
  intents: Record<string, unknown>[] = [];
  refunded: string[] = [];
  decline = false;
  paymentIntents = {
    create: async (params: unknown) => {
      this.intents.push(params as Record<string, unknown>);
      return { id: `pi_ucp_${this.intents.length}`, status: this.decline ? "requires_payment_method" : "succeeded" };
    },
  };
  refunds = {
    create: async (p: { payment_intent: string }) => {
      this.refunded.push(p.payment_intent);
      return {};
    },
  };
}

const AGENT = 'profile="https://agent.example/.well-known/ucp"';
let keyCounter = 0;

function ucpShop() {
  const stripe = new FakeStripe();
  const shop = setupShop({ ucp: { stripe: { client: stripe, businessProfile: "profile_test", environment: "testmode" } } });
  const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    shop.call(`/ucp/v1${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "UCP-Agent": AGENT,
        "Request-Id": `req_${++keyCounter}`,
        "Idempotency-Key": `idem_${keyCounter}`,
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { ...shop, stripe, send };
}

type Checkout = {
  id: string;
  status: string;
  totals: { type: string; amount: number }[];
  messages?: { code: string; path?: string }[];
  fulfillment: { methods: { id: string; type: string; destinations: { type: string; id: string; name: string }[]; selected_destination_id: string | null }[] };
  order?: { id: string; permalink_url: string };
};

async function readyCheckout(shop: ReturnType<typeof ucpShop>) {
  const created = await shop.send("POST", "/checkout-sessions", {
    line_items: [{ item: { id: "flat-white" }, quantity: 2 }, { item: { id: "croissant" }, quantity: 1 }],
    fulfillment: { methods: [{ type: "pickup" }] },
  });
  assert.equal(created.status, 201);
  const chk = (await created.json()) as Checkout;
  const updated = await shop.send("PUT", `/checkout-sessions/${chk.id}`, {
    line_items: [{ item: { id: "flat-white" }, quantity: 2 }, { item: { id: "croissant" }, quantity: 1 }],
    buyer: { email: "buyer@example.com", first_name: "Sam" },
    fulfillment: { methods: [{ type: "pickup", selected_destination_id: "loc_main" }] },
  });
  assert.equal(updated.status, 200);
  return (await updated.json()) as Checkout;
}

test("the business profile advertises checkout, pickup fulfilment, orders and payment handlers", async () => {
  const shop = ucpShop();
  const profile = (await (await shop.call("/.well-known/ucp")).json()) as { ucp: Record<string, Record<string, { endpoint?: string; id?: string }[]>> & { version: string } };
  assert.equal(profile.ucp.version, "2026-08-25");
  assert.equal(profile.ucp.services["dev.ucp.shopping"][0].endpoint, "https://shop.test/ucp/v1");
  for (const cap of ["dev.ucp.shopping.checkout", "dev.ucp.shopping.fulfillment", "dev.ucp.shopping.order"]) {
    assert.ok(profile.ucp.capabilities[cap], cap);
  }
  assert.equal(profile.ucp.payment_handlers["com.stripe.payments"][0].id, "stripe_payments");
  assert.ok(profile.ucp.payment_handlers["dev.agentpickup.test"]);
});

test("UCP-Agent and Idempotency-Key are required", async () => {
  const shop = ucpShop();
  const body = JSON.stringify({ line_items: [{ item: { id: "croissant" }, quantity: 1 }] });
  const noAgent = await shop.call("/ucp/v1/checkout-sessions", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "k1" }, body });
  assert.equal(noAgent.status, 400);
  const noKey = await shop.call("/ucp/v1/checkout-sessions", { method: "POST", headers: { "Content-Type": "application/json", "UCP-Agent": AGENT }, body });
  assert.equal(noKey.status, 400);
});

test("a checkout prices from the catalog and asks for email and a pickup location", async () => {
  const shop = ucpShop();
  const res = await shop.send("POST", "/checkout-sessions", {
    line_items: [{ item: { id: "flat-white" }, quantity: 2 }],
    fulfillment: { methods: [{ type: "pickup" }] },
  });
  const chk = (await res.json()) as Checkout;
  assert.equal(chk.status, "incomplete");
  assert.equal(chk.totals.find((t) => t.type === "total")!.amount, 900);
  const method = chk.fulfillment.methods[0];
  assert.equal(method.type, "pickup");
  assert.equal(method.destinations[0].type, "business_location");
  assert.equal(method.destinations[0].id, "loc_main");
  const paths = (chk.messages ?? []).map((m) => m.path);
  assert.ok(paths.includes("$.buyer.email"));
  assert.ok(paths.some((p) => p?.includes("selected_destination_id")));
});

test("unknown items are reported, not trusted", async () => {
  const shop = ucpShop();
  const res = await shop.send("POST", "/checkout-sessions", { line_items: [{ item: { id: "caviar" }, quantity: 1 }] });
  const chk = (await res.json()) as Checkout & { line_items: unknown[] };
  assert.equal(chk.line_items.length, 0);
  assert.ok((chk.messages ?? []).some((m) => m.code === "not_found"));
});

test("completing with the test handler creates a paid order whose permalink is the pickup pass", async () => {
  const shop = ucpShop();
  const chk = await readyCheckout(shop);
  assert.equal(chk.status, "ready_for_complete");
  const done = await shop.send("POST", `/checkout-sessions/${chk.id}/complete`, {
    payment: { instruments: [{ id: "instr_1", handler_id: "agentpickup_test", type: "test", selected: true }] },
  });
  assert.equal(done.status, 200);
  const completed = (await done.json()) as Checkout;
  assert.equal(completed.status, "completed");
  assert.match(completed.order!.permalink_url, /^https:\/\/shop\.test\/p\//);
  const order = (await shop.store.getOrder(completed.order!.id))!;
  assert.equal(order.status, "paid");
  assert.equal(order.rail, "ucp");
  assert.equal(order.totalCents, 1400);
  assert.equal(order.customerEmail, "buyer@example.com");

  const viewed = (await (await shop.send("GET", `/orders/${order.id}`)).json()) as {
    permalink_url: string;
    fulfillment: { expectations: { method_type: string }[]; events: { type: string }[] };
    line_items: { status: string }[];
  };
  assert.equal(viewed.fulfillment.expectations[0].method_type, "pickup");
  assert.equal(viewed.fulfillment.events.length, 0);

  await shop.post("/api/staff/collect", { scan: order.pickupCode });
  const after = (await (await shop.send("GET", `/orders/${order.id}`)).json()) as typeof viewed;
  assert.equal(after.fulfillment.events.at(-1)!.type, "delivered");
  assert.equal(after.line_items[0].status, "fulfilled");
});

test("completing with a Stripe Shared Payment Token charges the merchant's Stripe once, even when retried", async () => {
  const shop = ucpShop();
  const chk = await readyCheckout(shop);
  const body = {
    payment: {
      instruments: [{ id: "instr_1", handler_id: "stripe_payments", type: "card", selected: true, credential: { type: "stripe_payment_token", token: "spt_123" } }],
    },
  };
  const headers = { "Idempotency-Key": "complete-once" };
  const first = await shop.send("POST", `/checkout-sessions/${chk.id}/complete`, body, headers);
  const retry = await shop.send("POST", `/checkout-sessions/${chk.id}/complete`, body, headers);
  assert.equal(first.status, 200);
  assert.equal(retry.status, 200);
  assert.deepEqual(await first.json(), await retry.json());
  assert.equal(shop.stripe.intents.length, 1);
  const intent = shop.stripe.intents[0];
  assert.equal(intent.amount, 1400);
  assert.deepEqual(intent.payment_method_data, { shared_payment_granted_token: "spt_123" });
});

test("a declined token leaves the checkout ready to try again", async () => {
  const shop = ucpShop();
  shop.stripe.decline = true;
  const chk = await readyCheckout(shop);
  const res = await shop.send("POST", `/checkout-sessions/${chk.id}/complete`, {
    payment: { instruments: [{ id: "i", handler_id: "stripe_payments", type: "card", selected: true, credential: { type: "stripe_payment_token", token: "spt_bad" } }] },
  });
  assert.equal(res.status, 402);
  const again = (await (await shop.send("GET", `/checkout-sessions/${chk.id}`)).json()) as Checkout;
  assert.equal(again.status, "ready_for_complete");
  assert.equal((await shop.store.listOrders({ statuses: ["paid"] })).length, 0);
});

test("another platform can't see a checkout or its order", async () => {
  const shop = ucpShop();
  const chk = await readyCheckout(shop);
  const other = { "UCP-Agent": 'profile="https://someone-else.example/profile"' };
  assert.equal((await shop.send("GET", `/checkout-sessions/${chk.id}`, undefined, other)).status, 404);
  const done = (await (
    await shop.send("POST", `/checkout-sessions/${chk.id}/complete`, {
      payment: { instruments: [{ id: "i", handler_id: "agentpickup_test", type: "test", selected: true }] },
    })
  ).json()) as Checkout;
  assert.equal((await shop.send("GET", `/orders/${done.order!.id}`, undefined, other)).status, 404);
});

test("an uncollected UCP card order is refunded", async () => {
  const shop = ucpShop();
  const chk = await readyCheckout(shop);
  const done = (await (
    await shop.send("POST", `/checkout-sessions/${chk.id}/complete`, {
      payment: { instruments: [{ id: "i", handler_id: "stripe_payments", type: "card", selected: true, credential: { type: "stripe_payment_token", token: "spt_9" } }] },
    })
  ).json()) as Checkout;
  await shop.store.updateOrder(done.order!.id, { collectBy: Date.now() - 1 });
  await shop.collect.sweep();
  assert.deepEqual(shop.stripe.refunded, ["pi_ucp_1"]);
});
