import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { agentBuys, makeAgent, setupShop } from "./helpers.js";
import { SqliteStore } from "../src/index.js";

test("a shop pricing in AUD can't turn x402 on without a USD conversion", () => {
  assert.throws(() => setupShop({ currency: "aud" }), /toUsdCents/);
});

test("an AUD shop's x402 orders are priced in USD once, when the order is made", async () => {
  const calls: [number, string][] = [];
  const shop = setupShop(
    { currency: "aud" },
    {
      toUsdCents: async (cents, currency) => {
        calls.push([cents, currency]);
        return cents * 0.65;
      },
    },
  );
  const agent = makeAgent();
  // A$9.00 at 0.65 is US$5.85.
  const { orderId, required, paid } = await agentBuys(shop, agent, [{ id: "flat-white", qty: 2 }]);
  assert.equal(required.accepts[0].amount, "5850000");
  assert.equal(paid.status, 200);
  const body = (await paid.json()) as { order: { totalCents: number; currency: string; usdCents: number } };
  assert.deepEqual([body.order.totalCents, body.order.currency, body.order.usdCents], [900, "aud", 585]);
  assert.deepEqual(calls, [[900, "aud"]], "converted once, not again for the quote or the payment check");
  assert.equal((await shop.store.getOrder(orderId))!.usdCents, 585);
});

test("when the rate source fails, the order is refused rather than mispriced", async () => {
  const shop = setupShop({ currency: "aud" }, { toUsdCents: () => Promise.reject(new Error("rates down")) });
  const res = await shop.post("/api/orders", { items: [{ id: "flat-white", qty: 1 }], email: "a@b.co", rail: "x402" });
  assert.equal(res.status, 503);
  // Card and test orders don't need a USD price.
  const test = await shop.post("/api/orders", { items: [{ id: "flat-white", qty: 1 }], email: "a@b.co", rail: "test" });
  assert.equal(test.status, 201);
});

test("a USD shop's orders carry no separate USD price", async () => {
  const shop = setupShop();
  const { orderId } = await agentBuys(shop, makeAgent());
  const order = (await shop.store.getOrder(orderId))!;
  assert.equal(order.usdCents ?? null, null);
});

test("a database made by 0.1 gains the new column when opened", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "pickup-")), "old.db");
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE orders (
    id TEXT PRIMARY KEY, status TEXT NOT NULL, rail TEXT NOT NULL, capture_mode TEXT NOT NULL, items TEXT NOT NULL,
    total_cents INTEGER NOT NULL, currency TEXT NOT NULL, customer_email TEXT, customer_name TEXT, payment_ref TEXT,
    payer TEXT, pass_id TEXT UNIQUE, pickup_code TEXT, collect_by INTEGER NOT NULL, created_at INTEGER NOT NULL,
    paid_at INTEGER, ready_at INTEGER, collected_at INTEGER, refund_due INTEGER NOT NULL DEFAULT 0)`);
  old.prepare(
    "INSERT INTO orders (id, status, rail, capture_mode, items, total_cents, currency, collect_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("ord_old", "paid", "x402", "charge", "[]", 450, "usd", Date.now() + 60_000, Date.now());
  old.close();

  const store = new SqliteStore(file);
  const order = (await store.getOrder("ord_old"))!;
  assert.equal(order.totalCents, 450);
  assert.equal(order.usdCents, null);
  await store.updateOrder("ord_old", { usdCents: 300 });
  assert.equal((await store.getOrder("ord_old"))!.usdCents, 300);
  store.db.close();
});
