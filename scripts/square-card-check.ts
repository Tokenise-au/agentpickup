// Checks card payments through Square (the "square" rail) against your Square SANDBOX: a declined test card,
// then an approved one charged on the Square order, then a no-show refunded through Square. Prints what Square
// shows at each step. Sandbox host only. Needs SQUARE_ACCESS_TOKEN, SQUARE_LOCATION_ID and SQUARE_APP_ID in .env.
//   node --conditions=source --import tsx scripts/square-card-check.ts
import { readFileSync } from "node:fs";
import { generateSigningKeyPem } from "@agentpickup/core";
import { createCollect, outboxMailer, squareConnector } from "../packages/server/src/index.js";
import { testStore } from "../packages/server/test/helpers.js";

const env = Object.fromEntries(
  readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
if (!env.SQUARE_APP_ID?.startsWith("sandbox-")) throw new Error("SQUARE_APP_ID in .env must be a sandbox application.");
const host = "https://connect.squareupsandbox.com";
const sq = async (path: string) => {
  const res = await fetch(host + path, { headers: { Authorization: `Bearer ${env.SQUARE_ACCESS_TOKEN}`, "Square-Version": "2026-09-16" } });
  return (await res.json()) as Record<string, any>;
};

const base = "https://cardcheck.test";
const store = testStore();
const shop = createCollect({
  baseUrl: base,
  merchant: { name: "Card check", fromEmail: "orders@cardcheck.test", location: { name: "Counter" } },
  catalog: [],
  currency: "aud",
  store,
  mailer: outboxMailer(),
  signingKeyPem: generateSigningKeyPem(),
  payments: {},
  connectors: [squareConnector({ accessToken: env.SQUARE_ACCESS_TOKEN, locationId: env.SQUARE_LOCATION_ID, environment: "sandbox", cardPayments: { applicationId: env.SQUARE_APP_ID } })],
});
await shop.ready;
const call = (path: string, init?: RequestInit) => shop.app.request(`${base}${path}`, init);
const post = (path: string, body: unknown) => call(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const { items } = (await (await call("/api/catalog")).json()) as { items: { id: string; name: string; priceCents: number }[] };
console.log("menu from Square:", items.map((i) => `${i.name} A$${(i.priceCents / 100).toFixed(2)}`).join(", "));
const created = (await (await post("/api/orders", { items: [{ id: items[0].id, qty: 1 }], name: "Card check", rail: "square" })).json()) as { order: { id: string }; next: { url: string } };
const id = created.order.id;
console.log("checkout link:", created.next.url);

const page = await (await call(`/connect/square/pay/${id}`)).text();
console.log("checkout page:", page.includes('id="card-container"') ? "card form" : "NO CARD FORM", "|", page.match(/"amount":"[^"]+","currency":"[A-Z]+","country":"[A-Z]+"/)?.[0]);

const declined = await post(`/connect/square/pay/${id}`, { sourceId: "cnon:card-nonce-declined", email: "card-check@example.com" });
console.log("declined card:", declined.status, ((await declined.json()) as { error?: string }).error);

const ok = await post(`/connect/square/pay/${id}`, { sourceId: "cnon:card-nonce-ok", email: "card-check@example.com" });
console.log("approved card:", ok.status, JSON.stringify(await ok.json()));
await shop.flushConnectors();
const order = (await store.getOrder(id))!;
const link = (await store.getDoc<{ externalId: string; paymentId: string }>("link:square", id))!;
const squareOrder = (await sq(`/v2/orders/${link.externalId}`)).order;
const payment = (await sq(`/v2/payments/${link.paymentId}`)).payment;
console.log("agentPickup:", order.status, order.rail, "| Square order:", squareOrder.state, `total ${squareOrder.total_money.amount} ${squareOrder.total_money.currency}`, `tenders ${(squareOrder.tenders ?? []).map((t: { type: string }) => t.type).join(",")}`, `pickup ${squareOrder.fulfillments?.[0]?.state}`);
console.log("Square payment:", payment.status, payment.source_type, payment.card_details?.card?.card_brand, payment.card_details?.card?.last_4, `order ${payment.order_id === link.externalId ? "matches" : "DIFFERS"}`);

await store.updateOrder(id, { collectBy: Date.now() - 1 });
await shop.sweep();
await shop.flushConnectors();
const after = (await sq(`/v2/orders/${link.externalId}`)).order;
const refunds = (await sq(`/v2/refunds?location_id=${env.SQUARE_LOCATION_ID}&sort_order=DESC&limit=5`)).refunds?.filter((r: { payment_id: string }) => r.payment_id === link.paymentId) ?? [];
console.log("no-show:", (await store.getOrder(id))!.status, "| Square order:", after.state, `pickup ${after.fulfillments?.[0]?.state}`, `| refunds ${refunds.length}: ${refunds.map((r: { status: string; amount_money: { amount: number } }) => `${r.status} ${r.amount_money.amount}`).join(", ")}`);
shop.stop();
