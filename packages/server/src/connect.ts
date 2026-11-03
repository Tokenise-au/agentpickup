// The connector API: one set of routes any platform can integrate against, so agentPickup plugs into a
// POS or ordering system without a bespoke build. Platforms push the menu in, read paid orders (or
// receive them as signed webhooks), and mark orders ready. Named connectors (Square) mount beside it.
import { timingSafeEqual } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import type { Order, OrderStatus } from "@agentpickup/core";
import type { CatalogItem } from "./config.js";
import type { ConnectorContext, PickupConnector } from "./connectors/types.js";

export interface ConnectConfig {
  /** Bearer keys for platforms calling /connect/v1. One per platform, so each can be revoked. */
  apiKeys: string[];
}

const ID = /^[A-Za-z0-9_\-.:#]{1,100}$/;

/** A menu a platform sends is checked item by item; one bad item rejects the whole menu. */
export function parseCatalog(input: unknown): { items: CatalogItem[] } | { error: string } {
  const list = Array.isArray(input) ? input : (input as { items?: unknown })?.items;
  if (!Array.isArray(list) || list.length === 0) return { error: "Send { items: [...] } with at least one item." };
  if (list.length > 500) return { error: "A menu can have at most 500 items." };
  const items: CatalogItem[] = [];
  const seen = new Set<string>();
  for (const [i, raw] of list.entries()) {
    const item = raw as Partial<CatalogItem>;
    if (typeof item.id !== "string" || !ID.test(item.id)) return { error: `Item ${i}: id must be 1-100 letters, digits or _-.:#.` };
    if (seen.has(item.id)) return { error: `Item ${i}: duplicate id ${item.id}.` };
    if (typeof item.name !== "string" || !item.name.trim() || item.name.length > 120) return { error: `Item ${i}: name must be 1-120 characters.` };
    if (!Number.isInteger(item.priceCents) || item.priceCents! < 1 || item.priceCents! > 10_000_000) {
      return { error: `Item ${i}: priceCents must be a whole number of cents, 1 or more.` };
    }
    if (item.description !== undefined && (typeof item.description !== "string" || item.description.length > 500)) {
      return { error: `Item ${i}: description must be text of at most 500 characters.` };
    }
    seen.add(item.id);
    items.push({ id: item.id, name: item.name.trim(), priceCents: item.priceCents!, ...(item.description ? { description: item.description } : {}) });
  }
  return { items };
}

function bearer(keys: string[]): MiddlewareHandler {
  const wanted = keys.filter(Boolean).map((k) => Buffer.from(k));
  return async (c, next) => {
    const given = Buffer.from((c.req.header("Authorization") ?? "").replace(/^Bearer\s+/i, ""));
    const ok = wanted.some((k) => k.length === given.length && timingSafeEqual(k, given));
    if (!ok) return c.json({ error: "Send Authorization: Bearer <your connector key>." }, 401);
    return next();
  };
}

export function mountConnect(
  app: Hono,
  opts: {
    connect?: ConnectConfig;
    connectors: PickupConnector[];
    /** Each connector's own context, so its links stay its own. */
    ctxFor: (name: string) => ConnectorContext;
    syncCatalog: () => Promise<{ connector: string; items: number }[]>;
    clearCatalog: () => Promise<void>;
    listOrders: (statuses: OrderStatus[]) => Promise<Order[]>;
    view: (o: Order) => Record<string, unknown>;
  },
) {
  if (opts.connect?.apiKeys.length) {
    const ctx = opts.ctxFor("connect");
    const api = new Hono();
    api.use("*", bearer(opts.connect.apiKeys));

    api.put("/catalog", async (c) => {
      const parsed = parseCatalog(await c.req.json().catch(() => null));
      if ("error" in parsed) return c.json({ error: parsed.error }, 400);
      await ctx.setCatalog(parsed.items);
      return c.json({ items: parsed.items.length });
    });
    // Go back to the menu in the shop's own config.
    api.delete("/catalog", async (c) => {
      await opts.clearCatalog();
      return c.json({ ok: true });
    });
    api.post("/catalog/sync", async (c) => c.json({ synced: await opts.syncCatalog() }));

    // Platforms that poll rather than take webhooks read open orders here.
    api.get("/orders", async (c) => {
      const wanted = (c.req.query("status") ?? "paid,ready").split(",") as OrderStatus[];
      const allowed = wanted.filter((s) => ["paid", "ready", "collected", "expired", "cancelled"].includes(s));
      if (!allowed.length) return c.json({ error: "status must list paid, ready, collected, expired or cancelled." }, 400);
      return c.json({ orders: (await opts.listOrders(allowed)).map(opts.view) });
    });
    api.post("/orders/:id/ready", async (c) => {
      const order = await ctx.getOrder(c.req.param("id"));
      if (!order) return c.json({ error: "Order not found." }, 404);
      if (order.status === "ready") return c.json({ order: opts.view(order) });
      if (order.status !== "paid") return c.json({ error: `Only paid orders can be marked ready; this one is ${order.status}.` }, 409);
      await ctx.markReady(order.id);
      return c.json({ order: opts.view((await ctx.getOrder(order.id))!) });
    });
    app.route("/connect/v1", api);
  }

  for (const connector of opts.connectors) {
    if (!connector.routes) continue;
    const sub = new Hono();
    connector.routes(sub, opts.ctxFor(connector.name));
    app.route(`/connect/${connector.name}`, sub);
  }
}
