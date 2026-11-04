import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeSignedOffers,
  extractOffersFromPaymentRequired,
  verifyOfferSignatureJWS,
  verifyReceiptSignatureJWS,
  type JWSSignedReceipt,
} from "@x402/extensions/offer-receipt";
import { appendPaymentIdentifierToExtensions, PAYMENT_IDENTIFIER } from "@x402/extensions/payment-identifier";
import { createSIWxPayload, encodeSIWxHeader, SIGN_IN_WITH_X } from "@x402/extensions/sign-in-with-x";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { agentBuys, makeAgent, NETWORK, setupShop } from "./helpers.js";

async function publicJwk(shop: ReturnType<typeof setupShop>) {
  const jwks = (await (await shop.call("/.well-known/collect-keys.json")).json()) as { keys: Record<string, string>[] };
  return jwks.keys[0] as Record<string, string> & { kty: string };
}

test("the 402 carries bazaar discovery, a signed offer and the payment-identifier declaration", async () => {
  const shop = setupShop();
  const { required } = await agentBuys(shop, makeAgent());
  const ext = required.extensions as Record<string, unknown>;
  assert.ok(ext.bazaar, "bazaar discovery declared");
  assert.ok(ext[PAYMENT_IDENTIFIER], "payment-identifier declared");

  const offers = extractOffersFromPaymentRequired(required);
  assert.equal(offers.length, 1);
  const [decoded] = decodeSignedOffers(offers);
  assert.equal(decoded.amount, required.accepts[0].amount);
  const verified = await verifyOfferSignatureJWS(offers[0] as never, await publicJwk(shop));
  assert.equal(verified.payTo.toLowerCase(), required.accepts[0].payTo.toLowerCase());
});

test("a paid order returns a receipt signed by the shop's key", async () => {
  const shop = setupShop();
  const agent = makeAgent();
  const { paid } = await agentBuys(shop, agent);
  const body = (await paid.json()) as { receipt: JWSSignedReceipt };
  assert.equal(body.receipt.format, "jws");
  const receipt = await verifyReceiptSignatureJWS(body.receipt, await publicJwk(shop));
  assert.equal(receipt.payer.toLowerCase(), agent.address.toLowerCase());
  assert.match(receipt.transaction ?? "", /^0x[0-9a-f]{64}$/);
  assert.match(receipt.resourceUrl, /\/api\/orders\/ord_[^/]+\/pay$/);
});

test("the did:web document publishes the same key as the JWKS", async () => {
  const shop = setupShop();
  const did = (await (await shop.call("/.well-known/did.json")).json()) as {
    id: string;
    verificationMethod: { id: string; publicKeyJwk: Record<string, string> }[];
  };
  assert.equal(did.id, "did:web:shop.test");
  assert.deepEqual(did.verificationMethod[0].publicKeyJwk, await publicJwk(shop));
});

test("retrying the same payment with a payment-identifier returns the original result", async () => {
  const shop = setupShop();
  const agent = makeAgent();
  const created = await shop.post("/api/orders", { items: [{ id: "flat-white", qty: 1 }], email: "a@b.co", rail: "x402" });
  const { next } = (await created.json()) as { next: { url: string } };
  const path = new URL(next.url).pathname;
  const challenge = await shop.call(path, { method: "POST" });
  const required = agent.http.getPaymentRequiredResponse((n) => challenge.headers.get(n));
  const payload = await agent.http.createPaymentPayload(required);
  // Deep copy: the helper fills in the declaration object, which the next payment would otherwise reuse.
  const ext: Record<string, unknown> = structuredClone(required.extensions ?? {});
  appendPaymentIdentifierToExtensions(ext, "pay_retry_test_0001");
  payload.extensions = { ...(payload.extensions ?? {}), [PAYMENT_IDENTIFIER]: ext[PAYMENT_IDENTIFIER] };
  const headers = agent.http.encodePaymentSignatureHeader(payload);

  const first = await shop.call(path, { method: "POST", headers });
  assert.equal(first.status, 200);
  const retry = await shop.call(path, { method: "POST", headers });
  assert.equal(retry.status, 200);
  const replayed = (await retry.json()) as { replayed: boolean; passUrl: string };
  assert.equal(replayed.replayed, true);
  assert.equal(shop.facilitator.settled.length, 1, "settled once");

  // A different payment for the same order is still a conflict.
  const fresh = await agent.http.createPaymentPayload(required);
  const other = await shop.call(path, { method: "POST", headers: agent.http.encodePaymentSignatureHeader(fresh) });
  assert.equal(other.status, 409);
});

async function signIn(shop: ReturnType<typeof setupShop>, orderId: string, account: ReturnType<typeof privateKeyToAccount>) {
  const url = `https://shop.test/api/orders/${orderId}/pass`;
  const challenge = await shop.call(`/api/orders/${orderId}/pass`);
  assert.equal(challenge.status, 402);
  const body = (await challenge.json()) as { extensions: Record<string, { info: Record<string, string>; supportedChains: { chainId: string; type: string }[] }> };
  const ext = body.extensions[SIGN_IN_WITH_X];
  const chain = ext.supportedChains.find((c) => c.chainId === NETWORK)!;
  const payload = await createSIWxPayload({ ...ext.info, chainId: chain.chainId, type: chain.type } as never, account as never, url);
  return encodeSIWxHeader(payload);
}

test("the paying wallet can fetch its pass again with Sign-In-With-X", async () => {
  const shop = setupShop();
  const key = generatePrivateKey();
  const account = privateKeyToAccount(key);
  const agent = makeAgent(key);
  const { orderId } = await agentBuys(shop, agent);

  const header = await signIn(shop, orderId, account);
  const ok = await shop.call(`/api/orders/${orderId}/pass`, { headers: { "SIGN-IN-WITH-X": header } });
  assert.equal(ok.status, 200);
  const pass = (await ok.json()) as { passUrl: string; pickupCode: string; qrContent: string };
  assert.match(pass.passUrl, /\/p\//);
  assert.match(pass.pickupCode, /^[2-9A-HJKMNP-Z]{6}$/);

  const replay = await shop.call(`/api/orders/${orderId}/pass`, { headers: { "SIGN-IN-WITH-X": header } });
  assert.equal(replay.status, 401, "a sign-in can't be replayed");
});

test("another wallet can't fetch the pass, and a sign-in can't be moved to another order", async () => {
  const shop = setupShop();
  const { orderId } = await agentBuys(shop, makeAgent());
  const stranger = privateKeyToAccount(generatePrivateKey());
  const header = await signIn(shop, orderId, stranger);
  const res = await shop.call(`/api/orders/${orderId}/pass`, { headers: { "SIGN-IN-WITH-X": header } });
  assert.equal(res.status, 403);

  const key = generatePrivateKey();
  const a = await agentBuys(shop, makeAgent(key));
  const b = await agentBuys(shop, makeAgent(key));
  const forA = await signIn(shop, a.orderId, privateKeyToAccount(key));
  const moved = await shop.call(`/api/orders/${b.orderId}/pass`, { headers: { "SIGN-IN-WITH-X": forA } });
  assert.equal(moved.status, 401);
});

test("openapi.json describes the paid route and the sign-in route for x402scan", async () => {
  const shop = setupShop();
  const doc = (await (await shop.call("/openapi.json")).json()) as {
    info: Record<string, unknown>;
    paths: Record<string, Record<string, Record<string, unknown>>>;
    components: { securitySchemes: Record<string, unknown> };
  };
  assert.ok(doc.info["x-guidance"]);
  const pay = doc.paths["/api/orders/{id}/pay"].post;
  assert.deepEqual((pay["x-payment-info"] as { protocols: unknown[] }).protocols, [{ x402: {} }]);
  assert.ok((pay.responses as Record<string, unknown>)["402"]);
  assert.deepEqual(doc.paths["/api/orders/{id}/pass"].get.security, [{ siwx: [] }]);
  assert.deepEqual(doc.paths["/api/orders"].post.security, []);
  assert.ok(doc.components.securitySchemes.siwx);
  // The fixed order address is described too: x402scan registers only URLs in this document.
  const order = doc.paths["/api/x402/order"];
  for (const method of ["get", "post"]) {
    assert.deepEqual((order[method]["x-payment-info"] as { protocols: unknown[] }).protocols, [{ x402: {} }], method);
    assert.ok((order[method].responses as Record<string, unknown>)["402"], method);
  }
  assert.deepEqual((order.get.parameters as { name: string }[]).map((p) => p.name), ["items", "name"]);
});
