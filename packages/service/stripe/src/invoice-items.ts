import { jsonResponse, type OperationHandler } from "@crvouga/mockingbird-service"
import { recomputeInvoice } from "./billing.js"
import { invalidRequest, parameterMissing, resourceMissing, StripeError } from "./errors.js"
import { optionalString, parseUnitAmountDecimal } from "./fields.js"
import {
  customerNow,
  intOf,
  mergeRecordMetadata,
  priceAmount,
  type RequestScope,
  recordOf,
  requestScope,
  requireInvoice,
  requireLiveCustomer,
  requirePrice,
  type Services,
  stringOf,
} from "./internal.js"
import { matchesCreated, paginate } from "./list.js"
import { bodyParams, queryParams } from "./params.js"
import { normalizeCurrency } from "./prices.js"
import { priceOrId, renderDeletedInvoiceItem, renderInvoiceItem } from "./render.js"
import {
  type InvoiceItemRecord,
  type InvoiceLineRecord,
  type Metadata,
  type PriceRecord,
  seconds,
} from "./state.js"

type RecordValue = Record<string, unknown>

const lineOf = (scope: RequestScope, item: InvoiceItemRecord): InvoiceLineRecord => ({
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
})

/** At 2024-06-20 and 2025-02-24.acacia an invoice item's `price` is the Price object itself. */
const renderItem = (scope: RequestScope, item: InvoiceItemRecord): RecordValue => ({
  ...renderInvoiceItem(item),
  price: item.price === null ? null : priceOrId(scope.account, item.price),
})

/**
 * `price_data` generates a new Price inline: inactive, one-time, owned by `price_data[product]`,
 * and retrievable by id like any other price. Validated here, stored once the item is valid.
 */
const inlinePrice = (scope: RequestScope, data: RecordValue): PriceRecord => {
  const product = typeof data.product === "string" ? data.product : ""
  if (!scope.account.products.get(product))
    throw resourceMissing("product", product, "price_data[product]")
  const hasAmount = data.unit_amount !== undefined
  const hasDecimal = data.unit_amount_decimal !== undefined
  if (hasAmount && hasDecimal)
    throw invalidRequest(
      "You may only specify one of these parameters: unit_amount, unit_amount_decimal.",
      "price_data[unit_amount]",
    )
  const unit_amount_decimal = hasDecimal
    ? parseUnitAmountDecimal(String(data.unit_amount_decimal), "price_data[unit_amount_decimal]")
    : String(intOf(data.unit_amount) ?? 0)
  const taxBehavior = data.tax_behavior
  return {
    id: scope.ids.next("price_", 24),
    active: false,
    created: seconds(scope.now),
    currency: normalizeCurrency(String(data.currency ?? ""), "price_data[currency]"),
    lookup_key: null,
    metadata: {},
    nickname: null,
    product,
    recurring: null,
    tax_behavior:
      taxBehavior === "exclusive" || taxBehavior === "inclusive" ? taxBehavior : "unspecified",
    unit_amount_decimal,
  }
}

/** Draft invoices derive their money fields from lines, so any change re-derives both. */
const syncDraftInvoice = (scope: RequestScope, item: InvoiceItemRecord, removed = false): void => {
  if (item.invoice === null) return
  const invoice = scope.account.invoices.get(item.invoice)
  if (invoice?.status !== "draft") return
  const others = invoice.lines.filter((line) => line.invoice_item !== item.id)
  const existing = invoice.lines.find((line) => line.invoice_item === item.id)
  const lines = removed
    ? others
    : existing === undefined
      ? [...invoice.lines, lineOf(scope, item)]
      : invoice.lines.map((line) =>
          line.invoice_item === item.id ? { ...lineOf(scope, item), id: existing.id } : line,
        )
  scope.account.invoices.update(invoice.id, recomputeInvoice(scope, { ...invoice, lines }))
}

const requireItem = (scope: RequestScope, id: string): InvoiceItemRecord => {
  const item = scope.account.invoiceItems.get(id)
  if (!item)
    throw new StripeError({
      status: 404,
      code: "resource_missing",
      message: `No such Invoice Item: '${id}'(livemode=false)`,
      param: "invoiceitem",
    })
  return item
}

export const invoiceItemHandlers = (services: Services): Record<string, OperationHandler> => ({
  PostInvoiceitems: async (context) => {
    const scope = requestScope(services, context)
    const params = bodyParams(context)
    const customer = requireLiveCustomer(scope, stringOf(params, "customer") ?? "", "customer")
    const priceId = stringOf(params, "price")
    const priceData = recordOf(params.price_data)
    const inline =
      priceId === null && priceData !== undefined ? inlinePrice(scope, priceData) : undefined
    const price = priceId === null ? inline : requirePrice(scope, priceId, "price")
    const invoiceId = stringOf(params, "invoice")
    const invoice = invoiceId === null ? undefined : requireInvoice(scope, invoiceId, "invoice")
    if (invoice !== undefined && invoice.status !== "draft")
      throw invalidRequest(
        `You can only add invoice items to draft invoices. The invoice ${invoice.id} has a status of ${invoice.status}.`,
        "invoice",
      )
    const quantity = intOf(params.quantity) ?? 1
    const unitAmount =
      price !== undefined ? Number(price.unit_amount_decimal) : intOf(params.unit_amount)
    const derived =
      price !== undefined
        ? priceAmount(price, quantity)
        : unitAmount === undefined
          ? undefined
          : Math.round(unitAmount * quantity)
    const amount = intOf(params.amount) ?? derived
    if (amount === undefined) throw parameterMissing("amount")
    if (inline !== undefined) scope.account.prices.insert(inline.id, inline)
    const id = scope.ids.next("ii_", 24)
    const now = customerNow(scope, customer.id)
    const item: InvoiceItemRecord = {
      id,
      amount,
      created: seconds(scope.now),
      currency: stringOf(params, "currency") ?? price?.currency ?? "usd",
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
      unit_amount: unitAmount ?? null,
    }
    scope.account.invoiceItems.insert(id, item)
    syncDraftInvoice(scope, item)
    scope.emit("invoiceitem.created", renderItem(scope, item))
    return jsonResponse(200, renderItem(scope, item))
  },

  GetInvoiceitems: async (context) => {
    const scope = requestScope(services, context)
    const params = queryParams(context)
    const customer = stringOf(params, "customer")
    const invoice = stringOf(params, "invoice")
    const pending = params.pending === true || params.pending === "true"
    const page = await paginate<InvoiceItemRecord>(scope.account.invoiceItems, params, {
      url: "/v1/invoiceitems",
      kind: "invoiceitem",
      where: (item) =>
        matchesCreated(item.created, params.created) &&
        (customer === null || item.customer === customer) &&
        (invoice === null || item.invoice === invoice) &&
        (!pending || item.invoice === null),
      render: (item) => renderItem(scope, item),
    })
    return jsonResponse(200, page)
  },

  GetInvoiceitemsInvoiceitem: async (context) => {
    const scope = requestScope(services, context)
    queryParams(context)
    return jsonResponse(
      200,
      renderItem(scope, requireItem(scope, context.params.invoiceitem ?? "")),
    )
  },

  PostInvoiceitemsInvoiceitem: async (context) => {
    const scope = requestScope(services, context)
    const params = bodyParams(context)
    const current = requireItem(scope, context.params.invoiceitem ?? "")
    const quantity = intOf(params.quantity) ?? current.quantity
    const priceId = stringOf(params, "price")
    const priceData = recordOf(params.price_data)
    const inline =
      priceId === null && priceData !== undefined ? inlinePrice(scope, priceData) : undefined
    const price = priceId === null ? inline : requirePrice(scope, priceId, "price")
    if (inline !== undefined) scope.account.prices.insert(inline.id, inline)
    const next: InvoiceItemRecord = {
      ...current,
      amount:
        intOf(params.amount) ??
        (price !== undefined
          ? priceAmount(price, quantity)
          : current.unit_amount === null
            ? current.amount
            : Math.round(current.unit_amount * quantity)),
      description: optionalString(params, "description", current.description),
      metadata: mergeRecordMetadata(current.metadata, params.metadata),
      price: price?.id ?? current.price,
      quantity,
    }
    scope.account.invoiceItems.update(next.id, next)
    syncDraftInvoice(scope, next)
    return jsonResponse(200, renderItem(scope, next))
  },

  DeleteInvoiceitemsInvoiceitem: async (context) => {
    const scope = requestScope(services, context)
    const id = context.params.invoiceitem ?? ""
    const item = requireItem(scope, id)
    syncDraftInvoice(scope, item, true)
    scope.account.invoiceItems.delete(id)
    return jsonResponse(200, renderDeletedInvoiceItem(id))
  },
})
