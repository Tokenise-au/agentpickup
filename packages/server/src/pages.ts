// Shopper- and staff-facing pages. Every visible name, colour and logo is the
// merchant's; nothing here mentions the library.
import type { Order } from "@agentpickup/core";
import type { MerchantProfile } from "./config.js";
import { esc, formatMoney, formatTime } from "./format.js";

interface PageOpts {
  merchant: MerchantProfile;
  title: string;
  body: string;
  scripts?: string[];
  inlineScript?: string;
  /** Where the shop lives ("" at a domain root, "/v/cafe" under a path): relative links resolve against it. */
  root?: string;
}

export function page({ merchant, title, body, scripts = [], inlineScript, root }: PageOpts): string {
  const color = merchant.brandColor ?? "#111827";
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">${root !== undefined ? `\n<base href="${esc(root)}/">` : ""}
<title>${esc(title)} · ${esc(merchant.name)}</title>
<style>
:root{--brand:${esc(color)};--ink:#111827;--muted:#6b7280;--line:#e5e7eb;--bg:#f3f4f6;--card:#fff;--ok:#047857;--okbg:#ecfdf5;--bad:#b91c1c;--badbg:#fef2f2}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
header{background:var(--brand);color:#fff;padding:14px 20px;font-weight:700;font-size:18px;display:flex;align-items:center;gap:10px}
header img{height:28px}
main{max-width:520px;margin:0 auto;padding:20px 16px 48px}
.card{background:var(--card);border-radius:16px;padding:22px;box-shadow:0 1px 2px rgba(0,0,0,.05);margin-bottom:16px}
h1{font-size:22px;margin:0 0 6px}
p{margin:0 0 10px;color:#374151}
.muted{color:var(--muted);font-size:14px}
.qr{display:block;margin:14px auto 6px;width:min(280px,80vw);height:auto;image-rendering:pixelated}
.code{font:700 28px/1.2 ui-monospace,Menlo,Consolas,monospace;letter-spacing:.2em;text-align:center}
.label{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);text-align:center}
table{width:100%;border-collapse:collapse;font-size:15px}
td{padding:7px 0;border-bottom:1px solid var(--line)} td:last-child{text-align:right}
tr.total td{font-weight:700;border-bottom:0}
.btn{display:inline-block;border:0;border-radius:12px;background:var(--brand);color:#fff;font-family:inherit;font-weight:600;font-size:16px;line-height:1;padding:14px 20px;cursor:pointer;text-decoration:none;text-align:center}
.btn.block{display:block;width:100%}
.btn.ghost{background:#fff;color:var(--ink);border:1px solid var(--line)}
.btn:disabled{opacity:.5;cursor:default}
.pill{display:inline-block;border-radius:999px;padding:3px 10px;font-size:13px;font-weight:600;background:#eef2ff;color:#3730a3}
.pill.ok{background:var(--okbg);color:var(--ok)} .pill.bad{background:var(--badbg);color:var(--bad)}
.banner{border-radius:12px;padding:12px 14px;margin-bottom:14px;font-size:14px}
.banner.warn{background:#fffbeb;color:#92400e}
.result{border-radius:16px;padding:22px;text-align:center}
.result.ok{background:var(--okbg);color:var(--ok)} .result.bad{background:var(--badbg);color:var(--bad)}
.result .big{font-size:44px;line-height:1}
input[type=text],input[type=password]{width:100%;font:inherit;padding:12px 14px;border:1px solid var(--line);border-radius:12px;background:#fff}
.row{display:flex;gap:10px;align-items:center}
.row>*{flex:1}
video{width:100%;border-radius:14px;background:#000;aspect-ratio:1/1;object-fit:cover}
.hidden{display:none!important}
</style></head><body>
<header>${merchant.logoUrl ? `<img src="${esc(merchant.logoUrl)}" alt="">` : ""}${esc(merchant.name)}</header>
<main>${body}</main>
${inlineScript ? `<script>${inlineScript.replaceAll("<", "\\u003c")}</script>` : ""}
${scripts.map((s) => `<script src="${esc(s)}"></script>`).join("")}
</body></html>`;
}

function itemsTable(order: Order): string {
  const rows = order.items
    .map((i) => `<tr><td>${i.qty} × ${esc(i.name)}</td><td>${formatMoney(i.qty * i.unitCents, order.currency)}</td></tr>`)
    .join("");
  return `<table>${rows}<tr class="total"><td>Total</td><td>${formatMoney(order.totalCents, order.currency)}</td></tr></table>`;
}

export function statusPill(order: Order): string {
  const map: Record<Order["status"], [string, string]> = {
    awaiting_payment: ["Awaiting payment", ""],
    paid: ["Paid, ready soon", ""],
    ready: ["Ready to collect", "ok"],
    collected: ["Collected", "ok"],
    expired: ["Expired", "bad"],
    cancelled: ["Cancelled", "bad"],
  };
  const [label, cls] = map[order.status];
  return `<span class="pill ${cls}">${label}</span>`;
}

export function passPage(o: {
  order: Order;
  merchant: MerchantProfile;
  qrDataUri: string;
  timeZone?: string;
  /** The shop emails when an order is ready: say so while it's being made. */
  readySoon?: boolean;
}): string {
  const { order, merchant } = o;
  const live = order.status === "paid" || order.status === "ready";
  const preparing = o.readySoon && order.status === "paid";
  const body = `
<div class="card" style="text-align:center">
  ${statusPill(order)}
  ${
    live
      ? `<h1 style="margin-top:10px">${preparing ? "Being prepared" : "Show this at the counter"}</h1>
         ${preparing ? `<p class="muted">We'll email you when it's ready. Show this code at the counter to collect.</p>` : ""}
         <img class="qr" src="${o.qrDataUri}" alt="Pickup QR code">
         <div class="label">Pickup code</div><div class="code">${esc(order.pickupCode ?? "")}</div>`
      : order.status === "collected"
        ? `<h1 style="margin-top:10px">Collected. Enjoy!</h1><p class="muted">Picked up ${esc(formatTime(order.collectedAt ?? Date.now(), o.timeZone))}</p>`
        : `<h1 style="margin-top:10px">This pass can't be used</h1><p class="muted">Contact ${esc(merchant.supportEmail ?? merchant.name)} if that's unexpected.</p>`
  }
</div>
<div class="card">${itemsTable(order)}</div>
<div class="card">
  <b>${esc(merchant.location.name)}</b>
  ${merchant.location.address ? `<p class="muted" style="margin:2px 0 0">${esc(merchant.location.address)}</p>` : ""}
  ${merchant.location.hours ? `<p class="muted" style="margin:2px 0 0">${esc(merchant.location.hours)}</p>` : ""}
  ${live ? `<p class="muted" style="margin-top:8px">Collect by ${esc(formatTime(order.collectBy, o.timeZone))}</p>` : ""}
</div>
<p class="muted" style="text-align:center">Anyone with this code can collect the order.</p>`;
  return page({ merchant, title: "Your pickup pass", body });
}

export function thanksPage(o: { order: Order; merchant: MerchantProfile; passUrl: string }): string {
  const { order, merchant } = o;
  const body = `
<div class="card" style="text-align:center">
  <div style="font-size:44px">✉️</div>
  <h1>Paid. Check your inbox</h1>
  <p>${order.customerEmail ? `We've emailed your pickup QR to <b>${esc(order.customerEmail)}</b>.` : "Your pickup QR is ready."}
  Show it at ${esc(merchant.location.name)} to collect.</p>
  <a class="btn" href="${esc(o.passUrl)}">Open my pass now</a>
  ${merchant.shopUrl ? `<p style="margin-top:14px"><a href="${esc(merchant.shopUrl)}" style="color:var(--muted)">Back to shop</a></p>` : ""}
</div>
<div class="card">${itemsTable(order)}</div>`;
  return page({ merchant, title: "Order paid", body });
}

export function messagePage(merchant: MerchantProfile, title: string, text: string): string {
  return page({ merchant, title, body: `<div class="card"><h1>${esc(title)}</h1><p>${esc(text)}</p></div>` });
}

export function staffLoginPage(merchant: MerchantProfile, failed = false, root = ""): string {
  const body = `
<div class="card">
  <h1>Staff sign-in</h1>
  <p class="muted">Enter the staff key to open the scanner on this device.</p>
  ${failed ? `<div class="banner" style="background:var(--badbg);color:var(--bad)">That key didn't work.</div>` : ""}
  <form method="post" action="staff/login">
    <input type="password" name="key" autocomplete="current-password" placeholder="Staff key" required>
    <button class="btn block" style="margin-top:12px">Open scanner</button>
  </form>
</div>`;
  return page({ merchant, title: "Staff sign-in", body, root });
}

export function scannerPage(o: { merchant: MerchantProfile; open: boolean; prefill?: string; root?: string }): string {
  const body = `
${o.open ? `<div class="banner warn">Demo mode: this scanner is open to anyone. Set a staff key before using it in a real shop.</div>` : ""}
<div class="card" id="scanCard">
  <h1>Scan a pickup QR</h1>
  <p class="muted">Point the camera at the customer's QR, or type their pickup code.</p>
  <video id="video" playsinline muted class="hidden"></video>
  <button class="btn block" id="startCam" style="margin:10px 0">Start camera</button>
  <form id="manual" class="row" style="margin-top:6px">
    <input type="text" id="manualInput" placeholder="Pickup code, or scan with a USB scanner" autocomplete="off" autocapitalize="characters">
    <button class="btn" style="flex:0 0 auto">Find</button>
  </form>
  <p class="muted hidden" id="camHint" style="margin-top:8px"></p>
</div>
<div class="card hidden" id="orderCard"></div>
<div class="card">
  <div class="row" style="margin-bottom:6px"><h1 style="font-size:18px;margin:0">Open orders</h1><button class="btn ghost" id="refresh" style="flex:0 0 auto;padding:8px 12px;font-size:14px">Refresh</button></div>
  <div id="board" class="muted">Loading…</div>
</div>`;
  return page({
    merchant: o.merchant,
    title: "Scanner",
    body,
    scripts: ["collect-assets/jsQR.js", "collect-assets/scanner.js"],
    root: o.root ?? "",
    inlineScript: o.prefill ? `window.__collectPrefill=${JSON.stringify(o.prefill)};` : undefined,
  });
}
