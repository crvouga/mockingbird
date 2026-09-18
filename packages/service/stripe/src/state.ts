import type { OperationContext } from "@crvouga/mockingbird-service"
import { Collection, IdSequence } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { accountOf } from "./account.js"

export type Metadata = Record<string, string>

export type Address = {
  city: string | null
  country: string | null
  line1: string | null
  line2: string | null
  postal_code: string | null
  state: string | null
}

export type CustomField = { name: string; value: string }

export type CustomerRecord = {
  id: string
  address: Address | null
  balance: number
  created: number
  currency: string | null
  description: string | null
  email: string | null
  invoice_prefix: string
  invoice_settings: {
    custom_fields: CustomField[] | null
    default_payment_method: string | null
    footer: string | null
    rendering_options: Record<string, unknown> | null
  }
  metadata: Metadata
  name: string | null
  phone: string | null
  preferred_locales: string[]
  shipping: { address: Address; name: string; phone: string | null } | null
  tax_exempt: "none" | "exempt" | "reverse"
}

/** Deleted customers stay retrievable as tombstones. */
export type CustomerEntry =
  | { kind: "live"; customer: CustomerRecord }
  | { kind: "deleted"; id: string }

export type PackageDimensions = { height: number; length: number; weight: number; width: number }

export type ProductRecord = {
  id: string
  active: boolean
  created: number
  description: string | null
  images: string[]
  marketing_features: Array<{ name: string }>
  metadata: Metadata
  name: string
  package_dimensions: PackageDimensions | null
  shippable: boolean | null
  statement_descriptor: string | null
  unit_label: string | null
  updated: number
  url: string | null
}

export type Recurring = {
  interval: "day" | "week" | "month" | "year"
  interval_count: number
  usage_type: "licensed" | "metered"
}

export type PriceRecord = {
  id: string
  active: boolean
  created: number
  currency: string
  lookup_key: string | null
  metadata: Metadata
  nickname: string | null
  product: string
  recurring: Recurring | null
  tax_behavior: "exclusive" | "inclusive" | "unspecified"
  /** Canonical decimal string in cents (no trailing zeros), e.g. "100" or "100.5". */
  unit_amount_decimal: string
}

export type PaymentMethodRecord = {
  id: string
  type: string
  created: number
  customer: string | null
  billing_details: Record<string, unknown>
  card: Record<string, unknown> | null
  metadata: Metadata
  /** Present while the object is a card the mock can charge from a test token. */
  token: string | null
}

export type PaymentIntentStatus =
  | "requires_payment_method"
  | "requires_confirmation"
  | "requires_action"
  | "processing"
  | "requires_capture"
  | "canceled"
  | "succeeded"

export type PaymentIntentRecord = {
  id: string
  amount: number
  amount_capturable: number
  amount_received: number
  capture_method: "automatic" | "automatic_async" | "manual"
  client_secret: string
  confirmation_method: "automatic" | "manual"
  created: number
  currency: string
  customer: string | null
  description: string | null
  invoice: string | null
  last_payment_error: Record<string, unknown> | null
  latest_charge: string | null
  metadata: Metadata
  payment_method: string | null
  payment_method_types: string[]
  receipt_email: string | null
  setup_future_usage: string | null
  status: PaymentIntentStatus
  canceled_at: number | null
  cancellation_reason: string | null
  charge_ids: string[]
}

export type SetupIntentStatus =
  | "requires_payment_method"
  | "requires_confirmation"
  | "requires_action"
  | "processing"
  | "canceled"
  | "succeeded"

export type SetupIntentRecord = {
  id: string
  created: number
  customer: string | null
  description: string | null
  metadata: Metadata
  payment_method: string | null
  payment_method_types: string[]
  status: SetupIntentStatus
  usage: string
  client_secret: string
  last_setup_error: Record<string, unknown> | null
  cancellation_reason: string | null
  canceled_at: number | null
}

export type ChargeRecord = {
  id: string
  amount: number
  amount_captured: number
  amount_refunded: number
  captured: boolean
  created: number
  currency: string
  customer: string | null
  description: string | null
  disputed: boolean
  invoice: string | null
  metadata: Metadata
  paid: boolean
  payment_intent: string | null
  payment_method: string | null
  refunded: boolean
  status: "succeeded" | "pending" | "failed"
  refund_ids: string[]
}

export type RefundStatus = "pending" | "requires_action" | "succeeded" | "failed" | "canceled"

export type RefundRecord = {
  id: string
  amount: number
  charge: string | null
  created: number
  currency: string
  metadata: Metadata
  payment_intent: string | null
  reason: string | null
  receipt_number: string | null
  status: RefundStatus
}

export type DisputeRecord = {
  id: string
  amount: number
  charge: string
  created: number
  currency: string
  metadata: Metadata
  payment_intent: string | null
  reason: string
  status: string
}

export type CustomerBalanceTransactionRecord = {
  id: string
  amount: number
  created: number
  credit_note: string | null
  currency: string
  customer: string
  description: string | null
  ending_balance: number
  invoice: string | null
  metadata: Metadata
  type: string
}

export type DiscountRecord = {
  id: string
  coupon: string
  promotion_code: string | null
  customer: string | null
  subscription: string | null
  start: number
  end: number | null
}

export type InvoiceLineRecord = {
  id: string
  amount: number
  currency: string
  description: string | null
  discount_amounts: Array<Record<string, unknown>>
  invoice_item: string | null
  metadata: Metadata
  period: { start: number; end: number }
  price: string | null
  quantity: number | null
  proration: boolean
  subtotal: number
  type: "invoiceitem" | "subscription"
}

export type InvoiceStatus = "draft" | "open" | "paid" | "uncollectible" | "void"

export type InvoiceRecord = {
  id: string
  amount_due: number
  amount_paid: number
  amount_remaining: number
  attempt_count: number
  attempted: boolean
  auto_advance: boolean
  billing_reason: string | null
  charge: string | null
  collection_method: "charge_automatically" | "send_invoice"
  created: number
  currency: string
  customer: string | null
  customer_email: string | null
  customer_name: string | null
  description: string | null
  discount_ids: string[]
  due_date: number | null
  ending_balance: number | null
  invoice_pdf: string | null
  hosted_invoice_url: string | null
  metadata: Metadata
  next_payment_attempt: number | null
  number: string | null
  paid: boolean
  payment_intent: string | null
  period_end: number
  period_start: number
  status: InvoiceStatus
  status_transitions: {
    finalized_at: number | null
    marked_uncollectible_at: number | null
    paid_at: number | null
    voided_at: number | null
  }
  subscription: string | null
  subtotal: number
  total: number
  lines: InvoiceLineRecord[]
}

export type InvoiceItemRecord = {
  id: string
  amount: number
  created: number
  currency: string
  customer: string | null
  date: number
  description: string | null
  discountable: boolean
  invoice: string | null
  metadata: Metadata
  period: { start: number; end: number }
  price: string | null
  proration: boolean
  quantity: number
  unit_amount: number | null
}

export type SubscriptionItemRecord = {
  id: string
  created: number
  metadata: Metadata
  price: string
  quantity: number | null
  subscription: string
}

export type SubscriptionStatus =
  | "incomplete"
  | "incomplete_expired"
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "paused"

export type SubscriptionRecord = {
  id: string
  cancel_at: number | null
  cancel_at_period_end: boolean
  canceled_at: number | null
  collection_method: "charge_automatically" | "send_invoice"
  created: number
  currency: string
  customer: string
  days_until_due: number | null
  default_payment_method: string | null
  discount_ids: string[]
  ended_at: number | null
  item_ids: string[]
  latest_invoice: string | null
  metadata: Metadata
  pause_collection: Record<string, unknown> | null
  schedule: string | null
  start_date: number
  status: SubscriptionStatus
  trial_end: number | null
  trial_start: number | null
  current_period_start: number
  current_period_end: number
}

export type SubscriptionScheduleStatus =
  | "not_started"
  | "active"
  | "completed"
  | "released"
  | "canceled"

export type SubscriptionScheduleRecord = {
  id: string
  created: number
  customer: string
  end_behavior: string
  metadata: Metadata
  phases: Array<Record<string, unknown>>
  released_at: number | null
  released_subscription: string | null
  status: SubscriptionScheduleStatus
  subscription: string | null
}
export type CouponRecord = {
  id: string
  amount_off: number | null
  applies_to_products: string[]
  created: number
  currency: string | null
  currency_options: Record<string, { amount_off: number }>
  duration: "forever" | "once" | "repeating"
  duration_in_months: number | null
  livemode: false
  max_redemptions: number | null
  metadata: Metadata
  name: string | null
  percent_off: number | null
  redeem_by: number | null
  times_redeemed: number
  valid: boolean
}

export type PromotionCodeRecord = {
  id: string
  active: boolean
  code: string
  coupon: string
  created: number
  customer: string | null
  expires_at: number | null
  max_redemptions: number | null
  metadata: Metadata
  restrictions: {
    first_time_transaction: boolean
    minimum_amount: number | null
    minimum_amount_currency: string | null
  }
  times_redeemed: number
}

export type WebhookEventRecord = {
  id: string
  type: string
  created: number
  /** Partition token of the account whose key produced the event; never rendered. */
  account: string
  body: string
  data: { object: Record<string, unknown>; previous_attributes?: Record<string, unknown> }
}

export type WebhookDeliveryAttemptRecord = {
  message_id: string
  account: string
  attempt: number
  scheduled_at: string
  timeout_ms: number
  acknowledged: boolean
}

export type CheckoutSessionLineRecord = {
  id: string
  amount_subtotal: number
  amount_total: number
  currency: string
  description: string | null
  price: string | null
  quantity: number | null
  unit_amount: number | null
}

export type CheckoutSessionStatus = "open" | "complete" | "expired"

export type CheckoutSessionRecord = {
  id: string
  amount_subtotal: number
  amount_total: number
  cancel_url: string | null
  created: number
  currency: string
  customer: string | null
  customer_creation: string | null
  expires_at: number
  line_items: CheckoutSessionLineRecord[]
  livemode: false
  metadata: Metadata
  mode: "payment" | "setup" | "subscription"
  payment_intent: string | null
  payment_status: "paid" | "unpaid" | "no_payment_required"
  setup_intent: string | null
  status: CheckoutSessionStatus
  subscription: string | null
  success_url: string | null
  url: string
}

/** Every record type the Stripe mock stores, addressed per account. */
export class AccountState {
  readonly account: string
  readonly customers: Collection<CustomerEntry>
  readonly products: Collection<ProductRecord>
  readonly prices: Collection<PriceRecord>
  readonly paymentMethods: Collection<PaymentMethodRecord>
  readonly paymentIntents: Collection<PaymentIntentRecord>
  readonly setupIntents: Collection<SetupIntentRecord>
  readonly charges: Collection<ChargeRecord>
  readonly refunds: Collection<RefundRecord>
  readonly disputes: Collection<DisputeRecord>
  readonly balanceTransactions: Collection<CustomerBalanceTransactionRecord>
  readonly coupons: Collection<CouponRecord>
  readonly promotionCodes: Collection<PromotionCodeRecord>
  readonly discounts: Collection<DiscountRecord>
  readonly checkoutSessions: Collection<CheckoutSessionRecord>
  readonly invoices: Collection<InvoiceRecord>
  readonly invoiceItems: Collection<InvoiceItemRecord>
  readonly subscriptions: Collection<SubscriptionRecord>
  readonly subscriptionItems: Collection<SubscriptionItemRecord>
  readonly subscriptionSchedules: Collection<SubscriptionScheduleRecord>
  readonly events: Collection<WebhookEventRecord>
  readonly webhookDeliveryAttempts: Collection<WebhookDeliveryAttemptRecord>
  /** Every collection by name, so state can be copied between partitions generically. */
  readonly collections: Record<string, Collection<unknown>>

  constructor(sqlite: SqliteClient, namespace: string, account: string) {
    this.account = account
    const collection = <T>(base: string) =>
      new Collection<T>(sqlite, namespace, `${base}@${account}`)
    this.customers = collection<CustomerEntry>("customers")
    this.products = collection<ProductRecord>("products")
    this.prices = collection<PriceRecord>("prices")
    this.paymentMethods = collection<PaymentMethodRecord>("payment_methods")
    this.paymentIntents = collection<PaymentIntentRecord>("payment_intents")
    this.setupIntents = collection<SetupIntentRecord>("setup_intents")
    this.charges = collection<ChargeRecord>("charges")
    this.refunds = collection<RefundRecord>("refunds")
    this.disputes = collection<DisputeRecord>("disputes")
    this.balanceTransactions = collection<CustomerBalanceTransactionRecord>("balance_transactions")
    this.coupons = collection<CouponRecord>("coupons")
    this.promotionCodes = collection<PromotionCodeRecord>("promotion_codes")
    this.discounts = collection<DiscountRecord>("discounts")
    this.checkoutSessions = collection<CheckoutSessionRecord>("checkout_sessions")
    this.invoices = collection<InvoiceRecord>("invoices")
    this.invoiceItems = collection<InvoiceItemRecord>("invoice_items")
    this.subscriptions = collection<SubscriptionRecord>("subscriptions")
    this.subscriptionItems = collection<SubscriptionItemRecord>("subscription_items")
    this.subscriptionSchedules = collection<SubscriptionScheduleRecord>("subscription_schedules")
    this.events = collection<WebhookEventRecord>("events")
    this.webhookDeliveryAttempts = collection<WebhookDeliveryAttemptRecord>(
      "webhook_delivery_attempts",
    )
    this.collections = {
      balance_transactions: this.balanceTransactions,
      charges: this.charges,
      checkout_sessions: this.checkoutSessions,
      coupons: this.coupons,
      customers: this.customers,
      discounts: this.discounts,
      disputes: this.disputes,
      events: this.events,
      invoice_items: this.invoiceItems,
      invoices: this.invoices,
      payment_intents: this.paymentIntents,
      payment_methods: this.paymentMethods,
      prices: this.prices,
      products: this.products,
      promotion_codes: this.promotionCodes,
      refunds: this.refunds,
      setup_intents: this.setupIntents,
      subscription_items: this.subscriptionItems,
      subscription_schedules: this.subscriptionSchedules,
      subscriptions: this.subscriptions,
      webhook_delivery_attempts: this.webhookDeliveryAttempts,
    }
  }

  /**
   * Copy every record of another partition into this one.
   *
   * Used to seed an instance before a lockstep walk: a side that was warmed without this instance
   * (the oracle in a mock↔mock run) hands over the state its walk produced, without replaying
   * requests.
   */
  importFrom(source: AccountState): void {
    for (const [name, target] of Object.entries(this.collections)) {
      const origin = source.collections[name]
      if (origin === undefined) continue
      for (const entry of origin.list({ order: "oldest" }))
        target.insert(entry.id, entry.value as never)
    }
  }
}

export class StripeState {
  private readonly partitions = new Map<string, AccountState>()
  readonly ids: IdSequence

  constructor(
    private readonly sqlite: SqliteClient,
    private readonly namespace: string,
  ) {
    this.ids = new IdSequence(sqlite, namespace, "stripe")
  }

  /** Account-scoped collections; the same API key always resolves to the same partition. */
  for(account: string): AccountState {
    const cached = this.partitions.get(account)
    if (cached) return cached
    const state = new AccountState(this.sqlite, this.namespace, account)
    this.partitions.set(account, state)
    return state
  }

  scope(context: OperationContext): AccountState {
    return this.for(accountOf(context.request))
  }

  /** Account partitions seen so far, optionally narrowed to one. */
  accounts(account?: string): AccountState[] {
    if (account !== undefined) return [this.for(account)]
    return [...this.partitions.values()]
  }

  /**
   * Copy every partition and id counter of `source` into this instance (seeding a lockstep walk).
   * Counters come along so freshly minted ids cannot collide with the seeded ones.
   */
  importFrom(source: StripeState): void {
    for (const partition of source.accounts()) this.for(partition.account).importFrom(partition)
    const sequences = source.sqlite
      .prepare("SELECT name, kind, value FROM mockingbird_sequences WHERE namespace = ?")
      .all<{ name: string; kind: string; value: number }>(source.namespace)
    const upsert = this.sqlite.prepare(
      `INSERT INTO mockingbird_sequences (namespace, name, kind, value) VALUES (?, ?, ?, ?)
       ON CONFLICT(namespace, name, kind) DO UPDATE SET value = excluded.value`,
    )
    for (const sequence of sequences)
      upsert.run(this.namespace, sequence.name, sequence.kind, sequence.value)
  }

  async requestLogUrl() {
    const id = this.ids.next("req_")
    return `https://dashboard.stripe.com/acct_mockingbird/test/workbench/logs?object=${id}`
  }
}

export const seconds = (now: () => number) => Math.floor(now() / 1000)
