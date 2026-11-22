import type { OperationContext, OperationHandler } from "@crvouga/mockingbird-service"
import { afterIntentSucceeded } from "./billing.js"
import { portalChange, runPortalAction } from "./billing-portal.js"
import {
  amountDueNow,
  type CompletionInput,
  completeSession,
  requiresCard,
  successUrlFor,
} from "./checkout.js"
import { type CheckoutPageView, checkoutPage } from "./checkout-page.js"
import { promotionCodeFor, repriceSession } from "./checkout-sessions.js"
import { requestInfo } from "./context.js"
import { invalidRequest, parameterMissing, resourceMissing, StripeError } from "./errors.js"
import { findCustomer, type RequestScope, type Services, scopeForAccount } from "./internal.js"
import { confirmIntent } from "./payments.js"
import { type PortalMessages, type PortalView, portalContext, portalPage } from "./portal-page.js"
import { renderPaymentIntent, renderSetupIntent } from "./render.js"
import { confirmSetup } from "./setup-intents.js"
import { type CheckoutSessionRecord, seconds } from "./state.js"
import { stripeJs } from "./stripe-js.js"

const html = (status: number, body: string) =>
  new Response(`<!doctype html>\n${body}`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  })

/** The emulator's "not found" page (React, prebuilt in `#ui/server`, loaded only when served). */
const missing = async (message: string) =>
  new Response((await import("#ui/server")).notFoundPage(message), {
    status: 404,
    headers: { "content-type": "text/html; charset=utf-8" },
  })

const notFound = () => missing("Unknown Checkout Session.")

/** Everything the hosted page shows besides the session: merchant, customer, catalog details. */
const viewFor = (
  scope: RequestScope,
  session: CheckoutSessionRecord,
  extra: Pick<CheckoutPageView, "values" | "error" | "notice" | "promotionError"> = {},
): CheckoutPageView => {
  const account = scope.account
  const merchant = scope.services.accounts.config(account.account)?.displayName ?? "Test business"
  const customer = session.customer === null ? undefined : findCustomer(scope, session.customer)
  const promotion = (session.discount_refs ?? []).find((ref) => ref.promotion_code !== null)
  return {
    ...extra,
    session,
    merchant,
    customerEmail: customer?.email ?? session.customer_email ?? null,
    dueNow: amountDueNow(scope, session),
    needsCard: requiresCard(scope, session),
    allowPromotionCodes: session.allow_promotion_codes === true,
    promotionCode:
      promotion?.promotion_code == null
        ? null
        : (account.promotionCodes.get(promotion.promotion_code)?.code ?? null),
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
    ["email", "card", "exp", "cvc", "name", "country", "zip", "promotion_code"]
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

const formOf = (context: OperationContext): Record<string, string> => {
  const value = context.body.kind === "form" ? context.body.value : undefined
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  )
}

const portalScope = (services: Services, context: OperationContext) => {
  const id = context.params.session ?? ""
  const account = findAccount(services, (partition) => partition.portalSessions.has(id))
  if (account === undefined) return undefined
  const scope = scopeForAccount(services, context, account)
  const session = scope.account.portalSessions.get(id)
  const portal = session === undefined ? undefined : portalContext(scope, session)
  return portal === undefined ? undefined : { scope, portal }
}

const portalNotFound = () => missing("This portal session is invalid or has expired.")

/** The page a portal session opens on: its deep-linked flow until that completes, else home. */
const openingView = (
  portal: NonNullable<ReturnType<typeof portalContext>>,
  query: Record<string, unknown>,
): { view: PortalView; messages?: PortalMessages } => {
  const subscription = typeof query.subscription === "string" ? query.subscription : ""
  if (query.flow === "cancel" && subscription !== "")
    return { view: { kind: "cancel", subscription } }
  if (query.flow === "update" && subscription !== "")
    return { view: { kind: "update", subscription } }
  if (query.flow === "payment_method") return { view: { kind: "payment_method" } }
  if (query.flow === "customer_update") return { view: { kind: "customer_update" } }
  const { session, scope, config } = portal
  const flow = session.flow
  if (flow === null || session.flow_completed) return { view: { kind: "home" } }
  if (flow.type === "subscription_cancel" && flow.subscription_cancel)
    return { view: { kind: "cancel", subscription: flow.subscription_cancel.subscription } }
  if (flow.type === "subscription_update" && flow.subscription_update)
    return { view: { kind: "update", subscription: flow.subscription_update.subscription } }
  if (flow.type === "subscription_update_confirm" && flow.subscription_update_confirm) {
    const confirm = flow.subscription_update_confirm
    const item = confirm.items[0]
    try {
      const change = portalChange(scope, session, config, {
        subscription: confirm.subscription,
        price: item?.price ?? "",
        quantity: String(item?.quantity ?? ""),
      })
      return { view: { kind: "confirm_update", change } }
    } catch (error) {
      if (!(error instanceof StripeError)) throw error
      return { view: { kind: "home" }, messages: { error: error.init.message } }
    }
  }
  if (flow.type === "payment_method_update") return { view: { kind: "payment_method" } }
  if (flow.type === "customer_update") return { view: { kind: "customer_update" } }
  return { view: { kind: "home" } }
}

/** The page a refused portal form goes back to, with the error shown. */
const viewForAction = (form: Record<string, string>): PortalView => {
  const subscription = form.subscription ?? ""
  switch (form.action) {
    case "cancel":
    case "accept_retention":
      return { kind: "cancel", subscription }
    case "preview_update":
    case "update":
      return { kind: "update", subscription }
    case "add_payment_method":
      return { kind: "payment_method" }
    case "update_customer":
      return { kind: "customer_update" }
    default:
      return { kind: "home" }
  }
}

const text = (form: Record<string, unknown>, key: string): string | null => {
  const value = form[key]
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null
}

/**
 * The card fields as Stripe's Payment Element checks them before anything is charged. Blank
 * expiry and CVC are accepted (scripted posts send only a number); anything typed must be valid.
 */
export const readCardFields = (
  form: Record<string, unknown>,
  nowSeconds: number,
): { ok: true; input: Omit<CompletionInput, "card"> } | { ok: false; message: string } => {
  const email = text(form, "email")
  if (email !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return { ok: false, message: "Your email address is invalid." }
  const exp = text(form, "exp")
  let expMonth: number | undefined
  let expYear: number | undefined
  if (exp !== null) {
    const match = /^(\d{1,2})\s*\/?\s*(\d{2}|\d{4})$/.exec(exp.replace(/\s+/g, ""))
    if (!match) return { ok: false, message: "Your card's expiration date is incomplete." }
    expMonth = Number(match[1])
    expYear = Number(match[2]) + ((match[2] ?? "").length === 2 ? 2000 : 0)
    if (expMonth < 1 || expMonth > 12)
      return { ok: false, message: "Your card's expiration date is invalid." }
    const now = new Date(nowSeconds * 1000)
    const year = now.getUTCFullYear()
    if (expYear < year) return { ok: false, message: "Your card's expiration year is in the past." }
    if (expYear === year && expMonth < now.getUTCMonth() + 1)
      return { ok: false, message: "Your card's expiration date is in the past." }
  }
  const cvc = text(form, "cvc")
  if (cvc !== null && !/^\d{3,4}$/.test(cvc))
    return { ok: false, message: "Your card's security code is incomplete." }
  return {
    ok: true,
    input: {
      email,
      name: text(form, "name"),
      country: text(form, "country"),
      postalCode: text(form, "zip"),
      ...(expMonth === undefined ? {} : { expMonth }),
      ...(expYear === undefined ? {} : { expYear }),
    },
  }
}

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
    const values = postedValues(form)
    // Only a session created with `allow_promotion_codes` takes codes typed on the page.
    const promotionAction =
      form.action === "apply_promotion_code" || form.action === "remove_promotion_code"
    if (promotionAction && session.allow_promotion_codes !== true)
      return page(session, { values, error: "Promotion codes are not accepted for this purchase." })
    if (form.action === "apply_promotion_code") {
      const code = typeof form.promotion_code === "string" ? form.promotion_code : ""
      const found = promotionCodeFor(scope, session, code)
      if ("error" in found) return page(session, { values, promotionError: found.error })
      return page(repriceSession(scope, session, [found]))
    }
    if (form.action === "remove_promotion_code") return page(repriceSession(scope, session, []))
    const fields = readCardFields(form, seconds(scope.now))
    if (!fields.ok) return page(session, { values, error: fields.message })
    const typed = text(form, "card")
    const card = typed ?? (requiresCard(scope, session) ? "4242424242424242" : null)
    try {
      const result = completeSession(scope, session, { ...fields.input, card })
      if (!result.ok) return page(session, { values, error: result.message })
      const target = successUrlFor(result.session)
      return target === null ? page(result.session) : redirect(target)
    } catch (error) {
      if (error instanceof StripeError) return page(session, { values, error: error.init.message })
      throw error
    }
  },
  GetPortalPage: (context) => {
    const found = portalScope(services, context)
    if (!found) return portalNotFound()
    const opening = openingView(found.portal, context.query)
    return html(200, portalPage(found.portal, opening.view, opening.messages))
  },
  PostPortalPage: (context) => {
    const found = portalScope(services, context)
    if (!found) return portalNotFound()
    const { scope, portal } = found
    const form = formOf(context)
    const page = (view: PortalView, messages?: PortalMessages) => {
      // Re-read: the action may have changed the customer, session or subscriptions.
      const fresh = portalContext(
        scope,
        scope.account.portalSessions.get(portal.session.id) ?? portal.session,
      )
      return html(200, portalPage(fresh ?? portal, view, messages))
    }
    const values = Object.fromEntries(
      Object.entries(form).filter(([key]) => !["card", "cvc"].includes(key)),
    )
    try {
      if (form.action === "preview_update") {
        const change = portalChange(scope, portal.session, portal.config, form)
        return page({ kind: "confirm_update", change })
      }
      let input = {}
      if (form.action === "add_payment_method") {
        const fields = readCardFields(form, seconds(scope.now))
        if (!fields.ok) return page(viewForAction(form), { error: fields.message, values })
        input = fields.input
      }
      const outcome = runPortalAction(scope, portal.session, form, { input })
      if ("redirect" in outcome) return redirect(outcome.redirect)
      if ("confirmation" in outcome)
        return page({ kind: "confirmation", message: outcome.confirmation })
      return page({ kind: "home" }, { notice: outcome.notice })
    } catch (error) {
      if (error instanceof StripeError)
        return page(viewForAction(form), { error: error.init.message, values })
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
