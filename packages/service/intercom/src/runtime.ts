import {
  type AdminRoutes,
  bearerToken,
  type Clock,
  createRuntime as createServiceRuntime,
  createWebhookHub,
  type FaultPreset,
  hmac,
  type RequestLog,
  type ServiceRuntime,
  signers,
  type WebhookEndpoint,
  type WebhookHub,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { document } from "./generated/openapi.js"
import { INTERCOM_NAMESPACE, IntercomAPI, IntercomError } from "./index.js"
import { toHtml } from "./query.js"
import type { AdminRecord, Settings } from "./state.js"

/** The header Intercom signs webhooks with (our receivers read it lower-cased). */
export const HUB_SIGNATURE_HEADER = "X-Hub-Signature"

/** `sha1=<hex HMAC-SHA1(secret, rawBody)>`, Intercom's webhook signature. */
export const signHub = async (secret: string, body: string): Promise<string> =>
  `sha1=${await hmac("SHA-1", secret, body, "hex")}`

/** The topics a webhook endpoint receives unless it lists its own `events`. */
const DEFAULT_TOPICS = [
  "conversation.admin.replied",
  "conversation.admin.closed",
  "conversation.admin.opened",
  "conversation.admin.single.created",
]

const errorBody = (code: string, message: string) => ({
  type: "error.list",
  request_id: "req_mockingbird_fault",
  errors: [{ code, message }],
})

/**
 * Every named Intercom misbehaviour our consumers branch on, switched on with
 * `POST /__admin/faults {"preset": "<name>"}` (add `count` to limit it).
 */
export const INTERCOM_PRESETS: Record<string, FaultPreset> = {
  rate_limited: {
    description:
      "Every call answers 429 rate_limit_exceeded (the messaging adapter maps it to 429)",
    rules: [
      {
        status: 429,
        body: errorBody("rate_limit_exceeded", "Rate Limit Exceeded"),
        headers: { "X-RateLimit-Limit": "10000", "X-RateLimit-Remaining": "0" },
      },
    ],
  },
  server_error: {
    description: "Every call answers 500 (the messaging adapter throws)",
    rules: [{ status: 500, body: errorBody("server_error", "Server Error") }],
  },
  service_unavailable: {
    description: "Every call answers 503",
    rules: [{ status: 503, body: errorBody("service_unavailable", "Service Unavailable") }],
  },
  unauthorized: {
    description: "Every call answers 401 unauthorized",
    rules: [{ status: 401, body: errorBody("unauthorized", "Access Token Invalid") }],
  },
  contact_stale_404: {
    description:
      "The next conversation search answers 404, as when a cached contact id went stale: the adapter re-resolves the contact and retries once",
    rules: [
      {
        operationId: "SearchConversations",
        status: 404,
        body: errorBody("not_found", "User Not Found"),
        count: 1,
      },
    ],
  },
  search_unavailable: {
    description: "Conversation search answers `conversations: null` (the admin inbox answers 503)",
    rules: [{ operationId: "SearchConversations", effect: "search_unavailable" }],
  },
  repeated_cursor: {
    description:
      "Conversation search always answers the same next cursor (the admin inbox detects the loop and answers 503)",
    rules: [{ operationId: "SearchConversations", effect: "repeated_cursor" }],
  },
  webhook_duplicate: {
    description: "The next webhook is delivered twice (receivers dedupe on the notification id)",
    webhook: { mode: "duplicate" },
  },
  webhook_reorder: {
    description: "The next two webhooks arrive swapped",
    webhook: { mode: "reorder" },
  },
  webhook_drop: {
    description: "The next webhook is never delivered",
    webhook: { mode: "drop" },
  },
}

export type IntercomRuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  seed?: number | string
  adminKey?: string
  onLog?: (entry: RequestLog) => void
  admins?: readonly AdminRecord[]
  settings?: Partial<Settings>
  /**
   * Where webhooks go: the backend's `POST /messaging/webhook` and the EMR's
   * `POST /v1/webhooks/intercom`, signed with `secret` (the app's `INTERCOM_WEBHOOK_SECRET`).
   */
  webhooks?: {
    urls: readonly string[]
    secret?: string
    /** Topics to deliver; default the admin replied/closed/opened/single.created topics. */
    events?: readonly string[]
    retryDelaysMs?: readonly number[]
    fetch?: (request: Request) => Promise<Response>
  }
}

export type IntercomRuntime = ServiceRuntime<IntercomAPI> & { readonly webhooks: WebhookHub }

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const adminError = (status: number, message: string) =>
  json(status, { error: { type: "mockingbird_admin", message } })
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const guard = (run: () => Response): Response => {
  try {
    return run()
  } catch (error) {
    if (error instanceof IntercomError) return adminError(error.status, error.message)
    throw error
  }
}

const adminRoutes = (runtime: ServiceRuntime<IntercomAPI>): AdminRoutes => {
  const api = (namespace: string) => runtime.instance(namespace)
  const conversation = (namespace: string, id: string) => api(namespace).state.conversations.get(id)
  const defaultAdmin = (namespace: string) =>
    api(namespace).state.admins.list({ order: "oldest" }).at(0)?.value.id ?? ""
  return {
    "GET /contacts": ({ namespace }) => json(200, { contacts: api(namespace).contacts() }),
    "GET /conversations": ({ namespace }) =>
      json(200, { conversations: api(namespace).conversations() }),
    "POST /conversations": ({ body, namespace }) =>
      guard(() => {
        if (!isRecord(body) || typeof body.body !== "string") {
          return adminError(400, 'expected {"contactId" | "externalId", "adminId"?, "body"}')
        }
        const state = api(namespace).state
        const contactId =
          typeof body.contactId === "string"
            ? body.contactId
            : typeof body.externalId === "string"
              ? state.findContact((c) => c.external_id === body.externalId)?.id
              : undefined
        if (!contactId) return adminError(404, "no such contact")
        const created = api(namespace).startAdminConversation({
          contactId,
          adminId: typeof body.adminId === "string" ? body.adminId : defaultAdmin(namespace),
          body: body.body,
        })
        return json(201, created)
      }),
    "POST /conversations/:id/admin-reply": ({ params, body, namespace }) =>
      guard(() => {
        const found = conversation(namespace, params.id as string)
        if (!found) return adminError(404, `no conversation ${params.id}`)
        if (!isRecord(body) || typeof body.body !== "string") {
          return adminError(
            400,
            'expected {"adminId"?, "body", "messageType"?: "comment" | "note"}',
          )
        }
        const instance = api(namespace)
        const author = instance.state.admins.get(
          typeof body.adminId === "string" ? body.adminId : defaultAdmin(namespace),
        )
        if (!author) return adminError(404, `no admin ${String(body.adminId)}`)
        const next = instance.appendPart(found, {
          partType: body.messageType === "note" ? "note" : "comment",
          author: { type: "admin", id: author.id, name: author.name, email: author.email },
          body: toHtml(body.body),
        })
        return json(200, next)
      }),
    "POST /conversations/:id/close": ({ params, body, namespace }) =>
      guard(() => {
        const found = conversation(namespace, params.id as string)
        if (!found) return adminError(404, `no conversation ${params.id}`)
        const adminId =
          isRecord(body) && typeof body.adminId === "string"
            ? body.adminId
            : defaultAdmin(namespace)
        return json(200, api(namespace).manage(found, { action: "close", adminId }))
      }),
    "POST /conversations/:id/open": ({ params, body, namespace }) =>
      guard(() => {
        const found = conversation(namespace, params.id as string)
        if (!found) return adminError(404, `no conversation ${params.id}`)
        const adminId =
          isRecord(body) && typeof body.adminId === "string"
            ? body.adminId
            : defaultAdmin(namespace)
        return json(200, api(namespace).manage(found, { action: "open", adminId }))
      }),
    "PUT /admins": ({ body, namespace }) => {
      const list = Array.isArray(body) ? body : isRecord(body) ? body.admins : undefined
      if (!Array.isArray(list) || !list.every((a) => isRecord(a) && typeof a.id === "string")) {
        return adminError(400, "expected [{id, name, email}, …]")
      }
      const state = api(namespace).state
      for (const row of state.admins.list()) state.admins.delete(row.id)
      for (const each of list as Record<string, unknown>[]) {
        state.admins.insert(String(each.id), {
          type: "admin",
          id: String(each.id),
          name: String(each.name ?? `Admin ${each.id}`),
          email: String(each.email ?? `admin${each.id}@mock.intercom.local`),
          job_title: typeof each.job_title === "string" ? each.job_title : null,
          away_mode_enabled: each.away_mode_enabled === true,
          away_mode_reassign: false,
          has_inbox_seat: true,
          team_ids: [],
        })
      }
      return json(200, { admins: state.admins.list({ order: "oldest" }).map((row) => row.value) })
    },
    "GET /settings": ({ namespace }) => json(200, api(namespace).state.current()),
    "PUT /settings": ({ body, namespace }) => {
      if (!isRecord(body)) return adminError(400, "expected a JSON object")
      const patch: Partial<Settings> = {}
      if (body.tokens !== undefined) {
        if (!Array.isArray(body.tokens)) return adminError(400, "tokens: string[]")
        patch.tokens = body.tokens.map(String)
      }
      if (body.customAttributes !== undefined) {
        if (body.customAttributes !== null && !Array.isArray(body.customAttributes)) {
          return adminError(400, "customAttributes: string[] | null")
        }
        patch.customAttributes =
          body.customAttributes === null ? null : body.customAttributes.map(String)
      }
      return json(200, api(namespace).state.update(patch))
    },
  }
}

/**
 * The Intercom mock with Mockingbird's full service contract: `/health`, `/__admin/*`,
 * namespaces by header, by `/ns/<name>` path prefix, or by access token
 * (`PUT /__admin/credentials {"credentials": {"<INTERCOM_ACCESS_TOKEN>": "<namespace>"}}`),
 * clock control, fault presets, `X-Hub-Signature`-signed webhooks and a request journal
 * (metadata only: never message bodies).
 */
export const createRuntime = (options: IntercomRuntimeOptions = {}): IntercomRuntime => {
  const hooks = options.webhooks
  const hub = createWebhookHub({
    signer: signers.custom(async ({ body, secret }) =>
      secret ? { [HUB_SIGNATURE_HEADER]: await signHub(secret, body) } : {},
    ),
    ...(hooks?.retryDelaysMs ? { retryDelaysMs: hooks.retryDelaysMs } : {}),
    ...(hooks?.fetch ? { fetch: hooks.fetch } : {}),
    endpoints: (hooks?.urls ?? []).map(
      (url, index): WebhookEndpoint => ({
        id: `we_intercom_${index}`,
        url,
        ...(hooks?.secret ? { secret: hooks.secret } : {}),
        events: [...(hooks?.events ?? DEFAULT_TOPICS)],
      }),
    ),
  })
  const runtime = createServiceRuntime<IntercomAPI>({
    name: INTERCOM_NAMESPACE,
    document,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    credential: bearerToken,
    presets: INTERCOM_PRESETS,
    webhooks: hub,
    create: ({ sqlite, namespace, publicNamespace, clock }) =>
      new IntercomAPI({
        sqlite,
        namespace,
        now: clock.now,
        ...(options.admins ? { admins: options.admins } : {}),
        ...(options.settings ? { settings: options.settings } : {}),
        onWebhook: (notification) =>
          hub.publish({
            namespace: publicNamespace,
            type: notification.topic,
            body: notification as unknown as Record<string, unknown>,
            id: notification.id,
          }),
      }),
    describe: () => ({ webhooks: hub.endpoints("default").length > 0 ? "on" : "off" }),
    admin: adminRoutes,
  })
  return Object.assign(runtime, { webhooks: hub })
}
