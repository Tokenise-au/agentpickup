// Agent request signatures (RFC 9421 HTTP Message Signatures) as used by Visa's Trusted
// Agent Protocol (tags agent-browser-auth / agent-payer-auth), Mastercard Agent Pay and
// Web Bot Auth (tag web-bot-auth, keys in the agent's signature directory).
// Applied to agent payment routes in "log" or "require" mode.
import type { Context, MiddlewareHandler } from "hono";
import { constants, createHash, createPublicKey, verify, type JsonWebKey, type KeyObject } from "node:crypto";

export const TAP_TAGS = ["agent-browser-auth", "agent-payer-auth"] as const;
export const WEB_BOT_AUTH_TAG = "web-bot-auth";

type Jwk = JsonWebKey & { kid?: string; alg?: string };

export interface AgentSignatureConfig {
  /** "log" checks signatures when present; "require" refuses agent payment requests without a valid one. */
  mode: "log" | "require";
  /** Keys you trust directly (JWK with kid, or matched by RFC 7638 thumbprint). */
  keys?: Jwk[];
  /** Key services: a Visa-style `GET {url}/keys?keyID=` returning one JWK, or a JWKS URL. */
  keyServices?: { url: string; kind: "visa-keys" | "jwks" }[];
  /** Web Bot Auth: Signature-Agent origins whose /.well-known/http-message-signatures-directory you trust. */
  trustedAgents?: string[];
  /** Longest allowed created→expires window. TAP caps this at 8 minutes. */
  maxWindowSeconds?: number;
}

export type AgentSignatureResult =
  | { ok: true; keyid: string; tag: string; label: string }
  | { ok: false; reason: string };

interface Member {
  label: string;
  /** The member value exactly as sent: the @signature-params line covers these bytes. */
  raw: string;
  components: string[];
  params: Record<string, string | number>;
}

/** Split a structured-field dictionary at top-level commas (outside quotes, parens and byte sequences). */
function splitTopLevel(header: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let bytes = false;
  let start = 0;
  for (let i = 0; i < header.length; i++) {
    const ch = header[i];
    if (quoted) {
      if (ch === "\\") i++;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === ":" && depth === 0) bytes = !bytes;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0 && !bytes) {
      out.push(header.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(header.slice(start).trim());
  return out.filter(Boolean);
}

export function parseSignatureInput(header: string): Member[] {
  const members: Member[] = [];
  for (const part of splitTopLevel(header)) {
    const eq = part.indexOf("=");
    if (eq < 1) continue;
    const label = part.slice(0, eq).trim();
    const raw = part.slice(eq + 1).trim();
    const list = raw.match(/^\(([^)]*)\)/);
    if (!list) continue;
    const components = [...list[1].matchAll(/"([^"]+)"/g)].map((m) => m[1].toLowerCase());
    const params: Record<string, string | number> = {};
    for (const p of raw.slice(list[0].length).matchAll(/;\s*([A-Za-z0-9_*-]+)=("(?:[^"\\]|\\.)*"|-?\d+)/g)) {
      const key = p[1].toLowerCase();
      params[key] = p[2].startsWith('"') ? p[2].slice(1, -1) : Number(p[2]);
    }
    members.push({ label, raw, components, params });
  }
  return members;
}

export function parseSignatures(header: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const part of splitTopLevel(header)) {
    const m = part.match(/^([^=]+)=:([A-Za-z0-9+/=_-]*):$/);
    if (m) out.set(m[1].trim(), Buffer.from(m[2], "base64"));
  }
  return out;
}

/** RFC 7638 JWK thumbprint (SHA-256, base64url), the keyid Web Bot Auth uses. */
export function jwkThumbprint(jwk: Jwk): string {
  const fields: Record<string, string[]> = { OKP: ["crv", "kty", "x"], EC: ["crv", "kty", "x", "y"], RSA: ["e", "kty", "n"] };
  const keys = fields[String(jwk.kty)];
  if (!keys) return "";
  const json = `{${keys.map((k) => `"${k}":"${(jwk as Record<string, string>)[k]}"`).join(",")}}`;
  return createHash("sha256").update(json).digest("base64url");
}

/** The RFC 9421 signature base for the covered components. */
export function signatureBase(member: Member, req: { method: string; url: URL; headers: Headers }): string | null {
  const lines: string[] = [];
  for (const comp of member.components) {
    let value: string | null;
    if (comp === "@authority") value = req.url.host.toLowerCase();
    else if (comp === "@path") value = req.url.pathname;
    else if (comp === "@method") value = req.method.toUpperCase();
    else if (comp === "@target-uri") value = req.url.href;
    else if (comp === "@query") value = req.url.search || "?";
    else if (comp.startsWith("@")) return null;
    else value = req.headers.get(comp);
    if (value === null) return null;
    lines.push(`"${comp}": ${value}`);
  }
  lines.push(`"@signature-params": ${member.raw}`);
  return lines.join("\n");
}

function verifyWith(jwk: Jwk, alg: string | undefined, data: Buffer, sig: Buffer): boolean {
  let key: KeyObject;
  try {
    key = createPublicKey({ key: jwk, format: "jwk" });
  } catch {
    return false;
  }
  const a = (alg ?? jwk.alg ?? "").toLowerCase();
  try {
    if (jwk.kty === "OKP") return verify(null, data, key, sig);
    if (jwk.kty === "EC") return verify(a.includes("384") ? "sha384" : "sha256", data, { key, dsaEncoding: "ieee-p1363" }, sig);
    if (jwk.kty === "RSA") {
      const hash = a.includes("512") ? "sha512" : a.includes("384") ? "sha384" : "sha256";
      return verify(hash, data, { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_AUTO }, sig);
    }
  } catch {
    return false;
  }
  return false;
}

export function createAgentSignatureVerifier(config: AgentSignatureConfig) {
  const maxWindow = config.maxWindowSeconds ?? 8 * 60;
  const seenNonces = new Map<string, number>();
  const keyCache = new Map<string, { at: number; keys: Jwk[] }>();

  async function getJson(url: string): Promise<unknown> {
    if (!url.startsWith("https://")) return null;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { Accept: "application/json, application/http-message-signatures-directory+json" } }).catch(() => null);
    return res?.ok ? res.json().catch(() => null) : null;
  }

  async function cached(cacheKey: string, load: () => Promise<Jwk[]>): Promise<Jwk[]> {
    const hit = keyCache.get(cacheKey);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.keys;
    const keys = await load();
    keyCache.set(cacheKey, { at: Date.now(), keys });
    return keys;
  }

  const matches = (k: Jwk, keyid: string) => k.kid === keyid || jwkThumbprint(k) === keyid;

  async function resolveKey(keyid: string, headers: Headers): Promise<Jwk | null> {
    const pinned = config.keys?.find((k) => matches(k, keyid));
    if (pinned) return pinned;
    for (const svc of config.keyServices ?? []) {
      const keys = await cached(`${svc.kind}:${svc.url}:${svc.kind === "visa-keys" ? keyid : ""}`, async () => {
        if (svc.kind === "visa-keys") {
          const jwk = (await getJson(`${svc.url.replace(/\/$/, "")}/keys?keyID=${encodeURIComponent(keyid)}`)) as Jwk | null;
          return jwk?.kty ? [jwk] : [];
        }
        const set = (await getJson(svc.url)) as { keys?: Jwk[] } | null;
        return set?.keys ?? [];
      });
      const found = keys.find((k) => matches(k, keyid));
      if (found) return found;
    }
    const agent = headers.get("signature-agent")?.replace(/^(?:[a-z0-9_-]+=)?"?|"$/gi, "");
    if (agent) {
      let origin: string | null = null;
      try {
        origin = new URL(agent).origin;
      } catch {
        origin = null;
      }
      if (origin && config.trustedAgents?.includes(origin)) {
        const keys = await cached(`wba:${origin}`, async () => {
          const dir = (await getJson(`${origin}/.well-known/http-message-signatures-directory`)) as { keys?: Jwk[] } | null;
          return dir?.keys ?? [];
        });
        return keys.find((k) => matches(k, keyid)) ?? null;
      }
    }
    return null;
  }

  async function check(req: { method: string; url: URL; headers: Headers }): Promise<AgentSignatureResult | null> {
    const input = req.headers.get("signature-input");
    const sigHeader = req.headers.get("signature");
    if (!input || !sigHeader) return null;
    const signatures = parseSignatures(sigHeader);
    const now = Math.floor(Date.now() / 1000);
    for (const [nonce, at] of seenNonces) if (at < now - maxWindow) seenNonces.delete(nonce);

    let lastReason = "No agent signature with a recognised tag.";
    for (const member of parseSignatureInput(input)) {
      const tag = String(member.params.tag ?? "");
      if (![...TAP_TAGS, WEB_BOT_AUTH_TAG].includes(tag)) continue;
      const sig = signatures.get(member.label);
      const keyid = String(member.params.keyid ?? "");
      const created = Number(member.params.created);
      const expires = Number(member.params.expires);
      const nonce = member.params.nonce === undefined ? null : String(member.params.nonce);
      if (!sig || !keyid) { lastReason = "Signature or keyid missing."; continue; }
      if (!member.components.includes("@authority")) { lastReason = "The signature must cover @authority."; continue; }
      if (TAP_TAGS.includes(tag as (typeof TAP_TAGS)[number]) && !member.components.includes("@path")) { lastReason = "TAP signatures must cover @path."; continue; }
      if (!Number.isFinite(created) || !Number.isFinite(expires) || created > now + 60 || expires <= now || expires - created > maxWindow) {
        lastReason = "The signature is expired or its window is too long.";
        continue;
      }
      if (!nonce) { lastReason = "A nonce is required."; continue; }
      if (seenNonces.has(`${keyid}:${nonce}`)) { lastReason = "This signature nonce was already used."; continue; }
      const base = signatureBase(member, req);
      if (!base) { lastReason = "A covered component is missing from the request."; continue; }
      const jwk = await resolveKey(keyid, req.headers);
      if (!jwk) { lastReason = `No trusted key for keyid ${keyid}.`; continue; }
      const alg = member.params.alg === undefined ? undefined : String(member.params.alg);
      if (!verifyWith(jwk, alg, Buffer.from(base), sig)) { lastReason = "The signature doesn't verify."; continue; }
      seenNonces.set(`${keyid}:${nonce}`, now);
      return { ok: true, keyid, tag, label: member.label };
    }
    return { ok: false, reason: lastReason };
  }

  /** Middleware for agent payment routes. Adds Agent-Signature to the response describing what was checked. */
  const middleware: MiddlewareHandler = async (c: Context, next) => {
    const result = await check({ method: c.req.method, url: new URL(c.req.url), headers: c.req.raw.headers });
    if (config.mode === "require" && !result?.ok) {
      return c.json({ error: "A verified agent signature is required.", detail: result && !result.ok ? result.reason : "Unsigned request." }, 401);
    }
    if (result && !result.ok) console.warn(`[collect] agent signature rejected on ${c.req.path}: ${result.reason}`);
    await next();
    c.res.headers.set("Agent-Signature", result?.ok ? `verified; keyid="${result.keyid}"; tag="${result.tag}"` : result ? "invalid" : "none");
  };

  return { check, middleware };
}
