import { Collection, IdSequence } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { CORPUS_ROWS } from "./corpus/products.js"

/** The HSA/FSA eligibility values Flex assigns a product. */
export const ELIGIBILITIES = [
  "not_eligible",
  "auto_substantiation",
  "private_label",
  "letter_of_medical_necessity",
  "prescription",
  "vision",
  "service",
] as const
export type Eligibility = (typeof ELIGIBILITIES)[number]

export const NEXT_ACTION_TYPES = [
  "collect_letter_of_medical_necessity",
  "provide_second_payment_method",
  "provide_alternative_payment_method",
  "payment_failed",
] as const
export type NextActionType = (typeof NEXT_ACTION_TYPES)[number]

export const PAYMENT_INTENT_STATUSES = [
  "requires_payment_method",
  "requires_action",
  "processing",
  "succeeded",
  "canceled",
] as const
export type PaymentIntentStatus = (typeof PAYMENT_INTENT_STATUSES)[number]

export type ProductRecord = {
  product_id: string
  name: string
  description: string | null
  url: string | null
  client_reference_id: string | null
  hsa_fsa_eligibility: string | null
  visit_type: string | null
  active: boolean
  test_mode: boolean
  metadata: Record<string, string> | null
  created_at: string
}

export type CustomerRecord = {
  customer_id: string
  first_name: string | null
  last_name: string | null
  email: string | null
  phone: string | null
  test_mode: boolean
  created_at: string
}

/** A saved card. Only whether it is an HSA/FSA card is kept: never the number. */
export type PaymentMethodRecord = {
  payment_method_id: string
  type: "card"
  hsa_fsa: boolean
  customer: string | null
}

export type PaymentIntentRecord = {
  payment_intent_id: string
  amount: number
  amount_received: number | null
  customer: string | null
  payment_method: string | null
  status: PaymentIntentStatus
  created_at: string
}

export type SetupIntentRecord = {
  setup_intent_id: string
  status: PaymentIntentStatus
  customer: string | null
  payment_method: string | null
  created_at: string
}

export type NextAction = { type: NextActionType } & Record<string, unknown>

/** How often a recurring price bills (`price_data.recurring`). */
export type Recurring = {
  interval: "day" | "week" | "month" | "year"
  interval_count?: number
}

export type LineItemRecord = {
  price_data: { product: string; unit_amount: number; recurring?: Recurring | null }
  quantity: number
  amount_total: number
}

/** What a subscription-mode session was created with (`subscription_data`). */
export type SubscriptionData = {
  cancel_at_period_end?: boolean
  metadata?: Record<string, string>
}

export type SessionMode = "payment" | "subscription" | "off_session" | "setup"

export const SUBSCRIPTION_STATUSES = [
  "incomplete",
  "incomplete_expired",
  "trialing",
  "active",
  "past_due",
  "canceled",
  "unpaid",
  "paused",
] as const
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number]

/** A subscription a paid subscription-mode checkout session created. */
export type SubscriptionRecord = {
  subscription_id: string
  status: SubscriptionStatus
  items: {
    price_data: { product: string; unit_amount: number; recurring: Recurring }
    quantity: number
  }[]
  customer: string | null
  default_payment_method: string | null
  cancel_at_period_end: boolean
  current_period_start: string
  current_period_end: string
  canceled_at: string | null
  metadata: Record<string, string> | null
  test_mode: boolean
  created_at: string
}
export type SessionStatus = "open" | "paid" | "complete" | "canceled" | "expired"

export type SessionRecord = {
  checkout_session_id: string
  client_reference_id: string | null
  amount_total: number
  amount_received: number | null
  amount_refunded: number
  customer: string | null
  payment_intent: string | null
  setup_intent: string | null
  /** The subscription a paid subscription-mode session created. */
  subscription: string | null
  subscription_data: SubscriptionData | null
  mode: SessionMode
  status: SessionStatus
  /** The hosted page (`redirect_url` and `url`). */
  url: string
  success_url: string
  cancel_url: string | null
  next_action: NextAction | null
  visit_type: string | null
  metadata: Record<string, string> | null
  line_items: LineItemRecord[]
  allow_promotion_codes: boolean
  capture_method: string
  setup_future_use: string | null
  test_mode: boolean
  created_at: string
  expires_at: string
  /** Mock-clock epoch ms after which an open session expires. */
  expiresAtMs: number
}

export type RefundRecord = {
  refund_id: string
  checkout_session: string
  payment_intent: string | null
  amount: number
  status: "succeeded"
  created_at: string
}

/** Per-namespace knobs, set through `PUT /__admin/settings`; cleared on reset. */
export type Settings = {
  /**
   * `dotted` sends `checkout.session.completed` / `checkout.session.expired`; `underscored`
   * sends the aliases `checkout_session.completed` / `checkout_session.expired`.
   */
  eventNaming: "dotted" | "underscored"
  /** What an off-session charge does in the create response. */
  offSessionOutcome: "succeeded" | "declined" | "requires_action"
  /** Open sessions expire after this long on the mock clock. */
  sessionTtlSeconds: number
  /** A non-HSA card on a letter-of-medical-necessity product asks for the letter. */
  lmnOnRegularCard: boolean
  /** Base URL of the hosted page in session URLs; default: the request's own origin. */
  publicUrl: string | null
}

export const DEFAULT_SETTINGS: Settings = {
  eventNaming: "dotted",
  offSessionOutcome: "succeeded",
  sessionTtlSeconds: 86_400,
  lmnOnRegularCard: true,
  publicUrl: null,
}

/** The corpus row as the Flex product it records (every corpus product is active, test mode). */
export const corpusProduct = (row: (typeof CORPUS_ROWS)[number]): ProductRecord => {
  const [product_id, purpose, merchant, eligibility, visit_type, reference, created_at] = row
  return {
    product_id,
    name: `Geviti ${purpose} ${merchant}`,
    description: `Geviti ${purpose} product ${merchant}`,
    url: null,
    client_reference_id: reference,
    hsa_fsa_eligibility: eligibility,
    visit_type,
    active: true,
    test_mode: true,
    metadata: {
      geviti_purpose: purpose,
      geviti_merchant_product_id: merchant,
      geviti_client_reference_id: reference,
    },
    created_at,
  }
}

let corpusCache: Map<string, ProductRecord> | undefined
const corpusMap = (): Map<string, ProductRecord> => {
  corpusCache ??= new Map(CORPUS_ROWS.map((row) => [row[0], corpusProduct(row)]))
  return corpusCache
}

/**
 * Products: the recorded corpus as an immutable base layer, with created and edited
 * products in a Collection on top (so reset and snapshots cover every change and a fresh
 * namespace costs nothing to seed).
 */
export class ProductStore {
  private readonly overlay: Collection<ProductRecord>

  constructor(
    sqlite: SqliteClient,
    namespace: string,
    private readonly base: () => Map<string, ProductRecord>,
  ) {
    this.overlay = new Collection(sqlite, namespace, "products")
  }

  get(id: string): ProductRecord | undefined {
    return this.overlay.get(id) ?? this.base().get(id)
  }

  put(product: ProductRecord): void {
    if (this.overlay.has(product.product_id)) this.overlay.update(product.product_id, product)
    else this.overlay.insert(product.product_id, product)
  }

  /** Corpus order (by product id), then created products oldest first. */
  list(): ProductRecord[] {
    const base = this.base()
    const edited = new Map(this.overlay.list({ order: "oldest" }).map((row) => [row.id, row.value]))
    const out: ProductRecord[] = []
    for (const [id, product] of base) out.push(edited.get(id) ?? product)
    for (const [id, product] of edited) if (!base.has(id)) out.push(product)
    return out
  }
}

export class FlexState {
  readonly products: ProductStore
  readonly sessions: Collection<SessionRecord>
  readonly customers: Collection<CustomerRecord>
  readonly paymentMethods: Collection<PaymentMethodRecord>
  readonly paymentIntents: Collection<PaymentIntentRecord>
  readonly setupIntents: Collection<SetupIntentRecord>
  readonly refunds: Collection<RefundRecord>
  readonly subscriptions: Collection<SubscriptionRecord>
  readonly settings: Collection<Settings>
  readonly ids: IdSequence

  constructor(
    sqlite: SqliteClient,
    namespace: string,
    private readonly seed: { products?: readonly ProductRecord[]; settings: Partial<Settings> },
  ) {
    const custom = seed.products ? new Map(seed.products.map((p) => [p.product_id, p])) : undefined
    this.products = new ProductStore(sqlite, namespace, () => custom ?? corpusMap())
    this.sessions = new Collection(sqlite, namespace, "sessions")
    this.customers = new Collection(sqlite, namespace, "customers")
    this.paymentMethods = new Collection(sqlite, namespace, "payment_methods")
    this.paymentIntents = new Collection(sqlite, namespace, "payment_intents")
    this.setupIntents = new Collection(sqlite, namespace, "setup_intents")
    this.refunds = new Collection(sqlite, namespace, "refunds")
    this.subscriptions = new Collection(sqlite, namespace, "subscriptions")
    this.settings = new Collection(sqlite, namespace, "settings")
    this.ids = new IdSequence(sqlite, namespace, "flex")
  }

  current(): Settings {
    return this.settings.get("settings") ?? { ...DEFAULT_SETTINGS, ...this.seed.settings }
  }

  update(patch: Partial<Settings>): Settings {
    const next = { ...this.current(), ...patch }
    if (this.settings.has("settings")) this.settings.update("settings", next)
    else this.settings.insert("settings", next)
    return next
  }

  /** ULID-looking lowercase ids (`fprod_01z…`) that sort after every recorded corpus id. */
  nextId(prefix: string): string {
    return `${prefix}01z${this.ids
      .next(`${prefix}01z`, 23)
      .slice(prefix.length + 3)
      .toLowerCase()}`
  }
}
