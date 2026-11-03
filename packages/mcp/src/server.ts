// The agentPickup MCP server: lets any MCP client (Claude, ChatGPT, Cursor, an agent framework) find what a
// pickup shop sells, order it, pay over x402, and hand its user the QR to collect with.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { errorOf, usd, type Fetch, type Payer } from "./wallet.js";

export const VERSION = "0.1.0";

export interface PickupMcpOptions {
  /** The agentPickup shop this server orders from. */
  shopUrl: string;
  /** Let tool calls name another agentPickup shop. Leave off for hosted servers, so callers can't point it anywhere. */
  allowOtherShops?: boolean;
  /** How requests reach the shop. Defaults to global fetch; a shop hosting its own server passes its app's fetch. */
  fetch?: Fetch;
  /** The wallet that pays. Without one, pay_order returns the price and pay link for another x402 client. */
  payer?: Payer;
}

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
1. get_shop: see what the shop sells, its pickup location and how it takes payment.
2. create_pickup_order: needs the user's email, where the shop sends the pickup QR.
3. pay_order: pays from the configured wallet in USDC over x402. Confirm the items and total with the user first.
4. Give the user the pass link and pickup code. They show the QR at the counter to collect.
get_pickup_pass fetches the pass again later; order_status says whether it's ready or collected.`;

const money = (cents: number, currency: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);

const reply = (summary: string, data: unknown) => ({
  content: [{ type: "text" as const, text: `${summary}\n\n${JSON.stringify(data, null, 2)}` }],
});

const failure = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });

export function createPickupMcpServer(opts: PickupMcpOptions): McpServer {
  const home = new URL(opts.shopUrl).origin;
  const doFetch: Fetch = opts.fetch ?? ((req) => fetch(req));

  function shopFor(shopUrl?: string): string {
    if (!shopUrl) return home;
    let url: URL;
    try {
      url = new URL(shopUrl);
    } catch {
      throw new ToolError(`"${shopUrl}" isn't a URL.`);
    }
    if (url.origin === home) return home;
    if (!opts.allowOtherShops) throw new ToolError(`This server orders from one shop only: ${home}.`);
    if (url.protocol !== "https:" && url.hostname !== "localhost") throw new ToolError("Shops must be served over https.");
    return url.origin;
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

  const shopArg: Record<string, z.ZodType> = opts.allowOtherShops
    ? { shop_url: z.string().optional().describe(`An agentPickup shop's URL. Defaults to ${home}.`) }
    : {};

  const server = new McpServer({ name: "agentpickup", title: "agentPickup", version: VERSION }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "get_shop",
    {
      title: "See what a shop sells",
      description: "What the shop sells (item ids and prices), where to collect, and which payments it takes.",
      inputSchema: { ...shopArg },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(async (args: { shop_url?: string }) => {
      const shop = shopFor(args.shop_url);
      const data = await call(shop, "/api/catalog");
      const merchant = data.merchant as { name: string; location?: { name?: string; address?: string; hours?: string } };
      const currency = String(data.currency ?? "usd");
      const items = (data.items as { id: string; name: string; priceCents: number; description?: string }[]).map((i) => ({
        id: i.id,
        name: i.name,
        price: money(i.priceCents, currency),
        description: i.description,
      }));
      const payments = data.payments as { x402?: { network: string } | null };
      return reply(
        `${merchant.name}${merchant.location?.name ? `, collect at ${merchant.location.name}` : ""}. ` +
          (payments.x402 ? `Takes USDC over x402 on ${payments.x402.network}.` : "Doesn't take x402 payments."),
        { shop, merchant: merchant.name, location: merchant.location, currency, items, x402: payments.x402 ?? null },
      );
    }),
  );

  server.registerTool(
    "create_pickup_order",
    {
      title: "Order for pickup",
      description:
        "Create an order to collect in person. Returns the order id and total; pay it with pay_order. " +
        "The shop emails the pickup QR to `email` once it's paid.",
      inputSchema: {
        items: z
          .array(z.object({ id: z.string().describe("Item id from get_shop"), qty: z.number().int().min(1).max(20) }))
          .min(1),
        email: z.string().email().describe("The user's email. The pickup QR goes here."),
        name: z.string().max(100).optional().describe("Name for the order, shown to staff"),
        ...shopArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guarded(async (args: { items: { id: string; qty: number }[]; email: string; name?: string; shop_url?: string }) => {
      const shop = shopFor(args.shop_url);
      const data = await call(shop, "/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: args.items, email: args.email, name: args.name, rail: "x402" }),
      });
      const order = data.order as Order;
      const next = data.next as { url: string };
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
      const shop = shopFor(args.shop_url);
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
      const shop = shopFor(args.shop_url);
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
      const shop = shopFor(args.shop_url);
      const res = await opts.payer.signIn(`${shop}/api/orders/${encodeURIComponent(args.order_id)}/pass`, doFetch);
      if (!res.ok) throw new ToolError(await errorOf(res, `The shop answered ${res.status}.`));
      const pass = (await res.json()) as { passUrl: string; pickupCode: string; qrContent: string };
      return reply(`Pickup pass: ${pass.passUrl}, pickup code ${pass.pickupCode}.`, pass);
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
