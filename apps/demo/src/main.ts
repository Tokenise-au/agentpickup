// The product site: landing page, a live demo shop wired to @agentpickup/server,
// and the waitlist. Everything a real shop would configure lives in `createCollect`.
import { serve } from "@hono/node-server";
import { Hono, type MiddlewareHandler } from "hono";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateSigningKeyPem, newId } from "@agentpickup/core";
import { createCollect, outboxMailer, resendMailer, SqliteStore } from "@agentpickup/server";

const env = process.env;
const port = Number(env.PORT ?? 8402);
const baseUrl = (env.BASE_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
const dataDir = env.DATA_DIR ?? join(process.cwd(), "data");
mkdirSync(dataDir, { recursive: true });

function signingKey(): string {
  if (env.SIGNING_KEY_PEM) return env.SIGNING_KEY_PEM.replace(/\\n/g, "\n");
  const file = join(dataDir, "signing-key.pem");
  if (!existsSync(file)) writeFileSync(file, generateSigningKeyPem(), { mode: 0o600 });
  return readFileSync(file, "utf8");
}

const store = new SqliteStore(join(dataDir, "collect.db"));

const collect = createCollect({
  baseUrl,
  merchant: {
    name: "Demo Café",
    brandColor: "#9a3412",
    fromEmail: env.MAIL_FROM ?? "Demo Café <orders@example.com>",
    supportEmail: env.SUPPORT_EMAIL,
    shopUrl: `${baseUrl}/#demo`,
    location: { name: "Demo Café counter", address: "A demo shop: nothing here is real", hours: "Open whenever you are" },
  },
  catalog: [
    { id: "flat-white", name: "Flat white", priceCents: 450, description: "Double shot, silky milk" },
    { id: "long-black", name: "Long black", priceCents: 400, description: "Double shot over hot water" },
    { id: "almond-croissant", name: "Almond croissant", priceCents: 550, description: "Baked this morning" },
    { id: "banana-bread", name: "Banana bread", priceCents: 500, description: "Toasted, with butter" },
  ],
  currency: "usd",
  timeZone: env.TIME_ZONE ?? "Australia/Brisbane",
  store,
  mailer: env.RESEND_API_KEY ? resendMailer({ apiKey: env.RESEND_API_KEY }) : outboxMailer(),
  signingKeyPem: signingKey(),
  payments: {
    card: env.STRIPE_SECRET_KEY
      ? { secretKey: env.STRIPE_SECRET_KEY, webhookSecret: env.STRIPE_WEBHOOK_SECRET, captureMode: "hold" }
      : undefined,
    x402: env.X402_PAY_TO
      ? { payTo: env.X402_PAY_TO, network: (env.X402_NETWORK as `${string}:${string}`) ?? "eip155:84532" }
      : undefined,
    test: true,
  },
  collectWindowMinutes: 120,
  staffKey: env.STAFF_KEY || undefined,
  // The public demo lets visitors play staff; a real shop sets STAFF_KEY instead.
  allowOpenStaff: !env.STAFF_KEY,
  exposeEmailPreview: true,
});

// ---------- waitlist ----------

const db = new DatabaseSync(join(dataDir, "site.db"));
db.exec(`CREATE TABLE IF NOT EXISTS waitlist (
  id TEXT PRIMARY KEY, email TEXT NOT NULL, kind TEXT NOT NULL, note TEXT, created_at INTEGER NOT NULL
)`);

// ---------- a small per-IP limiter for the public endpoints ----------

function limit(perMinute: number): MiddlewareHandler {
  const hits = new Map<string, number[]>();
  return async (c, next) => {
    const ip = c.req.header("x-forwarded-for")?.split(",")[0].trim() ?? c.req.header("x-real-ip") ?? "local";
    const now = Date.now();
    const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= perMinute) return c.json({ error: "Slow down a little and try again in a minute." }, 429);
    recent.push(now);
    hits.set(ip, recent);
    return next();
  };
}

const app = new Hono();
app.use("/api/orders", limit(20));
app.use("/api/waitlist", limit(10));
app.use("/api/demo/*", limit(30));

app.post("/api/waitlist", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { email?: string; kind?: string; note?: string };
  const email = String(body.email ?? "").trim().slice(0, 200);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return c.json({ error: "That email doesn't look right." }, 400);
  const kind = ["payments", "shop", "platform", "developer", "other"].includes(String(body.kind)) ? String(body.kind) : "other";
  const note = String(body.note ?? "").trim().slice(0, 1000) || null;
  db.prepare("INSERT INTO waitlist (id, email, kind, note, created_at) VALUES (?, ?, ?, ?, ?)").run(
    newId("wl"),
    email,
    kind,
    note,
    Date.now(),
  );
  return c.json({ ok: true });
});

app.get("/admin/waitlist", (c) => {
  if (!env.ADMIN_KEY || c.req.query("key") !== env.ADMIN_KEY) return c.json({ error: "Not found." }, 404);
  return c.json({ signups: db.prepare("SELECT * FROM waitlist ORDER BY created_at DESC").all() });
});

// The demo's "simulate the scan" button: what a staff phone does, minus the camera.
app.post("/api/demo/scan", async (c) => {
  const { orderId } = (await c.req.json().catch(() => ({}))) as { orderId?: string };
  const order = orderId ? store.getOrder(orderId) : null;
  if (!order?.passId) return c.json({ title: "Not paid yet", detail: "Pay for the order first." }, 409);
  const result = await collect.collect(collect.collectLink(order));
  if (!result.ok) return c.json({ title: result.title, detail: result.detail }, result.status);
  return c.json({ message: result.message });
});

app.post("/api/demo/ready", async (c) => {
  const { orderId } = (await c.req.json().catch(() => ({}))) as { orderId?: string };
  const order = await collect.markReady(String(orderId ?? ""));
  return c.json({ status: order.status });
});

app.route("/", collect.app);

// ---------- the site ----------

const publicDir = join(import.meta.dirname, "..", "public");
const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};
function file(name: string) {
  const path = join(publicDir, name);
  const ext = name.slice(name.lastIndexOf("."));
  return () =>
    new Response(readFileSync(path), {
      headers: { "Content-Type": types[ext] ?? "application/octet-stream", "Cache-Control": "no-cache" },
    });
}
app.get("/", file("index.html"));
app.get("/site.css", file("site.css"));
app.get("/site.js", file("site.js"));
app.get("/favicon.svg", file("favicon.svg"));
app.get("/healthz", (c) => c.json({ ok: true }));

// Behind a TLS proxy (Railway, Fly, a load balancer) requests arrive as http://. Give the app the
// public origin so URLs it reports, like the resource in an x402 quote, match what clients called.
const publicOrigin = new URL(baseUrl).origin;
function withPublicOrigin(req: Request): Request {
  const url = new URL(req.url);
  if (url.origin === publicOrigin || !req.headers.get("x-forwarded-proto")) return req;
  const fixed = new URL(url.pathname + url.search, publicOrigin);
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(fixed, {
    method: req.method,
    headers: req.headers,
    body: hasBody ? req.body : undefined,
    ...(hasBody ? { duplex: "half" } : {}),
  } as RequestInit);
}

serve({ fetch: (req) => app.fetch(withPublicOrigin(req)), port }, () => {
  const rails = [env.STRIPE_SECRET_KEY && "card (Stripe)", env.X402_PAY_TO && "x402", "test"].filter(Boolean).join(", ");
  console.log(`agentPickup demo on ${baseUrl}  · payments: ${rails} · mail: ${env.RESEND_API_KEY ? "Resend" : "preview only"}`);
});
