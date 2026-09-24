import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  annotateResponse,
  basicAuth,
  bodyIssues,
  bootSqlite,
  createService,
  DroppedConnectionError,
  defineOperations,
  faultEffect,
  HttpError,
  jsonRes,
  type OperationContext,
  opaqueToken,
  type Service,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { Hono } from "hono"
import { type Catalog, orderableSkus, unitPrice } from "./catalog.js"
import { document, type SupportedOperationId } from "./generated/openapi.js"
import { type OrderRecord, type Settings, type Tracking, WholescriptsState } from "./state.js"

export type { FetchAPI } from "@crvouga/mockingbird-core"
export type { SqliteClient } from "@crvouga/mockingbird-sqlite"
export type {
  Catalog,
  MedPaxDetails,
  MedPaxPill,
  PrivateLabelCarton,
  Product,
} from "./catalog.js"
export { DEFAULT_CATALOG, MEDPAX_BOX_SKU } from "./catalog.js"
export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export type { AutoAdvance, OrderRecord, Settings, Tracking } from "./state.js"

export const WHOLESCRIPTS_NAMESPACE = "wholescripts"

export type WholescriptsAPIOptions = APIOptions & {
  /** The catalog every namespace starts with. Default: {@link DEFAULT_CATALOG}. */
  catalog?: Catalog
  /** Initial per-namespace settings (accounts, auto-advance). */
  settings?: Partial<Settings>
}

/** ASP.NET Web API's answer to a missing or wrong `Authorization: Basic`. */
const UNAUTHORIZED = { Message: "Authorization has been denied for this request." }

/** The Basic username a request carries: how credentials map to namespaces. */
export const basicUsername = (request: Request): string | undefined =>
  basicAuth(request)?.username || undefined

const record = (context: OperationContext): Record<string, unknown> | undefined =>
  context.body.kind === "json" &&
  typeof context.body.value === "object" &&
  context.body.value !== null &&
  !Array.isArray(context.body.value)
    ? (context.body.value as Record<string, unknown>)
    : undefined

const round2 = (value: number) => Math.round(value * 100) / 100

/** Canonical casing for the statuses our consumers branch on; anything else is kept verbatim. */
const CANONICAL: Record<string, string> = {
  pending: "Pending",
  processing: "Processing",
  complete: "Complete",
  completed: "Complete",
  cancelled: "Cancelled",
  canceled: "Cancelled",
  error: "Error",
}
export const canonicalStatus = (to: string): string => CANONICAL[to.trim().toLowerCase()] ?? to

const statusRow = (order: OrderRecord) => ({
  orderNumber: order.orderNumber,
  orderDate: order.orderDate,
  salesOrder: order.salesOrder,
  status: order.status,
  tracking: order.tracking,
  message: order.message,
  subTotal: order.subTotal,
  shipMethod: order.shipMethod,
  shipCharge: order.shipCharge,
  discount: order.discount,
  tax: order.tax,
  serviceFee: order.serviceFee,
  orderTotal: order.orderTotal,
})

export type TransitionInput = {
  to: string
  trackingNumber?: string
  carrier?: string
  trackingUrl?: string
  message?: string
}

const trackingUrl = (carrier: string, number: string) =>
  /ups/i.test(carrier)
    ? `https://www.ups.com/track?tracknum=${number}`
    : /usps/i.test(carrier)
      ? `https://tools.usps.com/go/TrackConfirmAction?tLabels=${number}`
      : `https://www.fedex.com/fedextrack/?trknbr=${number}`

/**
 * Stateful mock of the Wholescripts supplement fulfilment API.
 *
 * Orders start `Pending` and move only through admin transitions or auto-advance; nothing is
 * pushed to the app (Wholescripts has no webhooks), so the app sees each change on its next
 * `GET /api/Orders/Status` poll.
 */
export class WholescriptsAPI implements FetchAPI {
  readonly app: Hono
  readonly sqlite: SqliteClient
  readonly state: WholescriptsState
  private readonly service: Service
  private readonly now: () => number

  constructor(options: WholescriptsAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite)
    const namespace = options.namespace ?? WHOLESCRIPTS_NAMESPACE
    this.now = options.now ?? (() => Date.now())
    this.state = new WholescriptsState(sqlite, namespace, {
      catalog: options.catalog,
      settings: options.settings ?? {},
    })
    const handlers = defineOperations<SupportedOperationId>({
      GetPrivateLabelProductList: () => {
        const catalog = this.state.catalog()
        return jsonRes(200, {
          privateLabelProducts: [],
          medPaxPills: catalog.medPaxPills,
          privateLabelCartons: catalog.privateLabelCartons,
        })
      },
      GetProductList: (context) => this.productList(context),
      SubmitOrder: (context) => this.submit(context),
      GetOrderStatus: (context) => this.status(context),
      CancelOrder: (context) => this.cancel(context),
    })
    this.service = createService({
      document,
      handlers,
      sqlite,
      namespace,
      now: this.now,
      notFound: () =>
        jsonRes(404, { Message: "No HTTP resource was found that matches the request URI." }),
      onError: (error) => {
        if (error instanceof HttpError) return error.toResponse()
        throw error
      },
      before: (context) => {
        this.tick()
        const credentials = basicAuth(context.request)
        if (!credentials?.username || !credentials.password) return jsonRes(401, UNAUTHORIZED)
        const accounts = this.state.current().accounts
        if (
          accounts.length > 0 &&
          !accounts.some(
            (a) => a.username === credentials.username && a.password === credentials.password,
          )
        ) {
          return jsonRes(401, UNAUTHORIZED)
        }
        return undefined
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

  private productList(context: OperationContext): Response {
    const params = context.url.searchParams
    let rows = this.state.catalog().products
    if (params.get("instockonly")?.toLowerCase() === "true") {
      rows = rows.filter((p) => p.quantity > 0)
    }
    const search = params.get("search")?.trim().toLowerCase()
    if (search) {
      rows = rows.filter((p) =>
        [p.productName, p.sku, p.medPaxSku, p.brand, p.categories].some((field) =>
          field.toLowerCase().includes(search),
        ),
      )
    }
    const limit = Number(params.get("limit"))
    if (Number.isInteger(limit) && limit > 0) rows = rows.slice(0, limit)
    return jsonRes(200, rows)
  }

  private submit(context: OperationContext): Response {
    const rejected = (msg: string) => jsonRes(200, { orderNumber: "", success: false, msg })
    if (faultEffect(context.request, "submit_rejected") !== undefined) {
      return rejected("Payment authorization failed")
    }
    const body = record(context)
    if (!body) return rejected("Invalid order: the request body must be a JSON object")
    const issues = bodyIssues(context)
    if (issues.length > 0) {
      const first = issues[0]
      return rejected(`Invalid order: ${first?.path || "body"} ${first?.message ?? "is invalid"}`)
    }
    const items = body.Items as {
      Sku: string
      Quantity: number
      MedPaxPills?: { Sku: string; Quantity: number }[] | null
    }[]
    const catalog = this.state.catalog()
    const skus = orderableSkus(catalog)
    const lines = items.flatMap((item) => [
      { sku: item.Sku, quantity: item.Quantity },
      ...(item.MedPaxPills ?? []).map((pill) => ({ sku: pill.Sku, quantity: pill.Quantity })),
    ])
    const unknown = lines.find((line) => !skus.has(line.sku))
    if (unknown) return rejected(`Invalid SKU: ${unknown.sku}`)
    const subTotal = round2(
      lines.reduce((sum, line) => sum + unitPrice(catalog, line.sku) * line.quantity, 0),
    )
    const shipMethod = String(body.ShippingMethod)
    const shipCharge = /free/i.test(shipMethod) || subTotal === 0 ? 0 : 9.95
    const order: OrderRecord = {
      orderNumber: this.state.nextOrderNumber(),
      orderDate: this.iso(),
      salesOrder: "",
      status: "Pending",
      tracking: [],
      message: "",
      subTotal,
      shipMethod,
      shipCharge,
      discount: 0,
      tax: 0,
      serviceFee: 0,
      orderTotal: round2(subTotal + shipCharge),
      items: lines,
      createdAtMs: this.now(),
      advanced: 0,
    }
    this.state.orders.insert(order.orderNumber, order)
    // The vendor placed the order but the caller never hears back (the scheduler's "order may have
    // been placed" timeout branch).
    if (faultEffect(context.request, "submit_timeout") !== undefined) {
      throw new DroppedConnectionError()
    }
    return annotateResponse(
      jsonRes(200, {
        orderNumber: order.orderNumber,
        success: true,
        msg: "Order submitted successfully",
      }),
      { ids: { orderNumber: order.orderNumber } },
    )
  }

  private status(context: OperationContext): Response {
    const ordernum = context.url.searchParams.get("ordernum")?.trim()
    if (!ordernum) return jsonRes(400, { Message: "The ordernum parameter is required." })
    const order = this.state.orders.get(ordernum)
    if (!order || faultEffect(context.request, "status_empty") !== undefined) {
      return jsonRes(200, [])
    }
    const row: Record<string, unknown> = statusRow(order)
    if (faultEffect(context.request, "status_schema_drift") !== undefined) {
      delete row.salesOrder
      row.orderTotal = String(row.orderTotal)
    }
    return annotateResponse(jsonRes(200, [row]), { ids: { orderNumber: order.orderNumber } })
  }

  private cancel(context: OperationContext): Response {
    const body = record(context)
    const orderNumber = typeof body?.OrderNumber === "string" ? body.OrderNumber.trim() : ""
    if (!orderNumber) return jsonRes(400, { success: false, msg: "OrderNumber is required" })
    const order = this.state.orders.get(orderNumber)
    if (!order) return jsonRes(404, { success: false, msg: `Order ${orderNumber} not found` })
    const ids = { orderNumber }
    if (order.status === "Cancelled") {
      return annotateResponse(
        jsonRes(200, { success: false, msg: `Order ${orderNumber} is already cancelled` }),
        { ids },
      )
    }
    if (!["Pending", "Processing"].includes(order.status) || order.tracking.length > 0) {
      return annotateResponse(
        jsonRes(200, {
          success: false,
          msg: `Order ${orderNumber} cannot be cancelled: it is ${order.status}${order.tracking.length > 0 ? " and has shipped" : ""}`,
        }),
        { ids },
      )
    }
    this.transition(orderNumber, { to: "Cancelled", message: "Cancelled by customer request" })
    return annotateResponse(
      jsonRes(200, { success: true, msg: `Order ${orderNumber} cancelled` }),
      { ids },
    )
  }

  /** Move an order to a vendor status; `Complete` (or a tracking number) adds tracking. */
  transition(orderNumber: string, input: TransitionInput): OrderRecord | undefined {
    const order = this.state.orders.get(orderNumber)
    if (!order) return undefined
    const status = canonicalStatus(input.to)
    let tracking: Tracking[] = order.tracking
    if (input.trackingNumber) {
      const carrier = input.carrier ?? "UPS"
      tracking = [
        ...order.tracking.filter((t) => t.trackingNumber !== input.trackingNumber),
        {
          trackingNumber: input.trackingNumber,
          carrier,
          trackingUrl: input.trackingUrl ?? trackingUrl(carrier, input.trackingNumber),
        },
      ]
    } else if (status === "Complete" && tracking.length === 0) {
      const number = `1Z${opaqueToken(order.orderNumber, 16).toUpperCase()}`
      const carrier = input.carrier ?? "UPS"
      tracking = [{ trackingNumber: number, carrier, trackingUrl: trackingUrl(carrier, number) }]
    }
    const next: OrderRecord = {
      ...order,
      status,
      tracking,
      salesOrder:
        order.salesOrder ||
        (status === "Processing" || status === "Complete" ? `SO${order.orderNumber}` : ""),
      message: input.message ?? (status === "Error" ? "Order could not be processed" : ""),
    }
    this.state.orders.update(orderNumber, next)
    return this.state.orders.get(orderNumber)
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
        const moved = this.transition(current.orderNumber, {
          to: plan.path[current.advanced] as string,
        })
        if (!moved) break
        current = { ...moved, advanced: current.advanced + 1 }
        this.state.orders.update(current.orderNumber, current)
        applied++
      }
    }
    return applied
  }

  orders(): OrderRecord[] {
    return this.state.orders.list({ order: "oldest" }).map((row) => row.value)
  }
}

export type { WholescriptsRuntime, WholescriptsRuntimeOptions } from "./runtime.js"
export { createRuntime, WHOLESCRIPTS_PRESETS } from "./runtime.js"
