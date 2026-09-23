import { Collection, IdSequence } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"

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
  }
  metadata: Record<string, string>
  name: string | null
  next_invoice_sequence: number
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
  metadata: Record<string, string>
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
  metadata: Record<string, string>
  nickname: string | null
  product: string
  recurring: Recurring | null
  tax_behavior: "exclusive" | "inclusive" | "unspecified"
  /** Canonical decimal string in cents (no trailing zeros), e.g. "100" or "100.5". */
  unit_amount_decimal: string
}

export type BillingDetails = {
  address: Address | null
  email: string | null
  name: string | null
  phone: string | null
}

export type CardOutcome =
  | { kind: "success" }
  | { kind: "authenticate" }
  | { kind: "decline"; code: string; decline_code: string; message: string }

export type CardDetails = {
  brand: string
  country: string
  cvc_check: "pass" | "fail" | "unavailable" | "unchecked" | null
  exp_month: number
  exp_year: number
  fingerprint: string
  funding: string
  last4: string
  outcome: CardOutcome
}

export type PaymentMethodRecord = {
  id: string
  allow_redisplay: "always" | "limited" | "unspecified"
  billing_details: BillingDetails
  card: CardDetails | null
  created: number
  customer: string | null
  metadata: Record<string, string>
  type: string
}

export type Shipping = { address: Address; name: string; phone: string | null }

export type PaymentIntentRecord = {
  id: string
  amount: number
  amount_capturable: number
  amount_received: number
  automatic_payment_methods: boolean
  canceled_at: number | null
  cancellation_reason: string | null
  capture_method: "automatic" | "automatic_async" | "manual"
  client_secret: string
  confirmation_method: "automatic" | "manual"
  created: number
  currency: string
  customer: string | null
  description: string | null
  last_payment_error: Record<string, unknown> | null
  latest_charge: string | null
  metadata: Record<string, string>
  next_action: Record<string, unknown> | null
  payment_method: string | null
  payment_method_types: string[]
  receipt_email: string | null
  setup_future_usage: "off_session" | "on_session" | null
  shipping: Shipping | null
  statement_descriptor: string | null
  statement_descriptor_suffix: string | null
  status:
    | "canceled"
    | "processing"
    | "requires_action"
    | "requires_capture"
    | "requires_confirmation"
    | "requires_payment_method"
    | "succeeded"
}

export type SetupIntentRecord = {
  id: string
  automatic_payment_methods: boolean
  cancellation_reason: string | null
  client_secret: string
  created: number
  customer: string | null
  description: string | null
  last_setup_error: Record<string, unknown> | null
  mandate: string | null
  metadata: Record<string, string>
  next_action: Record<string, unknown> | null
  payment_method: string | null
  payment_method_types: string[]
  status:
    | "canceled"
    | "processing"
    | "requires_action"
    | "requires_confirmation"
    | "requires_payment_method"
    | "succeeded"
  usage: "off_session" | "on_session"
}

export type ChargeRecord = {
  id: string
  amount: number
  amount_captured: number
  amount_refunded: number
  balance_transaction: string | null
  billing_details: BillingDetails
  captured: boolean
  created: number
  currency: string
  customer: string | null
  description: string | null
  failure_code: string | null
  failure_message: string | null
  metadata: Record<string, string>
  paid: boolean
  payment_intent: string | null
  payment_method: string | null
  receipt_email: string | null
  refunded: boolean
  shipping: Shipping | null
  statement_descriptor: string | null
  statement_descriptor_suffix: string | null
  status: "failed" | "pending" | "succeeded"
}

export type RefundRecord = {
  id: string
  amount: number
  balance_transaction: string | null
  charge: string | null
  created: number
  currency: string
  metadata: Record<string, string>
  payment_intent: string | null
  reason: string | null
  status: "canceled" | "failed" | "pending" | "succeeded"
}

export type TokenRecord = {
  id: string
  card: CardDetails | null
  client_ip: string | null
  created: number
  type: "card"
  used: boolean
}

export type ConfirmationTokenRecord = {
  id: string
  created: number
  expires_at: number
  payment_method: string | null
  return_url: string | null
  setup_future_usage: "off_session" | "on_session" | null
  shipping: Shipping | null
}

export type MandateRecord = {
  id: string
  created: number
  customer: string | null
  payment_method: string
  status: "active" | "inactive" | "pending"
  type: "multi_use" | "single_use"
}

export type SourceRecord = {
  id: string
  client_secret: string
  created: number
  currency: string | null
  customer: string | null
  flow: "none" | "redirect" | "code_verification"
  status: "chargeable" | "consumed" | "canceled" | "failed" | "pending"
  type: string
  card: CardDetails | null
}

export type BalanceTransactionRecord = {
  id: string
  amount: number
  available_on: number
  created: number
  currency: string
  description: string | null
  fee: number
  net: number
  reporting_category: string
  source: string | null
  status: "available" | "pending"
  type: string
}

export type CustomerBalanceTransactionRecord = {
  id: string
  amount: number
  created: number
  currency: string
  customer: string
  description: string | null
  ending_balance: number
  metadata: Record<string, string>
  type: string
}

export type SubscriptionItemRecord = {
  id: string
  created: number
  current_period_end: number
  current_period_start: number
  metadata: Record<string, string>
  price: string
  quantity: number
  subscription: string
}

export type SubscriptionRecord = {
  id: string
  cancel_at: number | null
  cancel_at_period_end: boolean
  canceled_at: number | null
  collection_method: "charge_automatically" | "send_invoice"
  created: number
  currency: string
  current_period_end: number
  current_period_start: number
  customer: string
  days_until_due: number | null
  default_payment_method: string | null
  description: string | null
  ended_at: number | null
  items: string[]
  latest_invoice: string | null
  metadata: Record<string, string>
  start_date: number
  status:
    | "active"
    | "canceled"
    | "incomplete"
    | "incomplete_expired"
    | "past_due"
    | "paused"
    | "trialing"
    | "unpaid"
  trial_end: number | null
  trial_start: number | null
}

export type InvoiceLineRecord = {
  id: string
  amount: number
  currency: string
  description: string | null
  period: { start: number; end: number }
  price: string | null
  quantity: number
}

export type InvoiceRecord = {
  id: string
  amount_paid: number
  attempt_count: number
  auto_advance: boolean
  billing_reason: string
  collection_method: "charge_automatically" | "send_invoice"
  created: number
  currency: string
  customer: string
  default_payment_method: string | null
  description: string | null
  due_date: number | null
  ending_balance: number
  finalized_at: number | null
  lines: InvoiceLineRecord[]
  metadata: Record<string, string>
  number: string | null
  paid_at: number | null
  payment_intent: string | null
  period_end: number
  period_start: number
  preview: boolean
  starting_balance: number
  status: "draft" | "open" | "paid" | "uncollectible" | "void"
  subscription: string | null
  voided_at: number | null
}

export type InvoiceItemRecord = {
  id: string
  amount: number
  currency: string
  customer: string
  date: number
  description: string | null
  invoice: string | null
  metadata: Record<string, string>
  period: { start: number; end: number }
  price: string | null
  quantity: number
}

export type CouponRecord = {
  id: string
  amount_off: number | null
  created: number
  currency: string | null
  duration: "forever" | "once" | "repeating"
  duration_in_months: number | null
  max_redemptions: number | null
  metadata: Record<string, string>
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
  metadata: Record<string, string>
  times_redeemed: number
}

export type TaxRateRecord = {
  id: string
  active: boolean
  country: string | null
  created: number
  description: string | null
  display_name: string
  inclusive: boolean
  jurisdiction: string | null
  metadata: Record<string, string>
  percentage: number
}

export type CheckoutSessionRecord = {
  id: string
  cancel_url: string | null
  client_reference_id: string | null
  created: number
  currency: string | null
  customer: string | null
  customer_email: string | null
  expires_at: number
  metadata: Record<string, string>
  mode: "payment" | "setup" | "subscription"
  payment_intent: string | null
  payment_method_types: string[]
  payment_status: "no_payment_required" | "paid" | "unpaid"
  setup_intent: string | null
  status: "complete" | "expired" | "open"
  submit_type: string | null
  subscription: string | null
  success_url: string | null
  ui_mode: "elements" | "embedded_page" | "hosted_page"
  url: string | null
  amount_total: number | null
}

export type PaymentLinkRecord = {
  id: string
  active: boolean
  allow_promotion_codes: boolean
  billing_address_collection: "auto" | "required"
  currency: string
  customer_creation: "always" | "if_required"
  line_items: Array<{ price: string; quantity: number }>
  metadata: Record<string, string>
  payment_method_collection: "always" | "if_required"
  submit_type: "auto" | "book" | "donate" | "pay" | "subscribe"
  url: string
}

export type PortalSessionRecord = {
  id: string
  configuration: string
  created: number
  customer: string
  return_url: string | null
  url: string
}

export type WebhookEndpointRecord = {
  id: string
  api_version: string | null
  created: number
  description: string | null
  enabled_events: string[]
  metadata: Record<string, string>
  secret: string
  status: "disabled" | "enabled"
  url: string
}

export type EventRecord = {
  id: string
  api_version: string
  created: number
  data: { object: Record<string, unknown> }
  pending_webhooks: number
  request: { id: string | null; idempotency_key: string | null }
  type: string
}

export type PayoutRecord = {
  id: string
  amount: number
  arrival_date: number
  created: number
  currency: string
  description: string | null
  metadata: Record<string, string>
  method: "instant" | "standard"
  statement_descriptor: string | null
  status: "canceled" | "failed" | "in_transit" | "paid" | "pending"
  type: "bank_account" | "card"
}

export type IdempotencyRecord = {
  body: unknown
  fingerprint: string
  status: number
}

export type CustomerSessionRecord = {
  client_secret: string
  components: Record<string, { enabled: boolean }>
  created: number
  customer: string
  expires_at: number
}

export type EphemeralKeyRecord = {
  id: string
  created: number
  expires: number
  secret: string
  customer: string | null
}

export class StripeState {
  readonly customers: Collection<CustomerEntry>
  readonly products: Collection<ProductRecord>
  readonly prices: Collection<PriceRecord>
  readonly paymentMethods: Collection<PaymentMethodRecord>
  readonly paymentIntents: Collection<PaymentIntentRecord>
  readonly setupIntents: Collection<SetupIntentRecord>
  readonly charges: Collection<ChargeRecord>
  readonly refunds: Collection<RefundRecord>
  readonly tokens: Collection<TokenRecord>
  readonly confirmationTokens: Collection<ConfirmationTokenRecord>
  readonly mandates: Collection<MandateRecord>
  readonly sources: Collection<SourceRecord>
  readonly balanceTransactions: Collection<BalanceTransactionRecord>
  readonly customerBalanceTransactions: Collection<CustomerBalanceTransactionRecord>
  readonly subscriptions: Collection<SubscriptionRecord>
  readonly subscriptionItems: Collection<SubscriptionItemRecord>
  readonly invoices: Collection<InvoiceRecord>
  readonly invoiceItems: Collection<InvoiceItemRecord>
  readonly coupons: Collection<CouponRecord>
  readonly promotionCodes: Collection<PromotionCodeRecord>
  readonly taxRates: Collection<TaxRateRecord>
  readonly checkoutSessions: Collection<CheckoutSessionRecord>
  readonly paymentLinks: Collection<PaymentLinkRecord>
  readonly portalSessions: Collection<PortalSessionRecord>
  readonly webhookEndpoints: Collection<WebhookEndpointRecord>
  readonly events: Collection<EventRecord>
  readonly payouts: Collection<PayoutRecord>
  readonly idempotency: Collection<IdempotencyRecord>
  readonly customerSessions: Collection<CustomerSessionRecord>
  readonly ephemeralKeys: Collection<EphemeralKeyRecord>
  readonly ids: IdSequence

  constructor(sqlite: SqliteClient, namespace: string) {
    const collection = <T>(name: string) => new Collection<T>(sqlite, namespace, name)
    this.customers = collection("customers")
    this.products = collection("products")
    this.prices = collection("prices")
    this.paymentMethods = collection("payment_methods")
    this.paymentIntents = collection("payment_intents")
    this.setupIntents = collection("setup_intents")
    this.charges = collection("charges")
    this.refunds = collection("refunds")
    this.tokens = collection("tokens")
    this.confirmationTokens = collection("confirmation_tokens")
    this.mandates = collection("mandates")
    this.sources = collection("sources")
    this.balanceTransactions = collection("balance_transactions")
    this.customerBalanceTransactions = collection("customer_balance_transactions")
    this.subscriptions = collection("subscriptions")
    this.subscriptionItems = collection("subscription_items")
    this.invoices = collection("invoices")
    this.invoiceItems = collection("invoice_items")
    this.coupons = collection("coupons")
    this.promotionCodes = collection("promotion_codes")
    this.taxRates = collection("tax_rates")
    this.checkoutSessions = collection("checkout_sessions")
    this.paymentLinks = collection("payment_links")
    this.portalSessions = collection("portal_sessions")
    this.webhookEndpoints = collection("webhook_endpoints")
    this.events = collection("events")
    this.payouts = collection("payouts")
    this.idempotency = collection("idempotency")
    this.customerSessions = collection("customer_sessions")
    this.ephemeralKeys = collection("ephemeral_keys")
    this.ids = new IdSequence(sqlite, namespace, "stripe")
  }

  async requestLogUrl() {
    const id = this.ids.next("req_")
    return `https://dashboard.stripe.com/acct_mockingbird/test/workbench/logs?object=${id}`
  }
}

export const seconds = (now: () => number) => Math.floor(now() / 1000)
