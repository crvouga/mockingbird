import {
  type AdminRoutes,
  type Clock,
  type FaultPreset,
  type RequestLog,
  type ServiceRuntime,
  createRuntime as serviceRuntime,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { document } from "./generated/openapi.js"
import { accessKeyCredential, SQS_NAMESPACE, SqsAPI, type SqsSeedQueue } from "./index.js"

export const SQS_PRESETS: Record<string, FaultPreset> = {
  throttled: {
    description: "SQS answers RequestThrottled",
    rules: [
      {
        status: 400,
        body: { __type: "RequestThrottled", message: "Rate exceeded" },
        headers: { "content-type": "application/x-amz-json-1.0" },
      },
    ],
  },
  unavailable: {
    description: "The next SQS request loses its connection",
    rules: [{ drop: true, count: 1 }],
  },
}
export type SqsRuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  seed?: number | string
  adminKey?: string
  onLog?: (entry: RequestLog) => void
  region?: string
  accountId?: string
  queues?: readonly SqsSeedQueue[]
}
export type SqsRuntime = ServiceRuntime<SqsAPI>

const admin = (runtime: ServiceRuntime<SqsAPI>): AdminRoutes => ({
  "GET /queues": ({ namespace }) =>
    Response.json({
      queues: runtime
        .instance(namespace)
        .state.queues.list()
        .map(({ value }) => ({
          ...value,
          messages: runtime
            .instance(namespace)
            .state.messages.list({ where: (message) => message.queue === value.name }).length,
        })),
    }),
  "GET /messages": ({ namespace, url }) => {
    const queue = url.searchParams.get("queue")
    return Response.json({
      messages: runtime
        .instance(namespace)
        .state.messages.list({ where: (message) => !queue || message.queue === queue })
        .map(({ value }) => value),
    })
  },
  "POST /messages": async ({ namespace, body }) => {
    const input = body as {
      queue?: unknown
      body?: unknown
      messageAttributes?: unknown
      groupId?: unknown
      deduplicationId?: unknown
    } | null
    if (!input || typeof input.queue !== "string" || typeof input.body !== "string")
      return Response.json(
        { error: { type: "mockingbird_admin", message: "queue and body are required" } },
        { status: 400 },
      )
    const api = runtime.instance(namespace)
    const queue = api.state.queues.get(input.queue)
    if (!queue)
      return Response.json(
        { error: { type: "mockingbird_admin", message: "queue not found" } },
        { status: 404 },
      )
    const result = await api.enqueue(queue, {
      MessageBody: input.body,
      ...(typeof input.messageAttributes === "object"
        ? { MessageAttributes: input.messageAttributes }
        : {}),
      ...(typeof input.groupId === "string" ? { MessageGroupId: input.groupId } : {}),
      ...(typeof input.deduplicationId === "string"
        ? { MessageDeduplicationId: input.deduplicationId }
        : {}),
    })
    return Response.json(result, { status: 201 })
  },
  "POST /messages/:id/receive-count": ({ namespace, params, body }) => {
    const api = runtime.instance(namespace)
    const message = api.state.messages.get(params.id as string)
    const count = Number((body as { count?: unknown } | null)?.count)
    if (!message || !Number.isInteger(count) || count < 0)
      return Response.json(
        {
          error: { type: "mockingbird_admin", message: "message and non-negative count required" },
        },
        { status: 400 },
      )
    api.state.messages.insert(message.id, { ...message, receiveCount: count })
    return Response.json({ id: message.id, receiveCount: count })
  },
  "POST /messages/:id/duplicate": ({ namespace, params }) => {
    const api = runtime.instance(namespace)
    const message = api.state.messages.get(params.id as string)
    if (!message)
      return Response.json(
        { error: { type: "mockingbird_admin", message: "message not found" } },
        { status: 404 },
      )
    api.state.messages.insert(message.id, { ...message, visibleAt: runtime.clock.now() })
    return Response.json({ id: message.id, visible: true })
  },
  "POST /queues/:name/drain": ({ namespace, params }) => {
    const api = runtime.instance(namespace)
    const rows = api.state.messages.list({ where: (message) => message.queue === params.name })
    for (const row of rows) api.state.messages.delete(row.id)
    return Response.json({ drained: rows.length })
  },
})

export const createRuntime = (options: SqsRuntimeOptions = {}): SqsRuntime =>
  serviceRuntime({
    name: SQS_NAMESPACE,
    document,
    presets: SQS_PRESETS,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    credential: accessKeyCredential,
    create: ({ sqlite, namespace, clock }) =>
      new SqsAPI({
        sqlite,
        namespace,
        now: clock.now,
        ...(options.region ? { region: options.region } : {}),
        ...(options.accountId ? { accountId: options.accountId } : {}),
        ...(options.queues ? { queues: options.queues } : {}),
      }),
    admin,
  })
