// The 8am report: what happened yesterday (a Brisbane day) and over the last 7 days. Agents using the MCP server
// and the directory, orders at every shop, sellers signing up, the site, money, and anything that went wrong.
// Usage is counted here as it happens (site.db), because neither the host's request logs nor the MCP SDK keep it.
import type { DatabaseSync } from "node:sqlite";
import type { CollectEvent, Order } from "@agentpickup/core";
import type { Mailer } from "@agentpickup/server";

const ZONE = "Australia/Brisbane";
const DAY = 24 * 3600_000;

/** "2026-11-04" for a moment, in Brisbane. */
export const brisbaneDay = (ms = Date.now()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
const shiftDay = (day: string, by: number) => new Date(Date.parse(`${day}T12:00:00Z`) + by * DAY).toISOString().slice(0, 10);
const longDay = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString("en-AU", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" });

/** Who sent a request, in words: the app behind an MCP call, or a crawler. */
export function clientOf(ua: string | undefined): string {
  const u = (ua ?? "").toLowerCase();
  const known: [RegExp, string][] = [
    [/claude|anthropic/, "Claude"],
    [/openai|chatgpt/, "ChatGPT"],
    [/cursor/, "Cursor"],
    [/gemini|google/, "Google"],
    [/mcptry/, "mcptry.com (directory)"],
    [/glama/, "Glama (directory)"],
    [/smithery/, "Smithery (directory)"],
    [/pulsemcp/, "PulseMCP (directory)"],
    [/bot|crawl|spider|indexer|preview|monitor|uptime|headless|lighthouse/, "crawler"],
    [/^node|undici|axios/, "a Node app"],
    [/python|httpx|aiohttp/, "a Python app"],
    [/curl|wget|go-http|java|ruby/, "a script"],
  ];
  return known.find(([re]) => re.test(u))?.[1] ?? (u ? "a browser" : "unknown");
}
const isPerson = (ua: string | undefined) => clientOf(ua) === "a browser";

export function createUsage(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS usage_counts (
    day TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, kind, key)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS usage_events (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, day TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS report_sends (day TEXT PRIMARY KEY, at INTEGER NOT NULL, ok INTEGER NOT NULL, detail TEXT)`);
  const bump = db.prepare(
    "INSERT INTO usage_counts (day, kind, key, n) VALUES (?, ?, ?, ?) ON CONFLICT (day, kind, key) DO UPDATE SET n = n + excluded.n",
  );
  const add = db.prepare("INSERT INTO usage_events (at, day, kind, detail) VALUES (?, ?, ?, ?)");

  function count(kind: string, key: string, n = 1) {
    try {
      bump.run(brisbaneDay(), kind, key, n);
    } catch (err) {
      console.error("[usage] count failed:", err);
    }
  }
  function note(kind: string, detail: Record<string, unknown>) {
    try {
      add.run(Date.now(), brisbaneDay(), kind, JSON.stringify(detail));
    } catch (err) {
      console.error("[usage] note failed:", err);
    }
  }

  /** One request, after it was answered: pages, the directory, menus, sign-up steps, errors. */
  function request(method: string, path: string, status: number, ua: string | undefined, location: string | null) {
    const pages = ["/", "/connect", "/wallet", "/seller", "/support", "/privacy", "/terms"];
    if (method === "GET" && pages.includes(path) && status === 200) count(isPerson(ua) ? "page.person" : "page.bot", path);
    if (path === "/directory/v1/shops") count("directory", clientOf(ua));
    if (method === "GET" && /^(\/v\/[^/]+)?\/api\/catalog$/.test(path)) count("menu", `${path.replace(/\/api\/catalog$/, "") || "demo-cafe"}|${clientOf(ua)}`);
    if (path === "/connect/square/start") count("signup", "1 opened Sign in with Square");
    if (path === "/connect/square/callback" && status === 302 && location && !location.startsWith("/connect?")) count("signup", "2 signed in with Square");
    if (method === "POST" && path === "/connect/location" && status === 302 && location?.startsWith("/connect/payments")) count("signup", "3 connected a location");
    if (status >= 500) count("error", `${method} ${path.replace(/\/(ord|pi|wl)_[\w-]+/g, "/:id").replace(/^\/v\/[^/]+/, "/v/:venue")}`);
  }

  /** The JSON-RPC body of a hosted MCP request: which app started a session, which tools it called. */
  function mcp(body: unknown, ua: string | undefined) {
    const messages = Array.isArray(body) ? body : [body];
    for (const m of messages as { method?: string; params?: { name?: string; clientInfo?: { name?: string } } }[]) {
      if (m?.method === "initialize") count("mcp.session", m.params?.clientInfo?.name ? `${m.params.clientInfo.name} (${clientOf(ua)})` : clientOf(ua));
      if (m?.method === "tools/call" && m.params?.name) count("mcp.tool", m.params.name);
    }
  }

  /** An order event at a shop ("demo-cafe" or a venue's slug). */
  function order(shop: string, event: CollectEvent, o: Order) {
    const data = (event.data ?? {}) as Record<string, unknown>;
    if (event.type === "pass.emailed") return count(data.delivered ? "email.sent" : "email.failed", String(data.kind ?? "pass"));
    if (!["order.created", "order.paid", "order.ready", "order.collected", "order.expired", "order.refunded"].includes(event.type)) return;
    count(event.type, `${shop}|${o.rail}`);
    if (event.type !== "order.paid") return;
    // Real money: USDC settled on Base mainnet. Everything else here is a test payment or test USDC.
    const real = o.rail === "x402" && data.network === "eip155:8453";
    const usdCents = o.usdCents ?? (o.currency === "usd" ? o.totalCents : null);
    if (real && usdCents) count("money.real", shop, usdCents);
    note("paid", {
      shop,
      rail: o.rail,
      real,
      total: `${(o.totalCents / 100).toFixed(2)} ${o.currency.toUpperCase()}`,
      items: o.items.map((i) => `${i.qty}× ${i.name}`).join(", "),
      name: o.customerName ?? null,
      tx: real ? o.paymentRef : null,
    });
  }

  const countsFor = db.prepare("SELECT day, kind, key, n FROM usage_counts WHERE day BETWEEN ? AND ?");
  const eventsFor = db.prepare("SELECT at, day, kind, detail FROM usage_events WHERE day BETWEEN ? AND ? ORDER BY at");
  const firstDay = db.prepare("SELECT MIN(day) AS day FROM usage_counts");
  const sentFor = db.prepare("SELECT day, at, ok, detail FROM report_sends WHERE day = ?");
  const markSent = db.prepare(
    "INSERT INTO report_sends (day, at, ok, detail) VALUES (?, ?, ?, ?) ON CONFLICT (day) DO UPDATE SET at = excluded.at, ok = excluded.ok, detail = excluded.detail",
  );

  return {
    count,
    note,
    request,
    mcp,
    order,
    counts: (from: string, to: string) => countsFor.all(from, to) as { day: string; kind: string; key: string; n: number }[],
    events: (from: string, to: string) =>
      (eventsFor.all(from, to) as { at: number; day: string; kind: string; detail: string }[]).map((e) => ({ ...e, detail: JSON.parse(e.detail) })),
    countingSince: () => (firstDay.get() as { day: string | null }).day,
    sent: (day: string) => sentFor.get(day) as { ok: number; at: number } | undefined,
    markSent: (day: string, ok: boolean, detail: string) => markSent.run(day, Date.now(), ok ? 1 : 0, detail),
  };
}

export type Usage = ReturnType<typeof createUsage>;

// ---------- the report ----------

export interface ReportSources {
  usage: Usage;
  db: DatabaseSync;
  /** The venue host's admin API, if venues are on. */
  hostAdmin?: (path: string) => Promise<unknown>;
  /** The demo agent's wallet, for its balance. */
  demoWallet?: () => Promise<{ balance?: string | null; address?: string } | null>;
  fetch?: typeof fetch;
}

type Row = { day: string; kind: string; key: string; n: number };
const sum = (rows: Row[], kind: string, day?: string) => rows.filter((r) => r.kind === kind && (!day || r.day === day)).reduce((a, r) => a + r.n, 0);
const byKey = (rows: Row[], kind: string, day?: string) => {
  const m = new Map<string, number>();
  for (const r of rows) if (r.kind === kind && (!day || r.day === day)) m.set(r.key, (m.get(r.key) ?? 0) + r.n);
  return [...m].sort((a, b) => b[1] - a[1]);
};

export async function reportData(src: ReportSources, day: string) {
  const weekStart = shiftDay(day, -6);
  const rows = src.usage.counts(weekStart, day);
  const events = src.usage.events(day, day);
  const from = Date.parse(`${day}T00:00:00+10:00`);
  const to = from + DAY;

  const partners = (src.db.prepare("SELECT email, kind, note, created_at FROM waitlist WHERE created_at >= ? AND created_at < ? ORDER BY created_at").all(from, to) ??
    []) as { email: string; kind: string; note: string | null; created_at: number }[];
  let venues: { slug: string; name: string; createdAt: number; running: boolean; error?: string; test: boolean; viaSignup: boolean }[] = [];
  let requests: { system: string; email: string; at: number }[] = [];
  let listed: { name: string; url: string; domain: string; addedAt: number }[] = [];
  let listedTotal = 0;
  if (src.hostAdmin) {
    try {
      const v = (await src.hostAdmin("/host/v1/venues")) as {
        venues: { slug: string; createdAt: number; running: boolean; error?: string; settings: { merchant: { name: string }; payments?: { test?: boolean }; owner?: { squareMerchantId?: string } } }[];
      };
      venues = v.venues.map((x) => ({
        slug: x.slug,
        name: x.settings.merchant.name,
        createdAt: x.createdAt,
        running: x.running,
        error: x.error,
        test: Boolean(x.settings.payments?.test),
        viaSignup: Boolean(x.settings.owner?.squareMerchantId),
      }));
      requests = ((await src.hostAdmin("/host/v1/requests")) as { requests: { system: string; email: string; at: number }[] }).requests.filter((r) => r.at >= from && r.at < to);
      const all = ((await src.hostAdmin("/host/v1/listings")) as { listings: { addedAt: number; listing: { name: string; url: string; source?: { domain: string } } }[] }).listings;
      listedTotal = all.length;
      listed = all
        .filter((r) => r.addedAt >= from && r.addedAt < to)
        .map((r) => ({ name: r.listing.name, url: r.listing.url, domain: r.listing.source?.domain ?? "", addedAt: r.addedAt }));
    } catch (err) {
      console.error("[report] reading venues failed:", err);
    }
  }
  const wallet = await src.demoWallet?.().catch(() => null);
  const doFetch = src.fetch ?? fetch;
  const npm: { pkg: string; day: number | null; week: number | null }[] = [];
  for (const pkg of ["@agentpickup/mcp", "@agentpickup/server", "@agentpickup/core"]) {
    const read = async (span: string) => {
      try {
        const j = (await (await doFetch(`https://api.npmjs.org/downloads/point/${span}/${pkg}`)).json()) as { downloads?: number };
        return typeof j.downloads === "number" ? j.downloads : null;
      } catch {
        return null;
      }
    };
    npm.push({ pkg, day: await read("last-day"), week: await read("last-week") });
  }

  const week = Array.from({ length: 7 }, (_, i) => shiftDay(day, i - 6)).map((d) => ({
    day: d,
    sessions: sum(rows, "mcp.session", d),
    tools: sum(rows, "mcp.tool", d),
    directory: sum(rows, "directory", d),
    paid: sum(rows, "order.paid", d),
    people: sum(rows, "page.person", d),
    signups: byKey(rows, "signup", d).find(([k]) => k.startsWith("3"))?.[1] ?? 0,
  }));

  return {
    day,
    countingSince: src.usage.countingSince(),
    agents: {
      sessions: byKey(rows, "mcp.session", day),
      tools: byKey(rows, "mcp.tool", day),
      directory: byKey(rows, "directory", day),
      menus: byKey(rows, "menu", day),
    },
    orders: {
      created: byKey(rows, "order.created", day),
      paid: byKey(rows, "order.paid", day),
      ready: sum(rows, "order.ready", day),
      collected: sum(rows, "order.collected", day),
      expired: sum(rows, "order.expired", day),
      refunded: sum(rows, "order.refunded", day),
      paidList: events.filter((e) => e.kind === "paid").map((e) => e.detail as Record<string, unknown>),
      realUsdCents: sum(rows, "money.real", day),
    },
    sellers: {
      signup: byKey(rows, "signup", day).sort((a, b) => a[0].localeCompare(b[0])),
      newVenues: venues.filter((v) => v.createdAt >= from && v.createdAt < to),
      allVenues: venues,
      requests,
      partners,
      listed,
      listedTotal,
    },
    site: { people: byKey(rows, "page.person", day), bots: sum(rows, "page.bot", day) },
    problems: {
      emailsFailed: byKey(rows, "email.failed", day),
      emailsSent: sum(rows, "email.sent", day),
      errors: byKey(rows, "error", day),
      venuesDown: venues.filter((v) => !v.running),
    },
    wallet,
    npm,
    week,
  };
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export function renderReport(r: Awaited<ReturnType<typeof reportData>>) {
  const totalSessions = r.agents.sessions.reduce((a, [, n]) => a + n, 0);
  const totalTools = r.agents.tools.reduce((a, [, n]) => a + n, 0);
  const totalDirectory = r.agents.directory.reduce((a, [, n]) => a + n, 0);
  const totalPaid = r.orders.paid.reduce((a, [, n]) => a + n, 0);
  const people = r.site.people.reduce((a, [, n]) => a + n, 0);
  const problems = r.problems.emailsFailed.length + r.problems.errors.length + r.problems.venuesDown.length;
  const headline = [
    `${totalSessions} agent session${totalSessions === 1 ? "" : "s"} on the MCP server`,
    `${totalPaid} order${totalPaid === 1 ? "" : "s"} paid${r.orders.realUsdCents ? ` (${usd(r.orders.realUsdCents)} real USDC)` : ""}`,
    `${r.sellers.newVenues.length} new venue${r.sellers.newVenues.length === 1 ? "" : "s"}`,
    `${r.sellers.partners.length + r.sellers.requests.length} inquir${r.sellers.partners.length + r.sellers.requests.length === 1 ? "y" : "ies"}`,
    problems ? `${problems} problem${problems === 1 ? "" : "s"}` : "no problems",
  ].join(" · ");

  const list = (pairs: (string | number)[][], empty: string) =>
    pairs.length ? `<ul style="margin:6px 0 0;padding-left:18px">${pairs.map(([k, n]) => `<li>${esc(k)}: <b>${n}</b></li>`).join("")}</ul>` : `<p style="margin:6px 0 0;color:#6a6a6a">${esc(empty)}</p>`;
  const section = (title: string, body: string) =>
    `<tr><td style="padding:18px 24px 0"><div style="font-size:16px;font-weight:700;color:#17191c">${esc(title)}</div>${body}</td></tr>`;
  const shopName = (key: string) => key.replace(/\|.*$/, "");
  const railWords: Record<string, string> = { test: "test payment", x402: "USDC", card: "card", mpp: "agent card", ucp: "agent checkout", acp: "agent checkout" };
  const rail = (key: string) => railWords[key.split("|")[1] ?? ""] ?? key.split("|")[1] ?? "";
  const paidHow = (p: Record<string, unknown>) => (p.rail === "x402" ? (p.real ? "real USDC" : "test USDC") : (railWords[String(p.rail)] ?? String(p.rail)));

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#f3f4f2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#17191c;font-size:14.5px;line-height:1.55">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:20px 10px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border-radius:12px">
<tr><td style="padding:22px 24px 0"><div style="font-size:12px;color:#6a6a6a;letter-spacing:.06em;text-transform:uppercase">agentPickup · daily report</div>
<div style="font-size:21px;font-weight:700;margin-top:4px">${esc(longDay(r.day))}</div>
<div style="margin-top:8px;color:#3d4248">${esc(headline)}</div></td></tr>
${section(
  "Agents",
  `<p style="margin:6px 0 0">MCP sessions by app:</p>${list(r.agents.sessions, "No agent connected to the hosted MCP server.")}
   <p style="margin:10px 0 0">Tools called (${totalTools}):</p>${list(r.agents.tools, "None.")}
   <p style="margin:10px 0 0">Directory searches (${totalDirectory}):</p>${list(r.agents.directory, "None.")}
   <p style="margin:10px 0 0">Menus read through the API:</p>${list(r.agents.menus.map(([k, n]) => [k.replace("|", " by "), n]), "None.")}`,
)}
${section(
  "Orders",
  `${list(
    r.orders.created.map(([k, n]) => [`${shopName(k)}: created (${rail(k)})`, n]).concat(r.orders.paid.map(([k, n]) => [`${shopName(k)}: paid (${rail(k)})`, n])),
    "No orders.",
  )}
   ${r.orders.ready || r.orders.collected || r.orders.expired ? `<p style="margin:8px 0 0">Ready ${r.orders.ready} · collected ${r.orders.collected} · expired ${r.orders.expired}${r.orders.refunded ? ` · refunded ${r.orders.refunded}` : ""}</p>` : ""}
   ${
     r.orders.paidList.length
       ? `<ul style="margin:8px 0 0;padding-left:18px">${r.orders.paidList
           .map((p) => `<li>${esc(p.shop)}: ${esc(p.items)}, ${esc(p.total)}, ${esc(paidHow(p))}${p.name ? `, for ${esc(p.name)}` : ""}${p.tx ? ` · <a href="https://basescan.org/tx/${esc(p.tx)}">transaction</a>` : ""}</li>`)
           .join("")}</ul>`
       : ""
   }`,
)}
${section(
  "Sellers",
  `<p style="margin:6px 0 0">Sign-up steps:</p>${list(r.sellers.signup.map(([k, n]) => [k.slice(2), n]), "Nobody started signing up.")}
   ${r.sellers.newVenues.length ? `<p style="margin:10px 0 0">New venues:</p><ul style="margin:6px 0 0;padding-left:18px">${r.sellers.newVenues.map((v) => `<li>${esc(v.name)} (/v/${esc(v.slug)})${v.test ? ", test mode" : ""}</li>`).join("")}</ul>` : ""}
   ${r.sellers.requests.length ? `<p style="margin:10px 0 0">Asked for another system:</p><ul style="margin:6px 0 0;padding-left:18px">${r.sellers.requests.map((q) => `<li>${esc(q.system)}: ${esc(q.email)}</li>`).join("")}</ul>` : ""}
   ${r.sellers.partners.length ? `<p style="margin:10px 0 0">Partner form:</p><ul style="margin:6px 0 0;padding-left:18px">${r.sellers.partners.map((p) => `<li>${esc(p.kind)}: ${esc(p.email)}${p.note ? `, "${esc(p.note)}"` : ""}</li>`).join("")}</ul>` : `<p style="margin:10px 0 0;color:#6a6a6a">No partner form entries.</p>`}
   ${r.sellers.listed.length ? `<p style="margin:10px 0 0">Shops that listed themselves:</p><ul style="margin:6px 0 0;padding-left:18px">${r.sellers.listed.map((l) => `<li>${esc(l.name)} (${esc(l.domain)})</li>`).join("")}</ul>` : ""}
   <p style="margin:10px 0 0;color:#6a6a6a">${r.sellers.allVenues.length} venue${r.sellers.allVenues.length === 1 ? "" : "s"} here and ${r.sellers.listedTotal} listed from other sites.</p>`,
)}
${section("Site", `<p style="margin:6px 0 0">Pages viewed by people (${people}); ${r.site.bots} by bots and crawlers:</p>${list(r.site.people, "No visits from people.")}`)}
${section(
  "Money",
  `<p style="margin:6px 0 0">Real USDC received: <b>${usd(r.orders.realUsdCents)}</b>.${r.wallet?.balance ? ` The demo agent's wallet holds ${esc(r.wallet.balance)} USDC.` : ""}</p>`,
)}
${section(
  "Problems",
  problems
    ? `${r.problems.emailsFailed.length ? `<p style="margin:6px 0 0;color:#b42318">Emails that didn't send:</p>${list(r.problems.emailsFailed, "")}` : ""}
       ${r.problems.errors.length ? `<p style="margin:6px 0 0;color:#b42318">Server errors:</p>${list(r.problems.errors, "")}` : ""}
       ${r.problems.venuesDown.length ? `<p style="margin:6px 0 0;color:#b42318">Venues not running:</p><ul style="margin:6px 0 0;padding-left:18px">${r.problems.venuesDown.map((v) => `<li>${esc(v.name)}: ${esc(v.error ?? "stopped")}</li>`).join("")}</ul>` : ""}`
    : `<p style="margin:6px 0 0;color:#1f6b45">Nothing went wrong. ${r.problems.emailsSent} email${r.problems.emailsSent === 1 ? "" : "s"} sent.</p>`,
)}
${section(
  "Last 7 days",
  `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin-top:8px;border-collapse:collapse;font-size:13px">
   <tr style="color:#6a6a6a"><td style="padding:4px 6px 4px 0">Day</td><td>Agents</td><td>Tools</td><td>Directory</td><td>Paid</td><td>People</td><td>Sign-ups</td></tr>
   ${r.week
     .map(
       (w) =>
         `<tr style="border-top:1px solid #ebebeb"><td style="padding:4px 6px 4px 0">${esc(new Date(`${w.day}T12:00:00Z`).toLocaleDateString("en-AU", { timeZone: "UTC", weekday: "short", day: "numeric" }))}</td><td>${w.sessions}</td><td>${w.tools}</td><td>${w.directory}</td><td>${w.paid}</td><td>${w.people}</td><td>${w.signups}</td></tr>`,
     )
     .join("")}</table>
   <p style="margin:10px 0 0;color:#6a6a6a;font-size:13px">npm downloads (day / week): ${r.npm.map((p) => `${esc(p.pkg.replace("@agentpickup/", ""))} ${p.day ?? "–"} / ${p.week ?? "–"}`).join(" · ")}</p>`,
)}
<tr><td style="padding:20px 24px 22px;color:#9aa0a6;font-size:12px">Counted by agentpickup.app since ${esc(r.countingSince ? longDay(r.countingSince) : "today")}. Days run midnight to midnight, Brisbane time.</td></tr>
</table></td></tr></table></body></html>`;

  const lines = (pairs: (string | number)[][]) => (pairs.length ? pairs.map(([k, n]) => `  ${k}: ${n}`).join("\n") : "  none");
  const text = [
    `agentPickup daily report: ${longDay(r.day)}`,
    headline,
    "",
    "Agents (MCP sessions by app)",
    lines(r.agents.sessions),
    `Tools called: ${totalTools}`,
    lines(r.agents.tools),
    `Directory searches: ${totalDirectory}`,
    "",
    "Orders",
    lines(r.orders.created.map(([k, n]) => [`${shopName(k)} created (${rail(k)})`, n]).concat(r.orders.paid.map(([k, n]) => [`${shopName(k)} paid (${rail(k)})`, n]))),
    ...r.orders.paidList.map((p) => `  ${p.shop}: ${p.items}, ${p.total}, ${paidHow(p)}`),
    "",
    "Sellers",
    lines(r.sellers.signup.map(([k, n]) => [k.slice(2), n])),
    ...r.sellers.newVenues.map((v) => `  new venue: ${v.name} (/v/${v.slug})`),
    ...r.sellers.requests.map((q) => `  asked for ${q.system}: ${q.email}`),
    ...r.sellers.partners.map((p) => `  partner form (${p.kind}): ${p.email}${p.note ? `, "${p.note}"` : ""}`),
    ...r.sellers.listed.map((l) => `  listed itself: ${l.name} (${l.domain})`),
    "",
    `Site: ${people} page views by people, ${r.site.bots} by bots`,
    `Money: ${usd(r.orders.realUsdCents)} real USDC received${r.wallet?.balance ? `; demo wallet holds ${r.wallet.balance} USDC` : ""}`,
    `Problems: ${problems ? "" : "none"}`,
    ...r.problems.emailsFailed.map(([k, n]) => `  email not sent (${k}): ${n}`),
    ...r.problems.errors.map(([k, n]) => `  server error ${k}: ${n}`),
    ...r.problems.venuesDown.map((v) => `  venue down: ${v.name}: ${v.error ?? "stopped"}`),
  ].join("\n");
  return { subject: `agentPickup, ${longDay(r.day)}: ${headline}`, html, text };
}

/** Send yesterday's report once it's 8am in Brisbane, once per day; retried on the next check if it fails. */
export function startReportJob(opts: { sources: ReportSources; mailer: Mailer | null; to: string | undefined; from: string }) {
  async function sendFor(day: string, to: string) {
    if (!opts.mailer) throw new Error("No mailer delivers here.");
    const report = renderReport(await reportData(opts.sources, day));
    const { id } = await opts.mailer.send({ from: opts.from, to, replyTo: "hello@agentpickup.app", ...report });
    return { subject: report.subject, id };
  }
  async function tick() {
    if (!opts.to || !opts.mailer) return;
    const now = Date.now();
    const hour = Number(new Intl.DateTimeFormat("en-AU", { timeZone: ZONE, hour: "numeric", hourCycle: "h23" }).format(now));
    if (hour < 8) return;
    const day = shiftDay(brisbaneDay(now), -1);
    if (opts.sources.usage.sent(day)?.ok) return;
    // Nothing was counted that day: the first report is for the first full day of counting.
    const since = opts.sources.usage.countingSince();
    if (!since || since > day) return;
    try {
      const sent = await sendFor(day, opts.to);
      opts.sources.usage.markSent(day, true, sent.id);
      console.log(`[report] sent the report for ${day}`);
    } catch (err) {
      opts.sources.usage.markSent(day, false, String(err));
      console.error(`[report] sending the report for ${day} failed:`, err);
    }
  }
  const timer = setInterval(() => void tick(), 5 * 60_000);
  timer.unref();
  void tick();
  return { sendFor, yesterday: () => shiftDay(brisbaneDay(), -1), stop: () => clearInterval(timer) };
}
