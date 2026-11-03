# agentPickup

The pickup layer for agent payments: click and collect for people and their AI agents.

1. Someone buys online: a person at checkout, or an AI agent through x402, MPP, UCP or ACP.
2. They pay by card (Stripe), USDC (x402), or a Stripe Shared Payment Token handed over by an agent platform.
3. An email arrives from the shop with a signed QR and a short pickup code.
4. Staff scan it with any phone camera, the built-in scanner, or a USB scanner.
5. The order is handed over. A card hold is captured at that moment; no-shows are released or refunded.

Shoppers and staff only ever see the shop's name, colours and email address.

## Run it

```bash
npm install
npm start          # http://localhost:8402
npm test           # 165 tests: every path on SQLite, and again on Postgres (in-process PGlite)
npm run typecheck
```

With no settings it runs on instant test payments and shows emails on the page instead of
sending them. Copy `.env.example` to `.env` to switch things on:

| Setting | What it turns on |
|---|---|
| `STRIPE_SECRET_KEY` (+ `STRIPE_WEBHOOK_SECRET`) | Card checkout. Holds the card, captures on scan. Use `sk_test_` keys. Also the SPT handler for UCP. |
| `STRIPE_PROFILE_ID` | The Stripe profile id advertised to UCP platforms. |
| `X402_PAY_TO`, `X402_NETWORK`, `X402_FACILITATOR_URL` | x402 agent payments. `eip155:84532` is Base Sepolia (test USDC, x402.org facilitator), where the demo café wallet takes the payments. `eip155:8453` is Base mainnet (real USDC, PayAI's keyless facilitator by default), where payments go only to `X402_PAY_TO`. |
| `MPP_NETWORK_ID`, `MPP_CHALLENGE_SECRET` | MPP agent payments by card or Link into your Stripe (needs Stripe's MPP access). |
| `RESEND_API_KEY`, `MAIL_FROM` | Real email delivery, QR embedded as an inline image. |
| `STAFF_KEY` | Locks the scanner. Without it the demo runs with `allowOpenStaff`. |
| `ADMIN_KEY` | Read waitlist signups at `/admin/waitlist?key=…`. |
| `SIGNING_KEY_PEM`, `AP2_SIGNING_KEY_PEM` | Pass signing (Ed25519) and AP2 merchant signatures (ES256). Generated into `data/` if unset. |
| `DEMO_AGENT_KEY`, `DEMO_CAFE_KEY`, `DEMO_AGENT_MAX_ORDER`, `DEMO_AGENT_DAILY_LIMIT` | The demo's own wallets. The agent pays demo orders over x402 for real (the button on the page and the hosted `/mcp`): up to $20 an order and 60 a day on testnet, $10 and 20 on mainnet. On testnet the café is the payTo and hands test USDC back when the agent runs low; on mainnet the café key is ignored, the agent pays `X402_PAY_TO`, and you top it up. Keep only a small balance in the agent: its key sits in server config. |

## Agent payment standards

| Standard | What agentPickup does | Where |
|---|---|---|
| **x402** | `exact` payments priced from the order. **Bazaar** discovery metadata, **signed offers and receipts** (JWS, did:web key at `/.well-known/did.json`), **payment-identifier** idempotency, and **Sign-In-With-X** so the paying wallet can fetch its pass again | `POST /api/orders/:id/pay`, `GET /api/orders/:id/pass`, `/openapi.json` |
| **MPP** (Stripe + Tempo) | `WWW-Authenticate: Payment` challenge; card or Link through a Stripe Shared Payment Token, confirmed in the merchant's Stripe, with `Payment-Receipt`. Credentials are bound to one order | `POST /api/orders/:id/mpp` |
| **UCP** (2026-08-25) | Business profile; REST checkout with the `pickup` method and a `business_location`; `com.stripe.payments` SPT handler; the order `permalink_url` is the pickup pass, with ready and delivered fulfilment events | `/.well-known/ucp`, `/ucp/v1/*` |
| **AP2** (v0.2, via UCP) | ES256 `merchant_authorization` on every checkout, and a required SD-JWT+KB checkout mandate when the platform supports AP2. The mandate is verified and stored as evidence | UCP complete |
| **ACP** (2026-04-17) | Discovery; checkout sessions with the `pickup` fulfilment option; delegated payment (SPT); signed order webhooks | `/.well-known/acp.json`, `/acp/*` |
| **Visa TAP / Mastercard Agent Pay / Web Bot Auth** | RFC 9421 request signatures on agent payment routes, in `log` or `require` mode | middleware |

Stock x402 clients cap each payment at **$1** (`spendControls.maxAmountPerPayment`). Agents buying
real goods need that raised.

## MCP server

`@agentpickup/mcp` lets any MCP client order from an agentPickup shop: `get_shop`, `create_pickup_order`,
`pay_order` (x402 from a wallet you configure, with a spend cap), `order_status` and `get_pickup_pass`
(Sign-In-With-X). The demo hosts it at `/mcp`, paying with the demo agent's wallet:

```json
{ "mcpServers": { "agentpickup": { "type": "http", "url": "https://agentpickup.app/mcp" } } }
```

Run it locally with `npx -y @agentpickup/mcp` and `AGENTPICKUP_SHOP_URL` / `AGENTPICKUP_WALLET_KEY`. It's listed
in the official MCP Registry as `io.github.dav3trad3r/agentpickup`. See [packages/mcp](packages/mcp/README.md).

## Use it in your own server

```ts
import { createCollect, SqliteStore, resendMailer } from "@agentpickup/server";

const pickup = createCollect({
  baseUrl: "https://orders.yourshop.com",
  merchant: { name: "Corner Café", brandColor: "#9a3412", fromEmail: "Corner Café <orders@yourshop.com>", location: { name: "Front counter" } },
  catalog: [{ id: "flat-white", name: "Flat white", priceCents: 450 }],
  payments: {
    card: { secretKey: process.env.STRIPE_KEY!, captureMode: "hold" },
    x402: { payTo: process.env.WALLET!, network: "eip155:8453" },
    mpp: { stripeSecretKey: process.env.STRIPE_KEY!, networkId: process.env.MPP_NETWORK_ID!, challengeSecret: process.env.MPP_SECRET! },
  },
  ucp: { stripe: { secretKey: process.env.STRIPE_KEY!, businessProfile: "profile_…" }, ap2: { signingKeyPem: process.env.AP2_KEY! } },
  acp: { apiKeys: [process.env.ACP_PLATFORM_KEY!], stripe: { secretKey: process.env.STRIPE_KEY! } },
  agentSignatures: { mode: "log", keyServices: [{ url: "https://<visa key service>", kind: "visa-keys" }] },
  store: new SqliteStore("./data/pickup.db"),
  mailer: resendMailer({ apiKey: process.env.RESEND_KEY! }),
  signingKeyPem: process.env.PASS_SIGNING_KEY!,   // generateSigningKeyPem() from @agentpickup/core
  staffKey: process.env.STAFF_KEY,
  onEvent: (event, order) => { /* push to your POS: order.paid, order.ready, order.collected, order.expired */ },
});

app.route("/", pickup.app); // any Hono app; pickup.app.fetch works anywhere
```

### Storage

`SqliteStore` is a single file, fine for one server. For more than one server, or your database's own
backups, use `PostgresStore` with anything that has a pg-style `query(text, params)`: a `pg` Pool, Neon or
Supabase. Tables are created on first use, prefixed `pickup_` (set `prefix` to share a database between
shops). Hand-overs stay atomic across servers: one `UPDATE … WHERE status IN (…) RETURNING *`.

```ts
import pg from "pg";
import { PostgresStore } from "@agentpickup/server";

const store = new PostgresStore(new pg.Pool({ connectionString: process.env.DATABASE_URL }));
```

Your own store can implement the `Store` interface; its methods may return values or promises.

### Shops priced in other currencies

x402 settles in USDC. A shop with `currency: "aud"` passes `payments.x402.toUsdCents(amountCents, currency)`,
backed by whatever rate source it trusts. It runs once when an x402 order is created, and the USD price is
fixed on the order (`usdCents`), so the 402 quote, the payment check and any refund all agree. Without it,
`createCollect` refuses to turn x402 on rather than charge the wrong amount.

### x402 refunds

Set `payments.x402.refunds: { privateKey }` (a wallet holding USDC: `payTo` itself or a separate float) and
uncollected x402 orders are paid back to the wallet that paid them, through the facilitator, which pays the
gas. A failed refund is tried again on each sweep, and `collect.refundX402(orderId)` runs one by hand. The
EIP-3009 nonce is derived from the order id, so the USDC contract itself refuses a second refund of the same
order. The key sits in your server config: keep only what refunds need in that wallet.

Behind a TLS proxy (Railway, Fly, a load balancer) requests reach your server as `http://`. Rewrite
them to your public origin before `pickup.app.fetch` (see `withPublicOrigin` in `apps/demo/src/main.ts`)
so the URLs it reports, such as the resource in an x402 quote, match what clients called.

### Core routes

| Route | Who | What |
|---|---|---|
| `GET /api/catalog` | anyone | Menu, merchant and which payment methods are on |
| `POST /api/orders` | shopper or agent | `{ items: [{id, qty}], email, name?, rail }`. `Idempotency-Key` supported |
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
- **Agent payments** (x402, MPP, UCP, ACP) are charged at order time. Uncollected MPP, UCP and ACP card
  orders are refunded through Stripe; x402 orders are paid back from a refund wallet when one is set,
  and flagged `refundDue` otherwise. x402's `auth-capture` scheme
  (hold, then capture on scan) is the planned upgrade, but the public facilitator doesn't support it on
  Base Sepolia yet (checked 2026-11-03).
- **Hardening**: staff routes fail closed without a key, failed lookups are throttled per client,
  bodies are capped at 64 KB, and pass and staff pages are no-store, no-referrer and unframeable.
- **Webhooks**: set `webhook: { url, secret }` and every event is POSTed with a
  `Collect-Signature: t=<unix>,v1=<hmac-sha256(secret, "<t>.<body>")>` header.

## Layout

```
packages/core     @agentpickup/core    pass signing/verifying, ids, types (no dependencies)
packages/server   @agentpickup/server  Hono app: orders, payments, protocols, email, scanner, pages
packages/mcp      @agentpickup/mcp     MCP server (stdio and Streamable HTTP) for agents ordering from a shop
apps/demo         the product site: landing page, live demo shop, demo agent wallet, hosted /mcp, waitlist
```

The repo folder is still called `collect402`; the product and packages are agentPickup.
See [TODO.md](TODO.md) for what's built and what's next.

## Licence

- `packages/core` (`@agentpickup/core`, the pickup-pass format and verifier) is **Apache-2.0**, so anyone can
  issue and check passes.
- Everything else, including `@agentpickup/server`, the MCP server and the demo, is **FSL-1.1-ALv2**
  (Functional Source License): free to read, run and self-host for your own shop or platform, but not to
  offer a competing product. Each release turns into Apache-2.0 two years after it ships. See `LICENSE.md`.

## Not done yet

- Card payments have run against real Stripe in test mode (2026-11-03): Checkout with the 4242 test card,
  the thanks page confirming the session, the hold (`requires_capture`, nothing taken), the scan capturing
  it in full, a second scan refused, and a no-show releasing the hold (`canceled`, nothing ever taken).
  MPP and UCP/ACP Shared Payment Token charges have still only run against a stand-in.
- Email: the Resend mailer has delivered real pickup emails (the QR email and the "ready" email) through
  the Resend API (2026-11-03, Resend's test sender), and when Resend refuses a send the order carries on
  with the failure recorded.
- x402 is tested end to end with a fake facilitator, has settled a real order on Base mainnet, and its
  refund authorization passes PayAI's verification.
- Not built yet: Stripe Connect for platforms, Apple/Google Wallet passes, rotating QR codes,
  offline scanning, Shopify/Square adapters, UCP request signatures and cart/catalog endpoints, and the AP2
  payment mandate (the PSP's job).
- On npm: [`@agentpickup/core`](https://www.npmjs.com/package/@agentpickup/core),
  [`@agentpickup/server`](https://www.npmjs.com/package/@agentpickup/server) and
  [`@agentpickup/mcp`](https://www.npmjs.com/package/@agentpickup/mcp). `npm run build:packages` builds them.
