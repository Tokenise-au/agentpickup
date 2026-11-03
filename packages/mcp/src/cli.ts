#!/usr/bin/env node
// stdio entry: `npx @agentpickup/mcp`. Logs go to stderr; stdout belongs to the protocol.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createPickupMcpServer } from "./server.js";
import { walletPayer } from "./wallet.js";

const env = process.env;
const shopUrl = env.AGENTPICKUP_SHOP_URL || "https://web-production-3cfc1.up.railway.app";
const key = env.AGENTPICKUP_WALLET_KEY?.trim();
if (key && !/^0x[0-9a-fA-F]{64}$/.test(key)) {
  console.error("AGENTPICKUP_WALLET_KEY must be a 0x-prefixed 32-byte hex private key.");
  process.exit(1);
}

const payer = key
  ? walletPayer({
      privateKey: key as `0x${string}`,
      maxPerOrder: env.AGENTPICKUP_MAX_PER_ORDER || undefined,
      networks: env.AGENTPICKUP_NETWORKS?.split(",").map((n) => n.trim()).filter(Boolean),
    })
  : undefined;

const server = createPickupMcpServer({ shopUrl, allowOtherShops: true, payer });
await server.connect(new StdioServerTransport());
console.error(`agentPickup MCP · shop ${shopUrl} · ${payer ? `wallet ${payer.address}` : "no wallet (pay_order returns the pay link)"}`);
