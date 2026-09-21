/**
 * A port of our backend's Gene by Gene transport and webhook receiver:
 *
 * - `GXG/transport/gxg-auth.service.ts`: client-credentials token, cache with a 60 s refresh
 *   skew and a 5 min default TTL, in-flight dedup, and the **permanent credential block** on a
 *   401 / 403 / 400 `invalid_client` from the token endpoint.
 * - `GXG/transport/gxg-http-client.ts`: Bearer on every call; on a 401 invalidate the cached
 *   token and retry exactly once.
 * - `GXG/transport/gxg-client.ts`: the calls, their query params, and `404 → null / empty`.
 * - `GXG/orders/gxg-order-cancel.service.ts` + `gxg-order-cancel-graph.ts`: the three-layer cancel.
 * - `GXG/orders/gxg-product-placement.ts`, `GXG/shipping/gxg-shipping-options.ts`: placement.
 * - `GXG/patients/gxg-kit-attributes.ts`: the demographics PATCH (skips `WBQA` kits).
 * - `GXG/results/gxg-results-payload-fetcher.ts`: presignedUrl, then a plain GET.
 * - `GXG/webhooks/gxg-webhook-event-source.ts` (+ signature and extractors): verification and
 *   the id reads that trigger a scoped sync.
 *
 * The acceptance tests drive the mock only through this, so "the mock works" means "our
 * consumer's own logic reaches the right outcome".
 */
import { createHmac, timingSafeEqual } from "node:crypto"

export type Fetch = (request: Request) => Promise<Response>

const TOKEN_REFRESH_SKEW_MS = 60_000
const DEFAULT_TOKEN_TTL_MS = 5 * 60_000

export class GxgAuthService {
  private cachedToken: string | null = null
  private tokenExpiresAt = 0
  private pending: Promise<string> | null = null
  private blockedAuthError: Error | null = null
  tokenRequests = 0

  constructor(
    private readonly options: {
      tokenUrl: string
      clientId: string
      clientSecret: string
      fetch: Fetch
    },
  ) {}

  isCredentialBlocked(): boolean {
    return this.blockedAuthError !== null
  }

  async getAccessToken(): Promise<string> {
    if (this.blockedAuthError !== null) throw this.blockedAuthError
    if (this.cachedToken && Date.now() < this.tokenExpiresAt - TOKEN_REFRESH_SKEW_MS) {
      return this.cachedToken
    }
    if (!this.pending) {
      this.pending = this.fetchNewToken().finally(() => {
        this.pending = null
      })
    }
    return this.pending
  }

  invalidateAccessToken(): void {
    this.cachedToken = null
    this.tokenExpiresAt = 0
    this.pending = null
  }

  private async fetchNewToken(): Promise<string> {
    this.tokenRequests++
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.options.clientId,
      client_secret: this.options.clientSecret,
    }).toString()
    const response = await this.options.fetch(
      new Request(this.options.tokenUrl, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        },
        body,
      }),
    )
    if (!response.ok) {
      const errorText = await response.text().catch(() => "<no body>")
      const error = new Error(
        `Gene-by-Gene auth failed: HTTP ${response.status} ${response.statusText}. Body: ${errorText.slice(0, 1000)}`,
      )
      if (isPermanentTokenEndpointAuthFailure(response.status, errorText)) {
        this.blockedAuthError ??= error
      }
      throw error
    }
    const payload = (await response.json()) as { access_token?: unknown; expires_in?: unknown }
    const token = typeof payload.access_token === "string" ? payload.access_token.trim() : ""
    if (token.length === 0) throw new Error("Gene-by-Gene auth response missing access_token")
    const expiresInSec =
      typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in)
        ? Math.max(0, Math.floor(payload.expires_in))
        : null
    this.cachedToken = token
    this.tokenExpiresAt =
      Date.now() + (expiresInSec !== null ? expiresInSec * 1000 : DEFAULT_TOKEN_TTL_MS)
    return token
  }
}

export const isPermanentTokenEndpointAuthFailure = (status: number, errorBody: string) =>
  status === 401 || status === 403 || (status === 400 && errorBody.includes("invalid_client"))

export type GxgResult<T = unknown> = { data?: T; error?: unknown; response: Response }

/** openapi-fetch semantics: `data` on 2xx (undefined for 204), `error` otherwise. */
export class GxgHttpClient {
  constructor(
    private readonly baseUrl: string,
    private readonly auth: GxgAuthService,
    private readonly fetch: Fetch,
  ) {}

  async request<T = unknown>(
    method: string,
    path: string,
    init: {
      query?: Record<string, string | number | undefined>
      body?: unknown
      headers?: Record<string, string>
    } = {},
  ): Promise<GxgResult<T>> {
    const url = new URL(`${this.baseUrl.replace(/\/$/, "")}${path}`)
    for (const [key, value] of Object.entries(init.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    const body = init.body === undefined ? null : JSON.stringify(init.body)
    const send = async (token: string) =>
      this.fetch(
        new Request(url, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(body !== null ? { "Content-Type": "application/json" } : {}),
            ...init.headers,
          },
          ...(body !== null ? { body } : {}),
        }),
      )
    let response = await send(await this.auth.getAccessToken())
    if (response.status === 401) {
      // gxg-http-client.ts: invalidate and retry exactly once.
      this.auth.invalidateAccessToken()
      response = await send(await this.auth.getAccessToken())
    }
    const text = await response.text()
    const parsed = text.length > 0 ? safeJson(text) : undefined
    if (response.ok) return { data: parsed as T, response }
    return { error: parsed ?? text, response }
  }
}

const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** `gxgErrorFromHttp`'s upstream message read: ErrorDto `message`, else problem `title`/`detail`. */
export const upstreamMessage = (error: unknown): string => {
  if (typeof error === "string") return error
  if (!error || typeof error !== "object") return ""
  const record = error as Record<string, unknown>
  if (typeof record.message === "string") return record.message
  if (record.errors && typeof record.errors === "object") {
    const parts = Object.entries(record.errors as Record<string, string[]>).map(
      ([field, messages]) => `${field}: ${messages.join("; ")}`,
    )
    return `${typeof record.title === "string" ? `${record.title} — ` : ""}${parts.join(" | ")}`
  }
  if (typeof record.title === "string") return record.title
  if (typeof record.detail === "string") return record.detail
  return ""
}

export const statusToCode = (status: number) =>
  status === 400 || status === 422
    ? "validation"
    : status === 401 || status === 403
      ? "auth"
      : status === 404
        ? "not_found"
        : status === 409
          ? "state_invalid"
          : status === 429
            ? "rate_limit"
            : status >= 500
              ? "upstream"
              : "unknown"

export class GxgError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

const fail = (result: GxgResult, fallback: string) =>
  new GxgError(
    result.response.status,
    statusToCode(result.response.status),
    `${fallback} (http=${result.response.status}): ${upstreamMessage(result.error)}`,
  )

type Page<T> = { items: T[]; totalCount: number | undefined }
const page = <T>(data: unknown): Page<T> => {
  const record = (data ?? {}) as { items?: unknown; totalCount?: unknown }
  return {
    items: Array.isArray(record.items) ? (record.items as T[]) : [],
    totalCount: typeof record.totalCount === "number" ? record.totalCount : undefined,
  }
}

type Json = Record<string, unknown>

/** `GXG/transport/gxg-client.ts` (plus the placement / attributes / subscription calls). */
export class GxgClient {
  constructor(readonly http: GxgHttpClient) {}

  async fetchProduct(productId: string): Promise<Json | null> {
    const result = await this.http.request<Json[]>("GET", "/api/v2/products", {
      query: { productId },
    })
    if (result.response.status === 404) return null
    if (result.error || !result.data) throw fail(result, "GxG getProduct failed")
    const rows = Array.isArray(result.data) ? result.data : []
    return rows.find((row) => row.id === productId) ?? rows[0] ?? null
  }

  async fetchOrderFromVendor(orderId: string): Promise<Json | null> {
    const result = await this.http.request<Json>("GET", `/api/v2/orders/${orderId}`)
    if (result.response.status === 404) return null
    if (result.error || !result.data) throw fail(result, "GxG getOrder failed")
    return result.data
  }

  async fetchKit(kitNumber: string): Promise<Json | null> {
    const result = await this.http.request<Json>("GET", `/api/v2/kits/${kitNumber}`)
    if (result.response.status === 404) return null
    if (result.error || !result.data) throw fail(result, `GxG getKit ${kitNumber} failed`)
    return result.data
  }

  async fetchVendorOrdersListPage(args: { offset: number; pageSize: number }) {
    const result = await this.http.request("GET", "/api/v2/orders", { query: args })
    if (result.error || !result.data) throw fail(result, "GxG listOrders failed")
    return page<Json>(result.data)
  }

  async fetchFulfillmentsByOrderId(args: { orderId: string; offset: number; pageSize: number }) {
    const result = await this.http.request("GET", "/api/v2/fulfillments", { query: args })
    if (result.error || !result.data) throw fail(result, "GxG listFulfillments failed")
    return page<Json>(result.data)
  }

  async fetchKitOrderLinesByOrderId(args: { orderId: string; offset: number; pageSize: number }) {
    const result = await this.http.request("GET", "/api/v2/kitorderlines", { query: args })
    if (result.response.status === 404) return { items: [], totalCount: 0 }
    if (result.error || !result.data) throw fail(result, "GxG listKitOrderLines failed")
    return page<Json>(result.data)
  }

  async fetchResultsByKitNumber(args: { kitNumber: string; offset: number; pageSize: number }) {
    const result = await this.http.request("GET", "/api/v2/results", { query: args })
    if (result.response.status === 404) return { items: [], totalCount: 0 }
    if (result.error || !result.data) throw fail(result, "GxG listResults failed")
    return page<Json>(result.data)
  }

  async fetchKitResults(kitNumber: string) {
    const result = await this.http.request<Json>("GET", `/api/v2/kits/${kitNumber}/results`)
    if (result.response.status === 404) return { data: null, items: [] as Json[] }
    if (result.error || !result.data) throw fail(result, "GxG getKitResults failed")
    const items = result.data.kitResults
    return { data: result.data, items: Array.isArray(items) ? (items as Json[]) : [] }
  }

  async fetchResultPresignedUrl(args: {
    resultId?: string
    kitNumber?: string
    resultType?: string
  }) {
    const result = await this.http.request<Json>("GET", "/api/v2/results/results/presignedUrl", {
      query: args,
    })
    if (result.error || !result.data) throw fail(result, "GxG fetchResultPresignedUrl failed")
    const presignedUrl =
      typeof result.data.presignedUrl === "string" && result.data.presignedUrl.length > 0
        ? result.data.presignedUrl
        : null
    if (!presignedUrl) throw new Error("GxG fetchResultPresignedUrl: response missing presignedUrl")
    const resultId =
      typeof result.data.resultId === "string" && result.data.resultId.length > 0
        ? result.data.resultId
        : args.resultId
    return { presignedUrl, resultId }
  }

  postGetShippingOptions(body: { shippingAddress: Json; quantity: 1; productId: string }) {
    return this.http.request<Json>("POST", "/api/v2/fulfillments/actions/getShippingOptions", {
      body,
    })
  }

  postCreateOrder(body: Json) {
    return this.http.request<Json>("POST", "/api/v2/orders", { body })
  }

  postCreateOrderForExistingKits(body: Json) {
    return this.http.request<Json>("POST", "/api/v2/orders/actions/createOrderForExistingKits", {
      body,
    })
  }

  postUpdateShipmentAddress(body: Json) {
    return this.http.request<Json>("POST", "/api/v2/fulfillments/actions/updateShipmentAddress", {
      body,
      headers: { "Content-Type": "application/json" },
    })
  }

  deleteFulfillment(id: string) {
    return this.http.request("DELETE", `/api/v2/fulfillments/${id}`)
  }

  deleteKitOrderLines(kitNumber: string) {
    return this.http.request("DELETE", `/api/v2/kits/${kitNumber}/orderLines`)
  }

  deleteOrderLine(id: string) {
    return this.http.request("DELETE", `/api/v2/orderLines/${id}`)
  }

  /** `gxg-webhook-event-source.ts` createVendorSubscription (the genomics-cli sends json-patch+json). */
  async createNotificationSubscription(callbackUrl: string, events: readonly string[]) {
    const subscribable = events.filter((e) => e !== "GxG.Nucleus.Kit.KitOrderLine.Canceled")
    const result = await this.http.request<Json>("POST", "/api/v2/notificationSubscriptions", {
      body: { type: "webhook", endPoint: callbackUrl, events: subscribable },
      headers: { "Content-Type": "application/json-patch+json" },
    })
    if (result.error || !result.data) throw fail(result, "GxgWebhookEventSource.create failed")
    if (!result.data.id || !result.data.secret) {
      throw new Error("GxgWebhookEventSource.create: vendor response missing id or secret")
    }
    return { externalId: String(result.data.id), secret: String(result.data.secret) }
  }

  async listVendorSubscriptions() {
    const result = await this.http.request<Json[]>("GET", "/api/v2/notificationSubscriptions", {
      query: { type: "webhook" },
    })
    if (result.error) throw fail(result, "GxgWebhookEventSource.list failed")
    return (result.data ?? []).map((sub) => ({
      externalId: String(sub.id),
      endpoint: (sub.endPoint as string | null) ?? null,
      events: Array.isArray(sub.events) ? (sub.events as string[]) : [],
      active: (sub.active as boolean | undefined) ?? true,
      ...(typeof sub.secret === "string" && sub.secret.length > 0
        ? { signingSecret: sub.secret }
        : {}),
    }))
  }

  async deleteVendorSubscription(id: string) {
    const result = await this.http.request("DELETE", `/api/v2/notificationSubscriptions/${id}`)
    if (result.error) throw fail(result, "GxgWebhookEventSource.delete failed")
  }
}

// --- placement (gxg-product-placement.ts / gxg-shipping-options.ts) ----------------------------

export const GXG_SHIPPED_ORDER_ADDRESS_NOT_VALIDATED_FRAGMENT = "shipping address(es) not validated"
export const GXG_ADDRESS_NOT_FOUND_FRAGMENT = "address not found"
export const GXG_SHIPPING_OPTIONS_NOT_VALID_FRAGMENT = "not valid for shipping options"

export const buildShippedCreateOrderBody = (input: {
  productId: string
  placerOrderNumber: string
  address: Json
  courierServiceCode: string
  clientReferenceId?: string
}) => ({
  items: [
    {
      productId: input.productId,
      placerOrderNumber: input.placerOrderNumber,
      shipments: [
        {
          quantity: 1,
          address: input.address,
          courierServiceCode: input.courierServiceCode,
          referenceId: input.clientReferenceId ?? null,
        },
      ],
    },
  ],
  notes: input.clientReferenceId ?? null,
})

export const buildQuantityOnlyCreateOrderBody = (input: {
  productId: string
  placerOrderNumber: string
}) => ({
  items: [{ productId: input.productId, placerOrderNumber: input.placerOrderNumber, quantity: 1 }],
  notes: null,
})

export type ShippingOptionsResult =
  | { ok: true; courierServiceCodes: string[] }
  | { ok: false; code: string; message: string; errorMessages?: string[] }

export const fetchShippingOptions = async (
  client: GxgClient,
  productId: string,
  address: Json,
): Promise<ShippingOptionsResult> => {
  const { data, error, response } = await client.postGetShippingOptions({
    shippingAddress: address,
    quantity: 1,
    productId,
  })
  if (error || !data) {
    return {
      ok: false,
      code: statusToCode(response.status),
      message: `GxG getShippingOptions failed (http=${response.status}): ${upstreamMessage(error)}`,
    }
  }
  const errorMessages = Array.isArray(data.errorMessages) ? data.errorMessages.map(String) : []
  if (errorMessages.length > 0) {
    return {
      ok: false,
      code: "validation",
      errorMessages,
      message: `GxG getShippingOptions returned validation errors: ${errorMessages.join("; ")}`,
    }
  }
  const options = Array.isArray(data.shippingOptions) ? (data.shippingOptions as Json[]) : []
  const codes = options
    .map((o) => o.courierServiceCode)
    .filter((c): c is string => typeof c === "string" && c.length > 0)
  if (codes.length === 0) return { ok: false, code: "validation", message: "no shipping options" }
  return { ok: true, courierServiceCodes: codes }
}

export const extractKitNumbersFromGxgOrder = (order: Json): string[] => {
  const collected = new Set<string>()
  for (const line of (order.orderLines as Json[] | null) ?? []) {
    const kits = (line.kitNumbers ?? line.KitNumbers ?? []) as string[]
    for (const kit of kits) if (typeof kit === "string" && kit.length > 0) collected.add(kit)
  }
  return [...collected]
}

export type PlaceResult =
  | { ok: true; orderId: string; kitNumbers: string[]; placement: "shipped" | "quantity-only" }
  | { ok: false; code: string; message: string; addressValidationFailed: boolean }

/**
 * The placement flow: product lookup, shipping options, shipped create; on a
 * "not valid for shipping options" failure fall back to a quantity-only order.
 */
export const placeOrder = async (
  client: GxgClient,
  input: { productId: string; placerOrderNumber: string; address: Json },
): Promise<PlaceResult> => {
  const product = await client.fetchProduct(input.productId)
  if (!product)
    return {
      ok: false,
      code: "not_found",
      message: "product not found",
      addressValidationFailed: false,
    }
  const requiresShipping = product.shippingQualified !== false
  let body: Json = buildQuantityOnlyCreateOrderBody(input)
  let placement: "shipped" | "quantity-only" = "quantity-only"
  if (requiresShipping) {
    const options = await fetchShippingOptions(client, input.productId, input.address)
    if (options.ok) {
      body = buildShippedCreateOrderBody({
        ...input,
        courierServiceCode: options.courierServiceCodes[0] as string,
      })
      placement = "shipped"
    } else if (!options.message.toLowerCase().includes(GXG_SHIPPING_OPTIONS_NOT_VALID_FRAGMENT)) {
      const haystack = options.message.toLowerCase()
      return {
        ok: false,
        code: options.code,
        message: options.message,
        addressValidationFailed:
          haystack.includes(GXG_SHIPPED_ORDER_ADDRESS_NOT_VALIDATED_FRAGMENT) ||
          haystack.includes(GXG_ADDRESS_NOT_FOUND_FRAGMENT),
      }
    }
  }
  const { data, error, response } = await client.postCreateOrder(body)
  if (error || !data || typeof data.id !== "string") {
    const message = upstreamMessage(error)
    const haystack = message.toLowerCase()
    return {
      ok: false,
      code: statusToCode(response.status),
      message: `GxG createOrder failed (http=${response.status}): ${message}`,
      addressValidationFailed:
        haystack.includes(GXG_SHIPPED_ORDER_ADDRESS_NOT_VALIDATED_FRAGMENT) ||
        haystack.includes(GXG_ADDRESS_NOT_FOUND_FRAGMENT),
    }
  }
  return { ok: true, orderId: data.id, kitNumbers: extractKitNumbersFromGxgOrder(data), placement }
}

// --- kit demographics (gxg-kit-attributes.ts) ---------------------------------------------------

export class GxgKitAttributesPatchError extends Error {
  constructor(
    readonly kitNumber: string,
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
  get isValidationFailure() {
    return this.status === 400 || this.status === 422
  }
}

export const demographicsToKitAttributes = (d: {
  firstName: string
  lastName: string
  dob: string
  sex: "male" | "female" | "other"
  race?: string
  ethnicity?: string
}) => {
  const out = [
    { name: "firstname", value: d.firstName },
    { name: "lastname", value: d.lastName },
  ]
  const dob = /^\d{8}$/.test(d.dob) ? d.dob : d.dob.replace(/-/g, "")
  if (/^\d{8}$/.test(dob)) out.push({ name: "dateofbirth", value: dob })
  out.push({ name: "gender", value: d.sex === "male" ? "M" : d.sex === "female" ? "F" : "Unknown" })
  out.push({ name: "race", value: d.race?.trim() || "Unknown" })
  out.push({ name: "ethnicity", value: d.ethnicity?.trim() || "Unknown" })
  return out
}

export const patchKitDemographics = async (
  client: GxgClient,
  kitNumber: string,
  attributes: { name: string; value: string }[],
): Promise<"skipped" | "patched"> => {
  if (kitNumber.trim().startsWith("WBQA")) return "skipped"
  const { error, response } = await client.http.request(
    "PATCH",
    `/api/v2/kits/${kitNumber}/attributes`,
    { body: { kitNumber, attributes } },
  )
  if (error) {
    throw new GxgKitAttributesPatchError(
      kitNumber,
      response.status,
      `GxG PATCH kit ${kitNumber} attributes failed: ${upstreamMessage(error)}`,
    )
  }
  return "patched"
}

// --- shipment address (gxg-shipment-address.ts) ------------------------------------------------

export const patchOutboundShipmentAddress = async (
  client: GxgClient,
  orderId: string,
  patch: {
    line1: string
    line2?: string
    city: string
    state: string
    zip: string
    country?: string
  },
): Promise<{ ok: true } | { ok: false; reason: string }> => {
  const fulfillments = await client.fetchFulfillmentsByOrderId({
    orderId,
    offset: 0,
    pageSize: 100,
  })
  const shipment = fulfillments.items
    .flatMap((f) => (f.shipments as Json[] | null) ?? [])
    .find((s) => s.isReturnShipment !== true)
  if (!shipment) return { ok: false, reason: "no outbound shipment" }
  if (typeof shipment.trackingNumber === "string" && shipment.trackingNumber.length > 0) {
    return { ok: false, reason: `Outbound shipment ${shipment.id} already has trackingNumber` }
  }
  const existing = (shipment.address ?? {}) as Json
  const { error, response } = await client.postUpdateShipmentAddress({
    id: shipment.id,
    isReturnShipment: false,
    address: {
      isCommercial: existing.isCommercial === true,
      recipientName: existing.recipientName ?? null,
      addressLine1: patch.line1.trim(),
      addressLine2: patch.line2?.trim() || null,
      addressLine3: existing.addressLine3 ?? null,
      city: patch.city.trim(),
      stateOrRegion: patch.state.trim().toUpperCase(),
      postalCode: patch.zip.trim(),
      countryCode: patch.country ?? "US",
      email: existing.email ?? null,
      phone: existing.phone ?? null,
      shippingInstruction: existing.shippingInstruction ?? null,
      referenceId: existing.referenceId ?? null,
    },
  })
  if (error) return { ok: false, reason: `http=${response.status}: ${upstreamMessage(error)}` }
  // Our code verifies by refetching: the change must be visible on the next GET.
  const after = await client.fetchFulfillmentsByOrderId({ orderId, offset: 0, pageSize: 100 })
  const refetched = after.items
    .flatMap((f) => (f.shipments as Json[] | null) ?? [])
    .find((s) => s.id === shipment.id)
  const line1 = ((refetched?.address ?? {}) as Json).addressLine1
  return line1 === patch.line1.trim() ? { ok: true } : { ok: false, reason: "address not applied" }
}

// --- three-layer cancel (gxg-order-cancel.service.ts) ------------------------------------------

const isNotYetCancellable = (message: string) => /not in a cancellable status/i.test(message)
const lineCancelled = (line: Json) =>
  String(line.currentStatus ?? "")
    .toLowerCase()
    .includes("cancel")
const orderEffectivelyCancelled = (order: Json | null) => {
  if (order == null) return true
  const lines = (order.orderLines as Json[] | null) ?? []
  return lines.length === 0 || lines.every(lineCancelled)
}

export type CancelOutcome =
  | { ok: true; kind: "cancelled" | "already_cancelled"; counts: number[] }
  | { ok: false; code: "state_invalid" | "upstream"; message: string }

export const cancelOrder = async (client: GxgClient, orderId: string): Promise<CancelOutcome> => {
  let vendorOrder: Json | null = null
  let notFound = false
  try {
    vendorOrder = await client.fetchOrderFromVendor(orderId)
    notFound = vendorOrder == null
  } catch {}
  const fulfillmentIds = new Set<string>()
  const kitNumbers = new Set<string>()
  const orderLineIds = new Set<string>()
  for (const line of (vendorOrder?.orderLines as Json[] | null) ?? []) {
    orderLineIds.add(String(line.id))
    for (const f of (line.fulfillments as Json[] | null) ?? []) fulfillmentIds.add(String(f.id))
  }
  for (const kit of vendorOrder ? extractKitNumbersFromGxgOrder(vendorOrder) : [])
    kitNumbers.add(kit)
  try {
    const listed = await client.fetchFulfillmentsByOrderId({ orderId, offset: 0, pageSize: 100 })
    for (const f of listed.items) fulfillmentIds.add(String(f.id))
  } catch {}
  try {
    const listed = await client.fetchKitOrderLinesByOrderId({ orderId, offset: 0, pageSize: 100 })
    for (const row of listed.items) {
      if (row.kitNumber) kitNumbers.add(String(row.kitNumber))
      if (row.orderLineId) orderLineIds.add(String(row.orderLineId))
    }
  } catch {}
  const empty = fulfillmentIds.size === 0 && kitNumbers.size === 0 && orderLineIds.size === 0
  if (empty) {
    if (notFound || (vendorOrder && orderEffectivelyCancelled(vendorOrder))) {
      return { ok: true, kind: "already_cancelled", counts: [0, 0, 0] }
    }
    return { ok: false, code: "state_invalid", message: "Order is not yet cancellable" }
  }
  const layer = async (ids: Set<string>, cancel: (id: string) => Promise<GxgResult>) => {
    const failures: { status: number; message: string }[] = []
    let succeeded = 0
    for (const id of ids) {
      const result = await cancel(id)
      const status = result.response.status
      if (status === 404 || (result.error == null && status < 400)) succeeded++
      else failures.push({ status, message: upstreamMessage(result.error) })
    }
    return { failures, succeeded }
  }
  const failed = (failures: { message: string }[], at: string): CancelOutcome =>
    failures.every((f) => isNotYetCancellable(f.message))
      ? { ok: false, code: "state_invalid", message: "Order is not yet cancellable" }
      : { ok: false, code: "upstream", message: `GxG cancelOrder failed at ${at}` }
  const fulfillments = await layer(fulfillmentIds, (id) => client.deleteFulfillment(id))
  if (
    fulfillments.failures.length > 0 &&
    !fulfillments.failures.every((f) => isNotYetCancellable(f.message))
  ) {
    return failed(fulfillments.failures, "fulfillments")
  }
  const kits = await layer(kitNumbers, (kit) => client.deleteKitOrderLines(kit))
  if (kits.failures.length > 0) return failed(kits.failures, "kitOrderLines")
  const lines = await layer(orderLineIds, (id) => client.deleteOrderLine(id))
  if (lines.failures.length > 0) return failed(lines.failures, "orderLines")
  const refreshed = await client.fetchOrderFromVendor(orderId).catch(() => null)
  if (!orderEffectivelyCancelled(refreshed)) {
    return {
      ok: false,
      code: "upstream",
      message: "GxG cancel completed but vendor order is not cancelled",
    }
  }
  return {
    ok: true,
    kind: "cancelled",
    counts: [fulfillments.succeeded, kits.succeeded, lines.succeeded],
  }
}

// --- results (gxg-results-payload-fetcher.ts) --------------------------------------------------

export type PresignedFetch =
  | { ok: true; contentType: string | undefined; bytes: Uint8Array }
  | { ok: false; kind: "presigned_fetch_failed"; statusCode: number; isAccessDenied: boolean }

export const fetchResultPayload = async (
  client: GxgClient,
  job: { kitNumber: string; resultId?: string; resultType?: string },
  fetchImpl: Fetch,
): Promise<PresignedFetch> => {
  const { presignedUrl } = await client.fetchResultPresignedUrl(job)
  const response = await fetchImpl(new Request(presignedUrl))
  if (!response.ok) {
    const bodySnippet = (await response.text()).slice(0, 500)
    return {
      ok: false,
      kind: "presigned_fetch_failed",
      statusCode: response.status,
      isAccessDenied:
        response.status === 403 ||
        bodySnippet.includes("AccessDenied") ||
        bodySnippet.includes("Access Denied"),
    }
  }
  return {
    ok: true,
    contentType: response.headers.get("content-type") ?? undefined,
    bytes: new Uint8Array(await response.arrayBuffer()),
  }
}

// --- webhook receiver (gxg-webhook-event-source.ts) --------------------------------------------

export const signGxgWebhookBody = (secret: string, rawBody: string | Buffer) =>
  `sha512=${createHmac("sha512", secret)
    .update(typeof rawBody === "string" ? Buffer.from(rawBody) : rawBody)
    .digest("hex")}`

export type VerifyResult = {
  status: "verified" | "rejected"
  reason?: "missing-signature-header" | "no-stored-secret" | "signature-mismatch"
  eventType: string | undefined
  externalEventId: string | undefined
}

export const verifyGxgWebhook = (input: {
  headers: Headers
  rawBody: string
  secrets: readonly string[]
}): VerifyResult => {
  const signatureHeader = input.headers.get("gxg-signature") ?? undefined
  const eventType = input.headers.get("gxg-eventtype") ?? undefined
  const externalEventId = input.headers.get("gxg-notificationid") ?? undefined
  if (!signatureHeader)
    return { status: "rejected", reason: "missing-signature-header", eventType, externalEventId }
  if (input.secrets.length === 0)
    return { status: "rejected", reason: "no-stored-secret", eventType, externalEventId }
  const expected = Buffer.from(signatureHeader, "utf8")
  for (const secret of input.secrets) {
    const computed = Buffer.from(signGxgWebhookBody(secret, input.rawBody), "utf8")
    if (computed.length === expected.length && timingSafeEqual(computed, expected)) {
      return { status: "verified", eventType, externalEventId }
    }
  }
  return { status: "rejected", reason: "signature-mismatch", eventType, externalEventId }
}

/** `extract-gxg-order-id-from-webhook-body.ts`: top-level `OrderId`, else `Shipments[0].OrderId`. */
export const extractGxgOrderIdFromWebhookBody = (body: unknown): string | null => {
  if (!body || typeof body !== "object") return null
  const top = (body as Json).OrderId
  if (typeof top === "string" && top.length > 0) return top
  const shipments = (body as Json).Shipments
  if (!Array.isArray(shipments) || shipments.length === 0) return null
  const first = (shipments[0] as Json).OrderId
  return typeof first === "string" && first.length > 0 ? first : null
}

/** `extract-gxg-kit-numbers-from-webhook-body.ts`: `KitNumber`, plus `OrderLines[].KitNumbers`. */
export const extractGxgKitNumbersFromWebhookBody = (body: unknown): string[] => {
  if (!body || typeof body !== "object") return []
  const collected = new Set<string>()
  const top = (body as Json).KitNumber
  if (typeof top === "string" && top.length > 0) collected.add(top)
  const lines = (body as Json).OrderLines
  if (Array.isArray(lines)) {
    for (const line of lines as Json[]) {
      for (const kit of (line.KitNumbers as unknown[] | null) ?? []) {
        if (typeof kit === "string" && kit.length > 0) collected.add(kit)
      }
    }
  }
  return [...collected]
}

/**
 * `POST /webhooks/gene-by-gene`: always 200; records the verification outcome, and for a
 * verified event runs the scoped refreshes (`afterRecord`) the ids make possible.
 */
export class GxgWebhookReceiver {
  readonly events: (VerifyResult & { body: Json; orderId: string | null; kitNumbers: string[] })[] =
    []

  constructor(private readonly secrets: () => readonly string[]) {}

  async receive(request: Request): Promise<Response> {
    const rawBody = await request.text()
    const verified = verifyGxgWebhook({
      headers: request.headers,
      rawBody,
      secrets: this.secrets(),
    })
    const body = safeJson(rawBody) as Json
    this.events.push({
      ...verified,
      body,
      orderId: verified.status === "verified" ? extractGxgOrderIdFromWebhookBody(body) : null,
      kitNumbers: verified.status === "verified" ? extractGxgKitNumbersFromWebhookBody(body) : [],
    })
    return new Response(JSON.stringify({ received: true }), { status: 200 })
  }
}
