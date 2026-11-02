// Staff scanner: camera (BarcodeDetector, else jsQR), USB scanners and typed
// pickup codes all end up in lookup() → the order card → hand over.
(() => {
  const $ = (id) => document.getElementById(id);
  const video = $("video");
  const orderCard = $("orderCard");
  const hint = $("camHint");
  let stream = null;
  let scanning = false;
  let busy = false;
  let detector = null;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  const money = (cents, currency) =>
    new Intl.NumberFormat(undefined, { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  async function api(path, body) {
    const res = await fetch(path, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: "same-origin",
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) location.href = "/staff";
    return { ok: res.ok, data };
  }

  async function startCamera() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
    } catch (err) {
      hint.textContent = "Couldn't open the camera. Type the pickup code instead, or allow camera access.";
      hint.classList.remove("hidden");
      return;
    }
    video.srcObject = stream;
    video.classList.remove("hidden");
    $("startCam").classList.add("hidden");
    await video.play();
    if ("BarcodeDetector" in window) {
      try {
        detector = new window.BarcodeDetector({ formats: ["qr_code"] });
      } catch {
        detector = null;
      }
    }
    scanning = true;
    requestAnimationFrame(tick);
  }

  async function tick() {
    if (!scanning) return;
    if (!busy && video.readyState === video.HAVE_ENOUGH_DATA) {
      let text = null;
      if (detector) {
        const codes = await detector.detect(video).catch(() => []);
        text = codes[0]?.rawValue ?? null;
      } else if (window.jsQR) {
        const w = (canvas.width = video.videoWidth);
        const h = (canvas.height = video.videoHeight);
        ctx.drawImage(video, 0, 0, w, h);
        const img = ctx.getImageData(0, 0, w, h);
        text = window.jsQR(img.data, w, h, { inversionAttempts: "dontInvert" })?.data ?? null;
      }
      if (text) await lookup(text);
    }
    requestAnimationFrame(tick);
  }

  function showResult(kind, title, detail) {
    orderCard.classList.remove("hidden");
    orderCard.innerHTML = `<div class="result ${kind}"><div class="big">${kind === "ok" ? "✓" : "✕"}</div>
      <h1 style="margin-top:8px">${esc(title)}</h1><p style="color:inherit">${esc(detail || "")}</p></div>
      <button class="btn block ghost" id="next" style="margin-top:12px">Scan next</button>`;
    $("next").onclick = reset;
    loadBoard();
    orderCard.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function reset() {
    orderCard.classList.add("hidden");
    orderCard.innerHTML = "";
    busy = false;
    $("manualInput").value = "";
    loadBoard();
  }

  async function lookup(scan) {
    busy = true;
    const { ok, data } = await api("/api/staff/lookup", { scan });
    if (!ok) return showResult("bad", data.title || "Not a valid pass", data.detail);
    const o = data.order;
    const collectable = o.status === "paid" || o.status === "ready";
    const rows = o.items.map((i) => `<tr><td>${i.qty} × ${esc(i.name)}</td><td>${money(i.qty * i.unitCents, o.currency)}</td></tr>`).join("");
    orderCard.classList.remove("hidden");
    orderCard.innerHTML = `
      <div class="row"><h1 style="margin:0">${esc(o.customerName || "Order")} <span class="muted" style="font-size:15px">#${esc(o.pickupCode)}</span></h1></div>
      <p class="muted" style="margin:4px 0 12px">${esc(data.statusLabel)} · ${esc(data.paymentLabel)}</p>
      <table>${rows}<tr class="total"><td>Total</td><td>${money(o.totalCents, o.currency)}</td></tr></table>
      ${
        collectable
          ? `<button class="btn block" id="handover" style="margin-top:16px">Hand over and complete</button>`
          : `<div class="banner" style="background:var(--badbg);color:var(--bad);margin-top:14px">${esc(data.blockedReason || "This order can't be collected.")}</div>`
      }
      <button class="btn block ghost" id="cancel" style="margin-top:10px">Back</button>`;
    $("cancel").onclick = reset;
    if (collectable) {
      $("handover").onclick = async () => {
        $("handover").disabled = true;
        $("handover").textContent = "Completing…";
        const r = await api("/api/staff/collect", { scan });
        if (r.ok) showResult("ok", "Collected", r.data.message);
        else showResult("bad", r.data.title || "Couldn't complete", r.data.detail);
      };
    }
    orderCard.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  async function loadBoard() {
    const { ok, data } = await api("/api/staff/orders");
    const board = $("board");
    if (!ok) return (board.textContent = "Couldn't load orders.");
    if (!data.orders.length) return (board.textContent = "No open orders.");
    board.innerHTML = data.orders
      .map(
        (o) => `<div class="row" style="padding:8px 0;border-bottom:1px solid var(--line)">
          <div><b style="color:var(--ink)">#${esc(o.pickupCode)}</b> ${esc(o.customerName || "")}<br>
          <span>${o.items.map((i) => `${i.qty}× ${esc(i.name)}`).join(", ")}</span></div>
          ${
            o.status === "paid"
              ? `<button class="btn" data-ready="${esc(o.id)}" style="flex:0 0 auto;padding:9px 12px;font-size:14px">Mark ready</button>`
              : `<span class="pill ok" style="flex:0 0 auto">Ready</span>`
          }</div>`,
      )
      .join("");
    board.querySelectorAll("[data-ready]").forEach((b) => {
      b.onclick = async () => {
        b.disabled = true;
        await api("/api/staff/ready", { orderId: b.dataset.ready });
        loadBoard();
      };
    });
  }

  $("startCam").onclick = startCamera;
  $("manual").onsubmit = (e) => {
    e.preventDefault();
    const v = $("manualInput").value.trim();
    if (v) lookup(v);
  };
  $("refresh").onclick = loadBoard;
  loadBoard();
  if (window.__collectPrefill) lookup(window.__collectPrefill);
})();
