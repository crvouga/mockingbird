import {
  type AdminRoutes,
  bearerToken,
  type Clock,
  createRuntime as createServiceRuntime,
  createWebhookHub,
  type FaultPreset,
  fromBase64,
  hmac,
  type MockControls,
  type RequestLog,
  type ServiceRuntime,
  signers,
  type WebhookEndpoint,
  type WebhookHub,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { dailyBrowserScript } from "./generated/browser-script.js"
import { document } from "./generated/openapi.js"
import {
  DAILY_NAMESPACE,
  DailyAPI,
  type SessionInput,
  type TranscriptEntry,
  type TranscriptFormat,
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
 * How webhook deliveries are signed: `hex` (default) is our EMR's scheme, `daily` is Daily's
 * documented one.
 */
export type DailyWebhookSignature = "hex" | "daily"

/**
 * Our EMR's scheme: `x-webhook-signature` = hex HMAC-SHA256(DAILY_WEBHOOK_SECRET, rawBody).
 * (Daily's documented scheme differs: see `dailyDocumentedWebhookSigner`.)
 * `x-webhook-timestamp` rides along.
 */
export const dailyWebhookSigner = signers.custom(async ({ body, secret, timestampSeconds }) =>
  secret
    ? {
        "x-webhook-signature": await hmac("SHA-256", secret, body, "hex"),
        "x-webhook-timestamp": String(timestampSeconds),
      }
    : {},
)

/**
 * Daily's documented scheme (docs.daily.co/reference/rest-api/webhooks, `hmac`):
 * `X-Webhook-Signature` = base64 HMAC-SHA256 over `"<X-Webhook-Timestamp>.<body>"`, keyed by
 * the base64-decoded secret. The timestamp is unix seconds (Daily does not document the unit).
 */
export const dailyDocumentedWebhookSigner = signers.custom(
  async ({ body, secret, timestampSeconds }) =>
    secret
      ? {
          "x-webhook-signature": await hmac(
            "SHA-256",
            fromBase64(secret),
            `${timestampSeconds}.${body}`,
            "base64",
          ),
          "x-webhook-timestamp": String(timestampSeconds),
        }
      : {},
)

type WebhookDelivery = {
  /** `hex` (default, our EMR) or `daily` (Daily's documented scheme; the secret is base64). */
  signature?: DailyWebhookSignature
  retryDelaysMs?: readonly number[]
  fetch?: (request: Request) => Promise<Response>
}

export type DailyRuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  seed?: number | string
  adminPrefix?: string
  adminKey?: string
  /** Admin controls to boot with: clock, latency, faults, seed, a starting snapshot. */
  adminControls?: MockControls
  onLog?: (entry: RequestLog) => void
  settings?: Partial<Settings>
  /** Where webhooks go (`POST /v1/webhooks/daily`); `secret` is `DAILY_WEBHOOK_SECRET`. */
  webhooks?: Omit<WebhookEndpoint, "id"> & WebhookDelivery
  /** Where admin sessions write transcripts (the stack's s3rver). */
  transcripts?: TranscriptStore
  /**
   * `json` (default): our EMR's `{room}/{session}.json` and `transcription.stopped`. `vtt`:
   * Daily's transcript storage, a WebVTT file and `transcript.ready-to-download`.
   */
  transcriptFormat?: TranscriptFormat
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

const TRANSCRIPT_FORMATS: readonly string[] = ["json", "vtt"] satisfies TranscriptFormat[]

const adminRoutes = (runtime: ServiceRuntime<DailyAPI>): AdminRoutes => ({
  "GET /rooms": ({ namespace }) => json(200, { rooms: runtime.instance(namespace).rooms() }),
  "GET /rooms/:name": ({ params, namespace }) => {
    const room = runtime.instance(namespace).state.rooms.get(params.name as string)
    return room ? json(200, room) : adminError(404, `no room ${params.name}`)
  },
  "POST /call-fault": ({ body, namespace }) => {
    if (
      !isRecord(body) ||
      typeof body.type !== "string" ||
      !["ejected", "exp-token", "no-room", "exp-room", "nbf-room", "room-full"].includes(body.type)
    )
      return adminError(400, "expected supported join error type")
    runtime.instance(namespace).state.update({ nextJoinError: body.type })
    return json(200, { type: body.type })
  },
  "GET /rooms/:name/participants": ({ params, namespace }) => {
    const room = runtime.instance(namespace).state.rooms.get(params.name as string)
    return room ? json(200, room.presence) : adminError(404, "no room")
  },
  "POST /rooms/:name/participants": async ({ params, body, namespace }) => {
    const api = runtime.instance(namespace)
    const name = params.name as string
    const fail = (type: string) => json(400, { error: { type }, errorMsg: type })
    let room = api.state.rooms.get(name)
    if (!room) return fail("no-room")
    if (!isRecord(body)) return adminError(400, "expected participant object")
    if (body.browser === true && room.privacy === "private" && typeof body.token !== "string")
      return fail("ejected")
    if (body.browser === true && api.state.current().nextJoinError) {
      const type = api.state.current().nextJoinError as string
      api.state.update({ nextJoinError: null })
      return fail(type)
    }
    let owner = body.owner === true
    let userId = typeof body.user_id === "string" ? body.user_id : ""
    let userName = typeof body.user_name === "string" ? body.user_name : "Guest"
    if (body.token !== undefined) {
      if (typeof body.token !== "string") return fail("ejected")
      const inspection = await api.inspectToken(body.token)
      if (
        inspection.signatureValid !== true ||
        (inspection.claims?.r && inspection.claims.r !== name)
      )
        return fail("ejected")
      if (!inspection.joinable) {
        const problem = inspection.problems.join(" ")
        return fail(
          problem.includes("token expired")
            ? "exp-token"
            : problem.includes("room expired")
              ? "exp-room"
              : problem.includes("room not yet")
                ? "nbf-room"
                : "ejected",
        )
      }
      owner = inspection.claims?.o === true
      userId = typeof inspection.claims?.ud === "string" ? inspection.claims.ud : userId
      userName = typeof inspection.claims?.u === "string" ? inspection.claims.u : userName
    }
    // Re-read after async signature verification so simultaneous joins cannot overwrite one another.
    room = api.state.rooms.get(name)
    if (!room) return fail("no-room")
    const seconds = runtime.clock.now() / 1000
    const asSeconds = (n: unknown) =>
      typeof n === "number" ? (n >= 1e11 ? n / 1000 : n) : undefined
    const exp = asSeconds(room.config.exp)
    const nbf = asSeconds(room.config.nbf)
    if (exp !== undefined && exp <= seconds) return fail("exp-room")
    if (nbf !== undefined && nbf > seconds && !owner) return fail("nbf-room")
    if (
      typeof room.config.max_participants === "number" &&
      room.presence.length >= room.config.max_participants
    )
      return fail("room-full")
    const participant = {
      id: api.state.nextUuid("participant"),
      userId,
      userName,
      joinedAtMs: runtime.clock.now(),
      video: body.video !== false,
      audio: body.audio !== false,
      owner,
    }
    api.state.rooms.update(name, { ...room, presence: [...room.presence, participant] })
    if (room.presence.length === 0) api.emit("meeting.started", { room: name })
    api.emit("participant.joined", { room: name, participant })
    return json(200, participant)
  },
  "PATCH /rooms/:name/participants/:id": ({ params, body, namespace }) => {
    const api = runtime.instance(namespace)
    const room = api.state.rooms.get(params.name as string)
    const current = room?.presence.find((p) => p.id === params.id)
    if (!room || !current) return adminError(404, "no participant")
    if (
      !isRecord(body) ||
      (body.video !== undefined && typeof body.video !== "boolean") ||
      (body.audio !== undefined && typeof body.audio !== "boolean")
    )
      return adminError(400, "expected audio/video booleans")
    const participant = {
      ...current,
      ...(typeof body.video === "boolean" ? { video: body.video } : {}),
      ...(typeof body.audio === "boolean" ? { audio: body.audio } : {}),
    }
    api.state.rooms.update(room.name, {
      ...room,
      presence: room.presence.map((p) => (p.id === current.id ? participant : p)),
    })
    return json(200, participant)
  },
  "DELETE /rooms/:name/participants/:id": ({ params, namespace }) => {
    const api = runtime.instance(namespace)
    const room = api.state.rooms.get(params.name as string)
    const participant = room?.presence.find((p) => p.id === params.id)
    if (!room || !participant) return adminError(404, "no participant")
    const presence = room.presence.filter((p) => p.id !== participant.id)
    api.state.rooms.update(room.name, { ...room, presence })
    api.emit("participant.left", { room: room.name, participant })
    if (presence.length === 0) api.emit("meeting.ended", { room: room.name })
    return json(200, { deleted: true })
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
    if (
      body.transcriptFormat !== undefined &&
      !TRANSCRIPT_FORMATS.includes(body.transcriptFormat as string)
    ) {
      return adminError(400, 'transcriptFormat: "json" or "vtt"')
    }
    if (body.transcriptError !== undefined && typeof body.transcriptError !== "string") {
      return adminError(400, "transcriptError: string")
    }
    const input: SessionInput = {
      participants,
      durationSec: body.durationSec,
      ...(transcript ? { transcript } : {}),
      ...(typeof body.sessionId === "string" ? { sessionId: body.sessionId } : {}),
      ...(typeof body.recording === "boolean" ? { recording: body.recording } : {}),
      ...(body.transcriptFormat !== undefined
        ? { transcriptFormat: body.transcriptFormat as TranscriptFormat }
        : {}),
      ...(body.transcriptError !== undefined
        ? { transcriptError: body.transcriptError as string }
        : {}),
    }
    try {
      const result = await runtime.instance(namespace).endSession(params.name as string, input)
      return result ? json(200, result) : adminError(404, `no room ${params.name}`)
    } catch (err) {
      return adminError(502, `transcript write failed: ${err instanceof Error ? err.message : err}`)
    }
  },
  "POST /events": ({ body, namespace }) => {
    if (!isRecord(body) || typeof body.type !== "string" || body.type === "") {
      return adminError(400, 'expected {"type": "<event type>", "payload"?: {...}, "version"?}')
    }
    if (body.payload !== undefined && !isRecord(body.payload)) {
      return adminError(400, "payload: object")
    }
    if (body.version !== undefined && typeof body.version !== "string") {
      return adminError(400, "version: string")
    }
    return json(
      200,
      runtime
        .instance(namespace)
        .emit(
          body.type,
          (body.payload ?? {}) as Record<string, unknown>,
          body.version as string | undefined,
        ),
    )
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
 * The Daily mock with Mockingbird's full service contract: `/__admin/health`, `/__admin/*`, namespaces
 * by header, by `/__admin/ns/<name>` prefix on `DAILY_API_BASE_URL`, or by API key
 * (`PUT /__admin/credentials {"credentials": {"<DAILY_API_KEY>": "<namespace>"}}`), clock
 * control, fault presets, signed webhooks and a request journal.
 */
export const createRuntime = (options: DailyRuntimeOptions = {}): DailyRuntime => {
  const { retryDelaysMs, fetch: send, signature, ...endpoint } = options.webhooks ?? { url: "" }
  const hub = createWebhookHub({
    signer: signature === "daily" ? dailyDocumentedWebhookSigner : dailyWebhookSigner,
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
    ...(options.adminPrefix !== undefined ? { adminPrefix: options.adminPrefix } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.adminControls !== undefined ? { adminControls: options.adminControls } : {}),
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
        ...(options.transcriptFormat ? { transcriptFormat: options.transcriptFormat } : {}),
        onWebhook: (event) =>
          hub.publish({ namespace: publicNamespace, type: event.type, body: event, id: event.id }),
      }),
    describe: () => ({
      webhooks: hub.endpoints("default").length > 0 ? "on" : "off",
      webhookSignature: signature ?? "hex",
      transcriptFormat: options.transcriptFormat ?? "json",
      transcripts: options.transcripts
        ? `${options.transcripts.endpoint}/${options.transcripts.bucket}`
        : "off",
    }),
    admin: adminRoutes,
  })
  const handle = runtime.fetch.bind(runtime)
  runtime.fetch = async (request) => {
    const url = new URL(request.url)
    if (request.method === "GET" && url.pathname === "/daily-js/stand-in.js") {
      const namespace = runtime.namespaceOf(request)
      const configuration = {
        baseUrl: url.origin,
        adminPrefix: options.adminPrefix ?? "/__admin",
        headers: { "x-mockingbird-namespace": namespace },
      }
      return new Response(
        `${dailyBrowserScript}\nMockingbirdDaily.install(${JSON.stringify(configuration)});`,
        {
          headers: {
            "content-type": "text/javascript; charset=utf-8",
            "cache-control": "no-store",
          },
        },
      )
    }
    return handle(request)
  }
  return Object.assign(runtime, { webhooks: hub })
}
