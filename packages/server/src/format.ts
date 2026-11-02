export function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat("en", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);
}

export function formatTime(ms: number, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-AU", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(new Date(ms));
}
