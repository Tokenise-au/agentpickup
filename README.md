# agentPickup

Click and collect for people and their AI agents.

1. Someone buys online: a person at checkout, or an AI agent calling the shop's API.
2. They pay by card (Stripe) or in USDC (x402).
3. An email arrives from the shop with a signed QR and a short pickup code.
4. Staff scan it with any phone camera, the built-in scanner, or a USB scanner.
5. The order is handed over. A card hold is captured at that moment; no-shows are released.

Shoppers and staff only ever see the shop's name, colours and email address.

## Run it

```bash
npm install
npm start          # http://localhost:8402
npm test           # pass format + end-to-end order flow
npm run typecheck
```

With no settings it runs on instant test payments and shows emails on the page instead of
sending them. Copy `.env.example` to `.env` to switch things on:

| Setting | What it turns on |
|---|---|
| `STRIPE_SECRET_KEY` (+ `STRIPE_WEBHOOK_SECRET`) | Card checkout. Holds the card, captures on scan. Use `sk_test_` keys. |
| `X402_PAY_TO`, `X402_NETWORK` | Agent payments. `eip155:84532` is Base Sepolia (test USDC). |
| `RESEND_API_KEY`, `MAIL_FROM` | Real email delivery, QR embedded as an inline image. |
| `STAFF_KEY` | Locks the scanner. Without it `/staff` is open (demo only). |
| `ADMIN_KEY` | Read waitlist signups at `/admin/waitlist?key=…`. |

## Use it in your own server

```ts
import { createCollect, SqliteStore, resendMailer } from "@agentpickup/server";

const collect = createCollect({
  baseUrl: "https://orders.yourshop.com",
  merchant: { name: "Corner Café", brandColor: "#9a3412", fromEmail: "Corner Café <orders@yourshop.com>", location: { name: "Front counter" } },
  catalog: [{ id: "flat-white", name: "Flat white", priceCents: 450 }],
  payments: {
    card: { secretKey: process.env.STRIPE_KEY!, captureMode: "hold" },
    x402: { payTo: process.env.WALLET!, network: "eip155:8453" },
  },
  store: new SqliteStore("./data/collect.db"),
  mailer: resendMailer({ apiKey: process.env.RESEND_KEY! }),
  signingKeyPem: process.env.PASS_SIGNING_KEY!,   // generateSigningKeyPem() from @agentpickup/core
  staffKey: process.env.STAFF_KEY,
  onEvent: (event, order) => { /* push to your POS: order.paid, order.ready, order.collected, order.expired */ },
});

app.route("/", collect.app); // any Hono app; collect.app.fetch works anywhere
```

Behind a TLS proxy (Railway, Fly, a load balancer) requests reach your server as `http://`. Rewrite
them to your public origin before `collect.app.fetch` (see `withPublicOrigin` in `apps/demo/src/main.ts`)
so the URLs it reports, such as the resource in an x402 quote, match what clients called.

### Routes it adds

| Route | Who | What |
|---|---|---|
| `GET /api/catalog` | anyone | Menu, merchant and which payment methods are on |
| `POST /api/orders` | shopper or agent | `{ items: [{id, qty}], email, name?, rail: "card" \| "x402" \| "test" }` |
| `POST /api/orders/:id/pay` | agent | x402-protected. Answers 402 with the price; once paid the QR is emailed |
| `GET /api/orders/:id` | anyone with the id | Status only. No pass, code or email |
| `GET /orders/:id/thanks` | shopper | Stripe return page; confirms payment and sends the email |
| `POST /api/stripe/webhook` | Stripe | `checkout.session.completed` |
| `GET /p/:passId` | shopper | Pass page with the QR |
| `GET /c/:token` | anyone | Where the QR points: staff devices go to hand-over, everyone else to their pass |
| `GET /staff` | staff | Scanner (camera, USB or typed code) and open-orders board |
| `POST /api/staff/lookup`, `/collect`, `/ready` | staff | Check a pass, hand over (captures the hold), mark ready (sends a second email) |
| `GET /.well-known/collect-keys.json` | anyone | Public keys (JWKS) for checking passes offline |

## How it works

- **Passes** are compact JWS tokens signed with Ed25519 (`{v, oid, pid, exp}`). Items, names and
  amounts stay on the server. The QR encodes `https://<shop>/c/<token>` (~250 characters), so a
  normal phone camera opens it. Each pass is good for one pickup: the order moves
  `paid/ready → collected` in one atomic update, so two scanners can't both hand it over.
- **Card payments** use Stripe Checkout with `capture_method: manual`. The hold is captured on scan,
  and released if nobody collects in time (`noShowPolicy: "keep"` captures it instead). Card holds
  lapse after about 7 days, so use `captureMode: "charge"` for longer pickup windows.
- **Agent payments** use x402 `exact`, charged at order time. Uncollected agent orders are flagged
  `refundDue`. x402's `auth-capture` scheme (hold, then capture on scan) is the planned upgrade, but
  the public facilitator doesn't support it on Base Sepolia yet (checked 2026-11-03).
- **Webhooks**: set `webhook: { url, secret }` and every event is POSTed with a
  `Collect-Signature: t=<unix>,v1=<hmac-sha256(secret, "<t>.<body>")>` header.

## Layout

```
packages/core     @agentpickup/core    pass signing/verifying, ids, types (no dependencies)
packages/server   @agentpickup/server  Hono app: orders, Stripe, x402, email, scanner, pages
apps/demo         the product site: landing page, live demo shop, waitlist
```

The repo folder is still called `collect402`; the product and packages are agentPickup
(`agentpickup.xyz` and `agentpickup.app` looked unregistered on 2026-11-03; `agentpickup.com` is taken).

## Not done yet

- The Stripe and Resend paths are written and typechecked, but haven't been run against real
  test keys. The x402 path is verified up to the 402 challenge, not a settled payment.
- Not built yet: Stripe Connect for platforms, Apple/Google Wallet passes, rotating QR codes,
  offline scanning, Shopify/Square adapters, and an npm build (packages currently export TypeScript source).
