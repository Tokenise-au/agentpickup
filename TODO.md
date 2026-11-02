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
- [ ] **UCP**: `/.well-known/ucp` profile, checkout sessions with the `pickup` fulfilment method, and the pickup pass on the completed order
- [ ] **ACP**: checkout session endpoints, delegated payment via Stripe Shared Payment Tokens, and the pickup pass on the order
- [ ] **AP2 mandates**: accept a signed intent or cart mandate with an order, check it against the order, and keep it as dispute evidence
- [ ] **Visa Trusted Agent Protocol / Mastercard Agent Pay**: verify Web Bot Auth (RFC 9421) signatures on order requests, with an off/log/require policy

## Hardening (alongside each item)

- [x] Limit failed pickup-code and pass lookups per IP, so codes can't be guessed (12 per 10 minutes, then 429)
- [x] Open staff routes need an explicit `allowOpenStaff: true`, so a forgotten staff key fails closed
- [x] Request body size limits on every JSON endpoint (64 KB)
- [x] Idempotency keys on order creation (`Idempotency-Key`, the stored response is replayed)
- [x] Security headers on shopper and staff pages (no-store, no-referrer, frame-ancestors none, CSP)
- [ ] Regression run after every item: unit tests, typecheck, and the demo flow

## Roadmap to production

- [ ] Phase 0: public repo, npm build and publish, real x402 wallet, domain (Dave), privacy page
- [ ] Phase 1: Stripe test then live, x402 on Base mainnet, real email, no-show refunds for agent payments, AUD
- [ ] Phase 2: Postgres store, staff accounts, signing-key rotation, monitoring, backups, docs site
- [ ] Phase 3: publish the pickup-pass spec and get facilitator review
- [ ] Phase 4: hosted multi-tenant for platforms (Stripe Connect, dashboard, billing, legal)
- [ ] Phase 5: pilot with a payments partner and a platform, then launch
