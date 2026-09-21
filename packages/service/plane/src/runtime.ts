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
import { apiKeyCredential, PLANE_NAMESPACE, PlaneAPI } from "./index.js"
import type { Settings } from "./state.js"

const API = "/api/v1/workspaces/"

/**
 * Every named Plane misbehaviour our bug-report client branches on, switched on with
 * `POST /__admin/faults {"preset": "<name>"}`. Our client retries GETs on 429/5xx at 0, 2
 * and 8 s (three attempts) and never retries writes: use `count` to fail only some attempts.
 */
export const PLANE_PRESETS: Record<string, FaultPreset> = {
  rate_limited: {
    description:
      "Every call answers 429 Request was throttled (pass count: 2 to recover on the 3rd GET)",
    rules: [
      {
        pathPrefix: API,
        status: 429,
        body: { detail: "Request was throttled. Expected available in 60 seconds." },
        headers: { "x-ratelimit-remaining": "0" },
      },
    ],
  },
  server_error: {
    description: "Every call answers 500",
    rules: [
      {
        pathPrefix: API,
        status: 500,
        body: { error: "Something went wrong please try again later" },
      },
    ],
  },
  bad_gateway: {
    description: "Every call answers a 502 HTML page",
    rules: [
      {
        pathPrefix: API,
        status: 502,
        body: "<html><body>502 Bad Gateway</body></html>",
        headers: { "content-type": "text/html" },
      },
    ],
  },
  unauthorized: {
    description: "Every call answers 401 (token revoked)",
    rules: [{ pathPrefix: API, status: 401, body: { detail: "Given API token is not valid" } }],
  },
  invalid_json: {
    description: "Reads answer 200 with a body that is not JSON",
    rules: [
      {
        pathPrefix: API,
        method: "GET",
        status: 200,
        body: "<!doctype html><title>Plane</title>",
        headers: { "content-type": "text/html" },
      },
    ],
  },
  network_drop: {
    description: "The connection drops before any answer (fetch rejects)",
    rules: [{ pathPrefix: API, drop: true }],
  },
  slow: {
    description: "Every call answers after 15 s (past our client's 10 s timeout)",
    rules: [{ pathPrefix: API, latencyMs: 15_000 }],
  },
  pagination_missing_cursor: {
    description: "Lists claim another page (next_page_results: true) with an empty next_cursor",
    rules: [{ pathPrefix: API, method: "GET", effect: "pagination_missing_cursor" }],
  },
  pagination_repeated_cursor: {
    description: "Lists always claim another page behind the same next_cursor",
    rules: [{ pathPrefix: API, method: "GET", effect: "pagination_repeated_cursor" }],
  },
}

export type PlaneRuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  seed?: number | string
  adminKey?: string
  onLog?: (entry: RequestLog) => void
  settings?: Partial<Settings>
}

export type PlaneRuntime = ServiceRuntime<PlaneAPI>

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const adminError = (status: number, message: string) =>
  json(status, { error: { type: "mockingbird_admin", message } })
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const adminRoutes = (runtime: ServiceRuntime<PlaneAPI>): AdminRoutes => ({
  "GET /work-items": ({ namespace }) =>
    json(200, { work_items: runtime.instance(namespace).workItems() }),
  "POST /work-items/:id/state": ({ params, body, namespace }) => {
    if (!isRecord(body) || typeof body.state !== "string") {
      return adminError(400, 'expected {"state": "<state id or name, e.g. Done>"}')
    }
    const item = runtime.instance(namespace).moveToState(params.id as string, body.state)
    return item
      ? json(200, item)
      : adminError(404, `no work item ${params.id} or state ${body.state}`)
  },
  "POST /projects": ({ body, namespace }) => {
    if (!isRecord(body) || typeof body.workspace !== "string" || typeof body.project !== "string") {
      return adminError(400, 'expected {"workspace": "<slug>", "project": "<uuid>"}')
    }
    const api = runtime.instance(namespace)
    const project = api.ensureProject(body.workspace, body.project)
    return project
      ? json(200, { project, states: api.statesOf(project.id), labels: api.labelsOf(project.id) })
      : adminError(409, "project is not in settings.projects")
  },
  "GET /settings": ({ namespace }) => json(200, runtime.instance(namespace).state.current()),
  "PUT /settings": ({ body, namespace }) => {
    if (!isRecord(body)) return adminError(400, "expected a JSON object")
    const patch: Partial<Settings> = {}
    if (body.apiKeys !== undefined) {
      if (!Array.isArray(body.apiKeys)) return adminError(400, "apiKeys: string[]")
      patch.apiKeys = body.apiKeys.map(String)
    }
    if (body.rateLimitPerMinute !== undefined) {
      if (body.rateLimitPerMinute !== null && typeof body.rateLimitPerMinute !== "number") {
        return adminError(400, "rateLimitPerMinute: number | null")
      }
      patch.rateLimitPerMinute = body.rateLimitPerMinute as number | null
    }
    if (body.projects !== undefined) {
      if (!Array.isArray(body.projects)) return adminError(400, 'projects: ["<slug>/<uuid>"]')
      patch.projects = body.projects.map(String)
    }
    return json(200, runtime.instance(namespace).state.update(patch))
  },
})

/**
 * The Plane mock with Mockingbird's full service contract: `/health`, `/__admin/*`,
 * namespaces by header, by `/ns/<name>` path prefix, or by API key
 * (`PUT /__admin/credentials {"credentials": {"<PLANE_ACCESS_TOKEN>": "<namespace>"}}`),
 * clock control, fault presets and a request journal.
 */
export const createRuntime = (options: PlaneRuntimeOptions = {}): PlaneRuntime =>
  createServiceRuntime<PlaneAPI>({
    name: PLANE_NAMESPACE,
    document,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    credential: apiKeyCredential,
    presets: PLANE_PRESETS,
    create: ({ sqlite, namespace, clock }) =>
      new PlaneAPI({
        sqlite,
        namespace,
        now: clock.now,
        ...(options.settings ? { settings: options.settings } : {}),
      }),
    admin: adminRoutes,
  })
