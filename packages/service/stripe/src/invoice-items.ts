import { jsonResponse, type OperationHandler } from "@crvouga/mockingbird-service"
import { parameterMissing, resourceMissing } from "./errors.js"
import { applyExpand, type ExpandResolvers } from "./expand.js"
import { optionalString } from "./fields.js"
import {
  invoiceLineFromItem,
  mergeRecordMetadata,
  priceAmount,
  type RequestScope,
  recomputeInvoice,
  requestScope,
  requireInvoice,
  requireLiveCustomer,
  requirePrice,
  type Services,
} from "./internal.js"
import { matchesCreated, paginate } from "./list.js"
import { bodyParams, type Params, queryParams } from "./params.js"
import {
  renderCustomer,
  renderDeletedInvoiceItem,
  renderInvoice,
  renderInvoiceItem,
  renderPrice,
} from "./render.js"
import { type InvoiceItemRecord, type Metadata, seconds } from "./state.js"

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

export const invoiceItemHandlers = (services: Services): Record<string, OperationHandler> => {
  /**
   * Both spellings of every path: the list operations expand `data.price` on the envelope, the
   * single-object operations expand `price` on the record.
   */
  const expanders = (scope: RequestScope): ExpandResolvers => {
    const customer = (id: string) => {
      const entry = scope.account.customers.get(id)
      return entry?.kind === "live" ? renderCustomer(entry.customer) : undefined
    }
    const price = (id: string) => {
      const record = scope.account.prices.get(id)
      return record ? renderPrice(record) : undefined
    }
    const invoice = (id: string) => {
      const record = scope.account.invoices.get(id)
      return record ? renderInvoice(record, scope.account) : undefined
    }
    return {
      customer,
      invoice,
      price,
      "data.customer": customer,
      "data.invoice": invoice,
      "data.price": price,
    }
  }

  /** The rendered item carries its price id so `expand[]=price` has something to replace. */
  const renderItem = (item: InvoiceItemRecord): RecordValue => {
    const rendered = renderInvoiceItem(item)
    return item.price === null ? rendered : { ...rendered, price: item.price }
  }

  /** Draft invoices derive their money fields from lines, so any change re-derives both. */
  const syncDraftInvoice = (scope: RequestScope, item: InvoiceItemRecord): void => {
    if (item.invoice === null) return
    const invoice = scope.account.invoices.get(item.invoice)
    if (invoice?.status !== "draft") return
    const line = invoiceLineFromItem(scope, {
      id: item.id,
      amount: item.amount,
      currency: item.currency,
      description: item.description,
      quantity: item.quantity,
      metadata: item.metadata,
      price: item.price,
    })
    const lines = invoice.lines.some((existing) => existing.invoice_item === item.id)
      ? invoice.lines.map((existing) =>
          existing.invoice_item === item.id
            ? {
                ...existing,
                amount: item.amount,
                description: item.description,
                metadata: item.metadata,
                price: item.price,
                quantity: item.quantity,
                subtotal: item.amount,
              }
            : existing,
        )
      : [...invoice.lines, line]
    scope.account.invoices.update(invoice.id, recomputeInvoice({ ...invoice, lines }))
  }

  const requireItem = (scope: RequestScope, id: string): InvoiceItemRecord => {
    const item = scope.account.invoiceItems.get(id)
    if (!item) throw resourceMissing("invoiceitem", id, "invoiceitem")
    return item
  }

  return {
    PostInvoiceitems: async (context) => {
      const scope = requestScope(services, context)
      const params = bodyParams(context)
      const customer = requireLiveCustomer(scope, stringOf(params, "customer") ?? "", "customer")
      const priceId = stringOf(params, "price")
      const price = priceId === null ? undefined : requirePrice(scope, priceId, "price")
      const invoiceId = stringOf(params, "invoice")
      const invoice = invoiceId === null ? undefined : requireInvoice(scope, invoiceId, "invoice")
      const quantity = intOf(params.quantity) ?? 1
      const derived = price === undefined ? undefined : priceAmount(price, quantity)
      const amount = intOf(params.amount) ?? derived
      if (amount === undefined) throw parameterMissing("amount")
      const id = scope.ids.next("ii_")
      const now = seconds(scope.now)
      const item: InvoiceItemRecord = {
        id,
        amount,
        created: now,
        currency: stringOf(params, "currency") ?? "usd",
        customer: customer.id,
        date: now,
        description: stringOf(params, "description"),
        discountable: params.discountable !== false,
        invoice: invoice?.id ?? null,
        metadata: (params.metadata as Metadata | undefined) ?? {},
        period: { start: now, end: now },
        price: price?.id ?? null,
        proration: false,
        quantity,
        unit_amount: price === undefined ? null : Number(price.unit_amount_decimal),
      }
      scope.account.invoiceItems.insert(id, item)
      syncDraftInvoice(scope, item)
      return jsonResponse(200, applyExpand(renderItem(item), params.expand, expanders(scope)))
    },

    GetInvoiceitems: async (context) => {
      const scope = requestScope(services, context)
      const params = queryParams(context)
      const customer = stringOf(params, "customer")
      const invoice = stringOf(params, "invoice")
      const page = await paginate<InvoiceItemRecord>(scope.account.invoiceItems, params, {
        url: "/v1/invoiceitems",
        kind: "invoiceitem",
        where: (item) =>
          matchesCreated(item.created, params.created) &&
          (customer === null || item.customer === customer) &&
          (invoice === null || item.invoice === invoice),
        render: renderItem,
      })
      return jsonResponse(200, applyExpand(page, params.expand, expanders(scope)))
    },

    GetInvoiceitemsInvoiceitem: async (context) => {
      const scope = requestScope(services, context)
      const params = queryParams(context)
      const item = requireItem(scope, context.params.invoiceitem ?? "")
      return jsonResponse(200, applyExpand(renderItem(item), params.expand, expanders(scope)))
    },

    PostInvoiceitemsInvoiceitem: async (context) => {
      const scope = requestScope(services, context)
      const params = bodyParams(context)
      const current = requireItem(scope, context.params.invoiceitem ?? "")
      const next: InvoiceItemRecord = {
        ...current,
        amount: intOf(params.amount) ?? current.amount,
        description: optionalString(params, "description", current.description),
        metadata: mergeRecordMetadata(current.metadata, params.metadata),
        quantity: intOf(params.quantity) ?? current.quantity,
      }
      scope.account.invoiceItems.update(next.id, next)
      syncDraftInvoice(scope, next)
      return jsonResponse(200, applyExpand(renderItem(next), params.expand, expanders(scope)))
    },

    DeleteInvoiceitemsInvoiceitem: async (context) => {
      const scope = requestScope(services, context)
      const id = context.params.invoiceitem ?? ""
      const item = requireItem(scope, id)
      if (item.invoice !== null) {
        const invoice = scope.account.invoices.get(item.invoice)
        if (invoice && invoice.status === "draft") {
          const lines = invoice.lines.filter((line) => line.invoice_item !== item.id)
          if (lines.length !== invoice.lines.length)
            scope.account.invoices.update(invoice.id, recomputeInvoice({ ...invoice, lines }))
        }
      }
      scope.account.invoiceItems.delete(id)
      return jsonResponse(200, renderDeletedInvoiceItem(id))
    },
  }
}
