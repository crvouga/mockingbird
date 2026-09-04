import { jsonResponse, type OperationContext, opaqueToken } from "@crvouga/mockingbird-service"
import { resourceMissing } from "./errors.js"
import { mergeMetadata, optionalString, strippedString, validateEmail } from "./fields.js"
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

const renderCustomer = (customer: CustomerRecord) => ({
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
    default_payment_method: null,
    footer: customer.invoice_settings.footer,
    rendering_options: null,
  },
  livemode: false,
  metadata: customer.metadata,
  name: customer.name,
  next_invoice_sequence: 1,
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
    const settings = params.invoice_settings as { custom_fields?: unknown; footer?: string }
    if (settings.custom_fields !== undefined) {
      next.invoice_settings.custom_fields =
        settings.custom_fields === ""
          ? []
          : (settings.custom_fields as CustomerRecord["invoice_settings"]["custom_fields"])
    }
    if (settings.footer !== undefined)
      next.invoice_settings.footer = settings.footer === "" ? null : settings.footer
  }
  return next
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
      invoice_settings: { custom_fields: null, footer: null },
      metadata: {},
      name: null,
      phone: null,
      preferred_locales: [],
      shipping: null,
      tax_exempt: "none",
    }
    const customer = apply(base, params)
    await state.customers.insert(id, { kind: "live", customer })
    return jsonResponse(200, renderCustomer(customer))
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
    await state.customers.update(id, { kind: "live", customer })
    return jsonResponse(200, renderCustomer(customer))
  },

  DeleteCustomersCustomer: async (context: OperationContext) => {
    const id = context.params.customer ?? ""
    await live(state, id, 404)
    await state.customers.update(id, { kind: "deleted", id })
    return jsonResponse(200, renderDeleted(id))
  },
})
