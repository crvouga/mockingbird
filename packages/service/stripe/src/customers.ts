import { jsonResponse, type OperationHandler, opaqueToken } from "@crvouga/mockingbird-service"
import { cancelSubscription } from "./billing.js"
import {
  invalidRequest,
  parameterInvalidEmpty,
  parameterMissing,
  resourceMissing,
} from "./errors.js"
import { applyExpand, type ExpandResolvers } from "./expand.js"
import { mergeMetadata, optionalString, strippedString, validateEmail } from "./fields.js"
import {
  applyBalanceTransaction,
  type RequestScope,
  requestScope,
  requireLiveCustomer,
  type Services,
} from "./internal.js"
import { matchesCreated, paginate } from "./list.js"
import { bodyParams, type Params, queryParams } from "./params.js"
import {
  renderCustomer,
  renderCustomerBalanceTransaction,
  renderDeletedCustomer,
  renderPaymentMethod,
} from "./render.js"
import { searchRecords } from "./search.js"
import {
  type Address,
  type CustomerEntry,
  type CustomerRecord,
  type Metadata,
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
    // Stripe upper-cases the country code it stores (live: "sN" comes back "SN").
    out[key] =
      value === undefined
        ? null
        : key === "country"
          ? value.replace(/[a-z]/g, (letter) => letter.toUpperCase())
          : value
  }
  return out
}

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
      default_payment_method?: unknown
      footer?: string
    }
    if (settings.custom_fields !== undefined) {
      if (Array.isArray(settings.custom_fields))
        settings.custom_fields.forEach((field, index) => {
          for (const key of ["name", "value"] as const)
            if ((field as Record<string, unknown>)?.[key] === "")
              throw parameterInvalidEmpty(`invoice_settings[custom_fields][${index}][${key}]`)
        })
      next.invoice_settings.custom_fields =
        settings.custom_fields === ""
          ? []
          : (settings.custom_fields as CustomerRecord["invoice_settings"]["custom_fields"])
    }
    if (settings.default_payment_method !== undefined)
      next.invoice_settings.default_payment_method =
        settings.default_payment_method === "" ? null : String(settings.default_payment_method)
    if (settings.footer !== undefined)
      next.invoice_settings.footer = settings.footer === "" ? null : settings.footer
  }
  return next
}

/** Expansion table covering both the bare and the list-envelope spelling of the path. */
const expanders = (scope: RequestScope): ExpandResolvers => {
  const defaultPaymentMethod = (id: string): Record<string, unknown> | undefined => {
    const method = scope.account.paymentMethods.get(id)
    return method ? renderPaymentMethod(method) : undefined
  }
  return {
    "invoice_settings.default_payment_method": defaultPaymentMethod,
    "data.invoice_settings.default_payment_method": defaultPaymentMethod,
  }
}

export const customerHandlers = (services: Services): Record<string, OperationHandler> => {
  const render = (scope: RequestScope, customer: CustomerRecord, params: Params) =>
    applyExpand(renderCustomer(customer), params.expand, expanders(scope))

  return {
    PostCustomers: async (context) => {
      const scope = requestScope(services, context)
      const params = bodyParams(context)
      const id = scope.ids.next("cus_")
      const base: CustomerRecord = {
        id,
        address: null,
        balance: 0,
        created: seconds(scope.now),
        currency: null,
        description: null,
        email: null,
        invoice_prefix: opaqueToken(`invoice-prefix:${id}`, 8).toUpperCase(),
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
      }
      const clock =
        typeof params.test_clock === "string" && params.test_clock !== "" ? params.test_clock : null
      if (clock !== null && !scope.account.testClocks.get(clock))
        throw resourceMissing("test_clock", clock, "test_clock")
      const customer = { ...apply(base, params), test_clock: clock }
      if (customer.invoice_settings.default_payment_method !== null)
        throw invalidRequest(
          `The customer does not have a payment method with the ID ${customer.invoice_settings.default_payment_method}. The payment method must be attached to the customer.`,
          "invoice_settings[default_payment_method]",
        )
      scope.account.customers.insert(id, { kind: "live", customer })
      scope.emit("customer.created", renderCustomer(customer))
      return jsonResponse(200, render(scope, customer, params))
    },

    GetCustomers: async (context) => {
      const scope = requestScope(services, context)
      const params = queryParams(context)
      const clock =
        typeof params.test_clock === "string" && params.test_clock !== "" ? params.test_clock : null
      if (clock !== null && !scope.account.testClocks.get(clock))
        throw resourceMissing("billingclock", clock, "test_clock", 400)
      const email = params.email
      const page = await paginate<CustomerEntry>(scope.account.customers, params, {
        url: "/v1/customers",
        kind: "customer",
        where: (entry) =>
          entry.kind === "live" &&
          matchesCreated(entry.customer.created, params.created) &&
          (email === undefined || email === "" || entry.customer.email === email),
        exists: (entry) => entry.kind === "live",
        render: (entry) => (entry.kind === "live" ? renderCustomer(entry.customer) : undefined),
      })
      return jsonResponse(200, applyExpand(page, params.expand, expanders(scope)))
    },

    GetCustomersSearch: async (context) => {
      const scope = requestScope(services, context)
      const params = queryParams(context)
      const records = scope.account.customers
        .list({ order: "newest" })
        .map((entry) => entry.value)
        .flatMap((entry) => (entry.kind === "live" ? [entry.customer] : []))
      return jsonResponse(
        200,
        searchRecords(records, params, {
          url: "/v1/customers/search",
          render: renderCustomer,
          lag: scope.effect("search_lag"),
          now: scope.now,
        }),
      )
    },

    GetCustomersCustomer: async (context) => {
      const scope = requestScope(services, context)
      const params = queryParams(context)
      const id = context.params.customer ?? ""
      const entry = scope.account.customers.get(id)
      if (!entry) throw resourceMissing("customer", id, "id")
      return jsonResponse(
        200,
        entry.kind === "deleted"
          ? renderDeletedCustomer(id)
          : render(scope, entry.customer, params),
      )
    },

    PostCustomersCustomer: async (context) => {
      const scope = requestScope(services, context)
      const params = bodyParams(context)
      const id = context.params.customer ?? ""
      const entry = scope.account.customers.get(id)
      if (!entry || entry.kind === "deleted")
        throw resourceMissing("customer", id, "id", entry?.kind === "deleted" ? 400 : 404)
      const customer = apply(entry.customer, params)
      const defaultMethod = customer.invoice_settings.default_payment_method
      if (
        defaultMethod !== null &&
        defaultMethod !== entry.customer.invoice_settings.default_payment_method &&
        scope.account.paymentMethods.get(defaultMethod)?.customer !== id
      )
        throw invalidRequest(
          `The customer does not have a payment method with the ID ${defaultMethod}. The payment method must be attached to the customer.`,
          "invoice_settings[default_payment_method]",
        )
      scope.account.customers.update(id, { kind: "live", customer })
      scope.emit("customer.updated", renderCustomer(customer))
      return jsonResponse(200, render(scope, customer, params))
    },

    DeleteCustomersCustomer: async (context) => {
      const scope = requestScope(services, context)
      const id = context.params.customer ?? ""
      const entry = scope.account.customers.get(id)
      if (!entry || entry.kind === "deleted") throw resourceMissing("customer", id, "id")
      for (const subscription of scope.account.subscriptions.list({
        where: (record) =>
          record.customer === id && !["canceled", "incomplete_expired"].includes(record.status),
      }))
        cancelSubscription(scope, subscription.value)
      scope.account.customers.update(id, { kind: "deleted", id })
      scope.emit("customer.deleted", renderDeletedCustomer(id))
      return jsonResponse(200, renderDeletedCustomer(id))
    },

    GetCustomersCustomerBalanceTransactions: async (context) => {
      const scope = requestScope(services, context)
      const params = queryParams(context)
      const id = context.params.customer ?? ""
      // Stripe resolves the list cursor before the customer in the path.
      const page = await paginate(scope.account.balanceTransactions, params, {
        url: `/v1/customers/${id}/balance_transactions`,
        // Stripe names an unknown cursor on this list by its internal model.
        kind: "abstracttransaction",
        where: (record) => record.customer === id && matchesCreated(record.created, params.created),
        render: renderCustomerBalanceTransaction,
      })
      requireLiveCustomer(scope, id, "customer")
      return jsonResponse(200, page)
    },

    PostCustomersCustomerBalanceTransactions: async (context) => {
      const scope = requestScope(services, context)
      const params = bodyParams(context)
      const id = context.params.customer ?? ""
      const customer = requireLiveCustomer(scope, id, "customer")
      const amount = typeof params.amount === "number" ? params.amount : undefined
      if (amount === undefined) throw parameterMissing("amount")
      const currency =
        typeof params.currency === "string" && params.currency !== ""
          ? params.currency
          : (customer.currency ?? ACCOUNT_CURRENCY)
      const description = typeof params.description === "string" ? params.description : null
      const metadata = (params.metadata as Metadata | undefined) ?? {}
      const { id: transactionId } = applyBalanceTransaction(scope, {
        customer,
        amount,
        currency,
        description,
        metadata,
        type: "adjustment",
      })
      const transaction = scope.account.balanceTransactions.get(transactionId)
      if (!transaction)
        throw resourceMissing("customer_balance_transaction", transactionId, "transaction")
      return jsonResponse(200, renderCustomerBalanceTransaction(transaction))
    },
  }
}
