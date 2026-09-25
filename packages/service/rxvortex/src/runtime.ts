import {
  type AdminRoutes,
  type Clock,
  createRuntime as createServiceRuntime,
  createWebhookHub,
  type FaultPreset,
  type RequestLog,
  type ServiceRuntime,
  signers,
  type WebhookEndpoint,
  type WebhookHub,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { type CatalogItem, parseCatalogItem } from "./catalog.js"
import { document } from "./generated/openapi.js"
import { RXVORTEX_NAMESPACE, RxVortexAPI, tokenCredential } from "./index.js"
import type { AutoAdvance, Settings } from "./state.js"

/** Header our receiver compares to `RXVORTEX_WEBHOOK_SECRET` (plain equality). */
export const WEBHOOK_SECRET_HEADER = "x-rxvortex-webhook-secret"

/**
 * Every named RxVortex misbehaviour our consumer branches on, switched on with
 * `POST /__admin/faults {"preset": "<name>"}` (add `count` to limit it).
 */
export const RXVORTEX_PRESETS: Record<string, FaultPreset> = {
  duplicate_sender_order_id: {
    description: "Submit answers 409: an order with this sender_order_id already exists (it does)",
    rules: [{ operationId: "CreateOrder", effect: "duplicate_sender_order_id" }],
  },
  created_but_500: {
    description: "Submit creates the order, then answers 500; recovery by paymentId finds it",
    rules: [{ operationId: "CreateOrder", effect: "created_but_500" }],
  },
  numeric_tracking_id: {
    description: "Submit answers order_tracking_id as a number (our client treats it as an error)",
    rules: [{ operationId: "CreateOrder", effect: "numeric_tracking_id" }],
  },
  token_expired: {
    description: "Every authenticated call answers 401 Token has expired, before 24 h",
    rules: [
      { pathPrefix: "/api/v1/orders", effect: "token_expired" },
      { pathPrefix: "/api/v1/preset-catalog-items", effect: "token_expired" },
    ],
  },
  stale_error_with_delivered_date: {
    description: "Status answers an Error status next to a non-empty delivered_date",
    rules: [{ operationId: "GetOrder", effect: "stale_error_with_delivered_date" }],
  },
  validation_errors_array: {
    description: "Submit answers 422 with errors as a non-empty array",
    rules: [{ operationId: "CreateOrder", effect: "validation_errors_array" }],
  },
  validation_errors_object: {
    description: "Submit answers 422 with errors as an object keyed by field",
    rules: [{ operationId: "CreateOrder", effect: "validation_errors_object" }],
  },
  validation_errors_empty: {
    description: "Submit answers 422 with an empty errors array",
    rules: [{ operationId: "CreateOrder", effect: "validation_errors_empty" }],
  },
  server_error: {
    description: "Every call answers 500 Server Error",
    rules: [{ status: 500, body: { message: "Server Error" } }],
  },
  webhook_duplicate: {
    description: "The next status webhook is delivered twice",
    webhook: { mode: "duplicate" },
  },
  webhook_reorder: {
    description: "The next two status webhooks arrive swapped",
    webhook: { mode: "reorder" },
  },
  webhook_drop: {
    description: "The next status webhook is never delivered",
    webhook: { mode: "drop" },
  },
}

export type RxVortexRuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  seed?: number | string
  adminKey?: string
  onLog?: (entry: RequestLog) => void
  /**
   * Rows every namespace starts with, and returns to on `POST /__admin/reset` (`serve
   * --catalog <file>`). Default: `DEFAULT_CATALOG`.
   */
  catalog?: readonly CatalogItem[]
  settings?: Partial<Settings>
  /** Where status webhooks go (`POST /prescriptions/webhooks/rxvortex`), sent with the secret header. */
  webhooks?: Omit<WebhookEndpoint, "id"> & Pick<WebhookHubOptionsSubset, "retryDelaysMs" | "fetch">
  /**
   * Run auto-advance on this real-time interval (ms), so webhooks fire without a request
   * arriving. The served mock uses 100 ms; in-process runtimes default to off (reads and
   * `POST /__admin/tick` still advance).
   */
  tickMs?: number
}

type WebhookHubOptionsSubset = {
  retryDelaysMs?: readonly number[]
  fetch?: (request: Request) => Promise<Response>
}

export type RxVortexRuntime = ServiceRuntime<RxVortexAPI> & {
  readonly webhooks: WebhookHub
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

const adminRoutes = (runtime: ServiceRuntime<RxVortexAPI>): AdminRoutes => ({
  "GET /orders": ({ namespace }) => json(200, { orders: runtime.instance(namespace).orders() }),
  "POST /orders/:id/transition": ({ params, body, namespace }) => {
    if (!isRecord(body) || typeof body.to !== "string") {
      return adminError(
        400,
        'expected {"to": "<vendor status>", "trackingnumber"?, "shippingcarrier"?}',
      )
    }
    const optional = (key: string) => (typeof body[key] === "string" ? { [key]: body[key] } : {})
    const order = runtime.instance(namespace).transition(params.id as string, {
      to: body.to,
      ...optional("trackingnumber"),
      ...optional("shippingcarrier"),
      ...optional("shippingservice"),
      ...optional("delivered_date"),
    })
    return order ? json(200, order) : adminError(404, `no order ${params.id}`)
  },
  "GET /catalog": ({ namespace }) =>
    json(200, { data: runtime.instance(namespace).state.catalogRows() }),
  "PUT /catalog": ({ body, namespace }) => {
    const rows = isRecord(body) ? (body.items ?? body.data) : undefined
    if (!isRecord(body) || !Array.isArray(rows)) {
      return adminError(400, 'expected {"items": [{catalog_id, medication_name, …}], "mode"?}')
    }
    const mode = body.mode ?? "replace"
    if (mode !== "replace" && mode !== "merge") {
      return adminError(400, 'mode must be "replace" or "merge"')
    }
    let items: CatalogItem[]
    try {
      items = rows.map(parseCatalogItem)
    } catch (error) {
      return adminError(400, `items: ${(error as Error).message}`)
    }
    return json(200, { count: runtime.instance(namespace).state.putCatalog(items, mode) })
  },
  "GET /settings": ({ namespace }) => json(200, runtime.instance(namespace).state.current()),
  "PUT /settings": ({ body, namespace }) => {
    if (!isRecord(body)) return adminError(400, "expected a JSON object")
    const patch: Partial<Settings> = {}
    if (body.tokenTtlSeconds !== undefined) {
      if (typeof body.tokenTtlSeconds !== "number")
        return adminError(400, "tokenTtlSeconds: number")
      patch.tokenTtlSeconds = body.tokenTtlSeconds
    }
    if (body.staticTokens !== undefined) {
      if (!Array.isArray(body.staticTokens)) return adminError(400, "staticTokens: string[]")
      patch.staticTokens = body.staticTokens.map(String)
    }
    if (body.clients !== undefined) {
      if (!Array.isArray(body.clients))
        return adminError(400, "clients: [{client_id, client_secret}]")
      patch.clients = body.clients.filter(isRecord).map((c) => ({
        client_id: String(c.client_id),
        client_secret: String(c.client_secret),
      }))
    }
    if (body.autoAdvance !== undefined) {
      const parsed = parseAutoAdvance(body.autoAdvance)
      if (typeof parsed === "string") return adminError(400, parsed)
      patch.autoAdvance = parsed
    }
    if (body.unknownPresets !== undefined) {
      if (body.unknownPresets !== "reject" && body.unknownPresets !== "accept") {
        return adminError(400, 'unknownPresets: "reject" | "accept"')
      }
      patch.unknownPresets = body.unknownPresets
    }
    return json(200, runtime.instance(namespace).state.update(patch))
  },
  "POST /tick": ({ namespace }) => json(200, { applied: runtime.instance(namespace).tick() }),
})

/**
 * The RxVortex mock with Mockingbird's full service contract: `/health`, `/__admin/*`,
 * namespaces by header, by `/ns/<name>` path prefix, or by client id
 * (`PUT /__admin/credentials {"credentials": {"<RXVORTEX_CLIENT_ID>": "<namespace>"}}`),
 * clock control, fault presets, signed status webhooks and a request journal.
 */
export const createRuntime = (options: RxVortexRuntimeOptions = {}): RxVortexRuntime => {
  const { retryDelaysMs, fetch: send, ...endpoint } = options.webhooks ?? { url: "" }
  const hub = createWebhookHub({
    signer: signers.header(WEBHOOK_SECRET_HEADER),
    ...(retryDelaysMs ? { retryDelaysMs } : {}),
    ...(send ? { fetch: send } : {}),
    endpoints: options.webhooks ? [endpoint as WebhookEndpoint] : [],
  })
  const runtime = createServiceRuntime<RxVortexAPI>({
    name: RXVORTEX_NAMESPACE,
    document,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    credential: tokenCredential,
    presets: RXVORTEX_PRESETS,
    webhooks: hub,
    create: ({ sqlite, namespace, publicNamespace, clock }) =>
      new RxVortexAPI({
        sqlite,
        namespace,
        now: clock.now,
        ...(options.catalog ? { catalog: options.catalog } : {}),
        ...(options.settings ? { settings: options.settings } : {}),
        onWebhook: (event) =>
          hub.publish({
            namespace: publicNamespace,
            type: event.event,
            body: event,
            id: `${event.order_tracking_id}:${event.updated_at}:${event.rxstatus}`,
          }),
      }),
    describe: () => ({ webhooks: hub.endpoints("default").length > 0 ? "on" : "off" }),
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
    webhooks: hub,
    stop: () => {
      if (timer !== undefined) clearInterval(timer)
    },
  })
}
