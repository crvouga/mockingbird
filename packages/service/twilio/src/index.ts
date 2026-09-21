import type { FetchAPI } from "@crvouga/mockingbird-core"
import type { OpenAPIDocument } from "@crvouga/mockingbird-openapi"
import {
  type APIOptions,
  annotateResponse,
  basicAuth,
  bootSqlite,
  createService,
  defineOperations,
  fromBase64,
  HttpError,
  jsonRes,
  type OperationContext,
  type Service,
  toBase64,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { Hono } from "hono"
import { document, type SupportedOperationId } from "./generated/openapi.js"
import { e164Key, type LookupResult, lookup, lookupBody } from "./phone.js"
import {
  type LookupOverride,
  type MessageRecord,
  type RecordingRecord,
  type TwilioOutboxItem,
  TwilioState,
  type VerificationRecord,
  type VerifySettings,
} from "./state.js"
import { durationSeconds, mixDownToMono, readWav, synthesizeWav } from "./wav.js"

export type { FetchAPI } from "@crvouga/mockingbird-core"
export type { SqliteClient } from "@crvouga/mockingbird-sqlite"
export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export type { LookupResult, ValidationError } from "./phone.js"
export { e164Key, lookup } from "./phone.js"
export { TWILIO_PRODUCTS, twilioMockUrl } from "./rewrite.js"
export type {
  LookupOverride,
  MessageRecord,
  RecordingRecord,
  TwilioOutboxItem,
  VerificationRecord,
  VerificationStatus,
  VerifySettings,
} from "./state.js"
export { DEFAULT_VERIFY_SETTINGS } from "./state.js"
export type { WavFormat } from "./wav.js"
export { mixDownToMono, readWav, synthesizeWav } from "./wav.js"

export const TWILIO_NAMESPACE = "twilio"

/** The account sid used when a request carries an API key (`SK…`) instead of an account sid. */
export const DEFAULT_ACCOUNT_SID = "AC00000000000000000000000000000000"

export type TwilioAPIOptions = APIOptions & {
  /** Initial Verify settings for the namespace (fixed code, expiry, attempt limits). */
  verify?: Partial<VerifySettings>
  /**
   * Accepted `AccountSid → AuthToken` pairs. Omitted: any `AC…`/`SK…` username with a
   * non-empty password authenticates (Twilio's test credentials included).
   */
  accounts?: Record<string, string>
}

/** Twilio's JSON error body, `{code, message, more_info, status}`, with `X-Twilio-Error-Code`. */
export const twilioError = (status: number, code: number, message: string): Response =>
  jsonRes(
    status,
    { code, message, more_info: `https://www.twilio.com/docs/errors/${code}`, status },
    { "x-twilio-error-code": String(code) },
  )

const fail = (status: number, code: number, message: string) =>
  new HttpError(
    status,
    { code, message, more_info: `https://www.twilio.com/docs/errors/${code}`, status },
    { "x-twilio-error-code": String(code) },
  )

const SID = (prefix: string) => new RegExp(`^${prefix}[0-9a-f]{32}$`, "i")
const ACCOUNT_SID = SID("AC")
const SERVICE_SID = SID("VA")
const MESSAGING_SERVICE_SID = SID("MG")

/** Paths whose last segment is `{Sid}.json` / `{Sid}.wav`: routed as `{Sid}/.json` internally. */
const SUFFIXED = /\/(Messages|Recordings)\/([^/]+?)\.(json|wav)$/

/** The contract with `{Sid}.ext` segments split, which the router can match. */
const routingDocument = (source: OpenAPIDocument): OpenAPIDocument => ({
  ...source,
  paths: Object.fromEntries(
    Object.entries(source.paths ?? {}).map(([path, item]) => [
      path.replace(/\{Sid\}\.(json|wav)$/, "{Sid}/.$1"),
      item,
    ]),
  ),
})
const ROUTING = routingDocument(document)

/** The path Twilio names in a 404: the upstream path, without the mock's product prefix. */
const upstreamPath = (pathname: string) =>
  pathname.replace(/^\/(api|verify|lookups)(?=\/)/, "").replace(/\/\.(json|wav)$/, ".$1")

/** Twilio's ISO timestamps carry whole seconds. */
const isoSeconds = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z")

/** RFC 2822, as the 2010-04-01 API writes dates: `Thu, 24 Aug 2023 05:01:45 +0000`. */
const rfc2822 = (ms: number) => new Date(ms).toUTCString().replace("GMT", "+0000")

const GSM = /^[\n\r\x20-\x7E£¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ¤¡ÄÖÑÜ§¿äöñüà€]*$/

/** SMS segments: 160/153 GSM-7 characters, 70/67 UCS-2 characters. */
const segments = (body: string) => {
  const length = [...body].length
  if (length === 0) return 1
  const [single, part] = GSM.test(body) ? [160, 153] : [70, 67]
  return length <= single ? 1 : Math.ceil(length / part)
}

/** The form body as flat strings; repeated keys keep every value. */
const formOf = (context: OperationContext): Record<string, string | string[]> => {
  const value =
    context.body.kind === "form" || context.body.kind === "json" ? context.body.value : undefined
  if (typeof value !== "object" || value === null) return {}
  const out: Record<string, string | string[]> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "string") out[key] = item
    else if (Array.isArray(item)) out[key] = item.map(String)
    else if (item !== undefined && item !== null) out[key] = String(item)
  }
  return out
}

const one = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value.at(-1) : value

const many = (value: string | string[] | undefined): string[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value]

export type LatestVerification = {
  sid: string
  code: string
  status: VerificationRecord["status"]
  to: string
  channel: string
  serviceSid: string
  attempts: number
  sendAttempts: number
  createdAt: string
  expiresAt: string
}

export type PutRecordingInput = {
  /** WAV bytes; omitted means a synthesised 16-bit 8 kHz PCM recording. */
  wav?: Uint8Array
  /** For a synthesised recording. Default 2 (a dual-channel call recording). */
  channels?: number
  seconds?: number
  accountSid?: string
  callSid?: string
}

/**
 * Stateful mock of Twilio Lookup v2, Verify v2, Programmable Messaging and call Recordings,
 * with each product routed by its host carried as a path prefix (`/lookups`, `/verify`,
 * `/api`).
 */
export class TwilioAPI implements FetchAPI {
  readonly app: Hono
  readonly sqlite: SqliteClient
  readonly state: TwilioState
  private readonly service: Service
  private readonly now: () => number
  private readonly accounts: Record<string, string> | undefined

  constructor(options: TwilioAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite)
    const namespace = options.namespace ?? TWILIO_NAMESPACE
    this.now = options.now ?? (() => Date.now())
    this.accounts = options.accounts
    this.state = new TwilioState(sqlite, namespace, options.verify ?? {})
    const handlers = defineOperations<SupportedOperationId>({
      FetchPhoneNumber: (context) => this.fetchPhoneNumber(context),
      CreateVerification: (context) => this.createVerification(context),
      FetchVerification: (context) => this.fetchVerification(context),
      UpdateVerification: (context) => this.updateVerification(context),
      CreateVerificationCheck: (context) => this.createVerificationCheck(context),
      CreateMessage: (context) => this.createMessage(context),
      FetchMessage: (context) => this.fetchMessage(context),
      FetchRecordingMedia: (context) => this.fetchRecordingMedia(context),
      FetchRecording: (context) => this.fetchRecording(context),
      DeleteRecording: (context) => this.deleteRecording(context),
    })
    this.service = createService({
      document: ROUTING,
      handlers,
      sqlite,
      namespace,
      now: this.now,
      notFound: (request) =>
        twilioError(
          404,
          20404,
          `The requested resource ${upstreamPath(new URL(request.url).pathname)} was not found`,
        ),
      onError: (error) => {
        if (error instanceof HttpError) return error.toResponse()
        throw error
      },
      before: (context) => this.authenticate(context),
    })
    this.app = this.service.app
    this.sqlite = this.service.sqlite
  }

  fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const suffixed = SUFFIXED.exec(url.pathname)
    if (!suffixed) return this.service.fetch(request)
    url.pathname = url.pathname.replace(SUFFIXED, "/$1/$2/.$3")
    return this.service.fetch(new Request(url, request))
  }

  async reset(): Promise<void> {
    await this.service.reset()
  }

  private authenticate(context: OperationContext): Response | undefined {
    const credentials = basicAuth(context.request)
    if (!credentials?.username || !credentials.password || !/^(AC|SK)/.test(credentials.username)) {
      return twilioError(401, 20003, "Authenticate")
    }
    if (this.accounts !== undefined) {
      const expected = this.accounts[credentials.username]
      if (expected === undefined) return twilioError(401, 20003, "Authenticate")
      if (expected !== credentials.password) {
        return twilioError(
          401,
          20003,
          `authentication failed, auth token is not valid for account ${credentials.username}`,
        )
      }
    }
    return undefined
  }

  /** The account a request acts for: the path's, else the Basic username when it is one. */
  private accountOf(context: OperationContext): string {
    const fromPath = context.params.AccountSid
    if (fromPath) return fromPath
    const username = basicAuth(context.request)?.username ?? ""
    return username.startsWith("AC") ? username : DEFAULT_ACCOUNT_SID
  }

  private requireAccount(context: OperationContext) {
    const account = context.params.AccountSid ?? ""
    if (!ACCOUNT_SID.test(account)) {
      throw fail(
        404,
        20404,
        `The requested resource ${upstreamPath(context.url.pathname)} was not found`,
      )
    }
    return account
  }

  // ---- Lookup v2 -----------------------------------------------------------------------------

  /** Lookup validity, with any `PUT /__admin/lookups/:e164` override applied. */
  resolveLookup(raw: string, countryCode?: string): LookupResult {
    const computed = lookup(raw, countryCode)
    const override =
      this.state.lookups.get(computed.phone_number) ?? this.state.lookups.get(e164Key(raw))
    if (!override) return computed
    if (override.valid) return { ...computed, valid: true, validation_errors: [] }
    return {
      ...computed,
      calling_country_code: null,
      country_code: null,
      valid: false,
      validation_errors:
        override.validationErrors.length > 0 ? override.validationErrors : ["INVALID_BUT_POSSIBLE"],
    }
  }

  private fetchPhoneNumber(context: OperationContext): Response {
    const raw = context.params.PhoneNumber ?? ""
    const country =
      typeof context.query.CountryCode === "string" ? context.query.CountryCode : undefined
    const result = this.resolveLookup(raw, country)
    return jsonRes(200, lookupBody(result, raw, country))
  }

  // ---- Verify v2 -----------------------------------------------------------------------------

  private requireService(context: OperationContext): string {
    const sid = context.params.ServiceSid ?? ""
    if (!SERVICE_SID.test(sid)) {
      throw fail(
        404,
        20404,
        `The requested resource ${upstreamPath(context.url.pathname)} was not found`,
      )
    }
    return sid
  }

  /** The verification as of now: a pending one past its expiry becomes `expired`. */
  private current(verification: VerificationRecord): VerificationRecord {
    const ttl = this.state.verify().ttlSeconds * 1000
    if (verification.status !== "pending" || this.now() < verification.createdAtMs + ttl) {
      return verification
    }
    const expired = { ...verification, status: "expired" as const }
    this.state.verifications.update(verification.sid, expired)
    return expired
  }

  private verificationBody(v: VerificationRecord) {
    return {
      sid: v.sid,
      service_sid: v.serviceSid,
      account_sid: v.accountSid,
      to: v.to,
      channel: v.channel,
      status: v.status,
      valid: v.status === "approved",
      lookup: { carrier: null },
      amount: null,
      payee: null,
      send_code_attempts: v.sendAttempts.map((a) => ({
        attempt_sid: a.attemptSid,
        channel: a.channel,
        time: a.time,
      })),
      sna: null,
      date_created: v.dateCreated,
      date_updated: v.dateUpdated,
      url: `https://verify.twilio.com/v2/Services/${v.serviceSid}/Verifications/${v.sid}`,
    }
  }

  /** `To` as Verify accepts it: an email for the email channel, else a valid E.164 number. */
  private verifyRecipient(to: string | undefined, channel: string): string {
    if (to === undefined || to.trim() === "") throw fail(400, 60200, "Invalid parameter `To`: ")
    if (channel === "email") {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
        throw fail(400, 60200, `Invalid parameter \`To\`: ${to}`)
      }
      return to.trim().toLowerCase()
    }
    const result = to.trim().startsWith("+") ? this.resolveLookup(to) : undefined
    if (!result?.valid) throw fail(400, 60200, `Invalid parameter \`To\`: ${to}`)
    return result.phone_number
  }

  private createVerification(context: OperationContext): Response {
    const serviceSid = this.requireService(context)
    const form = formOf(context)
    const channel = one(form.Channel)
    if (!channel || !["sms", "call", "email", "whatsapp", "sna", "auto"].includes(channel)) {
      throw fail(400, 60200, `Invalid parameter \`Channel\`: ${channel ?? ""}`)
    }
    const to = this.verifyRecipient(one(form.To), channel)
    const customCode = one(form.CustomCode)
    if (customCode !== undefined && !/^[0-9]{4,10}$/.test(customCode)) {
      throw fail(400, 60200, `Invalid parameter \`CustomCode\`: ${customCode}`)
    }
    const settings = this.state.verify()
    const now = this.now()
    const history = this.state.verificationsTo(to, serviceSid).map((v) => this.current(v))
    const windowStart = now - settings.sendWindowSeconds * 1000
    const recentSends = history
      .flatMap((v) => v.sendAttempts)
      .filter((attempt) => attempt.timeMs > windowStart).length
    if (recentSends >= settings.maxSendAttempts) {
      throw fail(429, 60203, "Max send attempts reached")
    }
    const attempt = {
      attemptSid: this.state.sid("VL"),
      channel,
      time: isoSeconds(now),
      timeMs: now,
    }
    // A pending verification to the same number is re-sent (same sid, same code).
    const pending = history.find((v) => v.status === "pending")
    const verification: VerificationRecord = pending
      ? {
          ...pending,
          channel,
          sendAttempts: [...pending.sendAttempts, attempt],
          dateUpdated: isoSeconds(now),
        }
      : (() => {
          const sid = this.state.sid("VE")
          return {
            sid,
            serviceSid,
            accountSid: this.accountOf(context),
            to,
            channel,
            code: customCode ?? settings.fixedCode ?? this.state.code(sid),
            status: "pending" as const,
            attempts: 0,
            sendAttempts: [attempt],
            createdAtMs: now,
            dateCreated: isoSeconds(now),
            dateUpdated: isoSeconds(now),
          }
        })()
    if (pending) this.state.verifications.update(verification.sid, verification)
    else this.state.verifications.insert(verification.sid, verification)
    this.state.outbox.record({
      id: attempt.attemptSid,
      kind: "verify",
      sid: verification.sid,
      to,
      from: null,
      messagingServiceSid: null,
      body: `Your verification code is: ${verification.code}`,
      channel,
      code: verification.code,
      createdAt: new Date(now).toISOString(),
    })
    return annotateResponse(jsonRes(201, this.verificationBody(verification)), {
      ids: { verificationSid: verification.sid },
    })
  }

  private findVerification(context: OperationContext, sid: string): VerificationRecord {
    const serviceSid = this.requireService(context)
    const found = this.state.verifications.get(sid)
    const verification = found && found.serviceSid === serviceSid ? this.current(found) : undefined
    if (!verification || verification.status === "expired") {
      throw fail(
        404,
        20404,
        `The requested resource ${upstreamPath(context.url.pathname)} was not found`,
      )
    }
    return verification
  }

  private fetchVerification(context: OperationContext): Response {
    const verification = this.findVerification(context, context.params.Sid ?? "")
    return annotateResponse(jsonRes(200, this.verificationBody(verification)), {
      ids: { verificationSid: verification.sid },
    })
  }

  private updateVerification(context: OperationContext): Response {
    const verification = this.findVerification(context, context.params.Sid ?? "")
    const status = one(formOf(context).Status)
    if (status !== "canceled" && status !== "approved") {
      throw fail(400, 60200, `Invalid parameter \`Status\`: ${status ?? ""}`)
    }
    if (verification.status !== "pending") {
      throw fail(
        404,
        20404,
        `The requested resource ${upstreamPath(context.url.pathname)} was not found`,
      )
    }
    const updated: VerificationRecord = {
      ...verification,
      status,
      dateUpdated: isoSeconds(this.now()),
    }
    this.state.verifications.update(verification.sid, updated)
    return annotateResponse(jsonRes(200, this.verificationBody(updated)), {
      ids: { verificationSid: updated.sid },
    })
  }

  private createVerificationCheck(context: OperationContext): Response {
    const serviceSid = this.requireService(context)
    const form = formOf(context)
    const code = one(form.Code)
    if (code === undefined || code === "") throw fail(400, 60200, "Invalid parameter `Code`: ")
    const verificationSid = one(form.VerificationSid)
    const to = one(form.To)
    if (verificationSid === undefined && to === undefined) {
      throw fail(400, 60200, "Either a 'To' number or 'VerificationSid' must be specified")
    }
    const notFound = () =>
      fail(404, 20404, `The requested resource ${upstreamPath(context.url.pathname)} was not found`)
    let found: VerificationRecord | undefined
    if (verificationSid !== undefined) {
      const byId = this.state.verifications.get(verificationSid)
      found = byId && byId.serviceSid === serviceSid ? byId : undefined
    } else {
      const normalized = to?.includes("@") ? to.toLowerCase() : e164Key(to ?? "")
      found = this.state
        .verificationsTo(normalized, serviceSid)
        .map((v) => this.current(v))
        .find((v) => v.status === "pending")
    }
    const verification = found ? this.current(found) : undefined
    // Twilio keeps only pending verifications checkable: approved, canceled and expired are 404.
    if (verification?.status !== "pending") throw notFound()
    if (verification.attempts >= this.state.verify().maxCheckAttempts) {
      throw fail(429, 60202, "Max check attempts reached")
    }
    const now = this.now()
    const approved = code === verification.code
    const updated: VerificationRecord = {
      ...verification,
      attempts: verification.attempts + 1,
      status: approved ? "approved" : "pending",
      dateUpdated: isoSeconds(now),
    }
    this.state.verifications.update(verification.sid, updated)
    return annotateResponse(
      jsonRes(200, {
        sid: updated.sid,
        service_sid: updated.serviceSid,
        account_sid: updated.accountSid,
        to: updated.to,
        channel: updated.channel,
        status: updated.status,
        valid: approved,
        amount: null,
        payee: null,
        sna_attempts_error_codes: [],
        date_created: updated.dateCreated,
        date_updated: updated.dateUpdated,
      }),
      { ids: { verificationSid: updated.sid } },
    )
  }

  // ---- Messaging -----------------------------------------------------------------------------

  private createMessage(context: OperationContext): Response {
    const accountSid = this.requireAccount(context)
    const form = formOf(context)
    const to = one(form.To)
    const body = one(form.Body) ?? ""
    const from = one(form.From)
    const messagingServiceSid = one(form.MessagingServiceSid)
    const media = many(form.MediaUrl)
    if (to === undefined || to.trim() === "")
      throw fail(400, 21604, "A 'To' phone number is required.")
    if (body === "" && media.length === 0) throw fail(400, 21602, "Message body is required.")
    if (!from && !messagingServiceSid) throw fail(400, 21603, "A 'From' phone number is required.")
    if (messagingServiceSid !== undefined && !MESSAGING_SERVICE_SID.test(messagingServiceSid)) {
      throw fail(400, 21701, `The Messaging Service Sid ${messagingServiceSid} is invalid.`)
    }
    if ([...body].length > 1600) {
      throw fail(400, 21617, "The concatenated message body exceeds the 1600 character limit.")
    }
    const recipient = this.resolveLookup(to)
    if (!recipient.valid) throw fail(400, 21211, `Invalid 'To' Phone Number: ${to}`)
    const now = this.now()
    const sid = this.state.sid(media.length > 0 ? "MM" : "SM")
    const base = `/2010-04-01/Accounts/${accountSid}/Messages/${sid}`
    const message: MessageRecord = {
      sid,
      account_sid: accountSid,
      api_version: "2010-04-01",
      body,
      to: recipient.phone_number,
      from: from ?? null,
      messaging_service_sid: messagingServiceSid ?? null,
      status: messagingServiceSid ? "accepted" : "queued",
      direction: "outbound-api",
      num_segments: String(segments(body)),
      num_media: String(media.length),
      price: null,
      price_unit: "USD",
      error_code: null,
      error_message: null,
      date_created: rfc2822(now),
      date_updated: rfc2822(now),
      date_sent: null,
      uri: `${base}.json`,
      subresource_uris: { media: `${base}/Media.json`, feedback: `${base}/Feedback.json` },
    }
    this.state.messages.insert(sid, message)
    this.state.outbox.record({
      id: sid,
      kind: "sms",
      sid,
      to: recipient.phone_number,
      from: from ?? null,
      messagingServiceSid: messagingServiceSid ?? null,
      body,
      channel: "sms",
      ...(media.length > 0 ? { mediaUrls: media } : {}),
      createdAt: new Date(now).toISOString(),
    })
    return annotateResponse(jsonRes(201, message), { ids: { messageSid: sid } })
  }

  private fetchMessage(context: OperationContext): Response {
    const accountSid = this.requireAccount(context)
    const message = this.state.messages.get(context.params.Sid ?? "")
    if (!message || message.account_sid !== accountSid) {
      throw fail(
        404,
        20404,
        `The requested resource ${upstreamPath(context.url.pathname)} was not found`,
      )
    }
    return annotateResponse(jsonRes(200, message), { ids: { messageSid: message.sid } })
  }

  // ---- Recordings ----------------------------------------------------------------------------

  private findRecording(context: OperationContext): RecordingRecord {
    this.requireAccount(context)
    const recording = this.state.recordings.get(context.params.Sid ?? "")
    if (!recording || recording.deleted) {
      throw fail(
        404,
        20404,
        `The requested resource ${upstreamPath(context.url.pathname)} was not found`,
      )
    }
    return recording
  }

  private fetchRecordingMedia(context: OperationContext): Response {
    const recording = this.findRecording(context)
    const bytes = fromBase64(recording.wavBase64)
    // Twilio mixes a dual-channel recording down to mono unless asked for both channels.
    const served =
      String(context.query.RequestedChannels ?? "") === "2" ? bytes : mixDownToMono(bytes)
    return annotateResponse(
      new Response(served as BodyInit, {
        status: 200,
        headers: { "content-type": "audio/x-wav", "content-length": String(served.byteLength) },
      }),
      { ids: { recordingSid: recording.sid } },
    )
  }

  private recordingBody(recording: RecordingRecord) {
    const uri = `/2010-04-01/Accounts/${recording.accountSid}/Recordings/${recording.sid}`
    return {
      sid: recording.sid,
      account_sid: recording.accountSid,
      api_version: "2010-04-01",
      call_sid: recording.callSid,
      conference_sid: null,
      status: "completed",
      channels: recording.channels,
      duration: String(recording.duration),
      source: "RecordVerb",
      price: null,
      price_unit: "USD",
      error_code: null,
      encryption_details: null,
      start_time: recording.createdAt,
      date_created: recording.createdAt,
      date_updated: recording.createdAt,
      uri: `${uri}.json`,
      media_url: `https://api.twilio.com${uri}`,
    }
  }

  private fetchRecording(context: OperationContext): Response {
    const recording = this.findRecording(context)
    return annotateResponse(jsonRes(200, this.recordingBody(recording)), {
      ids: { recordingSid: recording.sid },
    })
  }

  private deleteRecording(context: OperationContext): Response {
    const recording = this.findRecording(context)
    this.state.recordings.update(recording.sid, { ...recording, deleted: true, wavBase64: "" })
    return annotateResponse(new Response(null, { status: 204 }), {
      ids: { recordingSid: recording.sid },
    })
  }

  // ---- Admin-plane helpers -------------------------------------------------------------------

  /** The newest verification to a number (what `GET /__admin/verify/:e164/latest` answers). */
  latestVerification(to: string): LatestVerification | undefined {
    const key = to.includes("@") ? to.toLowerCase() : e164Key(to)
    const newest = this.state.verificationsTo(key).at(0)
    if (!newest) return undefined
    const v = this.current(newest)
    return {
      sid: v.sid,
      code: v.code,
      status: v.status,
      to: v.to,
      channel: v.channel,
      serviceSid: v.serviceSid,
      attempts: v.attempts,
      sendAttempts: v.sendAttempts.length,
      createdAt: v.dateCreated,
      expiresAt: isoSeconds(v.createdAtMs + this.state.verify().ttlSeconds * 1000),
    }
  }

  setLookup(e164: string, override: LookupOverride): void {
    this.state.lookups.insert(e164Key(e164), override)
  }

  /** Store (or synthesise) a recording so `GET …/Recordings/{sid}.wav` serves it. */
  putRecording(sid: string, input: PutRecordingInput = {}): RecordingRecord {
    const wav =
      input.wav ?? synthesizeWav({ channels: input.channels ?? 2, seconds: input.seconds ?? 1 })
    const format = readWav(wav)
    const recording: RecordingRecord = {
      sid,
      accountSid: input.accountSid ?? DEFAULT_ACCOUNT_SID,
      callSid: input.callSid ?? this.state.sid("CA"),
      wavBase64: toBase64(wav),
      channels: format?.channels ?? 0,
      duration: durationSeconds(wav),
      createdAt: rfc2822(this.now()),
      deleted: false,
    }
    this.state.recordings.insert(sid, recording)
    return recording
  }

  outbox(): TwilioOutboxItem[] {
    return this.state.outbox.list()
  }

  messages(): MessageRecord[] {
    return this.state.messages.list({ order: "oldest" }).map((row) => row.value)
  }
}

export type {
  InboundSmsInput,
  TwilioAppWebhooks,
  TwilioRuntime,
  TwilioRuntimeOptions,
  VoiceWebhookKind,
} from "./runtime.js"
export { createRuntime, TWILIO_PRESETS, TWILIO_WEBHOOK_EVENTS } from "./runtime.js"
