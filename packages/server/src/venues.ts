// Many venues on one install: each venue is a full agentPickup shop at <baseUrl>/v/<slug>, with its own
// name, menu, payments, staff key and connectors, added and changed through an admin API. Venue secrets
// (card, Square and staff keys, the refund wallet, the pass-signing key) are sealed with AES-256-GCM
// before they reach the store, so the database never holds them in the clear. Listed venues appear in the
// public directory at /directory/v1/shops, where agents find shops near someone that sell what they want.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { generateSigningKeyPem, type CollectEvent, type Order } from "@agentpickup/core";
import type { CatalogItem, CollectConfig, MerchantConfig } from "./config.js";
import type { Mailer } from "./mail.js";
import type { Store } from "./store.js";
import { parseCatalog } from "./connect.js";
import { squareConnector } from "./connectors/square.js";
import { squareOAuth, type SquareLocationSummary, type SquareTokens } from "./connectors/square-oauth.js";
import { createCollect } from "./index.js";
import { searchDirectory, type DirectoryQuery, type ShopListing } from "./directory.js";
import { mountSignup, type SellerVenue, type SignupConfig } from "./signup.js";
import { checkListingUrl, fetchListing, ListingError } from "./listing.js";

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
  /** Show the venue in the public directory. Default true. */
  listed?: boolean;
  payments?: {
    test?: boolean;
    x402?: { payTo: string; network?: `${string}:${string}`; facilitatorUrl?: string; refundPrivateKey?: string | null };
    card?: { secretKey?: string | null; webhookSecret?: string | null; captureMode?: "hold" | "charge" } | null;
  };
  square?: {
    accessToken?: string | null;
    /** From Sign in with Square: renews the access token before it expires. */
    refreshToken?: string | null;
    locationId: string;
    environment?: "sandbox" | "production";
    webhookSignatureKey?: string | null;
    merchantId?: string;
    /** When the access token expires (unix ms), for venues connected through Sign in with Square. */
    tokenExpiresAt?: number;
    /** Set when the seller disconnected agentPickup in Square; the venue keeps its last menu. */
    revokedAt?: number;
  } | null;
  /** The Square seller who connected the venue, so they can manage it at /seller. */
  owner?: { squareMerchantId?: string };
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
  squareRefreshToken?: string;
  squareWebhookKey?: string;
  webhookSecret?: string;
}

/** A venue as stored: settings in the clear, secrets sealed. */
interface VenueRecord {
  slug: string;
  settings: Omit<VenueInput, "staffKey"> & {
    payments?: { test?: boolean; x402?: { payTo: string; network?: `${string}:${string}`; facilitatorUrl?: string }; card?: { captureMode?: "hold" | "charge" } };
    square?: { locationId: string; environment?: "sandbox" | "production"; merchantId?: string; tokenExpiresAt?: number; revokedAt?: number };
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
  /** Sellers sign themselves up at /connect with Sign in with Square, and manage their venues at /seller. */
  signup?: SignupConfig;
  /**
   * Prices venues in other currencies in US dollars for USDC payments, e.g. fxToUsdCents(). Without it, only
   * venues pricing in USD can take x402.
   */
  toUsdCents?: (cents: number, currency: string) => number | Promise<number>;
  /** Called for every order event at every venue, with the venue's slug, e.g. for usage reports. */
  onEvent?: (slug: string, event: CollectEvent, order: Order) => void | Promise<void>;
  /**
   * Listings other sites register with the directory (POST /directory/v1/listings): another agentPickup install,
   * or any shop taking agent payments at a counter. On by default; false turns registration off. Each is checked
   * when registered and again every `recheckHours` (default 6), and dropped after a day of failed checks.
   */
  listings?: false | { max?: number; recheckHours?: number; allowHttp?: boolean };
}

interface ListingRecord {
  id: string;
  listingUrl: string;
  listing: ShopListing;
  addedAt: number;
  checkedAt: number;
  failures: number;
  lastError?: string;
}

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const RESERVED = new Set(["host", "api", "admin", "connect", "static", "assets", "www", "app"]);
const DAY = 24 * 3600_000;

/** "Corner Café" -> "corner-cafe". */
function slugify(name: string): string {
  const slug = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug || "venue";
}

/** A staff key people can read out and type: "QX7M-4KPA-9TRD". */
function newStaffKey(): string {
  const letters = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const group = () => Array.from({ length: 4 }, () => letters[randomInt(letters.length)]).join("");
  return `${group()}-${group()}-${group()}`;
}

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
  take("squareRefreshToken", v.square === null ? null : v.square?.refreshToken);
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
    ...(v.listed === false ? { listed: false } : {}),
    payments: {
      ...(v.payments?.test ? { test: true } : {}),
      ...(v.payments?.x402 ? { x402: { payTo: v.payments.x402.payTo, network: v.payments.x402.network, facilitatorUrl: v.payments.x402.facilitatorUrl } } : {}),
      ...(v.payments?.card ? { card: { captureMode: v.payments.card.captureMode } } : {}),
    },
    ...(v.square
      ? {
          square: {
            locationId: v.square.locationId,
            environment: v.square.environment,
            ...(typeof v.square.merchantId === "string" ? { merchantId: v.square.merchantId } : {}),
            ...(Number.isFinite(v.square.tokenExpiresAt) ? { tokenExpiresAt: v.square.tokenExpiresAt } : {}),
            ...(Number.isFinite(v.square.revokedAt) ? { revokedAt: v.square.revokedAt } : {}),
          },
        }
      : {}),
    ...(typeof v.owner?.squareMerchantId === "string" ? { owner: { squareMerchantId: v.owner.squareMerchantId } } : {}),
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
  // Listings other sites register with the directory.
  const listingCfg = cfg.listings === false ? null : { max: 500, recheckHours: 6, allowHttp: false, ...(cfg.listings ?? {}) };
  const baseOrigin = new URL(base).origin;
  const here = { kind: "here" as const, domain: new URL(base).hostname };
  const listingIds = async () => (await cfg.store.getDoc<{ ids: string[] }>("listings", "index"))?.ids ?? [];
  const listingRecord = async (id: string) => (await cfg.store.getDoc<ListingRecord>("listing", id)) ?? null;

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
                ...(cfg.toUsdCents ? { toUsdCents: cfg.toUsdCents } : {}),
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
      ...(cfg.shared?.onEvent || cfg.onEvent
        ? {
            onEvent: async (event: CollectEvent, order: Order) => {
              await cfg.shared?.onEvent?.(event, order);
              await cfg.onEvent?.(record.slug, event, order);
            },
          }
        : {}),
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

  /** What the seller page shows a seller about one of their venues. */
  function sellerView(record: VenueRecord): SellerVenue {
    const s = record.settings;
    const url = `${base}${prefix}/${record.slug}`;
    return {
      slug: record.slug,
      name: s.merchant.name,
      currency: s.currency ?? "usd",
      url,
      staffUrl: `${url}/staff`,
      running: live.has(record.slug),
      squareLocationId: s.square?.locationId ?? null,
      squareConnected: Boolean(s.square && !s.square.revokedAt),
      brandColor: s.merchant.brandColor ?? null,
      wallet: s.payments?.x402?.payTo ?? null,
      test: Boolean(s.payments?.test),
      listed: s.listed !== false,
      settings: s as VenueInput,
    };
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
            squareRenewal: Boolean(secrets.squareRefreshToken),
            squareWebhook: Boolean(secrets.squareWebhookKey),
            webhook: Boolean(secrets.webhookSecret),
          }
        : null,
      links: { shop: url, staff: `${url}/staff`, catalog: `${url}/api/catalog`, ...(record.settings.square ? { squareWebhook: `${url}/connect/square/webhook` } : {}) },
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  // ---------- Sign in with Square ----------
  const square = cfg.signup ? squareOAuth({ ...cfg.signup.square, fetch: cfg.signup.square.fetch ?? cfg.fetch }) : null;

  /** Change a venue's settings, and any secrets the change names, without restating the rest. */
  async function patchVenue(slug: string, change: (settings: VenueRecord["settings"]) => VenueInput) {
    const record = await recordOf(slug);
    if (!record || (record as VenueRecord & { removedAt?: number }).removedAt) throw new VenueError("No such venue.");
    return upsertVenue(slug, change(structuredClone(record.settings)));
  }

  async function venuesOwnedBy(merchantId: string): Promise<VenueRecord[]> {
    const owned: VenueRecord[] = [];
    for (const slug of await index()) {
      const record = await recordOf(slug);
      if (record?.settings.owner?.squareMerchantId === merchantId) owned.push(record);
    }
    return owned;
  }

  /** Give every venue a seller owns their newest Square tokens (after signing in again, or a renewal). */
  async function useSquareTokens(tokens: SquareTokens) {
    for (const record of await venuesOwnedBy(tokens.merchantId)) {
      await patchVenue(record.slug, (s) => ({
        ...s,
        ...(s.square
          ? { square: { ...s.square, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, tokenExpiresAt: tokens.expiresAt, revokedAt: undefined } }
          : {}),
      }));
    }
  }

  /**
   * Square access tokens last 30 days and Square asks for renewal at least weekly: renew each seller's once it's
   * a week old. Runs hourly; one renewal covers all of a seller's venues.
   */
  async function renewSquareTokens(now = Date.now()) {
    if (!square) return [];
    const due = new Map<string, string>();
    for (const slug of await index()) {
      const sq = (await recordOf(slug))?.settings.square;
      if (!sq?.merchantId || sq.revokedAt || !sq.tokenExpiresAt || sq.tokenExpiresAt - now > 23 * DAY) continue;
      if (!due.has(sq.merchantId)) due.set(sq.merchantId, slug);
    }
    const renewed: string[] = [];
    for (const [merchantId, slug] of due) {
      try {
        const refreshToken = box.open<VenueSecrets>((await recordOf(slug))!.sealed).squareRefreshToken;
        if (!refreshToken) continue;
        await useSquareTokens(await square.refresh(refreshToken));
        renewed.push(merchantId);
      } catch (err) {
        console.error(`[venues] renewing Square access for ${slug} failed:`, err);
      }
    }
    return renewed;
  }

  /** The seller disconnected agentPickup in Square: stop using their tokens. Each venue keeps its last menu. */
  async function squareRevoked(merchantId: string) {
    for (const record of await venuesOwnedBy(merchantId)) {
      await patchVenue(record.slug, (s) => ({
        ...s,
        ...(s.square ? { square: { ...s.square, accessToken: null, refreshToken: null, revokedAt: Date.now() } } : {}),
      }));
    }
  }

  /** A new venue for one of the seller's Square locations: menu and profile come from Square; test payments until they add a wallet. */
  async function createSquareVenue(tokens: SquareTokens, location: SquareLocationSummary) {
    const name = (location.businessName || location.name).trim().slice(0, 80) || "My venue";
    const stem = slugify(name);
    let slug = stem;
    for (let i = 2; RESERVED.has(slug) || (await recordOf(slug)); i++) slug = `${stem.slice(0, 36)}-${i}`;
    const staffKey = newStaffKey();
    await upsertVenue(slug, {
      merchant: { name, fromEmail: cfg.sendFrom ?? `orders@${new URL(base).hostname}` },
      currency: location.currency,
      payments: { test: true },
      square: {
        locationId: location.id,
        environment: square!.environment,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        merchantId: tokens.merchantId,
        tokenExpiresAt: tokens.expiresAt,
        // Signs the events the host passes on from Square's one webhook, so the QR waits for "ready".
        webhookSignatureKey: randomBytes(24).toString("base64url"),
      },
      owner: { squareMerchantId: tokens.merchantId },
      staffKey,
    } satisfies VenueInput);
    return { slug, staffKey };
  }

  async function resetStaffKey(slug: string) {
    const staffKey = newStaffKey();
    await patchVenue(slug, (s) => ({ ...s, staffKey }));
    return staffKey;
  }

  /** "Tell me when you support my system" from the signup page. */
  async function saveRequest(request: { system: string; email: string }) {
    const list = (await cfg.store.getDoc<{ requests: unknown[] }>("signup", "requests"))?.requests ?? [];
    await cfg.store.putDoc("signup", "requests", { requests: [...list.slice(-499), { ...request, at: Date.now() }] });
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
  admin.get("/requests", async (c) => c.json({ requests: (await cfg.store.getDoc<{ requests: unknown[] }>("signup", "requests"))?.requests ?? [] }));
  admin.get("/listings", async (c) => {
    const list = [];
    for (const id of await listingIds()) list.push(await listingRecord(id));
    return c.json({ listings: list.filter(Boolean) });
  });
  admin.delete("/listings/:id", async (c) => ((await removeListing(c.req.param("id"))) ? c.json({ ok: true }) : c.json({ error: "No such listing." }, 404)));
  app.route("/host/v1", admin);

  // ---------- Square's one webhook for every venue ----------
  if (square && cfg.signup?.square.webhookSignatureKey) {
    const appKey = cfg.signup.square.webhookSignatureKey;
    const hookUrl = cfg.signup.square.webhookUrl ?? `${base}/connect/square/webhook`;
    app.post("/connect/square/webhook", async (c) => {
      const raw = await c.req.text();
      const expected = Buffer.from(createHmac("sha256", appKey).update(hookUrl + raw).digest("base64"));
      const given = Buffer.from(c.req.header("x-square-hmacsha256-signature") ?? "");
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) return c.json({ error: "Signature doesn't match." }, 401);
      const event = JSON.parse(raw) as {
        type?: string;
        merchant_id?: string;
        data?: { object?: { order_fulfillment_updated?: { location_id?: string } } };
      };
      await ready;
      if (event.type === "oauth.authorization.revoked" && event.merchant_id) {
        await squareRevoked(event.merchant_id);
        return c.json({ ok: true });
      }
      const locationId = event.data?.object?.order_fulfillment_updated?.location_id;
      if (!locationId) return c.json({ ok: true });
      for (const slug of await index()) {
        const venue = live.get(slug);
        const record = venue ? await recordOf(slug) : null;
        const sq = record?.settings.square;
        if (!venue || !record || sq?.locationId !== locationId) continue;
        if (event.merchant_id && sq.merchantId && sq.merchantId !== event.merchant_id) continue;
        const venueKey = box.open<VenueSecrets>(record.sealed).squareWebhookKey;
        if (!venueKey) continue;
        // Hand the event to the venue's own Square connector, signed with that venue's key.
        const venueUrl = `${base}${prefix}/${slug}/connect/square/webhook`;
        const signature = createHmac("sha256", venueKey).update(venueUrl + raw).digest("base64");
        await venue.app.fetch(
          new Request(venueUrl, { method: "POST", headers: { "Content-Type": "application/json", "x-square-hmacsha256-signature": signature }, body: raw }),
        );
      }
      return c.json({ ok: true });
    });
  }

  // ---------- sellers sign themselves up ----------
  if (square && cfg.signup) {
    mountSignup(app, {
      base,
      prefix,
      config: cfg.signup,
      square,
      store: cfg.store,
      secretKey: cfg.secretKey,
      convertsCurrency: Boolean(cfg.toUsdCents),
      seal: (value) => box.seal(value),
      open: (sealed) => box.open(sealed),
      ready,
      venuesOwnedBy: async (merchantId) => (await venuesOwnedBy(merchantId)).map((r) => sellerView(r)),
      createSquareVenue,
      useSquareTokens,
      patchVenue: async (slug, change) => {
        await patchVenue(slug, change);
      },
      resetStaffKey,
      removeVenue,
      saveRequest,
      ...(listingCfg ? { registerListing: async (url: string) => registerListing(url) } : {}),
    });
  }

  // ---------- listings other sites register ----------

  /** Fetch and check a listing. An agentPickup shop is checked against its live menu and payments, not its file. */
  async function checkListing(url: URL): Promise<ShopListing> {
    const doFetch = cfg.fetch ?? fetch;
    const listing = await fetchListing(url, doFetch);
    if (listing.order?.via !== "agentpickup") return listing;
    let live: { currency?: string; items?: { id: string; name: string; priceCents: number; description?: string }[]; payments?: { x402?: { network: string } | null; card?: boolean; test?: boolean } };
    try {
      const res = await doFetch(`${listing.url}/api/catalog`, { redirect: "manual", signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`it answered ${res.status}`);
      live = await res.json();
    } catch (err) {
      throw new ListingError(`The listing says it's an agentPickup shop, but its menu at ${listing.url}/api/catalog didn't load (${err instanceof Error ? err.message : err}).`);
    }
    const payments = { x402: live.payments?.x402 ? { network: live.payments.x402.network } : null, card: Boolean(live.payments?.card), test: Boolean(live.payments?.test) };
    return {
      ...listing,
      currency: (live.currency ?? listing.currency).toLowerCase(),
      items: (live.items ?? []).slice(0, 200).map((i) => ({ id: i.id, name: i.name, priceCents: i.priceCents, ...(i.description ? { description: i.description } : {}) })),
      payments,
      testOnly: !(payments.card || (payments.x402 && payments.x402.network !== "eip155:84532")),
    };
  }

  /** Someone registers their listing's URL. Registering again, or another file for the same shop, updates it. */
  async function registerListing(raw: unknown): Promise<ListingRecord> {
    if (!listingCfg) throw new ListingError("This directory doesn't take listings.");
    const url = checkListingUrl(raw, listingCfg.allowHttp);
    if (url.origin === baseOrigin) throw new ListingError("Shops on this site are in the directory already.");
    const listing = await checkListing(url);
    const ids = await listingIds();
    let id = createHash("sha256").update(url.href).digest("hex").slice(0, 16);
    for (const other of ids) if ((await listingRecord(other))?.listing.url === listing.url) id = other;
    const existing = await listingRecord(id);
    if (!existing && ids.length >= listingCfg.max) throw new ListingError("The directory is full for now.");
    const now = Date.now();
    const record: ListingRecord = { id, listingUrl: url.href, listing, addedAt: existing?.addedAt ?? now, checkedAt: now, failures: 0 };
    await cfg.store.putDoc("listing", id, record);
    if (!ids.includes(id)) await cfg.store.putDoc("listings", "index", { ids: [...ids, id] });
    return record;
  }

  async function removeListing(id: string) {
    const ids = await listingIds();
    if (!ids.includes(id)) return false;
    await cfg.store.putDoc("listings", "index", { ids: ids.filter((x) => x !== id) });
    return true;
  }

  /** Check each listing again once it's `recheckHours` old; drop one that has failed for a day. Runs hourly. */
  async function recheckListings(now = Date.now()) {
    if (!listingCfg) return;
    for (const id of await listingIds()) {
      const r = await listingRecord(id);
      if (!r || now - r.checkedAt < listingCfg.recheckHours * 3600_000) continue;
      try {
        await cfg.store.putDoc("listing", id, { ...r, listing: await checkListing(new URL(r.listingUrl)), checkedAt: now, failures: 0, lastError: undefined });
      } catch (err) {
        const failures = r.failures + 1;
        if (failures * listingCfg.recheckHours >= 24) {
          await removeListing(id);
          console.warn(`[venues] dropped the listing ${r.listingUrl} after a day of failed checks:`, err);
        } else {
          await cfg.store.putDoc("listing", id, { ...r, checkedAt: now, failures, lastError: err instanceof Error ? err.message : String(err) });
        }
      }
    }
  }

  /** A listed shop that runs agentPickup, which the hosted MCP server may order from. */
  async function isListedShop(shopBase: string) {
    const want = shopBase.replace(/\/+$/, "");
    for (const id of await listingIds()) {
      const r = await listingRecord(id);
      if (r?.listing.order?.via === "agentpickup" && r.listing.url === want) return true;
    }
    return false;
  }

  // ---------- the public directory ----------
  /** Every listed venue (and alsoList shop) that's running, then the listings other sites registered. */
  async function listings(): Promise<ShopListing[]> {
    await ready;
    const shops: ShopListing[] = [];
    for (const extra of cfg.alsoList ?? []) shops.push({ ...(await extra.listing()), source: here });
    for (const slug of await index()) {
      const venue = live.get(slug);
      const record = venue ? await recordOf(slug) : null;
      if (venue && record && record.settings.listed !== false) shops.push({ ...(await venue.listing()), source: here });
    }
    for (const id of await listingIds()) {
      const r = await listingRecord(id);
      if (r) shops.push(r.listing);
    }
    return shops;
  }
  const num = (v: string | undefined) => (v === undefined || v === "" ? undefined : Number(v));
  app.use("/directory/*", cors({ origin: "*", allowMethods: ["GET", "POST"] }));
  app.post("/directory/v1/listings", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { url?: string };
    try {
      const record = await registerListing(body.url);
      return c.json({ listing: record.listing, listingUrl: record.listingUrl, checkedAt: record.checkedAt }, 201);
    } catch (err) {
      if (err instanceof ListingError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });
  app.get("/directory/v1/listings", async (c) => {
    const list = [];
    for (const id of await listingIds()) {
      const r = await listingRecord(id);
      if (r) list.push({ name: r.listing.name, url: r.listing.url, domain: r.listing.source?.domain, listingUrl: r.listingUrl, addedAt: r.addedAt, checkedAt: r.checkedAt });
    }
    return c.json({ listings: list });
  });
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

  const renewTimer = square ? setInterval(() => void renewSquareTokens(), 3600_000) : null;
  renewTimer?.unref();
  const listingTimer = listingCfg ? setInterval(() => void recheckListings(), 3600_000) : null;
  listingTimer?.unref();

  return {
    app,
    ready,
    upsertVenue,
    removeVenue,
    /** The directory's shops, before any search. */
    listings,
    /** Renew Square access for sellers whose token is a week old. Runs hourly by itself. */
    renewSquareTokens,
    registerListing,
    /** Check listings again once they're due. Runs hourly by itself. */
    recheckListings,
    isListedShop,
    /** The running shop for a venue, for jobs that need it (sweeps run on their own). */
    venue: (slug: string) => live.get(slug) ?? null,
    stop() {
      if (renewTimer) clearInterval(renewTimer);
      if (listingTimer) clearInterval(listingTimer);
      for (const v of live.values()) v.stop();
    },
  };
}
