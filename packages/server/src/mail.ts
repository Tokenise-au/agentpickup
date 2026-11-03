import type { Order } from "@agentpickup/core";
import type { MerchantProfile } from "./config.js";
import { esc, formatMoney, formatTime } from "./format.js";

export interface MailAttachment {
  filename: string;
  content: Buffer;
  /** Referenced from the HTML as cid:<contentId>. */
  contentId?: string;
}

export interface OutgoingMail {
  from: string;
  to: string;
  subject: string;
  html: string;
  /** Plain-text version, for text-only clients and spam scoring. */
  text?: string;
  /** Where replies go: the shop's support address. */
  replyTo?: string;
  attachments?: MailAttachment[];
}

export interface Mailer {
  /** True when the mailer really delivers, so emails embed the QR as an attachment. */
  readonly delivers: boolean;
  send(mail: OutgoingMail): Promise<{ id: string }>;
}

/** Sends through Resend's HTTP API. */
export function resendMailer(opts: { apiKey: string }): Mailer {
  return {
    delivers: true,
    async send(mail) {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: mail.from,
          to: [mail.to],
          subject: mail.subject,
          html: mail.html,
          ...(mail.text ? { text: mail.text } : {}),
          ...(mail.replyTo ? { reply_to: mail.replyTo } : {}),
          attachments: mail.attachments?.map((a) => ({
            filename: a.filename,
            content: a.content.toString("base64"),
            content_id: a.contentId,
          })),
        }),
      });
      if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
      const body = (await res.json()) as { id: string };
      return { id: body.id };
    },
  };
}

/** "Name <address>" or a bare address, as Cloudflare's API wants it. */
function namedAddress(value: string): { address: string; name?: string } {
  const m = value.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  return m ? { address: m[2].trim(), ...(m[1].trim() ? { name: m[1].trim() } : {}) } : { address: value.trim() };
}

/**
 * Sends through Cloudflare Email Sending's REST API. The from address must be on a domain onboarded to
 * Email Sending in that account; the token needs Account > Email Sending > Edit.
 */
export function cloudflareMailer(opts: { accountId: string; apiToken: string; fetch?: typeof fetch }): Mailer {
  const doFetch = opts.fetch ?? fetch;
  return {
    delivers: true,
    async send(mail) {
      const res = await doFetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(opts.accountId)}/email/sending/send`, {
        method: "POST",
        headers: { Authorization: `Bearer ${opts.apiToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: namedAddress(mail.from),
          to: mail.to,
          subject: mail.subject,
          html: mail.html,
          ...(mail.text ? { text: mail.text } : {}),
          ...(mail.replyTo ? { reply_to: namedAddress(mail.replyTo) } : {}),
          ...(mail.attachments?.length
            ? {
                attachments: mail.attachments.map((a) =>
                  a.contentId
                    ? { disposition: "inline", content_id: a.contentId, filename: a.filename, type: mimeOf(a.filename), content: a.content.toString("base64") }
                    : { disposition: "attachment", filename: a.filename, type: mimeOf(a.filename), content: a.content.toString("base64") },
                ),
              }
            : {}),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        errors?: { code: number; message: string }[];
        result?: { message_id?: string; delivered?: string[]; queued?: string[]; permanent_bounces?: string[] };
      };
      if (!res.ok || body.success === false) {
        throw new Error(`Cloudflare Email ${res.status}: ${(body.errors ?? []).map((e) => `${e.code} ${e.message}`).join("; ") || "send failed"}`);
      }
      if (body.result?.permanent_bounces?.length) throw new Error(`Cloudflare Email: ${mail.to} bounced permanently`);
      return { id: body.result?.message_id ?? "cloudflare" };
    },
  };
}

function mimeOf(filename: string): string {
  const ext = filename.toLowerCase().split(".").pop();
  return ext === "png" ? "image/png" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "pdf" ? "application/pdf" : "application/octet-stream";
}

/**
 * Caps sends per recipient and in total per UTC day, so a public demo can't be used to email people at
 * will. A send over a cap throws; the order still goes through, with the failure on its pass.emailed event.
 */
export function cappedMailer(inner: Mailer, caps: { perRecipientPerDay: number; perDay: number }): Mailer {
  let day = "";
  let total = 0;
  const perRecipient = new Map<string, number>();
  return {
    delivers: inner.delivers,
    async send(mail) {
      const today = new Date().toISOString().slice(0, 10);
      if (today !== day) {
        day = today;
        total = 0;
        perRecipient.clear();
      }
      const to = mail.to.trim().toLowerCase();
      if (total >= caps.perDay) throw new Error("Daily email limit reached for this shop");
      if ((perRecipient.get(to) ?? 0) >= caps.perRecipientPerDay) throw new Error("Daily email limit reached for this address");
      total++;
      perRecipient.set(to, (perRecipient.get(to) ?? 0) + 1);
      return inner.send(mail);
    },
  };
}

/** Delivers nothing; the copy kept in the store is what the demo and local runs show. */
export function outboxMailer(): Mailer {
  return {
    delivers: false,
    async send() {
      return { id: "outbox" };
    },
  };
}

export interface PassEmailInput {
  order: Order;
  merchant: MerchantProfile;
  /** Image source for the QR: "cid:..." when delivered, a data: URI for previews. */
  qrSrc: string;
  passUrl: string;
  kind: "paid" | "ready";
  timeZone?: string;
  poweredBy?: { label: string; url: string };
}

export function renderPassEmail(input: PassEmailInput): { subject: string; html: string; text: string } {
  const { order, merchant, qrSrc, passUrl, kind } = input;
  const color = merchant.brandColor ?? "#111827";
  const heading = kind === "ready" ? "Your order is ready" : "Your order is paid";
  const lead =
    kind === "ready"
      ? `Come by ${esc(merchant.location.name)} and show this code at the counter.`
      : `Show this code at ${esc(merchant.location.name)} to collect your order.`;
  const subject = kind === "ready" ? `Ready to collect: ${merchant.name} order` : `Your ${merchant.name} order: show this QR to collect`;
  const rows = order.items
    .map(
      (i) => `<tr>
        <td style="padding:6px 0;color:#111827">${i.qty} × ${esc(i.name)}</td>
        <td style="padding:6px 0;color:#111827;text-align:right">${formatMoney(i.unitCents * i.qty, order.currency)}</td>
      </tr>`,
    )
    .join("");
  const header = merchant.logoUrl
    ? `<img src="${esc(merchant.logoUrl)}" alt="${esc(merchant.name)}" height="32" style="display:block;height:32px">`
    : `<div style="font-size:18px;font-weight:700;color:#ffffff">${esc(merchant.name)}</div>`;
  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 12px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:14px;overflow:hidden">
  <tr><td style="background:${esc(color)};padding:18px 24px">${header}</td></tr>
  <tr><td style="padding:28px 24px 8px">
    <div style="font-size:22px;font-weight:700;color:#111827">${heading}</div>
    <div style="font-size:15px;color:#4b5563;margin-top:6px;line-height:1.5">${lead}</div>
  </td></tr>
  <tr><td align="center" style="padding:16px 24px 4px">
    <img src="${esc(qrSrc)}" width="240" height="240" alt="Pickup QR code" style="display:block;width:240px;height:240px">
  </td></tr>
  <tr><td align="center" style="padding:4px 24px 20px">
    <div style="font-size:12px;color:#6b7280;letter-spacing:.08em;text-transform:uppercase">Pickup code</div>
    <div style="font-size:26px;font-weight:700;letter-spacing:.18em;color:#111827;font-family:ui-monospace,Menlo,Consolas,monospace">${esc(order.pickupCode ?? "")}</div>
  </td></tr>
  <tr><td style="padding:0 24px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb;font-size:15px">
      ${rows}
      <tr><td style="padding:8px 0;font-weight:700;color:#111827">Total</td>
          <td style="padding:8px 0;font-weight:700;color:#111827;text-align:right">${formatMoney(order.totalCents, order.currency)}</td></tr>
    </table>
  </td></tr>
  <tr><td style="padding:16px 24px;font-size:14px;color:#4b5563;line-height:1.6">
    <b style="color:#111827">${esc(merchant.location.name)}</b>${merchant.location.address ? `<br>${esc(merchant.location.address)}` : ""}${
      merchant.location.hours ? `<br>${esc(merchant.location.hours)}` : ""
    }<br>Collect by ${esc(formatTime(order.collectBy, input.timeZone))}
  </td></tr>
  <tr><td align="center" style="padding:4px 24px 28px">
    <a href="${esc(passUrl)}" style="display:inline-block;background:${esc(color)};color:#ffffff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:10px">Open my pass</a>
    <div style="font-size:12px;color:#9ca3af;margin-top:12px">Anyone with this code can collect the order, so keep it to yourself.</div>
  </td></tr>
</table>
<div style="font-size:12px;color:#9ca3af;margin-top:14px">${
    merchant.supportEmail ? `Questions? <a href="mailto:${esc(merchant.supportEmail)}" style="color:#6b7280">${esc(merchant.supportEmail)}</a>` : ""
  }${input.poweredBy ? `<br><a href="${esc(input.poweredBy.url)}" style="color:#9ca3af">${esc(input.poweredBy.label)}</a>` : ""}</div>
</td></tr></table>
</body></html>`;
  const location = [merchant.location.name, merchant.location.address, merchant.location.hours].filter(Boolean).join("\n");
  const text = [
    `${merchant.name}: ${heading}`,
    "",
    kind === "ready" ? `Come by ${merchant.location.name} and show your pickup code at the counter.` : `Show your pickup code at ${merchant.location.name} to collect your order.`,
    "",
    `Pickup code: ${order.pickupCode ?? ""}`,
    `Your pass, with the QR code: ${passUrl}`,
    "",
    ...order.items.map((i) => `${i.qty} x ${i.name}  ${formatMoney(i.unitCents * i.qty, order.currency)}`),
    `Total  ${formatMoney(order.totalCents, order.currency)}`,
    "",
    location,
    `Collect by ${formatTime(order.collectBy, input.timeZone)}`,
    "",
    "Anyone with this code can collect the order, so keep it to yourself.",
    ...(merchant.supportEmail ? ["", `Questions? ${merchant.supportEmail}`] : []),
  ].join("\n");
  return { subject, html, text };
}
