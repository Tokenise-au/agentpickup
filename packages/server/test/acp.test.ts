import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { StripeLike } from "../src/index.js";
import { setupShop } from "./helpers.js";

class FakeStripe implements StripeLike {
  intents: Record<string, unknown>[] = [];
  decline = false;
  paymentIntents = {
    create: async (params: unknown) => {
      this.intents.push(params as Record<string, unknown>);
      return { id: `pi_acp_${this.intents.length}`, status: this.decline ? "requires_payment_method" : "succeeded" };
    },
  };
  refunds = { create: async () => ({}) };
}

const KEY = "acp_test_key_platform_one";
let n = 0;

function acpShop(webhook?: { url: string; secret: string }) {
  const stripe = new FakeStripe();
  const shop = setupShop({ acp: { apiKeys: [KEY, "acp_test_key_platform_two"], stripe: { client: stripe }, webhook } });
  const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    shop.call(`/acp${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${KEY}`,
        "API-Version": "2026-04-17",
        "Idempotency-Key": `idem_${++n}`,
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { ...shop, stripe, send };
}

type Session = {
  id: string;
  status: string;
  line_items: { item: { id: string }; quantity: number }[];
  totals: { type: string; amount: number }[];
  fulfillment_options: { type: string; id: string; location: { name: string } }[];
  selected_fulfillment_options: { type: string; option_id: string }[];
  messages: { code: string; param?: string }[];
  order?: { id: string; permalink_url: string; status: string };
};

async function readySession(shop: ReturnType<typeof acpShop>) {
  const created = await shop.send("POST", "/checkout_sessions", {
    currency: "usd",
    line_items: [{ id: "flat-white" }, { id: "flat-white" }, { id: "croissant" }],
  });
  assert.equal(created.status, 201);
  const s = (await created.json()) as Session;
  const updated = await shop.send("POST", `/checkout_sessions/${s.id}`, { buyer: { email: "buyer@example.com", first_name: "Sam" } });
  return (await updated.json()) as Session;
}

test("discovery points agents at the ACP API", async () => {
  const shop = acpShop();
  const doc = (await (await shop.call("/.well-known/acp.json")).json()) as { protocol: { name: string; version: string }; api_base_url: string };
  assert.equal(doc.protocol.name, "acp");
  assert.equal(doc.protocol.version, "2026-04-17");
  assert.equal(doc.api_base_url, "https://shop.test/acp");
});

test("requests need a valid API key, API-Version, and an Idempotency-Key on POST", async () => {
  const shop = acpShop();
  const body = { line_items: [{ id: "croissant" }] };
  assert.equal((await shop.send("POST", "/checkout_sessions", body, { Authorization: "" })).status, 401);
  assert.equal((await shop.send("POST", "/checkout_sessions", body, { Authorization: "Bearer wrong" })).status, 401);
  assert.equal((await shop.send("POST", "/checkout_sessions", body, { "API-Version": "" })).status, 400);
  const noKey = await shop.send("POST", "/checkout_sessions", body, { "Idempotency-Key": "" });
  assert.equal(noKey.status, 400);
  assert.equal(((await noKey.json()) as { code: string }).code, "idempotency_key_required");
});

test("a session prices from the catalog, offers in-store pickup, and needs an email", async () => {
  const shop = acpShop();
  const res = await shop.send("POST", "/checkout_sessions", { line_items: [{ id: "flat-white" }, { id: "flat-white" }, { id: "croissant" }] });
  const s = (await res.json()) as Session;
  assert.equal(s.status, "not_ready_for_payment");
  assert.deepEqual(s.line_items.map((l) => [l.item.id, l.quantity]), [["flat-white", 2], ["croissant", 1]]);
  assert.equal(s.totals.find((t) => t.type === "total")!.amount, 1400);
  assert.equal(s.fulfillment_options[0].type, "pickup");
  assert.equal(s.selected_fulfillment_options[0].type, "pickup");
  assert.ok(s.messages.some((m) => m.param === "$.buyer.email"));
});

test("completing with the test handler creates a paid order whose permalink is the pickup pass", async () => {
  const shop = acpShop();
  const s = await readySession(shop);
  assert.equal(s.status, "ready_for_payment");
  const done = (await (await shop.send("POST", `/checkout_sessions/${s.id}/complete`, { payment_data: { handler_id: "agentpickup_test" } })).json()) as Session;
  assert.equal(done.status, "completed");
  assert.match(done.order!.permalink_url, /^https:\/\/shop\.test\/p\//);
  assert.equal(done.order!.status, "confirmed");
  const order = (await shop.store.getOrder(done.order!.id))!;
  assert.equal(order.rail, "acp");
  assert.equal(order.status, "paid");
});

test("an SPT is charged once; replays return the same response; a changed body with the same key is refused", async () => {
  const shop = acpShop();
  const s = await readySession(shop);
  const body = { payment_data: { handler_id: "card_tokenized", instrument: { type: "card", credential: { type: "spt", token: "spt_123" } } } };
  const headers = { "Idempotency-Key": "complete-acp-1" };
  const first = await shop.send("POST", `/checkout_sessions/${s.id}/complete`, body, headers);
  const replay = await shop.send("POST", `/checkout_sessions/${s.id}/complete`, body, headers);
  assert.equal(replay.headers.get("Idempotent-Replayed"), "true");
  assert.deepEqual(await first.json(), await replay.json());
  assert.equal(shop.stripe.intents.length, 1);
  assert.deepEqual(shop.stripe.intents[0].payment_method_data, { shared_payment_granted_token: "spt_123" });
  const conflict = await shop.send("POST", `/checkout_sessions/${s.id}/complete`, { ...body, buyer: { email: "x@y.co" } }, headers);
  assert.equal(conflict.status, 422);
});

test("a declined SPT returns a payment_declined message and no order", async () => {
  const shop = acpShop();
  shop.stripe.decline = true;
  const s = await readySession(shop);
  const res = await shop.send("POST", `/checkout_sessions/${s.id}/complete`, {
    payment_data: { handler_id: "card_tokenized", instrument: { type: "card", credential: { type: "spt", token: "spt_bad" } } },
  });
  const body = (await res.json()) as Session;
  assert.equal(body.status, "ready_for_payment");
  assert.ok(body.messages.some((m) => m.code === "payment_declined"));
  assert.equal((await shop.store.listOrders({ statuses: ["paid"] })).length, 0);
});

test("another platform can't read a session", async () => {
  const shop = acpShop();
  const s = await readySession(shop);
  const res = await shop.send("GET", `/checkout_sessions/${s.id}`, undefined, { Authorization: "Bearer acp_test_key_platform_two" });
  assert.equal(res.status, 404);
});

test("order events go to the platform webhook, signed", async () => {
  const sent: { headers: Record<string, string>; body: string }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === "https://platform.test/hooks") {
      sent.push({ headers: init?.headers as Record<string, string>, body: String(init?.body) });
      return new Response(null, { status: 200 });
    }
    return realFetch(url, init);
  }) as typeof fetch;
  try {
    const shop = acpShop({ url: "https://platform.test/hooks", secret: "hook-secret" });
    const s = await readySession(shop);
    const done = (await (await shop.send("POST", `/checkout_sessions/${s.id}/complete`, { payment_data: { handler_id: "agentpickup_test" } })).json()) as Session;
    const order = (await shop.store.getOrder(done.order!.id))!;
    await shop.post("/api/staff/collect", { scan: order.pickupCode });

    const types = sent.map((w) => (JSON.parse(w.body) as { type: string; data: { status: string } }));
    assert.equal(types[0].type, "order_create");
    assert.equal(types.at(-1)!.type, "order_update");
    assert.equal(types.at(-1)!.data.status, "completed");
    const { headers, body } = sent[0];
    const expected = createHmac("sha256", "hook-secret").update(`${headers.Timestamp}.${body}`).digest("base64url");
    assert.equal(headers["Merchant-Signature"], expected);
  } finally {
    globalThis.fetch = realFetch;
  }
});
