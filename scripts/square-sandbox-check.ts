// Checks the Square connector against your Square SANDBOX: syncs the menu (adding two test items if the
// sandbox menu is empty), then runs a paid order through ready and collected, and a no-show, printing what
// Square shows at each step. Sandbox host only. Needs SQUARE_ACCESS_TOKEN and SQUARE_LOCATION_ID in .env.
//   node --conditions=source --import tsx scripts/square-sandbox-check.ts
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSigningKeyPem } from "@agentpickup/core";
import { createCollect, outboxMailer, SqliteStore, squareConnector } from "../packages/server/src/index.js";

const env = Object.fromEntries(
  readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
const host = "https://connect.squareupsandbox.com";
const sq = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(host + path, {
    method,
    headers: { Authorization: `Bearer ${env.SQUARE_ACCESS_TOKEN}`, "Square-Version": "2026-09-16", "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json()) as Record<string, any>;
  if (!res.ok) throw new Error(`${method} ${path} ${res.status} ${JSON.stringify(json.errors)}`);
  return json;
};

// 1. Two test items, only if the sandbox menu is empty.
const existing = await sq("GET", "/v2/catalog/list?types=ITEM");
if (!(existing.objects ?? []).length) {
  const variation = (id: string, item: string, name: string, amount: number) => ({
    type: "ITEM_VARIATION",
    id,
    item_variation_data: { item_id: item, name, pricing_type: "FIXED_PRICING", price_money: { amount, currency: "AUD" } },
  });
  await sq("POST", "/v2/catalog/batch-upsert", {
    idempotency_key: "agentpickup-seed-menu-1",
    batches: [
      {
        objects: [
          { type: "ITEM", id: "#flatwhite", item_data: { name: "Flat white", description: "agentPickup test item", variations: [variation("#fw-reg", "#flatwhite", "Regular", 520), variation("#fw-lrg", "#flatwhite", "Large", 620)] } },
          { type: "ITEM", id: "#bananabread", item_data: { name: "Banana bread", description: "agentPickup test item", variations: [variation("#bb", "#bananabread", "Regular", 600)] } },
        ],
      },
    ],
  });
  console.log("seeded 2 test items into the sandbox menu");
}

// 2. The library, with the real Square connector.
const store = new SqliteStore(join(mkdtempSync(join(tmpdir(), "sq-")), "run.db"));
const collect = createCollect({
  baseUrl: "http://localhost",
  merchant: { name: "Square Sandbox Café", fromEmail: "orders@example.com" },
  catalog: [],
  currency: "aud",
  store,
  mailer: outboxMailer(),
  signingKeyPem: generateSigningKeyPem(),
  payments: { test: true },
  allowOpenStaff: true,
  connectors: [squareConnector({ accessToken: env.SQUARE_ACCESS_TOKEN, locationId: env.SQUARE_LOCATION_ID, environment: "sandbox" })],
});
await collect.ready;
const menu = (await (await collect.app.request("http://localhost/api/catalog")).json()) as { items: { id: string; name: string; priceCents: number }[] };
console.log("menu synced from Square:", menu.items.map((i) => `${i.name} A$${(i.priceCents / 100).toFixed(2)}`).join(", "));
const id = (name: string) => menu.items.find((i) => i.name === name)!.id;

const linkOf = async (orderId: string) => (await store.getDoc<{ externalId: string }>("link:square", orderId))!.externalId;
const squareState = async (orderId: string) => {
  const { order } = await sq("GET", `/v2/orders/${await linkOf(orderId)}`);
  return {
    squareOrder: order.id,
    state: order.state,
    pickup: order.fulfillments?.[0]?.state,
    total: `${order.total_money.currency} ${(order.total_money.amount / 100).toFixed(2)}`,
    paid: `${order.total_money.currency} ${((order.net_amount_due_money ? order.total_money.amount - order.net_amount_due_money.amount : 0) / 100).toFixed(2)} (due ${((order.net_amount_due_money?.amount ?? 0) / 100).toFixed(2)})`,
    tenders: (order.tenders ?? []).map((t: { type: string }) => t.type).join(","),
    source: order.source?.name,
    recipient: order.fulfillments?.[0]?.pickup_details?.recipient?.display_name,
    refunds: (order.refunds ?? []).length,
  };
};
const place = async (items: { id: string; qty: number }[], name: string) => {
  const res = await collect.app.request("http://localhost/api/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items, email: "sandbox-check@example.com", name, rail: "test" }),
  });
  return ((await res.json()) as { order: { id: string } }).order.id;
};

// 3. Paid -> in Square.
const a = await place([{ id: id("Flat white (Large)"), qty: 1 }, { id: id("Banana bread"), qty: 1 }], "Robin (sandbox check)");
await collect.flushConnectors();
console.log("\npaid:     ", JSON.stringify(await squareState(a)));
// 4. Ready in agentPickup -> PREPARED in Square.
await collect.markReady(a);
await collect.flushConnectors();
console.log("ready:    ", JSON.stringify(await squareState(a)));
// 5. Scan -> COMPLETED in Square.
const scanned = await collect.collect(collect.collectLink((await store.getOrder(a))!));
await collect.flushConnectors();
console.log("scanned:  ", scanned.ok, JSON.stringify(await squareState(a)));
// 6. A no-show -> CANCELED in Square.
const b = await place([{ id: id("Flat white (Regular)"), qty: 1 }], "No-show (sandbox check)");
await collect.flushConnectors();
await store.updateOrder(b, { collectBy: Date.now() - 1 });
await collect.sweep();
await collect.flushConnectors();
console.log("no-show:  ", JSON.stringify(await squareState(b)));
collect.stop();
