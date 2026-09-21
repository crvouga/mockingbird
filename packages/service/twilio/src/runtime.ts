import {
  type AdminRoutes,
  basicAuth,
  type Clock,
  createRuntime as createServiceRuntime,
  createWebhookHub,
  type FaultPreset,
  fromBase64,
  outboxAdminRoutes,
  type RequestLog,
  type ServiceRuntime,
  signers,
  type WebhookEndpoint,
  type WebhookHub,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { document } from "./generated/openapi.js"
import { DEFAULT_ACCOUNT_SID, TWILIO_NAMESPACE, TwilioAPI } from "./index.js"
import type { ValidationError } from "./phone.js"
import { routeByHost } from "./rewrite.js"
import { hexOf, type VerifySettings } from "./state.js"
import { readWav } from "./wav.js"

const errorBody = (status: number, code: number, message: string) => ({
  code,
  message,
  more_info: `https://www.twilio.com/docs/errors/${code}`,
  status,
})

/**
 * Every named Twilio misbehaviour our consumer branches on, switched on with
 * `POST /__admin/faults {"preset": "<name>"}` (add `count` to limit it). Our code branches on
 * HTTP status class and transport errors only, never on Twilio's numeric codes.
 */
export const TWILIO_PRESETS: Record<string, FaultPreset> = {
  verify_5xx: {
    description: "Verify start and check answer 500 (20500); the backend surfaces a 400",
    rules: [
      {
        operationId: "CreateVerification",
        status: 500,
        body: errorBody(500, 20500, "An internal server error has occurred"),
        headers: { "x-twilio-error-code": "20500" },
      },
      {
        operationId: "CreateVerificationCheck",
        status: 500,
        body: errorBody(500, 20500, "An internal server error has occurred"),
        headers: { "x-twilio-error-code": "20500" },
      },
    ],
  },
  sms_socket_drop: {
    description:
      "Messages.json drops the connection: an unknown outcome the notification dispatcher must not retry",
    rules: [{ operationId: "CreateMessage", drop: true }],
  },
  sms_4xx: {
    description: "Messages.json answers 400 21211 (invalid To): a definite failure",
    rules: [
      {
        operationId: "CreateMessage",
        status: 400,
        body: errorBody(400, 21211, "Invalid 'To' Phone Number"),
        headers: { "x-twilio-error-code": "21211" },
      },
    ],
  },
  lookup_5xx: {
    description: "Lookup answers 503 (20503); the EMR phone validation fails open",
    rules: [
      {
        operationId: "FetchPhoneNumber",
        status: 503,
        body: errorBody(503, 20503, "Service is unavailable. Please try again"),
        headers: { "x-twilio-error-code": "20503" },
      },
    ],
  },
  webhook_duplicate: {
    description: "The next inbound webhook is delivered twice (the app dedupes on MessageSid)",
    webhook: { mode: "duplicate" },
  },
  webhook_drop: {
    description: "The next inbound webhook is never delivered",
    webhook: { mode: "drop" },
  },
}

/** Event types the hub publishes; endpoints can filter on them (`PUT /__admin/webhook-endpoints`). */
export const TWILIO_WEBHOOK_EVENTS = {
  "sms.inbound": "/messaging/inbound/sms",
  "voice.twiml": "/admin/messaging/voice/twiml",
  "voice.disclosure": "/admin/messaging/voice/disclosure",
  "voice.status": "/admin/messaging/voice/status",
  "voice.recording": "/admin/messaging/voice/recording",
} as const

export type VoiceWebhookKind = "twiml" | "disclosure" | "status" | "recording"

/**
 * Where Twilio's inbound webhooks go: the app's origin, the public base URL it verifies
 * signatures against (`TWILIO_VOICE_WEBHOOK_BASE_URL`), and the auth token it verifies with.
 */
export type TwilioAppWebhooks = {
  /** Where the mock posts, e.g. `http://127.0.0.1:3000`. */
  url: string
  /** The public base URL the app signs against. Default: `url`. */
  publicBaseUrl?: string
  /** The app's `TWILIO_AUTH_TOKEN` (the HMAC key). */
  authToken: string
  /** `AccountSid` in the payloads. Default {@link DEFAULT_ACCOUNT_SID}. */
  accountSid?: string
  /** `To` of inbound SMS (the app requires `TWILIO_VOICE_CALLER_ID`). */
  callerId?: string
  /** `MessagingServiceSid` of inbound SMS, when the number belongs to one. */
  messagingServiceSid?: string
}

export type TwilioRuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  seed?: number | string
  adminKey?: string
  onLog?: (entry: RequestLog) => void
  /** Initial Verify settings for every namespace (e.g. `{fixedCode: "000000"}`). */
  verify?: Partial<VerifySettings>
  /** Accepted `AccountSid → AuthToken` pairs; omitted, any `AC…` sid with a token works. */
  accounts?: Record<string, string>
  /** Inbound SMS and voice webhooks to the app. */
  app?: TwilioAppWebhooks
  /** Delay before each webhook attempt. Default `[0]`: Twilio does not retry these. */
  retryDelaysMs?: readonly number[]
  /** Sends webhooks (tests pass an in-process receiver). Default global `fetch`. */
  fetch?: (request: Request) => Promise<Response>
}

export type InboundSmsInput = {
  from: string
  body: string
  /** Default: the configured `callerId`. */
  to?: string
  /** Media URLs (https) or `{url, contentType}`; makes the sid `MM…`. */
  media?: (string | { url: string; contentType?: string })[]
  messageSid?: string
  accountSid?: string
  /** Extra form parameters, verbatim. */
  params?: Record<string, string>
}

/** One delivery of an admin-triggered webhook, with what the app answered. */
export type DeliveryOutcome = {
  url: string
  state: string
  status: number | null
  error: string | null
  response: string | null
}

export type TwilioRuntime = ServiceRuntime<TwilioAPI> & {
  readonly webhooks: WebhookHub
  /** Sign and post an inbound SMS to the app; resolves once delivered (or failed). */
  inboundSms(input: InboundSmsInput, namespace?: string): Promise<SentWebhook>
  /** Sign and post a voice webhook (`twiml`, `disclosure`, `status`, `recording`). */
  voiceWebhook(
    kind: VoiceWebhookKind,
    params?: Record<string, string>,
    namespace?: string,
  ): Promise<SentWebhook>
}

export type SentWebhook = {
  params: Record<string, string>
  deliveries: DeliveryOutcome[]
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const adminError = (status: number, message: string) =>
  json(status, { error: { type: "mockingbird_admin", message } })
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const stringsOf = (value: unknown): Record<string, string> =>
  isRecord(value)
    ? Object.fromEntries(
        Object.entries(value)
          .filter(([, v]) => typeof v === "string" || typeof v === "number")
          .map(([k, v]) => [k, String(v)]),
      )
    : {}

const RECORDING_SID = /^RE[0-9a-f]{32}$/i
const VALIDATION_ERRORS: readonly ValidationError[] = [
  "TOO_SHORT",
  "TOO_LONG",
  "INVALID_BUT_POSSIBLE",
  "INVALID_COUNTRY_CODE",
  "INVALID_LENGTH",
  "NOT_A_NUMBER",
]

/** A `client:<uuid>` identity like the Voice SDK's (our TwiML route requires one). */
const clientIdentity = (seed: string) => {
  const hex = hexOf(seed, 32)
  return `client:${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/**
 * The Twilio mock with Mockingbird's full service contract: `/health`, `/__admin/*`,
 * namespaces by header, by `/ns/<name>` prefix, or by AccountSid
 * (`PUT /__admin/credentials {"credentials": {"<AccountSid>": "<namespace>"}}`), clock
 * control, fault presets, an outbox, and signed inbound SMS and voice webhooks.
 */
export const createRuntime = (options: TwilioRuntimeOptions = {}): TwilioRuntime => {
  const app = options.app
  const publicBase = (app?.publicBaseUrl ?? app?.url ?? "").replace(/\/+$/, "")
  const appBase = (app?.url ?? "").replace(/\/+$/, "")
  const send = options.fetch ?? ((request: Request) => fetch(request))
  // What the app answered each delivery (TwiML, `<Response/>`, an error), keyed by body.
  const answers = new Map<string, string>()
  const endpoints: WebhookEndpoint[] = app
    ? Object.entries(TWILIO_WEBHOOK_EVENTS).map(([event, path]) => ({
        id: `twilio_${event}`,
        url: `${appBase}${path}`,
        signUrl: `${publicBase}${path}`,
        secret: app.authToken,
        events: [event],
      }))
    : []
  const hub = createWebhookHub({
    signer: signers.twilio(),
    retryDelaysMs: options.retryDelaysMs ?? [0],
    endpoints,
    fetch: async (request) => {
      const sent = await request.clone().text()
      const response = await send(request)
      answers.set(`${request.url}\n${sent}`, await response.clone().text())
      return response
    },
  })
  const runtime = createServiceRuntime<TwilioAPI>({
    name: TWILIO_NAMESPACE,
    document,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    credential: (request) => basicAuth(request)?.username,
    presets: TWILIO_PRESETS,
    webhooks: hub,
    create: ({ sqlite, namespace, clock }) =>
      new TwilioAPI({
        sqlite,
        namespace,
        now: clock.now,
        ...(options.verify ? { verify: options.verify } : {}),
        ...(options.accounts ? { accounts: options.accounts } : {}),
      }),
    describe: () => ({ webhooks: app ? "on" : "off" }),
    admin: adminRoutes,
  })

  const publish = async (
    namespace: string,
    type: keyof typeof TWILIO_WEBHOOK_EVENTS,
    params: Record<string, string>,
    id: string,
  ): Promise<SentWebhook> => {
    const message = hub.publish({
      namespace,
      type,
      body: new URLSearchParams(params).toString(),
      form: params,
      id,
    })
    await hub.idle()
    const deliveries = hub
      .deliveries(namespace)
      .filter((d) => d.messageId === message.id)
      .map((d) => {
        const last = d.attempts.at(-1)
        return {
          url: d.url,
          state: d.state,
          status: last?.status ?? null,
          error: last?.error ?? null,
          response: answers.get(`${d.url}\n${message.body}`) ?? null,
        }
      })
    return { params, deliveries }
  }

  const accountSid = (override?: string) => override ?? app?.accountSid ?? DEFAULT_ACCOUNT_SID

  const inboundSms = (input: InboundSmsInput, namespace = "default") => {
    const instance = runtime.instance(namespace)
    const media = (input.media ?? []).map((m) => (typeof m === "string" ? { url: m } : m))
    const sid = input.messageSid ?? instance.state.sid(media.length > 0 ? "MM" : "SM")
    const account = accountSid(input.accountSid)
    const params: Record<string, string> = {
      AccountSid: account,
      ApiVersion: "2010-04-01",
      Body: input.body,
      From: input.from,
      FromCountry: "US",
      MessageSid: sid,
      NumMedia: String(media.length),
      NumSegments: "1",
      SmsMessageSid: sid,
      SmsSid: sid,
      SmsStatus: "received",
      To: input.to ?? app?.callerId ?? "",
      ToCountry: "US",
      ...(app?.messagingServiceSid ? { MessagingServiceSid: app.messagingServiceSid } : {}),
    }
    media.forEach((item, index) => {
      params[`MediaUrl${index}`] = item.url
      params[`MediaContentType${index}`] = item.contentType ?? "image/jpeg"
    })
    Object.assign(params, input.params ?? {})
    return publish(namespace, "sms.inbound", params, sid)
  }

  const voiceWebhook = (
    kind: VoiceWebhookKind,
    overrides: Record<string, string> = {},
    namespace = "default",
  ) => {
    const instance = runtime.instance(namespace)
    const account = accountSid(overrides.AccountSid)
    const callSid = overrides.CallSid ?? instance.state.sid("CA")
    const base: Record<string, string> = {
      AccountSid: account,
      ApiVersion: "2010-04-01",
      CallSid: callSid,
    }
    let params: Record<string, string>
    switch (kind) {
      case "twiml":
        params = {
          ...base,
          CallStatus: "ringing",
          Direction: "inbound",
          From: clientIdentity(callSid),
          To: app?.callerId ?? "",
          ...overrides,
        }
        break
      case "disclosure":
        params = { ...base, CallStatus: "in-progress", ...overrides }
        break
      case "status":
        params = { ...base, CallStatus: "completed", CallDuration: "42", ...overrides }
        break
      case "recording": {
        const recordingSid = overrides.RecordingSid ?? instance.state.sid("RE")
        if (!instance.state.recordings.get(recordingSid)) {
          instance.putRecording(recordingSid, { accountSid: account, callSid })
        }
        const recording = instance.state.recordings.get(recordingSid)
        params = {
          ...base,
          RecordingSid: recordingSid,
          // The canonical form our recording adapter insists on.
          RecordingUrl: `https://api.twilio.com/2010-04-01/Accounts/${account}/Recordings/${recordingSid}`,
          RecordingStatus: "completed",
          RecordingDuration: String(recording?.duration ?? 1),
          RecordingChannels: String(recording?.channels ?? 2),
          RecordingSource: "DialVerb",
          RecordingStartTime: new Date(runtime.clock.now()).toUTCString().replace("GMT", "+0000"),
          ...overrides,
        }
        break
      }
    }
    return publish(namespace, `voice.${kind}`, params, `${callSid}:${kind}:${Date.now()}`)
  }

  const inner = runtime.fetch
  return Object.assign(runtime, {
    webhooks: hub,
    inboundSms,
    voiceWebhook,
    fetch: async (request: Request) => inner(await acceptRawRecording(await routeByHost(request))),
  })
}

/**
 * `PUT /__admin/recordings/:sid` with a raw WAV body (any non-JSON content type) is turned into
 * the JSON form the control plane reads, `{"wavBase64": "…"}`.
 */
const acceptRawRecording = async (request: Request): Promise<Request> => {
  if (request.method !== "PUT") return request
  const url = new URL(request.url)
  if (!/(?:^|\/)__admin\/recordings\/[^/]+$/.test(url.pathname)) return request
  const type = request.headers.get("content-type") ?? ""
  if (type.includes("json")) return request
  const bytes = new Uint8Array(await request.arrayBuffer())
  const headers = new Headers(request.headers)
  headers.set("content-type", "application/json")
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return new Request(url, {
    method: "PUT",
    headers,
    body: JSON.stringify(bytes.length > 0 ? { wavBase64: btoa(binary) } : {}),
  })
}

const adminRoutes = (runtime: ServiceRuntime<TwilioAPI>): AdminRoutes => {
  const twilio = runtime as TwilioRuntime
  return {
    ...outboxAdminRoutes(
      runtime,
      (api) => api.state.outbox,
      (params) => {
        const kind = params.get("kind")
        return kind === null ? undefined : (item) => item.kind === kind
      },
    ),
    "GET /verify/:e164/latest": ({ params, namespace }) => {
      const latest = runtime.instance(namespace).latestVerification(params.e164 as string)
      return latest ? json(200, latest) : adminError(404, `no verification to ${params.e164}`)
    },
    "GET /verify": ({ namespace }) => json(200, runtime.instance(namespace).state.verify()),
    "PUT /verify": ({ body, namespace }) => {
      if (!isRecord(body)) return adminError(400, "expected a JSON object")
      const patch: Partial<VerifySettings> = {}
      if (body.fixedCode !== undefined) {
        if (
          body.fixedCode !== null &&
          !(typeof body.fixedCode === "string" && /^\d{4,10}$/.test(body.fixedCode))
        ) {
          return adminError(400, "fixedCode: 4–10 digits, or null for random codes")
        }
        patch.fixedCode = body.fixedCode
      }
      for (const key of [
        "ttlSeconds",
        "maxCheckAttempts",
        "maxSendAttempts",
        "sendWindowSeconds",
      ] as const) {
        if (body[key] === undefined) continue
        if (typeof body[key] !== "number" || (body[key] as number) < 0) {
          return adminError(400, `${key}: a non-negative number`)
        }
        patch[key] = body[key] as number
      }
      return json(200, runtime.instance(namespace).state.updateVerify(patch))
    },
    "PUT /lookups/:e164": ({ params, body, namespace }) => {
      if (!isRecord(body) || typeof body.valid !== "boolean") {
        return adminError(400, 'expected {"valid": boolean, "validationErrors"?: [...]}')
      }
      const errors = Array.isArray(body.validationErrors) ? body.validationErrors : []
      const bad = errors.find((e) => !VALIDATION_ERRORS.includes(e as ValidationError))
      if (bad !== undefined) {
        return adminError(400, `validationErrors: one of ${VALIDATION_ERRORS.join(", ")}`)
      }
      runtime.instance(namespace).setLookup(params.e164 as string, {
        valid: body.valid,
        validationErrors: errors as ValidationError[],
      })
      return json(200, { phoneNumber: params.e164, valid: body.valid, validationErrors: errors })
    },
    "DELETE /lookups/:e164": ({ params, namespace }) => {
      const instance = runtime.instance(namespace)
      const key = `+${(params.e164 as string).replace(/[^0-9]/g, "")}`
      return json(200, { deleted: instance.state.lookups.delete(key) })
    },
    "PUT /recordings/:sid": ({ params, body, namespace }) => {
      const sid = params.sid as string
      if (!RECORDING_SID.test(sid)) return adminError(400, "sid must look like RE + 32 hex")
      const input = isRecord(body) ? body : {}
      let wav: Uint8Array | undefined
      if (typeof input.wavBase64 === "string") {
        try {
          wav = fromBase64(input.wavBase64)
        } catch {
          return adminError(400, "wavBase64 is not base64")
        }
        if (!readWav(wav)) return adminError(400, "the upload is not a RIFF/WAVE file")
      }
      const recording = runtime.instance(namespace).putRecording(sid, {
        ...(wav ? { wav } : {}),
        ...(typeof input.channels === "number" ? { channels: input.channels } : {}),
        ...(typeof input.seconds === "number" ? { seconds: input.seconds } : {}),
        ...(typeof input.accountSid === "string" ? { accountSid: input.accountSid } : {}),
        ...(typeof input.callSid === "string" ? { callSid: input.callSid } : {}),
      })
      const { wavBase64: _bytes, ...metadata } = recording
      return json(200, metadata)
    },
    "GET /messages": ({ namespace }) =>
      json(200, { messages: runtime.instance(namespace).messages() }),
    "POST /inbound/sms": async ({ body, namespace }) => {
      if (!isRecord(body) || typeof body.from !== "string" || typeof body.body !== "string") {
        return adminError(400, 'expected {"from": "+1…", "body": "…", "to"?, "media"?}')
      }
      const media = Array.isArray(body.media)
        ? body.media
            .map((m) =>
              typeof m === "string"
                ? m
                : isRecord(m) && typeof m.url === "string"
                  ? {
                      url: m.url,
                      ...(typeof m.contentType === "string" ? { contentType: m.contentType } : {}),
                    }
                  : undefined,
            )
            .filter((m) => m !== undefined)
        : []
      const sent = await twilio.inboundSms(
        {
          from: body.from,
          body: body.body,
          media,
          ...(typeof body.to === "string" ? { to: body.to } : {}),
          ...(typeof body.messageSid === "string" ? { messageSid: body.messageSid } : {}),
          ...(typeof body.accountSid === "string" ? { accountSid: body.accountSid } : {}),
          params: stringsOf(body.params),
        },
        namespace,
      )
      return json(200, sent)
    },
    "POST /voice/:kind": async ({ params, body, namespace }) => {
      const kind = params.kind as VoiceWebhookKind
      if (!["twiml", "disclosure", "status", "recording"].includes(kind)) {
        return adminError(404, "kind: twiml, disclosure, status or recording")
      }
      return json(200, await twilio.voiceWebhook(kind, stringsOf(body), namespace))
    },
  }
}
