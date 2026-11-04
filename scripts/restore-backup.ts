// Brings a night's backup back from the ops Worker into a folder, checks every file against the manifest and
// every database with SQLite's integrity check, and prints what's in each. It never touches the live data: to
// put a restore live, stop the service and copy the files into its data folder (/data on Railway).
//   node --conditions=source --import tsx scripts/restore-backup.ts [--day 2026-11-05] [--out ./restored] [--env <file>]
// OPS_URL, OPS_KEY and BACKUP_KEY come from ~/.agentpickup/ops.env unless --env names another file.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { backupKeyFrom, openBackup, sha256, type BackupManifest } from "../apps/demo/src/ops.js";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const envFile = arg("env") ?? join(homedir(), ".agentpickup", "ops.env");
const env = Object.fromEntries(
  readFileSync(envFile, "utf8")
    .split(/\r?\n/)
    .filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
for (const name of ["OPS_URL", "OPS_KEY", "BACKUP_KEY"]) if (!env[name]) throw new Error(`${name} is missing from ${envFile}.`);
const key = backupKeyFrom(env.BACKUP_KEY);
const auth = { Authorization: `Bearer ${env.OPS_KEY}` };

async function get(path: string): Promise<Buffer> {
  const res = await fetch(`${env.OPS_URL.replace(/\/$/, "")}${path}`, { headers: auth });
  if (!res.ok) throw new Error(`GET ${path} answered ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const { keys } = JSON.parse((await get("/backups")).toString()) as { keys: { key: string }[] };
const days = keys.filter((k) => k.key.endsWith("/manifest.json")).map((k) => k.key.split("/")[0]).sort();
if (!days.length) throw new Error("The ops Worker has no complete backups yet.");
const day = arg("day") ?? days.at(-1)!;
if (!days.includes(day)) throw new Error(`No complete backup for ${day}. There are: ${days.join(", ")}`);
const out = resolve(arg("out") ?? join("restored", day));
const manifest = JSON.parse((await get(`/backups/${day}/manifest.json`)).toString()) as BackupManifest;
console.log(`Backup of ${day}, taken ${new Date(manifest.at).toISOString()}: ${manifest.files.length} files. Restoring to ${out}\n`);

let bad = 0;
for (const f of manifest.files) {
  const parts: Buffer[] = [];
  for (let i = 0; i < f.parts; i++) parts.push(await get(`/backups/${day}/${f.path}.enc${f.parts > 1 ? `.part${i}` : ""}`));
  const plain = openBackup(Buffer.concat(parts), key);
  const matches = sha256(plain) === f.sha256 && plain.length === f.bytes;
  const target = join(out, f.path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, plain);
  let detail = `${(plain.length / 1024).toFixed(0)} KB`;
  if (f.path.endsWith(".db")) {
    const db = new DatabaseSync(target, { readOnly: true });
    const integrity = (db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
    const counts = tables.map((t) => `${t} ${(db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n}`);
    db.close();
    if (integrity !== "ok") bad++;
    detail += `, integrity ${integrity}: ${counts.join(", ")}`;
  }
  if (!matches) bad++;
  console.log(`${matches ? "ok  " : "BAD "} ${f.path}  ${detail}`);
}
console.log(bad ? `\n${bad} file(s) failed their checks.` : `\nAll ${manifest.files.length} files match the manifest and every database passes its integrity check.`);
process.exit(bad ? 1 : 0);
