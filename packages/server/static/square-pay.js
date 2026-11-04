// The card checkout for the "square" rail: Square's card form (and Google Pay where the browser has it) turns
// the card into a one-time token, and the shop's server charges it on the order. Settings come from the page as
// window.__squarePay: appId, locationId, amount ("9.40"), currency, country, payUrl, needsEmail.
(async () => {
  const cfg = window.__squarePay;
  const msg = document.getElementById("payMsg");
  const button = document.getElementById("pay");
  const emailInput = document.getElementById("payEmail");
  const say = (text, bad) => {
    msg.textContent = text;
    msg.className = bad ? "banner" : "muted";
    msg.style.cssText = bad ? "margin-top:10px;background:var(--badbg);color:var(--bad)" : "margin-top:10px";
  };
  if (!cfg || !window.Square) return say("The card form couldn't load. Check your connection and reload the page.", true);

  let payments;
  let card;
  try {
    payments = window.Square.payments(cfg.appId, cfg.locationId);
    card = await payments.card();
    await card.attach("#card-container");
  } catch (err) {
    console.error(err);
    return say("Card payments aren't available on this page right now. Try again shortly.", true);
  }

  const email = () => (emailInput ? emailInput.value.trim() : "");
  const emailOk = () => !cfg.needsEmail || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email());
  let busy = false;

  async function pay(method, verification) {
    if (busy) return;
    if (!emailOk()) {
      say("Add your email first: your pickup QR goes there.", true);
      emailInput?.focus();
      return;
    }
    busy = true;
    button.disabled = true;
    say("Paying…");
    try {
      const result = await method.tokenize(verification);
      if (result.status !== "OK") throw new Error(result.errors?.[0]?.message || "Check the card details and try again.");
      const res = await fetch(cfg.payUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceId: result.token, email: email() || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.thanksUrl) throw new Error(data.error || "The payment didn't go through. Try again.");
      say("Paid. Opening your pass…");
      location.href = data.thanksUrl;
    } catch (err) {
      say(err.message, true);
      busy = false;
      button.disabled = false;
    }
  }

  button.disabled = false;
  say("");
  button.addEventListener("click", () =>
    pay(card, {
      amount: cfg.amount,
      currencyCode: cfg.currency,
      intent: "CHARGE",
      customerInitiated: true,
      sellerKeyedIn: false,
      billingContact: email() ? { email: email() } : {},
    }),
  );

  // Apple Pay, in Safari on Apple devices, once Square has validated the domain. Apple wants the payment sheet
  // opened straight from the click, so nothing is awaited before tokenize in pay().
  const appleButton = document.getElementById("apple-pay");
  try {
    if (!appleButton || !window.ApplePaySession) throw new Error("no Apple Pay here");
    const request = payments.paymentRequest({ countryCode: cfg.country, currencyCode: cfg.currency, total: { amount: cfg.amount, label: "Total" } });
    const applePay = await payments.applePay(request);
    appleButton.hidden = false;
    appleButton.addEventListener("click", (event) => {
      event.preventDefault();
      pay(applePay);
    });
  } catch {
    appleButton?.remove();
  }

  // Google Pay, where the browser offers it. No button shows otherwise.
  try {
    const request = payments.paymentRequest({ countryCode: cfg.country, currencyCode: cfg.currency, total: { amount: cfg.amount, label: "Total" } });
    const googlePay = await payments.googlePay(request);
    await googlePay.attach("#google-pay", { buttonSizeMode: "fill", buttonType: "long" });
    document.getElementById("google-pay").addEventListener("click", () => pay(googlePay));
  } catch {
    document.getElementById("google-pay")?.remove();
  }
})();
