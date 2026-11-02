// Small request guards: per-client throttling of failed lookups, and safe headers for
// pages that show bearer data (pickup passes, the staff scanner).
import type { Context, MiddlewareHandler } from "hono";

export function clientKey(c: Context): string {
  return (
    c.req.header("cf-connecting-ip") ??
    c.req.header("x-forwarded-for")?.split(",")[0].trim() ??
    c.req.header("x-real-ip") ??
    "local"
  );
}

/** Counts failures per client; once a client hits `max` within `windowMs` it is blocked until the window passes. */
export function createFailureThrottle(opts: { max: number; windowMs: number }) {
  const failures = new Map<string, number[]>();
  const recent = (key: string, now: number) => (failures.get(key) ?? []).filter((t) => now - t < opts.windowMs);
  return {
    blocked(key: string): boolean {
      const now = Date.now();
      const list = recent(key, now);
      failures.set(key, list);
      return list.length >= opts.max;
    },
    fail(key: string): void {
      const now = Date.now();
      const list = recent(key, now);
      list.push(now);
      failures.set(key, list);
      if (failures.size > 10_000) for (const [k] of failures) if (!recent(k, now).length) failures.delete(k);
    },
  };
}

const PAGE_CSP = [
  "default-src 'self'",
  "img-src 'self' data: https:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

/** Pages and API responses that carry a pass, a pickup code or staff controls. */
export const sensitiveHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  c.res.headers.set("X-Content-Type-Options", "nosniff");
  c.res.headers.set("Referrer-Policy", "no-referrer");
  c.res.headers.set("Cache-Control", "no-store");
  if (c.res.headers.get("Content-Type")?.includes("text/html")) {
    c.res.headers.set("X-Frame-Options", "DENY");
    c.res.headers.set("Content-Security-Policy", PAGE_CSP);
  }
};
