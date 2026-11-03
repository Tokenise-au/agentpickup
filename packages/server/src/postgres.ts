// A Postgres store, for shops that run more than one server or want their database's backups. It takes
// anything with a pg-style query(text, params) method (a pg Pool, a Neon or Supabase client, PGlite), so
// the package doesn't depend on a driver. Tables are prefixed so they can live beside an app's own.
import type { CollectEvent, Order, OrderStatus } from "@agentpickup/core";
import { fromRow, toRow, type Store, type StoredEmail } from "./store.js";

export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface PostgresStoreOptions {
  /** Table name prefix. Default "pickup_", giving pickup_orders, pickup_events and so on. */
  prefix?: string;
}

export class PostgresStore implements Store {
  private readonly t: { orders: string; events: string; emails: string; docs: string; idem: string };
  private readonly ready: Promise<void>;

  constructor(
    private readonly db: Queryable,
    opts: PostgresStoreOptions = {},
  ) {
    const prefix = opts.prefix ?? "pickup_";
    if (!/^[a-z_][a-z0-9_]*$/.test(prefix)) throw new Error("The table prefix may use lower-case letters, digits and _ only.");
    this.t = {
      orders: `${prefix}orders`,
      events: `${prefix}events`,
      emails: `${prefix}emails`,
      docs: `${prefix}docs`,
      idem: `${prefix}idempotency`,
    };
    this.ready = this.migrate();
    // Surface a failed migration on first use, not as an unhandled rejection at startup.
    this.ready.catch(() => undefined);
  }

  private async migrate() {
    const { orders, events, emails, docs, idem } = this.t;
    const statements = [
      `CREATE TABLE IF NOT EXISTS ${orders} (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        rail TEXT NOT NULL,
        capture_mode TEXT NOT NULL,
        items TEXT NOT NULL,
        total_cents INTEGER NOT NULL,
        currency TEXT NOT NULL,
        customer_email TEXT,
        customer_name TEXT,
        payment_ref TEXT,
        payer TEXT,
        pass_id TEXT UNIQUE,
        pickup_code TEXT,
        collect_by BIGINT NOT NULL,
        created_at BIGINT NOT NULL,
        paid_at BIGINT,
        ready_at BIGINT,
        collected_at BIGINT,
        refund_due INTEGER NOT NULL DEFAULT 0,
        usd_cents INTEGER
      )`,
      // Columns added after 0.1, for tables made before them.
      `ALTER TABLE ${orders} ADD COLUMN IF NOT EXISTS usd_cents INTEGER`,
      `CREATE INDEX IF NOT EXISTS ${orders}_status ON ${orders} (status, collect_by)`,
      `CREATE INDEX IF NOT EXISTS ${orders}_pickup_code ON ${orders} (pickup_code)`,
      // seq keeps insertion order for rows written in the same millisecond.
      `CREATE TABLE IF NOT EXISTS ${events} (
        seq BIGSERIAL,
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        type TEXT NOT NULL,
        at BIGINT NOT NULL,
        data TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS ${events}_order ON ${events} (order_id, at, seq)`,
      `CREATE TABLE IF NOT EXISTS ${emails} (
        seq BIGSERIAL,
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        recipient TEXT NOT NULL,
        subject TEXT NOT NULL,
        html TEXT NOT NULL,
        at BIGINT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS ${emails}_order ON ${emails} (order_id, at, seq)`,
      `CREATE TABLE IF NOT EXISTS ${docs} (
        kind TEXT NOT NULL,
        id TEXT NOT NULL,
        body TEXT NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (kind, id)
      )`,
      `CREATE TABLE IF NOT EXISTS ${idem} (
        key TEXT PRIMARY KEY,
        status INTEGER NOT NULL,
        body TEXT NOT NULL,
        at BIGINT NOT NULL
      )`,
    ];
    for (const sql of statements) await this.db.query(sql);
  }

  private async q(text: string, params: unknown[] = []) {
    await this.ready;
    return (await this.db.query(text, params)).rows;
  }

  private async one(text: string, params: unknown[] = []): Promise<Order | null> {
    const [row] = await this.q(text, params);
    return row ? fromRow(row) : null;
  }

  async insertOrder(order: Order): Promise<void> {
    const row = toRow(order);
    const cols = Object.keys(row);
    await this.q(
      `INSERT INTO ${this.t.orders} (${cols.join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")})`,
      cols.map((c) => row[c]),
    );
  }

  getOrder(id: string) {
    return this.one(`SELECT * FROM ${this.t.orders} WHERE id = $1`, [id]);
  }

  getOrderByPassId(passId: string) {
    return this.one(`SELECT * FROM ${this.t.orders} WHERE pass_id = $1`, [passId]);
  }

  getOrderByPickupCode(code: string) {
    return this.one(
      `SELECT * FROM ${this.t.orders} WHERE pickup_code = $1 AND status IN ('paid','ready') ORDER BY created_at DESC LIMIT 1`,
      [code.toUpperCase()],
    );
  }

  async updateOrder(id: string, patch: Partial<Order>): Promise<Order> {
    const row = toRow(patch);
    const cols = Object.keys(row);
    const order = cols.length
      ? await this.one(
          `UPDATE ${this.t.orders} SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(", ")} WHERE id = $${cols.length + 1} RETURNING *`,
          [...cols.map((c) => row[c]), id],
        )
      : await this.getOrder(id);
    if (!order) throw new Error(`order ${id} not found`);
    return order;
  }

  /** One UPDATE ... WHERE status IN (...): two servers racing on the same order can't both win. */
  transition(id: string, from: OrderStatus[], to: OrderStatus, patch: Partial<Order> = {}) {
    const row = toRow({ ...patch, status: to });
    const cols = Object.keys(row);
    const n = cols.length;
    return this.one(
      `UPDATE ${this.t.orders} SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(", ")}
       WHERE id = $${n + 1} AND status IN (${from.map((_, i) => `$${n + 2 + i}`).join(",")}) RETURNING *`,
      [...cols.map((c) => row[c]), id, ...from],
    );
  }

  async listOrders(opts: { statuses?: OrderStatus[]; limit?: number } = {}): Promise<Order[]> {
    const limit = opts.limit ?? 100;
    const rows = opts.statuses?.length
      ? await this.q(
          `SELECT * FROM ${this.t.orders} WHERE status IN (${opts.statuses.map((_, i) => `$${i + 1}`).join(",")})
           ORDER BY created_at DESC LIMIT $${opts.statuses.length + 1}`,
          [...opts.statuses, limit],
        )
      : await this.q(`SELECT * FROM ${this.t.orders} ORDER BY created_at DESC LIMIT $1`, [limit]);
    return rows.map(fromRow);
  }

  async listExpirable(now: number): Promise<Order[]> {
    const rows = await this.q(
      `SELECT * FROM ${this.t.orders} WHERE status IN ('awaiting_payment','paid','ready') AND collect_by < $1`,
      [now],
    );
    return rows.map(fromRow);
  }

  async addEvent(event: CollectEvent): Promise<void> {
    await this.q(`INSERT INTO ${this.t.events} (id, order_id, type, at, data) VALUES ($1, $2, $3, $4, $5)`, [
      event.id,
      event.orderId,
      event.type,
      event.at,
      event.data ? JSON.stringify(event.data) : null,
    ]);
  }

  async listEvents(orderId: string): Promise<CollectEvent[]> {
    const rows = await this.q(`SELECT * FROM ${this.t.events} WHERE order_id = $1 ORDER BY at ASC, seq ASC`, [orderId]);
    return rows.map((row) => ({
      id: row.id as string,
      orderId: row.order_id as string,
      type: row.type as CollectEvent["type"],
      at: Number(row.at),
      data: row.data ? JSON.parse(row.data as string) : undefined,
    }));
  }

  async saveEmail(email: StoredEmail): Promise<void> {
    await this.q(
      `INSERT INTO ${this.t.emails} (id, order_id, recipient, subject, html, at) VALUES ($1, $2, $3, $4, $5, $6)`,
      [email.id, email.orderId, email.to, email.subject, email.html, email.at],
    );
  }

  async getLatestEmail(orderId: string): Promise<StoredEmail | null> {
    const [row] = await this.q(
      `SELECT * FROM ${this.t.emails} WHERE order_id = $1 ORDER BY at DESC, seq DESC LIMIT 1`,
      [orderId],
    );
    if (!row) return null;
    return {
      id: row.id as string,
      orderId: row.order_id as string,
      to: row.recipient as string,
      subject: row.subject as string,
      html: row.html as string,
      at: Number(row.at),
    };
  }

  async getIdempotent(key: string): Promise<{ status: number; body: string } | null> {
    const [row] = await this.q(`SELECT status, body FROM ${this.t.idem} WHERE key = $1`, [key]);
    return row ? { status: Number(row.status), body: String(row.body) } : null;
  }

  async putIdempotent(key: string, status: number, body: string): Promise<void> {
    await this.q(
      `INSERT INTO ${this.t.idem} (key, status, body, at) VALUES ($1, $2, $3, $4) ON CONFLICT (key) DO NOTHING`,
      [key, status, body, Date.now()],
    );
  }

  async getDoc<T>(kind: string, id: string): Promise<T | null> {
    const [row] = await this.q(`SELECT body FROM ${this.t.docs} WHERE kind = $1 AND id = $2`, [kind, id]);
    return row ? (JSON.parse(row.body as string) as T) : null;
  }

  async putDoc(kind: string, id: string, doc: unknown): Promise<void> {
    await this.q(
      `INSERT INTO ${this.t.docs} (kind, id, body, updated_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (kind, id) DO UPDATE SET body = EXCLUDED.body, updated_at = EXCLUDED.updated_at`,
      [kind, id, JSON.stringify(doc), Date.now()],
    );
  }
}
