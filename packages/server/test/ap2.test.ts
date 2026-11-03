import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, type JsonWebKey, type KeyObject } from "node:crypto";
import { b64u, jcs, sha256b64u, signCompact, verifyCompact } from "../src/jws.js";
import type { PlatformProfile } from "../src/index.js";
import { setupShop } from "./helpers.js";

const AP2 = "dev.ucp.common.payment.ap2_mandate";
const AP2_AGENT = 'profile="https://wallet.test/ucp-profile"';
const PLAIN_AGENT = 'profile="https://plain.test/ucp-profile"';

const es256 = () => generateKeyPairSync("ec", { namedCurve: "P-256" });
const platformKey = es256();
const holderKey = es256();
const strangerKey = es256();
const jwkOf = (k: KeyObject) => k.export({ format: "jwk" }) as JsonWebKey;

const profiles: Record<string, PlatformProfile> = {
  "https://wallet.test/ucp-profile": { capabilities: ["dev.ucp.shopping.checkout", AP2], keys: [{ ...jwkOf(platformKey.publicKey), kid: "plat_1" }] },
  "https://plain.test/ucp-profile": { capabilities: ["dev.ucp.shopping.checkout"], keys: [] },
};

function ap2Shop() {
  const businessKey = es256().privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const shop = setupShop({
    ucp: { ap2: { signingKeyPem: businessKey, resolvePlatform: async (url) => profiles[url] ?? null } },
  });
  let n = 0;
  const send = (method: string, path: string, body: unknown, agent = AP2_AGENT) =>
    shop.call(`/ucp/v1${path}`, {
      method,
      headers: { "Content-Type": "application/json", "UCP-Agent": agent, "Idempotency-Key": `k${++n}`, "Request-Id": `r${n}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { ...shop, send };
}

type Checkout = Record<string, unknown> & { id: string; status: string; ap2?: { merchant_authorization: string }; order?: { id: string } };

async function checkout(shop: ReturnType<typeof ap2Shop>, agent = AP2_AGENT, qty = 1): Promise<Checkout> {
  const created = (await (await shop.send("POST", "/checkout-sessions", { line_items: [{ item: { id: "flat-white" }, quantity: qty }] }, agent)).json()) as Checkout;
  const ready = await shop.send(
    "PUT",
    `/checkout-sessions/${created.id}`,
    {
      line_items: [{ item: { id: "flat-white" }, quantity: qty }],
      buyer: { email: "buyer@example.com" },
      fulfillment: { methods: [{ type: "pickup", selected_destination_id: "loc_main" }] },
    },
    agent,
  );
  return (await ready.json()) as Checkout;
}

/** What a wallet platform does: wrap our signed checkout in an SD-JWT checkout mandate with key binding. */
function mandateFor(chk: Checkout, o: { signer?: KeyObject; kid?: string; exp?: number; aud?: string } = {}) {
  const [h, , sig] = chk.ap2!.merchant_authorization.split(".");
  const { ap2: _ap2, ...withoutAp2 } = chk;
  const checkoutJwt = `${h}.${b64u(jcs(withoutAp2))}.${sig}`;
  const disclosure = b64u(JSON.stringify([randomBytes(12).toString("base64url"), "checkout_jwt", checkoutJwt]));
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    vct: "mandate.checkout.1",
    _sd: [sha256b64u(disclosure)],
    _sd_alg: "sha-256",
    checkout_hash: sha256b64u(checkoutJwt),
    iat: now,
    exp: o.exp ?? now + 600,
    cnf: { jwk: jwkOf(holderKey.publicKey) },
  };
  const issuerJwt = signCompact({ alg: "ES256", kid: o.kid ?? "plat_1", typ: "dc+sd-jwt" }, b64u(JSON.stringify(claims)), o.signer ?? platformKey.privateKey);
  const presented = `${issuerJwt}~${disclosure}~`;
  const kb = signCompact(
    { alg: "ES256", typ: "kb+jwt" },
    b64u(JSON.stringify({ iat: now, aud: o.aud ?? "https://shop.test", nonce: "n1", sd_hash: sha256b64u(presented) })),
    holderKey.privateKey,
  );
  return presented + kb;
}

const testPayment = { instruments: [{ id: "i1", handler_id: "agentpickup_test", type: "test", selected: true }] };
const complete = (shop: ReturnType<typeof ap2Shop>, chk: Checkout, mandate?: string, agent = AP2_AGENT) =>
  shop.send("POST", `/checkout-sessions/${chk.id}/complete`, { payment: testPayment, ...(mandate ? { ap2: { checkout_mandate: mandate } } : {}) }, agent);
const codeOf = async (res: Response) => ((await res.json()) as { messages: { code: string }[] }).messages[0].code;

test("the profile advertises AP2 mandates and publishes the business ES256 key", async () => {
  const shop = ap2Shop();
  const profile = (await (await shop.call("/.well-known/ucp")).json()) as { ucp: { capabilities: Record<string, unknown> }; keys: JsonWebKey[] };
  assert.ok(profile.ucp.capabilities[AP2]);
  assert.equal(profile.keys[0].kty, "EC");
  assert.equal(profile.keys[0].crv, "P-256");
});

test("with an AP2 platform, every checkout carries a merchant signature over the JCS checkout", async () => {
  const shop = ap2Shop();
  const chk = await checkout(shop);
  assert.equal(chk.status, "ready_for_complete");
  const auth = chk.ap2!.merchant_authorization;
  assert.match(auth, /^[A-Za-z0-9_-]+\.\.[A-Za-z0-9_-]+$/);
  const profile = (await (await shop.call("/.well-known/ucp")).json()) as { keys: JsonWebKey[] };
  const [h, , s] = auth.split(".");
  const { ap2: _ap2, ...withoutAp2 } = chk;
  assert.ok(verifyCompact(`${h}.${b64u(jcs(withoutAp2))}.${s}`, profile.keys[0]), "detached JWS verifies with the published key");
});

test("completing a locked session needs a checkout mandate", async () => {
  const shop = ap2Shop();
  const chk = await checkout(shop);
  const res = await complete(shop, chk);
  assert.equal(res.status, 400);
  assert.equal(await codeOf(res), "mandate_required");
});

test("a valid mandate completes the order and is kept as evidence", async () => {
  const shop = ap2Shop();
  const chk = await checkout(shop);
  const mandate = mandateFor(chk);
  const res = await complete(shop, chk, mandate);
  assert.equal(res.status, 200);
  const done = (await res.json()) as Checkout;
  assert.equal(done.status, "completed");
  const paid = shop.store.listEvents(done.order!.id).find((e) => e.type === "order.paid")!;
  assert.equal(paid.data?.ap2CheckoutMandate, mandate);
});

test("a mandate signed for earlier terms is refused", async () => {
  const shop = ap2Shop();
  const chk = await checkout(shop, AP2_AGENT, 1);
  const stale = mandateFor(chk);
  await shop.send("PUT", `/checkout-sessions/${chk.id}`, {
    line_items: [{ item: { id: "flat-white" }, quantity: 3 }],
    fulfillment: { methods: [{ type: "pickup", selected_destination_id: "loc_main" }] },
  });
  const res = await complete(shop, chk, stale);
  assert.equal(res.status, 400);
  assert.equal(await codeOf(res), "mandate_scope_mismatch");
});

test("mandates from unknown keys, expired mandates and mis-addressed key bindings are refused", async () => {
  const shop = ap2Shop();
  const chk = await checkout(shop);
  assert.equal(await codeOf(await complete(shop, chk, mandateFor(chk, { kid: "nope" }))), "agent_missing_key");
  assert.equal(await codeOf(await complete(shop, chk, mandateFor(chk, { signer: strangerKey.privateKey }))), "mandate_invalid_signature");
  assert.equal(await codeOf(await complete(shop, chk, mandateFor(chk, { exp: Math.floor(Date.now() / 1000) - 10 }))), "mandate_expired");
  assert.equal(await codeOf(await complete(shop, chk, mandateFor(chk, { aud: "https://other-shop.test" }))), "mandate_scope_mismatch");
  assert.equal(shop.store.listOrders({ statuses: ["paid"] }).length, 0);
});

test("platforms without AP2 get unsigned checkouts and complete without a mandate", async () => {
  const shop = ap2Shop();
  const chk = await checkout(shop, PLAIN_AGENT);
  assert.equal(chk.ap2, undefined);
  assert.equal((await complete(shop, chk, undefined, PLAIN_AGENT)).status, 200);
});
