// Runs every server test file again with PostgresStore (on PGlite, real Postgres in-process), plus the
// checks only Postgres needs: racing transitions, same-millisecond ordering and table prefixes.
process.env.TEST_STORE = "postgres";

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import type { Order } from "@agentpickup/core";
import { PostgresStore } from "../src/index.js";
import { closeTestDb } from "./helpers.js";

await import("./flow.test.js");
await import("./hardening.test.js");
await import("./x402.test.js");
await import("./x402-extensions.test.js");
await import("./mpp.test.js");
await import("./ucp.test.js");
await import("./acp.test.js");
await import("./ap2.test.js");
await import("./agent-signatures.test.js");
await import("./currency.test.js");
after(() => closeTestDb());

const order = (id: string): Order => ({
  id,
  status: "paid",
  rail: "test",
  captureMode: "hold",
  items: [{ id: "flat-white", name: "Flat white", qty: 1, unitCents: 450 }],
  totalCents: 450,
  currency: "usd",
  customerEmail: "a@b.co",
  customerName: null,
  paymentRef: null,
  payer: null,
  passId: `pas_${id}`,
  pickupCode: "ABC234",
  collectBy: Date.now() + 60_000,
  createdAt: Date.now(),
  paidAt: Date.now(),
  readyAt: null,
  collectedAt: null,
  refundDue: false,
});

test("postgres: two scanners racing on one order, exactly one hands it over", async () => {
  const db = new PGlite();
  const store = new PostgresStore(db);
  await store.insertOrder(order("ord_race"));
  const results = await Promise.all(
    Array.from({ length: 8 }, () => store.transition("ord_race", ["paid", "ready"], "collected", { collectedAt: Date.now() })),
  );
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal((await store.getOrder("ord_race"))!.status, "collected");
  await db.close();
});

test("postgres: events and emails written in the same millisecond keep their order", async () => {
  const db = new PGlite();
  const store = new PostgresStore(db);
  const at = Date.now();
  for (const type of ["order.created", "order.paid", "pass.emailed", "order.ready"] as const) {
    await store.addEvent({ id: `evt_${type}`, orderId: "ord_1", type, at });
  }
  assert.deepEqual((await store.listEvents("ord_1")).map((e) => e.type), ["order.created", "order.paid", "pass.emailed", "order.ready"]);
  await store.saveEmail({ id: "eml_1", orderId: "ord_1", to: "a@b.co", subject: "paid", html: "1", at });
  await store.saveEmail({ id: "eml_2", orderId: "ord_1", to: "a@b.co", subject: "ready", html: "2", at });
  assert.equal((await store.getLatestEmail("ord_1"))!.subject, "ready");
  await db.close();
});

test("postgres: tables carry a prefix, so two stores can share a database", async () => {
  const db = new PGlite();
  const a = new PostgresStore(db, { prefix: "shop_a_" });
  const b = new PostgresStore(db, { prefix: "shop_b_" });
  await a.insertOrder(order("ord_a"));
  assert.ok(await a.getOrder("ord_a"));
  assert.equal(await b.getOrder("ord_a"), null);
  const tables = (await db.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE tablename LIKE 'shop_%' ORDER BY 1")).rows;
  assert.deepEqual(
    tables.map((t) => t.tablename),
    ["shop_a_docs", "shop_a_emails", "shop_a_events", "shop_a_idempotency", "shop_a_orders", "shop_b_docs", "shop_b_emails", "shop_b_events", "shop_b_idempotency", "shop_b_orders"],
  );
  assert.throws(() => new PostgresStore(db, { prefix: "bad; drop table" }), /prefix/);
  await db.close();
});
