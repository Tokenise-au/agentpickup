// Sellers sign themselves up: /connect walks a venue through Sign in with Square, choosing the location,
// and how agents pay them; /seller is where they come back to change it. Nothing here needs the admin API.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { isAddress } from "viem";
import type { SquareLocationSummary, SquareOAuth, SquareOAuthConfig, SquareTokens } from "./connectors/square-oauth.js";
import { esc, initialsOf, inkOn } from "./format.js";
import { logoSvg } from "./logos.js";
import type { Store } from "./store.js";
import type { VenueInput } from "./venues.js";

export interface SignupConfig {
  square: SquareOAuthConfig & {
    /**
     * The signature key of your app's webhook subscription at <baseUrl>/connect/square/webhook, subscribed to
     * order.fulfillment.updated and oauth.authorization.revoked. One subscription serves every venue.
     */
    webhookSignatureKey?: string;
    /** The notification URL exactly as entered in Square, if it differs from <baseUrl>/connect/square/webhook. */
    webhookUrl?: string;
  };
  /** USDC for new venues. Default Base Sepolia, the test network. */
  x402?: { network?: `${string}:${string}`; facilitatorUrl?: string };
  /** Shown on the signup pages. Default "agentPickup". */
  platformName?: string;
  /**
   * Extra HTML for the <head> of every signup page, after the built-in styles: your fonts and a stylesheet, so
   * the pages look like the rest of your site. Pages have `body.ap-signup`; the built-in look stays underneath.
   */
  pageHead?: string;
}

/** One of a seller's venues, as the seller page shows it. */
export interface SellerVenue {
  slug: string;
  name: string;
  /** Lower case, "aud". */
  currency: string;
  url: string;
  staffUrl: string;
  running: boolean;
  squareLocationId: string | null;
  squareConnected: boolean;
  /** The colour the seller picked here, if any. */
  brandColor: string | null;
  /** What customers see now: the seller's own settings, with Square's logo and colour filling the gaps. */
  shown: { name: string; logoUrl: string | null; brandColor: string | null };
  wallet: string | null;
  /** Cards through the seller's Square. */
  cards: boolean;
  test: boolean;
  listed: boolean;
  settings: VenueInput;
}

interface SignupDeps {
  base: string;
  prefix: string;
  config: SignupConfig;
  square: SquareOAuth;
  store: Store;
  secretKey: string;
  /** The host can price venues in other currencies in USD, so they can take USDC. */
  convertsCurrency: boolean;
  seal(value: unknown): string;
  open<T>(sealed: string): T;
  ready: Promise<unknown>;
  venuesOwnedBy(merchantId: string): Promise<SellerVenue[]>;
  createSquareVenue(tokens: SquareTokens, location: SquareLocationSummary): Promise<{ slug: string; staffKey: string }>;
  useSquareTokens(tokens: SquareTokens): Promise<void>;
  patchVenue(slug: string, change: (settings: VenueInput) => VenueInput): Promise<void>;
  resetStaffKey(slug: string): Promise<string>;
  removeVenue(slug: string): Promise<boolean>;
  saveRequest(request: { system: string; email: string }): Promise<void>;
  /** Register a listing URL with the directory, for shops that already take agent payments. */
  registerListing?(url: string): Promise<{ listing: { name: string; url: string } }>;
}

/** What Square sign-in left for the next steps: the tokens, the locations, staff keys still to show once. */
interface Pending {
  tokens: SquareTokens;
  locations: SquareLocationSummary[];
  staffKeys: Record<string, string>;
}

interface Session {
  /** Square merchant id. */
  m: string;
  /** The pending sign-in doc. */
  p: string;
  exp: number;
}

const SESSION_COOKIE = "ap_seller";
const STATE_COOKIE = "ap_square_state";
const SESSION_MS = 2 * 3600_000;
/** The name Square gives a business nobody has named yet. */
const SQUARE_PLACEHOLDER_NAMES = new Set(["my business", "default test account"]);
/** The colour pages use when a venue has none of its own and Square gave none. */
const DEFAULT_BRAND = "#111827";

/** A small pickup pass in the venue's name, logo and colour: what a customer sees. */
function brandPreview(shown: SellerVenue["shown"]): string {
  const colour = shown.brandColor ?? DEFAULT_BRAND;
  const on = inkOn(colour);
  // The brand colour as text on white only when it's dark enough to read there, as on the real pass.
  const text = on === "#ffffff" ? colour : "#14161a";
  const mark = shown.logoUrl ? `<img src="${esc(shown.logoUrl)}" alt="">` : `<span class="pv-mono">${esc(initialsOf(shown.name))}</span>`;
  return `<figure class="preview" style="--b:${esc(colour)};--on:${on};--bt:${esc(text)}" aria-label="Preview of the pickup pass">
    <div class="pv-head">${mark}<b>${esc(shown.name)}</b></div>
    <div class="pv-body"><span class="pv-pill">Ready to collect</span><span class="pv-qr" aria-hidden="true"></span><span class="pv-code">K7P4QX</span><span class="pv-btn">Open my pass</span></div>
  </figure>`;
}

const OTHER_SYSTEMS = ["Lightspeed", "Toast", "Clover", "Shopify POS", "Doshii", "Deliverect", "Something else"];
const NETWORKS: Record<string, string> = { "eip155:8453": "Base", "eip155:84532": "Base Sepolia, the test network" };

export function mountSignup(app: Hono, deps: SignupDeps) {
  const { base, config, square } = deps;
  const platform = config.platformName ?? "agentPickup";
  const network = config.x402?.network ?? "eip155:84532";
  const secure = base.startsWith("https://");
  const key = createHash("sha256").update(`agentpickup-seller:${deps.secretKey}`).digest();
  const mac = (text: string) => createHmac("sha256", key).update(text).digest("base64url");

  // ---------- the seller's session: a signed cookie ----------
  function readSession(c: Context): Session | null {
    const raw = getCookie(c, SESSION_COOKIE);
    if (!raw) return null;
    const [body, sig] = raw.split(".");
    if (!body || !sig || !safeEqual(sig, mac(body))) return null;
    try {
      const s = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Session;
      return s.exp > Date.now() ? s : null;
    } catch {
      return null;
    }
  }
  function writeSession(c: Context, s: Session) {
    const body = Buffer.from(JSON.stringify(s)).toString("base64url");
    setCookie(c, SESSION_COOKIE, `${body}.${mac(body)}`, { path: "/", httpOnly: true, sameSite: "Lax", secure, maxAge: SESSION_MS / 1000 });
  }
  /** Forms carry a token tied to the session, on top of the SameSite cookie. */
  const csrfFor = (s: Session) => mac(`csrf:${s.m}:${s.exp}`);
  const csrfOk = (s: Session, given: unknown) => typeof given === "string" && safeEqual(given, csrfFor(s));

  async function pendingOf(s: Session): Promise<Pending | null> {
    const doc = await deps.store.getDoc<{ sealed: string; at: number }>("signup", `pending:${s.p}`);
    if (!doc || Date.now() - doc.at > SESSION_MS) return null;
    return deps.open<Pending>(doc.sealed);
  }
  async function savePending(id: string, pending: Pending) {
    await deps.store.putDoc("signup", `pending:${id}`, { sealed: deps.seal(pending), at: Date.now() });
  }
  async function owns(s: Session, slug: string) {
    return (await deps.venuesOwnedBy(s.m)).find((v) => v.slug === slug) ?? null;
  }

  const page = (title: string, body: string, step?: number) => pageHtml({ platform, title, body, step, head: config.pageHead });
  const formLimit = bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.text("Too much data.", 413) });
  app.use("/connect/*", formLimit);
  app.use("/seller/*", formLimit);

  // ---------- 1. pick your system ----------
  app.get("/connect", (c) =>
    c.html(
      page(
        "Integrate your POS",
        `<p class="lede">Keep the POS you already use. Orders that people's AI assistants place and pay for arrive on
        your screens like any pickup order, and staff scan the customer's QR to hand over.</p>
        <section class="card system">
          <div class="row spread"><span class="brandmark">${logoSvg("Square")}<h2>Square</h2></span><span class="pill live">Live</span></div>
          <p class="muted">Sign in to your Square account and approve ${esc(platform)}. Your menu, logo, address and hours come
          from Square; you never share a password with us.</p>
          <a class="btn" href="/connect/square/start">Sign in with Square</a>
        </section>
        <section class="card">
          <div class="row spread"><h2>Another system</h2><span class="pill">Coming</span></div>
          <p class="muted">We're adding more. Pick yours and we'll email you when it's ready.</p>
          <form method="post" action="/connect/request" class="stack">
            <fieldset class="choices"><legend class="sr">Your system</legend>${OTHER_SYSTEMS.map(
              (s, i) => `<label class="choice"><input type="radio" name="system" value="${esc(s)}"${i === 0 ? " checked" : ""}>${logoSvg(s)}<span>${esc(s)}</span></label>`,
            ).join("")}</fieldset>
            <label>Your email <input type="email" name="email" required maxlength="200" autocomplete="email"></label>
            <button class="btn ghost" type="submit">Let me know</button>
          </form>
        </section>
        ${
          deps.registerListing
            ? `<section class="card">
          <h2>Already take agent payments?</h2>
          <p class="muted">If you run agentPickup yourself, or take x402 or UCP payments at a counter, publish a listing on your
          site and add its address here. Agents then find you through ${esc(platform)}'s directory.</p>
          <form method="post" action="/connect/listing" class="stack">
            <label>Listing URL <input type="url" name="url" required maxlength="500" placeholder="https://yourshop.com/.well-known/agentpickup.json"></label>
            <button class="btn ghost" type="submit">List my shop</button>
          </form>
          <p class="muted small">An agentPickup shop serves its listing at /.well-known/agentpickup.json already.</p>
        </section>`
            : ""
        }
        <p class="muted small">Already connected? <a href="/seller">Manage your venue</a>.</p>`,
      ),
    ),
  );

  app.post("/connect/request", async (c) => {
    const form = await c.req.parseBody();
    const email = String(form.email ?? "").trim();
    const system = String(form.system ?? "");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !OTHER_SYSTEMS.includes(system)) {
      return c.html(page("Something's missing", `<p>Choose your system and enter your email.</p><p><a href="/connect">Back</a></p>`), 400);
    }
    await deps.saveRequest({ system, email });
    return c.html(page("Thanks", `<p class="lede">We'll email ${esc(email)} when ${esc(platform)} works with ${esc(system)}.</p><p><a href="/">Back to ${esc(platform)}</a></p>`));
  });

  app.post("/connect/listing", async (c) => {
    if (!deps.registerListing) return c.redirect("/connect");
    const form = await c.req.parseBody();
    try {
      const { listing } = await deps.registerListing(String(form.url ?? ""));
      return c.html(
        page(
          "You're listed",
          `<p class="lede">${esc(listing.name)} is in the directory. Agents searching nearby or for what you sell will find it.</p>
           <p class="muted small">We check your listing every few hours, so changes to it show up on their own.</p>
           <p><a href="/directory/v1/shops?q=${encodeURIComponent(listing.name)}">See your entry</a></p>`,
        ),
      );
    } catch (err) {
      return c.html(page("Not listed yet", `<p class="lede">${esc(err instanceof Error ? err.message : String(err))}</p><p><a class="btn" href="/connect">Back</a></p>`), 400);
    }
  });

  // ---------- 2. Sign in with Square ----------
  app.get("/connect/square/start", (c) => {
    const state = randomBytes(18).toString("base64url");
    const next = c.req.query("next") === "seller" ? "seller" : "signup";
    setCookie(c, STATE_COOKIE, `${state}.${next}`, { path: "/connect/square", httpOnly: true, sameSite: "Lax", secure, maxAge: 600 });
    return c.redirect(square.authorizeUrl(state));
  });

  app.get("/connect/square/callback", async (c) => {
    const [expected, next] = (getCookie(c, STATE_COOKIE) ?? "").split(".");
    deleteCookie(c, STATE_COOKIE, { path: "/connect/square" });
    if (c.req.query("error")) {
      return c.html(page("Not connected", `<p class="lede">Square didn't connect: you may have chosen not to approve ${esc(platform)}.</p><p><a class="btn" href="/connect">Try again</a></p>`));
    }
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state || !expected || !safeEqual(state, expected)) {
      return c.html(page("Start again", `<p class="lede">That sign-in link has expired or didn't come from here.</p><p><a class="btn" href="/connect">Start again</a></p>`), 400);
    }
    let tokens: SquareTokens;
    let locations: SquareLocationSummary[];
    try {
      tokens = await square.exchangeCode(code);
      locations = await square.listLocations(tokens.accessToken);
    } catch (err) {
      console.error("[signup] Square sign-in failed:", err);
      return c.html(page("Square didn't answer", `<p class="lede">We couldn't finish signing in with Square. Try again in a minute.</p><p><a class="btn" href="/connect">Try again</a></p>`), 502);
    }
    await deps.ready;
    // Their existing venues get the fresh tokens too.
    await deps.useSquareTokens(tokens);
    const id = randomBytes(12).toString("base64url");
    await savePending(id, { tokens, locations, staffKeys: {} });
    writeSession(c, { m: tokens.merchantId, p: id, exp: Date.now() + SESSION_MS });
    return c.redirect(next === "seller" ? "/seller" : "/connect/location");
  });

  // ---------- 3. choose the location ----------
  app.get("/connect/location", async (c) => {
    const s = readSession(c);
    const pending = s && (await pendingOf(s));
    if (!s || !pending) return c.redirect("/connect");
    const mine = await deps.venuesOwnedBy(s.m);
    const active = pending.locations.filter((l) => l.active);
    if (!active.length) {
      return c.html(page("No locations", `<p class="lede">Your Square account has no active locations. Add one in Square, then <a href="/connect">sign in again</a>.</p>`, 2));
    }
    const rows = active
      .map((l, i) => {
        const venue = mine.find((v) => v.squareLocationId === l.id);
        return venue
          ? `<div class="option done"><b>${esc(l.name)}</b><span class="muted">${esc(l.address)}</span><a href="/seller">Connected: manage</a></div>`
          : `<label class="option"><input type="radio" name="locationId" value="${esc(l.id)}"${i === 0 ? " checked" : ""}><b>${esc(l.name)}</b><span class="muted">${esc(l.address || l.businessName)}</span></label>`;
      })
      .join("");
    const free = active.some((l) => !mine.some((v) => v.squareLocationId === l.id));
    return c.html(
      page(
        "Which location takes pickup orders?",
        `<form method="post" action="/connect/location" class="stack">
          <input type="hidden" name="csrf" value="${csrfFor(s)}">
          ${rows}
          ${free ? `<button class="btn" type="submit">Connect this location</button>` : `<p class="muted">Every location is connected.</p>`}
        </form>`,
        2,
      ),
    );
  });

  app.post("/connect/location", async (c) => {
    const s = readSession(c);
    const pending = s && (await pendingOf(s));
    const form = await c.req.parseBody();
    if (!s || !pending || !csrfOk(s, form.csrf)) return c.redirect("/connect");
    const location = pending.locations.find((l) => l.id === form.locationId && l.active);
    if (!location) return c.redirect("/connect/location");
    if ((await deps.venuesOwnedBy(s.m)).some((v) => v.squareLocationId === location.id)) return c.redirect("/seller");
    const { slug, staffKey } = await deps.createSquareVenue(pending.tokens, location);
    await savePending(s.p, { ...pending, staffKeys: { ...pending.staffKeys, [slug]: staffKey } });
    return c.redirect(`/connect/payments?venue=${encodeURIComponent(slug)}`);
  });

  // ---------- 4. how agents pay ----------
  app.get("/connect/payments", async (c) => {
    const s = readSession(c);
    const venue = s && (await owns(s, c.req.query("venue") ?? ""));
    if (!s || !venue) return c.redirect("/seller");
    return c.html(
      page(
        "How you get paid",
        `<p class="lede">The money goes straight to you: ${esc(platform)} never holds it.</p>
        <form method="post" action="/connect/payments?venue=${encodeURIComponent(venue.slug)}" class="stack">
          <input type="hidden" name="csrf" value="${csrfFor(s)}">
          <label class="check"><input type="checkbox" name="cards" value="1" checked> <span><b>Cards and Google Pay, through your Square.</b> The customer pays on a checkout page
            and the money lands in your Square account, at Square's usual card fees. The order shows on your Square screens as paid by card.</span></label>
          <label>USDC wallet address <span class="muted">(optional)</span>
            <input name="wallet" placeholder="0x…" spellcheck="false" autocomplete="off" maxlength="42" value="${esc(venue.wallet ?? "")}"></label>
          <p class="muted small">Agents can also pay in USDC, a digital US dollar, straight to your wallet on ${esc(NETWORKS[network] ?? network)}.${
            venue.currency === "usd"
              ? ""
              : deps.convertsCurrency
                ? ` Your ${esc(venue.currency.toUpperCase())} prices are converted to US dollars at the day's exchange rate when an agent orders.`
                : ` USDC can't be taken for ${esc(venue.currency.toUpperCase())} prices here yet.`
          }</p>
          <label class="check"><input type="checkbox" name="test" value="1" checked> Keep test mode on, so you can try orders with no real money first</label>
          <button class="btn" type="submit">Continue</button>
        </form>`,
        3,
      ),
    );
  });

  app.post("/connect/payments", async (c) => {
    const s = readSession(c);
    const slug = c.req.query("venue") ?? "";
    const form = await c.req.parseBody();
    const venue = s && csrfOk(s, form.csrf) ? await owns(s, slug) : null;
    if (!s || !venue) return c.redirect("/seller");
    const payments = paymentsChange(venue, String(form.wallet ?? ""), form.test === "1", form.cards === "1");
    if ("problem" in payments) {
      return c.html(page("Check your wallet", `<p class="lede">${esc(payments.problem)}</p><p><a class="btn" href="/connect/payments?venue=${encodeURIComponent(slug)}">Back</a></p>`, 3), 400);
    }
    await deps.patchVenue(slug, payments.apply);
    return c.redirect(`/connect/done?venue=${encodeURIComponent(slug)}`);
  });

  /**
   * A venue's cards, wallet and test mode, checked. With no real way to pay (no cards, no wallet), test mode
   * stays on so the venue can still take orders.
   */
  function paymentsChange(venue: SellerVenue, walletInput: string, test: boolean, cards: boolean): { problem: string } | { apply: (v: VenueInput) => VenueInput } {
    const wallet = walletInput.trim();
    if (wallet && !isAddress(wallet)) return { problem: "That isn't a wallet address. It starts with 0x and has 40 more letters and digits." };
    if (wallet && venue.currency !== "usd" && !deps.convertsCurrency) {
      return { problem: `USDC is US dollars, and your prices are in ${venue.currency.toUpperCase()}. This platform can't convert them yet, so leave the wallet empty for now.` };
    }
    return {
      apply: (v) => ({
        ...v,
        payments: {
          ...v.payments,
          test: test || (!wallet && !(cards && v.square)),
          x402: wallet ? { payTo: wallet, network, facilitatorUrl: config.x402?.facilitatorUrl } : undefined,
        },
        ...(v.square ? { square: { ...v.square, cards } } : {}),
      }),
    };
  }

  // ---------- 5. done ----------
  app.get("/connect/done", async (c) => {
    const s = readSession(c);
    const venue = s && (await owns(s, c.req.query("venue") ?? ""));
    if (!s || !venue) return c.redirect("/seller");
    // The staff key is shown once; the seller page makes a new one.
    const pending = await pendingOf(s);
    const staffKey = pending?.staffKeys[venue.slug];
    if (pending && staffKey) {
      const { [venue.slug]: _shown, ...rest } = pending.staffKeys;
      await savePending(s.p, { ...pending, staffKeys: rest });
    }
    return c.html(
      page(
        venue.test ? `${venue.name} is set up in test mode` : `${venue.name} is live`,
        `${
          staffKey
            ? `<section class="card key"><span class="muted small">Staff key</span><code>${esc(staffKey)}</code>
               <p class="muted small">Staff sign in to the scanner with this. Write it down: it's shown once. You can make a new one on your seller page.</p></section>`
            : ""
        }
        <section class="card">
          <h2>How orders work</h2>
          <ol>
            <li>An agent orders. The customer pays by card through your Square, or the agent pays in USDC, and the order appears in Square as a paid pickup order.</li>
            <li>Mark it ready in Square as usual. The customer gets their pickup QR by email.</li>
            <li>Scan the QR on the staff page to hand it over. Square closes the order.</li>
          </ol>
          <div class="row">
            <a class="btn" href="${esc(venue.staffUrl)}">Open the staff page</a>
            <a class="btn ghost" href="/seller">Seller page</a>
          </div>
        </section>
        <p class="muted small">${venue.listed ? `Agents can find you in the <a href="/directory/v1/shops?q=${encodeURIComponent(venue.name)}">directory</a>.` : ""}
        ${venue.test ? " Test mode is on: orders go through with no real money until you add a wallet and turn it off." : ""}</p>`,
        4,
      ),
    );
  });

  // ---------- the seller page ----------
  app.get("/seller", async (c) => {
    const s = readSession(c);
    if (!s) {
      return c.html(
        page(
          "Your venues",
          `<p class="lede">Sign in with the Square account you connected.</p><p><a class="btn" href="/connect/square/start?next=seller">Sign in with Square</a></p>
          <p class="muted small">New here? <a href="/connect">Integrate your POS</a>.</p>`,
        ),
      );
    }
    return c.html(await sellerPage(s, c.req.query("saved") ?? null));
  });

  async function sellerPage(s: Session, saved: string | null, shownKey?: { slug: string; key: string }, problem?: { slug: string; text: string }) {
    const venues = await deps.venuesOwnedBy(s.m);
    const csrf = csrfFor(s);
    const cards = venues
      .map((v) => {
        const action = `/seller/venues/${encodeURIComponent(v.slug)}`;
        const colour = v.shown.brandColor ?? DEFAULT_BRAND;
        const hints = [
          SQUARE_PLACEHOLDER_NAMES.has(v.name.trim().toLowerCase()) ? `"${esc(v.name)}" is Square's placeholder. Type your shop's name below.` : "",
          v.shown.logoUrl
            ? ""
            : `No logo yet. Add one to this location in your <a href="https://squareup.com/dashboard/locations" target="_blank" rel="noopener">Square Dashboard</a>; it shows here within the hour, or when you save.`,
          !v.brandColor && v.shown.brandColor ? "The colour comes from your Square online checkout. Pick another below to change it here." : "",
        ].filter(Boolean);
        return `<section class="card" id="${esc(v.slug)}">
          <div class="row spread"><h2>${esc(v.name)}</h2><span class="pill">${v.test ? "Test mode" : "Live"}</span></div>
          <p class="muted small">${v.squareConnected ? "Connected to Square" : "Square disconnected: sign in again to reconnect"} · ${v.listed ? "In the directory" : "Not in the directory"}</p>
          ${saved === v.slug ? `<p class="ok small">Saved.</p>` : ""}
          ${problem?.slug === v.slug ? `<p class="bad small">${esc(problem.text)}</p>` : ""}
          ${shownKey?.slug === v.slug ? `<section class="key"><span class="muted small">New staff key, shown once</span><code>${esc(shownKey.key)}</code></section>` : ""}
          <div class="brand">${brandPreview(v.shown)}
            <div class="stack"><span class="muted small">How customers see you, on the pass, the emails and the staff scanner.</span>
            ${hints.map((h) => `<p class="hint small">${h}</p>`).join("")}</div>
          </div>
          <form method="post" action="${action}" class="stack">
            <input type="hidden" name="csrf" value="${csrf}">
            <label>Shop name <input type="text" name="name" maxlength="80" required value="${esc(v.name)}" autocomplete="organization"></label>
            <input type="hidden" name="brandColorWas" value="${esc(colour)}">
            <label>Brand colour <input type="color" name="brandColor" value="${esc(colour)}"></label>
            <label class="check"><input type="checkbox" name="cards" value="1"${v.cards ? " checked" : ""}> Cards and Google Pay through your Square</label>
            <label>Wallet for USDC <input name="wallet" placeholder="0x…" spellcheck="false" autocomplete="off" maxlength="42" value="${esc(v.wallet ?? "")}"></label>
            <label class="check"><input type="checkbox" name="test" value="1"${v.test ? " checked" : ""}> Test mode</label>
            <label class="check"><input type="checkbox" name="listed" value="1"${v.listed ? " checked" : ""}> Show me in the agent directory</label>
            <button class="btn" type="submit">Save</button>
          </form>
          <div class="row">
            <a class="btn ghost" href="${esc(v.staffUrl)}">Staff page</a>
            <form method="post" action="${action}/staff-key"><input type="hidden" name="csrf" value="${csrf}"><button class="btn ghost" type="submit">New staff key</button></form>
          </div>
          <details><summary class="muted small">Disconnect</summary>
            <form method="post" action="${action}/disconnect" class="stack">
              <input type="hidden" name="csrf" value="${csrf}">
              <label class="check"><input type="checkbox" name="sure" value="1" required> Take ${esc(v.name)} off ${esc(platform)}. Orders already placed stay with you in Square.</label>
              <button class="btn danger" type="submit">Disconnect</button>
            </form>
          </details>
        </section>`;
      })
      .join("");
    return page(
      "Your venues",
      `${cards || `<p class="lede">No venues connected yet.</p>`}
      <div class="row"><a class="btn ghost" href="/connect/location">Connect another location</a>
      <form method="post" action="/seller/signout"><input type="hidden" name="csrf" value="${csrf}"><button class="btn ghost" type="submit">Sign out</button></form></div>`,
    );
  }

  app.post("/seller/venues/:slug", async (c) => {
    const s = readSession(c);
    const slug = c.req.param("slug");
    const form = await c.req.parseBody();
    const venue = s && csrfOk(s, form.csrf) ? await owns(s, slug) : null;
    if (!s || !venue) return c.redirect("/seller");
    const colour = String(form.brandColor ?? "").toLowerCase();
    // An untouched colour box still submits; keep following Square's colour until the seller picks one.
    const picked = /^#[0-9a-f]{6}$/.test(colour) && (venue.brandColor !== null || colour !== String(form.brandColorWas ?? "").toLowerCase());
    const name = String(form.name ?? "").trim().replace(/\s+/g, " ").slice(0, 80);
    const payments = paymentsChange(venue, String(form.wallet ?? ""), form.test === "1", form.cards === "1");
    if ("problem" in payments) return c.html(await sellerPage(s, null, undefined, { slug, text: payments.problem }), 400);
    await deps.patchVenue(slug, (v) => ({
      ...payments.apply(v),
      merchant: { ...v.merchant, ...(name ? { name } : {}), ...(picked ? { brandColor: colour } : {}) },
      listed: form.listed === "1",
    }));
    return c.redirect(`/seller?saved=${encodeURIComponent(slug)}#${encodeURIComponent(slug)}`);
  });

  app.post("/seller/venues/:slug/staff-key", async (c) => {
    const s = readSession(c);
    const slug = c.req.param("slug");
    const form = await c.req.parseBody();
    if (!s || !csrfOk(s, form.csrf) || !(await owns(s, slug))) return c.redirect("/seller");
    return c.html(await sellerPage(s, null, { slug, key: await deps.resetStaffKey(slug) }));
  });

  app.post("/seller/venues/:slug/disconnect", async (c) => {
    const s = readSession(c);
    const slug = c.req.param("slug");
    const form = await c.req.parseBody();
    if (!s || !csrfOk(s, form.csrf) || form.sure !== "1" || !(await owns(s, slug))) return c.redirect("/seller");
    await deps.removeVenue(slug);
    // With no venues left, end agentPickup's access to their Square account altogether.
    if (!(await deps.venuesOwnedBy(s.m)).length) {
      await square.revoke(s.m).catch((err) => console.error("[signup] revoking Square access failed:", err));
    }
    return c.redirect("/seller");
  });

  app.post("/seller/signout", async (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.redirect("/seller");
  });
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function pageHtml(o: { platform: string; title: string; body: string; step?: number; head?: string }): string {
  const steps = ["Integrate", "Location", "Payments", "Done"];
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(o.title)} · ${esc(o.platform)}</title>
<meta name="robots" content="noindex">
<style>
:root { --bg:#f6f7f5; --card:#fff; --line:#dfe3dd; --fg:#15181b; --muted:#5d646c; --accent:#111827; --accent-ink:#fff; --ok:#1f8a46; --bad:#b42318; color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root { --bg:#0f1113; --card:#171a1d; --line:#2a2f35; --fg:#eef0f3; --muted:#9aa2ab; --accent:#eef0f3; --accent-ink:#0f1113; --ok:#7fd99a; --bad:#f87171; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
main { max-width:560px; margin:0 auto; padding:28px 16px 64px; display:grid; gap:16px; }
header { display:flex; justify-content:space-between; align-items:center; gap:12px; font-weight:700; }
header a { color:inherit; text-decoration:none; }
.steps { display:flex; gap:6px; font-size:12px; color:var(--muted); font-weight:500; }
.steps span.on { color:var(--fg); font-weight:700; }
h1 { font-size:26px; line-height:1.2; margin:8px 0 0; }
h2 { font-size:18px; margin:0; }
p { margin:0; }
.lede { color:var(--muted); }
.muted { color:var(--muted); }
.small { font-size:13.5px; }
.ok { color:var(--ok); } .bad { color:var(--bad); }
a { color:inherit; text-underline-offset:3px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:18px; display:grid; gap:12px; }
.stack { display:grid; gap:12px; }
.row { display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
.row.spread { justify-content:space-between; }
label { display:grid; gap:6px; font-size:14px; font-weight:600; }
label.check { display:flex; gap:10px; align-items:flex-start; font-weight:400; }
input[type=email], input[type=url], input[type=text], input[name=wallet], select { font:inherit; font-size:15px; padding:10px 12px; border:1px solid var(--line); border-radius:10px; background:var(--bg); color:var(--fg); width:100%; }
input[type=color] { width:56px; height:36px; border:1px solid var(--line); border-radius:8px; background:none; padding:2px; }
.btn { display:inline-block; font:inherit; font-size:15px; font-weight:600; text-decoration:none; text-align:center; padding:11px 16px; border-radius:10px; border:1px solid var(--accent); background:var(--accent); color:var(--accent-ink); cursor:pointer; }
.btn.ghost { background:transparent; color:var(--fg); border-color:var(--line); }
.btn.danger { background:var(--bad); border-color:var(--bad); color:#fff; }
.btn:focus-visible, input:focus-visible, select:focus-visible { outline:2px solid var(--fg); outline-offset:2px; }
.option { display:grid; grid-template-columns:auto 1fr; column-gap:10px; padding:12px 14px; border:1px solid var(--line); border-radius:12px; background:var(--card); font-weight:400; }
.option span, .option a { grid-column:2; font-size:14px; }
.option.done { grid-template-columns:1fr; }
.option.done span, .option.done a { grid-column:1; }
.key code { display:block; font:600 22px/1.3 ui-monospace,Menlo,Consolas,monospace; letter-spacing:.06em; margin:4px 0; }
.pill { font-size:12px; border:1px solid var(--line); border-radius:999px; padding:3px 10px; color:var(--muted); }
ol { margin:0; padding-left:20px; display:grid; gap:6px; color:var(--muted); }
details summary { cursor:pointer; }
.brandmark { display:flex; align-items:center; gap:10px; }
.logo { width:22px; height:22px; flex:0 0 auto; }
.pill.live { color:var(--ok); border-color:currentColor; }
.choices { border:0; margin:0; padding:0; display:grid; grid-template-columns:repeat(auto-fill, minmax(150px, 1fr)); gap:8px; }
.choice { display:flex; align-items:center; gap:9px; padding:10px 12px; border:1px solid var(--line); border-radius:10px; font-weight:500; cursor:pointer; }
.choice input { margin:0; }
.choice .logo { width:18px; height:18px; }
.choice:has(input:checked) { border-color:var(--fg); }
.sr { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
.brand { display:grid; grid-template-columns:200px minmax(0,1fr); gap:16px; align-items:start; }
@media (max-width:520px) { .brand { grid-template-columns:1fr; } }
.hint { border-left:3px solid var(--muted); padding-left:10px; color:var(--muted); }
.preview { margin:0; border-radius:14px; overflow:hidden; border:1px solid var(--line); background:#f6f7f8; color:#111827; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
.pv-head { display:flex; align-items:center; gap:8px; padding:10px 12px; background:var(--b); color:var(--on); font-size:14px; }
.pv-head img { height:22px; max-width:90px; object-fit:contain; background:#fff; border-radius:5px; padding:2px; }
.pv-head b { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.pv-mono { display:grid; place-items:center; width:24px; height:24px; border-radius:6px; background:var(--on); color:var(--b); font-size:11px; font-weight:800; flex:0 0 auto; }
.pv-body { display:grid; justify-items:center; gap:7px; padding:14px 12px 16px; background:#fff; margin:10px; border-radius:10px; }
.pv-pill { font-size:11px; font-weight:600; color:#047857; background:#ecfdf5; border-radius:999px; padding:2px 8px; }
.pv-qr { width:76px; height:76px; background:conic-gradient(#111827 25%, #fff 0 50%, #111827 0 75%, #fff 0) 0 0/19px 19px; border:5px solid #fff; outline:1px solid #e5e7eb; }
.pv-code { font:700 15px ui-monospace,Menlo,Consolas,monospace; letter-spacing:.18em; color:var(--bt); }
.pv-btn { font-size:12px; font-weight:600; background:var(--b); color:var(--on); border-radius:8px; padding:7px 12px; }
</style>${o.head ?? ""}</head>
<body class="ap-signup"><main>
<header><a href="/">${esc(o.platform)}</a>${
    o.step ? `<span class="steps">${steps.map((s, i) => `<span class="${i + 1 === o.step ? "on" : ""}">${i + 1}. ${s}</span>`).join("")}</span>` : ""
  }</header>
<h1>${esc(o.title)}</h1>
${o.body}
</main></body></html>`;
}
