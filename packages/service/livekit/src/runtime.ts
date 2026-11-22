import {
  type AdminRoutes,
  type Clock,
  createWebhookHub,
  type FaultPreset,
  type MockControls,
  type RequestLog,
  type ServiceRuntime,
  createRuntime as serviceRuntime,
  signers,
  type WebhookEndpoint,
  type WebhookHub,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { bodySha256, jwt } from "./crypto.js"
import { document } from "./generated/openapi.js"
import { LIVEKIT_NAMESPACE, LiveKitAPI } from "./index.js"
import { signalControls } from "./signal-controls.js"
import { JOB_STATUSES, type JobStatus, type LiveKitTrack } from "./state.js"

export const LIVEKIT_PRESETS: Record<string, FaultPreset> = {
  network_loss: {
    description:
      "Drop active signaling sockets in this namespace; clients may resume the retained peers within ten seconds",
    rules: [],
  },
  unavailable: { description: "The next request loses its connection", rules: [{ drop: true }] },
  rate_limited: {
    description: "LiveKit answers resource_exhausted",
    rules: [
      {
        status: 429,
        body: { code: "resource_exhausted", msg: "rate limit exceeded", meta: {} },
        headers: { "content-type": "application/json" },
      },
    ],
  },
  webhook_duplicate: {
    description: "The next webhook is delivered twice",
    webhook: { mode: "duplicate" },
  },
  webhook_reorder: {
    description: "The next two webhooks arrive swapped",
    webhook: { mode: "reorder" },
  },
  webhook_drop: { description: "The next webhook is dropped", webhook: { mode: "drop" } },
}
export type LiveKitRuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  seed?: number | string
  adminPrefix?: string
  adminKey?: string
  /** Admin controls to boot with: clock, latency, faults, seed, a starting snapshot. */
  adminControls?: MockControls
  onLog?: (entry: RequestLog) => void
  keys?: Readonly<Record<string, string>>
  webhooks?: {
    endpoints?: WebhookEndpoint[]
    retryDelaysMs?: readonly number[]
    fetch?: (request: Request) => Promise<Response>
  }
}
export type LiveKitRuntime = ServiceRuntime<LiveKitAPI> & { readonly webhooks: WebhookHub }
const error = (status: number, message: string) =>
  Response.json({ error: { type: "mockingbird_admin", message } }, { status })
const admin = (runtime: ServiceRuntime<LiveKitAPI>): AdminRoutes => ({
  ...signalControls(runtime),
  "POST /faults/presets/network_loss": ({ namespace }) => {
    runtime.applyPreset("network_loss", namespace)
    return Response.json({ preset: "network_loss", rules: [] }, { status: 201 })
  },
  "GET /signal/connections": ({ namespace }) =>
    Response.json({
      connections: runtime
        .instance(namespace)
        .state.connections.list({ order: "oldest" })
        .map(({ value }) => value),
    }),
  "POST /signal/disconnect": ({ namespace, body }) => {
    const input = body as { room?: string; identity?: string } | null
    if (
      !input ||
      typeof input.room !== "string" ||
      (input.identity !== undefined && typeof input.identity !== "string")
    )
      return error(400, "room and optional identity must be strings")
    runtime.instance(namespace).disconnectSignal(input.room, input.identity)
    return Response.json({ disconnected: true })
  },
  "POST /dispatches/:id/jobs": ({ namespace, params, body }) => {
    if (!body || typeof body !== "object" || Array.isArray(body))
      return error(400, "expected a JSON object")
    const input = body as Record<string, unknown>
    if (input.status !== undefined && !JOB_STATUSES.includes(input.status as JobStatus))
      return error(400, "invalid job status")
    for (const key of ["workerId", "agentId", "participantIdentity", "error"])
      if (input[key] !== undefined && typeof input[key] !== "string")
        return error(400, `${key} must be a string`)
    const job = runtime.instance(namespace).assignJob(params.id as string, input)
    return job ? Response.json(job) : error(404, "dispatch not found")
  },
  "GET /rooms": ({ namespace }) =>
    Response.json({
      rooms: runtime
        .instance(namespace)
        .state.rooms.list({ order: "oldest" })
        .map(({ value }) => value),
    }),
  "POST /rooms/:room/participants": ({ namespace, params, body }) => {
    const input = body as {
      identity?: unknown
      name?: unknown
      metadata?: unknown
      attributes?: unknown
      permission?: unknown
    } | null
    if (!input || typeof input.identity !== "string") return error(400, "identity is required")
    const participant = runtime.instance(namespace).join(params.room as string, {
      identity: input.identity,
      ...(typeof input.name === "string" ? { name: input.name } : {}),
      ...(typeof input.metadata === "string" ? { metadata: input.metadata } : {}),
      ...(input.attributes && typeof input.attributes === "object"
        ? { attributes: input.attributes as Record<string, string> }
        : {}),
      ...(input.permission && typeof input.permission === "object"
        ? { permission: input.permission as Record<string, boolean> }
        : {}),
    })
    return participant
      ? Response.json(participant, { status: 201 })
      : error(409, "participant identity already exists")
  },
  "DELETE /rooms/:room/participants/:identity": ({ namespace, params }) =>
    runtime.instance(namespace).remove(params.room as string, params.identity as string)
      ? new Response(null, { status: 204 })
      : error(404, "participant not found"),
  "POST /rooms/:room/participants/:identity/tracks": ({ namespace, params, body }) => {
    const input = body as Partial<LiveKitTrack> | null
    const track = runtime
      .instance(namespace)
      .publish(params.room as string, params.identity as string, input ?? {})
    return track ? Response.json(track, { status: 201 }) : error(404, "participant not found")
  },
  "GET /rooms/:room/participants/:identity/media": ({ namespace, params }) =>
    Response.json({
      tracks: runtime
        .instance(namespace)
        .state.media.list({
          where: (row) => row.room === params.room && row.identity === params.identity,
        })
        .map(({ value }) => value),
    }),
  "GET /rooms/:room/participants/:identity/inbox": ({ namespace, params }) => {
    const participant = runtime
      .instance(namespace)
      .state.participants.get(
        runtime
          .instance(namespace)
          .state.participantId(params.room as string, params.identity as string),
      )
    return participant
      ? Response.json({
          messages: runtime
            .instance(namespace)
            .state.inbox.list({
              order: "oldest",
              where: (message) => message.participantSid === participant.sid,
            })
            .map(({ value }) => value),
        })
      : error(404, "participant not found")
  },
  "GET /resources": ({ namespace }) =>
    Response.json({
      resources: runtime
        .instance(namespace)
        .state.resources.list({ order: "oldest" })
        .map(({ value }) => value),
    }),
  "POST /resources/:id/transition": ({ namespace, params, body }) => {
    const input = body as { status?: unknown; error?: unknown } | null
    const api = runtime.instance(namespace)
    const current = api.state.resources.get(params.id as string)
    if (!current || !input || typeof input.status !== "string")
      return error(current ? 400 : 404, current ? "status is required" : "resource not found")
    const next = api.transitionResource(
      current.id,
      input.status,
      typeof input.error === "string" ? input.error : undefined,
    )
    return Response.json(next)
  },
})
export const createRuntime = (options: LiveKitRuntimeOptions = {}): LiveKitRuntime => {
  const keys = options.keys ?? { fixture: "fixture-secret-that-is-at-least-32-chars" }
  const [apiKey, apiSecret] = Object.entries(keys)[0] ?? [
    "fixture",
    "fixture-secret-that-is-at-least-32-chars",
  ]
  const hub = createWebhookHub({
    signer: signers.custom(async ({ body, timestampSeconds }) => ({
      Authorization: await jwt(apiSecret, {
        iss: apiKey,
        nbf: timestampSeconds,
        exp: timestampSeconds + 600,
        sha256: await bodySha256(body),
      }),
    })),
    endpoints: options.webhooks?.endpoints ?? [],
    ...(options.webhooks?.retryDelaysMs ? { retryDelaysMs: options.webhooks.retryDelaysMs } : {}),
    ...(options.webhooks?.fetch ? { fetch: options.webhooks.fetch } : {}),
  })
  const runtime = serviceRuntime({
    name: LIVEKIT_NAMESPACE,
    document,
    presets: LIVEKIT_PRESETS,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminPrefix !== undefined ? { adminPrefix: options.adminPrefix } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.adminControls !== undefined ? { adminControls: options.adminControls } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    create: ({ sqlite, namespace, clock }) =>
      new LiveKitAPI({
        sqlite,
        namespace,
        now: clock.now,
        keys,
        onEvent: (event) => hub.publish({ namespace, type: event.event, body: event }),
      }),
    admin,
  })
  const applyPreset = runtime.applyPreset.bind(runtime)
  runtime.applyPreset = (name, namespace = "default", overrides = {}) => {
    const rules = applyPreset(name, namespace, overrides)
    if (name === "network_loss") runtime.instance(namespace).disconnectSignal()
    return rules
  }
  return Object.assign(runtime, { webhooks: hub })
}
