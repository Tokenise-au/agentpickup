// Group orders: one person starts a coffee run with a closing time, and everyone's agent adds their own items and
// pays for them, straight to the shop. At closing time the paid shares become one combined order: one pickup on
// the shop's screens, each line marked for whom, and one QR for whoever collects. Unpaid shares are left out.
// agentPickup never holds anyone's money: each share is an ordinary paid order of its own.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Hono } from "hono";
import { newId, newPickupCode, type CollectEventType, type Order } from "@agentpickup/core";
import type { OrderInput } from "./protocol.js";
import type { Store } from "./store.js";

export interface GroupOrder {
  id: string;
  /** What people tell their agents to join: "K7QX4M". */
  code: string;
  title: string;
  status: "open" | "sent" | "cancelled";
  organiser: { name: string; email: string };
  organiserKeyHash: string;
  createdAt: number;
  closesAt: number;
  closedAt: number | null;
  /** Each person's share, as its own order. */
  members: string[];
  /** The order the shop makes and hands over, once the group closes. */
  combinedOrderId: string | null;
}

export class GroupError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 = 400,
  ) {
    super(message);
  }
}

export interface GroupDeps {
  store: Store;
  base: string;
  currency: string;
  /** How long a combined order stays collectable. */
  windowMs: number;
  /** The rails a share can be paid on: agent payments. */
  rails: { x402: boolean; test: boolean };
  createOrder(input: OrderInput): Promise<Order>;
  markPaid(orderId: string, payment: { paymentRef: string }): Promise<Order>;
  emit(type: CollectEventType, order: Order, data?: Record<string, unknown>): Promise<void>;
  /** Email the combined order's pass to the organiser, as the shop emails any order. */
  emailCombined(order: Order): Promise<void>;
  freshPickupCode(): Promise<string>;
  passUrl(order: Order): string;
  publicOrder(order: Order): Record<string, unknown>;
}

const MAX_MEMBERS = 30;
const hash = (key: string) => createHash("sha256").update(`agentpickup-group:${key}`).digest("hex");
const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const describeItems = (o: Order) => o.items.map((i) => `${i.qty}× ${i.name}`).join(", ");

export function createGroups(deps: GroupDeps) {
  const { store } = deps;
  // One change at a time per group, so two people joining at once both land.
  const locks = new Map<string, Promise<unknown>>();
  function locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const run = (locks.get(id) ?? Promise.resolve()).then(fn, fn);
    locks.set(id, run.catch(() => undefined));
    return run;
  }

  const load = async (id: string) => (await store.getDoc<GroupOrder>("group", id)) ?? null;
  const save = (g: GroupOrder) => store.putDoc("group", g.id, g);
  async function byCode(code: string) {
    const ref = await store.getDoc<{ id: string }>("group-code", code.trim().toUpperCase());
    const g = ref ? await load(ref.id) : null;
    if (!g) throw new GroupError("No group order with that code here.", 404);
    return g;
  }
  async function openIds() {
    return (await store.getDoc<{ ids: string[] }>("groups", "open"))?.ids ?? [];
  }

  /** The group an order is a share of, if any. */
  async function memberOf(orderId: string): Promise<GroupOrder | null> {
    const ref = await store.getDoc<{ groupId: string }>("group-of", orderId);
    return ref ? load(ref.groupId) : null;
  }

  async function start(input: { title?: string; closesInMinutes?: number; name?: string; email?: string }) {
    const email = String(input.email ?? "").trim();
    const name = String(input.name ?? "").trim().slice(0, 60);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new GroupError("The organiser's email is needed: the group's pickup QR goes there.");
    if (!name) throw new GroupError("The organiser's name is needed, so staff know who's collecting.");
    const minutes = input.closesInMinutes ?? 15;
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 240) throw new GroupError("A group order closes in 5 to 240 minutes.");
    if (!deps.rails.x402 && !deps.rails.test) throw new GroupError("This shop doesn't take agent payments, so it can't run group orders.", 409);
    let code = newPickupCode(6);
    for (let i = 0; i < 5 && (await store.getDoc("group-code", code)); i++) code = newPickupCode(6);
    const organiserKey = randomBytes(18).toString("base64url");
    const now = Date.now();
    const g: GroupOrder = {
      id: newId("grp"),
      code,
      title: (String(input.title ?? "").trim() || `${name}'s order`).slice(0, 60),
      status: "open",
      organiser: { name, email },
      organiserKeyHash: hash(organiserKey),
      createdAt: now,
      closesAt: now + minutes * 60_000,
      closedAt: null,
      members: [],
      combinedOrderId: null,
    };
    await save(g);
    await store.putDoc("group-code", code, { id: g.id });
    await store.putDoc("groups", "open", { ids: [...(await openIds()), g.id] });
    return { group: g, organiserKey };
  }

  /** Someone's agent adds their items to the group and pays for them. */
  async function join(code: string, input: OrderInput) {
    const g = await byCode(code);
    if (g.status !== "open" || Date.now() >= g.closesAt) throw new GroupError("This group order has closed.", 409);
    if (g.members.length >= MAX_MEMBERS) throw new GroupError(`A group order takes up to ${MAX_MEMBERS} people.`, 409);
    if (input.rail !== "x402" && input.rail !== "test") throw new GroupError("Each share is paid by agent: x402, or a test payment at a test shop.");
    const order = await deps.createOrder({ ...input, name: input.name?.trim() || "Guest" });
    await locked(g.id, async () => {
      const fresh = (await load(g.id))!;
      if (fresh.status !== "open") throw new GroupError("This group order has closed.", 409);
      await store.putDoc("group-of", order.id, { groupId: g.id });
      await save({ ...fresh, members: [...fresh.members, order.id] });
      // Unpaid shares are dropped when the group closes, not an hour later.
      await store.updateOrder(order.id, { collectBy: fresh.closesAt });
    });
    if (input.rail === "test") return { group: g, order: await deps.markPaid(order.id, { paymentRef: `test_${order.id}` }) };
    return { group: g, order: (await store.getOrder(order.id))! };
  }

  /**
   * Close the group: drop unpaid shares, and turn the paid ones into one combined order for the shop, with the
   * pickup QR emailed to the organiser. With nothing paid, the group is cancelled.
   */
  function close(id: string) {
    return locked(id, async () => {
      const g = await load(id);
      if (!g || g.status !== "open") return g;
      const paid: Order[] = [];
      for (const memberId of g.members) {
        const o = await store.getOrder(memberId);
        if (!o) continue;
        if (o.status === "awaiting_payment") {
          const dropped = await store.transition(o.id, ["awaiting_payment"], "cancelled");
          if (dropped) await deps.emit("order.cancelled", dropped, { reason: "group closed", groupMember: g.id });
        } else if (o.status === "paid") paid.push(o);
      }
      const now = Date.now();
      await store.putDoc("groups", "open", { ids: (await openIds()).filter((x) => x !== g.id) });
      if (!paid.length) {
        const cancelled = { ...g, status: "cancelled" as const, closedAt: now };
        await save(cancelled);
        return cancelled;
      }
      const combined: Order = {
        id: newId("ord"),
        status: "paid",
        rail: "group",
        captureMode: "charge",
        items: paid.flatMap((o) => o.items.map((i) => ({ ...i, note: `for ${o.customerName ?? "Guest"}` }))),
        totalCents: paid.reduce((sum, o) => sum + o.totalCents, 0),
        currency: deps.currency,
        customerEmail: g.organiser.email,
        customerName: `${g.title} (${g.organiser.name})`,
        paymentRef: `group:${g.id}`,
        payer: null,
        passId: randomBytes(12).toString("base64url"),
        pickupCode: await deps.freshPickupCode(),
        collectBy: now + deps.windowMs,
        createdAt: now,
        paidAt: now,
        readyAt: null,
        collectedAt: null,
        refundDue: false,
        usdCents: null,
      };
      await store.insertOrder(combined);
      // Each share now lasts as long as the combined order, and expires (with any refund) when it does.
      for (const o of paid) await store.updateOrder(o.id, { collectBy: combined.collectBy });
      const sent: GroupOrder = { ...g, status: "sent", closedAt: now, combinedOrderId: combined.id };
      await save(sent);
      await deps.emit("order.paid", combined, { group: g.id, people: paid.length });
      await deps.emailCombined(combined);
      return sent;
    });
  }

  /** The combined order was marked ready or handed over: so were everyone's shares. */
  async function followCombined(combined: Order, to: "ready" | "collected") {
    if (combined.rail !== "group" || !combined.paymentRef?.startsWith("group:")) return;
    const g = await load(combined.paymentRef.slice("group:".length));
    if (!g) return;
    const now = Date.now();
    for (const memberId of g.members) {
      const moved =
        to === "ready"
          ? await store.transition(memberId, ["paid"], "ready", { readyAt: now })
          : await store.transition(memberId, ["paid", "ready"], "collected", { collectedAt: now });
      if (moved) await deps.emit(to === "ready" ? "order.ready" : "order.collected", moved, { groupMember: g.id });
    }
  }

  /** Close groups whose time is up. Runs with the shop's sweep. */
  async function sweep(now = Date.now()) {
    for (const id of await openIds()) {
      const g = await load(id);
      if (g?.status === "open" && now >= g.closesAt) await close(id).catch((err) => console.error(`[collect] closing group ${id} failed:`, err));
    }
  }

  /** A group as anyone with its code sees it: names and items, never emails. */
  async function view(g: GroupOrder) {
    const members = [];
    let paidCents = 0;
    for (const id of g.members) {
      const o = await store.getOrder(id);
      if (!o) continue;
      const paid = ["paid", "ready", "collected"].includes(o.status);
      if (paid) paidCents += o.totalCents;
      members.push({ name: o.customerName ?? "Guest", items: describeItems(o), totalCents: o.totalCents, status: o.status });
    }
    const combined = g.combinedOrderId ? await store.getOrder(g.combinedOrderId) : null;
    return {
      code: g.code,
      title: g.title,
      status: g.status,
      organiser: g.organiser.name,
      closesAt: g.closesAt,
      members,
      paidCents,
      currency: deps.currency,
      combined: combined ? { status: combined.status, collectBy: combined.collectBy } : null,
      join: { method: "POST", url: `${deps.base}/api/groups/${g.code}/orders` },
    };
  }

  function routes(app: Hono) {
    app.post("/api/groups", async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { title?: string; closesInMinutes?: number; name?: string; email?: string };
      const { group, organiserKey } = await start(body);
      return c.json({ group: await view(group), organiserKey, note: "Share the code. Keep organiserKey: it closes the group early." }, 201);
    });
    app.get("/api/groups/:code", async (c) => c.json({ group: await view(await byCode(c.req.param("code"))) }));
    app.post("/api/groups/:code/orders", async (c) => {
      const input = (await c.req.json().catch(() => null)) as OrderInput | null;
      if (!input) throw new GroupError("Send JSON: { items, email, name, rail }.");
      const { group, order } = await join(c.req.param("code"), input);
      const next =
        order.status === "awaiting_payment"
          ? { type: "x402", method: "POST", url: `${deps.base}/api/orders/${order.id}/pay`, note: `Pay before ${new Date(group.closesAt).toISOString()}, when the group closes.` }
          : { type: "done", note: `Paid. ${group.organiser.name} collects the group's order.` };
      return c.json({ order: deps.publicOrder(order), group: await view((await load(group.id))!), next }, 201);
    });
    app.post("/api/groups/:code/close", async (c) => {
      const g = await byCode(c.req.param("code"));
      const { organiserKey } = (await c.req.json().catch(() => ({}))) as { organiserKey?: string };
      if (typeof organiserKey !== "string" || !safeEqual(hash(organiserKey), g.organiserKeyHash)) {
        throw new GroupError("Only the organiser can close the group early.", 403);
      }
      return c.json({ group: await view((await close(g.id))!) });
    });
  }

  return { start, join, close, memberOf, followCombined, sweep, view, byCode, routes };
}

export type Groups = ReturnType<typeof createGroups>;
