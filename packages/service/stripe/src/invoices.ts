import { jsonResponse, type OperationHandler } from "@crvouga/mockingbird-service"
import { invalidRequest, parameterMissing } from "./errors.js"
import { applyExpand, type ExpandResolvers } from "./expand.js"
import {
  clientSecretFor,
  confirmPaymentIntent,
  createCharge,
  customerEmail,
  customerName,
  invoiceLineFromItem,
  invoiceLineFromPrice,
  mergeRecordMetadata,
  openInvoice,
  type RequestScope,
  recomputeInvoice,
  requestScope,
  requireInvoice,
  requirePrice,
  requireSubscription,
  type Services,
} from "./internal.js"
import { matchesCreated, paginate } from "./list.js"
import { bodyParams, type Params, queryParams } from "./params.js"
import {
  renderCharge,
  renderCustomer,
  renderDeletedInvoice,
  renderInvoice,
  renderPaymentIntent,
  renderPromotionCode,
  renderSubscription,
} from "./render.js"
import { type InvoiceRecord, type SubscriptionItemRecord, seconds } from "./state.js"

type RecordValue = Record<string, unknown>

const stringOf = (params: Params, key: string): string | null => {
  const value = params[key]
  return typeof value === "string" && value !== "" ? value : null
}

const intOf = (value: unknown): number | undefined => {
  if (value === undefined || value === "") return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.trunc(parsed) : undefined
}

export const invoiceHandlers = (services: Services): Record<string, OperationHandler> => {
  const expanders = (scope: RequestScope): ExpandResolvers => ({
    charge: (id) => {
      const charge = scope.account.charges.get(id)
      return charge ? renderCharge(charge) : undefined
    },
    payment_intent: (id) => {
      const intent = scope.account.paymentIntents.get(id)
      return intent ? renderPaymentIntent(intent) : undefined
    },
    subscription: (id) => {
      const subscription = scope.account.subscriptions.get(id)
      return subscription ? renderSubscription(subscription, scope.account) : undefined
    },
    customer: (id) => {
      const entry = scope.account.customers.get(id)
      return entry?.kind === "live" ? renderCustomer(entry.customer) : undefined
    },
    default_payment_method: (id) => scope.account.paymentMethods.get(id),
    "discounts.coupon": (id) => scope.account.coupons.get(id),
    "discounts.promotion_code": (id) => {
      const promotion = scope.account.promotionCodes.get(id)
      return promotion ? renderPromotionCode(promotion) : undefined
    },
    "discount.coupon": (id) => scope.account.coupons.get(id),
    "discount.promotion_code": (id) => {
      const promotion = scope.account.promotionCodes.get(id)
      return promotion ? renderPromotionCode(promotion) : undefined
    },
  })

  const render = (scope: RequestScope, record: InvoiceRecord, params: Params) =>
    applyExpand(renderInvoice(record, scope.account), params.expand, expanders(scope))

  /** Lines of a preview invoice describe the subscription's current items. */
  const subscriptionLines = (scope: RequestScope, subscriptionId: string) => {
    const subscription = requireSubscription(scope, subscriptionId)
    return subscription.item_ids
      .map((id) => scope.account.subscriptionItems.get(id))
      .filter((item): item is SubscriptionItemRecord => item !== undefined)
      .map((item) =>
        invoiceLineFromPrice(scope, requirePrice(scope, item.price), item.quantity ?? 1),
      )
  }

  return {
    GetInvoices: async (context) => {
      const scope = requestScope(services, context)
      const params = queryParams(context)
      const customer = stringOf(params, "customer")
      const subscription = stringOf(params, "subscription")
      const status = stringOf(params, "status")
      const billingReason = stringOf(params, "billing_reason")
      return jsonResponse(
        200,
        await paginate<InvoiceRecord>(scope.account.invoices, params, {
          url: "/v1/invoices",
          kind: "invoice",
          where: (record) =>
            matchesCreated(record.created, params.created) &&
            (customer === null || record.customer === customer) &&
            (subscription === null || record.subscription === subscription) &&
            (status === null || record.status === status) &&
            (billingReason === null || record.billing_reason === billingReason),
          render: (record) => render(scope, record, params),
        }),
      )
    },
    PostInvoices: async (context) => {
      const scope = requestScope(services, context)
      const params = bodyParams(context)
      const customer = stringOf(params, "customer")
      if (customer === null) throw parameterMissing("customer")
      const entry = scope.account.customers.get(customer)
      if (!entry || entry.kind === "deleted")
        throw invalidRequest(`No such customer: '${customer}'`, "customer", "resource_missing")
      const subscription = stringOf(params, "subscription")
      if (subscription !== null) requireSubscription(scope, subscription)
      const pending = scope.account.invoiceItems
        .list({ order: "oldest" })
        .map((item) => item.value)
        .filter((item) => item.customer === customer && item.invoice === null)
      const opened = openInvoice(scope, {
        billingReason: "manual",
        customer,
        lines: pending.map((item) => invoiceLineFromItem(scope, item)),
        metadata: (params.metadata as Record<string, string> | undefined) ?? {},
        subscription,
      })
      const draft: InvoiceRecord = {
        ...opened,
        auto_advance: params.auto_advance !== undefined && params.auto_advance !== "false",
        collection_method:
          stringOf(params, "collection_method") === "send_invoice"
            ? "send_invoice"
            : "charge_automatically",
        description: stringOf(params, "description"),
        status: "draft",
        status_transitions: { ...opened.status_transitions, finalized_at: null },
      }
      scope.account.invoices.update(draft.id, draft)
      for (const item of pending)
        scope.account.invoiceItems.update(item.id, { ...item, invoice: draft.id })
      return jsonResponse(200, render(scope, draft, params))
    },
    GetInvoicesInvoice: async (context) => {
      const scope = requestScope(services, context)
      const params = queryParams(context)
      return jsonResponse(
        200,
        render(scope, requireInvoice(scope, context.params.invoice ?? ""), params),
      )
    },
    PostInvoicesInvoice: async (context) => {
      const scope = requestScope(services, context)
      const params = bodyParams(context)
      const current = requireInvoice(scope, context.params.invoice ?? "")
      const next: InvoiceRecord = {
        ...current,
        auto_advance:
          params.auto_advance === undefined
            ? current.auto_advance
            : params.auto_advance === true || params.auto_advance === "true",
        collection_method:
          stringOf(params, "collection_method") === "send_invoice"
            ? "send_invoice"
            : current.collection_method,
        description: stringOf(params, "description") ?? current.description,
        due_date: intOf(params.due_date) ?? current.due_date,
        metadata: mergeRecordMetadata(current.metadata, params.metadata),
      }
      scope.account.invoices.update(next.id, next)
      return jsonResponse(200, render(scope, next, params))
    },
    DeleteInvoicesInvoice: async (context) => {
      const scope = requestScope(services, context)
      const id = context.params.invoice ?? ""
      const current = requireInvoice(scope, id)
      if (current.status !== "draft")
        throw invalidRequest(
          `Only draft invoices can be deleted; this invoice has a status of ${current.status}.`,
          undefined,
          "invoice_not_draft",
        )
      scope.account.invoices.delete(id)
      return jsonResponse(200, renderDeletedInvoice(id))
    },
    PostInvoicesInvoiceFinalize: async (context) => {
      const scope = requestScope(services, context)
      const params = bodyParams(context)
      const current = requireInvoice(scope, context.params.invoice ?? "")
      if (current.status !== "draft")
        throw invalidRequest(
          `Only draft invoices can be finalized; this invoice has a status of ${current.status}.`,
          undefined,
          "invoice_not_draft",
        )
      const next: InvoiceRecord = {
        ...current,
        status: "open",
        status_transitions: { ...current.status_transitions, finalized_at: seconds(scope.now) },
      }
      scope.account.invoices.update(next.id, next)
      return jsonResponse(200, render(scope, next, params))
    },
    PostInvoicesInvoicePay: async (context) => {
      const scope = requestScope(services, context)
      const params = bodyParams(context)
      const current = requireInvoice(scope, context.params.invoice ?? "")
      if (current.status === "paid") return jsonResponse(200, render(scope, current, params))
      if (current.status === "void" || current.status === "uncollectible")
        throw invalidRequest(
          `This invoice cannot be paid because it has a status of ${current.status}.`,
          undefined,
          "invoice_not_payable",
        )
      const subscription =
        current.subscription === null
          ? undefined
          : scope.account.subscriptions.get(current.subscription)
      const paymentMethod =
        stringOf(params, "payment_method") ?? subscription?.default_payment_method ?? null
      const payable = recomputeInvoice(current)
      const intentId = scope.ids.next("pi_")
      scope.account.paymentIntents.insert(intentId, {
        id: intentId,
        amount: payable.amount_due,
        amount_capturable: 0,
        amount_received: 0,
        capture_method: "automatic",
        charge_ids: [],
        client_secret: clientSecretFor(intentId),
        confirmation_method: "automatic",
        created: seconds(scope.now),
        currency: payable.currency,
        customer: payable.customer,
        description: null,
        invoice: payable.id,
        last_payment_error: null,
        latest_charge: null,
        metadata: {},
        payment_method: paymentMethod,
        payment_method_types: ["card"],
        receipt_email: null,
        setup_future_usage: null,
        status: "requires_payment_method",
        canceled_at: null,
        cancellation_reason: null,
      })
      const intent = scope.account.paymentIntents.get(intentId)
      const settled =
        intent !== undefined && paymentMethod !== null
          ? confirmPaymentIntent(scope, intent, paymentMethod)
          : intent
      const chargeId =
        settled?.latest_charge ??
        createCharge(scope, {
          amount: payable.amount_due,
          currency: payable.currency,
          customer: payable.customer,
          invoice: payable.id,
          payment_intent: intentId,
          payment_method: paymentMethod,
        }).id
      const paidAt = seconds(scope.now)
      const next: InvoiceRecord = {
        ...payable,
        amount_paid: payable.amount_due,
        amount_remaining: 0,
        attempt_count: 1,
        attempted: true,
        charge: chargeId,
        paid: true,
        payment_intent: intentId,
        status: "paid",
        status_transitions: {
          ...payable.status_transitions,
          finalized_at: payable.status_transitions.finalized_at ?? paidAt,
          paid_at: paidAt,
        },
      }
      scope.account.invoices.update(next.id, next)
      scope.emit("invoice.paid", renderInvoice(next, scope.account))
      return jsonResponse(200, render(scope, next, params))
    },
    GetInvoicesInvoiceLines: async (context) => {
      const scope = requestScope(services, context)
      const params = queryParams(context)
      const invoice = requireInvoice(scope, context.params.invoice ?? "")
      const limit = Math.min(100, Math.max(1, intOf(params.limit) ?? 10))
      const rendered = render(scope, invoice, params)
      const data = ((rendered.lines ?? { data: [] }) as { data: RecordValue[] }).data
      const cursor = stringOf(params, "starting_after")
      const found = cursor === null ? 0 : data.findIndex((line) => line.id === cursor) + 1
      const from = Math.max(0, found)
      const window = data.slice(from, from + limit)
      return jsonResponse(200, {
        object: "list",
        data: window,
        has_more: from + window.length < data.length,
        url: `/v1/invoices/${invoice.id}/lines`,
      })
    },
    GetInvoicesUpcoming: async (context) => {
      const scope = requestScope(services, context)
      const params = queryParams(context)
      const subscriptionId = stringOf(params, "subscription")
      const subscription =
        subscriptionId === null ? undefined : scope.account.subscriptions.get(subscriptionId)
      const customer = stringOf(params, "customer") ?? subscription?.customer ?? null
      if (customer !== null) {
        const entry = scope.account.customers.get(customer)
        if (!entry || entry.kind === "deleted")
          throw invalidRequest(`No such customer: '${customer}'`, "customer", "resource_missing")
      }
      const lines = subscriptionId === null ? [] : subscriptionLines(scope, subscriptionId)
      const now = seconds(scope.now)
      const subtotal = lines.reduce((total, line) => total + line.amount, 0)
      const preview: InvoiceRecord = {
        id: `upcoming_in_${now}`,
        amount_due: subtotal,
        amount_paid: 0,
        amount_remaining: subtotal,
        attempt_count: 0,
        attempted: false,
        auto_advance: true,
        billing_reason: "upcoming",
        charge: null,
        collection_method: "charge_automatically",
        created: now,
        currency: lines[0]?.currency ?? "usd",
        customer,
        customer_email: customerEmail(scope, customer),
        customer_name: customerName(scope, customer),
        description: null,
        discount_ids: [],
        due_date: null,
        ending_balance: 0,
        hosted_invoice_url: null,
        invoice_pdf: null,
        lines,
        metadata: {},
        next_payment_attempt: null,
        number: null,
        paid: false,
        payment_intent: null,
        period_end: now,
        period_start: now,
        status: "draft",
        status_transitions: {
          finalized_at: null,
          marked_uncollectible_at: null,
          paid_at: null,
          voided_at: null,
        },
        subscription: subscriptionId,
        subtotal,
        total: subtotal,
      }
      return jsonResponse(200, render(scope, preview, params))
    },
  }
}
