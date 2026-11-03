// The demo's own AI agent: a Base Sepolia wallet that pays demo orders over x402 for real, through the
// public x402.org facilitator, so visitors can follow a settled payment on Basescan. Test USDC only.
// When it runs low, the café wallet pays it back through the same facilitator, so faucet funds circulate
// and neither wallet ever needs gas.
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { createPublicClient, erc20Abi, http, type Hex, type LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

export const DEMO_NETWORK = "eip155:84532";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const EXPLORER = "https://sepolia.basescan.org";
const MAX_ORDER = 20_000_000n; // $20 in USDC base units
const LOW = 15_000_000n; // top the agent up from the café below $15

export interface DemoAgentConfig {
  agentKey: Hex;
  /** Lets the café hand test USDC back to the agent when it runs low. */
  cafeKey?: Hex;
  baseUrl: string;
  /** The shop's own fetch, so the agent pays through the real x402 route without a network hop. */
  fetch: (req: Request) => Response | Promise<Response>;
  dailyLimit?: number;
  facilitatorUrl?: string;
  rpcUrl?: string;
}

export type AgentPayResult =
  | { ok: true; transaction: string; explorer: string; payer: string; amount: string; passUrl: string; emailedTo?: string }
  | { ok: false; status: 400 | 409 | 429 | 502 | 503; error: string };

const usd = (units: bigint) => (Number(units) / 1e6).toFixed(2);

function payer(account: LocalAccount, cap: string) {
  return new x402HTTPClient(
    x402Client.fromConfig({
      schemes: [{ network: DEMO_NETWORK, client: new ExactEvmScheme(account) }],
      spendControls: { maxAmountPerPayment: cap },
    }),
  );
}

export function createDemoAgent(cfg: DemoAgentConfig) {
  const agent = privateKeyToAccount(cfg.agentKey);
  const cafe = cfg.cafeKey ? privateKeyToAccount(cfg.cafeKey) : null;
  const chain = createPublicClient({ chain: baseSepolia, transport: http(cfg.rpcUrl) });
  const facilitator = new HTTPFacilitatorClient({ url: cfg.facilitatorUrl ?? "https://x402.org/facilitator" });
  const agentHttp = payer(agent, "$20");
  const cafeHttp = cafe ? payer(cafe, "$10000") : null;
  const dailyLimit = cfg.dailyLimit ?? 60;
  let day = "";
  let paidToday = 0;
  let refilling = false;
  // One payment at a time, so two clicks can't both pass the balance check.
  let queue: Promise<unknown> = Promise.resolve();

  const balanceOf = (address: Hex) =>
    chain.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [address] });

  async function status() {
    const balance = await balanceOf(agent.address).catch(() => null);
    return {
      enabled: true,
      network: DEMO_NETWORK,
      address: agent.address,
      balance: balance === null ? null : usd(balance),
      explorer: `${EXPLORER}/address/${agent.address}`,
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
    if (amount > MAX_ORDER) return { ok: false, status: 400, error: "The demo agent pays up to $20 an order." };
    if ((await balanceOf(agent.address)) < amount) {
      const topUp = cafe ? (await balanceOf(cafe.address)) >= amount : false;
      if (topUp) void refill();
      return {
        ok: false,
        status: 503,
        error: topUp
          ? "The demo agent is out of test USDC. It's being topped up; try again in a minute."
          : "The demo agent's wallet is out of test USDC right now. Try again later.",
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
      explorer: `${EXPLORER}/tx/${settled.transaction}`,
      payer: agent.address,
      amount: usd(amount),
      passUrl: body.passUrl,
      emailedTo: body.emailedTo,
    };
  }

  /** The café pays its whole test-USDC balance back to the agent once the agent drops below $15. */
  async function refill() {
    if (!cafe || !cafeHttp || refilling) return;
    refilling = true;
    try {
      const [mine, theirs] = await Promise.all([balanceOf(agent.address), balanceOf(cafe.address)]);
      if (mine >= LOW || theirs === 0n) return;
      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: DEMO_NETWORK,
        asset: USDC,
        amount: theirs.toString(),
        payTo: agent.address,
        maxTimeoutSeconds: 300,
        extra: { name: "USDC", version: "2" },
      };
      const payload = await cafeHttp.createPaymentPayload({
        x402Version: 2,
        resource: { url: `${cfg.baseUrl}/demo/refill`, description: "Demo Café returns test USDC to the demo agent" },
        accepts: [requirements],
      });
      const verified = await facilitator.verify(payload, requirements);
      if (!verified.isValid) throw new Error(verified.invalidReason ?? "rejected");
      const settled = await facilitator.settle(payload, requirements);
      console.log(`demo agent refilled with ${usd(theirs)} test USDC: ${EXPLORER}/tx/${settled.transaction}`);
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
