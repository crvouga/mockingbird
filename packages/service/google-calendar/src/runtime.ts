import {
  type AdminRoutes,
  type Clock,
  createRuntime as createServiceRuntime,
  createWebhookHub,
  type FaultPreset,
  type RequestLog,
  type ServiceRuntime,
  signers,
  type WebhookHub,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { document } from "./generated/openapi.js"
import {
  accessTokenCredential,
  GOOGLE_CALENDAR_NAMESPACE,
  GoogleCalendarAPI,
  type PushNotification,
} from "./index.js"
import type { Settings, UserRecord } from "./state.js"

/** The `X-Goog-*` headers of one push notification (Google sends an empty body). */
export const pushHeaders = (push: PushNotification): Record<string, string> => ({
  "x-goog-channel-id": push.channel.id,
  "x-goog-channel-expiration": new Date(push.channel.expirationMs).toUTCString(),
  ...(push.channel.token ? { "x-goog-channel-token": push.channel.token } : {}),
  "x-goog-message-number": String(push.messageNumber),
  "x-goog-resource-id": push.channel.resourceId,
  "x-goog-resource-state": push.state,
  "x-goog-resource-uri": push.channel.resourceUri,
})

const quota = (
  code: number,
  reason: string,
  message: string,
  status: string,
  domain = "usageLimits",
) => ({
  status: code,
  body: { error: { errors: [{ domain, reason, message }], code, message, status } },
})

/**
 * Every Google failure our calendar sync branches on, switched on with
 * `POST /__admin/faults {"preset": "<name>"}` (add `count` to limit it). googleapis retries 429
 * and 5xx on its own (gaxios), so use a `count` above its retry budget to surface one.
 */
export const GOOGLE_CALENDAR_PRESETS: Record<string, FaultPreset> = {
  invalid_grant: {
    description: "The token endpoint answers 400 invalid_grant (refresh token expired or revoked)",
    rules: [{ operationId: "OAuthToken", effect: "invalid_grant" }],
  },
  token_expired: {
    description: "Calendar and userinfo calls answer 401 as if the access token expired",
    rules: [
      { pathPrefix: "/calendar/v3/", effect: "token_expired" },
      { pathPrefix: "/oauth2/v3/userinfo", effect: "token_expired" },
    ],
  },
  rate_limited: {
    description: "Calendar calls answer 403 rateLimitExceeded",
    rules: [
      {
        pathPrefix: "/calendar/v3/",
        ...quota(403, "rateLimitExceeded", "Rate Limit Exceeded", "PERMISSION_DENIED"),
      },
    ],
  },
  too_many_requests: {
    description: "Calendar calls answer 429 rateLimitExceeded",
    rules: [
      {
        pathPrefix: "/calendar/v3/",
        ...quota(429, "rateLimitExceeded", "Rate Limit Exceeded", "RESOURCE_EXHAUSTED"),
      },
    ],
  },
  calendar_api_disabled: {
    description:
      "Calendar calls answer 403 accessNotConfigured (the API is disabled for the project)",
    rules: [
      {
        pathPrefix: "/calendar/v3/",
        ...quota(
          403,
          "accessNotConfigured",
          "Google Calendar API has not been used in project 000000000000 before or it is disabled.",
          "PERMISSION_DENIED",
          "usageLimits",
        ),
      },
    ],
  },
  insufficient_scopes: {
    description: "Calendar calls answer 403 insufficient authentication scopes",
    rules: [
      {
        pathPrefix: "/calendar/v3/",
        ...quota(
          403,
          "insufficientPermissions",
          "Request had insufficient authentication scopes.",
          "PERMISSION_DENIED",
          "global",
        ),
      },
    ],
  },
  sync_token_gone: {
    description: "events.list with a syncToken answers 410 fullSyncRequired",
    rules: [{ operationId: "EventsList", effect: "sync_token_gone" }],
  },
  backend_error: {
    description: "Calendar calls answer 503 backendError",
    rules: [
      {
        pathPrefix: "/calendar/v3/",
        ...quota(503, "backendError", "Backend Error", "UNAVAILABLE", "global"),
      },
    ],
  },
  connection_drop: {
    description: "The connection drops before any answer (fetch rejects)",
    rules: [{ pathPrefix: "/calendar/v3/", drop: true }],
  },
  push_duplicate: {
    description: "The next push notification is delivered twice",
    webhook: { mode: "duplicate" },
  },
  push_drop: {
    description: "The next push notification is never delivered",
    webhook: { mode: "drop" },
  },
}

export type GoogleCalendarRuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  seed?: number | string
  adminKey?: string
  onLog?: (entry: RequestLog) => void
  settings?: Partial<Settings>
  /** Push delivery: retry schedule and transport (default: global fetch, Google-like backoff). */
  push?: { retryDelaysMs?: readonly number[]; fetch?: (request: Request) => Promise<Response> }
}

export type GoogleCalendarRuntime = ServiceRuntime<GoogleCalendarAPI> & {
  readonly webhooks: WebhookHub
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const adminError = (status: number, message: string) =>
  json(status, { error: { type: "mockingbird_admin", message } })
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const adminRoutes = (runtime: ServiceRuntime<GoogleCalendarAPI>): AdminRoutes => {
  const calendarOf = (api: GoogleCalendarAPI, body: Record<string, unknown>) =>
    typeof body.email === "string"
      ? api.resolveCalendar(
          body.email,
          typeof body.calendarId === "string" ? body.calendarId : "primary",
        )
      : undefined
  const guard = (run: () => Response): Response => {
    try {
      return run()
    } catch (error) {
      if (error instanceof Error && "toResponse" in error) {
        return (error as unknown as { toResponse(): Response }).toResponse()
      }
      throw error
    }
  }
  return {
    "PUT /users/:email": ({ params, body, namespace }) => {
      if (!isRecord(body))
        return adminError(400, "expected a userinfo profile {name, given_name, …}")
      const api = runtime.instance(namespace)
      const email = decodeURIComponent(params.email as string)
      const profile: UserRecord = { ...api.user(email), ...(body as Partial<UserRecord>), email }
      api.state.users.insert(email, profile)
      api.ensurePrimary(email)
      return json(200, profile)
    },
    "GET /events": ({ url, namespace }) =>
      json(200, {
        events: runtime.instance(namespace).events(url.searchParams.get("email") ?? undefined),
      }),
    "POST /events": ({ body, namespace }) => {
      if (!isRecord(body) || !isRecord(body.event)) {
        return adminError(
          400,
          'expected {"email", "calendarId"?, "event": {summary, start, end, …}}',
        )
      }
      const api = runtime.instance(namespace)
      const calendar = calendarOf(api, body)
      if (!calendar) return adminError(404, "no such calendar for that email")
      return guard(() =>
        json(201, api.createEvent(calendar, body.event as Record<string, unknown>)),
      )
    },
    "PUT /events/:id": ({ params, body, namespace }) => {
      if (!isRecord(body) || !isRecord(body.event)) {
        return adminError(400, 'expected {"email", "calendarId"?, "event": {…full event…}}')
      }
      const api = runtime.instance(namespace)
      const calendar = calendarOf(api, body)
      const stored = calendar ? api.findEvent(calendar.id, params.id as string) : undefined
      if (!stored) return adminError(404, `no event ${params.id}`)
      return guard(() => json(200, api.updateEvent(stored, body.event as Record<string, unknown>)))
    },
    "DELETE /events/:id": ({ params, url, namespace }) => {
      const api = runtime.instance(namespace)
      const email = url.searchParams.get("email") ?? ""
      const calendar = api.resolveCalendar(email, url.searchParams.get("calendarId") ?? "primary")
      const stored = calendar ? api.findEvent(calendar.id, params.id as string) : undefined
      if (!stored) return adminError(404, `no event ${params.id}`)
      return guard(() => {
        api.deleteEvent(stored)
        return json(200, { deleted: true })
      })
    },
    "GET /channels": ({ namespace }) =>
      json(200, { channels: runtime.instance(namespace).channels() }),
    "POST /sync-tokens/invalidate": ({ namespace }) =>
      json(200, runtime.instance(namespace).invalidateSyncTokens()),
    "GET /settings": ({ namespace }) => json(200, runtime.instance(namespace).state.current()),
    "PUT /settings": ({ body, namespace }) => {
      if (!isRecord(body)) return adminError(400, "expected a JSON object")
      const patch: Partial<Settings> = {}
      if (body.clients !== undefined) {
        if (!Array.isArray(body.clients))
          return adminError(400, "clients: [{clientId, clientSecret}]")
        patch.clients = body.clients.filter(isRecord).map((c) => ({
          clientId: String(c.clientId),
          clientSecret: String(c.clientSecret),
        }))
      }
      for (const key of ["tokenTtlSeconds", "maxChannelTtlSeconds"] as const) {
        if (body[key] !== undefined) {
          if (typeof body[key] !== "number") return adminError(400, `${key}: number`)
          patch[key] = body[key] as number
        }
      }
      if (body.requireHttpsWebhooks !== undefined) {
        if (typeof body.requireHttpsWebhooks !== "boolean")
          return adminError(400, "requireHttpsWebhooks: boolean")
        patch.requireHttpsWebhooks = body.requireHttpsWebhooks
      }
      if (body.scope !== undefined) {
        if (typeof body.scope !== "string") return adminError(400, "scope: string")
        patch.scope = body.scope
      }
      return json(200, runtime.instance(namespace).state.update(patch))
    },
  }
}

/**
 * The Google Calendar + OAuth mock with Mockingbird's full service contract: `/health`,
 * `/__admin/*`, namespaces by header, by `/ns/<name>` path prefix, or by account (access
 * tokens carry their email: `PUT /__admin/credentials {"credentials": {"<email>": "<ns>"}}`),
 * clock control, fault presets, push notifications to each channel's address, and a journal.
 */
export const createRuntime = (
  options: GoogleCalendarRuntimeOptions = {},
): GoogleCalendarRuntime => {
  const hub = createWebhookHub({
    // Google retries failed pushes with exponential backoff.
    retryDelaysMs: options.push?.retryDelaysMs ?? [0, 1_000, 10_000, 60_000, 600_000],
    ...(options.push?.fetch ? { fetch: options.push.fetch } : {}),
    signer: signers.none(),
  })
  const runtime = createServiceRuntime<GoogleCalendarAPI>({
    name: GOOGLE_CALENDAR_NAMESPACE,
    document,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    credential: accessTokenCredential,
    presets: GOOGLE_CALENDAR_PRESETS,
    webhooks: hub,
    create: ({ sqlite, namespace, publicNamespace, clock }) =>
      new GoogleCalendarAPI({
        sqlite,
        namespace,
        now: clock.now,
        ...(options.settings ? { settings: options.settings } : {}),
        onChannels: (channels) =>
          hub.setEndpoints(
            publicNamespace,
            channels.map((c) => ({
              id: `channel:${c.id}`,
              url: c.address,
              tags: { channel: c.id },
            })),
          ),
        onPush: (push) => {
          const id = `${push.channel.id}:${push.messageNumber}`
          hub.publish({
            namespace: publicNamespace,
            type: `calendar.push.${push.state}`,
            body: "",
            contentType: "application/json; charset=UTF-8",
            tags: { channel: push.channel.id },
            headers: pushHeaders(push),
            id,
          })
        },
      }),
    admin: adminRoutes,
  })
  return Object.assign(runtime, { webhooks: hub })
}
