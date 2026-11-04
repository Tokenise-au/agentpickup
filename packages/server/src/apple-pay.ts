// Apple Pay on the Web through Square needs a file from Square at the domain's root. Square changes the file
// from time to time and asks that it isn't cached for long, so it's fetched from Square and kept for an hour
// rather than copied into the build. The same file works for Square's sandbox and production.
import type { Context } from "hono";

export const APPLE_PAY_DOMAIN_PATH = "/.well-known/apple-developer-merchantid-domain-association";
const SOURCE = "https://app.squareup.com/digital-wallets/apple-pay/apple-developer-merchantid-domain-association";

/** A handler for APPLE_PAY_DOMAIN_PATH. Mount it at the root of the domain the checkout pages are on. */
export function appleDomainAssociation(opts: { fetch?: typeof fetch; ttlMs?: number } = {}) {
  const doFetch = opts.fetch ?? fetch;
  const ttl = opts.ttlMs ?? 3600_000;
  let cached: { body: ArrayBuffer; at: number } | null = null;
  return async (c: Context) => {
    if (!cached || Date.now() - cached.at >= ttl) {
      try {
        const res = await doFetch(SOURCE);
        if (!res.ok) throw new Error(`Square answered ${res.status}`);
        cached = { body: await res.arrayBuffer(), at: Date.now() };
      } catch (err) {
        console.error("[collect] fetching Square's Apple Pay domain file failed:", err);
        // An hour-old copy beats none: Apple checks the domain again from time to time.
        if (!cached) return c.text("Unavailable, try again shortly.", 503);
      }
    }
    // No file extension, and served as bytes: Apple rejects anything else.
    return c.body(new Uint8Array(cached.body), 200, { "Content-Type": "application/octet-stream", "Cache-Control": "public, max-age=3600" });
  };
}
