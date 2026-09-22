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
import {
  DAILY_NAMESPACE,
  DailyAPI,
  type SessionInput,
  type TranscriptEntry,
  type TranscriptStore,
} from "./index.js"
import type { Settings } from "./state.js"

/** Where our EMR receives Daily webhooks. */
export const WEBHOOK_PATH = "/v1/webhooks/daily"

/**
 * Every named Daily misbehaviour our consumers branch on, switched on with
 * `POST /__admin/faults {"preset": "<name>"}` (add `count` to limit it).
 */
export const DAILY_PRESETS: Record<string, FaultPreset> = {
  room_not_found: {
    description:
      "Room calls answer 404 not-found (the EMR's `message.includes('404')` 'room no longer exists' branch)",
    rules: [{ pathPrefix: "/v1/rooms/", effect: "room_not_found" }],
  },
  unauthorized: {
    description: "Every call answers 401 authentication-error",
    rules: [
      {
        pathPrefix: "/v1/",
        status: 401,
        body: { error: "authentication-error", info: "Invalid API key" },
      },
    ],
  },
  rate_limited: {
    description: "Every call answers 429 rate-limit-error",
    rules: [
      {
        pathPrefix: "/v1/",
        status: 429,
        body: { error: "rate-limit-error", info: "Too many requests" },
      },
    ],
  },
  server_error: {
    description:
      "Every call answers 500 (EMR booking proceeds without video; backend queue retries)",
    rules: [
      {
        pathPrefix: "/v1/",
        status: 500,
        body: { error: "server-error", info: "Internal server error" },
      },
    ],
  },
  webhook_duplicate: {
    description: "The next webhook is delivered twice",
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

/**
 * Our EMR's scheme: `x-webhook-signature` = hex HMAC-SHA256(DAILY_WEBHOOK_SECRET, rawBody).
 * (Daily's documented scheme differs: base64 HMAC over `"<timestamp>.<body>"` with a
 * base64-decoded secret. See the README.) `x-webhook-timestamp` rides along.
 */
export const dailyWebhookSigner = signers.custom(async ({ body, secret, timestampSeconds }) =>
  secret
    ? {
        "x-webhook-signature": await hmac("SHA-256", secret, body, "hex"),
        "x-webhook-timestamp": String(timestampSeconds),
      }
    : {},
)

type WebhookDelivery = {
  retryDelaysMs?: readonly number[]
  fetch?: (request: Request) => Promise<Response>
}

export type DailyRuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  seed?: number | string
  adminKey?: string
  onLog?: (entry: RequestLog) => void
  settings?: Partial<Settings>
  /** Where webhooks go (`POST /v1/webhooks/daily`); `secret` is `DAILY_WEBHOOK_SECRET`. */
  webhooks?: Omit<WebhookEndpoint, "id"> & WebhookDelivery
  /** Where admin sessions write transcripts (the stack's s3rver). */
  transcripts?: TranscriptStore
}

export type DailyRuntime = ServiceRuntime<DailyAPI> & { readonly webhooks: WebhookHub }

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const adminError = (status: number, message: string) =>
  json(status, { error: { type: "mockingbird_admin", message } })
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const parseParticipants = (value: unknown) => {
  if (!Array.isArray(value)) return undefined
  const out: { userId: string; userName?: string; joinedAt?: string | number }[] = []
  for (const each of value) {
    if (!isRecord(each) || typeof each.userId !== "string") return undefined
    out.push({
      userId: each.userId,
      ...(typeof each.userName === "string" ? { userName: each.userName } : {}),
      ...(typeof each.joinedAt === "string" || typeof each.joinedAt === "number"
        ? { joinedAt: each.joinedAt }
        : {}),
    })
  }
  return out
}

const parseTranscript = (value: unknown): TranscriptEntry[] | undefined | string => {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) return "transcript must be [{s, t, ts, te}]"
  for (const each of value) {
    if (
      !isRecord(each) ||
      typeof each.s !== "string" ||
      typeof each.t !== "string" ||
      typeof each.ts !== "number" ||
      typeof each.te !== "number"
    ) {
      return "each transcript entry needs s (speaker userId), t (text), ts and te (seconds)"
    }
  }
  return value as TranscriptEntry[]
}

const adminRoutes = (runtime: ServiceRuntime<DailyAPI>): AdminRoutes => ({
  "GET /rooms": ({ namespace }) => json(200, { rooms: runtime.instance(namespace).rooms() }),
  "GET /rooms/:name": ({ params, namespace }) => {
    const room = runtime.instance(namespace).state.rooms.get(params.name as string)
    return room ? json(200, room) : adminError(404, `no room ${params.name}`)
  },
  "PUT /rooms/:name/presence": ({ params, body, namespace }) => {
    const participants = parseParticipants(isRecord(body) ? body.participants : undefined)
    if (!participants) {
      return adminError(400, 'expected {"participants": [{"userId", "userName"?, "joinedAt"?}]}')
    }
    const room = runtime.instance(namespace).setPresence(params.name as string, participants)
    return room ? json(200, room) : adminError(404, `no room ${params.name}`)
  },
  "POST /rooms/:name/session": async ({ params, body, namespace }) => {
    if (!isRecord(body)) return adminError(400, "expected a JSON object")
    const participants = parseParticipants(body.participants)
    if (!participants) return adminError(400, "participants: [{userId, userName?}]")
    if (typeof body.durationSec !== "number" || body.durationSec < 0) {
      return adminError(400, "durationSec: seconds")
    }
    const transcript = parseTranscript(body.transcript)
    if (typeof transcript === "string") return adminError(400, transcript)
    const input: SessionInput = {
      participants,
      durationSec: body.durationSec,
      ...(transcript ? { transcript } : {}),
      ...(typeof body.sessionId === "string" ? { sessionId: body.sessionId } : {}),
      ...(typeof body.recording === "boolean" ? { recording: body.recording } : {}),
    }
    try {
      const result = await runtime.instance(namespace).endSession(params.name as string, input)
      return result ? json(200, result) : adminError(404, `no room ${params.name}`)
    } catch (err) {
      return adminError(502, `transcript write failed: ${err instanceof Error ? err.message : err}`)
    }
  },
  "POST /tokens/decode": async ({ body, namespace, request }) => {
    if (!isRecord(body) || typeof body.token !== "string") {
      return adminError(400, 'expected {"token": "<jwt>", "apiKey"?: "<DAILY_API_KEY>"}')
    }
    const keys = [
      ...(typeof body.apiKey === "string" ? [body.apiKey] : []),
      ...(bearerToken(request) ? [bearerToken(request) as string] : []),
    ]
    return json(200, await runtime.instance(namespace).inspectToken(body.token, keys))
  },
  "GET /warnings": ({ namespace }) =>
    json(200, {
      warnings: runtime
        .instance(namespace)
        .state.warnings.list({ order: "oldest" })
        .map((row) => row.value),
    }),
  "GET /settings": ({ namespace }) => {
    const settings = runtime.instance(namespace).state.current()
    return json(200, { ...settings, apiKeys: settings.apiKeys.map(() => "***") })
  },
  "PUT /settings": ({ body, namespace }) => {
    if (!isRecord(body)) return adminError(400, "expected a JSON object")
    const patch: Partial<Settings> = {}
    if (body.apiKeys !== undefined) {
      if (!Array.isArray(body.apiKeys) || body.apiKeys.some((k) => typeof k !== "string")) {
        return adminError(400, "apiKeys: string[]")
      }
      patch.apiKeys = body.apiKeys as string[]
    }
    for (const field of ["domainId", "roomUrlBase"] as const) {
      if (body[field] !== undefined) {
        if (typeof body[field] !== "string") return adminError(400, `${field}: string`)
        patch[field] = body[field]
      }
    }
    const next = runtime.instance(namespace).state.update(patch)
    return json(200, { ...next, apiKeys: next.apiKeys.map(() => "***") })
  },
})

/**
 * The Daily mock with Mockingbird's full service contract: `/health`, `/__admin/*`, namespaces
 * by header, by `/ns/<name>` prefix on `DAILY_API_BASE_URL`, or by API key
 * (`PUT /__admin/credentials {"credentials": {"<DAILY_API_KEY>": "<namespace>"}}`), clock
 * control, fault presets, signed webhooks and a request journal.
 */
export const createRuntime = (options: DailyRuntimeOptions = {}): DailyRuntime => {
  const { retryDelaysMs, fetch: send, ...endpoint } = options.webhooks ?? { url: "" }
  const hub = createWebhookHub({
    signer: dailyWebhookSigner,
    ...(retryDelaysMs ? { retryDelaysMs } : {}),
    ...(send ? { fetch: send } : {}),
    endpoints: options.webhooks ? [endpoint as WebhookEndpoint] : [],
  })
  const runtime = createServiceRuntime<DailyAPI>({
    name: DAILY_NAMESPACE,
    document,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    credential: bearerToken,
    presets: DAILY_PRESETS,
    webhooks: hub,
    create: ({ sqlite, namespace, publicNamespace, clock }) =>
      new DailyAPI({
        sqlite,
        namespace,
        now: clock.now,
        ...(options.settings ? { settings: options.settings } : {}),
        ...(options.transcripts ? { transcripts: options.transcripts } : {}),
        onWebhook: (event) =>
          hub.publish({ namespace: publicNamespace, type: event.type, body: event, id: event.id }),
      }),
    describe: () => ({
      webhooks: hub.endpoints("default").length > 0 ? "on" : "off",
      transcripts: options.transcripts
        ? `${options.transcripts.endpoint}/${options.transcripts.bucket}`
        : "off",
    }),
    admin: adminRoutes,
  })
  return Object.assign(runtime, { webhooks: hub })
}
