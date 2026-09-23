import type { OpenAPIDocument, Operation } from "@crvouga/mockingbird-openapi"
import { StripeError } from "./errors.js"
import {
  renderBalanceTransaction,
  renderCharge,
  renderCheckoutLineItem,
  renderCoupon,
  renderCustomer,
  renderDeletedCustomer,
  renderDiscount,
  renderDispute,
  renderInvoice,
  renderPaymentIntent,
  renderPaymentMethod,
  renderPrice,
  renderProduct,
  renderPromotionCode,
  renderRefund,
  renderSetupIntent,
  renderSubscription,
  renderSubscriptionItem,
  renderSubscriptionSchedule,
  renderTestClock,
} from "./render.js"
import type { AccountState } from "./state.js"

type RecordValue = Record<string, unknown>

/** Resolver table kept for handlers' call sites; expansion itself is generic (`expandResponse`). */
export type ExpandResolvers = Readonly<Record<string, ((id: string) => unknown) | undefined>>

/**
 * Handlers used to expand their own responses; the mock now expands every response generically
 * after the handler runs, so this is the identity.
 */
export const applyExpand = <T>(value: T, _expand: unknown, _resolvers?: ExpandResolvers): T => value

/** `expand[]` from a decoded query or form body, as a list of dotted paths. */
export const expandPathsOf = (raw: unknown): string[] => {
  if (Array.isArray(raw))
    return raw.filter((entry): entry is string => typeof entry === "string" && entry !== "")
  if (typeof raw === "string" && raw !== "") return [raw]
  if (typeof raw === "object" && raw !== null)
    return Object.values(raw).filter((entry): entry is string => typeof entry === "string")
  return []
}

/**
 * First path segments Stripe accepts per object type. Stripe rejects a path whose first
 * segment is not expandable (`This property cannot be expanded (metadata).`) and any path
 * deeper than four levels; deeper segments are not checked (verified against test mode:
 * `customer.foo` is accepted, `foo` and `metadata` are not).
 */
const EXPANDABLE: Record<string, readonly string[]> = {
  customer: [
    "cash_balance",
    "default_source",
    "discount",
    "invoice_credit_balance",
    "invoice_settings",
    "sources",
    "subscriptions",
    "tax",
    "tax_ids",
    "test_clock",
  ],
  payment_intent: [
    "application",
    "customer",
    "invoice",
    "last_payment_error",
    "latest_charge",
    "on_behalf_of",
    "payment_method",
    "processing",
    "review",
    "source",
    "transfer_data",
  ],
  setup_intent: [
    "application",
    "customer",
    "last_setup_error",
    "latest_attempt",
    "mandate",
    "on_behalf_of",
    "payment_method",
    "single_use_mandate",
  ],
  payment_method: ["customer"],
  charge: [
    "application",
    "application_fee",
    "balance_transaction",
    "customer",
    "destination",
    "dispute",
    "failure_balance_transaction",
    "invoice",
    "on_behalf_of",
    "order",
    "payment_intent",
    "refunds",
    "review",
    "source",
    "source_transfer",
    "transfer",
    "transfer_data",
  ],
  refund: [
    "balance_transaction",
    "charge",
    "failure_balance_transaction",
    "payment_intent",
    "source_transfer_reversal",
    "transfer_reversal",
  ],
  dispute: ["balance_transactions", "charge", "payment_intent"],
  "checkout.session": [
    "customer",
    "discounts",
    "invoice",
    "line_items",
    "payment_intent",
    "payment_link",
    "setup_intent",
    "subscription",
    "total_details",
  ],
  invoice: [
    "account_tax_ids",
    "application",
    "charge",
    "customer",
    "default_payment_method",
    "default_source",
    "default_tax_rates",
    "discount",
    "discounts",
    "from_invoice",
    "last_finalization_error",
    "latest_revision",
    "lines",
    "on_behalf_of",
    "parent",
    "payment_intent",
    "payments",
    "quote",
    "subscription",
    "test_clock",
    "total_discount_amounts",
  ],
  invoiceitem: [
    "customer",
    "discounts",
    "invoice",
    "parent",
    "price",
    "pricing",
    "subscription",
    "tax_rates",
    "test_clock",
  ],
  subscription: [
    "application",
    "customer",
    "default_payment_method",
    "default_source",
    "default_tax_rates",
    "discount",
    "discounts",
    "items",
    "latest_invoice",
    "on_behalf_of",
    "pending_setup_intent",
    "pending_update",
    "schedule",
    "test_clock",
    "transfer_data",
  ],
  subscription_item: ["discounts", "price", "tax_rates"],
  subscription_schedule: [
    "application",
    "customer",
    "default_settings",
    "phases",
    "released_subscription",
    "subscription",
    "test_clock",
  ],
  coupon: ["applies_to", "currency_options"],
  promotion_code: ["coupon", "customer", "promotion"],
  product: ["default_price", "tax_code"],
  price: ["currency_options", "product", "tiers"],
  balance_transaction: ["source"],
  customer_balance_transaction: ["checkout_session", "credit_note", "customer", "invoice"],
  "test_helpers.test_clock": [],
  webhook_endpoint: [],
  event: [],
  account: ["external_accounts"],
  balance: [],
  discount: ["customer", "promotion_code", "subscription"],
}

const cannotExpand = (segment: string) =>
  new StripeError({
    status: 400,
    message: `This property cannot be expanded (${segment}).`,
  })

const tooDeep = (path: string) =>
  new StripeError({
    status: 400,
    code: "property_expansion_max_depth",
    noDocUrl: true,
    message: `You cannot expand more than 4 levels of a property. Property: ${path}`,
  })

type ResponseShape = { object: string; list: boolean; search: boolean }

const refName = (schema: unknown): string | undefined => {
  if (typeof schema !== "object" || schema === null) return undefined
  const record = schema as RecordValue
  if (typeof record.$ref === "string") return record.$ref.replace("#/components/schemas/", "")
  for (const key of ["anyOf", "oneOf"] as const) {
    const branches = record[key]
    if (Array.isArray(branches))
      for (const branch of branches) {
        const name = refName(branch)
        if (name !== undefined) return name
      }
  }
  return undefined
}

/** The object type an operation answers with, read from its 200 schema. */
export const responseShape = (
  document: OpenAPIDocument,
  operation: Operation,
): ResponseShape | undefined => {
  const media = (operation.operation.responses?.["200"] as RecordValue | undefined)?.content as
    | RecordValue
    | undefined
  const schema = (media?.["application/json"] as RecordValue | undefined)?.schema as
    | RecordValue
    | undefined
  if (schema === undefined) return undefined
  const direct = refName(schema)
  const name =
    direct ??
    refName(
      ((schema.properties as RecordValue | undefined)?.data as RecordValue | undefined)?.items,
    )
  if (name === undefined) return undefined
  const component = document.components?.schemas?.[name] as RecordValue | undefined
  const objectEnum = (
    (component?.properties as RecordValue | undefined)?.object as RecordValue | undefined
  )?.enum
  const object =
    Array.isArray(objectEnum) && typeof objectEnum[0] === "string" ? objectEnum[0] : name
  const wrapper = (
    (schema.properties as RecordValue | undefined)?.object as RecordValue | undefined
  )?.enum
  const search = Array.isArray(wrapper) && wrapper.includes("search_result")
  return { object, list: direct === undefined, search }
}

/** Reject what Stripe rejects, before the operation runs. */
export const validateExpand = (paths: readonly string[], shape: ResponseShape | undefined) => {
  for (const path of paths) {
    // Search results count their matches on request; lists refuse to.
    if (path === "total_count" && shape?.search) continue
    if (path === "total_count" && shape?.list)
      throw new StripeError({
        status: 400,
        message: "This property cannot be included (total_count)",
      })
    let segments = path.split(".")
    if (shape?.list) {
      if (segments[0] !== "data") throw cannotExpand(segments[0] ?? path)
      segments = segments.slice(1)
    }
    if (segments.length > 4) throw tooDeep(path)
    const allowed = shape === undefined ? undefined : EXPANDABLE[shape.object]
    const head = segments[0]
    if (head === undefined || head === "") throw cannotExpand(path)
    if (allowed !== undefined && !allowed.includes(head)) throw cannotExpand(head)
  }
}

const FIELD_KINDS: Record<string, string> = {
  coupon: "coupon",
  promotion_code: "promotion_code",
  default_price: "price",
  price: "price",
  product: "product",
  customer: "customer",
  invoice: "invoice",
  latest_invoice: "invoice",
  payment_intent: "payment_intent",
  latest_charge: "charge",
  charge: "charge",
  payment_method: "payment_method",
  default_payment_method: "payment_method",
  subscription: "subscription",
  released_subscription: "subscription",
  schedule: "subscription_schedule",
  setup_intent: "setup_intent",
  balance_transaction: "balance_transaction",
  test_clock: "test_clock",
  discounts: "discount",
  discount: "discount",
  dispute: "dispute",
}

const PREFIX_KINDS: ReadonlyArray<[string, string]> = [
  ["sub_sched_", "subscription_schedule"],
  ["cus_", "customer"],
  ["pi_", "payment_intent"],
  ["seti_", "setup_intent"],
  ["pm_", "payment_method"],
  ["ch_", "charge"],
  ["re_", "refund"],
  ["in_", "invoice"],
  ["sub_", "subscription"],
  ["si_", "subscription_item"],
  ["price_", "price"],
  ["prod_", "product"],
  ["promo_", "promotion_code"],
  ["di_", "discount"],
  ["dp_", "dispute"],
  ["txn_", "balance_transaction"],
  ["clock_", "test_clock"],
]

const resolve = (account: AccountState, now: number, kind: string, id: string): unknown => {
  switch (kind) {
    case "customer": {
      const entry = account.customers.get(id)
      if (!entry) return undefined
      return entry.kind === "live" ? renderCustomer(entry.customer) : renderDeletedCustomer(id)
    }
    case "payment_intent": {
      const record = account.paymentIntents.get(id)
      return record && renderPaymentIntent(record)
    }
    case "setup_intent": {
      const record = account.setupIntents.get(id)
      return record && renderSetupIntent(record)
    }
    case "payment_method": {
      const record = account.paymentMethods.get(id)
      return record && renderPaymentMethod(record)
    }
    case "charge": {
      const record = account.charges.get(id)
      return record && renderCharge(record)
    }
    case "refund": {
      const record = account.refunds.get(id)
      return record && renderRefund(record)
    }
    case "invoice": {
      const record = account.invoices.get(id)
      return record && renderInvoice(record, account)
    }
    case "subscription": {
      const record = account.subscriptions.get(id)
      return record && renderSubscription(record, account)
    }
    case "subscription_item": {
      const record = account.subscriptionItems.get(id)
      return record && renderSubscriptionItem(record, account)
    }
    case "subscription_schedule": {
      const record = account.subscriptionSchedules.get(id)
      return record && renderSubscriptionSchedule(record)
    }
    case "price": {
      const record = account.prices.get(id)
      return record && renderPrice(record)
    }
    case "product": {
      const record = account.products.get(id)
      return record && renderProduct(record)
    }
    case "coupon": {
      const record = account.coupons.get(id)
      return record && renderCoupon(record)
    }
    case "promotion_code": {
      const record = account.promotionCodes.get(id)
      return record && renderPromotionCode(record, account)
    }
    case "discount": {
      const record = account.discounts.get(id)
      return record && renderDiscount(record, account)
    }
    case "dispute": {
      const record = account.disputes.get(id)
      return record && renderDispute(record)
    }
    case "balance_transaction": {
      const record = account.ledger.get(id)
      return record && renderBalanceTransaction(record, now)
    }
    case "test_clock": {
      const record = account.testClocks.get(id)
      return record && renderTestClock(record)
    }
  }
  return undefined
}

const kindOf = (field: string, id: string): string | undefined =>
  FIELD_KINDS[field] ?? PREFIX_KINDS.find(([prefix]) => id.startsWith(prefix))?.[1]

const isRecord = (value: unknown): value is RecordValue =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Fields that only appear when expanded (Stripe's "includable" fields). */
const includable = (account: AccountState, node: RecordValue, field: string): unknown => {
  if (node.object === "charge" && field === "refunds" && typeof node.id === "string") {
    const refunds = account.refunds
      .list({ order: "newest", where: (refund) => refund.charge === node.id })
      .map((entry) => renderRefund(entry.value))
    return {
      object: "list",
      data: refunds,
      has_more: false,
      total_count: refunds.length,
      url: `/v1/charges/${node.id}/refunds`,
    }
  }
  if (node.object === "coupon" && typeof node.id === "string") {
    const coupon = account.coupons.get(node.id)
    if (!coupon) return undefined
    if (field === "applies_to") return renderCoupon(coupon, { appliesTo: true }).applies_to
    if (field === "currency_options")
      return renderCoupon(coupon, { currencyOptions: true }).currency_options
  }
  if (node.object === "checkout.session" && field === "line_items" && typeof node.id === "string") {
    const session = account.checkoutSessions.get(node.id)
    if (!session) return undefined
    return {
      object: "list",
      data: session.line_items.map((line) => renderCheckoutLineItem(line, account)),
      has_more: false,
      url: `/v1/checkout/sessions/${node.id}/line_items`,
    }
  }
  return undefined
}

const expandAt = (
  account: AccountState,
  now: number,
  node: unknown,
  segments: readonly string[],
): unknown => {
  const [head, ...rest] = segments
  if (head === undefined || node === null || node === undefined) return node
  if (Array.isArray(node)) return node.map((item) => expandAt(account, now, item, segments))
  if (!isRecord(node)) return node
  if ((node.object === "list" || node.object === "search_result") && head === "data") {
    node.data = expandAt(account, now, node.data, rest)
    return node
  }
  let value: unknown = node[head]
  if (value === undefined) {
    const included = includable(account, node, head)
    if (included === undefined) return node
    value = included
  }
  const expandId = (id: unknown): unknown => {
    if (typeof id !== "string" || id === "") return id
    const kind = kindOf(head, id)
    const resolved = kind === undefined ? undefined : resolve(account, now, kind, id)
    return resolved ?? id
  }
  value = Array.isArray(value) ? value.map(expandId) : expandId(value)
  node[head] = rest.length === 0 ? value : expandAt(account, now, value, rest)
  return node
}

/**
 * Replace ids with objects along every requested path, after the handler has rendered its
 * response. Ancestors of a path are expanded along the way, as Stripe does; paths through a
 * field the mock does not model leave the response untouched.
 */
export const expandResponse = (
  account: AccountState,
  now: number,
  value: unknown,
  paths: readonly string[],
): unknown => {
  const ordered = [...paths].sort((a, b) => a.split(".").length - b.split(".").length)
  let out = value
  for (const path of ordered) out = expandAt(account, now, out, path.split("."))
  return out
}
