import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  annotateResponse,
  basicAuth,
  bodyIssues,
  bootSqlite,
  createService,
  defineOperations,
  faultEffect,
  jsonRes,
  type OperationContext,
  type Service,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { Hono } from "hono"
import { document, type SupportedOperationId } from "./generated/openapi.js"
import { LifeFileState, type OrderRecord, type Settings } from "./state.js"

export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export type { OrderRecord, Settings } from "./state.js"
export const LIFEFILE_NAMESPACE = "lifefile"
export const basicUsername = (request: Request): string | undefined => basicAuth(request)?.username
export type PushOptions = { duplicate?: boolean; badCredentials?: boolean }
export type LifeFileAPIOptions = APIOptions & {
  settings?: Partial<Settings>
  onPush?: (order: OrderRecord, options: PushOptions) => Promise<void>
}
const envelope = (status: number, type: "success" | "error", message: string, orderId?: string) =>
  jsonRes(status, { type, message, ...(orderId ? { data: { orderId } } : {}) })
/** Metadata only: patient, prescription, address and memo bodies are never retained. */
export class LifeFileAPI implements FetchAPI {
  readonly app: Hono
  readonly sqlite: SqliteClient
  readonly state: LifeFileState
  private readonly service: Service
  private readonly now: () => number
  private readonly onPush: LifeFileAPIOptions["onPush"]
  constructor(options: LifeFileAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite)
    const namespace = options.namespace ?? LIFEFILE_NAMESPACE
    this.state = new LifeFileState(sqlite, namespace, options.settings ?? {})
    this.now = options.now ?? Date.now
    this.onPush = options.onPush
    this.service = createService({
      document,
      sqlite,
      namespace,
      now: this.now,
      handlers: defineOperations<SupportedOperationId>({
        CreateOrder: (c) => this.createOrder(c),
        UpdateOrderStatus: (c) => this.updateStatus(c),
      }),
      notFound: () => envelope(404, "error", "Not found"),
      onError: (error) => {
        throw error
      },
      before: (context) => {
        const credentials = basicAuth(context.request)
        if (
          !credentials?.username ||
          !credentials.password ||
          (this.state.current().accounts.length > 0 &&
            !this.state
              .current()
              .accounts.some(
                (a) => a.username === credentials.username && a.password === credentials.password,
              ))
        )
          return envelope(401, "error", "Unauthorized")
        for (const key of ["X-Vendor-ID", "X-Location-ID", "X-API-Network-ID"]) {
          const value = context.request.headers.get(key)
          if (value === null || !/^\d+$/.test(value) || Number(value) > 2147483647)
            return envelope(400, "error", `Invalid ${key}: expected a nonnegative integer`)
        }
        if (bodyIssues(context).length) return envelope(400, "error", "Invalid request body")
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
  private async createOrder(context: OperationContext): Promise<Response> {
    if (faultEffect(context.request, "reject") !== undefined)
      return envelope(200, "error", "Order rejected by emulator fixture")
    const body =
      context.body.kind === "json"
        ? (context.body.value as {
            message: { id: number }
            order: { general?: { referenceId?: string }; shipping: { state: string } }
          })
        : undefined
    if (!body) return envelope(400, "error", "Expected JSON")
    const existing = this.state.orders.list({
      where: (order) => order.messageId === body.message.id,
    })[0]?.value
    if (existing) return envelope(200, "success", "Order accepted", existing.orderId)
    if (this.state.current().refusedShippingStates.includes(body.order.shipping.state))
      return envelope(200, "error", "Shipping state refused by emulator pharmacy fixture")
    const order: OrderRecord = {
      orderId: this.state.ids.next("", 10),
      messageId: body.message.id,
      referenceId: body.order.general?.referenceId ?? null,
      status: "Received",
      updatedAt: new Date(this.now()).toISOString(),
    }
    this.state.orders.insert(order.orderId, order)
    await this.onPush?.(order, {
      duplicate: faultEffect(context.request, "duplicate_push") !== undefined,
      badCredentials: faultEffect(context.request, "bad_push_credentials") !== undefined,
    })
    return annotateResponse(envelope(200, "success", "Order accepted", order.orderId), {
      ids: { orderId: order.orderId },
    })
  }
  private async updateStatus(context: OperationContext): Promise<Response> {
    const order = this.state.orders.get(context.params.id ?? "")
    if (!order) return envelope(404, "error", "Order not found")
    const status = this.state.current().cancelStatus
    if (status === null)
      return envelope(
        501,
        "error",
        "Emulator limitation: configure cancelStatus; vendor cancellation codes are unverified",
      )
    const body =
      context.body.kind === "json" ? (context.body.value as { status: string }) : undefined
    if (body?.status !== status)
      return envelope(
        501,
        "error",
        "Emulator limitation: only the configured cancellation status is supported",
      )
    if (order.status !== "Cancelled") await this.transition(order.orderId, "Cancelled")
    return envelope(200, "success", "Order cancelled", order.orderId)
  }
  async transition(
    id: string,
    status: string,
    options: PushOptions = {},
  ): Promise<OrderRecord | undefined> {
    const order = this.state.orders.get(id)
    if (!order) return undefined
    const next = { ...order, status, updatedAt: new Date(this.now()).toISOString() }
    this.state.orders.update(id, next)
    await this.onPush?.(next, options)
    return next
  }
}
export type { LifeFileRuntime, LifeFileRuntimeOptions } from "./runtime.js"
export { createRuntime, LIFEFILE_PRESETS } from "./runtime.js"
