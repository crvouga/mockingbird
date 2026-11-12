import { CSS_RESET } from "@crvouga/mockingbird-ui"
import { subscriptionItems } from "./billing.js"
import {
  CANCELLATION_REASONS,
  ensureDefaultConfiguration,
  formatDate,
  type PortalChange,
  previewProration,
  resetsBillingPeriod,
} from "./billing-portal.js"
import { CARD_CORE } from "./card-input.js"
import { formatMoney } from "./checkout-page.js"
import { findCustomer, type RequestScope } from "./internal.js"
import { portalProducts } from "./render.js"
import type {
  BillingPortalConfigurationRecord,
  BillingPortalSessionRecord,
  CustomerRecord,
  InvoiceRecord,
  PaymentMethodRecord,
  PriceRecord,
  SubscriptionRecord,
} from "./state.js"
import { HOSTED_PAGE_TEST_CARDS } from "./test-tokens.js"

/** Which page of the portal to show. */
export type PortalView =
  | { kind: "home" }
  | { kind: "cancel"; subscription: string }
  | { kind: "update"; subscription: string }
  | { kind: "confirm_update"; change: PortalChange }
  | { kind: "payment_method" }
  | { kind: "customer_update" }
  | { kind: "confirmation"; message: string }

export type PortalMessages = {
  notice?: string
  error?: string
  /** Values posted with a refused form, put back into it. */
  values?: Record<string, string>
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)

const REASON_LABELS: Record<string, string> = {
  too_expensive: "It's too expensive",
  missing_features: "Some features are missing",
  switched_service: "I'm switching to a different service",
  unused: "I don't use the service enough",
  customer_service: "Customer service was less than expected",
  too_complex: "Ease of use was less than expected",
  low_quality: "Quality was less than expected",
  other: "Other reason",
}

const STYLES = `
${CSS_RESET}
:root{--text:#1a1f36;--muted:#697386;--faint:#a3acb9;--line:#e3e8ee;--accent:#635bff;--accent-hover:#5851e5;
--danger:#df1b41;--ok:#1ea672;--warn:#c44c00;--test-bg:#ffde92;--test-fg:#983705;
--font:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Ubuntu,sans-serif}
html,body{margin:0;color:var(--text);font-family:var(--font);font-size:14px;line-height:1.45;-webkit-font-smoothing:antialiased;container-type:inline-size}
.app{min-height:100vh;min-width:0;max-width:100%;display:flex;flex-direction:column}
.side{background:#f6f9fc;padding:24px 20px;min-width:0}
.main{padding:24px 20px 48px;flex:1;min-width:0}
.inner{min-width:0;max-width:100%}
@container (min-width:900px){.app{flex-direction:row}.side{width:40%;display:flex;justify-content:flex-end;padding:48px 32px}
.side .inner{width:100%;max-width:320px}.main{padding:48px 32px}.main .inner{max-width:min(560px,100%)}}
.merchant{display:flex;align-items:center;gap:10px;font-weight:600;font-size:15px}
.avatar{width:28px;height:28px;border-radius:50%;background:#e3e8ee;display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;color:var(--muted)}
.badge{display:inline-block;padding:1px 6px;border-radius:4px;background:var(--test-bg);color:var(--test-fg);font-size:11px;font-weight:600;letter-spacing:.03em;text-transform:uppercase}
.back{display:inline-flex;align-items:center;gap:6px;margin-top:24px;color:var(--muted);text-decoration:none;font-weight:500}
.back:hover{color:var(--text)}
.tagline{color:var(--muted);margin:16px 0 0}
.legal{margin-top:32px;color:var(--faint);font-size:12px;display:flex;flex-wrap:wrap;gap:12px}
.legal a{color:inherit}
h1{font-size:20px;font-weight:600;margin:0 0 20px}
h2{font-size:13px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);margin:0 0 12px}
section{padding:0 0 28px;margin:0 0 28px;border-bottom:1px solid var(--line)}
section:last-of-type{border-bottom:0}
.card{padding:16px 0}
.card+.card{border-top:1px solid var(--line)}
.plan{font-size:16px;font-weight:600}
.price{font-size:24px;font-weight:600;margin:4px 0}
.meta{color:var(--muted);margin:2px 0}
.chip{display:inline-block;padding:1px 8px;border-radius:10px;font-size:12px;font-weight:500;background:#e3e8ee;color:var(--muted);margin-left:6px;vertical-align:middle}
.chip.ok{background:#d7f7c2;color:#05690d}.chip.warn{background:#fcedb9;color:#a82c00}.chip.bad{background:#ffe7f2;color:#b3093c}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
.btn{display:inline-flex;align-items:center;justify-content:center;height:34px;padding:0 14px;border-radius:6px;border:0;cursor:pointer;
font-weight:600;text-decoration:none;background:#fff;color:var(--text);box-shadow:0 0 0 1px rgba(60,66,87,.16),0 2px 5px rgba(60,66,87,.08)}
.btn:hover{box-shadow:0 0 0 1px rgba(60,66,87,.3),0 2px 5px rgba(60,66,87,.12)}
.btn.primary{background:var(--accent);color:#fff;box-shadow:none}.btn.primary:hover{background:var(--accent-hover)}
.btn.danger{background:var(--danger);color:#fff;box-shadow:none}
.link{border:0;background:none;padding:0;color:var(--accent);font-weight:600;cursor:pointer;text-decoration:none}
.row{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px 12px;padding:10px 0;min-width:0}
.row+.row{border-top:1px solid var(--line)}
.notice{padding:10px 12px;border-radius:6px;background:#eef8f2;color:#05690d;margin:0 0 20px}
.error{padding:10px 12px;border-radius:6px;background:#ffe7f2;color:#b3093c;margin:0 0 20px}
label.field{display:block;margin:0 0 14px}
label.field span{display:block;color:var(--muted);font-weight:500;margin-bottom:6px}
label.field.invalid input{border-color:var(--danger);box-shadow:0 0 0 1px var(--danger);color:var(--danger)}
label.field .field-error{display:block;margin:6px 0 0;color:var(--danger);font-size:13px;font-weight:400}
input[type=text],input[type=email],input[type=number],textarea,select{width:100%;min-width:0;max-width:100%;padding:8px 10px;border-radius:6px;border:0;
box-shadow:0 0 0 1px rgba(60,66,87,.16),0 2px 5px rgba(60,66,87,.08);background:#fff}
textarea{min-height:72px;resize:vertical}
.split{display:flex;flex-wrap:wrap;gap:10px;min-width:0}.split>*{flex:1;min-width:min(100%,8rem)}
.option{display:flex;gap:10px;align-items:flex-start;padding:12px;border-radius:8px;box-shadow:0 0 0 1px var(--line);margin:0 0 8px;cursor:pointer}
.option:has(input:checked){box-shadow:0 0 0 2px var(--accent)}
.option input{margin-top:3px}
.summary{padding:12px;border-radius:8px;background:#f6f9fc;margin:0 0 16px}
.summary .row{padding:6px 0}
.summary .total{font-weight:600}
.offer{padding:14px;border-radius:8px;background:#f5f4ff;margin:0 0 20px}
.done{text-align:center;padding:40px 0}
.done .mark{width:52px;height:52px;margin:0 auto 18px;border-radius:50%;background:var(--ok);display:flex;align-items:center;justify-content:center;color:#fff;font-size:26px}
.testcards{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 16px}
.testcards button{border:0;border-radius:6px;padding:4px 8px;background:#fffbf0;box-shadow:0 0 0 1px #f5d37a;cursor:pointer;font-size:12px}
`

const SCRIPT = `${CARD_CORE}
(() => {
  const $ = (id) => document.getElementById(id);
  const card = $("card"), exp = $("exp"), cvc = $("cvc"), zip = $("zip"), country = $("country");
  if (card) {
    const context = () => ({ brand: MBCard.brandOf(card.value), country: (country && country.value || "").toUpperCase() });
    MBCard.wire([{ name: "card", input: card }, { name: "exp", input: exp }, { name: "cvc", input: cvc }, { name: "name", input: $("name") }, { name: "country", input: country }, { name: "zip", input: zip }], { context });
    const fields = [["card", card], ["exp", exp], ["cvc", cvc], ["zip", zip]];
    const touched = {};
    let revealed = false;
    const paint = () => {
      for (const [name, input] of fields) {
        let error = MBCard.validate(name, input.value, context());
        if (error && !revealed && (!input.value || (error.code.indexOf("incomplete") === 0 && (!touched[name] || document.activeElement === input)))) error = null;
        const label = input.closest("label");
        label.classList.toggle("invalid", !!error);
        input.setAttribute("aria-invalid", error ? "true" : "false");
        let node = label.querySelector(".field-error");
        if (!error) { if (node) node.remove(); continue; }
        if (!node) { node = document.createElement("span"); node.className = "field-error"; node.setAttribute("role", "alert"); label.appendChild(node); }
        node.textContent = error.message;
      }
    };
    for (const [name, input] of fields) {
      MBCard.reformat(input, name, context());
      input.addEventListener("input", paint);
      input.addEventListener("focus", paint);
      input.addEventListener("blur", () => { if (input.value) touched[name] = true; paint(); });
    }
    card.form.addEventListener("submit", (event) => {
      revealed = true;
      paint();
      const invalid = fields.find(([name, input]) => MBCard.validate(name, input.value, context()));
      if (!invalid) return;
      event.preventDefault();
      invalid[1].focus();
    });
  }
  const set = (input, value) => {
    if (!input) return;
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  for (const button of document.querySelectorAll("[data-test-card]")) {
    button.addEventListener("click", () => {
      const number = button.getAttribute("data-test-card");
      set(card, number);
      set(exp, "12 / 34");
      set(cvc, /^3[47]/.test(number) ? "1234" : "123");
      set(zip, "94107");
    });
  }
})();`

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("")

const intervalLabel = (price: PriceRecord | undefined) => {
  const recurring = price?.recurring
  if (!recurring) return ""
  return recurring.interval_count === 1
    ? `per ${recurring.interval}`
    : `every ${recurring.interval_count} ${recurring.interval}s`
}

const priceLabel = (price: PriceRecord | undefined, quantity = 1) =>
  price === undefined
    ? ""
    : `${formatMoney(Math.round(Number(price.unit_amount_decimal) * quantity), price.currency)} ${intervalLabel(price)}`

/** Everything a portal page shows, looked up once per request. */
type PortalContext = {
  scope: RequestScope
  session: BillingPortalSessionRecord
  config: BillingPortalConfigurationRecord
  customer: CustomerRecord
  merchant: string
  base: string
}

export const portalContext = (
  scope: RequestScope,
  session: BillingPortalSessionRecord,
): PortalContext | undefined => {
  const customer = findCustomer(scope, session.customer)
  if (!customer) return undefined
  const config =
    scope.account.portalConfigurations.get(session.configuration) ??
    ensureDefaultConfiguration(scope)
  return {
    scope,
    session,
    config,
    customer,
    merchant: scope.services.accounts.config(scope.account.account)?.displayName ?? "Test business",
    base: `${scope.base}/p/session/${session.id}`,
  }
}

const productName = (context: PortalContext, price: PriceRecord | undefined) =>
  price === undefined
    ? "Subscription"
    : (context.scope.account.products.get(price.product)?.name ?? price.product)

/** Subscriptions the portal lists: everything not yet ended. */
const liveSubscriptions = (context: PortalContext): SubscriptionRecord[] =>
  context.scope.account.subscriptions
    .list({
      order: "newest",
      where: (subscription) =>
        subscription.customer === context.customer.id &&
        ["active", "trialing", "past_due", "unpaid", "paused", "incomplete"].includes(
          subscription.status,
        ),
    })
    .map((entry) => entry.value)

const statusChip = (subscription: SubscriptionRecord) => {
  if (subscription.cancel_at_period_end || subscription.cancel_at !== null)
    return `<span class="chip warn">Cancels ${formatDate(subscription.cancel_at ?? subscription.current_period_end)}</span>`
  if (subscription.status === "trialing")
    return `<span class="chip ok">Trial ends ${formatDate(subscription.trial_end ?? subscription.current_period_end)}</span>`
  if (subscription.status === "past_due" || subscription.status === "unpaid")
    return `<span class="chip bad">Past due</span>`
  if (subscription.status === "paused") return `<span class="chip warn">Paused</span>`
  if (subscription.status === "incomplete") return `<span class="chip bad">Incomplete</span>`
  if (subscription.pause_collection !== null)
    return `<span class="chip warn">Payments paused${subscription.pause_collection.resumes_at === null ? "" : ` until ${formatDate(subscription.pause_collection.resumes_at)}`}</span>`
  return ""
}

const subscriptionCard = (context: PortalContext, subscription: SubscriptionRecord) => {
  const { scope, config } = context
  const items = subscriptionItems(scope, subscription)
  const lines = items
    .map((item) => {
      const price = scope.account.prices.get(item.price)
      const quantity = item.quantity ?? 1
      return `<div class="plan">${escapeHtml(productName(context, price))}${quantity > 1 ? ` × ${quantity}` : ""}</div>
<div class="price">${escapeHtml(priceLabel(price, quantity))}</div>`
    })
    .join("")
  const canceling = subscription.cancel_at_period_end || subscription.cancel_at !== null
  const manageable = ["active", "trialing", "past_due"].includes(subscription.status)
  const renews =
    subscription.status === "paused"
      ? "This subscription is paused."
      : canceling
        ? `Your plan will be canceled on ${formatDate(subscription.cancel_at ?? subscription.current_period_end)}.`
        : subscription.status === "trialing"
          ? `Your trial ends on ${formatDate(subscription.trial_end ?? subscription.current_period_end)}.`
          : `Your plan renews on ${formatDate(subscription.current_period_end)}.`
  const actions: string[] = []
  if (
    manageable &&
    !canceling &&
    config.features.subscription_update.enabled &&
    items.length === 1 &&
    portalProducts(scope.account, config).length > 0
  )
    actions.push(
      `<a class="btn primary" data-testid="stripe-mock-portal-update-plan" href="${context.base}?flow=update&amp;subscription=${subscription.id}">Update plan</a>`,
    )
  if (manageable && !canceling && config.features.subscription_cancel.enabled)
    actions.push(
      `<a class="btn" data-testid="stripe-mock-portal-cancel-plan" href="${context.base}?flow=cancel&amp;subscription=${subscription.id}">Cancel plan</a>`,
    )
  if (manageable && canceling)
    actions.push(
      `<form method="post"><input type="hidden" name="subscription" value="${subscription.id}"><button class="btn primary" name="action" value="renew" data-testid="stripe-mock-portal-renew">Renew plan</button></form>`,
    )
  return `<div class="card" data-testid="stripe-mock-portal-subscription" data-subscription-id="${subscription.id}" data-status="${subscription.status}">
${lines}${statusChip(subscription)}
<p class="meta">${escapeHtml(renews)}</p>
${actions.length > 0 ? `<div class="actions">${actions.join("")}</div>` : ""}
</div>`
}

const cardLabel = (method: PaymentMethodRecord) => {
  const card = method.card ?? {}
  const brand = String(card.brand ?? "card")
  return `${brand.charAt(0).toUpperCase()}${brand.slice(1)} •••• ${String(card.last4 ?? "")}`
}

const paymentMethodsSection = (context: PortalContext) => {
  const { scope, customer, config } = context
  const enabled = config.features.payment_method_update.enabled
  const methods = scope.account.paymentMethods
    .list({ order: "newest", where: (method) => method.customer === customer.id })
    .map((entry) => entry.value)
  const defaultId = customer.invoice_settings.default_payment_method
  const rows = methods
    .map((method) => {
      const card = method.card ?? {}
      const isDefault = method.id === defaultId
      const actions =
        enabled && !isDefault
          ? `<form method="post" class="actions" style="margin:0"><input type="hidden" name="payment_method" value="${method.id}"><button class="link" name="action" value="set_default_payment_method" data-testid="stripe-mock-portal-make-default">Make default</button><button class="link" name="action" value="detach_payment_method" data-testid="stripe-mock-portal-remove-payment-method">Delete</button></form>`
          : ""
      return `<div class="row" data-testid="stripe-mock-portal-payment-method" data-payment-method-id="${method.id}"><div><strong>${escapeHtml(cardLabel(method))}</strong>${isDefault ? '<span class="chip">Default</span>' : ""}<div class="meta">Expires ${String(card.exp_month ?? "").padStart(2, "0")}/${String(card.exp_year ?? "")}</div></div>${actions}</div>`
    })
    .join("")
  const add = enabled
    ? `<div class="actions"><a class="btn" href="${context.base}?flow=payment_method" data-testid="stripe-mock-portal-add-payment-method">Add payment method</a></div>`
    : ""
  return `<section data-testid="stripe-mock-portal-payment-methods"><h2>Payment method</h2>${rows || '<p class="meta">No payment method on file.</p>'}${add}</section>`
}

const billingSection = (context: PortalContext) => {
  const { customer, config } = context
  const address = customer.address
  const lines = [
    customer.name,
    customer.email,
    customer.phone,
    address === null
      ? null
      : [
          address.line1,
          address.line2,
          address.city,
          address.state,
          address.postal_code,
          address.country,
        ]
          .filter((part) => part !== null && part !== undefined && part !== "")
          .join(", ") || null,
  ].filter((line): line is string => line !== null && line !== undefined && line !== "")
  const update = config.features.customer_update.enabled
    ? `<div class="actions"><a class="btn" href="${context.base}?flow=customer_update" data-testid="stripe-mock-portal-update-customer">Update information</a></div>`
    : ""
  return `<section data-testid="stripe-mock-portal-billing"><h2>Billing information</h2>${lines.map((line) => `<p class="meta">${escapeHtml(line)}</p>`).join("") || '<p class="meta">No billing information.</p>'}${update}</section>`
}

const invoiceChip = (invoice: InvoiceRecord) =>
  invoice.status === "paid"
    ? '<span class="chip ok">Paid</span>'
    : invoice.status === "open"
      ? '<span class="chip bad">Due</span>'
      : `<span class="chip">${escapeHtml(invoice.status.charAt(0).toUpperCase() + invoice.status.slice(1))}</span>`

const invoicesSection = (context: PortalContext) => {
  if (!context.config.features.invoice_history.enabled) return ""
  const invoices = context.scope.account.invoices
    .list({
      order: "newest",
      where: (invoice) => invoice.customer === context.customer.id && invoice.status !== "draft",
    })
    .slice(0, 20)
    .map((entry) => entry.value)
  const rows = invoices
    .map((invoice) => {
      const pay =
        invoice.status === "open"
          ? `<form method="post" style="margin:0"><input type="hidden" name="invoice" value="${invoice.id}"><button class="btn primary" name="action" value="pay_invoice" data-testid="stripe-mock-portal-pay-invoice">Pay</button></form>`
          : ""
      return `<div class="row" data-testid="stripe-mock-portal-invoice" data-invoice-id="${invoice.id}" data-status="${invoice.status}"><div>${formatDate(invoice.created)}<div class="meta">${escapeHtml(invoice.number ?? invoice.id)}</div></div><div>${formatMoney(invoice.total, invoice.currency)} ${invoiceChip(invoice)}</div>${pay}</div>`
    })
    .join("")
  return `<section data-testid="stripe-mock-portal-invoices"><h2>Invoice history</h2>${rows || '<p class="meta">No invoices yet.</p>'}</section>`
}

const home = (context: PortalContext) => {
  const subscriptions = liveSubscriptions(context)
  return `<h1>Manage your billing</h1>
<section data-testid="stripe-mock-portal-subscriptions"><h2>${subscriptions.length > 1 ? "Current subscriptions" : "Current subscription"}</h2>
${subscriptions.map((subscription) => subscriptionCard(context, subscription)).join("") || '<p class="meta">No active subscriptions.</p>'}</section>
${paymentMethodsSection(context)}
${billingSection(context)}
${invoicesSection(context)}`
}

/** Where "Go back" leads: a deep-linked flow returns to the merchant, the portal to its home. */
const backHref = (context: PortalContext) =>
  context.session.flow !== null && !context.session.flow_completed
    ? (context.session.return_url ?? context.base)
    : context.base

const cancelPage = (context: PortalContext, subscriptionId: string, messages: PortalMessages) => {
  const { scope, config, session } = context
  const subscription = scope.account.subscriptions.get(subscriptionId)
  if (!subscription || subscription.customer !== context.customer.id) return home(context)
  const cancel = config.features.subscription_cancel
  const immediately = cancel.mode === "immediately"
  const when = immediately
    ? "Your subscription will be canceled immediately."
    : `Your subscription will be canceled, but is still available until the end of your billing period on ${formatDate(subscription.current_period_end)}.`
  const reasons = cancel.cancellation_reason.enabled
    ? `<h2>Tell us why you're canceling</h2>${cancel.cancellation_reason.options
        .filter((option) => (CANCELLATION_REASONS as readonly string[]).includes(option))
        .map(
          (option) =>
            `<label class="option" data-testid="stripe-mock-portal-reason-${escapeHtml(option)}"><input type="radio" name="reason" value="${option}" data-testid="stripe-mock-portal-reason"${messages.values?.reason === option ? " checked" : ""}><span>${escapeHtml(REASON_LABELS[option] ?? option)}</span></label>`,
        )
        .join(
          "",
        )}<label class="field"><span>Anything else? (optional)</span><textarea name="comment" data-testid="stripe-mock-portal-comment">${escapeHtml(messages.values?.comment ?? "")}</textarea></label>`
    : ""
  const retention = session.flow?.subscription_cancel?.retention
  const coupon =
    retention && session.flow?.subscription_cancel?.subscription === subscription.id
      ? scope.account.coupons.get(retention.coupon_offer.coupon)
      : undefined
  const offer =
    coupon === undefined
      ? ""
      : `<div class="offer" data-testid="stripe-mock-portal-offer"><strong>Before you go: ${escapeHtml(
          coupon.percent_off !== null
            ? `${coupon.percent_off}% off`
            : formatMoney(coupon.amount_off ?? 0, coupon.currency ?? subscription.currency),
        )}${coupon.duration === "repeating" && coupon.duration_in_months !== null ? ` for ${coupon.duration_in_months} months` : coupon.duration === "forever" ? " forever" : ""}</strong>
<form method="post" class="actions"><input type="hidden" name="subscription" value="${subscription.id}"><button class="btn primary" name="action" value="accept_retention" data-testid="stripe-mock-portal-accept-offer">Accept offer</button></form></div>`
  return `<h1>Cancel your plan</h1>
${offer}
<form method="post" data-testid="stripe-mock-portal-cancel-form">
<input type="hidden" name="subscription" value="${subscription.id}">
<div class="summary"><div class="plan">${escapeHtml(
    subscriptionItems(scope, subscription)
      .map((item) => productName(context, scope.account.prices.get(item.price)))
      .join(", "),
  )}</div><p class="meta">${escapeHtml(when)}</p></div>
${reasons}
<div class="actions"><button class="btn danger" name="action" value="cancel" data-testid="stripe-mock-portal-cancel-confirm">Cancel plan</button><a class="btn" href="${escapeHtml(backHref(context))}" data-testid="stripe-mock-portal-back">Go back</a></div>
</form>`
}

const updatePage = (context: PortalContext, subscriptionId: string, messages: PortalMessages) => {
  const { scope, config } = context
  const subscription = scope.account.subscriptions.get(subscriptionId)
  if (!subscription || subscription.customer !== context.customer.id) return home(context)
  const item = subscriptionItems(scope, subscription)[0]
  const allowed = config.features.subscription_update.default_allowed_updates
  const selected = messages.values?.price ?? item?.price
  const options = allowed.includes("price")
    ? portalProducts(scope.account, config)
        .flatMap((product) => product.prices)
        .map((priceId) => {
          const price = scope.account.prices.get(priceId)
          if (!price?.active) return ""
          return `<label class="option" data-testid="stripe-mock-portal-price-option-${escapeHtml(price.lookup_key ?? price.id)}"><input type="radio" name="price" value="${price.id}" data-testid="stripe-mock-portal-price-option"${price.id === selected ? " checked" : ""}><span><strong>${escapeHtml(productName(context, price))}</strong>${price.id === item?.price ? '<span class="chip">Current plan</span>' : ""}<div class="meta">${escapeHtml(priceLabel(price))}</div></span></label>`
        })
        .join("")
    : `<input type="hidden" name="price" value="${item?.price ?? ""}">`
  const quantity = allowed.includes("quantity")
    ? `<label class="field"><span>Quantity</span><input type="number" min="1" name="quantity" value="${escapeHtml(messages.values?.quantity ?? String(item?.quantity ?? 1))}" data-testid="stripe-mock-portal-quantity"></label>`
    : ""
  return `<h1>Update your plan</h1>
<form method="post" data-testid="stripe-mock-portal-update-form">
<input type="hidden" name="subscription" value="${subscription.id}">
${options}${quantity}
<div class="actions"><button class="btn primary" name="action" value="preview_update" data-testid="stripe-mock-portal-continue">Continue</button><a class="btn" href="${escapeHtml(backHref(context))}" data-testid="stripe-mock-portal-back">Go back</a></div>
</form>`
}

const confirmUpdatePage = (context: PortalContext, change: PortalChange) => {
  const { scope, config } = context
  const current = scope.account.subscriptionItems.get(change.itemId)
  const before = scope.account.prices.get(current?.price ?? "")
  const after = scope.account.prices.get(change.price)
  const due = previewProration(scope, config, change)
  const currency = after?.currency ?? change.subscription.currency
  const behavior = config.features.subscription_update.proration_behavior
  const dueLine =
    behavior === "always_invoice" || resetsBillingPeriod(scope, change)
      ? due < 0
        ? `<div class="row total"><span>Credit to your balance</span><span data-testid="stripe-mock-portal-amount-due">−${formatMoney(-due, currency)}</span></div>`
        : `<div class="row total"><span>Amount due today</span><span data-testid="stripe-mock-portal-amount-due">${formatMoney(due, currency)}</span></div>`
      : `<div class="row total"><span>Adjustment on your next invoice</span><span data-testid="stripe-mock-portal-amount-due">${due < 0 ? "−" : ""}${formatMoney(Math.abs(due), currency)}</span></div>`
  return `<h1>Confirm your new plan</h1>
<div class="summary" data-testid="stripe-mock-portal-update-summary">
<div class="row"><span>Current plan</span><span>${escapeHtml(productName(context, before))} · ${escapeHtml(priceLabel(before, current?.quantity ?? 1))}</span></div>
<div class="row"><span>New plan</span><span>${escapeHtml(productName(context, after))} · ${escapeHtml(priceLabel(after, change.quantity))}</span></div>
${dueLine}
</div>
<form method="post">
<input type="hidden" name="subscription" value="${change.subscription.id}"><input type="hidden" name="price" value="${change.price}"><input type="hidden" name="quantity" value="${change.quantity}">
<div class="actions"><button class="btn primary" name="action" value="update" data-testid="stripe-mock-portal-confirm-update">Confirm</button><a class="btn" href="${escapeHtml(backHref(context))}" data-testid="stripe-mock-portal-back">Go back</a></div>
</form>`
}

const paymentMethodPage = (context: PortalContext, messages: PortalMessages) => {
  const value = (key: string) =>
    messages.values?.[key] ? ` value="${escapeHtml(messages.values[key])}"` : ""
  const cards = HOSTED_PAGE_TEST_CARDS.map(
    (card) =>
      `<button type="button" data-test-card="${card.number}" data-testid="stripe-mock-portal-test-card" title="${escapeHtml(card.hint)}">${escapeHtml(card.label)} ${card.number.slice(-4)}</button>`,
  ).join("")
  return `<h1>Add payment method</h1>
<div class="testcards">${cards}</div>
<form method="post" data-testid="stripe-mock-portal-payment-form">
<label class="field"><span>Card number</span><input type="text" id="card" name="card" inputmode="numeric" autocomplete="cc-number" placeholder="1234 1234 1234 1234" maxlength="23" data-testid="stripe-mock-portal-card"${value("card")}></label>
<div class="split"><label class="field"><span>Expiration</span><input type="text" id="exp" name="exp" inputmode="numeric" autocomplete="cc-exp" maxlength="7" placeholder="MM / YY" data-testid="stripe-mock-portal-exp"${value("exp")}></label>
<label class="field"><span>CVC</span><input type="text" id="cvc" name="cvc" inputmode="numeric" autocomplete="cc-csc" maxlength="4" placeholder="CVC" data-testid="stripe-mock-portal-cvc"${value("cvc")}></label></div>
<label class="field"><span>Name on card</span><input type="text" id="name" name="name" autocomplete="cc-name" data-testid="stripe-mock-portal-name"${value("name")}></label>
<div class="split"><label class="field"><span>Country</span><input type="text" id="country" name="country" autocomplete="country" maxlength="2" value="${escapeHtml(messages.values?.country ?? "US")}" data-testid="stripe-mock-portal-country"></label>
<label class="field"><span>ZIP</span><input type="text" id="zip" name="zip" autocomplete="postal-code" maxlength="10" data-testid="stripe-mock-portal-zip"${value("zip")}></label></div>
<div class="actions"><button class="btn primary" name="action" value="add_payment_method" data-testid="stripe-mock-portal-save-card">Add</button><a class="btn" href="${escapeHtml(backHref(context))}" data-testid="stripe-mock-portal-back">Go back</a></div>
</form>`
}

const customerUpdatePage = (context: PortalContext) => {
  const { customer, config } = context
  const allowed = config.features.customer_update.allowed_updates
  const field = (name: string, label: string, current: string | null | undefined, type = "text") =>
    `<label class="field"><span>${label}</span><input type="${type}" name="${name}" value="${escapeHtml(current ?? "")}" data-testid="stripe-mock-portal-${name.replace(/_/g, "-")}"></label>`
  const address = customer.address
  return `<h1>Update billing information</h1>
<form method="post" data-testid="stripe-mock-portal-customer-form">
${allowed.includes("name") ? field("name", "Name", customer.name) : ""}
${allowed.includes("email") ? field("email", "Email", customer.email, "email") : ""}
${allowed.includes("phone") ? field("phone", "Phone", customer.phone) : ""}
${
  allowed.includes("address")
    ? `${field("line1", "Address", address?.line1)}${field("line2", "Address line 2", address?.line2)}<div class="split">${field("city", "City", address?.city)}${field("state", "State", address?.state)}</div><div class="split">${field("postal_code", "Postal code", address?.postal_code)}${field("country", "Country", address?.country)}</div>`
    : ""
}
<div class="actions"><button class="btn primary" name="action" value="update_customer" data-testid="stripe-mock-portal-save-customer">Save</button><a class="btn" href="${escapeHtml(backHref(context))}" data-testid="stripe-mock-portal-back">Go back</a></div>
</form>`
}

const confirmation = (context: PortalContext, message: string) =>
  `<div class="done" data-testid="stripe-mock-portal-confirmation"><div class="mark">✓</div><h1>${escapeHtml(message)}</h1>${
    context.session.return_url === null
      ? ""
      : `<p><a class="btn primary" href="${escapeHtml(context.session.return_url)}">Return to ${escapeHtml(context.merchant)}</a></p>`
  }</div>`

/**
 * The customer portal served in place of billing.stripe.com: the customer's subscriptions (update,
 * cancel, renew), payment methods (add, make default, delete), billing information and invoice
 * history, as the session's configuration allows. Stable `data-testid`s let UI suites drive it.
 */
export const portalPage = (
  context: PortalContext,
  view: PortalView,
  messages: PortalMessages = {},
) => {
  const { session, customer, merchant, config } = context
  const body =
    view.kind === "cancel"
      ? cancelPage(context, view.subscription, messages)
      : view.kind === "update"
        ? updatePage(context, view.subscription, messages)
        : view.kind === "confirm_update"
          ? confirmUpdatePage(context, view.change)
          : view.kind === "payment_method"
            ? paymentMethodPage(context, messages)
            : view.kind === "customer_update"
              ? customerUpdatePage(context)
              : view.kind === "confirmation"
                ? confirmation(context, view.message)
                : home(context)
  const profile = config.business_profile
  const legal = [
    profile.terms_of_service_url === null
      ? ""
      : `<a href="${escapeHtml(profile.terms_of_service_url)}">Terms</a>`,
    profile.privacy_policy_url === null
      ? ""
      : `<a href="${escapeHtml(profile.privacy_policy_url)}">Privacy</a>`,
  ].join("")
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(merchant)} — Billing</title>
<meta name="viewport" content="width=device-width, initial-scale=1"><style>${STYLES}</style></head>
<body data-testid="stripe-mock-portal" data-session-id="${session.id}" data-customer-id="${customer.id}" data-view="${view.kind}">
<div class="app">
<aside class="side"><div class="inner">
<div class="merchant"><span class="avatar">${escapeHtml(initials(merchant) || "?")}</span>${escapeHtml(merchant)} <span class="badge">Test mode</span></div>
${profile.headline === null ? "" : `<p class="tagline">${escapeHtml(profile.headline)}</p>`}
${session.return_url === null ? "" : `<a class="back" href="${escapeHtml(session.return_url)}" data-testid="stripe-mock-portal-return">← Return to ${escapeHtml(merchant)}</a>`}
<div class="legal"><span>Powered by <b>stripe</b></span>${legal}</div>
</div></aside>
<main class="main"><div class="inner">
${messages.notice ? `<p class="notice" role="status" data-testid="stripe-mock-portal-notice">${escapeHtml(messages.notice)}</p>` : ""}
${messages.error ? `<p class="error" role="alert" data-testid="stripe-mock-portal-error">${escapeHtml(messages.error)}</p>` : ""}
${body}
</div></main>
</div>
<script>${SCRIPT}</script>
</body></html>`
}
