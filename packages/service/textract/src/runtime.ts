import {
  type AdminRoutes,
  type Clock,
  createWebhookHub,
  type FaultPreset,
  type RequestLog,
  type ServiceRuntime,
  createRuntime as serviceRuntime,
  signers,
  type WebhookEndpoint,
  type WebhookHub,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { document } from "./generated/openapi.js"
import { accessKeyCredential, TEXTRACT_NAMESPACE, TextractAPI } from "./index.js"
import type { TextractCorpus, TextractJobStatus } from "./state.js"

export const TEXTRACT_PRESETS: Record<string, FaultPreset> = {
  throttled: {
    description: "Textract answers ThrottlingException",
    rules: [
      {
        status: 400,
        body: { __type: "ThrottlingException", message: "Rate exceeded" },
        headers: { "content-type": "application/x-amz-json-1.1" },
      },
    ],
  },
  throughput_exceeded: {
    description: "Textract answers ProvisionedThroughputExceededException",
    rules: [
      {
        status: 400,
        body: {
          __type: "ProvisionedThroughputExceededException",
          message: "Provisioned throughput exceeded",
        },
        headers: { "content-type": "application/x-amz-json-1.1" },
      },
    ],
  },
  unavailable: { description: "The next request loses its connection", rules: [{ drop: true }] },
}
export type TextractRuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  seed?: number | string
  adminKey?: string
  onLog?: (entry: RequestLog) => void
  corpora?: readonly TextractCorpus[]
  webhooks?: {
    endpoints?: WebhookEndpoint[]
    retryDelaysMs?: readonly number[]
    fetch?: (request: Request) => Promise<Response>
  }
}
export type TextractRuntime = ServiceRuntime<TextractAPI> & { readonly webhooks: WebhookHub }
const problem = (status: number, message: string) =>
  Response.json({ error: { type: "mockingbird_admin", message } }, { status })
const admin = (runtime: ServiceRuntime<TextractAPI>): AdminRoutes => ({
  "GET /corpora": ({ namespace }) =>
    Response.json({
      corpora: runtime
        .instance(namespace)
        .state.corpora.list()
        .map(({ value }) => value),
    }),
  "POST /corpora": ({ namespace, body }) => {
    const input = body as TextractCorpus | null
    if (
      !input ||
      typeof input.bucket !== "string" ||
      typeof input.name !== "string" ||
      !Array.isArray(input.blocks)
    )
      return problem(400, "bucket, name and blocks are required")
    return Response.json(runtime.instance(namespace).putCorpus(input), { status: 201 })
  },
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
  "POST /jobs/:id/transition": ({ namespace, params, body }) => {
    const input = body as { status?: unknown; statusMessage?: unknown } | null
    const allowed = new Set<TextractJobStatus>(["SUCCEEDED", "PARTIAL_SUCCESS", "FAILED"])
    if (
      !input ||
      typeof input.status !== "string" ||
      !allowed.has(input.status as TextractJobStatus)
    )
      return problem(400, "a terminal status is required")
    const moved = runtime
      .instance(namespace)
      .transition(
        params.id as string,
        input.status as Exclude<TextractJobStatus, "IN_PROGRESS">,
        typeof input.statusMessage === "string" ? input.statusMessage : undefined,
      )
    return moved ? Response.json(moved) : problem(409, "job not found or already terminal")
  },
})
export const createRuntime = (options: TextractRuntimeOptions = {}): TextractRuntime => {
  const hub = createWebhookHub({
    signer: signers.none(),
    endpoints: options.webhooks?.endpoints ?? [],
    ...(options.webhooks?.retryDelaysMs ? { retryDelaysMs: options.webhooks.retryDelaysMs } : {}),
    ...(options.webhooks?.fetch ? { fetch: options.webhooks.fetch } : {}),
  })
  const runtime = serviceRuntime({
    name: TEXTRACT_NAMESPACE,
    document,
    presets: TEXTRACT_PRESETS,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    credential: accessKeyCredential,
    create: ({ sqlite, namespace, clock }) =>
      new TextractAPI({
        sqlite,
        namespace,
        now: clock.now,
        ...(options.corpora ? { corpora: options.corpora } : {}),
        onNotification: (event) =>
          hub.publish({ namespace, type: `textract:${event.Status.toLowerCase()}`, body: event }),
      }),
    admin,
  })
  return Object.assign(runtime, { webhooks: hub })
}
