/**
 * Vendor the supported subset of Stripe's official OpenAPI spec into `openapi.yaml`.
 *
 * Source: https://github.com/stripe/openapi (spec3.json), pinned by commit below. Only the
 * operations Mockingbird implements are kept, together with the component schemas they
 * transitively reference. Expandable fields are collapsed to their unexpanded (id-only) shape
 * because the mock never expands. Mockingbird metadata is layered on top so the differential
 * runner knows identities, references, volatile fields and unsupported parameters.
 *
 * Run with `bun run vendor` inside packages/service/stripe (network access required).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { stringify } from "yaml"

const UPSTREAM = {
  repository: "stripe/openapi",
  commit: "6ed8e70ed90416a4f37603fffcf2fb1f96b405d5",
  file: "openapi/spec3.json",
} as const

const packageDir = resolve(import.meta.dir, "..")
const cachePath = resolve(packageDir, "node_modules/.cache/stripe-spec3.json")
const outputPath = resolve(packageDir, "openapi.yaml")

type Json = Record<string, unknown>
type Schema = Json

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const fetchUpstream = async (): Promise<Json> => {
  try {
    return JSON.parse(await readFile(cachePath, "utf8")) as Json
  } catch {
    const url = `https://raw.githubusercontent.com/${UPSTREAM.repository}/${UPSTREAM.commit}/${UPSTREAM.file}`
    const response = await fetch(url)
    if (!response.ok) throw new Error(`failed to fetch ${url}: ${response.status}`)
    const text = await response.text()
    await mkdir(dirname(cachePath), { recursive: true })
    await writeFile(cachePath, text)
    return JSON.parse(text) as Json
  }
}

// --- metadata helpers -------------------------------------------------------------------------

const identity = (type: string) => ({ "x-mockingbird-resource": { type, identity: true } })
const ref = (type: string, missing: string) => ({ "x-mockingbird-resource-ref": { type, missing } })
const volatile = (kind: "id" | "timestamp" | "token" | "url" | "account" | "opaque") => ({
  "x-mockingbird-volatile": { kind },
})
const unsupported = (reason: string) => ({ "x-mockingbird-unsupported": { reason } })
const scope = (value: "run-id" | "walk-start-unix" | "walk-start-iso") => ({
  "x-mockingbird-scope": { value },
})

const MISSING = {
  customer: "cus_mockingbird_missing",
  product: "prod_mockingbird_missing",
  price: "price_mockingbird_missing",
  payment_method: "pm_mockingbird_missing",
  payment_intent: "pi_mockingbird_missing",
  setup_intent: "seti_mockingbird_missing",
  charge: "ch_mockingbird_missing",
  refund: "re_mockingbird_missing",
  dispute: "dp_mockingbird_missing",
  invoice: "in_mockingbird_missing",
  invoiceitem: "ii_mockingbird_missing",
  subscription: "sub_mockingbird_missing",
  subscription_item: "si_mockingbird_missing",
  schedule: "sub_sched_mockingbird_missing",
  coupon: "coupon_mockingbird_missing",
  promotion_code: "promo_mockingbird_missing",
  event: "evt_mockingbird_missing",
  session: "cs_mockingbird_missing",
  transaction: "cbtxn_mockingbird_missing",
  intent: "pi_mockingbird_missing",
  test_clock: "clock_mockingbird_missing",
  webhook_endpoint: "we_mockingbird_missing",
  balance_transaction: "txn_mockingbird_missing",
} as const

/** The generator only needs a handful of currencies; the mock still knows Stripe's full list. */
const CURRENCY: Schema = { type: "string", enum: ["usd", "eur", "gbp", "jpy", "cad", "aud"] }
/** Stripe validates IETF language tags; keep the generator to well-formed ones. */
const LOCALE_ITEM: Schema = {
  type: "string",
  enum: ["en", "en-US", "en-GB", "fr", "fr-CA", "de", "es", "ja", "pt-BR"],
}

const nullableIdOnly = (extra: Json = {}): Schema => ({
  maxLength: 5000,
  type: ["string", "null"],
  ...extra,
})

// --- schema shaping ---------------------------------------------------------------------------

/** Id-or-expanded-object field for properties the pinned spec no longer publishes. */
const expandableId = (extra: Json = {}): Schema => ({
  type: ["string", "object", "null"],
  ...extra,
})

/** Property-level edits applied to a component schema. `null` deletes the property. */
type Shape = Record<string, Schema | null>

const RESPONSE_SHAPES: Record<string, Shape> = {
  customer: {
    id: identity("customer"),
    created: volatile("timestamp"),
    invoice_prefix: volatile("opaque"),
    // Only present when expanded; the mock never expands.
    cash_balance: null,
    sources: null,
    subscriptions: null,
    tax: null,
    tax_ids: null,
    // Not returned by the pinned API version.
    business_name: null,
    individual_name: null,
    invoice_credit_balance: null,
    default_source: nullableIdOnly(),
    discount: { type: "null" },
    test_clock: nullableIdOnly(),
  },
  deleted_customer: { id: identity("customer") },
  product: {
    id: identity("product"),
    // Returned by the pinned API version although absent from the published schema.
    attributes: { type: "array", items: { type: "string" } },
    tax_details: { type: "null" },
    type: { type: "string", enum: ["good", "service"] },
    created: volatile("timestamp"),
    updated: volatile("timestamp"),
    default_price: expandableId(identity("price")),
    tax_code: nullableIdOnly(),
    // Requests accept 40,000 characters; the published response schema says 5,000.
    description: { type: ["string", "null"], maxLength: 40000 },
  },
  deleted_product: { id: identity("product") },
  invoice_setting_customer_setting: { default_payment_method: nullableIdOnly() },
  recurring: { trial_period_days: { type: ["integer", "null"] } },
  api_errors: {
    request_log_url: volatile("url"),
    payment_intent: null,
    payment_method: null,
    setup_intent: null,
    source: null,
  },
  deleted_invoice: { id: identity("invoice") },
  deleted_coupon: { id: identity("coupon") },
  deleted_discount: { id: identity("discount") },
  deleted_subscription_item: { id: identity("subscription_item") },
  customer_balance_transaction: {
    id: identity("transaction"),
    created: volatile("timestamp"),
    customer: expandableId(identity("customer")),
  },
  payment_method: {
    id: identity("payment_method"),
    created: volatile("timestamp"),
    customer: expandableId(identity("customer")),
  },
  payment_intent: {
    id: identity("payment_intent"),
    created: volatile("timestamp"),
    client_secret: volatile("token"),
    latest_charge: expandableId(identity("charge")),
    customer: expandableId(identity("customer")),
    invoice: expandableId(identity("invoice")),
    payment_method: expandableId(identity("payment_method")),
    application: null,
    application_fee_amount: null,
    automatic_payment_methods: null,
    review: null,
    setup_future_usage: { type: ["string", "null"] },
    shipping: null,
    statement_descriptor: { type: ["string", "null"] },
    statement_descriptor_suffix: { type: ["string", "null"] },
    transfer_data: null,
    transfer_group: { type: ["string", "null"] },
  },
  setup_intent: {
    id: identity("setup_intent"),
    created: volatile("timestamp"),
    client_secret: volatile("token"),
    customer: expandableId(identity("customer")),
    payment_method: expandableId(identity("payment_method")),
    // Only present when expanded; the mock inlines the intent instead.
    latest_attempt: null,
    mandate: null,
    single_use_mandate: null,
    application: null,
    attach_to_self: null,
    flow_directions: null,
    on_behalf_of: { type: ["string", "null"] },
  },
  charge: {
    id: identity("charge"),
    created: volatile("timestamp"),
    customer: expandableId(identity("customer")),
    invoice: expandableId(identity("invoice")),
    payment_intent: expandableId(identity("payment_intent")),
    payment_method: expandableId(identity("payment_method")),
    balance_transaction: null,
    billing_details: {
      type: "object",
      properties: {
        address: { type: ["object", "null"] },
        email: { type: ["string", "null"] },
        name: { type: ["string", "null"] },
        phone: { type: ["string", "null"] },
      },
    },
    captured: { type: "boolean" },
    application: null,
    application_fee: null,
    application_fee_amount: null,
    fraud_details: null,
    on_behalf_of: { type: ["string", "null"] },
    outcome: null,
    radar_options: null,
    receipt_email: { type: ["string", "null"] },
    receipt_number: { type: ["string", "null"] },
    refunds: null,
    review: null,
    shipping: null,
    source_transfer: null,
    statement_descriptor: { type: ["string", "null"] },
    transfer_data: null,
    transfer_group: { type: ["string", "null"] },
  },
  refund: {
    id: identity("refund"),
    created: volatile("timestamp"),
    charge: expandableId(identity("charge")),
    payment_intent: expandableId(identity("payment_intent")),
    balance_transaction: null,
    destination_details: null,
    failure_balance_transaction: null,
    instructions_email: { type: ["string", "null"] },
    next_action: null,
    receipt_number: { type: ["string", "null"] },
    source_transfer_reversal: null,
    transfer_reversal: null,
  },
  dispute: {
    id: identity("dispute"),
    created: volatile("timestamp"),
    charge: expandableId(identity("charge")),
    payment_intent: expandableId(identity("payment_intent")),
    // Evidence, eligibility and balance-ledger surfaces the mock never models.
    balance_transactions: null,
    enhanced_eligibility_types: null,
    evidence: null,
    evidence_details: null,
    is_charge_refundable: null,
    payment_method_details: null,
  },
  "checkout.session": {
    id: identity("session"),
    created: volatile("timestamp"),
    expires_at: volatile("timestamp"),
    url: volatile("url"),
    customer: expandableId(identity("customer")),
    payment_intent: expandableId(identity("payment_intent")),
    setup_intent: expandableId(identity("setup_intent")),
    subscription: expandableId(identity("subscription")),
    // Tax, custom-text and shipping plumbing the mock never models.
    automatic_tax: null,
    custom_fields: null,
    custom_text: null,
    shipping_options: null,
    after_expiration: null,
    consent: null,
    consent_collection: null,
    currency_conversion: null,
    discounts: null,
    invoice: null,
    invoice_creation: null,
    locale: null,
    optional_items: null,
    origin_context: null,
    payment_link: null,
    permissions: null,
    presentment_details: null,
    saved_payment_method_options: null,
    shipping_cost: null,
    submit_type: null,
    wallet_options: null,
  },
  line_item: {
    id: identity("invoice_item"),
    discounts: { type: "array", items: {} },
    discount_amounts: { type: "array", items: {} },
    metadata: { type: "object" },
  },
  item: {
    id: identity("checkout_item"),
    discounts: { type: "array", items: {} },
    taxes: { type: "array", items: {} },
  },
  invoiceitem: {
    id: identity("invoiceitem"),
    customer: expandableId(identity("customer")),
    invoice: expandableId(identity("invoice")),
    quantity_decimal: null,
    date: volatile("timestamp"),
    period: { type: "object" },
    discountable: { type: "boolean" },
    proration: { type: "boolean" },
  },
  invoice: {
    id: identity("invoice"),
    created: volatile("timestamp"),
    number: volatile("opaque"),
    hosted_invoice_url: volatile("url"),
    invoice_pdf: volatile("url"),
    charge: expandableId(identity("charge")),
    payment_intent: expandableId(identity("payment_intent")),
    subscription: expandableId(identity("subscription")),
    customer: expandableId(identity("customer")),
    default_payment_method: expandableId(identity("payment_method")),
    // Amounts and tax plumbing the mock never models.
    amount_overpaid: null,
    amount_paid_off_stripe: null,
    amount_shipping: null,
    automatic_tax: null,
    default_tax_rates: null,
    issuer: null,
    payment_settings: null,
    post_payment_credit_notes_amount: null,
    pre_payment_credit_notes_amount: null,
    starting_balance: null,
    total_discount_amounts: null,
    total_pretax_credit_amounts: null,
    status_transitions: {
      type: "object",
      properties: {
        finalized_at: { type: ["integer", "null"] },
        marked_uncollectible_at: { type: ["integer", "null"] },
        paid_at: { type: ["integer", "null"] },
        voided_at: { type: ["integer", "null"] },
      },
    },
    lines: { type: "object" },
    discounts: { type: "array", items: {} },
  },
  subscription: {
    id: identity("subscription"),
    created: volatile("timestamp"),
    customer: expandableId(identity("customer")),
    latest_invoice: expandableId(identity("invoice")),
    default_payment_method: expandableId(identity("payment_method")),
    schedule: expandableId(identity("schedule")),
    pending_setup_intent: null,
    application: null,
    automatic_tax: null,
    billing_mode: null,
    billing_schedules: null,
    managed_payments: null,
    invoice_settings: null,
    default_tax_rates: null,
    discounts: { type: "array", items: {} },
    items: { type: "object" },
    // Period bounds live on subscription items in the pinned version; the mock returns them on
    // the subscription too because the e2e clients read them there.
    current_period_start: { type: "integer" },
    current_period_end: { type: "integer" },
  },
  subscription_item: {
    id: identity("subscription_item"),
    created: volatile("timestamp"),
    subscription: expandableId(identity("subscription")),
    current_period_start: volatile("timestamp"),
    current_period_end: volatile("timestamp"),
    discounts: { type: "array", items: {} },
  },
  price: {
    id: identity("price"),
    created: volatile("timestamp"),
    product: expandableId(identity("product")),
    // Only present when expanded or when the pricing model uses them.
    currency_options: null,
    tiers: null,
  },
  subscription_schedule: {
    id: identity("schedule"),
    created: volatile("timestamp"),
    customer: expandableId(identity("customer")),
    subscription: expandableId(identity("subscription")),
    released_subscription: expandableId(identity("subscription")),
    billing_mode: null,
    default_settings: null,
    phases: { type: "array", items: {} },
  },
  coupon: {
    id: identity("coupon"),
    created: volatile("timestamp"),
    applies_to: {
      type: "object",
      properties: { products: { type: "array", items: identity("product") } },
    },
    times_redeemed: { type: "integer" },
    valid: { type: "boolean" },
  },
  promotion_code: {
    id: identity("promotion_code"),
    created: volatile("timestamp"),
    expires_at: volatile("timestamp"),
    customer: expandableId(identity("customer")),
    // The pinned version replaced `coupon` with `promotion`; the mock returns `coupon`, which is
    // what the e2e clients read.
    promotion: null,
    restrictions: {
      type: "object",
      properties: {
        first_time_transaction: { type: "boolean" },
        minimum_amount: { type: ["integer", "null"] },
        minimum_amount_currency: { type: ["string", "null"] },
      },
    },
    times_redeemed: { type: "integer" },
  },
  discount: {
    id: identity("discount"),
    coupon: expandableId(identity("coupon")),
    promotion_code: expandableId(identity("promotion_code")),
    customer: expandableId(identity("customer")),
    subscription: expandableId(identity("subscription")),
    start: volatile("timestamp"),
    source: {
      type: "object",
      properties: {
        coupon: identity("coupon"),
        promotion_code: identity("promotion_code"),
        type: { type: "string" },
      },
    },
  },
  event: {
    id: identity("event"),
    created: volatile("timestamp"),
    request: {
      type: ["object", "null"],
      properties: {
        id: volatile("token"),
        idempotency_key: { type: ["string", "null"] },
      },
    },
  },
  notification_event_data: { object: {} },
  "test_helpers.test_clock": {
    id: identity("test_clock"),
    created: volatile("timestamp"),
    frozen_time: volatile("timestamp"),
    deletes_after: volatile("timestamp"),
  },
  webhook_endpoint: {
    id: identity("webhook_endpoint"),
    secret: volatile("token"),
    created: volatile("timestamp"),
  },
  balance_transaction: {
    id: identity("balance_transaction"),
    created: volatile("timestamp"),
    available_on: volatile("timestamp"),
    source: expandableId(),
  },
  account: {
    id: volatile("account"),
    created: volatile("timestamp"),
  },
}
/**
 * Fields the mock renders only for older API versions (`Stripe-Version: 2024-06-20` and
 * `2025-02-24.acacia`): declared so those responses validate, but not required, because the
 * vendored (latest) version omits them.
 */
const VERSIONED_FIELDS: Record<string, readonly string[]> = {
  invoice: ["charge", "payment_intent", "subscription"],
  subscription: ["current_period_start", "current_period_end"],
  payment_intent: ["invoice"],
}

/** Request-body property edits keyed by operationId. */
const IMAGES: Schema = { type: "array", maxItems: 8, items: { type: "string", maxLength: 2048 } }
const MARKETING_FEATURES: Schema = {
  type: "array",
  maxItems: 15,
  items: {
    type: "object",
    required: ["name"],
    // Stripe's documented limit is 5000; the API enforces 80 (verified in test mode).
    properties: { name: { type: "string", maxLength: 80 } },
  },
}
/** Stripe lets update calls clear a field by sending `""`; the spec models that as a union. */
const unsettable = (schema: Schema): Schema => ({
  anyOf: [schema, { type: "string", enum: [""] }],
})

const BODY_SHAPES: Record<string, Shape> = {
  PostCustomers: {
    "preferred_locales[]": LOCALE_ITEM,
    business_name: unsupported("not returned by the pinned API version"),
    cash_balance: unsupported("cash balance settings are not modelled"),
    individual_name: unsupported("not returned by the pinned API version"),
    invoice_prefix: unsupported("invoice prefix allocation is not modelled"),
    next_invoice_sequence: unsupported("invoicing is not modelled"),
    payment_method: unsupported("payment methods are not modelled"),
    source: unsupported("payment sources are not modelled"),
    tax: unsupported("tax location validation is not modelled"),
    tax_id_data: unsupported("tax ids are not modelled"),
    test_clock: unsupported("test clocks are not modelled"),
    "invoice_settings.default_payment_method": unsupported("payment methods are not modelled"),
    "invoice_settings.rendering_options": unsupported(
      "invoice rendering templates are not modelled",
    ),
  },
  PostCustomersCustomer: {
    "preferred_locales[]": LOCALE_ITEM,
    bank_account: unsupported("payment sources are not modelled"),
    card: unsupported("payment sources are not modelled"),
    business_name: unsupported("not returned by the pinned API version"),
    cash_balance: unsupported("cash balance settings are not modelled"),
    default_alipay_account: unsupported("payment sources are not modelled"),
    default_bank_account: unsupported("payment sources are not modelled"),
    default_card: unsupported("payment sources are not modelled"),
    default_source: unsupported("payment sources are not modelled"),
    individual_name: unsupported("not returned by the pinned API version"),
    invoice_prefix: unsupported("invoice prefix allocation is not modelled"),
    next_invoice_sequence: unsupported("invoicing is not modelled"),
    source: unsupported("payment sources are not modelled"),
    tax: unsupported("tax location validation is not modelled"),
    "invoice_settings.default_payment_method": unsupported("payment methods are not modelled"),
    "invoice_settings.rendering_options": unsupported(
      "invoice rendering templates are not modelled",
    ),
  },
  PostProducts: {
    images: IMAGES,
    marketing_features: MARKETING_FEATURES,
    default_price_data: unsupported("inline price creation is not modelled"),
    id: unsupported("caller-chosen ids are not modelled"),
    tax_code: unsupported("tax codes are not modelled"),
  },
  PostProductsId: {
    images: unsettable(IMAGES),
    marketing_features: unsettable(MARKETING_FEATURES),
    default_price: unsupported("default price assignment is not modelled"),
    tax_code: unsupported("tax codes are not modelled"),
  },
  PostPrices: {
    currency: CURRENCY,
    "recurring.interval_count": { type: "integer", minimum: 1 },
    billing_scheme: unsupported("tiered billing is not modelled"),
    currency_options: unsupported("multi-currency prices are not modelled"),
    custom_unit_amount: unsupported("customer-chosen amounts are not modelled"),
    product: ref("product", MISSING.product),
    product_data: unsupported("inline product creation is not modelled"),
    tiers: unsupported("tiered billing is not modelled"),
    tiers_mode: unsupported("tiered billing is not modelled"),
    transfer_lookup_key: unsupported("lookup key transfer is not modelled"),
    transform_quantity: unsupported("quantity transforms are not modelled"),
    "recurring.meter": unsupported("billing meters are not modelled"),
  },
  PostPricesPrice: {
    currency_options: unsupported("multi-currency prices are not modelled"),
    transfer_lookup_key: unsupported("lookup key transfer is not modelled"),
  },
  // --- money movement: parameters the mock accepts but does not model are refused up front -----
  PostCustomersCustomerBalanceTransactions: {
    amount: { type: "integer" },
    currency: CURRENCY,
    description: { type: "string", maxLength: 350 },
    metadata: { type: "object" },
    expand: unsupported("customer balance transactions are never expanded"),
  },
  PostPaymentMethods: {
    type: { type: "string", enum: ["card"] },
    billing_details: { type: "object" },
    metadata: { type: "object" },
    card: { type: "object" },
    allow_redisplay: unsupported("redisplay policy is not modelled"),
    customer: unsupported("payment methods are attached after creation"),
    payment_method: unsupported("cloning an existing payment method is not modelled"),
  },
  PostPaymentMethodsPaymentMethod: {
    billing_details: { type: "object" },
    metadata: { type: "object" },
    card: { type: "object" },
    allow_redisplay: unsupported("redisplay policy is not modelled"),
  },
  PostPaymentMethodsPaymentMethodAttach: {
    customer: ref("customer", MISSING.customer),
  },
  PostPaymentMethodsPaymentMethodDetach: {},
  PostPaymentIntents: {
    amount: { type: "integer", minimum: 1 },
    currency: CURRENCY,
    customer: ref("customer", MISSING.customer),
    payment_method: { type: "string" },
    description: { type: "string", maxLength: 1000 },
    metadata: { type: "object" },
    capture_method: { type: "string", enum: ["automatic", "manual"] },
    confirm: { type: "boolean" },
    off_session: { type: "boolean" },
    setup_future_usage: { type: "string", enum: ["on_session", "off_session"] },
    payment_method_types: {
      type: "array",
      maxItems: 4,
      items: { type: "string", enum: ["card", "link"] },
    },
    application_fee_amount: unsupported("Connect application fees are not modelled"),
    automatic_payment_methods: unsupported("the payment method type list is explicit in the mock"),
    mandate: unsupported("mandates are not modelled"),
    mandate_data: unsupported("mandates are not modelled"),
    on_behalf_of: unsupported("Connect is not modelled"),
    payment_details: unsupported("payment details are not modelled"),
    payment_method_data: unsupported("raw payment method data is not modelled"),
    payment_method_options: unsupported("payment method options are not modelled"),
    radar_options: unsupported("Radar is not modelled"),
    receipt_email: { type: "string", maxLength: 5000 },
    shipping: unsupported("shipping details are not modelled"),
    statement_descriptor: unsupported("statement descriptors are not modelled"),
    statement_descriptor_suffix: unsupported("statement descriptors are not modelled"),
    transfer_data: unsupported("Connect is not modelled"),
    transfer_group: unsupported("Connect is not modelled"),
    use_stripe_sdk: unsupported("Stripe.js handshakes are not modelled"),
  },
  PostPaymentIntentsIntent: {
    amount: { type: "integer", minimum: 1 },
    customer: ref("customer", MISSING.customer),
    description: { type: "string", maxLength: 1000 },
    metadata: { type: "object" },
    payment_method: { type: "string" },
    receipt_email: { type: "string", maxLength: 5000 },
    setup_future_usage: { type: "string", enum: ["on_session", "off_session"] },
    payment_method_data: unsupported("raw payment method data is not modelled"),
    payment_method_options: unsupported("payment method options are not modelled"),
    statement_descriptor: unsupported("statement descriptors are not modelled"),
    statement_descriptor_suffix: unsupported("statement descriptors are not modelled"),
    transfer_data: unsupported("Connect is not modelled"),
  },
  PostPaymentIntentsIntentConfirm: {
    payment_method: { type: "string" },
    return_url: { type: "string", maxLength: 5000 },
    off_session: { type: "boolean" },
    setup_future_usage: { type: "string", enum: ["on_session", "off_session"] },
    capture_method: { type: "string", enum: ["automatic", "manual"] },
    client_secret: unsupported("the mock does not verify client secrets"),
    mandate: unsupported("mandates are not modelled"),
    mandate_data: unsupported("mandates are not modelled"),
    payment_method_data: unsupported("raw payment method data is not modelled"),
    payment_method_options: unsupported("payment method options are not modelled"),
    payment_method_types: unsupported("the payment method type list is fixed at creation"),
    radar_options: unsupported("Radar is not modelled"),
    shipping: unsupported("shipping details are not modelled"),
    use_stripe_sdk: unsupported("Stripe.js handshakes are not modelled"),
  },
  PostPaymentIntentsIntentCancel: {
    cancellation_reason: {
      type: "string",
      enum: ["abandoned", "duplicate", "fraudulent", "requested_by_customer"],
    },
  },
  PostPaymentIntentsIntentCapture: {
    amount_to_capture: { type: "integer", minimum: 1 },
    application_fee_amount: unsupported("Connect application fees are not modelled"),
    statement_descriptor: unsupported("statement descriptors are not modelled"),
    statement_descriptor_suffix: unsupported("statement descriptors are not modelled"),
    transfer_data: unsupported("Connect is not modelled"),
  },
  PostSetupIntents: {
    customer: ref("customer", MISSING.customer),
    description: { type: "string", maxLength: 1000 },
    metadata: { type: "object" },
    payment_method: { type: "string" },
    usage: { type: "string", enum: ["off_session", "on_session"] },
    attach_to_self: unsupported("Connect is not modelled"),
    automatic_payment_methods: unsupported("the payment method type list is explicit"),
    flow_directions: unsupported("Connect is not modelled"),
    mandate_data: unsupported("mandates are not modelled"),
    on_behalf_of: unsupported("Connect is not modelled"),
    payment_method_data: unsupported("raw payment method data is not modelled"),
    payment_method_options: unsupported("payment method options are not modelled"),
    payment_method_types: unsupported("the payment method type list is explicit"),
  },
  PostSetupIntentsIntent: {
    customer: ref("customer", MISSING.customer),
    description: { type: "string", maxLength: 1000 },
    metadata: { type: "object" },
    payment_method: { type: "string" },
    attach_to_self: unsupported("Connect is not modelled"),
    flow_directions: unsupported("Connect is not modelled"),
    payment_method_data: unsupported("raw payment method data is not modelled"),
    payment_method_options: unsupported("payment method options are not modelled"),
  },
  PostSetupIntentsIntentConfirm: {
    payment_method: { type: "string" },
    return_url: { type: "string", maxLength: 5000 },
    client_secret: unsupported("the mock does not verify client secrets"),
    mandate_data: unsupported("mandates are not modelled"),
    payment_method_data: unsupported("raw payment method data is not modelled"),
    payment_method_options: unsupported("payment method options are not modelled"),
    use_stripe_sdk: unsupported("Stripe.js handshakes are not modelled"),
  },
  PostSetupIntentsIntentCancel: {
    cancellation_reason: {
      type: "string",
      enum: ["abandoned", "duplicate", "requested_by_customer"],
    },
  },
  PostRefunds: {
    amount: { type: "integer", minimum: 1 },
    charge: ref("charge", MISSING.charge),
    payment_intent: ref("payment_intent", MISSING.payment_intent),
    reason: {
      type: "string",
      enum: ["duplicate", "fraudulent", "requested_by_customer"],
    },
    metadata: { type: "object" },
    instructions_email: unsupported("customer instructions are not modelled"),
    refund_application_fee: unsupported("Connect is not modelled"),
    reverse_transfer: unsupported("Connect is not modelled"),
  },
  PostRefundsRefund: { metadata: { type: "object" } },
  PostCheckoutSessions: {
    mode: { type: "string", enum: ["payment", "setup", "subscription"] },
    customer: ref("customer", MISSING.customer),
    customer_creation: { type: "string", enum: ["always", "if_required"] },
    expires_at: { type: "integer" },
    success_url: { type: "string", maxLength: 5000 },
    cancel_url: { type: "string", maxLength: 5000 },
    metadata: { type: "object" },
    automatic_tax: unsupported("tax is not modelled"),
    consent_collection: unsupported("consent collection is not modelled"),
    custom_fields: unsupported("custom fields are not modelled"),
    custom_text: unsupported("custom text is not modelled"),
    discounts: unsupported("checkout discounts are not modelled"),
    invoice_creation: unsupported("checkout invoice creation is not modelled"),
    locale: LOCALE_ITEM,
    payment_method_collection: unsupported("payment method collection is not modelled"),
    payment_method_configuration: unsupported("payment method configuration is not modelled"),
    payment_method_options: unsupported("payment method options are not modelled"),
    payment_method_types: unsupported("the payment method type list is explicit"),
    redirect_on_completion: unsupported("redirect behaviour is not modelled"),
    saved_payment_method_options: unsupported("saved payment method policy is not modelled"),
    setup_intent_data: unsupported("setup intent data is not modelled"),
    shipping_address_collection: unsupported("shipping is not modelled"),
    shipping_options: unsupported("shipping is not modelled"),
    submit_type: unsupported("submit types are not modelled"),
    tax_id_collection: unsupported("tax ids are not modelled"),
    ui_mode: unsupported("embedded checkout is not modelled"),
  },
  PostCheckoutSessionsSessionExpire: {},
  PostInvoices: {
    customer: ref("customer", MISSING.customer),
    collection_method: { type: "string", enum: ["charge_automatically", "send_invoice"] },
    subscription: ref("subscription", MISSING.subscription),
    description: { type: "string", maxLength: 1500 },
    metadata: { type: "object" },
    auto_advance: { type: "boolean" },
    account_tax_ids: unsupported("tax ids are not modelled"),
    automatic_tax: unsupported("tax is not modelled"),
    days_until_due: unsupported("send-invoice terms are not modelled"),
    default_payment_method: { type: "string" },
    default_source: unsupported("payment sources are not modelled"),
    default_tax_rates: unsupported("tax rates are not modelled"),
    discounts: unsupported("invoice discounts are not modelled"),
    due_date: unsupported("send-invoice terms are not modelled"),
    effective_at: unsupported("invoice scheduling is not modelled"),
    footer: unsupported("invoice footers are not modelled"),
    from_invoice: unsupported("invoice cloning is not modelled"),
    issuer: unsupported("invoice issuers are not modelled"),
    number: unsupported("invoice numbering is not modelled"),
    on_behalf_of: unsupported("Connect is not modelled"),
    payment_settings: unsupported("invoice payment settings are not modelled"),
    pending_invoice_items_behavior: unsupported("pending items are not modelled"),
    rendering: unsupported("invoice rendering is not modelled"),
    shipping_cost: unsupported("shipping is not modelled"),
    shipping_details: unsupported("shipping is not modelled"),
    statement_descriptor: unsupported("statement descriptors are not modelled"),
    transfer_data: unsupported("Connect is not modelled"),
  },
  PostInvoicesInvoice: {
    description: { type: "string", maxLength: 1500 },
    metadata: { type: "object" },
    auto_advance: { type: "boolean" },
    collection_method: { type: "string", enum: ["charge_automatically", "send_invoice"] },
    default_payment_method: { type: "string" },
    due_date: { type: "integer" },
    account_tax_ids: unsupported("tax ids are not modelled"),
    automatic_tax: unsupported("tax is not modelled"),
    days_until_due: unsupported("send-invoice terms are not modelled"),
    default_source: unsupported("payment sources are not modelled"),
    default_tax_rates: unsupported("tax rates are not modelled"),
    discounts: unsupported("invoice discounts are not modelled"),
    effective_at: unsupported("invoice scheduling is not modelled"),
    footer: unsupported("invoice footers are not modelled"),
    issuer: unsupported("invoice issuers are not modelled"),
    on_behalf_of: unsupported("Connect is not modelled"),
    payment_settings: unsupported("invoice payment settings are not modelled"),
    rendering: unsupported("invoice rendering is not modelled"),
    shipping_cost: unsupported("shipping is not modelled"),
    shipping_details: unsupported("shipping is not modelled"),
    statement_descriptor: unsupported("statement descriptors are not modelled"),
    transfer_data: unsupported("Connect is not modelled"),
  },
  DeleteInvoicesInvoice: {},
  PostInvoicesInvoiceFinalize: {
    auto_advance: { type: "boolean" },
    expand: unsupported("the mock never expands this operation's response"),
  },
  PostInvoicesInvoicePay: {
    payment_method: { type: "string" },
    forgive: unsupported("write-offs are not modelled"),
    mandate: unsupported("mandates are not modelled"),
    off_session: unsupported("off-session policy is not modelled"),
    paid_out_of_band: unsupported("out-of-band payments are not modelled"),
    source: unsupported("payment sources are not modelled"),
  },
  PostInvoiceitems: {
    amount: { type: "integer" },
    currency: CURRENCY,
    customer: ref("customer", MISSING.customer),
    invoice: ref("invoice", MISSING.invoice),
    description: { type: "string", maxLength: 1500 },
    metadata: { type: "object" },
    quantity: { type: "integer" },
    discountable: { type: "boolean" },
    discounts: unsupported("line discounts are not modelled"),
    period: unsupported("custom line periods are not modelled"),
    pricing: unsupported("line pricing is not modelled"),
    tax_behavior: unsupported("tax is not modelled"),
    tax_code: unsupported("tax codes are not modelled"),
    tax_rates: unsupported("tax rates are not modelled"),
    unit_amount_decimal: unsupported("decimal unit amounts are not modelled for invoice items"),
  },
  PostInvoiceitemsInvoiceitem: {
    amount: { type: "integer" },
    description: { type: "string", maxLength: 1500 },
    metadata: { type: "object" },
    quantity: { type: "integer" },
    discountable: { type: "boolean" },
    discounts: unsupported("line discounts are not modelled"),
    period: unsupported("custom line periods are not modelled"),
    pricing: unsupported("line pricing is not modelled"),
    tax_behavior: unsupported("tax is not modelled"),
    tax_code: unsupported("tax codes are not modelled"),
    tax_rates: unsupported("tax rates are not modelled"),
    unit_amount_decimal: unsupported("decimal unit amounts are not modelled for invoice items"),
  },
  DeleteInvoiceitemsInvoiceitem: {},
  PostSubscriptions: {
    customer: ref("customer", MISSING.customer),
    default_payment_method: { type: "string" },
    description: { type: "string", maxLength: 5000 },
    metadata: { type: "object" },
    payment_behavior: {
      type: "string",
      enum: [
        "allow_incomplete",
        "default_incomplete",
        "error_if_incomplete",
        "pending_if_incomplete",
      ],
    },
    proration_behavior: { type: "string", enum: ["always_invoice", "create_prorations", "none"] },
    backdate_start_date: { type: "integer" },
    billing_cycle_anchor: { type: "integer" },
    trial_end: { type: "integer" },
    trial_period_days: { type: "integer", minimum: 1 },
    application_fee_percent: unsupported("Connect is not modelled"),
    automatic_tax: unsupported("tax is not modelled"),
    billing_thresholds: unsupported("billing thresholds are not modelled"),
    cancel_at: unsupported("scheduled cancellation is not modelled"),
    cancel_at_period_end: { type: "boolean" },
    collection_method: unsupported("only charge_automatically is modelled"),
    currency: unsupported("the currency comes from the price"),
    days_until_due: unsupported("send-invoice terms are not modelled"),
    default_source: unsupported("payment sources are not modelled"),
    default_tax_rates: unsupported("tax rates are not modelled"),
    discounts: unsupported("subscription discounts are not modelled"),
    items: { type: "array", maxItems: 4, items: { type: "object" } },
    on_behalf_of: unsupported("Connect is not modelled"),
    payment_settings: unsupported("subscription payment settings are not modelled"),
    pending_invoice_item_interval: unsupported("pending items are not modelled"),
    transfer_data: unsupported("Connect is not modelled"),
    trial_settings: unsupported("trial settings are not modelled"),
  },
  PostSubscriptionsSubscriptionExposedId: {
    default_payment_method: { type: "string" },
    description: { type: "string", maxLength: 5000 },
    metadata: { type: "object" },
    cancel_at_period_end: { type: "boolean" },
    proration_behavior: { type: "string", enum: ["always_invoice", "create_prorations", "none"] },
    cancel_at: unsupported("scheduled cancellation is not modelled"),
    collection_method: unsupported("only charge_automatically is modelled"),
    days_until_due: unsupported("send-invoice terms are not modelled"),
    discounts: unsupported("subscription discounts are not modelled"),
    items: { type: "array", maxItems: 4, items: { type: "object" } },
    payment_settings: unsupported("subscription payment settings are not modelled"),
    pending_invoice_item_interval: unsupported("pending items are not modelled"),
    transfer_data: unsupported("Connect is not modelled"),
    trial_end: { type: "integer" },
    trial_settings: unsupported("trial settings are not modelled"),
  },
  DeleteSubscriptionsSubscriptionExposedId: {
    cancellation_details: unsupported("cancellation details are not modelled"),
    invoice_now: unsupported("immediate invoicing is not modelled"),
    prorate: unsupported("proration is not modelled"),
  },
  PostSubscriptionSchedules: {
    customer: ref("customer", MISSING.customer),
    end_behavior: { type: "string", enum: ["cancel", "none", "release", "renew"] },
    metadata: { type: "object" },
    start_date: unsupported("schedule start dates are not modelled"),
    phases: { type: "array", maxItems: 3, items: { type: "object" } },
    expand: unsupported("the mock never expands this operation's response"),
  },
  PostSubscriptionSchedulesSchedule: {
    end_behavior: { type: "string", enum: ["cancel", "none", "release", "renew"] },
    metadata: { type: "object" },
    phases: { type: "array", maxItems: 3, items: { type: "object" } },
    default_settings: unsupported("schedule default settings are not modelled"),
    proration_behavior: unsupported("proration is not modelled"),
  },
  PostSubscriptionSchedulesScheduleCancel: {},
  PostSubscriptionSchedulesScheduleRelease: {},
  PostCoupons: {
    amount_off: { type: "integer", minimum: 1 },
    currency: CURRENCY,
    duration: { type: "string", enum: ["forever", "once", "repeating"] },
    duration_in_months: { type: "integer", minimum: 1 },
    max_redemptions: { type: "integer", minimum: 1 },
    name: { type: "string", maxLength: 40 },
    metadata: { type: "object" },
    percent_off: { type: "number" },
    redeem_by: { type: "integer" },
    applies_to: { type: "object" },
    currency_options: unsupported("multi-currency coupons are not modelled"),
    id: unsupported("caller-chosen ids are not modelled"),
  },
  PostCouponsCoupon: {
    metadata: { type: "object" },
    name: { type: "string", maxLength: 40 },
    applies_to: { type: "object" },
    currency_options: unsupported("multi-currency coupons are not modelled"),
  },
  PostPromotionCodes: {
    code: { type: "string", maxLength: 5000 },
    customer: ref("customer", MISSING.customer),
    expires_at: { type: "integer" },
    metadata: { type: "object" },
    active: { type: "boolean" },
    restrictions: { type: "object" },
    expand: unsupported("the mock never expands this operation's response"),
  },
  PostPromotionCodesPromotionCode: {
    active: { type: "boolean" },
    metadata: { type: "object" },
    restrictions: { type: "object" },
  },
  PostInvoicesInvoiceVoid: {},
  PostSubscriptionItems: {
    subscription: ref("subscription", MISSING.subscription),
    price: ref("price", MISSING.price),
    quantity: { type: "integer", minimum: 1, maximum: 10 },
    metadata: { type: "object" },
    billing_thresholds: unsupported("billing thresholds are not modelled"),
    discounts: unsupported("item discounts are not generated by parity walks"),
    payment_behavior: unsupported("proration payment behaviour is not generated by parity walks"),
    price_data: unsupported("inline prices are not generated by parity walks"),
    proration_date: unsupported("proration dates are not modelled"),
    tax_rates: unsupported("tax rates are not modelled"),
  },
  PostSubscriptionItemsItem: {
    price: ref("price", MISSING.price),
    quantity: { type: "integer", minimum: 1, maximum: 10 },
    metadata: { type: "object" },
    billing_thresholds: unsupported("billing thresholds are not modelled"),
    discounts: unsupported("item discounts are not generated by parity walks"),
    off_session: unsupported("off-session policy is not modelled"),
    payment_behavior: unsupported("proration payment behaviour is not generated by parity walks"),
    price_data: unsupported("inline prices are not generated by parity walks"),
    proration_date: unsupported("proration dates are not modelled"),
    tax_rates: unsupported("tax rates are not modelled"),
  },
  DeleteSubscriptionItemsItem: {
    clear_usage: unsupported("metered usage is not modelled"),
    proration_date: unsupported("proration dates are not modelled"),
  },
  PostTestHelpersTestClocks: {
    frozen_time: { type: "integer", ...scope("walk-start-unix") },
    name: { type: "string", maxLength: 300 },
    customer: unsupported("clock-scoped customers are created through POST /v1/customers"),
  },
  PostTestHelpersTestClocksTestClockAdvance: {
    frozen_time: { type: "integer", ...scope("walk-start-unix") },
  },
  PostWebhookEndpoints: {
    url: { type: "string", maxLength: 5000, pattern: "^https://example\\.com/[a-z]{1,12}$" },
    description: { type: "string", maxLength: 5000 },
    metadata: { type: "object" },
    connect: unsupported("Connect is not modelled"),
    api_version: unsupported("endpoints deliver at the account's API version"),
  },
  PostWebhookEndpointsWebhookEndpoint: {
    url: { type: "string", maxLength: 5000, pattern: "^https://example\\.com/[a-z]{1,12}$" },
    description: { type: "string", maxLength: 5000 },
    metadata: { type: "object" },
    disabled: { type: "boolean" },
  },
}

/** Query-parameter edits keyed by operationId; `null` deletes the parameter. */
const QUERY_SHAPES: Record<string, Shape> = {
  GetCustomers: {
    "created.gte": scope("walk-start-unix"),
    ending_before: ref("customer", MISSING.customer),
    starting_after: ref("customer", MISSING.customer),
    test_clock: unsupported("test clocks are not modelled"),
  },
  GetCustomersCustomer: {},
  GetProducts: {
    "created.gte": scope("walk-start-unix"),
    ending_before: ref("product", MISSING.product),
    starting_after: ref("product", MISSING.product),
    "ids[]": ref("product", MISSING.product),
  },
  GetProductsId: {},
  GetPrices: {
    currency: CURRENCY,
    lookup_keys: { type: "array", maxItems: 10, items: { type: "string", maxLength: 5000 } },
    "created.gte": scope("walk-start-unix"),
    ending_before: ref("price", MISSING.price),
    starting_after: ref("price", MISSING.price),
    product: ref("product", MISSING.product),
    "recurring.meter": unsupported("billing meters are not modelled"),
  },
  GetPricesPrice: {},
  GetCustomersSearch: {},
  GetPaymentMethods: {
    customer: ref("customer", MISSING.customer),
    starting_after: ref("payment_method", MISSING.payment_method),
    ending_before: ref("payment_method", MISSING.payment_method),
  },
  GetPaymentMethodsPaymentMethod: {},
  GetPaymentIntents: {
    customer: ref("customer", MISSING.customer),
    starting_after: ref("payment_intent", MISSING.payment_intent),
    ending_before: ref("payment_intent", MISSING.payment_intent),
    "created.gte": scope("walk-start-unix"),
  },
  GetPaymentIntentsSearch: {},
  GetPaymentIntentsIntent: {},
  GetSetupIntents: {
    customer: ref("customer", MISSING.customer),
    starting_after: ref("setup_intent", MISSING.setup_intent),
    ending_before: ref("setup_intent", MISSING.setup_intent),
    "created.gte": scope("walk-start-unix"),
  },
  GetSetupIntentsIntent: {},
  GetCharges: {
    customer: ref("customer", MISSING.customer),
    payment_intent: ref("payment_intent", MISSING.payment_intent),
    starting_after: ref("charge", MISSING.charge),
    ending_before: ref("charge", MISSING.charge),
    "created.gte": scope("walk-start-unix"),
  },
  GetChargesCharge: {},
  GetRefunds: {
    charge: ref("charge", MISSING.charge),
    payment_intent: ref("payment_intent", MISSING.payment_intent),
    starting_after: ref("refund", MISSING.refund),
    ending_before: ref("refund", MISSING.refund),
  },
  GetRefundsRefund: {},
  GetDisputes: {
    charge: ref("charge", MISSING.charge),
    payment_intent: ref("payment_intent", MISSING.payment_intent),
    starting_after: ref("dispute", MISSING.dispute),
    ending_before: ref("dispute", MISSING.dispute),
    "created.gte": scope("walk-start-unix"),
  },
  GetDisputesDispute: {},
  GetCheckoutSessions: {
    customer: ref("customer", MISSING.customer),
    payment_intent: ref("payment_intent", MISSING.payment_intent),
    subscription: ref("subscription", MISSING.subscription),
    starting_after: ref("session", MISSING.session),
    ending_before: ref("session", MISSING.session),
    "created.gte": scope("walk-start-unix"),
  },
  GetCheckoutSessionsSession: {},
  GetCheckoutSessionsSessionLineItems: {
    starting_after: unsupported("line item cursors are not modelled"),
    ending_before: unsupported("line item cursors are not modelled"),
  },
  GetInvoices: {
    customer: ref("customer", MISSING.customer),
    subscription: ref("subscription", MISSING.subscription),
    starting_after: ref("invoice", MISSING.invoice),
    ending_before: ref("invoice", MISSING.invoice),
    "created.gte": scope("walk-start-unix"),
  },
  GetInvoicesInvoice: {},
  GetInvoicesInvoiceLines: {
    starting_after: unsupported("line item cursors are not modelled"),
    ending_before: unsupported("line item cursors are not modelled"),
  },
  GetInvoiceitems: {
    customer: ref("customer", MISSING.customer),
    invoice: ref("invoice", MISSING.invoice),
    starting_after: ref("invoiceitem", MISSING.invoiceitem),
    ending_before: ref("invoiceitem", MISSING.invoiceitem),
    "created.gte": scope("walk-start-unix"),
  },
  GetInvoiceitemsInvoiceitem: {},
  GetSubscriptions: {
    customer: ref("customer", MISSING.customer),
    starting_after: ref("subscription", MISSING.subscription),
    ending_before: ref("subscription", MISSING.subscription),
    "created.gte": scope("walk-start-unix"),
  },
  GetSubscriptionsSubscriptionExposedId: {},
  GetSubscriptionItems: {
    subscription: ref("subscription", MISSING.subscription),
    starting_after: ref("subscription_item", MISSING.subscription_item),
    ending_before: ref("subscription_item", MISSING.subscription_item),
  },
  GetSubscriptionItemsItem: {},
  GetSubscriptionSchedules: {
    customer: ref("customer", MISSING.customer),
    starting_after: ref("schedule", MISSING.schedule),
    ending_before: ref("schedule", MISSING.schedule),
    "created.gte": scope("walk-start-unix"),
  },
  GetSubscriptionSchedulesSchedule: {},
  GetCoupons: {
    starting_after: ref("coupon", MISSING.coupon),
    ending_before: ref("coupon", MISSING.coupon),
    "created.gte": scope("walk-start-unix"),
  },
  GetCouponsCoupon: {},
  GetPromotionCodes: {
    customer: ref("customer", MISSING.customer),
    coupon: ref("coupon", MISSING.coupon),
    starting_after: ref("promotion_code", MISSING.promotion_code),
    ending_before: ref("promotion_code", MISSING.promotion_code),
    "created.gte": scope("walk-start-unix"),
  },
  GetPromotionCodesPromotionCode: {},
  GetProductsSearch: {},
  GetEvents: {
    starting_after: ref("event", MISSING.event),
    ending_before: ref("event", MISSING.event),
    "created.gte": scope("walk-start-unix"),
  },
  GetEventsId: {},
  GetBalanceTransactions: {
    "created.gte": scope("walk-start-unix"),
    starting_after: ref("balance_transaction", MISSING.balance_transaction),
    ending_before: ref("balance_transaction", MISSING.balance_transaction),
    payout: unsupported("payouts are not modelled"),
    source: ref("charge", MISSING.charge),
  },
  GetBalanceTransactionsId: {},
  GetTestHelpersTestClocks: {
    starting_after: ref("test_clock", MISSING.test_clock),
    ending_before: ref("test_clock", MISSING.test_clock),
  },
  GetWebhookEndpoints: {
    starting_after: ref("webhook_endpoint", MISSING.webhook_endpoint),
    ending_before: ref("webhook_endpoint", MISSING.webhook_endpoint),
  },
}

/**
 * Body parameters the pinned upstream spec no longer publishes but the SDK version the suites pin still
 * sends. They are added to the form schema without joining `required`, so the request is accepted
 * (and either modelled or explicitly unsupported) instead of failing as an unknown parameter.
 */
const EXTRA_BODY_PARAMS: Record<string, Shape> = {
  PostInvoiceitems: { price: ref("price", MISSING.price) },
  PostInvoiceitemsInvoiceitem: { price: ref("price", MISSING.price) },
  PostCouponsCoupon: { applies_to: { type: "object" } },
  PostPromotionCodes: { coupon: ref("coupon", MISSING.coupon) },
  PostSubscriptions: { pause_collection: unsupported("collection pausing is not modelled") },
  PostSubscriptionsSubscriptionExposedId: {
    pause_collection: unsupported("collection pausing is not modelled"),
  },
}

/**
 * Stripe.js sends raw card details as `payment_method_data[card][number|exp_month|exp_year|cvc]`
 * with a publishable key; the public spec omits that branch. The mock's Stripe.js stand-in and
 * hosted page do the same, so these operations accept it (the generator never sends it).
 */
const RAW_CARD_OPERATIONS = [
  "PostPaymentIntents",
  "PostPaymentIntentsIntentConfirm",
  "PostSetupIntents",
  "PostSetupIntentsIntentConfirm",
]

const acceptRawCard = (operation: Json) => {
  const body = operation.requestBody as Json | undefined
  const form = (body?.content as Json | undefined)?.["application/x-www-form-urlencoded"] as
    | Json
    | undefined
  const properties = (form?.schema as Json | undefined)?.properties as Json | undefined
  const data = properties?.payment_method_data as Json | undefined
  if (!data || !isObject(data.properties)) throw new Error("payment_method_data has no properties")
  const type = (data.properties as Json).type as Json | undefined
  if (type && Array.isArray(type.enum) && !type.enum.includes("card"))
    type.enum = [...(type.enum as string[]), "card"].sort()
  ;(data.properties as Json).card = {
    type: "object",
    additionalProperties: true,
    ...unsupported("raw card details come only from the Stripe.js stand-in"),
  }
}

const applyExtraBodyParams = (schema: Schema, shape: Shape) => {
  const properties = isObject(schema.properties) ? (schema.properties as Json) : {}
  schema.properties = properties
  for (const [key, edit] of Object.entries(shape)) {
    if (edit === null) {
      delete properties[key]
      continue
    }
    properties[key] = { ...(isObject(properties[key]) ? (properties[key] as Json) : {}), ...edit }
  }
}

/**
 * Path-parameter resource refs. A parameter name can mean different resources on different routes
 * (`{intent}` is a payment intent on `/v1/payment_intents/...` and a setup intent on
 * `/v1/setup_intents/...`), so prefix groups are checked before the bare-name fallback.
 */
const PATH_REFS: Record<string, Json> = {
  customer: ref("customer", MISSING.customer),
  price: ref("price", MISSING.price),
  payment_method: ref("payment_method", MISSING.payment_method),
  charge: ref("charge", MISSING.charge),
  refund: ref("refund", MISSING.refund),
  dispute: ref("dispute", MISSING.dispute),
  invoice: ref("invoice", MISSING.invoice),
  invoiceitem: ref("invoiceitem", MISSING.invoiceitem),
  subscription_exposed_id: ref("subscription", MISSING.subscription),
  schedule: ref("schedule", MISSING.schedule),
  coupon: ref("coupon", MISSING.coupon),
  promotion_code: ref("promotion_code", MISSING.promotion_code),
  session: ref("session", MISSING.session),
  webhook_endpoint: ref("webhook_endpoint", MISSING.webhook_endpoint),
  "/c/3ds/{intent}/authenticate#intent": ref("payment_intent", MISSING.payment_intent),
}

const PATH_REF_GROUPS: readonly { prefix: string; refs: Record<string, Json> }[] = [
  {
    prefix: "/v1/payment_intents",
    refs: { intent: ref("payment_intent", MISSING.payment_intent) },
  },
  {
    prefix: "/v1/setup_intents",
    refs: { intent: ref("setup_intent", MISSING.setup_intent) },
  },
  {
    prefix: "/v1/subscription_items",
    refs: { item: ref("subscription_item", MISSING.subscription_item) },
  },
  { prefix: "/v1/events", refs: { id: ref("event", MISSING.event) } },
  {
    prefix: "/v1/balance_transactions",
    refs: { id: ref("balance_transaction", MISSING.balance_transaction) },
  },
  { prefix: "/v1/products", refs: { id: ref("product", MISSING.product) } },
  {
    prefix: "/v1/test_helpers/test_clocks",
    refs: { test_clock: ref("test_clock", MISSING.test_clock) },
  },
]

const pathRefFor = (path: string, name: string): Json | undefined => {
  const group = PATH_REF_GROUPS.find((candidate) => path.startsWith(candidate.prefix))
  return group?.refs[name] ?? PATH_REFS[name]
}

export type OperationConfig = {
  /** `false` for anything that must not run against a real account (money movement, deletes). */
  safe: boolean
  /** `false` skips the differential runner entirely; requires a reason. */
  parity?: boolean
  /** `false` declares a documented gap: the mock answers a Stripe-shaped error. Requires a reason. */
  supported?: boolean
  reason?: string
}

const OPERATIONS: Record<string, OperationConfig> = {
  // customers
  PostCustomers: { safe: true },
  GetCustomers: { safe: true },
  GetCustomersSearch: { safe: true },
  GetCustomersCustomer: { safe: true },
  PostCustomersCustomer: { safe: true },
  DeleteCustomersCustomer: { safe: true },
  GetCustomersCustomerBalanceTransactions: { safe: true },
  PostCustomersCustomerBalanceTransactions: { safe: false },
  // payment methods
  GetPaymentMethods: { safe: true },
  PostPaymentMethods: { safe: false },
  GetPaymentMethodsPaymentMethod: { safe: true },
  PostPaymentMethodsPaymentMethod: { safe: false },
  PostPaymentMethodsPaymentMethodAttach: { safe: false },
  PostPaymentMethodsPaymentMethodDetach: { safe: false },
  // payment intents
  GetPaymentIntents: { safe: true },
  PostPaymentIntents: { safe: false },
  GetPaymentIntentsSearch: { safe: true },
  GetPaymentIntentsIntent: { safe: true },
  PostPaymentIntentsIntent: { safe: false },
  PostPaymentIntentsIntentConfirm: { safe: false },
  PostPaymentIntentsIntentCancel: { safe: false },
  PostPaymentIntentsIntentCapture: { safe: false },
  // setup intents
  GetSetupIntents: { safe: true },
  PostSetupIntents: { safe: false },
  GetSetupIntentsIntent: { safe: true },
  PostSetupIntentsIntent: { safe: false },
  PostSetupIntentsIntentConfirm: { safe: false },
  PostSetupIntentsIntentCancel: { safe: false },
  // charges, refunds, disputes
  GetCharges: { safe: true },
  PostCharges: {
    safe: false,
    supported: false,
    reason: "charges are always created through PaymentIntents",
  },
  GetChargesCharge: { safe: true },
  PostChargesCharge: {
    safe: false,
    supported: false,
    reason: "charges are only read in the e2e path",
  },
  GetRefunds: { safe: true },
  PostRefunds: { safe: false },
  GetRefundsRefund: { safe: true },
  PostRefundsRefund: { safe: false },
  GetDisputes: { safe: true },
  GetDisputesDispute: { safe: true },
  PostDisputesDispute: {
    safe: false,
    supported: false,
    reason: "the mock never creates or mutates disputes",
  },
  GetBalanceTransactions: { safe: true },
  GetBalanceTransactionsId: { safe: true },
  // account
  GetAccount: { safe: true },
  GetBalance: { safe: true },
  // checkout
  GetCheckoutSessions: { safe: true },
  PostCheckoutSessions: { safe: false },
  GetCheckoutSessionsSession: { safe: true },
  PostCheckoutSessionsSession: {
    safe: false,
    supported: false,
    reason: "sessions complete through their payment intent, never by update",
  },
  PostCheckoutSessionsSessionExpire: { safe: false },
  GetCheckoutSessionsSessionLineItems: { safe: true },
  // invoices
  GetInvoices: { safe: true },
  PostInvoices: { safe: false },
  GetInvoicesInvoice: { safe: true },
  PostInvoicesInvoice: { safe: false },
  DeleteInvoicesInvoice: { safe: false },
  PostInvoicesInvoiceFinalize: { safe: false },
  PostInvoicesInvoicePay: { safe: false },
  PostInvoicesInvoiceVoid: { safe: false },
  GetInvoicesInvoiceLines: { safe: true },
  GetInvoicesUpcoming: {
    safe: false,
    parity: false,
    reason:
      "route is absent from the pinned upstream spec (2026-08-26.dahlia previews invoices instead); the e2e SDK still calls it",
  },
  // invoice items
  GetInvoiceitems: { safe: true },
  PostInvoiceitems: { safe: false },
  GetInvoiceitemsInvoiceitem: { safe: true },
  PostInvoiceitemsInvoiceitem: { safe: false },
  DeleteInvoiceitemsInvoiceitem: { safe: false },
  // subscriptions
  GetSubscriptions: { safe: true },
  PostSubscriptions: { safe: false },
  GetSubscriptionsSubscriptionExposedId: { safe: true },
  PostSubscriptionsSubscriptionExposedId: { safe: false },
  DeleteSubscriptionsSubscriptionExposedId: { safe: false },
  GetSubscriptionItems: { safe: true },
  PostSubscriptionItems: { safe: false },
  GetSubscriptionItemsItem: { safe: true },
  PostSubscriptionItemsItem: { safe: false },
  DeleteSubscriptionItemsItem: { safe: false },
  // subscription schedules
  GetSubscriptionSchedules: { safe: true },
  PostSubscriptionSchedules: { safe: false },
  GetSubscriptionSchedulesSchedule: { safe: true },
  PostSubscriptionSchedulesSchedule: { safe: false },
  PostSubscriptionSchedulesScheduleCancel: { safe: false },
  PostSubscriptionSchedulesScheduleRelease: { safe: false },
  // coupons and promotion codes
  GetCoupons: { safe: true },
  PostCoupons: { safe: false },
  GetCouponsCoupon: { safe: true },
  PostCouponsCoupon: { safe: false },
  DeleteCouponsCoupon: { safe: false },
  GetPromotionCodes: { safe: true },
  PostPromotionCodes: { safe: false },
  GetPromotionCodesPromotionCode: { safe: true },
  PostPromotionCodesPromotionCode: { safe: false },
  // products and prices
  PostProducts: { safe: true },
  GetProducts: { safe: true },
  GetProductsSearch: { safe: true },
  GetProductsId: { safe: true },
  PostProductsId: { safe: true },
  DeleteProductsId: { safe: true },
  PostPrices: { safe: true },
  GetPrices: { safe: true },
  GetPricesPrice: { safe: true },
  PostPricesPrice: { safe: true },
  // events
  GetEvents: { safe: true },
  GetEventsId: { safe: true },
  // test clocks (safe: they only exist in test mode and delete themselves)
  PostTestHelpersTestClocks: { safe: false },
  GetTestHelpersTestClocks: { safe: true },
  GetTestHelpersTestClocksTestClock: { safe: true },
  PostTestHelpersTestClocksTestClockAdvance: { safe: false },
  DeleteTestHelpersTestClocksTestClock: { safe: false },
  // webhook endpoints (unsafe: a real endpoint would start receiving deliveries)
  GetWebhookEndpoints: { safe: true },
  PostWebhookEndpoints: { safe: false },
  GetWebhookEndpointsWebhookEndpoint: { safe: true },
  PostWebhookEndpointsWebhookEndpoint: { safe: false },
  DeleteWebhookEndpointsWebhookEndpoint: { safe: false },
  // browser surfaces served by the mock itself (see SYNTHETIC_OPERATIONS)
  GetCheckoutPage: {
    safe: true,
    parity: false,
    reason: "the hosted Checkout page is HTML served by the mock in place of checkout.stripe.com",
  },
  PostCheckoutPage: {
    safe: false,
    parity: false,
    reason:
      "the hosted Checkout page form post is served by the mock in place of checkout.stripe.com",
  },
  GetStripeJs: {
    safe: true,
    parity: false,
    reason: "the Stripe.js stand-in is JavaScript served by the mock in place of js.stripe.com/v3",
  },
  PostThreeDSecureAuthenticate: {
    safe: false,
    parity: false,
    reason: "the 3-D Secure challenge the Stripe.js stand-in completes has no public API",
  },
}

/**
 * Expansion paths the mock actually resolves, per operation. Operations without an entry (or with
 * an empty list) declare `expand` unsupported, so the command generator never asks for an
 * expansion the mock would silently ignore.
 */
const EXPAND_PATHS: Record<string, readonly string[]> = {
  PostCustomers: ["invoice_settings.default_payment_method"],
  GetCustomers: ["data.invoice_settings.default_payment_method"],
  GetCustomersCustomer: ["invoice_settings.default_payment_method"],
  PostCustomersCustomer: ["invoice_settings.default_payment_method"],
  GetPaymentMethods: ["data.customer"],
  GetPaymentMethodsPaymentMethod: ["customer"],
  PostPaymentMethodsPaymentMethod: ["customer"],
  GetPaymentIntents: ["data.latest_charge", "data.payment_method", "data.invoice", "data.customer"],
  PostPaymentIntents: ["latest_charge", "payment_method", "invoice"],
  GetPaymentIntentsSearch: ["data.latest_charge", "data.payment_method", "data.invoice"],
  GetBalanceTransactions: ["data.source"],
  GetBalanceTransactionsId: ["source"],
  PostInvoicesInvoiceVoid: ["charge", "subscription", "payment_intent"],
  PostSubscriptionItems: ["price", "discounts"],
  PostSubscriptionItemsItem: ["price", "discounts"],
  GetSubscriptionItems: ["data.discounts", "data.price"],
  GetSubscriptionItemsItem: ["discounts", "price"],
  GetAccount: [],
  GetBalance: [],
  PostTestHelpersTestClocks: [],
  GetTestHelpersTestClocks: [],
  GetTestHelpersTestClocksTestClock: [],
  PostTestHelpersTestClocksTestClockAdvance: [],
  GetWebhookEndpoints: [],
  PostWebhookEndpoints: [],
  GetWebhookEndpointsWebhookEndpoint: [],
  PostWebhookEndpointsWebhookEndpoint: [],
  GetPaymentIntentsIntent: [
    "latest_charge",
    "payment_method",
    "invoice",
    "invoice.discounts.coupon",
    "invoice.subscription",
    "customer",
  ],
  PostPaymentIntentsIntent: ["latest_charge", "payment_method", "invoice"],
  PostPaymentIntentsIntentConfirm: ["latest_charge", "payment_method", "invoice"],
  PostPaymentIntentsIntentCancel: ["latest_charge", "payment_method", "invoice"],
  PostPaymentIntentsIntentCapture: ["latest_charge", "payment_method", "invoice"],
  GetSetupIntents: ["data.payment_method", "data.customer"],
  PostSetupIntents: ["payment_method", "customer"],
  GetSetupIntentsIntent: ["payment_method", "customer"],
  PostSetupIntentsIntent: ["payment_method", "customer"],
  PostSetupIntentsIntentConfirm: ["payment_method", "customer"],
  PostSetupIntentsIntentCancel: ["payment_method", "customer"],
  GetCharges: [
    "data.invoice",
    "data.invoice.discounts.coupon",
    "data.payment_intent",
    "data.payment_intent.invoice",
    "data.customer",
  ],
  GetChargesCharge: [
    "invoice",
    "invoice.discounts.coupon",
    "payment_intent",
    "payment_intent.invoice",
    "customer",
    "payment_method",
  ],
  GetRefunds: ["data.charge", "data.payment_intent"],
  PostRefunds: ["charge", "payment_intent"],
  GetRefundsRefund: ["charge", "payment_intent"],
  PostRefundsRefund: ["charge", "payment_intent"],
  GetCheckoutSessions: [
    "data.payment_intent",
    "data.subscription",
    "data.setup_intent",
    "data.customer",
  ],
  PostCheckoutSessions: ["payment_intent", "subscription", "setup_intent", "customer"],
  GetCheckoutSessionsSession: ["payment_intent", "subscription", "setup_intent", "customer"],
  PostCheckoutSessionsSessionExpire: ["payment_intent", "subscription", "setup_intent", "customer"],
  GetInvoices: [
    "data.charge",
    "data.subscription",
    "data.payment_intent",
    "data.discounts.coupon",
    "data.customer",
  ],
  PostInvoices: ["charge", "subscription", "payment_intent", "discounts.coupon", "customer"],
  GetInvoicesInvoice: [
    "charge",
    "subscription",
    "payment_intent",
    "discount.coupon",
    "discount.promotion_code",
    "discounts.coupon",
    "discounts.promotion_code",
    "customer",
    "default_payment_method",
  ],
  PostInvoicesInvoice: ["charge", "subscription", "payment_intent", "discounts.coupon"],
  PostInvoicesInvoiceFinalize: ["charge", "subscription", "payment_intent"],
  PostInvoicesInvoicePay: ["charge", "subscription", "payment_intent"],
  PostGetInvoicesUpcoming: [],
  GetInvoiceitems: ["data.customer", "data.price"],
  PostInvoiceitems: ["customer", "invoice", "price"],
  GetInvoiceitemsInvoiceitem: ["customer", "invoice", "price"],
  PostInvoiceitemsInvoiceitem: ["customer", "invoice", "price"],
  GetSubscriptions: [
    "data.discounts.coupon",
    "data.latest_invoice",
    "data.default_payment_method",
    "data.customer",
  ],
  PostSubscriptions: [
    "discounts",
    "discounts.coupon",
    "latest_invoice",
    "latest_invoice.payment_intent",
    "default_payment_method",
    "customer",
    "schedule",
  ],
  GetSubscriptionsSubscriptionExposedId: [
    "discounts",
    "discounts.coupon",
    "discounts.promotion_code",
    "items.data.discounts",
    "items.data.price",
    "latest_invoice",
    "default_payment_method",
    "customer",
    "schedule",
  ],
  PostSubscriptionsSubscriptionExposedId: [
    "discounts",
    "discounts.coupon",
    "latest_invoice",
    "default_payment_method",
    "customer",
    "schedule",
  ],
  DeleteSubscriptionsSubscriptionExposedId: ["latest_invoice", "customer"],
  GetSubscriptionSchedules: ["data.subscription", "data.customer"],
  PostSubscriptionSchedules: ["subscription", "customer"],
  GetSubscriptionSchedulesSchedule: ["subscription", "customer"],
  PostSubscriptionSchedulesSchedule: ["subscription", "customer"],
  GetCoupons: ["data.applies_to"],
  PostCoupons: ["applies_to"],
  GetCouponsCoupon: ["applies_to"],
  PostCouponsCoupon: ["applies_to"],
  GetPromotionCodes: ["data.coupon", "data.coupon.applies_to", "data.customer"],
  PostPromotionCodes: ["coupon", "coupon.applies_to", "customer"],
  GetPromotionCodesPromotionCode: ["coupon", "coupon.applies_to", "customer"],
  PostPromotionCodesPromotionCode: ["coupon", "coupon.applies_to", "customer"],
  PostProducts: [],
  GetProducts: ["data.default_price"],
  GetProductsId: ["default_price"],
  PostProductsId: ["default_price"],
  PostPrices: ["product", "product_data"],
  GetPrices: ["data.product"],
  GetPricesPrice: ["product"],
  PostPricesPrice: ["product"],
}

// --- transforms --------------------------------------------------------------------------------

/** Strip prose and Stripe-only extensions; normalise `nullable` to a 3.1 type union. */
const clean = (value: unknown, propertyMap = false): unknown => {
  if (Array.isArray(value)) return value.map((item) => clean(item))
  if (!isObject(value)) return value
  const out: Json = {}
  for (const [key, inner] of Object.entries(value)) {
    if (propertyMap) {
      out[key] = clean(inner)
      continue
    }
    if (
      key === "description" ||
      key === "x-expandableFields" ||
      key === "x-expansionResources" ||
      key === "x-resourceId" ||
      key === "x-stripeResource" ||
      key === "x-stripeOperations" ||
      key === "x-stripeMostCommon" ||
      key === "x-stripeBypassValidation" ||
      key === "x-stripeParam"
    )
      continue
    out[key] = clean(inner, key === "properties")
  }
  if (out.nullable === true) {
    delete out.nullable
    if (typeof out.type === "string") out.type = [out.type, "null"]
    else if (Array.isArray(out.anyOf)) out.anyOf = [...(out.anyOf as unknown[]), { type: "null" }]
    else if (Array.isArray(out.oneOf)) out.oneOf = [...(out.oneOf as unknown[]), { type: "null" }]
    else if (out.$ref) {
      out.anyOf = [{ $ref: out.$ref }, { type: "null" }]
      delete out.$ref
    }
  }
  return out
}

/** Locate a (possibly nested) property inside a schema, descending into anyOf object branches. */
const propertyContainer = (schema: Schema, path: string[]): Schema | undefined => {
  let current: Schema | undefined = schema
  for (const segment of path) {
    if (!current) return undefined
    const properties = isObject(current.properties) ? current.properties : undefined
    let next: Schema | undefined =
      properties && isObject(properties[segment]) ? (properties[segment] as Schema) : undefined
    if (!next && Array.isArray(current.anyOf)) {
      for (const branch of current.anyOf) {
        if (isObject(branch) && isObject(branch.properties) && isObject(branch.properties[segment]))
          next = branch.properties[segment] as Schema
      }
    }
    if (!next) return undefined
    current = next
  }
  return current
}

const parentAndKey = (path: string): [string[], string] => {
  const segments = path.split(".")
  const key = segments.pop() ?? path
  return [segments, key]
}

const applyShape = (schema: Schema, shape: Shape, label: string) => {
  for (const [path, edit] of Object.entries(shape)) {
    if (path.endsWith("[]")) {
      const [arrayParent, arrayKey] = parentAndKey(path.slice(0, -2))
      const target = propertyContainer(schema, [...arrayParent, arrayKey])
      if (!target || !isObject(target.items))
        throw new Error(`${label}: array property ${path} not found`)
      if (edit === null) throw new Error(`${label}: cannot delete array items ${path}`)
      target.items = { ...target.items, ...edit }
      continue
    }
    const [parentPath, key] = parentAndKey(path)
    const parent = parentPath.length === 0 ? schema : propertyContainer(schema, parentPath)
    const containers: Schema[] = []
    if (parent) {
      if (isObject(parent.properties)) containers.push(parent.properties)
      if (Array.isArray(parent.anyOf))
        for (const branch of parent.anyOf)
          if (isObject(branch) && isObject(branch.properties)) containers.push(branch.properties)
    }
    let holder = containers.find((c) => isObject(c[key]))
    if (
      !holder &&
      edit !== null &&
      parent &&
      isObject(parent.properties) &&
      Object.keys(edit).some((k) => !k.startsWith("x-mockingbird"))
    ) {
      holder = parent.properties
      holder[key] = {}
      if (Array.isArray(parent.required))
        parent.required = [...(parent.required as string[]), key].sort()
    }
    if (!holder) throw new Error(`${label}: property ${path} not found`)
    if (edit === null) {
      delete holder[key]
      if (Array.isArray(parent?.required))
        parent.required = (parent.required as string[]).filter((r) => r !== key)
      continue
    }
    const existing = holder[key] as Schema
    const replacesSchema = Object.keys(edit).some((k) => !k.startsWith("x-mockingbird"))
    holder[key] = replacesSchema ? { ...edit } : { ...existing, ...edit }
  }
}

/**
 * Open object schemas the vendored doc leaves as bare `{type: "object"}`.
 *
 * Form validation treats an object as closed unless it declares `additionalProperties`, so a bare
 * object rejects every nested key (`metadata[k]=v`, `items[0][price]=…`, `phases[0][items]`) with
 * `parameter_unknown`. Stripe accepts those keys, so the vendored contract declares the objects
 * open: `metadata` keeps its documented string→string typing, anything else accepts free-form
 * values instead of refusing the request.
 */
const openBareObjects = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(openBareObjects)
  if (!isObject(value)) return value
  for (const [key, inner] of Object.entries(value)) value[key] = openBareObjects(inner)
  const isBareObject =
    value.type === "object" &&
    value.properties === undefined &&
    value.additionalProperties === undefined &&
    value.$ref === undefined &&
    value.anyOf === undefined &&
    value.oneOf === undefined &&
    value.allOf === undefined
  if (isBareObject) value.additionalProperties = true
  return value
}

const metadataSchema = (): Schema => ({
  anyOf: [
    {
      additionalProperties: { maxLength: 500, type: "string" },
      maxProperties: 50,
      type: "object",
    },
    { enum: [""], type: "string" },
  ],
})

/** Type every `metadata` field (top level and inside `*_data` objects) as string→string. */
const shapeMetadata = (operation: Json) => {
  const parameters = Array.isArray(operation.parameters) ? (operation.parameters as Json[]) : []
  for (const parameter of parameters) {
    if (parameter.name === "metadata" && isObject(parameter.schema))
      parameter.schema = metadataSchema()
  }
  const body = isObject(operation.requestBody) ? operation.requestBody : undefined
  const content = body && isObject(body.content) ? (body.content as Json) : undefined
  const form = content?.["application/x-www-form-urlencoded"]
  const schema = isObject(form) && isObject(form.schema) ? form.schema : undefined
  const properties = schema && isObject(schema.properties) ? schema.properties : undefined
  if (properties === undefined) return
  if (isObject(properties.metadata)) properties.metadata = metadataSchema()
  for (const [key, value] of Object.entries(properties)) {
    if (!key.endsWith("_data") || !isObject(value)) continue
    const nested = isObject(value.properties) ? value.properties : undefined
    if (nested !== undefined && isObject(nested.metadata)) nested.metadata = metadataSchema()
  }
}

const collectRefs = (value: unknown, out: Set<string>) => {
  if (Array.isArray(value)) for (const v of value) collectRefs(v, out)
  else if (isObject(value)) {
    if (typeof value.$ref === "string") {
      const name = value.$ref.replace("#/components/schemas/", "")
      out.add(name)
    }
    for (const v of Object.values(value)) collectRefs(v, out)
  }
}
/**
 * Narrow (or reject) the `expand` parameter for every operation, in whichever place it appears:
 * a query parameter on reads, a form-body property on writes. Operations without declared paths
 * get the unsupported stamp so the generator never asks for an expansion the mock ignores.
 */
const shapeExpand = (operation: Json, operationId: string) => {
  const paths = EXPAND_PATHS[operationId]
  const apply = (holder: Json | undefined) => {
    if (!holder) return
    if (!paths || paths.length === 0) {
      Object.assign(holder, unsupported("the mock never expands this operation's response"))
      return
    }
    holder.items = { type: "string", enum: [...paths] }
    holder.maxItems = paths.length
  }
  const parameters = Array.isArray(operation.parameters) ? (operation.parameters as Json[]) : []
  for (const parameter of parameters) {
    if (parameter.name === "expand" && isObject(parameter.schema)) apply(parameter.schema)
  }
  const body = isObject(operation.requestBody) ? operation.requestBody : undefined
  const content = body && isObject(body.content) ? (body.content as Json) : undefined
  const form = content?.["application/x-www-form-urlencoded"]
  const schema = isObject(form) && isObject(form.schema) ? form.schema : undefined
  const properties = schema && isObject(schema.properties) ? schema.properties : undefined
  const expand = properties && isObject(properties.expand) ? properties.expand : undefined
  apply(expand)
}

/** Operation-level Mockingbird metadata driven by the allowlist entry. */
const stampOperation = (operation: Json, config: OperationConfig, label: string) => {
  const supported = config.supported ?? true
  const parity = config.parity ?? supported
  if ((!supported || !parity) && config.reason === undefined)
    throw new Error(`${label}: unsupported/parity-disabled operations need a reason`)
  operation["x-mockingbird"] = {
    supported,
    ...(config.reason === undefined ? {} : { reason: config.reason }),
    parity: {
      enabled: parity,
      safe: config.safe,
      ...(config.reason === undefined ? {} : { reason: config.reason }),
    },
  }
}

/**
 * Give every operation its error responses and mark the parity header.
 *
 * Stripe's published spec declares only the success response (errors ride a `default`), but the
 * mock answers real Stripe-shaped 400/402/404 bodies, so the contract has to declare those
 * statuses or every rejected request fails mock-conformance validation.
 */
const parityHeaders = (operation: Json) => {
  const responses = (operation.responses as Record<string, Json>) ?? {}
  operation.responses = responses
  for (const status of ["400", "402", "404"]) {
    if (responses[status] !== undefined) continue
    // Stripe's error envelope, so `request_log_url` is treated as volatile when compared.
    responses[status] = {
      content: { "application/json": { schema: { $ref: "#/components/schemas/error" } } },
    }
  }
  for (const response of Object.values(responses)) {
    response.headers = {
      "content-type": {
        schema: { type: "string", enum: ["application/json"] },
        "x-mockingbird-parity-header": true,
      },
    }
  }
  // Stripe's edge (nginx) answers an over-long request line with an HTML 414.
  responses["414"] = {
    description: "Request-URI Too Large (nginx)",
    headers: {
      "content-type": {
        schema: { type: "string", enum: ["text/html"] },
        "x-mockingbird-parity-header": true,
      },
    },
    content: { "text/html": { schema: { type: "string" } } },
  }
}

/**
 * Routes the e2e clients call that the pinned upstream spec no longer publishes. `GET
 * /v1/invoices/upcoming` disappeared in favour of `POST /v1/invoices/create_preview`, but
 * stripe-node at the version the suites pin still issues the GET, so the mock declares it by hand and
 * disables differential parity for it (the real side would answer for a different API version).
 */
const SYNTHETIC_OPERATIONS: readonly { path: string; method: string; operation: Json }[] = [
  {
    path: "/v1/invoices/upcoming",
    method: "get",
    operation: {
      operationId: "GetInvoicesUpcoming",
      parameters: [
        {
          name: "customer",
          in: "query",
          schema: { type: "string", ...ref("customer", MISSING.customer) },
        },
        {
          name: "subscription",
          in: "query",
          schema: { type: "string", ...ref("subscription", MISSING.subscription) },
        },
        {
          name: "schedule",
          in: "query",
          schema: { type: "string", ...unsupported("renewal scheduling is not modelled") },
        },
        {
          name: "discounts[]",
          in: "query",
          schema: {
            type: "array",
            maxItems: 10,
            items: { type: "string", ...unsupported("preview discounts are not modelled") },
          },
        },
        {
          name: "invoice_items[]",
          in: "query",
          schema: {
            type: "array",
            maxItems: 10,
            items: { type: "string", ...unsupported("preview invoice items are not modelled") },
          },
        },
        {
          name: "subscription_details",
          in: "query",
          schema: {
            type: "string",
            ...unsupported("preview subscription details are not modelled"),
          },
        },
        {
          name: "customer_details",
          in: "query",
          schema: { type: "string", ...unsupported("preview customer details are not modelled") },
        },
      ],
      responses: {
        "200": {
          content: { "application/json": { schema: { $ref: "#/components/schemas/invoice" } } },
        },
      },
    },
  },
]

const htmlResponse = (description: string): Json => ({
  content: { "text/html": { schema: { type: "string", description } } },
})

/**
 * Browser surfaces the mock serves itself so UI flows never leave the stack: the hosted Checkout
 * page (`session.url` points here instead of checkout.stripe.com), the Stripe.js stand-in served
 * in place of js.stripe.com/v3, and the 3-D Secure challenge that stand-in completes.
 */
const BROWSER_OPERATIONS: readonly { path: string; method: string; operation: Json }[] = [
  {
    path: "/c/pay/{session}",
    method: "get",
    operation: {
      operationId: "GetCheckoutPage",
      security: [],
      parameters: [{ name: "session", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        "200": htmlResponse("the hosted Checkout form"),
        "404": htmlResponse("unknown session"),
      },
    },
  },
  {
    path: "/c/pay/{session}",
    method: "post",
    operation: {
      operationId: "PostCheckoutPage",
      security: [],
      parameters: [{ name: "session", in: "path", required: true, schema: { type: "string" } }],
      requestBody: {
        content: {
          "application/x-www-form-urlencoded": {
            schema: {
              type: "object",
              properties: {
                action: { type: "string", enum: ["pay", "cancel"] },
                card: { type: "string", maxLength: 32 },
                exp: { type: "string", maxLength: 7 },
                cvc: { type: "string", maxLength: 4 },
                zip: { type: "string", maxLength: 10 },
              },
            },
          },
        },
      },
      responses: {
        "302": { description: "redirect to success_url or cancel_url" },
        "200": htmlResponse("the form again, with the decline message"),
        "404": htmlResponse("unknown session"),
      },
    },
  },
  {
    path: "/v3",
    method: "get",
    operation: {
      operationId: "GetStripeJs",
      security: [],
      responses: {
        "200": { content: { "application/javascript": { schema: { type: "string" } } } },
      },
    },
  },
  {
    path: "/c/3ds/{intent}/authenticate",
    method: "post",
    operation: {
      operationId: "PostThreeDSecureAuthenticate",
      security: [],
      parameters: [{ name: "intent", in: "path", required: true, schema: { type: "string" } }],
      requestBody: {
        content: {
          "application/x-www-form-urlencoded": {
            schema: {
              type: "object",
              properties: { client_secret: { type: "string", maxLength: 5000 } },
              required: ["client_secret"],
            },
          },
        },
      },
      responses: {
        "200": {
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/payment_intent" } },
          },
        },
      },
    },
  },
]

const main = async () => {
  const upstream = await fetchUpstream()
  const info = upstream.info as Json
  const upstreamPaths = upstream.paths as Record<string, Json>
  const upstreamSchemas = (upstream.components as Json).schemas as Record<string, Json>

  const paths: Record<string, Json> = {}
  for (const [path, item] of Object.entries(upstreamPaths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (!isObject(operation) || typeof operation.operationId !== "string") continue
      const config = OPERATIONS[operation.operationId]
      if (!config) continue
      const cleaned = clean(operation) as Json
      const pathItem = paths[path] ?? {}
      paths[path] = pathItem

      // Path params → resource refs; query params → shapes.
      const parameters = Array.isArray(cleaned.parameters) ? (cleaned.parameters as Json[]) : []
      const queryShape = QUERY_SHAPES[operation.operationId] ?? {}
      const kept: Json[] = []
      for (const parameter of parameters) {
        const name = String(parameter.name)
        if (parameter.in === "path") {
          const pathRef = pathRefFor(path, name)
          if (!pathRef)
            throw new Error(
              `${operation.operationId}: no resource ref for path parameter {${name}}`,
            )
          kept.push({ ...parameter, schema: { ...(parameter.schema as Json), ...pathRef } })
          continue
        }
        const top = queryShape[name]
        if (top === null) continue
        const schema = { ...(parameter.schema as Json) }
        if (top) Object.assign(schema, top)
        for (const [shapePath, edit] of Object.entries(queryShape)) {
          if (!shapePath.startsWith(`${name}.`) && shapePath !== `${name}[]`) continue
          if (shapePath === `${name}[]`) {
            if (!isObject(schema.items))
              throw new Error(`${operation.operationId}: ${name} is not an array`)
            schema.items = { ...schema.items, ...edit }
            continue
          }
          const nested = shapePath.slice(name.length + 1)
          const [parentPath, key] = parentAndKey(nested)
          const container = parentPath.length === 0 ? schema : propertyContainer(schema, parentPath)
          const holders: Schema[] = []
          if (container && isObject(container.properties)) holders.push(container.properties)
          if (container && Array.isArray(container.anyOf))
            for (const b of container.anyOf)
              if (isObject(b) && isObject(b.properties)) holders.push(b.properties)
          const holder = holders.find((h) => isObject(h[key]))
          if (!holder) throw new Error(`${operation.operationId}: query ${shapePath} not found`)
          if (edit === null) delete holder[key]
          else holder[key] = { ...(holder[key] as Json), ...edit }
        }
        kept.push({ ...parameter, schema })
      }
      for (const name of Object.keys(queryShape)) {
        if (
          !parameters.some(
            (p) =>
              p.name === name ||
              name.startsWith(`${String(p.name)}.`) ||
              name === `${String(p.name)}[]`,
          )
        )
          throw new Error(`${operation.operationId}: query parameter ${name} not found`)
      }

      shapeMetadata(cleaned)
      cleaned.parameters = kept

      const bodyShape = BODY_SHAPES[operation.operationId]
      const extraBody = EXTRA_BODY_PARAMS[operation.operationId]
      if (bodyShape || extraBody) {
        const body = cleaned.requestBody as Json
        const content = body.content as Record<string, Json>
        const form = content["application/x-www-form-urlencoded"]
        if (!form) throw new Error(`${operation.operationId}: no form body`)
        const formSchema = form.schema as Schema
        if (bodyShape) applyShape(formSchema, bodyShape, operation.operationId)
        if (extraBody) applyExtraBodyParams(formSchema, extraBody)
      }

      if (RAW_CARD_OPERATIONS.includes(operation.operationId)) acceptRawCard(cleaned)

      shapeExpand(cleaned, operation.operationId)

      parityHeaders(cleaned)

      stampOperation(cleaned, config, operation.operationId)
      pathItem[method] = cleaned
    }
  }

  for (const synthetic of [...SYNTHETIC_OPERATIONS, ...BROWSER_OPERATIONS]) {
    const config = OPERATIONS[synthetic.operation.operationId]
    if (!config) throw new Error(`${synthetic.operation.operationId}: missing allowlist entry`)
    const operation = clean(synthetic.operation) as Json
    const parameters = Array.isArray(operation.parameters) ? (operation.parameters as Json[]) : []
    for (const parameter of parameters) {
      if (parameter.in !== "path") continue
      const name = String(parameter.name)
      const pathRef = PATH_REFS[`${synthetic.path}#${name}`] ?? PATH_REFS[name]
      if (!pathRef) throw new Error(`${synthetic.operation.operationId}: no ref for {${name}}`)
      parameter.schema = { ...(parameter.schema as Json), ...pathRef }
    }
    parityHeaders(operation)
    stampOperation(operation, config, synthetic.operation.operationId)
    const pathItem = paths[synthetic.path] ?? {}
    paths[synthetic.path] = pathItem
    pathItem[synthetic.method] = operation
  }
  const missingOps = Object.keys(OPERATIONS).filter(
    (id) =>
      !Object.values(paths).some((item) =>
        Object.values(item).some((op) => isObject(op) && op.operationId === id),
      ),
  )
  if (missingOps.length > 0)
    throw new Error(`operations not found upstream: ${missingOps.join(", ")}`)

  // Transitive component closure with shaping applied before following refs.
  const schemas: Record<string, Json> = {}
  const queue = new Set<string>()
  collectRefs(paths, queue)
  for (const name of queue) {
    if (schemas[name]) continue
    const source = upstreamSchemas[name]
    if (!source) throw new Error(`component schema ${name} not found upstream`)
    const shaped = clean(source) as Json
    const shape = RESPONSE_SHAPES[name]
    if (shape) applyShape(shaped, shape, name)
    const optional = VERSIONED_FIELDS[name]
    if (optional && Array.isArray(shaped.required))
      shaped.required = (shaped.required as string[]).filter((key) => !optional.includes(key))
    schemas[name] = shaped
    collectRefs(shaped, queue)
  }
  for (const name of Object.keys(RESPONSE_SHAPES))
    if (!schemas[name]) throw new Error(`shape for unused component schema ${name}`)

  openBareObjects(paths)
  openBareObjects(schemas)

  const document = {
    openapi: "3.1.0",
    info: {
      title: "Stripe API (Mockingbird subset)",
      version: String(info.version),
      "x-mockingbird-upstream": { ...UPSTREAM, url: `https://github.com/${UPSTREAM.repository}` },
    },
    servers: [{ url: "https://api.stripe.com/" }],
    security: [{ bearerAuth: [] }],
    paths: Object.fromEntries(Object.entries(paths).sort(([a], [b]) => a.localeCompare(b))),
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
      schemas: Object.fromEntries(Object.entries(schemas).sort(([a], [b]) => a.localeCompare(b))),
    },
  }
  const yaml = `# Generated by scripts/vendor.ts from ${UPSTREAM.repository}@${UPSTREAM.commit} (${UPSTREAM.file}). Do not edit by hand.\n${stringify(document, { lineWidth: 0, aliasDuplicateObjects: false })}`
  await writeFile(outputPath, yaml)
  console.log(
    `wrote ${outputPath} (${Object.keys(paths).length} paths, ${Object.keys(schemas).length} schemas, api version ${String(info.version)})`,
  )
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error))
  process.exit(1)
})
