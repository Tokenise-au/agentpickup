// The product site: landing page, a live demo shop wired to @agentpickup/server,
// and the waitlist. Everything a real shop would configure lives in `createCollect`.
import { serve } from "@hono/node-server";
import { Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { DatabaseSync } from "node:sqlite";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateSigningKeyPem, newId } from "@agentpickup/core";
import { createMcpHandler, walletPayer } from "@agentpickup/mcp";
import {
  cappedMailer,
  cloudflareMailer,
  createCollect,
  createVenueHost,
  fxToUsdCents,
  outboxMailer,
  resendMailer,
  SqliteStore,
  type SignupConfig,
} from "@agentpickup/server";
import { privateKeyToAccount } from "viem/accounts";
import { createDemoAgent, DEMO_NETWORKS, TESTNET } from "./demo-agent.js";
import { createUsage, renderReport, reportData, startReportJob, type ReportSources } from "./report.js";

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

// AP2 mandates need an ES256 (P-256) business key; kept beside the pass key.
function ap2Key(): string {
  if (env.AP2_SIGNING_KEY_PEM) return env.AP2_SIGNING_KEY_PEM.replace(/\\n/g, "\n");
  const file = join(dataDir, "ap2-key.pem");
  if (!existsSync(file)) {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    writeFileSync(file, privateKey.export({ format: "pem", type: "pkcs8" }).toString(), { mode: 0o600 });
  }
  return readFileSync(file, "utf8");
}

const store = new SqliteStore(join(dataDir, "collect.db"));

// The site's own data: the partner form, and the usage behind the 8am report.
const db = new DatabaseSync(join(dataDir, "site.db"));
db.exec(`CREATE TABLE IF NOT EXISTS waitlist (
  id TEXT PRIMARY KEY, email TEXT NOT NULL, kind TEXT NOT NULL, note TEXT, created_at INTEGER NOT NULL
)`);
const usage = createUsage(db);
// Real email through Cloudflare Email Sending (or Resend), from orders@agentpickup.app. It's a public demo, so
// sends are capped per address and per day; without a key, emails only show on the page.
const sender = env.MAIL_SENDER || "orders@agentpickup.app";
const delivering =
  env.CLOUDFLARE_EMAIL_TOKEN && env.CLOUDFLARE_ACCOUNT_ID
    ? cloudflareMailer({ accountId: env.CLOUDFLARE_ACCOUNT_ID, apiToken: env.CLOUDFLARE_EMAIL_TOKEN })
    : env.RESEND_API_KEY
      ? resendMailer({ apiKey: env.RESEND_API_KEY })
      : null;
const mailer = delivering ? cappedMailer(delivering, { perRecipientPerDay: 3, perDay: 100 }) : outboxMailer();

// The demo's wallets. On Base Sepolia the café's own address is the payTo, so it can hand test USDC back
// to the agent. On Base mainnet, payments go to X402_PAY_TO (the owner's wallet): the café key, which sits
// in server config, never receives real money, and the owner tops the agent up by hand.
const x402Network = (env.X402_NETWORK as `${string}:${string}`) || TESTNET;
const demoNetwork = DEMO_NETWORKS[x402Network];
const demoAgentKey = demoNetwork ? (env.DEMO_AGENT_KEY as `0x${string}` | undefined) : undefined;
const demoCafeKey = x402Network === TESTNET ? (env.DEMO_CAFE_KEY as `0x${string}` | undefined) : undefined;
const x402PayTo = demoCafeKey ? privateKeyToAccount(demoCafeKey).address : env.X402_PAY_TO;
// x402.org settles testnet only; PayAI settles Base mainnet with no account or key.
const x402Facilitator = env.X402_FACILITATOR_URL || demoNetwork?.facilitator;

const collect = createCollect({
  baseUrl,
  merchant: {
    name: "Demo Café",
    brandColor: "#9a3412",
    fromEmail: env.MAIL_FROM ?? `Demo Café <${sender}>`,
    supportEmail: env.SUPPORT_EMAIL,
    shopUrl: `${baseUrl}/#demo`,
    location: { name: "Demo Café counter", address: "A demo shop: nothing here is real", hours: "Open whenever you are" },
  },
  catalog: [
    { id: "flat-white", name: "Flat white", priceCents: 450, description: "Double shot, silky milk" },
    { id: "long-black", name: "Long black", priceCents: 400, description: "Double shot over hot water" },
    { id: "almond-croissant", name: "Almond croissant", priceCents: 550, description: "Baked this morning" },
    { id: "banana-bread", name: "Banana bread", priceCents: 500, description: "Toasted, with butter" },
    // Cheap enough that a small real-USDC float in the demo agent covers several on-chain orders.
    { id: "babyccino", name: "Babyccino", priceCents: 50, description: "Frothed milk, a marshmallow on the side" },
  ],
  currency: "usd",
  timeZone: env.TIME_ZONE ?? "Australia/Brisbane",
  store,
  mailer,
  signingKeyPem: signingKey(),
  payments: {
    card: env.STRIPE_SECRET_KEY
      ? { secretKey: env.STRIPE_SECRET_KEY, webhookSecret: env.STRIPE_WEBHOOK_SECRET, captureMode: "hold" }
      : undefined,
    x402: x402PayTo ? { payTo: x402PayTo, network: x402Network, facilitatorUrl: x402Facilitator } : undefined,
    mpp:
      env.STRIPE_SECRET_KEY && env.MPP_NETWORK_ID && env.MPP_CHALLENGE_SECRET
        ? { stripeSecretKey: env.STRIPE_SECRET_KEY, networkId: env.MPP_NETWORK_ID, challengeSecret: env.MPP_CHALLENGE_SECRET }
        : undefined,
    test: true,
  },
  // UCP checkout at /ucp/v1: test instruments always, Stripe Shared Payment Tokens when keys are set.
  ucp: {
    stripe: env.STRIPE_SECRET_KEY
      ? { secretKey: env.STRIPE_SECRET_KEY, businessProfile: env.STRIPE_PROFILE_ID, environment: env.STRIPE_SECRET_KEY.includes("_test_") ? "testmode" : "livemode" }
      : undefined,
    ap2: { signingKeyPem: ap2Key() },
  },
  // ACP at /acp. The public demo publishes its platform key; a real shop issues one per platform.
  acp: {
    apiKeys: [env.ACP_API_KEY || "demo-acp-key"],
    stripe: env.STRIPE_SECRET_KEY ? { secretKey: env.STRIPE_SECRET_KEY } : undefined,
  },
  // Agent signatures are checked and reported on agent payment routes, not required, in the demo.
  agentSignatures: { mode: "log" },
  collectWindowMinutes: 120,
  // A receipt first, the QR when "Mark ready" is pressed.
  qrEmail: "when-ready",
  staffKey: env.STAFF_KEY || undefined,
  // The public demo lets visitors play staff; a real shop sets STAFF_KEY instead.
  allowOpenStaff: !env.STAFF_KEY,
  exposeEmailPreview: true,
  onEvent: (event, order) => usage.order("demo-cafe", event, order),
});

// A real agent wallet that pays demo orders over x402, so the demo settles on-chain.
const demoAgent =
  demoAgentKey && x402PayTo
    ? createDemoAgent({
        agentKey: demoAgentKey,
        network: x402Network,
        cafeKey: demoCafeKey,
        baseUrl,
        fetch: (req) => collect.app.fetch(req),
        facilitatorUrl: x402Facilitator,
        dailyLimit: Number(env.DEMO_AGENT_DAILY_LIMIT) || undefined,
        maxOrderUsd: Number(env.DEMO_AGENT_MAX_ORDER) || undefined,
      })
    : null;


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

// www.<domain> answers with a permanent redirect to the bare domain, keeping the method (308).
const publicHost = new URL(baseUrl).host;
app.use("*", async (c, next) => {
  const host = c.req.header("host");
  if (host && host === `www.${publicHost}`) {
    const url = new URL(c.req.url);
    return c.redirect(`${baseUrl}${url.pathname}${url.search}`, 308);
  }
  return next();
});
// Count what happened, for the 8am report: pages, the directory, menus, sign-up steps, errors, and MCP calls.
app.use("*", async (c, next) => {
  const mcpBody = c.req.method === "POST" && c.req.path === "/mcp" ? c.req.raw.clone().json().catch(() => null) : null;
  await next();
  const ua = c.req.header("user-agent");
  usage.request(c.req.method, c.req.path, c.res.status, ua, c.res.headers.get("location"));
  if (mcpBody) usage.mcp(await mcpBody, ua);
});
app.use("/api/orders", limit(20));
app.use("/api/waitlist", limit(10));
app.use("/api/demo/*", limit(30));
app.use("/api/demo/agent-pay", limit(4));
app.use("/mcp", limit(60));
app.use("/v/*", limit(60));
app.use("/host/*", limit(30));
app.use("/directory/*", limit(60));
// Square's webhook comes from a few Square servers for every venue, so it isn't limited per address.
const connectLimit = limit(30);
app.use("/connect/*", (c, next) => (c.req.path === "/connect/square/webhook" ? next() : connectLimit(c, next)));
app.use("/seller/*", limit(30));
app.use(
  "/mcp",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Accept", "Mcp-Session-Id", "Mcp-Protocol-Version", "Last-Event-ID"],
    exposeHeaders: ["Mcp-Session-Id"],
  }),
);

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
  const order = orderId ? await store.getOrder(orderId) : null;
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

app.get("/api/demo/agent", async (c) => c.json(demoAgent ? await demoAgent.status() : { enabled: false }));

app.post("/api/demo/agent-pay", async (c) => {
  if (!demoAgent) return c.json({ error: "The demo agent isn't switched on here." }, 404);
  const { orderId } = (await c.req.json().catch(() => ({}))) as { orderId?: string };
  const order = orderId ? await store.getOrder(orderId) : null;
  if (!order || order.rail !== "x402") return c.json({ error: "Start an x402 order first." }, 400);
  try {
    const result = await demoAgent.pay(order.id);
    return result.ok ? c.json(result) : c.json({ error: result.error }, result.status);
  } catch (err) {
    console.warn("demo agent payment failed:", err instanceof Error ? err.message : err);
    return c.json({ error: "The demo agent couldn't pay just now. Try again in a minute." }, 502);
  }
});

// Sellers connect their own Square at /connect when the Square app's keys are set. A sandbox Square app
// pairs with test USDC on Base Sepolia; a production one with the demo's own network.
const squareEnvironment = env.SQUARE_ENVIRONMENT === "production" ? "production" : "sandbox";
const signupNetwork = squareEnvironment === "production" ? x402Network : TESTNET;
const signup: SignupConfig | undefined =
  env.SQUARE_APP_ID && env.SQUARE_APP_SECRET
    ? {
        square: {
          applicationId: env.SQUARE_APP_ID,
          applicationSecret: env.SQUARE_APP_SECRET,
          environment: squareEnvironment,
          webhookSignatureKey: env.SQUARE_APP_WEBHOOK_KEY || undefined,
        },
        x402: { network: signupNetwork, facilitatorUrl: signupNetwork === x402Network ? x402Facilitator : DEMO_NETWORKS[TESTNET].facilitator },
      }
    : undefined;

// More venues on the same install, at /v/<slug>, managed through /host/v1. Off unless both keys are set.
const venueHost =
  env.VENUE_SECRET && env.VENUE_ADMIN_KEY
    ? createVenueHost({
        baseUrl,
        store: new SqliteStore(join(dataDir, "venues.db")),
        storeFor: (slug) => new SqliteStore(join(dataDir, "venues", `${slug}.db`)),
        mailer,
        sendFrom: sender,
        secretKey: env.VENUE_SECRET,
        adminKeys: [env.VENUE_ADMIN_KEY],
        shared: { exposeEmailPreview: true, agentSignatures: { mode: "log" }, collectWindowMinutes: 120 },
        // Demo venues let visitors play staff unless a venue sets its own staff key.
        allowOpenStaff: true,
        // The Demo Café is in the directory too.
        alsoList: [collect],
        signup,
        // Australian venues price in AUD; USDC is US dollars.
        toUsdCents: fxToUsdCents(),
        onEvent: (slug, event, order) => usage.order(slug, event, order),
      })
    : null;
if (venueHost) app.route("/", venueHost.app);
// Until sign-up is switched on, "Integrate it" goes to the partner form.
if (!venueHost || !signup) app.get("/connect", (c) => c.redirect("/#partners"));

// ---------- the 8am report ----------
// Yesterday's usage, emailed to REPORT_TO at 8am Brisbane time. /admin/report previews it; /admin/report/send sends it now.
const reportSources: ReportSources = {
  usage,
  db,
  hostAdmin: venueHost
    ? async (path) => (await venueHost.app.request(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${env.VENUE_ADMIN_KEY}` } })).json()
    : undefined,
  demoWallet: demoAgent ? () => demoAgent.status() : undefined,
};
const reportJob = startReportJob({ sources: reportSources, mailer: delivering, to: env.REPORT_TO, from: `agentPickup <${env.REPORT_FROM || "reports@agentpickup.app"}>` });
const isAdmin = (key: string | undefined) => Boolean(env.ADMIN_KEY && key === env.ADMIN_KEY);
app.get("/admin/report", async (c) => {
  if (!isAdmin(c.req.query("key"))) return c.json({ error: "Not found." }, 404);
  return c.html(renderReport(await reportData(reportSources, c.req.query("day") ?? reportJob.yesterday())).html);
});
app.post("/admin/report/send", async (c) => {
  if (!isAdmin(c.req.query("key"))) return c.json({ error: "Not found." }, 404);
  if (!env.REPORT_TO) return c.json({ error: "Set REPORT_TO first." }, 400);
  return c.json(await reportJob.sendFor(c.req.query("day") ?? reportJob.yesterday(), env.REPORT_TO));
});

// The agentPickup MCP server, hosted for the demo shop. The demo agent's wallet pays, under the
// same daily cap as the button on the page; the same wallet signs in to fetch passes again.
// With venues on, find_shops searches the directory and the tools can order from any venue here.
const onVenueHost = (req: Request) => /^\/(v|directory)\//.test(new URL(req.url).pathname);
const mcp = createMcpHandler({
  shopUrl: baseUrl,
  fetch: (req) => (venueHost && onVenueHost(req) ? venueHost.app.fetch(req) : collect.app.fetch(req)),
  directoryUrl: venueHost ? `${baseUrl}/directory/v1/shops` : undefined,
  payer:
    demoAgent && demoAgentKey
      ? {
          ...walletPayer({ privateKey: demoAgentKey, networks: [x402Network] }),
          pay: async (order) => {
            // The demo wallet pays the Demo Café only; a venue's orders are paid by the agent's own wallet.
            if (!order.payUrl.startsWith(`${baseUrl}/api/`)) {
              return { ok: false, error: `The demo wallet pays the Demo Café only. Pay this order from your own x402 wallet: POST ${order.payUrl}` };
            }
            const paid = await demoAgent.pay(order.id);
            return paid.ok ? { ...paid, network: x402Network } : { ok: false, error: paid.error };
          },
        }
      : undefined,
});
app.all("/mcp", (c) => mcp(c.req.raw));

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
app.get("/privacy", file("privacy.html"));
app.get("/terms", file("terms.html"));
app.get("/support", file("support.html"));
app.get("/wallet", file("wallet.html"));
// RFC 9116: where to report a security problem.
app.get("/.well-known/security.txt", (c) =>
  c.text(
    [
      "Contact: mailto:hello@agentpickup.app",
      `Expires: ${new Date(Date.now() + 365 * 24 * 3600_000).toISOString()}`,
      "Preferred-Languages: en",
      `Canonical: ${baseUrl}/.well-known/security.txt`,
      `Policy: ${baseUrl}/support`,
      "",
    ].join("\n"),
  ),
);
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
  const rails = [env.STRIPE_SECRET_KEY && "card (Stripe)", x402PayTo && "x402", "test"].filter(Boolean).join(", ");
  const mail = env.CLOUDFLARE_EMAIL_TOKEN ? "Cloudflare" : env.RESEND_API_KEY ? "Resend" : "preview only";
  console.log(`agentPickup demo on ${baseUrl}  · payments: ${rails} · mail: ${mail}`);
  if (demoAgent) console.log(`demo agent ${demoAgent.address} pays ${demoAgent.cafeAddress ?? x402PayTo} on ${x402Network}`);
  void demoAgent?.refill();
});
