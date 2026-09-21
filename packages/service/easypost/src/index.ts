import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  annotateResponse,
  basicAuth,
  bodyIssues,
  bootSqlite,
  coerce,
  createService,
  defineOperations,
  HttpError,
  jsonRes,
  type OperationContext,
  type Service,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { Hono } from "hono"
import { document, type SupportedOperationId } from "./generated/openapi.js"
import {
  EasyPostState,
  type Settings,
  TEST_TRACKING_CODES,
  TRACKER_STATUSES,
  type TrackerRecord,
  type TrackerStatus,
  type TrackingDetail,
} from "./state.js"

export type { FetchAPI } from "@crvouga/mockingbird-core"
export type { SqliteClient } from "@crvouga/mockingbird-sqlite"
export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export type { Settings, TrackerRecord, TrackerStatus, TrackingDetail } from "./state.js"
export { TEST_TRACKING_CODES, TRACKER_STATUSES } from "./state.js"

export const EASYPOST_NAMESPACE = "easypost"

export type EasyPostAPIOptions = APIOptions & {
  /** Initial per-namespace settings (restrict accepted API keys). */
  settings?: Partial<Settings>
}

/** EasyPost's error envelope: `{error: {code, message, errors}}` (our client reads `error.message`). */
export const easyPostError = (
  status: number,
  code: string,
  message: string,
  errors: { field: string; message: string }[] = [],
) => jsonRes(status, { error: { code, message, errors } })

/** The API key a request carries (`Basic base64(key:)`), how credentials map to namespaces. */
export const apiKeyCredential = (request: Request): string | undefined =>
  basicAuth(request)?.username || undefined

const CARRIER_ALIASES: Record<string, string> = {
  usps: "USPS",
  ups: "UPS",
  fedex: "FedEx",
  dhl: "DHLExpress",
  dhlexpress: "DHLExpress",
}

/** The carrier EasyPost detects from a code's shape (the same patterns our resolver uses). */
export const detectCarrier = (code: string): string => {
  const cleaned = code.trim().toUpperCase()
  if (/^1Z[A-Z0-9]{16}$/.test(cleaned)) return "UPS"
  if (/^(420\d{4,5}\d{20,22}|9[0-9]{21,27}|[A-Z]{2}[0-9]{9}US)$/.test(cleaned)) return "USPS"
  if (/^[0-9]{12,22}$/.test(cleaned)) return "FedEx"
  if (/^[0-9]{10,11}$/.test(cleaned)) return "DHLExpress"
  // Test-mode trackers (including the EZ… codes) report USPS.
  return "USPS"
}

const DEFAULT_DETAIL: Record<TrackerStatus, string> = {
  unknown: "unknown",
  pre_transit: "status_update",
  in_transit: "arrived_at_facility",
  out_for_delivery: "out_for_delivery",
  delivered: "arrived_at_destination",
  available_for_pickup: "arrived_at_pickup_location",
  return_to_sender: "return",
  failure: "unknown",
  cancelled: "cancelled",
  error: "unknown",
}

const MESSAGES: Record<TrackerStatus, string> = {
  unknown: "Status unknown",
  pre_transit: "Pre-Shipment Info Sent to USPS",
  in_transit: "Arrived at USPS Facility",
  out_for_delivery: "Out for Delivery",
  delivered: "Delivered",
  available_for_pickup: "Available for Pickup",
  return_to_sender: "Returned to Sender",
  failure: "Delivery Exception",
  cancelled: "Shipment Cancelled",
  error: "Carrier Error",
}

export type TransitionInput = {
  status: TrackerStatus
  status_detail?: string
  message?: string
  signed_by?: string
}

export const isTrackerStatus = (value: unknown): value is TrackerStatus =>
  typeof value === "string" && (TRACKER_STATUSES as readonly string[]).includes(value)

/**
 * Stateful mock of the EasyPost trackers API.
 *
 * A tracker is created (or re-used, for the same code and carrier) on `POST /v2/trackers`.
 * In test mode EasyPost's documented test codes answer their fixed statuses; any other code
 * starts `unknown` and moves only through admin transitions.
 */
export class EasyPostAPI implements FetchAPI {
  readonly app: Hono
  readonly sqlite: SqliteClient
  readonly state: EasyPostState
  private readonly service: Service
  private readonly now: () => number

  constructor(options: EasyPostAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite)
    const namespace = options.namespace ?? EASYPOST_NAMESPACE
    this.now = options.now ?? (() => Date.now())
    this.state = new EasyPostState(sqlite, namespace, options.settings ?? {})
    const handlers = defineOperations<SupportedOperationId>({
      CreateTracker: (context) => this.createTracker(context),
      ListTrackers: (context) => this.listTrackers(context),
      RetrieveTracker: (context) => {
        const tracker = this.state.trackers.get(context.params.id ?? "")
        if (!tracker) {
          return easyPostError(404, "NOT_FOUND", "The requested resource could not be found.")
        }
        return annotateResponse(jsonRes(200, tracker), { ids: { trackerId: tracker.id } })
      },
    })
    this.service = createService({
      document,
      handlers,
      sqlite,
      namespace,
      now: this.now,
      notFound: () => easyPostError(404, "NOT_FOUND", "The requested resource could not be found."),
      onError: (error) => {
        if (error instanceof HttpError) return error.toResponse()
        throw error
      },
      before: (context) => {
        const key = apiKeyCredential(context.request)
        const message = "We couldn't authenticate you. Please check your API key and try again."
        if (!key) return easyPostError(401, "APIKEY.REQUIRED", message)
        const allowed = this.state.current().apiKeys
        if (allowed.length > 0 && !allowed.includes(key)) {
          return easyPostError(401, "APIKEY.INACTIVE", message)
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
    return new Date(this.now()).toISOString().replace(/\.\d{3}Z$/, "Z")
  }

  private detail(status: TrackerStatus, statusDetail: string, carrier: string): TrackingDetail {
    return {
      object: "TrackingDetail",
      message: MESSAGES[status],
      status,
      status_detail: statusDetail,
      datetime: this.iso(),
      source: carrier,
      tracking_location: {
        object: "TrackingLocation",
        city: status === "unknown" ? null : "SALT LAKE CITY",
        state: status === "unknown" ? null : "UT",
        country: status === "unknown" ? null : "US",
        zip: status === "unknown" ? null : "84101",
      },
    }
  }

  /** Build a new tracker the way EasyPost does on first sight of a code. */
  private build(code: string, carrier: string, mode: "test" | "production"): TrackerRecord {
    const fixed = mode === "test" ? TEST_TRACKING_CODES[code] : undefined
    const status = fixed?.status ?? "unknown"
    const statusDetail = fixed?.status_detail ?? "unknown"
    const id = this.state.nextId()
    const now = this.iso()
    return {
      id,
      object: "Tracker",
      mode,
      tracking_code: code,
      status,
      status_detail: statusDetail,
      carrier,
      signed_by: status === "delivered" ? "John Tester" : null,
      weight: null,
      est_delivery_date: fixed ? now : null,
      shipment_id: null,
      tracking_details: status === "unknown" ? [] : [this.detail(status, statusDetail, carrier)],
      carrier_detail: null,
      public_url: `https://track.easypost.com/${id}`,
      fees: [],
      created_at: now,
      updated_at: now,
    }
  }

  private createTracker(context: OperationContext): Response {
    const media = context.body.kind === "json" ? "application/json" : undefined
    const issues = bodyIssues(context, media ?? "application/x-www-form-urlencoded")
    const body = (
      context.body.kind === "json" || context.body.kind === "form" ? context.body.value : undefined
    ) as { tracker?: { tracking_code?: unknown; carrier?: unknown } } | undefined
    const code = body?.tracker?.tracking_code
    if (typeof code !== "string" || code.trim().length === 0) {
      return easyPostError(422, "PARAMETER.REQUIRED", "Missing required parameter.", [
        { field: "tracker.tracking_code", message: "cannot be blank" },
      ])
    }
    if (issues.length > 0) {
      return easyPostError(
        422,
        "PARAMETER.INVALID",
        "Invalid parameter.",
        issues.map((issue) => ({ field: issue.path || "tracker", message: issue.message })),
      )
    }
    const trackingCode = code.trim()
    const hint = typeof body?.tracker?.carrier === "string" ? body.tracker.carrier : undefined
    const carrier = hint
      ? (CARRIER_ALIASES[hint.toLowerCase()] ?? hint)
      : detectCarrier(trackingCode)
    const key = apiKeyCredential(context.request) ?? ""
    const mode = key.startsWith("EZAK") ? "production" : "test"
    const tracker =
      this.state.existing(trackingCode, carrier) ?? this.build(trackingCode, carrier, mode)
    if (!this.state.trackers.has(tracker.id)) this.state.trackers.insert(tracker.id, tracker)
    return annotateResponse(jsonRes(201, tracker), { ids: { trackerId: tracker.id } })
  }

  private listTrackers(context: OperationContext): Response {
    let size = 20
    if (context.query.page_size !== undefined) {
      const parsed = coerce.integer(context.query.page_size)
      if (!parsed.ok || parsed.value < 1 || parsed.value > 100) {
        return easyPostError(422, "PARAMETER.INVALID", "Invalid parameter.", [
          { field: "page_size", message: "must be an integer between 1 and 100" },
        ])
      }
      size = parsed.value
    }
    const code = typeof context.query.tracking_code === "string" ? context.query.tracking_code : ""
    const carrier = typeof context.query.carrier === "string" ? context.query.carrier : ""
    const rows = this.state.trackers
      .list({
        where: (t) =>
          (code === "" || t.tracking_code === code) && (carrier === "" || t.carrier === carrier),
      })
      .map((row) => row.value)
    return jsonRes(200, { trackers: rows.slice(0, size), has_more: rows.length > size })
  }

  /**
   * Move a tracker (by id or tracking code) to a status, appending a tracking detail. When no
   * tracker exists for the code yet, one is registered first, so the app's next lookup of that
   * code re-uses it and sees the status.
   */
  transition(idOrCode: string, input: TransitionInput, carrierHint?: string): TrackerRecord {
    const existing = this.state.find(idOrCode)
    const base =
      existing ??
      this.build(
        idOrCode,
        carrierHint
          ? (CARRIER_ALIASES[carrierHint.toLowerCase()] ?? carrierHint)
          : detectCarrier(idOrCode),
        "test",
      )
    if (!existing) this.state.trackers.insert(base.id, base)
    const statusDetail = input.status_detail ?? DEFAULT_DETAIL[input.status]
    const detail = this.detail(input.status, statusDetail, base.carrier)
    const next: TrackerRecord = {
      ...base,
      status: input.status,
      status_detail: statusDetail,
      signed_by: input.signed_by ?? (input.status === "delivered" ? "John Tester" : base.signed_by),
      tracking_details: [
        ...base.tracking_details,
        input.message ? { ...detail, message: input.message } : detail,
      ],
      updated_at: this.iso(),
    }
    this.state.trackers.update(base.id, next)
    return next
  }

  trackers(): TrackerRecord[] {
    return this.state.trackers.list({ order: "oldest" }).map((row) => row.value)
  }
}

export type { EasyPostRuntime, EasyPostRuntimeOptions } from "./runtime.js"
export { createRuntime, EASYPOST_PRESETS } from "./runtime.js"
