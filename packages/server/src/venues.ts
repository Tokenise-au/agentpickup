// Many venues on one install: each venue is a full agentPickup shop at <baseUrl>/v/<slug>, with its own
// name, menu, payments, staff key and connectors, added and changed through an admin API. Venue secrets
// (card, Square and staff keys, the refund wallet, the pass-signing key) are sealed with AES-256-GCM
// before they reach the store, so the database never holds them in the clear. Listed venues appear in the
// public directory at /directory/v1/shops, where agents find shops near someone that sell what they want.
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { generateSigningKeyPem } from "@agentpickup/core";
import type { CatalogItem, CollectConfig, MerchantConfig } from "./config.js";
import type { Mailer } from "./mail.js";
import type { Store } from "./store.js";
import { parseCatalog } from "./connect.js";
import { squareConnector } from "./connectors/square.js";
import { createCollect } from "./index.js";
import { searchDirectory, type DirectoryQuery, type ShopListing } from "./directory.js";

/** What a platform sends to create or change a venue. Secret fields are write-only. */
export interface VenueInput {
  merchant: MerchantConfig;
  currency?: string;
  catalog?: CatalogItem[];
  timeZone?: string;
  collectWindowMinutes?: number;
  noShowPolicy?: "release" | "keep";
  /** When the pickup QR is emailed. Default "when-ready" for a venue whose Square webhook is set up, else "with-receipt". */
  qrEmail?: "with-receipt" | "when-ready";
  qrFallbackMinutes?: number;
  /** Show the venue in the public directory. Default true. */
  listed?: boolean;
  payments?: {
    test?: boolean;
    x402?: { payTo: string; network?: `${string}:${string}`; facilitatorUrl?: string; refundPrivateKey?: string | null };
    card?: { secretKey?: string | null; webhookSecret?: string | null; captureMode?: "hold" | "charge" } | null;
  };
  square?: { accessToken?: string | null; locationId: string; environment?: "sandbox" | "production"; webhookSignatureKey?: string | null } | null;
  staffKey?: string | null;
  webhook?: { url: string; secret?: string | null } | null;
}

/** Secrets kept sealed. Omitted on an update: kept. null: removed. */
interface VenueSecrets {
  signingKeyPem: string;
  staffKey?: string;
  cardSecretKey?: string;
  cardWebhookSecret?: string;
  x402RefundKey?: string;
  squareAccessToken?: string;
  squareWebhookKey?: string;
  webhookSecret?: string;
}

/** A venue as stored: settings in the clear, secrets sealed. */
interface VenueRecord {
  slug: string;
  settings: Omit<VenueInput, "staffKey"> & {
    payments?: { test?: boolean; x402?: { payTo: string; network?: `${string}:${string}`; facilitatorUrl?: string }; card?: { captureMode?: "hold" | "charge" } };
    square?: { locationId: string; environment?: "sandbox" | "production" };
    webhook?: { url: string };
  };
  sealed: string;
  createdAt: number;
  updatedAt: number;
}

export interface VenueHostConfig {
  /** The host's public origin, e.g. "https://agentpickup.app". Venues live at <baseUrl><pathPrefix>/<slug>. */
  baseUrl: string;
  /** Default "/v". */
  pathPrefix?: string;
  /** Where the venue list lives. */
  store: Store;
  /** Each venue's own store (orders, events, emails): a SQLite file per venue, or a PostgresStore with a per-venue prefix. */
  storeFor: (slug: string) => Store;
  mailer: Mailer;
  /** Seals venue secrets at rest. At least 32 characters; keep it out of the database. */
  secretKey: string;
  /** Bearer keys for the admin API at /host/v1. */
  adminKeys: string[];
  /** Settings every venue shares (UCP, ACP, agent signatures, exposeEmailPreview, poweredBy...). */
  shared?: Partial<CollectConfig>;
  /** Venues without a staff key get an open scanner. Demos only. */
  allowOpenStaff?: boolean;
  /** For tests, or a proxy: the fetch Square connectors use. */
  fetch?: typeof fetch;
  /**
   * Send every venue's email from this address on your own verified domain ("orders@yourplatform.com"),
   * under the venue's name; replies go to the venue's supportEmail.
   */
  sendFrom?: string;
  /** Other shops to show in the directory alongside the venues, such as the install's own shop. */
  alsoList?: { listing(): Promise<ShopListing> }[];
}

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const RESERVED = new Set(["host", "api", "admin", "connect", "static", "assets", "www", "app"]);

function sealer(secret: string) {
  if (secret.length < 32) throw new Error("The venue host's secretKey must be at least 32 characters.");
  const key = createHash("sha256").update(`agentpickup-venues:${secret}`).digest();
  return {
    seal(value: unknown): string {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
    },
    open<T>(sealed: string): T {
      const raw = Buffer.from(sealed, "base64");
      const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8")) as T;
    },
  };
}

function bearer(keys: string[]): MiddlewareHandler {
  const wanted = keys.filter(Boolean).map((k) => Buffer.from(k));
  return async (c, next) => {
    const given = Buffer.from((c.req.header("Authorization") ?? "").replace(/^Bearer\s+/i, ""));
    if (!wanted.some((k) => k.length === given.length && timingSafeEqual(k, given))) {
      return c.json({ error: "Send Authorization: Bearer <your admin key>." }, 401);
    }
    return next();
  };
}

class VenueError extends Error {}

/** Check a venue body and split it into stored settings and secret changes. */
function parseVenue(body: unknown): { settings: VenueRecord["settings"]; secrets: Partial<Record<keyof VenueSecrets, string | null>> } {
  const v = body as VenueInput;
  if (!v || typeof v !== "object") throw new VenueError("Send the venue as JSON.");
  const m = v.merchant;
  if (!m || typeof m.name !== "string" || !m.name.trim() || m.name.length > 80) throw new VenueError("merchant.name must be 1-80 characters.");
  if (typeof m.fromEmail !== "string" || !/@/.test(m.fromEmail)) throw new VenueError("merchant.fromEmail must be a sender address.");
  if (v.currency !== undefined && !/^[a-zA-Z]{3}$/.test(v.currency)) throw new VenueError("currency must be a three-letter code.");
  let catalog: CatalogItem[] | undefined;
  if (v.catalog !== undefined) {
    const parsed = parseCatalog({ items: v.catalog });
    if ("error" in parsed) throw new VenueError(parsed.error);
    catalog = parsed.items;
  }
  if (v.square && (typeof v.square.locationId !== "string" || !v.square.locationId)) throw new VenueError("square.locationId is required.");
  if (v.payments?.x402 && typeof v.payments.x402.payTo !== "string") throw new VenueError("payments.x402.payTo is required.");
  if (v.qrEmail !== undefined && v.qrEmail !== "with-receipt" && v.qrEmail !== "when-ready") throw new VenueError('qrEmail must be "with-receipt" or "when-ready".');
  checkLocation(m.location);

  const secrets: Partial<Record<keyof VenueSecrets, string | null>> = {};
  const take = (name: keyof VenueSecrets, value: string | null | undefined) => {
    if (value !== undefined) secrets[name] = value;
  };
  take("staffKey", v.staffKey);
  take("cardSecretKey", v.payments?.card === null ? null : v.payments?.card?.secretKey);
  take("cardWebhookSecret", v.payments?.card === null ? null : v.payments?.card?.webhookSecret);
  take("x402RefundKey", v.payments?.x402?.refundPrivateKey);
  take("squareAccessToken", v.square === null ? null : v.square?.accessToken);
  take("squareWebhookKey", v.square === null ? null : v.square?.webhookSignatureKey);
  take("webhookSecret", v.webhook === null ? null : v.webhook?.secret);

  const settings: VenueRecord["settings"] = {
    merchant: { ...m, name: m.name.trim() },
    ...(v.currency ? { currency: v.currency.toLowerCase() } : {}),
    ...(catalog ? { catalog } : {}),
    ...(v.timeZone ? { timeZone: v.timeZone } : {}),
    ...(v.collectWindowMinutes ? { collectWindowMinutes: v.collectWindowMinutes } : {}),
    ...(v.noShowPolicy ? { noShowPolicy: v.noShowPolicy } : {}),
    ...(v.qrEmail ? { qrEmail: v.qrEmail } : {}),
    ...(v.qrFallbackMinutes ? { qrFallbackMinutes: v.qrFallbackMinutes } : {}),
    ...(v.listed === false ? { listed: false } : {}),
    payments: {
      ...(v.payments?.test ? { test: true } : {}),
      ...(v.payments?.x402 ? { x402: { payTo: v.payments.x402.payTo, network: v.payments.x402.network, facilitatorUrl: v.payments.x402.facilitatorUrl } } : {}),
      ...(v.payments?.card ? { card: { captureMode: v.payments.card.captureMode } } : {}),
    },
    ...(v.square ? { square: { locationId: v.square.locationId, environment: v.square.environment } } : {}),
    ...(v.webhook ? { webhook: { url: v.webhook.url } } : {}),
  };
  return { settings, secrets };
}

/** Coordinates and opening hours a venue sets by hand (a Square venue gets them from Square). */
function checkLocation(location: VenueInput["merchant"]["location"]) {
  if (!location) return;
  const { lat, lng, openingHours } = location;
  if ((lat !== undefined || lng !== undefined) && !(typeof lat === "number" && Math.abs(lat) <= 90 && typeof lng === "number" && Math.abs(lng) <= 180)) {
    throw new VenueError("merchant.location needs both lat (-90 to 90) and lng (-180 to 180).");
  }
  if (openingHours !== undefined) {
    const time = /^([01]\d|2[0-3]):[0-5]\d$/;
    const ok =
      Array.isArray(openingHours) &&
      openingHours.length <= 50 &&
      openingHours.every((p) => Number.isInteger(p?.day) && p.day >= 0 && p.day <= 6 && time.test(p.open) && time.test(p.close));
    if (!ok) throw new VenueError('merchant.location.openingHours is a list of { day: 0-6 (Sunday 0), open: "07:00", close: "15:00" }.');
  }
}

export function createVenueHost(cfg: VenueHostConfig) {
  const base = cfg.baseUrl.replace(/\/+$/, "");
  const prefix = (cfg.pathPrefix ?? "/v").replace(/\/+$/, "");
  const box = sealer(cfg.secretKey);
  const live = new Map<string, ReturnType<typeof createCollect>>();
  const failed = new Map<string, string>();

  const recordOf = async (slug: string) => (await cfg.store.getDoc<VenueRecord>("venue", slug)) ?? null;
  const index = async () => (await cfg.store.getDoc<{ slugs: string[] }>("venues", "index"))?.slugs ?? [];

  function build(record: VenueRecord) {
    const secrets = box.open<VenueSecrets>(record.sealed);
    const s = record.settings;
    const x402 = s.payments?.x402;
    const merchant = cfg.sendFrom
      ? { ...s.merchant, fromEmail: `"${s.merchant.name.replace(/["<>]/g, "")}" <${cfg.sendFrom}>` }
      : s.merchant;
    return createCollect({
      ...cfg.shared,
      baseUrl: `${base}${prefix}/${record.slug}`,
      merchant,
      catalog: s.catalog ?? [],
      currency: s.currency,
      timeZone: s.timeZone ?? cfg.shared?.timeZone,
      collectWindowMinutes: s.collectWindowMinutes ?? cfg.shared?.collectWindowMinutes,
      noShowPolicy: s.noShowPolicy ?? cfg.shared?.noShowPolicy,
      // Square tells us when staff mark an order ready, so the QR can wait for that.
      qrEmail: s.qrEmail ?? (s.square && secrets.squareWebhookKey ? "when-ready" : "with-receipt"),
      qrFallbackMinutes: s.qrFallbackMinutes,
      store: cfg.storeFor(record.slug),
      mailer: cfg.mailer,
      signingKeyPem: secrets.signingKeyPem,
      payments: {
        test: Boolean(s.payments?.test),
        ...(x402
          ? {
              x402: {
                payTo: x402.payTo,
                network: x402.network,
                facilitatorUrl: x402.facilitatorUrl,
                ...(secrets.x402RefundKey ? { refunds: { privateKey: secrets.x402RefundKey as `0x${string}` } } : {}),
              },
            }
          : {}),
        ...(secrets.cardSecretKey
          ? { card: { secretKey: secrets.cardSecretKey, webhookSecret: secrets.cardWebhookSecret, captureMode: s.payments?.card?.captureMode } }
          : {}),
      },
      staffKey: secrets.staffKey,
      allowOpenStaff: Boolean(cfg.allowOpenStaff && !secrets.staffKey),
      connectors:
        s.square && secrets.squareAccessToken
          ? [
              squareConnector({
                accessToken: secrets.squareAccessToken,
                locationId: s.square.locationId,
                environment: s.square.environment,
                webhookSignatureKey: secrets.squareWebhookKey,
                fetch: cfg.fetch,
              }),
            ]
          : [],
      ...(s.webhook && secrets.webhookSecret ? { webhook: { url: s.webhook.url, secret: secrets.webhookSecret } } : {}),
    });
  }

  function start(record: VenueRecord) {
    live.get(record.slug)?.stop();
    live.delete(record.slug);
    failed.delete(record.slug);
    try {
      live.set(record.slug, build(record));
    } catch (err) {
      // A venue that can't start (a secret sealed with another key, a bad setting) stays down; the others run.
      failed.set(record.slug, err instanceof Error ? err.message : String(err));
      console.error(`[venues] ${record.slug} didn't start:`, err);
    }
  }

  const ready = (async () => {
    for (const slug of await index()) {
      const record = await recordOf(slug);
      if (record) start(record);
    }
    await Promise.all([...live.values()].map((v) => v.ready));
  })();

  async function upsertVenue(slug: string, body: unknown) {
    if (!SLUG.test(slug) || RESERVED.has(slug)) throw new VenueError("The venue's name in the address must be 1-40 lower-case letters, digits or dashes.");
    const { settings, secrets } = parseVenue(body);
    const existing = await recordOf(slug);
    const current: VenueSecrets = existing ? box.open<VenueSecrets>(existing.sealed) : { signingKeyPem: generateSigningKeyPem() };
    for (const [name, value] of Object.entries(secrets) as [keyof VenueSecrets, string | null][]) {
      if (value === null) delete current[name];
      else current[name] = value;
    }
    const now = Date.now();
    const record: VenueRecord = { slug, settings, sealed: box.seal(current), createdAt: existing?.createdAt ?? now, updatedAt: now };
    await cfg.store.putDoc("venue", slug, record);
    const slugs = await index();
    if (!slugs.includes(slug)) await cfg.store.putDoc("venues", "index", { slugs: [...slugs, slug] });
    start(record);
    await live.get(slug)?.ready;
    return describe(record);
  }

  async function removeVenue(slug: string) {
    const record = await recordOf(slug);
    if (!record) return false;
    live.get(slug)?.stop();
    live.delete(slug);
    failed.delete(slug);
    await cfg.store.putDoc("venues", "index", { slugs: (await index()).filter((s) => s !== slug) });
    await cfg.store.putDoc("venue", slug, { ...record, removedAt: Date.now() });
    return true;
  }

  /** A venue as the admin API shows it: settings, where it lives, which secrets are set (never their values). */
  function describe(record: VenueRecord) {
    let secrets: VenueSecrets | null = null;
    try {
      secrets = box.open<VenueSecrets>(record.sealed);
    } catch {
      // Sealed with a different key: report it rather than fail.
    }
    const url = `${base}${prefix}/${record.slug}`;
    return {
      slug: record.slug,
      url,
      running: live.has(record.slug),
      ...(failed.has(record.slug) ? { error: failed.get(record.slug) } : {}),
      settings: record.settings,
      listed: record.settings.listed !== false,
      secretsSet: secrets
        ? {
            staffKey: Boolean(secrets.staffKey),
            card: Boolean(secrets.cardSecretKey),
            x402Refunds: Boolean(secrets.x402RefundKey),
            square: Boolean(secrets.squareAccessToken),
            squareWebhook: Boolean(secrets.squareWebhookKey),
            webhook: Boolean(secrets.webhookSecret),
          }
        : null,
      links: { shop: url, staff: `${url}/staff`, catalog: `${url}/api/catalog`, ...(record.settings.square ? { squareWebhook: `${url}/connect/square/webhook` } : {}) },
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  const app = new Hono();

  // ---------- admin API ----------
  const admin = new Hono();
  admin.use("*", bearer(cfg.adminKeys));
  admin.use("*", bodyLimit({ maxSize: 256 * 1024, onError: (c) => c.json({ error: "Request body too large." }, 413) }));
  admin.onError((err, c) => (err instanceof VenueError ? c.json({ error: err.message }, 400) : c.json({ error: "Something went wrong." }, 500)));
  admin.get("/venues", async (c) => {
    await ready;
    const list = [];
    for (const slug of await index()) {
      const record = await recordOf(slug);
      if (record) list.push(describe(record));
    }
    return c.json({ venues: list });
  });
  admin.get("/venues/:slug", async (c) => {
    const record = await recordOf(c.req.param("slug"));
    if (!record || (record as VenueRecord & { removedAt?: number }).removedAt) return c.json({ error: "No such venue." }, 404);
    return c.json({ venue: describe(record) });
  });
  admin.put("/venues/:slug", async (c) => {
    await ready;
    const body = await c.req.json().catch(() => null);
    return c.json({ venue: await upsertVenue(c.req.param("slug"), body) });
  });
  admin.delete("/venues/:slug", async (c) => {
    await ready;
    return (await removeVenue(c.req.param("slug"))) ? c.json({ ok: true }) : c.json({ error: "No such venue." }, 404);
  });
  app.route("/host/v1", admin);

  // ---------- the public directory ----------
  /** Every listed venue (and alsoList shop) that's running. */
  async function listings(): Promise<ShopListing[]> {
    await ready;
    const shops: ShopListing[] = [];
    for (const extra of cfg.alsoList ?? []) shops.push(await extra.listing());
    for (const slug of await index()) {
      const venue = live.get(slug);
      const record = venue ? await recordOf(slug) : null;
      if (venue && record && record.settings.listed !== false) shops.push(await venue.listing());
    }
    return shops;
  }
  const num = (v: string | undefined) => (v === undefined || v === "" ? undefined : Number(v));
  app.use("/directory/*", cors({ origin: "*", allowMethods: ["GET"] }));
  app.get("/directory/v1/shops", async (c) => {
    const query: DirectoryQuery = {
      q: c.req.query("q")?.slice(0, 100),
      place: c.req.query("place")?.slice(0, 100),
      lat: num(c.req.query("lat")),
      lng: num(c.req.query("lng")),
      radiusKm: num(c.req.query("radius_km")),
      openNow: c.req.query("open_now") === "true",
      limit: num(c.req.query("limit")),
    };
    const bad = (["lat", "lng", "radiusKm", "limit"] as const).find((k) => query[k] !== undefined && !Number.isFinite(query[k]));
    if (bad) return c.json({ error: `${bad} must be a number.` }, 400);
    if ((query.lat === undefined) !== (query.lng === undefined)) return c.json({ error: "Send lat and lng together." }, 400);
    const shops = searchDirectory(await listings(), query);
    return c.json({ shops, count: shops.length });
  });

  // ---------- each venue at <prefix>/<slug> ----------
  const toVenue = async (c: { req: { param: (k: string) => string | undefined; raw: Request } }) => {
    await ready;
    const venue = live.get(c.req.param("slug") ?? "");
    return venue ? venue.app.fetch(c.req.raw) : new Response(JSON.stringify({ error: "No such venue." }), { status: 404, headers: { "Content-Type": "application/json" } });
  };
  app.all(`${prefix}/:slug`, (c) => toVenue(c));
  app.all(`${prefix}/:slug/*`, (c) => toVenue(c));

  return {
    app,
    ready,
    upsertVenue,
    removeVenue,
    /** The directory's shops, before any search. */
    listings,
    /** The running shop for a venue, for jobs that need it (sweeps run on their own). */
    venue: (slug: string) => live.get(slug) ?? null,
    stop() {
      for (const v of live.values()) v.stop();
    },
  };
}
