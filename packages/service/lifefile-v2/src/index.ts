import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  annotateResponse,
  basicAuth,
  bearerToken,
  bootSqlite,
  createService,
  DroppedConnectionError,
  defineOperations,
  faultEffect,
  fromBase64,
  jsonRes,
  markMutationAccepted,
  type OperationContext,
  type Service,
  toBase64,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { Hono } from "hono"
import {
  CANCEL_STATUS,
  CATALOG_DATA,
  type CatalogData,
  describePrivilege,
  NEW_STATUS,
} from "./corpus.js"
import { document, type SupportedOperationId } from "./generated/openapi.js"
import { LifeFileState } from "./state.js"
import type {
  ApiUser,
  OrderRecord,
  RxRecord,
  Settings,
  ShippingRecord,
  StatusChange,
  TokenRecord,
  TrackingRecord,
} from "./types.js"
import { type PushBody, pushBody } from "./webhooks.js"

export type { FetchAPI } from "@crvouga/mockingbird-core"
export type { SqliteClient } from "@crvouga/mockingbird-sqlite"
export type { CatalogData } from "./corpus.js"
export {
  CATALOG_DATA,
  CATALOGS,
  CORPUS_VERSION,
  DEFAULT_CLIENT,
  DEFAULT_SETTINGS,
  PRODUCTION_STATUSES,
  RECORDED_LATENCY_MS,
  SANDBOX_STATUSES,
} from "./corpus.js"
export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export type { LifeFileV2Runtime, LifeFileV2RuntimeOptions } from "./runtime.js"
export { createRuntime, LIFEFILE_V2_PRESETS } from "./runtime.js"
export { LifeFileState } from "./state.js"
export type * from "./types.js"
export type { PushBody } from "./webhooks.js"
export {
  basicPushSigner,
  PROVISIONAL_PUSH_SHAPE,
  PUSH_EVENT,
  PUSH_RETRY_DELAYS_MS,
  PUSH_SHAPE_HEADER,
  pushBody,
} from "./webhooks.js"

export const LIFEFILE_V2_NAMESPACE = "lifefile-v2"

export type PushRequest = { body: PushBody; badCredentials: boolean }

export type LifeFileV2APIOptions = APIOptions & {
  settings?: Partial<Settings>
  apiUsers?: readonly Partial<ApiUser>[]
  onPush?: (push: PushRequest) => void
}

type Json = Record<string, unknown>

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const base64url = (value: string) =>
  toBase64(new TextEncoder().encode(value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")

const fromBase64url = (value: string): string | undefined => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      fromBase64(value.replace(/-/g, "+").replace(/_/g, "/")),
    )
  } catch {
    return undefined
  }
}

const JWT_HEADER = base64url(JSON.stringify({ typ: "JWT", alg: "HS256" }))

type Claims = { sub: string; jti: number; iat: number; gen: number; rev: number }

const decodeClaims = (token: string): Claims | undefined => {
  const [, payload] = token.split(".")
  if (!payload) return undefined
  const text = fromBase64url(payload)
  if (!text) return undefined
  try {
    const value = JSON.parse(text) as unknown
    if (
      !isRecord(value) ||
      typeof value.sub !== "string" ||
      typeof value.jti !== "number" ||
      typeof value.iat !== "number" ||
      typeof value.gen !== "number" ||
      typeof value.rev !== "number"
    ) {
      return undefined
    }
    return { sub: value.sub, jti: value.jti, iat: value.iat, gen: value.gen, rev: value.rev }
  } catch {
    return undefined
  }
}

export const tokenCredential = (request: Request): string | undefined => {
  const token = bearerToken(request)
  if (token) return decodeClaims(token)?.sub
  return basicAuth(request)?.username || undefined
}

const success = (data: unknown, message = "Success.") =>
  jsonRes(200, { type: "success", message, data })

const failure = (status: number, message: string, data: unknown = null) =>
  jsonRes(status, { type: "error", message, data })

const oauthError = (status: number, error: string, description: string) =>
  jsonRes(status, { error, error_description: description })

const INVALID_CREDENTIALS = () => oauthError(401, "invalid_client", "Invalid Credentials")
const INVALID_REQUEST = () => oauthError(422, "invalid_request", "Validation Error")
const NOT_FOUND = () => failure(404, "Record not found")
const VALIDATION = (data: Record<string, string[]>) => failure(422, "Validation Error", data)
const BEARER_REQUIRED = "Authorization header is expected to reference a Bearer authentication"
const INACTIVE = "Invalid authorization token: Token is no longer active"
const SHIPPING_CRASH = (given: string) =>
  failure(500, `Server Error: shipping must be an object, ${given} given`)

const PRESCRIBER_FIELDS = [
  "id",
  "npi",
  "licenseState",
  "licenseNumber",
  "dea",
  "lastName",
  "firstName",
  "middleName",
  "address1",
  "address2",
  "city",
  "state",
  "zip",
  "phone",
  "fax",
  "email",
] as const

const PATIENT_FIELDS = [
  "id",
  "lastName",
  "firstName",
  "middleName",
  "gender",
  "dateOfBirth",
  "address1",
  "address2",
  "address3",
  "city",
  "state",
  "zip",
  "country",
  "phoneHome",
  "phoneMobile",
  "phoneWork",
  "email",
] as const

const SHIPPING_FIELDS = [
  "recipientType",
  "recipientLastName",
  "recipientFirstName",
  "company",
  "attention",
  "recipientPhone",
  "recipientEmail",
  "addressLine1",
  "addressLine2",
  "addressLine3",
  "city",
  "state",
  "zipCode",
  "country",
  "service",
  "handlingService",
  "signatureType",
  "insuranceAmount",
  "thirdPartyBillingAccount",
  "saturdayDelivery",
  "fedExPriorityAlert",
  "residentialAddressIndicator",
] as const satisfies readonly (keyof ShippingRecord)[]

const ORDER_SHIPPING_FIELDS = [
  "recipientType",
  "recipientLastName",
  "recipientFirstName",
  "recipientPhone",
  "recipientEmail",
  "addressLine1",
  "addressLine2",
  "addressLine3",
  "city",
  "state",
  "zipCode",
  "country",
  "service",
  "handlingService",
] as const satisfies readonly (keyof ShippingRecord)[]

const RX_FIELDS = [
  "fillId",
  "rxType",
  "rxNumber",
  "drugName",
  "drugStrength",
  "drugForm",
  "quantity",
  "quantityUnits",
  "directions",
  "refills",
  "daysSupply",
  "scheduleCode",
  "clinicalDifferenceStatement",
  "note",
  "uuid",
] as const satisfies readonly (keyof RxRecord)[]

const scalar = (value: unknown): string | number | boolean | null =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value
    : null

const pick = <K extends string>(source: unknown, fields: readonly K[]) => {
  const record = isRecord(source) ? source : {}
  return Object.fromEntries(fields.map((field) => [field, scalar(record[field])])) as Record<
    K,
    string | number | null
  >
}

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i

const words = (segment: string) =>
  segment
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/_/g, " ")

const attribute = (path: string) => {
  if (path.includes(".rxs.")) return path
  const parts = path.split(".")
  const last = parts.pop() ?? ""
  return [...parts, words(last)].join(".")
}

type Rule = {
  path: string
  parent?: string
  required: boolean
  maxLength?: number
  enum?: string[]
  uuid?: boolean
}

type Schema = {
  $ref?: string
  type?: string | string[]
  properties?: Record<string, Schema>
  required?: string[]
  items?: Schema
  oneOf?: Schema[]
  anyOf?: Schema[]
  allOf?: Schema[]
  maxLength?: number
  enum?: unknown[]
  format?: string
}

const components = (document as unknown as { components: { schemas: Record<string, Schema> } })
  .components.schemas

const resolve = (schema: Schema | undefined): Schema => {
  if (!schema) return {}
  if (schema.$ref) return resolve(components[schema.$ref.split("/").pop() ?? ""])
  const variants = [...(schema.oneOf ?? []), ...(schema.anyOf ?? []), ...(schema.allOf ?? [])]
  if (variants.length === 0) return schema
  const properties: Record<string, Schema> = {}
  for (const variant of variants.map(resolve)) {
    for (const [name, child] of Object.entries(variant.properties ?? {})) {
      const next = resolve(child)
      const prior = properties[name]
      if (!prior) {
        properties[name] = next
        continue
      }
      properties[name] = {
        ...prior,
        ...(prior.enum || next.enum
          ? { enum: [...new Set([...(prior.enum ?? []), ...(next.enum ?? [])])] }
          : {}),
        ...(prior.maxLength !== undefined || next.maxLength !== undefined
          ? { maxLength: Math.max(prior.maxLength ?? 0, next.maxLength ?? 0) }
          : {}),
      }
    }
  }
  const merged: Schema = { properties, required: [] }
  const { oneOf: _oneOf, anyOf: _anyOf, allOf: _allOf, ...rest } = schema
  return { ...rest, ...merged }
}

const fieldRules = (schema: Schema, prefix: string, depth = 0, parent?: string): Rule[] => {
  const resolved = resolve(schema)
  const out: Rule[] = []
  if (depth > 4) return out
  for (const [name, child] of Object.entries(resolved.properties ?? {})) {
    const path = prefix ? `${prefix}.${name}` : name
    const value = resolve(child)
    const type = Array.isArray(value.type) ? value.type : value.type ? [value.type] : []
    if (type.includes("array")) continue
    if (value.properties) {
      out.push(...fieldRules(value, path, depth + 1, path))
      continue
    }
    out.push({
      path,
      ...(parent ? { parent } : {}),
      required: (resolved.required ?? []).includes(name),
      ...(value.maxLength !== undefined ? { maxLength: value.maxLength } : {}),
      ...(value.enum?.every((e) => typeof e === "string") ? { enum: value.enum as string[] } : {}),
      ...(value.format === "uuid" ? { uuid: true } : {}),
    })
  }
  return out
}

const ORDER_PAYLOAD = resolve(components.CreateOrderPayload)
const SECTION_RULES = (["general", "prescriber", "patient", "shipping", "billing"] as const).map(
  (section) => ({
    section,
    rules: fieldRules(ORDER_PAYLOAD.properties?.[section] ?? {}, `order.${section}`),
  }),
)
const RX_RULES = fieldRules(resolve(ORDER_PAYLOAD.properties?.rxs).items ?? {}, "").filter(
  (rule) => rule.path !== "uuid",
)
const SHIPPING_UPDATE_RULES = fieldRules(components.OrderShipping ?? {}, "shipping")

const at = (value: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((node, key) => (isRecord(node) ? node[key] : undefined), value)

const missing = (value: unknown) => value === undefined || value === null || value === ""

const checkRule = (errors: Record<string, string[]>, rule: Rule, value: unknown, key: string) => {
  const name = attribute(key)
  const add = (message: string) => {
    errors[key] = [...(errors[key] ?? []), message]
  }
  if (missing(value)) {
    if (rule.required) add(`The ${name} field is required.`)
    return
  }
  if (rule.maxLength !== undefined && typeof value === "string" && value.length > rule.maxLength) {
    add(`The ${name} may not be greater than ${rule.maxLength} characters.`)
  }
  if (rule.enum && typeof value === "string" && !rule.enum.includes(value)) {
    add(`The selected ${name} is invalid.`)
  }
}

const validateOrder = (body: Json): Record<string, string[]> => {
  const errors: Record<string, string[]> = {}
  if (missing(at(body, "message.id"))) errors["message.id"] = ["The message.id field is required."]
  for (const { section, rules } of SECTION_RULES) {
    const node = at(body, `order.${section}`)
    if (!isRecord(node)) continue
    for (const rule of rules) {
      if (rule.parent && !isRecord(at(body, rule.parent))) continue
      checkRule(errors, rule, at(body, rule.path), rule.path)
    }
  }
  const rxs = at(body, "order.rxs")
  if (!Array.isArray(rxs) || rxs.length === 0) {
    errors["order.rxs"] = ["The order.rxs field is required."]
    return errors
  }
  const seen = new Map<string, number[]>()
  rxs.forEach((rx, index) => {
    const prefix = `order.rxs.${index}`
    if (!isRecord(rx)) {
      errors[prefix] = [`The ${prefix} must be an array.`]
      return
    }
    for (const rule of RX_RULES) {
      if (rule.parent && !isRecord(at(rx, rule.parent))) continue
      checkRule(errors, rule, at(rx, rule.path), `${prefix}.${rule.path}`)
    }
    if (missing(rx.scheduleCode)) {
      errors[`${prefix}.scheduleCode`] = [`The ${prefix}.scheduleCode field is required.`]
    }
    const uuid = rx.uuid
    if (!missing(uuid)) {
      if (typeof uuid !== "string" || !UUID.test(uuid)) {
        errors[`${prefix}.uuid`] = [`The ${prefix}.uuid must be a valid UUID.`]
      } else {
        seen.set(uuid.toLowerCase(), [...(seen.get(uuid.toLowerCase()) ?? []), index])
      }
    }
  })
  for (const indexes of seen.values()) {
    if (indexes.length < 2) continue
    for (const index of indexes) {
      const key = `order.rxs.${index}.uuid`
      errors[key] = [
        ...(errors[key] ?? []),
        "Each RX UUID must be unique within the order (case-insensitive).",
      ]
    }
  }
  return errors
}

const sortedErrors = (errors: Record<string, string[]>) => {
  const rank = (key: string) => {
    const match = /^order\.rxs\.(\d+)\./.exec(key)
    return match ? 1_000 + Number(match[1]) : 0
  }
  return Object.fromEntries(Object.entries(errors).sort(([a], [b]) => rank(a) - rank(b))) as Record<
    string,
    string[]
  >
}

const zoned = (ms: number, timeZone: string) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>
  const local = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  )
  const offsetMinutes = Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000)
  const sign = offsetMinutes < 0 ? "-" : "+"
  const abs = Math.abs(offsetMinutes)
  const offset = `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`
  return { local, iso: `${local.replace(" ", "T")}${offset}` }
}

type Auth = { user: ApiUser; claims: Claims; token: TokenRecord | undefined }

type Page = { page: number; perPage: number }

const queryString = (context: OperationContext, name: string): string | undefined => {
  const value = context.query[name]
  return typeof value === "string" ? value : undefined
}

const pageOf = (
  context: OperationContext,
  sortFields: readonly string[],
  defaultSort: string,
  defaultType: "asc" | "desc",
): (Page & { sortField: string; sortType: "asc" | "desc" }) | Record<string, string[]> => {
  const errors: Record<string, string[]> = {}
  const pageRaw = queryString(context, "page")
  const perPageRaw = queryString(context, "perPage")
  const page = pageRaw === undefined ? 1 : Number(pageRaw)
  const perPage = perPageRaw === undefined ? 20 : Number(perPageRaw)
  if (!Number.isInteger(page)) errors.page = ["The page must be an integer."]
  else if (page < 1) errors.page = ["The page must be at least 1."]
  if (!Number.isInteger(perPage)) errors.perPage = ["The per page must be an integer."]
  else if (perPage < 5 || perPage > 50) errors.perPage = ["The per page must be between 5 and 50."]
  const sortField = queryString(context, "sortField") ?? defaultSort
  if (!sortFields.includes(sortField)) errors.sortField = ["The selected sort field is invalid."]
  const sortType = queryString(context, "sortType") ?? defaultType
  if (sortType !== "asc" && sortType !== "desc") {
    errors.sortType = ["The selected sort type is invalid."]
  }
  if (Object.keys(errors).length > 0) return errors
  return { page, perPage, sortField, sortType: sortType as "asc" | "desc" }
}

const paginate = <T>(items: readonly T[], page: Page) => ({
  data: items.slice((page.page - 1) * page.perPage, page.page * page.perPage),
  total: items.length,
  perPage: page.perPage,
  currentPage: page.page,
  lastPage: Math.max(1, Math.ceil(items.length / page.perPage)),
})

const isPage = (value: unknown): value is Page & { sortField: string; sortType: "asc" | "desc" } =>
  isRecord(value) && typeof value.page === "number"

const compare = (a: unknown, b: unknown) => {
  if (typeof a === "number" && typeof b === "number") return a - b
  return String(a ?? "").localeCompare(String(b ?? ""))
}

const ORDER_SORT_FIELDS = [
  "id",
  "createdOn",
  "lastUpdatedOn",
  "patient.lastName",
  "patient.firstName",
  "patient.dateOfBirth",
  "patient.gender",
  "patient.city",
  "patient.state",
  "prescriber.lastName",
  "prescriber.firstName",
  "prescriber.city",
  "prescriber.state",
  "prescriber.npi",
  "prescriber.dea",
  "prescriber.licenseState",
  "prescriber.licenseNumber",
  "practice.id",
  "shipping.recipientLastName",
  "shipping.recipientFirstName",
  "shipping.state",
  "shipping.city",
  "shipping.service",
  "shipping.handlingService",
  "billing.payorType",
] as const

const SUBSTRING_FILTERS = new Set([
  "general.memo",
  "rx.drugName",
  "rx.drugStrength",
  "rx.drugForm",
  "patient.email",
  "shipping.addressLine1",
])
const CSV_FILTERS = new Set(["id", "general.statusId", "rx.fillId"])

const filterSchema = resolve(components.OrderListFilter)
const allowedFilters = new Set<string>()
for (const [section, child] of Object.entries(filterSchema.properties ?? {})) {
  const resolved = resolve(child)
  if (!resolved.properties) {
    allowedFilters.add(section)
    continue
  }
  for (const [name, leaf] of Object.entries(resolved.properties)) {
    const range = resolve(leaf)
    if (range.properties) {
      for (const bound of Object.keys(range.properties))
        allowedFilters.add(`${section}.${name}.${bound}`)
    } else allowedFilters.add(`${section}.${name}`)
  }
}

const flatten = (value: unknown, prefix = ""): [string, string][] => {
  if (typeof value === "string") return [[prefix, value]]
  if (!isRecord(value)) return []
  return Object.entries(value).flatMap(([key, entry]) =>
    flatten(entry, prefix ? `${prefix}.${key}` : key),
  )
}

export class LifeFileV2API implements FetchAPI {
  readonly app: Hono
  readonly sqlite: SqliteClient
  readonly state: LifeFileState
  private readonly service: Service
  private readonly now: () => number
  private readonly onPush: ((push: PushRequest) => void) | undefined
  private readonly auth = new WeakMap<Request, Auth>()
  private readonly rateWindows = new Map<string, { window: number; count: number }>()
  private rateMinute = -1

  constructor(options: LifeFileV2APIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite)
    const namespace = options.namespace ?? LIFEFILE_V2_NAMESPACE
    this.now = options.now ?? (() => Date.now())
    this.onPush = options.onPush
    this.state = new LifeFileState(
      sqlite,
      namespace,
      { settings: options.settings ?? {}, apiUsers: options.apiUsers ?? [] },
      this.now,
    )
    const handlers = defineOperations<SupportedOperationId>({
      IssueToken: (c) => this.issueToken(c),
      RevokeCurrentToken: (c) => this.revokeCurrentToken(c),
      CurrentApiUser: (c) => this.currentApiUser(c),
      RotateCurrentSecret: (c) => this.rotateSecret(c),
      ListOrders: (c) => this.listOrders(c),
      CreateOrder: (c) => this.createOrder(c),
      ShowOrder: (c) => this.withOrder(c, (order) => success(this.orderDto(order))),
      GetOrderStatus: (c) => this.withOrder(c, (order) => success(this.status(order.statusId))),
      UpdateOrderStatus: (c) => this.updateStatus(c),
      GetOrderShipping: (c) => this.withOrder(c, (order) => success({ ...order.shipping })),
      UpdateOrderShipping: (c) => this.updateShipping(c),
      ListLocations: (c) => this.listLocations(c),
      ShowLocation: (c) => this.showLocation(c),
      ListLocationShippingConfigurations: (c) => this.emptyPage(c),
      ListShippingServices: (c) => this.listShippingServices(c),
      ListPracticeShippingServices: (c) => this.emptyPage(c),
      ListStatuses: (c) => this.listStatuses(c),
      Ping: (c) => success({ http_method: c.request.method, ssl_client_verify: null }),
    })
    this.service = createService({
      document,
      handlers,
      sqlite,
      namespace,
      now: this.now,
      notFound: () => failure(404, "Not Found"),
      onError: (error) => {
        throw error
      },
      before: (context) => this.authenticate(context),
    })
    this.app = this.service.app
    this.sqlite = this.service.sqlite
  }

  async fetch(request: Request): Promise<Response> {
    this.runDue(this.statusWriteTarget(request))
    const limited = this.rateLimit(request)
    if (limited.refused) return limited.refused
    const response = await this.service.fetch(request)
    if (!limited.headers) return response
    const out = new Response(response.body, response)
    out.headers.set("X-RateLimit-Limit", String(limited.headers.limit))
    out.headers.set("X-RateLimit-Remaining", String(limited.headers.remaining))
    return out
  }

  async reset(): Promise<void> {
    await this.service.reset()
    this.rateWindows.clear()
    this.state.ensureSeeded()
  }

  private settings(): Settings {
    return this.state.current()
  }

  private catalog(): CatalogData {
    return CATALOG_DATA[this.settings().catalog]
  }

  private status(id: string | null): { id: string | null; label: string | null } {
    return { id, label: this.catalog().statuses.find((s) => s.id === id)?.label ?? null }
  }

  private local(ms: number) {
    return zoned(ms, this.settings().timeZone)
  }

  private rateLimit(request: Request): {
    refused?: Response
    headers?: { limit: number; remaining: number }
  } {
    const { pathname } = new URL(request.url)
    if (!pathname.includes("/api/v2/")) return {}
    const limits = this.settings().rateLimits
    if (!limits) return {}
    const token = pathname.endsWith("/api/v2/auth/token") && request.method === "POST"
    const limit = token ? limits.token : limits.api
    const window = Math.floor(this.now() / 60_000)
    if (window !== this.rateMinute) {
      for (const [key, entry] of this.rateWindows) {
        if (entry.window !== window) this.rateWindows.delete(key)
      }
      this.rateMinute = window
    }
    const key = `${token ? "token" : "api"}:${this.rateVendor(request.headers.get("x-vendor-id"))}`
    const current = this.rateWindows.get(key)
    const count = current && current.window === window ? current.count + 1 : 1
    this.rateWindows.set(key, { window, count })
    const headers = { limit, remaining: Math.max(0, limit - count) }
    if (count <= limit) return { headers }
    const retryAfter = String(60 - Math.floor((this.now() % 60_000) / 1000))
    const refused = token
      ? oauthError(429, "too_many_requests", "Too Many Requests")
      : failure(429, "Too Many Attempts.")
    refused.headers.set("Retry-After", retryAfter)
    return { refused, headers }
  }

  private rateVendor(header: string | null): string {
    const vendor = Number(header ?? "")
    if (!Number.isInteger(vendor) || vendor <= 0) return "unknown"
    if (vendor === this.settings().vendorId) return String(vendor)
    const known = this.state.apiUsers
      .list({ order: "oldest" })
      .some(({ value }) => value.vendorId === vendor)
    return known ? String(vendor) : "unknown"
  }

  private pruneDeadTokens(now: number, settings: Settings): void {
    for (const { id, value } of this.state.tokens.list({ order: "oldest" })) {
      const expired = now >= value.issuedAt + settings.tokenTtlSeconds * 1000
      const idle = now - value.lastUsedAt >= settings.tokenIdleSeconds * 1000
      if (expired || idle) this.state.tokens.delete(id)
    }
  }

  private authenticate(context: OperationContext): Response | undefined {
    const id = context.operation.operationId as SupportedOperationId
    if (id === "IssueToken") return undefined
    const header = context.request.headers.get("authorization") ?? ""
    const match = /^Bearer\s+(\S+)\s*$/i.exec(header)
    if (!match?.[1]) return failure(401, BEARER_REQUIRED)
    const token = match[1]
    const parts = token.split(".")
    if (parts.length !== 3)
      return failure(401, "Invalid authorization token: Wrong number of segments", [])
    const vendor = context.request.headers.get("x-vendor-id")
    if (vendor === null || vendor.trim() === "")
      return failure(401, "X-Vendor-ID header is required")
    const claims = decodeClaims(token)
    if (!claims || parts[2] !== this.state.signature(`${parts[0]}.${parts[1]}`)) {
      return failure(401, "Invalid authorization token: Signature verification failed", [])
    }
    const settings = this.settings()
    const now = this.now()
    if (faultEffect(context.request, "token_revoked") !== undefined)
      return failure(401, INACTIVE, [])
    if (now >= (claims.iat + settings.tokenTtlSeconds) * 1000) {
      return failure(401, "Invalid authorization token: Expired token", [])
    }
    const user = this.state.user(claims.sub)
    if (!user || user.generation !== claims.gen || settings.tokenGeneration !== claims.rev) {
      return failure(401, INACTIVE, [])
    }
    const record = this.state.tokens.get(String(claims.jti))
    if (record?.revoked) return failure(401, INACTIVE, [])
    const lastUsed = record?.lastUsedAt ?? claims.iat * 1000
    if (now - lastUsed >= settings.tokenIdleSeconds * 1000) return failure(401, INACTIVE, [])
    if (settings.enforceVendorId && Number(vendor) !== user.vendorId) {
      return failure(401, "Invalid X-Vendor-ID header")
    }
    const privilege = (context.operation.operation as Json)["x-lifefile-privilege"]
    if (typeof privilege === "string" && !user.privileges.includes(privilege)) {
      return failure(
        403,
        `The authenticated API user does not have the required privilege '${privilege}'.`,
      )
    }
    const used: TokenRecord = {
      tokenId: claims.jti,
      clientId: claims.sub,
      issuedAt: record?.issuedAt ?? claims.iat * 1000,
      lastUsedAt: now,
      revoked: false,
    }
    this.state.tokens.insert(String(claims.jti), used)
    this.auth.set(context.request, { user, claims, token: used })
    return undefined
  }

  private authOf(context: OperationContext): Auth {
    const auth = this.auth.get(context.request)
    if (!auth) throw new Error("request was not authenticated")
    return auth
  }

  private issueToken(context: OperationContext): Response {
    const form: Record<string, string> = {}
    const value =
      context.body.kind === "form" || context.body.kind === "json" ? context.body.value : undefined
    if (isRecord(value)) {
      for (const [key, entry] of Object.entries(value)) {
        if (typeof entry === "string") form[key] = entry
      }
    }
    const vendor = context.request.headers.get("x-vendor-id")
    if (vendor === null || vendor.trim() === "") return INVALID_REQUEST()
    if (form.grant_type !== "client_credentials") return INVALID_REQUEST()
    const basic = basicAuth(context.request)
    const clientId = form.client_id || basic?.username || ""
    const secret = form.client_secret || basic?.password || ""
    if (!clientId || !secret) return INVALID_CREDENTIALS()
    const settings = this.settings()
    const now = this.now()
    if (settings.enforceVendorId && Number(vendor) !== settings.vendorId) {
      const known = this.state.user(clientId)
      if (!known || known.vendorId !== Number(vendor)) return INVALID_CREDENTIALS()
    }
    let user = this.state.user(clientId)
    if (!user) {
      if (!settings.openEnrollment) return INVALID_CREDENTIALS()
      user = this.state.registerUser({ clientId, secret, secretIssuedAt: now })
    }
    if (user.secret !== secret) return INVALID_CREDENTIALS()
    if (now >= user.secretIssuedAt + settings.secretTtlDays * 86_400_000)
      return INVALID_CREDENTIALS()
    if (settings.enforceVendorId && Number(vendor) !== user.vendorId) return INVALID_CREDENTIALS()
    this.pruneDeadTokens(now, settings)
    const tokenId = this.state.nextTokenId()
    const claims: Claims = {
      sub: user.clientId,
      jti: tokenId,
      iat: Math.floor(now / 1000),
      gen: user.generation,
      rev: settings.tokenGeneration,
    }
    const payload = base64url(JSON.stringify(claims))
    const signature = this.state.signature(`${JWT_HEADER}.${payload}`)
    this.state.tokens.insert(String(tokenId), {
      tokenId,
      clientId: user.clientId,
      issuedAt: claims.iat * 1000,
      lastUsedAt: claims.iat * 1000,
      revoked: false,
    })
    return jsonRes(200, {
      access_token: `${JWT_HEADER}.${payload}.${signature}`,
      token_type: "Bearer",
      expires_in: settings.tokenTtlSeconds,
      scope: "*",
    })
  }

  private revokeCurrentToken(context: OperationContext): Response {
    const { claims, token } = this.authOf(context)
    this.state.tokens.insert(String(claims.jti), {
      tokenId: claims.jti,
      clientId: claims.sub,
      issuedAt: token?.issuedAt ?? claims.iat * 1000,
      lastUsedAt: this.now(),
      revoked: true,
    })
    return success([], "API token revoked successfully.")
  }

  private currentApiUser(context: OperationContext): Response {
    const { user, claims } = this.authOf(context)
    const settings = this.settings()
    return success({
      apiUser: {
        id: user.userId,
        userName: user.clientId,
        vendorId: user.vendorId,
        userGroup: user.userGroup,
      },
      token: {
        id: claims.jti,
        authType: "api_user_v2_jwt",
        issuedAt: this.local(claims.iat * 1000).iso,
        expiresAt: this.local((claims.iat + settings.tokenTtlSeconds) * 1000).iso,
        lastUsedOn: this.local(this.now()).iso,
      },
      privileges: user.privileges.map(describePrivilege),
    })
  }

  private activeTokens(user: ApiUser): number {
    const settings = this.settings()
    const now = this.now()
    return this.state.tokens
      .list({ where: (t) => t.clientId === user.clientId && !t.revoked })
      .filter(
        (row) =>
          now < row.value.issuedAt + settings.tokenTtlSeconds * 1000 &&
          now - row.value.lastUsedAt < settings.tokenIdleSeconds * 1000,
      ).length
  }

  private rotateSecret(context: OperationContext): Response {
    const { user } = this.authOf(context)
    const revokedTokenCount = this.activeTokens(user)
    const next = this.state.saveUser({
      ...user,
      secret: this.state.secret(),
      secretIssuedAt: this.now(),
      generation: user.generation + 1,
    })
    return success(
      { userName: next.clientId, secret: next.secret, revokedTokenCount },
      "API user secret rotated successfully.",
    )
  }

  revokeTokens(): number {
    return this.state.update({ tokenGeneration: this.settings().tokenGeneration + 1 })
      .tokenGeneration
  }

  expireSecret(clientId: string): ApiUser | undefined {
    const user = this.state.user(clientId)
    if (!user) return undefined
    return this.state.saveUser({
      ...user,
      secretIssuedAt: this.now() - this.settings().secretTtlDays * 86_400_000 - 1,
    })
  }

  private createOrder(context: OperationContext): Response {
    const { user } = this.authOf(context)
    const body =
      context.body.kind === "json" && isRecord(context.body.value) ? context.body.value : {}
    const locationId = at(body, "order.location.id")
    if (missing(locationId)) {
      return VALIDATION({ "order.location.id": ["The order location id field is required."] })
    }
    const location = this.catalog().locations.find((l) => String(l.id) === String(locationId))
    if (!location) {
      return failure(
        422,
        `Invalid order location id received: '${String(scalar(locationId) ?? "")}'`,
      )
    }
    const practiceId = at(body, "order.practice.id")
    const practice = missing(practiceId) ? user.practiceId : Number(practiceId)
    if (practice !== user.practiceId) {
      return failure(
        403,
        `This API user is not allowed to create an order for Practice ID ${String(scalar(practiceId))}.`,
      )
    }
    const errors = validateOrder(body)
    if (Object.keys(errors).length > 0) return VALIDATION(sortedErrors(errors))
    const now = this.now()
    const { id, sequence } = this.state.nextOrderId()
    const settings = this.settings()
    const rxs = (at(body, "order.rxs") as Json[]).map((rx) => {
      const fields = pick(rx, RX_FIELDS) as unknown as RxRecord
      return {
        ...fields,
        rxNumber: rx.rxType === "refill" ? fields.rxNumber : null,
        uuid: typeof rx.uuid === "string" && rx.uuid ? rx.uuid : this.state.uuid(),
      }
    })
    const order: OrderRecord = {
      id,
      sequence,
      createdAt: now,
      lastUpdatedAt: now,
      statusId: NEW_STATUS,
      statusWritten: false,
      touched: false,
      general: {
        memo: (scalar(at(body, "order.general.memo")) as string | null) ?? null,
        referenceId: (scalar(at(body, "order.general.referenceId")) as string | null) ?? null,
      },
      locationId: location.id,
      prescriber: pick(at(body, "order.prescriber"), PRESCRIBER_FIELDS),
      practice: {
        id: practice,
        name: practice === settings.practice.id ? settings.practice.name : `Practice ${practice}`,
      },
      patient: pick(at(body, "order.patient"), PATIENT_FIELDS),
      shipping: pick(at(body, "order.shipping"), SHIPPING_FIELDS) as unknown as ShippingRecord,
      billing: {
        payorType: (scalar(at(body, "order.billing.payorType")) as string | null) ?? null,
      },
      rxs,
      messageId: (scalar(at(body, "message.id")) as string | number | null) ?? null,
      tracking: null,
    }
    order.prescriber.id = null
    order.patient.id = null
    this.state.saveOrder(order)
    for (const rx of rxs) this.state.indexRx(rx.uuid, id)
    if (settings.intake && this.catalog().statuses.some((s) => s.id === settings.intake?.status)) {
      this.state.pendingIntake.insert(String(id), {
        orderId: id,
        dueAt: now + settings.intake.afterMs,
      })
    }
    const response = annotateResponse(success({ orderId: id }), { ids: { orderId: String(id) } })
    if (faultEffect(context.request, "create_lost_reply") !== undefined) {
      markMutationAccepted(context.request, { ids: { orderId: String(id) } })
      throw new DroppedConnectionError()
    }
    return response
  }

  orderDto(order: OrderRecord) {
    return {
      id: order.id,
      createdOn: this.local(order.createdAt).local,
      lastUpdatedOn: this.local(order.lastUpdatedAt).local,
      general: { ...order.general, statusId: order.statusId },
      location: { id: order.locationId },
      prescriber: { ...order.prescriber },
      practice: { ...order.practice },
      patient: { ...order.patient },
      shipping: Object.fromEntries(ORDER_SHIPPING_FIELDS.map((f) => [f, order.shipping[f]])),
      billing: { ...order.billing },
      rxs: order.rxs.map((rx) => Object.fromEntries(RX_FIELDS.map((f) => [f, rx[f]]))),
    }
  }

  orders(): OrderRecord[] {
    return this.state.orders
      .list()
      .map((row) => row.value)
      .sort((a, b) => b.sequence - a.sequence)
  }

  private orderIdOf(context: OperationContext): number | Response {
    const raw = context.params.orderId ?? ""
    if (!/^-?\d+$/.test(raw)) return VALIDATION({ orderId: ["The order id must be an integer."] })
    const id = Number(raw)
    if (id < 1) return VALIDATION({ orderId: ["The order id must be at least 1."] })
    return id
  }

  private withOrder(
    context: OperationContext,
    then: (order: OrderRecord) => Response,
    touch = true,
  ): Response {
    const id = this.orderIdOf(context)
    if (typeof id !== "number") return id
    const order = this.state.order(id)
    if (!order) return NOT_FOUND()
    if (touch && !order.touched) this.state.saveOrder({ ...order, touched: true })
    return then(this.state.order(id) as OrderRecord)
  }

  private statusWriteTarget(request: Request): number | undefined {
    if (request.method !== "PUT") return undefined
    const match = /\/api\/v2\/orders\/(\d+)\/status$/.exec(new URL(request.url).pathname)
    return match ? Number(match[1]) : undefined
  }

  runDue(except?: number): void {
    const now = this.now()
    const settings = this.settings()
    for (const row of this.state.pendingIntake.list({ order: "oldest" })) {
      if (row.value.dueAt > now || row.value.orderId === except) continue
      this.state.pendingIntake.delete(row.id)
      const order = this.state.order(row.value.orderId)
      if (!order || order.statusWritten || order.statusId !== NEW_STATUS || !settings.intake)
        continue
      if (!this.catalog().statuses.some((s) => s.id === settings.intake?.status)) continue
      this.changeStatus(order, settings.intake.status, "intake", { touchUpdated: false })
    }
  }

  private changeStatus(
    order: OrderRecord,
    next: string,
    source: StatusChange["source"],
    options: { touchUpdated?: boolean; push?: boolean; markTouched?: boolean } = {},
  ): StatusChange {
    const previous = order.statusId
    const updated: OrderRecord = {
      ...order,
      statusId: next,
      statusWritten: source !== "intake" || order.statusWritten,
      touched: options.markTouched ? true : order.touched,
      lastUpdatedAt: options.touchUpdated === false ? order.lastUpdatedAt : this.now(),
    }
    this.state.saveOrder(updated)
    if (source !== "intake" || previous !== next) this.state.pendingIntake.delete(String(order.id))
    const change: StatusChange = { order: updated, previous, current: next, source }
    if (options.push !== false && previous !== next) this.push(updated, previous, null)
    return change
  }

  private push(
    order: OrderRecord,
    previous: string | null,
    tracking: TrackingRecord | null,
    badCredentials = false,
  ) {
    const status = this.status(order.statusId)
    this.onPush?.({
      body: pushBody({
        order,
        status: { id: status.id ?? "", label: status.label ?? "" },
        previous:
          previous === null ? null : { id: previous, label: this.status(previous).label ?? "" },
        changedOn: this.local(this.now()).local,
        tracking,
      }),
      badCredentials,
    })
  }

  private updateStatus(context: OperationContext): Response {
    const id = this.orderIdOf(context)
    if (typeof id !== "number") return id
    const order = this.state.order(id)
    if (!order) return NOT_FOUND()
    const body =
      context.body.kind === "json" && isRecord(context.body.value) ? context.body.value : {}
    const status = body.status
    if (typeof status !== "string" || status.trim() === "") {
      return VALIDATION({ status: ["The status field is required."] })
    }
    if (!this.catalog().statuses.some((s) => s.id === status)) {
      return failure(404, `Order Status ID '${status}' does not exist`)
    }
    const settings = this.settings()
    const fastTrack =
      status === CANCEL_STATUS &&
      !order.touched &&
      !order.statusWritten &&
      (order.statusId === NEW_STATUS || order.statusId === settings.intake?.status) &&
      this.now() - order.createdAt <= settings.fastTrackWindowMs &&
      this.catalog().statuses.some((s) => s.id === settings.fastTrackStatus)
    if (fastTrack) {
      this.changeStatus(order, settings.fastTrackStatus, "fast_track", { markTouched: true })
      return success({
        order_status_changed: 1,
        original_order_status: NEW_STATUS,
        current_order_status: settings.fastTrackStatus,
        process_fast_track_result: [],
      })
    }
    this.runDue()
    this.changeStatus(this.state.order(id) as OrderRecord, status, "api", { markTouched: true })
    return success({ status })
  }

  setStatus(
    orderId: number,
    status: string,
    options: { push?: boolean } = {},
  ): StatusChange | string {
    const order = this.state.order(orderId)
    if (!order) return `no order ${orderId}`
    if (!this.catalog().statuses.some((s) => s.id === status)) {
      return `Order Status ID '${status}' does not exist`
    }
    return this.changeStatus(order, status, "admin", { push: options.push !== false })
  }

  emitPush(
    orderId: number,
    tracking: TrackingRecord | null,
    badCredentials = false,
  ): OrderRecord | undefined {
    const order = this.state.order(orderId)
    if (!order) return undefined
    const saved = tracking ? this.state.saveOrder({ ...order, tracking }) : order
    this.push(saved, null, tracking, badCredentials)
    return saved
  }

  private updateShipping(context: OperationContext): Response {
    return this.withOrder(context, (order) => {
      const body = context.body.kind === "json" ? context.body.value : undefined
      const shipping = isRecord(body) ? body.shipping : undefined
      if (!isRecord(shipping)) {
        const given =
          shipping === undefined || shipping === null
            ? "null"
            : Array.isArray(shipping)
              ? "array"
              : typeof shipping === "number"
                ? Number.isInteger(shipping)
                  ? "int"
                  : "float"
                : typeof shipping === "boolean"
                  ? "bool"
                  : "string"
        if (given !== "array") return SHIPPING_CRASH(given)
      }
      const errors: Record<string, string[]> = {}
      const patch = isRecord(shipping) ? shipping : {}
      for (const rule of SHIPPING_UPDATE_RULES) {
        if (rule.path.split(".")[1] && !((rule.path.split(".")[1] as string) in patch)) continue
        checkRule(
          errors,
          { ...rule, required: false },
          at({ shipping: patch }, rule.path),
          rule.path,
        )
      }
      if (Object.keys(errors).length > 0) return VALIDATION(errors)
      const next = { ...order.shipping }
      for (const field of SHIPPING_FIELDS) {
        if (field in patch) (next as Record<string, unknown>)[field] = scalar(patch[field])
      }
      this.state.saveOrder({ ...order, shipping: next, lastUpdatedAt: this.now() })
      return success(null)
    })
  }

  private listOrders(context: OperationContext): Response {
    const page = pageOf(context, ORDER_SORT_FIELDS, "id", "desc")
    if (!isPage(page)) return VALIDATION(page)
    const filters = flatten(context.query.filter)
    const unknown = filters.filter(([key]) => !allowedFilters.has(key))
    if (unknown.length > 0) {
      return VALIDATION(
        Object.fromEntries(
          unknown.map(([key]) => [`filter.${key}`, [`The filter.${key} filter is not supported.`]]),
        ),
      )
    }
    const rxUuid = filters.find(([key]) => key === "rx.uuid")?.[1]
    const candidates = rxUuid !== undefined ? this.state.ordersByRx(rxUuid) : this.orders()
    const rows = candidates
      .map((order) => this.orderDto(order))
      .filter((dto) => filters.every(([key, value]) => this.matches(dto, key, value)))
    const direction = page.sortType === "asc" ? 1 : -1
    rows.sort((a, b) => {
      const primary = compare(at(a, page.sortField), at(b, page.sortField)) * direction
      return primary !== 0 ? primary : b.id - a.id
    })
    return success(paginate(rows, page))
  }

  private matches(dto: ReturnType<LifeFileV2API["orderDto"]>, key: string, value: string): boolean {
    const wanted = value.toLowerCase()
    const [section, field, bound] = key.split(".")
    if (section === "rx") {
      return dto.rxs.some((rx) =>
        this.compareField(`rx.${field}`, rx[field as keyof typeof rx], wanted),
      )
    }
    if (bound === "from" || bound === "to") {
      const actual = String(
        at(dto, `${section}.${field}`) ?? (section === "general" ? at(dto, field ?? "") : ""),
      )
      return bound === "from" ? actual >= value : actual <= value
    }
    const path =
      section === "id"
        ? "id"
        : section === "general" && field === "statusId"
          ? "general.statusId"
          : key
    return this.compareField(key, at(dto, path), wanted)
  }

  private compareField(key: string, actual: unknown, wanted: string): boolean {
    const text = String(actual ?? "").toLowerCase()
    if (CSV_FILTERS.has(key))
      return wanted
        .split(",")
        .map((v) => v.trim())
        .includes(text)
    if (SUBSTRING_FILTERS.has(key)) return text.includes(wanted)
    return text === wanted
  }

  private listStatuses(context: OperationContext): Response {
    const page = pageOf(context, ["id", "label"], "label", "asc")
    if (!isPage(page)) return VALIDATION(page)
    const rows = [...this.catalog().statuses]
    if (page.sortField === "id") rows.sort((a, b) => a.id.localeCompare(b.id))
    if (page.sortType === "desc") rows.reverse()
    return success(paginate(rows, page))
  }

  private listLocations(context: OperationContext): Response {
    const page = pageOf(context, ["id", "name", "shortName"], "name", "asc")
    if (!isPage(page)) return VALIDATION(page)
    const rows = [...this.catalog().locations]
    if (page.sortField !== "name") {
      rows.sort((a, b) => compare(a[page.sortField as "id"], b[page.sortField as "id"]))
    }
    if (page.sortType === "desc") rows.reverse()
    return success(paginate(rows, page))
  }

  private showLocation(context: OperationContext): Response {
    const raw = context.params.locationId ?? ""
    if (!/^\d+$/.test(raw))
      return VALIDATION({ locationId: ["The location id must be an integer."] })
    const location = this.catalog().locations.find((l) => l.id === Number(raw))
    return location ? success({ ...location }) : NOT_FOUND()
  }

  private listShippingServices(context: OperationContext): Response {
    const page = pageOf(context, ["id", "name", "sortPosition"], "sortPosition", "asc")
    if (!isPage(page)) return VALIDATION(page)
    const rows = [...this.catalog().shippingServices]
    if (queryString(context, "sortField") !== undefined) {
      rows.sort((a, b) => compare(a[page.sortField as "id"], b[page.sortField as "id"]))
      if (page.sortType === "desc") rows.reverse()
    }
    return success(paginate(rows, page))
  }

  private emptyPage(context: OperationContext): Response {
    const page = pageOf(context, ["id", "name"], "id", "asc")
    if (!isPage(page)) return VALIDATION(page)
    return success(paginate([], page))
  }
}
