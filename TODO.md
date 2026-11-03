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
- [x] Regression run after every item: unit tests, typecheck, and the demo flow (70 tests; UCP, ACP, x402, the demo order and the staff page checked on the running server; desktop and phone layout)

## Roadmap to production

- [ ] Phase 0: public repo, npm build and publish, real x402 wallet, domain (Dave), privacy page
- [ ] Phase 1: Stripe test then live, x402 on Base mainnet, real email, no-show refunds for agent payments, AUD
- [ ] Phase 2: Postgres store, staff accounts, signing-key rotation, monitoring, backups, docs site
- [ ] Phase 3: publish the pickup-pass spec and get facilitator review
- [ ] Phase 4: hosted multi-tenant for platforms (Stripe Connect, dashboard, billing, legal)
- [ ] Phase 5: pilot with a payments partner and a platform, then launch
