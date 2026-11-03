(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
  };
  const clock = (ms) =>
    ms ? new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "--:--:--";

  // ---------- hero: decorative QR and a looping event log ----------
  (function heroQr() {
    const el = $("heroQr");
    let seed = 5;
    const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
    const finder = (y, x) => {
      for (const [a, b] of [[0, 0], [0, 14], [14, 0]]) {
        const v = y - a, u = x - b;
        if (v >= 0 && v < 7 && u >= 0 && u < 7) return v === 0 || v === 6 || u === 0 || u === 6 || (v > 1 && v < 5 && u > 1 && u < 5) ? 1 : 0;
      }
      return -1;
    };
    let html = "";
    for (let y = 0; y < 21; y++) for (let x = 0; x < 21; x++) {
      const f = finder(y, x);
      html += (f === -1 ? rnd() > 0.52 : f === 1) ? "<i></i>" : "<b></b>";
    }
    el.innerHTML = html;
  })();

  (function heroLog() {
    const lines = [...document.querySelectorAll("#heroLog > div")];
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return lines.forEach((l) => l.classList.add("on"));
    let i = 0;
    const step = () => {
      if (i < lines.length) {
        lines[i++].classList.add("on");
        setTimeout(step, 900);
      } else {
        setTimeout(() => {
          lines.forEach((l) => l.classList.remove("on"));
          i = 0;
          setTimeout(step, 700);
        }, 4500);
      }
    };
    setTimeout(step, 400);
  })();

  $("copyInstall").onclick = async (e) => {
    const btn = e.currentTarget;
    const text = btn.textContent;
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = "copied ✓";
    } catch {
      btn.textContent = "select and copy";
    }
    setTimeout(() => (btn.textContent = text), 1400);
  };

  // ---------- demo shop ----------
  let catalog = null;
  let demoAgent = null;
  const cart = new Map();
  let orderId = store.get("demoOrderId");
  let poll = null;
  let emailShownFor = null;

  const money = (cents) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: (catalog?.currency ?? "usd").toUpperCase() }).format(cents / 100);

  async function api(path, body) {
    const res = await fetch(path, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }

  function renderMenu() {
    $("menu").innerHTML = catalog.items
      .map(
        (i) => `<div class="item">
          <div><div class="item-name">${esc(i.name)}</div><div class="item-desc">${esc(i.description || "")}</div></div>
          <div class="item-price">${money(i.priceCents)}</div>
          <div class="qty" data-id="${esc(i.id)}">
            <button type="button" data-d="-1" aria-label="Remove one ${esc(i.name)}">−</button>
            <span>${cart.get(i.id) || 0}</span>
            <button type="button" data-d="1" aria-label="Add one ${esc(i.name)}">+</button>
          </div>
        </div>`,
      )
      .join("");
    $("menu").querySelectorAll(".qty button").forEach((b) => {
      b.onclick = () => {
        const id = b.parentElement.dataset.id;
        const next = Math.max(0, Math.min(9, (cart.get(id) || 0) + Number(b.dataset.d)));
        next ? cart.set(id, next) : cart.delete(id);
        renderMenu();
      };
    });
    const total = catalog.items.reduce((s, i) => s + (cart.get(i.id) || 0) * i.priceCents, 0);
    $("total").textContent = money(total);
    document.querySelectorAll("[data-pay]").forEach((b) => (b.disabled = total === 0));
  }

  function renderPayButtons() {
    const p = catalog.payments;
    const rows = [];
    if (p.card) rows.push(`<button class="btn btn-white" data-pay="card">Pay by card</button><p class="pay-note">stripe test mode · 4242 4242 4242 4242 · any future date · any cvc</p>`);
    if (p.test) rows.push(`<button class="btn ${p.card ? "btn-outline" : "btn-lime"}" data-pay="test">Instant test payment</button>`);
    if (p.x402) rows.push(`<button class="btn btn-outline" data-pay="x402">Pay as an AI agent (x402)</button>`);
    $("payRow").innerHTML = rows.join("");
    document.querySelectorAll("[data-pay]").forEach((b) => (b.onclick = () => placeOrder(b.dataset.pay)));
  }

  async function placeOrder(rail) {
    $("orderError").textContent = "";
    const items = [...cart].map(([id, qty]) => ({ id, qty }));
    const email = $("email").value.trim();
    if (!email && rail !== "card") {
      $("orderError").textContent = "Add an email so there's somewhere to send the QR. It's only shown on this page.";
      $("email").focus();
      return;
    }
    document.querySelectorAll("[data-pay]").forEach((b) => (b.disabled = true));
    const { ok, data } = await api("/api/orders", { items, email: email || undefined, name: $("name").value.trim() || undefined, rail });
    document.querySelectorAll("[data-pay]").forEach((b) => (b.disabled = false));
    if (!ok) {
      $("orderError").textContent = data.error || "Something went wrong.";
      return;
    }
    if (data.next.type === "redirect") {
      store.set("demoOrderId", data.order.id);
      location.href = data.next.url;
      return;
    }
    if (data.next.type === "x402") return showAgent(data, email);
    startFlow(data.order.id, { scroll: true });
  }

  async function showAgent(data, email) {
    const box = $("agentBox");
    box.classList.remove("hidden");
    box.innerHTML = `<span class="mono muted small">asking the pay link for its price…</span>`;
    const pay = await fetch(data.next.url, { method: "POST" });
    let reqs = null;
    try {
      const header = pay.headers.get("PAYMENT-REQUIRED");
      reqs = header ? JSON.parse(atob(header)) : await pay.json();
    } catch {}
    const accept = reqs?.accepts?.[0];
    box.innerHTML = `
      <p><b>Order ${esc(data.order.id)}</b> is waiting for an agent to pay.</p>
      <p class="muted small" style="margin-top:4px">The pay link answered <b>${pay.status} Payment Required</b>${
        accept ? `: ${(Number(accept.amount) / 1e6).toFixed(2)} USDC on ${esc(accept.network)}` : ""
      }. Any x402 client can pay it:</p>
      <pre>import { wrapFetchWithPayment } from "@x402/fetch";
const pay = wrapFetchWithPayment(fetch, client); // the agent's wallet
await pay("${esc(data.next.url)}", { method: "POST" });
// → 200, and the QR is emailed to ${esc(email)}</pre>
      ${
        demoAgent?.enabled
          ? `<button class="btn btn-lime" id="agentPay">Have our demo agent pay it</button>
             <p class="muted small" style="margin-top:8px">A real wallet (<a href="${esc(demoAgent.explorer)}" target="_blank" rel="noopener">${esc(short(demoAgent.address))}</a>${
               demoAgent.balance ? `, ${esc(demoAgent.balance)} ${esc(demoAgent.money)}` : ""
             }) pays in ${esc(demoAgent.money)} on ${esc(demoAgent.networkName)}, settled on-chain through ${esc(demoAgent.facilitator)}. Up to $${esc(demoAgent.maxOrder)} an order.</p>
             <p id="agentPayResult" class="mono small"></p>`
          : `<p class="muted small">This page has no wallet, so the demo stops here. Use the instant test payment to see the rest.</p>`
      }`;
    const button = $("agentPay");
    if (button) button.onclick = () => agentPays(data.order.id, button);
  }

  async function agentPays(id, button) {
    button.disabled = true;
    button.textContent = "signing and settling…";
    const out = $("agentPayResult");
    const { ok, data } = await api("/api/demo/agent-pay", { orderId: id });
    if (!ok) {
      button.disabled = false;
      button.textContent = "Have our demo agent pay it";
      out.className = "mono small bad";
      out.textContent = `✕ ${data.error || "that didn't work, try again?"}`;
      return;
    }
    button.remove();
    out.className = "mono small ok";
    out.innerHTML = `✓ paid ${esc(data.amount)} USDC · <a href="${esc(data.explorer)}" target="_blank" rel="noopener">tx ${esc(short(data.transaction))}</a> on ${esc(demoAgent.networkName)}`;
    startFlow(id, { scroll: true });
  }

  const short = (hex) => (hex && hex.length > 12 ? `${hex.slice(0, 6)}…${hex.slice(-4)}` : hex || "");

  // ---------- the event log on the right ----------

  function startFlow(id, { scroll = false } = {}) {
    orderId = id;
    emailShownFor = null;
    store.set("demoOrderId", id);
    $("flowEmpty").classList.add("hidden");
    $("flowLive").classList.remove("hidden");
    $("flowLiveDot").classList.remove("hidden");
    $("scanResult").classList.add("hidden");
    $("emailPreview").removeAttribute("srcdoc");
    $("emailSubject").textContent = "waiting for the email…";
    $("flowTitle").textContent = `${id} · events`;
    clearInterval(poll);
    refresh();
    poll = setInterval(refresh, 2500);
    if (scroll && window.matchMedia("(max-width: 960px)").matches) $("flow").scrollIntoView({ behavior: "smooth" });
  }

  function renderLog(o, emailed) {
    const summary = o.items.map((i) => `${i.qty}× ${i.name.toLowerCase()}`).join(", ");
    const railText = o.rail === "card" ? "card · hold" : o.rail === "x402" ? "usdc · x402" : "test payment";
    const line = (at, cls, event, detail, value, valueCls = "") =>
      `<div class="${at ? "" : "pending"}"><span class="t">${clock(at)}</span><span class="e ${cls}">${event}</span><span class="d">${esc(detail)}</span><span class="v ${valueCls}">${value}</span></div>`;
    const rows = [
      line(o.createdAt, "", "order.created", summary, money(o.totalCents)),
      line(o.paidAt, "am", "order.paid", railText, o.rail === "card" ? "held" : "paid", "am"),
      line(emailed ? o.paidAt : null, "", "pass.emailed", "QR + pickup code", emailed ? "✓" : ""),
      line(o.readyAt, "vi", "order.ready", "second email sent", o.readyAt ? "✓" : ""),
    ];
    if (o.status === "expired" || o.status === "cancelled") {
      rows.push(line(Date.now(), "bad", `order.${o.status}`, "not collected in time", "released", "bad"));
    } else {
      rows.push(line(o.collectedAt, "ok", "order.collected", "scanned at the counter", o.collectedAt ? (o.rail === "card" ? "captured" : "done") : "", "ok"));
    }
    $("orderLog").innerHTML = rows.join("");
  }

  async function refresh() {
    if (!orderId) return;
    const { ok, data } = await api(`/api/orders/${orderId}`);
    if (!ok) return resetFlow();
    const o = data.order;
    const emailKey = `${o.id}:${o.status === "ready" ? "ready" : "paid"}`;
    if (o.paidAt && emailShownFor !== emailKey) {
      const res = await fetch(`/api/orders/${o.id}/email-preview`);
      if (res.ok) {
        emailShownFor = emailKey;
        $("emailPreview").srcdoc = await res.text();
        $("emailSubject").textContent = o.readyAt ? "Ready to collect: Demo Café order" : "Receipt: your Demo Café order";
      }
    }
    renderLog(o, Boolean(emailShownFor));
    $("markReady").disabled = o.status !== "paid";
    $("simulateScan").disabled = !(o.status === "paid" || o.status === "ready");
    if (["collected", "expired", "cancelled"].includes(o.status)) {
      clearInterval(poll);
      $("flowLiveDot").classList.add("hidden");
    }
  }

  function resetFlow() {
    clearInterval(poll);
    orderId = null;
    emailShownFor = null;
    store.set("demoOrderId", null);
    $("flowLive").classList.add("hidden");
    $("flowLiveDot").classList.add("hidden");
    $("flowEmpty").classList.remove("hidden");
    $("flowTitle").textContent = "order · events";
  }

  $("markReady").onclick = async () => {
    $("markReady").disabled = true;
    await api("/api/demo/ready", { orderId });
    refresh();
  };

  $("simulateScan").onclick = async () => {
    $("simulateScan").disabled = true;
    const { ok, data } = await api("/api/demo/scan", { orderId });
    const box = $("scanResult");
    box.classList.remove("hidden", "ok", "bad");
    box.classList.add(ok ? "ok" : "bad");
    box.textContent = ok ? `✓ collected · ${data.message}` : `✕ ${data.title}: ${data.detail}`;
    refresh();
  };

  $("newOrder").onclick = () => {
    resetFlow();
    cart.clear();
    renderMenu();
    $("agentBox").classList.add("hidden");
    $("demo").scrollIntoView({ behavior: "smooth" });
  };

  // ---------- waitlist ----------
  $("waitlistForm").onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const msg = $("wlMsg");
    msg.className = "form-msg mono";
    msg.textContent = "sending…";
    const { ok, data } = await api("/api/waitlist", { email: f.email.value, kind: f.kind.value, note: f.note.value });
    msg.classList.add(ok ? "ok" : "bad");
    msg.textContent = ok ? "✓ you're on the list. we'll be in touch." : `✕ ${data.error || "that didn't work, try again?"}`;
    if (ok) f.reset();
  };

  // ---------- boot ----------
  api("/api/catalog").then(({ ok, data }) => {
    if (!ok) return ($("menu").textContent = "The demo shop is unavailable right now.");
    catalog = data;
    if (data.payments?.x402) api("/api/demo/agent").then((r) => (demoAgent = r.ok ? r.data : null));
    renderPayButtons();
    renderMenu();
    if (orderId) startFlow(orderId);
  });
})();
