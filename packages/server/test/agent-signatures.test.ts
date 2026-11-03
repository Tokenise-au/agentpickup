import { test } from "node:test";
import assert from "node:assert/strict";
import { constants, generateKeyPairSync, randomBytes, sign, type JsonWebKey, type KeyObject } from "node:crypto";
import { jwkThumbprint, parseSignatureInput, signatureBase } from "../src/agent-signatures.js";
import type { AgentSignatureConfig } from "../src/index.js";
import { setupShop } from "./helpers.js";

const ed = generateKeyPairSync("ed25519");
const edJwk = { ...(ed.publicKey.export({ format: "jwk" }) as JsonWebKey), kid: "visa-agent-1" };
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const rsaJwk = { ...(rsa.publicKey.export({ format: "jwk" }) as JsonWebKey), kid: "mc-agent-1", alg: "PS256" };

/** Sign a request the way a TAP / Web Bot Auth agent does (RFC 9421). */
function signed(
  path: string,
  o: {
    key?: KeyObject;
    keyid?: string;
    alg?: string;
    tag?: string;
    created?: number;
    expires?: number;
    nonce?: string;
    components?: string[];
    signPath?: string;
    signatureAgent?: string;
  } = {},
) {
  const now = Math.floor(Date.now() / 1000);
  const components = o.components ?? ["@authority", "@path"];
  const params =
    `(${components.map((c) => `"${c}"`).join(" ")})` +
    `;created=${o.created ?? now};expires=${o.expires ?? now + 300};keyid="${o.keyid ?? "visa-agent-1"}"` +
    `;alg="${o.alg ?? "ed25519"}";nonce="${o.nonce ?? randomBytes(32).toString("base64")}";tag="${o.tag ?? "agent-payer-auth"}"`;
  const headers = new Headers({ "Signature-Input": `sig1=${params}` });
  if (o.signatureAgent) headers.set("Signature-Agent", `"${o.signatureAgent}"`);
  const [member] = parseSignatureInput(`sig1=${params}`);
  const base = signatureBase(member, { method: "POST", url: new URL(`https://shop.test${o.signPath ?? path}`), headers })!;
  const key = o.key ?? ed.privateKey;
  const sig =
    key.asymmetricKeyType === "rsa"
      ? sign("sha256", Buffer.from(base), { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 })
      : sign(null, Buffer.from(base), key);
  headers.set("Signature", `sig1=:${sig.toString("base64")}:`);
  return Object.fromEntries(headers.entries());
}

function sigShop(agentSignatures: AgentSignatureConfig) {
  const shop = setupShop({ ucp: {}, agentSignatures });
  const createCheckout = (headers: Record<string, string> = {}) =>
    shop.call("/ucp/v1/checkout-sessions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "UCP-Agent": 'profile="https://agent.test/profile"',
        "Idempotency-Key": randomBytes(8).toString("hex"),
        ...headers,
      },
      body: JSON.stringify({ line_items: [{ item: { id: "croissant" }, quantity: 1 }] }),
    });
  return { ...shop, createCheckout };
}

test("require mode refuses unsigned agent requests and accepts a valid TAP signature", async () => {
  const shop = sigShop({ mode: "require", keys: [edJwk] });
  assert.equal((await shop.createCheckout()).status, 401);
  const ok = await shop.createCheckout(signed("/ucp/v1/checkout-sessions"));
  assert.equal(ok.status, 201);
  assert.match(ok.headers.get("Agent-Signature") ?? "", /^verified; keyid="visa-agent-1"; tag="agent-payer-auth"/);
});

test("signatures for another path, outside the window, reused, or from unknown keys are refused", async () => {
  const shop = sigShop({ mode: "require", keys: [edJwk] });
  const path = "/ucp/v1/checkout-sessions";
  const now = Math.floor(Date.now() / 1000);
  assert.equal((await shop.createCheckout(signed(path, { signPath: "/somewhere-else" }))).status, 401);
  assert.equal((await shop.createCheckout(signed(path, { created: now - 900, expires: now - 300 }))).status, 401);
  assert.equal((await shop.createCheckout(signed(path, { created: now, expires: now + 3600 }))).status, 401, "TAP caps the window at 8 minutes");
  assert.equal((await shop.createCheckout(signed(path, { keyid: "who-knows" }))).status, 401);
  assert.equal((await shop.createCheckout(signed(path, { tag: "something-else" }))).status, 401);
  assert.equal((await shop.createCheckout(signed(path, { components: ["@authority"] }))).status, 401, "TAP must cover @path");
  const once = signed(path, { nonce: "fixed-nonce-123" });
  assert.equal((await shop.createCheckout(once)).status, 201);
  assert.equal((await shop.createCheckout(once)).status, 401, "a nonce can't be replayed");
});

test("keys can come from a Visa-style key service, and RSA-PSS keys work", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u === "https://keys.visa.test/keys?keyID=mc-agent-1") return Response.json(rsaJwk);
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  try {
    const shop = sigShop({ mode: "require", keyServices: [{ url: "https://keys.visa.test", kind: "visa-keys" }] });
    const res = await shop.createCheckout(signed("/ucp/v1/checkout-sessions", { key: rsa.privateKey, keyid: "mc-agent-1", alg: "rsa-pss-sha256" }));
    assert.equal(res.status, 201);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Web Bot Auth agents are trusted through their signature directory, if their origin is allowed", async () => {
  const realFetch = globalThis.fetch;
  const thumb = jwkThumbprint(edJwk);
  globalThis.fetch = (async (url: string | URL | Request) =>
    String(url) === "https://bot.example/.well-known/http-message-signatures-directory"
      ? Response.json({ keys: [{ kty: edJwk.kty, crv: edJwk.crv, x: edJwk.x }] })
      : new Response(null, { status: 404 })) as typeof fetch;
  try {
    const opts = { keyid: thumb, tag: "web-bot-auth", components: ["@authority", "signature-agent"], signatureAgent: "https://bot.example" };
    const trusted = sigShop({ mode: "require", trustedAgents: ["https://bot.example"] });
    assert.equal((await trusted.createCheckout(signed("/ucp/v1/checkout-sessions", opts))).status, 201);
    const untrusted = sigShop({ mode: "require", trustedAgents: [] });
    assert.equal((await untrusted.createCheckout(signed("/ucp/v1/checkout-sessions", opts))).status, 401);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("log mode lets unsigned requests through and reports what it saw; human checkout is untouched", async () => {
  const shop = sigShop({ mode: "require", keys: [edJwk] });
  const human = await shop.post("/api/orders", { items: [{ id: "croissant", qty: 1 }], email: "a@b.co", rail: "test" });
  assert.equal(human.status, 201, "the shopper checkout isn't an agent route");

  const logShop = sigShop({ mode: "log", keys: [edJwk] });
  const res = await logShop.createCheckout();
  assert.equal(res.status, 201);
  assert.equal(res.headers.get("Agent-Signature"), "none");
});
