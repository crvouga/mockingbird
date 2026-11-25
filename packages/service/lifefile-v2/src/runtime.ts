import {
  type AdminRoutes,
  type Clock,
  createRuntime as createServiceRuntime,
  createWebhookHub,
  type FaultPreset,
  type MockControls,
  opaqueToken,
  type RequestLog,
  type ServiceRuntime,
  type WebhookHub,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import {
  CATALOG_DATA,
  CATALOGS,
  CORPUS_VERSION,
  DEFAULT_SETTINGS,
  RECORDED_LATENCY_MS,
} from "./corpus.js"
import { document } from "./generated/openapi.js"
import { LIFEFILE_V2_NAMESPACE, LifeFileV2API, tokenCredential } from "./index.js"
import type { ApiUser, Catalog, PushTarget, Settings, TrackingRecord } from "./types.js"
import { basicPushSigner, PUSH_EVENT, PUSH_RETRY_DELAYS_MS } from "./webhooks.js"

const envelope = (message: string) => ({ type: "error", message, data: null })

export const LIFEFILE_V2_PRESETS: Record<string, FaultPreset> = {
  create_lost_reply: {
    description:
      "The next order is created, then the connection drops before the reply: the caller cannot tell it exists",
    rules: [{ operationId: "CreateOrder", effect: "create_lost_reply" }],
  },
  server_error: {
    description: "API calls answer 500 in LifeFile's error envelope",
    rules: [{ pathPrefix: "/api/v2", status: 500, body: envelope("Server Error") }],
  },
  unavailable: {
    description: "API calls answer 503 with Retry-After",
    rules: [
      {
        pathPrefix: "/api/v2",
        status: 503,
        headers: { "content-type": "application/json", "retry-after": "1" },
        body: envelope("Service Unavailable"),
      },
    ],
  },
  rate_limited: {
    description: "API calls answer 429 Too Many Attempts. with Retry-After: 60",
    rules: [
      {
        pathPrefix: "/api/v2",
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "60" },
        body: envelope("Too Many Attempts."),
      },
    ],
  },
  token_rate_limited: {
    description: "Token requests answer 429 too_many_requests",
    rules: [
      {
        operationId: "IssueToken",
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "60" },
        body: { error: "too_many_requests", error_description: "Too Many Requests" },
      },
    ],
  },
  invalid_client: {
    description: "Token requests answer 401 invalid_client, as for a wrong or expired secret",
    rules: [
      {
        operationId: "IssueToken",
        status: 401,
        body: { error: "invalid_client", error_description: "Invalid Credentials" },
      },
    ],
  },
  token_revoked: {
    description: "API calls answer 401 for an inactive token: the client must sign in again",
    rules: [{ pathPrefix: "/api/v2", effect: "token_revoked" }],
  },
  push_duplicate: {
    description: "The next Data Push is delivered twice",
    webhook: { mode: "duplicate" },
  },
  push_reorder: {
    description: "The next two Data Pushes arrive swapped",
    webhook: { mode: "reorder" },
  },
  push_drop: {
    description: "The next Data Push is never delivered",
    webhook: { mode: "drop" },
  },
}

export type LifeFileV2RuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  seed?: number | string
  adminPrefix?: string
  adminKey?: string
  adminControls?: MockControls
  onLog?: (entry: RequestLog) => void
  settings?: Partial<Settings>
  apiUsers?: readonly Partial<ApiUser>[]
  latency?: "recorded" | "none"
  namespaceIdleMs?: number
  maxRecords?: number
  maxSnapshots?: number
  checkpointMutations?: boolean
  maxOrders?: number
  maxApiUsers?: number
  push?: PushTarget & {
    retryDelaysMs?: readonly number[]
    fetch?: (request: Request) => Promise<Response>
  }
}

export type LifeFileV2Runtime = ServiceRuntime<LifeFileV2API> & { readonly webhooks: WebhookHub }

export const RECORDED_LATENCY_CONTROL = {
  operations: Object.fromEntries(Object.entries(RECORDED_LATENCY_MS)),
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const adminError = (status: number, message: string) =>
  json(status, { error: { type: "mockingbird_admin", message } })
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const SETTING_KEYS = new Set<keyof Settings>(Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[])

const isWhole = (value: unknown, min: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min

const isTimeZone = (value: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value })
    return true
  } catch {
    return false
  }
}

const parseSettings = (
  body: Record<string, unknown>,
  current: Settings,
): Partial<Settings> | string => {
  const patch: Partial<Settings> = {}
  for (const key of Object.keys(body)) {
    if (!SETTING_KEYS.has(key as keyof Settings)) return `unknown setting ${key}`
  }
  const number = (key: keyof Settings, min: number, whole: boolean) => {
    const value = body[key]
    if (value === undefined) return undefined
    if (typeof value !== "number" || !Number.isFinite(value) || value < min)
      return `${key}: number >= ${min}`
    if (whole && !Number.isInteger(value)) return `${key}: whole number >= ${min}`
    ;(patch as Record<string, unknown>)[key] = value
    return undefined
  }
  const bool = (key: keyof Settings) => {
    const value = body[key]
    if (value === undefined) return undefined
    if (typeof value !== "boolean") return `${key}: boolean`
    ;(patch as Record<string, unknown>)[key] = value
    return undefined
  }
  const problem =
    number("vendorId", 1, true) ??
    number("tokenTtlSeconds", 1, true) ??
    number("tokenIdleSeconds", 1, true) ??
    number("secretTtlDays", 0, false) ??
    number("fastTrackWindowMs", 0, true) ??
    number("tokenGeneration", 0, true) ??
    bool("enforceVendorId") ??
    bool("openEnrollment")
  if (problem) return problem
  if (body.catalog !== undefined) {
    if (!CATALOGS.includes(body.catalog as Catalog))
      return `catalog must be one of ${CATALOGS.join(", ")}`
    patch.catalog = body.catalog as Catalog
    if (body.intake === undefined && body.catalog !== current.catalog) {
      patch.intake = body.catalog === "sandbox" ? DEFAULT_SETTINGS.intake : null
    }
  }
  const codes = new Set(CATALOG_DATA[patch.catalog ?? current.catalog].statuses.map((s) => s.id))
  if (body.intake !== undefined) {
    const intake = body.intake
    if (
      intake !== null &&
      (!isRecord(intake) || typeof intake.status !== "string" || !isWhole(intake.afterMs, 0))
    ) {
      return 'intake: null or {"status": "<code>", "afterMs": <whole ms >= 0>}'
    }
    if (intake !== null && !codes.has(intake.status as string)) {
      return `intake: ${String(intake.status)} is not a status of the ${patch.catalog ?? current.catalog} catalog`
    }
    patch.intake =
      intake === null
        ? null
        : { status: intake.status as string, afterMs: intake.afterMs as number }
  }
  for (const key of ["fastTrackStatus", "timeZone"] as const) {
    if (body[key] === undefined) continue
    if (typeof body[key] !== "string" || !body[key]) return `${key}: non-empty string`
    patch[key] = body[key] as string
  }
  if (patch.timeZone !== undefined && !isTimeZone(patch.timeZone)) {
    return `timeZone: ${patch.timeZone} is not an IANA time zone`
  }
  if (patch.fastTrackStatus !== undefined && !codes.has(patch.fastTrackStatus)) {
    return `fastTrackStatus: ${patch.fastTrackStatus} is not a status of the ${patch.catalog ?? current.catalog} catalog`
  }
  if (body.practice !== undefined) {
    const practice = body.practice
    if (!isRecord(practice) || !isWhole(practice.id, 1) || typeof practice.name !== "string") {
      return 'practice: {"id": <whole number >= 1>, "name": "<name>"}'
    }
    patch.practice = { id: practice.id, name: practice.name }
  }
  if (body.rateLimits !== undefined) {
    const limits = body.rateLimits
    if (limits === null) patch.rateLimits = null
    else if (!isRecord(limits) || !isWhole(limits.api, 1) || !isWhole(limits.token, 1)) {
      return 'rateLimits: null or {"api": <whole number >= 1>, "token": <whole number >= 1>}'
    } else patch.rateLimits = { api: limits.api, token: limits.token }
  }
  if (body.push !== undefined) {
    const push = parsePush(body.push)
    if (typeof push === "string") return push
    patch.push = push
  }
  return patch
}

const shownSettings = (settings: Settings) => ({
  ...settings,
  push: settings.push ? { url: settings.push.url, username: settings.push.username } : null,
})

const parsePush = (value: unknown): PushTarget | null | string => {
  if (value === null) return null
  if (
    !isRecord(value) ||
    typeof value.url !== "string" ||
    !/^https?:\/\//.test(value.url) ||
    typeof value.username !== "string" ||
    typeof value.password !== "string"
  ) {
    return 'push: null or {"url": "http(s)://…", "username": "…", "password": "…"}'
  }
  return { url: value.url, username: value.username, password: value.password }
}

const parseUser = (body: unknown): Partial<ApiUser> | string => {
  if (!isRecord(body) || typeof body.clientId !== "string" || !body.clientId) {
    return 'expected {"clientId", "secret"?, "privileges"?, "practiceId"?, "vendorId"?, "userGroup"?}'
  }
  const user: Partial<ApiUser> = { clientId: body.clientId }
  if (body.secret !== undefined) {
    if (typeof body.secret !== "string" || !body.secret) return "secret: non-empty string"
    user.secret = body.secret
  }
  if (body.privileges !== undefined) {
    if (!Array.isArray(body.privileges) || body.privileges.some((p) => typeof p !== "string")) {
      return "privileges: string[]"
    }
    user.privileges = body.privileges as string[]
  }
  for (const key of ["practiceId", "vendorId", "userId"] as const) {
    if (body[key] === undefined) continue
    if (typeof body[key] !== "number") return `${key}: number`
    user[key] = body[key] as number
  }
  if (body.userGroup !== undefined) {
    if (body.userGroup !== "api-practice" && body.userGroup !== "api-pharmacy") {
      return "userGroup: api-practice or api-pharmacy"
    }
    user.userGroup = body.userGroup
  }
  return user
}

const parseTracking = (value: unknown): TrackingRecord | null | string => {
  if (value === undefined || value === null || value === false) return null
  if (value === true) return { trackingNumber: "1Z999AA10123456784", carrier: "UPS", service: null }
  if (!isRecord(value) || typeof value.trackingNumber !== "string" || !value.trackingNumber) {
    return 'tracking: true or {"trackingNumber", "carrier"?, "service"?}'
  }
  return {
    trackingNumber: value.trackingNumber,
    carrier: typeof value.carrier === "string" ? value.carrier : null,
    service: typeof value.service === "string" ? value.service : null,
  }
}

const orderIdParam = (raw: string | undefined) =>
  raw && /^\d+$/.test(raw) ? Number(raw) : undefined

export const createRuntime = (options: LifeFileV2RuntimeOptions = {}): LifeFileV2Runtime => {
  const hub = createWebhookHub({
    signer: basicPushSigner(),
    retryDelaysMs: options.push?.retryDelaysMs ?? PUSH_RETRY_DELAYS_MS,
    ...(options.push?.fetch ? { fetch: options.push.fetch } : {}),
  })
  const bootPush: PushTarget | null = options.push
    ? { url: options.push.url, username: options.push.username, password: options.push.password }
    : null

  const syncPush = (namespace: string, api: LifeFileV2API) => {
    const target = api.state.current().push
    const kept = hub.endpoints(namespace).filter((e) => e.id !== "lifefile_push")
    hub.setEndpoints(namespace, [
      ...kept,
      ...(target
        ? [
            {
              id: "lifefile_push",
              url: target.url,
              secret: `${target.username}:${target.password}`,
            },
          ]
        : []),
    ])
  }

  const adminControls: MockControls | undefined =
    options.latency === "none" || options.adminControls?.latency !== undefined
      ? options.adminControls
      : { ...(options.adminControls ?? {}), latency: RECORDED_LATENCY_CONTROL }

  const issued = new Map<string, number>()
  const tokenNonce = (namespace: string) => () => {
    const count = (issued.get(namespace) ?? 0) + 1
    issued.set(namespace, count)
    return opaqueToken(`lifefile-v2:nonce:${options.seed ?? ""}:${namespace}:${count}`, 22)
  }

  const runtime: ServiceRuntime<LifeFileV2API> = createServiceRuntime<LifeFileV2API>({
    name: LIFEFILE_V2_NAMESPACE,
    document,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminPrefix !== undefined ? { adminPrefix: options.adminPrefix } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(adminControls !== undefined ? { adminControls } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    ...(options.namespaceIdleMs !== undefined ? { namespaceIdleMs: options.namespaceIdleMs } : {}),
    ...(options.maxRecords !== undefined ? { maxRecords: options.maxRecords } : {}),
    ...(options.maxSnapshots !== undefined ? { maxSnapshots: options.maxSnapshots } : {}),
    ...(options.checkpointMutations !== undefined
      ? { checkpointMutations: options.checkpointMutations }
      : {}),
    credential: tokenCredential,
    presets: LIFEFILE_V2_PRESETS,
    webhooks: hub,
    onClockChange: (namespace) => {
      runtime.instance(namespace).runDue()
    },
    create: ({ sqlite, namespace, publicNamespace, clock }) => {
      const api: LifeFileV2API = new LifeFileV2API({
        sqlite,
        namespace,
        now: clock.now,
        tokenNonce: tokenNonce(namespace),
        settings: { ...(bootPush ? { push: bootPush } : {}), ...(options.settings ?? {}) },
        ...(options.apiUsers ? { apiUsers: options.apiUsers } : {}),
        ...(options.maxOrders !== undefined ? { maxOrders: options.maxOrders } : {}),
        ...(options.maxApiUsers !== undefined ? { maxApiUsers: options.maxApiUsers } : {}),
        onPush: ({ body, badCredentials }) => {
          syncPush(publicNamespace, api)
          hub.publish({
            namespace: publicNamespace,
            type: PUSH_EVENT,
            body,
            tags: { badCredentials: String(badCredentials) },
          })
        },
      })
      return api
    },
    describe: () => ({ corpus: CORPUS_VERSION, push: bootPush ? "on" : "off" }),
    admin: (rt) => adminRoutes(rt, syncPush),
  })
  return Object.assign(runtime, { webhooks: hub })
}

const seeded = (runtime: ServiceRuntime<LifeFileV2API>, namespace: string) => {
  const api = runtime.instance(namespace)
  api.state.seedIfNeeded()
  return api
}

const adminRoutes = (
  runtime: ServiceRuntime<LifeFileV2API>,
  syncPush: (namespace: string, api: LifeFileV2API) => void,
): AdminRoutes => ({
  "GET /orders": ({ namespace }) => {
    const api = seeded(runtime, namespace)
    return json(200, { orders: api.orders().map((order) => api.orderDto(order)) })
  },
  "POST /orders/:id/status": ({ namespace, params, body }) => {
    if (!isRecord(body) || typeof body.status !== "string" || !body.status) {
      return adminError(400, 'expected {"status": "<code>", "push"?: boolean}')
    }
    if (body.push !== undefined && typeof body.push !== "boolean")
      return adminError(400, "push: boolean")
    const id = orderIdParam(params.id)
    const api = seeded(runtime, namespace)
    if (id === undefined) return adminError(404, `no order ${params.id}`)
    const change = api.setStatus(id, body.status, { push: body.push !== false })
    if (typeof change === "string") return adminError(404, change)
    return json(200, api.orderDto(change.order))
  },
  "POST /orders/:id/push": ({ namespace, params, body }) => {
    const input = body === undefined || body === null ? {} : body
    if (!isRecord(input)) return adminError(400, 'expected {"tracking"?, "badCredentials"?}')
    const tracking = parseTracking(input.tracking)
    if (typeof tracking === "string") return adminError(400, tracking)
    if (input.badCredentials !== undefined && typeof input.badCredentials !== "boolean") {
      return adminError(400, "badCredentials: boolean")
    }
    const id = orderIdParam(params.id)
    const api = seeded(runtime, namespace)
    const order =
      id === undefined ? undefined : api.emitPush(id, tracking, input.badCredentials === true)
    if (!order) return adminError(404, `no order ${params.id}`)
    return json(200, api.orderDto(order))
  },
  "POST /tokens/revoke": ({ namespace }) =>
    json(200, { tokenGeneration: seeded(runtime, namespace).revokeTokens() }),
  "GET /api-users": ({ namespace }) =>
    json(200, {
      apiUsers: seeded(runtime, namespace)
        .state.apiUsers.list({ order: "oldest" })
        .map(({ value: { secret: _secret, ...user } }) => user),
    }),
  "PUT /api-users": ({ namespace, body }) => {
    const parsed = parseUser(body)
    if (typeof parsed === "string") return adminError(400, parsed)
    const state = seeded(runtime, namespace).state
    const existing = state.user(parsed.clientId as string)
    const user = existing
      ? state.saveUser({
          ...existing,
          ...parsed,
          ...(parsed.secret && parsed.secret !== existing.secret ? { secretIssuedAt: null } : {}),
        })
      : state.registerUser(parsed)
    const { secret: _secret, ...shown } = user
    return json(200, shown)
  },
  "POST /api-users/:clientId/expire-secret": ({ namespace, params }) => {
    const user = seeded(runtime, namespace).expireSecret(params.clientId ?? "")
    if (!user) return adminError(404, `no API user ${params.clientId}`)
    const { secret: _secret, ...shown } = user
    return json(200, shown)
  },
  "GET /settings": ({ namespace }) =>
    json(200, shownSettings(seeded(runtime, namespace).state.current())),
  "PUT /settings": ({ namespace, body }) => {
    if (!isRecord(body)) return adminError(400, "expected a JSON object")
    const api = seeded(runtime, namespace)
    const patch = parseSettings(body, api.state.current())
    if (typeof patch === "string") return adminError(400, patch)
    const next = api.state.update(patch)
    syncPush(namespace, api)
    return json(200, shownSettings(next))
  },
  "PUT /push": ({ namespace, body }) => {
    const push = parsePush(body ?? null)
    if (typeof push === "string") return adminError(400, push)
    const api = seeded(runtime, namespace)
    api.state.update({ push })
    syncPush(namespace, api)
    return json(200, { push: push ? { url: push.url, username: push.username } : null })
  },
})
