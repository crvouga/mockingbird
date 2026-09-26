/**
 * Stored records are the wire shape Paddle returns as `data` (snake_case), so a handler can
 * serve them as-is and `include=` relations are layered on at response time.
 */

export type Status = "active" | "archived"
export type CatalogType = "standard" | "custom"
export type Interval = "day" | "week" | "month" | "year"
export type CollectionMode = "automatic" | "manual"
export type TransactionStatus =
  | "draft"
  | "ready"
  | "billed"
  | "paid"
  | "completed"
  | "canceled"
  | "past_due"
export type TransactionOrigin =
  | "api"
  | "subscription_charge"
  | "subscription_payment_method_change"
  | "subscription_recurring"
  | "subscription_update"
  | "web"
export type SubscriptionStatus = "active" | "canceled" | "past_due" | "paused" | "trialing"

export type CustomData = Record<string, unknown> | null
export type TimePeriod = { interval: Interval; frequency: number }
export type TrialPeriod = TimePeriod & { requires_payment_method?: boolean }
export type Money = { amount: string; currency_code: string }
export type Period = { starts_at: string; ends_at: string }

export type BillingDetails = {
  enable_checkout: boolean
  purchase_order_number: string | null
  additional_information: string | null
  payment_terms: TimePeriod
}

export type CustomerRecord = {
  id: string
  name: string | null
  email: string
  marketing_consent: boolean
  status: Status
  custom_data: CustomData
  locale: string
  created_at: string
  updated_at: string
  import_meta: null
}

export type AddressRecord = {
  id: string
  customer_id: string
  description: string | null
  first_line: string | null
  second_line: string | null
  city: string | null
  postal_code: string | null
  region: string | null
  country_code: string
  custom_data: CustomData
  status: Status
  created_at: string
  updated_at: string
  import_meta: null
}

export type BusinessRecord = {
  id: string
  customer_id: string
  name: string
  company_number: string | null
  tax_identifier: string | null
  status: Status
  contacts: { name: string | null; email: string }[] | null
  created_at: string
  updated_at: string
  custom_data: CustomData
  import_meta: null
}

export type ProductRecord = {
  id: string
  name: string
  type: CatalogType
  description: string | null
  tax_category: string
  image_url: string | null
  custom_data: CustomData
  status: Status
  created_at: string
  updated_at: string
  import_meta: null
}

export type PriceRecord = {
  id: string
  product_id: string
  description: string
  type: CatalogType
  name: string | null
  billing_cycle: TimePeriod | null
  trial_period: TrialPeriod | null
  tax_mode: string
  unit_price: Money
  unit_price_overrides: { country_codes: string[]; unit_price: Money }[]
  quantity: { minimum: number; maximum: number }
  status: Status
  created_at: string
  updated_at: string
  custom_data: CustomData
  import_meta: null
}

export type Totals = { subtotal: string; discount: string; tax: string; total: string }

export type TransactionTotals = Totals & {
  credit: string
  credit_to_balance: string
  balance: string
  grand_total: string
  grand_total_tax: string
  fee: string | null
  earnings: string | null
  currency_code: string
}

export type LineItem = {
  id: string
  price_id: string
  quantity: number
  proration: null
  tax_rate: string
  unit_totals: Totals
  totals: Totals
  product: ProductRecord
}

export type PreviewLineItem = Omit<LineItem, "id">

export type TransactionDetails = {
  tax_rates_used: { tax_rate: string; totals: Totals }[]
  totals: TransactionTotals
  adjusted_totals: {
    subtotal: string
    tax: string
    total: string
    grand_total: string
    grand_total_tax: string
    fee: string | null
    earnings: string | null
    currency_code: string
    retained_fee: string
  }
  payout_totals: null
  adjusted_payout_totals: null
  line_items: LineItem[]
}

export type PreviewDetails = {
  tax_rates_used: { tax_rate: string; totals: Totals }[]
  totals: TransactionTotals
  line_items: PreviewLineItem[]
}

export type PaymentAttempt = {
  payment_attempt_id: string
  stored_payment_method_id: string
  payment_method_id: string | null
  amount: string
  status: "captured" | "error"
  error_code: string | null
  method_details: {
    type: "card"
    card: {
      type: string
      last4: string
      expiry_month: number
      expiry_year: number
      cardholder_name: string
    }
    paypal: null
    south_korea_local_card: null
    underlying_details: null
  } | null
  created_at: string
  captured_at: string | null
}

export type TransactionItem = {
  price_id: string
  /** The price as it was when the transaction was written, as Paddle embeds it. */
  price: PriceRecord
  quantity: number
  proration: null
}

export type TransactionRecord = {
  id: string
  status: TransactionStatus
  customer_id: string | null
  address_id: string | null
  business_id: string | null
  custom_data: CustomData
  currency_code: string
  origin: TransactionOrigin
  subscription_id: string | null
  invoice_id: string | null
  invoice_number: string | null
  collection_mode: CollectionMode
  discount_id: null
  billing_details: BillingDetails | null
  billing_period: Period | null
  items: TransactionItem[]
  details: TransactionDetails
  payments: PaymentAttempt[]
  checkout: { url: string | null } | null
  created_at: string
  updated_at: string
  billed_at: string | null
  revised_at: null
}

export type SubscriptionItem = {
  status: "active" | "inactive" | "trialing"
  quantity: number
  recurring: boolean
  created_at: string
  updated_at: string
  previously_billed_at: string | null
  next_billed_at: string | null
  trial_dates: Period | null
  price: PriceRecord
  product: ProductRecord
}

export type ScheduledChange = {
  action: "cancel" | "pause" | "resume"
  effective_at: string
  resume_at: string | null
}

export type SubscriptionRecord = {
  id: string
  status: SubscriptionStatus
  customer_id: string
  address_id: string
  business_id: string | null
  currency_code: string
  created_at: string
  updated_at: string
  started_at: string | null
  first_billed_at: string | null
  next_billed_at: string | null
  paused_at: string | null
  canceled_at: string | null
  discount: null
  collection_mode: CollectionMode
  billing_details: BillingDetails | null
  current_billing_period: Period | null
  billing_cycle: TimePeriod
  scheduled_change: ScheduledChange | null
  management_urls: { update_payment_method: string | null; cancel: string }
  items: SubscriptionItem[]
  custom_data: CustomData
  import_meta: null
}

/** One-time charges queued with `effective_from: next_billing_period`, billed at the next renewal. */
export type PendingCharge = { price_id: string; quantity: number }

export type EventRecord = {
  event_id: string
  event_type: string
  occurred_at: string
  notification_id: null
  data: Record<string, unknown>
}
