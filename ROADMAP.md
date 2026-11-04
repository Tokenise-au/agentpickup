# agentPickup roadmap

Written 2026-11-03. We work through the phases in order: each one ends with a "done when" check, and the next
starts once it passes. The checklists behind each phase are in [TODO.md](TODO.md).

**Production ready means:** a venue signs itself up and goes live without us; agents and people can pay (USDC,
cards, Stripe agent payments) with the money going straight to the venue; real venues have run it without help;
orders are backed up and we hear about failures before venues do; the legal pages are up; and we're listed
where sellers look.

**The product in one line:** venues keep their own POS and payments; agentPickup adds the agent front door
(x402, UCP, ACP, MPP, the MCP server and the directory) and proof of pickup (a signed QR, scanned at the counter).

## Where it stands

- Live at [agentpickup.app](https://agentpickup.app): the Demo Café takes real USDC on Base, and a Square sandbox
  venue shows the Square flow end to end (menu in, order on Square's screens, "ready" from Square, scan to
  collect). Square sellers sign themselves up at [agentpickup.app/connect](https://agentpickup.app/connect)
  with their real Square account (production app since 2026-11-04).
- On npm (2026-11-05): `@agentpickup/core` 0.3.0, `@agentpickup/server` 0.8.0 (sign-up, group orders, cards and
  Apple Pay through the shop's Square) and `@agentpickup/mcp` 0.3.0.
- In the official MCP Registry (0.3.0). Agents can find shops through the directory and `find_shops`.
- Usable today by developers who self-host the library, and by Square sellers through /connect. Not in the
  Square App Marketplace yet.

## Phase 0: ship what's built (done 2026-11-03)

On npm: server 0.6.1 and MCP 0.2.0; MCP Registry 0.2.0; privacy, terms and support pages live; support mail at
hello@agentpickup.app.

| What | Who | Size |
|---|---|---|
| Publish server 0.6.0 and MCP 0.2.0 to npm, then the MCP Registry entry | Dave | 15 min |
| Privacy policy, terms and support pages on agentpickup.app, hello@agentpickup.app forwarding, security.txt | Claude | done 2026-11-03 |
| Shortlist 3 Brisbane cafés on Square as design partners | Dave | ongoing |

**Done when** the packages on npm match the live site and the legal pages are up.

## Phase 1: sellers connect their own Square (done 2026-11-03, on the Square sandbox)

Checked live: a sandbox café signed up at /connect, an agent found it through `find_shops`, ordered from its
Square menu, the order arrived in Square as a paid pickup order, and marking it ready in Square sent the QR email
about a second later. The payment was test mode: the demo wallets had no test USDC (USDC itself is proven on the
Demo Café). Before real cafés: a production Square app (redirect URL and keys, `SQUARE_ENVIRONMENT=production`).

| What | Who | Size |
|---|---|---|
| Connect wizard at `/connect` behind the "Integrate it" buttons: pick your system, Sign in with Square, choose the location, USDC wallet or test mode, done | Claude | 4-6 h |
| Square sign-in done properly: sealed tokens, refreshed before they expire, revoked on disconnect | Claude | in the above |
| One Square webhook for every venue, so "ready" works with no setup | Claude | in the above |
| Seller page through Sign in with Square: colour, wallet, listed, pause, disconnect | Claude | in the above |
| Square Developer Console: redirect URL and app secret (sandbox, then a production app) | Dave | 15 min each |

USDC only in this phase. Other systems (Lightspeed, Toast, Clover, Shopify POS, Doshii, Deliverect) appear as
"request it" and feed the partner list.

**Done when** a café connects itself in under five minutes, takes an agent's USDC order, and marks it ready in
Square.

## Phase 2: safe to run real orders (done 2026-11-04)

| What | Who | Size |
|---|---|---|
| Nightly backups of the venue databases, with a restore tested once (built 2026-11-04: encrypted, to the ops Worker, 35 days; `scripts/restore-backup.ts`) | Claude | 2 h |
| Uptime check on the site, the directory and `/mcp`, plus alerts on failed emails, Square calls and refunds, to you (built 2026-11-04: the ops Worker, every 5 minutes, by email) | Claude | 2 h |
| An admin view of every venue's recent orders and failures (built 2026-11-04: `/admin/ops`) | Claude | in the above |
| Put `OPS_URL`, `OPS_KEY` and `BACKUP_KEY` in Railway, and keep `BACKUP_KEY` in your password manager (done 2026-11-04) | Dave | 5 min |
| Usage counters and the 8am Brisbane report email: agents, orders, sellers, site, money, problems (done 2026-11-04) | Claude | done |

**Done when** a restore from last night's backup works and a forced failure reaches you within minutes. Both
proven 2026-11-04: the first backup (7 files) restored with every check passing, and the test alert was emailed
at the Worker's next five-minute check.

## Phase 3: first real venues (weeks 2-3)

| What | Who |
|---|---|
| Onboard 1-3 cafés through the wizard | Dave, with Claude on call |
| Real agent orders: Claude through the MCP server, the demo agent, and x402 developers | Both |
| Watch every order: receipt, Square, ready, QR, scan. Fix what staff trip on | Claude |
| Ask each café what would make them keep it | Dave |

**Done when** 3 venues have handed over 20 real orders between them and staff don't need help.

## Phase 4: cards and Stripe agent payments (weeks 3-4)

Cards through the shop's own Square were built first (2026-11-04), before any more marketing: every shop that
signs up is on Square, so they take cards with nothing new to set up. Stripe Connect below adds the agent-native
card checkouts (ChatGPT, Google, Stripe's MPP).

| What | Who | Size |
|---|---|---|
| Cards and Google Pay through the shop's Square: a checkout page, charged on the Square order, refunded if not collected (built 2026-11-04) | Claude | done |
| Apple Pay on the Square checkout (built 2026-11-04; a payment from an iPhone still to try) | Claude | done |
| Confirm Stripe Shared Payment Tokens charge on a connected seller's account | Claude | 1 h, before building |
| Connect with Stripe in the wizard: card checkout held until pickup, and MPP, ACP (ChatGPT) and UCP (Google) agent payments, all on the seller's own Stripe | Claude | 4-6 h |
| Our fee: an application fee per collected order, taken by Stripe at payment | Dave decides the price | |
| Turn on Stripe Connect (test mode first), accept the terms, ask Stripe for MPP access | Dave | |

**Done when** a pilot café takes a card order and an agent card payment, and our fee lands in our Stripe.

## Phase 5: get listed (from week 4, mostly waiting on others)

- Apply to the Square App Marketplace (check Square's current requirements and review time first). It needs
  Phases 0 and 1; a review that takes weeks doesn't hold up Phase 6.
- Doshii and Deliverect partner access through the outreach list; build each connector once access arrives.
- Propose the pickup pass to the x402 Foundation as an extension; publish the spec.
- A short video: an agent orders a coffee, the customer collects it with the QR.

**Done when** the Square listing is submitted and at least one partner (Doshii or Deliverect) has given access.

## Phase 6: ready for scale (before ~50 venues, or when a platform signs)

| What | Size |
|---|---|
| Move the hosted venues onto Postgres; make venue changes reach every server; run the timed jobs on one | 1-2 days |
| Staff accounts instead of one shared staff key per venue | half a day |
| Raise the email quota (200 a day now); open a PayAI account (the free tier covers 1,000 payments) | Dave |

**Done when** a second server runs alongside the first with no double emails, sweeps or refunds. That's
production ready.

## Going global (noted 2026-11-05, to schedule)

Nothing in the code ties agentPickup to Australia: any currency and time zone works, and the money goes straight
from the agent to the shop's wallet, so we don't need a licence in each country. What keeps us to Square's 8
countries (US, Canada, UK, Ireland, France, Spain, Australia, Japan) is that sign-up and cards both run through
Square, and that the currency converter knows the ECB's ~30 currencies.

| What | Who | Size |
|---|---|---|
| Shops without a POS: the menu typed in at sign-up, orders on the staff page, Ready tapped there. Works in any country | Claude | about a day |
| A wider currency source beside the ECB's, so a shop pricing in any currency (dirhams, dong, naira...) can take USDC. Only matters once shops can join without Square | Claude | 1 h, with the above |
| Shopify POS connector: Shopify sells in far more countries than Square | Claude | 1-2 days |
| A Shopify Partner app for the connector | Dave | 15 min |
| Terms and privacy for shops and customers outside Australia (GDPR for the EU), reviewed by a lawyer | Dave | |
| Cards outside Square's countries: Stripe Connect (Phase 4) covers far more countries | Claude | in Phase 4 |

**Done when** a shop outside Square's countries signs itself up and takes an agent's USDC order.

## Parked

- The customer order page: venues already have their own.
- Apple and Google Wallet passes, rotating QR codes, offline scanning, custom domains per venue.
- x402 hold-then-capture (`auth-capture`), once a facilitator supports it.
