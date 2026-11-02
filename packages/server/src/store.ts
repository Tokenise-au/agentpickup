import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { CollectEvent, Order, OrderStatus } from "@agentpickup/core";

export interface StoredEmail {
  id: string;
  orderId: string;
  to: string;
  subject: string;
  html: string;
  at: number;
}

/** Swap this for Postgres, D1 or anything else; the server only uses these calls. */
export interface Store {
  insertOrder(order: Order): void;
  getOrder(id: string): Order | null;
  getOrderByPassId(passId: string): Order | null;
  getOrderByPickupCode(code: string): Order | null;
  updateOrder(id: string, patch: Partial<Order>): Order;
  /** Atomically move an order between states; returns null if it wasn't in `from`. */
  transition(id: string, from: OrderStatus[], to: OrderStatus, patch?: Partial<Order>): Order | null;
  listOrders(opts?: { statuses?: OrderStatus[]; limit?: number }): Order[];
  listExpirable(now: number): Order[];
  addEvent(event: CollectEvent): void;
  listEvents(orderId: string): CollectEvent[];
  saveEmail(email: StoredEmail): void;
  getLatestEmail(orderId: string): StoredEmail | null;
  /** Responses already sent for an Idempotency-Key, so a retried request gets the same answer. */
  getIdempotent(key: string): { status: number; body: string } | null;
  putIdempotent(key: string, status: number, body: string): void;
  /** Protocol sessions (UCP and ACP checkouts) as JSON documents. */
  getDoc<T>(kind: string, id: string): T | null;
  putDoc(kind: string, id: string, doc: unknown): void;
}

const COLUMNS: Record<keyof Order, string> = {
  id: "id",
  status: "status",
  rail: "rail",
  captureMode: "capture_mode",
  items: "items",
  totalCents: "total_cents",
  currency: "currency",
  customerEmail: "customer_email",
  customerName: "customer_name",
  paymentRef: "payment_ref",
  payer: "payer",
  passId: "pass_id",
  pickupCode: "pickup_code",
  collectBy: "collect_by",
  createdAt: "created_at",
  paidAt: "paid_at",
  readyAt: "ready_at",
  collectedAt: "collected_at",
  refundDue: "refund_due",
};

function toRow(order: Partial<Order>): Record<string, string | number | null> {
  const row: Record<string, string | number | null> = {};
  for (const [key, value] of Object.entries(order)) {
    const col = COLUMNS[key as keyof Order];
    if (!col) continue;
    if (key === "items") row[col] = JSON.stringify(value);
    else if (key === "refundDue") row[col] = value ? 1 : 0;
    else row[col] = (value ?? null) as string | number | null;
  }
  return row;
}

function fromRow(row: Record<string, unknown>): Order {
  return {
    id: row.id as string,
    status: row.status as OrderStatus,
    rail: row.rail as Order["rail"],
    captureMode: row.capture_mode as Order["captureMode"],
    items: JSON.parse(row.items as string),
    totalCents: Number(row.total_cents),
    currency: row.currency as string,
    customerEmail: (row.customer_email as string) ?? null,
    customerName: (row.customer_name as string) ?? null,
    paymentRef: (row.payment_ref as string) ?? null,
    payer: (row.payer as string) ?? null,
    passId: (row.pass_id as string) ?? null,
    pickupCode: (row.pickup_code as string) ?? null,
    collectBy: Number(row.collect_by),
    createdAt: Number(row.created_at),
    paidAt: row.paid_at == null ? null : Number(row.paid_at),
    readyAt: row.ready_at == null ? null : Number(row.ready_at),
    collectedAt: row.collected_at == null ? null : Number(row.collected_at),
    refundDue: Number(row.refund_due) === 1,
  };
}

export class SqliteStore implements Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS orders (
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
        collect_by INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        paid_at INTEGER,
        ready_at INTEGER,
        collected_at INTEGER,
        refund_due INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS orders_status ON orders (status, collect_by);
      CREATE INDEX IF NOT EXISTS orders_pickup_code ON orders (pickup_code);
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        type TEXT NOT NULL,
        at INTEGER NOT NULL,
        data TEXT
      );
      CREATE INDEX IF NOT EXISTS events_order ON events (order_id, at);
      CREATE TABLE IF NOT EXISTS emails (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        recipient TEXT NOT NULL,
        subject TEXT NOT NULL,
        html TEXT NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS emails_order ON emails (order_id, at);
      CREATE TABLE IF NOT EXISTS docs (
        kind TEXT NOT NULL,
        id TEXT NOT NULL,
        body TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (kind, id)
      );
      CREATE TABLE IF NOT EXISTS idempotency (
        key TEXT PRIMARY KEY,
        status INTEGER NOT NULL,
        body TEXT NOT NULL,
        at INTEGER NOT NULL
      );
    `);
  }

  insertOrder(order: Order): void {
    const row = toRow(order);
    const cols = Object.keys(row);
    this.db
      .prepare(`INSERT INTO orders (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
      .run(...cols.map((c) => row[c]));
  }

  getOrder(id: string): Order | null {
    const row = this.db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
    return row ? fromRow(row as Record<string, unknown>) : null;
  }

  getOrderByPassId(passId: string): Order | null {
    const row = this.db.prepare("SELECT * FROM orders WHERE pass_id = ?").get(passId);
    return row ? fromRow(row as Record<string, unknown>) : null;
  }

  getOrderByPickupCode(code: string): Order | null {
    const row = this.db
      .prepare("SELECT * FROM orders WHERE pickup_code = ? AND status IN ('paid','ready') ORDER BY created_at DESC LIMIT 1")
      .get(code.toUpperCase());
    return row ? fromRow(row as Record<string, unknown>) : null;
  }

  updateOrder(id: string, patch: Partial<Order>): Order {
    const row = toRow(patch);
    const cols = Object.keys(row);
    if (cols.length) {
      this.db
        .prepare(`UPDATE orders SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`)
        .run(...cols.map((c) => row[c]), id);
    }
    const order = this.getOrder(id);
    if (!order) throw new Error(`order ${id} not found`);
    return order;
  }

  transition(id: string, from: OrderStatus[], to: OrderStatus, patch: Partial<Order> = {}): Order | null {
    const row = toRow({ ...patch, status: to });
    const cols = Object.keys(row);
    const result = this.db
      .prepare(
        `UPDATE orders SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ? AND status IN (${from.map(() => "?").join(",")})`,
      )
      .run(...cols.map((c) => row[c]), id, ...from);
    return Number(result.changes) === 1 ? this.getOrder(id) : null;
  }

  listOrders(opts: { statuses?: OrderStatus[]; limit?: number } = {}): Order[] {
    const limit = opts.limit ?? 100;
    const rows = opts.statuses?.length
      ? this.db
          .prepare(
            `SELECT * FROM orders WHERE status IN (${opts.statuses.map(() => "?").join(",")}) ORDER BY created_at DESC LIMIT ?`,
          )
          .all(...opts.statuses, limit)
      : this.db.prepare("SELECT * FROM orders ORDER BY created_at DESC LIMIT ?").all(limit);
    return rows.map((r) => fromRow(r as Record<string, unknown>));
  }

  listExpirable(now: number): Order[] {
    return this.db
      .prepare("SELECT * FROM orders WHERE status IN ('awaiting_payment','paid','ready') AND collect_by < ?")
      .all(now)
      .map((r) => fromRow(r as Record<string, unknown>));
  }

  addEvent(event: CollectEvent): void {
    this.db
      .prepare("INSERT INTO events (id, order_id, type, at, data) VALUES (?, ?, ?, ?, ?)")
      .run(event.id, event.orderId, event.type, event.at, event.data ? JSON.stringify(event.data) : null);
  }

  listEvents(orderId: string): CollectEvent[] {
    return this.db
      .prepare("SELECT * FROM events WHERE order_id = ? ORDER BY at ASC")
      .all(orderId)
      .map((r) => {
        const row = r as Record<string, unknown>;
        return {
          id: row.id as string,
          orderId: row.order_id as string,
          type: row.type as CollectEvent["type"],
          at: Number(row.at),
          data: row.data ? JSON.parse(row.data as string) : undefined,
        };
      });
  }

  saveEmail(email: StoredEmail): void {
    this.db
      .prepare("INSERT INTO emails (id, order_id, recipient, subject, html, at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(email.id, email.orderId, email.to, email.subject, email.html, email.at);
  }

  getIdempotent(key: string): { status: number; body: string } | null {
    const row = this.db.prepare("SELECT status, body FROM idempotency WHERE key = ?").get(key) as
      | { status: number; body: string }
      | undefined;
    return row ? { status: Number(row.status), body: String(row.body) } : null;
  }

  putIdempotent(key: string, status: number, body: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO idempotency (key, status, body, at) VALUES (?, ?, ?, ?)")
      .run(key, status, body, Date.now());
  }

  getDoc<T>(kind: string, id: string): T | null {
    const row = this.db.prepare("SELECT body FROM docs WHERE kind = ? AND id = ?").get(kind, id) as { body: string } | undefined;
    return row ? (JSON.parse(row.body) as T) : null;
  }

  putDoc(kind: string, id: string, doc: unknown): void {
    this.db
      .prepare(
        "INSERT INTO docs (kind, id, body, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(kind, id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at",
      )
      .run(kind, id, JSON.stringify(doc), Date.now());
  }

  getLatestEmail(orderId: string): StoredEmail | null {
    const row = this.db.prepare("SELECT * FROM emails WHERE order_id = ? ORDER BY at DESC LIMIT 1").get(orderId) as
      | Record<string, unknown>
      | undefined;
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
}
