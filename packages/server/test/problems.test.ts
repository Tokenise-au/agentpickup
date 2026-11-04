import { test } from "node:test";
import assert from "node:assert/strict";
import type { PickupConnector, Problem } from "../src/index.js";
import { setupShop } from "./helpers.js";

test("problems: a POS call that still fails after its retries, and an email that won't send, reach onProblem once each", async () => {
  const seen: Problem[] = [];
  let tries = 0;
  const pos: PickupConnector = {
    name: "pos",
    onEvent: async (event) => {
      if (event.type !== "order.paid") return;
      tries++;
      throw new Error("POS is down");
    },
  };
  const shop = setupShop({
    connectors: [pos],
    mailer: { delivers: true, send: async () => Promise.reject(new Error("daily sending quota reached")) },
    onProblem: (p) => seen.push(p),
  });
  const res = await shop.post("/api/orders", { items: [{ id: "flat-white", qty: 1 }], email: "robin@example.com", rail: "test" });
  assert.equal(res.status, 201, "the customer's order goes through regardless");
  const { order } = (await res.json()) as { order: { id: string } };
  await shop.collect.flushConnectors();

  assert.equal(tries, 3, "the POS call was retried before it counted as a problem");
  const byKind = Object.fromEntries(seen.map((p) => [p.kind, p]));
  assert.deepEqual(Object.keys(byKind).sort(), ["connector", "email"]);
  assert.deepEqual(byKind.connector, { kind: "connector", message: "POS is down", orderId: order.id, connector: "pos" });
  assert.deepEqual(byKind.email, { kind: "email", message: "daily sending quota reached", orderId: order.id });
  shop.collect.stop();
});

test("problems: an onProblem that throws doesn't break the order", async () => {
  const shop = setupShop({
    mailer: { delivers: true, send: async () => Promise.reject(new Error("nope")) },
    onProblem: () => {
      throw new Error("alerting is broken too");
    },
  });
  const res = await shop.post("/api/orders", { items: [{ id: "flat-white", qty: 1 }], email: "robin@example.com", rail: "test" });
  assert.equal(res.status, 201);
  shop.collect.stop();
});
