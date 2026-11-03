# @agentpickup/mcp

An MCP server for [agentPickup](https://github.com/dav3trad3r/agentpickup) shops. It lets an AI agent see
what a shop sells, order it, pay in USDC over x402, and hand its user the QR they show at the counter to
collect.

## Tools

| Tool | What it does |
|---|---|
| `get_shop` | Items and prices, the pickup location, and how the shop takes payment |
| `create_pickup_order` | Creates an order. Needs the user's email, where the shop sends the pickup QR |
| `pay_order` | Pays the order's x402 link from your wallet and returns the pass link. With no wallet set up, returns the price and pay link instead |
| `order_status` | Waiting for payment, paid, ready, collected or expired |
| `get_pickup_pass` | Fetches the pass link, pickup code and QR again by signing in as the paying wallet (Sign-In-With-X) |

## Use it

Try it against the hosted demo shop first. It pays with the demo's own small wallet, within the demo's caps:

```json
{ "mcpServers": { "agentpickup": { "type": "http", "url": "https://web-production-3cfc1.up.railway.app/mcp" } } }
```

Or run it locally against any agentPickup shop, with your own wallet:

```json
{
  "mcpServers": {
    "agentpickup": {
      "command": "npx",
      "args": ["-y", "@agentpickup/mcp"],
      "env": {
        "AGENTPICKUP_SHOP_URL": "https://orders.yourshop.com",
        "AGENTPICKUP_WALLET_KEY": "0x…",
        "AGENTPICKUP_MAX_PER_ORDER": "$25"
      }
    }
  }
}
```

| Setting | Default | |
|---|---|---|
| `AGENTPICKUP_SHOP_URL` | the demo shop | The shop to order from. Tool calls can also name another shop with `shop_url` |
| `AGENTPICKUP_WALLET_KEY` | none | An EVM private key holding USDC. Without it, `pay_order` only quotes |
| `AGENTPICKUP_MAX_PER_ORDER` | `$25` | The most the wallet pays for one order |
| `AGENTPICKUP_NETWORKS` | `eip155:84532` | Networks the wallet may pay on. Base Sepolia (test USDC) unless you add `eip155:8453` for Base mainnet |

Use a wallet that holds only what you're willing to let an agent spend. The tools tell the model to confirm
items and the total with the user before paying.

## Host it in your own server

```ts
import { createMcpHandler, walletPayer } from "@agentpickup/mcp";

const mcp = createMcpHandler({ shopUrl: "https://orders.yourshop.com" }); // no wallet: pay_order quotes
app.all("/mcp", (c) => mcp(c.req.raw)); // Streamable HTTP, stateless, any Request/Response runtime
```

Node 22.13 or later. Licence: FSL-1.1-ALv2 (free to use and self-host; becomes Apache-2.0 two years after
each release).
