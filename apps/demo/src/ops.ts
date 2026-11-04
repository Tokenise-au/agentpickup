// The install's safety net (roadmap phase 2). Every night, each SQLite database and key file in the data folder
// is snapshotted, gzipped, encrypted with BACKUP_KEY and sent to the ops Worker, which keeps 35 days of them.
// Failures worth a person's attention (a POS call, an email, a refund, a venue that won't start) are logged
// here; /ops/health sums them up for the Worker, which checks it every five minutes and emails the operator;
// /admin/ops shows it all. scripts/restore-backup.ts brings a night back.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync, gzipSync } from "node:zlib";
import type { Problem } from "@agentpickup/server";

const MAGIC = Buffer.from("APB1");
const DAY = 24 * 3600_000;
/** Under the Worker store's 25 MiB per value. */
export const PART_BYTES = 20 * 1024 * 1024;
/** A day without a good backup is worth an alert; a little slack for the run time. */
const BACKUP_STALE_MS = 26 * 3600_000;

/** BACKUP_KEY: 32 random bytes, base64. */
export function backupKeyFrom(text: string): Buffer {
  const key = Buffer.from(text.trim(), "base64");
  if (key.length !== 32) throw new Error("BACKUP_KEY must be 32 bytes, base64-encoded.");
  return key;
}

/** gzip, then AES-256-GCM: "APB1", a 12-byte IV, the ciphertext, the 16-byte tag. */
export function sealBackup(plain: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(gzipSync(plain)), cipher.final()]);
  return Buffer.concat([MAGIC, iv, body, cipher.getAuthTag()]);
}

export function openBackup(sealed: Buffer, key: Buffer): Buffer {
  if (!sealed.subarray(0, 4).equals(MAGIC)) throw new Error("Not an agentPickup backup file.");
  const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(4, 16));
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  return gunzipSync(Buffer.concat([decipher.update(sealed.subarray(16, sealed.length - 16)), decipher.final()]));
}

export const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** What a backup takes, relative to the data folder: every database and key file, the venues' included. */
export function backupFiles(dataDir: string): string[] {
  const here = (dir: string, rel: string, test: (f: string) => boolean) =>
    existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && test(e.name)).map((e) => (rel ? `${rel}/${e.name}` : e.name)) : [];
  return [...here(dataDir, "", (f) => f.endsWith(".db") || f.endsWith(".pem")), ...here(join(dataDir, "venues"), "venues", (f) => f.endsWith(".db"))].sort();
}

/** A consistent copy of a live SQLite database (WAL included), as bytes. */
function snapshot(file: string, tmp: string): Buffer {
  mkdirSync(dirname(tmp), { recursive: true });
  rmSync(tmp, { force: true });
  const db = new DatabaseSync(file);
  try {
    db.prepare("VACUUM INTO ?").run(tmp);
  } finally {
    db.close();
  }
  const bytes = readFileSync(tmp);
  rmSync(tmp, { force: true });
  return bytes;
}

export interface BackupManifest {
  v: 1;
  day: string;
  at: number;
  files: { path: string; bytes: number; sha256: string; parts: number }[];
}

export interface OpsHealth {
  ok: boolean;
  at: number;
  /** One line per thing that needs a person, for the alert. */
  issues: string[];
  backup: { configured: boolean; lastOkAt: number | null; lastOkDay: string | null; lastError: string | null };
  problems: { kind: string; venue: string; count: number; lastAt: number; message: string }[];
  venuesDown: { slug: string; error: string }[];
  testAlert: boolean;
}

export function createOps(opts: {
  db: DatabaseSync;
  dataDir: string;
  /** The ops Worker: backups go to <url>/backups/<day>/<path>.enc. Without it, backups are off. */
  target?: { url: string; key: string };
  backupKey?: Buffer;
  /** Venues that should be running and aren't. */
  venuesDown?: () => Promise<{ slug: string; error: string }[]>;
  fetch?: typeof fetch;
  now?: () => number;
}) {
  const { db } = opts;
  const now = opts.now ?? Date.now;
  const doFetch = opts.fetch ?? fetch;
  db.exec(`
    CREATE TABLE IF NOT EXISTS ops_problems (at INTEGER NOT NULL, venue TEXT NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL, order_id TEXT);
    CREATE INDEX IF NOT EXISTS ops_problems_at ON ops_problems (at);
    CREATE TABLE IF NOT EXISTS ops_backups (at INTEGER NOT NULL, day TEXT NOT NULL, ok INTEGER NOT NULL, files INTEGER NOT NULL, bytes INTEGER NOT NULL, error TEXT);
    CREATE TABLE IF NOT EXISTS ops_flags (name TEXT PRIMARY KEY, until INTEGER NOT NULL);
  `);
  const brisbaneDay = (ms: number) => new Date(ms + 10 * 3600_000).toISOString().slice(0, 10);
  const brisbaneHour = (ms: number) => new Date(ms + 10 * 3600_000).getUTCHours();

  /** A failure at a venue ("demo-cafe" for the site's own shop). Expected limits aren't problems. */
  function problem(venue: string, p: Problem) {
    // A visitor ordering again and again on the public demo hits the per-address cap: that's the cap working.
    if (p.kind === "email" && p.message.startsWith("Daily email limit reached for this address")) return;
    db.prepare("INSERT INTO ops_problems (at, venue, kind, message, order_id) VALUES (?, ?, ?, ?, ?)").run(now(), venue, p.kind, p.message.slice(0, 500), p.orderId ?? null);
    db.prepare("DELETE FROM ops_problems WHERE at < ?").run(now() - 30 * DAY);
  }

  async function put(key: string, body: Buffer | string, contentType: string) {
    const res = await doFetch(`${opts.target!.url}/backups/${key}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${opts.target!.key}`, "Content-Type": contentType },
      body: typeof body === "string" ? body : new Uint8Array(body),
    });
    if (!res.ok) throw new Error(`the ops Worker answered ${res.status} for ${key}: ${(await res.text()).slice(0, 200)}`);
  }

  let running: Promise<unknown> | null = null;
  /** Snapshot, encrypt and send everything. The manifest goes last: a day with one is complete. */
  async function backup(): Promise<{ day: string; ok: boolean; files: number; bytes: number; error?: string }> {
    if (running) await running.catch(() => undefined);
    const at = now();
    const day = brisbaneDay(at);
    const job = (async () => {
      if (!opts.target || !opts.backupKey) throw new Error("Backups are off: set OPS_URL, OPS_KEY and BACKUP_KEY.");
      const manifest: BackupManifest = { v: 1, day, at, files: [] };
      let bytes = 0;
      for (const path of backupFiles(opts.dataDir)) {
        const full = join(opts.dataDir, path);
        const plain = path.endsWith(".db") ? snapshot(full, join(opts.dataDir, ".backup-tmp", path)) : readFileSync(full);
        const sealed = sealBackup(plain, opts.backupKey);
        const parts = Math.max(1, Math.ceil(sealed.length / PART_BYTES));
        for (let i = 0; i < parts; i++) {
          await put(`${day}/${path}.enc${parts > 1 ? `.part${i}` : ""}`, sealed.subarray(i * PART_BYTES, (i + 1) * PART_BYTES), "application/octet-stream");
        }
        manifest.files.push({ path, bytes: plain.length, sha256: sha256(plain), parts });
        bytes += sealed.length;
      }
      await put(`${day}/manifest.json`, JSON.stringify(manifest), "application/json");
      return { files: manifest.files.length, bytes };
    })();
    running = job;
    try {
      const { files, bytes } = await job;
      db.prepare("INSERT INTO ops_backups (at, day, ok, files, bytes, error) VALUES (?, ?, 1, ?, ?, NULL)").run(at, day, files, bytes);
      return { day, ok: true, files, bytes };
    } catch (err) {
      const error = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      console.error("[ops] backup failed:", err);
      db.prepare("INSERT INTO ops_backups (at, day, ok, files, bytes, error) VALUES (?, ?, 0, 0, 0, ?)").run(at, day, error);
      return { day, ok: false, files: 0, bytes: 0, error };
    } finally {
      running = null;
      db.prepare("DELETE FROM ops_backups WHERE at < ?").run(now() - 90 * DAY);
    }
  }

  const lastOk = () => db.prepare("SELECT at, day FROM ops_backups WHERE ok = 1 ORDER BY at DESC LIMIT 1").get() as { at: number; day: string } | undefined;
  const lastTry = () => db.prepare("SELECT at, ok, error FROM ops_backups ORDER BY at DESC LIMIT 1").get() as { at: number; ok: number; error: string | null } | undefined;

  /** Run once a day after 3am Brisbane, and again within the hour if that try failed. */
  function backupDue(t = now()): boolean {
    if (!opts.target || !opts.backupKey || brisbaneHour(t) < 3) return false;
    if (lastOk()?.day === brisbaneDay(t)) return false;
    const tried = lastTry();
    return !tried || t - tried.at > 3600_000;
  }

  async function health(): Promise<OpsHealth> {
    const t = now();
    const ok = lastOk();
    const tried = lastTry();
    const configured = Boolean(opts.target && opts.backupKey);
    const problems = (
      db
        .prepare(
          `SELECT kind, venue, COUNT(*) AS count, MAX(at) AS lastAt,
             (SELECT message FROM ops_problems q WHERE q.kind = p.kind AND q.venue = p.venue ORDER BY at DESC LIMIT 1) AS message
           FROM ops_problems p WHERE at >= ? GROUP BY kind, venue ORDER BY lastAt DESC`,
        )
        .all(t - 3600_000) as OpsHealth["problems"]
    ).map((p) => ({ ...p, count: Number(p.count), lastAt: Number(p.lastAt) }));
    const venuesDown = await (opts.venuesDown?.() ?? Promise.resolve([])).catch((err) => [{ slug: "?", error: `couldn't list venues: ${String(err)}` }]);
    const testAlert = Number((db.prepare("SELECT until FROM ops_flags WHERE name = 'test-alert'").get() as { until: number } | undefined)?.until ?? 0) > t;
    const issues: string[] = [];
    if (!configured) issues.push("Backups are off: OPS_URL, OPS_KEY or BACKUP_KEY isn't set.");
    else if (!ok || t - ok.at > BACKUP_STALE_MS) {
      issues.push(`No good backup since ${ok ? new Date(ok.at).toISOString() : "it started"}${tried && !tried.ok ? `. Last try: ${tried.error}` : ""}.`);
    }
    for (const p of problems) issues.push(`${p.count} ${p.kind} problem${p.count === 1 ? "" : "s"} at ${p.venue} in the last hour. Latest: ${p.message}`);
    for (const v of venuesDown) issues.push(`Venue ${v.slug} isn't running: ${v.error}`);
    if (testAlert) issues.push("Test alert, from the button on /admin/ops.");
    return {
      ok: issues.length === 0,
      at: t,
      issues,
      backup: { configured, lastOkAt: ok?.at ?? null, lastOkDay: ok?.day ?? null, lastError: tried && !tried.ok ? tried.error : null },
      problems,
      venuesDown,
      testAlert,
    };
  }

  /** Make /ops/health report a problem for a while, to prove an alert reaches the operator. */
  function testAlert(minutes = 15) {
    db.prepare("INSERT INTO ops_flags (name, until) VALUES ('test-alert', ?) ON CONFLICT (name) DO UPDATE SET until = excluded.until").run(now() + minutes * 60_000);
  }

  const recentProblems = (limit = 50) =>
    db.prepare("SELECT at, venue, kind, message, order_id AS orderId FROM ops_problems ORDER BY at DESC LIMIT ?").all(limit) as {
      at: number;
      venue: string;
      kind: string;
      message: string;
      orderId: string | null;
    }[];
  const recentBackups = (limit = 14) =>
    db.prepare("SELECT at, day, ok, files, bytes, error FROM ops_backups ORDER BY at DESC LIMIT ?").all(limit) as {
      at: number;
      day: string;
      ok: number;
      files: number;
      bytes: number;
      error: string | null;
    }[];

  function start() {
    const tick = () => {
      if (backupDue()) void backup();
    };
    const first = setTimeout(tick, 60_000);
    const timer = setInterval(tick, 10 * 60_000);
    first.unref();
    timer.unref();
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }

  return { problem, backup, backupDue, health, testAlert, recentProblems, recentBackups, start };
}

/** A venue's latest orders, read straight from its database file, for the admin page. No emails or names. */
export function recentOrders(file: string, limit = 8) {
  if (!existsSync(file)) return [];
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db
      .prepare("SELECT id, status, rail, total_cents AS totalCents, currency, created_at AS createdAt FROM orders ORDER BY created_at DESC LIMIT ?")
      .all(limit) as { id: string; status: string; rail: string; totalCents: number; currency: string; createdAt: number }[];
  } finally {
    db.close();
  }
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const when = (ms: number) => new Date(ms).toLocaleString("en-AU", { timeZone: "Australia/Brisbane", dateStyle: "medium", timeStyle: "short" });
const kb = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** /admin/ops: health now, the last fortnight of backups, recent problems, and each venue's latest orders. */
export function renderOpsPage(o: {
  health: OpsHealth;
  backups: ReturnType<ReturnType<typeof createOps>["recentBackups"]>;
  problems: ReturnType<ReturnType<typeof createOps>["recentProblems"]>;
  venues: { slug: string; name: string; running: boolean; test: boolean; orders: ReturnType<typeof recentOrders> }[];
  adminKey: string;
  sent?: boolean;
}): string {
  const { health } = o;
  const money = (cents: number, currency: string) => `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  const venueRows = o.venues
    .map(
      (v) => `<section class="card"><div class="row"><h2>${esc(v.name)}</h2><span class="pill ${v.running ? "ok" : "bad"}">${v.running ? (v.test ? "running · test mode" : "running · live") : "not running"}</span></div>
      <p class="muted">${esc(v.slug)}</p>
      ${
        v.orders.length
          ? `<table><tr><th>Placed</th><th>Order</th><th>Status</th><th>Paid by</th><th class="r">Total</th></tr>${v.orders
              .map((x) => `<tr><td>${esc(when(x.createdAt))}</td><td class="mono">${esc(x.id)}</td><td>${esc(x.status)}</td><td>${esc(x.rail)}</td><td class="r">${esc(money(x.totalCents, x.currency))}</td></tr>`)
              .join("")}</table>`
          : `<p class="muted">No orders yet.</p>`
      }</section>`,
    )
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Ops · agentPickup</title>
<style>
:root{--bg:#0a0b0d;--card:#111316;--line:#23272d;--fg:#eef0f3;--muted:#8b929c;--ok:#b5f23d;--bad:#f87171;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:960px;margin:0 auto;padding:28px 16px 64px;display:grid;gap:14px}
h1{margin:0;font-size:28px}h2{margin:0;font-size:17px}.muted{color:var(--muted);margin:4px 0 8px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px;min-width:0;overflow-x:auto}
.row{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}
.pill{font-size:12px;border:1px solid currentColor;border-radius:999px;padding:2px 10px}.ok{color:var(--ok)}.bad{color:var(--bad)}
table{width:100%;border-collapse:collapse;font-size:13.5px;margin-top:8px}th,td{text-align:left;padding:6px 8px 6px 0;border-top:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:500;border-top:0}.r{text-align:right}.mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px}
ul{margin:8px 0 0;padding-left:18px}button{font:inherit;font-weight:600;background:var(--fg);color:var(--bg);border:0;border-radius:8px;padding:9px 14px;cursor:pointer}
</style></head><body><main>
<h1>Ops</h1>
<section class="card"><div class="row"><h2>Right now</h2><span class="pill ${health.ok ? "ok" : "bad"}">${health.ok ? "all good" : `${health.issues.length} issue${health.issues.length === 1 ? "" : "s"}`}</span></div>
  ${health.issues.length ? `<ul>${health.issues.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : `<p class="muted">Nothing needs you. The ops Worker checks this every five minutes and emails you when that changes.</p>`}
  <form method="post" action="/admin/ops/test-alert?key=${encodeURIComponent(o.adminKey)}" class="row" style="margin-top:12px">
    <span class="muted">${o.sent ? "Test alert set: an email should arrive within about ten minutes." : "Check alerts reach you: this shows as a problem for 15 minutes."}</span>
    <button type="submit">Send a test alert</button>
  </form>
</section>
<section class="card"><h2>Backups</h2><p class="muted">Every night after 3am Brisbane: each database and key file, encrypted, kept 35 days.</p>
  ${
    o.backups.length
      ? `<table><tr><th>Ran</th><th>Day</th><th>Result</th><th class="r">Files</th><th class="r">Size</th></tr>${o.backups
          .map((b) => `<tr><td>${esc(when(b.at))}</td><td>${esc(b.day)}</td><td class="${b.ok ? "ok" : "bad"}">${b.ok ? "ok" : esc(b.error)}</td><td class="r">${b.files}</td><td class="r">${b.ok ? kb(b.bytes) : ""}</td></tr>`)
          .join("")}</table>`
      : `<p class="muted">No backups yet.</p>`
  }
</section>
<section class="card"><h2>Problems</h2><p class="muted">Failures worth a look, newest first: POS calls after their retries, emails, refunds, venues.</p>
  ${
    o.problems.length
      ? `<table><tr><th>When</th><th>Venue</th><th>Kind</th><th>What happened</th><th>Order</th></tr>${o.problems
          .map((p) => `<tr><td>${esc(when(p.at))}</td><td>${esc(p.venue)}</td><td>${esc(p.kind)}</td><td>${esc(p.message)}</td><td class="mono">${esc(p.orderId ?? "")}</td></tr>`)
          .join("")}</table>`
      : `<p class="muted">None in the last 30 days.</p>`
  }
</section>
<h2 style="margin-top:10px">Venues</h2>
${venueRows}
</main></body></html>`;
}
