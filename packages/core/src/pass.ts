// A pass is a compact JWS (EdDSA over Ed25519) that the customer shows as a QR.
// It carries only what the counter needs to find and check the order; items,
// names and amounts stay on the server so a leaked screenshot reveals nothing.
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type JsonWebKey,
  type KeyObject,
} from "node:crypto";

export interface PassClaims {
  /** Pass format version. */
  v: 1;
  /** Order id. */
  oid: string;
  /** Pass id: random, single-use, the handle the server redeems against. */
  pid: string;
  /** Unix seconds after which the pass is no longer collectable. */
  exp: number;
}

export interface SigningKey {
  kid: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
}

export interface VerifyKey {
  kid: string;
  publicKey: KeyObject;
}

export type VerifyResult =
  | { ok: true; claims: PassClaims }
  | { ok: false; reason: "malformed" | "unknown_key" | "bad_signature" | "expired" };

const b64u = (buf: Buffer | string) => Buffer.from(buf).toString("base64url");

function kidFor(publicKey: KeyObject): string {
  const raw = publicKey.export({ format: "der", type: "spki" });
  return createHash("sha256").update(raw).digest("base64url").slice(0, 8);
}

/** Make a new Ed25519 signing key. Store the PEM somewhere safe; it signs every pass. */
export function generateSigningKeyPem(): string {
  const { privateKey } = generateKeyPairSync("ed25519");
  return privateKey.export({ format: "pem", type: "pkcs8" }).toString();
}

export function loadSigningKey(pkcs8Pem: string): SigningKey {
  const privateKey = createPrivateKey(pkcs8Pem);
  const publicKey = createPublicKey(privateKey);
  return { kid: kidFor(publicKey), privateKey, publicKey };
}

export function signPass(claims: PassClaims, key: SigningKey): string {
  const header = b64u(JSON.stringify({ alg: "EdDSA", kid: key.kid }));
  const payload = b64u(JSON.stringify(claims));
  const signature = sign(null, Buffer.from(`${header}.${payload}`), key.privateKey);
  return `${header}.${payload}.${b64u(signature)}`;
}

/** Check a pass signature and expiry. Does not check single use; that needs the store. */
export function verifyPass(
  token: string,
  keys: VerifyKey[],
  nowSeconds: number = Math.floor(Date.now() / 1000),
): VerifyResult {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [h, p, s] = parts;
  let header: { alg?: string; kid?: string };
  let claims: PassClaims;
  try {
    header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (header.alg !== "EdDSA" || claims?.v !== 1 || !claims.oid || !claims.pid) {
    return { ok: false, reason: "malformed" };
  }
  const key = keys.find((k) => k.kid === header.kid);
  if (!key) return { ok: false, reason: "unknown_key" };
  const good = verify(null, Buffer.from(`${h}.${p}`), key.publicKey, Buffer.from(s, "base64url"));
  if (!good) return { ok: false, reason: "bad_signature" };
  if (typeof claims.exp === "number" && claims.exp < nowSeconds) return { ok: false, reason: "expired" };
  return { ok: true, claims };
}

/** Public keys as a JWKS document, for anyone who wants to check passes offline. */
export function toJwks(keys: VerifyKey[]) {
  return {
    keys: keys.map((k) => ({
      ...(k.publicKey.export({ format: "jwk" }) as JsonWebKey),
      kid: k.kid,
      alg: "EdDSA",
      use: "sig",
    })),
  };
}

/** Pull a pass token out of whatever the scanner read: a bare token or a /c/<token> link. */
export function extractToken(scanned: string): string | null {
  const text = scanned.trim();
  const fromUrl = text.match(/\/c\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/);
  if (fromUrl) return fromUrl[1];
  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(text)) return text;
  return null;
}
