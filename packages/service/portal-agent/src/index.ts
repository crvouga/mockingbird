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
  HttpError,
  jsonRes,
  type OperationContext,
  opaqueToken,
  type Service,
  stableStringify,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { Hono } from "hono"
import type { PortalAgentCallback } from "./callback.js"
import { document, type SupportedOperationId } from "./generated/openapi.js"
import {
  type CallbackStatus,
  type JobRecord,
  type JobResponseBody,
  type JobStatus,
  PortalAgentState,
  type RespondWith,
  type Settings,
} from "./state.js"

export type { FetchAPI } from "@crvouga/mockingbird-core"
export type { SqliteClient } from "@crvouga/mockingbird-sqlite"
export type { PortalAgentCallback } from "./callback.js"
export {
  CALLBACK_FULFILLMENT_STATUSES,
  CALLBACK_PHARMACY_IDS,
  CALLBACK_STATUSES,
  callbackIssues,
} from "./callback.js"
export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export type {
  CallbackFulfillmentStatus,
  CallbackStatus,
  JobRecord,
  JobResponseBody,
  JobStatus,
  RespondWith,
  Settings,
} from "./state.js"

export const PORTAL_AGENT_NAMESPACE = "portal-agent"

export type PortalAgentAPIOptions = APIOptions & {
  /** Initial per-namespace settings (accepted API keys, synchronous outcome). */
  settings?: Partial<Settings>
  /** Called for every completed job; the runtime delivers it with `x-internal-key`. */
  onCallback?: (callback: PortalAgentCallback) => void
}

/** What `POST /__admin/jobs/:id/complete` takes: the outcome and any fields to report. */
export type CompleteInput = Partial<Omit<PortalAgentCallback, "status" | "paymentId">> & {
  status: CallbackStatus
  [key: string]: unknown
}

const errorBody = (errorCode: string, errorDetail: string): JobResponseBody => ({
  status: "error",
  errorCode,
  errorDetail,
  message: errorDetail,
})

const record = (context: OperationContext): Record<string, unknown> => {
  if (
    context.body.kind !== "json" ||
    typeof context.body.value !== "object" ||
    !context.body.value ||
    Array.isArray(context.body.value)
  ) {
    throw new HttpError(
      400,
      errorBody("invalid_payload", "The request body must be a JSON object."),
    )
  }
  return context.body.value as Record<string, unknown>
}

/** Synchronous outcomes a preset can force (`effect` name → status). */
const RESPOND_EFFECTS: Record<string, CallbackStatus> = {
  respond_submitted: "submitted",
  respond_draft_ready: "draft_ready",
  respond_needs_review: "needs_review",
  respond_error: "error",
}

/**
 * Stateful mock of our portal agent (the LifeFile / VPI browser runner).
 *
 * A job is accepted (or answered synchronously per settings/presets) and stored as metadata
 * only; `complete()` (the admin route) produces the callback the agent would post back.
 */
export class PortalAgentAPI implements FetchAPI {
  readonly app: Hono
  readonly sqlite: SqliteClient
  readonly state: PortalAgentState
  private readonly service: Service
  private readonly now: () => number
  private readonly onCallback: ((callback: PortalAgentCallback) => void) | undefined

  constructor(options: PortalAgentAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite)
    const namespace = options.namespace ?? PORTAL_AGENT_NAMESPACE
    this.now = options.now ?? (() => Date.now())
    this.onCallback = options.onCallback
    this.state = new PortalAgentState(sqlite, namespace, { settings: options.settings ?? {} })
    const handlers = defineOperations<SupportedOperationId>({
      CreatePortalFulfillmentJob: (context) => this.createJob(context),
    })
    this.service = createService({
      document,
      handlers,
      sqlite,
      namespace,
      now: this.now,
      notFound: () => jsonRes(404, errorBody("not_found", "Not Found")),
      onError: (error) => {
        if (error instanceof HttpError) return error.toResponse()
        throw error
      },
      before: (context) => {
        const token = bearerToken(context.request)
        const keys = this.state.current().apiKeys
        if (!token || (keys.length > 0 && !keys.includes(token))) {
          return jsonRes(401, {
            status: "error",
            errorCode: "unauthorized",
            message: "Missing or invalid bearer token",
          })
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

  private createJob(context: OperationContext): Response {
    const body = record(context)
    const issues = bodyIssues(context)
    if (issues.length > 0) {
      return jsonRes(
        400,
        errorBody(
          "invalid_payload",
          issues.map((issue) => `${issue.path || "<root>"}: ${issue.message}`).join("; "),
        ),
      )
    }
    const key = String(body.idempotencyKey)
    const fingerprint = opaqueToken(stableStringify(body), 24)
    const existing = this.state.byIdempotencyKey(key)
    if (existing) {
      const ids = { jobId: existing.agentJobId, paymentId: existing.paymentId }
      if (existing.fingerprint !== fingerprint) {
        return annotateResponse(
          jsonRes(
            409,
            errorBody(
              "idempotency_key_reused",
              `idempotencyKey ${key} was already used with a different payload`,
            ),
          ),
          { ids },
        )
      }
      const replay = jsonRes(existing.httpStatus, existing.response)
      replay.headers.set("idempotent-replayed", "true")
      return annotateResponse(replay, { ids })
    }

    const agentJobId = this.state.nextId("job_")
    const [httpStatus, response] = this.syncResponse(context.request, agentJobId)
    const now = this.iso()
    const job: JobRecord = {
      agentJobId,
      idempotencyKey: key,
      fingerprint,
      paymentId: String(body.paymentId),
      prescriptionOrderItemId:
        typeof body.prescriptionOrderItemId === "string" ? body.prescriptionOrderItemId : null,
      pharmacyId: String(body.pharmacyId),
      allowSubmit: body.allowSubmit === true,
      stageForProviderSignature: body.stageForProviderSignature === true,
      status: response.status,
      response,
      httpStatus,
      portalOrderId: response.portalOrderId ?? null,
      portalDraftOrderId: response.portalDraftOrderId ?? null,
      confirmationNumber: response.confirmationNumber ?? null,
      callbacks: 0,
      created_at: now,
      updated_at: now,
    }
    this.state.jobs.insert(agentJobId, job)
    return annotateResponse(jsonRes(httpStatus, response), {
      ids: { jobId: agentJobId, paymentId: job.paymentId },
    })
  }

  /** The synchronous answer: presets first, then `settings.respondWith`, else `accepted`. */
  private syncResponse(request: Request, agentJobId: string): [number, JobResponseBody] {
    if (faultEffect(request, "accepted_without_job_id") !== undefined) {
      return [202, { status: "accepted" }]
    }
    if (faultEffect(request, "submitted_without_order_id") !== undefined) {
      return [200, { status: "submitted" }]
    }
    if (faultEffect(request, "draft_ready_without_draft_id") !== undefined) {
      return [200, { status: "draft_ready", agentJobId }]
    }
    if (faultEffect(request, "non_string_field") !== undefined) {
      // A number where our parser requires a string: the whole response is rejected.
      return [202, { status: "accepted", agentJobId, submittedAt: this.now() as never }]
    }
    let respond: RespondWith | null = this.state.current().respondWith
    for (const [effect, status] of Object.entries(RESPOND_EFFECTS)) {
      const params = faultEffect(request, effect)
      if (params !== undefined) respond = { ...(params as Partial<RespondWith>), status }
    }
    if (!respond) return [202, { status: "accepted", agentJobId, message: "Job accepted" }]
    return [200, this.outcome(respond, agentJobId)]
  }

  private outcome(respond: RespondWith, agentJobId: string): JobResponseBody {
    const message = respond.message !== undefined ? { message: respond.message } : {}
    switch (respond.status) {
      case "submitted":
        return {
          status: "submitted",
          agentJobId,
          portalOrderId: this.portalOrderId(agentJobId),
          confirmationNumber: this.confirmationNumber(agentJobId),
          submittedAt: this.iso(),
          ...message,
        }
      case "draft_ready":
        return {
          status: "draft_ready",
          agentJobId,
          portalDraftOrderId: this.portalDraftOrderId(agentJobId),
          ...message,
        }
      case "needs_review":
        return {
          status: "needs_review",
          agentJobId,
          needsReviewReason: respond.needsReviewReason ?? "Portal product could not be matched",
          ...message,
        }
      default:
        return {
          status: "error",
          agentJobId,
          errorCode: respond.errorCode ?? "portal_error",
          errorDetail: respond.errorDetail ?? "The pharmacy portal rejected the order",
          ...message,
        }
    }
  }

  private portalOrderId(agentJobId: string) {
    return `LF-${opaqueToken(`order:${agentJobId}`, 10).toUpperCase()}`
  }
  private confirmationNumber(agentJobId: string) {
    return `CONF-${opaqueToken(`confirmation:${agentJobId}`, 8).toUpperCase()}`
  }
  private portalDraftOrderId(agentJobId: string) {
    return `DRAFT-${opaqueToken(`draft:${agentJobId}`, 10).toUpperCase()}`
  }

  /** The callback a completed job produces (not yet validated or sent). */
  buildCallback(job: JobRecord, input: CompleteInput): PortalAgentCallback {
    const defaults: Partial<PortalAgentCallback> =
      input.status === "submitted"
        ? {
            portalOrderId: job.portalOrderId ?? this.portalOrderId(job.agentJobId),
            confirmationNumber: job.confirmationNumber ?? this.confirmationNumber(job.agentJobId),
            submittedAt: this.iso(),
          }
        : input.status === "draft_ready"
          ? {
              portalDraftOrderId: job.portalDraftOrderId ?? this.portalDraftOrderId(job.agentJobId),
            }
          : input.status === "needs_review"
            ? { needsReviewReason: "Portal product could not be matched" }
            : { errorCode: "portal_error", errorDetail: "The pharmacy portal rejected the order" }
    return {
      status: input.status,
      paymentId: job.paymentId,
      prescriptionOrderItemId: job.prescriptionOrderItemId,
      pharmacyId: job.pharmacyId,
      agentJobId: job.agentJobId,
      ...defaults,
      ...(input as Partial<PortalAgentCallback>),
    }
  }

  /** Record the outcome on the job and emit the callback. */
  complete(id: string, callback: PortalAgentCallback): JobRecord | undefined {
    const job = this.state.jobs.get(id)
    if (!job) return undefined
    const text = (value: unknown, fallback: string | null) =>
      typeof value === "string" ? value : fallback
    const next: JobRecord = {
      ...job,
      status: callback.status as JobStatus,
      portalOrderId: text(callback.portalOrderId, job.portalOrderId),
      portalDraftOrderId: text(callback.portalDraftOrderId, job.portalDraftOrderId),
      confirmationNumber: text(callback.confirmationNumber, job.confirmationNumber),
      callbacks: job.callbacks + 1,
      updated_at: this.iso(),
    }
    this.state.jobs.update(id, next)
    this.onCallback?.(callback)
    return next
  }

  jobs(): JobRecord[] {
    return this.state.jobs.list({ order: "oldest" }).map((row) => row.value)
  }
}

export type { PortalAgentRuntime, PortalAgentRuntimeOptions } from "./runtime.js"
export { CALLBACK_KEY_HEADER, createRuntime, PORTAL_AGENT_PRESETS } from "./runtime.js"
