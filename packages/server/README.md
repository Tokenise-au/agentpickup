# @agentpickup/server

The pickup layer for agent payments. A person or an AI agent buys online and pays by card (Stripe),
USDC (x402), or a Stripe Shared Payment Token through MPP, UCP (with AP2 mandates) or ACP. The shop
emails a signed QR, staff scan it at the counter, and the order is handed over. A card hold is
captured at that moment; no-shows are released or refunded.

Shoppers and staff only ever see the shop's name, colours and email address.

```ts
import { createCollect, SqliteStore, resendMailer } from "@agentpickup/server";
import { generateSigningKeyPem } from "@agentpickup/core";

const pickup = createCollect({
  baseUrl: "https://orders.yourshop.com",
  merchant: { name: "Corner Café", brandColor: "#9a3412", fromEmail: "Corner Café <orders@yourshop.com>" },
  catalog: [{ id: "flat-white", name: "Flat white", priceCents: 450 }],
  payments: {
    card: { secretKey: process.env.STRIPE_KEY!, captureMode: "hold" },
    x402: { payTo: process.env.WALLET!, network: "eip155:8453" },
  },
  store: new SqliteStore("./data/pickup.db"),
  mailer: resendMailer({ apiKey: process.env.RESEND_KEY! }),
  signingKeyPem: process.env.PASS_SIGNING_KEY!, // generateSigningKeyPem()
  staffKey: process.env.STAFF_KEY,
});

// pickup.app is a Hono app: mount it, or call pickup.app.fetch from any runtime with Request/Response.
```

`createVenueHost` runs many venues on one install, each at `/v/<slug>` with its own menu, payments, staff key
and Square connector, managed through an admin API with secrets sealed at rest. It also publishes a public
directory at `/directory/v1/shops`, where agents find shops near someone that sell what they want.

Connectors put orders on the screens staff already use: `squareConnector` for Square POS (menu and the
venue's logo, address, hours and map position in; paid pickup orders out; ready and collected both ways), and
a connector API at `/connect/v1` any other platform can integrate against.

The first email is a receipt. With `qrEmail: "when-ready"` the pickup QR follows when the order is marked
ready; by default it's in the receipt. Email goes through `cloudflareMailer`
(Cloudflare Email Sending) or `resendMailer`, with a plain-text part, reply-to the shop, and `cappedMailer`
for public demos.

Storage is `SqliteStore` (one file) or `PostgresStore` (any pg-style client: `pg`, Neon, Supabase), or
your own `Store`. Shops priced in other currencies take x402 through `payments.x402.toUsdCents`, and
`payments.x402.refunds` pays USDC no-shows back through the facilitator.

Node 22.13 or later (uses `node:sqlite`). Full configuration, routes and protocol notes:
[github.com/dav3trad3r/agentpickup](https://github.com/dav3trad3r/agentpickup).

Licence: FSL-1.1-ALv2. Free to use, run and self-host for your own shop or platform; not for offering a
competing product. Each release becomes Apache-2.0 two years after it ships.
