import { test } from "node:test";
import assert from "node:assert/strict";
import { generateSigningKeyPem } from "@agentpickup/core";
import { createCollect, createVenueHost, outboxMailer } from "../src/index.js";
import { CATALOG, testStore } from "./helpers.js";

const HOST = "https://host.test";

/** The internet, as the directory sees it: another site's agentPickup shop, a UCP shop, and whatever a test needs. */
function web() {
  const corner = createCollect({
    baseUrl: "https://corner.test",
    merchant: { name: "Corner Café", fromEmail: "orders@corner.test", location: { name: "Counter", address: "12 Crown St, Surry Hills", lat: -33.8836, lng: 151.2149 } },
    catalog: CATALOG,
    store: testStore(),
    mailer: outboxMailer(),
    signingKeyPem: generateSigningKeyPem(),
    payments: { test: true },
  });
  const pages = new Map<string, () => Response>();
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const page = pages.get(url.href);
    if (page) return page();
    if (url.host === "corner.test") return corner.app.fetch(new Request(url, init));
    return new Response("not found", { status: 404 });
  }) as typeof globalThis.fetch;
  return { corner, pages, fetch };
}

const ucpListing = {
  agentpickup: "listing/1",
  name: "Bondi Bakes",
  url: "https://bakes.test",
  location: { name: "Front counter", address: "Campbell Pde, Bondi Beach", lat: -33.8915, lng: 151.2767, openingHours: [{ day: 1, open: "07:00", close: "15:00" }] },
  timeZone: "Australia/Sydney",
  currency: "aud",
  payments: { x402: null, card: false, test: false, protocols: ["ucp"] },
  items: [{ id: "sd", name: "Sourdough", priceCents: 900 }],
  order: { via: "ucp", profile: "https://bakes.test/.well-known/ucp" },
};

function hostWith(w: ReturnType<typeof web>, listings?: { recheckHours?: number }) {
  return createVenueHost({
    baseUrl: HOST,
    store: testStore(),
    storeFor: () => testStore(),
    mailer: outboxMailer(),
    secretKey: "x".repeat(40),
    adminKeys: ["admin"],
    fetch: w.fetch,
    ...(listings ? { listings } : {}),
  });
}
const register = (host: ReturnType<typeof hostWith>, url: string) =>
  host.app.request(`${HOST}/directory/v1/listings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) });
const shops = async (host: ReturnType<typeof hostWith>, q = "") =>
  ((await (await host.app.request(`${HOST}/directory/v1/shops${q}`)).json()) as { shops: { name: string; url: string; items: { id: string }[]; source?: { kind: string; domain: string }; order?: { via: string }; testOnly: boolean }[] }).shops;

test("listing: every agentPickup shop publishes its own, at its own address", async () => {
  const w = web();
  const doc = (await (await w.corner.app.request("https://corner.test/.well-known/agentpickup.json")).json()) as Record<string, unknown>;
  assert.equal(doc.agentpickup, "listing/1");
  assert.equal(doc.name, "Corner Café");
  assert.equal(doc.url, "https://corner.test");
  assert.deepEqual(doc.order, { via: "agentpickup" });
  assert.deepEqual((doc.location as { lat: number }).lat, -33.8836);
  assert.deepEqual((doc.items as { id: string }[]).map((i) => i.id), ["flat-white", "croissant"]);
  w.corner.stop();
});

test("listing: another site's agentPickup shop registers, shows up with its live menu, and the platform can take it down", async () => {
  const w = web();
  const host = hostWith(w);
  const res = await register(host, "https://corner.test/.well-known/agentpickup.json");
  assert.equal(res.status, 201, await res.clone().text());
  const near = await shops(host, "?lat=-33.884&lng=151.21&q=croissant");
  assert.equal(near.length, 1);
  assert.equal(near[0].name, "Corner Café");
  assert.deepEqual(near[0].source && [near[0].source.kind, near[0].source.domain], ["listed", "corner.test"]);
  assert.deepEqual(near[0].items.map((i) => i.id), ["croissant"], "the menu comes from the shop's live API");
  assert.equal(await host.isListedShop("https://corner.test"), true, "so the hosted MCP server may order from it");

  assert.equal((await register(host, "https://corner.test/.well-known/agentpickup.json")).status, 201);
  const pub = (await (await host.app.request(`${HOST}/directory/v1/listings`)).json()) as { listings: { name: string }[] };
  assert.equal(pub.listings.length, 1, "registering again updates the one entry");

  const admin = (await (await host.app.request(`${HOST}/host/v1/listings`, { headers: { Authorization: "Bearer admin" } })).json()) as { listings: { id: string }[] };
  const del = await host.app.request(`${HOST}/host/v1/listings/${admin.listings[0].id}`, { method: "DELETE", headers: { Authorization: "Bearer admin" } });
  assert.equal(del.status, 200);
  assert.equal((await shops(host)).length, 0);
  assert.equal(await host.isListedShop("https://corner.test"), false);
  host.stop();
  w.corner.stop();
});

test("listing: a shop with its own UCP checkout lists itself, and agents are told to order there", async () => {
  const w = web();
  w.pages.set("https://bakes.test/.well-known/agentpickup.json", () => Response.json(ucpListing));
  const host = hostWith(w);
  assert.equal((await register(host, "https://bakes.test/.well-known/agentpickup.json")).status, 201);
  const [bakes] = await shops(host, "?q=sourdough");
  assert.equal(bakes.order?.via, "ucp");
  assert.equal(bakes.testOnly, false);
  assert.equal(await host.isListedShop("https://bakes.test"), false, "the MCP server can't order through UCP itself");
  host.stop();
  w.corner.stop();
});

test("listing: what the directory refuses to fetch or list", async () => {
  const w = web();
  const host = hostWith(w);
  const refused = async (url: string, why: RegExp) => {
    const res = await register(host, url);
    assert.equal(res.status, 400, url);
    assert.match(((await res.json()) as { error: string }).error, why, url);
  };
  await refused("http://corner.test/.well-known/agentpickup.json", /https/);
  await refused("https://127.0.0.1/listing.json", /domain name, not an IP/);
  await refused("https://localhost/listing.json", /public site/);
  await refused("https://corner.test:8443/listing.json", /standard https port/);
  await refused(`${HOST}/.well-known/agentpickup.json`, /in the directory already/);

  w.pages.set("https://evil.test/listing.json", () => Response.json({ ...ucpListing, url: "https://corner.test", order: { via: "agentpickup" } }));
  await refused("https://evil.test/listing.json", /must be on the listing's own site/);
  w.pages.set("https://bakes.test/no-location.json", () => Response.json({ ...ucpListing, location: undefined }));
  await refused("https://bakes.test/no-location.json", /location\.name/);
  w.pages.set("https://bakes.test/old.json", () => Response.json({ ...ucpListing, agentpickup: "listing/0" }));
  await refused("https://bakes.test/old.json", /listing\/1/);
  w.pages.set("https://bakes.test/moved.json", () => new Response(null, { status: 302, headers: { Location: "https://elsewhere.test/x.json" } }));
  await refused("https://bakes.test/moved.json", /redirects/);
  w.pages.set("https://bakes.test/huge.json", () => new Response(JSON.stringify({ ...ucpListing, padding: "x".repeat(300 * 1024) })));
  await refused("https://bakes.test/huge.json", /over 256 KB/);
  w.pages.set("https://dead.test/.well-known/agentpickup.json", () => Response.json({ ...ucpListing, url: "https://dead.test", order: { via: "agentpickup" }, logoUrl: undefined }));
  await refused("https://dead.test/.well-known/agentpickup.json", /menu at https:\/\/dead\.test\/api\/catalog didn't load/);
  assert.equal((await shops(host)).length, 0);
  host.stop();
  w.corner.stop();
});

test("listing: each listing is checked again, and one that's down for a day is dropped", async () => {
  const w = web();
  let up = true;
  w.pages.set("https://bakes.test/.well-known/agentpickup.json", () => (up ? Response.json(ucpListing) : new Response("down", { status: 503 })));
  const host = hostWith(w, { recheckHours: 6 });
  await register(host, "https://bakes.test/.well-known/agentpickup.json");
  up = false;
  let now = Date.now();
  for (let check = 1; check <= 3; check++) {
    now += 7 * 3600_000;
    await host.recheckListings(now);
    assert.equal((await shops(host)).length, 1, `still listed after ${check} failed check(s)`);
  }
  now += 7 * 3600_000;
  await host.recheckListings(now);
  assert.equal((await shops(host)).length, 0, "dropped after a day of failed checks");
  host.stop();
  w.corner.stop();
});
