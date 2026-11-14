import { Collection } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"

export type Money = { amount: string; currencyCode: string }

export type Address = {
  address1: string | null
  address2: string | null
  city: string | null
  company: string | null
  countryCode: string | null
  firstName: string | null
  lastName: string | null
  phone: string | null
  provinceCode: string | null
  zip: string | null
}

export type ProductRecord = {
  id: string
  title: string
  handle: string
  status: "ACTIVE" | "ARCHIVED" | "DRAFT"
  vendor: string
}

export type VariantRecord = {
  id: string
  productId: string
  title: string
  sku: string | null
  barcode: string | null
  /** Decimal string in the shop currency, e.g. `"25.00"`. */
  price: string
  inventoryQuantity: number
  createdAt: string
  updatedAt: string
}

export type LineItemRecord = {
  id: string
  title: string
  name: string
  quantity: number
  sku: string | null
  variantId: string | null
  price: string
  requiresShipping: boolean
}

export type OrderRecord = {
  id: string
  number: number
  name: string
  email: string | null
  phone: string | null
  note: string | null
  tags: string[]
  test: boolean
  sourceName: string | null
  currency: string
  createdAt: string
  updatedAt: string
  processedAt: string
  cancelledAt: string | null
  cancelReason: string | null
  closed: boolean
  financialStatus: string
  fulfillmentStatus: string
  lineItems: LineItemRecord[]
  shippingAddress: Address | null
}

export type TrackingInfo = { company: string | null; number: string | null; url: string | null }

export type FulfillmentRecord = {
  id: string
  orderId: string
  name: string
  status: "SUCCESS" | "CANCELLED"
  displayStatus: string
  tracking: TrackingInfo[]
  createdAt: string
  updatedAt: string
  deliveredAt: string | null
}

export type DraftOrderRecord = {
  id: string
  name: string
  status: "OPEN" | "INVOICE_SENT" | "COMPLETED"
  email: string | null
  phone: string | null
  note: string | null
  tags: string[]
  currency: string
  lineItems: LineItemRecord[]
  shippingAddress: Address | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
  orderId: string | null
}

export type MetafieldOwnerType = "ORDER" | "DRAFTORDER" | "PRODUCT" | "PRODUCTVARIANT"

export type MetafieldRecord = {
  id: string
  ownerId: string
  ownerType: MetafieldOwnerType
  namespace: string
  key: string
  value: string
  type: string
  createdAt: string
  updatedAt: string
}

export type WebhookSubscriptionRecord = {
  id: string
  topic: string
  format: "JSON"
  uri: string
  includeFields: string[]
  /** The Admin API version the subscription was created with; webhooks carry it. */
  apiVersion: string
  createdAt: string
  updatedAt: string
}

/** What the next mutation does instead of running (`POST /__admin/fail-next-mutation`). */
export type MutationFailure =
  | { kind: "userErrors"; message: string; field: string[] | null; code: string | null }
  | { kind: "throttled" }

export type Settings = {
  /** Accepted `X-Shopify-Access-Token` values; empty accepts any non-empty token. */
  accessTokens: string[]
  /** The app's client secret: the HMAC key of `X-Shopify-Hmac-Sha256`. */
  apiSecret: string
  shopName: string
  shopDomain: string
  currency: string
  /** Owner of the app-reserved metafield namespace (`app--<appId>`). */
  appId: string
}

export const DEFAULT_SETTINGS: Settings = {
  accessTokens: [],
  apiSecret: "mockingbird_shopify_api_secret",
  shopName: "Mockingbird Test Store",
  shopDomain: "mockingbird-test.myshopify.com",
  currency: "USD",
  appId: "1000001",
}

/**
 * Each kind of id counts from its own base, so a numeric id (and the gid built from it) says
 * what it is: orders 5000000001…, fulfilments 4000000001…, draft orders 900000001…, and so on.
 */
const ID_BASES = {
  product: 7_000_000_000,
  variant: 41_000_000_000,
  order: 5_000_000_000,
  orderNumber: 1000,
  lineItem: 13_000_000_000,
  fulfillment: 4_000_000_000,
  draftOrder: 900_000_000,
  draftOrderNumber: 0,
  metafield: 20_000_000_000,
  webhookSubscription: 1_100_000_000,
  event: 9_000_000_000,
} as const

export type IdKind = keyof typeof ID_BASES

/** Seeded catalogue: synthetic products, never a real merchant's. */
const PRODUCTS: Array<ProductRecord & { variants: Array<Omit<VariantRecord, "productId">> }> = [
  {
    id: "7000000001",
    title: "Mockingbird Tee",
    handle: "mockingbird-tee",
    status: "ACTIVE",
    vendor: "Mockingbird",
    variants: [
      variant("41000000001", "Small", "MB-TEE-S", "25.00", 40),
      variant("41000000002", "Medium", "MB-TEE-M", "25.00", 25),
    ],
  },
  {
    id: "7000000002",
    title: "Mockingbird Mug",
    handle: "mockingbird-mug",
    status: "ACTIVE",
    vendor: "Mockingbird",
    variants: [variant("41000000003", "Default Title", "MB-MUG", "12.50", 100)],
  },
]

function variant(
  id: string,
  title: string,
  sku: string,
  price: string,
  inventoryQuantity: number,
): Omit<VariantRecord, "productId"> {
  const at = "2026-01-01T00:00:00Z"
  return { id, title, sku, barcode: null, price, inventoryQuantity, createdAt: at, updatedAt: at }
}

export class ShopifyState {
  readonly products: Collection<ProductRecord>
  readonly variants: Collection<VariantRecord>
  readonly orders: Collection<OrderRecord>
  readonly fulfillments: Collection<FulfillmentRecord>
  readonly draftOrders: Collection<DraftOrderRecord>
  readonly metafields: Collection<MetafieldRecord>
  readonly webhookSubscriptions: Collection<WebhookSubscriptionRecord>
  readonly mutationFailures: Collection<MutationFailure>
  readonly settings: Collection<Settings>
  readonly counters: Collection<number>

  constructor(
    sqlite: SqliteClient,
    namespace: string,
    private readonly seed: Partial<Settings> = {},
  ) {
    this.products = new Collection(sqlite, namespace, "products")
    this.variants = new Collection(sqlite, namespace, "product_variants")
    this.orders = new Collection(sqlite, namespace, "orders")
    this.fulfillments = new Collection(sqlite, namespace, "fulfillments")
    this.draftOrders = new Collection(sqlite, namespace, "draft_orders")
    this.metafields = new Collection(sqlite, namespace, "metafields")
    this.webhookSubscriptions = new Collection(sqlite, namespace, "webhook_subscriptions")
    this.mutationFailures = new Collection(sqlite, namespace, "mutation_failures")
    this.settings = new Collection(sqlite, namespace, "settings")
    this.counters = new Collection(sqlite, namespace, "counters")
    this.ensureSeeded()
  }

  ensureSeeded(): void {
    if (!this.settings.has("settings")) {
      this.settings.insert("settings", { ...DEFAULT_SETTINGS, ...this.seed })
    }
    for (const { variants, ...product } of PRODUCTS) {
      if (!this.products.has(product.id)) this.products.insert(product.id, product)
      for (const row of variants) {
        if (!this.variants.has(row.id))
          this.variants.insert(row.id, { ...row, productId: product.id })
      }
    }
  }

  /** The next numeric id of a kind, as a string (`legacyResourceId`). */
  nextId(kind: IdKind): string {
    const next = (this.counters.get(kind) ?? 0) + 1
    this.counters.insert(kind, next)
    return String(ID_BASES[kind] + next)
  }

  current(): Settings {
    return this.settings.get("settings") ?? { ...DEFAULT_SETTINGS, ...this.seed }
  }

  update(patch: Partial<Settings>): Settings {
    const next = { ...this.current(), ...patch }
    this.settings.insert("settings", next)
    return next
  }

  /** The failure queued for the next mutation, removed as it is read. */
  takeMutationFailure(): MutationFailure | undefined {
    const failure = this.mutationFailures.get("next")
    if (failure) this.mutationFailures.delete("next")
    return failure
  }

  metafieldsOf(ownerId: string, namespace?: string): MetafieldRecord[] {
    return this.metafields
      .list({
        where: (row) =>
          row.ownerId === ownerId && (namespace === undefined || row.namespace === namespace),
        order: "oldest",
      })
      .map((row) => row.value)
  }

  fulfillmentsOf(orderId: string): FulfillmentRecord[] {
    return this.fulfillments
      .list({ where: (row) => row.orderId === orderId, order: "oldest" })
      .map((row) => row.value)
  }
}
