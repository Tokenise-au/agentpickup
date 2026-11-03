// Shared test setup: an in-memory shop, a fake x402 facilitator and an agent
// that signs real x402 payments, so payment paths run without a network.
import { generateSigningKeyPem } from "@agentpickup/core";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { PGlite } from "@electric-sql/pglite";
import { createCollect, outboxMailer, PostgresStore, SqliteStore, type CollectConfig, type Store } from "../src/index.js";

/**
 * SQLite by default. postgres.test.ts runs every test file again on Postgres: one in-process PGlite for the
 * whole run, and a fresh table prefix per store, which is also how two shops share a real database.
 */
let pg: PGlite | null = null;
let stores = 0;
export function testStore(): Store {
  if (process.env.TEST_STORE !== "postgres") return new SqliteStore(":memory:");
  pg ??= new PGlite();
  return new PostgresStore(pg, { prefix: `t${++stores}_` });
}
export async function closeTestDb() {
  await pg?.close();
  pg = null;
}

export const NETWORK = "eip155:84532" as const;
export const PAY_TO = "0x1111111111111111111111111111111111111111";

/** Accepts any well-formed payment whose amount and payee match; records what it settled. */
export class FakeFacilitator implements FacilitatorClient {
  settled: { payload: PaymentPayload; requirements: PaymentRequirements }[] = [];
  failSettle = false;

  async verify(payload: PaymentPayload, requirements: PaymentRequirements) {
    const auth = (payload.payload as { authorization?: { from: string; to: string; value: string } }).authorization;
    const ok = !!auth && auth.to.toLowerCase() === requirements.payTo.toLowerCase() && auth.value === requirements.amount;
    return ok ? { isValid: true, payer: auth!.from } : { isValid: false, invalidReason: "amount_or_payee_mismatch" };
  }

  async settle(payload: PaymentPayload, requirements: PaymentRequirements) {
    const payer = (payload.payload as { authorization: { from: string } }).authorization.from;
    if (this.failSettle) {
      return { success: false, errorReason: "insufficient_funds", transaction: "", network: requirements.network, payer };
    }
    this.settled.push({ payload, requirements });
    const tx = `0x${(this.settled.length).toString(16).padStart(64, "0")}`;
    return { success: true, transaction: tx, network: requirements.network, payer };
  }

  async getSupported() {
    return { kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }], extensions: [], signers: {} };
  }
}

export function makeAgent(privateKey: `0x${string}` = generatePrivateKey()) {
  const account = privateKeyToAccount(privateKey);
  // Stock x402 clients refuse anything over $1 per payment; a coffee order needs more headroom.
  const client = x402Client.fromConfig({
    schemes: [{ network: NETWORK, client: new ExactEvmScheme(account) }],
    spendControls: { maxAmountPerPayment: "$50" },
  });
  return { address: account.address, http: new x402HTTPClient(client) };
}

export const CATALOG = [
  { id: "flat-white", name: "Flat white", priceCents: 450 },
  { id: "croissant", name: "Croissant", priceCents: 500 },
];

export function setupShop(extra: Partial<CollectConfig> = {}) {
  const store = testStore();
  const facilitator = new FakeFacilitator();
  const collect = createCollect({
    baseUrl: "https://shop.test",
    merchant: { name: "Test Café", fromEmail: "orders@shop.test", location: { name: "Front counter" } },
    catalog: CATALOG,
    store,
    mailer: outboxMailer(),
    signingKeyPem: generateSigningKeyPem(),
    payments: { test: true, x402: { payTo: PAY_TO, network: NETWORK, facilitator } },
    exposeEmailPreview: true,
    allowOpenStaff: true,
    ...extra,
  });
  const call = (path: string, init?: RequestInit) => collect.app.request(`https://shop.test${path}`, init);
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    call(path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { store, collect, facilitator, call, post };
}

/** The full agent flow: create an x402 order, read the 402, sign, and pay. */
export async function agentBuys(
  shop: ReturnType<typeof setupShop>,
  agent: ReturnType<typeof makeAgent>,
  items = [{ id: "flat-white", qty: 1 }],
  extraHeaders: Record<string, string> = {},
) {
  const created = await shop.post("/api/orders", { items, email: "agent-owner@example.com", rail: "x402" });
  const { order, next } = (await created.json()) as { order: { id: string }; next: { url: string } };
  const path = new URL(next.url).pathname;
  const challenge = await shop.call(path, { method: "POST", headers: extraHeaders });
  const required = agent.http.getPaymentRequiredResponse((n) => challenge.headers.get(n), await challenge.clone().json().catch(() => undefined));
  const payload = await agent.http.createPaymentPayload(required);
  const paid = await shop.call(path, {
    method: "POST",
    headers: { ...agent.http.encodePaymentSignatureHeader(payload), ...extraHeaders },
  });
  return { orderId: order.id, path, challenge, required, payload, paid };
}
