import { test } from "node:test";
import assert from "node:assert/strict";
import { generateSigningKeyPem } from "@agentpickup/core";
import { cappedMailer, cloudflareMailer, createCollect, createVenueHost, outboxMailer, type Mailer, type OutgoingMail } from "../src/index.js";
import { testStore } from "./helpers.js";

type Sent = { url: string; auth: string | null; body: Record<string, any> };

function fakeCloudflare(reply: (body: Record<string, any>) => { status: number; json: unknown } = () => ({ status: 200, json: { success: true, result: { message_id: "<m1@agentpickup.app>", delivered: [], queued: ["x"], permanent_bounces: [] } } })) {
  const sent: Sent[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    sent.push({ url: String(input), auth: new Headers(init?.headers).get("Authorization"), body });
    const r = reply(body);
    return new Response(JSON.stringify(r.json), { status: r.status, headers: { "Content-Type": "application/json" } });
  };
  return { sent, fetch: fetch as typeof globalThis.fetch };
}

test("cloudflare mailer: sends the pass email with the QR inline, a text part and a reply-to", async () => {
  const cf = fakeCloudflare();
  const mailer = cloudflareMailer({ accountId: "acct123", apiToken: "cf-token", fetch: cf.fetch });
  const store = testStore();
  const shop = createCollect({
    baseUrl: "https://agentpickup.app",
    merchant: { name: "Demo Café", fromEmail: "Demo Café <orders@agentpickup.app>", supportEmail: "hello@democafe.test", location: { name: "Front counter" } },
    catalog: [{ id: "flat-white", name: "Flat white", priceCents: 450 }],
    store,
    mailer,
    signingKeyPem: generateSigningKeyPem(),
    payments: { test: true },
  });
  const res = await shop.app.request("https://agentpickup.app/api/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items: [{ id: "flat-white", qty: 2 }], email: "robin@example.com", rail: "test" }),
  });
  const { order } = (await res.json()) as { order: { id: string } };
  const saved = (await store.getOrder(order.id))!;

  assert.equal(cf.sent.length, 1);
  const { url, auth, body } = cf.sent[0];
  assert.equal(url, "https://api.cloudflare.com/client/v4/accounts/acct123/email/sending/send");
  assert.equal(auth, "Bearer cf-token");
  assert.deepEqual(body.from, { address: "orders@agentpickup.app", name: "Demo Café" });
  assert.equal(body.to, "robin@example.com");
  assert.deepEqual(body.reply_to, { address: "hello@democafe.test" });
  assert.match(body.subject, /Demo Café order/);
  assert.match(body.html, /src="cid:pickup-qr"/);
  assert.match(body.text, new RegExp(`Pickup code: ${saved.pickupCode}`));
  assert.match(body.text, /Your pass, with the QR code: https:\/\/agentpickup\.app\/p\//);
  assert.match(body.text, /2 x Flat white/);
  const [qr] = body.attachments;
  assert.deepEqual([qr.disposition, qr.content_id, qr.filename, qr.type], ["inline", "pickup-qr", "pickup-qr.png", "image/png"]);
  assert.equal(Buffer.from(qr.content, "base64").subarray(1, 4).toString(), "PNG");

  const emailed = (await store.listEvents(order.id)).find((e) => e.type === "pass.emailed");
  assert.equal(emailed?.data?.delivered, true);
  shop.stop();
});

test("cloudflare mailer: an API error or a permanent bounce is reported, and the order still goes through", async () => {
  const failing = cloudflareMailer({
    accountId: "a",
    apiToken: "t",
    fetch: fakeCloudflare(() => ({ status: 403, json: { success: false, errors: [{ code: 10000, message: "Authentication error" }] } })).fetch,
  });
  const mail: OutgoingMail = { from: "orders@agentpickup.app", to: "x@example.com", subject: "s", html: "h" };
  await assert.rejects(failing.send(mail), /Cloudflare Email 403: 10000 Authentication error/);
  const bouncing = cloudflareMailer({
    accountId: "a",
    apiToken: "t",
    fetch: fakeCloudflare(() => ({ status: 200, json: { success: true, result: { permanent_bounces: ["x@example.com"] } } })).fetch,
  });
  await assert.rejects(bouncing.send(mail), /bounced permanently/);

  const store = testStore();
  const shop = createCollect({
    baseUrl: "https://agentpickup.app",
    merchant: { name: "Demo Café", fromEmail: "orders@agentpickup.app" },
    catalog: [{ id: "a", name: "A", priceCents: 100 }],
    store,
    mailer: failing,
    signingKeyPem: generateSigningKeyPem(),
    payments: { test: true },
  });
  const res = await shop.app.request("https://agentpickup.app/api/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items: [{ id: "a", qty: 1 }], email: "x@example.com", rail: "test" }),
  });
  assert.equal(res.status, 201);
  const { order } = (await res.json()) as { order: { id: string; status: string } };
  assert.equal(order.status, "paid");
  const emailed = (await store.listEvents(order.id)).find((e) => e.type === "pass.emailed");
  assert.equal(emailed?.data?.delivered, false);
  assert.match(String(emailed?.data?.error), /Authentication error/);
  shop.stop();
});

test("capped mailer: at most N emails per address and M in total per day", async () => {
  const delivered: string[] = [];
  const inner: Mailer = {
    delivers: true,
    async send(mail) {
      delivered.push(mail.to);
      return { id: String(delivered.length) };
    },
  };
  const capped = cappedMailer(inner, { perRecipientPerDay: 3, perDay: 5 });
  const send = (to: string) => capped.send({ from: "f@x", to, subject: "s", html: "h" });
  for (let i = 0; i < 3; i++) await send("Robin@Example.com");
  await assert.rejects(send("robin@example.com"), /limit reached for this address/, "case doesn't get around it");
  await send("a@example.com");
  await send("b@example.com");
  await assert.rejects(send("c@example.com"), /limit reached for this shop/);
  assert.equal(delivered.length, 5);
});

test("venue host: each venue's email comes from the platform's domain under the venue's name", async () => {
  const sent: OutgoingMail[] = [];
  const host = createVenueHost({
    baseUrl: "https://platform.test",
    store: testStore(),
    storeFor: () => testStore(),
    mailer: { delivers: true, send: async (m) => (sent.push(m), { id: "1" }) },
    secretKey: "x".repeat(40),
    adminKeys: ["k"],
    sendFrom: "orders@platform.test",
  });
  const req = (path: string, init?: RequestInit) => host.app.request(`https://platform.test${path}`, init);
  await req("/host/v1/venues/corner", {
    method: "PUT",
    headers: { Authorization: "Bearer k", "Content-Type": "application/json" },
    body: JSON.stringify({
      merchant: { name: "Corner Café", fromEmail: "owner@cornercafe.test", supportEmail: "hi@cornercafe.test" },
      catalog: [{ id: "a", name: "A", priceCents: 300 }],
      payments: { test: true },
    }),
  });
  await req("/v/corner/api/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items: [{ id: "a", qty: 1 }], email: "robin@example.com", rail: "test" }),
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].from, '"Corner Café" <orders@platform.test>');
  assert.equal(sent[0].replyTo, "hi@cornercafe.test");
  host.stop();
});

test("outbox mailer still keeps emails on the page only", async () => {
  assert.equal(outboxMailer().delivers, false);
});
