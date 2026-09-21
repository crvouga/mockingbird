import {
  type AdminRoutes,
  basicAuth,
  type Clock,
  createRuntime as createServiceRuntime,
  type FaultPreset,
  outboxAdminRoutes,
  type RequestLog,
  type ServiceRuntime,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { document } from "./generated/openapi.js"
import { type IngestInput, MAILOSAUR_NAMESPACE, MailosaurAPI } from "./index.js"
import type { Settings } from "./state.js"

/**
 * Every named Mailosaur misbehaviour worth testing against, switched on with
 * `POST /__admin/faults {"preset": "<name>"}` (add `count` to limit it).
 */
export const MAILOSAUR_PRESETS: Record<string, FaultPreset> = {
  auth_failed: {
    description: "Every API call answers 401 (the SDK raises authentication_error)",
    rules: [
      {
        pathPrefix: "/api/",
        status: 401,
        body: {
          type: "authentication_error",
          message: "Authentication failed, check your API key.",
        },
      },
    ],
  },
  rate_limited: {
    description: "Searches answer 429 (the SDK raises api_error)",
    rules: [
      {
        operationId: "SearchMessages",
        status: 429,
        body: { type: "rate_limit_exceeded", message: "Too many requests." },
      },
    ],
  },
  server_error: {
    description: "Every API call answers 500",
    rules: [
      {
        pathPrefix: "/api/",
        status: 500,
        body: { type: "api_error", message: "An unexpected error occurred." },
      },
    ],
  },
  search_never_matches: {
    description:
      "Searches find nothing even when mail has arrived, so `messages.get` times out (search_timeout)",
    rules: [{ operationId: "SearchMessages", effect: "search_never_matches" }],
  },
  slow_search: {
    description: "Searches take 2 s to answer",
    rules: [{ operationId: "SearchMessages", latencyMs: 2_000 }],
  },
}

export type MailosaurRuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  seed?: number | string
  adminKey?: string
  onLog?: (entry: RequestLog) => void
  settings?: Partial<Settings>
}

export type MailosaurRuntime = ServiceRuntime<MailosaurAPI>

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const adminError = (status: number, message: string) =>
  json(status, { error: { type: "mockingbird_admin", message } })
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const nullableText = (value: unknown) => (typeof value === "string" ? value : null)

/** Accept our own ingest shape and Resend's `POST /emails` shape (`reply_to`, tag objects…). */
const ingestInput = (body: Record<string, unknown>): IngestInput | string => {
  if (body.to === undefined)
    return 'expected {"to": "<address>" | [...], "from"?, "subject"?, "html"?, "text"?}'
  if (body.server !== undefined && (typeof body.server !== "string" || body.server === "")) {
    return "server: an 8-character server id"
  }
  if (body.type !== undefined && body.type !== "Email" && body.type !== "SMS") {
    return 'type: "Email" or "SMS"'
  }
  if (body.attachments !== undefined && !Array.isArray(body.attachments)) {
    return "attachments: [{filename, content (base64), contentType}]"
  }
  return {
    ...(typeof body.server === "string" ? { server: body.server } : {}),
    ...(body.type === "SMS" || body.type === "Email" ? { type: body.type } : {}),
    from: body.from,
    to: body.to,
    cc: body.cc,
    bcc: body.bcc,
    subject: typeof body.subject === "string" ? body.subject : null,
    html: nullableText(body.html),
    text: nullableText(body.text),
    headers: body.headers,
    ...(Array.isArray(body.attachments)
      ? {
          attachments: body.attachments.filter(isRecord) as NonNullable<IngestInput["attachments"]>,
        }
      : {}),
  }
}

const adminRoutes = (runtime: ServiceRuntime<MailosaurAPI>): AdminRoutes => ({
  "POST /ingest": ({ body, namespace }) => {
    if (!isRecord(body)) return adminError(400, "expected a JSON object")
    const input = ingestInput(body)
    if (typeof input === "string") return adminError(400, input)
    try {
      return json(201, runtime.instance(namespace).ingest(input))
    } catch (error) {
      return adminError(400, error instanceof Error ? error.message : String(error))
    }
  },
  ...outboxAdminRoutes(
    runtime,
    (api) => api.state.outbox,
    (params) => {
      const server = params.get("server")
      return server === null ? undefined : (item) => item.server === server || item.server === "*"
    },
  ),
  "GET /outbox/:id/links": ({ params, namespace }) => {
    const record = runtime.instance(namespace).state.outbox.get(params.id as string)
    if (!record) return adminError(404, `no message ${params.id}`)
    const { html, text } = record.message
    return json(200, {
      id: record.id,
      links: (html.links.length > 0 ? html.links : text.links).map((link) => link.href),
      codes: [...html.codes, ...text.codes].map((code) => code.value),
    })
  },
  "GET /settings": ({ namespace }) => json(200, runtime.instance(namespace).state.current()),
  "PUT /settings": ({ body, namespace }) => {
    if (!isRecord(body)) return adminError(400, "expected a JSON object")
    const patch: Partial<Settings> = {}
    if (body.pollDelaysMs !== undefined) {
      const delays = body.pollDelaysMs
      if (
        !Array.isArray(delays) ||
        delays.length === 0 ||
        delays.some((d) => typeof d !== "number" || !Number.isInteger(d) || d < 0)
      ) {
        return adminError(400, "pollDelaysMs: a non-empty list of whole milliseconds")
      }
      patch.pollDelaysMs = delays as number[]
    }
    return json(200, runtime.instance(namespace).state.update(patch))
  },
})

/**
 * The Mailosaur mock with Mockingbird's full service contract: `/health`, `/__admin/*`,
 * namespaces by header, by `/ns/<name>` path prefix, or by API key
 * (`PUT /__admin/credentials {"credentials": {"<MAILOSAUR_API_KEY>": "<namespace>"}}`),
 * clock control, fault presets, the ingest route and a request journal.
 */
export const createRuntime = (options: MailosaurRuntimeOptions = {}): MailosaurRuntime =>
  createServiceRuntime<MailosaurAPI>({
    name: MAILOSAUR_NAMESPACE,
    document,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    credential: (request) => basicAuth(request)?.username || undefined,
    presets: MAILOSAUR_PRESETS,
    create: ({ sqlite, namespace, clock }) =>
      new MailosaurAPI({
        sqlite,
        namespace,
        now: clock.now,
        ...(options.settings ? { settings: options.settings } : {}),
      }),
    admin: adminRoutes,
  })
