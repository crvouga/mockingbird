import {
  type AdminRoutes,
  type Clock,
  createWebhookHub,
  type FaultPreset,
  type RequestLog,
  type S3Target,
  type ServiceRuntime,
  createRuntime as serviceRuntime,
  signers,
  type WebhookEndpoint,
  type WebhookHub,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { document } from "./generated/openapi.js"
import { accessKeyCredential, MEDIACONVERT_NAMESPACE, MediaConvertAPI } from "./index.js"
import type { MediaConvertJobStatus } from "./state.js"

export const MEDIACONVERT_PRESETS: Record<string, FaultPreset> = {
  too_many_requests: {
    description: "MediaConvert answers TooManyRequestsException",
    rules: [
      {
        status: 429,
        body: { __type: "TooManyRequestsException", message: "Rate exceeded" },
        headers: { "content-type": "application/json" },
      },
    ],
  },
  internal_error: {
    description: "MediaConvert answers InternalServerErrorException",
    rules: [
      {
        status: 500,
        body: { __type: "InternalServerErrorException", message: "Internal service error" },
        headers: { "content-type": "application/json" },
      },
    ],
  },
  unavailable: { description: "The next request loses its connection", rules: [{ drop: true }] },
}
export type MediaConvertRuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  seed?: number | string
  adminKey?: string
  onLog?: (entry: RequestLog) => void
  region?: string
  accountId?: string
  endpoint?: string
  s3?: Omit<S3Target, "bucket">
  webhooks?: {
    endpoints?: WebhookEndpoint[]
    retryDelaysMs?: readonly number[]
    fetch?: (request: Request) => Promise<Response>
  }
}
export type MediaConvertRuntime = ServiceRuntime<MediaConvertAPI> & {
  readonly webhooks: WebhookHub
}
const problem = (status: number, message: string) =>
  Response.json({ error: { type: "mockingbird_admin", message } }, { status })
const admin = (runtime: ServiceRuntime<MediaConvertAPI>): AdminRoutes => ({
  "GET /jobs": ({ namespace }) =>
    Response.json({
      jobs: runtime
        .instance(namespace)
        .state.jobs.list({ order: "oldest" })
        .map(({ value }) => value),
    }),
  "GET /jobs/:id": ({ namespace, params }) => {
    const job = runtime.instance(namespace).state.jobs.get(params.id as string)
    return job ? Response.json(job) : problem(404, "job not found")
  },
  "POST /jobs/:id/transition": async ({ namespace, params, body }) => {
    const input = body as {
      status?: unknown
      progress?: unknown
      durationInMs?: unknown
      size?: unknown
      names?: unknown
      errorCode?: unknown
      errorMessage?: unknown
    } | null
    const allowed = new Set<MediaConvertJobStatus>(["PROGRESSING", "COMPLETE", "ERROR", "CANCELED"])
    if (
      !input ||
      typeof input.status !== "string" ||
      !allowed.has(input.status as MediaConvertJobStatus)
    )
      return problem(400, "a supported status is required")
    const moved = await runtime
      .instance(namespace)
      .transition(params.id as string, input.status as MediaConvertJobStatus, {
        ...(typeof input.progress === "number" ? { progress: input.progress } : {}),
        ...(typeof input.durationInMs === "number" ? { durationInMs: input.durationInMs } : {}),
        ...(typeof input.size === "number" ? { size: input.size } : {}),
        ...(Array.isArray(input.names) && input.names.every((name) => typeof name === "string")
          ? { names: input.names as string[] }
          : {}),
        ...(typeof input.errorCode === "number" ? { errorCode: input.errorCode } : {}),
        ...(typeof input.errorMessage === "string" ? { errorMessage: input.errorMessage } : {}),
      })
    return moved ? Response.json(moved) : problem(409, "job not found or already terminal")
  },
})
export const createRuntime = (options: MediaConvertRuntimeOptions = {}): MediaConvertRuntime => {
  const hub = createWebhookHub({
    signer: signers.none(),
    endpoints: options.webhooks?.endpoints ?? [],
    ...(options.webhooks?.retryDelaysMs ? { retryDelaysMs: options.webhooks.retryDelaysMs } : {}),
    ...(options.webhooks?.fetch ? { fetch: options.webhooks.fetch } : {}),
  })
  const runtime = serviceRuntime({
    name: MEDIACONVERT_NAMESPACE,
    document,
    presets: MEDIACONVERT_PRESETS,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    credential: accessKeyCredential,
    create: ({ sqlite, namespace, clock }) =>
      new MediaConvertAPI({
        sqlite,
        namespace,
        now: clock.now,
        ...(options.region ? { region: options.region } : {}),
        ...(options.accountId ? { accountId: options.accountId } : {}),
        ...(options.endpoint ? { endpoint: options.endpoint } : {}),
        ...(options.s3 ? { s3: options.s3 } : {}),
        onEvent: (event) =>
          hub.publish({
            namespace,
            type: `mediaconvert:${String(event.detail.status).toLowerCase()}`,
            body: event,
          }),
      }),
    admin,
  })
  return Object.assign(runtime, { webhooks: hub })
}
