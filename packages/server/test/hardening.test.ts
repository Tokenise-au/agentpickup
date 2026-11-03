import { test } from "node:test";
import assert from "node:assert/strict";
import { setupShop } from "./helpers.js";

async function testOrder(shop: ReturnType<typeof setupShop>) {
  const res = await shop.post("/api/orders", { items: [{ id: "flat-white", qty: 1 }], email: "a@b.co", rail: "test" });
  const { order } = (await res.json()) as { order: { id: string } };
  return (await shop.store.getOrder(order.id))!;
}

test("with no staff key and no allowOpenStaff, staff routes are closed", async () => {
  const shop = setupShop({ allowOpenStaff: false });
  const order = await testOrder(shop);
  assert.equal((await shop.post("/api/staff/collect", { scan: order.pickupCode })).status, 403);
  assert.equal((await shop.call("/staff")).status, 403);
  assert.equal((await shop.store.getOrder(order.id))!.status, "paid");
});

test("guessing pickup codes gets a client locked out, even for a real code", async () => {
  const shop = setupShop();
  const order = await testOrder(shop);
  const ip = { "x-forwarded-for": "203.0.113.9" };
  for (let i = 0; i < 12; i++) {
    const res = await shop.post("/api/staff/lookup", { scan: "ZZZZZZ" }, ip);
    assert.equal(res.status, 404);
  }
  assert.equal((await shop.post("/api/staff/lookup", { scan: order.pickupCode }, ip)).status, 429);
  // Another client is unaffected.
  assert.equal((await shop.post("/api/staff/lookup", { scan: order.pickupCode }, { "x-forwarded-for": "198.51.100.4" })).status, 200);
});

test("oversized request bodies are refused", async () => {
  const shop = setupShop();
  const res = await shop.post("/api/orders", { items: [], padding: "x".repeat(70 * 1024) });
  assert.equal(res.status, 413);
});

test("an Idempotency-Key makes order creation safe to retry", async () => {
  const shop = setupShop();
  const body = { items: [{ id: "croissant", qty: 2 }], email: "a@b.co", rail: "test" };
  const first = await shop.post("/api/orders", body, { "Idempotency-Key": "retry-me-123" });
  const again = await shop.post("/api/orders", body, { "Idempotency-Key": "retry-me-123" });
  const other = await shop.post("/api/orders", body, { "Idempotency-Key": "a-different-key" });
  const id = (r: unknown) => (r as { order: { id: string } }).order.id;
  const [a, b, c] = [await first.json(), await again.json(), await other.json()];
  assert.equal(first.status, 201);
  assert.equal(again.status, 201);
  assert.equal(again.headers.get("Idempotent-Replayed"), "true");
  assert.equal(id(a), id(b));
  assert.notEqual(id(a), id(c));
  assert.equal((await shop.store.listOrders()).length, 2);
});

test("pass pages are not cached, framed or leaked through the referrer", async () => {
  const shop = setupShop();
  const order = await testOrder(shop);
  const res = await shop.call(`/p/${order.passId}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  assert.equal(res.headers.get("Referrer-Policy"), "no-referrer");
  assert.equal(res.headers.get("X-Frame-Options"), "DENY");
  assert.match(res.headers.get("Content-Security-Policy") ?? "", /frame-ancestors 'none'/);
  const staffApi = await shop.post("/api/staff/lookup", { scan: order.pickupCode });
  assert.equal(staffApi.headers.get("Cache-Control"), "no-store");
});
