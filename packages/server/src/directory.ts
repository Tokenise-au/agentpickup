// The agent directory: every shop on an install as one searchable list, so an agent can find pickup
// shops near someone that sell what they want, then order through the shop's own API or the MCP server.
import type { CatalogItem, MerchantProfile, OpeningPeriod, PickupLocation } from "./config.js";

/** A shop as the directory shows it. */
export interface ShopListing {
  name: string;
  /** The shop's base URL: its menu is at <url>/api/catalog and the MCP server takes it as shop_url. */
  url: string;
  logoUrl?: string;
  brandColor?: string;
  location: PickupLocation;
  timeZone?: string;
  currency: string;
  /** `protocols`: agent checkouts a listed shop takes besides these ("ucp", "acp", "mpp"). */
  payments: { x402: { network: string } | null; card: boolean; test: boolean; protocols?: string[] };
  /** No real money changes hands here: test payments, or USDC on a testnet. */
  testOnly: boolean;
  items: { id: string; name: string; priceCents: number; description?: string }[];
  /**
   * How an agent orders: through agentPickup's API at `url` (and the MCP server's tools), through the shop's UCP
   * checkout, or on its own site.
   */
  order?: { via: "agentpickup" } | { via: "ucp"; profile: string } | { via: "web"; url: string };
  /** Where the entry came from: a shop on this install, or a listing another site registered with the directory. */
  source?: { kind: "here" | "listed"; domain: string; listingUrl?: string; checkedAt?: number };
}

const TESTNETS = new Set(["eip155:84532"]);

export function listingOf(shop: {
  url: string;
  merchant: MerchantProfile;
  currency: string;
  timeZone?: string;
  items: CatalogItem[];
  payments: ShopListing["payments"];
}): ShopListing {
  const { merchant, payments } = shop;
  const realMoney = payments.card || Boolean(payments.x402 && !TESTNETS.has(payments.x402.network));
  return {
    name: merchant.name,
    url: shop.url,
    ...(merchant.logoUrl ? { logoUrl: merchant.logoUrl } : {}),
    ...(merchant.brandColor ? { brandColor: merchant.brandColor } : {}),
    location: merchant.location,
    ...(shop.timeZone ? { timeZone: shop.timeZone } : {}),
    currency: shop.currency,
    payments,
    testOnly: !realMoney,
    items: shop.items.map((i) => ({ id: i.id, name: i.name, priceCents: i.priceCents, ...(i.description ? { description: i.description } : {}) })),
  };
}

export interface DirectoryQuery {
  /** What they want: matched against shop names and menu items ("flat white", "croissant"). */
  q?: string;
  /** A suburb, street or city, matched against shop addresses. */
  place?: string;
  /** Where they are. With these, results are the shops within radiusKm, nearest first. */
  lat?: number;
  lng?: number;
  /** Default 10. */
  radiusKm?: number;
  /** Leave out shops known to be closed now. Shops without hours stay in. */
  openNow?: boolean;
  /** Default 10, at most 50. */
  limit?: number;
  now?: Date;
}

export interface DirectoryResult extends Omit<ShopListing, "items"> {
  distanceKm?: number;
  /** null when the shop hasn't given its hours. */
  openNow: boolean | null;
  /** Menu items matching q, or the first few when there's no q. */
  items: ShopListing["items"];
  itemCount: number;
}

// Words people (and agents) use for what a café menu spells out.
const ALSO: Record<string, string[]> = {
  coffee: ["coffee", "cafe", "latte", "flat white", "long black", "espresso", "cappuccino", "mocha", "macchiato", "americano", "piccolo", "cold brew"],
  cafe: ["cafe", "coffee"],
};

const plain = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

/** "croissants" finds "croissant". */
const stem = (word: string) => (word.length > 4 && word.endsWith("es") ? word.slice(0, -2) : word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word);

function matcher(q: string): (text: string) => boolean {
  const phrase = plain(q).trim();
  const words = phrase.split(/[^a-z0-9]+/).filter(Boolean).map(stem);
  const alternatives = ALSO[phrase] ?? ALSO[stem(phrase)] ?? null;
  return (text) => {
    const hay = plain(text);
    if (alternatives?.some((a) => hay.includes(a))) return true;
    return words.length > 0 && words.every((w) => hay.includes(w));
  };
}

export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/** Whether a shop is open at `now`, in its own time zone. null when it hasn't given its hours. */
export function isOpen(periods: OpeningPeriod[] | undefined, timeZone: string | undefined, now: Date): boolean | null {
  if (!periods?.length) return null;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  const time = `${get("hour")}:${get("minute")}`;
  return periods.some((p) => {
    if (p.close > p.open) return p.day === day && time >= p.open && time < p.close;
    // Past midnight: open from `open` on its day until `close` the next morning.
    return (p.day === day && time >= p.open) || ((p.day + 1) % 7 === day && time < p.close);
  });
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function clock(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const hour = h % 12 || 12;
  return `${hour}${m ? `:${String(m).padStart(2, "0")}` : ""}${h < 12 ? "am" : "pm"}`;
}

/** Opening hours as people read them: "Mon-Fri 7am-3pm, Sat 8am-1pm". */
export function formatHours(periods: OpeningPeriod[]): string {
  const byDay = new Map<number, string>();
  for (const day of [1, 2, 3, 4, 5, 6, 0]) {
    const ranges = periods
      .filter((p) => p.day === day)
      .sort((a, b) => a.open.localeCompare(b.open))
      .map((p) => `${clock(p.open)}-${clock(p.close)}`);
    if (ranges.length) byDay.set(day, ranges.join(" & "));
  }
  const order = [1, 2, 3, 4, 5, 6, 0];
  const groups: { from: number; to: number; hours: string }[] = [];
  for (const [i, day] of order.entries()) {
    const hours = byDay.get(day);
    if (!hours) continue;
    const last = groups.at(-1);
    if (last && last.hours === hours && order[i - 1] === last.to) last.to = day;
    else groups.push({ from: day, to: day, hours });
  }
  return groups
    .map((g) => `${DAY_NAMES[g.from]}${g.to !== g.from ? `-${DAY_NAMES[g.to]}` : ""} ${g.hours}`)
    .join(", ");
}

export function searchDirectory(listings: ShopListing[], query: DirectoryQuery): DirectoryResult[] {
  const now = query.now ?? new Date();
  const wants = query.q?.trim() ? matcher(query.q) : null;
  const inPlace = query.place?.trim() ? matcher(query.place) : null;
  const here = typeof query.lat === "number" && typeof query.lng === "number" ? { lat: query.lat, lng: query.lng } : null;
  const radius = query.radiusKm ?? 10;
  const limit = Math.min(Math.max(1, query.limit ?? 10), 50);

  const results: (DirectoryResult & { score: number })[] = [];
  for (const shop of listings) {
    const loc = shop.location;
    if (inPlace && !inPlace([shop.name, loc.name, loc.address ?? ""].join(" "))) continue;
    let distance: number | undefined;
    if (here) {
      if (typeof loc.lat !== "number" || typeof loc.lng !== "number") continue;
      distance = distanceKm(here, { lat: loc.lat, lng: loc.lng });
      if (distance > radius) continue;
    }
    const openNow = isOpen(loc.openingHours, shop.timeZone, now);
    if (query.openNow && openNow === false) continue;
    const matching = wants ? shop.items.filter((i) => wants(`${i.name} ${i.description ?? ""}`)) : shop.items;
    const nameMatches = wants ? wants(shop.name) : true;
    if (wants && !matching.length && !nameMatches) continue;
    const { items, ...rest } = shop;
    results.push({
      ...rest,
      ...(distance !== undefined ? { distanceKm: Math.round(distance * 10) / 10 } : {}),
      openNow,
      items: (matching.length ? matching : items).slice(0, 8),
      itemCount: items.length,
      score: matching.length,
    });
  }
  results.sort((a, b) =>
    a.distanceKm !== undefined && b.distanceKm !== undefined
      ? a.distanceKm - b.distanceKm
      : b.score - a.score || a.name.localeCompare(b.name),
  );
  return results.slice(0, limit).map(({ score: _score, ...r }) => r);
}
