// The agentPickup MCP server: lets any MCP client (Claude, ChatGPT, Cursor, an agent framework) find pickup
// shops near someone, see what they sell, order, pay over x402, and hand its user the QR to collect with.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { errorOf, usd, type Fetch, type Payer } from "./wallet.js";

export const VERSION = "0.3.0";

export interface PickupMcpOptions {
  /** The agentPickup shop this server orders from. */
  shopUrl: string;
  /**
   * Let tool calls name any agentPickup shop. Leave off for hosted servers, so callers can't point it anywhere:
   * they can still name shops on the same host (venues at /v/<slug>), as find_shops returns them.
   */
  allowOtherShops?: boolean;
  /** An agentPickup directory (<host>/directory/v1/shops). Adds find_shops: shops near someone that sell what they want. */
  directoryUrl?: string;
  /**
   * Shops on other hosts a hosted server may still order from, such as agentPickup shops its directory has checked.
   * Called with the shop's base URL.
   */
  trustedShop?: (shopBase: string) => boolean | Promise<boolean>;
  /** How requests reach the shop. Defaults to global fetch; a shop hosting its own server passes its app's fetch. */
  fetch?: Fetch;
  /** The wallet that pays. Without one, pay_order returns the price and pay link for another x402 client. */
  payer?: Payer;
}

type DirectoryShop = {
  name: string;
  url: string;
  location: { name: string; address?: string; hours?: string };
  currency: string;
  payments: { x402: { network: string } | null; card: boolean; test: boolean };
  testOnly: boolean;
  distanceKm?: number;
  openNow: boolean | null;
  items: { id: string; name: string; priceCents: number }[];
  itemCount: number;
  order?: { via: "agentpickup" } | { via: "ucp"; profile: string } | { via: "web"; url: string };
  source?: { kind: "here" | "listed"; domain: string };
};

type Order = {
  id: string;
  status: string;
  items: { id: string; name: string; qty: number; priceCents: number }[];
  totalCents: number;
  currency: string;
  collectBy: number | null;
};

class ToolError extends Error {}

const INSTRUCTIONS = `agentPickup lets you buy things online for the user to collect in person.
0. find_shops (when available): shops near the user that sell what they want. Pass a shop's shop_url to the other tools.
1. get_shop: see what the shop sells, its pickup location and how it takes payment.
2. create_pickup_order: needs the user's email, where the shop sends the pickup QR.
3. pay_order: pays from the configured wallet in USDC over x402. Confirm the items and total with the user first.
4. Give the user the pass link and pickup code. They show the QR at the counter to collect.
get_pickup_pass fetches the pass again later; order_status says whether it's ready or collected.
Group orders (a coffee run): start_group_order gives a code to share; each person's agent calls join_group_order and
pays its own share with pay_order; at closing time the shop gets one combined order and the organiser gets its QR.
group_order_status shows who's in; close_group_order closes it early.`;

const money = (cents: number, currency: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);

const reply = (summary: string, data: unknown) => ({
  content: [{ type: "text" as const, text: `${summary}\n\n${JSON.stringify(data, null, 2)}` }],
});

const failure = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });

/** A shop's base URL: shops can live under a path (https://host/v/cafe). A pasted API or pass link works too. */
const shopBase = (url: URL) => {
  const path = url.pathname.replace(/\/+$/, "");
  return url.origin + (path.match(/^(.*)\/(?:api|p|c)\/.+$/)?.[1] ?? path.replace(/\/staff$/, ""));
};

export function createPickupMcpServer(opts: PickupMcpOptions): McpServer {
  const homeUrl = new URL(opts.shopUrl);
  const home = shopBase(homeUrl);
  const doFetch: Fetch = opts.fetch ?? ((req) => fetch(req));

  async function shopFor(shopUrl?: string): Promise<string> {
    if (!shopUrl) return home;
    let url: URL;
    try {
      url = new URL(shopUrl);
    } catch {
      throw new ToolError(`"${shopUrl}" isn't a URL.`);
    }
    // Shops on this server's own host: the home shop and its venues.
    if (url.origin === homeUrl.origin) return shopBase(url);
    if (opts.allowOtherShops || opts.trustedShop) {
      if (url.protocol !== "https:" && url.hostname !== "localhost") throw new ToolError("Shops must be served over https.");
      if (opts.allowOtherShops || (await opts.trustedShop!(shopBase(url)))) return shopBase(url);
      throw new ToolError(`This server orders from shops on ${homeUrl.origin} and agentPickup shops its directory lists.`);
    }
    throw new ToolError(`This server orders from shops on ${homeUrl.origin} only.`);
  }

  async function call(shop: string, path: string, init?: RequestInit) {
    const res = await doFetch(new Request(`${shop}${path}`, init));
    if (!res.ok) throw new ToolError(await errorOf(res, `The shop answered ${res.status}.`));
    return res.json() as Promise<Record<string, unknown>>;
  }

  // Tool errors go back to the model as text it can act on, not as protocol errors.
  const guarded =
    <A>(fn: (args: A) => Promise<ReturnType<typeof reply>>) =>
    async (args: A) => {
      try {
        return await fn(args);
      } catch (err) {
        if (err instanceof ToolError) return failure(err.message);
        return failure(`Couldn't reach the shop: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

  const shopArg: Record<string, z.ZodType> =
    opts.allowOtherShops || opts.directoryUrl
      ? { shop_url: z.string().optional().describe(`An agentPickup shop's URL, as find_shops returns it. Defaults to ${home}.`) }
      : {};

  const server = new McpServer({ name: "agentpickup", title: "agentPickup", version: VERSION }, { instructions: INSTRUCTIONS });

  if (opts.directoryUrl) {
    const directoryUrl = opts.directoryUrl;
    server.registerTool(
      "find_shops",
      {
        title: "Find pickup shops",
        description:
          "Find agentPickup shops to order from: near a point (lat/lng), in a suburb or city (place), or selling something (query). " +
          "Returns each shop's shop_url, pickup address, hours, whether it's open now, distance, and matching menu items.",
        inputSchema: {
          query: z.string().max(100).optional().describe('What the user wants, e.g. "flat white" or "croissant". Leave out to list everything.'),
          place: z.string().max(100).optional().describe('A suburb, street or city to match against shop addresses, e.g. "Surry Hills".'),
          lat: z.number().min(-90).max(90).optional().describe("Where the user is: latitude. Send with lng."),
          lng: z.number().min(-180).max(180).optional().describe("Where the user is: longitude. Send with lat."),
          radius_km: z.number().positive().max(100).optional().describe("With lat/lng: how far to look. Default 10."),
          open_now: z.boolean().optional().describe("Only shops open now (shops without listed hours stay in)."),
          limit: z.number().int().min(1).max(50).optional(),
        },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      guarded(
        async (args: { query?: string; place?: string; lat?: number; lng?: number; radius_km?: number; open_now?: boolean; limit?: number }) => {
          if ((args.lat === undefined) !== (args.lng === undefined)) throw new ToolError("Send lat and lng together.");
          const url = new URL(directoryUrl);
          const params: Record<string, unknown> = { q: args.query, place: args.place, lat: args.lat, lng: args.lng, radius_km: args.radius_km, limit: args.limit };
          for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
          if (args.open_now) url.searchParams.set("open_now", "true");
          const res = await doFetch(new Request(url));
          if (!res.ok) throw new ToolError(await errorOf(res, `The directory answered ${res.status}.`));
          const { shops } = (await res.json()) as { shops: DirectoryShop[] };
          if (!shops.length) return reply("No agentPickup shops match. Try a wider radius, another place, or no query.", { shops: [] });
          const lines = shops.map((s) => {
            const facts = [
              s.distanceKm !== undefined ? `${s.distanceKm} km` : null,
              s.openNow === true ? "open now" : s.openNow === false ? "closed now" : null,
              s.testOnly ? "test shop, no real money" : null,
              s.source?.kind === "listed" ? `listed by ${s.source.domain}` : null,
              s.order?.via === "ucp" ? "orders through its UCP checkout" : s.order?.via === "web" ? "orders on its own website" : null,
            ].filter(Boolean);
            const items = s.items.slice(0, 3).map((i) => `${i.name} ${money(i.priceCents, s.currency)}`).join(", ");
            return `- ${s.name}${facts.length ? ` (${facts.join(", ")})` : ""}${s.location.address ? `, ${s.location.address}` : ""}${items ? `: ${items}` : ""}`;
          });
          return reply(`${shops.length} shop${shops.length === 1 ? "" : "s"}:\n${lines.join("\n")}\nPass a shop's shop_url to get_shop or create_pickup_order.`, {
            shops: shops.map((s) => ({
              shop_url: s.url,
              name: s.name,
              location: { name: s.location.name, address: s.location.address, hours: s.location.hours },
              distanceKm: s.distanceKm,
              openNow: s.openNow,
              testOnly: s.testOnly,
              payments: { x402: s.payments.x402?.network ?? null, test: s.payments.test },
              listedBy: s.source?.kind === "listed" ? s.source.domain : null,
              // agentpickup: use get_shop and create_pickup_order. ucp or web: order there instead.
              orderVia: s.order?.via ?? "agentpickup",
              ...(s.order?.via === "ucp" ? { ucpProfile: s.order.profile } : s.order?.via === "web" ? { orderUrl: s.order.url } : {}),
              items: s.items.map((i) => ({ id: i.id, name: i.name, price: money(i.priceCents, s.currency) })),
              moreItems: Math.max(0, s.itemCount - s.items.length),
            })),
          });
        },
      ),
    );
  }

  server.registerTool(
    "get_shop",
    {
      title: "See what a shop sells",
      description: "What the shop sells (item ids and prices), where to collect, and which payments it takes.",
      inputSchema: { ...shopArg },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(async (args: { shop_url?: string }) => {
      const shop = await shopFor(args.shop_url);
      const data = await call(shop, "/api/catalog");
      const merchant = data.merchant as { name: string; location?: { name?: string; address?: string; hours?: string } };
      const currency = String(data.currency ?? "usd");
      const items = (data.items as { id: string; name: string; priceCents: number; description?: string }[]).map((i) => ({
        id: i.id,
        name: i.name,
        price: money(i.priceCents, currency),
        description: i.description,
      }));
      const payments = data.payments as { x402?: { network: string } | null; test?: boolean; card?: boolean; square?: { live: boolean } | null };
      const cards = Boolean(payments.square || payments.card);
      const ways = [
        ...(payments.x402 ? [`USDC over x402 on ${payments.x402.network}, paid by the agent`] : []),
        ...(cards ? ["cards, paid by the user on a checkout link"] : []),
        ...(payments.test ? ["test payments, with no money moving"] : []),
      ];
      return reply(
        `${merchant.name}${merchant.location?.name ? `, collect at ${merchant.location.name}` : ""}. ` +
          (!ways.length
            ? "Doesn't take agent payments."
            : ways.length === 1 && payments.test
              ? "A test shop: orders are marked paid without money moving."
              : `Takes ${ways.join("; ")}.`),
        { shop, merchant: merchant.name, location: merchant.location, currency, items, x402: payments.x402 ?? null, cards, test: Boolean(payments.test) },
      );
    }),
  );

  server.registerTool(
    "create_pickup_order",
    {
      title: "Order for pickup",
      description:
        "Create an order to collect in person. Returns the order id and total; pay it with pay_order. " +
        "The shop emails the pickup QR to `email` once it's paid. Where the shop takes cards, `payment: \"card\"` " +
        "returns a checkout link for the user to pay on instead.",
      inputSchema: {
        items: z
          .array(z.object({ id: z.string().describe("Item id from get_shop"), qty: z.number().int().min(1).max(20) }))
          .min(1),
        email: z.string().email().describe("The user's email. The pickup QR goes here."),
        name: z.string().max(100).optional().describe("Name for the order, shown to staff"),
        payment: z
          .enum(["agent", "card"])
          .optional()
          .describe("Who pays: agent (USDC over x402, or a test payment at a test shop) or card (the user pays on a checkout link). Default: agent where the shop takes it, else card."),
        ...shopArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guarded(async (args: { items: { id: string; qty: number }[]; email: string; name?: string; payment?: "agent" | "card"; shop_url?: string }) => {
      const shop = await shopFor(args.shop_url);
      // The agent pays over x402 where the shop takes it, a test shop marks the order paid straight away, and a
      // shop that takes cards gives the user a checkout link.
      const { payments } = (await call(shop, "/api/catalog")) as { payments: { x402?: unknown; test?: boolean; card?: boolean; square?: unknown } };
      const agentRail = payments.x402 ? "x402" : payments.test ? "test" : null;
      const cardRail = payments.square ? "square" : payments.card ? "card" : null;
      const rail = args.payment === "card" ? cardRail : args.payment === "agent" ? agentRail : (agentRail ?? cardRail);
      if (!rail) throw new ToolError(args.payment === "card" ? "This shop doesn't take cards." : "This shop doesn't take agent payments.");
      const data = await call(shop, "/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: args.items, email: args.email, name: args.name, rail }),
      });
      const order = data.order as Order;
      const next = data.next as { url?: string; passUrl?: string };
      if (rail === "test") {
        return reply(
          `Test order ${order.id}: ${order.items.map((i) => `${i.qty}× ${i.name}`).join(", ")}, ${money(order.totalCents, order.currency)}, ` +
            `marked paid with no money moving. The shop emails ${args.email} the receipt and pickup QR; the pass is at ${next.passUrl}.`,
          { shop, orderId: order.id, status: order.status, test: true, total: money(order.totalCents, order.currency), items: order.items, passUrl: next.passUrl },
        );
      }
      if (rail === "square" || rail === "card") {
        return reply(
          `Order ${order.id}: ${order.items.map((i) => `${i.qty}× ${i.name}`).join(", ")}, ${money(order.totalCents, order.currency)}. ` +
            `Give the user this link to pay by card: ${next.url}. Once they've paid, the shop emails ${args.email} the receipt and pickup QR.`,
          { shop, orderId: order.id, total: money(order.totalCents, order.currency), items: order.items, payBy: "card", checkoutUrl: next.url, collectBy: order.collectBy },
        );
      }
      return reply(
        `Order ${order.id}: ${order.items.map((i) => `${i.qty}× ${i.name}`).join(", ")}, ${money(order.totalCents, order.currency)}. ` +
          `Confirm with the user, then call pay_order.`,
        { shop, orderId: order.id, total: money(order.totalCents, order.currency), items: order.items, payUrl: next.url, collectBy: order.collectBy },
      );
    }),
  );

  server.registerTool(
    "pay_order",
    {
      title: "Pay for an order",
      description: opts.payer
        ? `Pay an order in USDC over x402 from wallet ${opts.payer.address}. This spends money: confirm the items and total with the user first. Returns the pickup pass link.`
        : "No wallet is set up here, so this returns the price and pay link for another x402 client to pay.",
      inputSchema: { order_id: z.string(), ...shopArg },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    guarded(async (args: { order_id: string; shop_url?: string }) => {
      const shop = await shopFor(args.shop_url);
      const status = (await call(shop, `/api/orders/${encodeURIComponent(args.order_id)}`)) as { order: { rail: string; status: string }; checkoutUrl?: string };
      if (status.order.rail === "square" || status.order.rail === "card") {
        if (status.order.status !== "awaiting_payment") return reply(`Order ${args.order_id} is already paid (${status.order.status}).`, { orderId: args.order_id, status: status.order.status });
        return reply(
          status.checkoutUrl
            ? `This order is paid by card: give the user ${status.checkoutUrl} to pay on.`
            : "This order is paid by card, on the checkout link create_pickup_order returned.",
          { orderId: args.order_id, payBy: "card", checkoutUrl: status.checkoutUrl ?? null },
        );
      }
      const payUrl = `${shop}/api/orders/${encodeURIComponent(args.order_id)}/pay`;
      if (!opts.payer) {
        const res = await doFetch(new Request(payUrl, { method: "POST" }));
        if (res.status !== 402) throw new ToolError(await errorOf(res, "This order isn't waiting for an x402 payment."));
        // x402 v2 carries the requirements in the PAYMENT-REQUIRED header; older servers put them in the body.
        const header = res.headers.get("PAYMENT-REQUIRED");
        const required = (header ? JSON.parse(Buffer.from(header, "base64").toString("utf8")) : await res.json()) as {
          accepts?: { amount: string; network: string; asset: string; payTo: string }[];
        };
        const accept = required.accepts?.[0];
        return reply(
          `Waiting for payment: ${usd(accept?.amount)} USDC on ${accept?.network}. No wallet is configured here; ` +
            `POST the pay link with any x402 client, or set AGENTPICKUP_WALLET_KEY.`,
          { orderId: args.order_id, payUrl, amount: usd(accept?.amount), network: accept?.network, asset: accept?.asset, payTo: accept?.payTo },
        );
      }
      const paid = await opts.payer.pay({ id: args.order_id, payUrl }, doFetch);
      if (!paid.ok) throw new ToolError(paid.error);
      return reply(
        `Paid ${paid.amount ?? ""} USDC. Pickup pass: ${paid.passUrl}` +
          (paid.emailedTo ? ` (also emailed to ${paid.emailedTo})` : "") +
          `. The user shows its QR at the counter.`,
        { orderId: args.order_id, ...paid, ok: undefined },
      );
    }),
  );

  server.registerTool(
    "order_status",
    {
      title: "Check an order",
      description: "Whether an order is waiting for payment, paid, ready to collect, collected or expired.",
      inputSchema: { order_id: z.string(), ...shopArg },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(async (args: { order_id: string; shop_url?: string }) => {
      const shop = await shopFor(args.shop_url);
      const { order } = (await call(shop, `/api/orders/${encodeURIComponent(args.order_id)}`)) as { order: Order };
      const words: Record<string, string> = {
        awaiting_payment: "is waiting for payment",
        paid: "is paid and being prepared",
        ready: "is ready to collect",
        collected: "has been collected",
        expired: "expired before anyone collected it",
        cancelled: "was cancelled",
      };
      return reply(`Order ${order.id} ${words[order.status] ?? `is ${order.status}`}.`, order);
    }),
  );

  server.registerTool(
    "get_pickup_pass",
    {
      title: "Get the pickup pass",
      description: "The pass link, pickup code and QR content for an order this wallet paid, by signing in with the wallet (Sign-In-With-X).",
      inputSchema: { order_id: z.string(), ...shopArg },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(async (args: { order_id: string; shop_url?: string }) => {
      if (!opts.payer) throw new ToolError("No wallet is set up here. The pass was emailed to the buyer when the order was paid.");
      const shop = await shopFor(args.shop_url);
      const res = await opts.payer.signIn(`${shop}/api/orders/${encodeURIComponent(args.order_id)}/pass`, doFetch);
      if (!res.ok) throw new ToolError(await errorOf(res, `The shop answered ${res.status}.`));
      const pass = (await res.json()) as { passUrl: string; pickupCode: string; qrContent: string };
      return reply(`Pickup pass: ${pass.passUrl}, pickup code ${pass.pickupCode}.`, pass);
    }),
  );

  // ---------- group orders ----------
  type GroupView = {
    code: string;
    title: string;
    status: string;
    organiser: string;
    closesAt: number;
    members: { name: string; items: string; totalCents: number; status: string }[];
    paidCents: number;
    currency: string;
    combined: { status: string; collectBy: number } | null;
  };
  const closesIn = (g: GroupView) => {
    const minutes = Math.max(0, Math.round((g.closesAt - Date.now()) / 60_000));
    return g.status === "open" ? `closes in ${minutes} min` : g.status === "sent" ? "closed and sent to the shop" : "cancelled";
  };
  const groupSummary = (g: GroupView) => {
    const paid = g.members.filter((m) => m.status !== "awaiting_payment" && m.status !== "cancelled");
    return `${g.title} (code ${g.code}), ${closesIn(g)}: ${paid.length} of ${g.members.length} paid, ${money(g.paidCents, g.currency)} so far.`;
  };

  server.registerTool(
    "start_group_order",
    {
      title: "Start a group order",
      description:
        "Start a group order (a coffee run) at a shop. Returns a code to share: each person's agent joins with it and pays for " +
        "their own items. When it closes, the shop gets one combined order and the organiser is emailed its pickup QR.",
      inputSchema: {
        organiser_name: z.string().min(1).max(60).describe("Who collects, shown to staff"),
        organiser_email: z.string().email().describe("Where the group's pickup QR goes"),
        title: z.string().max(60).optional().describe('e.g. "Friday coffee run"'),
        closes_in_minutes: z.number().int().min(5).max(240).optional().describe("Default 15"),
        ...shopArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guarded(async (args: { organiser_name: string; organiser_email: string; title?: string; closes_in_minutes?: number; shop_url?: string }) => {
      const shop = await shopFor(args.shop_url);
      const data = (await call(shop, "/api/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: args.organiser_name, email: args.organiser_email, title: args.title, closesInMinutes: args.closes_in_minutes }),
      })) as { group: GroupView; organiserKey: string };
      return reply(
        `Started ${data.group.title}: share code ${data.group.code}. Everyone's agent joins with join_group_order and the code; it ${closesIn(data.group)}. ` +
          `Keep organiser_key to close it early.`,
        { shop, code: data.group.code, closesAt: data.group.closesAt, organiser_key: data.organiserKey },
      );
    }),
  );

  server.registerTool(
    "join_group_order",
    {
      title: "Join a group order",
      description:
        "Add the user's items to a group order with its code. Returns the order id; pay it with pay_order before the group closes. " +
        "The organiser collects everything, so the user gets a receipt, not a QR.",
      inputSchema: {
        code: z.string().min(4).max(12).describe("The group's code"),
        items: z.array(z.object({ id: z.string().describe("Item id from get_shop"), qty: z.number().int().min(1).max(20) })).min(1),
        email: z.string().email().describe("The user's email, for their receipt"),
        name: z.string().min(1).max(60).describe("The user's name, shown to staff on their items"),
        ...shopArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guarded(async (args: { code: string; items: { id: string; qty: number }[]; email: string; name: string; shop_url?: string }) => {
      const shop = await shopFor(args.shop_url);
      const { payments } = (await call(shop, "/api/catalog")) as { payments: { x402?: unknown; test?: boolean } };
      const rail = payments.x402 ? "x402" : payments.test ? "test" : null;
      if (!rail) throw new ToolError("This shop doesn't take agent payments.");
      const data = (await call(shop, `/api/groups/${encodeURIComponent(args.code)}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: args.items, email: args.email, name: args.name, rail }),
      })) as { order: Order; group: GroupView; next: { type: string; url?: string } };
      const what = `${data.order.items.map((i) => `${i.qty}× ${i.name}`).join(", ")}, ${money(data.order.totalCents, data.order.currency)}`;
      return reply(
        rail === "test"
          ? `Added to ${data.group.title}: ${what}, paid with a test payment (no money moved). ${data.group.organiser} collects it.`
          : `Added to ${data.group.title}: ${what}. Confirm with the user, then pay it with pay_order (order ${data.order.id}) before the group closes.`,
        { shop, orderId: data.order.id, group: groupSummary(data.group), payUrl: data.next.url ?? null, test: rail === "test" },
      );
    }),
  );

  server.registerTool(
    "group_order_status",
    {
      title: "Check a group order",
      description: "Who's in a group order, what they ordered, who has paid, and whether it has closed and been collected.",
      inputSchema: { code: z.string().min(4).max(12), ...shopArg },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(async (args: { code: string; shop_url?: string }) => {
      const shop = await shopFor(args.shop_url);
      const { group } = (await call(shop, `/api/groups/${encodeURIComponent(args.code)}`)) as { group: GroupView };
      return reply(
        groupSummary(group) + (group.combined ? ` The shop's order is ${group.combined.status}.` : ""),
        group,
      );
    }),
  );

  server.registerTool(
    "close_group_order",
    {
      title: "Close a group order now",
      description: "Close a group order early, as its organiser. Unpaid shares are left out; the shop gets the rest as one order.",
      inputSchema: { code: z.string().min(4).max(12), organiser_key: z.string().min(8), ...shopArg },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    guarded(async (args: { code: string; organiser_key: string; shop_url?: string }) => {
      const shop = await shopFor(args.shop_url);
      const { group } = (await call(shop, `/api/groups/${encodeURIComponent(args.code)}/close`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organiserKey: args.organiser_key }),
      })) as { group: GroupView };
      return reply(
        group.status === "sent"
          ? `Closed: ${groupSummary(group)} The shop has the combined order, and ${group.organiser}'s pickup QR is on its way by email.`
          : `Closed with nobody paid, so the group order was cancelled.`,
        group,
      );
    }),
  );

  return server;
}

/** A Streamable HTTP endpoint (stateless, JSON responses) for hosting the server, e.g. at /mcp. */
export function createMcpHandler(opts: PickupMcpOptions) {
  return async (req: Request): Promise<Response> => {
    const server = createPickupMcpServer(opts);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(req);
  };
}
