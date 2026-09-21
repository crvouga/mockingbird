import {
  type AdminRoutes,
  type Clock,
  createRuntime as createServiceRuntime,
  type FaultPreset,
  type RequestLog,
  type ServiceRuntime,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { document } from "./generated/openapi.js"
import { apiKeyCredential, EASYPOST_NAMESPACE, EasyPostAPI, isTrackerStatus } from "./index.js"
import type { Settings } from "./state.js"

const errorBody = (code: string, message: string) => ({ error: { code, message, errors: [] } })

/**
 * Every named EasyPost misbehaviour our tracking lookup branches on, switched on with
 * `POST /__admin/faults {"preset": "<name>"}` (add `count` to limit it).
 */
export const EASYPOST_PRESETS: Record<string, FaultPreset> = {
  rate_limited: {
    description: "Trackers answer 429 RATE_LIMITED (our client reports status unknown)",
    rules: [
      {
        pathPrefix: "/v2/trackers",
        status: 429,
        body: errorBody("RATE_LIMITED", "You have exceeded the rate limit for this endpoint."),
      },
    ],
  },
  server_error: {
    description: "Trackers answer 500 INTERNAL_SERVER_ERROR",
    rules: [
      {
        pathPrefix: "/v2/trackers",
        status: 500,
        body: errorBody("INTERNAL_SERVER_ERROR", "Something went wrong on our end."),
      },
    ],
  },
  invalid_api_key: {
    description: "Every call answers 401 APIKEY.INACTIVE, as if EASYPOST_API_KEY were revoked",
    rules: [
      {
        pathPrefix: "/v2/",
        status: 401,
        body: errorBody(
          "APIKEY.INACTIVE",
          "We couldn't authenticate you. Please check your API key and try again.",
        ),
      },
    ],
  },
  gateway_html: {
    description:
      "Trackers answer a 502 HTML page (no JSON: our client falls back to its own message)",
    rules: [
      {
        pathPrefix: "/v2/trackers",
        status: 502,
        body: "<html><body><h1>502 Bad Gateway</h1></body></html>",
        headers: { "content-type": "text/html" },
      },
    ],
  },
  connection_drop: {
    description: "The connection drops before any answer (fetch rejects)",
    rules: [{ pathPrefix: "/v2/trackers", drop: true }],
  },
  slow: {
    description: "Trackers answer after 5 s",
    rules: [{ pathPrefix: "/v2/trackers", latencyMs: 5_000 }],
  },
}

export type EasyPostRuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  seed?: number | string
  adminKey?: string
  onLog?: (entry: RequestLog) => void
  settings?: Partial<Settings>
}

export type EasyPostRuntime = ServiceRuntime<EasyPostAPI>

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const adminError = (status: number, message: string) =>
  json(status, { error: { type: "mockingbird_admin", message } })
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const adminRoutes = (runtime: ServiceRuntime<EasyPostAPI>): AdminRoutes => ({
  "GET /trackers": ({ namespace }) =>
    json(200, { trackers: runtime.instance(namespace).trackers() }),
  "POST /trackers/:code/transition": ({ params, body, namespace }) => {
    if (!isRecord(body) || !isTrackerStatus(body.status)) {
      return adminError(
        400,
        'expected {"status": "<unknown|pre_transit|in_transit|out_for_delivery|delivered|available_for_pickup|return_to_sender|failure|cancelled|error>", "status_detail"?, "message"?, "carrier"?}',
      )
    }
    const text = (key: string) => (typeof body[key] === "string" ? { [key]: body[key] } : {})
    const tracker = runtime
      .instance(namespace)
      .transition(
        params.code as string,
        { status: body.status, ...text("status_detail"), ...text("message"), ...text("signed_by") },
        typeof body.carrier === "string" ? body.carrier : undefined,
      )
    return json(200, tracker)
  },
  "GET /settings": ({ namespace }) => json(200, runtime.instance(namespace).state.current()),
  "PUT /settings": ({ body, namespace }) => {
    if (!isRecord(body)) return adminError(400, "expected a JSON object")
    const patch: Partial<Settings> = {}
    if (body.apiKeys !== undefined) {
      if (!Array.isArray(body.apiKeys)) return adminError(400, "apiKeys: string[]")
      patch.apiKeys = body.apiKeys.map(String)
    }
    return json(200, runtime.instance(namespace).state.update(patch))
  },
})

/**
 * The EasyPost mock with Mockingbird's full service contract: `/health`, `/__admin/*`,
 * namespaces by header, by `/ns/<name>` path prefix, or by API key
 * (`PUT /__admin/credentials {"credentials": {"<EASYPOST_API_KEY>": "<namespace>"}}`),
 * clock control, fault presets and a request journal.
 */
export const createRuntime = (options: EasyPostRuntimeOptions = {}): EasyPostRuntime =>
  createServiceRuntime<EasyPostAPI>({
    name: EASYPOST_NAMESPACE,
    document,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    credential: apiKeyCredential,
    presets: EASYPOST_PRESETS,
    create: ({ sqlite, namespace, clock }) =>
      new EasyPostAPI({
        sqlite,
        namespace,
        now: clock.now,
        ...(options.settings ? { settings: options.settings } : {}),
      }),
    admin: adminRoutes,
  })
