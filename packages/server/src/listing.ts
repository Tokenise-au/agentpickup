// The open listing format: a shop that takes agent payments at a counter describes itself in one JSON file, and
// any directory can list it. Every agentPickup shop serves its own at <shop>/.well-known/agentpickup.json; a shop
// running something else (an x402 or UCP checkout) publishes the same file on its own site and registers its URL.
import type { ShopListing } from "./directory.js";

export const LISTING_VERSION = "listing/1";

/** The file a shop publishes. */
export type ListingDocument = Omit<ShopListing, "source" | "testOnly"> & { agentpickup: typeof LISTING_VERSION; updatedAt?: string };

export class ListingError extends Error {}

const TESTNETS = new Set(["eip155:84532"]);
const PROTOCOLS = new Set(["ucp", "acp", "mpp"]);

export function listingDocument(l: ShopListing): ListingDocument {
  const { source: _source, testOnly: _testOnly, ...rest } = l;
  return { agentpickup: LISTING_VERSION, ...rest, order: rest.order ?? { via: "agentpickup" }, updatedAt: new Date().toISOString() };
}

/**
 * A URL the directory may fetch: https on a public domain name (no IP addresses, no localhost, no other ports),
 * so a listing can't point the directory at private networks.
 */
export function checkListingUrl(raw: unknown, allowHttp = false): URL {
  let url: URL;
  try {
    url = new URL(String(raw));
  } catch {
    throw new ListingError("That isn't a URL.");
  }
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) throw new ListingError("The listing must be served over https.");
  if (url.username || url.password) throw new ListingError("The listing URL can't carry a username or password.");
  if (url.port) throw new ListingError("The listing must be on the standard https port.");
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) throw new ListingError("The listing must be on a public site.");
  if (/^[\d.]+$/.test(host) || host.includes(":") || host.startsWith("[")) throw new ListingError("The listing must be on a domain name, not an IP address.");
  if (!host.includes(".")) throw new ListingError("The listing must be on a public site.");
  return url;
}

const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() && v.length <= max ? v.trim() : null);
const sameSite = (raw: unknown, origin: string, what: string) => {
  const url = checkListingUrl(raw, origin.startsWith("http:"));
  if (url.origin !== origin) throw new ListingError(`${what} must be on the listing's own site (${origin}), so nobody can list someone else's shop.`);
  return url.href.replace(/\/+$/, "");
};

/** Check a listing someone registered and turn it into a directory entry. */
export function parseListing(doc: unknown, listingUrl: URL): ShopListing {
  const d = doc as Partial<ListingDocument> | null;
  if (!d || typeof d !== "object") throw new ListingError("The listing isn't a JSON object.");
  if (d.agentpickup !== LISTING_VERSION) throw new ListingError(`The listing needs "agentpickup": "${LISTING_VERSION}".`);
  const name = str(d.name, 80);
  if (!name) throw new ListingError("The listing needs a name (up to 80 characters).");
  const url = sameSite(d.url, listingUrl.origin, "The shop's url");

  const loc = d.location as Partial<ShopListing["location"]> | undefined;
  const locationName = str(loc?.name, 80);
  if (!loc || !locationName) throw new ListingError("The listing needs location.name: where people collect.");
  const { lat, lng } = loc;
  if ((lat !== undefined || lng !== undefined) && !(typeof lat === "number" && Math.abs(lat) <= 90 && typeof lng === "number" && Math.abs(lng) <= 180)) {
    throw new ListingError("location needs both lat (-90 to 90) and lng (-180 to 180).");
  }
  const time = /^([01]\d|2[0-3]):[0-5]\d$/;
  const openingHours = loc.openingHours;
  if (
    openingHours !== undefined &&
    !(Array.isArray(openingHours) && openingHours.length <= 50 && openingHours.every((p) => Number.isInteger(p?.day) && p.day >= 0 && p.day <= 6 && time.test(p.open) && time.test(p.close)))
  ) {
    throw new ListingError('location.openingHours is a list of { day: 0-6 (Sunday 0), open: "07:00", close: "15:00" }.');
  }
  let timeZone: string | undefined;
  if (d.timeZone !== undefined) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: String(d.timeZone) });
      timeZone = String(d.timeZone);
    } catch {
      throw new ListingError("timeZone isn't a time zone, such as Australia/Brisbane.");
    }
  }
  const currency = typeof d.currency === "string" && /^[a-zA-Z]{3}$/.test(d.currency) ? d.currency.toLowerCase() : null;
  if (!currency) throw new ListingError("The listing needs a three-letter currency.");

  const p = (d.payments ?? {}) as Partial<ShopListing["payments"]> & { protocols?: unknown };
  const x402 = p.x402 && typeof p.x402 === "object" && typeof p.x402.network === "string" && /^[a-z0-9-]+:[\w-]+$/.test(p.x402.network) ? { network: p.x402.network } : null;
  const protocols = Array.isArray(p.protocols) ? p.protocols.filter((x): x is string => typeof x === "string" && PROTOCOLS.has(x)) : [];
  const payments = { x402, card: p.card === true, test: p.test === true, ...(protocols.length ? { protocols } : {}) };
  if (!x402 && !payments.card && !payments.test && !protocols.length) throw new ListingError("The listing must say how agents pay: x402, card, ucp, acp or mpp.");

  if (d.items !== undefined && (!Array.isArray(d.items) || d.items.length > 200)) throw new ListingError("items is a list of up to 200 menu items.");
  const items = (d.items ?? []).map((i, n) => {
    const id = str(i?.id, 100);
    const itemName = str(i?.name, 120);
    if (!id || !itemName || !Number.isInteger(i.priceCents) || i.priceCents < 0 || i.priceCents > 10_000_000) {
      throw new ListingError(`items[${n}] needs an id, a name and a whole-number priceCents.`);
    }
    const description = str(i.description, 500);
    return { id, name: itemName, priceCents: i.priceCents, ...(description ? { description } : {}) };
  });

  const o = d.order as ShopListing["order"] | undefined;
  const order: NonNullable<ShopListing["order"]> =
    !o || o.via === "agentpickup"
      ? { via: "agentpickup" }
      : o.via === "ucp"
        ? { via: "ucp", profile: sameSite(o.profile, listingUrl.origin, "The UCP profile") }
        : o.via === "web"
          ? { via: "web", url: sameSite(o.url, listingUrl.origin, "The ordering page") }
          : (() => {
              throw new ListingError('order.via is "agentpickup", "ucp" or "web".');
            })();

  const logoUrl = typeof d.logoUrl === "string" ? sameSite(d.logoUrl, listingUrl.origin, "The logo") : undefined;
  const brandColor = typeof d.brandColor === "string" && /^#[0-9a-fA-F]{6}$/.test(d.brandColor) ? d.brandColor : undefined;
  const realMoney = payments.card || protocols.length > 0 || Boolean(x402 && !TESTNETS.has(x402.network));
  return {
    name,
    url,
    ...(logoUrl ? { logoUrl } : {}),
    ...(brandColor ? { brandColor } : {}),
    location: {
      name: locationName,
      ...(str(loc.address, 200) ? { address: str(loc.address, 200)! } : {}),
      ...(str(loc.hours, 200) ? { hours: str(loc.hours, 200)! } : {}),
      ...(openingHours ? { openingHours } : {}),
      ...(typeof lat === "number" && typeof lng === "number" ? { lat, lng } : {}),
    },
    ...(timeZone ? { timeZone } : {}),
    currency,
    payments,
    testOnly: !realMoney,
    items,
    order,
    source: { kind: "listed", domain: listingUrl.hostname, listingUrl: listingUrl.href, checkedAt: Date.now() },
  };
}

/** Fetch a listing with a short timeout, no redirects, and a size cap. */
export async function fetchListing(url: URL, doFetch: typeof fetch): Promise<ShopListing> {
  let res: Response;
  try {
    res = await doFetch(url.href, { redirect: "manual", signal: AbortSignal.timeout(8000), headers: { Accept: "application/json" } });
  } catch (err) {
    throw new ListingError(`Couldn't fetch the listing: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status >= 300 && res.status < 400) throw new ListingError("The listing URL redirects. Register the final URL.");
  if (!res.ok) throw new ListingError(`The listing URL answered ${res.status}.`);
  const text = await res.text();
  if (text.length > 256 * 1024) throw new ListingError("The listing is over 256 KB.");
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new ListingError("The listing isn't valid JSON.");
  }
  return parseListing(doc, url);
}
