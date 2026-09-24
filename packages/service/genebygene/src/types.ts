/**
 * Wire shapes (the subset of the Nucleus v2 DTOs the mock answers with) and the records the
 * mock keeps. Records hold only what the vendor echoes back: order lines, fulfillments,
 * shipments (with the address the vendor ships to), kits (with the demographics attributes the
 * vendor reports on `GET /kits/{kitNumber}`), results and subscriptions.
 */

export type AddressDto = {
  isCommercial?: boolean
  recipientName?: string | null
  addressLine1?: string | null
  addressLine2?: string | null
  addressLine3?: string | null
  city?: string | null
  stateOrRegion?: string | null
  postalCode?: string | null
  countryCode?: string | null
  email?: string | null
  phone?: string | null
  shippingInstruction?: string | null
  referenceId?: string | null
}

export type ProductDto = {
  id: string
  name: string | null
  description: string | null
  price: number | null
  productType: string | null
  isInsurable: boolean
  shippingQualified: boolean | null
  maxOrderingQuantity: number | null
  preassembly?: boolean
  components: {
    name: string | null
    quantity: number
    productType: string | null
    product: ProductDto
  }[]
}

export type OrderRecord = {
  id: string
  orderDate: string
  /** Mock-clock epoch ms of creation (list ordering, date filters). */
  createdAtMs: number
  notes: string | null
  /** 1: new kits (shipped or quantity-only), 3: existing kits (`Order.Created` `OrderType`). */
  orderType: 1 | 3
  lineIds: string[]
}

export type LineRecord = {
  id: string
  orderId: string
  productId: string
  productName: string | null
  productType: string | null
  productCode: string
  bundleProductId: string | null
  bundleProductName: string | null
  quantity: number
  unitPrice: number
  currentStatus: string
  placerOrderNumber: string | null
  comment: string | null
  kitNumbers: string[]
  /** The kit-material line: the one that ships and carries fulfillments. */
  ships: boolean
  fulfillmentIds: string[]
  cancelCodeId: number | null
  cancelNote: string | null
  shippingDate: string | null
}

export type ShipmentRecord = {
  id: string
  isReturnShipment: boolean
  address: AddressDto
  trackingNumber: string | null
  shippingInstruction: string | null
  reference1: string | null
  price: number | null
  courierServiceCode: string | null
  courierServiceName: string | null
  referenceId: string | null
}

export type FulfillmentRecord = {
  id: string
  orderId: string
  orderLineId: string
  quantity: number
  currentStatus: string
  kitCount: number
  isInternational: boolean
  shipments: ShipmentRecord[]
  closeoutDate: string | null
}

export type KitHistoryEntry = {
  statusName: string
  effectiveDate: string
  errorMessage: string | null
}

export type KitRecord = {
  kitNumber: string
  gender: string | null
  /** The order that minted the kit, then any existing-kits orders placed on it. */
  orderIds: string[]
  orderLineIds: string[]
  status: string
  errors: string[]
  errorMessage: string | null
  errorCode: number | null
  history: KitHistoryEntry[]
  receivedDate: string | null
  effectiveDate: string
  attributes: { name: string; value: string }[]
  canceled: boolean
  cancelCodeId: number | null
  cancelNote: string | null
  alternateKitId: string
}

export type ResultRecord = {
  resultId: string
  kitNumber: string
  orderId: string
  orderLineId: string
  resultType: string
  resultTypeName: string
  resultDate: string
  /** Object key, e.g. `WB3K9Q2X.json`: the `/__blob/<key>` and S3 key. */
  key: string
  /** `s3://<bucket>/<key>`, what `resultPayload` reports. */
  resultPayload: string
}

/** A happy-path walk: step `i` runs once the mock clock reaches `startedAtMs + i * stepDelayMs`. */
export type ScenarioRecord = {
  orderId: string
  startedAtMs: number
  stepDelayMs: number
  /** Index of the next step to run. */
  next: number
  /** What each step did, in order. */
  log: string[]
}

export type BlobRecord = { key: string; contentType: string; base64: string }

export type SubscriptionRecord = {
  id: string
  displayName: string | null
  type: string | null
  endPoint: string
  secret: string
  events: string[]
  active: boolean
  disabled: boolean
}

/** How the auth host answers a client id it refuses. */
export type BlockMode = "invalid_client" | "unauthorized" | "forbidden"

/** Per-namespace knobs, set through `PUT /__admin/settings`; cleared on reset. */
export type Settings = {
  /** `expires_in` of issued tokens. Default 3600 (IdentityServer's default). */
  tokenTtlSeconds: number
  /** Only these client credentials get a token; empty means any pair does. */
  clients: { client_id: string; client_secret: string }[]
  /** Client ids the auth host refuses, and how (400 invalid_client, 401, 403). */
  blockedClients: Record<string, BlockMode>
  /** Bumped by `POST /__admin/tokens/revoke`: tokens minted under an older generation answer 401. */
  tokenGeneration: number
  /** Mint kit numbers when an order is placed (default). Off: only `POST /__admin/orders/:id/kit-numbers` does. */
  generateKitNumbers: boolean
  /** Bucket `resultPayload` URIs name when no `--results-s3-bucket` is configured. */
  resultsBucket: string
  /** Lifetime of a presigned result URL on the mock clock. */
  presignedUrlTtlSeconds: number
  /** Which recorded catalog `GET /api/v2/products` answers. Default `both`. */
  catalog: "production" | "staging" | "both"
  /**
   * When a shipped-form order gets its kit numbers: `immediate` (default, in the create
   * response) or `deferred` (the production shape: only `POST /__admin/orders/:id/kit-numbers`
   * associates them). Quantity-only orders always get theirs immediately.
   */
  kitAssociation: "immediate" | "deferred"
  /** Synthetic address-corpus rows this namespace adds (`PUT /__admin/addresses/corpus`). */
  addressCorpus: {
    kind: "quote-ok-place-not-found" | "quote-ok-place-ok"
    addressLine1: string
    city: string
    stateOrRegion: string
    postalCode: string
    note: string
  }[]
}

export const DEFAULT_SETTINGS: Settings = {
  tokenTtlSeconds: 3600,
  clients: [],
  blockedClients: {},
  tokenGeneration: 0,
  generateKitNumbers: true,
  resultsBucket: "mockingbird-genebygene-results",
  presignedUrlTtlSeconds: 3600,
  catalog: "both",
  kitAssociation: "immediate",
  addressCorpus: [],
}
