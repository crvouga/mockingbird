import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  annotateResponse,
  bearerToken,
  bodyIssues,
  bootSqlite,
  createService,
  defineOperations,
  faultEffect,
  fromBase64,
  HttpError,
  jsonRes,
  type OperationContext,
  opaqueToken,
  putObject,
  type S3Target,
  type Service,
  toBase64,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { Hono } from "hono"
import {
  ATTRIBUTE_DEFINITIONS,
  attributeDefinition,
  type Catalog,
  catalogProducts,
  DELUXE_BUNDLE_ID,
  EVENT_TYPES,
  LAB_RETURN_ADDRESS,
  PRODUCT_CODES,
  STAGING_ONLY_IDS,
  SUBSCRIBABLE_EVENTS,
  TENANT_ID,
} from "./corpus.js"
import {
  type CustomResults,
  RESULT_FIXTURES,
  type ResultFixture,
  resultFiles,
} from "./fixtures/index.js"
import { document, type SupportedOperationId } from "./generated/openapi.js"
import {
  type CorpusAddress,
  closeoutDate,
  courierServiceName,
  MESSAGES,
  notValidatedMessage,
  placeCheck,
  quoteMenu,
  quoteVerdict,
  RETURN_COURIER,
  type ShippingOption,
  trackingNumberFor,
} from "./shipping.js"
import { GeneByGeneState, netIso } from "./state.js"
import type {
  AddressDto,
  FulfillmentRecord,
  KitRecord,
  LineRecord,
  OrderRecord,
  ProductDto,
  ResultRecord,
  ScenarioRecord,
  Settings,
  ShipmentRecord,
  SubscriptionRecord,
} from "./types.js"
import {
  GXG_EVENTS,
  type GxgWebhook,
  KIT_ERROR_MESSAGES,
  kitCompletedBody,
  kitErrorBody,
  kitNumbersGeneratedBody,
  kitOrderLineCanceledBody,
  kitReceivedBody,
  orderCreatedBody,
  orderShippedBody,
  type ShippedEntry,
} from "./webhooks.js"

export type { FetchAPI } from "@crvouga/mockingbird-core"
export type { S3Target } from "@crvouga/mockingbird-service"
export type { SqliteClient } from "@crvouga/mockingbird-sqlite"
export type { Catalog } from "./corpus.js"
export {
  ATTRIBUTE_DEFINITIONS,
  CATALOGS,
  CORPUS_VERSION,
  catalogProducts,
  DELUXE_BUNDLE_ID,
  EVENT_TYPES,
  PRODUCT_CODES,
  PRODUCTION_PRODUCTS,
  STAGING_PRODUCTS,
} from "./corpus.js"
export type { CustomResults, ResultFile, ResultFixture } from "./fixtures/index.js"
export {
  ANCESTRY_REPORT,
  minimalPdf,
  NORMAL_REPORT,
  PGX_REPORT,
  RAW_DATA_CSV,
  RESULT_FIXTURES,
  resultFiles,
} from "./fixtures/index.js"
export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export type { CorpusAddress, CorpusKind, CourierService, ShippingOption } from "./shipping.js"
export {
  ADDRESS_CORPUS,
  addressValidationErrors,
  COURIER_SERVICES,
  INTERNATIONAL_SERVICES,
  MAX_ADDRESS_LINE,
  menuFor,
  placeCheck,
  priceFor,
  QUOTE_OK_PLACE_NOT_FOUND,
  QUOTE_OK_PLACE_OK,
  quoteMenu,
  quoteVerdict,
  RETURN_COURIER,
  stateForZip3,
  trackingNumberFor,
  UNDELIVERABLE_ZIP3,
  ZONE_FACTORS,
  zoneFor,
} from "./shipping.js"
export { netIso } from "./state.js"
export type {
  AddressDto,
  BlockMode,
  FulfillmentRecord,
  KitRecord,
  LineRecord,
  OrderRecord,
  ProductDto,
  ResultRecord,
  Settings,
  ShipmentRecord,
  SubscriptionRecord,
} from "./types.js"
export { DEFAULT_SETTINGS } from "./types.js"
export type { GxgEventType, GxgWebhook, ShippedEntry } from "./webhooks.js"
export {
  GXG_EVENTS,
  gxgSigner,
  KIT_ERROR_MESSAGES,
  signGxgWebhookBody,
} from "./webhooks.js"

export const GENEBYGENE_NAMESPACE = "genebygene"

/** Kit statuses, in ladder order (`GXG/docs/llm/06-order-kit-status-lifecycle.md`). */
export const KIT_STATUSES = [
  "Not Received",
  "Received",
  "In Lab",
  "In QC Analysis",
  "QC Analysis Complete",
  "Results Completed",
  "Completed",
  "Error",
  "Canceled",
] as const

/** Kits past this point are with the lab: their order lines are no longer cancellable. */
/** `POST /__admin/scenario/happy-path`, step by step. */
const HAPPY_PATH = [
  "associate",
  "ship",
  "Received",
  "In Lab",
  "In QC Analysis",
  "QC Analysis Complete",
  "Results Completed",
] as const

/** Fulfillment states whose shipment address can no longer change. */
const LOCKED_FULFILLMENT = new Set<string>(["Shipped", "Canceled", "Error"])

const WITH_LAB = new Set<string>([
  "Received",
  "In Lab",
  "In QC Analysis",
  "QC Analysis Complete",
  "Results Completed",
  "Completed",
])

export type GeneByGeneAPIOptions = APIOptions & {
  /** A custom catalog. Default: the recorded catalogs, picked by `settings.catalog`. */
  products?: readonly ProductDto[]
  /** Initial per-namespace settings. */
  settings?: Partial<Settings>
  /** Called for every notification event; the runtime signs and delivers it. */
  onWebhook?: (event: GxgWebhook) => void
  /** Also write result files here (the stack's s3rver); `resultPayload` then names its bucket. */
  resultsS3?: S3Target
  /** The public namespace name, put on presigned URLs (`?namespace=`) so they route back here. */
  publicNamespace?: string
}

export type TransitionInput = {
  to: string
  /** `Kit.Error` code (4: delay, 19: new collection needed). Default 4. */
  errorCode?: number
  errorMessage?: string
  /** Result fixture at `Completed`; default: `PUT /__admin/results/:kitNumber`, else `normal`. */
  fixture?: ResultFixture
  /** Also publish the one-page PDF report. */
  pdf?: boolean
}

export type ShipInput = { trackingNumber?: string; returnTrackingNumber?: string }

const TOKEN_PREFIX = "gxg_"
const base64url = (value: string) =>
  toBase64(new TextEncoder().encode(value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
const fromBase64url = (value: string) => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      fromBase64(value.replace(/-/g, "+").replace(/_/g, "/")),
    )
  } catch {
    return undefined
  }
}
const tokenSignature = (clientId: string, issuedAt: number, generation: number) =>
  opaqueToken(`genebygene:${clientId}:${issuedAt}:${generation}`, 32)

/** The client id a bearer token was issued to: the credential carrier for namespaces. */
export const tokenCredential = (request: Request): string | undefined => {
  const token = bearerToken(request)
  if (!token) return undefined
  if (!token.startsWith(TOKEN_PREFIX)) return token
  const [encoded] = token.slice(TOKEN_PREFIX.length).split(".")
  return encoded ? fromBase64url(encoded) : undefined
}

const tokenClaims = (token: string) => {
  if (!token.startsWith(TOKEN_PREFIX)) return undefined
  const [encoded, issued, gen, signature] = token.slice(TOKEN_PREFIX.length).split(".")
  const clientId = encoded ? fromBase64url(encoded) : undefined
  const issuedAt = Number(issued)
  const generation = Number(gen)
  if (clientId === undefined || !Number.isInteger(issuedAt) || !Number.isInteger(generation)) {
    return undefined
  }
  if (!signature || signature !== tokenSignature(clientId, issuedAt, generation)) return undefined
  return { clientId, issuedAt, generation }
}

// --- response shapes -------------------------------------------------------------------------

const PROBLEM_TYPES: Record<number, string> = {
  400: "https://tools.ietf.org/html/rfc9110#section-15.5.1",
  404: "https://tools.ietf.org/html/rfc9110#section-15.5.5",
  422: "https://tools.ietf.org/html/rfc4918#section-11.2",
}

/**
 * Nucleus handler errors: `ErrorDto` (`{"statusCode":400,"message":…,"payload":{},
 * "errorType":"ValidationError"}`). Our consumer branches on the status and on substrings of
 * `message`, never on `errorType`.
 */
const errorDto = (status: number, message: string, errorType = "ValidationError") =>
  jsonRes(status, { statusCode: status, message, payload: {}, errorType })

/**
 * A missing resource, as staging answers it: `ErrorDto` with a null payload and type
 * (`{"statusCode":404,"message":"Resource not found.","payload":null,"errorType":null}`).
 */
const notFoundDto = (message = "Resource not found.") =>
  jsonRes(404, { statusCode: 404, message, payload: null, errorType: null })

/**
 * A subscription that does not exist, as staging answers it: the empty GUID is a 400 problem
 * ("Valid Notification Subscription Id required."), any other id a 404 `Invalid Id <id>`.
 */
const missingSubscription = (id: string) =>
  EMPTY_GUID.test(id)
    ? problem(400, "One or more validation errors occurred.", {
        errors: { id: ["Valid Notification Subscription Id required."] },
      })
    : notFoundDto(`Invalid Id ${id}`)

/** `getShippingOptions` for a product with nothing to ship, or an id the catalog lacks. */
const NOT_VALID_FOR_SHIPPING = "This product Id is not valid for shipping options."

/** The address-edit refusal once a shipment has tracking or has shipped (`can not`: two words). */
const ADDRESS_LOCKED = "The shipment address can not be updated"

/** ASP.NET problem details, with `errors` for model-binding validation failures. */
const problem = (
  status: number,
  title: string,
  extra: { detail?: string; errors?: Record<string, string[]> } = {},
) =>
  jsonRes(status, {
    type: PROBLEM_TYPES[status] ?? PROBLEM_TYPES[400],
    title,
    status,
    ...(extra.detail !== undefined ? { detail: extra.detail } : {}),
    ...(extra.errors !== undefined ? { errors: extra.errors } : {}),
    traceId: `00-${opaqueToken(`${title}:${extra.detail ?? ""}`, 32).toLowerCase()}-00`,
  })

/** An empty 401 (a JSON body here is a failure: our client only invalidates and retries). */
const unauthorized = () =>
  new Response(null, {
    status: 401,
    headers: { "www-authenticate": 'Bearer error="invalid_token"' },
  })

/** Model-binding style errors, keyed like ASP.NET does (`items[0].productId`). */
const validationErrors = (context: OperationContext) => {
  const issues = bodyIssues(context)
  if (issues.length === 0) return undefined
  const errors: Record<string, string[]> = {}
  for (const issue of issues) {
    const missing = /^missing required property (.+)$/.exec(issue.message)
    const segments = issue.path.split(".").filter(Boolean)
    if (missing) segments.push(missing[1] as string)
    const field =
      segments
        .map((segment, index) =>
          /^\d+$/.test(segment) ? `[${segment}]` : index === 0 ? segment : `.${segment}`,
        )
        .join("") || "$"
    const message = missing
      ? `The ${missing[1]} field is required.`
      : `The field ${field} ${issue.message}.`
    errors[field] = [...(errors[field] ?? []), message]
  }
  return problem(400, "One or more validation errors occurred.", { errors })
}

const record = (context: OperationContext): Record<string, unknown> | undefined =>
  context.body.kind === "json" &&
  typeof context.body.value === "object" &&
  context.body.value !== null &&
  !Array.isArray(context.body.value)
    ? (context.body.value as Record<string, unknown>)
    : undefined

/** A query value; blank or whitespace-only is no value on staging (`?productType=%20` lists all). */
const query = (context: OperationContext, name: string): string | undefined => {
  const raw = context.query[name]
  const value =
    typeof raw === "string"
      ? raw
      : Array.isArray(raw) && typeof raw[0] === "string"
        ? raw[0]
        : undefined
  return value?.trim() ? value : undefined
}

const str = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null

const fullAddress = (address: AddressDto | undefined): Required<AddressDto> => ({
  isCommercial: address?.isCommercial === true,
  recipientName: address?.recipientName ?? null,
  addressLine1: address?.addressLine1 ?? null,
  addressLine2: address?.addressLine2 ?? null,
  addressLine3: address?.addressLine3 ?? null,
  city: address?.city ?? null,
  stateOrRegion: address?.stateOrRegion ?? null,
  postalCode: address?.postalCode ?? null,
  countryCode: address?.countryCode ?? null,
  email: address?.email ?? null,
  phone: address?.phone ?? null,
  shippingInstruction: address?.shippingInstruction ?? null,
  referenceId: address?.referenceId ?? null,
})

const isDomestic = (address: AddressDto | undefined) =>
  (address?.countryCode ?? "US").toUpperCase() === "US"

type QuoteOutcome =
  | { kind: "http500" }
  | { kind: "http400" }
  | { kind: "validation"; errors: Record<string, string[]> }
  | { kind: "errorMessages"; errorMessages: string[] }
  | { kind: "carrier"; message: string }
  | { kind: "options"; zone: number; options: ShippingOption[] }

/** Address fields that decide where a kit goes (everything but the instruction). */
const sameDestination = (a: AddressDto, b: AddressDto) => {
  const { shippingInstruction: _a, ...left } = fullAddress(a)
  const { shippingInstruction: _b, ...right } = fullAddress(b)
  return JSON.stringify(left) === JSON.stringify(right)
}

const slug = (name: string | null) =>
  (name ?? "product")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")

const isShippable = (product: ProductDto) =>
  product.productType === "Materials" && product.shippingQualified === true

/** The component products a bundle expands into (a plain product is its own single line). */
const expand = (
  product: ProductDto,
): { product: ProductDto; quantity: number; bundle: ProductDto | null }[] =>
  product.components.length > 0
    ? product.components.map((c) => ({ product: c.product, quantity: c.quantity, bundle: product }))
    : [{ product, quantity: 1, bundle: null }]

const kitStatusName = (value: string): string | undefined => {
  const wanted = value.trim().toLowerCase()
  if (wanted === "cancelled") return "Canceled"
  return KIT_STATUSES.find((status) => status.toLowerCase() === wanted)
}

/** Case and spaces do not matter to an enum filter (`Lab Services` is `LabServices`). */
const enumKey = (value: string) => value.replace(/\s+/g, "").toLowerCase()

/** The enum filters staging validates, with the names it accepts (recorded live). */
const QUERY_ENUMS = {
  status: { label: "Status", names: ["Pending", ...KIT_STATUSES] },
  productType: {
    label: "Product Type",
    names: ["Materials", "Bundle", "DigitalProduct", "LabServices"],
  },
  entityType: { label: "Entity Type", names: ["Kit"] },
} as const
const enumNames = (name: keyof typeof QUERY_ENUMS): ReadonlySet<string> =>
  new Set(QUERY_ENUMS[name].names.map(enumKey))

/** Character formats staging enforces on kit filters (recorded: `{`, `_`, `.`, spaces refused). */
const QUERY_FORMATS = {
  /** `kitNumbers` on the kit-order-line lists: letters, digits and commas. */
  kitList: /^[A-Za-z0-9,]+$/,
  /** `kitNumber` on `GET /api/v2/kits`: letters, digits, commas and hyphens. */
  kitNumber: /^[A-Za-z0-9,-]+$/,
} as const

type QueryRule =
  | "int"
  | "bool"
  | "date"
  | "guid"
  | "required"
  | keyof typeof QUERY_ENUMS
  | keyof typeof QUERY_FORMATS

const pascal = (name: string) => `${name[0]?.toUpperCase() ?? ""}${name.slice(1)}`
const spaced = (name: string) => pascal(name).replace(/([a-z])([A-Z])/g, "$1 $2")
const GUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i
const EMPTY_GUID = /^0{8}-?0{4}-?0{4}-?0{4}-?0{12}$/

/**
 * Staging's query validation, as one problem-details 400 (recorded in corpus/live-errors.json):
 * a value that does not bind (`The value 'a' is not valid for Offset.`) falls back to its
 * default, then the validators run over the bound values (`'Status' has a range of values which
 * does not include 'a'.`, `'Page Size' must be between 1 and 100000.`, `'Offset' must be
 * greater than or equal to '0'.`, `'Result Id' must not be empty.`), and every message is
 * reported together. `paged` adds the offset and pageSize rules.
 */
const queryProblem = (
  context: OperationContext,
  rules: Record<string, QueryRule | readonly QueryRule[]>,
  paged = false,
): Response | undefined => {
  const errors: Record<string, string[]> = {}
  const add = (name: string, message: string) => {
    errors[name] = [...(errors[name] ?? []), message]
  }
  const all: Record<string, readonly QueryRule[]> = {
    ...(paged ? { offset: ["int"], pageSize: ["int"] } : {}),
    ...Object.fromEntries(
      Object.entries(rules).map(([k, v]) => [k, typeof v === "string" ? [v] : v]),
    ),
  }
  for (const [name, list] of Object.entries(all)) {
    const raw = query(context, name)
    const present = raw !== undefined && raw !== ""
    const notBound = `The value '${raw}' is not valid for ${pascal(name)}.`
    let bound = present
    for (const rule of list) {
      if (!present) continue
      if (rule === "int" && !/^[+-]?\d+$/.test(raw.trim())) add(name, notBound)
      if (rule === "bool" && !/^(true|false)$/i.test(raw.trim())) add(name, notBound)
      if (rule === "date" && Number.isNaN(Date.parse(raw))) add(name, notBound)
      if (rule === "guid" && !GUID.test(raw.trim())) {
        add(name, notBound)
        bound = false
      }
    }
    for (const rule of list) {
      if (rule === "required") {
        const empty = !bound || (list.includes("guid") && EMPTY_GUID.test(String(raw).trim()))
        if (empty) add(name, `'${spaced(name)}' must not be empty.`)
      } else if (rule in QUERY_FORMATS && present) {
        if (!QUERY_FORMATS[rule as keyof typeof QUERY_FORMATS].test(raw)) {
          add(name, `'${spaced(name)}' is not in the correct format.`)
        }
      } else if (rule in QUERY_ENUMS && present) {
        const known = enumNames(rule as keyof typeof QUERY_ENUMS)
        if (/^\d+$/.test(raw.trim()) || !known.has(enumKey(raw))) {
          const { label } = QUERY_ENUMS[rule as keyof typeof QUERY_ENUMS]
          // Staging trims the value before it validates, and echoes the trimmed value.
          add(name, `'${label}' has a range of values which does not include '${raw.trim()}'.`)
        }
      }
    }
  }
  if (paged) {
    const number = (name: string, fallback: number) => {
      const raw = query(context, name)
      return raw !== undefined && /^[+-]?\d+$/.test(raw.trim()) ? Number(raw) : fallback
    }
    const pageSize = number("pageSize", DEFAULT_PAGE_SIZE)
    if (pageSize < 1 || pageSize > 100_000) {
      add("pageSize", `'Page Size' must be between 1 and 100000. You entered ${pageSize}.`)
    }
    if (number("offset", 0) < 0) add("offset", "'Offset' must be greater than or equal to '0'.")
  }
  return Object.keys(errors).length > 0
    ? problem(400, "One or more validation errors occurred.", { errors })
    : undefined
}

/** A `{id}` route segment that is not a GUID: `The value 'x' is not valid.` (no field name). */
const routeGuidProblem = (context: OperationContext): Response | undefined => {
  const id = context.params.id ?? ""
  return GUID.test(id)
    ? undefined
    : problem(400, "One or more validation errors occurred.", {
        errors: { id: [`The value '${id}' is not valid.`] },
      })
}

/** An id filter; staging ignores one that is not a GUID (`?orderId=⁇` lists every order). */
const guidFilter = (context: OperationContext, name: string): string | undefined => {
  const value = query(context, name)?.trim()
  return value && GUID.test(value) ? value : undefined
}

/** Staging pages 100 rows when no pageSize is sent. */
const DEFAULT_PAGE_SIZE = 100

/** The page a list asks for; call `queryProblem(…, true)` first, which rejects bad values. */
const pageOf = (context: OperationContext): { offset: number; pageSize: number } => {
  const number = (name: string, fallback: number) => {
    const raw = query(context, name)
    return raw !== undefined && /^[+-]?\d+$/.test(raw.trim()) ? Number(raw) : fallback
  }
  return { offset: number("offset", 0), pageSize: number("pageSize", DEFAULT_PAGE_SIZE) }
}

const paginate = <T>(items: readonly T[], page: { offset: number; pageSize: number }) => ({
  offset: page.offset,
  pageSize: page.pageSize,
  totalCount: items.length,
  items: items.slice(page.offset, page.offset + page.pageSize),
})

const isJson = (value: string) => {
  try {
    JSON.parse(value)
    return true
  } catch {
    return false
  }
}

const csv = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

/**
 * Stateful mock of Gene by Gene's Nucleus API v2 (and its OAuth host's `/connect/token`).
 *
 * Orders expand bundles into per-component order lines; the kit-material line carries the
 * fulfillments (an outbound shipment plus a return label) and every line carries the order's
 * kit numbers. Kits move along the status ladder only through admin transitions, which emit the
 * matching notification and, at `Completed`, publish result files (JSON, PDF, CSV) that
 * `presignedUrl` and `GET /__blob/<key>` serve and, when configured, the stack's S3 receives.
 */
export class GeneByGeneAPI implements FetchAPI {
  readonly app: Hono
  readonly sqlite: SqliteClient
  readonly state: GeneByGeneState
  private readonly service: Service
  private readonly now: () => number
  private readonly onWebhook: ((event: GxgWebhook) => void) | undefined
  private readonly resultsS3: S3Target | undefined
  private readonly publicNamespace: string | undefined

  constructor(options: GeneByGeneAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite)
    const namespace = options.namespace ?? GENEBYGENE_NAMESPACE
    this.now = options.now ?? (() => Date.now())
    this.onWebhook = options.onWebhook
    this.resultsS3 = options.resultsS3
    this.publicNamespace = options.publicNamespace
    this.state = new GeneByGeneState(sqlite, namespace, {
      products: options.products ?? [],
      settings: {
        ...(options.resultsS3 ? { resultsBucket: options.resultsS3.bucket } : {}),
        ...options.settings,
      },
    })
    const handlers = defineOperations<SupportedOperationId>({
      PostConnectToken: (c) => this.token(c),
      ListProducts: (c) => this.listProducts(c),
      GetShippingOptions: (c) => this.shippingOptions(c),
      CreateOrder: (c) => this.createOrder(c),
      CreateOrderForExistingKits: (c) => this.createOrderForExistingKits(c),
      ListOrders: (c) => this.listOrders(c),
      GetOrder: (c) => this.getOrder(c),
      GetOrderLine: (c) => this.getOrderLine(c),
      CancelOrderLine: (c) => this.cancelOrderLine(c),
      ListFulfillments: (c) => this.listFulfillments(c),
      CancelFulfillment: (c) => this.cancelFulfillment(c),
      UpdateShipmentAddress: (c) => this.updateShipmentAddress(c),
      ListKits: (c) => this.listKits(c),
      GetKit: (c) => this.getKit(c),
      CancelKitOrderLines: (c) => this.cancelKitOrderLines(c),
      SetKitAttributes: (c) => this.setKitAttributes(c),
      GetKitResults: (c) => this.getKitResults(c),
      ListKitOrderLines: (c) => this.listKitOrderLines(c),
      ListKitOrderLineKits: (c) => this.listKitOrderLineKits(c),
      ListResults: (c) => this.listResults(c),
      SearchResults: (c) => this.searchResults(c),
      GetResultPresignedUrl: (c) => this.presignedUrl(c),
      GetResultBlob: (c) => this.blob(c),
      ListAttributeDefinitions: (c) =>
        queryProblem(c, { entityType: "entityType" }) ?? jsonRes(200, ATTRIBUTE_DEFINITIONS),
      ListEventTypes: (c) => {
        // A blank name is no filter on staging.
        const name = query(c, "name")?.trim()
        return jsonRes(
          200,
          EVENT_TYPES.filter((e) => !name || e.name.toLowerCase().includes(name.toLowerCase())),
        )
      },
      ListNotificationSubscriptions: (c) => this.listSubscriptions(c),
      CreateNotificationSubscription: (c) => this.createSubscription(c),
      GetNotificationSubscription: (c) => this.getSubscription(c),
      UpdateNotificationSubscription: (c) => this.updateSubscription(c),
      DeleteNotificationSubscription: (c) => this.deleteSubscription(c),
    })
    this.service = createService({
      document,
      handlers,
      sqlite,
      namespace,
      now: this.now,
      notFound: () => problem(404, "Not Found"),
      onError: (error) => {
        if (error instanceof HttpError) return error.toResponse()
        throw error
      },
      before: (context) => {
        const id = context.operation.operationId
        if (id === "PostConnectToken" || id === "GetResultBlob") return undefined
        const token = bearerToken(context.request)
        if (!token) return unauthorized()
        if (faultEffect(context.request, "token_revoked") !== undefined) return unauthorized()
        const claims = tokenClaims(token)
        if (!claims) return unauthorized()
        const settings = this.state.current()
        // The token dies at issuedAt + expires_in on the mock clock.
        const nowSeconds = Math.floor(this.now() / 1000)
        if (nowSeconds >= claims.issuedAt + settings.tokenTtlSeconds) return unauthorized()
        if (
          claims.generation !== settings.tokenGeneration ||
          settings.blockedClients[claims.clientId]
        ) {
          return unauthorized()
        }
        return undefined
      },
    })
    this.app = this.service.app
    this.sqlite = this.service.sqlite
  }

  async fetch(request: Request): Promise<Response> {
    await this.runDueScenarios()
    return this.service.fetch(request)
  }

  async reset(): Promise<void> {
    await this.service.reset()
    this.state.ensureSeeded()
  }

  private iso(): string {
    return netIso(this.now())
  }

  private emit(type: GxgWebhook["type"], body: Record<string, unknown>): void {
    this.onWebhook?.({ type, body })
  }

  // --- auth ----------------------------------------------------------------------------------

  private token(context: OperationContext): Response {
    const form: Record<string, string> = {}
    const value =
      context.body.kind === "form" || context.body.kind === "json" ? context.body.value : undefined
    if (value && typeof value === "object") {
      for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
        if (typeof v === "string") form[key] = v
      }
    }
    if (form.grant_type !== undefined && form.grant_type !== "client_credentials") {
      return jsonRes(400, { error: "unsupported_grant_type" })
    }
    if (!form.grant_type || !form.client_id || !form.client_secret) {
      return jsonRes(400, { error: form.client_id ? "invalid_client" : "invalid_request" })
    }
    const settings = this.state.current()
    const blocked = settings.blockedClients[form.client_id]
    if (blocked === "unauthorized") return jsonRes(401, { error: "invalid_client" })
    if (blocked === "forbidden") return jsonRes(403, { error: "unauthorized_client" })
    if (blocked === "invalid_client") return jsonRes(400, { error: "invalid_client" })
    if (
      settings.clients.length > 0 &&
      !settings.clients.some(
        (c) => c.client_id === form.client_id && c.client_secret === form.client_secret,
      )
    ) {
      return jsonRes(400, { error: "invalid_client" })
    }
    const issuedAt = Math.floor(this.now() / 1000)
    const accessToken = `${TOKEN_PREFIX}${base64url(form.client_id)}.${issuedAt}.${settings.tokenGeneration}.${tokenSignature(form.client_id, issuedAt, settings.tokenGeneration)}`
    return jsonRes(200, {
      access_token: accessToken,
      expires_in: settings.tokenTtlSeconds,
      token_type: "Bearer",
    })
  }

  // --- catalog -------------------------------------------------------------------------------

  private products(): readonly ProductDto[] {
    if (this.state.products.count() > 0) {
      return this.state.products.list({ order: "oldest" }).map((row) => row.value)
    }
    return catalogProducts(this.catalog())
  }

  private catalog(): Catalog {
    return this.state.current().catalog ?? "both"
  }

  /** A catalog product, or a bundle component, by id. */
  private findProduct(id: string): ProductDto | undefined {
    for (const product of this.products()) {
      if (product.id === id) return product
      const component = product.components.find((c) => c.product.id === id)
      if (component) return component.product
    }
    return undefined
  }

  private productCode(product: ProductDto): string {
    return PRODUCT_CODES[product.id] ?? slug(product.name)
  }

  private listProducts(context: OperationContext): Response {
    const productId = query(context, "productId")
    const productCode = query(context, "productCode")
    const productType = query(context, "productType")
    // Staging ignores a productId that is not a GUID, and matches a GUID against each listed
    // product's own id or any of its components' ids (a component id lists its bundles).
    const byId =
      productId && GUID.test(productId.trim()) ? productId.trim().toLowerCase() : undefined
    return jsonRes(
      200,
      this.products().filter(
        (p) =>
          (!byId ||
            p.id.toLowerCase() === byId ||
            p.components.some((c) => c.product.id.toLowerCase() === byId)) &&
          (!productCode || this.productCode(p) === productCode) &&
          // Staging matches the type with SQL LIKE '%…%' (not modelled beyond a substring).
          (!productType ||
            (p.productType ?? "").toLowerCase().includes(productType.trim().toLowerCase())),
      ),
    )
  }

  /** Namespace corpus rows added through `PUT /__admin/addresses/corpus`. */
  private extraCorpus(): readonly CorpusAddress[] {
    return this.state.current().addressCorpus ?? []
  }

  /**
   * Whether a product can be quoted: the product, an empty 500 (a staging-only id against the
   * production catalog), or the 400 "not valid for shipping options" (unknown id, or nothing
   * to ship).
   */
  private quotable(productId: string): ProductDto | "http500" | "http400" {
    if (this.catalog() === "production" && STAGING_ONLY_IDS.has(productId)) return "http500"
    const product = this.findProduct(productId)
    if (!product || !expand(product).some((e) => isShippable(e.product))) return "http400"
    return product
  }

  /**
   * The quote (`quoteVerdict`): request validation, the address rules, the carrier's refusals,
   * then the destination's menu. Never the USPS deliverability check, so an address the place
   * check will reject still gets its zone's menu.
   */
  quote(productId: string, address: AddressDto | undefined, quantity = 1): QuoteOutcome {
    const quotable = this.quotable(productId)
    if (quotable === "http500") return { kind: "http500" }
    if (quotable === "http400") return { kind: "http400" }
    const verdict = quoteVerdict(address)
    if (verdict.kind !== "ok") return verdict
    if (quantity < 1)
      return { kind: "errorMessages", errorMessages: ["Quantity must be at least 1."] }
    const menu = quoteMenu(address as AddressDto, this.now()) as {
      zone: number
      options: ShippingOption[]
    }
    return { kind: "options", zone: menu.zone, options: menu.options }
  }

  private shippingOptions(context: OperationContext): Response {
    const invalid = validationErrors(context)
    if (invalid) return invalid
    const body = record(context) ?? {}
    const productId = String(body.productId)
    const address = body.shippingAddress as AddressDto | undefined
    const refuse = (errorMessages: string[]) =>
      jsonRes(200, { dutiesAndTaxesIncluded: false, errorMessages, shippingOptions: [] })
    if (
      faultEffect(context.request, "address_not_validated") !== undefined &&
      typeof this.quotable(productId) === "object"
    ) {
      return refuse([MESSAGES.addressNotFound])
    }
    const quantity = typeof body.quantity === "number" ? body.quantity : 1
    const quote = this.quote(productId, address, quantity)
    if (quote.kind === "http500" || quote.kind === "http400") {
      // A staging-only id against the production tenant: an empty 500, as recorded.
      return quote.kind === "http500"
        ? new Response(null, { status: 500 })
        : errorDto(400, NOT_VALID_FOR_SHIPPING)
    }
    if (quote.kind === "validation") {
      return problem(400, "One or more validation errors occurred.", { errors: quote.errors })
    }
    if (quote.kind === "carrier") {
      return jsonRes(500, {
        statusCode: 500,
        message: quote.message,
        payload: null,
        errorType: null,
      })
    }
    if (quote.kind === "errorMessages") return refuse(quote.errorMessages)
    return jsonRes(200, {
      dutiesAndTaxesIncluded: true,
      errorMessages: [],
      shippingOptions: quote.options,
    })
  }

  /**
   * Classify an address without placing anything (`POST /__admin/addresses/classify`): what the
   * quote answers, what a shipped place answers, and the zone's codes and prices.
   */
  classify(input: { address: AddressDto; productId?: string; courierServiceCode?: string }) {
    const quote = this.quote(input.productId ?? DELUXE_BUNDLE_ID, input.address)
    const place = placeCheck(input.address, this.extraCorpus())
    const menu = quote.kind === "options" ? quote.options : []
    const code = input.courierServiceCode
    const badCourier = code !== undefined && !this.courierAllowed(code, menu)
    return {
      quote: quote.kind,
      place: place.ok ? (badCourier ? "bad-courier" : "ok") : place.kind,
      ...(place.ok ? {} : { reason: place.reason }),
      ...(quote.kind === "errorMessages" ? { errorMessages: quote.errorMessages } : {}),
      zone: quote.kind === "options" ? quote.zone : null,
      codes: menu.map((o) => o.courierServiceCode),
      prices: Object.fromEntries(menu.map((o) => [o.courierServiceCode, o.estimatedPrice])),
    }
  }

  /**
   * The place-time check's 400 (`Shipping address(es) not validated: <line1> : <reason>`), or
   * undefined when the address would ship. `forceNotFound` is the `address_not_found` preset.
   */
  private placeRefusal(address: AddressDto | undefined, forceNotFound = false) {
    const check = placeCheck(address, this.extraCorpus())
    if (!check.ok) return errorDto(400, notValidatedMessage(address, check.reason))
    if (forceNotFound) return errorDto(400, notValidatedMessage(address, MESSAGES.addressNotFound))
    return undefined
  }

  /** A code the zone's menu offers, or the bundle's return leg (`DHL_DOMESTIC_RETURN`). */
  private courierAllowed(code: string, menu: readonly ShippingOption[]): boolean {
    return (
      code === RETURN_COURIER.courierServiceCode || menu.some((o) => o.courierServiceCode === code)
    )
  }

  // --- orders --------------------------------------------------------------------------------

  private lineDto(line: LineRecord) {
    const fulfillments = line.fulfillmentIds.flatMap((id) => {
      const f = this.state.fulfillments.get(id)
      return f ? [this.fulfillmentDto(f)] : []
    })
    return {
      id: line.id,
      orderId: line.orderId,
      productId: line.productId,
      productName: line.productName,
      productType: line.productType,
      bundleProductId: line.bundleProductId,
      bundleProductName: line.bundleProductName,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      currentStatus: line.currentStatus,
      fulfillments: fulfillments.length > 0 ? fulfillments : null,
      placerOrderNumber: line.placerOrderNumber,
      kitNumbers: line.kitNumbers.length > 0 ? [...line.kitNumbers] : null,
    }
  }

  orderDto(order: OrderRecord) {
    return {
      id: order.id,
      orderDate: order.orderDate,
      orderLines: this.state.linesOf(order).map((line) => this.lineDto(line)),
    }
  }

  private shipmentDto(shipment: ShipmentRecord) {
    return {
      id: shipment.id,
      isReturnShipment: shipment.isReturnShipment,
      address: fullAddress(shipment.address),
      trackingNumber: shipment.trackingNumber,
      shippingInstruction: shipment.shippingInstruction,
      reference1: shipment.reference1,
      price: shipment.price,
      courier: null,
      courierService: null,
    }
  }

  private fulfillmentDto(fulfillment: FulfillmentRecord) {
    return {
      id: fulfillment.id,
      orderLineId: fulfillment.orderLineId,
      quantity: fulfillment.quantity,
      currentStatus: fulfillment.currentStatus,
      shipments: fulfillment.shipments.map((s) => this.shipmentDto(s)),
      kitCount: fulfillment.kitCount,
      isInternational: fulfillment.isInternational,
    }
  }

  private newKit(
    order: OrderRecord,
    lineIds: string[],
    attributes: KitRecord["attributes"],
  ): KitRecord {
    const now = this.iso()
    const kit: KitRecord = {
      kitNumber: this.state.kitNumber(),
      gender: null,
      orderIds: [order.id],
      orderLineIds: lineIds,
      status: "Not Received",
      errors: [],
      errorMessage: null,
      errorCode: null,
      history: [{ statusName: "Not Received", effectiveDate: now, errorMessage: null }],
      receivedDate: null,
      effectiveDate: now,
      attributes: [],
      canceled: false,
      cancelCodeId: null,
      cancelNote: null,
      alternateKitId: "",
    }
    this.mergeAttributes(kit, attributes)
    this.state.kits.insert(kit.kitNumber, kit)
    return kit
  }

  private createOrder(context: OperationContext): Response {
    const invalid = validationErrors(context)
    if (invalid) return invalid
    const body = record(context) ?? {}
    const items = (body.items as Record<string, unknown>[] | null) ?? []
    if (items.length === 0) return errorDto(400, "At least one order item is required.")
    type Plan = {
      item: Record<string, unknown>
      product: ProductDto
      shipments: Record<string, unknown>[]
      quantity: number
    }
    const plans: Plan[] = []
    for (const [index, item] of items.entries()) {
      const product = this.findProduct(String(item.productId))
      if (!product) return errorDto(400, `Product ${String(item.productId)} not found.`, "NotFound")
      const shipments = (item.shipments as Record<string, unknown>[] | null) ?? []
      const quantity =
        shipments.length > 0
          ? shipments.reduce((sum, s) => sum + (typeof s.quantity === "number" ? s.quantity : 0), 0)
          : typeof item.quantity === "number"
            ? item.quantity
            : 0
      if (quantity < 1) {
        return errorDto(
          400,
          `Item ${index}: a quantity or at least one shipment with a quantity is required.`,
        )
      }
      if (product.maxOrderingQuantity !== null && quantity > product.maxOrderingQuantity) {
        return errorDto(
          400,
          `Item ${index}: quantity exceeds the maximum of ${product.maxOrderingQuantity}.`,
        )
      }
      if (shipments.length > 0) {
        if (!expand(product).some((e) => isShippable(e.product))) {
          return errorDto(400, `Product ${product.name} is not valid for shipping options.`)
        }
        const forceNotFound =
          faultEffect(context.request, "address_not_validated") !== undefined ||
          faultEffect(context.request, "address_not_found") !== undefined
        for (const shipment of shipments) {
          const address = shipment.address as AddressDto | undefined
          // The place-time USPS check: structure, then Address Not Found.
          const refused = this.placeRefusal(address, forceNotFound)
          if (refused) return refused
          const code = str(shipment.courierServiceCode)
          if (!code) return errorDto(400, "A courier service code is required for each shipment.")
          const menu = quoteMenu(address as AddressDto, this.now())?.options ?? []
          if (!this.courierAllowed(code, menu)) {
            return errorDto(
              400,
              `The courier service code '${code}' is not valid for shipping options.`,
            )
          }
          if (typeof shipment.quantity !== "number" || shipment.quantity < 1) {
            return errorDto(400, "Each shipment needs a quantity of at least 1.")
          }
        }
      }
      plans.push({ item, product, shipments, quantity })
    }

    const order: OrderRecord = {
      id: this.state.uuid("order"),
      orderDate: this.iso(),
      createdAtMs: this.now(),
      notes: str(body.notes),
      orderType: 1,
      lineIds: [],
    }
    const withKits: LineRecord[] = []
    const settings = this.state.current()
    const noKits = faultEffect(context.request, "no_kit_numbers") !== undefined
    // Shipped-form places wait for the shipping desk when association is deferred (the
    // production shape); quantity-only places always get their kit numbers in the same turn.
    const deferShipped = settings.kitAssociation === "deferred" || !settings.generateKitNumbers
    for (const { item, product, shipments, quantity } of plans) {
      const skipKits = noKits || (shipments.length > 0 && deferShipped)
      const lines: LineRecord[] = expand(product).map(
        ({ product: part, quantity: each, bundle }) => ({
          id: this.state.uuid("orderLine"),
          orderId: order.id,
          productId: part.id,
          productName: part.name,
          productType: part.productType,
          productCode: this.productCode(part),
          bundleProductId: bundle?.id ?? null,
          bundleProductName: bundle?.name ?? null,
          quantity: each * quantity,
          unitPrice: part.price ?? 0,
          currentStatus: "Pending",
          placerOrderNumber: str(item.placerOrderNumber),
          comment: str(item.comment),
          kitNumbers: [],
          ships: isShippable(part),
          fulfillmentIds: [],
          cancelCodeId: null,
          cancelNote: null,
          shippingDate: null,
        }),
      )
      const shipping = lines.find((line) => line.ships)
      if (shipping) {
        for (const shipment of shipments) {
          // Echoed field for field, including the nulls the caller sent.
          const address = fullAddress(shipment.address as AddressDto)
          const code = String(shipment.courierServiceCode)
          const option = quoteMenu(address, this.now())?.options.find(
            (o) => o.courierServiceCode === code,
          )
          const fulfillment: FulfillmentRecord = {
            id: this.state.uuid("fulfillment"),
            orderId: order.id,
            orderLineId: shipping.id,
            quantity: shipment.quantity as number,
            currentStatus: "Ordered",
            kitCount: shipment.quantity as number,
            isInternational: !isDomestic(address),
            closeoutDate: null,
            shipments: [
              {
                id: this.state.uuid("shipment"),
                isReturnShipment: false,
                address,
                trackingNumber: null,
                shippingInstruction:
                  str(shipment.shippingInstruction) ?? address.shippingInstruction,
                reference1: null,
                price: option?.estimatedPrice ?? null,
                courierServiceCode: code,
                courierServiceName: courierServiceName(code),
                referenceId: str(shipment.referenceId),
              },
              {
                id: this.state.uuid("shipment"),
                isReturnShipment: true,
                address: fullAddress(LAB_RETURN_ADDRESS),
                trackingNumber: null,
                shippingInstruction: null,
                reference1: null,
                price: null,
                courierServiceCode: null,
                courierServiceName: null,
                referenceId: null,
              },
            ],
          }
          this.state.fulfillments.insert(fulfillment.id, fulfillment)
          shipping.fulfillmentIds.push(fulfillment.id)
        }
      }
      for (const line of lines) {
        this.state.lines.insert(line.id, line)
        order.lineIds.push(line.id)
      }
      if (shipping && !skipKits) {
        const samples =
          (item.samples as { attributes?: { name?: unknown; value?: unknown }[] }[] | null) ?? []
        for (let i = 0; i < quantity; i++) {
          const kit = this.newKit(
            order,
            lines.map((l) => l.id),
            attributePairs(samples[i]?.attributes),
          )
          for (const line of lines) line.kitNumbers.push(kit.kitNumber)
        }
        for (const line of lines) this.state.lines.update(line.id, line)
        withKits.push(...lines)
      }
    }
    this.state.orders.insert(order.id, order)
    const lines = this.state.linesOf(order)
    this.emit(GXG_EVENTS.orderCreated, orderCreatedBody(order, lines))
    if (withKits.length > 0)
      this.emit(GXG_EVENTS.kitNumbersGenerated, kitNumbersGeneratedBody(order, lines))
    return annotateResponse(jsonRes(200, this.orderDto(order)), {
      ids: {
        orderId: order.id,
        kitNumbers: lines
          .flatMap((l) => l.kitNumbers)
          .filter(unique)
          .join(","),
      },
    })
  }

  private createOrderForExistingKits(context: OperationContext): Response {
    const invalid = validationErrors(context)
    if (invalid) return invalid
    const body = record(context) ?? {}
    const items = (body.items as Record<string, unknown>[] | null) ?? []
    if (items.length === 0) return errorDto(400, "At least one order item is required.")
    for (const item of items) {
      if (!this.findProduct(String(item.productId))) {
        return errorDto(400, `Product ${String(item.productId)} not found.`, "NotFound")
      }
      const kitNumbers = ((item.kitNumbers as string[] | null) ?? []).filter(
        (k) => k.trim().length > 0,
      )
      if (kitNumbers.length === 0) return errorDto(400, "At least one kit number is required.")
      const missing = kitNumbers.filter((k) => !this.state.kits.has(k.trim()))
      if (missing.length > 0)
        return errorDto(400, `Kit number(s) not found: ${missing.join(", ")}.`, "NotFound")
    }
    const order: OrderRecord = {
      id: this.state.uuid("order"),
      orderDate: this.iso(),
      createdAtMs: this.now(),
      notes: str(body.notes),
      orderType: 3,
      lineIds: [],
    }
    for (const item of items) {
      const product = this.findProduct(String(item.productId)) as ProductDto
      const kitNumbers = ((item.kitNumbers as string[]) ?? [])
        .map((k) => k.trim())
        .filter((k) => k.length > 0)
      const lines: LineRecord[] = expand(product).map(
        ({ product: part, quantity: each, bundle }) => ({
          id: this.state.uuid("orderLine"),
          orderId: order.id,
          productId: part.id,
          productName: part.name,
          productType: part.productType,
          productCode: this.productCode(part),
          bundleProductId: bundle?.id ?? null,
          bundleProductName: bundle?.name ?? null,
          quantity: each * kitNumbers.length,
          unitPrice: part.price ?? 0,
          currentStatus: "Pending",
          placerOrderNumber: str(item.placerOrderNumber),
          comment: str(item.comment),
          kitNumbers: [...kitNumbers],
          ships: false,
          fulfillmentIds: [],
          cancelCodeId: null,
          cancelNote: null,
          shippingDate: null,
        }),
      )
      for (const line of lines) {
        this.state.lines.insert(line.id, line)
        order.lineIds.push(line.id)
      }
      const samples =
        (item.samples as
          | { kitNumber?: unknown; attributes?: { name?: unknown; value?: unknown }[] }[]
          | null) ?? []
      for (const kitNumber of kitNumbers) {
        const kit = this.state.kits.get(kitNumber) as KitRecord
        kit.orderIds = [...kit.orderIds.filter((id) => id !== order.id), order.id]
        kit.orderLineIds = [...kit.orderLineIds, ...lines.map((l) => l.id)]
        const sample = samples.find((s) => s.kitNumber === kitNumber)
        this.mergeAttributes(kit, attributePairs(sample?.attributes))
        this.state.kits.update(kitNumber, kit)
      }
    }
    this.state.orders.insert(order.id, order)
    this.emit(GXG_EVENTS.orderCreated, orderCreatedBody(order, this.state.linesOf(order)))
    return annotateResponse(jsonRes(200, this.orderDto(order)), { ids: { orderId: order.id } })
  }

  private listOrders(context: OperationContext): Response {
    const invalid = queryProblem(context, { orderDateMin: "date", orderDateMax: "date" }, true)
    if (invalid) return invalid
    const page = pageOf(context)
    const orderId = guidFilter(context, "orderId")
    const min = query(context, "orderDateMin")
    const max = query(context, "orderDateMax")
    const productName = query(context, "productName")?.toLowerCase()
    const orders = this.state.orders
      .list()
      .map((row) => row.value)
      .filter(
        (order) =>
          (!orderId || order.id === orderId) &&
          (!min || order.createdAtMs >= Date.parse(min)) &&
          (!max || order.createdAtMs <= Date.parse(max)) &&
          (!productName ||
            this.state
              .linesOf(order)
              .some((l) => l.productName?.toLowerCase().includes(productName))),
      )
    return jsonRes(
      200,
      paginate(
        orders.map((o) => this.orderDto(o)),
        page,
      ),
    )
  }

  private getOrder(context: OperationContext): Response {
    const unbound = routeGuidProblem(context)
    if (unbound) return unbound
    const order = this.state.orders.get(context.params.id ?? "")
    if (!order) return notFoundDto()
    return annotateResponse(jsonRes(200, this.orderDto(order)), { ids: { orderId: order.id } })
  }

  private getOrderLine(context: OperationContext): Response {
    const unbound = routeGuidProblem(context)
    if (unbound) return unbound
    const line = this.state.lines.get(context.params.id ?? "")
    if (!line) return notFoundDto()
    const order = this.state.orders.get(line.orderId) as OrderRecord
    const kits = line.kitNumbers.flatMap((k) => {
      const kit = this.state.kits.get(k)
      return kit ? [kit] : []
    })
    const outbound = line.fulfillmentIds
      .flatMap((id) => this.state.fulfillments.get(id)?.shipments ?? [])
      .find((s) => !s.isReturnShipment)
    return jsonRes(200, {
      id: line.id,
      orderId: line.orderId,
      orderBy: null,
      orderDate: order.orderDate,
      notes: order.notes,
      orderLineNote: line.comment,
      productId: line.productId,
      productName: line.productName,
      productType: line.productType,
      kitStatusSummary: {
        totalReceivedKits: kits.filter((k) => WITH_LAB.has(k.status)).length,
        unpaidKits: 0,
        paidKits: kits.length,
        canceledKits: kits.filter((k) => k.canceled).length,
        canceledProducts: line.currentStatus === "Canceled" ? 1 : 0,
        errorKits: kits.filter((k) => k.status === "Error").length,
        resultCompleteKits: kits.filter(
          (k) => k.status === "Results Completed" || k.status === "Completed",
        ).length,
      },
      shippingDate: line.shippingDate,
      trackingNumber: outbound?.trackingNumber ?? null,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      currentStatus: line.currentStatus,
      cancelCodeId: line.cancelCodeId,
      cancelNote: line.cancelNote,
      siblingOrderLines: this.state
        .linesOf(order)
        .filter((l) => l.id !== line.id)
        .map((l) => ({ id: l.id, displayName: l.productName })),
    })
  }

  // --- the three cancel layers (GXG/orders/gxg-order-cancel.service.ts) ------------------------

  private cancelConflict(context: OperationContext): Response | undefined {
    return faultEffect(context.request, "cancel_conflict") !== undefined
      ? errorDto(409, "The entity is not in a cancellable status.", "Conflict")
      : undefined
  }

  private cancelFulfillment(context: OperationContext): Response {
    const fulfillment = this.state.fulfillments.get(context.params.id ?? "")
    if (!fulfillment) return notFoundDto()
    const conflict = this.cancelConflict(context)
    if (conflict) return conflict
    // Already shipped, or already canceled by an earlier partial cancel: both refuse.
    if (fulfillment.currentStatus !== "Ordered") {
      return errorDto(
        400,
        `Fulfillment ${fulfillment.id} is not in a cancellable status (${fulfillment.currentStatus}).`,
      )
    }
    this.state.fulfillments.update(fulfillment.id, { ...fulfillment, currentStatus: "Canceled" })
    // The kit it would have mailed is canceled with it (Kit.KitOrderLine.Canceled).
    const line = this.state.lines.get(fulfillment.orderLineId)
    for (const kitNumber of line?.kitNumbers ?? []) {
      const kit = this.state.kits.get(kitNumber)
      if (kit && !kit.canceled && !WITH_LAB.has(kit.status))
        this.cancelKit(kit, 1, "Canceled via API")
    }
    return annotateResponse(new Response(null, { status: 204 }), {
      ids: { fulfillmentId: fulfillment.id },
    })
  }

  private cancelKitOrderLines(context: OperationContext): Response {
    const kit = this.state.kits.get(context.params.kitNumber ?? "")
    // An already-canceled kit is gone from the vendor's point of view: 404 (idempotent success).
    if (!kit || kit.canceled) return notFoundDto(`Kit ${context.params.kitNumber} not found`)
    const conflict = this.cancelConflict(context)
    if (conflict) return conflict
    if (WITH_LAB.has(kit.status)) {
      return errorDto(
        400,
        `Kit order line for kit ${kit.kitNumber} is not in a cancellable status (${kit.status}).`,
      )
    }
    this.cancelKit(kit, 1, "Canceled via API")
    return annotateResponse(new Response(null, { status: 204 }), {
      ids: { kitNumber: kit.kitNumber },
    })
  }

  private cancelKit(kit: KitRecord, cancelCodeId: number, note: string): KitRecord {
    const now = this.iso()
    const next: KitRecord = {
      ...kit,
      canceled: true,
      status: "Canceled",
      cancelCodeId,
      cancelNote: note,
      effectiveDate: now,
      history: [...kit.history, { statusName: "Canceled", effectiveDate: now, errorMessage: null }],
    }
    this.state.kits.update(kit.kitNumber, next)
    const line = this.labLine(next)
    if (line) this.emit(GXG_EVENTS.kitOrderLineCanceled, kitOrderLineCanceledBody(next, line, now))
    return next
  }

  private cancelOrderLine(context: OperationContext): Response {
    const line = this.state.lines.get(context.params.id ?? "")
    if (!line || line.currentStatus === "Canceled") {
      return notFoundDto()
    }
    const conflict = this.cancelConflict(context)
    if (conflict) return conflict
    const withLab = line.kitNumbers.some((k) => {
      const kit = this.state.kits.get(k)
      return kit !== undefined && !kit.canceled && WITH_LAB.has(kit.status)
    })
    if (withLab || line.currentStatus === "Completed") {
      return errorDto(
        400,
        `Order line ${line.id} is not in a cancellable status (${line.currentStatus}).`,
      )
    }
    for (const id of line.fulfillmentIds) {
      const f = this.state.fulfillments.get(id)
      if (f && f.currentStatus === "Ordered")
        this.state.fulfillments.update(id, { ...f, currentStatus: "Canceled" })
    }
    this.state.lines.update(line.id, {
      ...line,
      currentStatus: "Canceled",
      cancelCodeId: 1,
      cancelNote: "Canceled via API",
    })
    return annotateResponse(new Response(null, { status: 204 }), { ids: { orderLineId: line.id } })
  }

  // --- fulfillments --------------------------------------------------------------------------

  private listFulfillments(context: OperationContext): Response {
    const invalid = queryProblem(context, {}, true)
    if (invalid) return invalid
    const page = pageOf(context)
    const orderId = guidFilter(context, "orderId")
    const orderLineId = guidFilter(context, "orderLineId")
    const fulfillmentId = guidFilter(context, "fulfillmentId")
    const items = this.state.fulfillments
      .list()
      .map((row) => row.value)
      .filter(
        (f) =>
          (!orderId || f.orderId === orderId) &&
          (!orderLineId || f.orderLineId === orderLineId) &&
          (!fulfillmentId || f.id === fulfillmentId),
      )
    return jsonRes(
      200,
      paginate(
        items.map((f) => this.fulfillmentDto(f)),
        page,
      ),
    )
  }

  /**
   * `EditAddressCommand`: replaces the shipment's address (no merge; the caller sends it whole)
   * and re-runs the place check. An edit that changes only the instruction always goes through
   * (our consumer's fallback when a field edit is refused). Once the shipment has tracking, or
   * its fulfillment is Shipped / Canceled / Error, the address is locked.
   */
  private updateShipmentAddress(context: OperationContext): Response {
    const invalid = validationErrors(context)
    if (invalid) return invalid
    const body = record(context) ?? {}
    const shipmentId = String(body.id)
    const fulfillment = this.state.fulfillments
      .list()
      .map((row) => row.value)
      .find((f) => f.shipments.some((s) => s.id === shipmentId))
    if (!fulfillment) return notFoundDto()
    const shipment = fulfillment.shipments.find((s) => s.id === shipmentId) as ShipmentRecord
    if (shipment.trackingNumber || LOCKED_FULFILLMENT.has(fulfillment.currentStatus)) {
      return errorDto(400, ADDRESS_LOCKED)
    }
    const sent = body.address as AddressDto | undefined
    const address = fullAddress(sent)
    const instruction = str(body.shippingInstruction) ?? address.shippingInstruction
    if (!sameDestination(address, shipment.address)) {
      const forceNotFound = faultEffect(context.request, "address_not_validated") !== undefined
      const refused = this.placeRefusal(sent, forceNotFound)
      if (refused) return refused
    }
    const nextInstruction = instruction ?? shipment.shippingInstruction
    const updated: ShipmentRecord = {
      ...shipment,
      address: { ...address, shippingInstruction: nextInstruction },
      shippingInstruction: nextInstruction,
    }
    this.state.fulfillments.update(fulfillment.id, {
      ...fulfillment,
      shipments: fulfillment.shipments.map((s) => (s.id === shipmentId ? updated : s)),
    })
    // 200 echoes the command.
    return annotateResponse(jsonRes(200, body), {
      ids: { shipmentId, fulfillmentId: fulfillment.id },
    })
  }

  // --- kits ----------------------------------------------------------------------------------

  private kitLines(kit: KitRecord): LineRecord[] {
    return kit.orderLineIds.flatMap((id) => {
      const line = this.state.lines.get(id)
      return line ? [line] : []
    })
  }

  /** The lab-services line a kit's `Kit.Error` / `Canceled` names (else its first line). */
  private labLine(kit: KitRecord): LineRecord | undefined {
    const lines = this.kitLines(kit)
    return (
      lines.find((l) => l.productType === "Lab Services") ?? lines.find((l) => !l.ships) ?? lines[0]
    )
  }

  private lineKitStatus(kit: KitRecord, line: LineRecord): string {
    return kit.canceled || line.currentStatus === "Canceled" ? "Canceled" : kit.status
  }

  private attributeDto(attribute: { name: string; value: string }) {
    const definition = attributeDefinition(attribute.name)
    return {
      name: attribute.name,
      displayName: definition?.displayName ?? attribute.name,
      alternateName: null,
      description: null,
      value: attribute.value,
      attributeTypeId: definition?.attributeTypeId ?? 1,
      isReadOnly: false,
      allowsMultipleValues: false,
    }
  }

  private kitResults(kitNumber: string): ResultRecord[] {
    return this.state.results
      .list({ order: "oldest", where: (r) => r.kitNumber === kitNumber })
      .map((row) => row.value)
  }

  kitDto(kit: KitRecord) {
    const results = this.kitResults(kit.kitNumber)
    return {
      kitNumber: kit.kitNumber,
      gender: kit.gender,
      tenantId: TENANT_ID,
      currentStatuses: this.kitLines(kit).map((line) => {
        const order = this.state.orders.get(line.orderId)
        const fulfillment = line.fulfillmentIds[0]
          ? this.state.fulfillments.get(line.fulfillmentIds[0])
          : undefined
        const product = this.findProduct(line.productId)
        return {
          status: this.lineKitStatus(kit, line),
          errors: [...kit.errors],
          errorMessage: kit.errorMessage,
          productId: line.productId,
          productCode: line.productCode,
          productName: line.productName,
          productType: product?.productType ?? line.productType,
          orderLineId: line.id,
          orderId: line.orderId,
          orderDate: order?.orderDate ?? kit.effectiveDate,
          fulfillmentId: fulfillment?.id ?? null,
          fulfillment: fulfillment ? this.fulfillmentDto(fulfillment) : null,
          results: results
            .filter((r) => r.orderLineId === line.id)
            .map((r) => ({
              resultType: r.resultType,
              resultTypeDisplayName: r.resultTypeName,
              resultPayload: r.resultPayload,
              resultDate: r.resultDate,
            })),
          history: kit.history.map((h) => ({ ...h })),
        }
      }),
      attributes: kit.attributes.map((a) => this.attributeDto(a)),
    }
  }

  private kitOrderLineDto(kit: KitRecord, line: LineRecord) {
    const order = this.state.orders.get(line.orderId)
    return {
      kitNumber: kit.kitNumber,
      gender: kit.gender,
      productId: line.productId,
      productName: line.productName,
      isInsurable: false,
      isInsured: false,
      currentStatus: this.lineKitStatus(kit, line),
      currentErrorMessage: kit.errorMessage,
      cancelCodeId: kit.canceled ? kit.cancelCodeId : line.cancelCodeId,
      cancelNote: kit.canceled ? kit.cancelNote : line.cancelNote,
      orderLineId: line.id,
      orderId: line.orderId,
      orderDate: order?.orderDate ?? kit.effectiveDate,
      orderLines: null,
      kitAttributeValues: kit.attributes.map((a) => ({ name: a.name, value: a.value })),
      kitReceivedDate: kit.receivedDate,
      kitEffectiveDate: kit.effectiveDate,
    }
  }

  private listKits(context: OperationContext): Response {
    const invalid = queryProblem(context, { status: "status", kitNumber: "kitNumber" }, true)
    if (invalid) return invalid
    const page = pageOf(context)
    const kitNumber = query(context, "kitNumber")
    const orderNumber = query(context, "orderNumber")
    const status = query(context, "status")
    const kits = this.state.kits
      .list()
      .map((row) => row.value)
      .filter(
        (k) =>
          (!kitNumber || k.kitNumber === kitNumber) &&
          (!orderNumber || k.orderIds.includes(orderNumber)) &&
          (!status || enumKey(k.status) === enumKey(status)),
      )
    return jsonRes(
      200,
      paginate(
        kits.map((kit) => ({
          kitNumber: kit.kitNumber,
          gender: kit.gender,
          orders: kit.orderIds.flatMap((id) => {
            const order = this.state.orders.get(id)
            return order ? [{ id: order.id, orderDate: order.orderDate }] : []
          }),
        })),
        page,
      ),
    )
  }

  private getKit(context: OperationContext): Response {
    const kit = this.state.kits.get(context.params.kitNumber ?? "")
    if (!kit) return notFoundDto(`Kit ${context.params.kitNumber} not found`)
    return annotateResponse(jsonRes(200, this.kitDto(kit)), { ids: { kitNumber: kit.kitNumber } })
  }

  private mergeAttributes(kit: KitRecord, pairs: { name: string; value: string }[]): void {
    for (const pair of pairs) {
      const name = pair.name.trim().toLowerCase()
      const index = kit.attributes.findIndex((a) => a.name === name)
      if (index >= 0) kit.attributes[index] = { name, value: pair.value }
      else kit.attributes.push({ name, value: pair.value })
      if (name === "gender") kit.gender = pair.value
    }
  }

  private setKitAttributes(context: OperationContext): Response {
    const invalid = validationErrors(context)
    if (invalid) return invalid
    const kitNumber = context.params.kitNumber ?? ""
    const kit = this.state.kits.get(kitNumber)
    if (!kit) return notFoundDto(`Kit ${kitNumber} not found`)
    const body = record(context) ?? {}
    if (typeof body.kitNumber === "string" && body.kitNumber !== kitNumber) {
      return errorDto(400, `Kit number ${body.kitNumber} in the body does not match ${kitNumber}.`)
    }
    const attributes = (body.attributes as { name?: unknown; value?: unknown }[] | null) ?? []
    if (attributes.length === 0) return errorDto(400, "At least one attribute is required.")
    const errors: Record<string, string[]> = {}
    const pairs: { name: string; value: string }[] = []
    for (const [index, attribute] of attributes.entries()) {
      const name = typeof attribute.name === "string" ? attribute.name.trim().toLowerCase() : ""
      if (!attributeDefinition(name)) {
        return errorDto(400, `Attribute '${String(attribute.name)}' is not defined.`, "Validation")
      }
      const value = typeof attribute.value === "string" ? attribute.value.trim() : ""
      const field = `attributes[${index}].value`
      if (value.length === 0) errors[field] = [`A value is required for ${name}.`]
      else if (name === "dateofbirth" && !isYyyymmdd(value)) {
        errors[field] = [`${name} must be a valid date formatted as YYYYMMDD.`]
      } else if (name === "gender" && !["M", "F", "Unknown"].includes(value)) {
        errors[field] = ["gender must be M, F or Unknown."]
      }
      pairs.push({ name, value })
    }
    if (Object.keys(errors).length > 0) {
      return problem(422, "One or more attribute values are invalid.", { errors })
    }
    const next = { ...kit, attributes: [...kit.attributes] }
    this.mergeAttributes(next, pairs)
    this.state.kits.update(kitNumber, next)
    return annotateResponse(
      jsonRes(
        200,
        next.attributes.map((a) => this.attributeDto(a)),
      ),
      {
        ids: { kitNumber },
      },
    )
  }

  private getKitResults(context: OperationContext): Response {
    const kit = this.state.kits.get(context.params.kitNumber ?? "")
    if (!kit) return notFoundDto()
    return jsonRes(200, {
      kitNumber: kit.kitNumber,
      gender: kit.gender,
      kitResults: this.kitResults(kit.kitNumber).map((r) => ({
        resultPayload: r.resultPayload,
        resultType: r.resultType,
        resultDate: r.resultDate,
        orderLineId: r.orderLineId,
        orderId: r.orderId,
        resultid: r.resultId,
      })),
    })
  }

  /** (kit, line) rows, newest kit first, filtered like `GET /api/v2/kitorderlines`. */
  private kitOrderLineRows(context: OperationContext): { kit: KitRecord; line: LineRecord }[] {
    const kitNumbers = csv(query(context, "kitNumbers"))
    const orderId = guidFilter(context, "orderId")
    const orderLineId = guidFilter(context, "orderLineId")
    const status = query(context, "status")
    const productType = query(context, "productType")
    const term = query(context, "attributeTerm")?.toLowerCase()
    const searched = csv(query(context, "attributesToSearch") ?? "FirstName,LastName").map((s) =>
      s.toLowerCase(),
    )
    const rows: { kit: KitRecord; line: LineRecord }[] = []
    for (const { value: kit } of this.state.kits.list()) {
      if (kitNumbers.length > 0 && !kitNumbers.includes(kit.kitNumber)) continue
      if (
        term &&
        !kit.attributes.some(
          (a) => searched.includes(a.name) && a.value.toLowerCase().includes(term),
        )
      ) {
        continue
      }
      for (const line of this.kitLines(kit)) {
        if (orderId && line.orderId !== orderId) continue
        if (orderLineId && line.id !== orderLineId) continue
        if (status && enumKey(this.lineKitStatus(kit, line)) !== enumKey(status)) continue
        if (productType && enumKey(line.productType ?? "") !== enumKey(productType)) continue
        rows.push({ kit, line })
      }
    }
    return rows
  }

  private listKitOrderLines(context: OperationContext): Response {
    const invalid = queryProblem(
      context,
      { status: "status", orderByAsc: "bool", kitNumbers: "kitList" },
      true,
    )
    if (invalid) return invalid
    // Staging fails with an empty 500 on a productType it cannot parse (kitorderlines/kits
    // validates it as a 400 instead), and on an attributesFilter that is not JSON, but the
    // latter only when rows remain to apply it to.
    const rows = this.kitOrderLineRows(context)
    const productType = query(context, "productType")
    const filter = query(context, "attributesFilter")
    if (productType && queryProblem(context, { productType: "productType" })) {
      return new Response(null, { status: 500 })
    }
    if (filter && !isJson(filter) && rows.length > 0) {
      return new Response(null, { status: 500 })
    }
    const page = pageOf(context)
    return jsonRes(
      200,
      paginate(
        rows.map(({ kit, line }) => this.kitOrderLineDto(kit, line)),
        page,
      ),
    )
  }

  private listKitOrderLineKits(context: OperationContext): Response {
    const invalid = queryProblem(
      context,
      {
        status: "status",
        productType: "productType",
        orderByAsc: "bool",
        kitNumbers: "kitList",
      },
      true,
    )
    if (invalid) return invalid
    // After query validation, kitorderlines/kits wants a JSON array: anything else is a 400
    // ErrorDto, and a non-empty array fails with an empty 500 (recorded for
    // `[{"name":…,"value":…}]`; its element shape is not known).
    const filter = query(context, "attributesFilter")
    if (filter) {
      let parsed: unknown
      try {
        parsed = JSON.parse(filter)
      } catch {}
      if (!Array.isArray(parsed)) {
        return jsonRes(400, {
          statusCode: 400,
          message: "Invalid search filter value",
          payload: null,
          errorType: null,
        })
      }
      if (parsed.length > 0) return new Response(null, { status: 500 })
    }
    const page = pageOf(context)
    const byKit = new Map<string, { kit: KitRecord; lines: LineRecord[] }>()
    for (const { kit, line } of this.kitOrderLineRows(context)) {
      const entry = byKit.get(kit.kitNumber) ?? { kit, lines: [] }
      entry.lines.push(line)
      byKit.set(kit.kitNumber, entry)
    }
    return jsonRes(
      200,
      paginate(
        [...byKit.values()].map(({ kit, lines }) => ({
          ...this.kitOrderLineDto(kit, lines[0] as LineRecord),
          orderLines: lines.map((line) => this.kitOrderLineDto(kit, line)),
        })),
        page,
      ),
    )
  }

  // --- results -------------------------------------------------------------------------------

  private resultDto(r: ResultRecord) {
    return {
      resultPayload: r.resultPayload,
      resultType: r.resultType,
      resultDisplayName: r.resultTypeName,
      resultDate: r.resultDate,
      orderLineId: r.orderLineId,
      orderId: r.orderId,
      kitNumber: r.kitNumber,
      resultId: r.resultId,
    }
  }

  private listResults(context: OperationContext): Response {
    const invalid = queryProblem(context, {}, true)
    if (invalid) return invalid
    const page = pageOf(context)
    // An unknown kit is an empty page on staging, not a 404.
    const kitNumber = query(context, "kitNumber")
    const results = this.state.results
      .list()
      .map((row) => row.value)
      .filter((r) => !kitNumber || r.kitNumber === kitNumber)
    return jsonRes(
      200,
      paginate(
        results.map((r) => this.resultDto(r)),
        page,
      ),
    )
  }

  private searchResults(context: OperationContext): Response {
    const invalid = queryProblem(
      context,
      {
        dateOfBirth: "date",
        orderByAsc: "bool",
        resultDateYear: "int",
        resultDateDayOfYear: "int",
        collectionDateRangeStart: "date",
        collectionDateRangeEnd: "date",
        resultDate: "date",
      },
      true,
    )
    if (invalid) return invalid
    const page = pageOf(context)
    const kits = [...csv(query(context, "kitNumbers")), ...csv(query(context, "kitList"))]
    const firstName = query(context, "firstName")?.trim().toLowerCase()
    const lastName = query(context, "lastName")?.trim().toLowerCase()
    const dob = query(context, "dateOfBirth")
      ?.replace(/[^0-9]/g, "")
      .slice(0, 8)
    const typeName = query(context, "resultTypeName")?.toLowerCase()
    const rows = this.state.results
      .list()
      .map((row) => row.value)
      .flatMap((r) => {
        const kit = this.state.kits.get(r.kitNumber)
        if (!kit) return []
        const attr = (name: string) => kit.attributes.find((a) => a.name === name)?.value ?? null
        if (kits.length > 0 && !kits.includes(r.kitNumber)) return []
        if (firstName && attr("firstname")?.toLowerCase() !== firstName) return []
        if (lastName && attr("lastname")?.toLowerCase() !== lastName) return []
        if (dob && attr("dateofbirth") !== dob) return []
        if (typeName && r.resultTypeName.toLowerCase() !== typeName) return []
        return [
          {
            kitNumber: r.kitNumber,
            orderId: r.orderId,
            orderLineId: r.orderLineId,
            firstName: attr("firstname"),
            lastName: attr("lastname"),
            dateOfBirth: attr("dateofbirth"),
            resultId: r.resultId,
            resultType: r.resultType,
            resultTypeName: r.resultTypeName,
            resultDate: r.resultDate,
            resultPayload: r.resultPayload,
          },
        ]
      })
    return jsonRes(200, paginate(rows, page))
  }

  private blobSignature(key: string, date: number, expires: number): string {
    return opaqueToken(`blob:${this.state.namespace}:${key}:${date}:${expires}`, 40)
  }

  private presignedUrl(context: OperationContext): Response {
    // Staging needs a resultId, or a kitNumber and a resultType: each is required when the
    // other way of naming the result is incomplete (a resultId that does not bind is empty).
    const given = (name: string) => (query(context, name) ?? "").trim().length > 0
    const id = query(context, "resultId") ?? ""
    const hasId = GUID.test(id.trim()) && !EMPTY_GUID.test(id.trim())
    const byKit = given("kitNumber") && given("resultType")
    const errors: Record<string, string[]> = {}
    if (given("resultId") && !GUID.test(id.trim())) {
      errors.resultId = [`The value '${id}' is not valid for ResultId.`]
    }
    if (!hasId && !byKit) {
      errors.resultId = [...(errors.resultId ?? []), "'Result Id' must not be empty."]
    }
    if (!hasId && !given("kitNumber")) errors.kitNumber = ["'Kit Number' must not be empty."]
    if (!hasId && !given("resultType")) errors.resultType = ["'Result Type' must not be empty."]
    if (Object.keys(errors).length > 0) {
      return problem(400, "One or more validation errors occurred.", { errors })
    }
    const resultId = query(context, "resultId")
    const kitNumber = query(context, "kitNumber")
    const resultType = query(context, "resultType")
    const candidates = this.state.results
      .list({ order: "oldest" })
      .map((row) => row.value)
      .filter(
        (r) =>
          (!resultId || r.resultId === resultId) &&
          (!kitNumber || r.kitNumber === kitNumber) &&
          (!resultType || r.resultType === resultType),
      )
    const result = resultId || kitNumber ? candidates[0] : undefined
    // By id, staging names the id; by kit and type, it spells "associated" its own way.
    if (!result) {
      return notFoundDto(
        hasId ? `Invalid kit result ID ${id}` : "There is no report assoicated with that result",
      )
    }
    const date = Math.floor(this.now() / 1000)
    const expires = this.state.current().presignedUrlTtlSeconds
    const params = new URLSearchParams({
      ...(this.publicNamespace ? { namespace: this.publicNamespace } : {}),
      "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
      "X-Amz-Date": String(date),
      "X-Amz-Expires": String(expires),
      "X-Amz-Signature": this.blobSignature(result.key, date, expires),
    })
    return annotateResponse(
      jsonRes(200, {
        presignedUrl: `${context.url.origin}/__blob/${encodeURIComponent(result.key)}?${params}`,
        resultId: result.resultId,
        kitNumber: result.kitNumber,
        resultType: result.resultType,
        expiresAt: netIso((date + expires) * 1000),
      }),
      { ids: { resultId: result.resultId, kitNumber: result.kitNumber } },
    )
  }

  private blob(context: OperationContext): Response {
    const key = context.params.key ?? ""
    const s3Error = (status: number, code: string, message: string) =>
      new Response(
        `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>${message}</Message><Key>${key}</Key></Error>`,
        { status, headers: { "content-type": "application/xml" } },
      )
    const date = Number(query(context, "X-Amz-Date"))
    const expires = Number(query(context, "X-Amz-Expires"))
    const signature = query(context, "X-Amz-Signature")
    if (!signature || signature !== this.blobSignature(key, date, expires)) {
      return s3Error(403, "AccessDenied", "Access Denied")
    }
    if (this.now() / 1000 > date + expires) {
      return s3Error(403, "AccessDenied", "Request has expired")
    }
    const blob = this.state.blobs.get(key)
    if (!blob) return s3Error(404, "NoSuchKey", "The specified key does not exist.")
    return new Response(fromBase64(blob.base64) as BodyInit, {
      status: 200,
      headers: { "content-type": blob.contentType },
    })
  }

  // --- notification subscriptions ------------------------------------------------------------

  private subscriptionDto(sub: SubscriptionRecord, withSecret = false) {
    return {
      id: sub.id,
      displayName: sub.displayName,
      tenantId: TENANT_ID,
      type: sub.type,
      endPoint: sub.endPoint,
      // The secret is returned only by the create call.
      secret: withSecret ? sub.secret : null,
      interval: 0,
      startTime: 0,
      events: [...sub.events],
      active: sub.active,
      disabled: sub.disabled,
      filter: null,
    }
  }

  private eventsProblem(events: unknown): Response | undefined {
    if (!Array.isArray(events) || events.length === 0)
      return errorDto(400, "Valid event type is required.")
    return events.every((e) => typeof e === "string" && SUBSCRIBABLE_EVENTS.has(e))
      ? undefined
      : errorDto(400, "Valid event type is required.")
  }

  private endpointProblem(endPoint: unknown): Response | undefined {
    try {
      const url = new URL(String(endPoint))
      return url.protocol === "http:" || url.protocol === "https:"
        ? undefined
        : errorDto(400, "A valid endpoint is required.")
    } catch {
      return errorDto(400, "A valid endpoint is required.")
    }
  }

  /** Active, enabled subscriptions: where notifications go (with their own secrets). */
  activeSubscriptions(): SubscriptionRecord[] {
    return this.state.subscriptions
      .list({ order: "oldest" })
      .map((row) => row.value)
      .filter((s) => s.active && !s.disabled)
  }

  private listSubscriptions(context: OperationContext): Response {
    const type = query(context, "type")?.toLowerCase()
    return jsonRes(
      200,
      this.state.subscriptions
        .list({ order: "oldest" })
        .map((row) => row.value)
        .filter((s) => !type || (s.type ?? "webhook").toLowerCase() === type)
        .map((s) => this.subscriptionDto(s)),
    )
  }

  private createSubscription(context: OperationContext): Response {
    const invalid = validationErrors(context)
    if (invalid) return invalid
    const body = record(context) ?? {}
    const type = str(body.type) ?? "webhook"
    if (!["webhook", "email"].includes(type.toLowerCase())) {
      return errorDto(400, "Subscription type must be webhook or email.")
    }
    const endpoint = this.endpointProblem(body.endPoint)
    if (endpoint) return endpoint
    const events = this.eventsProblem(body.events)
    if (events) return events
    const endPoint = String(body.endPoint)
    if (this.state.subscriptions.list().some((row) => row.value.endPoint === endPoint)) {
      return errorDto(400, `A subscription for endpoint ${endPoint} already exists.`)
    }
    const sub: SubscriptionRecord = {
      id: this.state.uuid("subscription"),
      displayName: null,
      type,
      endPoint,
      secret: str(body.secret) ?? this.state.secret(),
      events: [...(body.events as string[])],
      active: true,
      disabled: false,
    }
    this.state.subscriptions.insert(sub.id, sub)
    return annotateResponse(jsonRes(200, this.subscriptionDto(sub, true)), {
      ids: { subscriptionId: sub.id },
    })
  }

  private getSubscription(context: OperationContext): Response {
    const sub = this.state.subscriptions.get(context.params.id ?? "")
    if (!sub) return missingSubscription(context.params.id ?? "")
    return jsonRes(200, this.subscriptionDto(sub))
  }

  private updateSubscription(context: OperationContext): Response {
    const sub = this.state.subscriptions.get(context.params.id ?? "")
    if (!sub) return missingSubscription(context.params.id ?? "")
    const invalid = validationErrors(context)
    if (invalid) return invalid
    const body = record(context) ?? {}
    if (body.endPoint !== undefined && body.endPoint !== null) {
      const endpoint = this.endpointProblem(body.endPoint)
      if (endpoint) return endpoint
    }
    if (body.events !== undefined && body.events !== null) {
      const events = this.eventsProblem(body.events)
      if (events) return events
    }
    const next: SubscriptionRecord = {
      ...sub,
      ...(typeof body.type === "string" ? { type: body.type } : {}),
      ...(typeof body.endPoint === "string" ? { endPoint: body.endPoint } : {}),
      ...(Array.isArray(body.events) ? { events: [...(body.events as string[])] } : {}),
      ...(typeof body.secret === "string" && body.secret.length > 0 ? { secret: body.secret } : {}),
      ...(typeof body.active === "boolean" ? { active: body.active } : {}),
    }
    this.state.subscriptions.update(sub.id, next)
    return jsonRes(200, this.subscriptionDto(next))
  }

  private deleteSubscription(context: OperationContext): Response {
    const sub = this.state.subscriptions.get(context.params.id ?? "")
    if (!sub) return missingSubscription(context.params.id ?? "")
    this.state.subscriptions.delete(sub.id)
    return new Response(null, { status: 204 })
  }

  // --- lifecycle (admin) ---------------------------------------------------------------------

  /** Mint kit numbers for an order placed while kit generation was off; emits `KitNumbersGenerated`. */
  generateKitNumbers(orderId: string): OrderRecord | undefined {
    const order = this.state.orders.get(orderId)
    if (!order) return undefined
    const lines = this.state.linesOf(order)
    const shipping = lines.find((l) => l.ships)
    if (!shipping || shipping.kitNumbers.length > 0) return order
    const kits = Array.from({ length: shipping.quantity }, () =>
      this.newKit(
        order,
        lines.map((l) => l.id),
        [],
      ),
    )
    for (const line of lines) {
      this.state.lines.update(line.id, { ...line, kitNumbers: kits.map((k) => k.kitNumber) })
    }
    this.emit(
      GXG_EVENTS.kitNumbersGenerated,
      kitNumbersGeneratedBody(order, this.state.linesOf(order)),
    )
    return order
  }

  /**
   * Ship an order: every open fulfillment (one is created at a default address for a
   * quantity-only order) gets tracking numbers and a closeout date (`M/D/YYYY`, Houston time),
   * the kit-material line reads `Shipped` (sibling lines stay as they are, as the recorded
   * production orders show), and `Order.Shipped` goes out. Tracking numbers are minted from the
   * shipment ids ({@link trackingNumberFor}) unless the admin call overrides them.
   */
  ship(
    orderId: string,
    input: ShipInput = {},
  ): { order: ReturnType<GeneByGeneAPI["orderDto"]> } | string {
    const order = this.state.orders.get(orderId)
    if (!order) return `no order ${orderId}`
    const now = this.now()
    const closeout = closeoutDate(now)
    const entries: ShippedEntry[] = []
    for (const line of this.state.linesOf(order)) {
      if (!line.ships || line.currentStatus === "Canceled") continue
      if (line.fulfillmentIds.length === 0) {
        const fulfillment: FulfillmentRecord = {
          id: this.state.uuid("fulfillment"),
          orderId: order.id,
          orderLineId: line.id,
          quantity: line.quantity,
          currentStatus: "Ordered",
          kitCount: line.quantity,
          isInternational: false,
          closeoutDate: null,
          shipments: [
            {
              id: this.state.uuid("shipment"),
              isReturnShipment: false,
              address: fullAddress({
                ...LAB_RETURN_ADDRESS,
                recipientName: "Tenant bulk shipment",
              }),
              trackingNumber: null,
              shippingInstruction: null,
              reference1: null,
              price: null,
              courierServiceCode: "DHL_PARCEL_EXPEDITED",
              courierServiceName: courierServiceName("DHL_PARCEL_EXPEDITED"),
              referenceId: null,
            },
            ...line.kitNumbers.map(() => ({
              id: this.state.uuid("shipment"),
              isReturnShipment: true,
              address: fullAddress(LAB_RETURN_ADDRESS),
              trackingNumber: null,
              shippingInstruction: null,
              reference1: null,
              price: null,
              courierServiceCode: null,
              courierServiceName: null,
              referenceId: null,
            })),
          ],
        }
        this.state.fulfillments.insert(fulfillment.id, fulfillment)
        line.fulfillmentIds = [fulfillment.id]
      }
      for (const id of line.fulfillmentIds) {
        const fulfillment = this.state.fulfillments.get(id)
        if (fulfillment?.currentStatus !== "Ordered") continue
        const hhmmss = new Date(now).toISOString().slice(11, 19).replace(/:/g, "")
        const outboundCode =
          fulfillment.shipments.find((s) => !s.isReturnShipment)?.courierServiceCode ?? null
        const minted = (s: ShipmentRecord) =>
          trackingNumberFor({
            shipmentId: s.id,
            isReturnShipment: s.isReturnShipment,
            courierServiceCode: s.isReturnShipment ? null : outboundCode,
            postalCode: s.address.postalCode,
          })
        const shipments = fulfillment.shipments.map((s, index) =>
          s.isReturnShipment
            ? {
                ...s,
                trackingNumber: s.trackingNumber ?? input.returnTrackingNumber ?? minted(s),
                reference1: line.kitNumbers[Math.max(0, index - 1)] ?? line.kitNumbers[0] ?? null,
              }
            : {
                ...s,
                trackingNumber: s.trackingNumber ?? input.trackingNumber ?? minted(s),
                reference1: `${line.kitNumbers[0] ?? "WB"}T${hhmmss}`,
              },
        )
        const shipped: FulfillmentRecord = {
          ...fulfillment,
          currentStatus: "Shipped",
          closeoutDate: closeout,
          shipments,
        }
        this.state.fulfillments.update(id, shipped)
        const outbound = shipments.find((s) => !s.isReturnShipment)
        if (outbound) {
          entries.push({
            fulfillment: shipped,
            line,
            outbound,
            returns: shipments.filter((s) => s.isReturnShipment),
          })
        }
      }
      this.state.lines.update(line.id, {
        ...line,
        currentStatus: "Shipped",
        shippingDate: netIso(now),
      })
    }
    if (entries.length === 0) return `order ${orderId} has nothing left to ship`
    this.emit(GXG_EVENTS.orderShipped, orderShippedBody(order, entries))
    return { order: this.orderDto(order) }
  }

  /** Stage the results a kit publishes when it reaches `Completed`. */
  setPendingResults(
    kitNumber: string,
    source: { fixture: ResultFixture } | { custom: CustomResults },
  ): boolean {
    if (!this.state.kits.has(kitNumber)) return false
    this.state.pendingResults.insert(kitNumber, {
      kitNumber,
      fixture: "fixture" in source ? source.fixture : "custom",
      ...("custom" in source ? { custom: source.custom } : {}),
    })
    return true
  }

  /**
   * The one automatic motion: associate kit numbers (when deferred) → ship → `Received` →
   * `In Lab` → `In QC Analysis` → `QC Analysis Complete` → `Results Completed`, emitting each
   * step's webhooks. Step `i` runs once the mock clock reaches start + `i * stepDelayMs`
   * (default 0: every step runs now); later steps run on the next request after the clock
   * passes them.
   */
  async startHappyPath(orderId: string, stepDelayMs = 0): Promise<ScenarioRecord | string> {
    if (!this.state.orders.has(orderId)) return `no order ${orderId}`
    const scenario: ScenarioRecord = {
      orderId,
      startedAtMs: this.now(),
      stepDelayMs: Math.max(0, stepDelayMs),
      next: 0,
      log: [],
    }
    this.state.scenarios.insert(orderId, scenario)
    await this.runDueScenarios()
    return this.state.scenarios.get(orderId) ?? scenario
  }

  private scenarioRunning = false

  /** Run every happy-path step whose time has come on the mock clock. */
  async runDueScenarios(): Promise<void> {
    if (this.scenarioRunning || this.state.scenarios.count() === 0) return
    this.scenarioRunning = true
    try {
      for (const { value } of this.state.scenarios.list({ order: "oldest" })) {
        const scenario = { ...value, log: [...value.log] }
        while (
          scenario.next < HAPPY_PATH.length &&
          scenario.startedAtMs + scenario.next * scenario.stepDelayMs <= this.now()
        ) {
          const step = HAPPY_PATH[scenario.next] as string
          scenario.log.push(`${step}: ${await this.happyPathStep(scenario.orderId, step)}`)
          scenario.next++
        }
        this.state.scenarios.update(scenario.orderId, scenario)
      }
    } finally {
      this.scenarioRunning = false
    }
  }

  private async happyPathStep(orderId: string, step: string): Promise<string> {
    if (step === "associate") {
      const order = this.state.orders.get(orderId)
      const hasKits = order && this.state.linesOf(order).some((l) => l.kitNumbers.length > 0)
      if (hasKits) return "kit numbers already associated"
      this.generateKitNumbers(orderId)
      return "kit numbers associated"
    }
    if (step === "ship") {
      const shipped = this.ship(orderId)
      return typeof shipped === "string" ? shipped : "shipped"
    }
    const order = this.state.orders.get(orderId)
    const kits = order
      ? this.state
          .linesOf(order)
          .flatMap((l) => l.kitNumbers)
          .filter(unique)
      : []
    const outcomes: string[] = []
    for (const kitNumber of kits) {
      const kit = await this.transition(kitNumber, { to: step })
      outcomes.push(typeof kit === "string" ? kit : `${kitNumber} ${step}`)
    }
    return outcomes.join("; ") || "no kits"
  }

  /**
   * Move a kit along the status ladder, emitting the matching notification. At `Completed`
   * (or `Results Completed`) the kit's result files are written (blob store, and the S3 target
   * when configured) before `Kit.Completed` goes out.
   */
  async transition(
    kitNumber: string,
    input: TransitionInput,
  ): Promise<ReturnType<GeneByGeneAPI["kitDto"]> | string> {
    const kit = this.state.kits.get(kitNumber)
    if (!kit) return `no kit ${kitNumber}`
    const to = kitStatusName(input.to)
    if (!to)
      return `unknown kit status ${JSON.stringify(input.to)}; one of ${KIT_STATUSES.join(", ")}`
    if (kit.canceled) return `kit ${kitNumber} is canceled`
    if (to === "Canceled") {
      return this.kitDto(this.cancelKit(kit, 1, "Canceled by lab"))
    }
    const now = this.iso()
    const next: KitRecord = {
      ...kit,
      status: to,
      effectiveDate: now,
      history: [...kit.history, { statusName: to, effectiveDate: now, errorMessage: null }],
      ...(to === "Error" ? {} : { errors: [], errorMessage: null, errorCode: null }),
      ...(to === "Received" && !kit.receivedDate ? { receivedDate: now } : {}),
    }
    const lines = this.kitLines(next)
    if (to === "Error") {
      const code = input.errorCode ?? 4
      const message = input.errorMessage ?? KIT_ERROR_MESSAGES[code] ?? `Kit error ${code}`
      next.errors = [String(code)]
      next.errorMessage = message
      next.errorCode = code
      next.history[next.history.length - 1] = {
        statusName: to,
        effectiveDate: now,
        errorMessage: message,
      }
      this.state.kits.update(kitNumber, next)
      const line = this.labLine(next)
      if (line) this.emit(GXG_EVENTS.kitError, kitErrorBody(next, line, code, message))
      return this.kitDto(next)
    }
    if (to === "Results Completed" || to === "Completed") {
      const staged = this.state.pendingResults.get(kitNumber)
      const fixture =
        input.fixture ?? (staged?.fixture as ResultFixture | "custom" | undefined) ?? "normal"
      const source =
        fixture === "custom" && staged?.custom !== undefined
          ? { custom: staged.custom as CustomResults }
          : {
              fixture: (RESULT_FIXTURES as readonly string[]).includes(fixture)
                ? (fixture as ResultFixture)
                : "normal",
            }
      const published = await this.publishResults(next, lines, source, input.pdf === true)
      if (typeof published === "string") return published
      for (const line of lines) {
        if (!line.ships && line.currentStatus !== "Canceled") {
          this.state.lines.update(line.id, { ...line, currentStatus: "Completed" })
        }
      }
      this.state.kits.update(kitNumber, next)
      const byLine = new Map<string, ResultRecord[]>()
      for (const result of published)
        byLine.set(result.orderLineId, [...(byLine.get(result.orderLineId) ?? []), result])
      for (const [lineId, results] of byLine) {
        const line = this.state.lines.get(lineId) as LineRecord
        this.emit(GXG_EVENTS.kitCompleted, kitCompletedBody(next, line, results))
      }
      return this.kitDto(next)
    }
    if (to === "Received" || WITH_LAB.has(to)) {
      for (const line of lines) {
        if (!line.ships && (line.currentStatus === "Pending" || line.currentStatus === "Shipped")) {
          this.state.lines.update(line.id, { ...line, currentStatus: "Processing" })
        }
      }
    }
    this.state.kits.update(kitNumber, next)
    if (to === "Received") this.emit(GXG_EVENTS.kitReceived, kitReceivedBody(next))
    return this.kitDto(next)
  }

  private async publishResults(
    kit: KitRecord,
    lines: readonly LineRecord[],
    source: { fixture: ResultFixture } | { custom: CustomResults },
    pdf: boolean,
  ): Promise<ResultRecord[] | string> {
    const reportDate = this.iso()
    const files = resultFiles(kit.kitNumber, source, reportDate, { pdf })
    const live = lines.filter((l) => l.currentStatus !== "Canceled")
    const reportLine =
      live.find((l) => l.productCode === "ngx_report_comprehensive_json") ??
      live.find((l) => !l.ships) ??
      live[0] ??
      lines[0]
    const rawLine = live.find((l) => l.productCode === "ngx_raw_data") ?? reportLine
    if (!reportLine || !rawLine) return `kit ${kit.kitNumber} has no order lines`
    const bucket = this.resultsS3?.bucket ?? this.state.current().resultsBucket
    const published: ResultRecord[] = []
    for (const file of files) {
      // `s3://<bucket>/<namespace>/<kitNumber>.<ext>`: parallel workers share one bucket.
      const key = `${this.publicNamespace ?? "default"}/${kit.kitNumber}.${file.extension}`
      const line = file.extension === "csv" ? rawLine : reportLine
      let resultPayload = `s3://${bucket}/${key}`
      if (this.resultsS3) {
        try {
          resultPayload = await putObject(this.resultsS3, key, file.bytes, file.contentType)
        } catch (error) {
          return `results S3 write failed: ${error instanceof Error ? error.message : String(error)}`
        }
      }
      this.state.blobs.insert(key, {
        key,
        contentType: file.contentType,
        base64: toBase64(file.bytes),
      })
      const existing = this.state.results
        .list({ where: (r) => r.kitNumber === kit.kitNumber && r.resultType === file.resultType })
        .at(0)?.value
      const result: ResultRecord = {
        resultId: existing?.resultId ?? this.state.uuid("result"),
        kitNumber: kit.kitNumber,
        orderId: line.orderId,
        orderLineId: line.id,
        resultType: file.resultType,
        resultTypeName: file.resultTypeName,
        resultDate: reportDate,
        key,
        resultPayload,
      }
      this.state.results.insert(result.resultId, result)
      published.push(result)
    }
    return published
  }

  orders(): OrderRecord[] {
    return this.state.orders.list({ order: "oldest" }).map((row) => row.value)
  }

  kits(): KitRecord[] {
    return this.state.kits.list({ order: "oldest" }).map((row) => row.value)
  }

  /** The kit as `GET /api/v2/kits/{kitNumber}` reports it. */
  kit(kitNumber: string) {
    const kit = this.state.kits.get(kitNumber)
    return kit ? this.kitDto(kit) : undefined
  }

  /** The order as `GET /api/v2/orders/{id}` reports it. */
  order(orderId: string) {
    const order = this.state.orders.get(orderId)
    return order ? this.orderDto(order) : undefined
  }
}

const unique = <T>(value: T, index: number, all: readonly T[]) => all.indexOf(value) === index

const isYyyymmdd = (value: string) => {
  if (!/^\d{8}$/.test(value)) return false
  const date = new Date(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T00:00:00Z`)
  return (
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10).replace(/-/g, "") === value
  )
}

const attributePairs = (
  attributes: { name?: unknown; value?: unknown }[] | null | undefined,
): { name: string; value: string }[] =>
  (attributes ?? []).flatMap((a) =>
    typeof a.name === "string" && typeof a.value === "string" && a.name.trim().length > 0
      ? [{ name: a.name, value: a.value }]
      : [],
  )

export type { GeneByGeneRuntime, GeneByGeneRuntimeOptions } from "./runtime.js"
export { createRuntime, GENEBYGENE_PRESETS } from "./runtime.js"
