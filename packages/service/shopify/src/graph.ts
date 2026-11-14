import { GraphQLError } from "graphql"
import type {
  Address,
  DraftOrderRecord,
  FulfillmentRecord,
  LineItemRecord,
  MetafieldOwnerType,
  MetafieldRecord,
  OrderRecord,
  ShopifyState,
  TrackingInfo,
  VariantRecord,
  WebhookSubscriptionRecord,
} from "./state.js"

/** A webhook topic as Shopify names it on the wire (`orders/fulfilled`). */
export type ShopifyTopic =
  | "orders/create"
  | "orders/fulfilled"
  | "orders/cancelled"
  | "fulfillments/create"
  | "fulfillments/update"

/** `ORDERS_FULFILLED` → `orders/fulfilled`. */
export const restTopic = (topic: string): ShopifyTopic =>
  topic.toLowerCase().replace("_", "/") as ShopifyTopic

export type GraphContext = {
  state: ShopifyState
  /** ISO-8601 at the emulator clock, to the second (`2026-01-04T12:00:00Z`). */
  timestamp: () => string
  /** The Admin API version in the request path. */
  apiVersion: string
  emit: (topic: ShopifyTopic, body: Record<string, unknown>) => void
  /** Called after webhook subscriptions change, so the delivery hub follows them. */
  subscriptionsChanged: () => void
  /** Ids this request touched, for the journal. */
  touched: Record<string, string>
  /** Set when `POST /__admin/fail-next-mutation` queued userErrors for this document. */
  injectedUserError?: { message: string; field: string[] | null; code: string | null }
}

type Args = Record<string, unknown>
type Resolved = Record<string, unknown>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const text = (value: unknown): string | null => (typeof value === "string" ? value : null)

export const gid = (type: string, id: string) => `gid://shopify/${type}/${id}`

/** The numeric id inside `gid://shopify/<type>/<id>`, or `undefined` for another type. */
export const parseGid = (value: string): { type: string; id: string } | undefined => {
  const match = /^gid:\/\/shopify\/([A-Za-z]+)\/(\d+)$/.exec(value)
  return match ? { type: match[1] as string, id: match[2] as string } : undefined
}

/** Shopify rejects a malformed global id before resolving anything. */
const requireGid = (value: unknown, type: string): string | undefined => {
  const parsed = typeof value === "string" ? parseGid(value) : undefined
  if (!parsed) throw new GraphQLError(`Invalid global id '${String(value)}'`)
  return parsed.type === type ? parsed.id : undefined
}

const decimal = (value: number) => value.toFixed(2)

const moneyBag = (amount: string, currencyCode: string) => ({
  shopMoney: { amount, currencyCode },
  presentmentMoney: { amount, currencyCode },
})

const lineTotal = (items: LineItemRecord[]) =>
  decimal(items.reduce((total, item) => total + Number(item.price) * item.quantity, 0))

const cursorOf = (id: string) => btoa(JSON.stringify({ last_id: Number(id) }))
const idOfCursor = (cursor: string): string | undefined => {
  try {
    const parsed = JSON.parse(atob(cursor)) as unknown
    return isRecord(parsed) && typeof parsed.last_id === "number"
      ? String(parsed.last_id)
      : undefined
  } catch {
    return undefined
  }
}

/** Relay pagination over rows ordered by numeric id, with Shopify's first/last requirement. */
const connection = <T extends { id: string }>(
  rows: T[],
  args: Args,
  render: (row: T) => Resolved,
): Resolved => {
  const first = typeof args.first === "number" ? args.first : undefined
  const last = typeof args.last === "number" ? args.last : undefined
  if (first === undefined && last === undefined) {
    throw new GraphQLError("you must provide one of first or last")
  }
  if ((first ?? 0) > 250 || (last ?? 0) > 250 || (first ?? 1) < 0 || (last ?? 1) < 0) {
    throw new GraphQLError("The first and last arguments must be between 0 and 250")
  }
  const ordered = [...rows].sort((a, b) => Number(a.id) - Number(b.id))
  if (args.reverse === true) ordered.reverse()
  let start = 0
  let end = ordered.length
  for (const [name, apply] of [
    ["after", (index: number) => (start = Math.max(start, index + 1))],
    ["before", (index: number) => (end = Math.min(end, index))],
  ] as const) {
    if (typeof args[name] !== "string") continue
    const id = idOfCursor(args[name] as string)
    if (id === undefined) throw new GraphQLError(`Invalid cursor for ${name}`)
    const index = ordered.findIndex((row) => row.id === id)
    if (index >= 0) apply(index)
  }
  let window = ordered.slice(start, end)
  let hasNextPage = end < ordered.length
  let hasPreviousPage = start > 0
  if (first !== undefined && window.length > first) {
    window = window.slice(0, first)
    hasNextPage = true
  }
  if (last !== undefined && window.length > last) {
    window = window.slice(window.length - last)
    hasPreviousPage = true
  }
  const nodes = window.map(render)
  return {
    edges: window.map((row, index) => ({ cursor: cursorOf(row.id), node: nodes[index] })),
    nodes,
    pageInfo: {
      hasNextPage,
      hasPreviousPage,
      startCursor: window[0] ? cursorOf(window[0].id) : null,
      endCursor: window.at(-1) ? cursorOf((window.at(-1) as T).id) : null,
    },
  }
}

const addressInput = (raw: unknown): Address | null => {
  if (!isRecord(raw)) return null
  return {
    address1: text(raw.address1),
    address2: text(raw.address2),
    city: text(raw.city),
    company: text(raw.company),
    countryCode: text(raw.countryCode),
    firstName: text(raw.firstName),
    lastName: text(raw.lastName),
    phone: text(raw.phone),
    provinceCode: text(raw.provinceCode),
    zip: text(raw.zip),
  }
}

const OWNER_TYPES: Record<string, MetafieldOwnerType> = {
  Order: "ORDER",
  DraftOrder: "DRAFTORDER",
  Product: "PRODUCT",
  ProductVariant: "PRODUCTVARIANT",
}

/** Metafield types the emulator validates; any other `type` is `INVALID_TYPE`. */
const METAFIELD_TYPES: Record<string, (value: string) => string | undefined> = {
  single_line_text_field: (value) =>
    value.includes("\n") ? "Value must be a single line text string." : undefined,
  multi_line_text_field: () => undefined,
  number_integer: (value) => (/^-?\d+$/.test(value) ? undefined : "Value must be an integer."),
  number_decimal: (value) =>
    /^-?\d+(\.\d+)?$/.test(value) ? undefined : "Value must be a decimal.",
  boolean: (value) =>
    value === "true" || value === "false" ? undefined : "Value must be true or false.",
  date: (value) =>
    /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value))
      ? undefined
      : "Value must be in YYYY-MM-DD format.",
  date_time: (value) =>
    Number.isNaN(Date.parse(value)) ? "Value must be in ISO 8601 date and time format." : undefined,
  url: (value) => {
    try {
      const url = new URL(value)
      return ["http:", "https:", "mailto:", "sms:", "tel:"].includes(url.protocol)
        ? undefined
        : "Value must be a valid URL."
    } catch {
      return "Value must be a valid URL."
    }
  },
  json: (value) => {
    try {
      JSON.parse(value)
      return undefined
    } catch {
      return "Value must be valid JSON."
    }
  },
}

type MetafieldWrite = {
  ownerId: string
  ownerType: MetafieldOwnerType
  namespace: string
  key: string
  value: string
  type: string
}

type FieldError = { field: string[] | null; message: string; code: string | null }

/** REST-style (`snake_case`) renderings: the bodies Shopify posts to webhook subscriptions. */
export const restAddress = (address: Address | null) =>
  address && {
    first_name: address.firstName,
    last_name: address.lastName,
    name: [address.firstName, address.lastName].filter(Boolean).join(" ") || null,
    company: address.company,
    address1: address.address1,
    address2: address.address2,
    city: address.city,
    province_code: address.provinceCode,
    country_code: address.countryCode,
    zip: address.zip,
    phone: address.phone,
  }

const restLineItem = (item: LineItemRecord, fulfilled: boolean) => ({
  id: Number(item.id),
  admin_graphql_api_id: gid("LineItem", item.id),
  variant_id: item.variantId === null ? null : Number(item.variantId),
  title: item.title,
  name: item.name,
  quantity: item.quantity,
  sku: item.sku,
  price: item.price,
  requires_shipping: item.requiresShipping,
  fulfillment_status: fulfilled ? "fulfilled" : null,
})

export const restFulfillment = (fulfillment: FulfillmentRecord, order: OrderRecord) => {
  const tracking = fulfillment.tracking
  return {
    id: Number(fulfillment.id),
    admin_graphql_api_id: gid("Fulfillment", fulfillment.id),
    order_id: Number(order.id),
    name: fulfillment.name,
    status: fulfillment.status.toLowerCase(),
    service: "manual",
    shipment_status: SHIPMENT_STATUS[fulfillment.displayStatus] ?? null,
    created_at: fulfillment.createdAt,
    updated_at: fulfillment.updatedAt,
    tracking_company: tracking[0]?.company ?? null,
    tracking_number: tracking[0]?.number ?? null,
    tracking_numbers: tracking.flatMap((info) => (info.number ? [info.number] : [])),
    tracking_url: tracking[0]?.url ?? null,
    tracking_urls: tracking.flatMap((info) => (info.url ? [info.url] : [])),
    line_items: order.lineItems.map((item) => restLineItem(item, true)),
  }
}

const SHIPMENT_STATUS: Record<string, string> = {
  ATTEMPTED_DELIVERY: "attempted_delivery",
  CONFIRMED: "confirmed",
  DELIVERED: "delivered",
  FAILURE: "failure",
  IN_TRANSIT: "in_transit",
  LABEL_PRINTED: "label_printed",
  LABEL_PURCHASED: "label_purchased",
  OUT_FOR_DELIVERY: "out_for_delivery",
  READY_FOR_PICKUP: "ready_for_pickup",
}

const REST_FULFILLMENT_STATUS: Record<string, string | null> = {
  FULFILLED: "fulfilled",
  PARTIALLY_FULFILLED: "partial",
  RESTOCKED: "restocked",
}

export const restOrder = (order: OrderRecord, fulfillments: FulfillmentRecord[]) => {
  const total = lineTotal(order.lineItems)
  const fulfilled = order.fulfillmentStatus === "FULFILLED"
  return {
    id: Number(order.id),
    admin_graphql_api_id: gid("Order", order.id),
    name: order.name,
    order_number: order.number,
    email: order.email,
    phone: order.phone,
    note: order.note,
    tags: order.tags.join(", "),
    test: order.test,
    currency: order.currency,
    source_name: order.sourceName,
    created_at: order.createdAt,
    updated_at: order.updatedAt,
    processed_at: order.processedAt,
    cancelled_at: order.cancelledAt,
    cancel_reason: order.cancelReason?.toLowerCase() ?? null,
    closed_at: null,
    financial_status: order.financialStatus.toLowerCase(),
    fulfillment_status: REST_FULFILLMENT_STATUS[order.fulfillmentStatus] ?? null,
    subtotal_price: total,
    total_price: total,
    line_items: order.lineItems.map((item) => restLineItem(item, fulfilled)),
    fulfillments: fulfillments.map((row) => restFulfillment(row, order)),
    shipping_address: restAddress(order.shippingAddress),
  }
}

/**
 * Resolves the Admin GraphQL subset against {@link ShopifyState}. Fields are plain values or
 * functions of their arguments (graphql-js's default resolver calls them), so only what a
 * selection set asks for is computed.
 */
export class ShopifyGraph {
  constructor(private readonly context: GraphContext) {}

  private get state() {
    return this.context.state
  }

  root(): Resolved {
    return {
      shop: () => this.shop(),
      order: (args: Args) => {
        const id = requireGid(args.id, "Order")
        const order = id === undefined ? undefined : this.state.orders.get(id)
        if (order) this.context.touched.orderId = order.id
        return order ? this.order(order) : null
      },
      draftOrder: (args: Args) => {
        const id = requireGid(args.id, "DraftOrder")
        const draft = id === undefined ? undefined : this.state.draftOrders.get(id)
        return draft ? this.draftOrder(draft) : null
      },
      productVariant: (args: Args) => {
        const id = requireGid(args.id, "ProductVariant")
        const row = id === undefined ? undefined : this.state.variants.get(id)
        return row ? this.variant(row) : null
      },
      productVariants: (args: Args) =>
        connection(this.searchVariants(text(args.query)), args, (row) => this.variant(row)),
      webhookSubscription: (args: Args) => {
        const id = requireGid(args.id, "WebhookSubscription")
        const row = id === undefined ? undefined : this.state.webhookSubscriptions.get(id)
        return row ? this.subscription(row) : null
      },
      webhookSubscriptions: (args: Args) => {
        const topics = Array.isArray(args.topics) ? (args.topics as string[]) : undefined
        const callbackUrl = text(args.callbackUrl)
        const rows = this.state.webhookSubscriptions
          .list({
            where: (row) =>
              (topics === undefined || topics.includes(row.topic)) &&
              (callbackUrl === null || row.uri === callbackUrl),
          })
          .map((row) => row.value)
        return connection(rows, args, (row) => this.subscription(row))
      },
    }
  }

  mutations(): Resolved {
    const guard =
      (run: (args: Args) => Resolved) =>
      (args: Args): Resolved => {
        const injected = this.context.injectedUserError
        if (injected) return { userErrors: [injected] }
        return run(args)
      }
    return {
      orderCreate: guard((args) => this.orderCreate(args)),
      draftOrderCreate: guard((args) => this.draftOrderCreate(args)),
      draftOrderComplete: guard((args) => this.draftOrderComplete(args)),
      metafieldsSet: guard((args) => this.metafieldsSet(args)),
      webhookSubscriptionCreate: guard((args) => this.webhookSubscriptionCreate(args)),
      webhookSubscriptionDelete: guard((args) => this.webhookSubscriptionDelete(args)),
    }
  }

  // ---- renderers -------------------------------------------------------------------------

  private shop(): Resolved {
    const settings = this.state.current()
    return {
      id: gid("Shop", "1"),
      name: settings.shopName,
      myshopifyDomain: settings.shopDomain,
      currencyCode: settings.currency,
    }
  }

  private metafieldFields(ownerId: string): Resolved {
    return {
      metafield: (args: Args) => {
        const namespace = text(args.namespace) ?? this.appNamespace()
        const row = this.state
          .metafieldsOf(ownerId, namespace)
          .find((field) => field.key === args.key)
        return row ? this.metafield(row) : null
      },
      metafields: (args: Args) =>
        connection(
          this.state.metafieldsOf(ownerId, text(args.namespace) ?? undefined),
          args,
          (row) => this.metafield(row),
        ),
    }
  }

  private metafield(row: MetafieldRecord): Resolved {
    return {
      id: gid("Metafield", row.id),
      legacyResourceId: row.id,
      namespace: row.namespace,
      key: row.key,
      value: row.value,
      type: row.type,
      ownerType: row.ownerType,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }

  private variant(row: VariantRecord): Resolved {
    const product = this.state.products.get(row.productId)
    return {
      id: gid("ProductVariant", row.id),
      legacyResourceId: row.id,
      title: row.title,
      displayName: `${product?.title ?? ""} - ${row.title}`,
      sku: row.sku,
      barcode: row.barcode,
      price: row.price,
      inventoryQuantity: row.inventoryQuantity,
      availableForSale: product?.status === "ACTIVE" && row.inventoryQuantity > 0,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      product: () =>
        product && {
          id: gid("Product", product.id),
          legacyResourceId: product.id,
          title: product.title,
          handle: product.handle,
          status: product.status,
          vendor: product.vendor,
          ...this.metafieldFields(gid("Product", product.id)),
        },
      ...this.metafieldFields(gid("ProductVariant", row.id)),
    }
  }

  private lineItem(item: LineItemRecord, currency: string): Resolved {
    const variant = item.variantId === null ? undefined : this.state.variants.get(item.variantId)
    return {
      id: gid("LineItem", item.id),
      name: item.name,
      title: item.title,
      quantity: item.quantity,
      sku: item.sku,
      requiresShipping: item.requiresShipping,
      variant: () => (variant ? this.variant(variant) : null),
      originalUnitPriceSet: moneyBag(item.price, currency),
    }
  }

  private fulfillment(row: FulfillmentRecord): Resolved {
    return {
      id: gid("Fulfillment", row.id),
      legacyResourceId: row.id,
      name: row.name,
      status: row.status,
      displayStatus: row.displayStatus,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      deliveredAt: row.deliveredAt,
      trackingInfo: (args: Args) =>
        typeof args.first === "number" ? row.tracking.slice(0, args.first) : row.tracking,
    }
  }

  order(order: OrderRecord): Resolved {
    const total = lineTotal(order.lineItems)
    const address = order.shippingAddress
    return {
      id: gid("Order", order.id),
      legacyResourceId: order.id,
      name: order.name,
      email: order.email,
      phone: order.phone,
      note: order.note,
      tags: order.tags,
      test: order.test,
      sourceName: order.sourceName,
      currencyCode: order.currency,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      processedAt: order.processedAt,
      cancelledAt: order.cancelledAt,
      cancelReason: order.cancelReason,
      closed: order.closed,
      displayFinancialStatus: order.financialStatus,
      displayFulfillmentStatus: order.fulfillmentStatus,
      subtotalPriceSet: moneyBag(total, order.currency),
      totalPriceSet: moneyBag(total, order.currency),
      shippingAddress: address && {
        ...address,
        countryCodeV2: address.countryCode,
        name: [address.firstName, address.lastName].filter(Boolean).join(" ") || null,
      },
      lineItems: (args: Args) =>
        connection(order.lineItems, args, (item) => this.lineItem(item, order.currency)),
      fulfillments: (args: Args) => {
        const rows = this.state.fulfillmentsOf(order.id).map((row) => this.fulfillment(row))
        return typeof args.first === "number" ? rows.slice(0, args.first) : rows
      },
      ...this.metafieldFields(gid("Order", order.id)),
    }
  }

  private draftOrder(draft: DraftOrderRecord): Resolved {
    const total = lineTotal(draft.lineItems)
    const order = draft.orderId === null ? undefined : this.state.orders.get(draft.orderId)
    return {
      id: gid("DraftOrder", draft.id),
      legacyResourceId: draft.id,
      name: draft.name,
      status: draft.status,
      email: draft.email,
      note2: draft.note,
      tags: draft.tags,
      currencyCode: draft.currency,
      createdAt: draft.createdAt,
      updatedAt: draft.updatedAt,
      completedAt: draft.completedAt,
      totalPriceSet: moneyBag(total, draft.currency),
      subtotalPriceSet: moneyBag(total, draft.currency),
      order: () => (order ? this.order(order) : null),
      lineItems: (args: Args) =>
        connection(draft.lineItems, args, (item) => this.lineItem(item, draft.currency)),
      ...this.metafieldFields(gid("DraftOrder", draft.id)),
    }
  }

  private subscription(row: WebhookSubscriptionRecord): Resolved {
    return {
      id: gid("WebhookSubscription", row.id),
      legacyResourceId: row.id,
      topic: row.topic,
      format: row.format,
      callbackUrl: row.uri,
      uri: row.uri,
      includeFields: row.includeFields,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }

  // ---- queries ---------------------------------------------------------------------------

  /** Shopify search syntax, the subset that finds variants: `sku:`, `product_id:`, `title:`, `barcode:`, free text. */
  private searchVariants(query: string | null): VariantRecord[] {
    const rows = this.state.variants.list().map((row) => row.value)
    if (!query?.trim()) return rows
    const terms = query.match(/(?:[^\s"]+:)?"[^"]*"|\S+/g) ?? []
    const filters = terms
      .filter((term) => !/^(AND|OR)$/.test(term))
      .map((term) => {
        const colon = term.indexOf(":")
        const field = colon > 0 ? term.slice(0, colon) : null
        const value = (colon > 0 ? term.slice(colon + 1) : term).replace(/^"|"$/g, "")
        return { field, value: value.toLowerCase() }
      })
    for (const { field } of filters) {
      if (field !== null && !["sku", "product_id", "title", "barcode", "id"].includes(field)) {
        throw new GraphQLError(
          `The Mockingbird emulator does not support the productVariants search field '${field}'`,
          { extensions: { code: "MOCKINGBIRD_UNSUPPORTED" } },
        )
      }
    }
    return rows.filter((row) => {
      const product = this.state.products.get(row.productId)
      return filters.every(({ field, value }) => {
        const like = (candidate: string | null | undefined) =>
          (candidate ?? "").toLowerCase().includes(value.replace(/\*$/, ""))
        switch (field) {
          case "sku":
            return (row.sku ?? "").toLowerCase() === value
          case "barcode":
            return (row.barcode ?? "").toLowerCase() === value
          case "product_id":
            return row.productId === value
          case "id":
            return row.id === value
          case "title":
            return like(row.title) || like(product?.title)
          default:
            return like(row.title) || like(row.sku) || like(product?.title)
        }
      })
    })
  }

  // ---- mutations -------------------------------------------------------------------------

  private appNamespace(): string {
    return `app--${this.state.current().appId}`
  }

  /** Resolve line item inputs; errors carry their path under `prefix`. */
  private lineItems(
    raw: unknown,
    prefix: string[],
    priceOf: (input: Args) => string | null,
  ): { items: LineItemRecord[]; errors: FieldError[] } {
    const errors: FieldError[] = []
    const items: LineItemRecord[] = []
    const inputs = Array.isArray(raw) ? (raw as Args[]) : []
    if (inputs.length === 0) {
      errors.push({
        field: [...prefix],
        message: "Line items must have at least one line item",
        code: "BLANK",
      })
    }
    for (const [index, input] of inputs.entries()) {
      const path = [...prefix, String(index)]
      const quantity = Number(input.quantity)
      if (!Number.isInteger(quantity) || quantity < 1) {
        errors.push({
          field: [...path, "quantity"],
          message: "Quantity must be greater than or equal to 1",
          code: "INVALID",
        })
        continue
      }
      if (input.variantId !== undefined && input.variantId !== null) {
        const parsed = parseGid(String(input.variantId))
        const row =
          parsed?.type === "ProductVariant" ? this.state.variants.get(parsed.id) : undefined
        if (!row) {
          errors.push({
            field: [...path, "variantId"],
            message: "Variant not found",
            code: "NOT_FOUND",
          })
          continue
        }
        const product = this.state.products.get(row.productId)
        items.push({
          id: this.state.nextId("lineItem"),
          title: product?.title ?? row.title,
          name:
            row.title === "Default Title"
              ? (product?.title ?? row.title)
              : `${product?.title} - ${row.title}`,
          quantity,
          sku: row.sku,
          variantId: row.id,
          price: decimal(Number(priceOf(input) ?? row.price)),
          requiresShipping: input.requiresShipping !== false,
        })
        continue
      }
      const title = text(input.title)
      const price = priceOf(input)
      if (!title) {
        errors.push({ field: [...path, "title"], message: "Title can't be blank", code: "BLANK" })
        continue
      }
      if (price === null || !Number.isFinite(Number(price))) {
        errors.push({
          field: [...path, "priceSet"],
          message: "Price must be provided for a custom line item",
          code: "BLANK",
        })
        continue
      }
      items.push({
        id: this.state.nextId("lineItem"),
        title,
        name: title,
        quantity,
        sku: text(input.sku),
        variantId: null,
        price: decimal(Number(price)),
        requiresShipping: input.requiresShipping !== false,
      })
    }
    return { items, errors }
  }

  /** Validate metafield writes; nothing is stored unless every one is valid. */
  private validateMetafields(
    inputs: Args[],
    owner: (input: Args) => { ownerId: string; ownerType: MetafieldOwnerType } | undefined,
    prefix: string,
  ): { writes: MetafieldWrite[]; errors: (FieldError & { elementIndex: number })[] } {
    const writes: MetafieldWrite[] = []
    const errors: (FieldError & { elementIndex: number })[] = []
    for (const [index, input] of inputs.entries()) {
      const path = [prefix, String(index)]
      const fail = (field: string, message: string, code: string) =>
        errors.push({ field: [...path, field], message, code, elementIndex: index })
      const resolved = owner(input)
      if (!resolved) {
        fail("ownerId", "Owner does not exist.", "INVALID")
        continue
      }
      const namespace = text(input.namespace) ?? this.appNamespace()
      const key = text(input.key) ?? ""
      const value = text(input.value) ?? ""
      if (key.length < 2) {
        fail("key", "Key is too short (minimum is 2 characters)", "INVALID")
        continue
      }
      if (namespace.length < 2) {
        fail("namespace", "Namespace is too short (minimum is 2 characters)", "INVALID")
        continue
      }
      const existing = this.state
        .metafieldsOf(resolved.ownerId, namespace)
        .find((row) => row.key === key)
      const type = text(input.type) ?? existing?.type
      if (!type) {
        fail("type", "Type can't be blank", "BLANK")
        continue
      }
      const check = METAFIELD_TYPES[type]
      if (!check) {
        fail("type", `Type '${type}' is not a valid metafield type`, "INVALID_TYPE")
        continue
      }
      const invalid = check(value)
      if (invalid) {
        fail("value", invalid, "INVALID_VALUE")
        continue
      }
      writes.push({ ...resolved, namespace, key, value, type })
    }
    return { writes, errors }
  }

  private writeMetafields(writes: MetafieldWrite[]): MetafieldRecord[] {
    const now = this.context.timestamp()
    return writes.map((write) => {
      const existing = this.state
        .metafieldsOf(write.ownerId, write.namespace)
        .find((row) => row.key === write.key)
      const row: MetafieldRecord = existing
        ? { ...existing, value: write.value, type: write.type, updatedAt: now }
        : { id: this.state.nextId("metafield"), ...write, createdAt: now, updatedAt: now }
      if (existing) this.state.metafields.update(row.id, row)
      else this.state.metafields.insert(row.id, row)
      return row
    })
  }

  private ownerOf(input: Args): { ownerId: string; ownerType: MetafieldOwnerType } | undefined {
    const parsed = typeof input.ownerId === "string" ? parseGid(input.ownerId) : undefined
    const ownerType = parsed ? OWNER_TYPES[parsed.type] : undefined
    if (!parsed || !ownerType) return undefined
    const exists =
      ownerType === "ORDER"
        ? this.state.orders.has(parsed.id)
        : ownerType === "DRAFTORDER"
          ? this.state.draftOrders.has(parsed.id)
          : ownerType === "PRODUCT"
            ? this.state.products.has(parsed.id)
            : this.state.variants.has(parsed.id)
    return exists ? { ownerId: gid(parsed.type, parsed.id), ownerType } : undefined
  }

  /** Store a new order and announce `orders/create`. */
  private insertOrder(
    fields: Omit<
      OrderRecord,
      | "id"
      | "number"
      | "name"
      | "createdAt"
      | "updatedAt"
      | "cancelledAt"
      | "cancelReason"
      | "closed"
      | "fulfillmentStatus"
    >,
  ): OrderRecord {
    const now = this.context.timestamp()
    const id = this.state.nextId("order")
    const number = Number(this.state.nextId("orderNumber"))
    const order: OrderRecord = {
      ...fields,
      id,
      number,
      name: `#${number}`,
      createdAt: now,
      updatedAt: now,
      cancelledAt: null,
      cancelReason: null,
      closed: false,
      fulfillmentStatus: "UNFULFILLED",
    }
    this.state.orders.insert(id, order)
    this.context.touched.orderId = id
    this.context.emit("orders/create", restOrder(order, []))
    return order
  }

  private orderCreate(args: Args): Resolved {
    const input = isRecord(args.order) ? args.order : {}
    const shopCurrency = this.state.current().currency
    const { items, errors } = this.lineItems(input.lineItems, ["order", "lineItems"], (line) => {
      const set = isRecord(line.priceSet) ? line.priceSet : undefined
      const shopMoney = set && isRecord(set.shopMoney) ? set.shopMoney : undefined
      return shopMoney ? String(shopMoney.amount) : null
    })
    const metafieldInputs = Array.isArray(input.metafields) ? (input.metafields as Args[]) : []
    // The order does not exist yet: validate against a placeholder owner, written after.
    const pendingOwner = { ownerId: "pending", ownerType: "ORDER" as const }
    const metafields = this.validateMetafields(metafieldInputs, () => pendingOwner, "metafields")
    const allErrors = [
      ...errors,
      ...metafields.errors.map(({ elementIndex: _index, field, ...rest }) => ({
        ...rest,
        field: field && ["order", ...field],
      })),
    ]
    if (allErrors.length > 0) return { order: null, userErrors: allErrors }
    const order = this.insertOrder({
      email: text(input.email),
      phone: text(input.phone),
      note: text(input.note),
      tags: Array.isArray(input.tags) ? (input.tags as string[]) : [],
      test: input.test === true,
      sourceName: text(input.sourceName),
      currency: text(input.currency) ?? shopCurrency,
      processedAt: text(input.processedAt) ?? this.context.timestamp(),
      financialStatus: text(input.financialStatus) ?? "PAID",
      lineItems: items,
      shippingAddress: addressInput(input.shippingAddress),
    })
    this.writeMetafields(
      metafields.writes.map((write) => ({ ...write, ownerId: gid("Order", order.id) })),
    )
    return { order: this.order(order), userErrors: [] }
  }

  private draftOrderCreate(args: Args): Resolved {
    const input = isRecord(args.input) ? args.input : {}
    const { items, errors } = this.lineItems(input.lineItems, ["lineItems"], (line) =>
      line.originalUnitPrice === undefined || line.originalUnitPrice === null
        ? null
        : String(line.originalUnitPrice),
    )
    const metafieldInputs = Array.isArray(input.metafields) ? (input.metafields as Args[]) : []
    const pendingOwner = { ownerId: "pending", ownerType: "DRAFTORDER" as const }
    const metafields = this.validateMetafields(metafieldInputs, () => pendingOwner, "metafields")
    const allErrors = [
      ...errors.map(({ code: _code, ...rest }) => rest),
      ...metafields.errors.map(({ elementIndex: _index, code: _code, ...rest }) => rest),
    ]
    if (allErrors.length > 0) return { draftOrder: null, userErrors: allErrors }
    const now = this.context.timestamp()
    const id = this.state.nextId("draftOrder")
    const draft: DraftOrderRecord = {
      id,
      name: `#D${this.state.nextId("draftOrderNumber")}`,
      status: "OPEN",
      email: text(input.email),
      phone: text(input.phone),
      note: text(input.note),
      tags: Array.isArray(input.tags) ? (input.tags as string[]) : [],
      currency: text(input.presentmentCurrencyCode) ?? this.state.current().currency,
      lineItems: items,
      shippingAddress: addressInput(input.shippingAddress),
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      orderId: null,
    }
    this.state.draftOrders.insert(id, draft)
    this.writeMetafields(
      metafields.writes.map((write) => ({ ...write, ownerId: gid("DraftOrder", id) })),
    )
    this.context.touched.draftOrderId = id
    return { draftOrder: this.draftOrder(draft), userErrors: [] }
  }

  private draftOrderComplete(args: Args): Resolved {
    const id = requireGid(args.id, "DraftOrder")
    const draft = id === undefined ? undefined : this.state.draftOrders.get(id)
    if (!draft) {
      return { draftOrder: null, userErrors: [{ field: ["id"], message: "Draft order not found" }] }
    }
    if (draft.status === "COMPLETED") {
      return {
        draftOrder: null,
        userErrors: [{ field: ["id"], message: "Draft order has already been completed" }],
      }
    }
    const order = this.insertOrder({
      email: draft.email,
      phone: draft.phone,
      note: draft.note,
      tags: draft.tags,
      test: false,
      sourceName: text(args.sourceName) ?? "shopify_draft_order",
      currency: draft.currency,
      processedAt: this.context.timestamp(),
      financialStatus: args.paymentPending === true ? "PENDING" : "PAID",
      lineItems: draft.lineItems.map((item) => ({ ...item, id: this.state.nextId("lineItem") })),
      shippingAddress: draft.shippingAddress,
    })
    const now = this.context.timestamp()
    const completed: DraftOrderRecord = {
      ...draft,
      status: "COMPLETED",
      completedAt: now,
      updatedAt: now,
      orderId: order.id,
    }
    this.state.draftOrders.update(draft.id, completed)
    this.context.touched.draftOrderId = draft.id
    return { draftOrder: this.draftOrder(completed), userErrors: [] }
  }

  private metafieldsSet(args: Args): Resolved {
    const inputs = Array.isArray(args.metafields) ? (args.metafields as Args[]) : []
    if (inputs.length > 25) {
      return {
        metafields: null,
        userErrors: [
          {
            field: ["metafields"],
            message: "Exceeded the maximum metafields input limit of 25.",
            code: "LESS_THAN_OR_EQUAL_TO",
            elementIndex: null,
          },
        ],
      }
    }
    const { writes, errors } = this.validateMetafields(
      inputs,
      (input) => this.ownerOf(input),
      "metafields",
    )
    if (errors.length > 0) return { metafields: null, userErrors: errors }
    return {
      metafields: this.writeMetafields(writes).map((row) => this.metafield(row)),
      userErrors: [],
    }
  }

  private webhookSubscriptionCreate(args: Args): Resolved {
    const topic = String(args.topic)
    const input = isRecord(args.webhookSubscription) ? args.webhookSubscription : {}
    if (input.format === "XML") {
      throw new GraphQLError("The Mockingbird emulator delivers only JSON webhooks", {
        extensions: { code: "MOCKINGBIRD_UNSUPPORTED" },
      })
    }
    const uri = text(input.callbackUrl) ?? text(input.uri)
    const field = ["webhookSubscription", input.uri !== undefined ? "uri" : "callbackUrl"]
    const reject = (message: string) => ({
      webhookSubscription: null,
      userErrors: [{ field, message }],
    })
    if (!uri) return reject("Address can't be blank")
    let protocol: string
    try {
      protocol = new URL(uri).protocol
    } catch {
      return reject("Address is invalid")
    }
    if (protocol !== "https:" && protocol !== "http:") {
      return reject(`Address protocol ${protocol}// is not supported`)
    }
    const taken = this.state.webhookSubscriptions
      .list({ where: (row) => row.topic === topic && row.uri === uri })
      .at(0)
    if (taken) return reject("Address for this topic has already been taken")
    const now = this.context.timestamp()
    const id = this.state.nextId("webhookSubscription")
    const row: WebhookSubscriptionRecord = {
      id,
      topic,
      format: "JSON",
      uri,
      includeFields: Array.isArray(input.includeFields) ? (input.includeFields as string[]) : [],
      apiVersion: this.context.apiVersion,
      createdAt: now,
      updatedAt: now,
    }
    this.state.webhookSubscriptions.insert(id, row)
    this.context.touched.webhookSubscriptionId = id
    this.context.subscriptionsChanged()
    return { webhookSubscription: this.subscription(row), userErrors: [] }
  }

  private webhookSubscriptionDelete(args: Args): Resolved {
    const id = requireGid(args.id, "WebhookSubscription")
    if (id === undefined || !this.state.webhookSubscriptions.delete(id)) {
      return {
        deletedWebhookSubscriptionId: null,
        userErrors: [{ field: ["id"], message: "Webhook subscription does not exist" }],
      }
    }
    this.context.subscriptionsChanged()
    return { deletedWebhookSubscriptionId: gid("WebhookSubscription", id), userErrors: [] }
  }
}

/** Fulfil every line of an order (the admin control), announcing both webhooks. */
export const fulfillOrder = (
  state: ShopifyState,
  orderId: string,
  tracking: TrackingInfo,
  timestamp: string,
  emit: (topic: ShopifyTopic, body: Record<string, unknown>) => void,
): { order: OrderRecord; fulfillment: FulfillmentRecord } | string => {
  const order = state.orders.get(orderId)
  if (!order) return `no order ${orderId}`
  if (order.cancelledAt) return `order ${orderId} is cancelled`
  if (order.fulfillmentStatus === "FULFILLED") return `order ${orderId} is already fulfilled`
  const count = state.fulfillmentsOf(orderId).length
  const fulfillment: FulfillmentRecord = {
    id: state.nextId("fulfillment"),
    orderId,
    name: `${order.name}.${count + 1}`,
    status: "SUCCESS",
    displayStatus: "FULFILLED",
    tracking: tracking.company || tracking.number || tracking.url ? [tracking] : [],
    createdAt: timestamp,
    updatedAt: timestamp,
    deliveredAt: null,
  }
  state.fulfillments.insert(fulfillment.id, fulfillment)
  const next: OrderRecord = { ...order, fulfillmentStatus: "FULFILLED", updatedAt: timestamp }
  state.orders.update(orderId, next)
  const all = state.fulfillmentsOf(orderId)
  emit("fulfillments/create", restFulfillment(fulfillment, next))
  emit("orders/fulfilled", restOrder(next, all))
  return { order: next, fulfillment }
}

/** Change a fulfilment's tracking or shipment status (the admin control): `fulfillments/update`. */
export const updateFulfillment = (
  state: ShopifyState,
  fulfillmentId: string,
  patch: { tracking?: TrackingInfo; displayStatus?: string },
  timestamp: string,
  emit: (topic: ShopifyTopic, body: Record<string, unknown>) => void,
): FulfillmentRecord | string => {
  const fulfillment = state.fulfillments.get(fulfillmentId)
  if (!fulfillment) return `no fulfillment ${fulfillmentId}`
  const order = state.orders.get(fulfillment.orderId) as OrderRecord
  const displayStatus = patch.displayStatus ?? fulfillment.displayStatus
  const next: FulfillmentRecord = {
    ...fulfillment,
    ...(patch.tracking ? { tracking: [patch.tracking] } : {}),
    displayStatus,
    deliveredAt: displayStatus === "DELIVERED" ? (fulfillment.deliveredAt ?? timestamp) : null,
    updatedAt: timestamp,
  }
  state.fulfillments.update(fulfillmentId, next)
  emit("fulfillments/update", restFulfillment(next, order))
  return next
}

/** Cancel an unfulfilled order (the admin control): `orders/cancelled`. */
export const cancelOrder = (
  state: ShopifyState,
  orderId: string,
  reason: string,
  timestamp: string,
  emit: (topic: ShopifyTopic, body: Record<string, unknown>) => void,
): OrderRecord | string => {
  const order = state.orders.get(orderId)
  if (!order) return `no order ${orderId}`
  if (order.cancelledAt) return `order ${orderId} is already cancelled`
  if (order.fulfillmentStatus === "FULFILLED") {
    return `order ${orderId} is fulfilled; Shopify cancels only unfulfilled orders`
  }
  const next: OrderRecord = {
    ...order,
    cancelledAt: timestamp,
    cancelReason: reason,
    closed: true,
    updatedAt: timestamp,
  }
  state.orders.update(orderId, next)
  emit("orders/cancelled", restOrder(next, state.fulfillmentsOf(orderId)))
  return next
}
