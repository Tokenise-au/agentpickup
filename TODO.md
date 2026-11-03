# agentPickup to-do

Ticked items are built, tested, and passed the full regression suite (`npm test` + `npm run typecheck`).

## Agent-payment standards

- [x] **Offline x402 test harness**: a fake facilitator plus a real signing client, so every x402 path is covered by tests without a network
- [x] **x402 extensions**
  - [x] bazaar: discovery metadata on the pay route, plus `/openapi.json` in the shape x402scan indexes (paid and sign-in routes)
  - [x] offer-and-receipt: signed offers in the 402, signed receipts on settlement (JWS, the merchant's Ed25519 key, did:web at `/.well-known/did.json`)
  - [x] payment-identifier: a retry with the same id gets the original result and never settles twice
  - [x] sign-in-with-x: the paying wallet re-fetches its pass at `GET /api/orders/:id/pass` (single-use nonces bound to the order)
- [x] **MPP (Machine Payments Protocol)**: a 402 challenge for agents paying by card or Link through Stripe Shared Payment Tokens (`mppx` 0.17), settling into the merchant's own Stripe. Credentials are bound to one order, retries are idempotent, no-shows are refunded, and there's an MPP offer in `/openapi.json`. Charged at order time: mppx confirms immediately, with no manual capture. Live use needs Stripe MPP access.
- [x] **UCP** (2026-08-25): the `/.well-known/ucp` profile; REST checkout at `/ucp/v1` (create, get, update, complete, cancel) with the `pickup` method and a `business_location` destination; `com.stripe.payments` SPT handler plus a test handler; the order's `permalink_url` is the pickup pass, and fulfilment events cover ready and delivered. UCP-Agent and Idempotency-Key are enforced, and sessions and orders are scoped to the platform that made them. Not done: RFC 9421 request signatures, the cart and catalog endpoints, order webhooks.
- [x] **ACP** (2026-04-17): `/.well-known/acp.json`; `/acp/checkout_sessions` (create, update, get, complete, cancel) with the `pickup` fulfilment option; SPT delegated payment (`card_tokenized`) plus a test handler; the order permalink is the pickup pass; signed order webhooks (`Merchant-Signature`, HMAC over timestamp and body: ACP leaves the format open). Bearer keys, API-Version and idempotency with conflict detection are enforced.
- [x] **AP2 mandates** (v0.2, through UCP's `dev.ucp.common.payment.ap2_mandate`): the business ES256 key in `/.well-known/ucp` `keys`. When the platform's profile supports AP2, every checkout carries `ap2.merchant_authorization` (a detached JWS over the JCS checkout) and completion needs an SD-JWT+KB checkout mandate. Verified: the platform's signature (key from its profile), key binding (`sd_hash`, `aud`, freshness), expiry, disclosure digests, `checkout_hash`, and that `checkout_jwt` is our own signature over the current id, totals and line items. The mandate is stored as evidence. Not done: the payment mandate, which is the PSP's job, and the user-credential flow.
- [x] **Visa Trusted Agent Protocol / Mastercard Agent Pay / Web Bot Auth**: RFC 9421 verification on agent payment routes (x402 and MPP pay links, UCP, ACP) in `log` or `require` mode. It accepts the TAP tags `agent-browser-auth` and `agent-payer-auth` plus `web-bot-auth`, and requires `@authority` (plus `@path` for TAP), a created/expires window of at most 8 minutes, and single-use nonces. Keys can be pinned, come from a Visa-style `/keys?keyID=` service or a JWKS, or from a trusted agent's `/.well-known/http-message-signatures-directory` (JWK thumbprint keyids). Ed25519, ECDSA and RSA-PSS are supported. Visa's sample merchant code uses a non-standard signature base; this follows RFC 9421 as the spec text says. Not done: the Agentic Consumer Recognition Object.

## Hardening (alongside each item)

- [x] Limit failed pickup-code and pass lookups per IP, so codes can't be guessed (12 per 10 minutes, then 429)
- [x] Open staff routes need an explicit `allowOpenStaff: true`, so a forgotten staff key fails closed
- [x] Request body size limits on every JSON endpoint (64 KB)
- [x] Idempotency keys on order creation (`Idempotency-Key`, the stored response is replayed)
- [x] Security headers on shopper and staff pages (no-store, no-referrer, frame-ancestors none, CSP)
- [x] Regression run after every item: unit tests, typecheck, and the demo flow (77 tests; UCP, ACP, x402, the demo order and the staff page checked on the running server; desktop and phone layout)

## Exposure (2026-11-03)

- [x] Licence: `@agentpickup/core` Apache-2.0, everything else FSL-1.1-ALv2; repo public with topics
- [x] npm packaging: `dist` builds with types, a `source` export condition for this repo, package READMEs, `npm pack` checked
- [x] npm publish of `@agentpickup/core`, `/server`, `/mcp` 0.1.0 (org `agentpickup`, owner dbh88)
- [x] Demo agent wallet on Base Sepolia: real x402 payments through the x402.org facilitator, Basescan link, daily cap, café hands test USDC back through the facilitator when the agent runs low
- [ ] Fund the demo agent with test USDC (Dave: faucet.circle.com, Base Sepolia, `0xd253e213cE143Aa0E1e1cAfc92f7AE82c98aB3bB`)
- [x] MCP server `@agentpickup/mcp`: five tools, wallet with spend cap and testnet default, stdio CLI, Streamable HTTP handler, hosted at `/mcp` on the demo
- [x] MCP Registry listing `io.github.dav3trad3r/agentpickup` 0.1.0 (npm package + hosted `/mcp`). Re-publish with `npx tsx scripts/publish-mcp-registry.ts --go` after bumping `packages/mcp/server.json`

## Connectors (2026-11-03)

- [x] Connector contract (`PickupConnector`: menu in, order events out, callback routes) and a live menu kept in the store
- [x] Connector API at `/connect/v1` for any platform (menu push and revert, open orders, mark ready), Bearer keys
- [x] Square POS connector: menu sync, paid pickup orders with the payment recorded as external, ready/collected/no-show both ways, refunds recorded, orders closed. Run against a real Square sandbox; `scripts/square-sandbox-check.ts`
- [x] Square "ready" webhook against real Square: subscription registered through Square's API for the live Square Sandbox Café venue; staff marking ready in Square emailed the customer ~4 s later (2026-11-03)
- [x] Multi-venue: `createVenueHost`, venues at `/v/<slug>`, admin API `/host/v1`, secrets sealed with AES-256-GCM, a shop can live under any path
- [ ] Venue admin dashboard (the admin API exists), custom domains per venue, Stripe Connect payouts per venue

## Email (2026-11-03)

- [x] Cloudflare Email Sending: agentpickup.app onboarded (DKIM, bounce MX/SPF, DMARC p=reject), `cloudflareMailer`, live on the demo from orders@agentpickup.app
- [x] Plain-text part, reply-to the shop, provider message id on `pass.emailed`, `cappedMailer` (demo: 3 per address, 100 a day), venues send from the platform domain under their own name
- [x] Receipt first (items, how it was paid with the USDC transaction link, order number, tax id); `qrEmail: "when-ready"` sends the QR when the order is marked ready (no timed fallback, by choice: hospitality orders aren't ready on a timer); default for venues with the Square webhook, and the Demo Café

## Integrate, don't compete (2026-11-03)

- [x] Square location as the venue's profile: logo, address, hours, contact details, time zone, map position; the shop's own settings win; hourly refresh, last copy kept
- [x] Agent directory `/directory/v1/shops` on the venue host: search by item, place, distance and open now; `listed`, `alsoList`
- [x] MCP `find_shops`, ordering from any venue on the same host, test shops order with no money moving (MCP 0.2.0)
- [x] Open listings (2026-11-04): every shop serves `/.well-known/agentpickup.json` (`listing/1`); other sites register at `POST /directory/v1/listings` (same-site URLs, https on a domain, size and timeout limits, agentPickup shops checked against their live menu), rechecked every 6 h and dropped after a day down; `source` and `order.via` in results; the hosted MCP orders from listed agentPickup shops only (`trustedShop`); form on /connect; new listings in the 8am report
- [ ] Get agentPickup shops into the x402 catalogues (Coinbase Bazaar, PayAI): needs a fixed paid "order and pay" endpoint, since pay links are per order
- [x] Group orders (2026-11-04): each person's agent pays its own share to the shop; at closing the paid shares become one combined order (each line "for <name>"), sent to Square once, QR to the organiser; ready, collected and expiry follow to every share. MCP `start_group_order` / `join_group_order` / `group_order_status` / `close_group_order`. Checked live on the Square sandbox: one order, lines "for Sam" and "for Alex"
- [ ] Doshii and Deliverect connectors (need partner API access)
- [ ] Square payments for people's cards (stays on hold: agent card payments run on Stripe today)

## Next: sellers sign themselves up (planned 2026-11-03, not started)

**Where it stands.** A seller can't sign up by themselves yet. Venues are created by us through the admin API,
with a Square access token pasted in and the Square webhook registered by hand. agentPickup is not in the
Square App Marketplace, and the only Square connection is the sandbox venue. Today people find it through
agentpickup.app, npm, the MCP Registry (agents) and the directory; developers can self-host the library and
connect Square with their own token.

**Connect wizard at agentpickup.app/connect** (both "Integrate it" buttons open it instead of the partner form):

1. Pick your system. Square works; Lightspeed, Toast, Clover, Shopify POS, Doshii and Deliverect are
   "request it" options that save to the partner list (each needs its own partner access).
2. Sign in with Square (OAuth): the seller approves access to menu, orders and business profile; no password
   reaches us.
3. Choose the location. The venue is created from it; menu, logo, address and hours come from Square.
4. Payments (below).
5. Done: shop link, staff page, how it shows in the directory. Staff keep marking orders ready in Square.

Sellers come back with Sign in with Square to a small page: colour, wallet, listed, pause, disconnect.

- [x] Square OAuth: state check, tokens sealed like other venue secrets, renewed once a week old (one renewal per seller), revoked when the last venue disconnects; `oauth.authorization.revoked` handled
- [x] One app-level Square webhook for every venue, routed by location, so new venues get "ready" with no setup
- [x] Wizard pages and the seller page; "Integrate it" buttons point at it (partner form until sign-up is switched on)
- [x] `fxToUsdCents`: ECB rates through Frankfurter, so AUD venues can take USDC
- [x] Dave: sandbox redirect URL and app keys (2026-11-03); app-level webhook `wbhk_d429…` registered at /connect/square/webhook
- [x] Checked live on the sandbox: sign-up, agent order through the MCP, order in Square, ready in Square, QR email in ~1 s
- [ ] Production Square app: redirect URL, keys, `SQUARE_ENVIRONMENT=production`, its own webhook subscription (before Phase 3)
- [ ] Repeat the agent's USDC payment on a wizard venue once a wallet has Base Sepolia test USDC
- Size: about 4-6 hours, built and tested on the Square sandbox first

**Payments step.** Money always goes straight to the seller, never through us.

| Payment | Who pays this way | Seller needs | Per venue today |
|---|---|---|---|
| USDC over x402 | Agents with their own wallet | A wallet address | Yes |
| Card (Stripe Checkout, held until pickup) | People | Their own Stripe | Only by pasting a secret key into the API |
| Stripe agent payments (MPP, ACP for ChatGPT, UCP for Google) | Agents paying with the user's card or Link | Their own Stripe | No: built for single shops only |
| Test mode | Trying it | Nothing | Yes, on by default |

- [ ] Decide: include Connect with Stripe in the wizard, or ship USDC-only first
- [ ] Stripe Connect: "Connect with Stripe" in the wizard, charges on the seller's own account, an application fee per collected order (how we earn), per-venue card and agent payments. About 4-6 hours more
- [ ] Dave: turn on Stripe Connect (test mode first) and accept the Connect terms; ask Stripe for MPP access
- [ ] Before building: confirm in Stripe's docs that Shared Payment Tokens charge on a connected account (SPT charges have only run against a stand-in so far)

**Scaling the hosted install** (agentpickup.app as it runs today):

- One Railway instance with SQLite files on a volume (a venue list plus one file per venue). Each venue runs in
  that process with its own timers. Fine for a handful to low hundreds of venues; it can't run a second
  instance, because a venue added on one wouldn't start on the other.
- [ ] Move the venue host and venue stores to Postgres (`PostgresStore` exists), make venue changes reach
      every instance, and run the timed jobs (no-show sweep, Square resync) on one instance only
- [x] Usage counted in site.db (MCP sessions by app and tool calls, directory, menus, pages, sign-up steps, orders, real USDC, emails, errors) and a daily report emailed to REPORT_TO at 8am Brisbane; preview at /admin/report (2026-11-04)
- [ ] Monitoring and alerts, database backups, staff accounts instead of one shared staff key per venue
- [ ] Email quota: Cloudflare is at 200 a day for now, and the demo caps itself at 100
- [ ] x402 facilitator: PayAI's keyless tier covers 1,000 settlements, then needs an account

**Getting into the Square App Marketplace** (after the wizard):

- [ ] A production Square app with OAuth (the wizard)
- [ ] Privacy policy, terms and support pages on agentpickup.app
- [ ] Apply for a listing; Square reviews apps before they're listed (check the current requirements and timing first)

## Roadmap

The phases, sizes and order are in [ROADMAP.md](ROADMAP.md) (2026-11-03). It replaces the earlier phases 0-5,
whose finished parts are ticked above: the domain, Stripe in test mode, real email, x402 on Base mainnet,
no-show refunds for agent payments, AUD shops and the Postgres store.
