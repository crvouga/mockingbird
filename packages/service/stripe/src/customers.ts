import { jsonResponse, type OperationContext, opaqueToken } from "@crvouga/mockingbird-service"
import { invalidRequest, resourceMissing } from "./errors.js"
import { recordEvent } from "./events.js"
import { mergeMetadata, optionalString, strippedString, validateEmail } from "./fields.js"
import { recordCustomerBalance } from "./ledger.js"
import { matchesCreated, paginate } from "./list.js"
import { bodyParams, type Params, queryParams } from "./params.js"
import {
  type Address,
  type CustomerEntry,
  type CustomerRecord,
  type StripeState,
  seconds,
} from "./state.js"

const ADDRESS_KEYS = ["city", "country", "line1", "line2", "postal_code", "state"] as const

/** Stripe's account currency in test mode; a customer picks it up once a balance is set. */
const ACCOUNT_CURRENCY = "usd"

const toAddress = (raw: unknown): Address => {
  const input = raw as Record<string, string | undefined>
  const out = {} as Record<(typeof ADDRESS_KEYS)[number], string | null>
  for (const key of ADDRESS_KEYS) {
    const value = input[key]
    out[key] = value === undefined ? null : value
  }
  return out
}

export const renderCustomer = (customer: CustomerRecord) => ({
  id: customer.id,
  object: "customer",
  address: customer.address,
  balance: customer.balance,
  created: customer.created,
  currency: customer.currency,
  customer_account: null,
  default_source: null,
  delinquent: false,
  description: customer.description,
  discount: null,
  email: customer.email,
  invoice_prefix: customer.invoice_prefix,
  invoice_settings: {
    custom_fields: customer.invoice_settings.custom_fields,
    default_payment_method: customer.invoice_settings.default_payment_method,
    footer: customer.invoice_settings.footer,
    rendering_options: null,
  },
  livemode: false,
  metadata: customer.metadata,
  name: customer.name,
  next_invoice_sequence: customer.next_invoice_sequence,
  phone: customer.phone,
  preferred_locales: customer.preferred_locales,
  shipping: customer.shipping,
  tax_exempt: customer.tax_exempt,
  test_clock: null,
})

const renderDeleted = (id: string) => ({ id, object: "customer", deleted: true })

const apply = (current: CustomerRecord, params: Params): CustomerRecord => {
  const next: CustomerRecord = { ...current, invoice_settings: { ...current.invoice_settings } }
  if (params.address !== undefined)
    next.address = params.address === "" ? null : toAddress(params.address)
  if (params.balance !== undefined) {
    next.balance = params.balance as number
    if (next.balance !== 0) next.currency = ACCOUNT_CURRENCY
  }
  next.description = optionalString(params, "description", current.description)
  const email = optionalString(params, "email", current.email)
  next.email = email === null ? null : validateEmail(email)
  next.name = strippedString(params, "name", current.name)
  next.phone = strippedString(params, "phone", current.phone)
  next.metadata = mergeMetadata(current.metadata, params.metadata)
  if (params.preferred_locales !== undefined)
    next.preferred_locales = params.preferred_locales as string[]
  if (params.shipping !== undefined) {
    if (params.shipping === "") next.shipping = null
    else {
      const shipping = params.shipping as { address: unknown; name: string; phone?: string }
      next.shipping = {
        address: toAddress(shipping.address),
        name: shipping.name,
        phone: shipping.phone === undefined ? null : shipping.phone,
      }
    }
  }
  if (params.tax_exempt !== undefined) {
    next.tax_exempt =
      params.tax_exempt === "" ? "none" : (params.tax_exempt as CustomerRecord["tax_exempt"])
  }
  if (params.invoice_settings !== undefined) {
    const settings = params.invoice_settings as {
      custom_fields?: unknown
      default_payment_method?: string
      footer?: string
    }
    if (settings.custom_fields !== undefined) {
      next.invoice_settings.custom_fields =
        settings.custom_fields === ""
          ? []
          : (settings.custom_fields as CustomerRecord["invoice_settings"]["custom_fields"])
    }
    if (settings.footer !== undefined)
      next.invoice_settings.footer = settings.footer === "" ? null : settings.footer
    if ("default_payment_method" in settings) {
      const method = settings.default_payment_method
      next.invoice_settings.default_payment_method =
        method === "" || method === undefined ? null : method
    }
  }
  return next
}

const assertPaymentMethod = async (state: StripeState, customerId: string, methodId: string) => {
  const method = await state.paymentMethods.get(methodId)
  if (!method)
    throw resourceMissing(
      "payment_method",
      methodId,
      "invoice_settings[default_payment_method]",
      400,
    )
  if (method.customer !== null && method.customer !== customerId)
    throw invalidRequest(
      "The payment method must be attached to the customer.",
      "invoice_settings[default_payment_method]",
    )
  if (method.customer === null) {
    method.customer = customerId
    await state.paymentMethods.update(methodId, method)
  }
}

/** Allocate the next invoice number for a customer (`PREFIX-0001`). */
export const takeInvoiceNumber = async (state: StripeState, customerId: string) => {
  const entry = await state.customers.get(customerId)
  if (!entry || entry.kind !== "live") return undefined
  const sequence = entry.customer.next_invoice_sequence
  entry.customer.next_invoice_sequence += 1
  await state.customers.update(customerId, entry)
  return `${entry.customer.invoice_prefix}-${String(sequence).padStart(4, "0")}`
}

const live = async (state: StripeState, id: string, missingStatus: number) => {
  const entry = await state.customers.get(id)
  if (!entry || entry.kind === "deleted") throw resourceMissing("customer", id, "id", missingStatus)
  return entry.customer
}

export const customerHandlers = (state: StripeState) => ({
  PostCustomers: async (context: OperationContext) => {
    const params = bodyParams(context)
    const id = await state.ids.next("cus_")
    const base: CustomerRecord = {
      id,
      address: null,
      balance: 0,
      created: seconds(context.now),
      currency: null,
      description: null,
      email: null,
      invoice_prefix: opaqueToken(`invoice-prefix:${id}`, 8).toUpperCase(),
      invoice_settings: { custom_fields: null, default_payment_method: null, footer: null },
      metadata: {},
      name: null,
      next_invoice_sequence: 1,
      phone: null,
      preferred_locales: [],
      shipping: null,
      tax_exempt: "none",
    }
    const customer = apply(base, params)
    if (customer.invoice_settings.default_payment_method)
      await assertPaymentMethod(state, id, customer.invoice_settings.default_payment_method)
    if (typeof params.payment_method === "string" && params.payment_method !== "") {
      await assertPaymentMethod(state, id, params.payment_method)
      customer.invoice_settings.default_payment_method = params.payment_method
    }
    await state.customers.insert(id, { kind: "live", customer })
    if (customer.balance !== 0 && customer.currency)
      await recordCustomerBalance(state, customer, customer.balance, seconds(context.now), null)
    const body = renderCustomer(customer)
    await recordEvent(state, "customer.created", body, seconds(context.now))
    return jsonResponse(200, body)
  },

  GetCustomers: async (context: OperationContext) => {
    const params = queryParams(context)
    const email = params.email
    const page = await paginate<CustomerEntry>(state.customers, params, {
      url: "/v1/customers",
      kind: "customer",
      exists: (entry) => entry.kind === "live",
      where: (entry) =>
        entry.kind === "live" &&
        matchesCreated(entry.customer.created, params.created) &&
        (email === undefined || email === "" || entry.customer.email === email),
      render: (entry) => (entry.kind === "live" ? renderCustomer(entry.customer) : undefined),
    })
    return jsonResponse(200, page)
  },

  GetCustomersCustomer: async (context: OperationContext) => {
    queryParams(context)
    const id = context.params.customer ?? ""
    const entry = await state.customers.get(id)
    if (!entry) throw resourceMissing("customer", id, "id")
    return jsonResponse(
      200,
      entry.kind === "deleted" ? renderDeleted(id) : renderCustomer(entry.customer),
    )
  },

  PostCustomersCustomer: async (context: OperationContext) => {
    const params = bodyParams(context)
    const id = context.params.customer ?? ""
    const entry = await state.customers.get(id)
    const current = await live(state, id, entry?.kind === "deleted" ? 400 : 404)
    const customer = apply(current, params)
    if (
      customer.invoice_settings.default_payment_method &&
      customer.invoice_settings.default_payment_method !==
        current.invoice_settings.default_payment_method
    )
      await assertPaymentMethod(state, id, customer.invoice_settings.default_payment_method)
    await state.customers.update(id, { kind: "live", customer })
    if (customer.balance !== current.balance && customer.currency)
      await recordCustomerBalance(
        state,
        customer,
        customer.balance - current.balance,
        seconds(context.now),
        null,
      )
    const body = renderCustomer(customer)
    await recordEvent(state, "customer.updated", body, seconds(context.now))
    return jsonResponse(200, body)
  },

  DeleteCustomersCustomer: async (context: OperationContext) => {
    const id = context.params.customer ?? ""
    await live(state, id, 404)
    await state.customers.update(id, { kind: "deleted", id })
    const body = renderDeleted(id)
    await recordEvent(state, "customer.deleted", body, seconds(context.now))
    return jsonResponse(200, body)
  },
})
