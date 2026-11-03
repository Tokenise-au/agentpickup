// The demo's own AI agent: a wallet that pays demo orders over x402 for real, so visitors can follow a
// settled payment on Basescan. On Base Sepolia it pays test USDC through x402.org, and the café wallet
// hands it back through the same facilitator when the agent runs low. On Base mainnet it pays real USDC
// through PayAI into the owner's wallet, and the owner tops it up; the café key is never used there.
// Neither wallet needs gas: the facilitator submits every transfer.
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { createPublicClient, erc20Abi, http, type Chain, type Hex, type LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";

export const TESTNET = "eip155:84532";
export const MAINNET = "eip155:8453";

interface DemoNetwork {
  chain: Chain;
  name: string;
  usdc: Hex;
  /** EIP-712 domain of the USDC contract, for EIP-3009 transfers. */
  usdcDomain: { name: string; version: string };
  /** How the page names the money: "test USDC" or "USDC". */
  money: string;
  explorer: string;
  facilitator: string;
  /** Defaults that keep a public button cheap to leave running. */
  maxOrderUsd: number;
  dailyLimit: number;
}

export const DEMO_NETWORKS: Record<string, DemoNetwork> = {
  [TESTNET]: {
    chain: baseSepolia,
    name: "Base Sepolia",
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    usdcDomain: { name: "USDC", version: "2" },
    money: "test USDC",
    explorer: "https://sepolia.basescan.org",
    facilitator: "https://x402.org/facilitator",
    maxOrderUsd: 20,
    dailyLimit: 60,
  },
  [MAINNET]: {
    chain: base,
    name: "Base",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    usdcDomain: { name: "USD Coin", version: "2" },
    money: "USDC",
    explorer: "https://basescan.org",
    facilitator: "https://facilitator.payai.network",
    maxOrderUsd: 10,
    dailyLimit: 20,
  },
};

const LOW = 15_000_000n; // the café tops the agent up below $15 (testnet only)

export interface DemoAgentConfig {
  agentKey: Hex;
  network: string;
  /** Testnet only: lets the café hand test USDC back to the agent when it runs low. Ignored on mainnet. */
  cafeKey?: Hex;
  baseUrl: string;
  /** The shop's own fetch, so the agent pays through the real x402 route without a network hop. */
  fetch: (req: Request) => Response | Promise<Response>;
  dailyLimit?: number;
  maxOrderUsd?: number;
  facilitatorUrl?: string;
  rpcUrl?: string;
}

export type AgentPayResult =
  | { ok: true; transaction: string; explorer: string; payer: string; amount: string; passUrl: string; emailedTo?: string }
  | { ok: false; status: 400 | 409 | 429 | 502 | 503; error: string };

const usd = (units: bigint) => (Number(units) / 1e6).toFixed(2);

function payer(account: LocalAccount, network: string, cap: string) {
  return new x402HTTPClient(
    x402Client.fromConfig({
      schemes: [{ network: network as `${string}:${string}`, client: new ExactEvmScheme(account) }],
      spendControls: { maxAmountPerPayment: cap },
    }),
  );
}

export function createDemoAgent(cfg: DemoAgentConfig) {
  const net = DEMO_NETWORKS[cfg.network];
  if (!net) throw new Error(`The demo agent doesn't run on ${cfg.network}.`);
  const agent = privateKeyToAccount(cfg.agentKey);
  const cafe = cfg.cafeKey && cfg.network === TESTNET ? privateKeyToAccount(cfg.cafeKey) : null;
  const chain = createPublicClient({ chain: net.chain, transport: http(cfg.rpcUrl) });
  const facilitator = new HTTPFacilitatorClient({ url: cfg.facilitatorUrl ?? net.facilitator });
  const maxOrderUsd = cfg.maxOrderUsd ?? net.maxOrderUsd;
  const maxOrder = BigInt(Math.round(maxOrderUsd * 1e6));
  const agentHttp = payer(agent, cfg.network, `$${maxOrderUsd}`);
  const cafeHttp = cafe ? payer(cafe, cfg.network, "$10000") : null;
  const dailyLimit = cfg.dailyLimit ?? net.dailyLimit;
  let day = "";
  let paidToday = 0;
  let refilling = false;
  // One payment at a time, so two clicks can't both pass the balance check.
  let queue: Promise<unknown> = Promise.resolve();

  const balanceOf = (address: Hex) =>
    chain.readContract({ address: net.usdc, abi: erc20Abi, functionName: "balanceOf", args: [address] });

  async function status() {
    const balance = await balanceOf(agent.address).catch(() => null);
    return {
      enabled: true,
      network: cfg.network,
      networkName: net.name,
      money: net.money,
      facilitator: new URL(cfg.facilitatorUrl ?? net.facilitator).host,
      address: agent.address,
      balance: balance === null ? null : usd(balance),
      explorer: `${net.explorer}/address/${agent.address}`,
      maxOrder: maxOrderUsd.toFixed(2),
      cafe: cafe?.address ?? null,
    };
  }

  async function payNow(orderId: string): Promise<AgentPayResult> {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== day) [day, paidToday] = [today, 0];
    if (paidToday >= dailyLimit) {
      return { ok: false, status: 429, error: "The demo agent has paid for enough coffee today. Try the instant test payment." };
    }
    const url = `${cfg.baseUrl}/api/orders/${encodeURIComponent(orderId)}/pay`;
    const challenge = await cfg.fetch(new Request(url, { method: "POST" }));
    if (challenge.status !== 402) {
      const body = (await challenge.json().catch(() => ({}))) as { error?: string };
      return { ok: false, status: 409, error: body.error ?? "This order isn't waiting for an x402 payment." };
    }
    const required = agentHttp.getPaymentRequiredResponse(
      (n) => challenge.headers.get(n),
      await challenge.json().catch(() => undefined),
    );
    const amount = BigInt(required.accepts[0]?.amount ?? 0);
    if (amount > maxOrder) return { ok: false, status: 400, error: `The demo agent pays up to $${maxOrderUsd.toFixed(2)} an order.` };
    if ((await balanceOf(agent.address)) < amount) {
      const topUp = cafe ? (await balanceOf(cafe.address)) >= amount : false;
      if (topUp) void refill();
      return {
        ok: false,
        status: 503,
        error: topUp
          ? `The demo agent is out of ${net.money}. It's being topped up; try again in a minute.`
          : `The demo agent's wallet is out of ${net.money} right now. Try again later.`,
      };
    }
    const payload = await agentHttp.createPaymentPayload(required);
    const paid = await cfg.fetch(new Request(url, { method: "POST", headers: agentHttp.encodePaymentSignatureHeader(payload) }));
    if (!paid.ok) {
      const body = (await paid.json().catch(() => ({}))) as { error?: string };
      return { ok: false, status: 502, error: body.error ?? `The payment didn't go through (${paid.status}).` };
    }
    paidToday++;
    const body = (await paid.json()) as { passUrl: string; emailedTo?: string };
    const settled = agentHttp.getPaymentSettleResponse((n) => paid.headers.get(n));
    void refill();
    return {
      ok: true,
      transaction: settled.transaction,
      explorer: `${net.explorer}/tx/${settled.transaction}`,
      payer: agent.address,
      amount: usd(amount),
      passUrl: body.passUrl,
      emailedTo: body.emailedTo,
    };
  }

  /** Testnet only: the café pays its whole test-USDC balance back to the agent once the agent drops below $15. */
  async function refill() {
    if (!cafe || !cafeHttp || refilling) return;
    refilling = true;
    try {
      const [mine, theirs] = await Promise.all([balanceOf(agent.address), balanceOf(cafe.address)]);
      if (mine >= LOW || theirs === 0n) return;
      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: cfg.network as `${string}:${string}`,
        asset: net.usdc,
        amount: theirs.toString(),
        payTo: agent.address,
        maxTimeoutSeconds: 300,
        extra: net.usdcDomain,
      };
      const payload = await cafeHttp.createPaymentPayload({
        x402Version: 2,
        resource: { url: `${cfg.baseUrl}/demo/refill`, description: "Demo Café returns test USDC to the demo agent" },
        accepts: [requirements],
      });
      const verified = await facilitator.verify(payload, requirements);
      if (!verified.isValid) throw new Error(verified.invalidReason ?? "rejected");
      const settled = await facilitator.settle(payload, requirements);
      console.log(`demo agent refilled with ${usd(theirs)} ${net.money}: ${net.explorer}/tx/${settled.transaction}`);
    } catch (err) {
      console.warn("demo agent refill failed:", err instanceof Error ? err.message : err);
    } finally {
      refilling = false;
    }
  }

  return {
    address: agent.address,
    cafeAddress: cafe?.address ?? null,
    status,
    refill,
    pay(orderId: string): Promise<AgentPayResult> {
      const run = queue.then(() => payNow(orderId));
      queue = run.catch(() => undefined);
      return run;
    },
  };
}
