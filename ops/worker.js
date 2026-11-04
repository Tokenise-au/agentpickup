// agentpickup-ops: the install's eyes from outside. Every five minutes it checks the site, the directory, the
// MCP server and the app's own /ops/health, and emails the operator when something breaks and again when it's
// fixed. It also keeps the app's nightly backups, 35 days of them in KV. Backups arrive encrypted and the key
// stays with the app, so this Worker only ever holds ciphertext.
//
// Bindings (wrangler.jsonc): OPS (KV), EMAIL (send_email), SITE_URL, ALERT_FROM. Secrets: OPS_KEY, ALERT_TO.

const UA = "agentpickup-uptime/1 (+https://agentpickup.app)";
const BACKUP_TTL_SECONDS = 35 * 86400;
const MAX_VALUE_BYTES = 25 * 1024 * 1024;
/** A site check alerts after this many failures in a row: two checks, about ten minutes, so a blip doesn't. */
const FAILS_TO_ALERT = 2;
/** The same app issues are repeated at most this often while they last. */
const REPEAT_MS = 6 * 3600_000;

const CHECKS = {
  site: { label: "The website", path: "/", ok: async (res) => res.status === 200 && (await res.text()).includes("agentPickup") },
  directory: { label: "The shop directory", path: "/directory/v1/shops", ok: async (res) => res.status === 200 && Array.isArray((await res.json()).shops) },
  // A plain GET gets "406 Not Acceptable" from a healthy MCP server: alive, and no agent session opened.
  mcp: { label: "The MCP server", path: "/mcp", ok: async (res) => [200, 405, 406].includes(res.status) },
  health: { label: "The app's health check", path: "/ops/health", auth: true, ok: async (res) => res.status === 200 },
};

export default {
  async fetch(request, env) {
    if (!(await authorised(request, env))) return new Response("Not found", { status: 404 });
    const url = new URL(request.url);

    if (url.pathname.startsWith("/backups/")) {
      const key = decodeURIComponent(url.pathname.slice("/backups/".length));
      if (!/^\d{4}-\d{2}-\d{2}\/[\w.\/-]+$/.test(key) || key.includes("..")) return json({ error: "That isn't a backup key." }, 400);
      if (request.method === "PUT") {
        const body = await request.arrayBuffer();
        if (body.byteLength > MAX_VALUE_BYTES) return json({ error: "Over 25 MB: send it in parts." }, 413);
        await env.OPS.put(`b:${key}`, body, { expirationTtl: BACKUP_TTL_SECONDS, metadata: { bytes: body.byteLength, at: Date.now() } });
        return new Response(null, { status: 204 });
      }
      if (request.method === "GET") {
        const value = await env.OPS.get(`b:${key}`, "arrayBuffer");
        return value ? new Response(value, { headers: { "Content-Type": "application/octet-stream" } }) : json({ error: "No such backup." }, 404);
      }
    }
    if (url.pathname === "/backups" && request.method === "GET") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const keys = [];
      let cursor;
      do {
        const page = await env.OPS.list({ prefix: `b:${prefix}`, cursor });
        keys.push(...page.keys.map((k) => ({ key: k.name.slice(2), ...(k.metadata ?? {}) })));
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
      return json({ keys });
    }
    if (url.pathname === "/status" && request.method === "GET") return json((await env.OPS.get("state", "json")) ?? {});
    if (url.pathname === "/check" && request.method === "POST") return json(await check(env));
    return json({ error: "Not found." }, 404);
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(check(env));
  },
};

/** The OPS_KEY bearer, compared in constant time. */
async function authorised(request, env) {
  const given = new TextEncoder().encode((request.headers.get("authorization") ?? "").replace(/^Bearer /, ""));
  const expected = new TextEncoder().encode(env.OPS_KEY ?? "");
  return expected.length > 0 && given.length === expected.length && crypto.subtle.timingSafeEqual(given, expected);
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const when = (ms) => new Date(ms).toLocaleString("en-AU", { timeZone: "Australia/Brisbane", dateStyle: "medium", timeStyle: "short" });
/** The same issue, whatever its counts, times and latest error: the alert repeats only when this changes. */
const issueKey = (issue) => issue.split(/\. Latest:| since |\. Last try:/)[0].replace(/\d+/g, "#");

async function probe(env, check) {
  try {
    const res = await fetch(`${env.SITE_URL}${check.path}`, {
      headers: { "User-Agent": UA, ...(check.auth ? { Authorization: `Bearer ${env.OPS_KEY}` } : {}) },
      signal: AbortSignal.timeout(15_000),
      redirect: "manual",
    });
    const copy = res.clone();
    return (await check.ok(res).catch(() => false)) ? { ok: true, res: copy } : { ok: false, detail: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, detail: String(err?.message ?? err).slice(0, 200) };
  }
}

async function check(env) {
  const now = Date.now();
  const state = (await env.OPS.get("state", "json")) ?? { checks: {}, app: { key: "", since: now, lastAlertAt: 0 } };
  const alerts = [];
  let health = null;

  for (const [name, c] of Object.entries(CHECKS)) {
    const r = await probe(env, c);
    if (name === "health" && r.ok) health = await r.res.json().catch(() => null);
    const prev = state.checks[name] ?? { ok: true, fails: 0, since: now, alerted: false };
    if (r.ok) {
      if (prev.alerted) alerts.push({ subject: `${c.label} is back`, lines: [`${c.label} answers again. It was down from ${when(prev.since)}.`] });
      state.checks[name] = { ok: true, fails: 0, since: prev.ok ? prev.since : now, alerted: false };
    } else {
      const fails = prev.ok ? 1 : prev.fails + 1;
      const since = prev.ok ? now : prev.since;
      const alert = fails >= FAILS_TO_ALERT && !prev.alerted;
      if (alert) {
        alerts.push({
          subject: `${c.label} is down`,
          lines: [`${c.label} (${env.SITE_URL}${c.path}) has failed ${fails} checks in a row, since ${when(since)}.`, `Last answer: ${r.detail}.`],
        });
      }
      state.checks[name] = { ok: false, fails, since, alerted: prev.alerted || alert, detail: r.detail };
    }
  }

  // What the app itself says needs a person: backups, failures at venues, venues down, the test alert.
  if (health) {
    const issues = Array.isArray(health.issues) ? health.issues : [];
    const key = issues.map(issueKey).sort().join("|");
    const prev = state.app ?? { key: "", since: now, lastAlertAt: 0 };
    if (issues.length && (key !== prev.key || now - prev.lastAlertAt > REPEAT_MS)) {
      alerts.push({ subject: issues.length === 1 ? issues[0].split(". ")[0] : `${issues.length} things need you`, lines: issues });
      state.app = { key, since: key === prev.key ? prev.since : now, lastAlertAt: now };
    } else if (!issues.length && prev.key) {
      alerts.push({ subject: "All clear", lines: ["Everything the app reported has cleared."] });
      state.app = { key: "", since: now, lastAlertAt: 0 };
    }
  }

  const sent = [];
  for (const a of alerts) {
    try {
      await env.EMAIL.send({
        to: env.ALERT_TO,
        from: { email: env.ALERT_FROM, name: "agentPickup alerts" },
        subject: `agentPickup: ${a.subject}`.slice(0, 200),
        text: [...a.lines, "", `Ops page: ${env.SITE_URL}/admin/ops (add ?key= and your admin key)`, `Checked ${when(now)}, every five minutes.`].join("\n"),
      });
      sent.push(a.subject);
    } catch (err) {
      sent.push(`NOT SENT (${err?.code ?? "error"}): ${a.subject}`);
      console.error("alert email failed:", err?.code, err?.message);
    }
  }
  state.lastCheckAt = now;
  state.lastAlerts = sent.length ? { at: now, sent } : state.lastAlerts;
  await env.OPS.put("state", JSON.stringify(state));
  return { checks: Object.fromEntries(Object.entries(state.checks).map(([k, v]) => [k, v.ok ? "ok" : v.detail])), issues: health?.issues ?? null, alerts: sent };
}
