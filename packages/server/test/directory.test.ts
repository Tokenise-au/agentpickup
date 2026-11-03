import { test } from "node:test";
import assert from "node:assert/strict";
import { createVenueHost, formatHours, isOpen, searchDirectory, type ShopListing } from "../src/index.js";
import { setupShop, testStore } from "./helpers.js";

const WEEKDAYS = [1, 2, 3, 4, 5].map((day) => ({ day, open: "07:00", close: "15:00" }));

test("opening hours read the way people write them", () => {
  assert.equal(formatHours([...WEEKDAYS, { day: 6, open: "08:00", close: "12:30" }]), "Mon-Fri 7am-3pm, Sat 8am-12:30pm");
  assert.equal(
    formatHours([{ day: 1, open: "07:00", close: "11:00" }, { day: 1, open: "12:00", close: "15:00" }, { day: 3, open: "07:00", close: "15:00" }]),
    "Mon 7am-11am & 12pm-3pm, Wed 7am-3pm",
    "a closed Tuesday splits the run",
  );
  assert.equal(formatHours([{ day: 0, open: "18:00", close: "02:00" }]), "Sun 6pm-2am");
});

test("open now is worked out in the shop's own time zone, including past midnight", () => {
  // Tuesday 9:30am in Sydney (AEDT, UTC+11).
  const tue930 = new Date("2026-11-02T22:30:00Z");
  assert.equal(isOpen(WEEKDAYS, "Australia/Sydney", tue930), true);
  assert.equal(isOpen(WEEKDAYS, "Europe/London", tue930), false, "10:30pm Monday in London");
  assert.equal(isOpen(undefined, "Australia/Sydney", tue930), null, "no hours given");
  // A bar open Monday 6pm to 2am: 1am Tuesday counts.
  const late = [{ day: 1, open: "18:00", close: "02:00" }];
  assert.equal(isOpen(late, "Australia/Sydney", new Date("2026-11-02T14:00:00Z")), true);
  assert.equal(isOpen(late, "Australia/Sydney", new Date("2026-11-02T16:00:00Z")), false);
});

const shop = (name: string, extra: Partial<ShopListing> & { lat?: number; lng?: number; address?: string } = {}): ShopListing => ({
  name,
  url: `https://host.test/v/${name.toLowerCase().replace(/\W+/g, "-")}`,
  location: { name, address: extra.address, lat: extra.lat, lng: extra.lng, openingHours: WEEKDAYS },
  timeZone: "Australia/Sydney",
  currency: "aud",
  payments: { x402: { network: "eip155:8453" }, card: false, test: false },
  testOnly: false,
  items: [
    { id: "fw", name: "Flat white", priceCents: 520 },
    { id: "cr", name: "Croissants", priceCents: 600, description: "Butter, baked here" },
  ],
  ...extra,
});

test("search finds shops by what they sell, where they are, and how far away", () => {
  const listings = [
    shop("Corner Café", { lat: -33.8836, lng: 151.2149, address: "12 Crown St, Surry Hills NSW 2010" }),
    shop("Harbour Kiosk", { lat: -33.8568, lng: 151.2153, address: "1 Circular Quay, Sydney NSW 2000" }),
    shop("Bondi Bakes", {
      lat: -33.8915,
      lng: 151.2767,
      address: "Campbell Pde, Bondi Beach NSW 2026",
      items: [{ id: "sd", name: "Sourdough", priceCents: 900 }],
    }),
    shop("Melbourne Beans", { lat: -37.8136, lng: 144.9631, address: "Collins St, Melbourne VIC 3000" }),
  ];
  const near = { lat: -33.8840, lng: 151.2100 };

  const nearby = searchDirectory(listings, near);
  assert.deepEqual(nearby.map((s) => s.name), ["Corner Café", "Harbour Kiosk", "Bondi Bakes"], "within 10 km, nearest first");
  assert.equal(nearby[0].distanceKm, 0.5);

  const croissant = searchDirectory(listings, { ...near, q: "croissant" });
  assert.deepEqual(croissant.map((s) => s.name), ["Corner Café", "Harbour Kiosk"], "plurals and descriptions match");
  assert.deepEqual(croissant[0].items.map((i) => i.id), ["cr"]);
  assert.equal(croissant[0].itemCount, 2);

  assert.deepEqual(searchDirectory(listings, { q: "coffee", place: "surry hills" }).map((s) => s.name), ["Corner Café"], "coffee finds a flat white");
  assert.deepEqual(searchDirectory(listings, { q: "cafe" }).map((s) => s.name), ["Corner Café"], "accents don't matter");
  assert.deepEqual(searchDirectory(listings, { ...near, radiusKm: 1 }).map((s) => s.name), ["Corner Café"]);
  assert.equal(searchDirectory(listings, { place: "Melbourne" }).length, 1);
  assert.equal(searchDirectory(listings, { q: "caviar" }).length, 0);

  // Tuesday 9:30pm in Sydney: everyone is closed.
  const evening = new Date("2026-11-03T10:30:00Z");
  assert.equal(searchDirectory(listings, { ...near, openNow: true, now: evening }).length, 0);
  assert.equal(searchDirectory(listings, { ...near, now: evening })[0].openNow, false);
});

test("venue host: the public directory lists running, listed venues and the install's own shop", async () => {
  const host = createVenueHost({
    baseUrl: "https://host.test",
    store: testStore(),
    storeFor: () => testStore(),
    mailer: { delivers: false, send: async () => ({ id: "x" }) },
    secretKey: "x".repeat(40),
    adminKeys: ["k"],
    alsoList: [setupShop().collect],
  });
  const put = (slug: string, body: unknown) =>
    host.app.request(`https://host.test/host/v1/venues/${slug}`, {
      method: "PUT",
      headers: { Authorization: "Bearer k", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const venue = (name: string, location: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    merchant: { name, fromEmail: "orders@host.test", location },
    catalog: [{ id: "fw", name: "Flat white", priceCents: 500 }],
    payments: { test: true },
    timeZone: "Australia/Sydney",
    ...extra,
  });
  assert.equal((await put("corner", venue("Corner Café", { name: "Counter", address: "12 Crown St, Surry Hills", lat: -33.8836, lng: 151.2149, openingHours: WEEKDAYS }))).status, 200);
  assert.equal((await put("quiet", venue("Quiet Café", { name: "Counter", lat: -33.8837, lng: 151.215 }, { listed: false }))).status, 200);
  const bad = await put("nowhere", venue("Nowhere", { name: "Counter", lat: 200, lng: 0 }));
  assert.equal(bad.status, 400);
  assert.match(((await bad.json()) as { error: string }).error, /lat/);
  const badHours = await put("nowhere", venue("Nowhere", { name: "Counter", openingHours: [{ day: 9, open: "7am", close: "3pm" }] }));
  assert.equal(badHours.status, 400);

  const get = (q: string) => host.app.request(`https://host.test/directory/v1/shops${q}`);
  const all = (await (await get("")).json()) as { shops: (ShopListing & { distanceKm?: number })[] };
  assert.deepEqual(all.shops.map((s) => s.name).sort(), ["Corner Café", "Test Café"], "the unlisted venue stays out");

  const res = await get("?lat=-33.884&lng=151.21&q=flat%20white");
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  const { shops } = (await res.json()) as { shops: (ShopListing & { distanceKm?: number; openNow: boolean | null })[] };
  assert.equal(shops.length, 1, "the install's shop has no map position, so it isn't 'near'");
  assert.equal(shops[0].url, "https://host.test/v/corner");
  assert.equal(shops[0].location.address, "12 Crown St, Surry Hills");
  assert.equal(shops[0].testOnly, true);
  assert.equal(typeof shops[0].distanceKm, "number");

  assert.equal((await get("?lat=abc&lng=1")).status, 400);
  assert.equal((await get("?lat=1")).status, 400);
  host.stop();
});

test("venue host: a Square venue with its webhook set up sends the receipt first, unless it says otherwise", async () => {
  const answers: Record<string, unknown> = {
    locations: { location: { name: "Main" } },
    catalog: { objects: [] },
    orders: { order: { id: "SQ1", version: 1, state: "OPEN", fulfillments: [{ uid: "F1" }] } },
    payments: { payment: { id: "P1" } },
  };
  const square = async (input: string | URL | Request) => Response.json(answers[new URL(String(input)).pathname.split("/")[2]] ?? {});
  const subjects: string[] = [];
  const host = createVenueHost({
    baseUrl: "https://host.test",
    store: testStore(),
    storeFor: () => testStore(),
    mailer: { delivers: true, send: async (m) => (subjects.push(m.subject), { id: "x" }) },
    secretKey: "x".repeat(40),
    adminKeys: ["k"],
    fetch: square as typeof fetch,
  });
  const base = { merchant: { name: "Sq", fromEmail: "o@host.test" }, catalog: [{ id: "a", name: "A", priceCents: 100 }], payments: { test: true } };
  const firstSubject = async (slug: string, body: Record<string, unknown>) => {
    await host.app.request(`https://host.test/host/v1/venues/${slug}`, {
      method: "PUT",
      headers: { Authorization: "Bearer k", "Content-Type": "application/json" },
      body: JSON.stringify({ ...base, ...body }),
    });
    await host.app.request(`https://host.test/v/${slug}/api/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: [{ id: "a", qty: 1 }], email: "robin@example.com", rail: "test" }),
    });
    return subjects.at(-1);
  };
  assert.equal(await firstSubject("hooked", { square: { locationId: "L1", accessToken: "t", webhookSignatureKey: "s" } }), "Receipt: your Sq order");
  assert.equal(
    await firstSubject("unhooked", { square: { locationId: "L1", accessToken: "t" } }),
    "Your Sq order: show this QR to collect",
    "without the webhook nobody tells us it's ready",
  );
  assert.equal(
    await firstSubject("chosen", { qrEmail: "with-receipt", square: { locationId: "L1", accessToken: "t", webhookSignatureKey: "s" } }),
    "Your Sq order: show this QR to collect",
  );
  assert.equal(await firstSubject("by-hand", { qrEmail: "when-ready" }), "Receipt: your Sq order");
  host.stop();
});
