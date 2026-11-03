// Minimal JWS helpers for AP2 and UCP: compact and detached JWS with ES256/ES384/EdDSA,
// JCS canonical JSON, and SD-JWT parsing. Node crypto only.
import { createHash, createPublicKey, sign, verify, type JsonWebKey, type KeyObject } from "node:crypto";
import { canonicalize } from "@x402/extensions/offer-receipt";

export const b64u = (data: Buffer | string) => Buffer.from(data).toString("base64url");
export const fromB64u = (s: string) => Buffer.from(s, "base64url");
export const sha256b64u = (s: string) => createHash("sha256").update(s).digest("base64url");

/** RFC 8785 canonical JSON. */
export const jcs = (value: unknown) => canonicalize(value as object);

const HASH: Record<string, string | null> = { ES256: "sha256", ES384: "sha384", ES512: "sha512", EdDSA: null };

export function signCompact(header: Record<string, unknown>, payloadB64: string, key: KeyObject): string {
  const alg = String(header.alg);
  if (!(alg in HASH)) throw new Error(`unsupported alg ${alg}`);
  const h = b64u(JSON.stringify(header));
  const input = Buffer.from(`${h}.${payloadB64}`);
  const sig = sign(HASH[alg], input, alg === "EdDSA" ? key : { key, dsaEncoding: "ieee-p1363" });
  return `${h}.${payloadB64}.${b64u(sig)}`;
}

export function verifyCompact(jws: string, key: KeyObject | JsonWebKey): { header: Record<string, unknown>; payload: Buffer } | null {
  const [h, p, s] = jws.split(".");
  if (!h || p === undefined || !s) return null;
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(fromB64u(h).toString("utf8"));
  } catch {
    return null;
  }
  const alg = String(header.alg);
  if (!(alg in HASH)) return null;
  const pub = "kty" in (key as object) ? createPublicKey({ key: key as JsonWebKey, format: "jwk" }) : (key as KeyObject);
  const input = Buffer.from(`${h}.${p}`);
  const ok = verify(HASH[alg], input, alg === "EdDSA" ? pub : { key: pub, dsaEncoding: "ieee-p1363" }, fromB64u(s));
  return ok ? { header, payload: fromB64u(p) } : null;
}

export const decodeJson = <T>(b: Buffer | string): T => JSON.parse(Buffer.isBuffer(b) ? b.toString("utf8") : fromB64u(b).toString("utf8"));

export interface SdJwt {
  issuerJwt: string;
  disclosures: string[];
  kbJwt: string | null;
}

/** Split `<issuer-jwt>~<disclosure>~...~<kb-jwt>`; an empty last part means no key binding. */
export function parseSdJwt(value: string): SdJwt | null {
  const parts = value.split("~");
  if (parts.length < 2) return null;
  const issuerJwt = parts[0];
  const last = parts[parts.length - 1];
  const disclosures = parts.slice(1, -1).filter(Boolean);
  if (issuerJwt.split(".").length !== 3) return null;
  return { issuerJwt, disclosures, kbJwt: last ? last : null };
}
