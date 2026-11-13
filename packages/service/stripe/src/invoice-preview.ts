/**
 * Invoice previews: `POST /v1/invoices/create_preview`, and `GET /v1/invoices/upcoming` (plus its
 * `/lines`) at the API versions that still serve it. A preview is the invoice a customer or
 * subscription would get next, with the requested subscription changes applied, and writes
 * nothing: no records, no coupon redemptions, no events, no ids drawn from the account's sequence.
 *
 * The arithmetic mirrors what the real paths bill (`updateSubscription` → `billProration` /
 * `invoiceBillingCycleReset`, the renewal's `cycleLines`, `upcomingInvoice`), so a preview quotes
 * what the matching update then charges. Evidence: https://docs.stripe.com/api/invoices/create_preview
 * and https://docs.stripe.com/billing/subscriptions/prorations (preview response sample:
 * "Unused time on … after 01 Sep 2020" / "Remaining time on … after …" proration lines, then the
 * next period's lines). Choices those pages leave open are best guesses, listed in the README.
 */
import {
  addInterval,
  assertCompatiblePrices,
  type DiscountRequest,
  discountLines,
  INACTIVE_PRICE,
  parseDiscounts,
  recurringOf,
  resolveDiscountSource,
  sameBillingPeriod,
  subscriptionItems,
} from "./billing.js"
import { invalidRequest, parameterMissing, resourceMissing, StripeError } from "./errors.js"
import {
  booleanOf,
  customerNow,
  findCustomer,
  intOf,
  priceAmount,
  type RequestScope,
  recordOf,
  requirePrice,
  requireSubscription,
  stringOf,
} from "./internal.js"
import type { Params } from "./params.js"
import { renderInvoice } from "./render.js"
import type {
  AccountState,
  DiscountRecord,
  InvoiceLineRecord,
  InvoiceRecord,
  PriceRecord,
  SubscriptionItemRecord,
  SubscriptionRecord,
} from "./state.js"

type RecordValue = Record<string, unknown>

export type PreviewSurface = "create_preview" | "upcoming"

type ProrationBehavior = "always_invoice" | "create_prorations" | "none"

type PreviewItem = {
  id: string | null
  price: string | null
  quantity: number | undefined
  deleted: boolean
  param: string
}

type PreviewInvoiceItem = {
  price: string | null
  quantity: number
  amount: number | undefined
  currency: string | null
  description: string | null
  param: string
}

export type PreviewRequest = {
  surface: PreviewSurface
  customer: string | null
  customerDetails: boolean
  subscription: string | null
  items: PreviewItem[] | undefined
  itemsParam: string
  prorationBehavior: ProrationBehavior
  prorationDate: number | undefined
  prorationDateParam: string
  discounts: DiscountRequest[] | "clear" | undefined
  invoiceItems: PreviewInvoiceItem[]
}

/** An explicit refusal for a preview option the emulator does not model (never ignored). */
const notModelled = (param: string) =>
  invalidRequest(`Previewing with \`${param}\` is not modelled by this emulator.`, param)

const ONE_TIME_ONLY =
  "The price specified is set to `type=one_time` but this field only accepts prices with `type=recurring`."

const PRORATION_BEHAVIORS: readonly string[] = ["always_invoice", "create_prorations", "none"]

/** Refuse every key of `record` outside `allowed`, as `<prefix>[<key>]`. */
const onlyKeys = (record: RecordValue, allowed: readonly string[], prefix: string) => {
  for (const key of Object.keys(record))
    if (!allowed.includes(key) && record[key] !== undefined) throw notModelled(`${prefix}[${key}]`)
}

const parseItems = (raw: unknown, param: string): PreviewItem[] | undefined => {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) return []
  return raw.map((entry, index) => {
    const record = recordOf(entry) ?? {}
    const prefix = `${param}[${index}]`
    onlyKeys(record, ["id", "price", "quantity", "deleted", "metadata"], prefix)
    return {
      id: stringOf(record, "id"),
      price: stringOf(record, "price"),
      quantity: intOf(record.quantity),
      deleted: booleanOf(record.deleted) === true,
      param: prefix,
    }
  })
}

const parseInvoiceItems = (raw: unknown): PreviewInvoiceItem[] => {
  if (!Array.isArray(raw)) return []
  return raw.map((entry, index) => {
    const record = recordOf(entry) ?? {}
    const prefix = `invoice_items[${index}]`
    onlyKeys(record, ["price", "quantity", "amount", "currency", "description", "metadata"], prefix)
    const price = stringOf(record, "price")
    const amount = intOf(record.amount)
    if (price === null && amount === undefined) throw parameterMissing(`${prefix}[amount]`)
    if (price !== null && amount !== undefined)
      throw invalidRequest(
        "You may only specify one of these parameters: amount, price.",
        `${prefix}[amount]`,
      )
    if (amount !== undefined && stringOf(record, "currency") === null)
      throw parameterMissing(`${prefix}[currency]`)
    return {
      price,
      quantity: intOf(record.quantity) ?? 1,
      amount,
      currency: stringOf(record, "currency"),
      description: stringOf(record, "description"),
      param: prefix,
    }
  })
}

/** The flat `subscription_*` forms `GET /v1/invoices/upcoming` takes at 2024-06-20. */
const LEGACY_FLAT = [
  "subscription_items",
  "subscription_proration_behavior",
  "subscription_proration_date",
] as const

/** Read and validate a preview's parameters; anything not modelled is refused here. */
export const parsePreviewRequest = (params: Params, surface: PreviewSurface): PreviewRequest => {
  for (const key of [
    "customer_account",
    "issuer",
    "on_behalf_of",
    "schedule",
    "schedule_details",
    "currency",
  ])
    if (params[key] !== undefined && params[key] !== "") throw notModelled(key)
  const automaticTax = recordOf(params.automatic_tax)
  if (automaticTax !== undefined) {
    if (booleanOf(automaticTax.enabled) === true) throw notModelled("automatic_tax[enabled]")
    onlyKeys(automaticTax, ["enabled"], "automatic_tax")
  }
  const mode = stringOf(params, "preview_mode")
  if (mode !== null && mode !== "next") throw notModelled("preview_mode")
  const customerDetails = recordOf(params.customer_details)
  if (customerDetails !== undefined) onlyKeys(customerDetails, ["tax_exempt"], "customer_details")
  for (const key of Object.keys(params))
    if (
      key.startsWith("subscription_") &&
      key !== "subscription_details" &&
      !(LEGACY_FLAT as readonly string[]).includes(key)
    )
      throw notModelled(key)
  const details = recordOf(params.subscription_details)
  if (details !== undefined)
    onlyKeys(details, ["items", "proration_behavior", "proration_date"], "subscription_details")
  const flat = LEGACY_FLAT.some((key) => params[key] !== undefined)
  if (flat && details !== undefined)
    throw invalidRequest(
      "You cannot combine `subscription_details` with the `subscription_items`, `subscription_proration_behavior` and `subscription_proration_date` parameters.",
      "subscription_details",
    )
  const source: RecordValue = flat
    ? {
        items: params.subscription_items,
        proration_behavior: params.subscription_proration_behavior,
        proration_date: params.subscription_proration_date,
      }
    : (details ?? {})
  const itemsParam = flat ? "subscription_items" : "subscription_details[items]"
  const behaviorRaw = stringOf(source, "proration_behavior")
  if (behaviorRaw !== null && !PRORATION_BEHAVIORS.includes(behaviorRaw))
    throw invalidRequest(
      `Invalid ${flat ? "subscription_proration_behavior" : "subscription_details[proration_behavior]"}: must be one of always_invoice, create_prorations, or none`,
    )
  const coupon = stringOf(params, "coupon")
  const discounts = parseDiscounts(params.discounts)
  if (coupon !== null && discounts !== undefined)
    throw invalidRequest(
      "You may only specify one of these parameters: coupon, discounts.",
      "coupon",
    )
  return {
    surface,
    customer: stringOf(params, "customer"),
    customerDetails: customerDetails !== undefined,
    subscription: stringOf(params, "subscription"),
    items: parseItems(source.items, itemsParam),
    itemsParam,
    prorationBehavior: (behaviorRaw ?? "create_prorations") as ProrationBehavior,
    prorationDate: intOf(source.proration_date),
    prorationDateParam: flat
      ? "subscription_proration_date"
      : "subscription_details[proration_date]",
    discounts: coupon === null ? discounts : [{ coupon }],
    invoiceItems: parseInvoiceItems(params.invoice_items),
  }
}

// --- the preview --------------------------------------------------------------------------------

/** An account view that also sees the preview's not-yet-created discounts. */
const withDiscounts = (account: AccountState, extra: Map<string, DiscountRecord>): AccountState => {
  if (extra.size === 0) return account
  const bind = (target: object, prop: string | symbol) => {
    const value = Reflect.get(target, prop, target)
    return typeof value === "function" ? value.bind(target) : value
  }
  const discounts = new Proxy(account.discounts, {
    get: (target, prop) =>
      prop === "get" ? (id: string) => extra.get(id) ?? target.get(id) : bind(target, prop),
  })
  return new Proxy(account, {
    get: (target, prop) => (prop === "discounts" ? discounts : bind(target, prop)),
  })
}

/** Stripe dates proration lines as `01 Sep 2020` (UTC). */
const prorationDay = (at: number) => {
  const date = new Date(at * 1000)
  const month = date.toLocaleString("en-US", { month: "short", timeZone: "UTC" })
  return `${String(date.getUTCDate()).padStart(2, "0")} ${month} ${date.getUTCFullYear()}`
}

type Builder = {
  scope: RequestScope
  lines: InvoiceLineRecord[]
}

const nextLineId = (builder: Builder) =>
  `il_tmp_${String(builder.lines.length + 1).padStart(17, "0")}`

const productName = (scope: RequestScope, price: PriceRecord) =>
  scope.account.products.get(price.product)?.name ?? price.product

const quantityLabel = (quantity: number) => (quantity === 1 ? "" : `${quantity} × `)

const pushPriceLine = (
  builder: Builder,
  price: PriceRecord,
  quantity: number,
  period: { start: number; end: number },
  extra: {
    amount?: number
    description?: string
    proration?: boolean
    subscription?: string | null
    subscriptionItem?: string | null
    type?: InvoiceLineRecord["type"]
  } = {},
) => {
  const amount = extra.amount ?? priceAmount(price, quantity)
  builder.lines.push({
    id: nextLineId(builder),
    amount,
    currency: price.currency,
    description: extra.description ?? `${quantity} × ${productName(builder.scope, price)}`,
    discount_amounts: [],
    invoice_item: null,
    metadata: {},
    period,
    price: price.id,
    quantity,
    proration: extra.proration ?? false,
    subtotal: amount,
    type: extra.type ?? "subscription",
    subscription: extra.subscription ?? null,
    subscription_item: extra.subscriptionItem ?? null,
  })
}

/** The customer's pending proration items, as the renewal (`cycleLines`) bills them. */
const pushPendingProrations = (builder: Builder, customer: string, subscription: string) => {
  const pending = builder.scope.account.invoiceItems.list({
    order: "oldest",
    where: (item) => item.customer === customer && item.invoice === null && item.proration,
  })
  for (const { value: item } of pending)
    builder.lines.push({
      id: nextLineId(builder),
      amount: item.amount,
      currency: item.currency,
      description: item.description,
      discount_amounts: [],
      invoice_item: item.id,
      metadata: item.metadata,
      period: item.period,
      price: item.price,
      quantity: item.quantity,
      proration: true,
      subtotal: item.amount,
      type: "invoiceitem",
      subscription,
    })
}

/** Every pending invoice item of the customer (a manual invoice's preview). */
const pushPendingItems = (builder: Builder, customer: string) => {
  const pending = builder.scope.account.invoiceItems.list({
    order: "oldest",
    where: (item) => item.customer === customer && item.invoice === null,
  })
  for (const { value: item } of pending)
    builder.lines.push({
      id: nextLineId(builder),
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
}

const pushRequestedItems = (builder: Builder, items: PreviewInvoiceItem[], now: number) => {
  for (const item of items) {
    if (item.price !== null) {
      const price = requirePrice(builder.scope, item.price, `${item.param}[price]`)
      pushPriceLine(
        builder,
        price,
        item.quantity,
        { start: now, end: now },
        {
          type: "invoiceitem",
          ...(item.description === null ? {} : { description: item.description }),
        },
      )
      continue
    }
    const amount = (item.amount ?? 0) * item.quantity
    builder.lines.push({
      id: nextLineId(builder),
      amount,
      currency: item.currency ?? "usd",
      description: item.description,
      discount_amounts: [],
      invoice_item: null,
      metadata: {},
      period: { start: now, end: now },
      price: null,
      quantity: item.quantity,
      proration: false,
      subtotal: amount,
      type: "invoiceitem",
    })
  }
}

/** A price a preview item may move to, checked the way the update path checks it. */
const subscribablePrice = (scope: RequestScope, id: string, param: string) => {
  const price = requirePrice(scope, id, param)
  if (price.recurring === null) throw invalidRequest(ONE_TIME_ONLY, param)
  if (!price.active) throw invalidRequest(INACTIVE_PRICE, param)
  return price
}

type ItemChange = {
  current: SubscriptionItemRecord | undefined
  price: PriceRecord
  quantity: number
  deleted: boolean
}

/** Apply the requested item changes to a copy of the subscription's items. */
const changedItems = (
  scope: RequestScope,
  subscription: SubscriptionRecord,
  requests: PreviewItem[],
  itemsParam: string,
): ItemChange[] => {
  const changes: ItemChange[] = subscriptionItems(scope, subscription).map((item) => ({
    current: item,
    price: requirePrice(scope, item.price),
    quantity: item.quantity ?? 1,
    deleted: false,
  }))
  for (const request of requests) {
    if (request.id !== null) {
      const change = changes.find((entry) => entry.current?.id === request.id)
      if (change === undefined)
        throw resourceMissing("subscription_item", request.id, `${request.param}[id]`)
      if (request.deleted) {
        change.deleted = true
        continue
      }
      const moved = request.price !== null && request.price !== change.price.id
      if (moved)
        change.price = subscribablePrice(scope, request.price as string, `${request.param}[price]`)
      // Changing the price resets the quantity to 1 unless one is given (Stripe's rule).
      change.quantity = request.quantity ?? (moved ? 1 : change.quantity)
      continue
    }
    if (request.deleted) throw parameterMissing(`${request.param}[id]`)
    if (request.price === null) throw parameterMissing(`${request.param}[price]`)
    changes.push({
      current: undefined,
      price: subscribablePrice(scope, request.price, `${request.param}[price]`),
      quantity: request.quantity ?? 1,
      deleted: false,
    })
  }
  const kept = changes.filter((change) => !change.deleted)
  if (kept.length > 0)
    assertCompatiblePrices(
      kept.map((change) => change.price),
      itemsParam,
    )
  return changes
}

/**
 * Credit for the unused time on each changed or removed item and a charge for the rest of the
 * period on its replacement. Per changed item the two lines sum to exactly the net amount the
 * update path bills (`round((new - old) × left)`), so the quote matches the charge.
 */
const pushProrations = (
  builder: Builder,
  subscription: SubscriptionRecord,
  changes: ItemChange[],
  at: number,
) => {
  const span = Math.max(1, subscription.current_period_end - subscription.current_period_start)
  const left = Math.max(0, subscription.current_period_end - at) / span
  const period = { start: at, end: subscription.current_period_end }
  const day = prorationDay(at)
  const line = (
    price: PriceRecord,
    quantity: number,
    amount: number,
    item: string | null,
    word: string,
  ) => {
    if (amount === 0) return
    pushPriceLine(builder, price, quantity, period, {
      amount,
      description: `${word} time on ${quantityLabel(quantity)}${productName(builder.scope, price)} after ${day}`,
      proration: true,
      subscription: subscription.id,
      subscriptionItem: item,
    })
  }
  for (const change of changes) {
    const current = change.current
    if (current === undefined) {
      line(
        change.price,
        change.quantity,
        Math.round(priceAmount(change.price, change.quantity) * left),
        null,
        "Remaining",
      )
      continue
    }
    const oldPrice = requirePrice(builder.scope, current.price)
    const oldQuantity = current.quantity ?? 1
    const oldAmount = priceAmount(oldPrice, oldQuantity)
    const credit = -Math.round(oldAmount * left)
    if (change.deleted) {
      line(oldPrice, oldQuantity, credit, current.id, "Unused")
      continue
    }
    if (change.price.id === oldPrice.id && change.quantity === oldQuantity) continue
    const net = Math.round((priceAmount(change.price, change.quantity) - oldAmount) * left)
    line(oldPrice, oldQuantity, credit, current.id, "Unused")
    line(change.price, change.quantity, net - credit, current.id, "Remaining")
  }
}

const pushCycle = (
  builder: Builder,
  subscription: string | null,
  changes: ItemChange[],
  period: { start: number; end: number },
) => {
  for (const change of changes)
    if (!change.deleted)
      pushPriceLine(builder, change.price, change.quantity, period, {
        subscription,
        subscriptionItem: change.current?.id ?? null,
      })
}

/** Discounts in force at `at` (repeating ones expire), as the renewal applies them. */
const liveDiscountIds = (scope: RequestScope, ids: readonly string[], at: number) =>
  ids.filter((id) => {
    const discount = scope.account.discounts.get(id)
    return discount !== undefined && (discount.end === null || discount.end > at)
  })

/**
 * The preview's discounts: the requested ones (validated, never redeemed) or, when none are
 * requested, the ones it inherits. `discounts=""` inherits nothing.
 */
const resolveDiscounts = (
  scope: RequestScope,
  request: PreviewRequest,
  inherited: string[],
  target: { customer: string | null; subscription: string | null },
): { ids: string[]; extra: Map<string, DiscountRecord> } => {
  const extra = new Map<string, DiscountRecord>()
  if (request.discounts === undefined) return { ids: inherited, extra }
  if (request.discounts === "clear") return { ids: [], extra }
  const ids = request.discounts.map((entry, index) => {
    if (entry.discount !== undefined) {
      if (!inherited.includes(entry.discount))
        throw resourceMissing("discount", entry.discount, `discounts[${index}][discount]`)
      return entry.discount
    }
    const source = resolveDiscountSource(scope, entry, `discounts[${index}]`)
    const coupon = scope.account.coupons.get(source.coupon)
    const start = customerNow(scope, target.customer)
    const id = `di_tmp_${String(index + 1).padStart(17, "0")}`
    extra.set(id, {
      id,
      coupon: source.coupon,
      promotion_code: source.promotion_code,
      customer: target.customer,
      subscription: target.subscription,
      invoice: null,
      checkout_session: null,
      start,
      end:
        coupon?.duration === "repeating" && coupon.duration_in_months !== null
          ? addInterval(start, "month", coupon.duration_in_months)
          : null,
    })
    return id
  })
  return { ids, extra }
}

const noUpcoming = (customer: string) =>
  new StripeError({
    status: 404,
    code: "invoice_upcoming_none",
    message: `No upcoming invoices for customer: ${customer}`,
  })

type Shape = {
  billingReason: string
  subscription: SubscriptionRecord | null
  customer: string | null
  created: number
  period: { start: number; end: number }
  nextPaymentAttempt: number | null
  inheritedDiscounts: string[]
}

/** Build the preview invoice's lines and frame without touching state. */
const compose = (
  scope: RequestScope,
  request: PreviewRequest,
): { builder: Builder; shape: Shape } => {
  const builder: Builder = { scope, lines: [] }
  const missingCustomerStatus = request.surface === "upcoming" ? 404 : 400
  if (request.customer !== null) {
    const entry = scope.account.customers.get(request.customer)
    if (!entry || entry.kind === "deleted")
      throw resourceMissing("customer", request.customer, "customer", missingCustomerStatus)
  }
  const subscriptionId = request.subscription
  const items = request.items
  if (request.prorationDate !== undefined) {
    if (subscriptionId === null || items === undefined || items.length === 0)
      throw invalidRequest(
        `\`${request.prorationDateParam}\` requires \`subscription\` and \`${request.itemsParam}\`.`,
        request.prorationDateParam,
      )
    if (request.prorationBehavior === "none")
      throw invalidRequest(
        `\`${request.prorationDateParam}\` cannot be used when proration behavior is \`none\`.`,
        request.prorationDateParam,
      )
  }
  // A new subscription (items without a subscription).
  if (subscriptionId === null && items !== undefined && items.length > 0) {
    if (request.customer === null && !request.customerDetails) throw parameterMissing("customer")
    const now = customerNow(scope, request.customer)
    const changes: ItemChange[] = items.map((item) => {
      if (item.id !== null) throw resourceMissing("subscription_item", item.id, `${item.param}[id]`)
      if (item.deleted || item.price === null) throw parameterMissing(`${item.param}[price]`)
      return {
        current: undefined,
        price: subscribablePrice(scope, item.price, `${item.param}[price]`),
        quantity: item.quantity ?? 1,
        deleted: false,
      }
    })
    assertCompatiblePrices(
      changes.map((change) => change.price),
      request.itemsParam,
    )
    const recurring = changes[0]?.price.recurring
    const end =
      recurring === null || recurring === undefined
        ? now
        : addInterval(now, recurring.interval, recurring.interval_count)
    pushCycle(builder, null, changes, { start: now, end })
    pushRequestedItems(builder, request.invoiceItems, now)
    return {
      builder,
      shape: {
        billingReason: "upcoming",
        subscription: null,
        customer: request.customer,
        created: now,
        period: { start: now, end: now },
        nextPaymentAttempt: null,
        inheritedDiscounts: [],
      },
    }
  }
  let subscription: SubscriptionRecord | undefined
  if (subscriptionId !== null)
    subscription = requireSubscription(scope, subscriptionId, "subscription")
  else if (request.customer !== null)
    subscription = scope.account.subscriptions
      .list({ order: "oldest" })
      .map((entry) => entry.value)
      .find(
        (record) =>
          record.customer === request.customer &&
          ["active", "trialing", "past_due"].includes(record.status),
      )
  // No subscription to preview: a one-off (`manual`) invoice of the customer's pending items.
  if (subscription === undefined) {
    if (request.customer === null && !request.customerDetails) throw parameterMissing("customer")
    const now = customerNow(scope, request.customer)
    if (request.customer !== null) pushPendingItems(builder, request.customer)
    pushRequestedItems(builder, request.invoiceItems, now)
    if (request.surface === "upcoming" && builder.lines.length === 0)
      throw noUpcoming(request.customer ?? "")
    return {
      builder,
      shape: {
        billingReason: "manual",
        subscription: null,
        customer: request.customer,
        created: now,
        period: { start: now, end: now },
        nextPaymentAttempt: null,
        inheritedDiscounts: [],
      },
    }
  }
  if (
    ["canceled", "incomplete_expired"].includes(subscription.status) ||
    subscription.cancel_at_period_end
  )
    throw noUpcoming(request.customer ?? subscription.customer)
  const now = customerNow(scope, subscription.customer)
  const at = request.prorationDate ?? now
  if (
    request.prorationDate !== undefined &&
    (at < subscription.current_period_start || at > subscription.current_period_end)
  )
    throw invalidRequest(
      `\`${request.prorationDateParam}\` must be within the subscription's current period (${subscription.current_period_start}–${subscription.current_period_end}).`,
      request.prorationDateParam,
    )
  const changes = changedItems(scope, subscription, items ?? [], request.itemsParam)
  const changing = (items ?? []).length > 0
  const behavior = request.prorationBehavior
  // A trial is free: changing plans during one prorates nothing (as the update path).
  const prorate = changing && behavior !== "none" && subscription.status !== "trialing"
  const kept = changes.filter((change) => !change.deleted)
  const previous = recurringOf(scope, subscription)
  const nextRecurring = kept[0]?.price.recurring ?? previous
  const resetsAnchor =
    changing &&
    (subscription.status === "active" || subscription.status === "past_due") &&
    !sameBillingPeriod(previous, nextRecurring)
  const frame = (
    billingReason: string,
    period: { start: number; end: number },
    created: number,
  ) => ({
    builder,
    shape: {
      billingReason,
      subscription,
      customer: subscription.customer,
      created,
      period,
      nextPaymentAttempt: created,
      inheritedDiscounts: liveDiscountIds(scope, subscription.discount_ids, created),
    },
  })
  if (resetsAnchor) {
    // A different billing period starts a new one now, invoiced at once less the unused time.
    const end = addInterval(at, nextRecurring.interval, nextRecurring.interval_count)
    if (behavior !== "none")
      pushProrations(
        builder,
        subscription,
        changes
          .filter((change) => change.current !== undefined)
          .map((change) => ({ ...change, deleted: true })),
        at,
      )
    pushPendingProrations(builder, subscription.customer, subscription.id)
    pushCycle(builder, subscription.id, changes, { start: at, end })
    pushRequestedItems(builder, request.invoiceItems, at)
    return frame("subscription_update", { start: at, end: at }, at)
  }
  if (prorate && behavior === "always_invoice") {
    pushProrations(builder, subscription, changes, at)
    // The change is invoiced immediately: the preview is that invoice.
    if (builder.lines.length > 0) {
      pushRequestedItems(builder, request.invoiceItems, at)
      return frame("subscription_update", { start: at, end: at }, at)
    }
  }
  pushPendingProrations(builder, subscription.customer, subscription.id)
  if (prorate) pushProrations(builder, subscription, changes, at)
  const start = subscription.current_period_end
  const end = addInterval(start, nextRecurring.interval, nextRecurring.interval_count)
  pushCycle(builder, subscription.id, changes, { start, end })
  pushRequestedItems(builder, request.invoiceItems, now)
  return {
    builder,
    shape: {
      billingReason: "upcoming",
      subscription,
      customer: subscription.customer,
      created: start,
      period: { start: subscription.current_period_start, end: start },
      nextPaymentAttempt: start,
      inheritedDiscounts: liveDiscountIds(scope, subscription.discount_ids, start),
    },
  }
}

/** The preview id Stripe prefixes with `upcoming_in`; derived, so nothing is drawn. */
const previewId = (shape: Shape) => {
  const owner = shape.subscription?.id ?? shape.customer
  const suffix = owner === null || owner === undefined ? "preview" : owner.replace(/^[a-z]+_/, "")
  return `upcoming_in_${suffix}`
}

/** The preview invoice, rendered for the request's API version. */
export const previewInvoice = (scope: RequestScope, request: PreviewRequest): RecordValue => {
  const { builder, shape } = compose(scope, request)
  const currency = builder.lines[0]?.currency
  const foreign = builder.lines.findIndex((line) => line.currency !== currency)
  if (foreign !== -1)
    throw invalidRequest(
      "All lines of a preview invoice must share one currency; multi-currency previews are not modelled by this emulator.",
      "invoice_items",
    )
  const { ids, extra } = resolveDiscounts(scope, request, shape.inheritedDiscounts, {
    customer: shape.customer,
    subscription: shape.subscription?.id ?? null,
  })
  const account = withDiscounts(scope.account, extra)
  const view: RequestScope = { ...scope, account }
  // Proration lines are not discountable; discounts spread over the other lines only.
  const discountable = builder.lines.filter((line) => !line.proration)
  const { perLine, totals } = discountLines(view, ids, discountable)
  const lines = builder.lines.map((line) => {
    const index = discountable.indexOf(line)
    return index === -1 ? line : { ...line, discount_amounts: perLine[index] ?? [] }
  })
  const subtotal = lines.reduce((sum, line) => sum + line.amount, 0)
  const discounted = totals.reduce((sum, entry) => sum + entry.amount, 0)
  const total = subtotal - discounted
  const customer = shape.customer === null ? undefined : findCustomer(scope, shape.customer)
  const balance = customer?.balance ?? 0
  const due = Math.max(0, total + balance)
  const subscription = shape.subscription
  const id = request.surface === "create_preview" ? previewId(shape) : ""
  const record: InvoiceRecord = {
    id,
    amount_due: due,
    amount_paid: 0,
    amount_remaining: due,
    attempt_count: 0,
    attempted: false,
    auto_advance: shape.billingReason !== "manual",
    billing_reason: shape.billingReason,
    charge: null,
    collection_method: subscription?.collection_method ?? "charge_automatically",
    created: shape.created,
    currency: lines[0]?.currency ?? subscription?.currency ?? customer?.currency ?? "usd",
    customer: shape.customer,
    customer_email: customer?.email ?? null,
    customer_name: customer?.name ?? null,
    description: null,
    discount_ids: ids,
    due_date: null,
    ending_balance: null,
    hosted_invoice_url: null,
    invoice_pdf: null,
    lines,
    metadata: {},
    next_payment_attempt: shape.nextPaymentAttempt,
    number: null,
    paid: false,
    payment_intent: null,
    period_end: shape.period.end,
    period_start: shape.period.start,
    status: "draft",
    status_transitions: {
      finalized_at: null,
      marked_uncollectible_at: null,
      paid_at: null,
      voided_at: null,
    },
    subscription: subscription?.id ?? null,
    subtotal,
    total,
    subscription_metadata: subscription?.metadata ?? null,
    days_until_due: subscription?.days_until_due ?? null,
    starting_balance: balance,
    discount_amounts: totals,
  }
  const rendered = renderInvoice(record, account)
  const renderedLines = rendered.lines as { data: RecordValue[]; url: string }
  renderedLines.data = renderedLines.data.map((line, index) =>
    lines[index]?.proration
      ? // Stripe bills prorations as (non-discountable) pending invoice items.
        { ...line, discountable: false, type: "invoiceitem" }
      : line,
  )
  if (request.surface === "upcoming") {
    renderedLines.url = "/v1/invoices/upcoming/lines"
    const { id: _id, ...withoutId } = rendered
    return withoutId
  }
  return rendered
}

/** `GET /v1/invoices/upcoming/lines`: the same preview's lines, paged by `starting_after`. */
export const previewLines = (
  scope: RequestScope,
  request: PreviewRequest,
  page: { limit: number; startingAfter: string | null; endingBefore: string | null },
): RecordValue => {
  if (page.endingBefore !== null) throw notModelled("ending_before")
  const invoice = previewInvoice(scope, request)
  const data = (invoice.lines as { data: RecordValue[] }).data
  const found =
    page.startingAfter === null ? 0 : data.findIndex((line) => line.id === page.startingAfter) + 1
  const from = Math.max(0, found)
  const window = data.slice(from, from + page.limit)
  return {
    object: "list",
    data: window,
    has_more: from + window.length < data.length,
    url: "/v1/invoices/upcoming/lines",
  }
}
