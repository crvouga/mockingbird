import {
  type AdminRoutes,
  bearerToken,
  type Clock,
  createRuntime as createServiceRuntime,
  createWebhookHub,
  type FaultPreset,
  type RequestLog,
  type ServiceRuntime,
  signers,
  type WebhookEndpoint,
  type WebhookHub,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { CALLBACK_STATUSES, callbackIssues } from "./callback.js"
import { document } from "./generated/openapi.js"
import { type CompleteInput, PORTAL_AGENT_NAMESPACE, PortalAgentAPI } from "./index.js"
import type { CallbackStatus, RespondWith, Settings } from "./state.js"

/** Header our receiver compares to `ERX_PORTAL_AGENT_CALLBACK_KEY` (plain equality). */
export const CALLBACK_KEY_HEADER = "x-internal-key"

const JOBS = "CreatePortalFulfillmentJob"

/**
 * Every named portal-agent behaviour our consumer branches on, switched on with
 * `POST /__admin/faults {"preset": "<name>"}` (add `count` to limit it).
 */
export const PORTAL_AGENT_PRESETS: Record<string, FaultPreset> = {
  respond_submitted: {
    description:
      "The job answers synchronously: submitted, with portalOrderId and confirmationNumber",
    rules: [{ operationId: JOBS, effect: "respond_submitted" }],
  },
  respond_draft_ready: {
    description: "The job answers synchronously: draft_ready, with portalDraftOrderId",
    rules: [{ operationId: JOBS, effect: "respond_draft_ready" }],
  },
  respond_needs_review: {
    description: "The job answers synchronously: needs_review, with needsReviewReason",
    rules: [{ operationId: JOBS, effect: "respond_needs_review" }],
  },
  respond_error: {
    description: "The job answers synchronously: error, with errorCode and errorDetail",
    rules: [{ operationId: JOBS, effect: "respond_error" }],
  },
  accepted_without_job_id: {
    description: "Answers accepted with no agentJobId (our parser rejects it)",
    rules: [{ operationId: JOBS, effect: "accepted_without_job_id" }],
  },
  submitted_without_order_id: {
    description:
      "Answers submitted with no portalOrderId, confirmationNumber or agentJobId (rejected)",
    rules: [{ operationId: JOBS, effect: "submitted_without_order_id" }],
  },
  draft_ready_without_draft_id: {
    description: "Answers draft_ready with no portalDraftOrderId (rejected)",
    rules: [{ operationId: JOBS, effect: "draft_ready_without_draft_id" }],
  },
  non_string_field: {
    description: "Answers accepted with a numeric submittedAt (any non-string field is rejected)",
    rules: [{ operationId: JOBS, effect: "non_string_field" }],
  },
  http_500: {
    description: "Answers 500 with {status: error, errorDetail} (our client surfaces errorDetail)",
    rules: [
      {
        operationId: JOBS,
        status: 500,
        body: {
          status: "error",
          errorCode: "agent_unavailable",
          errorDetail: "Portal agent browser pool exhausted",
        },
      },
    ],
  },
  timeout: {
    description:
      "The job request never answers: the connection drops (our client's network-error branch)",
    rules: [{ operationId: JOBS, drop: true }],
  },
  slow: {
    description:
      "The job answers after 21 s, past our client's 20 s ERX_PORTAL_AGENT_HTTP_TIMEOUT_MS",
    rules: [{ operationId: JOBS, latencyMs: 21_000 }],
  },
  callback_duplicate: {
    description: "The next callback is delivered twice",
    webhook: { mode: "duplicate" },
  },
  callback_reorder: {
    description: "The next two callbacks arrive swapped",
    webhook: { mode: "reorder" },
  },
  callback_drop: {
    description: "The next callback is never delivered (our backend's callback timeout path)",
    webhook: { mode: "drop" },
  },
}

export type PortalAgentRuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  seed?: number | string
  adminKey?: string
  onLog?: (entry: RequestLog) => void
  settings?: Partial<Settings>
  /**
   * Where callbacks go (`POST /prescriptions/webhooks/portal-agent`), sent with
   * `x-internal-key: <secret>` (the app's `ERX_PORTAL_AGENT_CALLBACK_KEY`).
   */
  webhooks?: Omit<WebhookEndpoint, "id"> & {
    retryDelaysMs?: readonly number[]
    fetch?: (request: Request) => Promise<Response>
  }
}

export type PortalAgentRuntime = ServiceRuntime<PortalAgentAPI> & {
  readonly webhooks: WebhookHub
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const adminError = (status: number, message: string) =>
  json(status, { error: { type: "mockingbird_admin", message } })
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const parseRespondWith = (value: unknown): RespondWith | null | string => {
  if (value === null) return null
  if (!isRecord(value) || !CALLBACK_STATUSES.includes(value.status as CallbackStatus)) {
    return `respondWith must be null or {status: ${CALLBACK_STATUSES.join("|")}, …}`
  }
  const out: RespondWith = { status: value.status as CallbackStatus }
  for (const key of ["message", "needsReviewReason", "errorCode", "errorDetail"] as const) {
    if (typeof value[key] === "string") out[key] = value[key] as string
  }
  return out
}

const adminRoutes = (runtime: ServiceRuntime<PortalAgentAPI>): AdminRoutes => ({
  "GET /jobs": ({ namespace }) => json(200, { jobs: runtime.instance(namespace).jobs() }),
  "GET /jobs/:id": ({ params, namespace }) => {
    const job = runtime.instance(namespace).state.jobs.get(params.id as string)
    return job ? json(200, job) : adminError(404, `no job ${params.id}`)
  },
  "POST /jobs/:id/complete": ({ params, body, namespace, url }) => {
    if (!isRecord(body) || typeof body.status !== "string") {
      return adminError(
        400,
        `expected {"status": "${CALLBACK_STATUSES.join('" | "')}", "fulfillmentStatus"?, …}`,
      )
    }
    const api = runtime.instance(namespace)
    const job = api.state.jobs.get(params.id as string)
    if (!job) return adminError(404, `no job ${params.id}`)
    const callback = api.buildCallback(job, body as CompleteInput)
    const force = url.searchParams.get("force") === "1"
    const issues = callbackIssues(callback)
    if (issues.length > 0 && !force) {
      return adminError(
        400,
        `our receiver would reject this callback: ${issues.join("; ")} (add ?force=1 to send it anyway)`,
      )
    }
    const updated = api.complete(job.agentJobId, callback)
    return json(200, { job: updated, callback })
  },
  "GET /settings": ({ namespace }) => json(200, runtime.instance(namespace).state.current()),
  "PUT /settings": ({ body, namespace }) => {
    if (!isRecord(body)) return adminError(400, "expected a JSON object")
    const patch: Partial<Settings> = {}
    if (body.apiKeys !== undefined) {
      if (!Array.isArray(body.apiKeys)) return adminError(400, "apiKeys: string[]")
      patch.apiKeys = body.apiKeys.map(String)
    }
    if (body.respondWith !== undefined) {
      const parsed = parseRespondWith(body.respondWith)
      if (typeof parsed === "string") return adminError(400, parsed)
      patch.respondWith = parsed
    }
    return json(200, runtime.instance(namespace).state.update(patch))
  },
})

/**
 * The portal-agent mock with Mockingbird's full service contract: `/health`, `/__admin/*`,
 * namespaces by header, by `/ns/<name>` path prefix, or by bearer key
 * (`PUT /__admin/credentials {"credentials": {"<ERX_PORTAL_AGENT_API_KEY>": "<namespace>"}}`),
 * clock control, fault presets, callbacks with `x-internal-key`, and a request journal.
 */
export const createRuntime = (options: PortalAgentRuntimeOptions = {}): PortalAgentRuntime => {
  const { retryDelaysMs, fetch: send, ...endpoint } = options.webhooks ?? { url: "" }
  const hub = createWebhookHub({
    signer: signers.header(CALLBACK_KEY_HEADER),
    ...(retryDelaysMs ? { retryDelaysMs } : {}),
    ...(send ? { fetch: send } : {}),
    endpoints: options.webhooks ? [endpoint as WebhookEndpoint] : [],
  })
  const runtime = createServiceRuntime<PortalAgentAPI>({
    name: PORTAL_AGENT_NAMESPACE,
    document,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    credential: bearerToken,
    presets: PORTAL_AGENT_PRESETS,
    webhooks: hub,
    create: ({ sqlite, namespace, publicNamespace, clock }) =>
      new PortalAgentAPI({
        sqlite,
        namespace,
        now: clock.now,
        ...(options.settings ? { settings: options.settings } : {}),
        onCallback: (callback) => {
          const job = String(callback.agentJobId ?? callback.paymentId)
          hub.publish({
            namespace: publicNamespace,
            type: `portal_agent.${callback.status}`,
            body: callback as unknown as Record<string, unknown>,
            id: `${job}:${hub.messages(publicNamespace).length + 1}`,
          })
        },
      }),
    describe: () => ({ callbacks: hub.endpoints("default").length > 0 ? "on" : "off" }),
    admin: adminRoutes,
  })
  return Object.assign(runtime, { webhooks: hub })
}
