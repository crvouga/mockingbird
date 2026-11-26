/**
 * Ports of our three Wholescripts consumers, so "the mock works" means "our consumers' own
 * logic reaches the right outcome":
 *
 * - {@link BackendWholescriptsClient}: `apps/backend/.../wholescripts/wholescripts.service.ts`
 *   and its zod schemas (`wholescripts.types.ts`, verbatim below): Basic auth, schema-checked
 *   responses (a mismatch logs and yields `data: null`), the private-label restructure, and
 *   `supplements.service.ts`'s "place, then read the status back".
 * - {@link fetchEmrProductList}: the EMR's `getAllProducts` (`ProductList?instockonly=true&limit=1000`).
 * - {@link SchedulerWholescriptsAdapter}: the supplement scheduler's Python client, adapter and mappers
 *   (`supplement_management/app/adapters/wholescripts/{client,adapter,mappers}.py`).
 */
import z from "zod"

export type Fetch = (request: Request) => Promise<Response>

// --- wholescripts.types.ts (backend), verbatim ---------------------------------------------

export const ItemTimeEnum = z.enum(["AM", "PM", "AM with food", "PM with food"])
export type ItemTime = z.infer<typeof ItemTimeEnum>
export const MedPaxPillSchema = z.object({
  productId: z.string().optional(),
  Sku: z.string(),
  Quantity: z.number(),
  ItemTime: ItemTimeEnum,
})
export const OrderItemSchema = z.object({
  Sku: z.string(),
  Quantity: z.number(),
  MedPaxName: z.string().optional(),
  MedPaxPills: z.array(MedPaxPillSchema).optional(),
})
export const ShippingAddressSchema = z.object({
  FName: z.string(),
  LName: z.string(),
  Address1: z.string(),
  Address2: z.string().optional(),
  City: z.string(),
  State: z.string(),
  Zip: z.string(),
  Email: z.string().email(),
})
export const OrderSubmitRequestSchema = z.object({
  ShippingAddress: ShippingAddressSchema,
  Notes: z.string().optional(),
  Items: z.array(OrderItemSchema),
  ShippingMethod: z.string(),
})
export const OrderSubmitResponseSchema = z.object({
  orderNumber: z.string(),
  success: z.boolean(),
  msg: z.string(),
})
export const TrackingInfoSchema = z.object({
  trackingNumber: z.string(),
  carrier: z.string(),
  trackingUrl: z.string().optional(),
})
export const OrderStatusSchema = z.object({
  orderNumber: z.string(),
  orderDate: z.string(),
  salesOrder: z.string(),
  status: z.string(),
  tracking: z.array(TrackingInfoSchema),
  message: z.string(),
  subTotal: z.number(),
  shipMethod: z.string(),
  shipCharge: z.number(),
  discount: z.number(),
  tax: z.number(),
  serviceFee: z.number(),
  orderTotal: z.number(),
})
export const WholeScriptsProductSchema = z.object({
  productName: z.string(),
  sku: z.string(),
  medPaxSku: z.string(),
  categories: z.string(),
  retailPrice: z.number(),
  upc: z.string(),
  descriptionShort: z.string(),
  descriptionFull: z.string().optional(),
  brand: z.string(),
  productImage: z.string(),
  quantity: z.number(),
  countUnit: z.string(),
  wholesalePrice: z.number(),
  supplementFactsHTML: z.string(),
  defaultDosing: z.array(z.object({ time: z.string(), qty: z.number() })),
})
export const MedPaxPillInfoSchema = z.object({
  sku: z.string(),
  genericName: z.string(),
  privateLabelName: z.string(),
  quantity: z.number(),
})
export const PrivateLabelCartonSchema = z.object({
  sku: z.string(),
  name: z.string(),
  cartonImage: z.string(),
  quantity: z.number(),
})
export const PrivateLabelProductListSchema = z.object({
  privateLabelProducts: z.array(z.any()),
  medPaxPills: z.array(MedPaxPillInfoSchema),
  privateLabelCartons: z.array(PrivateLabelCartonSchema),
})
export const OrderStatusResponseSchema = z.array(OrderStatusSchema)
export const WholeScriptsProductListSchema = z.array(WholeScriptsProductSchema)
export type OrderSubmitRequest = z.infer<typeof OrderSubmitRequestSchema>
export type OrderStatus = z.infer<typeof OrderStatusSchema>
export type MedPaxPill = z.infer<typeof MedPaxPillSchema>

// --- backend WholeScriptsClientService ------------------------------------------------------

const basic = (username: string, password: string) => `Basic ${btoa(`${username}:${password}`)}`

/** The backend client; errors surface as thrown `Error`s where Nest throws exceptions. */
export class BackendWholescriptsClient {
  readonly schemaErrors: string[] = []
  private cache: z.infer<typeof PrivateLabelProductListSchema> | null = null

  constructor(
    private readonly apiUrl: string,
    private readonly credentials: { username: string; password: string },
    private readonly fetch: Fetch,
  ) {}

  private async makeApiRequest<T>(
    endpoint: string,
    schema: z.ZodType<T>,
    init: { method: string; body?: string } = { method: "GET" },
  ): Promise<{ data: T | null; status: number; message: string }> {
    let response: Response
    try {
      response = await this.fetch(
        new Request(`${this.apiUrl}${endpoint}`, {
          ...init,
          headers: {
            Authorization: basic(this.credentials.username, this.credentials.password),
            "Content-Type": "application/json",
            Accept: "*/*",
          },
        }),
      )
    } catch {
      throw new Error("Failed to make API request to Wholescripts")
    }
    if (!response.ok) throw new Error("Failed to make API request to Wholescripts")
    const raw: unknown = await response.json()
    const parsed = schema.safeParse(raw)
    if (!parsed.success) this.schemaErrors.push(parsed.error.message)
    return {
      data: parsed.success ? parsed.data : null,
      status: response.status,
      message: parsed.success ? response.statusText : parsed.error.message,
    }
  }

  /** `getPrivateLabelProducts` (cached for an hour in Redis; here for the client's life). */
  async getPrivateLabelProducts() {
    if (this.cache) return this.cache
    const response = await this.makeApiRequest(
      "/api/Orders/PrivateLabelProductList",
      PrivateLabelProductListSchema,
    )
    if (!response.data) throw new Error("Failed to get private label products from Wholescripts")
    this.cache = response.data
    return response.data
  }

  async getPrivateLabelCartons() {
    return (await this.getPrivateLabelProducts()).privateLabelCartons
  }

  /** `placeOrder`: validate, restructure into the first private-label carton, submit. */
  async placeOrder(orderData: OrderSubmitRequest) {
    const validated = OrderSubmitRequestSchema.safeParse(orderData)
    if (!validated.success) throw new Error(`Invalid order data: ${validated.error.message}`)
    const restructured = await this.restructureOrderWithPrivateLabel(orderData)
    const response = await this.makeApiRequest("/api/Orders/Submit", OrderSubmitResponseSchema, {
      method: "POST",
      body: JSON.stringify(restructured),
    })
    if (!response.data) throw new Error("Failed to submit order to WholeScripts")
    if (!response.data.success) throw new Error(`Order submission failed: ${response.data.msg}`)
    return response.data
  }

  private async restructureOrderWithPrivateLabel(
    orderData: OrderSubmitRequest,
  ): Promise<OrderSubmitRequest> {
    try {
      const cartons = await this.getPrivateLabelCartons()
      const carton = cartons[0]
      if (!carton) return orderData
      if (orderData.Items.some((item) => item.MedPaxPills && item.MedPaxPills.length > 0)) {
        return orderData
      }
      const pills: MedPaxPill[] = orderData.Items.map((item) => ({
        Sku: item.Sku,
        Quantity: item.Quantity,
        ItemTime: "AM",
      }))
      return {
        ...orderData,
        Items: [{ Sku: carton.sku, Quantity: 1, MedPaxName: carton.name, MedPaxPills: pills }],
      }
    } catch {
      return orderData
    }
  }

  /** `getOrderStatus`: the first row, or `null` when there is none (or the schema drifted). */
  async getOrderStatus(orderNumber: string): Promise<OrderStatus | null> {
    if (!orderNumber) throw new Error("Order number is required")
    const response = await this.makeApiRequest(
      `/api/Orders/Status?ordernum=${encodeURIComponent(orderNumber)}`,
      OrderStatusResponseSchema,
    )
    if (!response.data || response.data.length === 0) return null
    return response.data[0] ?? null
  }

  /**
   * `supplements.service.ts processWholeScriptsOrder`: order the pills inside the first carton,
   * then read the status back; a missing status is a failure.
   */
  async processSupplementOrder(input: {
    shippingAddress: OrderSubmitRequest["ShippingAddress"]
    lineItems: MedPaxPill[]
    shippingMethod: string
  }) {
    const cartons = await this.getPrivateLabelCartons()
    const carton = cartons[0]
    if (!carton) throw new Error("No private label cartons available")
    const placed = await this.placeOrder({
      ShippingAddress: input.shippingAddress,
      Items: [
        { Sku: carton.sku, Quantity: 1, MedPaxName: carton.name, MedPaxPills: input.lineItems },
      ],
      ShippingMethod: input.shippingMethod,
    })
    const status = await this.getOrderStatus(placed.orderNumber)
    if (!status) throw new Error("Could not retrieve order status from WholeScripts")
    return placed
  }
}

/** The EMR's `getAllProducts`: the in-stock catalog, schema-checked. */
export const fetchEmrProductList = async (
  apiUrl: string,
  credentials: { username: string; password: string },
  fetch: Fetch,
) => {
  const response = await fetch(
    new Request(`${apiUrl}/api/Orders/ProductList?instockonly=true&limit=1000`, {
      headers: {
        Authorization: basic(credentials.username, credentials.password),
        "Content-Type": "application/json",
      },
    }),
  )
  if (!response.ok) throw new Error(`Wholescripts ProductList failed: ${response.status}`)
  const parsed = WholeScriptsProductListSchema.safeParse(await response.json())
  if (!parsed.success) throw new Error("Failed to get products from Wholescripts")
  return parsed.data
}

// --- Supplement scheduler (Python) client + adapter + mappers----------------------------------------

export class VendorPermanentError extends Error {}
export class VendorTemporaryError extends Error {}
export class VendorTimeoutError extends Error {}

type Json = Record<string, unknown>

/** `WholeScriptsClient`: httpx Basic auth; 4xx never retried, 5xx and connect errors retried. */
export class SchedulerWholescriptsClient {
  constructor(
    private readonly baseUrl: string,
    private readonly credentials: { username: string; password: string },
    private readonly fetch: Fetch,
    private readonly maxAttempts = 3,
  ) {}

  async getProductList(search?: string, inStockOnly = false): Promise<Json[]> {
    const params = new URLSearchParams()
    if (search) params.set("search", search)
    if (inStockOnly) params.set("instockonly", "true")
    const query = params.toString()
    return (await this.request(
      "GET",
      `/api/Orders/ProductList${query ? `?${query}` : ""}`,
    )) as Json[]
  }

  async getPrivateLabelProductList(): Promise<Json> {
    return (await this.request("GET", "/api/Orders/PrivateLabelProductList")) as Json
  }

  async submitOrder(payload: Json): Promise<Json> {
    return (await this.request("POST", "/api/Orders/Submit", payload, true)) as Json
  }

  async getOrderStatus(orderNumber: string): Promise<Json[]> {
    return (await this.request(
      "GET",
      `/api/Orders/Status?${new URLSearchParams({ ordernum: orderNumber })}`,
    )) as Json[]
  }

  async cancelOrder(orderNumber: string): Promise<Json> {
    return (await this.request("POST", "/api/Orders/Cancel", { OrderNumber: orderNumber })) as Json
  }

  private async request(method: string, path: string, json?: Json, isSubmit = false) {
    let lastError: Error | undefined
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      let response: Response
      try {
        response = await this.fetch(
          new Request(`${this.baseUrl}${path}`, {
            method,
            headers: {
              authorization: basic(this.credentials.username, this.credentials.password),
              ...(json ? { "content-type": "application/json" } : {}),
            },
            ...(json ? { body: JSON.stringify(json) } : {}),
          }),
        )
      } catch (error) {
        // A dropped connection mid-submit reads like httpx's ReadTimeout: never retried.
        if (isSubmit) {
          throw new VendorTimeoutError("WholeScripts submit timed out. Order may have been placed.")
        }
        lastError = new VendorTemporaryError(`Connection error: ${String(error)}`)
        continue
      }
      if (response.ok) return response.json()
      const text = (await response.text()).slice(0, 500)
      if (response.status >= 400 && response.status < 500) {
        throw new VendorPermanentError(`WholeScripts ${response.status}: ${text}`)
      }
      lastError = new VendorTemporaryError(`WholeScripts ${response.status}: ${text}`)
    }
    throw lastError ?? new VendorTemporaryError("All retry attempts failed")
  }
}

export type FulfillmentItem = {
  product_id: string
  quantity: number
  fulfillment: "medpax" | "individual"
  dosing_time?: string
}

export type VendorOrderRequest = {
  shipping_address: {
    first_name: string
    last_name: string
    address1: string
    address2: string | null
    city: string
    state: string
    zip_code: string
    email: string | null
  }
  notes: string | null
  shipping_method: string
  context: {
    fulfillment_items: FulfillmentItem[]
    member_first_name?: string
    cadence_days?: number
  }
}

/** `mappers.build_submit_payload`. */
export const buildSubmitPayload = (
  request: VendorOrderRequest,
  memberFirstName: string,
  cadenceDays: number,
  medpaxBoxSku: string,
): Json => {
  const addr = request.shipping_address
  const shipping: Json = {
    FName: addr.first_name,
    LName: addr.last_name,
    Address1: addr.address1,
    Address2: addr.address2,
    City: addr.city,
    State: addr.state,
    Zip: addr.zip_code,
  }
  if (addr.email) shipping.Email = addr.email
  const items: Json[] = []
  const pills = request.context.fulfillment_items.filter((fi) => fi.fulfillment === "medpax")
  const individual = request.context.fulfillment_items.filter((fi) => fi.fulfillment !== "medpax")
  if (pills.length > 0) {
    items.push({
      Sku: medpaxBoxSku,
      Quantity: cadenceDays >= 60 ? 2 : 1,
      MedPaxName: memberFirstName,
      MedPaxPills: pills.map((p) => ({
        Sku: p.product_id,
        Quantity: p.quantity,
        ItemTime: p.dosing_time,
      })),
    })
  }
  for (const fi of individual) items.push({ Sku: fi.product_id, Quantity: fi.quantity })
  return {
    ShippingAddress: shipping,
    Notes: request.notes,
    ShippingMethod: request.shipping_method,
    Items: items,
  }
}

export type SchedulerOrderStatus = "failed" | "cancelled" | "shipped" | "placed" | "unknown"

/** `mappers._map_ws_status`. */
export const mapWsStatus = (wsStatus: string, tracking: unknown[]): SchedulerOrderStatus => {
  const lower = wsStatus.toLowerCase().trim()
  if (lower.includes("error")) return "failed"
  if (lower.includes("cancel")) return "cancelled"
  if (lower === "complete") return "shipped"
  if (lower === "processing" || lower === "pending")
    return tracking.length > 0 ? "shipped" : "placed"
  return "unknown"
}

const snake = (name: string) => name.replace(/(?<=[a-z0-9])([A-Z])/g, "_$1").toLowerCase()

/** `mappers.parse_status_response`. */
export const parseStatusResponse = (vendorOrderId: string, raw: Json) => {
  const wsStatus = typeof raw.status === "string" ? raw.status : ""
  const tracking = Array.isArray(raw.tracking) ? raw.tracking : []
  const metadata: Json = {}
  for (const key of [
    "subTotal",
    "shipCharge",
    "discount",
    "tax",
    "serviceFee",
    "orderTotal",
    "shipMethod",
    "salesOrder",
    "message",
  ]) {
    if (key in raw) metadata[snake(key)] = raw[key]
  }
  return {
    vendor_order_id: vendorOrderId,
    status: mapWsStatus(wsStatus, tracking),
    // The scheduler's VendorOrderStatus types these as list[str] but passes the vendor's tracking
    // objects through unchanged.
    tracking_numbers: tracking,
    raw_status: wsStatus,
    metadata: (Object.keys(metadata).length > 0 ? metadata : null) as Json | null,
  }
}

/** `WholeScriptsVendorAdapter`. */
export class SchedulerWholescriptsAdapter {
  constructor(
    private readonly client: SchedulerWholescriptsClient,
    private readonly medpaxBoxSku = "000000000200095263",
  ) {}

  async placeOrder(request: VendorOrderRequest) {
    const addr = request.shipping_address
    const missing = (
      ["first_name", "last_name", "address1", "city", "state", "zip_code"] as const
    ).filter((f) => !addr[f])
    if (missing.length > 0) {
      throw new VendorPermanentError(
        `Shipping address missing required fields: ${missing.join(", ")}`,
      )
    }
    const payload = buildSubmitPayload(
      request,
      request.context.member_first_name ?? "Patient",
      request.context.cadence_days ?? 30,
      this.medpaxBoxSku,
    )
    const result = await this.client.submitOrder(payload)
    if (!result.success) {
      throw new VendorPermanentError(
        `WholeScripts rejected order: ${String(result.msg ?? "Order rejected by WholeScripts")}`,
      )
    }
    return { vendor_order_id: String(result.orderNumber), status: "placed" as const }
  }

  async getOrderStatus(vendorOrderId: string) {
    const results = await this.client.getOrderStatus(vendorOrderId)
    const first = results[0]
    if (!first) {
      return {
        vendor_order_id: vendorOrderId,
        status: "unknown" as const,
        tracking_numbers: [],
        raw_status: null,
        metadata: { reason: "no_results" } as Json | null,
      }
    }
    return parseStatusResponse(vendorOrderId, first)
  }

  async cancelOrder(vendorOrderId: string) {
    const result = await this.client.cancelOrder(vendorOrderId)
    return { success: Boolean(result.success ?? false), message: String(result.msg ?? "") }
  }

  /** `check_stock`: by product SKU, or by MedPax SKU from `medPaxDetails.quantity`. */
  async checkStock(skus: string[]): Promise<Record<string, boolean>> {
    const products = await this.client.getProductList()
    const bySku = new Map<string, Json>()
    const medpaxSkus = new Set<string>()
    for (const p of products) {
      bySku.set(String(p.sku), p)
      if (p.medPaxSku) {
        bySku.set(String(p.medPaxSku), p)
        medpaxSkus.add(String(p.medPaxSku))
      }
    }
    const result: Record<string, boolean> = {}
    for (const sku of skus) {
      const p = bySku.get(sku) ?? {}
      const mpd = p.medPaxDetails as Json | null | undefined
      result[sku] =
        medpaxSkus.has(sku) && mpd && typeof mpd === "object"
          ? Boolean(mpd.quantity)
          : Boolean(p.quantity)
    }
    return result
  }
}

/** An order the way the supplement scheduler builds one. */
export const sampleSchedulerOrder = (): VendorOrderRequest => ({
  shipping_address: {
    first_name: "Ada",
    last_name: "Lovelace",
    address1: "1 Main St",
    address2: null,
    city: "Phoenix",
    state: "AZ",
    zip_code: "85004",
    email: "ada@example.com",
  },
  notes: null,
  shipping_method: "Ground",
  context: {
    member_first_name: "Ada",
    cadence_days: 30,
    fulfillment_items: [
      { product_id: "MPVD001", quantity: 30, fulfillment: "medpax", dosing_time: "AM" },
      { product_id: "MP001", quantity: 30, fulfillment: "medpax", dosing_time: "PM with food" },
      { product_id: "SKU002", quantity: 1, fulfillment: "individual" },
    ],
  },
})
