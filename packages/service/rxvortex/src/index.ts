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
  issuesByField,
  jsonRes,
  type OperationContext,
  opaqueToken,
  type Service,
  toBase64,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { Hono } from "hono"
import type { CatalogItem } from "./catalog.js"
import { document, type SupportedOperationId } from "./generated/openapi.js"
import { type OrderRecord, RxVortexState, type Settings } from "./state.js"
import { isShippedOrLater, isTerminal, triple } from "./statuses.js"

export type { FetchAPI } from "@crvouga/mockingbird-core"
export type { SqliteClient } from "@crvouga/mockingbird-sqlite"
export type { CatalogItem } from "./catalog.js"
export { CUSTOM_CREAM_ANCHOR_PRESET_ID, DEFAULT_CATALOG } from "./catalog.js"
export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export type { AutoAdvance, OrderRecord, Settings } from "./state.js"

export const RXVORTEX_NAMESPACE = "rxvortex"

/** The status webhook body RxVortex posts (our receiver reads these field names). */
export type RxVortexWebhook = {
  event: "order.status_updated"
  orderReferenceID: string
  order_tracking_id: string
  tracking_id: string
  sender_order_id: string
  rxstatus: string
  orderstatus: string
  shipping_status: string
  delivered_date: string | null
  trackingnumber: string | null
  shippingcarrier: string | null
  shippingservice: string | null
  shipmenttrackingurl: string | null
  updated_at: string
}

export type RxVortexAPIOptions = APIOptions & {
  /** Rows every namespace starts with. Default: {@link DEFAULT_CATALOG}. */
  catalog?: readonly CatalogItem[]
  /** Initial per-namespace settings (token TTL, static tokens, clients, auto-advance). */
  settings?: Partial<Settings>
  /** Called for every status change; the runtime signs and delivers it. */
  onWebhook?: (event: RxVortexWebhook) => void
}

const TOKEN_PREFIX = "rxv_"

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

/**
 * The client id a bearer token was issued to, or the static token itself. Tokens carry their
 * client id so the runtime can map `RXVORTEX_CLIENT_ID` to a namespace (the app's `fetch`
 * cannot add a namespace header).
 */
export const tokenCredential = (request: Request): string | undefined => {
  const token = bearerToken(request)
  if (!token) return undefined
  if (!token.startsWith(TOKEN_PREFIX)) return token
  const [encoded] = token.slice(TOKEN_PREFIX.length).split(".")
  return encoded ? fromBase64url(encoded) : undefined
}

const issueToken = (clientId: string, issuedAtSeconds: number) => {
  const signature = opaqueToken(`rxvortex:${clientId}:${issuedAtSeconds}`, 32)
  return `${TOKEN_PREFIX}${base64url(clientId)}.${issuedAtSeconds}.${signature}`
}

type TokenCheck = { ok: true } | { ok: false; message: string }

const checkToken = (token: string, settings: Settings, nowMs: number): TokenCheck => {
  if (settings.staticTokens.includes(token)) return { ok: true }
  if (!token.startsWith(TOKEN_PREFIX)) return { ok: false, message: "Unauthenticated." }
  const [encoded, issued, signature] = token.slice(TOKEN_PREFIX.length).split(".")
  const clientId = encoded ? fromBase64url(encoded) : undefined
  const issuedAt = Number(issued)
  if (clientId === undefined || !Number.isInteger(issuedAt) || !signature) {
    return { ok: false, message: "Unauthenticated." }
  }
  if (signature !== opaqueToken(`rxvortex:${clientId}:${issuedAt}`, 32)) {
    return { ok: false, message: "Unauthenticated." }
  }
  if (nowMs / 1000 >= issuedAt + settings.tokenTtlSeconds) {
    return { ok: false, message: "Token has expired." }
  }
  return { ok: true }
}

const record = (context: OperationContext): Record<string, unknown> => {
  if (
    context.body.kind !== "json" ||
    typeof context.body.value !== "object" ||
    !context.body.value
  ) {
    throw new HttpError(422, {
      message: "The given data was invalid.",
      errors: { body: ["The request body must be a JSON object."] },
    })
  }
  return context.body.value as Record<string, unknown>
}

/** The status body `GET /api/v1/orders/{id}` answers with. */
const statusBody = (order: OrderRecord) => ({
  order_tracking_id: order.order_tracking_id,
  tracking_id: order.order_tracking_id,
  orderReferenceID: order.order_tracking_id,
  sender_order_id: order.sender_order_id,
  rxstatus: order.rxstatus,
  orderstatus: order.orderstatus,
  shipping_status: order.shipping_status,
  delivered_date: order.delivered_date,
  trackingnumber: order.trackingnumber,
  shippingservice: order.shippingservice,
  shippingcarrier: order.shippingcarrier,
  shipmenttrackingurl: order.shipmenttrackingurl,
  cancellable: order.cancellable,
  created_at: order.created_at,
  updated_at: order.updated_at,
})

export type TransitionInput = {
  to: string
  trackingnumber?: string
  shippingcarrier?: string
  shippingservice?: string
  delivered_date?: string
}

/**
 * Stateful mock of the RxVortex (Strive) pharmacy API.
 *
 * Orders start `Created` and move only through admin transitions or auto-advance, each of
 * which updates the three vendor status fields together and emits the status webhook.
 */
export class RxVortexAPI implements FetchAPI {
  readonly app: Hono
  readonly sqlite: SqliteClient
  readonly state: RxVortexState
  private readonly service: Service
  private readonly now: () => number
  private readonly onWebhook: ((event: RxVortexWebhook) => void) | undefined

  constructor(options: RxVortexAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite)
    const namespace = options.namespace ?? RXVORTEX_NAMESPACE
    this.now = options.now ?? (() => Date.now())
    this.onWebhook = options.onWebhook
    this.state = new RxVortexState(sqlite, namespace, {
      catalog: options.catalog ?? [],
      settings: options.settings ?? {},
    })
    const handlers = defineOperations<SupportedOperationId>({
      GenerateAccessToken: (context) => this.generateToken(context),
      CreateOrder: (context) => this.createOrder(context),
      GetOrder: (context) => this.getOrder(context),
      CancelOrder: (context) => this.cancelOrder(context),
      ListPresetCatalogItems: () =>
        jsonRes(200, {
          data: this.state.catalog.list({ order: "oldest" }).map((row) => row.value),
        }),
    })
    this.service = createService({
      document,
      handlers,
      sqlite,
      namespace,
      now: this.now,
      notFound: () => jsonRes(404, { message: "Not Found" }),
      onError: (error) => {
        if (error instanceof HttpError) return error.toResponse()
        throw error
      },
      before: (context) => {
        if (context.operation.operationId === "GenerateAccessToken") return undefined
        this.tick()
        const token = bearerToken(context.request)
        if (!token) return jsonRes(401, { message: "Unauthenticated." })
        if (faultEffect(context.request, "token_expired") !== undefined) {
          return jsonRes(401, { message: "Token has expired." })
        }
        const check = checkToken(token, this.state.current(), this.now())
        return check.ok ? undefined : jsonRes(401, { message: check.message })
      },
    })
    this.app = this.service.app
    this.sqlite = this.service.sqlite
  }

  fetch(request: Request): Promise<Response> {
    return this.service.fetch(request)
  }

  async reset(): Promise<void> {
    await this.service.reset()
    this.state.ensureSeeded()
  }

  private iso(): string {
    return new Date(this.now()).toISOString()
  }

  private generateToken(context: OperationContext): Response {
    const body = record(context)
    const issues = bodyIssues(context)
    if (issues.length > 0) {
      return jsonRes(422, { message: "The given data was invalid.", errors: issuesByField(issues) })
    }
    const clientId = String(body.client_id)
    const clients = this.state.current().clients
    if (
      clients.length > 0 &&
      !clients.some((c) => c.client_id === clientId && c.client_secret === body.client_secret)
    ) {
      return jsonRes(401, { message: "Invalid client credentials." })
    }
    const ttl = this.state.current().tokenTtlSeconds
    return jsonRes(200, {
      access_token: issueToken(clientId, Math.floor(this.now() / 1000)),
      token_type: "Bearer",
      expires_in: ttl,
    })
  }

  private createOrder(context: OperationContext): Response {
    const body = record(context)
    if (faultEffect(context.request, "validation_errors_array") !== undefined) {
      return jsonRes(422, {
        message: "The given data was invalid.",
        errors: [{ field: "patient.phone", message: "The patient.phone format is invalid." }],
      })
    }
    if (faultEffect(context.request, "validation_errors_object") !== undefined) {
      return jsonRes(422, {
        message: "The given data was invalid.",
        errors: { "patient.phone": ["The patient.phone format is invalid."] },
      })
    }
    if (faultEffect(context.request, "validation_errors_empty") !== undefined) {
      return jsonRes(422, { message: "The given data was invalid.", errors: [] })
    }
    const issues = bodyIssues(context)
    if (issues.length > 0) {
      return jsonRes(422, { message: "The given data was invalid.", errors: issuesByField(issues) })
    }
    const order = body.order as { sender_order_id: string }
    const meds = body.medication_requests as { preset_catalog_id: string }[]
    const unknown = meds.find((med) => {
      const item = this.state.catalog.get(med.preset_catalog_id)
      return !item || item.status !== "active"
    })
    if (unknown) {
      return jsonRes(422, {
        message: "The given data was invalid.",
        errors: {
          "medication_requests.0.preset_catalog_id": [
            `The selected preset catalog id ${unknown.preset_catalog_id} is invalid.`,
          ],
        },
      })
    }
    const existing = this.state.findOrder(order.sender_order_id)
    if (existing) {
      return annotateResponse(
        jsonRes(409, {
          success: false,
          message: `An order with sender_order_id ${order.sender_order_id} already exists.`,
        }),
        { ids: { orderId: existing.order_tracking_id } },
      )
    }
    const now = this.iso()
    const created: OrderRecord = {
      order_tracking_id: this.state.nextTrackingId(),
      sender_order_id: order.sender_order_id,
      ...triple("Created"),
      delivered_date: null,
      trackingnumber: null,
      shippingservice: null,
      shippingcarrier: null,
      shipmenttrackingurl: null,
      cancellable: true,
      created_at: now,
      updated_at: now,
      createdAtMs: this.now(),
      preset_catalog_ids: meds.map((m) => m.preset_catalog_id),
      advanced: 0,
    }
    this.state.orders.insert(created.order_tracking_id, created)
    const ids = { orderId: created.order_tracking_id, senderOrderId: created.sender_order_id }
    if (faultEffect(context.request, "created_but_500") !== undefined) {
      return annotateResponse(jsonRes(500, { message: "Server Error" }), { ids })
    }
    if (faultEffect(context.request, "duplicate_sender_order_id") !== undefined) {
      return annotateResponse(
        jsonRes(409, {
          success: false,
          message: `An order with sender_order_id ${created.sender_order_id} already exists.`,
        }),
        { ids },
      )
    }
    const numeric = faultEffect(context.request, "numeric_tracking_id") !== undefined
    return annotateResponse(
      jsonRes(200, {
        success: true,
        message: "Order created successfully.",
        order_tracking_id: numeric
          ? Number.parseInt(created.order_tracking_id.replace(/\D/g, "") || "1", 10)
          : created.order_tracking_id,
        sender_order_id: created.sender_order_id,
        status: created.rxstatus,
      }),
      { ids },
    )
  }

  private getOrder(context: OperationContext): Response {
    const order = this.state.findOrder(context.params.orderId ?? "")
    if (!order) return jsonRes(404, { message: "Order not found." })
    const body = statusBody(order)
    if (faultEffect(context.request, "stale_error_with_delivered_date") !== undefined) {
      Object.assign(body, {
        rxstatus: "Error",
        orderstatus: "Error",
        delivered_date: order.delivered_date ?? this.iso().slice(0, 10),
      })
    }
    return annotateResponse(jsonRes(200, body), { ids: { orderId: order.order_tracking_id } })
  }

  private cancelOrder(context: OperationContext): Response {
    const order = this.state.findOrder(context.params.orderId ?? "")
    if (!order) return jsonRes(404, { message: "Order not found." })
    if (!order.cancellable) {
      return jsonRes(409, {
        success: false,
        message: `Order ${order.order_tracking_id} cannot be cancelled in status ${order.rxstatus}.`,
      })
    }
    const updated = this.transition(order.order_tracking_id, { to: "Cancelled" })
    return annotateResponse(
      jsonRes(200, {
        success: true,
        message: "Order cancelled.",
        order_tracking_id: order.order_tracking_id,
        rxstatus: updated?.rxstatus ?? "Cancelled",
      }),
      { ids: { orderId: order.order_tracking_id } },
    )
  }

  /** Move an order to a vendor status, set the three fields coherently, emit the webhook. */
  transition(id: string, input: TransitionInput): OrderRecord | undefined {
    const order = this.state.findOrder(id)
    if (!order) return undefined
    const status = triple(input.to)
    const shipped = isShippedOrLater(input.to)
    const delivered = /deliver/i.test(status.shipping_status)
    const trackingnumber =
      input.trackingnumber ??
      order.trackingnumber ??
      (shipped ? `1Z${opaqueToken(order.order_tracking_id, 16).toUpperCase()}` : null)
    const carrier = input.shippingcarrier ?? order.shippingcarrier ?? (shipped ? "UPS" : null)
    const next: OrderRecord = {
      ...order,
      ...status,
      trackingnumber,
      shippingcarrier: carrier,
      shippingservice:
        input.shippingservice ?? order.shippingservice ?? (shipped ? "Ground" : null),
      shipmenttrackingurl:
        trackingnumber && carrier === "UPS"
          ? `https://www.ups.com/track?tracknum=${trackingnumber}`
          : order.shipmenttrackingurl,
      delivered_date:
        input.delivered_date ?? (delivered ? this.iso().slice(0, 10) : order.delivered_date),
      cancellable: !shipped && !isTerminal(status),
      updated_at: this.iso(),
    }
    this.state.orders.update(order.order_tracking_id, next)
    this.onWebhook?.({
      event: "order.status_updated",
      orderReferenceID: next.order_tracking_id,
      order_tracking_id: next.order_tracking_id,
      tracking_id: next.order_tracking_id,
      sender_order_id: next.sender_order_id,
      rxstatus: next.rxstatus,
      orderstatus: next.orderstatus,
      shipping_status: next.shipping_status,
      delivered_date: next.delivered_date,
      trackingnumber: next.trackingnumber,
      shippingcarrier: next.shippingcarrier,
      shippingservice: next.shippingservice,
      shipmenttrackingurl: next.shipmenttrackingurl,
      updated_at: next.updated_at,
    })
    return this.state.orders.get(order.order_tracking_id)
  }

  /**
   * Apply every auto-advance step that is due on the mock clock. Runs before each vendor
   * request, on `POST /__admin/tick`, and from the served runtime's background ticker.
   */
  tick(): number {
    const plan = this.state.current().autoAdvance
    if (!plan || plan.path.length === 0) return 0
    let applied = 0
    for (const { value: order } of this.state.orders.list({ order: "oldest" })) {
      let current = order
      while (current.advanced < plan.path.length) {
        const due = current.createdAtMs + plan.afterMs * (current.advanced + 1)
        if (this.now() < due) break
        const to = plan.path[current.advanced] as string
        const moved = this.transition(current.order_tracking_id, { to })
        if (!moved) break
        current = { ...moved, advanced: current.advanced + 1 }
        this.state.orders.update(current.order_tracking_id, current)
        applied++
      }
    }
    return applied
  }

  orders(): OrderRecord[] {
    return this.state.orders.list({ order: "oldest" }).map((row) => row.value)
  }
}

export type { RxVortexRuntime, RxVortexRuntimeOptions } from "./runtime.js"
export { createRuntime, RXVORTEX_PRESETS } from "./runtime.js"
