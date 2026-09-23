import { jsonResponse, type OperationHandler } from "@crvouga/mockingbird-service"
import {
  applyDiscountRequests,
  createDraftInvoice,
  finalizeInvoice,
  parseDiscounts,
  payInvoice,
  recomputeInvoice,
  upcomingInvoice,
  voidInvoice,
} from "./billing.js"
import { invalidRequest, parameterMissing, resourceMissing, StripeError } from "./errors.js"
import {
  booleanOf,
  intOf,
  mergeRecordMetadata,
  type RequestScope,
  requestScope,
  requireInvoice,
  requireSubscription,
  type Services,
  stringOf,
} from "./internal.js"
import { matchesCreated, paginate } from "./list.js"
import { bodyParams, queryParams } from "./params.js"
import { renderDeletedInvoice, renderInvoice } from "./render.js"
import type { InvoiceLineRecord, InvoiceRecord } from "./state.js"

type RecordValue = Record<string, unknown>

const NOT_DRAFT =
  "This invoice is not a draft; you can only update draft invoices' discounts and line items."

export const invoiceHandlers = (services: Services): Record<string, OperationHandler> => {
  const render = (scope: RequestScope, record: InvoiceRecord) =>
    renderInvoice(record, scope.account)

  return {
    GetInvoices: async (context) => {
      const scope = requestScope(services, context)
      const params = queryParams(context)
      const customer = stringOf(params, "customer")
      const subscription = stringOf(params, "subscription")
      const status = stringOf(params, "status")
      const collection = stringOf(params, "collection_method")
      const account = stringOf(params, "customer_account")
      if (account !== null) throw resourceMissing("customer", account, "customer_account", 400)
      if (customer !== null && !scope.account.customers.get(customer))
        throw resourceMissing("customer", customer, "customer", 400)
      return jsonResponse(
        200,
        await paginate<InvoiceRecord>(scope.account.invoices, params, {
          url: "/v1/invoices",
          kind: "invoice",
          where: (record) =>
            matchesCreated(record.created, params.created) &&
            (params.due_date === undefined ||
              matchesCreated(record.due_date ?? -1, params.due_date)) &&
            (customer === null || record.customer === customer) &&
            (subscription === null || record.subscription === subscription) &&
            (status === null || record.status === status) &&
            (collection === null || record.collection_method === collection),
          render: (record) => render(scope, record),
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
      if (subscription !== null) requireSubscription(scope, subscription, "subscription")
      const collection =
        stringOf(params, "collection_method") === "send_invoice"
          ? "send_invoice"
          : "charge_automatically"
      const daysUntilDue = intOf(params.days_until_due)
      if (
        collection === "send_invoice" &&
        daysUntilDue === undefined &&
        params.due_date === undefined
      )
        throw invalidRequest(
          "Invoices with `send_invoice` collection method must have either a `due_date` or `days_until_due` set.",
          "days_until_due",
        )
      // Since 2022-08-01 pending invoice items are excluded unless asked for.
      const include = stringOf(params, "pending_invoice_items_behavior") === "include"
      const pending = include
        ? scope.account.invoiceItems
            .list({ order: "oldest" })
            .map((item) => item.value)
            .filter((item) => item.customer === customer && item.invoice === null)
        : []
      const lines: InvoiceLineRecord[] = pending.map((item) => ({
        id: scope.ids.next("il_", 24),
        amount: item.amount,
        currency: item.currency,
        description: item.description,
        discount_amounts: [],
        invoice_item: item.id,
        metadata: item.metadata,
        period: item.period,
        price: item.price,
        quantity: item.quantity,
        proration: item.proration,
        subtotal: item.amount,
        type: "invoiceitem",
      }))
      let draft = createDraftInvoice(scope, {
        customer,
        subscription,
        lines,
        billingReason: "manual",
        metadata: (params.metadata as Record<string, string> | undefined) ?? {},
        collectionMethod: collection,
        daysUntilDue: daysUntilDue ?? null,
        autoAdvance: booleanOf(params.auto_advance) ?? false,
        description: stringOf(params, "description"),
        defaultPaymentMethod: stringOf(params, "default_payment_method"),
      })
      for (const item of pending)
        scope.account.invoiceItems.update(item.id, { ...item, invoice: draft.id })
      const discounts = parseDiscounts(params.discounts)
      if (discounts !== undefined && discounts !== "clear" && discounts.length > 0) {
        const ids = applyDiscountRequests(scope, discounts, { customer, invoice: draft.id })
        draft = recomputeInvoice(scope, { ...draft, discount_ids: ids })
        scope.account.invoices.update(draft.id, draft)
      }
      return jsonResponse(200, render(scope, draft))
    },
    GetInvoicesInvoice: async (context) => {
      const scope = requestScope(services, context)
      queryParams(context)
      return jsonResponse(200, render(scope, requireInvoice(scope, context.params.invoice ?? "")))
    },
    PostInvoicesInvoice: async (context) => {
      const scope = requestScope(services, context)
      const params = bodyParams(context)
      const current = requireInvoice(scope, context.params.invoice ?? "")
      const discounts = parseDiscounts(params.discounts)
      const draftOnly = discounts !== undefined || params.collection_method !== undefined
      if (draftOnly && current.status !== "draft") throw invalidRequest(NOT_DRAFT)
      const discountIds =
        discounts === undefined
          ? current.discount_ids
          : discounts === "clear"
            ? []
            : applyDiscountRequests(
                scope,
                discounts,
                { customer: current.customer, invoice: current.id },
                current.discount_ids,
              )
      const collection = stringOf(params, "collection_method")
      const next = recomputeInvoice(scope, {
        ...current,
        auto_advance: booleanOf(params.auto_advance) ?? current.auto_advance,
        collection_method:
          collection === "send_invoice"
            ? "send_invoice"
            : collection === "charge_automatically"
              ? "charge_automatically"
              : current.collection_method,
        days_until_due: intOf(params.days_until_due) ?? current.days_until_due ?? null,
        default_payment_method:
          stringOf(params, "default_payment_method") ?? current.default_payment_method ?? null,
        description: stringOf(params, "description") ?? current.description,
        discount_ids: discountIds,
        due_date: intOf(params.due_date) ?? current.due_date,
        metadata: mergeRecordMetadata(current.metadata, params.metadata),
      })
      scope.account.invoices.update(next.id, next)
      scope.emit("invoice.updated", render(scope, next))
      return jsonResponse(200, render(scope, next))
    },
    DeleteInvoicesInvoice: async (context) => {
      const scope = requestScope(services, context)
      const id = context.params.invoice ?? ""
      const current = requireInvoice(scope, id)
      if (current.status !== "draft")
        throw invalidRequest(
          `You can only delete draft invoices. This invoice has a status of ${current.status}.`,
          undefined,
          "invoice_not_editable",
        )
      for (const entry of scope.account.invoiceItems.list({ where: (item) => item.invoice === id }))
        scope.account.invoiceItems.delete(entry.id)
      scope.account.invoices.delete(id)
      scope.emit("invoice.deleted", render(scope, current))
      return jsonResponse(200, renderDeletedInvoice(id))
    },
    PostInvoicesInvoiceFinalize: async (context) => {
      const scope = requestScope(services, context)
      bodyParams(context)
      const current = requireInvoice(scope, context.params.invoice ?? "")
      return jsonResponse(200, render(scope, finalizeInvoice(scope, current)))
    },
    PostInvoicesInvoicePay: async (context) => {
      const scope = requestScope(services, context)
      const params = bodyParams(context)
      const current = requireInvoice(scope, context.params.invoice ?? "")
      if (current.status === "paid")
        throw invalidRequest("Invoice is already paid", undefined, "invoice_already_paid")
      if (current.status === "void" || current.status === "uncollectible")
        throw invalidRequest(
          `This invoice can no longer be paid because it has a status of ${current.status}.`,
          undefined,
          "invoice_not_editable",
        )
      const outOfBand = booleanOf(params.paid_out_of_band) === true
      const paid = payInvoice(scope, current, {
        paymentMethod: stringOf(params, "payment_method"),
        offSession: booleanOf(params.off_session) ?? true,
        outOfBand,
      })
      return jsonResponse(200, render(scope, paid))
    },
    PostInvoicesInvoiceVoid: async (context) => {
      const scope = requestScope(services, context)
      bodyParams(context)
      const current = requireInvoice(scope, context.params.invoice ?? "")
      return jsonResponse(200, render(scope, voidInvoice(scope, current)))
    },
    GetInvoicesInvoiceLines: async (context) => {
      const scope = requestScope(services, context)
      const params = queryParams(context)
      const invoice = requireInvoice(scope, context.params.invoice ?? "")
      const limit = Math.min(100, Math.max(1, intOf(params.limit) ?? 10))
      const rendered = render(scope, invoice)
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
      // 2025-03-31.basil removed the endpoint in favour of POST /v1/invoices/create_preview.
      if (scope.era === "basil")
        throw new StripeError({
          status: 404,
          message:
            "This API method has been deprecated. Please use the Create Preview Invoice API instead: https://docs.stripe.com/api/invoices/create_preview.",
        })
      const params = queryParams(context)
      const subscriptionId = stringOf(params, "subscription")
      const customerId = stringOf(params, "customer")
      if (subscriptionId === null && customerId === null) throw parameterMissing("customer")
      if (customerId !== null) {
        const entry = scope.account.customers.get(customerId)
        if (!entry || entry.kind === "deleted")
          throw resourceMissing("customer", customerId, "customer")
      }
      const subscription =
        subscriptionId !== null
          ? requireSubscription(scope, subscriptionId, "subscription")
          : scope.account.subscriptions
              .list({ order: "oldest" })
              .map((entry) => entry.value)
              .find(
                (record) =>
                  record.customer === customerId &&
                  ["active", "trialing", "past_due"].includes(record.status),
              )
      if (
        subscription === undefined ||
        ["canceled", "incomplete_expired"].includes(subscription.status) ||
        subscription.cancel_at_period_end
      )
        throw new StripeError({
          status: 404,
          code: "invoice_upcoming_none",
          message: `No upcoming invoices for customer: ${customerId ?? subscription?.customer ?? ""}`,
        })
      return jsonResponse(200, upcomingInvoice(scope, subscription))
    },
  }
}
