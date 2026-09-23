import { jsonResponse, type OperationContext } from "@crvouga/mockingbird-service"
import { takeInvoiceNumber } from "./customers.js"
import { invalidRequest, parameterMissing, resourceMissing } from "./errors.js"
import { recordEvent } from "./events.js"
import { expandObject } from "./expand.js"
import { mergeMetadata, optionalBoolean, unitAmountOf } from "./fields.js"
import { embeddedList, matchesCreated, paginate } from "./list.js"
import { bodyParams, type Params, queryParams } from "./params.js"
import { confirmPaymentIntent, renderPaymentMethod } from "./payments.js"
import { normalizeCurrency, renderPrice } from "./prices.js"
import { matchesSearch, parseSearch, searchPage } from "./search.js"
import {
  type CouponRecord,
  type InvoiceLineRecord,
  type InvoiceRecord,
  type PaymentIntentRecord,
  type PriceRecord,
  type PromotionCodeRecord,
  type StripeState,
  type SubscriptionItemRecord,
  type SubscriptionRecord,
  seconds,
  type TaxRateRecord,
} from "./state.js"

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const requireCustomer = async (state: StripeState, id: string, param: string) => {
  const entry = await state.customers.get(id)
  if (!entry || entry.kind !== "live") throw resourceMissing("customer", id, param, 400)
  return entry.customer
}

const priceAmount = (price: PriceRecord) => {
  const whole = unitAmountOf(price.unit_amount_decimal)
  return whole ?? Math.round(Number(price.unit_amount_decimal))
}

export const addInterval = (unix: number, interval: string, count: number) => {
  const date = new Date(unix * 1000)
  if (interval === "year") date.setUTCFullYear(date.getUTCFullYear() + count)
  else if (interval === "month") date.setUTCMonth(date.getUTCMonth() + count)
  else if (interval === "week") date.setUTCDate(date.getUTCDate() + 7 * count)
  else date.setUTCDate(date.getUTCDate() + count)
  return Math.floor(date.getTime() / 1000)
}

const issuer = () => ({ type: "self" })

const renderLine = (line: InvoiceLineRecord, invoiceId: string) => ({
  id: line.id,
  object: "line_item",
  amount: line.amount,
  currency: line.currency,
  description: line.description,
  discountable: true,
  discounts: [],
  invoice: invoiceId,
  livemode: false,
  metadata: {},
  parent: null,
  period: line.period,
  quantity: line.quantity,
  subscription: null,
  subtotal: line.amount,
})

const invoiceTotals = (invoice: InvoiceRecord) => {
  const subtotal = invoice.lines.reduce((sum, line) => sum + line.amount, 0)
  const paid = invoice.status === "paid"
  return {
    subtotal,
    total: subtotal,
    amount_due: paid ? 0 : Math.max(0, subtotal - invoice.amount_paid),
    amount_paid: invoice.amount_paid,
    amount_remaining: paid ? 0 : Math.max(0, subtotal - invoice.amount_paid),
  }
}

export const renderInvoice = (invoice: InvoiceRecord) => {
  const totals = invoiceTotals(invoice)
  return {
    id: invoice.id,
    object: "invoice",
    amount_due: totals.amount_due,
    amount_overpaid: 0,
    amount_paid: totals.amount_paid,
    amount_paid_off_stripe: 0,
    amount_remaining: totals.amount_remaining,
    amount_shipping: 0,
    attempt_count: invoice.attempt_count,
    attempted: invoice.attempt_count > 0,
    auto_advance: invoice.auto_advance,
    automatic_tax: { enabled: false },
    billing_reason: invoice.billing_reason,
    collection_method: invoice.collection_method,
    created: invoice.created,
    currency: invoice.currency,
    customer: invoice.customer,
    default_payment_method: invoice.default_payment_method,
    description: invoice.description,
    discounts: [],
    due_date: invoice.due_date,
    ending_balance: invoice.ending_balance,
    hosted_invoice_url:
      invoice.status === "draft" ? null : `https://invoice.stripe.com/i/${invoice.id}`,
    issuer: issuer(),
    lines: embeddedList(
      `/v1/invoices/${invoice.id}/lines`,
      invoice.lines.map((line) => renderLine(line, invoice.id)),
    ),
    livemode: false,
    metadata: invoice.metadata,
    number: invoice.number,
    payment_intent: invoice.payment_intent,
    payment_settings: {},
    period_end: invoice.period_end,
    period_start: invoice.period_start,
    post_payment_credit_notes_amount: 0,
    pre_payment_credit_notes_amount: 0,
    starting_balance: invoice.starting_balance,
    status: invoice.status,
    status_transitions: {
      ...(invoice.finalized_at === null ? {} : { finalized_at: invoice.finalized_at }),
      ...(invoice.paid_at === null ? {} : { paid_at: invoice.paid_at }),
      ...(invoice.voided_at === null ? {} : { voided_at: invoice.voided_at }),
    },
    subtotal: totals.subtotal,
    total: totals.total,
  }
}

const renderItem = async (state: StripeState, item: SubscriptionItemRecord) => {
  const price = await state.prices.get(item.price)
  return {
    id: item.id,
    object: "subscription_item",
    created: item.created,
    current_period_end: item.current_period_end,
    current_period_start: item.current_period_start,
    discounts: [],
    metadata: item.metadata,
    price: price ? renderPrice(price) : item.price,
    quantity: item.quantity,
    subscription: item.subscription,
  }
}

export const renderSubscription = async (state: StripeState, subscription: SubscriptionRecord) => {
  const items = []
  for (const id of subscription.items) {
    const item = await state.subscriptionItems.get(id)
    if (item) items.push(await renderItem(state, item))
  }
  return {
    id: subscription.id,
    object: "subscription",
    automatic_tax: { enabled: false },
    billing_cycle_anchor: subscription.current_period_start,
    billing_mode: { type: "classic" },
    billing_schedules: [],
    cancel_at: subscription.cancel_at,
    cancel_at_period_end: subscription.cancel_at_period_end,
    canceled_at: subscription.canceled_at,
    collection_method: subscription.collection_method,
    created: subscription.created,
    currency: subscription.currency,
    customer: subscription.customer,
    default_payment_method: subscription.default_payment_method,
    description: subscription.description,
    discounts: [],
    ended_at: subscription.ended_at,
    invoice_settings: { issuer: issuer() },
    items: embeddedList(`/v1/subscription_items?subscription=${subscription.id}`, items),
    latest_invoice: subscription.latest_invoice,
    livemode: false,
    metadata: subscription.metadata,
    start_date: subscription.start_date,
    status: subscription.status,
    trial_end: subscription.trial_end,
    trial_start: subscription.trial_start,
  }
}

const renderCoupon = (coupon: CouponRecord) => ({
  id: coupon.id,
  object: "coupon",
  amount_off: coupon.amount_off,
  created: coupon.created,
  currency: coupon.currency,
  duration: coupon.duration,
  duration_in_months: coupon.duration_in_months,
  livemode: false,
  max_redemptions: coupon.max_redemptions,
  metadata: coupon.metadata,
  name: coupon.name,
  percent_off: coupon.percent_off,
  redeem_by: coupon.redeem_by,
  times_redeemed: coupon.times_redeemed,
  valid: coupon.valid,
})

const renderPromotion = (code: PromotionCodeRecord) => ({
  id: code.id,
  object: "promotion_code",
  active: code.active,
  code: code.code,
  created: code.created,
  customer: code.customer,
  expires_at: code.expires_at,
  livemode: false,
  max_redemptions: code.max_redemptions,
  metadata: code.metadata,
  promotion: { type: "coupon", coupon: code.coupon },
  restrictions: { first_time_transaction: false },
  times_redeemed: code.times_redeemed,
})

const renderTax = (rate: TaxRateRecord) => ({
  id: rate.id,
  object: "tax_rate",
  active: rate.active,
  country: rate.country,
  created: rate.created,
  description: rate.description,
  display_name: rate.display_name,
  effective_percentage: rate.percentage,
  inclusive: rate.inclusive,
  jurisdiction: rate.jurisdiction,
  livemode: false,
  metadata: rate.metadata,
  percentage: rate.percentage,
})

const blankInvoice = (
  id: string,
  now: number,
  input: {
    customer: string
    currency: string
    collection: InvoiceRecord["collection_method"]
    reason: string
    subscription: string | null
    lines: InvoiceLineRecord[]
    period: { start: number; end: number }
    preview?: boolean
  },
): InvoiceRecord => ({
  id,
  amount_paid: 0,
  attempt_count: 0,
  auto_advance: true,
  billing_reason: input.reason,
  collection_method: input.collection,
  created: now,
  currency: input.currency,
  customer: input.customer,
  default_payment_method: null,
  description: null,
  due_date: null,
  ending_balance: 0,
  finalized_at: null,
  lines: input.lines,
  metadata: {},
  number: null,
  paid_at: null,
  payment_intent: null,
  period_end: input.period.end,
  period_start: input.period.start,
  preview: input.preview === true,
  starting_balance: 0,
  status: "draft",
  subscription: input.subscription,
  voided_at: null,
})

const loadInvoice = async (state: StripeState, id: string) => {
  const invoice = await state.invoices.get(id)
  if (!invoice) throw resourceMissing("invoice", id, "invoice")
  return invoice
}

const loadSubscription = async (state: StripeState, id: string, param = "subscription") => {
  const subscription = await state.subscriptions.get(id)
  if (!subscription) throw resourceMissing("subscription", id, param)
  return subscription
}

export const finalizeInvoice = async (state: StripeState, invoice: InvoiceRecord, now: number) => {
  if (invoice.status !== "draft")
    throw invalidRequest("This invoice is already finalized.", "invoice")
  invoice.status = "open"
  invoice.finalized_at = now
  invoice.number = (await takeInvoiceNumber(state, invoice.customer)) ?? null
  const total = invoiceTotals(invoice).total
  if (total <= 0) {
    invoice.status = "paid"
    invoice.paid_at = now
    invoice.amount_paid = 0
  } else if (invoice.collection_method === "charge_automatically") {
    const id = await state.ids.next("pi_")
    const intent: PaymentIntentRecord = {
      id,
      amount: total,
      amount_capturable: 0,
      amount_received: 0,
      automatic_payment_methods: true,
      canceled_at: null,
      cancellation_reason: null,
      capture_method: "automatic_async",
      client_secret: `${id}_secret_${id.slice(3, 12)}`,
      confirmation_method: "automatic",
      created: now,
      currency: invoice.currency,
      customer: invoice.customer,
      description: invoice.description,
      last_payment_error: null,
      latest_charge: null,
      metadata: { invoice: invoice.id },
      next_action: null,
      payment_method: invoice.default_payment_method,
      payment_method_types: ["card"],
      receipt_email: null,
      setup_future_usage: null,
      shipping: null,
      statement_descriptor: null,
      statement_descriptor_suffix: null,
      status: invoice.default_payment_method ? "requires_confirmation" : "requires_payment_method",
    }
    await state.paymentIntents.insert(id, intent)
    invoice.payment_intent = id
    invoice.attempt_count += 1
  }
  await state.invoices.update(invoice.id, invoice)
  await recordEvent(state, "invoice.finalized", renderInvoice(invoice), now)
  return invoice
}

export const payInvoice = async (
  state: StripeState,
  invoice: InvoiceRecord,
  now: number,
  paymentMethod: string | undefined,
) => {
  if (invoice.status === "draft") await finalizeInvoice(state, invoice, now)
  if (invoice.status === "paid") return invoice
  if (invoice.status !== "open")
    throw invalidRequest(
      `This invoice cannot be paid because it has a status of ${invoice.status}.`,
    )
  const total = invoiceTotals(invoice).total
  if (total <= 0) {
    invoice.status = "paid"
    invoice.paid_at = now
    await state.invoices.update(invoice.id, invoice)
    return invoice
  }
  if (!invoice.payment_intent) await finalizeInvoice(state, invoice, now)
  const intent = invoice.payment_intent
    ? await state.paymentIntents.get(invoice.payment_intent)
    : undefined
  if (!intent)
    throw invalidRequest("This invoice does not have a payment intent to pay.", "invoice")
  const method = paymentMethod ?? invoice.default_payment_method ?? undefined
  if (method) {
    await confirmPaymentIntent(state, now, intent, { payment_method: method }, false)
    const fresh = await state.paymentIntents.get(intent.id)
    if (fresh?.status === "succeeded") {
      invoice.status = "paid"
      invoice.paid_at = now
      invoice.amount_paid = total
      await state.invoices.update(invoice.id, invoice)
      await recordEvent(state, "invoice.paid", renderInvoice(invoice), now)
    }
  }
  return invoice
}

const itemInputs = (params: Params) => {
  const items = params.items
  if (!Array.isArray(items) || items.length === 0)
    throw invalidRequest("You must provide at least one subscription item.", "items")
  return items.map((item, index) => {
    const record = asRecord(item)
    const price = record && typeof record.price === "string" ? record.price : undefined
    if (!price) throw parameterMissing(`items[${index}][price]`)
    const quantity = record && typeof record.quantity === "number" ? record.quantity : 1
    return { price, quantity }
  })
}

export const createSubscription = async (state: StripeState, now: number, params: Params) => {
  if (typeof params.customer !== "string" || params.customer === "")
    throw parameterMissing("customer")
  const customer = await requireCustomer(state, params.customer, "customer")
  const inputs = itemInputs(params)
  const prices: PriceRecord[] = []
  for (const input of inputs) {
    const price = await state.prices.get(input.price)
    if (!price) throw resourceMissing("price", input.price, "items", 400)
    if (!price.recurring)
      throw invalidRequest(
        "The price specified is set to `type=one_time` but subscriptions only accept recurring prices.",
        "items",
      )
    prices.push(price)
  }
  const first = prices[0]
  if (!first) throw parameterMissing("items")
  const recurring = first.recurring ?? {
    interval: "month" as const,
    interval_count: 1,
    usage_type: "licensed" as const,
  }
  const periodEnd = addInterval(now, recurring.interval, recurring.interval_count)
  const trialDays = typeof params.trial_period_days === "number" ? params.trial_period_days : 0
  const trialing = trialDays > 0
  const collection =
    params.collection_method === "send_invoice" ? "send_invoice" : "charge_automatically"
  const defaultMethod =
    typeof params.default_payment_method === "string" && params.default_payment_method !== ""
      ? params.default_payment_method
      : customer.invoice_settings.default_payment_method
  const id = await state.ids.next("sub_")
  const itemIds: string[] = []
  const lines: InvoiceLineRecord[] = []
  for (let index = 0; index < inputs.length; index += 1) {
    const input = inputs[index]
    const price = prices[index]
    if (!input || !price) continue
    const itemId = await state.ids.next("si_")
    const item: SubscriptionItemRecord = {
      id: itemId,
      created: now,
      current_period_end: trialing ? now + trialDays * 86400 : periodEnd,
      current_period_start: now,
      metadata: {},
      price: price.id,
      quantity: input.quantity,
      subscription: id,
    }
    await state.subscriptionItems.insert(itemId, item)
    itemIds.push(itemId)
    const lineId = await state.ids.next("il_")
    lines.push({
      id: lineId,
      amount: trialing ? 0 : priceAmount(price) * input.quantity,
      currency: price.currency,
      description: null,
      period: { start: now, end: item.current_period_end },
      price: price.id,
      quantity: input.quantity,
    })
  }
  const invoiceId = await state.ids.next("in_")
  const invoice = blankInvoice(invoiceId, now, {
    customer: customer.id,
    currency: first.currency,
    collection,
    reason: "subscription_create",
    subscription: id,
    lines,
    period: { start: now, end: trialing ? now + trialDays * 86400 : periodEnd },
  })
  invoice.default_payment_method = defaultMethod
  await state.invoices.insert(invoiceId, invoice)
  await finalizeInvoice(state, invoice, now)
  if (!trialing && collection === "charge_automatically" && defaultMethod)
    await payInvoice(state, invoice, now, defaultMethod)
  const paid = invoice.status === "paid" || trialing
  const subscription: SubscriptionRecord = {
    id,
    cancel_at: null,
    cancel_at_period_end: params.cancel_at_period_end === true,
    canceled_at: null,
    collection_method: collection,
    created: now,
    currency: first.currency,
    current_period_end: trialing ? now + trialDays * 86400 : periodEnd,
    current_period_start: now,
    customer: customer.id,
    days_until_due: collection === "send_invoice" ? 30 : null,
    default_payment_method: defaultMethod,
    description: typeof params.description === "string" ? params.description : null,
    ended_at: null,
    items: itemIds,
    latest_invoice: invoiceId,
    metadata: mergeMetadata({}, params.metadata),
    start_date: now,
    status: trialing ? "trialing" : paid || collection === "send_invoice" ? "active" : "incomplete",
    trial_end: trialing ? now + trialDays * 86400 : null,
    trial_start: trialing ? now : null,
  }
  if (params.payment_behavior === "error_if_incomplete" && subscription.status === "incomplete")
    throw invalidRequest(
      "The subscription did not have a successful payment and payment_behavior is error_if_incomplete.",
    )
  await state.subscriptions.insert(id, subscription)
  await recordEvent(
    state,
    "customer.subscription.created",
    await renderSubscription(state, subscription),
    now,
  )
  return subscription
}

const renderInvoiceItem = (item: {
  id: string
  amount: number
  currency: string
  customer: string
  date: number
  description: string | null
  invoice: string | null
  metadata: Record<string, string>
  period: { start: number; end: number }
  quantity: number
}) => ({
  id: item.id,
  object: "invoiceitem",
  amount: item.amount,
  currency: item.currency,
  customer: item.customer,
  date: item.date,
  description: item.description,
  discountable: true,
  invoice: item.invoice,
  livemode: false,
  metadata: item.metadata,
  period: item.period,
  proration: false,
  quantity: item.quantity,
  quantity_decimal: String(item.quantity),
})

export const billingHandlers = (state: StripeState) => ({
  GetCustomersCustomerPaymentMethods: async (context: OperationContext) => {
    const params = queryParams(context)
    const customer = context.params.customer ?? ""
    await requireCustomer(state, customer, "customer")
    const page = await paginate(state.paymentMethods, params, {
      url: `/v1/customers/${customer}/payment_methods`,
      kind: "payment_method",
      where: (method) =>
        method.customer === customer &&
        (params.type === undefined || params.type === "" || method.type === params.type),
      render: renderPaymentMethod,
    })
    return jsonResponse(200, page)
  },

  GetCustomersCustomerBalanceTransactions: async (context: OperationContext) => {
    const params = queryParams(context)
    const customer = context.params.customer ?? ""
    await requireCustomer(state, customer, "customer")
    const page = await paginate(state.customerBalanceTransactions, params, {
      url: `/v1/customers/${customer}/balance_transactions`,
      kind: "customer_balance_transaction",
      where: (txn) => txn.customer === customer,
      render: (txn) => ({
        id: txn.id,
        object: "customer_balance_transaction",
        amount: txn.amount,
        created: txn.created,
        currency: txn.currency,
        customer: txn.customer,
        description: txn.description,
        ending_balance: txn.ending_balance,
        livemode: false,
        metadata: txn.metadata,
        type: txn.type,
      }),
    })
    return jsonResponse(200, page)
  },

  PostCustomersCustomerBalanceTransactions: async (context: OperationContext) => {
    const params = bodyParams(context)
    const now = seconds(context.now)
    const customer = await requireCustomer(state, context.params.customer ?? "", "customer")
    if (typeof params.amount !== "number") throw parameterMissing("amount")
    if (typeof params.currency !== "string") throw parameterMissing("currency")
    const currency = normalizeCurrency(params.currency)
    customer.balance += params.amount
    customer.currency = currency
    const entry = await state.customers.get(customer.id)
    if (entry?.kind === "live") {
      entry.customer = customer
      await state.customers.update(customer.id, entry)
    }
    const id = await state.ids.next("cbtxn_")
    const txn = {
      id,
      amount: params.amount,
      created: now,
      currency,
      customer: customer.id,
      description: typeof params.description === "string" ? params.description : null,
      ending_balance: customer.balance,
      metadata: mergeMetadata({}, params.metadata),
      type: "adjustment",
    }
    await state.customerBalanceTransactions.insert(id, txn)
    return jsonResponse(200, {
      ...txn,
      object: "customer_balance_transaction",
      livemode: false,
    })
  },

  GetCustomersCustomerBalanceTransactionsTransaction: async (context: OperationContext) => {
    const txn = await state.customerBalanceTransactions.get(context.params.transaction ?? "")
    if (!txn || txn.customer !== context.params.customer)
      throw resourceMissing(
        "customer_balance_transaction",
        context.params.transaction ?? "",
        "transaction",
      )
    return jsonResponse(200, { ...txn, object: "customer_balance_transaction", livemode: false })
  },

  PostCoupons: async (context: OperationContext) => {
    const params = bodyParams(context)
    const now = seconds(context.now)
    const duration = params.duration
    if (duration !== "forever" && duration !== "once" && duration !== "repeating")
      throw parameterMissing("duration")
    if (params.percent_off === undefined && params.amount_off === undefined)
      throw invalidRequest("Must provide percent_off or amount_off.")
    if (params.amount_off !== undefined && typeof params.currency !== "string")
      throw parameterMissing("currency")
    const requested = typeof params.id === "string" && params.id !== "" ? params.id : undefined
    if (requested && (await state.coupons.get(requested)))
      throw invalidRequest(`Coupon already exists: ${requested}`, "id")
    const generated = requested ?? (await state.ids.next("coupon_")).slice("coupon_".length)
    const coupon: CouponRecord = {
      id: generated,
      amount_off: typeof params.amount_off === "number" ? params.amount_off : null,
      created: now,
      currency: typeof params.currency === "string" ? normalizeCurrency(params.currency) : null,
      duration,
      duration_in_months:
        typeof params.duration_in_months === "number" ? params.duration_in_months : null,
      max_redemptions: typeof params.max_redemptions === "number" ? params.max_redemptions : null,
      metadata: mergeMetadata({}, params.metadata),
      name: typeof params.name === "string" ? params.name : null,
      percent_off: typeof params.percent_off === "number" ? params.percent_off : null,
      redeem_by: typeof params.redeem_by === "number" ? params.redeem_by : null,
      times_redeemed: 0,
      valid: true,
    }
    await state.coupons.insert(coupon.id, coupon)
    await recordEvent(state, "coupon.created", renderCoupon(coupon), now)
    return jsonResponse(200, renderCoupon(coupon))
  },

  GetCoupons: async (context: OperationContext) => {
    const params = queryParams(context)
    const page = await paginate(state.coupons, params, {
      url: "/v1/coupons",
      kind: "coupon",
      where: (coupon) => matchesCreated(coupon.created, params.created),
      render: renderCoupon,
    })
    return jsonResponse(200, page)
  },

  GetCouponsCoupon: async (context: OperationContext) => {
    const coupon = await state.coupons.get(context.params.coupon ?? "")
    if (!coupon) throw resourceMissing("coupon", context.params.coupon ?? "", "coupon")
    return jsonResponse(200, renderCoupon(coupon))
  },

  PostCouponsCoupon: async (context: OperationContext) => {
    const params = bodyParams(context)
    const coupon = await state.coupons.get(context.params.coupon ?? "")
    if (!coupon) throw resourceMissing("coupon", context.params.coupon ?? "", "coupon")
    coupon.metadata = mergeMetadata(coupon.metadata, params.metadata)
    if (typeof params.name === "string") coupon.name = params.name === "" ? null : params.name
    await state.coupons.update(coupon.id, coupon)
    return jsonResponse(200, renderCoupon(coupon))
  },

  DeleteCouponsCoupon: async (context: OperationContext) => {
    const id = context.params.coupon ?? ""
    const coupon = await state.coupons.get(id)
    if (!coupon) throw resourceMissing("coupon", id, "coupon")
    await state.coupons.delete(id)
    await recordEvent(
      state,
      "coupon.deleted",
      { id, object: "coupon", deleted: true },
      seconds(context.now),
    )
    return jsonResponse(200, { id, object: "coupon", deleted: true })
  },

  PostPromotionCodes: async (context: OperationContext) => {
    const params = bodyParams(context)
    const now = seconds(context.now)
    const promotion = asRecord(params.promotion)
    const couponId =
      typeof params.coupon === "string"
        ? params.coupon
        : promotion && typeof promotion.coupon === "string"
          ? promotion.coupon
          : undefined
    if (!couponId) throw parameterMissing("promotion[coupon]")
    if (!(await state.coupons.get(couponId)))
      throw resourceMissing("coupon", couponId, "coupon", 400)
    const id = await state.ids.next("promo_")
    const code =
      typeof params.code === "string" && params.code !== ""
        ? params.code
        : id.slice("promo_".length).toUpperCase()
    const record: PromotionCodeRecord = {
      id,
      active: params.active !== false,
      code,
      coupon: couponId,
      created: now,
      customer: typeof params.customer === "string" ? params.customer : null,
      expires_at: typeof params.expires_at === "number" ? params.expires_at : null,
      max_redemptions: typeof params.max_redemptions === "number" ? params.max_redemptions : null,
      metadata: mergeMetadata({}, params.metadata),
      times_redeemed: 0,
    }
    await state.promotionCodes.insert(id, record)
    return jsonResponse(200, renderPromotion(record))
  },

  GetPromotionCodes: async (context: OperationContext) => {
    const params = queryParams(context)
    const page = await paginate(state.promotionCodes, params, {
      url: "/v1/promotion_codes",
      kind: "promotion_code",
      where: (code) =>
        (params.active === undefined || code.active === params.active) &&
        (typeof params.code !== "string" || params.code === "" || code.code === params.code) &&
        (typeof params.coupon !== "string" ||
          params.coupon === "" ||
          code.coupon === params.coupon),
      render: renderPromotion,
    })
    return jsonResponse(200, page)
  },

  GetPromotionCodesPromotionCode: async (context: OperationContext) => {
    const code = await state.promotionCodes.get(context.params.promotion_code ?? "")
    if (!code)
      throw resourceMissing("promotion_code", context.params.promotion_code ?? "", "promotion_code")
    return jsonResponse(200, renderPromotion(code))
  },

  PostPromotionCodesPromotionCode: async (context: OperationContext) => {
    const params = bodyParams(context)
    const code = await state.promotionCodes.get(context.params.promotion_code ?? "")
    if (!code)
      throw resourceMissing("promotion_code", context.params.promotion_code ?? "", "promotion_code")
    code.active = optionalBoolean(params, "active", code.active) ?? code.active
    code.metadata = mergeMetadata(code.metadata, params.metadata)
    await state.promotionCodes.update(code.id, code)
    return jsonResponse(200, renderPromotion(code))
  },

  PostTaxRates: async (context: OperationContext) => {
    const params = bodyParams(context)
    const now = seconds(context.now)
    if (typeof params.display_name !== "string") throw parameterMissing("display_name")
    if (typeof params.percentage !== "number") throw parameterMissing("percentage")
    if (typeof params.inclusive !== "boolean") throw parameterMissing("inclusive")
    const id = await state.ids.next("txr_")
    const rate: TaxRateRecord = {
      id,
      active: params.active !== false,
      country: typeof params.country === "string" ? params.country : null,
      created: now,
      description: typeof params.description === "string" ? params.description : null,
      display_name: params.display_name,
      inclusive: params.inclusive,
      jurisdiction: typeof params.jurisdiction === "string" ? params.jurisdiction : null,
      metadata: mergeMetadata({}, params.metadata),
      percentage: params.percentage,
    }
    await state.taxRates.insert(id, rate)
    return jsonResponse(200, renderTax(rate))
  },

  GetTaxRates: async (context: OperationContext) => {
    const params = queryParams(context)
    const page = await paginate(state.taxRates, params, {
      url: "/v1/tax_rates",
      kind: "tax_rate",
      where: (rate) => params.active === undefined || rate.active === params.active,
      render: renderTax,
    })
    return jsonResponse(200, page)
  },

  GetTaxRatesTaxRate: async (context: OperationContext) => {
    const rate = await state.taxRates.get(context.params.tax_rate ?? "")
    if (!rate) throw resourceMissing("tax_rate", context.params.tax_rate ?? "", "tax_rate")
    return jsonResponse(200, renderTax(rate))
  },

  PostTaxRatesTaxRate: async (context: OperationContext) => {
    const params = bodyParams(context)
    const rate = await state.taxRates.get(context.params.tax_rate ?? "")
    if (!rate) throw resourceMissing("tax_rate", context.params.tax_rate ?? "", "tax_rate")
    rate.active = optionalBoolean(params, "active", rate.active) ?? rate.active
    if (typeof params.description === "string") rate.description = params.description || null
    if (typeof params.display_name === "string" && params.display_name !== "")
      rate.display_name = params.display_name
    rate.metadata = mergeMetadata(rate.metadata, params.metadata)
    await state.taxRates.update(rate.id, rate)
    return jsonResponse(200, renderTax(rate))
  },

  PostSubscriptions: async (context: OperationContext) => {
    const params = bodyParams(context)
    const subscription = await createSubscription(state, seconds(context.now), params)
    return jsonResponse(
      200,
      await expandObject(state, params.expand, await renderSubscription(state, subscription)),
    )
  },

  GetSubscriptions: async (context: OperationContext) => {
    const params = queryParams(context)
    const page = await paginate(state.subscriptions, params, {
      url: "/v1/subscriptions",
      kind: "subscription",
      where: (subscription) =>
        (params.status === undefined ||
          params.status === "" ||
          subscription.status === params.status) &&
        (typeof params.customer !== "string" ||
          params.customer === "" ||
          subscription.customer === params.customer),
      render: (subscription) => renderSubscription(state, subscription),
    })
    return jsonResponse(200, page)
  },

  GetSubscriptionsSubscriptionExposedId: async (context: OperationContext) => {
    const params = queryParams(context)
    const subscription = await loadSubscription(
      state,
      context.params.subscription_exposed_id ?? "",
      "subscription_exposed_id",
    )
    return jsonResponse(
      200,
      await expandObject(state, params.expand, await renderSubscription(state, subscription)),
    )
  },

  PostSubscriptionsSubscriptionExposedId: async (context: OperationContext) => {
    const params = bodyParams(context)
    const now = seconds(context.now)
    const subscription = await loadSubscription(state, context.params.subscription_exposed_id ?? "")
    subscription.metadata = mergeMetadata(subscription.metadata, params.metadata)
    if (typeof params.cancel_at_period_end === "boolean")
      subscription.cancel_at_period_end = params.cancel_at_period_end
    if (typeof params.description === "string")
      subscription.description = params.description || null
    if (typeof params.default_payment_method === "string")
      subscription.default_payment_method =
        params.default_payment_method === "" ? null : params.default_payment_method
    await state.subscriptions.update(subscription.id, subscription)
    await recordEvent(
      state,
      "customer.subscription.updated",
      await renderSubscription(state, subscription),
      now,
    )
    return jsonResponse(200, await renderSubscription(state, subscription))
  },

  DeleteSubscriptionsSubscriptionExposedId: async (context: OperationContext) => {
    const now = seconds(context.now)
    const subscription = await loadSubscription(state, context.params.subscription_exposed_id ?? "")
    subscription.status = "canceled"
    subscription.canceled_at = now
    subscription.ended_at = now
    subscription.cancel_at_period_end = false
    await state.subscriptions.update(subscription.id, subscription)
    await recordEvent(
      state,
      "customer.subscription.deleted",
      await renderSubscription(state, subscription),
      now,
    )
    return jsonResponse(200, await renderSubscription(state, subscription))
  },

  GetSubscriptionsSearch: async (context: OperationContext) => {
    const params = queryParams(context)
    const clauses = parseSearch(String(params.query ?? ""))
    const rows = await state.subscriptions.list({
      where: (subscription) =>
        matchesSearch(
          clauses,
          (field) => {
            if (field === "status") return subscription.status
            if (field === "customer") return subscription.customer
            return undefined
          },
          subscription.metadata,
        ),
    })
    const data = await Promise.all(rows.map((row) => renderSubscription(state, row.value)))
    return jsonResponse(200, searchPage("/v1/subscriptions/search", data))
  },

  PostSubscriptionsSubscriptionResume: async (context: OperationContext) => {
    const now = seconds(context.now)
    const subscription = await loadSubscription(state, context.params.subscription ?? "")
    subscription.cancel_at_period_end = false
    subscription.cancel_at = null
    if (subscription.status === "paused" || subscription.status === "canceled") {
      subscription.status = "active"
      subscription.ended_at = null
      subscription.canceled_at = null
    }
    await state.subscriptions.update(subscription.id, subscription)
    await recordEvent(
      state,
      "customer.subscription.updated",
      await renderSubscription(state, subscription),
      now,
    )
    return jsonResponse(200, await renderSubscription(state, subscription))
  },

  PostSubscriptionItems: async (context: OperationContext) => {
    const params = bodyParams(context)
    const now = seconds(context.now)
    if (typeof params.subscription !== "string") throw parameterMissing("subscription")
    if (typeof params.price !== "string") throw parameterMissing("price")
    const subscription = await loadSubscription(state, params.subscription)
    const price = await state.prices.get(params.price)
    if (!price) throw resourceMissing("price", params.price, "price", 400)
    const id = await state.ids.next("si_")
    const item: SubscriptionItemRecord = {
      id,
      created: now,
      current_period_end: subscription.current_period_end,
      current_period_start: subscription.current_period_start,
      metadata: mergeMetadata({}, params.metadata),
      price: price.id,
      quantity: typeof params.quantity === "number" ? params.quantity : 1,
      subscription: subscription.id,
    }
    await state.subscriptionItems.insert(id, item)
    subscription.items.push(id)
    await state.subscriptions.update(subscription.id, subscription)
    return jsonResponse(200, await renderItem(state, item))
  },

  GetSubscriptionItems: async (context: OperationContext) => {
    const params = queryParams(context)
    if (typeof params.subscription !== "string" || params.subscription === "")
      throw parameterMissing("subscription")
    const page = await paginate(state.subscriptionItems, params, {
      url: "/v1/subscription_items",
      kind: "subscription_item",
      where: (item) => item.subscription === params.subscription,
      render: (item) => renderItem(state, item),
    })
    return jsonResponse(200, page)
  },

  GetSubscriptionItemsItem: async (context: OperationContext) => {
    const item = await state.subscriptionItems.get(context.params.item ?? "")
    if (!item) throw resourceMissing("subscription_item", context.params.item ?? "", "item")
    return jsonResponse(200, await renderItem(state, item))
  },

  PostSubscriptionItemsItem: async (context: OperationContext) => {
    const params = bodyParams(context)
    const item = await state.subscriptionItems.get(context.params.item ?? "")
    if (!item) throw resourceMissing("subscription_item", context.params.item ?? "", "item")
    if (typeof params.price === "string" && params.price !== "") {
      if (!(await state.prices.get(params.price)))
        throw resourceMissing("price", params.price, "price", 400)
      item.price = params.price
    }
    if (typeof params.quantity === "number") item.quantity = params.quantity
    item.metadata = mergeMetadata(item.metadata, params.metadata)
    await state.subscriptionItems.update(item.id, item)
    return jsonResponse(200, await renderItem(state, item))
  },

  DeleteSubscriptionItemsItem: async (context: OperationContext) => {
    const id = context.params.item ?? ""
    const item = await state.subscriptionItems.get(id)
    if (!item) throw resourceMissing("subscription_item", id, "item")
    const subscription = await state.subscriptions.get(item.subscription)
    if (subscription) {
      subscription.items = subscription.items.filter((itemId) => itemId !== id)
      await state.subscriptions.update(subscription.id, subscription)
    }
    await state.subscriptionItems.delete(id)
    return jsonResponse(200, { id, object: "subscription_item", deleted: true })
  },

  PostInvoices: async (context: OperationContext) => {
    const params = bodyParams(context)
    const now = seconds(context.now)
    if (typeof params.customer !== "string" || params.customer === "")
      throw parameterMissing("customer")
    const customer = await requireCustomer(state, params.customer, "customer")
    const currency =
      typeof params.currency === "string"
        ? normalizeCurrency(params.currency)
        : (customer.currency ?? "usd")
    const id = await state.ids.next("in_")
    const pending = await state.invoiceItems.list({
      where: (item) => item.customer === customer.id && item.invoice === null,
    })
    const lines: InvoiceLineRecord[] = []
    for (const entry of pending) {
      const lineId = await state.ids.next("il_")
      lines.push({
        id: lineId,
        amount: entry.value.amount,
        currency: entry.value.currency,
        description: entry.value.description,
        period: entry.value.period,
        price: entry.value.price,
        quantity: entry.value.quantity,
      })
      entry.value.invoice = id
      await state.invoiceItems.update(entry.id, entry.value)
    }
    const invoice = blankInvoice(id, now, {
      customer: customer.id,
      currency,
      collection:
        params.collection_method === "send_invoice" ? "send_invoice" : "charge_automatically",
      reason: "manual",
      subscription: typeof params.subscription === "string" ? params.subscription : null,
      lines,
      period: { start: now, end: now },
    })
    invoice.metadata = mergeMetadata({}, params.metadata)
    invoice.description = typeof params.description === "string" ? params.description : null
    invoice.auto_advance = params.auto_advance !== false
    if (typeof params.default_payment_method === "string")
      invoice.default_payment_method = params.default_payment_method
    await state.invoices.insert(id, invoice)
    await recordEvent(state, "invoice.created", renderInvoice(invoice), now)
    return jsonResponse(200, await expandObject(state, params.expand, renderInvoice(invoice)))
  },

  GetInvoices: async (context: OperationContext) => {
    const params = queryParams(context)
    const page = await paginate(state.invoices, params, {
      url: "/v1/invoices",
      kind: "invoice",
      where: (invoice) =>
        !invoice.preview &&
        matchesCreated(invoice.created, params.created) &&
        (typeof params.customer !== "string" ||
          params.customer === "" ||
          invoice.customer === params.customer) &&
        (typeof params.subscription !== "string" ||
          params.subscription === "" ||
          invoice.subscription === params.subscription) &&
        (params.status === undefined || params.status === "" || invoice.status === params.status),
      render: renderInvoice,
    })
    return jsonResponse(200, page)
  },

  GetInvoicesInvoice: async (context: OperationContext) => {
    const params = queryParams(context)
    const invoice = await loadInvoice(state, context.params.invoice ?? "")
    return jsonResponse(200, await expandObject(state, params.expand, renderInvoice(invoice)))
  },

  PostInvoicesInvoice: async (context: OperationContext) => {
    const params = bodyParams(context)
    const invoice = await loadInvoice(state, context.params.invoice ?? "")
    if (invoice.status !== "draft")
      throw invalidRequest("Non-draft invoices can't be updated this way.", "invoice")
    invoice.metadata = mergeMetadata(invoice.metadata, params.metadata)
    if (typeof params.description === "string") invoice.description = params.description || null
    if (typeof params.auto_advance === "boolean") invoice.auto_advance = params.auto_advance
    await state.invoices.update(invoice.id, invoice)
    return jsonResponse(200, renderInvoice(invoice))
  },

  DeleteInvoicesInvoice: async (context: OperationContext) => {
    const invoice = await loadInvoice(state, context.params.invoice ?? "")
    if (invoice.status !== "draft")
      throw invalidRequest("You can only delete draft invoices.", "invoice")
    await state.invoices.delete(invoice.id)
    return jsonResponse(200, { id: invoice.id, object: "invoice", deleted: true })
  },

  PostInvoicesInvoiceFinalize: async (context: OperationContext) => {
    const invoice = await loadInvoice(state, context.params.invoice ?? "")
    await finalizeInvoice(state, invoice, seconds(context.now))
    return jsonResponse(200, renderInvoice(invoice))
  },

  PostInvoicesInvoicePay: async (context: OperationContext) => {
    const params = bodyParams(context)
    const invoice = await loadInvoice(state, context.params.invoice ?? "")
    await payInvoice(
      state,
      invoice,
      seconds(context.now),
      typeof params.payment_method === "string" ? params.payment_method : undefined,
    )
    return jsonResponse(200, renderInvoice(invoice))
  },

  PostInvoicesInvoiceVoid: async (context: OperationContext) => {
    const now = seconds(context.now)
    const invoice = await loadInvoice(state, context.params.invoice ?? "")
    if (invoice.status !== "open")
      throw invalidRequest("You can only void open invoices.", "invoice")
    invoice.status = "void"
    invoice.voided_at = now
    if (invoice.payment_intent) {
      const intent = await state.paymentIntents.get(invoice.payment_intent)
      if (intent && intent.status !== "succeeded" && intent.status !== "canceled") {
        intent.status = "canceled"
        intent.canceled_at = now
        intent.cancellation_reason = "void_invoice"
        await state.paymentIntents.update(intent.id, intent)
      }
    }
    await state.invoices.update(invoice.id, invoice)
    await recordEvent(state, "invoice.voided", renderInvoice(invoice), now)
    return jsonResponse(200, renderInvoice(invoice))
  },

  PostInvoicesInvoiceSend: async (context: OperationContext) => {
    const invoice = await loadInvoice(state, context.params.invoice ?? "")
    if (invoice.status === "draft") await finalizeInvoice(state, invoice, seconds(context.now))
    return jsonResponse(200, renderInvoice(invoice))
  },

  GetInvoicesInvoiceLines: async (context: OperationContext) => {
    const invoice = await loadInvoice(state, context.params.invoice ?? "")
    return jsonResponse(200, renderInvoice(invoice).lines)
  },

  GetInvoicesSearch: async (context: OperationContext) => {
    const params = queryParams(context)
    const clauses = parseSearch(String(params.query ?? ""))
    const rows = await state.invoices.list({
      where: (invoice) =>
        !invoice.preview &&
        matchesSearch(
          clauses,
          (field) => {
            if (field === "status") return invoice.status
            if (field === "customer") return invoice.customer
            if (field === "subscription") return invoice.subscription
            if (field === "number") return invoice.number
            return undefined
          },
          invoice.metadata,
        ),
    })
    return jsonResponse(
      200,
      searchPage(
        "/v1/invoices/search",
        rows.map((row) => renderInvoice(row.value)),
      ),
    )
  },

  PostInvoicesCreatePreview: async (context: OperationContext) => {
    const params = bodyParams(context)
    const now = seconds(context.now)
    if (typeof params.customer !== "string" || params.customer === "")
      throw parameterMissing("customer")
    await requireCustomer(state, params.customer, "customer")
    const currency =
      typeof params.currency === "string" ? normalizeCurrency(params.currency) : "usd"
    const id = await state.ids.next("in_")
    const invoice = blankInvoice(id, now, {
      customer: params.customer,
      currency,
      collection: "charge_automatically",
      reason: "manual",
      subscription: typeof params.subscription === "string" ? params.subscription : null,
      lines: [],
      period: { start: now, end: now },
      preview: true,
    })
    await state.invoices.insert(id, invoice)
    return jsonResponse(200, renderInvoice(invoice))
  },

  PostInvoiceitems: async (context: OperationContext) => {
    const params = bodyParams(context)
    const now = seconds(context.now)
    if (typeof params.customer !== "string") throw parameterMissing("customer")
    await requireCustomer(state, params.customer, "customer")
    const currency =
      typeof params.currency === "string" ? normalizeCurrency(params.currency) : undefined
    let amount = typeof params.amount === "number" ? params.amount : undefined
    let priceId: string | null = null
    if (typeof params.price === "string" && params.price !== "") {
      const price = await state.prices.get(params.price)
      if (!price) throw resourceMissing("price", params.price, "price", 400)
      priceId = price.id
      amount = priceAmount(price) * (typeof params.quantity === "number" ? params.quantity : 1)
    }
    if (amount === undefined) throw parameterMissing("amount")
    if (!currency && !priceId) throw parameterMissing("currency")
    const resolvedCurrency =
      currency ?? (priceId ? (await state.prices.get(priceId))?.currency : undefined) ?? "usd"
    const id = await state.ids.next("ii_")
    const item = {
      id,
      amount,
      currency: resolvedCurrency,
      customer: params.customer,
      date: now,
      description: typeof params.description === "string" ? params.description : null,
      invoice: typeof params.invoice === "string" ? params.invoice : null,
      metadata: mergeMetadata({}, params.metadata),
      period: { start: now, end: now },
      price: priceId,
      quantity: typeof params.quantity === "number" ? params.quantity : 1,
    }
    await state.invoiceItems.insert(id, item)
    if (item.invoice) {
      const invoice = await state.invoices.get(item.invoice)
      if (invoice && invoice.status === "draft") {
        invoice.lines.push({
          id: await state.ids.next("il_"),
          amount: item.amount,
          currency: item.currency,
          description: item.description,
          period: item.period,
          price: item.price,
          quantity: item.quantity,
        })
        await state.invoices.update(invoice.id, invoice)
      }
    }
    return jsonResponse(200, renderInvoiceItem(item))
  },

  GetInvoiceitems: async (context: OperationContext) => {
    const params = queryParams(context)
    const page = await paginate(state.invoiceItems, params, {
      url: "/v1/invoiceitems",
      kind: "invoiceitem",
      where: (item) =>
        (typeof params.customer !== "string" ||
          params.customer === "" ||
          item.customer === params.customer) &&
        (params.pending === undefined ||
          (params.pending === true ? item.invoice === null : item.invoice !== null)),
      render: renderInvoiceItem,
    })
    return jsonResponse(200, page)
  },

  GetInvoiceitemsInvoiceitem: async (context: OperationContext) => {
    const item = await state.invoiceItems.get(context.params.invoiceitem ?? "")
    if (!item) throw resourceMissing("invoiceitem", context.params.invoiceitem ?? "", "invoiceitem")
    return jsonResponse(200, renderInvoiceItem(item))
  },

  PostInvoiceitemsInvoiceitem: async (context: OperationContext) => {
    const params = bodyParams(context)
    const item = await state.invoiceItems.get(context.params.invoiceitem ?? "")
    if (!item) throw resourceMissing("invoiceitem", context.params.invoiceitem ?? "", "invoiceitem")
    if (typeof params.amount === "number") item.amount = params.amount
    if (typeof params.description === "string") item.description = params.description || null
    item.metadata = mergeMetadata(item.metadata, params.metadata)
    await state.invoiceItems.update(item.id, item)
    return jsonResponse(200, renderInvoiceItem(item))
  },

  DeleteInvoiceitemsInvoiceitem: async (context: OperationContext) => {
    const id = context.params.invoiceitem ?? ""
    const item = await state.invoiceItems.get(id)
    if (!item) throw resourceMissing("invoiceitem", id, "invoiceitem")
    await state.invoiceItems.delete(id)
    return jsonResponse(200, { id, object: "invoiceitem", deleted: true })
  },

  GetCustomersSearch: async (context: OperationContext) => {
    const params = queryParams(context)
    const clauses = parseSearch(String(params.query ?? ""))
    const { renderCustomer } = await import("./customers.js")
    const rows = await state.customers.list({
      where: (entry) =>
        entry.kind === "live" &&
        matchesSearch(
          clauses,
          (field) => {
            if (entry.kind !== "live") return undefined
            if (field === "email") return entry.customer.email
            if (field === "name") return entry.customer.name
            if (field === "phone") return entry.customer.phone
            return undefined
          },
          entry.kind === "live" ? entry.customer.metadata : {},
        ),
    })
    return jsonResponse(
      200,
      searchPage(
        "/v1/customers/search",
        rows.flatMap((row) =>
          row.value.kind === "live" ? [renderCustomer(row.value.customer)] : [],
        ),
      ),
    )
  },

  GetProductsSearch: async (context: OperationContext) => {
    const params = queryParams(context)
    const clauses = parseSearch(String(params.query ?? ""))
    const { renderProduct } = await import("./products.js")
    const rows = await state.products.list({
      where: (product) =>
        matchesSearch(
          clauses,
          (field) => {
            if (field === "name") return product.name
            if (field === "active") return String(product.active)
            if (field === "url") return product.url
            return undefined
          },
          product.metadata,
        ),
    })
    return jsonResponse(
      200,
      searchPage(
        "/v1/products/search",
        rows.map((row) => renderProduct(row.value)),
      ),
    )
  },

  GetPricesSearch: async (context: OperationContext) => {
    const params = queryParams(context)
    const clauses = parseSearch(String(params.query ?? ""))
    const rows = await state.prices.list({
      where: (price) =>
        matchesSearch(
          clauses,
          (field) => {
            if (field === "product") return price.product
            if (field === "currency") return price.currency
            if (field === "active") return String(price.active)
            if (field === "lookup_key") return price.lookup_key
            if (field === "type") return price.recurring ? "recurring" : "one_time"
            return undefined
          },
          price.metadata,
        ),
    })
    return jsonResponse(
      200,
      searchPage(
        "/v1/prices/search",
        rows.map((row) => renderPrice(row.value)),
      ),
    )
  },
})
