import { jsonResponse, type OperationHandler } from "@crvouga/mockingbird-service"
import { invalidRequest, parameterMissing } from "./errors.js"
import { applyExpand, type ExpandResolvers } from "./expand.js"
import {
  clientSecretFor,
  createDiscount,
  type RequestScope,
  requestScope,
  requirePrice,
  requireSession,
  requireSubscription,
  type Services,
} from "./internal.js"
import { matchesCreated, paginate } from "./list.js"
import { bodyParams, type Params, queryParams } from "./params.js"
import {
  renderCheckoutLineItem,
  renderCheckoutSession,
  renderInvoice,
  renderSubscription,
} from "./render.js"
import {
  type CheckoutSessionLineRecord,
  type CheckoutSessionRecord,
  type Metadata,
  seconds,
} from "./state.js"
import { createSubscriptionRecord } from "./subscriptions.js"

const stringOf = (params: Params, key: string): string | null => {
  const value = params[key]
  return typeof value === "string" && value !== "" ? value : null
}

const intOf = (value: unknown): number | undefined => {
  if (value === undefined || value === "") return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.trunc(parsed) : undefined
}

type RequestedLine = {
  priceId: string | null
  currency: string
  quantity: number
  unitAmount: number
  description: string | null
}

/** `line_items[0][price]` / `line_items[0][price_data][…]`, decoded by the form codec. */
const requestedLines = (scope: RequestScope, params: Params): RequestedLine[] => {
  const raw = params.line_items
  if (!Array.isArray(raw) || raw.length === 0) throw parameterMissing("line_items")
  const lines: RequestedLine[] = []
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue
    const line = entry as Record<string, unknown>
    const quantity = intOf(line.quantity) ?? 1
    const priceId = typeof line.price === "string" && line.price !== "" ? line.price : null
    if (priceId !== null) {
      const price = requirePrice(scope, priceId)
      lines.push({
        priceId,
        currency: price.currency,
        description: null,
        quantity,
        unitAmount: Math.round(Number(price.unit_amount_decimal)),
      })
      continue
    }
    const priceData = line.price_data
    if (typeof priceData !== "object" || priceData === null)
      throw parameterMissing("line_items[0][price]")
    const data = priceData as Record<string, unknown>
    const currency = typeof data.currency === "string" ? data.currency : "usd"
    const unitAmount = intOf(data.unit_amount) ?? 0
    const productData = data.product_data
    const name =
      typeof productData === "object" &&
      productData !== null &&
      typeof (productData as Record<string, unknown>).name === "string"
        ? ((productData as Record<string, unknown>).name as string)
        : null
    lines.push({
      priceId: null,
      currency,
      description: name,
      quantity,
      unitAmount,
    })
  }
  if (lines.length === 0) throw parameterMissing("line_items")
  return lines
}

const sessionLines = (
  scope: RequestScope,
  requested: RequestedLine[],
): CheckoutSessionLineRecord[] =>
  requested.map((line) => ({
    id: scope.ids.next("li_"),
    amount_subtotal: line.unitAmount * line.quantity,
    amount_total: line.unitAmount * line.quantity,
    currency: line.currency,
    description: line.description,
    price: line.priceId,
    quantity: line.quantity,
    unit_amount: line.unitAmount,
  }))

export const checkoutSessionHandlers = (services: Services): Record<string, OperationHandler> => {
  const expanders = (scope: RequestScope): ExpandResolvers => ({
    payment_intent: (id) => scope.account.paymentIntents.get(id),
    setup_intent: (id) => scope.account.setupIntents.get(id),
    subscription: (id) => {
      const subscription = scope.account.subscriptions.get(id)
      return subscription ? renderSubscription(subscription, scope.account) : undefined
    },
    customer: (id) => {
      const entry = scope.account.customers.get(id)
      return entry?.kind === "live" ? entry.customer : undefined
    },
    invoice: (id) => {
      const invoice = scope.account.invoices.get(id)
      return invoice ? renderInvoice(invoice, scope.account) : undefined
    },
  })

  const render = (scope: RequestScope, record: CheckoutSessionRecord, params: Params) =>
    applyExpand(renderCheckoutSession(record), params.expand, expanders(scope))

  return {
    GetCheckoutSessions: async (context) => {
      const scope = requestScope(services, context)
      const params = queryParams(context)
      const customer = stringOf(params, "customer")
      const status = stringOf(params, "status")
      const paymentIntent = stringOf(params, "payment_intent")
      const subscription = stringOf(params, "subscription")
      return jsonResponse(
        200,
        await paginate<CheckoutSessionRecord>(scope.account.checkoutSessions, params, {
          url: "/v1/checkout/sessions",
          kind: "checkout.session",
          where: (record) =>
            matchesCreated(record.created, params.created) &&
            (customer === null || record.customer === customer) &&
            (status === null || record.status === status) &&
            (paymentIntent === null || record.payment_intent === paymentIntent) &&
            (subscription === null || record.subscription === subscription),
          render: (record) => render(scope, record, params),
        }),
      )
    },
    PostCheckoutSessions: async (context) => {
      const scope = requestScope(services, context)
      const params = bodyParams(context)
      const mode = stringOf(params, "mode") ?? "payment"
      if (mode !== "payment" && mode !== "setup" && mode !== "subscription")
        throw invalidRequest("Invalid mode.", "mode")
      let customer = stringOf(params, "customer")
      if (customer !== null) {
        const entry = scope.account.customers.get(customer)
        if (!entry || entry.kind === "deleted")
          throw invalidRequest(`No such customer: '${customer}'`, "customer", "resource_missing")
      } else if (stringOf(params, "customer_creation") === "always") {
        const id = scope.ids.next("cus_")
        scope.account.customers.insert(id, {
          kind: "live",
          customer: {
            id,
            address: null,
            balance: 0,
            created: seconds(scope.now),
            currency: null,
            description: null,
            email: null,
            invoice_prefix: `MOCKING${id.slice(-4).toUpperCase()}`,
            invoice_settings: {
              custom_fields: null,
              default_payment_method: null,
              footer: null,
              rendering_options: null,
            },
            metadata: {},
            name: null,
            phone: null,
            preferred_locales: [],
            shipping: null,
            tax_exempt: "none",
          },
        })
        customer = id
      }
      const requested = requestedLines(scope, params)
      const lines = sessionLines(scope, requested)
      const amountTotal = lines.reduce((total, line) => total + line.amount_total, 0)
      const currency = lines[0]?.currency ?? "usd"
      const id = scope.ids.next("cs_")
      const metadata = (params.metadata as Metadata | undefined) ?? {}
      const paymentIntentData =
        typeof params.payment_intent_data === "object" && params.payment_intent_data !== null
          ? (params.payment_intent_data as Record<string, unknown>)
          : {}
      const subscriptionData =
        typeof params.subscription_data === "object" && params.subscription_data !== null
          ? (params.subscription_data as Record<string, unknown>)
          : {}
      let paymentIntent: string | null = null
      let setupIntent: string | null = null
      let subscription: string | null = null
      let paymentStatus: CheckoutSessionRecord["payment_status"] = "unpaid"
      if (mode === "payment") {
        const intentId = scope.ids.next("pi_")
        scope.account.paymentIntents.insert(intentId, {
          id: intentId,
          amount: amountTotal,
          amount_capturable: 0,
          amount_received: 0,
          capture_method: "automatic",
          charge_ids: [],
          client_secret: clientSecretFor(intentId),
          confirmation_method: "automatic",
          created: seconds(scope.now),
          currency,
          customer,
          description: null,
          invoice: null,
          last_payment_error: null,
          latest_charge: null,
          metadata: {
            ...metadata,
            ...((paymentIntentData.metadata as Metadata | undefined) ?? {}),
          },
          payment_method: null,
          payment_method_types: ["card"],
          receipt_email: null,
          setup_future_usage:
            typeof paymentIntentData.setup_future_usage === "string"
              ? paymentIntentData.setup_future_usage
              : null,
          status: "requires_payment_method",
          canceled_at: null,
          cancellation_reason: null,
        })
        paymentIntent = intentId
      } else if (mode === "setup") {
        const intentId = scope.ids.next("seti_")
        scope.account.setupIntents.insert(intentId, {
          id: intentId,
          cancellation_reason: null,
          canceled_at: null,
          client_secret: clientSecretFor(intentId),
          created: seconds(scope.now),
          customer,
          description: null,
          last_setup_error: null,
          metadata,
          payment_method: null,
          payment_method_types: ["card"],
          status: "requires_payment_method",
          usage: "off_session",
        })
        setupIntent = intentId
        paymentStatus = "no_payment_required"
      } else {
        if (customer === null) throw parameterMissing("customer")
        const first = requested[0]
        if (!first || first.priceId === null)
          throw invalidRequest(
            "Subscription mode requires line items that reference a price.",
            "line_items",
          )
        const created = createSubscriptionRecord(scope, {
          customer,
          defaultPaymentMethod: null,
          items: requested
            .filter((line) => line.priceId !== null)
            .map((line) => ({ price: line.priceId as string, quantity: line.quantity })),
          metadata: (subscriptionData.metadata as Metadata | undefined) ?? {},
          paymentBehavior: "default_incomplete",
          trialEnd: null,
        })
        subscription = created.id
        paymentStatus = "no_payment_required"
      }
      const now = seconds(scope.now)
      const record: CheckoutSessionRecord = {
        id,
        amount_subtotal: amountTotal,
        amount_total: amountTotal,
        cancel_url: stringOf(params, "cancel_url"),
        created: now,
        currency,
        customer,
        customer_creation: stringOf(params, "customer_creation"),
        expires_at: intOf(params.expires_at) ?? now + 86_400,
        line_items: lines,
        livemode: false,
        metadata,
        mode,
        payment_intent: paymentIntent,
        payment_status: paymentStatus,
        setup_intent: setupIntent,
        status: "open",
        subscription,
        success_url: stringOf(params, "success_url"),
        url: `https://checkout.stripe.com/c/pay/${id}`,
      }
      scope.account.checkoutSessions.insert(id, record)
      return jsonResponse(200, render(scope, record, params))
    },
    GetCheckoutSessionsSession: async (context) => {
      const scope = requestScope(services, context)
      const params = queryParams(context)
      return jsonResponse(
        200,
        render(scope, requireSession(scope, context.params.session ?? ""), params),
      )
    },
    PostCheckoutSessionsSessionExpire: async (context) => {
      const scope = requestScope(services, context)
      const params = bodyParams(context)
      const current = requireSession(scope, context.params.session ?? "")
      if (current.status !== "open")
        throw invalidRequest(
          `Only a session with a status of open can be expired; this session has a status of ${current.status}.`,
          undefined,
          "checkout_session_not_open",
        )
      const next: CheckoutSessionRecord = { ...current, status: "expired" }
      scope.account.checkoutSessions.update(next.id, next)
      scope.emit("checkout.session.expired", renderCheckoutSession(next))
      return jsonResponse(200, render(scope, next, params))
    },
    GetCheckoutSessionsSessionLineItems: async (context) => {
      const scope = requestScope(services, context)
      const params = queryParams(context)
      const session = requireSession(scope, context.params.session ?? "")
      const limit = intOf(params.limit) ?? 10
      return jsonResponse(200, {
        object: "list",
        data: session.line_items
          .slice(0, limit)
          .map((line) => renderCheckoutLineItem(line, scope.account)),
        has_more: session.line_items.length > limit,
        url: `/v1/checkout/sessions/${session.id}/line_items`,
      })
    },
  }
}

export { createDiscount, requireSubscription }
