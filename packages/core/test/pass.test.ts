import { test } from "node:test";
import assert from "node:assert/strict";
import { extractToken, generateSigningKeyPem, loadSigningKey, newPickupCode, signPass, toJwks, verifyPass } from "../src/index.js";

const key = loadSigningKey(generateSigningKeyPem());
const claims = { v: 1 as const, oid: "ord_abc", pid: "pass_xyz", exp: 2_000_000_000 };

test("a signed pass verifies with its key", () => {
  const token = signPass(claims, key);
  assert.deepEqual(verifyPass(token, [key]), { ok: true, claims });
});

test("a pass signed by another key is refused", () => {
  const other = loadSigningKey(generateSigningKeyPem());
  const token = signPass(claims, other);
  assert.deepEqual(verifyPass(token, [key]), { ok: false, reason: "unknown_key" });
});

test("a tampered pass is refused", () => {
  const token = signPass(claims, key);
  const [h, , s] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ ...claims, oid: "ord_other" })).toString("base64url");
  assert.deepEqual(verifyPass(`${h}.${forged}.${s}`, [key]), { ok: false, reason: "bad_signature" });
});

test("an expired pass is refused", () => {
  const token = signPass({ ...claims, exp: 100 }, key);
  assert.deepEqual(verifyPass(token, [key], 200), { ok: false, reason: "expired" });
});

test("garbage is malformed, not a crash", () => {
  assert.deepEqual(verifyPass("hello", [key]), { ok: false, reason: "malformed" });
  assert.deepEqual(verifyPass("a.b.c", [key]), { ok: false, reason: "malformed" });
});

test("the QR fits comfortably", () => {
  const token = signPass({ v: 1, oid: "ord_AbCdEfGhIjKl", pid: "AbCdEfGhIjKlMnOp", exp: 1_900_000_000 }, key);
  assert.ok(`https://shop.example.com/c/${token}`.length < 300);
});

test("tokens are found in links and bare text", () => {
  const token = signPass(claims, key);
  assert.equal(extractToken(`https://shop.example.com/c/${token}`), token);
  assert.equal(extractToken(`  ${token}\n`), token);
  assert.equal(extractToken("not a pass"), null);
});

test("JWKS carries the kid", () => {
  const jwks = toJwks([key]);
  assert.equal(jwks.keys[0].kid, key.kid);
  assert.equal(jwks.keys[0].crv, "Ed25519");
});

test("pickup codes avoid look-alike characters", () => {
  for (let i = 0; i < 200; i++) assert.match(newPickupCode(), /^[2-9A-HJKMNP-Z]{6}$/);
});
