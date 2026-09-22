import type { OperationContext, OperationHandler } from "@crvouga/mockingbird-service"
import { afterIntentSucceeded } from "./billing.js"
import { completeSession, successUrlFor } from "./checkout.js"
import { requestInfo } from "./context.js"
import { invalidRequest, parameterMissing, resourceMissing, StripeError } from "./errors.js"
import { type Services, scopeForAccount } from "./internal.js"
import { confirmIntent } from "./payments.js"
import { renderPaymentIntent, renderSetupIntent } from "./render.js"
import { confirmSetup } from "./setup-intents.js"
import type { CheckoutSessionRecord } from "./state.js"
import { stripeJs } from "./stripe-js.js"

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)

const money = (amount: number, currency: string) =>
  `${(amount / 100).toFixed(2)} ${currency.toUpperCase()}`

const html = (status: number, body: string) =>
  new Response(`<!doctype html>\n${body}`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  })

/**
 * The hosted Checkout page served in place of checkout.stripe.com: a plain form with stable
 * `data-testid`s so UI suites can fill it (`stripe-mock-card`, `-exp`, `-cvc`, `-zip`, `-pay`,
 * `-cancel`). Card numbers post straight to the mock and are mapped to a test token on arrival;
 * they are never stored or logged.
 */
const checkoutPage = (session: CheckoutSessionRecord, error?: string) => {
  const lines = session.line_items
    .map(
      (line) =>
        `<li data-testid="stripe-mock-line">${escapeHtml(line.description ?? "Item")} × ${line.quantity ?? 1} — ${money(line.amount_total, line.currency)}</li>`,
    )
    .join("")
  const open = session.status === "open"
  return `<html lang="en"><head><meta charset="utf-8"><title>Mockingbird Checkout</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font-family:system-ui,sans-serif;max-width:28rem;margin:2rem auto;padding:0 1rem}
label{display:block;margin:.5rem 0 .2rem}input{width:100%;padding:.5rem;box-sizing:border-box}
button{margin-top:1rem;padding:.6rem 1rem}.error{color:#b00020}</style></head>
<body data-testid="stripe-mock-checkout" data-session-id="${escapeHtml(session.id)}" data-status="${session.status}">
<h1>Checkout</h1>
<p data-testid="stripe-mock-mode">${escapeHtml(session.mode)}</p>
<ul>${lines}</ul>
<p data-testid="stripe-mock-total">Total: ${money(session.amount_total, session.currency)}</p>
${error ? `<p class="error" role="alert" data-testid="stripe-mock-error">${escapeHtml(error)}</p>` : ""}
${
  open
    ? `<form method="post" data-testid="stripe-mock-form">
<label for="card">Card number</label><input id="card" name="card" data-testid="stripe-mock-card" inputmode="numeric" autocomplete="cc-number" placeholder="4242 4242 4242 4242">
<label for="exp">Expiry (MM/YY)</label><input id="exp" name="exp" data-testid="stripe-mock-exp" autocomplete="cc-exp" placeholder="12/34">
<label for="cvc">CVC</label><input id="cvc" name="cvc" data-testid="stripe-mock-cvc" autocomplete="cc-csc" placeholder="123">
<label for="zip">ZIP</label><input id="zip" name="zip" data-testid="stripe-mock-zip" autocomplete="postal-code" placeholder="94107">
<button type="submit" name="action" value="pay" data-testid="stripe-mock-pay">Pay</button>
<button type="submit" name="action" value="cancel" data-testid="stripe-mock-cancel" formnovalidate>Cancel</button>
</form>`
    : `<p data-testid="stripe-mock-closed">This Checkout Session is ${escapeHtml(session.status)}.</p>`
}
</body></html>`
}

/** The account partition holding an object, searched across the namespace. */
const findAccount = (
  services: Services,
  has: (account: ReturnType<Services["state"]["for"]>) => boolean,
): string | undefined => services.state.accounts().find(has)?.account

const sessionScope = (services: Services, context: OperationContext) => {
  const id = context.params.session ?? ""
  const account = findAccount(services, (partition) => partition.checkoutSessions.has(id))
  if (account === undefined) return undefined
  const scope = scopeForAccount(services, context, account)
  const session = scope.account.checkoutSessions.get(id)
  return session === undefined ? undefined : { scope, session }
}

const redirect = (location: string) => new Response(null, { status: 302, headers: { location } })

export const browserHandlers = (services: Services): Record<string, OperationHandler> => ({
  GetCheckoutPage: (context) => {
    const found = sessionScope(services, context)
    if (!found) return html(404, "<title>Not found</title><p>Unknown Checkout Session.</p>")
    return html(200, checkoutPage(found.session))
  },
  PostCheckoutPage: (context) => {
    const found = sessionScope(services, context)
    if (!found) return html(404, "<title>Not found</title><p>Unknown Checkout Session.</p>")
    const { scope, session } = found
    const form =
      context.body.kind === "form" &&
      typeof context.body.value === "object" &&
      context.body.value !== null
        ? (context.body.value as Record<string, unknown>)
        : {}
    if (form.action === "cancel") {
      if (session.cancel_url !== null) return redirect(session.cancel_url)
      return html(200, checkoutPage(session, "Checkout canceled."))
    }
    if (session.status !== "open") return html(200, checkoutPage(session))
    const card =
      typeof form.card === "string" && form.card.trim() !== "" ? form.card : "4242424242424242"
    try {
      const result = completeSession(scope, session, card)
      if (!result.ok) return html(200, checkoutPage(session, result.message))
      const target = successUrlFor(result.session)
      return target === null ? html(200, checkoutPage(result.session)) : redirect(target)
    } catch (error) {
      if (error instanceof StripeError) return html(200, checkoutPage(session, error.init.message))
      throw error
    }
  },
  GetStripeJs: (context) =>
    new Response(
      stripeJs(
        services.publicUrl ?? `${requestInfo(context.request).origin}${services.namespacePrefix}`,
      ),
      {
        status: 200,
        headers: {
          "content-type": "application/javascript; charset=utf-8",
          "access-control-allow-origin": "*",
          "cache-control": "no-store",
        },
      },
    ),
  PostThreeDSecureAuthenticate: (context) => {
    const id = context.params.intent ?? ""
    const form =
      context.body.kind === "form" &&
      typeof context.body.value === "object" &&
      context.body.value !== null
        ? (context.body.value as Record<string, unknown>)
        : {}
    const secret = typeof form.client_secret === "string" ? form.client_secret : ""
    if (secret === "") throw parameterMissing("client_secret")
    const account = findAccount(
      services,
      (partition) => partition.paymentIntents.has(id) || partition.setupIntents.has(id),
    )
    if (account === undefined) throw resourceMissing("payment_intent", id, "intent")
    const scope = scopeForAccount(services, context, account)
    const intent = scope.account.paymentIntents.get(id)
    if (intent !== undefined) {
      if (intent.client_secret !== secret)
        throw invalidRequest("The client_secret provided does not match.", "client_secret")
      if (intent.status !== "requires_action" || intent.payment_method === null)
        return Response.json(renderPaymentIntent(intent))
      const method = scope.account.paymentMethods.get(intent.payment_method)
      if (!method) throw resourceMissing("PaymentMethod", intent.payment_method, "payment_method")
      const settled = confirmIntent(scope, intent, method, {
        offSession: false,
        autoAuthenticate: true,
      })
      afterIntentSucceeded(scope, settled)
      return Response.json(renderPaymentIntent(scope.account.paymentIntents.get(id) ?? settled))
    }
    const setup = scope.account.setupIntents.get(id)
    if (!setup) throw resourceMissing("setup_intent", id, "intent")
    if (setup.client_secret !== secret)
      throw invalidRequest("The client_secret provided does not match.", "client_secret")
    if (setup.status !== "requires_action" || setup.payment_method === null)
      return Response.json(renderSetupIntent(setup))
    const method = scope.account.paymentMethods.get(setup.payment_method)
    if (!method) throw resourceMissing("PaymentMethod", setup.payment_method, "payment_method")
    return Response.json(renderSetupIntent(confirmSetup(scope, setup, method, true)))
  },
})
