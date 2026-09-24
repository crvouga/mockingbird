import {
  type AdminRoutes,
  type Clock,
  createRuntime as createServiceRuntime,
  type FaultPreset,
  type RequestLog,
  type ServiceRuntime,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { Catalog } from "./catalog.js"
import { document } from "./generated/openapi.js"
import { basicUsername, WHOLESCRIPTS_NAMESPACE, WholescriptsAPI } from "./index.js"
import type { AutoAdvance, Settings } from "./state.js"

/**
 * Every named Wholescripts misbehaviour our consumers branch on, switched on with
 * `POST /__admin/faults {"preset": "<name>"}` (add `count` to limit it).
 */
export const WHOLESCRIPTS_PRESETS: Record<string, FaultPreset> = {
  submit_rejected: {
    description:
      "Submit answers 200 {success: false, msg} (the backend and the scheduler both reject it)",
    rules: [{ operationId: "SubmitOrder", effect: "submit_rejected" }],
  },
  submit_timeout: {
    description:
      "Submit places the order, then drops the connection (the scheduler's 'order may have been placed')",
    rules: [{ operationId: "SubmitOrder", effect: "submit_timeout" }],
  },
  status_empty: {
    description:
      "Status answers [] even for a known order (backend returns null, the scheduler 'unknown')",
    rules: [{ operationId: "GetOrderStatus", effect: "status_empty" }],
  },
  status_schema_drift: {
    description:
      "Status rows drop salesOrder and stringify orderTotal (the backend zod check fails: data null)",
    rules: [{ operationId: "GetOrderStatus", effect: "status_schema_drift" }],
  },
  server_error: {
    description: "Every call answers 500 (the scheduler retries 5xx; the backend throws)",
    rules: [{ status: 500, body: { Message: "An error has occurred." } }],
  },
  unauthorized: {
    description: "Every call answers 401, as with rotated Basic credentials",
    rules: [{ status: 401, body: { Message: "Authorization has been denied for this request." } }],
  },
}

export type WholescriptsRuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  seed?: number | string
  adminKey?: string
  onLog?: (entry: RequestLog) => void
  catalog?: Catalog
  settings?: Partial<Settings>
  /**
   * Run auto-advance on this real-time interval (ms). The served mock uses 100 ms; in-process
   * runtimes default to off (requests and `POST /__admin/tick` still advance).
   */
  tickMs?: number
}

export type WholescriptsRuntime = ServiceRuntime<WholescriptsAPI> & {
  /** Stop the background ticker, if one runs. */
  stop(): void
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const adminError = (status: number, message: string) =>
  json(status, { error: { type: "mockingbird_admin", message } })
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const parseAutoAdvance = (value: unknown): AutoAdvance | null | string => {
  if (value === null) return null
  if (!isRecord(value)) return "autoAdvance must be {afterMs, path} or null"
  if (typeof value.afterMs !== "number" || value.afterMs < 0)
    return "autoAdvance.afterMs must be ms"
  if (!Array.isArray(value.path) || value.path.some((s) => typeof s !== "string")) {
    return "autoAdvance.path must be a list of vendor statuses"
  }
  return { afterMs: value.afterMs, path: value.path as string[] }
}

const adminRoutes = (runtime: ServiceRuntime<WholescriptsAPI>): AdminRoutes => ({
  "GET /orders": ({ namespace }) => json(200, { orders: runtime.instance(namespace).orders() }),
  "POST /orders/:id/transition": ({ params, body, namespace }) => {
    if (!isRecord(body) || typeof body.to !== "string") {
      return adminError(
        400,
        'expected {"to": "Pending|Processing|Complete|Cancelled|Error|…", "trackingNumber"?, "carrier"?, "message"?}',
      )
    }
    const optional = (key: string) => (typeof body[key] === "string" ? { [key]: body[key] } : {})
    const order = runtime.instance(namespace).transition(params.id as string, {
      to: body.to,
      ...optional("trackingNumber"),
      ...optional("carrier"),
      ...optional("trackingUrl"),
      ...optional("message"),
    })
    return order ? json(200, order) : adminError(404, `no order ${params.id}`)
  },
  "GET /catalog": ({ namespace }) => json(200, runtime.instance(namespace).state.catalog()),
  "PUT /catalog": ({ body, namespace }) => {
    if (
      !isRecord(body) ||
      !Array.isArray(body.products) ||
      !Array.isArray(body.medPaxPills) ||
      !Array.isArray(body.privateLabelCartons)
    ) {
      return adminError(
        400,
        "expected {products: [...], medPaxPills: [...], privateLabelCartons: [...]}",
      )
    }
    return json(200, runtime.instance(namespace).state.replaceCatalog(body as Catalog))
  },
  "GET /settings": ({ namespace }) => json(200, runtime.instance(namespace).state.current()),
  "PUT /settings": ({ body, namespace }) => {
    if (!isRecord(body)) return adminError(400, "expected a JSON object")
    const patch: Partial<Settings> = {}
    if (body.accounts !== undefined) {
      if (!Array.isArray(body.accounts)) return adminError(400, "accounts: [{username, password}]")
      patch.accounts = body.accounts.filter(isRecord).map((a) => ({
        username: String(a.username),
        password: String(a.password),
      }))
    }
    if (body.autoAdvance !== undefined) {
      const parsed = parseAutoAdvance(body.autoAdvance)
      if (typeof parsed === "string") return adminError(400, parsed)
      patch.autoAdvance = parsed
    }
    return json(200, runtime.instance(namespace).state.update(patch))
  },
  "POST /tick": ({ namespace }) => json(200, { applied: runtime.instance(namespace).tick() }),
})

/**
 * The Wholescripts mock with Mockingbird's full service contract: `/health`, `/__admin/*`,
 * namespaces by header, by `/ns/<name>` path prefix, or by Basic username
 * (`PUT /__admin/credentials {"credentials": {"<WHOLESCRIPTS_USERNAME>": "<namespace>"}}`),
 * clock control, fault presets and a request journal. Wholescripts sends no webhooks.
 */
export const createRuntime = (options: WholescriptsRuntimeOptions = {}): WholescriptsRuntime => {
  const runtime = createServiceRuntime<WholescriptsAPI>({
    name: WHOLESCRIPTS_NAMESPACE,
    document,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    credential: basicUsername,
    presets: WHOLESCRIPTS_PRESETS,
    create: ({ sqlite, namespace, clock }) =>
      new WholescriptsAPI({
        sqlite,
        namespace,
        now: clock.now,
        ...(options.catalog ? { catalog: options.catalog } : {}),
        ...(options.settings ? { settings: options.settings } : {}),
      }),
    admin: adminRoutes,
  })
  let timer: ReturnType<typeof setInterval> | undefined
  if (options.tickMs !== undefined && options.tickMs > 0) {
    timer = setInterval(() => {
      for (const name of runtime.namespaces()) runtime.instance(name).tick()
    }, options.tickMs)
    ;(timer as { unref?: () => void }).unref?.()
  }
  return Object.assign(runtime, {
    stop: () => {
      if (timer !== undefined) clearInterval(timer)
    },
  })
}
