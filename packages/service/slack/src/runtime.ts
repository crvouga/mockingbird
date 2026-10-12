import {
  type AdminRoutes,
  type Clock,
  createRuntime as createServiceRuntime,
  type FaultPreset,
  type MockControls,
  type OutboxItem,
  type OutboxStore,
  outboxAdminRoutes,
  type RequestLog,
  type ServiceRuntime,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { document } from "./generated/openapi.js"
import type { SlackAPIOptions } from "./index.js"
import { SLACK_NAMESPACE, SlackAPI, slackCredential } from "./index.js"
import { disconnectSockets, listSocketConnections } from "./sockets.js"
import type { Settings, SlackChannel, SlackFile, SlackUser } from "./state.js"

/**
 * Every named Slack misbehaviour our consumers branch on, switched on with
 * `POST /__admin/faults {"preset": "<name>"}` (add `count` to limit it, `params` to tune it).
 */
export const SLACK_PRESETS: Record<string, FaultPreset> = {
  rate_limited: {
    description:
      "Webhooks answer 429 rate_limited and the Web API 429 {ok:false, error:ratelimited}, both with retry-after (params.retryAfter seconds, default 1)",
    rules: [{ effect: "rate_limited", params: { retryAfter: 1 } }],
  },
  "5xx": {
    description:
      "Every call answers 500 internal_error (params.status 503 gives service_unavailable); our clients retry these",
    rules: [{ effect: "server_error", params: { status: 500 } }],
  },
  service_unavailable: {
    description: "Every call answers 503 service_unavailable",
    rules: [{ effect: "server_error", params: { status: 503 } }],
  },
  channel_not_found: {
    description:
      "Webhooks answer 404 channel_not_found; Web API channel methods answer {ok:false, error:channel_not_found}",
    rules: [{ effect: "channel_not_found" }],
  },
  no_service: {
    description: "Webhooks answer 404 no_service (the hook was revoked): a terminal 4xx",
    rules: [{ operationId: "PostIncomingWebhook", effect: "no_service" }],
  },
  invalid_auth: {
    description: "Web API calls answer {ok:false, error:invalid_auth} (the bot token was revoked)",
    rules: [{ pathPrefix: "/api/", effect: "invalid_auth" }],
  },
  connections_open_invalid_auth: {
    description:
      "apps.connections.open answers {ok:false, error:invalid_auth} and does not mint a ticket",
    rules: [{ operationId: "AppsConnectionsOpen", effect: "connections_open_invalid_auth" }],
  },
  connections_open_429: {
    description:
      "apps.connections.open answers 429 {ok:false, error:ratelimited} with retry-after (params.retryAfter seconds, default 1)",
    rules: [
      {
        operationId: "AppsConnectionsOpen",
        effect: "connections_open_429",
        params: { retryAfter: 1 },
      },
    ],
  },
  connections_open_5xx: {
    description:
      "apps.connections.open answers 500 internal_error (params.status 503 gives service_unavailable)",
    rules: [
      {
        operationId: "AppsConnectionsOpen",
        effect: "connections_open_5xx",
        params: { status: 500 },
      },
    ],
  },
  socket_close_after_hello: {
    description: "The next Socket Mode WebSocket sends hello, then a normal close frame",
    rules: [{ operationId: "AppsConnectionsOpen", effect: "socket_close_after_hello" }],
  },
  socket_abnormal_close: {
    description:
      "The next Socket Mode WebSocket sends hello, then drops the TCP connection (close code 1006)",
    rules: [{ operationId: "AppsConnectionsOpen", effect: "socket_abnormal_close" }],
  },
  socket_hello_latency: {
    description:
      "Delay the Socket Mode hello frame by params.latencyMs (default 0). The HTTP response is not delayed",
    rules: [
      {
        operationId: "AppsConnectionsOpen",
        effect: "socket_hello_latency",
        params: { latencyMs: 0 },
      },
    ],
  },
}

export type SlackRuntimeOptions = Pick<SlackAPIOptions, "fixtures" | "baseUrl" | "tokens"> & {
  sqlite?: SqliteClient
  clock?: Clock
  seed?: number | string
  adminPrefix?: string
  adminKey?: string
  /** Admin controls to boot with: clock, latency, faults, seed, a starting snapshot. */
  adminControls?: MockControls
  onLog?: (entry: RequestLog) => void
  settings?: Partial<Settings>
}

export type SlackRuntime = ServiceRuntime<SlackAPI>

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const adminError = (status: number, message: string) =>
  json(status, { error: { type: "mockingbird_admin", message } })
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const list = (body: unknown, key: string): unknown[] | undefined =>
  Array.isArray(body) ? body : isRecord(body) && Array.isArray(body[key]) ? body[key] : undefined

/** `/services/T/B/X`, `T/B/X`, or a full hooks.slack.com URL, as the `T/B/X` suffix. */
const hookSuffix = (value: string): string => {
  let path = value
  try {
    if (/^https?:\/\//.test(value)) path = new URL(value).pathname
  } catch {
    // Not a URL: use as-is.
  }
  return path
    .replace(/^\/?ns\/[^/]+/, "")
    .replace(/^\/?services\//, "")
    .replace(/^\/|\/$/g, "")
}

const outboxFilter = (params: URLSearchParams) => {
  const webhook = params.get("webhook")
  const channel = params.get("channel")
  const thread = params.get("thread_ts")
  const source = params.get("source")
  if (webhook === null && channel === null && thread === null && source === null) return undefined
  return (item: Record<string, unknown>) => {
    if (webhook !== null && item.webhook !== `/services/${hookSuffix(webhook)}`) return false
    if (channel !== null) {
      const wanted = channel.toLowerCase().replace(/^#/, "")
      const recipients = (item.to as string[]).map((t) => t.toLowerCase().replace(/^#/, ""))
      if (!recipients.includes(wanted)) return false
    }
    if (thread !== null && item.thread_ts !== thread) return false
    if (source !== null && item.source !== source) return false
    return true
  }
}

const adminRoutes = (runtime: ServiceRuntime<SlackAPI>): AdminRoutes => ({
  ...outboxAdminRoutes(
    runtime,
    (api) => api.state.outbox as unknown as OutboxStore<OutboxItem>,
    outboxFilter,
  ),
  "GET /hooks": ({ namespace }) =>
    json(200, {
      hooks: runtime
        .instance(namespace)
        .state.hooks.list({ order: "oldest" })
        .map((row) => ({ ...row.value, url: `/services/${row.value.path}` })),
    }),
  "POST /hooks": ({ body, namespace }) => {
    const entries = list(body, "hooks") ?? (isRecord(body) ? [body] : undefined)
    if (!entries || entries.some((e) => !isRecord(e) || typeof e.path !== "string")) {
      return adminError(400, 'expected {"path": "T…/B…/X…", "channel"?: "C…"} or {"hooks": [...]}')
    }
    const api = runtime.instance(namespace)
    const created = (entries as Record<string, unknown>[]).map((entry) => {
      const path = hookSuffix(entry.path as string)
      const hook = {
        path,
        channel: typeof entry.channel === "string" ? entry.channel : `/services/${path}`,
      }
      api.state.hooks.insert(path, hook)
      return { ...hook, url: `/services/${path}` }
    })
    return json(201, { hooks: created })
  },
  "DELETE /hooks": ({ namespace, url }) => {
    const api = runtime.instance(namespace)
    const only = url.searchParams.get("path")
    for (const row of api.state.hooks.list()) {
      if (only === null || row.id === hookSuffix(only)) api.state.hooks.delete(row.id)
    }
    return json(200, { status: "ok" })
  },
  "GET /channels": ({ namespace }) =>
    json(200, {
      channels: runtime
        .instance(namespace)
        .state.channels.list({ order: "oldest" })
        .map((r) => r.value),
    }),
  "POST /channels": ({ body, namespace }) => {
    const entries = list(body, "channels") ?? (isRecord(body) ? [body] : undefined)
    if (!entries || entries.some((e) => !isRecord(e) || typeof e.name !== "string")) {
      return adminError(
        400,
        'expected {"id"?, "name", "is_private"?, "is_archived"?, "is_member"?}',
      )
    }
    const api = runtime.instance(namespace)
    const saved = (entries as Record<string, unknown>[]).map((entry) => {
      const name = (entry.name as string).replace(/^#/, "").toLowerCase()
      const channel: SlackChannel = {
        id:
          typeof entry.id === "string"
            ? entry.id
            : `C${name.toUpperCase().replace(/[^A-Z0-9]/g, "")}`.slice(0, 11),
        name,
        is_private: entry.is_private === true,
        is_archived: entry.is_archived === true,
        is_member: entry.is_member !== false,
        created: Math.floor(runtime.namespaceClock(namespace).now() / 1000),
      }
      api.state.channels.insert(channel.id, channel)
      return channel
    })
    return json(201, { channels: saved })
  },
  "GET /users": ({ namespace }) =>
    json(200, {
      users: runtime
        .instance(namespace)
        .state.users.list({ order: "oldest" })
        .map((r) => r.value),
    }),
  "POST /users": ({ body, namespace }) => {
    const entries = list(body, "users") ?? (isRecord(body) ? [body] : undefined)
    if (!entries || entries.some((e) => !isRecord(e) || typeof e.id !== "string")) {
      return adminError(400, 'expected {"id": "U…", "name"?, "real_name"?, "email"?}')
    }
    const api = runtime.instance(namespace)
    const saved = (entries as Record<string, unknown>[]).map((entry) => {
      const id = entry.id as string
      const user: SlackUser = {
        id,
        name: typeof entry.name === "string" ? entry.name : id.toLowerCase(),
        real_name: typeof entry.real_name === "string" ? entry.real_name : id,
        email: typeof entry.email === "string" ? entry.email : null,
        is_bot: entry.is_bot === true,
        deleted: entry.deleted === true,
        tz: typeof entry.tz === "string" ? entry.tz : "America/Los_Angeles",
      }
      api.state.users.insert(id, user)
      return user
    })
    return json(201, { users: saved })
  },
  "POST /files": ({ body, namespace }) => {
    const entries = list(body, "files") ?? (isRecord(body) ? [body] : undefined)
    if (!entries || entries.some((e) => !isRecord(e) || typeof e.id !== "string")) {
      return adminError(400, 'expected {"id": "F…", "name"?, "mimetype"?, "size"?}')
    }
    const api = runtime.instance(namespace)
    const saved = (entries as Record<string, unknown>[]).map((entry) => {
      const id = entry.id as string
      const name = typeof entry.name === "string" ? entry.name : `${id}.bin`
      const file: SlackFile = {
        id,
        name,
        title: typeof entry.title === "string" ? entry.title : name,
        mimetype: typeof entry.mimetype === "string" ? entry.mimetype : "application/octet-stream",
        filetype: typeof entry.filetype === "string" ? entry.filetype : "binary",
        size: typeof entry.size === "number" ? entry.size : 0,
        created: Math.floor(runtime.namespaceClock(namespace).now() / 1000),
      }
      api.state.files.insert(id, file)
      return file
    })
    return json(201, { files: saved })
  },
  "GET /views": ({ namespace }) =>
    json(200, {
      views: runtime
        .instance(namespace)
        .state.views.list({ order: "oldest" })
        .map((r) => r.value),
    }),
  "GET /settings": ({ namespace }) => json(200, runtime.instance(namespace).state.current()),
  "PUT /settings": ({ body, namespace }) => {
    if (!isRecord(body)) return adminError(400, "expected a JSON object")
    const patch: Partial<Settings> = {}
    for (const key of [
      "teamId",
      "teamName",
      "teamDomain",
      "botUserId",
      "botId",
      "appId",
    ] as const) {
      if (body[key] === undefined) continue
      if (typeof body[key] !== "string") return adminError(400, `${key}: string`)
      patch[key] = body[key] as string
    }
    if (body.tokens !== undefined) {
      if (!Array.isArray(body.tokens)) return adminError(400, "tokens: string[]")
      patch.tokens = body.tokens.map(String)
    }
    if (body.strictChannels !== undefined) {
      if (typeof body.strictChannels !== "boolean")
        return adminError(400, "strictChannels: boolean")
      patch.strictChannels = body.strictChannels
    }
    for (const key of ["appTokens", "revokedAppTokens"] as const) {
      if (body[key] === undefined) continue
      const entries = body[key]
      if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string")) {
        return adminError(400, `${key}: string[]`)
      }
      patch[key] = entries.map(String)
    }
    if (body.socketLifetimeMs !== undefined) {
      if (
        body.socketLifetimeMs !== null &&
        (typeof body.socketLifetimeMs !== "number" || body.socketLifetimeMs < 0)
      ) {
        return adminError(400, "socketLifetimeMs: number | null")
      }
      patch.socketLifetimeMs = body.socketLifetimeMs
    }
    return json(200, runtime.instance(namespace).state.update(patch))
  },
  "GET /socket/connections": ({ namespace }) =>
    json(200, {
      connections: listSocketConnections(namespace).map((row) => ({
        namespace: row.namespace,
        appId: row.appId,
        ticket: row.ticket,
        connectedAt: row.connectedAt,
        state: row.state,
        reconnectCount: row.reconnectCount,
      })),
    }),
  "POST /socket/disconnect": ({ body, namespace }) => {
    const reason = isRecord(body) && typeof body.reason === "string" ? body.reason : "warning"
    if (reason !== "warning" && reason !== "refresh_requested" && reason !== "link_disabled") {
      return adminError(400, "reason must be warning, refresh_requested, or link_disabled")
    }
    const code = isRecord(body) && typeof body.code === "number" ? body.code : 1000
    return json(200, { closed: disconnectSockets(namespace, reason, code) })
  },
})

/**
 * The Slack mock with Mockingbird's full service contract: `/__admin/health`, `/__admin/*`, the outbox
 * (`GET /__admin/outbox?webhook=|channel=`), namespaces by header, by `/__admin/ns/<name>` path prefix,
 * or by credential (a bot token or a webhook's `T/B/X` path), clock control and fault presets.
 */
export const createRuntime = (options: SlackRuntimeOptions = {}): SlackRuntime =>
  createServiceRuntime<SlackAPI>({
    name: SLACK_NAMESPACE,
    document,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminPrefix !== undefined ? { adminPrefix: options.adminPrefix } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.adminControls !== undefined ? { adminControls: options.adminControls } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    credential: (request) => slackCredential(request, options.adminPrefix),
    presets: SLACK_PRESETS,
    create: ({ sqlite, namespace, publicNamespace, adminPrefix, clock, rng }) =>
      new SlackAPI({
        ...(options.fixtures ? { fixtures: options.fixtures } : {}),
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
        ...(options.tokens ? { tokens: options.tokens } : {}),
        sqlite,
        namespace,
        publicNamespace,
        adminPrefix,
        now: clock.now,
        random: rng.next,
        ...(options.settings ? { settings: options.settings } : {}),
      }),
    admin: adminRoutes,
  })
