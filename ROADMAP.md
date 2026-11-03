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
  collect).
- On npm: `@agentpickup/core` 0.2.0 and `@agentpickup/server` 0.4.0. Server 0.6.0 and MCP 0.2.0 are built and
  waiting to be published.
- In the official MCP Registry (0.1.1). Agents can find shops through the directory and `find_shops`.
- Usable today by developers who self-host the library. Sellers can't sign up by themselves, and it isn't in the
  Square App Marketplace.

## Phase 0: ship what's built (this week)

| What | Who | Size |
|---|---|---|
| Publish server 0.6.0 and MCP 0.2.0 to npm, then the MCP Registry entry | Dave | 15 min |
| Privacy policy, terms and support pages on agentpickup.app | Claude | 2 h |
| Shortlist 3 Brisbane cafés on Square as design partners | Dave | ongoing |

**Done when** the packages on npm match the live site and the legal pages are up.

## Phase 1: sellers connect their own Square (next)

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

## Phase 2: safe to run real orders (half a day)

| What | Who | Size |
|---|---|---|
| Nightly backups of the venue databases, with a restore tested once | Claude | 2 h |
| Uptime check on the site, the directory and `/mcp`, plus alerts on failed emails, Square calls and refunds, to you | Claude | 2 h |
| An admin view of every venue's recent orders and failures (the admin API has the data) | Claude | in the above |

**Done when** a restore from last night's backup works and a forced failure reaches you within minutes.

## Phase 3: first real venues (weeks 2-3)

| What | Who |
|---|---|
| Onboard 1-3 cafés through the wizard | Dave, with Claude on call |
| Real agent orders: Claude through the MCP server, the demo agent, and x402 developers | Both |
| Watch every order: receipt, Square, ready, QR, scan. Fix what staff trip on | Claude |
| Ask each café what would make them keep it | Dave |

**Done when** 3 venues have handed over 20 real orders between them and staff don't need help.

## Phase 4: cards and Stripe agent payments (weeks 3-4)

| What | Who | Size |
|---|---|---|
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

## Parked

- Square payments for people's cards: agent card payments run on Stripe today.
- The customer order page: venues already have their own.
- Apple and Google Wallet passes, rotating QR codes, offline scanning, custom domains per venue.
- x402 hold-then-capture (`auth-capture`), once a facilitator supports it.
