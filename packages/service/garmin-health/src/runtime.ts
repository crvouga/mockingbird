import {
  type AdminRoutes,
  bearerToken,
  type Clock,
  createRuntime as createServiceRuntime,
  createWebhookHub,
  type FaultPreset,
  type MockControls,
  type RequestLog,
  type ServiceRuntime,
  signers,
  type WebhookEndpoint,
  type WebhookHub,
} from "@crvouga/mockingbird-service"
import { document } from "./generated/openapi.js"
import {
  GARMIN_HEALTH_NAMESPACE,
  GarminHealthAPI,
  type GarminHealthAPIOptions,
  isSummaryType,
  type Settings,
  type SummarySeed,
} from "./index.js"

/** Where each notification kind is posted, relative to the consumer's webhook base URL. */
export const WEBHOOK_PATHS = {
  push: "/push",
  ping: "/ping",
  deregistration: "/deregistration",
  permissions: "/permissions",
} as const
type WebhookKind = keyof typeof WEBHOOK_PATHS

/** Header the consumer requires on every webhook delivery; its value is the app's client id. */
const CLIENT_ID_HEADER = "garmin-client-id"

export type GarminHealthWebhooks = {
  /** The consumer's webhook base URL, e.g. `http://localhost:8000/api/v1/garmin/webhooks`. */
  baseUrl: string
  /** Sent as `garmin-client-id`. Default: the emulator's seeded client id. */
  clientId?: string
  /** Override a kind's path under `baseUrl`. */
  paths?: Partial<Record<WebhookKind, string>>
  retryDelaysMs?: readonly number[]
  fetch?: (request: Request) => Promise<Response>
}

/** The four endpoints (push, ping, deregistration, permissions) behind one base URL. */
export const webhookEndpoints = (
  config: Pick<GarminHealthWebhooks, "baseUrl" | "clientId" | "paths">,
): WebhookEndpoint[] =>
  (Object.keys(WEBHOOK_PATHS) as WebhookKind[]).map((kind) => ({
    id: `garmin_${kind}`,
    url: `${config.baseUrl.replace(/\/+$/, "")}${config.paths?.[kind] ?? WEBHOOK_PATHS[kind]}`,
    events: [kind],
    headers: { [CLIENT_ID_HEADER]: config.clientId ?? "mock_garmin_client" },
  }))

const apiFailure = (status: number, error: string, message: string, headers = {}) => ({
  status,
  body: { error, message },
  headers,
})

/**
 * Every named Garmin misbehaviour a consumer may branch on, switched on with
 * `POST /__admin/faults {"preset": "<name>", "count": n}`. Bodies are scripted fixtures, not
 * observed Garmin bodies (best guess, not oracle-verified).
 */
export const GARMIN_HEALTH_PRESETS: Record<string, FaultPreset> = {
  unauthorized: {
    description: "Health API calls answer 401 (an expired or revoked access token)",
    rules: [
      {
        pathPrefix: "/wellness-api",
        ...apiFailure(401, "unauthorized", "The access token is expired or invalid."),
      },
    ],
  },
  conflict: {
    description: "Backfill answers 409, as for an already requested window",
    rules: [
      {
        operationId: "RequestBackfill",
        ...apiFailure(409, "duplicate_request", "This window was already requested."),
      },
    ],
  },
  rate_limited: {
    description: "Health API calls answer 429 with Retry-After: 1",
    rules: [
      {
        pathPrefix: "/wellness-api",
        ...apiFailure(429, "rate_limited", "Too many requests.", { "retry-after": "1" }),
      },
    ],
  },
  server_error: {
    description: "Health API calls answer 500",
    rules: [
      {
        pathPrefix: "/wellness-api",
        ...apiFailure(500, "internal_error", "Internal server error."),
      },
    ],
  },
  refresh_rejected: {
    description: "The token endpoint answers 400 invalid_grant (a revoked refresh token)",
    rules: [
      {
        operationId: "OAuthToken",
        status: 400,
        body: { error: "invalid_grant", error_description: "The refresh token is invalid." },
      },
    ],
  },
  connection_drop: {
    description: "Backfill drops the connection",
    rules: [{ operationId: "RequestBackfill", drop: true }],
  },
  duplicate: {
    description: "The next webhook is delivered twice",
    webhook: { mode: "duplicate" },
  },
  webhook_drop: {
    description: "The next webhook is never delivered",
    webhook: { mode: "drop" },
  },
  webhook_reorder: {
    description: "The next two webhooks arrive swapped",
    webhook: { mode: "reorder" },
  },
}

export type GarminHealthRuntimeOptions = Omit<
  GarminHealthAPIOptions,
  "now" | "namespace" | "adminPrefix" | "publicNamespace" | "onWebhook"
> & {
  clock?: Clock
  seed?: string | number
  adminPrefix?: string
  adminKey?: string
  /** Admin controls to boot with: clock, latency, faults, seed, a starting snapshot. */
  adminControls?: MockControls
  onLog?: (entry: RequestLog) => void
  /** Where webhooks go. Without it, set a namespace's with `PUT /__admin/webhook-base-url`. */
  webhooks?: GarminHealthWebhooks
}

export type GarminHealthRuntime = ServiceRuntime<GarminHealthAPI> & {
  readonly webhooks: WebhookHub
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const adminError = (status: number, message: string) =>
  json(status, { error: { type: "mockingbird_admin", message } })
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const listOf = (body: unknown, key: string): unknown[] | undefined =>
  Array.isArray(body) ? body : isRecord(body) && Array.isArray(body[key]) ? body[key] : undefined
const idsOf = (body: unknown): string[] | undefined =>
  isRecord(body) && Array.isArray(body.ids) ? body.ids.map(String) : undefined

const guarded = (run: () => Response): Response => {
  try {
    return run()
  } catch (error) {
    return adminError(400, error instanceof Error ? error.message : String(error))
  }
}

const adminRoutes = (runtime: ServiceRuntime<GarminHealthAPI>, hub: WebhookHub): AdminRoutes => ({
  "GET /settings": ({ namespace }) => json(200, runtime.instance(namespace).settings()),
  "PUT /settings": ({ body, namespace }) =>
    guarded(() => {
      if (!isRecord(body)) return adminError(400, "expected a JSON object")
      const patch: Partial<Settings> = {}
      for (const key of ["autoDeliver", "denyConsent", "rotateRefreshTokens"] as const) {
        const value = body[key]
        if (typeof value === "boolean") patch[key] = value
        else if (value !== undefined) return adminError(400, `${key} must be a boolean`)
      }
      if (typeof body.tokenTtlSeconds === "number") patch.tokenTtlSeconds = body.tokenTtlSeconds
      if (typeof body.consentUserId === "string") patch.consentUserId = body.consentUserId
      if (typeof body.publicUrl === "string") patch.publicUrl = body.publicUrl
      return json(200, runtime.instance(namespace).updateSettings(patch))
    }),
  "GET /users": ({ namespace }) =>
    json(200, {
      users: runtime
        .instance(namespace)
        .users.list({ order: "oldest" })
        .map((r) => r.value),
    }),
  "PUT /users": ({ body, namespace }) =>
    guarded(() => {
      const list = listOf(body, "users")
      if (!list) return adminError(400, "expected [user] or {users: [user]}")
      for (const [i, u] of list.entries())
        if (!isRecord(u) || typeof u.userId !== "string" || !u.userId)
          return adminError(400, `users[${i}]: userId is required`)
      const api = runtime.instance(namespace)
      const users = list.map((u) => api.putUser(u as { userId: string }))
      return json(200, { users })
    }),
  "PUT /summaries": ({ body, namespace }) =>
    guarded(() => {
      const list = listOf(body, "summaries")
      if (!list) return adminError(400, "expected [summary] or {summaries: [summary]}")
      for (const [i, s] of list.entries())
        if (!isRecord(s) || !isRecord(s.data) || typeof s.userId !== "string")
          return adminError(400, `summaries[${i}]: userId, type and data are required`)
        else if (typeof s.type !== "string" || !isSummaryType(s.type))
          return adminError(400, `summaries[${i}]: unknown type ${String(s.type)}`)
      const api = runtime.instance(namespace)
      return json(200, {
        summaries: list.map((s) => api.addSummary(s as SummarySeed).key),
      })
    }),
  "GET /backfills": ({ namespace }) => {
    const api = runtime.instance(namespace)
    return json(200, {
      backfills: api.backfills.list({ order: "oldest" }).map((r) => r.value),
      // Metadata only: the delivery body stays in the webhook event log.
      notifications: api.notifications.list({ order: "oldest" }).map(({ value }) => {
        const { body: _body, ...metadata } = value
        return metadata
      }),
    })
  },
  "POST /notifications/deliver": async ({ body, namespace }) => {
    const sent = runtime.instance(namespace).deliverPending(idsOf(body))
    await hub.idle(namespace)
    return json(200, { delivered: sent })
  },
  "POST /notifications/drop": ({ body, namespace }) =>
    json(200, { dropped: runtime.instance(namespace).dropPending(idsOf(body)) }),
  "PUT /webhook-base-url": ({ body, namespace }) => {
    if (!isRecord(body) || typeof body.baseUrl !== "string")
      return adminError(400, "expected {baseUrl, clientId?, paths?}")
    try {
      new URL(body.baseUrl)
    } catch {
      return adminError(400, `not a URL: ${body.baseUrl}`)
    }
    const paths = isRecord(body.paths)
      ? (Object.fromEntries(
          Object.entries(body.paths).filter(
            ([k, v]) => k in WEBHOOK_PATHS && typeof v === "string",
          ),
        ) as GarminHealthWebhooks["paths"])
      : undefined
    const set = hub.setEndpoints(
      namespace,
      webhookEndpoints({
        baseUrl: body.baseUrl,
        ...(typeof body.clientId === "string" ? { clientId: body.clientId } : {}),
        ...(paths ? { paths } : {}),
      }),
    )
    return json(200, { endpoints: set.map(({ id, url, events }) => ({ id, url, events })) })
  },
  "POST /users/:userId/deregister": ({ params, namespace }) =>
    guarded(() => json(200, runtime.instance(namespace).deregisterUser(params.userId as string))),
  "POST /users/:userId/permissions": ({ params, body, namespace }) =>
    guarded(() => {
      const permissions =
        isRecord(body) && isRecord(body.permissions) ? body.permissions : undefined
      if (!permissions || !Object.values(permissions).every((v) => typeof v === "boolean"))
        return adminError(400, "expected {permissions: {<name>: boolean}}")
      return json(
        200,
        runtime
          .instance(namespace)
          .changePermissions(params.userId as string, permissions as Record<string, boolean>),
      )
    }),
  "POST /users/:userId/expire-token": ({ params, body, namespace }) => {
    const revoke = isRecord(body) && body.revokeRefresh === true
    return json(200, {
      expired: runtime.instance(namespace).expireTokens(params.userId as string, revoke),
    })
  },
})

/**
 * The Garmin Health mock with Mockingbird's full service contract. Namespaces select by header,
 * by `/__admin/ns/<name>` path prefix (which ping `callbackURL`s carry) or by access token.
 */
export const createRuntime = (options: GarminHealthRuntimeOptions = {}): GarminHealthRuntime => {
  const { webhooks, ...apiOptions } = options
  const hub = createWebhookHub({
    // Garmin deliveries carry no signature the consumer verifies; only garmin-client-id.
    signer: signers.none(),
    ...(webhooks?.retryDelaysMs ? { retryDelaysMs: webhooks.retryDelaysMs } : {}),
    ...(webhooks?.fetch ? { fetch: webhooks.fetch } : {}),
    endpoints: webhooks ? webhookEndpoints(webhooks) : [],
  })
  const runtime = createServiceRuntime<GarminHealthAPI>({
    name: GARMIN_HEALTH_NAMESPACE,
    document,
    presets: GARMIN_HEALTH_PRESETS,
    credential: bearerToken,
    webhooks: hub,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminPrefix ? { adminPrefix: options.adminPrefix } : {}),
    ...(options.adminKey ? { adminKey: options.adminKey } : {}),
    ...(options.adminControls !== undefined ? { adminControls: options.adminControls } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    create: ({ sqlite, namespace, publicNamespace, adminPrefix, clock }) =>
      new GarminHealthAPI({
        ...apiOptions,
        sqlite,
        namespace,
        now: clock.now,
        adminPrefix,
        publicNamespace,
        onWebhook: (event) =>
          hub.publish({
            namespace: publicNamespace,
            type: event.kind,
            body: event.body,
            tags: event.tags,
          }),
      }),
    describe: () => ({ webhooks: hub.endpoints("default").length > 0 ? "on" : "off" }),
    admin: (self) => adminRoutes(self, hub),
  })
  return Object.assign(runtime, { webhooks: hub })
}
