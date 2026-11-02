// Sign-In-With-X for paying agents: the wallet that paid for an order can fetch its
// pass again later by signing a one-time challenge, with no account and no repayment.
import { randomBytes } from "node:crypto";
import {
  buildSIWxSchema,
  parseSIWxHeader,
  SIGN_IN_WITH_X,
  validateSIWxMessage,
  verifySIWxSignature,
} from "@x402/extensions/sign-in-with-x";

const CHALLENGE_TTL_MS = 5 * 60_000;

export function createSiwxGate(opts: { baseUrl: string; network: string }) {
  const origin = new URL(opts.baseUrl);
  // nonce → the order it was issued for and when it lapses. Single use, bound to one order.
  const nonces = new Map<string, { scope: string; expires: number }>();

  function prune(now: number) {
    for (const [nonce, entry] of nonces) if (entry.expires < now) nonces.delete(nonce);
  }

  /** A 402 body asking the caller to sign in with the wallet that paid. */
  function challenge(scope: string, resourceUrl: string) {
    const now = Date.now();
    prune(now);
    const nonce = randomBytes(16).toString("hex");
    nonces.set(nonce, { scope, expires: now + CHALLENGE_TTL_MS });
    return {
      x402Version: 2,
      error: "Sign in with the wallet that paid for this order.",
      resource: { url: resourceUrl, description: "Pickup pass for a paid order", mimeType: "application/json" },
      accepts: [],
      extensions: {
        [SIGN_IN_WITH_X]: {
          info: {
            domain: origin.host,
            uri: resourceUrl,
            statement: "Sign in to fetch the pickup pass for your order",
            version: "1",
            nonce,
            issuedAt: new Date(now).toISOString(),
            expirationTime: new Date(now + CHALLENGE_TTL_MS).toISOString(),
          },
          supportedChains: [{ chainId: opts.network, type: "eip191" }],
          schema: buildSIWxSchema(),
        },
      },
    };
  }

  /** Check a SIGN-IN-WITH-X header issued for `scope`; returns the signing wallet. */
  async function verify(header: string, scope: string): Promise<{ ok: true; address: string } | { ok: false; reason: string }> {
    let payload;
    try {
      payload = parseSIWxHeader(header);
    } catch {
      return { ok: false, reason: "Malformed SIGN-IN-WITH-X header." };
    }
    const checked = await validateSIWxMessage(payload, origin, {
      checkNonce: (nonce) => {
        const entry = nonces.get(nonce);
        if (!entry || entry.scope !== scope || entry.expires < Date.now()) return false;
        nonces.delete(nonce);
        return true;
      },
    });
    if (!checked.isValid) return { ok: false, reason: checked.invalidMessage };
    const signed = await verifySIWxSignature(payload);
    if (!signed.isValid) return { ok: false, reason: signed.invalidMessage };
    return { ok: true, address: signed.payer };
  }

  return { challenge, verify };
}
