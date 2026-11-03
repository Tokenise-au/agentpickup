import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createVenueHost, fxToUsdCents, type OutgoingMail } from "../src/index.js";
import { testStore } from "./helpers.js";

const HOST = "https://host.test";
const APP_ID = "sandbox-sq0idb-test";
const APP_SECRET = "sandbox-sq0csb-secret";
const HOOK_KEY = "app-webhook-key";
const WALLET = "0x2fAB3cF3e605D524679b3116EE177554C3076875";
const DAY = 24 * 3600_000;

/** Enough of Square for sign-in and one venue: OAuth, locations, the menu, pickup orders. */
class FakeSquare {
  revoked: string[] = [];
  refreshes = 0;
  /** host + path of every request, in order. */
  calls: string[] = [];
  /** merchant -> the access token Square currently accepts. */
  tokens = new Map<string, string>();
  orders = new Map<string, { id: string; version: number; state: string; fulfillments: { uid: string; state: string }[]; total_money: { amount: number; currency: string } }>();
  private codes: Record<string, string> = { "good-code": "M1", "other-code": "M2" };
  private issued = 0;
  private locations = [
    { id: "L1", name: "Crown St", business_name: "Corner Café", currency: "AUD", status: "ACTIVE", address: { address_line_1: "12 Crown St", locality: "Surry Hills", administrative_district_level_1: "NSW", postal_code: "2010" } },
    { id: "L2", name: "Bondi", business_name: "Corner Café", currency: "AUD", status: "ACTIVE" },
    { id: "L3", name: "Closed", business_name: "Corner Café", currency: "AUD", status: "INACTIVE" },
  ];

  private grant(merchant: string) {
    const access = `EAAA-${merchant}-${++this.issued}`;
    this.tokens.set(merchant, access);
    return { access_token: access, token_type: "bearer", refresh_token: `R-${merchant}`, expires_at: new Date(Date.now() + 30 * DAY).toISOString(), merchant_id: merchant };
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    this.calls.push(url.host + url.pathname);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const reply = (status: number, json: unknown) => Response.json(json, { status });
    if (url.host !== "connect.squareupsandbox.com") return reply(404, { errors: [{ code: "NOT_FOUND" }] });

    if (url.pathname === "/oauth2/token") {
      if (body.client_id !== APP_ID || body.client_secret !== APP_SECRET) return reply(401, { errors: [{ code: "UNAUTHORIZED" }] });
      if (body.grant_type === "authorization_code") {
        const merchant = this.codes[body.code];
        return merchant ? reply(200, this.grant(merchant)) : reply(400, { errors: [{ code: "BAD_REQUEST", detail: "bad code" }] });
      }
      if (body.grant_type === "refresh_token") {
        this.refreshes++;
        return reply(200, this.grant(String(body.refresh_token).replace(/^R-/, "")));
      }
    }
    if (url.pathname === "/oauth2/revoke") {
      if (headers.get("Authorization") !== `Client ${APP_SECRET}`) return reply(401, { errors: [{ code: "UNAUTHORIZED" }] });
      this.revoked.push(body.merchant_id);
      this.tokens.delete(body.merchant_id);
      return reply(200, { success: true });
    }

    // Everything else needs the seller's current token.
    const bearer = headers.get("Authorization")?.replace(/^Bearer /, "");
    if (![...this.tokens.values()].includes(bearer ?? "")) return reply(401, { errors: [{ code: "ACCESS_TOKEN_EXPIRED" }] });
    if (url.pathname === "/v2/locations") return reply(200, { locations: this.locations });
    const loc = url.pathname.match(/^\/v2\/locations\/(\w+)$/);
    if (loc) return reply(200, { location: { ...this.locations.find((l) => l.id === loc[1]), timezone: "Australia/Sydney" } });
    if (url.pathname === "/v2/catalog/list") {
      return reply(200, {
        objects: [{ type: "ITEM", id: "I1", item_data: { name: "Flat white", variations: [{ id: "V1", item_variation_data: { price_money: { amount: 520, currency: "AUD" } } }] } }],
      });
    }
    if (url.pathname === "/v2/orders" && method === "POST") {
      const id = `SQ${this.orders.size + 1}`;
      const order = { id, version: 1, state: "OPEN", fulfillments: [{ uid: "F1", state: "PROPOSED" }], total_money: { amount: 520, currency: "AUD" } };
      this.orders.set(id, order);
      return reply(200, { order });
    }
    if (url.pathname === "/v2/payments") return reply(200, { payment: { id: "PAY1" } });
    const ord = url.pathname.match(/^\/v2\/orders\/(\w+)$/);
    if (ord) {
      const order = this.orders.get(ord[1])!;
      if (method === "PUT") {
        for (const f of body.order.fulfillments ?? []) order.fulfillments[0].state = f.state;
        if (body.order.state) order.state = body.order.state;
        order.version++;
      }
      return reply(200, { order });
    }
    return reply(404, { errors: [{ code: "NOT_FOUND", detail: `${method} ${url.pathname}` }] });
  };
}

/** A browser for the host: keeps cookies across requests, doesn't follow redirects. */
function browser(app: { request: (url: string, init?: RequestInit) => Response | Promise<Response> }) {
  const jar = new Map<string, string>();
  async function go(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (jar.size) headers.set("Cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
    const res = await app.request(`${HOST}${path}`, { ...init, headers });
    for (const cookie of res.headers.getSetCookie()) {
      const pair = cookie.split(";")[0];
      const name = pair.slice(0, pair.indexOf("="));
      const value = pair.slice(pair.indexOf("=") + 1);
      if (/Max-Age=0/i.test(cookie) || !value) jar.delete(name);
      else jar.set(name, value);
    }
    return res;
  }
  const form = (path: string, fields: Record<string, string>) =>
    go(path, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
  return { go, form, jar };
}

const csrfIn = (html: string) => html.match(/name="csrf" value="([^"]+)"/)![1];

function setup(opts: { converts?: boolean; environment?: "sandbox" | "production"; store?: ReturnType<typeof testStore>; square?: FakeSquare } = {}) {
  const square = opts.square ?? new FakeSquare();
  const sent: OutgoingMail[] = [];
  const store = opts.store ?? testStore();
  const host = createVenueHost({
    baseUrl: HOST,
    store,
    storeFor: () => testStore(),
    mailer: { delivers: true, send: async (m) => (sent.push(m), { id: String(sent.length) }) },
    secretKey: "x".repeat(40),
    adminKeys: ["admin"],
    sendFrom: "orders@host.test",
    fetch: square.fetch as typeof fetch,
    ...(opts.converts === false ? {} : { toUsdCents: (cents: number) => cents * 0.7 }),
    signup: {
      square: { applicationId: APP_ID, applicationSecret: APP_SECRET, environment: opts.environment ?? "sandbox", webhookSignatureKey: HOOK_KEY },
      x402: { network: "eip155:84532" },
    },
  });
  return { square, sent, host, store };
}

/** Sign in with Square as `code`'s merchant, and land on the next page. */
async function signIn(b: ReturnType<typeof browser>, code = "good-code", next = "") {
  const start = await b.go(`/connect/square/start${next}`);
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  return b.go(`/connect/square/callback?code=${code}&state=${state}`);
}

/** The whole wizard for location L1, ending on the done page. */
async function signUp(b: ReturnType<typeof browser>, payments: Record<string, string> = { wallet: WALLET }) {
  await signIn(b);
  const csrf = csrfIn(await (await b.go("/connect/location")).text());
  const created = await b.form("/connect/location", { locationId: "L1", csrf });
  const paymentsPath = created.headers.get("location")!;
  const done = await b.form(paymentsPath, { csrf, ...payments });
  return { slug: new URL(paymentsPath, HOST).searchParams.get("venue")!, done, csrf };
}

test("signup: Sign in with Square, pick a location, add a wallet, and the venue runs on its Square menu", async () => {
  const { host, square } = setup();
  const b = browser(host.app);

  assert.match(await (await b.go("/connect")).text(), /Sign in with Square/);
  const start = await b.go("/connect/square/start");
  assert.equal(start.status, 302);
  const authorize = new URL(start.headers.get("location")!);
  assert.equal(authorize.origin + authorize.pathname, "https://connect.squareupsandbox.com/oauth2/authorize");
  assert.equal(authorize.searchParams.get("client_id"), APP_ID);
  assert.equal(authorize.searchParams.get("scope"), "MERCHANT_PROFILE_READ ITEMS_READ ORDERS_READ ORDERS_WRITE PAYMENTS_READ PAYMENTS_WRITE");
  assert.equal(authorize.searchParams.get("session"), null, "sandbox ignores session; production sends false");

  const forged = await b.go("/connect/square/callback?code=good-code&state=not-the-one");
  assert.equal(forged.status, 400, "a state that isn't this browser's is refused");
  assert.equal(square.tokens.size, 0);
  assert.match(await (await b.go("/connect/square/callback?error=access_denied")).text(), /Not connected/);

  const back = await signIn(b);
  assert.equal(back.headers.get("location"), "/connect/location");
  const choose = await (await b.go("/connect/location")).text();
  assert.match(choose, /Crown St/);
  assert.match(choose, /12 Crown St, Surry Hills NSW 2010/);
  assert.doesNotMatch(choose, /Closed/, "inactive locations aren't offered");

  const csrf = csrfIn(choose);
  const created = await b.form("/connect/location", { locationId: "L1", csrf });
  assert.equal(created.headers.get("location"), "/connect/payments?venue=corner-cafe");
  const catalog = (await (await host.app.request(`${HOST}/v/corner-cafe/api/catalog`)).json()) as {
    merchant: { name: string; location: { name: string; address?: string } };
    currency: string;
    items: { id: string; priceCents: number }[];
    payments: { test: boolean; x402: unknown };
  };
  assert.equal(catalog.merchant.name, "Corner Café");
  assert.equal(catalog.merchant.location.address, "12 Crown St, Surry Hills NSW 2010", "the profile comes from Square");
  assert.equal(catalog.currency, "aud");
  assert.deepEqual(catalog.items.map((i) => [i.id, i.priceCents]), [["V1", 520]], "the menu comes from Square");
  assert.equal(catalog.payments.test, true, "test mode until there's a wallet");

  const bad = await b.form("/connect/payments?venue=corner-cafe", { csrf, wallet: "not-a-wallet" });
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /isn&#39;t a wallet address/);

  const paid = await b.form("/connect/payments?venue=corner-cafe", { csrf, wallet: WALLET });
  assert.equal(paid.headers.get("location"), "/connect/done?venue=corner-cafe");
  const live = (await (await host.app.request(`${HOST}/v/corner-cafe/api/catalog`)).json()) as { payments: { test: boolean; x402: { payTo: string; network: string } } };
  assert.deepEqual([live.payments.test, live.payments.x402.payTo, live.payments.x402.network], [false, WALLET, "eip155:84532"]);

  const done = await (await b.go("/connect/done?venue=corner-cafe")).text();
  const staffKey = done.match(/<code>([A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})<\/code>/)![1];
  assert.match(done, /Corner Café is live/);
  assert.doesNotMatch(await (await b.go("/connect/done?venue=corner-cafe")).text(), new RegExp(staffKey), "the staff key is shown once");
  const staff = await host.app.request(`${HOST}/v/corner-cafe/api/staff/orders`, { headers: { "x-collect-staff-key": staffKey } });
  assert.equal(staff.status, 200, "and it opens the staff API");
  host.stop();
});

test("signup: Square's one webhook reaches the right venue, which sends the receipt first and the QR when it's ready", async () => {
  const { host, square, sent } = setup();
  const b = browser(host.app);
  const { slug } = await signUp(b, { wallet: "", test: "1" });
  const venue = host.venue(slug)!;
  const res = await host.app.request(`${HOST}/v/${slug}/api/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items: [{ id: "V1", qty: 1 }], email: "robin@example.com", rail: "test" }),
  });
  const { order } = (await res.json()) as { order: { id: string } };
  await venue.flushConnectors();
  assert.equal(sent.at(-1)!.subject, "Receipt: your Corner Café order");
  const [sq] = [...square.orders.values()];

  const event = JSON.stringify({
    merchant_id: "M1",
    type: "order.fulfillment.updated",
    data: { object: { order_fulfillment_updated: { order_id: sq.id, location_id: "L1", fulfillment_update: [{ new_state: "PREPARED" }] } } },
  });
  const sign = (body: string, key = HOOK_KEY) => createHmac("sha256", key).update(`${HOST}/connect/square/webhook${body}`).digest("base64");
  const forged = await host.app.request(`${HOST}/connect/square/webhook`, { method: "POST", headers: { "x-square-hmacsha256-signature": sign(event, "wrong") }, body: event });
  assert.equal(forged.status, 401);
  const hook = await host.app.request(`${HOST}/connect/square/webhook`, { method: "POST", headers: { "x-square-hmacsha256-signature": sign(event) }, body: event });
  assert.equal(hook.status, 200);
  const ready = (await (await host.app.request(`${HOST}/v/${slug}/api/orders/${order.id}`)).json()) as { order: { status: string } };
  assert.equal(ready.order.status, "ready");
  assert.equal(sent.at(-1)!.subject, "Ready to collect: Corner Café order");
  assert.match(sent.at(-1)!.html, /cid:pickup-qr/);

  // The seller disconnects agentPickup in Square: the venue stops using their tokens.
  const revoked = JSON.stringify({ merchant_id: "M1", type: "oauth.authorization.revoked", data: { type: "revocation" } });
  await host.app.request(`${HOST}/connect/square/webhook`, { method: "POST", headers: { "x-square-hmacsha256-signature": sign(revoked) }, body: revoked });
  const admin = (await (await host.app.request(`${HOST}/host/v1/venues/${slug}`, { headers: { Authorization: "Bearer admin" } })).json()) as {
    venue: { settings: { square: { revokedAt?: number } }; secretsSet: { square: boolean; squareRenewal: boolean } };
  };
  assert.equal(typeof admin.venue.settings.square.revokedAt, "number");
  assert.deepEqual([admin.venue.secretsSet.square, admin.venue.secretsSet.squareRenewal], [false, false]);
  host.stop();
});

test("signup: Square access is renewed once it's a week old, for all of a seller's venues at once", async () => {
  const { host, square } = setup();
  const b = browser(host.app);
  const { slug } = await signUp(b);
  // A second location for the same seller.
  const csrf = csrfIn(await (await b.go("/connect/location")).text());
  await b.form("/connect/location", { locationId: "L2", csrf });
  const before = square.tokens.get("M1");

  assert.deepEqual(await host.renewSquareTokens(Date.now() + 2 * DAY), [], "not due yet");
  assert.deepEqual(await host.renewSquareTokens(Date.now() + 8 * DAY), ["M1"]);
  assert.equal(square.refreshes, 1, "one renewal covers both venues");
  assert.notEqual(square.tokens.get("M1"), before, "Square now accepts only the new token");
  // Both venues still reach Square with the renewed token.
  for (const s of [slug, "corner-cafe-2"]) assert.deepEqual(await host.venue(s)!.syncCatalog(), [{ connector: "square", items: 1 }]);
  host.stop();
});

test("signup: after a switch to a production Square app, sandbox venues aren't renewed with it", async () => {
  const sandbox = setup();
  await signUp(browser(sandbox.host.app));
  sandbox.host.stop();
  // The same install, restarted with the production app's keys.
  const prod = setup({ environment: "production", store: sandbox.store, square: sandbox.square });
  await prod.host.ready;
  sandbox.square.calls.length = 0;
  assert.deepEqual(await prod.host.renewSquareTokens(Date.now() + 8 * DAY), []);
  assert.deepEqual(sandbox.square.calls.filter((c) => c.endsWith("/oauth2/token")), [], "the production app can't renew a sandbox seller's tokens, so it doesn't try");
  prod.host.stop();
});

test("seller page: only the seller who connected a venue can change it, and disconnecting the last one ends Square access", async () => {
  const { host, square } = setup();
  const b = browser(host.app);
  const { slug } = await signUp(b);

  const fresh = browser(host.app);
  assert.match(await (await fresh.go("/seller")).text(), /Sign in with Square/);

  const page = await (await b.go("/seller")).text();
  assert.match(page, /Corner Café/);
  const csrf = csrfIn(page);
  const saved = await b.form(`/seller/venues/${slug}`, { csrf, brandColor: "#123456", wallet: WALLET });
  assert.match(saved.headers.get("location")!, /saved=corner-cafe/);
  const catalog = (await (await host.app.request(`${HOST}/v/${slug}/api/catalog`)).json()) as { merchant: { brandColor: string } };
  assert.equal(catalog.merchant.brandColor, "#123456");
  const directory = (await (await host.app.request(`${HOST}/directory/v1/shops`)).json()) as { shops: unknown[] };
  assert.equal(directory.shops.length, 0, "unticking the directory box takes it out");

  await b.form(`/seller/venues/${slug}`, { csrf: "forged", brandColor: "#ff0000", wallet: WALLET, listed: "1" });
  assert.equal(((await (await host.app.request(`${HOST}/v/${slug}/api/catalog`)).json()) as { merchant: { brandColor: string } }).merchant.brandColor, "#123456", "a form without the session's token changes nothing");

  // Another Square seller signs in: they can't touch this venue.
  const other = browser(host.app);
  await signIn(other, "other-code", "?next=seller");
  const otherCsrf = csrfIn(await (await other.go("/seller")).text());
  await other.form(`/seller/venues/${slug}`, { csrf: otherCsrf, brandColor: "#ff0000", wallet: WALLET, listed: "1" });
  assert.equal(((await (await host.app.request(`${HOST}/v/${slug}/api/catalog`)).json()) as { merchant: { brandColor: string } }).merchant.brandColor, "#123456");

  const keyPage = await (await b.form(`/seller/venues/${slug}/staff-key`, { csrf })).text();
  const staffKey = keyPage.match(/<code>([A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})<\/code>/)![1];
  assert.equal((await host.app.request(`${HOST}/v/${slug}/api/staff/orders`, { headers: { "x-collect-staff-key": staffKey } })).status, 200);

  await b.form(`/seller/venues/${slug}/disconnect`, { csrf });
  assert.ok(host.venue(slug), "without ticking the box nothing happens");
  await b.form(`/seller/venues/${slug}/disconnect`, { csrf, sure: "1" });
  assert.equal(host.venue(slug), null);
  assert.deepEqual(square.revoked, ["M1"]);
  host.stop();
});

test("signup: a seller on another system leaves their email, and the platform sees it", async () => {
  const { host } = setup();
  const b = browser(host.app);
  const thanks = await b.form("/connect/request", { system: "Lightspeed", email: "owner@cafe.test" });
  assert.match(await thanks.text(), /Lightspeed/);
  assert.equal((await b.form("/connect/request", { system: "Lightspeed", email: "nope" })).status, 400);
  const { requests } = (await (await host.app.request(`${HOST}/host/v1/requests`, { headers: { Authorization: "Bearer admin" } })).json()) as {
    requests: { system: string; email: string }[];
  };
  assert.deepEqual(requests.map((r) => [r.system, r.email]), [["Lightspeed", "owner@cafe.test"]]);
  host.stop();
});

test("signup: without a currency converter, an AUD venue can't add a wallet, and says why", async () => {
  const { host } = setup({ converts: false });
  const b = browser(host.app);
  const { slug, done, csrf } = await signUp(b);
  assert.equal(done.status, 400);
  assert.match(await done.text(), /your prices are in AUD/);
  const catalog = (await (await host.app.request(`${HOST}/v/${slug}/api/catalog`)).json()) as { payments: { test: boolean; x402: unknown } };
  assert.deepEqual([catalog.payments.test, catalog.payments.x402], [true, null], "still running, in test mode");
  assert.match(await (await b.go(`/connect/payments?venue=${slug}`)).text(), /can't be taken for AUD prices here yet/);
  assert.equal((await b.form(`/connect/payments?venue=${slug}`, { csrf })).status, 302, "going on without a wallet works");
  host.stop();
});

test("exchange rates: AUD to US cents at the day's rate, kept for an hour, and the last rates used if the source is down", async () => {
  let calls = 0;
  let down = false;
  const fake = (async () => {
    calls++;
    if (down) return new Response("no", { status: 503 });
    return Response.json({ amount: 1, base: "USD", date: "2026-11-02", rates: { AUD: 1.4269 } });
  }) as unknown as typeof fetch;
  const convert = fxToUsdCents({ fetch: fake, maxAgeMs: 0 });
  assert.equal(Math.round(await convert(520, "aud")), 364);
  assert.equal(await convert(500, "usd"), 500, "US dollars need no rate");
  down = true;
  assert.equal(Math.round(await convert(1000, "AUD")), 701, "the source is down: yesterday's rate still serves");
  await assert.rejects(convert(100, "XYZ"), /No exchange rate for XYZ/);
  const cached = fxToUsdCents({ fetch: fake });
  down = false;
  calls = 0;
  await cached(100, "AUD");
  await cached(200, "AUD");
  assert.equal(calls, 1, "one fetch an hour");
  await assert.rejects(fxToUsdCents({ fetch: (async () => new Response("no", { status: 503 })) as unknown as typeof fetch })(100, "AUD"), /Exchange rates answered 503/);
});
