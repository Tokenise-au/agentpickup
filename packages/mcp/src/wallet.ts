// An x402 wallet for the MCP server: pays an order's pay link and signs in with Sign-In-With-X to read
// the order's pass again later.
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { createSIWxPayload, encodeSIWxHeader, SIGN_IN_WITH_X } from "@x402/extensions/sign-in-with-x";
import { privateKeyToAccount } from "viem/accounts";

export type Fetch = (req: Request) => Response | Promise<Response>;

export type PayOutcome =
  | { ok: true; passUrl: string; emailedTo?: string; amount?: string; transaction?: string; network?: string; explorer?: string }
  | { ok: false; error: string };

export interface Payer {
  address: string;
  /** Pay an order's x402 pay link. */
  pay(order: { id: string; payUrl: string }, fetch: Fetch): Promise<PayOutcome>;
  /** Sign in as the paying wallet to read an order's pass again. Returns the shop's response. */
  signIn(passUrl: string, fetch: Fetch): Promise<Response>;
}

export interface WalletPayerOptions {
  privateKey: `0x${string}`;
  /** Most the wallet pays for one order, as "$25". Stock x402 clients stop at $1. */
  maxPerOrder?: string;
  /** CAIP-2 networks the wallet may pay on. Base Sepolia (test USDC) only unless you say otherwise. */
  networks?: string[];
}

const EXPLORERS: Record<string, string> = {
  "eip155:8453": "https://basescan.org/tx/",
  "eip155:84532": "https://sepolia.basescan.org/tx/",
};

export const usd = (units: string | undefined) => (units ? (Number(units) / 1e6).toFixed(2) : undefined);

export async function errorOf(res: Response, fallback: string): Promise<string> {
  const body = (await res.clone().json().catch(() => ({}))) as { error?: string };
  return body.error ?? fallback;
}

export function walletPayer(opts: WalletPayerOptions): Payer {
  const account = privateKeyToAccount(opts.privateKey);
  const networks = (opts.networks?.length ? opts.networks : ["eip155:84532"]) as `${string}:${string}`[];
  const http = new x402HTTPClient(
    x402Client.fromConfig({
      schemes: networks.map((network) => ({ network, client: new ExactEvmScheme(account) })),
      spendControls: { maxAmountPerPayment: opts.maxPerOrder ?? "$25" },
    }),
  );

  return {
    address: account.address,

    async pay(order, fetch) {
      const challenge = await fetch(new Request(order.payUrl, { method: "POST" }));
      if (challenge.status !== 402) {
        return { ok: false, error: await errorOf(challenge, "This order isn't waiting for an x402 payment.") };
      }
      const required = http.getPaymentRequiredResponse(
        (n) => challenge.headers.get(n),
        await challenge.json().catch(() => undefined),
      );
      let payload;
      try {
        payload = await http.createPaymentPayload(required);
      } catch (err) {
        return { ok: false, error: `The wallet won't pay this: ${err instanceof Error ? err.message : String(err)}` };
      }
      const paid = await fetch(new Request(order.payUrl, { method: "POST", headers: http.encodePaymentSignatureHeader(payload) }));
      if (!paid.ok) return { ok: false, error: await errorOf(paid, `The payment didn't go through (${paid.status}).`) };
      const body = (await paid.json()) as { passUrl: string; emailedTo?: string };
      const settled = http.getPaymentSettleResponse((n) => paid.headers.get(n));
      return {
        ok: true,
        passUrl: body.passUrl,
        emailedTo: body.emailedTo,
        amount: usd(payload.accepted.amount),
        transaction: settled.transaction,
        network: settled.network,
        explorer: EXPLORERS[settled.network] ? EXPLORERS[settled.network] + settled.transaction : undefined,
      };
    },

    async signIn(passUrl, fetch) {
      const challenge = await fetch(new Request(passUrl));
      if (challenge.status !== 402) return challenge;
      const body = (await challenge.clone().json().catch(() => ({}))) as {
        extensions?: Record<string, { info: Record<string, string>; supportedChains: { chainId: string; type: string }[] }>;
      };
      const ext = body.extensions?.[SIGN_IN_WITH_X];
      const chain = ext?.supportedChains.find((c) => c.chainId.startsWith("eip155:"));
      if (!ext || !chain) return challenge;
      const signed = await createSIWxPayload(
        { ...ext.info, chainId: chain.chainId, type: chain.type } as never,
        account as never,
        passUrl,
      );
      return fetch(new Request(passUrl, { headers: { "SIGN-IN-WITH-X": encodeSIWxHeader(signed) } }));
    },
  };
}
