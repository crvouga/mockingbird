/**
 * A port of OUR consumer's Twilio code (geviti-monorepo, read-only), used as the acceptance
 * oracle. Each block names its source; the requests, field reads, error handling and status
 * interpretation are kept as they are there. The one addition is the G-T1 seam: every
 * `new Twilio(...)` gets an `httpClient` that sends to the mock instead of `*.twilio.com`.
 */
import { RequestClient, type Twilio, validateRequest } from "twilio"
import { twilioMockUrl } from "../src/index.js"

// ---- G-T1: the httpClient seam ---------------------------------------------------------------

type RequestOptions = Parameters<RequestClient["request"]>[0]

/**
 * The G-T1 seam as it would land in the app: twilio-node's own `RequestClient` (axios, real
 * sockets), with every `https://<product>.twilio.com/<path>` rewritten to
 * `{TWILIO_API_BASE_URL}/<product>/<path>`.
 */
export class MockRequestClient extends RequestClient {
  constructor(private readonly baseUrl: string) {
    super()
  }

  // `never`: the base signature is generic over the body type the caller parses.
  override request(opts: RequestOptions): Promise<never> {
    return super.request({ ...opts, uri: twilioMockUrl(opts.uri, this.baseUrl) }) as Promise<never>
  }
}

/**
 * The same seam for an in-process mock: a `RequestClient` whose transport is a Fetch handler
 * (`runtime.fetch`). A dropped connection surfaces as the `TypeError` fetch throws.
 */
export class FetchRequestClient extends RequestClient {
  constructor(
    private readonly baseUrl: string,
    private readonly send: (request: Request) => Promise<Response>,
  ) {
    super()
  }

  override async request(opts: RequestOptions): Promise<never> {
    const url = new URL(twilioMockUrl(opts.uri, this.baseUrl))
    for (const [key, value] of Object.entries((opts.params ?? {}) as Record<string, unknown>)) {
      if (value !== undefined) url.searchParams.append(key, String(value))
    }
    const headers = new Headers(opts.headers as Record<string, string>)
    if (opts.username && opts.password) {
      headers.set("authorization", `Basic ${btoa(`${opts.username}:${opts.password}`)}`)
    }
    let body: string | undefined
    if (opts.data) {
      const form = new URLSearchParams()
      for (const [key, value] of Object.entries(opts.data as Record<string, unknown>)) {
        if (value === undefined) continue
        for (const each of Array.isArray(value) ? value : [value]) form.append(key, String(each))
      }
      body = form.toString()
    }
    const response = await this.send(
      new Request(url, { method: opts.method.toUpperCase(), headers, ...(body ? { body } : {}) }),
    )
    const text = await response.text()
    const json = response.headers.get("content-type")?.includes("json")
    return {
      statusCode: response.status,
      body: json && text ? JSON.parse(text) : text,
      headers: Object.fromEntries(response.headers),
    } as never
  }
}

// ---- Backend: twilio.service.ts ----------------------------------------------------------------

/** Nest's HttpException, as far as our code branches on it. */
export class HttpException extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}
export class BadRequestException extends HttpException {
  constructor(message: string) {
    super(400, message)
  }
}

/** RedisCacheService.setWithExpiry / get / delete, over an injectable clock. */
export class TtlCache {
  private readonly entries = new Map<string, { value: unknown; expiresAt: number }>()
  constructor(private readonly now: () => number = () => Date.now()) {}
  async setWithExpiry(key: string, value: unknown, seconds: number) {
    this.entries.set(key, { value, expiresAt: this.now() + seconds * 1000 })
  }
  async get<T>(key: string): Promise<T | null> {
    const entry = this.entries.get(key)
    if (!entry || entry.expiresAt <= this.now()) return null
    return entry.value as T
  }
  async delete(keys: string[]) {
    for (const key of keys) this.entries.delete(key)
  }
}

type PhoneVerificationMode = "onboarding" | "profile"
type PhoneVerificationCacheData = {
  phoneNumber: string
  email: string
  mode?: PhoneVerificationMode
}
const PHONE_VERIFICATION_CACHE_KEY_PREFIX = "phone_verification:"
const PHONE_VERIFICATION_TTL_SECONDS = 600

/** `B/global-services/services/twilio/twilio.service.ts`, minus the E2E OTP bypass it retires. */
export class TwilioService {
  constructor(
    private readonly client: Twilio,
    private readonly serviceSid: string,
    private readonly cacheService: TtlCache,
  ) {}

  private getCacheKey(verificationSid: string) {
    return `${PHONE_VERIFICATION_CACHE_KEY_PREFIX}${verificationSid}`
  }

  async getValidatedPhoneNumber(phoneNumber: string) {
    const validation = await this.client.lookups.v2.phoneNumbers(phoneNumber).fetch()
    if (!validation.valid) return false
    return validation.phoneNumber
  }

  async startVerification(phoneNumber: string, email: string, mode: PhoneVerificationMode) {
    const validatedPhoneNumber = await this.getValidatedPhoneNumber(phoneNumber)
    if (!validatedPhoneNumber) throw new BadRequestException("Phone number is not valid")
    const verification = await this.client.verify.v2
      .services(this.serviceSid)
      .verifications.create({ to: validatedPhoneNumber, channel: "sms" })
    const verificationSid = verification.sid
    const cacheData: PhoneVerificationCacheData = { phoneNumber: validatedPhoneNumber, email, mode }
    await this.cacheService.setWithExpiry(
      this.getCacheKey(verificationSid),
      cacheData,
      PHONE_VERIFICATION_TTL_SECONDS,
    )
    return { verificationSid, phoneNumber: validatedPhoneNumber }
  }

  async checkVerification(verificationSid: string, code: string) {
    const cacheKey = this.getCacheKey(verificationSid)
    const cached = await this.cacheService.get<PhoneVerificationCacheData>(cacheKey)
    if (!cached) throw new Error("Verification session not found or expired")
    const check = await this.client.verify.v2
      .services(this.serviceSid)
      .verificationChecks.create({ verificationSid, code })
    if (check.status === "approved") await this.cacheService.delete([cacheKey])
    return { success: check.status === "approved", status: check.status, data: cached }
  }
}

// ---- Backend: users.service.ts + users.controller.ts ------------------------------------------

export type LocalUser = {
  id: string
  email: string
  phoneNumber: string | null
  isPhoneVerified: boolean
}

/** What a controller answers: Nest maps HttpException to its status, anything else to 500. */
export type HttpOutcome = { status: number; body: unknown }

const asHttp = async (work: () => Promise<unknown>): Promise<HttpOutcome> => {
  try {
    return { status: 200, body: await work() }
  } catch (error) {
    if (error instanceof HttpException) {
      return { status: error.status, body: { statusCode: error.status, message: error.message } }
    }
    return { status: 500, body: { statusCode: 500, message: "Internal server error" } }
  }
}

const US_PHONE_NUMBER_REGEX = /^\+1[2-9][0-9]{2}[2-9][0-9]{2}[0-9]{4}$/

/** `POST /users/verify/{start-phone,check-phone,validate-phone}` over `UsersService`. */
export class UsersBackend {
  readonly users = new Map<string, LocalUser>()
  constructor(private readonly twilioService: TwilioService) {}

  startPhone(dto: { phoneNumber: string; email: string; mode?: PhoneVerificationMode }) {
    return asHttp(async () => {
      try {
        return await this.twilioService.startVerification(
          dto.phoneNumber,
          dto.email,
          dto.mode ?? "onboarding",
        )
      } catch (error) {
        if (error instanceof HttpException) throw error
        throw new BadRequestException("Failed to start phone verification")
      }
    })
  }

  checkPhone(dto: { verificationSid: string; code: string }) {
    return asHttp(async () => {
      try {
        const checkResult = await this.twilioService.checkVerification(
          dto.verificationSid,
          dto.code,
        )
        if (!checkResult.success) throw new BadRequestException("Invalid verification code")
        const cached = checkResult.data
        const localUser = this.users.get(cached.email.trim().toLowerCase())
        if (localUser) {
          localUser.phoneNumber = cached.phoneNumber
          localUser.isPhoneVerified = true
        }
        return { success: true, message: "Phone number verified successfully" }
      } catch (error) {
        if (error instanceof HttpException) throw error
        throw new BadRequestException("Failed to check phone verification")
      }
    })
  }

  /** `PhoneNumberValidateService.validatePhoneNumber` (Lookup errors are not caught: a 500). */
  validatePhone(dto: { phoneNumber: string }) {
    return asHttp(async () => {
      const cleaned = dto.phoneNumber.replace(/[^\d+]/g, "")
      const digitsOnly = cleaned.replace(/\+/g, "")
      if (digitsOnly.length !== 11) {
        return {
          valid: false,
          phoneNumber: null,
          message: "Phone number must be exactly 11 digits including country code",
        }
      }
      if (!digitsOnly.startsWith("1")) {
        return {
          valid: false,
          phoneNumber: null,
          message: "Phone number must start with country code 1",
        }
      }
      if (!US_PHONE_NUMBER_REGEX.test(`+${digitsOnly}`)) {
        return {
          valid: false,
          phoneNumber: null,
          message: "Phone number must be a valid US phone number",
        }
      }
      const validated = await this.twilioService.getValidatedPhoneNumber(`+${digitsOnly}`)
      if (!validated)
        return { valid: false, phoneNumber: null, message: "Phone number is not valid" }
      return { valid: true, phoneNumber: validated, message: "Phone number is valid" }
    })
  }
}

/**
 * `E/utils/phone.ts` `validatePhoneNumberViaService`: the EMR asks the backend and fails open
 * (valid) on a 5xx or a network error.
 */
export const emrValidatePhone = async (
  backend: UsersBackend,
  phoneNumber: string,
): Promise<{ valid: boolean; phoneNumber: string | null; message?: string }> => {
  const response = await backend.validatePhone({ phoneNumber })
  if (response.status !== 200) {
    const message =
      (response.body as { message?: string })?.message ??
      `Phone validation request failed with status ${response.status}`
    if (response.status >= 500) {
      return {
        valid: true,
        phoneNumber,
        message: `Phone validation skipped (service error): ${message}`,
      }
    }
    return { valid: false, phoneNumber: null, message }
  }
  const data = response.body as { valid: boolean; phoneNumber: string | null; message: string }
  return { valid: data.valid, phoneNumber: data.phoneNumber ?? null, message: data.message }
}

// ---- notification-dispatcher: channels/sms.ts + sms-delivery-policy.ts + delivery-errors.ts ----

export const SMS_RETRY_ON_UNKNOWN_TYPES = [
  "account.password_reset_request",
  "account.password_reset_confirmed",
  "appointment.reminder_now",
] as const
export const SMS_DELIVERY_UNKNOWN_OUTCOME_EVENT = "sms_delivery_unknown_outcome"
export const SMS_DELIVERY_UNKNOWN_OUTCOME_MESSAGE =
  "Twilio SMS delivery is unconfirmed and requires reconciliation"
const isSmsRetryOnUnknownOutcomeType = (templateId: string) =>
  (SMS_RETRY_ON_UNKNOWN_TYPES as readonly string[]).includes(templateId)

const REQUEST_NEVER_SENT_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "UND_ERR_CONNECT_TIMEOUT",
])
const CONNECT_PHASE_CODES = new Set(["ETIMEDOUT", "ECONNRESET", "ECONNABORTED"])
const CONNECT_PHASE_SYSCALLS = new Set(["connect", "getaddrinfo"])

const transportDetails = (error: object) => {
  const cause: unknown = Reflect.get(error, "cause")
  const source = typeof cause === "object" && cause !== null ? cause : error
  const code: unknown = Reflect.get(source, "code")
  const syscall: unknown = Reflect.get(source, "syscall")
  return {
    code: typeof code === "string" ? code : undefined,
    syscall: typeof syscall === "string" ? syscall : undefined,
  }
}

/** Any provider answer of 400 or more is a definite failure (a 5xx included). */
export const isDefiniteDeliveryFailure = (error: unknown) => {
  if (typeof error !== "object" || error === null) return false
  const status: unknown = Reflect.get(error, "status")
  if (typeof status === "number" && status >= 400) return true
  const { code, syscall } = transportDetails(error)
  if (code === undefined) return false
  if (REQUEST_NEVER_SENT_CODES.has(code)) return true
  return (
    CONNECT_PHASE_CODES.has(code) && syscall !== undefined && CONNECT_PHASE_SYSCALLS.has(syscall)
  )
}

export type DeliveryState = {
  provider: "twilio"
  status: "pending" | "accepted"
  providerId?: string
}
export type Delivery = {
  state: DeliveryState | undefined
  update(state: DeliveryState | undefined): Promise<void>
}
export type SmsJob = {
  to: string
  body: string
  templateId: string
  actions?: { label: string; url: string }[]
}

/** Thrown when BullMQ must not retry (`UnrecoverableError`). */
export class UnrecoverableError extends Error {}

/** `SmsChannel.send`: the unknown-outcome policy around `messages.create`. */
export class SmsChannel {
  readonly warnings: { event: string; type: string }[] = []
  constructor(
    private readonly client: Twilio,
    private readonly creds: { from?: string; serviceSid?: string },
    private readonly smsEnabled = true,
  ) {}

  async send(job: SmsJob, delivery: Delivery) {
    if (delivery.state?.status === "accepted") return
    if (delivery.state?.status === "pending" && !isSmsRetryOnUnknownOutcomeType(job.templateId)) {
      this.reportUnknownOutcome(job)
      throw new Error(SMS_DELIVERY_UNKNOWN_OUTCOME_MESSAGE)
    }
    const appended = job.actions?.length
      ? `${job.body}\n\n${job.actions.map((a) => `${a.label}: ${a.url}`).join("\n")}`
      : job.body
    let awaitingProviderResponse = false
    try {
      if (this.smsEnabled) {
        await delivery.update({ provider: "twilio", status: "pending" })
        delivery.state = { provider: "twilio", status: "pending" }
        awaitingProviderResponse = true
        const message = await this.client.messages.create({
          to: job.to,
          body: appended,
          ...(this.creds.serviceSid
            ? { messagingServiceSid: this.creds.serviceSid }
            : this.creds.from
              ? { from: this.creds.from }
              : {}),
        })
        awaitingProviderResponse = false
        if (!message.sid) throw new Error("Twilio accepted response is missing its message id")
        const accepted = {
          provider: "twilio",
          status: "accepted",
          providerId: message.sid,
        } as const
        await delivery.update(accepted)
        delivery.state = accepted
      }
    } catch (error) {
      if (awaitingProviderResponse) {
        if (isDefiniteDeliveryFailure(error) || isSmsRetryOnUnknownOutcomeType(job.templateId)) {
          await delivery.update(undefined)
          delivery.state = undefined
          throw error
        }
        this.reportUnknownOutcome(job)
        throw new Error(SMS_DELIVERY_UNKNOWN_OUTCOME_MESSAGE)
      }
      if (delivery.state?.status === "pending") {
        throw new UnrecoverableError(SMS_DELIVERY_UNKNOWN_OUTCOME_MESSAGE)
      }
      throw error
    }
  }

  private reportUnknownOutcome(job: SmsJob) {
    this.warnings.push({ event: SMS_DELIVERY_UNKNOWN_OUTCOME_EVENT, type: job.templateId })
  }
}

/** An in-memory `delivery` attempt record, as the dispatcher persists it. */
export const memoryDelivery = (): Delivery => {
  const delivery: Delivery = {
    state: undefined,
    update: async (state) => {
      delivery.state = state
    },
  }
  return delivery
}

// ---- Backend: care-chat/channels/twilio-conversation-sms.adapter.ts ---------------------------

export class ChannelSendError extends Error {}

export const sendConversationSms = async (
  client: Twilio,
  config: { messagingServiceSid?: string; from?: string },
  params: { to: string; bodyText: string },
) => {
  try {
    const message = await client.messages.create({
      to: params.to,
      body: params.bodyText,
      ...(config.messagingServiceSid
        ? { messagingServiceSid: config.messagingServiceSid }
        : { from: config.from ?? "" }),
    })
    const providerMessageId = message.sid?.trim()
    if (!providerMessageId) throw new Error("Twilio returned no message id")
    return { providerMessageId }
  } catch (error) {
    if (error instanceof ChannelSendError) throw error
    throw new ChannelSendError("Care-chat SMS delivery failed", { cause: error })
  }
}

// ---- Backend: messaging/call-recording/twilio-recording-http.adapter.ts -----------------------

const TWILIO_RECORDING_SID_PATTERN = /^RE[0-9a-f]{32}$/i

/**
 * `TwilioRecordingHttpAdapter` with the G-T1 change applied: the hardcoded
 * `https://api.twilio.com` origin becomes `TWILIO_API_BASE_URL` for the request, while the
 * canonical URL check still compares against the api.twilio.com form Twilio sends.
 */
export class TwilioRecordingHttpAdapter {
  constructor(
    private readonly config: { accountSid: string; authToken: string; apiBaseUrl: string },
    private readonly send: (request: Request) => Promise<Response> = (r) => fetch(r),
  ) {}

  async download(params: { recordingSid: string; recordingUrl: string }) {
    const recordingUrl = this.validateRecordingUrl(params)
    const response = await this.send(
      new Request(
        `${twilioMockUrl(recordingUrl, this.config.apiBaseUrl)}.wav?RequestedChannels=2`,
        {
          headers: { Authorization: this.authorizationHeader() },
        },
      ),
    )
    if (!response.ok || !response.body) {
      throw new Error(`Twilio recording download returned HTTP ${response.status}`)
    }
    return validateDualChannelWav(new Uint8Array(await response.arrayBuffer()))
  }

  async delete(recordingSid: string) {
    const recordingUrl = this.canonicalRecordingUrl(recordingSid)
    const response = await this.send(
      new Request(`${twilioMockUrl(recordingUrl, this.config.apiBaseUrl)}.json`, {
        method: "DELETE",
        headers: { Authorization: this.authorizationHeader() },
      }),
    )
    if (!response.ok && response.status !== 404) {
      throw new Error(`Twilio recording delete returned HTTP ${response.status}`)
    }
  }

  private validateRecordingUrl(params: { recordingSid: string; recordingUrl: string }) {
    if (!TWILIO_RECORDING_SID_PATTERN.test(params.recordingSid))
      throw new Error("bad recording sid")
    if (!params.recordingUrl.startsWith("https://")) throw new Error("recording URL must be https")
    const canonicalUrl = this.canonicalRecordingUrl(params.recordingSid)
    if (params.recordingUrl.replace(/\/+$/, "") !== canonicalUrl) {
      throw new Error("Twilio recording URL does not match the configured account")
    }
    return canonicalUrl
  }

  private canonicalRecordingUrl(recordingSid: string) {
    return `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.config.accountSid)}/Recordings/${recordingSid}`
  }

  private authorizationHeader() {
    return `Basic ${btoa(`${this.config.accountSid}:${this.config.authToken}`)}`
  }
}

/** `validateDualChannelWav` / `parseWavChannelCount`, over the whole body. */
export const validateDualChannelWav = (bytes: Uint8Array) => {
  const header = Buffer.from(bytes)
  if (header.length < 12)
    throw new Error("Twilio recording WAV ended before its channel count was available")
  if (header.toString("ascii", 0, 4) !== "RIFF" || header.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Twilio recording response is not a valid WAV file")
  }
  let offset = 12
  while (header.length >= offset + 8) {
    const chunkName = header.toString("ascii", offset, offset + 4)
    const chunkSize = header.readUInt32LE(offset + 4)
    const chunkDataStart = offset + 8
    if (chunkName === "fmt ") {
      const channelCount = header.readUInt16LE(chunkDataStart + 2)
      if (channelCount !== 2) {
        throw new Error(`Twilio recording WAV must contain 2 channels; received ${channelCount}`)
      }
      return bytes
    }
    offset = chunkDataStart + chunkSize + (chunkSize % 2)
  }
  throw new Error("Twilio recording WAV channel count was not found within the header limit")
}

// ---- Backend webhook receivers: twilio-webhook-signature.ts, messaging-inbound-sms.controller.ts,
// ---- inbound-sms.event.ts, call-recording.service.ts, messaging-voice.service.ts ---------------

/** `verifyTwilioWebhookSignature`: `TWILIO_VOICE_WEBHOOK_BASE_URL + originalUrl`, sorted params. */
export const verifyTwilioWebhookSignature = (params: {
  authToken: string
  webhookBaseUrl: string
  originalUrl: string
  signature: string | undefined
  body: Record<string, string>
}) => {
  const publicUrl = `${params.webhookBaseUrl.replace(/\/+$/, "")}${params.originalUrl}`
  if (
    !params.signature ||
    !validateRequest(params.authToken, params.signature, publicUrl, params.body)
  ) {
    return null
  }
  return { publicUrl, bodyParams: params.body }
}

const TWILIO_MESSAGE_SID_PATTERN = /^(SM|MM)[0-9a-f]{32}$/i
const TWILIO_CALL_SID_PATTERN = /^CA[0-9a-f]{32}$/i
const E164_PATTERN = /^\+[1-9]\d{7,14}$/

export type InboundSmsEvent = {
  providerMessageId: string
  sender: string
  recipient: string
  body: string
  media: { index: number; url: string; contentType: string }[]
}

/** `parseInboundSmsEvent` (zod schema), throwing `InvalidPayload` where zod would. */
export class InvalidPayload extends Error {}
export const parseInboundSmsEvent = (payload: Record<string, string>): InboundSmsEvent => {
  if (!TWILIO_MESSAGE_SID_PATTERN.test(payload.MessageSid?.trim() ?? ""))
    throw new InvalidPayload("MessageSid")
  if (!payload.From?.trim() || !payload.To?.trim() || typeof payload.Body !== "string") {
    throw new InvalidPayload("From/To/Body")
  }
  if (!/^\d+$/.test(payload.NumMedia?.trim() ?? "")) throw new InvalidPayload("NumMedia")
  const numMedia = Number(payload.NumMedia)
  if (numMedia > 10) throw new InvalidPayload("NumMedia")
  const media: InboundSmsEvent["media"] = []
  for (let index = 0; index < Math.min(numMedia, 10); index++) {
    const url = payload[`MediaUrl${index}`]?.trim() ?? ""
    if (!url.startsWith("https://")) throw new InvalidPayload(`MediaUrl${index}`)
    media.push({ index, url, contentType: payload[`MediaContentType${index}`]?.trim() ?? "" })
  }
  return {
    providerMessageId: payload.MessageSid as string,
    sender: payload.From as string,
    recipient: payload.To as string,
    body: payload.Body,
    media,
  }
}

/**
 * The app's Twilio webhook routes, as a Fetch handler: `POST /messaging/inbound/sms` (403 on a
 * bad signature, `<Response/>` on success, dedupe on MessageSid, the recipient must be the
 * caller id) and `POST /admin/messaging/voice/{status,recording}` with their schema checks.
 */
export class TwilioWebhookReceiver {
  readonly inbound: InboundSmsEvent[] = []
  readonly statuses: { callSid: string; status: string }[] = []
  readonly recordings: { recordingSid: string; recordingUrl: string; callSid: string }[] = []
  private readonly seen = new Set<string>()

  constructor(
    private readonly config: { authToken: string; webhookBaseUrl: string; callerId: string },
  ) {}

  fetch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const body = Object.fromEntries(new URLSearchParams(await request.text()))
    const verified = verifyTwilioWebhookSignature({
      authToken: this.config.authToken,
      webhookBaseUrl: this.config.webhookBaseUrl,
      originalUrl: `${url.pathname}${url.search}`,
      signature: request.headers.get("x-twilio-signature") ?? undefined,
      body,
    })
    if (!verified)
      return Response.json({ message: "Webhook signature verification failed" }, { status: 403 })
    if (url.pathname === "/messaging/inbound/sms") {
      let event: InboundSmsEvent
      try {
        event = parseInboundSmsEvent(verified.bodyParams)
      } catch {
        return Response.json({ message: "Webhook payload is invalid" }, { status: 400 })
      }
      if (event.recipient !== this.config.callerId) {
        return Response.json({ message: "Unknown recipient" }, { status: 400 })
      }
      if (!this.seen.has(event.providerMessageId)) {
        this.seen.add(event.providerMessageId)
        this.inbound.push(event)
      }
      return new Response("<Response/>", { headers: { "content-type": "text/xml" } })
    }
    if (url.pathname === "/admin/messaging/voice/status") {
      const p = verified.bodyParams
      if (
        !TWILIO_CALL_SID_PATTERN.test(p.CallSid ?? "") ||
        !["completed", "busy", "no-answer", "failed", "canceled"].includes(p.CallStatus ?? "")
      ) {
        return Response.json({ message: "invalid status payload" }, { status: 400 })
      }
      this.statuses.push({ callSid: p.CallSid as string, status: p.CallStatus as string })
      return new Response("", { status: 200 })
    }
    if (url.pathname === "/admin/messaging/voice/recording") {
      const p = verified.bodyParams
      if (
        !TWILIO_RECORDING_SID_PATTERN.test(p.RecordingSid ?? "") ||
        !(p.RecordingUrl ?? "").startsWith("https://") ||
        !TWILIO_CALL_SID_PATTERN.test(p.CallSid ?? "") ||
        !["in-progress", "completed", "absent"].includes(p.RecordingStatus ?? "") ||
        !/^\d+$/.test(p.RecordingDuration ?? "")
      ) {
        return Response.json({ message: "invalid recording payload" }, { status: 400 })
      }
      if (p.RecordingStatus === "completed") {
        this.recordings.push({
          recordingSid: p.RecordingSid as string,
          recordingUrl: p.RecordingUrl as string,
          callSid: p.CallSid as string,
        })
      }
      return new Response("", { status: 200 })
    }
    return new Response("<Response/>", { headers: { "content-type": "text/xml" } })
  }
}

export { E164_PATTERN }
