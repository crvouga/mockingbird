import {
  type AdminRoutes,
  type Clock,
  createRuntime as createServiceRuntime,
  type FaultPreset,
  type MockControls,
  type RequestLog,
  type ServiceRuntime,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { document } from "./generated/openapi.js"
import { accessTokenCredential, META_NAMESPACE, MetaAPI } from "./index.js"
import type { MetaSettings } from "./state.js"

const graphError = (status: number, code: number, message: string, transient = false) => ({
  status,
  body: {
    error: {
      message,
      type: code === 190 ? "OAuthException" : "GraphMethodException",
      code,
      is_transient: transient,
      fbtrace_id: "trace_fault",
    },
  },
})

export const META_PRESETS: Record<string, FaultPreset> = {
  expired_token: {
    description: "Every Graph request answers OAuth code 190 for an expired token",
    rules: [
      {
        pathPrefix: "/v26.0/",
        ...graphError(401, 190, "Error validating access token: Session has expired."),
      },
    ],
  },
  rate_limited: {
    description: "The next Graph request answers the standard transient rate-limit error",
    rules: [
      { pathPrefix: "/v26.0/", ...graphError(429, 4, "Application request limit reached", true) },
    ],
  },
  server_error: {
    description: "The next Graph request answers a transient 500 error",
    rules: [{ pathPrefix: "/v26.0/", ...graphError(500, 1, "An unknown error occurred", true) }],
  },
  partial_event_acceptance: {
    description: "A conversion batch accepts its first event and reports later events as rejected",
    rules: [{ operationId: "PostPixelEvents", effect: "partial_acceptance" }],
  },
  accepted_then_drop: {
    description: "Conversion events persist, then the connection drops (ambiguous write)",
    rules: [{ operationId: "PostPixelEvents", effect: "accepted_then_drop" }],
  },
  slow: {
    description: "Graph requests answer after 5 seconds",
    rules: [{ pathPrefix: "/v26.0/", latencyMs: 5_000 }],
  },
}

export type MetaRuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  seed?: number | string
  adminPrefix?: string
  adminKey?: string
  /** Admin controls to boot with: clock, latency, faults, seed, a starting snapshot. */
  adminControls?: MockControls
  onLog?: (entry: RequestLog) => void
  settings?: Partial<MetaSettings>
}

export type MetaRuntime = ServiceRuntime<MetaAPI>

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const adminRoutes = (runtime: ServiceRuntime<MetaAPI>): AdminRoutes => ({
  "GET /events": ({ namespace }) => json(200, { data: runtime.instance(namespace).events() }),
  "GET /settings": ({ namespace }) => json(200, runtime.instance(namespace).state.current()),
  "PUT /settings": ({ namespace, body }) => {
    if (!isRecord(body))
      return json(400, { error: { type: "mockingbird_admin", message: "expected a JSON object" } })
    const patch: Partial<MetaSettings> = {}
    if (body.accessTokens !== undefined) {
      if (!Array.isArray(body.accessTokens))
        return json(400, {
          error: { type: "mockingbird_admin", message: "accessTokens: string[]" },
        })
      patch.accessTokens = body.accessTokens.map(String)
    }
    if (body.maxEventAgeSeconds !== undefined) {
      if (!Number.isInteger(body.maxEventAgeSeconds) || Number(body.maxEventAgeSeconds) < 0) {
        return json(400, {
          error: { type: "mockingbird_admin", message: "maxEventAgeSeconds: non-negative integer" },
        })
      }
      patch.maxEventAgeSeconds = Number(body.maxEventAgeSeconds)
    }
    return json(200, runtime.instance(namespace).state.update(patch))
  },
})

export const createRuntime = (options: MetaRuntimeOptions = {}): MetaRuntime =>
  createServiceRuntime<MetaAPI>({
    name: META_NAMESPACE,
    document,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminPrefix !== undefined ? { adminPrefix: options.adminPrefix } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.adminControls !== undefined ? { adminControls: options.adminControls } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    credential: accessTokenCredential,
    presets: META_PRESETS,
    create: ({ sqlite, namespace, clock }) =>
      new MetaAPI({
        sqlite,
        namespace,
        now: clock.now,
        ...(options.settings ? { settings: options.settings } : {}),
      }),
    admin: adminRoutes,
  })
