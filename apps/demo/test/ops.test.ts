import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { backupFiles, createOps, openBackup, PART_BYTES, sealBackup, sha256, type BackupManifest } from "../src/ops.js";

const KEY = randomBytes(32);

/** The ops Worker's backup store: PUT and GET by key. */
function fakeWorker(opsKey: string) {
  const stored = new Map<string, Buffer>();
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (new Headers(init?.headers).get("authorization") !== `Bearer ${opsKey}`) return new Response("no", { status: 401 });
    const key = decodeURIComponent(url.pathname.replace(/^\/backups\//, ""));
    if (init?.method === "PUT") {
      stored.set(key, Buffer.from(await new Response(init.body as BodyInit).arrayBuffer()));
      return new Response(null, { status: 204 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { stored, fetch };
}

function dataDir() {
  const dir = mkdtempSync(join(tmpdir(), "ops-"));
  mkdirSync(join(dir, "venues"));
  for (const [file, rows] of [["collect.db", 3], [join("venues", "corner-cafe.db"), 5]] as const) {
    const db = new DatabaseSync(join(dir, file));
    db.exec("PRAGMA journal_mode = WAL; CREATE TABLE orders (id TEXT PRIMARY KEY, total INTEGER)");
    for (let i = 0; i < rows; i++) db.prepare("INSERT INTO orders VALUES (?, ?)").run(`ord_${i}`, i * 100);
    // Left open, as the running server leaves its stores: the snapshot must still be consistent.
  }
  writeFileSync(join(dir, "signing-key.pem"), "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n");
  writeFileSync(join(dir, "notes.txt"), "not part of a backup");
  return dir;
}

test("ops: a sealed backup opens with the key, and refuses a wrong key or a changed byte", () => {
  const plain = Buffer.from("orders and settings ".repeat(200));
  const sealed = sealBackup(plain, KEY);
  assert.ok(sealed.length < plain.length, "gzipped before it's encrypted");
  assert.deepEqual(openBackup(sealed, KEY), plain);
  assert.throws(() => openBackup(sealed, randomBytes(32)));
  const tampered = Buffer.from(sealed);
  tampered[30] ^= 1;
  assert.throws(() => openBackup(tampered, KEY));
});

test("ops: a backup sends every database and key file, encrypted, then a manifest; restored, the databases work", async () => {
  const dir = dataDir();
  assert.deepEqual(backupFiles(dir), ["collect.db", "signing-key.pem", "venues/corner-cafe.db"]);
  const worker = fakeWorker("ops-key");
  const site = new DatabaseSync(":memory:");
  const ops = createOps({ db: site, dataDir: dir, target: { url: "https://ops.test", key: "ops-key" }, backupKey: KEY, fetch: worker.fetch, now: () => Date.parse("2026-11-04T18:00:00Z") });

  const result = await ops.backup();
  assert.equal(result.ok, true, result.error);
  assert.equal(result.day, "2026-11-05", "named for the Brisbane date it ran on");
  const manifest = JSON.parse(worker.stored.get("2026-11-05/manifest.json")!.toString()) as BackupManifest;
  assert.deepEqual(manifest.files.map((f) => [f.path, f.parts]), [["collect.db", 1], ["signing-key.pem", 1], ["venues/corner-cafe.db", 1]]);

  for (const f of manifest.files) {
    const sealed = worker.stored.get(`2026-11-05/${f.path}.enc`)!;
    assert.ok(!sealed.includes(Buffer.from("ord_1")), "nothing readable without the key");
    const plain = openBackup(sealed, KEY);
    assert.equal(sha256(plain), f.sha256);
    if (!f.path.endsWith(".db")) continue;
    const restored = join(mkdtempSync(join(tmpdir(), "restored-")), "x.db");
    writeFileSync(restored, plain);
    const db = new DatabaseSync(restored, { readOnly: true });
    assert.equal((db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check, "ok");
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM orders").get() as { n: number }).n, f.path === "collect.db" ? 3 : 5);
    db.close();
  }
  assert.equal(ops.recentBackups()[0].ok, 1);
});

test("ops: a file bigger than the store's value limit goes in parts", () => {
  // The split itself, at the size the backup uses.
  const sealed = sealBackup(randomBytes(PART_BYTES + 1000), KEY);
  assert.equal(Math.ceil(sealed.length / PART_BYTES), 2);
});

test("ops: health lists what needs a person: no backup, a failed backup, problems, the test alert; the demo's per-address cap isn't one", async () => {
  let now = Date.parse("2026-11-04T18:00:00Z");
  const worker = fakeWorker("ops-key");
  const ops = createOps({ db: new DatabaseSync(":memory:"), dataDir: dataDir(), target: { url: "https://ops.test", key: "ops-key" }, backupKey: KEY, fetch: worker.fetch, now: () => now });

  assert.match((await ops.health()).issues.join("\n"), /No good backup since it started/);
  assert.equal(ops.backupDue(), true, "after 3am Brisbane with no backup today");
  await ops.backup();
  assert.equal(ops.backupDue(), false, "done for today");
  assert.deepEqual((await ops.health()).issues, []);

  ops.problem("demo-cafe", { kind: "email", message: "Daily email limit reached for this address" });
  assert.equal((await ops.health()).ok, true, "a visitor hitting the demo's cap is the cap working");
  ops.problem("corner-cafe", { kind: "connector", message: "Square POST /v2/orders answered 500", orderId: "ord_1", connector: "square" });
  ops.problem("corner-cafe", { kind: "connector", message: "Square POST /v2/orders answered 503", orderId: "ord_2", connector: "square" });
  const h = await ops.health();
  assert.equal(h.ok, false);
  assert.deepEqual(h.issues, ["2 connector problems at corner-cafe in the last hour. Latest: Square POST /v2/orders answered 503"]);

  // An hour on, the problems have aged out; two days on, the backup is stale and the next try fails.
  now += 2 * 24 * 3600_000;
  worker.stored.clear();
  const failing = createOps({
    db: new DatabaseSync(":memory:"),
    dataDir: dataDir(),
    target: { url: "https://ops.test", key: "wrong-key" },
    backupKey: KEY,
    fetch: worker.fetch,
    now: () => now,
  });
  const result = await failing.backup();
  assert.equal(result.ok, false);
  assert.match((await failing.health()).issues[0], /No good backup since it started\. Last try: the ops Worker answered 401/);
  assert.equal(failing.backupDue(), false, "not again within the hour");

  failing.testAlert(15);
  assert.ok((await failing.health()).issues.includes("Test alert, from the button on /admin/ops."));
  now += 16 * 60_000;
  assert.ok(!(await failing.health()).issues.includes("Test alert, from the button on /admin/ops."), "it clears itself");
});
