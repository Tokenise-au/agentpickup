// AP2 mandates for UCP checkouts (UCP extension dev.ucp.common.payment.ap2_mandate,
// AP2 v0.2): the business signs every checkout (detached JWS over the JCS checkout),
// and completing needs a checkout mandate, an SD-JWT with key binding from the platform,
// that carries our own signed checkout. The mandate is kept as dispute evidence.
import { createHash, createPrivateKey, createPublicKey, type JsonWebKey } from "node:crypto";
import { b64u, decodeJson, jcs, parseSdJwt, sha256b64u, signCompact, verifyCompact } from "./jws.js";

export const AP2_CAPABILITY = "dev.ucp.common.payment.ap2_mandate";
const MAX_KB_AGE_S = 300;
const CLOCK_SKEW_S = 60;

export interface PlatformProfile {
  capabilities: string[];
  keys: (JsonWebKey & { kid?: string })[];
}

export interface Ap2Config {
  /** PKCS#8 PEM for the business's ES256 (P-256) key that signs checkouts. */
  signingKeyPem: string;
  /** Look up a platform's UCP profile (capabilities and keys). Defaults to fetching the https URL in UCP-Agent. */
  resolvePlatform?: (profileUrl: string) => Promise<PlatformProfile | null>;
}

export type Ap2ErrorCode =
  | "mandate_required"
  | "agent_missing_key"
  | "mandate_invalid_signature"
  | "mandate_expired"
  | "mandate_scope_mismatch"
  | "merchant_authorization_invalid";

export class Ap2Error extends Error {
  constructor(
    readonly code: Ap2ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** The profile URL from a UCP-Agent header such as `profile="https://agent.example/profile"`. */
export function profileUrlFrom(ucpAgent: string): string | null {
  return ucpAgent.match(/profile="([^"]+)"/)?.[1] ?? null;
}

async function fetchProfile(url: string): Promise<PlatformProfile | null> {
  if (!url.startsWith("https://")) return null;
  const res = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { Accept: "application/json" } }).catch(() => null);
  if (!res?.ok) return null;
  const doc = (await res.json().catch(() => null)) as { ucp?: { capabilities?: Record<string, unknown> }; keys?: PlatformProfile["keys"] } | null;
  if (!doc) return null;
  return { capabilities: Object.keys(doc.ucp?.capabilities ?? {}), keys: doc.keys ?? [] };
}

export function createAp2(config: Ap2Config) {
  const privateKey = createPrivateKey(config.signingKeyPem);
  const publicKey = createPublicKey(privateKey);
  const jwk = publicKey.export({ format: "jwk" }) as JsonWebKey;
  if (jwk.kty !== "EC" || jwk.crv !== "P-256") throw new Error("AP2 signingKeyPem must be an EC P-256 key (ES256).");
  const kid = createHash("sha256").update(publicKey.export({ format: "der", type: "spki" })).digest("base64url").slice(0, 16);
  const resolve = config.resolvePlatform ?? fetchProfile;
  const profiles = new Map<string, { at: number; profile: PlatformProfile | null }>();

  async function platform(profileUrl: string) {
    const hit = profiles.get(profileUrl);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.profile;
    const profile = await resolve(profileUrl).catch(() => null);
    profiles.set(profileUrl, { at: Date.now(), profile });
    return profile;
  }

  /** The business key, for the top-level `keys` of /.well-known/ucp. */
  const publicJwk = { ...jwk, kid, alg: "ES256", use: "sig" };

  /** Does the platform behind this UCP-Agent support AP2 mandates? Decides whether a session is locked. */
  async function negotiated(ucpAgent: string): Promise<boolean> {
    const url = profileUrlFrom(ucpAgent);
    if (!url) return false;
    return Boolean((await platform(url))?.capabilities.includes(AP2_CAPABILITY));
  }

  /** Detached JWS over the JCS checkout (without `ap2`): `<header>..<signature>`. */
  function merchantAuthorization(checkoutWithoutAp2: unknown): string {
    const compact = signCompact({ alg: "ES256", kid }, b64u(jcs(checkoutWithoutAp2)), privateKey);
    const [h, , s] = compact.split(".");
    return `${h}..${s}`;
  }

  /**
   * Verify a checkout mandate for the current session state. Returns the embedded checkout
   * terms on success; throws Ap2Error with the UCP error code otherwise.
   */
  async function verifyCheckoutMandate(
    mandate: string,
    o: { ucpAgent: string; audience: string; expect: { id: string; totals: unknown; line_items: unknown } },
  ) {
    const sd = parseSdJwt(mandate);
    if (!sd) throw new Ap2Error("mandate_invalid_signature", "The checkout mandate isn't an SD-JWT.");

    // 1. Platform signature over the issuer JWT.
    const url = profileUrlFrom(o.ucpAgent);
    const profile = url ? await platform(url) : null;
    const header = decodeJson<{ kid?: string; alg?: string }>(sd.issuerJwt.split(".")[0]);
    const platformKey = profile?.keys.find((k) => k.kid === header.kid);
    if (!platformKey) throw new Ap2Error("agent_missing_key", "No key in the platform profile matches the mandate's kid.");
    const issuer = verifyCompact(sd.issuerJwt, platformKey);
    if (!issuer) throw new Ap2Error("mandate_invalid_signature", "The platform signature on the mandate doesn't verify.");
    const claims = decodeJson<{
      vct?: string;
      _sd?: string[];
      _sd_alg?: string;
      checkout_hash?: string;
      iat?: number;
      exp?: number;
      cnf?: { jwk?: JsonWebKey };
    }>(issuer.payload);
    if (claims.vct !== "mandate.checkout.1") throw new Ap2Error("mandate_scope_mismatch", "Not a checkout mandate (vct).");
    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.exp === "number" && claims.exp < now) throw new Ap2Error("mandate_expired", "The checkout mandate has expired.");
    if (typeof claims.iat === "number" && claims.iat > now + CLOCK_SKEW_S) throw new Ap2Error("mandate_invalid_signature", "The mandate is dated in the future.");
    if (claims._sd_alg && claims._sd_alg !== "sha-256") throw new Ap2Error("mandate_invalid_signature", `Unsupported _sd_alg ${claims._sd_alg}.`);

    // 2. Key binding: the holder (the user's key, per cnf) signs this presentation.
    if (!claims.cnf?.jwk || !sd.kbJwt) throw new Ap2Error("mandate_invalid_signature", "The mandate needs key binding (cnf and a KB-JWT).");
    const kb = verifyCompact(sd.kbJwt, claims.cnf.jwk);
    if (!kb) throw new Ap2Error("mandate_invalid_signature", "The key-binding signature doesn't verify.");
    const kbHeader = decodeJson<{ typ?: string }>(sd.kbJwt.split(".")[0]);
    const kbClaims = decodeJson<{ iat?: number; aud?: string; sd_hash?: string; nonce?: string }>(kb.payload);
    const presented = `${sd.issuerJwt}~${sd.disclosures.map((d) => `${d}~`).join("")}`;
    if (kbHeader.typ !== "kb+jwt" || kbClaims.sd_hash !== sha256b64u(presented)) {
      throw new Ap2Error("mandate_invalid_signature", "The key binding doesn't cover this presentation.");
    }
    if (typeof kbClaims.iat !== "number" || kbClaims.iat < now - MAX_KB_AGE_S || kbClaims.iat > now + CLOCK_SKEW_S) {
      throw new Ap2Error("mandate_expired", "The key-binding proof is too old.");
    }
    if (kbClaims.aud !== o.audience) throw new Ap2Error("mandate_scope_mismatch", `The mandate is addressed to ${kbClaims.aud}, not this business.`);

    // 3. Disclosed checkout_jwt, hashed into checkout_hash.
    let checkoutJwt: string | null = null;
    for (const d of sd.disclosures) {
      if (!claims._sd?.includes(sha256b64u(d))) throw new Ap2Error("mandate_invalid_signature", "A disclosure isn't covered by the mandate.");
      const [, name, value] = decodeJson<[string, string, unknown]>(d);
      if (name === "checkout_jwt" && typeof value === "string") checkoutJwt = value;
    }
    if (!checkoutJwt) throw new Ap2Error("mandate_scope_mismatch", "The mandate doesn't disclose checkout_jwt.");
    if (claims.checkout_hash !== sha256b64u(checkoutJwt)) throw new Ap2Error("mandate_scope_mismatch", "checkout_hash doesn't match checkout_jwt.");

    // 4. checkout_jwt is our own merchant authorization with the checkout attached, for these terms.
    const ours = verifyCompact(checkoutJwt, publicKey);
    if (!ours || (ours.header as { kid?: string }).kid !== kid) {
      throw new Ap2Error("merchant_authorization_invalid", "The embedded checkout isn't signed by this business.");
    }
    const embedded = decodeJson<{ id?: string; totals?: unknown; line_items?: unknown }>(ours.payload);
    const same = (a: unknown, b: unknown) => jcs(a) === jcs(b);
    if (embedded.id !== o.expect.id || !same(embedded.totals, o.expect.totals) || !same(embedded.line_items, o.expect.line_items)) {
      throw new Ap2Error("mandate_scope_mismatch", "The mandate was signed for different checkout terms.");
    }
    return { checkoutJwt, checkoutHash: claims.checkout_hash };
  }

  return { publicJwk, kid, negotiated, merchantAuthorization, verifyCheckoutMandate };
}

export type Ap2 = ReturnType<typeof createAp2>;
