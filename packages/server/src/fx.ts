// USDC is US dollars, so a shop pricing in another currency needs its prices in USD to take x402 payments.
// This converts at the European Central Bank's daily reference rates, through Frankfurter (free, no key).
// Rates are kept for an hour; if the source is down, the last rates serve for up to a day, after which
// conversion fails and the shop turns away USDC orders until rates are back.
export interface FxOptions {
  fetch?: typeof fetch;
  /** Default Frankfurter's latest rates against USD. */
  url?: string;
  /** How long rates are kept before fetching again. Default an hour. */
  maxAgeMs?: number;
}

/** A `toUsdCents` for payments.x402 or the venue host: cents in `currency` to US cents. */
export function fxToUsdCents(opts: FxOptions = {}) {
  const doFetch = opts.fetch ?? fetch;
  const url = opts.url ?? "https://api.frankfurter.dev/v1/latest?base=USD";
  const maxAge = opts.maxAgeMs ?? 3600_000;
  let rates: Record<string, number> | null = null;
  let fetchedAt = 0;
  let loading: Promise<void> | null = null;

  async function load() {
    const res = await doFetch(url);
    if (!res.ok) throw new Error(`Exchange rates answered ${res.status}`);
    const json = (await res.json()) as { base?: string; rates?: Record<string, number> };
    if (json.base !== "USD" || !json.rates) throw new Error("Exchange rates came back in an unexpected shape");
    rates = json.rates;
    fetchedAt = Date.now();
  }

  return async (cents: number, currency: string): Promise<number> => {
    const code = currency.toUpperCase();
    if (code === "USD") return cents;
    if (!rates || Date.now() - fetchedAt > maxAge) {
      loading ??= load().finally(() => (loading = null));
      try {
        await loading;
      } catch (err) {
        if (!rates || Date.now() - fetchedAt > 24 * 3600_000) throw err;
        console.warn("[collect] exchange rates unavailable, using the last ones:", err);
      }
    }
    const rate = rates![code];
    if (!rate) throw new Error(`No exchange rate for ${code}`);
    // Rates are units of `code` per US dollar.
    return cents / rate;
  };
}
