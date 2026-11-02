import { test } from "node:test";
import assert from "node:assert/strict";
import { generateSigningKeyPem, loadSigningKey, signPass } from "@agentpickup/core";
import { createCollect, outboxMailer, SqliteStore } from "../src/index.js";

function setup(extra: { staffKey?: string } = {}) {
  const store = new SqliteStore(":memory:");
  const collect = createCollect({
    baseUrl: "https://shop.test",
    merchant: { name: "Test Café", fromEmail: "orders@shop.test", location: { name: "Front counter" } },
    catalog: [
      { id: "flat-white", name: "Flat white", priceCents: 450 },
      { id: "croissant", name: "Croissant", priceCents: 500 },
    ],
    store,
    mailer: outboxMailer(),
    signingKeyPem: generateSigningKeyPem(),
    payments: { test: true },
    exposeEmailPreview: true,
    allowOpenStaff: true,
    ...extra,
  });
  const call = (path: string, init?: RequestInit) => collect.app.request(`https://shop.test${path}`, init);
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    call(path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { store, collect, call, post };
}

async function placeTestOrder(post: ReturnType<typeof setup>["post"]) {
  const res = await post("/api/orders", {
    items: [
      { id: "flat-white", qty: 2 },
      { id: "croissant", qty: 1 },
    ],
    email: "sam@example.com",
    name: "Sam",
    rail: "test",
  });
  assert.equal(res.status, 201);
  return (await res.json()) as { order: { id: string; status: string; totalCents: number }; next: { passUrl: string } };
}

test("buy → email with QR → scan → collected, and only once", async () => {
  const { store, collect, call, post } = setup();
  const { order, next } = await placeTestOrder(post);
  assert.equal(order.status, "paid");
  assert.equal(order.totalCents, 1400);

  const saved = store.getOrder(order.id)!;
  assert.ok(saved.passId && saved.pickupCode);
  assert.equal(next.passUrl, `https://shop.test/p/${saved.passId}`);

  const email = await call(`/api/orders/${order.id}/email-preview`);
  const html = await email.text();
  assert.match(html, /data:image\/png;base64,/);
  assert.match(html, new RegExp(saved.pickupCode!));
  assert.doesNotMatch(html, /agentpickup|collect402/i, "shoppers never see the library's name");

  const scan = collect.collectLink(saved);
  const lookup = await post("/api/staff/lookup", { scan });
  assert.equal(lookup.status, 200);
  const looked = (await lookup.json()) as { order: { customerName: string; items: unknown[] } };
  assert.equal(looked.order.customerName, "Sam");

  const first = await post("/api/staff/collect", { scan });
  assert.equal(first.status, 200);
  assert.equal(store.getOrder(order.id)!.status, "collected");

  const second = await post("/api/staff/collect", { scan });
  assert.equal(second.status, 409);
});

test("the pickup code works when the QR won't scan", async () => {
  const { store, post } = setup();
  const { order } = await placeTestOrder(post);
  const code = store.getOrder(order.id)!.pickupCode!;
  const res = await post("/api/staff/collect", { scan: code.toLowerCase() });
  assert.equal(res.status, 200);
});

test("a QR signed by someone else is refused", async () => {
  const { store, post } = setup();
  const { order } = await placeTestOrder(post);
  const saved = store.getOrder(order.id)!;
  const forger = loadSigningKey(generateSigningKeyPem());
  const forged = signPass({ v: 1, oid: saved.id, pid: saved.passId!, exp: 2_000_000_000 }, forger);
  const res = await post("/api/staff/collect", { scan: `https://shop.test/c/${forged}` });
  assert.equal(res.status, 400);
  assert.equal(store.getOrder(order.id)!.status, "paid");
});

test("prices come from the catalog, not the request", async () => {
  const { post } = setup();
  const res = await post("/api/orders", {
    items: [{ id: "flat-white", qty: 1, priceCents: 1 }],
    email: "sam@example.com",
    rail: "test",
  });
  const body = (await res.json()) as { order: { totalCents: number } };
  assert.equal(body.order.totalCents, 450);
});

test("bad orders are rejected with a reason", async () => {
  const { post } = setup();
  assert.equal((await post("/api/orders", { items: [], email: "a@b.co", rail: "test" })).status, 400);
  assert.equal((await post("/api/orders", { items: [{ id: "nope", qty: 1 }], email: "a@b.co", rail: "test" })).status, 400);
  assert.equal((await post("/api/orders", { items: [{ id: "croissant", qty: 1 }], rail: "test" })).status, 400);
  assert.equal((await post("/api/orders", { items: [{ id: "croissant", qty: 1 }], email: "a@b.co", rail: "card" })).status, 400);
});

test("uncollected orders expire", async () => {
  const { store, collect, post } = setup();
  const { order } = await placeTestOrder(post);
  store.updateOrder(order.id, { collectBy: Date.now() - 1 });
  await collect.sweep();
  assert.equal(store.getOrder(order.id)!.status, "expired");
  const res = await post("/api/staff/collect", { scan: store.getOrder(order.id)!.pickupCode });
  assert.equal(res.status, 404, "expired orders no longer match a pickup code");
});

test("staff routes need the staff key when one is set", async () => {
  const { store, post } = setup({ staffKey: "s3cret-key" });
  const { order } = await placeTestOrder(post);
  const scan = store.getOrder(order.id)!.pickupCode;
  assert.equal((await post("/api/staff/collect", { scan })).status, 401);
  assert.equal((await post("/api/staff/collect", { scan }, { "x-collect-staff-key": "wrong" })).status, 401);
  assert.equal((await post("/api/staff/collect", { scan }, { "x-collect-staff-key": "s3cret-key" })).status, 200);
});

test("a shopper opening the QR link sees their pass, not the hand-over screen", async () => {
  const { store, collect, call, post } = setup({ staffKey: "s3cret-key" });
  const { order } = await placeTestOrder(post);
  const link = collect.collectLink(store.getOrder(order.id)!);
  const res = await call(new URL(link).pathname, { redirect: "manual" });
  assert.equal(res.status, 302);
  assert.match(res.headers.get("location")!, /^\/p\//);
});
