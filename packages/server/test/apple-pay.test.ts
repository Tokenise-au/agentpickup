import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { APPLE_PAY_DOMAIN_PATH, appleDomainAssociation } from "../src/index.js";

const FILE = new TextEncoder().encode('7B227073704964223A22...'); // Square's file is hex-encoded JSON

function serve(opts: { ttlMs?: number; failing?: () => boolean } = {}) {
  let calls = 0;
  const fetch = (async (input: string | URL | Request) => {
    calls++;
    assert.equal(String(input), "https://app.squareup.com/digital-wallets/apple-pay/apple-developer-merchantid-domain-association");
    return opts.failing?.() ? new Response("down", { status: 503 }) : new Response(FILE, { headers: { "Content-Type": "application/octet-stream" } });
  }) as typeof globalThis.fetch;
  const app = new Hono();
  app.get(APPLE_PAY_DOMAIN_PATH, appleDomainAssociation({ fetch, ttlMs: opts.ttlMs }));
  return { get: () => app.request(`https://shop.test${APPLE_PAY_DOMAIN_PATH}`), calls: () => calls };
}

test("apple pay: Square's domain file is served from the domain's root, as bytes, and fetched once an hour", async () => {
  const site = serve();
  const first = await site.get();
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("content-type"), "application/octet-stream");
  assert.deepEqual(new Uint8Array(await first.arrayBuffer()), FILE);
  await site.get();
  assert.equal(site.calls(), 1, "kept for the hour");
  const fresh = serve({ ttlMs: 0 });
  await fresh.get();
  await fresh.get();
  assert.equal(fresh.calls(), 2, "fetched again once it's stale");
});

test("apple pay: with Square down, the last copy is still served, and with none yet the route says so", async () => {
  let down = false;
  const site = serve({ ttlMs: 0, failing: () => down });
  assert.equal((await site.get()).status, 200);
  down = true;
  const stale = await site.get();
  assert.equal(stale.status, 200);
  assert.deepEqual(new Uint8Array(await stale.arrayBuffer()), FILE);
  assert.equal((await serve({ failing: () => true }).get()).status, 503);
});
