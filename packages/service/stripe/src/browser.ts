import type { OperationContext, OperationHandler } from "@crvouga/mockingbird-service"
import { afterIntentSucceeded } from "./billing.js"
import { completeSession, successUrlFor } from "./checkout.js"
import { type CheckoutPageView, checkoutPage } from "./checkout-page.js"
import { requestInfo } from "./context.js"
import { invalidRequest, parameterMissing, resourceMissing, StripeError } from "./errors.js"
import { findCustomer, type RequestScope, type Services, scopeForAccount } from "./internal.js"
import { confirmIntent } from "./payments.js"
import { renderPaymentIntent, renderSetupIntent } from "./render.js"
import { confirmSetup } from "./setup-intents.js"
import type { CheckoutSessionRecord } from "./state.js"
import { stripeJs } from "./stripe-js.js"

const html = (status: number, body: string) =>
  new Response(`<!doctype html>\n${body}`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  })

const notFound = () => html(404, "<title>Not found</title><p>Unknown Checkout Session.</p>")

/** Everything the hosted page shows besides the session: merchant, customer, catalog details. */
const viewFor = (
  scope: RequestScope,
  session: CheckoutSessionRecord,
  extra: Pick<CheckoutPageView, "values" | "error" | "notice"> = {},
): CheckoutPageView => {
  const account = scope.account
  const merchant = scope.services.accounts.config(account.account)?.displayName ?? "Test business"
  const customer = session.customer === null ? undefined : findCustomer(scope, session.customer)
  return {
    ...extra,
    session,
    merchant,
    customerEmail: customer?.email ?? null,
    lines: session.line_items.map((line) => {
      const price = line.price === null ? undefined : account.prices.get(line.price)
      const productId = price?.product ?? (line as { product?: string | null }).product ?? null
      const product = productId === null ? undefined : account.products.get(productId)
      const recurring = price?.recurring ?? null
      return {
        name: line.description ?? product?.name ?? "Item",
        description: product?.description ?? null,
        image: product?.images[0] ?? null,
        quantity: line.quantity ?? 1,
        unitAmount: line.unit_amount,
        amount: line.amount_subtotal,
        currency: line.currency,
        interval:
          recurring === null
            ? null
            : recurring.interval_count === 1
              ? recurring.interval
              : `${recurring.interval_count} ${recurring.interval}s`,
      }
    }),
  }
}

/** The fields a shopper typed, echoed back after a decline (never stored). */
const postedValues = (form: Record<string, unknown>): Record<string, string> =>
  Object.fromEntries(
    ["email", "card", "exp", "cvc", "name", "country", "zip"]
      .map((key) => [key, form[key]])
      .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )

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
    if (!found) return notFound()
    return html(200, checkoutPage(viewFor(found.scope, found.session)))
  },
  PostCheckoutPage: (context) => {
    const found = sessionScope(services, context)
    if (!found) return notFound()
    const { scope, session } = found
    const form =
      context.body.kind === "form" &&
      typeof context.body.value === "object" &&
      context.body.value !== null
        ? (context.body.value as Record<string, unknown>)
        : {}
    const page = (current: CheckoutSessionRecord, extra?: Parameters<typeof viewFor>[2]) =>
      html(200, checkoutPage(viewFor(scope, current, extra)))
    if (form.action === "cancel") {
      if (session.cancel_url !== null) return redirect(session.cancel_url)
      return page(session, { notice: "Checkout canceled." })
    }
    if (session.status !== "open") return page(session)
    const card =
      typeof form.card === "string" && form.card.trim() !== "" ? form.card : "4242424242424242"
    const values = postedValues(form)
    try {
      const result = completeSession(scope, session, card)
      if (!result.ok) return page(session, { values, error: result.message })
      const target = successUrlFor(result.session)
      return target === null ? page(result.session) : redirect(target)
    } catch (error) {
      if (error instanceof StripeError) return page(session, { values, error: error.init.message })
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
