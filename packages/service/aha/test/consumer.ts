/**
 * A port of our backend's AHA consumers: `AhaService.requestAha` (raw envelope, used by the
 * bloodwork checkout), `AhaLabProvider.ahaJson` (wrapped envelope, X-Idempotency-Key, the
 * lab-provider port), their zod schemas, the `AhaWebhookGuard`, and
 * `BloodworkService.processAhaWebhook` (GV-(\d+) parsing, status normalisation, the
 * `scheduleServiceTime` / `scheduleServiceTimeZone` extraction and each handler's effect).
 * The acceptance tests drive the mock through it, so "the mock works" means "our consumer's
 * own logic reaches the right outcome".
 */
import { createHash, createHmac } from "node:crypto"

export type Fetch = (request: Request) => Promise<Response>

export type AhaConfig = {
  apiUrl: string
  apiKey: string
  apiSecret?: string
  useLegacyAuth?: boolean
}

type AhaError = { code: string; message: string; details?: unknown }

// --- zod schemas (aha.types.ts), hand-ported --------------------------------------------

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)
const isStatus = (v: unknown) => v === "SUCCESS" || v === "ERROR"

/** `AhaCreateOrderResponseSchema` */
export const parseCreateOrderResponse = (v: unknown) =>
  isObject(v) &&
  isObject(v.content) &&
  typeof v.content.partner_order_id === "string" &&
  typeof v.content.order_number === "string" &&
  typeof v.message === "string" &&
  isStatus(v.status)
    ? (v as {
        content: { partner_order_id: string; order_number: string }
        message: string
        status: "SUCCESS" | "ERROR"
      })
    : null

/** `AhaCancelOrderResponseSchema` */
export const parseCancelOrderResponse = (v: unknown) =>
  isObject(v) && typeof v.message === "string" && isStatus(v.status)
    ? (v as { message: string; status: "SUCCESS" | "ERROR" })
    : null

/** `AhaApiResponseSchema(inner)`: `{success: boolean, data?: inner, error?}` */
const parseWrapped = <T>(v: unknown, inner: (x: unknown) => T | null) => {
  if (!isObject(v) || typeof v.success !== "boolean") return null
  if (v.data === undefined) return { success: v.success, data: undefined }
  const data = inner(v.data)
  return data ? { success: v.success, data } : null
}

export type CreateOrderRequest = {
  partner_order_id: string
  patient_first_name: string
  patient_id: string
  patient_middle_initial?: string
  patient_last_name: string
  biological_sex: "Male" | "Female" | "Non-binary"
  patient_dob: string
  patient_phone_number: string
  patient_email_address?: string
  patient_address_line1: string
  patient_address_line2?: string
  patient_city: string
  patient_state: string
  patient_zipcode: string
  service_type: "Full Service" | "Draw Only" | "Pickup Only"
  preferred_schedule_date?: string
  preferred_schedule_time?: string
  patient_timezone?: string
  npi: string
  ordering_physician: string
  test_codes: { test_code: string; test_description: string }[]
}

// --- AhaService (the live bloodwork path; raw envelope) ----------------------------------

export class AhaServiceConsumer {
  constructor(
    private readonly config: AhaConfig,
    private readonly send: Fetch,
    private readonly now: () => number = Date.now,
  ) {}

  formatPartnerOrderId(sequence: number): string {
    return `GV-${sequence}`
  }

  private async requestAha<T>(path: string, body: unknown, parse: (v: unknown) => T | null) {
    const { apiUrl, apiKey, apiSecret, useLegacyAuth } = this.config
    if (!useLegacyAuth && !apiSecret) {
      return {
        success: false as const,
        error: { code: "CONFIGURATION_ERROR", message: "AHA API Secret not found." } as AhaError,
      }
    }
    let authHeaders: Record<string, string>
    if (useLegacyAuth) {
      authHeaders = { "X-Geviti-Auth-Key": apiKey, "X-API-Version": "1.0" }
    } else {
      const timestamp = this.now().toString()
      const signature = createHmac("sha256", apiSecret as string)
        .update(`${apiKey}:${path}:${timestamp}`)
        .digest("base64")
      authHeaders = { "X-API-KEY": apiKey, "X-TIMESTAMP": timestamp, "X-SIGNATURE": signature }
    }
    try {
      const response = await this.send(
        new Request(`${apiUrl}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders },
          body: JSON.stringify(body),
        }),
      )
      if (!response.ok) {
        const errorText = await response.text()
        return {
          success: false as const,
          error: {
            code: "AHA_API_ERROR",
            message: `AHA API returned ${response.status}`,
            details: errorText,
          } as AhaError,
        }
      }
      const parsed = parse(await response.json())
      if (!parsed) {
        return {
          success: false as const,
          error: {
            code: "INVALID_RESPONSE",
            message: "Invalid response format from AHA API",
          } as AhaError,
        }
      }
      return { success: true as const, data: parsed }
    } catch (error) {
      return {
        success: false as const,
        error: {
          code: "API_CALL_ERROR",
          message: "Failed to call AHA API",
          details: error instanceof Error ? error.message : "Unknown error",
        } as AhaError,
      }
    }
  }

  async createOrUpdateOrder(orderData: CreateOrderRequest) {
    const response = await this.requestAha(
      "/v1/geviti/create-order",
      orderData,
      parseCreateOrderResponse,
    )
    if (response.success) {
      // Our code never checks the inner status here (only the lab provider does).
      return {
        success: true as const,
        ahaOrderNumber: response.data.content.order_number,
        partnerOrderId: response.data.content.partner_order_id,
        message: response.data.message,
      }
    }
    return { success: false as const, error: response.error }
  }

  async cancelOrder(partnerOrderSequence: number, reason?: string) {
    const response = await this.requestAha(
      "/v1/geviti/cancel",
      {
        partner_order_id: `GV-${partnerOrderSequence.toString()}`,
        notes: [{ note_type: "CANCELLATION", notes: reason ?? "Order cancelled via API" }],
      },
      parseCancelOrderResponse,
    )
    if (response.success) {
      return {
        success: true as const,
        message: response.data.message,
        status: response.data.status,
      }
    }
    return { success: false as const, error: response.error }
  }
}

/** `createAhaOrderFromLabResult`'s request mapping (the parts that shape the wire body). */
export const bloodworkOrderRequest = (
  sequence: number,
  user: {
    id: number
    firstName: string
    lastName: string
    sex: string
    dob: string
    phoneNumber: string
    email: string
  },
  address: { line1: string; line2?: string; city: string; state: string; zip: string },
  practitioner: { firstName: string; lastName: string; npiNumber: string },
  testCodes: { test_code: string; test_description: string }[],
): CreateOrderRequest => {
  const sex = user.sex.toLowerCase()
  return {
    partner_order_id: `GV-${sequence}`,
    patient_first_name: user.firstName,
    patient_id: `${user.id}`,
    patient_middle_initial: "",
    patient_last_name: user.lastName,
    biological_sex:
      sex === "male" || sex === "m"
        ? "Male"
        : sex === "female" || sex === "f"
          ? "Female"
          : "Non-binary",
    patient_dob: user.dob,
    patient_phone_number: user.phoneNumber.replace(/\D/g, "").replace(/^1/, "") || "",
    patient_email_address: user.email,
    patient_address_line1: address.line1,
    patient_address_line2: address.line2 ?? "",
    patient_city: address.city,
    patient_state: address.state,
    patient_zipcode: address.zip,
    service_type: "Full Service",
    npi: practitioner.npiNumber,
    ordering_physician: `${practitioner.firstName} ${practitioner.lastName}`,
    test_codes: testCodes,
  }
}

// --- AhaLabProvider (the lab-provider port; wrapped envelope) ----------------------------

export type LabProviderError = { code: string; message: string; retryable: boolean }

export const partnerSequenceFromIdempotencyKey = (key: string): number => {
  const hex = createHash("sha256").update(key).digest("hex").slice(0, 8)
  return (Number.parseInt(hex, 16) % 2_000_000_000) + 1
}

const labError = (message: string, code: string): LabProviderError => ({
  code,
  message,
  retryable: code === "upstream" || code === "unknown" || code === "rate_limit",
})

export class AhaLabProviderConsumer {
  constructor(
    private readonly config: AhaConfig,
    private readonly send: Fetch,
    private readonly now: () => number = Date.now,
  ) {}

  private async ahaJson(path: string, body: unknown, idempotencyKey?: string) {
    const { apiKey, apiSecret, useLegacyAuth } = this.config
    if (!useLegacyAuth && !apiSecret) {
      return {
        ok: false as const,
        error: labError("AHA_API_SECRET required when AHA_USE_LEGACY_AUTH is false", "validation"),
      }
    }
    let authHeaders: Record<string, string>
    if (useLegacyAuth) {
      authHeaders = { "X-Geviti-Auth-Key": apiKey, "X-API-Version": "1.0" }
    } else {
      const timestamp = this.now().toString()
      const signature = createHmac("sha256", apiSecret as string)
        .update(`${apiKey}:${path}:${timestamp}`)
        .digest("base64")
      authHeaders = { "X-API-KEY": apiKey, "X-TIMESTAMP": timestamp, "X-SIGNATURE": signature }
    }
    const res = await this.send(
      new Request(`${this.config.apiUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders,
          ...(idempotencyKey ? { "X-Idempotency-Key": idempotencyKey } : {}),
        },
        body: JSON.stringify(body ?? {}),
      }),
    )
    if (!res.ok) {
      const text = await res.text()
      return {
        ok: false as const,
        error: labError(
          `AHA HTTP ${res.status}: ${text}`,
          res.status === 429 ? "rate_limit" : "upstream",
        ),
      }
    }
    return { ok: true as const, json: (await res.json()) as unknown }
  }

  async placeOrder(req: {
    idempotencyKey: string
    patient: {
      firstName: string
      lastName: string
      providerPatientId: string
      sex: "male" | "female" | "other"
      dob: string
      phone?: string
      email?: string
    }
    address: { line1: string; line2?: string; city: string; state: string; zip: string }
    orderingPhysician: { npi: string; fullName: string }
    providerProductIds: string[]
  }) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(req.patient.dob)) {
      return {
        ok: false as const,
        error: labError("patient.dob is required for AHA in YYYY-MM-DD format", "validation"),
      }
    }
    const partnerOrderId = `GV-${partnerSequenceFromIdempotencyKey(req.idempotencyKey)}`
    const body: CreateOrderRequest = {
      partner_order_id: partnerOrderId,
      patient_first_name: req.patient.firstName,
      patient_id: req.patient.providerPatientId,
      patient_last_name: req.patient.lastName,
      biological_sex:
        req.patient.sex === "male"
          ? "Male"
          : req.patient.sex === "female"
            ? "Female"
            : "Non-binary",
      patient_dob: req.patient.dob,
      patient_phone_number: req.patient.phone ?? "+10000000000",
      ...(req.patient.email !== undefined ? { patient_email_address: req.patient.email } : {}),
      patient_address_line1: req.address.line1,
      ...(req.address.line2 !== undefined ? { patient_address_line2: req.address.line2 } : {}),
      patient_city: req.address.city,
      patient_state: req.address.state,
      patient_zipcode: req.address.zip,
      service_type: "Full Service",
      npi: req.orderingPhysician.npi,
      ordering_physician: req.orderingPhysician.fullName,
      test_codes: req.providerProductIds.map((id) => ({ test_code: id, test_description: id })),
    }
    const res = await this.ahaJson("/v1/geviti/create-order", body, req.idempotencyKey)
    if (!res.ok) return { ok: false as const, error: res.error }
    const wrapped = parseWrapped(res.json, parseCreateOrderResponse)
    if (!wrapped?.success) {
      return { ok: false as const, error: labError("Unexpected AHA create response", "upstream") }
    }
    const inner = wrapped.data
    if (!inner || inner.status === "ERROR") {
      return {
        ok: false as const,
        error: labError(inner?.message ?? "AHA returned ERROR", "upstream"),
      }
    }
    return {
      ok: true as const,
      partnerOrderId,
      providerOrderId: inner.content.order_number,
      status: "placed" as const,
    }
  }

  async cancelOrder(req: { providerOrderId: string; reason?: string; idempotencyKey?: string }) {
    // Faithful to the code: the lab provider sends its providerOrderId (AHA's order_number)
    // in the partner_order_id field (G-A1).
    const res = await this.ahaJson(
      "/v1/geviti/cancel",
      {
        partner_order_id: req.providerOrderId,
        notes: [{ note_type: "CANCELLATION", notes: req.reason ?? "Cancelled via lab-provider" }],
      },
      req.idempotencyKey,
    )
    if (!res.ok) return { ok: false as const, error: res.error }
    const wrapped = parseWrapped(res.json, parseCancelOrderResponse)
    if (!wrapped?.success) {
      return { ok: false as const, error: labError("Unexpected AHA cancel response", "upstream") }
    }
    const inner = wrapped.data
    if (!inner || inner.status === "ERROR") {
      return {
        ok: false as const,
        error: labError(inner?.message ?? "AHA cancel ERROR", "upstream"),
      }
    }
    return { ok: true as const, status: "cancelled" as const }
  }
}

// --- the webhook receiver (AhaWebhookGuard + BloodworkService.processAhaWebhook) -------------

/** `AhaWebhookGuard.canActivate`: `Authorization: Token <AHA_WEBHOOK_SECRET>`. */
export const guardAllows = (headers: Headers, secret: string): boolean => {
  const authorization = headers.get("authorization")
  if (!authorization?.toLowerCase().startsWith("token ")) return false
  const [, token] = authorization.split(" ")
  return token === secret
}

const STOREFRONT: Record<string, string> = {
  order_placed: "bloodwork.Awaiting Scheduling",
  scheduled: "bloodwork.Awaiting Draw",
  rescheduled: "bloodwork.Awaiting Draw",
  checked_in: "bloodwork.Awaiting Draw",
  draw_completed: "bloodwork.Results Pending",
  draw_failed_refused: "bloodwork.Cancelled",
  draw_failed_uto: "bloodwork.Cancelled",
  draw_failed_not_home: "bloodwork.Cancelled",
  draw_failed_rescheduled: "bloodwork.Cancelled",
  draw_failed_cancelled: "bloodwork.Cancelled",
  draw_failed_other: "bloodwork.Cancelled",
  lab_testing: "bloodwork.Results Pending",
  cancelled: "bloodwork.Cancelled",
}

/** `mapAhaStatusToInternal` */
export const mapAhaStatusToInternal = (
  orderStatus: string,
  drawStatus?: string,
): { internalStatus: string | null; drawStatusCode?: string } => {
  const normalizedOrder = orderStatus.toLowerCase().replace(/\s+/g, "_")
  if (normalizedOrder === "check_out" && drawStatus) {
    const normalizedDraw = drawStatus.toLowerCase().replace(/\s+/g, "_")
    if (normalizedDraw === "sample_collected" || normalizedDraw === "completed") {
      return { internalStatus: "draw_completed", drawStatusCode: normalizedDraw }
    }
    const failureMap: Record<string, string> = {
      patient_refused: "draw_failed_refused",
      uto: "draw_failed_uto",
      patient_not_home: "draw_failed_not_home",
      patient_rescheduled: "draw_failed_rescheduled",
      order_cancelled: "draw_failed_cancelled",
      others: "draw_failed_other",
    }
    return {
      internalStatus: failureMap[normalizedDraw] || "draw_failed_other",
      drawStatusCode: normalizedDraw,
    }
  }
  const statusMap: Record<string, string | null> = {
    scheduled: "scheduled",
    rescheduled: "rescheduled",
    cancelled: "cancelled",
    check_in: "checked_in",
    lab_testing_in_progress: "lab_testing",
    non_scheduled_update: null,
  }
  // As written, `null ?? normalizedOrder` means `non_scheduled_update` is never "ignored" by
  // the `!internalStatus` check: it reaches the default branch and logs "Unknown internal
  // status" (still a no-op, but not the path the catalog describes).
  return { internalStatus: statusMap[normalizedOrder] ?? normalizedOrder }
}

/**
 * `moment.tz(localString, zone).utc()`, independently of the mock's own helper: read the
 * zone's UTC offset with `Intl` (`longOffset`) at the naive instant, then correct once.
 */
export const momentTzToUtc = (local: string, zone: string): number => {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local)
  if (!m) return Number.NaN
  const n = m.slice(1).map((part) => Number(part ?? 0))
  const naive = Date.UTC(n[0] ?? 0, (n[1] ?? 1) - 1, n[2], n[3], n[4], n[5])
  const offsetAt = (instant: number) => {
    const name =
      new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" })
        .formatToParts(new Date(instant))
        .find((p) => p.type === "timeZoneName")?.value ?? "GMT"
    const o = /GMT([+-])(\d{2}):(\d{2})/.exec(name)
    return o ? (o[1] === "-" ? -1 : 1) * (Number(o[2]) * 60 + Number(o[3])) * 60_000 : 0
  }
  const first = naive - offsetAt(naive)
  return naive - offsetAt(first)
}

/** What our app records for one AHA order: the DB flags the webhook handlers set. */
export type AppOrder = {
  sequence: number
  ahaOrderId: string
  status: string
  storefrontStatus: string
  hasScheduledInitialBloodwork: boolean
  vitalAppointmentScheduled: boolean
  vitalBloodDrawn: boolean
  isTestCancelled: boolean
  /** The EMR appointment (BOOK_LAB_DRAW_APPOINTMENT / UPDATE_APPOINTMENT jobs). */
  appointment: { at: string; status: "booked" | "rescheduled" | "cancelled" } | null
  slack: { messageType: string; incident: boolean }[]
}

/** The slice of our backend a webhook reaches: the handler's parsing and each branch's writes. */
export class AhaWebhookReceiver {
  readonly orders = new Map<number, AppOrder>()
  readonly log: string[] = []

  constructor(private readonly secret: string) {}

  /** What `aha.bloodwork.service` records after a successful create-order. */
  track(sequence: number, ahaOrderId: string): void {
    this.orders.set(sequence, {
      sequence,
      ahaOrderId,
      status: "scheduled",
      storefrontStatus: STOREFRONT.order_placed as string,
      hasScheduledInitialBloodwork: false,
      vitalAppointmentScheduled: false,
      vitalBloodDrawn: false,
      isTestCancelled: false,
      appointment: null,
      slack: [],
    })
  }

  /** The controller: the guard, then `processAhaWebhook` (fire-and-forget; always 200). */
  receive(
    headers: Headers,
    payload: Record<string, unknown>,
  ): { http: number; processed: boolean } {
    if (!guardAllows(headers, this.secret)) return { http: 403, processed: false }
    return { http: 201, processed: this.process(payload) }
  }

  process(payload: Record<string, unknown>): boolean {
    const partnerOrderIdStr = payload.partnerOrderId
    if (typeof partnerOrderIdStr !== "string" || !partnerOrderIdStr) {
      this.log.push("Missing partnerOrderId")
      return false
    }
    const match = partnerOrderIdStr.match(/^GV-(\d+)$/)
    const sequence = match ? Number.parseInt(match[1] as string, 10) : null
    if (!sequence) {
      this.log.push(`Invalid partner order ID format: ${partnerOrderIdStr}`)
      return false
    }
    const order = this.orders.get(sequence)
    if (!order) {
      this.log.push(`No AHA order found for sequence: ${sequence}`)
      return false
    }
    const { internalStatus } = mapAhaStatusToInternal(
      String(payload.status),
      typeof payload.drawStatus === "string" ? payload.drawStatus : undefined,
    )
    if (!internalStatus) return true
    try {
      switch (internalStatus) {
        case "scheduled":
        case "rescheduled": {
          const at = this.appointmentUtc(payload)
          order.status = internalStatus
          if (internalStatus === "scheduled") {
            order.hasScheduledInitialBloodwork = true
            order.vitalAppointmentScheduled = true
            order.appointment = { at, status: "booked" }
          } else if (order.appointment) {
            order.appointment = { at, status: "rescheduled" }
          } else {
            throw new Error("Error fetching medplum appointment details by lab result ID.")
          }
          order.storefrontStatus = STOREFRONT[internalStatus] as string
          order.slack.push({ messageType: "schedule_update", incident: false })
          break
        }
        case "cancelled":
          order.isTestCancelled = true
          order.status = internalStatus
          if (!order.appointment) throw new Error("Cannot read appointment details from lab result")
          order.appointment = { ...order.appointment, status: "cancelled" }
          order.storefrontStatus = STOREFRONT.cancelled as string
          order.slack.push({ messageType: "status_update", incident: false })
          break
        case "checked_in":
        case "lab_testing":
          order.status = internalStatus
          order.storefrontStatus = STOREFRONT[internalStatus] as string
          order.slack.push({ messageType: "status_update", incident: false })
          break
        case "draw_completed":
          order.vitalBloodDrawn = true
          order.status = internalStatus
          order.storefrontStatus = STOREFRONT.draw_completed as string
          order.slack.push({ messageType: "status_update", incident: false })
          break
        default:
          if (!internalStatus.startsWith("draw_failed_")) {
            this.log.push(`Unknown internal status: ${internalStatus}`)
            break
          }
          order.isTestCancelled = true
          order.status = internalStatus
          if (!order.appointment) throw new Error("Cannot read appointment details from lab result")
          order.appointment = { ...order.appointment, status: "cancelled" }
          order.storefrontStatus = STOREFRONT[internalStatus] as string
          order.slack.push({ messageType: "incident", incident: true })
      }
      return true
    } catch (error) {
      this.log.push(error instanceof Error ? error.message : String(error))
      return false
    }
  }

  /** `extractAppointmentDate` + `extractTimeZone` + `moment.tz(...).utc()`. */
  private appointmentUtc(payload: Record<string, unknown>): string {
    const time = payload.scheduleServiceTime
    if (typeof time !== "string")
      throw new Error("Missing appointment date/time in webhook payload")
    const zone = payload.scheduleServiceTimeZone
    if (typeof zone !== "string") throw new Error("Missing timezone in webhook payload")
    return new Date(momentTzToUtc(time, zone)).toISOString()
  }
}
