// Sign in with Square (OAuth code flow): a seller approves agentPickup in their own Square account, and the
// venue gets an access token for their menu, orders and payments. Access tokens last 30 days; Square asks
// apps to renew them at least every 7 days, which the venue host does.
export interface SquareOAuthConfig {
  /** The application ID from the OAuth page of your app in the Square Developer Console. */
  applicationId: string;
  /** The application secret from the same page. Keep it out of the database. */
  applicationSecret: string;
  /** Default "sandbox". */
  environment?: "sandbox" | "production";
  /** For tests, or a proxy. */
  fetch?: typeof fetch;
  squareVersion?: string;
}

/** What a venue needs: profile and locations, menu, and pickup orders with their payments. */
export const SQUARE_SCOPES = ["MERCHANT_PROFILE_READ", "ITEMS_READ", "ORDERS_READ", "ORDERS_WRITE", "PAYMENTS_READ", "PAYMENTS_WRITE"];

export interface SquareTokens {
  accessToken: string;
  refreshToken: string;
  /** Unix ms. */
  expiresAt: number;
  merchantId: string;
}

export interface SquareLocationSummary {
  id: string;
  name: string;
  businessName: string;
  address: string;
  currency: string;
  active: boolean;
}

export function squareOAuth(cfg: SquareOAuthConfig) {
  const host = cfg.environment === "production" ? "https://connect.squareup.com" : "https://connect.squareupsandbox.com";
  const doFetch = cfg.fetch ?? fetch;
  const version = cfg.squareVersion ?? "2026-09-16";

  async function post<T>(path: string, body: unknown, auth?: string): Promise<T> {
    const res = await doFetch(`${host}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Square-Version": version, ...(auth ? { Authorization: auth } : {}) },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as { errors?: { code: string; detail?: string }[]; message?: string; type?: string };
    if (!res.ok) {
      const detail = json.errors?.map((e) => `${e.code}${e.detail ? `: ${e.detail}` : ""}`).join("; ") ?? json.message ?? json.type ?? "";
      throw new Error(`Square ${path} answered ${res.status}${detail ? ` (${detail})` : ""}`);
    }
    return json as T;
  }

  const tokens = (t: { access_token: string; refresh_token: string; expires_at: string; merchant_id: string }): SquareTokens => ({
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    expiresAt: Date.parse(t.expires_at),
    merchantId: t.merchant_id,
  });

  return {
    environment: cfg.environment ?? "sandbox",

    /** Where to send the seller. `state` comes back on the callback; check it against the seller's cookie. */
    authorizeUrl(state: string): string {
      const params = new URLSearchParams({ client_id: cfg.applicationId, scope: SQUARE_SCOPES.join(" "), state });
      // Production requires the seller to sign in, so they approve with the right Square account.
      if (cfg.environment === "production") params.set("session", "false");
      return `${host}/oauth2/authorize?${params}`;
    },

    async exchangeCode(code: string): Promise<SquareTokens> {
      return tokens(
        await post("/oauth2/token", { client_id: cfg.applicationId, client_secret: cfg.applicationSecret, code, grant_type: "authorization_code" }),
      );
    },

    async refresh(refreshToken: string): Promise<SquareTokens> {
      return tokens(
        await post("/oauth2/token", {
          client_id: cfg.applicationId,
          client_secret: cfg.applicationSecret,
          refresh_token: refreshToken,
          grant_type: "refresh_token",
        }),
      );
    },

    /** Ends agentPickup's access to the seller's Square account. */
    async revoke(merchantId: string): Promise<void> {
      await post("/oauth2/revoke", { client_id: cfg.applicationId, merchant_id: merchantId }, `Client ${cfg.applicationSecret}`);
    },

    async listLocations(accessToken: string): Promise<SquareLocationSummary[]> {
      const res = await doFetch(`${host}/v2/locations`, { headers: { Authorization: `Bearer ${accessToken}`, "Square-Version": version } });
      const json = (await res.json().catch(() => ({}))) as {
        locations?: {
          id: string;
          name?: string;
          business_name?: string;
          currency?: string;
          status?: string;
          address?: { address_line_1?: string; locality?: string; administrative_district_level_1?: string; postal_code?: string };
        }[];
      };
      if (!res.ok) throw new Error(`Square /v2/locations answered ${res.status}`);
      return (json.locations ?? []).map((l) => ({
        id: l.id,
        name: l.name ?? l.business_name ?? l.id,
        businessName: l.business_name ?? l.name ?? "",
        address: [l.address?.address_line_1, [l.address?.locality, l.address?.administrative_district_level_1, l.address?.postal_code].filter(Boolean).join(" ")]
          .filter(Boolean)
          .join(", "),
        currency: (l.currency ?? "USD").toLowerCase(),
        active: l.status !== "INACTIVE",
      }));
    },
  };
}

export type SquareOAuth = ReturnType<typeof squareOAuth>;
