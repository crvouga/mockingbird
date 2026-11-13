import type {
  AccountState,
  BalanceTransactionRecord,
  BillingPortalConfigurationRecord,
  BillingPortalSessionRecord,
  ChargeRecord,
  CheckoutSessionLineRecord,
  CheckoutSessionRecord,
  CouponRecord,
  CustomerBalanceTransactionRecord,
  CustomerRecord,
  DiscountRecord,
  DisputeRecord,
  InvoiceItemRecord,
  InvoiceLineRecord,
  InvoiceRecord,
  PaymentIntentRecord,
  PaymentMethodRecord,
  PriceCurrencyOption,
  PriceRecord,
  ProductRecord,
  PromotionCodeRecord,
  RefundRecord,
  SetupIntentRecord,
  SubscriptionItemRecord,
  SubscriptionRecord,
  SubscriptionScheduleRecord,
  TestClockRecord,
  WebhookEndpointRecord,
  WebhookEventRecord,
} from "./state.js"

/**
 * Renderers return the superset of every supported API version's fields; `shapeForEra` trims a
 * response to the version the caller asked for.
 */
type RecordValue = Record<string, unknown>

/** Stable rendered frame shared by every resource: the fields Stripe always returns. */
const base = (id: string, object: string, created: number) => ({
  id,
  object,
  created,
  livemode: false,
})

export const unitAmountOf = (decimal: string): number | null =>
  decimal.includes(".") ? null : Number(decimal)

export const renderCustomer = (customer: CustomerRecord): RecordValue => ({
  ...base(customer.id, "customer", customer.created),
  address: customer.address,
  balance: customer.balance,
  currency: customer.currency,
  customer_account: null,
  default_source: null,
  delinquent: false,
  description: customer.description,
  discount: customer.discount ?? null,
  email: customer.email,
  invoice_prefix: customer.invoice_prefix,
  invoice_settings: {
    custom_fields: customer.invoice_settings.custom_fields,
    default_payment_method: customer.invoice_settings.default_payment_method,
    footer: customer.invoice_settings.footer,
    rendering_options: customer.invoice_settings.rendering_options,
  },
  metadata: customer.metadata,
  name: customer.name,
  next_invoice_sequence: 1,
  phone: customer.phone,
  preferred_locales: customer.preferred_locales,
  shipping: customer.shipping,
  tax_exempt: customer.tax_exempt,
  test_clock: customer.test_clock ?? null,
})

export const renderDeletedCustomer = (id: string) => ({
  id,
  object: "customer",
  deleted: true,
})

export const renderProduct = (product: ProductRecord): RecordValue => ({
  ...base(product.id, "product", product.created),
  active: product.active,
  attributes: [],
  default_price: product.default_price ?? null,
  description: product.description,
  images: product.images,
  marketing_features: product.marketing_features,
  metadata: product.metadata,
  name: product.name,
  package_dimensions: product.package_dimensions,
  shippable: product.shippable,
  statement_descriptor: product.statement_descriptor,
  tax_code: null,
  tax_details: null,
  type: "service",
  unit_label: product.unit_label,
  updated: product.updated,
  url: product.url,
})

export const renderDeletedProduct = (id: string) => ({
  id,
  object: "product",
  deleted: true,
})

export const renderPrice = (price: PriceRecord): RecordValue => ({
  ...base(price.id, "price", price.created),
  active: price.active,
  billing_scheme: "per_unit",
  currency: price.currency,
  custom_unit_amount: null,
  lookup_key: price.lookup_key,
  metadata: price.metadata,
  nickname: price.nickname,
  product: price.product,
  recurring:
    price.recurring === null
      ? null
      : {
          interval: price.recurring.interval,
          interval_count: price.recurring.interval_count,
          meter: null,
          trial_period_days: price.recurring.trial_period_days,
          usage_type: price.recurring.usage_type,
        },
  tax_behavior: price.tax_behavior,
  tiers_mode: null,
  transform_quantity: null,
  type: price.recurring === null ? "one_time" : "recurring",
  unit_amount: unitAmountOf(price.unit_amount_decimal),
  unit_amount_decimal: price.unit_amount_decimal,
})

/**
 * `currency_options` is includable: Stripe returns it only when expanded, one entry per currency
 * (the price's own included), sorted by code.
 */
export const renderPriceCurrencyOptions = (price: PriceRecord): RecordValue => {
  const entries: Record<string, PriceCurrencyOption> = {
    ...price.currency_options,
    [price.currency]: {
      tax_behavior: price.tax_behavior,
      unit_amount_decimal: price.unit_amount_decimal,
    },
  }
  return Object.fromEntries(
    Object.entries(entries)
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([code, option]) => [
        code,
        {
          custom_unit_amount: null,
          tax_behavior: option.tax_behavior,
          unit_amount: unitAmountOf(option.unit_amount_decimal),
          unit_amount_decimal: option.unit_amount_decimal,
        },
      ]),
  )
}

/** Price as an inline object, falling back to the bare id when the record is gone. */
export const priceOrId = (scope: AccountState, id: string): RecordValue | string => {
  const price = scope.prices.get(id)
  return price ? renderPrice(price) : id
}

export const renderPaymentMethod = (method: PaymentMethodRecord): RecordValue => ({
  ...base(method.id, "payment_method", method.created),
  allow_redisplay: "unspecified",
  billing_details: method.billing_details,
  card: method.card,
  customer: method.customer,
  customer_account: null,
  metadata: method.metadata,
  type: method.type,
})

export const renderPaymentIntent = (intent: PaymentIntentRecord): RecordValue => ({
  ...base(intent.id, "payment_intent", intent.created),
  amount: intent.amount,
  amount_capturable: intent.amount_capturable,
  amount_details: { tip: {} },
  amount_received: intent.amount_received,
  automatic_payment_methods: intent.automatic_payment_methods ?? null,
  cancellation_reason: intent.cancellation_reason,
  canceled_at: intent.canceled_at,
  capture_method: intent.capture_method,
  client_secret: intent.client_secret,
  confirmation_method: intent.confirmation_method,
  currency: intent.currency,
  customer: intent.customer,
  description: intent.description,
  invoice: intent.invoice,
  last_payment_error: intent.last_payment_error,
  latest_charge: intent.latest_charge,
  metadata: intent.metadata,
  next_action: intent.next_action ?? null,
  payment_method: intent.payment_method,
  payment_method_types: intent.payment_method_types,
  receipt_email: intent.receipt_email,
  setup_future_usage: intent.setup_future_usage,
  status: intent.status,
})

export const renderSetupIntent = (intent: SetupIntentRecord): RecordValue => ({
  ...base(intent.id, "setup_intent", intent.created),
  automatic_payment_methods: intent.automatic_payment_methods ?? null,
  cancellation_reason: intent.cancellation_reason,
  canceled_at: intent.canceled_at,
  client_secret: intent.client_secret,
  customer: intent.customer,
  description: intent.description,
  last_setup_error: intent.last_setup_error,
  metadata: intent.metadata,
  next_action: intent.next_action ?? null,
  payment_method: intent.payment_method,
  payment_method_types: intent.payment_method_types,
  status: intent.status,
  usage: intent.usage,
})

export const renderCharge = (charge: ChargeRecord): RecordValue => ({
  ...base(charge.id, "charge", charge.created),
  amount: charge.amount,
  amount_captured: charge.amount_captured,
  amount_refunded: charge.amount_refunded,
  balance_transaction: charge.balance_transaction ?? null,
  billing_details: { address: null, email: null, name: null, phone: null },
  captured: charge.captured,
  currency: charge.currency,
  customer: charge.customer,
  description: charge.description,
  disputed: charge.disputed,
  failure_code: charge.failure_code ?? null,
  failure_message: charge.failure_message ?? null,
  invoice: charge.invoice,
  metadata: charge.metadata,
  outcome: charge.outcome ?? null,
  paid: charge.paid,
  payment_intent: charge.payment_intent,
  payment_method: charge.payment_method,
  payment_method_details:
    charge.card === null || charge.card === undefined
      ? null
      : {
          card: {
            amount_authorized: charge.amount,
            brand: charge.card.brand,
            checks: charge.card.checks,
            country: charge.card.country,
            exp_month: charge.card.exp_month,
            exp_year: charge.card.exp_year,
            fingerprint: charge.card.fingerprint,
            funding: charge.card.funding,
            last4: charge.card.last4,
            network: charge.card.brand,
            three_d_secure: null,
            wallet: null,
          },
          type: "card",
        },
  receipt_email: charge.receipt_email ?? null,
  receipt_url: `https://pay.stripe.com/receipts/payment/${charge.id}`,
  refunded: charge.refunded,
  status: charge.status,
})

export const renderRefund = (refund: RefundRecord): RecordValue => ({
  ...base(refund.id, "refund", refund.created),
  amount: refund.amount,
  balance_transaction: refund.balance_transaction ?? null,
  charge: refund.charge,
  currency: refund.currency,
  failure_reason: refund.failure_reason ?? null,
  metadata: refund.metadata,
  payment_intent: refund.payment_intent,
  reason: refund.reason,
  receipt_number: refund.receipt_number,
  status: refund.status,
})

/** The `dispute.evidence` fields (`POST /v1/disputes/:id` `evidence[…]`), besides `enhanced_evidence`. */
export const DISPUTE_EVIDENCE_FIELDS = [
  "access_activity_log",
  "billing_address",
  "cancellation_policy",
  "cancellation_policy_disclosure",
  "cancellation_rebuttal",
  "customer_communication",
  "customer_email_address",
  "customer_name",
  "customer_purchase_ip",
  "customer_signature",
  "duplicate_charge_documentation",
  "duplicate_charge_explanation",
  "duplicate_charge_id",
  "product_description",
  "receipt",
  "refund_policy",
  "refund_policy_disclosure",
  "refund_refusal_explanation",
  "service_date",
  "service_documentation",
  "shipping_address",
  "shipping_carrier",
  "shipping_date",
  "shipping_documentation",
  "shipping_tracking_number",
  "uncategorized_file",
  "uncategorized_text",
] as const

/**
 * A dispute; `balanceTransactions` are its ledger lines already rendered (Stripe embeds them as
 * objects, never ids). Inquiries (`warning_*`) are the only disputes whose charge stays refundable.
 */
export const renderDispute = (
  dispute: DisputeRecord,
  balanceTransactions: readonly RecordValue[] = [],
): RecordValue => {
  const evidence: Record<string, unknown> = { enhanced_evidence: {} }
  for (const field of DISPUTE_EVIDENCE_FIELDS) evidence[field] = dispute.evidence?.[field] ?? null
  const details = dispute.evidence_details
  const inquiry = dispute.status.startsWith("warning_")
  return {
    ...base(dispute.id, "dispute", dispute.created),
    amount: dispute.amount,
    balance_transactions: [...balanceTransactions],
    charge: dispute.charge,
    currency: dispute.currency,
    enhanced_eligibility_types: [],
    evidence,
    evidence_details: {
      due_by: details?.due_by ?? null,
      enhanced_eligibility: {},
      has_evidence: details?.has_evidence ?? false,
      past_due: details?.past_due ?? false,
      submission_count: details?.submission_count ?? 0,
    },
    is_charge_refundable: inquiry,
    metadata: dispute.metadata,
    payment_intent: dispute.payment_intent,
    ...(dispute.card_brand === undefined || dispute.card_brand === null
      ? {}
      : {
          payment_method_details: {
            card: {
              brand: dispute.card_brand,
              case_type: inquiry ? "inquiry" : "chargeback",
              network: dispute.card_brand,
              network_reason_code: null,
            },
            type: "card",
          },
        }),
    reason: dispute.reason,
    status: dispute.status,
  }
}

export const renderCustomerBalanceTransaction = (
  transaction: CustomerBalanceTransactionRecord,
): RecordValue => ({
  ...base(transaction.id, "customer_balance_transaction", transaction.created),
  amount: transaction.amount,
  checkout_session: null,
  credit_note: transaction.credit_note,
  currency: transaction.currency,
  customer: transaction.customer,
  description: transaction.description,
  ending_balance: transaction.ending_balance,
  invoice: transaction.invoice,
  metadata: transaction.metadata,
  type: transaction.type,
})

export const renderBalanceTransaction = (
  transaction: BalanceTransactionRecord,
  now: number,
): RecordValue => ({
  id: transaction.id,
  object: "balance_transaction",
  amount: transaction.amount,
  available_on: transaction.available_on,
  balance_type: "payments",
  created: transaction.created,
  currency: transaction.currency,
  description: transaction.description,
  exchange_rate: null,
  fee: transaction.fee,
  fee_details:
    transaction.fee === 0
      ? []
      : [
          {
            amount: transaction.fee,
            application: null,
            currency: transaction.currency,
            description: transaction.fee_description ?? "Stripe processing fees",
            type: "stripe_fee",
          },
        ],
  net: transaction.net,
  reporting_category: transaction.reporting_category,
  source: transaction.source,
  status: now >= transaction.available_on ? "available" : "pending",
  type: transaction.type,
})

export const renderCoupon = (
  coupon: CouponRecord,
  options: { appliesTo?: boolean; currencyOptions?: boolean } = {},
): RecordValue => ({
  ...base(coupon.id, "coupon", coupon.created),
  amount_off: coupon.amount_off,
  // `applies_to` and `currency_options` are includable: Stripe returns them only when expanded,
  // and `applies_to` only when the coupon is restricted at all.
  ...(options.appliesTo && coupon.applies_to_products.length > 0
    ? { applies_to: { products: coupon.applies_to_products } }
    : {}),
  currency: coupon.currency,
  ...(options.currencyOptions
    ? {
        currency_options: Object.fromEntries(
          Object.entries(coupon.currency_options).map(([code, option]) => [
            code,
            { amount_off: option.amount_off },
          ]),
        ),
      }
    : {}),
  duration: coupon.duration,
  duration_in_months: coupon.duration_in_months,
  max_redemptions: coupon.max_redemptions,
  metadata: coupon.metadata,
  name: coupon.name,
  percent_off: coupon.percent_off,
  redeem_by: coupon.redeem_by,
  times_redeemed: coupon.times_redeemed,
  valid: coupon.valid,
})

export const renderDeletedCoupon = (id: string) => ({ id, object: "coupon", deleted: true })

/** A coupon id as its full object when the account still has it (a discount embeds it). */
const couponObject = (scope: AccountState, id: string): RecordValue | string => {
  const coupon = scope.coupons.get(id)
  return coupon ? renderCoupon(coupon) : id
}

export const renderDiscount = (discount: DiscountRecord, scope: AccountState): RecordValue => ({
  id: discount.id,
  object: "discount",
  checkout_session: discount.checkout_session ?? null,
  coupon: couponObject(scope, discount.coupon),
  customer: discount.customer,
  customer_account: null,
  end: discount.end,
  invoice: discount.invoice ?? null,
  invoice_item: null,
  promotion_code: discount.promotion_code,
  source: { coupon: discount.coupon, type: "coupon" },
  start: discount.start,
  subscription: discount.subscription,
  subscription_item: null,
})

const discountRecords = (scope: AccountState, ids: readonly string[]) =>
  ids
    .map((id) => scope.discounts.get(id))
    .filter((record): record is DiscountRecord => record !== undefined)

/** Stripe's single `discount` field: the discount when there is exactly one, else null. */
const singleDiscount = (scope: AccountState, ids: readonly string[]): RecordValue | null => {
  const records = discountRecords(scope, ids)
  return records.length === 1 && records[0] ? renderDiscount(records[0], scope) : null
}

export const renderPromotionCode = (
  promotion: PromotionCodeRecord,
  scope: AccountState,
): RecordValue => ({
  ...base(promotion.id, "promotion_code", promotion.created),
  active: promotion.active,
  code: promotion.code,
  coupon: couponObject(scope, promotion.coupon),
  customer: promotion.customer,
  customer_account: null,
  expires_at: promotion.expires_at,
  max_redemptions: promotion.max_redemptions,
  metadata: promotion.metadata,
  promotion: { coupon: promotion.coupon, type: "coupon" },
  restrictions: {
    first_time_transaction: promotion.restrictions.first_time_transaction,
    minimum_amount: promotion.restrictions.minimum_amount,
    minimum_amount_currency: promotion.restrictions.minimum_amount_currency,
  },
  times_redeemed: promotion.times_redeemed,
})

export const renderCheckoutLineItem = (
  line: CheckoutSessionLineRecord,
  scope: AccountState,
): RecordValue => ({
  id: line.id,
  object: "item",
  amount_discount: line.amount_discount ?? 0,
  amount_subtotal: line.amount_subtotal,
  amount_tax: 0,
  amount_total: line.amount_total,
  currency: line.currency,
  description: line.description,
  discounts: [],
  metadata: {},
  price: line.price === null ? null : priceOrId(scope, line.price),
  quantity: line.quantity,
  taxes: [],
})

export const renderCheckoutSession = (session: CheckoutSessionRecord): RecordValue => ({
  ...base(session.id, "checkout.session", session.created),
  amount_subtotal: session.amount_subtotal,
  amount_total: session.amount_total,
  allow_promotion_codes: session.allow_promotion_codes ?? null,
  cancel_url: session.cancel_url,
  client_reference_id: session.client_reference_id ?? null,
  currency: session.currency,
  custom_text: session.custom_text ?? {
    after_submit: null,
    shipping_address: null,
    submit: null,
    terms_of_service_acceptance: null,
  },
  customer: session.customer,
  customer_creation: session.customer_creation,
  customer_details:
    session.customer_details === undefined || session.customer_details === null
      ? null
      : {
          address:
            session.customer_details.address === null
              ? null
              : {
                  city: null,
                  country: session.customer_details.address.country,
                  line1: null,
                  line2: null,
                  postal_code: session.customer_details.address.postal_code,
                  state: null,
                },
          email: session.customer_details.email,
          name: session.customer_details.name,
          phone: null,
          tax_exempt: "none",
          tax_ids: [],
        },
  customer_email: session.customer_email ?? null,
  discounts: (session.discount_refs ?? []).map((ref) => ({
    coupon: ref.coupon,
    promotion_code: ref.promotion_code,
  })),
  expires_at: session.expires_at,
  invoice: session.invoice ?? null,
  metadata: session.metadata,
  mode: session.mode,
  payment_intent: session.payment_intent,
  payment_method_collection: session.payment_method_collection ?? "always",
  payment_method_types: session.payment_method_types ?? ["card"],
  payment_status: session.payment_status,
  setup_intent: session.setup_intent,
  status: session.status,
  subscription: session.subscription,
  success_url: session.success_url,
  ui_mode: session.ui_mode ?? "hosted_page",
  client_secret: session.client_secret ?? null,
  return_url: session.return_url ?? null,
  total_details: {
    amount_discount: session.amount_discount ?? 0,
    amount_shipping: 0,
    amount_tax: 0,
  },
  url: session.status === "open" && session.ui_mode !== "embedded_page" ? session.url : null,
})

const renderInvoiceLine = (
  invoice: InvoiceRecord,
  line: InvoiceLineRecord,
  scope: AccountState,
): RecordValue => {
  const price = line.price === null ? undefined : scope.prices.get(line.price)
  return {
    id: line.id,
    object: "line_item",
    amount: line.amount,
    currency: line.currency,
    description: line.description,
    discount_amounts: line.discount_amounts,
    discountable: line.discountable ?? true,
    discounts: [],
    invoice: invoice.id,
    invoice_item: line.invoice_item,
    livemode: false,
    metadata: line.metadata,
    parent:
      line.type === "subscription"
        ? {
            invoice_item_details: null,
            subscription_item_details: {
              invoice_item: null,
              proration: line.proration,
              proration_details: { credited_items: null },
              subscription: line.subscription ?? invoice.subscription,
              subscription_item: line.subscription_item ?? null,
            },
            type: "subscription_item_details",
          }
        : {
            invoice_item_details: {
              invoice_item: line.invoice_item,
              proration: line.proration,
              proration_details: { credited_items: null },
              subscription: invoice.subscription,
            },
            subscription_item_details: null,
            type: "invoice_item_details",
          },
    period: line.period,
    plan: null,
    pretax_credit_amounts: [],
    price: price ? renderPrice(price) : null,
    pricing:
      price === undefined
        ? null
        : {
            price_details: { price: price.id, product: price.product },
            type: "price_details",
            unit_amount_decimal: price.unit_amount_decimal,
          },
    proration: line.proration,
    quantity: line.quantity,
    subscription: line.subscription ?? invoice.subscription,
    subscription_item: line.subscription_item ?? null,
    subtotal: line.subtotal,
    type: line.type,
  }
}

export const renderInvoice = (invoice: InvoiceRecord, scope: AccountState): RecordValue => ({
  ...base(invoice.id, "invoice", invoice.created),
  amount_due: invoice.amount_due,
  amount_paid: invoice.amount_paid,
  amount_remaining: invoice.amount_remaining,
  attempt_count: invoice.attempt_count,
  attempted: invoice.attempted,
  auto_advance: invoice.auto_advance,
  billing_reason: invoice.billing_reason,
  charge: invoice.charge,
  collection_method: invoice.collection_method,
  currency: invoice.currency,
  customer: invoice.customer,
  customer_email: invoice.customer_email,
  customer_name: invoice.customer_name,
  days_until_due: invoice.days_until_due ?? null,
  default_payment_method: invoice.default_payment_method ?? null,
  description: invoice.description,
  discount: singleDiscount(scope, invoice.discount_ids),
  discounts: invoice.discount_ids,
  due_date: invoice.due_date,
  ending_balance: invoice.ending_balance,
  hosted_invoice_url: invoice.hosted_invoice_url,
  invoice_pdf: invoice.invoice_pdf,
  lines: {
    object: "list",
    data: invoice.lines.map((line) => renderInvoiceLine(invoice, line, scope)),
    has_more: false,
    total_count: invoice.lines.length,
    url: `/v1/invoices/${invoice.id}/lines`,
  },
  metadata: invoice.metadata,
  next_payment_attempt: invoice.next_payment_attempt,
  number: invoice.number,
  paid: invoice.paid,
  paid_out_of_band: invoice.paid_out_of_band ?? false,
  parent:
    invoice.subscription === null
      ? null
      : {
          quote_details: null,
          subscription_details: {
            metadata: invoice.subscription_metadata ?? {},
            subscription: invoice.subscription,
          },
          type: "subscription_details",
        },
  payment_intent: invoice.payment_intent,
  period_end: invoice.period_end,
  period_start: invoice.period_start,
  starting_balance: invoice.starting_balance ?? 0,
  status: invoice.status,
  status_transitions: invoice.status_transitions,
  subscription: invoice.subscription,
  subscription_details:
    invoice.subscription === null ? null : { metadata: invoice.subscription_metadata ?? {} },
  subtotal: invoice.subtotal,
  total: invoice.total,
  total_discount_amounts: (invoice.discount_amounts ?? []).map((entry) => ({
    amount: entry.amount,
    discount: entry.discount,
  })),
  total_pretax_credit_amounts: [],
})

export const renderDeletedInvoice = (id: string) => ({ id, object: "invoice", deleted: true })

export const renderInvoiceItem = (item: InvoiceItemRecord): RecordValue => ({
  ...base(item.id, "invoiceitem", item.created),
  amount: item.amount,
  currency: item.currency,
  customer: item.customer,
  date: item.date,
  description: item.description,
  discountable: item.discountable,
  invoice: item.invoice,
  metadata: item.metadata,
  period: item.period,
  proration: item.proration,
  quantity: item.quantity,
  unit_amount: item.unit_amount,
})

export const renderDeletedInvoiceItem = (id: string) => ({
  id,
  object: "invoiceitem",
  deleted: true,
})

export const renderSubscriptionItem = (
  item: SubscriptionItemRecord,
  scope: AccountState,
): RecordValue => {
  const subscription = scope.subscriptions.get(item.subscription)
  return {
    ...base(item.id, "subscription_item", item.created),
    current_period_end: subscription?.current_period_end ?? 0,
    current_period_start: subscription?.current_period_start ?? 0,
    discounts: item.discount_ids ?? [],
    metadata: item.metadata,
    price: priceOrId(scope, item.price),
    quantity: item.quantity,
    subscription: item.subscription,
  }
}

export const renderSubscription = (
  subscription: SubscriptionRecord,
  scope: AccountState,
): RecordValue => ({
  ...base(subscription.id, "subscription", subscription.created),
  billing_cycle_anchor: subscription.billing_cycle_anchor ?? subscription.start_date,
  cancel_at: subscription.cancel_at,
  cancel_at_period_end: subscription.cancel_at_period_end,
  canceled_at: subscription.canceled_at,
  cancellation_details: subscription.cancellation_details ?? {
    comment: null,
    feedback: null,
    reason: null,
  },
  collection_method: subscription.collection_method,
  currency: subscription.currency,
  current_period_end: subscription.current_period_end,
  current_period_start: subscription.current_period_start,
  customer: subscription.customer,
  days_until_due: subscription.days_until_due,
  default_payment_method: subscription.default_payment_method,
  description: subscription.description ?? null,
  discount: singleDiscount(scope, subscription.discount_ids),
  discounts: subscription.discount_ids,
  ended_at: subscription.ended_at,
  items: {
    object: "list",
    data: subscription.item_ids
      .map((id) => scope.subscriptionItems.get(id))
      .filter((record): record is SubscriptionItemRecord => record !== undefined)
      .map((record) => renderSubscriptionItem(record, scope)),
    has_more: false,
    total_count: subscription.item_ids.length,
    url: `/v1/subscription_items?subscription=${subscription.id}`,
  },
  latest_invoice: subscription.latest_invoice,
  metadata: subscription.metadata,
  pause_collection: subscription.pause_collection,
  payment_settings: subscription.payment_settings ?? {
    payment_method_options: null,
    payment_method_types: null,
    save_default_payment_method: "off",
  },
  schedule: subscription.schedule,
  start_date: subscription.start_date,
  status: subscription.status,
  test_clock: customerTestClock(scope, subscription.customer),
  trial_end: subscription.trial_end,
  trial_settings: subscription.trial_settings ?? {
    end_behavior: { missing_payment_method: "create_invoice" },
  },
  trial_start: subscription.trial_start,
})

const customerTestClock = (scope: AccountState, customer: string): string | null => {
  const entry = scope.customers.get(customer)
  return entry?.kind === "live" ? (entry.customer.test_clock ?? null) : null
}

export const renderDeletedSubscriptionItem = (id: string) => ({
  id,
  object: "subscription_item",
  deleted: true,
})

export const renderSubscriptionSchedule = (schedule: SubscriptionScheduleRecord): RecordValue => {
  const nowPhase = schedule.phases.find((phase) => phase.current === true)
  return {
    ...base(schedule.id, "subscription_schedule", schedule.created),
    canceled_at: schedule.canceled_at ?? null,
    completed_at: schedule.completed_at ?? null,
    current_phase:
      nowPhase === undefined
        ? null
        : { end_date: nowPhase.end_date ?? null, start_date: nowPhase.start_date ?? null },
    customer: schedule.customer,
    end_behavior: schedule.end_behavior,
    metadata: schedule.metadata,
    phases: schedule.phases.map(({ current: _current, ...phase }) => phase),
    released_at: schedule.released_at,
    released_subscription: schedule.released_subscription,
    status: schedule.status,
    subscription: schedule.subscription,
    test_clock: null,
  }
}

export const renderTestClock = (clock: TestClockRecord): RecordValue => ({
  ...base(clock.id, "test_helpers.test_clock", clock.created),
  deletes_after: clock.deletes_after,
  frozen_time: clock.frozen_time,
  name: clock.name,
  status: clock.status,
  status_details: {},
})

export const renderWebhookEndpoint = (
  endpoint: WebhookEndpointRecord,
  withSecret: boolean,
): RecordValue => ({
  ...base(endpoint.id, "webhook_endpoint", endpoint.created),
  api_version: endpoint.api_version,
  application: null,
  description: endpoint.description,
  enabled_events: endpoint.enabled_events,
  metadata: endpoint.metadata,
  ...(withSecret ? { secret: endpoint.secret } : {}),
  status: endpoint.status,
  url: endpoint.url,
})

/** Events are stored as their exact wire JSON, so rendering is a parse of those bytes. */
export const renderEvent = (event: WebhookEventRecord): RecordValue =>
  JSON.parse(event.body) as RecordValue

export type PortalProduct = {
  product: string
  prices: string[]
  adjustable_quantity: { enabled: boolean; maximum: number | null; minimum: number }
}

/**
 * The products (and prices) a configuration lets customers switch between. `products: null` (the
 * mock's dashboard-saved default) means every active product with active licensed recurring prices.
 */
export const portalProducts = (
  scope: AccountState,
  config: BillingPortalConfigurationRecord,
): PortalProduct[] => {
  const configured = config.features.subscription_update.products
  if (configured !== null) return configured
  const byProduct = new Map<string, string[]>()
  for (const { value: price } of scope.prices.list({ order: "oldest" })) {
    if (!price.active || price.recurring === null || price.recurring.usage_type !== "licensed")
      continue
    if (scope.products.get(price.product)?.active !== true) continue
    byProduct.set(price.product, [...(byProduct.get(price.product) ?? []), price.id])
  }
  return [...byProduct.entries()].slice(0, 10).map(([product, prices]) => ({
    product,
    prices,
    adjustable_quantity: { enabled: true, maximum: 99, minimum: 1 },
  }))
}

export const renderPortalConfiguration = (
  configuration: BillingPortalConfigurationRecord,
  scope: AccountState,
): RecordValue => ({
  ...base(configuration.id, "billing_portal.configuration", configuration.created),
  active: configuration.active,
  application: null,
  business_profile: configuration.business_profile,
  default_return_url: configuration.default_return_url,
  features: {
    ...configuration.features,
    subscription_update: {
      ...configuration.features.subscription_update,
      products: portalProducts(scope, configuration),
    },
  },
  is_default: configuration.is_default,
  login_page: configuration.login_page,
  metadata: configuration.metadata,
  name: configuration.name,
  updated: configuration.updated,
})

export const renderPortalSession = (session: BillingPortalSessionRecord): RecordValue => ({
  ...base(session.id, "billing_portal.session", session.created),
  configuration: session.configuration,
  customer: session.customer,
  customer_account: null,
  flow:
    session.flow === null
      ? null
      : {
          after_completion: session.flow.after_completion,
          customer_update: null,
          subscription_cancel: session.flow.subscription_cancel,
          subscription_update: session.flow.subscription_update,
          subscription_update_confirm: session.flow.subscription_update_confirm,
          type: session.flow.type,
        },
  locale: session.locale,
  on_behalf_of: null,
  return_url: session.return_url,
  url: session.url,
})
