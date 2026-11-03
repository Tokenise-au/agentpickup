import { test } from "node:test";
import assert from "node:assert/strict";
import { generateSigningKeyPem } from "@agentpickup/core";
import { createCollect, createVenueHost, outboxMailer, type Store } from "../src/index.js";
import { CATALOG, FakeFacilitator, makeAgent, NETWORK, PAY_TO, testStore } from "./helpers.js";

const HOST = "https://host.test";
const SECRET = "a-long-host-secret-for-sealing-venue-keys-0123456789";
const ADMIN = { Authorization: "Bearer admin-key", "Content-Type": "application/json" };

test("a shop under a path: links, QR, staff page, cookie, did:web and x402 all carry the path", async () => {
  const store = testStore();
  const facilitator = new FakeFacilitator();
  const shop = createCollect({
    baseUrl: `${HOST}/v/cafe`,
    merchant: { name: "Path Café", fromEmail: "orders@host.test" },
    catalog: CATALOG,
    store,
    mailer: outboxMailer(),
    signingKeyPem: generateSigningKeyPem(),
    payments: { test: true, x402: { payTo: PAY_TO, network: NETWORK, facilitator } },
    staffKey: "staff-secret",
  });
  const call = (path: string, init?: RequestInit) => shop.app.request(`${HOST}${path}`, init);
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    call(path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

  assert.equal((await call("/api/catalog")).status, 404, "nothing at the domain root");
  const made = (await (await post("/v/cafe/api/orders", { items: [{ id: "flat-white", qty: 1 }], email: "a@b.co", rail: "test" })).json()) as {
    order: { id: string };
    next: { passUrl: string };
  };
  assert.match(made.next.passUrl, /^https:\/\/host\.test\/v\/cafe\/p\//);
  const order = (await store.getOrder(made.order.id))!;
  const link = shop.collectLink(order);
  assert.match(link, /^https:\/\/host\.test\/v\/cafe\/c\//);
  const qr = await call(new URL(link).pathname, { redirect: "manual" });
  assert.equal(qr.headers.get("location"), `/v/cafe/p/${order.passId}`);

  const login = await call("/v/cafe/staff");
  const html = await login.text();
  assert.match(html, /<base href="\/v\/cafe\/">/);
  assert.match(html, /action="staff\/login"/);
  const signedIn = await call("/v/cafe/staff/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "key=staff-secret",
    redirect: "manual",
  });
  assert.equal(signedIn.headers.get("location"), "/v/cafe/staff");
  assert.match(signedIn.headers.get("set-cookie") ?? "", /Path=\/v\/cafe/);
  const scanner = await (await call("/v/cafe/staff", { headers: { Cookie: (signedIn.headers.get("set-cookie") ?? "").split(";")[0] } })).text();
  assert.match(scanner, /src="collect-assets\/scanner\.js"/);
  assert.equal((await call("/v/cafe/collect-assets/scanner.js")).status, 200);

  const did = (await (await call("/v/cafe/did.json")).json()) as { id: string };
  assert.equal(did.id, "did:web:host.test:v:cafe");

  // x402 under the path: the 402 names the right resource, and the agent's payment settles.
  const agent = makeAgent();
  const x = (await (await post("/v/cafe/api/orders", { items: [{ id: "flat-white", qty: 1 }], email: "a@b.co", rail: "x402" })).json()) as {
    next: { url: string };
  };
  const payPath = new URL(x.next.url).pathname;
  assert.equal(payPath.startsWith("/v/cafe/api/orders/"), true);
  const challenge = await call(payPath, { method: "POST" });
  assert.equal(challenge.status, 402);
  const required = agent.http.getPaymentRequiredResponse((n) => challenge.headers.get(n), await challenge.clone().json().catch(() => undefined));
  assert.equal(required.resource.url, x.next.url);
  const paid = await call(payPath, { method: "POST", headers: agent.http.encodePaymentSignatureHeader(await agent.http.createPaymentPayload(required)) });
  assert.equal(paid.status, 200);
  assert.equal(facilitator.settled.length, 1);
  shop.stop();
});

function host(registry: Store, stores: Map<string, Store>, extra: Partial<Parameters<typeof createVenueHost>[0]> = {}) {
  return createVenueHost({
    baseUrl: HOST,
    store: registry,
    storeFor: (slug) => {
      if (!stores.has(slug)) stores.set(slug, testStore());
      return stores.get(slug)!;
    },
    mailer: outboxMailer(),
    secretKey: SECRET,
    adminKeys: ["admin-key"],
    ...extra,
  });
}

const venueBody = (name: string, item: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    merchant: { name, fromEmail: "orders@host.test", location: { name: "Front counter" } },
    currency: "aud",
    catalog: [{ id: item, name: item, priceCents: 500 }],
    payments: { test: true },
    ...extra,
  });

test("venue host: venues are added through the admin API and each runs at its own address", async () => {
  const registry = testStore();
  const stores = new Map<string, Store>();
  const h = host(registry, stores);
  const req = (path: string, init?: RequestInit) => h.app.request(`${HOST}${path}`, init);

  assert.equal((await req("/host/v1/venues")).status, 401);
  const bad = await req("/host/v1/venues/Bad Name", { method: "PUT", headers: ADMIN, body: venueBody("X", "x") });
  assert.equal(bad.status, 400);

  const a = await req("/host/v1/venues/corner-cafe", { method: "PUT", headers: ADMIN, body: venueBody("Corner Café", "flat-white", { staffKey: "corner-staff" }) });
  assert.equal(a.status, 200, await a.clone().text());
  const venueA = ((await a.json()) as { venue: { url: string; running: boolean; secretsSet: Record<string, boolean> } }).venue;
  assert.equal(venueA.url, `${HOST}/v/corner-cafe`);
  assert.equal(venueA.running, true);
  assert.equal(venueA.secretsSet.staffKey, true);
  assert.equal(JSON.stringify(venueA).includes("corner-staff"), false, "the admin API never shows a secret");
  await req("/host/v1/venues/bakery", { method: "PUT", headers: ADMIN, body: venueBody("The Bakery", "sourdough") });

  const menuA = (await (await req("/v/corner-cafe/api/catalog")).json()) as { merchant: { name: string }; items: { id: string }[]; currency: string };
  const menuB = (await (await req("/v/bakery/api/catalog")).json()) as { merchant: { name: string }; items: { id: string }[] };
  assert.deepEqual([menuA.merchant.name, menuA.items[0].id, menuA.currency], ["Corner Café", "flat-white", "aud"]);
  assert.deepEqual([menuB.merchant.name, menuB.items[0].id], ["The Bakery", "sourdough"]);
  assert.equal((await req("/v/nowhere/api/catalog")).status, 404);

  // Orders stay with their venue.
  const made = (await (
    await req("/v/corner-cafe/api/orders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: [{ id: "flat-white", qty: 1 }], email: "a@b.co", rail: "test" }) })
  ).json()) as { order: { id: string } };
  assert.equal((await req(`/v/corner-cafe/api/orders/${made.order.id}`)).status, 200);
  assert.equal((await req(`/v/bakery/api/orders/${made.order.id}`)).status, 404);
  assert.ok(await stores.get("corner-cafe")!.getOrder(made.order.id));
  assert.equal(await stores.get("bakery")!.getOrder(made.order.id), null);

  // The corner café has a staff key; the bakery has none and no open scanner either.
  assert.match(await (await req("/v/corner-cafe/staff")).text(), /Staff sign-in/);
  assert.match(await (await req("/v/bakery/staff")).text(), /Staff access isn(&#39;|')t set up/);

  const list = (await (await req("/host/v1/venues", { headers: ADMIN })).json()) as { venues: { slug: string }[] };
  assert.deepEqual(list.venues.map((v) => v.slug), ["corner-cafe", "bakery"]);
  h.stop();
});

test("venue host: secrets are sealed in the store, kept on updates unless replaced, and survive a restart", async () => {
  const registry = testStore();
  const stores = new Map<string, Store>();
  const first = host(registry, stores);
  const req = (h: ReturnType<typeof host>, path: string, init?: RequestInit) => h.app.request(`${HOST}${path}`, init);
  await req(first, "/host/v1/venues/cafe", { method: "PUT", headers: ADMIN, body: venueBody("Café", "flat-white", { staffKey: "first-staff-key" }) });

  const raw = JSON.stringify(await registry.getDoc("venue", "cafe"));
  assert.equal(raw.includes("first-staff-key"), false, "not in the clear");
  assert.equal(raw.includes("BEGIN PRIVATE KEY"), false, "the signing key is sealed too");

  // An update without staffKey keeps it; the scanner still asks for it.
  await req(first, "/host/v1/venues/cafe", { method: "PUT", headers: ADMIN, body: venueBody("Café Renamed", "flat-white") });
  assert.match(await (await req(first, "/v/cafe/staff")).text(), /Staff sign-in/);
  const made = (await (
    await req(first, "/v/cafe/api/orders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: [{ id: "flat-white", qty: 1 }], email: "a@b.co", rail: "test" }) })
  ).json()) as { order: { id: string }; next: { passUrl: string } };
  first.stop();

  // A new process with the same registry and key: the venue, its name and its orders are back.
  const second = host(registry, stores);
  await second.ready;
  const menu = (await (await req(second, "/v/cafe/api/catalog")).json()) as { merchant: { name: string } };
  assert.equal(menu.merchant.name, "Café Renamed");
  assert.equal((await req(second, new URL(made.next.passUrl).pathname)).status, 200, "passes issued before the restart still open");
  second.stop();

  // The wrong key: the venue stays down and says why; the host keeps running.
  const wrong = host(registry, stores, { secretKey: "a-different-host-secret-that-is-long-enough-000" });
  await wrong.ready;
  assert.equal((await req(wrong, "/v/cafe/api/catalog")).status, 404);
  const described = (await (await req(wrong, "/host/v1/venues/cafe", { headers: ADMIN })).json()) as { venue: { running: boolean; error: string; secretsSet: unknown } };
  assert.equal(described.venue.running, false);
  assert.match(described.venue.error, /authenticate|unable|unsupported/i);
  assert.equal(described.venue.secretsSet, null);
  wrong.stop();
});

test("venue host: removing a venue takes it offline", async () => {
  const h = host(testStore(), new Map());
  const req = (path: string, init?: RequestInit) => h.app.request(`${HOST}${path}`, init);
  await req("/host/v1/venues/pop-up", { method: "PUT", headers: ADMIN, body: venueBody("Pop-up", "x") });
  assert.equal((await req("/v/pop-up/api/catalog")).status, 200);
  assert.equal((await req("/host/v1/venues/pop-up", { method: "DELETE", headers: ADMIN })).status, 200);
  assert.equal((await req("/v/pop-up/api/catalog")).status, 404);
  assert.equal((await req("/host/v1/venues/pop-up", { headers: ADMIN })).status, 404);
  h.stop();
});
