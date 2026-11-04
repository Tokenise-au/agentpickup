# Start here

agentPickup on one page, for anyone new to it. Written 2026-11-05. The details are in [README.md](README.md)
(how it works and how to run it), [ROADMAP.md](ROADMAP.md) (where it stands and what's next) and
[TODO.md](TODO.md) (the checklists).

## What it is

Click and collect for people and their AI agents. An agent (Claude, ChatGPT, Gemini, or a script with a
wallet) orders and pays at a real shop, and the person collects in person with a signed QR that staff scan at
the counter. Shops keep their own POS: on Square, agent orders land on the screens staff already use, and
marking an order ready in Square emails the customer their QR.

The agent-payment standards (x402, MPP, UCP, ACP) cover paying, not handing over. agentPickup adds the agent
front door (those standards, an MCP server and a public directory of shops) and proof of pickup.

It's run by Tokenise Pty Ltd at [agentpickup.app](https://agentpickup.app).

## How the money moves

We never hold or pass on anyone's money. Each payment goes straight from the buyer to the shop:

| How they pay | Where the money goes | When |
|---|---|---|
| USDC over x402, from an agent's own wallet on Base | The shop's own wallet, settled through PayAI's facilitator | When the order is placed; can be paid back if nobody collects |
| Card, Apple Pay or Google Pay | The shop's own Square account, at Square's usual fees | When the customer pays on the checkout page; refunded through Square if nobody collects |
| Test payment | Nowhere: no money moves | For trying it out. Test orders reach Square at $0, so they never count as sales |

On a server you run yourself, the library also takes Stripe cards (held until pickup) and Stripe's agent
payments (MPP, ACP for ChatGPT, UCP for Google). Hosted shops get Stripe with Stripe Connect (roadmap Phase 4),
which is also where our fee would come from: a fee per collected order, price not decided. The hosted service
is free during the pilot.

## What's live (5 November 2026)

- **agentpickup.app:** the site; sign-up for Square sellers at [/connect](https://agentpickup.app/connect) on
  Square's production app; the [seller page](https://agentpickup.app/seller); the
  [agent wallet guide](https://agentpickup.app/wallet); support, privacy and terms.
- **Venues:** the Demo Café (real USDC on Base, paid by our demo agent's wallet), the Square Sandbox Café
  (Square's sandbox, nothing real) and a test account. One real sign-in so far: Dave's own test shop, My
  Business, in test mode.
- **The MCP server**, hosted at `https://agentpickup.app/mcp` and on npm. It's in the official MCP Registry,
  and directories pick it up from there (mcprush, Glama, mcptry and more).
- **The shop directory** agents search: [/directory/v1/shops](https://agentpickup.app/directory/v1/shops).
- **x402 listings:** the Demo Café's fixed order address (`/api/x402/order`) is in PayAI's x402 discovery and on
  [x402scan](https://www.x402scan.com/server/540b44bb-c2ad-479c-bb5c-0001fc3dcbdc) (registered 5 Nov). x402-list has it in
  review. x402scan registers only what `/openapi.json` describes, so keep new paid routes in it.
- **On npm:** `@agentpickup/core` 0.3.0 (the pickup pass, Apache-2.0), `@agentpickup/server` 0.8.0 and
  `@agentpickup/mcp` 0.3.1 (FSL-1.1-ALv2: anyone can use them except to run a competing service, and each
  release becomes Apache-2.0 two years on).
- **Ops:** nightly encrypted backups, uptime checks every five minutes with email alerts, an admin view, and an
  8am Brisbane report email. See README, "Backups and alerts".

**Traction so far:** no outside shop, agent or customer has used it yet. On the first day of counting (4 Nov)
there were about 275 MCP sessions, almost all directory crawlers and probes, and every order was one of our own
tests. The product is ahead of demand, so getting it in front of people comes next.

## Where it runs, and who holds each login

No secrets on this page. The values live in Railway's variables, and the backup key is also in Dave's password
manager.

| What | Where | Login |
|---|---|---|
| The site, API, MCP server and every venue's database (SQLite files on a volume at `/data`) | Railway, service `web`. Every push to `main` deploys it | Dave |
| The code | GitHub, [`Tokenise-au/agentpickup`](https://github.com/Tokenise-au/agentpickup) (moved from `dav3trad3r` on 5 Nov; old links redirect) | Dave, and the Tokenise-au org |
| The domain, DNS, outgoing email (orders@, alerts@ and reports@agentpickup.app), page counts, and the ops Worker in `ops/` that keeps the backups and checks uptime | Cloudflare | Dave |
| "Sign in with Square" for sellers, and Square's webhooks | Square Developer Console: a production app and a sandbox app | Dave |
| USDC settlement | PayAI's public facilitator. No account yet; the free tier covers 1,000 payments | none |
| The npm packages | npm account `dbh88` | Dave |
| The MCP Registry entry `io.github.dav3trad3r/agentpickup` | Tied to Dave's GitHub login, so it kept its name when the repo moved. Keep it: directories copied it | Dave |
| The mcprush listing | Claimed 5 Nov through GitHub. Its analytics are off on purpose: they route agent traffic through mcprush | Dave |

The main Railway variables, by name: `ADMIN_KEY` (the admin pages); `VENUE_ADMIN_KEY` and `VENUE_SECRET` (the
venue host); `SQUARE_APP_ID`, `SQUARE_APP_SECRET`, `SQUARE_APP_WEBHOOK_KEY` and `SQUARE_ENVIRONMENT`;
`X402_PAY_TO`, `X402_NETWORK` and `X402_FACILITATOR_URL` (the Demo Café); `DEMO_AGENT_KEY` and its limits;
`CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_EMAIL_TOKEN`; `OPS_URL`, `OPS_KEY` and `BACKUP_KEY`; `REPORT_TO`.

**Private pages,** opened with the admin key (ask Dave): `/admin/ops` (health, backups, problems and every
venue's recent orders), `/admin/report` (the daily report) and `/admin/waitlist`.

**Not in the repo:** the outreach page, with who to contact, a ready message for each and progress, is on Dave's
claude.ai. Ask Dave to share it.

## Decisions, and why

- **We never hold customers' money.** It goes straight to the shop's wallet or Square. Holding other people's
  money would raise licensing questions (AUSTRAC), so the design never does.
- **Integrate, don't compete.** Shops keep their POS and payments; we only add the agent front door and proof of
  pickup. Square came first: sellers sign themselves in, it's common with cafés and small shops, and orders
  show on its own screens.
- **Square cards are charged at the order, not held.** Square's screens only show paid orders, so the card is
  charged when the customer pays and refunded through Square if nobody collects.
- **Cards came before any more marketing** (4 Nov). A shop has to take ordinary payments before we send anyone
  to it.
- **Test mode only adds test payments.** It never switches real ones off: with cards on, real card orders come
  in from the first one, and sign-up says so.
- **The pickup QR is emailed when the order is ready** (Square tells us), not on a timer.
- **Shops can be found without us in the loop.** Every shop publishes its own listing at
  `/.well-known/agentpickup.json`, and the directory also lists shops on other sites.
- **Outreach** messages are drafted by Claude and sent by Dave.

## What's next

1. **Get it in front of people (now):** the outreach list, starting with PayAI (on Discord), the x402
   Foundation (on GitHub) and Coinbase; a test order from a real Coinbase agent wallet; Apple Pay tried on an
   iPhone; then two or three Brisbane shops as reference sites.
2. **Phase 4:** Stripe Connect, so hosted shops take Stripe cards and agent card payments, and our fee.
3. **Phase 5:** get listed: the Square App Marketplace, and Doshii and Deliverect partner access.
4. **Phase 6:** ready for scale: Postgres, and staff accounts instead of one shared key per venue.
5. **Going global (to schedule):** shops without a POS, more currencies, Shopify POS, and terms for outside
   Australia.

## Run it

```bash
npm install
npm start    # http://localhost:8402, on test payments, with emails shown on the page
npm test
```

Node 22. Pushing to `main` deploys the live site, so run the tests first. The code layout is in README, "Layout".
