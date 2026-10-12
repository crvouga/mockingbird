import {
  type AdminRoutes,
  type Clock,
  createRuntime as createServiceRuntime,
  type FaultPreset,
  type MockControls,
  type RequestLog,
  type ServiceRuntime,
} from "@crvouga/mockingbird-service"
import { document } from "./generated/openapi.js"
import { SentryAPI, type SentryAPIOptions, sentryCredential } from "./index.js"
import { createCaptureKey, object } from "./protocol.js"
import type { IssueRecord, SentrySettings } from "./state.js"

const ingestion = ["IngestEnvelope", "StoreEvent", "IngestMinidump"]
export const SENTRY_PRESETS: Record<string, FaultPreset> = {
  rate_limited: {
    description: "Reject ingestion with an error-category 60-second quota and Retry-After",
    rules: ingestion.map((operationId) => ({ operationId, effect: "rate_limited" })),
  },
  server_error: {
    description: "Reject ingestion with a synthetic 503 service-unavailable response",
    rules: ingestion.map((operationId) => ({
      operationId,
      status: 503,
      body: { detail: "project not available" },
    })),
  },
  network_reset: {
    description: "Drop the ingestion connection before any write",
    rules: ingestion.map((operationId) => ({ operationId, drop: true })),
  },
  item_rejected: {
    description: "Reject ingestion with a synthetic filter response before any write",
    rules: ingestion.map((operationId) => ({ operationId, effect: "item_rejected" })),
  },
}
export type SentryRuntimeOptions = Omit<SentryAPIOptions, "now" | "namespace"> & {
  clock?: Clock
  seed?: number | string
  adminKey?: string
  /** Admin controls to boot with: clock, latency, faults, seed, a starting snapshot. */
  adminControls?: MockControls
  onLog?: (entry: RequestLog) => void
}
export type SentryRuntime = ServiceRuntime<SentryAPI>
const bad = (detail: string) =>
  Response.json({ error: { type: "mockingbird_admin", message: detail } }, { status: 400 })
const routes = (runtime: SentryRuntime): AdminRoutes => ({
  "GET /events": ({ namespace, url }) =>
    Response.json({ events: runtime.instance(namespace).captured(url) }),
  "GET /issues": ({ namespace, url }) => {
    const api = runtime.instance(namespace)
    const matching = new Set(api.captured(url).map((e) => e.groupId))
    return Response.json({
      issues: api.state.issues
        .list()
        .filter(({ value }) => matching.has(value.id))
        .map(({ value }) => api.issueWire(value)),
    })
  },
  "GET /envelopes": ({ namespace, url }) =>
    Response.json({
      envelopes: runtime
        .instance(namespace)
        .state.envelopes.list()
        .map(({ value }) => {
          const { raw: _raw, ...metadata } = value
          return metadata
        })
        .filter(
          (e) =>
            !url.searchParams.get("project") || e.projectId === url.searchParams.get("project"),
        ),
    }),
  "GET /settings": ({ namespace }) => Response.json(runtime.instance(namespace).state.current()),
  "PUT /settings": ({ namespace, body }) => {
    const data = object(body)
    const api = runtime.instance(namespace)
    const current = api.state.current()
    const next: SentrySettings = { ...current }
    if (data.grouping !== undefined) {
      if (data.grouping !== "exception" && data.grouping !== "message")
        return bad("grouping must be exception or message")
      next.grouping = data.grouping
    }
    for (const field of ["sensitivePaths", "rejectItems"] as const) {
      if (data[field] !== undefined) {
        if (!Array.isArray(data[field]) || data[field].some((x) => typeof x !== "string"))
          return bad(`${field} must be a string array`)
        next[field] = data[field] as string[]
      }
    }
    api.state.settings.update("current", next)
    return Response.json(next)
  },
  "POST /flush": ({ namespace, body }) => {
    const data = object(body)
    if (
      data.eventIds !== undefined &&
      (!Array.isArray(data.eventIds) || data.eventIds.some((id) => typeof id !== "string"))
    )
      return bad("eventIds must be a string array")
    if (
      data.count !== undefined &&
      (typeof data.count !== "number" || !Number.isSafeInteger(data.count) || data.count < 0)
    )
      return bad("count must be a nonnegative integer")
    const rows = runtime
      .instance(namespace)
      .state.events.list()
      .map(({ value }) => value)
      .filter((e) => data.project === undefined || e.projectId === String(data.project))
    const ids = rows.map((e) => e.event_id)
    return Response.json({
      flushed:
        (!Array.isArray(data.eventIds) || data.eventIds.every((id) => ids.includes(String(id)))) &&
        (data.count === undefined || rows.length >= Number(data.count)),
      count: rows.length,
      eventIds: ids,
    })
  },
  "POST /projects/:id/clear": ({ namespace, params }) => {
    const api = runtime.instance(namespace)
    if (!api.state.projects.has(params.id ?? ""))
      return Response.json(
        { error: { type: "mockingbird_admin", message: "Unknown project" } },
        { status: 404 },
      )
    api.state.clearProject(params.id as string)
    return Response.json({ cleared: true })
  },
  "POST /issues/:id/status": ({ namespace, params, body }) => {
    const api = runtime.instance(namespace)
    const issue = api.state.issues.get(params.id ?? "")
    if (!issue)
      return Response.json(
        { error: { type: "mockingbird_admin", message: "Unknown issue" } },
        { status: 404 },
      )
    const status = object(body).status
    if (status !== "resolved" && status !== "unresolved" && status !== "ignored")
      return bad("Invalid status")
    const updated: IssueRecord = { ...issue, status }
    api.state.issues.update(issue.id, updated)
    return Response.json(api.issueWire(updated))
  },
})
export const createRuntime = (options: SentryRuntimeOptions = {}): SentryRuntime => {
  const captureKey = options.captureKey ?? createCaptureKey()
  return createServiceRuntime({
    name: "sentry",
    document,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminPrefix !== undefined ? { adminPrefix: options.adminPrefix } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.adminControls !== undefined ? { adminControls: options.adminControls } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    create: ({ sqlite, namespace, clock, adminPrefix }) =>
      new SentryAPI({ ...options, sqlite, namespace, now: clock.now, adminPrefix, captureKey }),
    credential: sentryCredential,
    presets: SENTRY_PRESETS,
    admin: routes,
  })
}
