import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  annotateResponse,
  bodyIssues,
  bootSqlite,
  createService,
  defineOperations,
  faultEffect,
  fromBase64,
  HttpError,
  hmac,
  issuesByField,
  jsonRes,
  type OperationContext,
  requestFingerprint,
  type Service,
  timingSafeEqual,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { Hono } from "hono"
import { document, type SupportedOperationId } from "./generated/openapi.js"
import { AhaState, type OrderRecord, type Settings } from "./state.js"
import { drawStatus, isDrawn, isScheduling, ORDER_PLACED, orderStatus } from "./statuses.js"
import { isTimeZone, zonedParts, zonedToEpoch } from "./time.js"

export type { FetchAPI } from "@crvouga/mockingbird-core"
export type { SqliteClient } from "@crvouga/mockingbird-sqlite"
export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export type { ApiCredential, AutoSchedule, OrderRecord, Settings } from "./state.js"
export { DRAW_STATUSES, ORDER_STATUSES } from "./statuses.js"
export { isTimeZone, zonedParts, zonedToEpoch } from "./time.js"

export const AHA_NAMESPACE = "aha"

/**
 * The webhook body AHA posts to `POST /bloodwork/aha-webhook` (`AhaWebhookGenericDto`).
 * `status` and `partnerOrderId` are always present; the rest depend on the status.
 * `scheduleServiceTime` / `scheduleServiceTimeZone` are not in the DTO, but our handler
 * requires them on `Scheduled` and `Rescheduled`.
 */
export type AhaWebhook = {
  status: string
  partnerOrderId: string
  ahaOrderId: string
  scheduleServiceTime?: string
  scheduleServiceTimeZone?: string
  scheduledServiceDate?: string
  scheduledServiceTime?: string
  scheduledServiceTimeZone?: string
  scheduleConfirmationDate?: string
  scheduleConfirmationTime?: string
  scheduleConfirmationTimeZone?: string
  checkInDate?: string
  checkInTime?: string
  checkInTimeZone?: string
  drawStatus?: string
  drawStatusDate?: string
  drawStatusTime?: string
  drawStatusTimeZone?: string
  dropOffDate?: string
  dropOffTime?: string
  dropOffTimeZone?: string
}

export type TransitionInput = {
  /** A vendor order status (`Scheduled`, `Check Out`, …); case and `_` are forgiven. */
  status: string
  /** Sent with `Check Out`; defaults to `Sample Collected` there. */
  drawStatus?: string
  /** The appointment instant (ISO-8601 or epoch ms) for `Scheduled` / `Rescheduled`. */
  scheduledAt?: string | number
  /** IANA zone for every local time in the webhook; defaults to the order's zone. */
  timeZone?: string
}

export type AhaAPIOptions = APIOptions & {
  /** Initial per-namespace settings (envelope, credentials, autoSchedule, …). */
  settings?: Partial<Settings>
  /** Called for every emitted webhook; the runtime delivers it with `Authorization: Token …`. */
  onWebhook?: (event: AhaWebhook) => void
  /** Wall clock for `X-TIMESTAMP` tolerance (the consumer signs with real time). Default `Date.now`. */
  wallClock?: () => number
}

const DAY_MS = 86_400_000

const error = (status: number, message: string, extra: Record<string, unknown> = {}) =>
  jsonRes(status, { status: "ERROR", message, ...extra })

const record = (context: OperationContext): Record<string, unknown> => {
  if (
    context.body.kind !== "json" ||
    typeof context.body.value !== "object" ||
    !context.body.value ||
    Array.isArray(context.body.value)
  ) {
    throw new HttpError(400, { status: "ERROR", message: "Request body must be a JSON object" })
  }
  return context.body.value as Record<string, unknown>
}

const isBase64Sha256 = (value: string) => {
  try {
    return fromBase64(value).length === 32
  } catch {
    return false
  }
}

/**
 * Verify AHA partner authentication: HMAC mode (`X-API-KEY`, `X-TIMESTAMP`,
 * `X-SIGNATURE` over `"<apiKey>:<path>:<timestamp>"`) or legacy `X-Geviti-Auth-Key`.
 * Returns an error message, or `undefined` when the request is authentic.
 */
export const verifyAuth = async (
  request: Request,
  path: string,
  settings: Settings,
  wallNow: number,
): Promise<string | undefined> => {
  const apiKey = request.headers.get("x-api-key")
  if (apiKey) {
    const timestamp = request.headers.get("x-timestamp")
    const signature = request.headers.get("x-signature")
    if (!timestamp || !signature) return "Missing X-TIMESTAMP or X-SIGNATURE"
    if (!/^\d{10,16}$/.test(timestamp)) return "X-TIMESTAMP must be epoch milliseconds"
    if (
      settings.timestampToleranceMs > 0 &&
      Math.abs(wallNow - Number(timestamp)) > settings.timestampToleranceMs
    ) {
      return "Request timestamp outside the allowed window"
    }
    const known = settings.credentials.find((c) => c.apiKey === apiKey)
    if (settings.credentials.length > 0 && !known) return "Invalid API key"
    if (known?.apiSecret !== undefined) {
      const expected = await hmac(
        "SHA-256",
        known.apiSecret,
        `${apiKey}:${path}:${timestamp}`,
        "base64",
      )
      return timingSafeEqual(expected, signature) ? undefined : "Invalid signature"
    }
    if (settings.credentials.length > 0) return "API key has no secret; use legacy auth"
    return isBase64Sha256(signature) ? undefined : "Invalid signature"
  }
  const legacy = request.headers.get("x-geviti-auth-key")
  if (legacy) {
    if (!settings.allowLegacy) return "Legacy authentication is disabled"
    if (settings.credentials.length > 0 && !settings.credentials.some((c) => c.apiKey === legacy)) {
      return "Invalid API key"
    }
    return undefined
  }
  return "Missing authentication headers"
}

/** The credential a request carries (`X-API-KEY`, else `X-Geviti-Auth-Key`), for namespaces. */
export const apiKeyCredential = (request: Request): string | undefined =>
  request.headers.get("x-api-key") ?? request.headers.get("x-geviti-auth-key") ?? undefined

/**
 * Stateful mock of the AHA partner API.
 *
 * Orders start `Order Placed` and move only through admin transitions (or `autoSchedule`),
 * each of which emits the webhook AHA would send, with every field our handler reads.
 */
export class AhaAPI implements FetchAPI {
  readonly app: Hono
  readonly sqlite: SqliteClient
  readonly state: AhaState
  private readonly service: Service
  private readonly now: () => number
  private readonly wallClock: () => number
  private readonly onWebhook: ((event: AhaWebhook) => void) | undefined

  constructor(options: AhaAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite)
    const namespace = options.namespace ?? AHA_NAMESPACE
    this.now = options.now ?? (() => Date.now())
    this.wallClock = options.wallClock ?? (() => Date.now())
    this.onWebhook = options.onWebhook
    this.state = new AhaState(sqlite, namespace, options.settings ?? {})
    const handlers = defineOperations<SupportedOperationId>({
      CreateOrder: (context) => this.idempotent(context, () => this.createOrder(context)),
      CancelOrder: (context) => this.idempotent(context, () => this.cancelOrder(context)),
    })
    this.service = createService({
      document,
      handlers,
      sqlite,
      namespace,
      now: this.now,
      notFound: () => error(404, "Not Found"),
      onError: (err) => {
        if (err instanceof HttpError) return err.toResponse()
        throw err
      },
      before: async (context) => {
        this.tick()
        if (faultEffect(context.request, "bad_signature") !== undefined) {
          return error(401, "Invalid signature")
        }
        const problem = await verifyAuth(
          context.request,
          context.url.pathname,
          this.state.current(),
          this.wallClock(),
        )
        return problem === undefined ? undefined : error(401, problem)
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

  /** The success body in the namespace's envelope. */
  private envelope(body: Record<string, unknown>): Response {
    return jsonRes(
      200,
      this.state.current().envelope === "wrapped" ? { success: true, data: body } : body,
    )
  }

  private async idempotent(
    context: OperationContext,
    handler: () => Response | Promise<Response>,
  ): Promise<Response> {
    const key = context.request.headers.get("x-idempotency-key")
    if (!key) return handler()
    const body = context.body.kind === "json" ? context.body.value : null
    return this.state.idempotency.run(
      key,
      requestFingerprint(context.request.method, context.url.pathname, body),
      {
        mismatch: () => error(409, "Idempotency key already used with a different request"),
        conflict: () => error(409, "A request with this idempotency key is still in progress"),
      },
      handler,
    )
  }

  private validate(context: OperationContext): Response | undefined {
    const issues = bodyIssues(context)
    return issues.length > 0
      ? error(400, "Invalid request", { errors: issuesByField(issues) })
      : undefined
  }

  private createOrder(context: OperationContext): Response {
    const body = record(context)
    const invalid = this.validate(context)
    if (invalid) return invalid
    const partnerOrderId = String(body.partner_order_id)
    const zone =
      typeof body.patient_timezone === "string" && isTimeZone(body.patient_timezone)
        ? body.patient_timezone
        : this.state.current().defaultTimeZone
    const preferred =
      typeof body.preferred_schedule_date === "string" &&
      typeof body.preferred_schedule_time === "string"
        ? zonedToEpoch(body.preferred_schedule_date, body.preferred_schedule_time, zone)
        : undefined
    const existing = this.state.orders.get(partnerOrderId)
    const now = this.iso()
    const order: OrderRecord = existing
      ? {
          ...existing,
          timeZone: zone,
          scheduledAt:
            preferred !== undefined ? new Date(preferred).toISOString() : existing.scheduledAt,
          updated_at: now,
        }
      : {
          partner_order_id: partnerOrderId,
          order_number: this.state.nextOrderNumber(),
          status: ORDER_PLACED,
          drawStatus: null,
          scheduledAt: preferred !== undefined ? new Date(preferred).toISOString() : null,
          timeZone: zone,
          cancelled: false,
          created_at: now,
          updated_at: now,
          createdAtMs: this.now(),
          autoScheduled: false,
        }
    this.state.orders.insert(partnerOrderId, order)
    const ids = { partnerOrderId, orderNumber: order.order_number }
    if (faultEffect(context.request, "invalid_response") !== undefined) {
      return annotateResponse(jsonRes(200, { ok: true }), { ids })
    }
    if (faultEffect(context.request, "order_error") !== undefined) {
      return annotateResponse(
        this.envelope({
          content: { partner_order_id: partnerOrderId, order_number: "" },
          message: "Unable to create order: patient address could not be verified",
          status: "ERROR",
        }),
        { ids },
      )
    }
    return annotateResponse(
      this.envelope({
        content: { partner_order_id: partnerOrderId, order_number: order.order_number },
        message: existing ? "Order updated successfully" : "Order created successfully",
        status: "SUCCESS",
      }),
      { ids },
    )
  }

  private cancelOrder(context: OperationContext): Response {
    const body = record(context)
    const invalid = this.validate(context)
    if (invalid) return invalid
    const order = this.state.findOrder(String(body.partner_order_id))
    if (!order) return error(404, `Order ${String(body.partner_order_id)} not found`)
    const ids = { partnerOrderId: order.partner_order_id, orderNumber: order.order_number }
    if (faultEffect(context.request, "invalid_response") !== undefined) {
      return annotateResponse(jsonRes(200, { ok: true }), { ids })
    }
    if (faultEffect(context.request, "order_error") !== undefined || isDrawn(order.drawStatus)) {
      return annotateResponse(
        this.envelope({
          message: `Order ${order.partner_order_id} cannot be cancelled after the sample was collected`,
          status: "ERROR",
        }),
        { ids },
      )
    }
    if (!order.cancelled) {
      if (this.state.current().cancelWebhook) {
        this.transition(order.partner_order_id, { status: "Cancelled" })
      } else {
        this.state.orders.update(order.partner_order_id, {
          ...order,
          status: "Cancelled",
          cancelled: true,
          updated_at: this.iso(),
        })
      }
    }
    return annotateResponse(
      this.envelope({
        message: order.cancelled ? "Order already cancelled" : "Order cancelled successfully",
        status: "SUCCESS",
      }),
      { ids },
    )
  }

  /**
   * Move an order to a vendor status and emit the webhook with every field our handler reads.
   * Throws `RangeError` for a bad zone or appointment time.
   */
  transition(
    id: string,
    input: TransitionInput,
  ): { order: OrderRecord; webhook: AhaWebhook } | undefined {
    const order = this.state.findOrder(id)
    if (!order) return undefined
    const status = orderStatus(input.status)
    const zone = input.timeZone ?? order.timeZone
    if (!isTimeZone(zone))
      throw new RangeError(`timeZone ${JSON.stringify(zone)} is not an IANA zone`)
    const nowMs = this.now()
    const nowLocal = zonedParts(nowMs, zone)
    const draw = status === "Check Out" ? drawStatus(input.drawStatus ?? "Sample Collected") : null
    let scheduledAt = order.scheduledAt
    if (isScheduling(status)) {
      if (input.scheduledAt !== undefined) {
        const parsed =
          typeof input.scheduledAt === "number" ? input.scheduledAt : Date.parse(input.scheduledAt)
        if (!Number.isFinite(parsed)) {
          throw new RangeError(`scheduledAt ${JSON.stringify(input.scheduledAt)} is not a date`)
        }
        scheduledAt = new Date(parsed).toISOString()
      } else if (status === "Rescheduled" && order.scheduledAt) {
        scheduledAt = new Date(Date.parse(order.scheduledAt) + DAY_MS).toISOString()
      } else if (!scheduledAt) {
        scheduledAt = new Date(Math.ceil((nowMs + DAY_MS) / 3_600_000) * 3_600_000).toISOString()
      }
    }
    const webhook: AhaWebhook = {
      status,
      partnerOrderId: order.partner_order_id,
      ahaOrderId: order.order_number,
    }
    if (isScheduling(status) && scheduledAt) {
      const at = zonedParts(Date.parse(scheduledAt), zone)
      Object.assign(webhook, {
        scheduleServiceTime: `${at.date}T${at.timeWithSeconds}`,
        scheduleServiceTimeZone: zone,
        scheduledServiceDate: at.date,
        scheduledServiceTime: at.time,
        scheduledServiceTimeZone: zone,
        scheduleConfirmationDate: nowLocal.date,
        scheduleConfirmationTime: nowLocal.time,
        scheduleConfirmationTimeZone: zone,
      })
    }
    if (status === "Check In") {
      Object.assign(webhook, {
        checkInDate: nowLocal.date,
        checkInTime: nowLocal.time,
        checkInTimeZone: zone,
      })
    }
    if (draw !== null) {
      Object.assign(webhook, {
        drawStatus: draw,
        drawStatusDate: nowLocal.date,
        drawStatusTime: nowLocal.time,
        drawStatusTimeZone: zone,
      })
    }
    if (status === "Lab Testing In Progress") {
      Object.assign(webhook, {
        dropOffDate: nowLocal.date,
        dropOffTime: nowLocal.time,
        dropOffTimeZone: zone,
      })
    }
    const next: OrderRecord = {
      ...order,
      status,
      drawStatus: draw ?? order.drawStatus,
      scheduledAt,
      timeZone: zone,
      cancelled: order.cancelled || status === "Cancelled",
      updated_at: this.iso(),
    }
    this.state.orders.update(order.partner_order_id, next)
    this.onWebhook?.(webhook)
    return { order: next, webhook }
  }

  /**
   * Emit `Scheduled` for every order whose `autoSchedule` delay has passed on the mock clock.
   * Runs before each vendor request, on `POST /__admin/tick`, and from the served ticker.
   */
  tick(): number {
    const plan = this.state.current().autoSchedule
    if (!plan) return 0
    let applied = 0
    for (const { value: order } of this.state.orders.list({ order: "oldest" })) {
      if (order.autoScheduled || order.cancelled || order.status !== ORDER_PLACED) continue
      if (this.now() < order.createdAtMs + plan.afterMs) continue
      this.state.orders.update(order.partner_order_id, { ...order, autoScheduled: true })
      this.transition(order.partner_order_id, {
        status: "Scheduled",
        ...(order.scheduledAt ? {} : { scheduledAt: order.createdAtMs + (plan.leadMs ?? DAY_MS) }),
      })
      applied++
    }
    return applied
  }

  orders(): OrderRecord[] {
    return this.state.orders.list({ order: "oldest" }).map((row) => row.value)
  }
}

export type { AhaRuntime, AhaRuntimeOptions } from "./runtime.js"
export { AHA_PRESETS, createRuntime, WEBHOOK_PATH } from "./runtime.js"
