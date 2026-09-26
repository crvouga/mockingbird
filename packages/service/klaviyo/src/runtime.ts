import {
  type AdminRoutes,
  type Clock,
  createRuntime as createServiceRuntime,
  type FaultPreset,
  outboxAdminRoutes,
  type RequestLog,
  type ServiceRuntime,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { klaviyoApiKey, klaviyoError } from "./errors.js"
import { document } from "./generated/openapi.js"
import { KLAVIYO_NAMESPACE, KlaviyoAPI } from "./index.js"

const error = (status: number, code: string, title: string, detail: string) =>
  klaviyoError({ status, code, title, detail }, `preset:${code}`)

/**
 * Every named Klaviyo misbehaviour, switched on with `POST /__admin/faults {"preset": "<name>"}`
 * (add `count` to limit it). Our consumer reads only `response.ok` and throws the body text,
 * so each one fails the BullMQ job, which then retries.
 */
export const KLAVIYO_PRESETS: Record<string, FaultPreset> = {
  throttled: {
    description: "Every call answers 429 throttled with Retry-After: 1",
    rules: [
      {
        status: 429,
        headers: { "retry-after": "1" },
        body: error(
          429,
          "throttled",
          "Request was throttled.",
          "Request was throttled. Expected available in 1 second.",
        ),
      },
    ],
  },
  invalid_api_key: {
    description: "Every call answers 401: the private key is not valid",
    rules: [
      {
        status: 401,
        body: error(
          401,
          "authentication_failed",
          "Incorrect authentication credentials.",
          "Incorrect authentication credentials.",
        ),
      },
    ],
  },
  server_error: {
    description: "Every call answers 500 with a JSON:API error",
    rules: [
      {
        status: 500,
        body: error(500, "error", "A server error occurred.", "A server error occurred."),
      },
    ],
  },
  service_unavailable: {
    description: "Every call answers 503 with a JSON:API error",
    rules: [
      {
        status: 503,
        body: error(
          503,
          "service_unavailable",
          "Service unavailable.",
          "Service temporarily unavailable. Please try again later.",
        ),
      },
    ],
  },
  connection_drop: {
    description: "Event creation drops the connection (the event is not stored)",
    rules: [{ operationId: "CreateEvent", drop: true }],
  },
}

export type KlaviyoRuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  seed?: number | string
  adminKey?: string
  onLog?: (entry: RequestLog) => void
  /** Base URL used in response `links` (default `https://a.klaviyo.com`). */
  baseUrl?: string
}

export type KlaviyoRuntime = ServiceRuntime<KlaviyoAPI>

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const adminRoutes = (runtime: ServiceRuntime<KlaviyoAPI>): AdminRoutes => ({
  ...outboxAdminRoutes(
    runtime,
    (api) => api.state.events,
    (params) => {
      const metric = params.get("metric")
      const uniqueId = params.get("unique_id")
      if (metric === null && uniqueId === null) return undefined
      return (item) =>
        (metric === null || item.metric === metric) &&
        (uniqueId === null || item.uniqueId === uniqueId)
    },
  ),
  "GET /profiles": ({ namespace }) =>
    json(200, {
      profiles: runtime
        .instance(namespace)
        .state.profiles.list({ order: "oldest" })
        .map((row) => row.value),
    }),
})

/**
 * The Klaviyo mock with Mockingbird's full service contract: `/health`, `/__admin/*`,
 * namespaces by header, by `/ns/<name>` path prefix (in `KLAVIYO_URL`), or by private key
 * (`PUT /__admin/credentials {"credentials": {"<KLAVIYO_API_KEY>": "<namespace>"}}`), clock
 * control, fault presets, the event outbox and a request journal.
 */
export const createRuntime = (options: KlaviyoRuntimeOptions = {}): KlaviyoRuntime =>
  createServiceRuntime<KlaviyoAPI>({
    name: KLAVIYO_NAMESPACE,
    document,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    credential: klaviyoApiKey,
    presets: KLAVIYO_PRESETS,
    create: ({ sqlite, namespace, clock }) =>
      new KlaviyoAPI({
        sqlite,
        namespace,
        now: clock.now,
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
      }),
    admin: adminRoutes,
  })
