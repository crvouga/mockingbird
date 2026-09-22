/**
 * A port of our backend's portal-agent integration: `portal-agent-fulfillment.base.ts`
 * (dispatchPortalAgentJob and its strict response parser), the LifeFile adapter's
 * `buildPayload`, the callback receiver in `pharmacy-webhook.controller.ts`
 * (`x-internal-key` equality, `isPortalAgentFulfillmentCallback`) and
 * `ErxFulfillmentService.handlePortalAgentResult` over an in-memory payment record. The
 * acceptance tests drive the mock through it, so "the mock works" means "our consumer's own
 * logic reaches the right outcome".
 */
export type Fetch = (request: Request) => Promise<Response>

export type FulfillmentStatus =
  | "pending"
  | "submitted"
  | "processing"
  | "shipped"
  | "delivered"
  | "error"
  | "cancelled"

export type PortalAgentJobResponse = {
  status: "accepted" | "submitted" | "draft_ready" | "needs_review" | "error"
  agentJobId?: string
  portalOrderId?: string
  portalDraftOrderId?: string
  confirmationNumber?: string
  message?: string
  screenshotArtifactId?: string
  submittedAt?: string
  needsReviewReason?: string
  errorCode?: string
  errorDetail?: string
}

export type ErxFulfillmentResult = {
  success: boolean
  fulfillmentStatus: FulfillmentStatus
  pharmacyOrderId?: string
  portalDraftOrderId?: string
  pharmacyStatus?: string
  portalAgentStatus?: string
  needsReviewReason?: string
  error?: string
}

/** The slice of `ErxEnrichedRequest` the portal payload reads. */
export type EnrichedRequest = {
  paymentId: string
  prescriptionOrderItemId: string | null
  pharmacyId: string
  medicationId: string
  productId: string | null
  catalogId: string | null
  medicationName: string
  strength: string | null
  form: string | null
  drugFamily: string | null
  instructions: string
  quantity: number
  quantityUnit: string | null
  daySupply: number | null
  refills: number
  amountCents: number
  patient: {
    firstName: string
    lastName: string
    dob: string
    gender: string
    phone: string
    email: string
    address: { line1: string; line2: string | null; city: string; state: string; zip: string }
  }
  prescriber: {
    firstName: string
    lastName: string
    credential: string | null
    npi: string
    dea: string | null
    stateLicenseNumber: string | null
    phone: string | null
    fax: string | null
    email: string | null
    address: unknown
  }
}

export const DEFAULT_PORTAL_AGENT_HTTP_TIMEOUT_MS = 20000

export const safeParseJson = (value: string): unknown => {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0

const isPortalAgentJobStatus = (value: unknown): value is PortalAgentJobResponse["status"] =>
  value === "accepted" ||
  value === "submitted" ||
  value === "draft_ready" ||
  value === "needs_review" ||
  value === "error"

export const parsePortalAgentJobResponse = (value: unknown): PortalAgentJobResponse | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const response = value as Record<string, unknown>
  if (!isPortalAgentJobStatus(response.status)) return null
  const optionalFields = [
    "agentJobId",
    "portalOrderId",
    "portalDraftOrderId",
    "confirmationNumber",
    "message",
    "screenshotArtifactId",
    "submittedAt",
    "needsReviewReason",
    "errorCode",
    "errorDetail",
  ] as const
  if (
    optionalFields.some(
      (field) => response[field] !== undefined && typeof response[field] !== "string",
    )
  ) {
    return null
  }
  const hasJobId = isNonEmptyString(response.agentJobId)
  const hasSubmittedOrderId =
    isNonEmptyString(response.portalOrderId) ||
    isNonEmptyString(response.confirmationNumber) ||
    hasJobId
  if (response.status === "accepted" && !hasJobId) return null
  if (response.status === "submitted" && !hasSubmittedOrderId) return null
  if (response.status === "draft_ready" && !isNonEmptyString(response.portalDraftOrderId)) {
    return null
  }
  return response as PortalAgentJobResponse
}

export const portalAgentOrderId = (
  response: PortalAgentJobResponse | null,
  request: EnrichedRequest,
): string =>
  response?.portalOrderId ??
  response?.confirmationNumber ??
  response?.agentJobId ??
  `portal-agent:${request.paymentId}`

export const buildPortalAgentResponseStatus = (response: PortalAgentJobResponse | null) => {
  const status = response?.status ?? "accepted"
  const parts = [`portal_agent_${status}`]
  if (response?.screenshotArtifactId) parts.push(`screenshot=${response.screenshotArtifactId}`)
  if (response?.submittedAt) parts.push(`submittedAt=${response.submittedAt}`)
  if (response?.errorCode) parts.push(`errorCode=${response.errorCode}`)
  if (response?.message) parts.push(`message=${response.message}`)
  return parts.join(" ").slice(0, 255)
}

export const buildPortalAgentErrorMessage = (response: PortalAgentJobResponse): string =>
  response.errorDetail ?? response.message ?? response.errorCode ?? "Portal agent reported an error"

const normalizePortalDraftOrderId = (value: unknown) => {
  const normalized = typeof value === "string" ? value.trim() : ""
  return normalized ? normalized.slice(0, 255) : null
}

const joinName = (firstName: string, lastName: string) =>
  [firstName, lastName].filter(Boolean).join(" ").trim()

/** `buildIdempotencyKey`. */
export const buildIdempotencyKey = (request: EnrichedRequest) =>
  [
    "rx-portal-agent",
    request.paymentId,
    request.prescriptionOrderItemId ?? request.medicationId,
  ].join(":")

/** The LifeFile adapter's `buildPayload` (product-mapping details trimmed to names). */
export const buildPayload = (
  request: EnrichedRequest,
  portalCredentials: { url: string; username: string; password: string },
  flags: { allowSubmit: boolean; stageForProviderSignature: boolean } = {
    allowSubmit: false,
    stageForProviderSignature: false,
  },
) => {
  const portalPharmacyId =
    request.pharmacyId === "rxvortex" || request.pharmacyId === "lifefile"
      ? "lifefile"
      : request.pharmacyId
  return {
    idempotencyKey: buildIdempotencyKey(request),
    paymentId: request.paymentId,
    prescriptionOrderItemId: request.prescriptionOrderItemId,
    pharmacyId: portalPharmacyId,
    allowSubmit: flags.allowSubmit,
    ...(flags.stageForProviderSignature ? { stageForProviderSignature: true } : {}),
    portalCredentials,
    patient: {
      name: joinName(request.patient.firstName, request.patient.lastName),
      firstName: request.patient.firstName,
      lastName: request.patient.lastName,
      dob: request.patient.dob,
      sex: request.patient.gender,
      phone: request.patient.phone,
      email: request.patient.email,
      shippingAddress: {
        line1: request.patient.address.line1,
        line2: request.patient.address.line2,
        city: request.patient.address.city,
        state: request.patient.address.state,
        postalCode: request.patient.address.zip,
        zip: request.patient.address.zip,
        ...(portalPharmacyId === "lifefile"
          ? { recipientType: "Patient", deliveryService: "Temperature Sensitive Shipping" }
          : {}),
      },
    },
    prescriber: {
      name: joinName(request.prescriber.firstName, request.prescriber.lastName),
      firstName: request.prescriber.firstName,
      lastName: request.prescriber.lastName,
      credential: request.prescriber.credential,
      npi: request.prescriber.npi,
      NPI: request.prescriber.npi,
      dea: request.prescriber.dea,
      DEA: request.prescriber.dea,
      stateLicenseNumber: request.prescriber.stateLicenseNumber,
      phone: request.prescriber.phone,
      fax: request.prescriber.fax,
      email: request.prescriber.email,
      address: request.prescriber.address,
    },
    payment: portalPharmacyId === "lifefile" ? { payorType: "Prescriber" } : undefined,
    medication: {
      medicationId: request.medicationId,
      productId: request.productId,
      catalogId: request.catalogId,
      name: request.medicationName,
      productName: request.medicationName,
      strength: request.strength,
      formulation: request.form,
      drugFamily: request.drugFamily,
      productFamily: request.drugFamily,
      portalProductMapping: {
        [portalPharmacyId]: {
          pharmacyId: portalPharmacyId,
          portalProductName: request.medicationName,
          portalProductSearch: request.medicationName,
          portalProductVariant: request.strength ?? undefined,
        },
      },
    },
    sig: request.instructions,
    quantity: request.quantity,
    quantityUnit: request.quantityUnit,
    daysSupply: request.daySupply,
    refills: request.refills,
    amountCents: request.amountCents,
  }
}

/** `PortalAgentFulfillmentAdapterBase.dispatchPortalAgentJob`, over any `fetch`. */
export class PortalAgentConsumer {
  constructor(
    private readonly apiUrl: string,
    private readonly apiKey: string,
    private readonly fetch: Fetch,
    private readonly httpTimeoutMs = DEFAULT_PORTAL_AGENT_HTTP_TIMEOUT_MS,
  ) {}

  async dispatch(request: EnrichedRequest, payload: unknown): Promise<ErxFulfillmentResult> {
    const url = `${this.apiUrl.replace(/\/$/, "")}/rx/portal-fulfillment/jobs`
    let response: Response
    try {
      response = await this.fetch(
        new Request(url, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(this.httpTimeoutMs),
        }),
      )
    } catch (err) {
      const isTimeout = err instanceof Error && err.name === "TimeoutError"
      const message = isTimeout
        ? `Portal agent request timed out after ${this.httpTimeoutMs}ms`
        : `Portal agent request failed: ${err instanceof Error ? err.message : "network error"}`
      return {
        success: false,
        fulfillmentStatus: "error",
        portalAgentStatus: "error",
        error: message,
      }
    }

    const responseText = await response.text()
    const responseBody = parsePortalAgentJobResponse(safeParseJson(responseText))

    if (!response.ok) {
      const message =
        responseBody?.errorDetail ??
        responseBody?.message ??
        `Portal agent request failed with ${response.status}`
      return {
        success: false,
        fulfillmentStatus: "error",
        portalAgentStatus: responseBody?.status ?? "error",
        error: message,
      }
    }

    if (!responseBody) {
      return {
        success: false,
        fulfillmentStatus: "error",
        portalAgentStatus: "error",
        error: "Portal agent returned an invalid success response",
      }
    }

    if (responseBody.status === "draft_ready") {
      const portalDraftOrderId = normalizePortalDraftOrderId(responseBody.portalDraftOrderId)
      return {
        success: false,
        fulfillmentStatus: "processing",
        ...(portalDraftOrderId ? { pharmacyOrderId: portalDraftOrderId, portalDraftOrderId } : {}),
        pharmacyStatus: buildPortalAgentResponseStatus(responseBody),
        portalAgentStatus: "draft_ready",
      }
    }

    if (responseBody.status === "needs_review") {
      const needsReviewReason =
        typeof responseBody.needsReviewReason === "string"
          ? responseBody.needsReviewReason
          : undefined
      const portalDraftOrderId = normalizePortalDraftOrderId(responseBody.portalDraftOrderId)
      return {
        success: false,
        fulfillmentStatus: "error",
        pharmacyOrderId: portalAgentOrderId(responseBody, request),
        ...(portalDraftOrderId ? { portalDraftOrderId } : {}),
        pharmacyStatus: buildPortalAgentResponseStatus(responseBody),
        portalAgentStatus: responseBody.status,
        ...(needsReviewReason !== undefined ? { needsReviewReason } : {}),
        error: `Portal agent needs review: ${needsReviewReason ?? responseBody.message ?? "unspecified reason"}`,
      }
    }

    if (responseBody.status === "error") {
      return {
        success: false,
        fulfillmentStatus: "error",
        pharmacyOrderId: portalAgentOrderId(responseBody, request),
        pharmacyStatus: buildPortalAgentResponseStatus(responseBody),
        portalAgentStatus: responseBody.status,
        error: buildPortalAgentErrorMessage(responseBody),
      }
    }

    return {
      success: true,
      fulfillmentStatus: responseBody.status === "submitted" ? "submitted" : "processing",
      pharmacyOrderId: portalAgentOrderId(responseBody, request),
      pharmacyStatus: buildPortalAgentResponseStatus(responseBody),
      portalAgentStatus: responseBody.status,
    }
  }
}

export type PortalAgentFulfillmentCallback = {
  status: "submitted" | "draft_ready" | "needs_review" | "error"
  paymentId: string
  prescriptionOrderItemId?: string | null
  pharmacyId?: string
  portalOrderId?: string | null
  portalDraftOrderId?: string | null
  confirmationNumber?: string | null
  agentJobId?: string | null
  message?: string | null
  screenshotArtifactId?: string | null
  submittedAt?: string | null
  needsReviewReason?: string | null
  errorCode?: string | null
  errorDetail?: string | null
  fulfillmentStatus?: Exclude<FulfillmentStatus, "pending">
  trackingNumber?: string | null
  trackingCarrier?: string | null
}

const PORTAL_AGENT_PHARMACY_IDS = new Set(["lifefile", "vpi"])
const CALLBACK_STATUSES = new Set(["submitted", "draft_ready", "needs_review", "error"])
const CALLBACK_FULFILLMENT_STATUSES = new Set([
  "submitted",
  "processing",
  "shipped",
  "delivered",
  "error",
  "cancelled",
])
const OPTIONAL_STRING_CALLBACK_FIELDS = [
  "prescriptionOrderItemId",
  "portalOrderId",
  "portalDraftOrderId",
  "confirmationNumber",
  "agentJobId",
  "message",
  "screenshotArtifactId",
  "submittedAt",
  "needsReviewReason",
  "errorCode",
  "errorDetail",
  "trackingNumber",
  "trackingCarrier",
] as const

export const isPortalAgentFulfillmentCallback = (
  value: unknown,
): value is PortalAgentFulfillmentCallback => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const callback = value as Record<string, unknown>
  if (!isNonEmptyString(callback.paymentId) || !CALLBACK_STATUSES.has(String(callback.status))) {
    return false
  }
  if (
    callback.pharmacyId !== undefined &&
    (typeof callback.pharmacyId !== "string" || !PORTAL_AGENT_PHARMACY_IDS.has(callback.pharmacyId))
  ) {
    return false
  }
  if (
    !OPTIONAL_STRING_CALLBACK_FIELDS.every((field) => {
      const v = callback[field]
      return v === undefined || v === null || typeof v === "string"
    })
  ) {
    return false
  }
  if (
    callback.fulfillmentStatus !== undefined &&
    !(
      typeof callback.fulfillmentStatus === "string" &&
      CALLBACK_FULFILLMENT_STATUSES.has(callback.fulfillmentStatus)
    )
  ) {
    return false
  }
  return callback.status !== "draft_ready" || isNonEmptyString(callback.portalDraftOrderId)
}

/** `PharmacyWebhookController.handlePortalAgent`: 401, 400, or 202 with the callback. */
export const receiveCallback = (
  expectedKey: string | undefined,
  headers: Headers,
  body: unknown,
): { status: 401 | 400 } | { status: 202; callback: PortalAgentFulfillmentCallback } => {
  const internalKey = headers.get("x-internal-key") ?? undefined
  if (!expectedKey || !internalKey || internalKey !== expectedKey) return { status: 401 }
  if (!isPortalAgentFulfillmentCallback(body)) return { status: 400 }
  return { status: 202, callback: body }
}

/** The fields of a prescription payment `handlePortalAgentResult` reads and writes. */
export type PaymentRecord = {
  id: string
  pharmacyId: string | null
  fulfillmentStatus: FulfillmentStatus
  pharmacyOrderId: string | null
  pharmacyStatus: string | null
  portalAgentStatus: string | null
  trackingNumber: string | null
  trackingCarrier: string | null
  fulfillmentError: string | null
}

const PORTAL_CALLBACK_PROTECTED_STATUSES = new Set<FulfillmentStatus>([
  "shipped",
  "delivered",
  "cancelled",
  "error",
])
export const isPortalCallbackApplicable = (status: FulfillmentStatus) =>
  !PORTAL_CALLBACK_PROTECTED_STATUSES.has(status)

const buildPortalAgentStatus = (
  result: PortalAgentFulfillmentCallback,
  portalAgentStatus: string = result.status,
) => {
  const parts = [`portal_agent_${portalAgentStatus}`]
  if (result.screenshotArtifactId) parts.push(`screenshot=${result.screenshotArtifactId}`)
  if (result.message) parts.push(`message=${result.message}`)
  return parts.join(" ").slice(0, 255)
}

/**
 * `ErxFulfillmentService.handlePortalAgentResult`: returns `"ignored"` where the service logs
 * and returns, otherwise mutates the payment the way `updateFulfillment` would.
 */
export const applyPortalAgentResult = (
  payment: PaymentRecord,
  result: PortalAgentFulfillmentCallback,
): "applied" | "ignored" => {
  if (!payment.pharmacyId || !PORTAL_AGENT_PHARMACY_IDS.has(payment.pharmacyId)) return "ignored"
  if (!isPortalCallbackApplicable(payment.fulfillmentStatus)) return "ignored"

  const portalDraftOrderId = normalizePortalDraftOrderId(result.portalDraftOrderId)
  const isDraftReady =
    result.status === "draft_ready" ||
    (result.status === "needs_review" && portalDraftOrderId !== null)
  const pharmacyOrderId =
    (isDraftReady ? portalDraftOrderId : null) ??
    result.portalOrderId ??
    result.confirmationNumber ??
    result.agentJobId ??
    payment.pharmacyOrderId
  const portalAgentStatus = isDraftReady ? "draft_ready" : result.status
  const pharmacyStatus = buildPortalAgentStatus(result, portalAgentStatus)

  if (isDraftReady && portalDraftOrderId) {
    Object.assign(payment, {
      fulfillmentStatus: "processing",
      pharmacyOrderId: portalDraftOrderId,
      pharmacyStatus,
      portalAgentStatus,
      fulfillmentError: null,
    })
    return "applied"
  }
  if (result.status === "submitted") {
    Object.assign(payment, {
      fulfillmentStatus: result.fulfillmentStatus ?? "submitted",
      pharmacyOrderId,
      pharmacyStatus,
      portalAgentStatus,
      trackingNumber: result.trackingNumber ?? payment.trackingNumber,
      trackingCarrier: result.trackingCarrier ?? payment.trackingCarrier,
      fulfillmentError: null,
    })
    return "applied"
  }
  const message =
    result.status === "needs_review"
      ? `Portal agent needs review: ${result.needsReviewReason ?? result.message ?? "unspecified reason"}`
      : `Portal agent error: ${result.errorDetail ?? result.message ?? result.errorCode ?? "unspecified error"}`
  Object.assign(payment, {
    fulfillmentStatus: "error",
    pharmacyOrderId,
    pharmacyStatus,
    portalAgentStatus,
    fulfillmentError: message,
  })
  return "applied"
}

/** How the fulfilment service records a dispatch result on the payment. */
export const applyDispatchResult = (payment: PaymentRecord, result: ErxFulfillmentResult) => {
  Object.assign(payment, {
    fulfillmentStatus: result.fulfillmentStatus,
    pharmacyOrderId: result.pharmacyOrderId ?? payment.pharmacyOrderId,
    pharmacyStatus: result.pharmacyStatus ?? payment.pharmacyStatus,
    portalAgentStatus: result.portalAgentStatus ?? payment.portalAgentStatus,
    fulfillmentError: result.success ? null : (result.error ?? null),
  })
}

export const newPayment = (id: string): PaymentRecord => ({
  id,
  pharmacyId: "lifefile",
  fulfillmentStatus: "pending",
  pharmacyOrderId: null,
  pharmacyStatus: null,
  portalAgentStatus: null,
  trackingNumber: null,
  trackingCarrier: null,
  fulfillmentError: null,
})

/** An enriched testosterone request the way enrichment shapes one. */
export const sampleRequest = (paymentId: string): EnrichedRequest => ({
  paymentId,
  prescriptionOrderItemId: `poi_${paymentId}`,
  pharmacyId: "rxvortex",
  medicationId: "testosterone-cypionate-200",
  productId: "testosterone-cypionate",
  catalogId: "rxvortex:1c0b7f7e",
  medicationName: "Testosterone Cypionate",
  strength: "200 mg/mL",
  form: "Injectable",
  drugFamily: "testosterone",
  instructions: "Inject 0.5 mL intramuscularly once weekly",
  quantity: 10,
  quantityUnit: "mL",
  daySupply: 70,
  refills: 0,
  amountCents: 14900,
  patient: {
    firstName: "Ada",
    lastName: "Lovelace",
    dob: "1985-02-14",
    gender: "female",
    phone: "6025550142",
    email: "ada@example.com",
    address: { line1: "1 Main St", line2: null, city: "Phoenix", state: "AZ", zip: "85004" },
  },
  prescriber: {
    firstName: "Grace",
    lastName: "Hopper",
    credential: "MD",
    npi: "1234567893",
    dea: "AH1234563",
    stateLicenseNumber: "MD-1",
    phone: "6025550100",
    fax: null,
    email: "grace@example.com",
    address: null,
  },
})

export const PORTAL_CREDENTIALS = {
  url: "https://host.lifefile.net/portal",
  username: "dr.hopper",
  password: "portal-password-do-not-log",
}
