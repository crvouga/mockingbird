/**
 * A port of our backend's Pharmetika integration (`pharmetika-fulfillment.adapter.ts`,
 * `pharmetika-live.client.ts`, `ensureWebhookSecret`, and the parts of
 * `ErxFulfillmentService.handleWebhook` that apply a webhook to a payment): the same
 * requests, headers, field fallbacks, success rule and status interpretation. The acceptance
 * tests drive the mock through it, so "the mock works" means "our consumer's own logic
 * reaches the right outcome".
 */
export type FulfillmentStatus =
  | "pending"
  | "submitted"
  | "processing"
  | "shipped"
  | "delivered"
  | "error"
  | "cancelled"

export type Fetch = (request: Request) => Promise<Response>

type PharmetikaResponse = {
  success?: 0 | 1 | boolean | string
  messages?: { message?: string; msg?: string; type?: string }[]
  data?: Record<string, unknown> | unknown[]
  patient_id?: number
  duplicate_entry_count?: number
  duplicate_entries?: PatientListEntry[]
}

type PatientListEntry = {
  patient_id?: number
  demographics?: {
    first_name?: string
    last_name?: string
    DOB?: string
    email?: string
    phone_primary?: string | number
    line_1?: string
    postal_code?: string
  }
}

type ClinicListEntry = { identifier?: string; data?: { name?: string } }

/** The slice of `ErxEnrichedRequest` the adapter reads. */
export type EnrichedRequest = {
  paymentId: string
  prescriberPharmetikaIdentifier?: string | null
  clinic?: { clinicIdentifier?: string; name?: string } | null
  patient: {
    firstName: string
    lastName: string
    gender: string
    dob: string
    email: string
    phone: string
    address: { line1: string; line2: string | null; city: string; state: string; zip: string }
  }
  catalogId: string | null
  medicationId: string
  medicationName: string
  strength: string | null
  quantity: number
  quantityUnit: string | null
  daySupply: number | null
  instructions: string
  reasonForCompounding: { code: string; description?: string; context?: string } | null
}

export type FulfillmentResult = {
  success: boolean
  fulfillmentStatus: FulfillmentStatus
  pharmacyOrderId?: string
  pharmacyStatus?: string
  pharmacyPortalUrl?: string
  error?: string
}

// --- helpers, verbatim in behaviour -------------------------------------------------------

/** UUIDv7 over an injectable clock (the adapter uses `Date.now()` and `randomBytes`). */
export const generateUuidV7 = (now: number = Date.now()) => {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  const timestamp = BigInt(now)
  bytes[0] = Number((timestamp >> 40n) & 0xffn)
  bytes[1] = Number((timestamp >> 32n) & 0xffn)
  bytes[2] = Number((timestamp >> 24n) & 0xffn)
  bytes[3] = Number((timestamp >> 16n) & 0xffn)
  bytes[4] = Number((timestamp >> 8n) & 0xffn)
  bytes[5] = Number(timestamp & 0xffn)
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x70
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

const normalizeDigits = (value: string | number | null | undefined) =>
  String(value ?? "").replace(/\D/g, "")
const normalizeName = (value: string | null | undefined) =>
  String(value ?? "")
    .trim()
    .toLowerCase()
const normalizeDate = (value: string | null | undefined) => String(value ?? "").slice(0, 10)

const normalizePharmetikaGender = (gender: string | null | undefined) => {
  const normalized = normalizeName(gender)
  if (normalized === "male" || normalized === "m") return "M"
  if (normalized === "female" || normalized === "f") return "F"
  if (normalized === "other" || normalized === "o") return "O"
  return "U"
}

const normalizeFhirGender = (gender: string | null | undefined) => {
  const normalized = normalizeName(gender)
  if (normalized === "m") return "male"
  if (normalized === "f") return "female"
  if (normalized === "o") return "other"
  if (normalized === "u") return "unknown"
  return normalized || "unknown"
}

const normalizeProductIdentifier = (value: string) =>
  value.startsWith("pharmetika:") ? value.slice("pharmetika:".length) : value

export const formatMessages = (body: PharmetikaResponse | null, fallback = "Validation failed") => {
  const messages = Array.isArray(body?.messages)
    ? body.messages
        .map((message) => message.message ?? message.msg ?? "")
        .filter((message) => message.length > 0)
    : []
  return messages.join("; ") || fallback
}

/** The success rule: only `true` or `1` counts. HTTP 200 with `success: 0` is a failure. */
export const isPharmetikaSuccess = (body: PharmetikaResponse | null) =>
  body?.success === true || body?.success === 1

const isSamePatient = (entry: PatientListEntry, request: EnrichedRequest) => {
  const d = entry.demographics
  if (!d) return false
  return (
    normalizeName(d.first_name) === normalizeName(request.patient.firstName) &&
    normalizeName(d.last_name) === normalizeName(request.patient.lastName) &&
    normalizeDate(d.DOB) === normalizeDate(request.patient.dob)
  )
}

const patientMatchScore = (entry: PatientListEntry, request: EnrichedRequest) => {
  const d = entry.demographics
  if (!d) return 0
  let score = 0
  if (normalizeDigits(d.phone_primary) === normalizeDigits(request.patient.phone)) score += 2
  if (normalizeName(d.email) === normalizeName(request.patient.email)) score += 1
  if (normalizeName(d.line_1) === normalizeName(request.patient.address.line1)) score += 1
  if (normalizeDigits(d.postal_code) === normalizeDigits(request.patient.address.zip)) score += 1
  return score
}

const safeParseJson = (text: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
}

const readRecord = (
  value: Record<string, unknown> | null | undefined,
  path: string[],
): Record<string, unknown> | null => {
  let current: unknown = value
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return null
    current = (current as Record<string, unknown>)[key]
  }
  return current && typeof current === "object" && !Array.isArray(current)
    ? (current as Record<string, unknown>)
    : null
}

const readString = (
  value: Record<string, unknown> | null | undefined,
  path: string[],
): string | null => {
  let current: unknown = value
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return null
    current = (current as Record<string, unknown>)[key]
  }
  return typeof current === "string" && current.trim().length > 0 ? current : null
}

/** `PharmetikaFulfillmentAdapter.mapStatus`, verbatim. */
export const mapStatus = (workflowStatus: string): FulfillmentStatus => {
  const s = workflowStatus.toLowerCase()
  if (s === "completed" || s === "shipped-received" || s === "delivered") return "delivered"
  if (s === "shipped" || s === "completed orders") return "shipped"
  if (s === "cancelled") return "cancelled"
  if (
    s === "data_entry_queue" ||
    s === "data_entry" ||
    s === "data_entry_clarification" ||
    s === "data_entry_rework" ||
    s === "data_entry_verification" ||
    s === "lab_formulation" ||
    s === "contacting_patient" ||
    s === "filled" ||
    s.startsWith("compounding") ||
    s === "dispensed" ||
    s === "dispense_checked" ||
    s === "dispense_verified" ||
    s === "order_reconciliation" ||
    s === "shipping" ||
    s === "signed" ||
    s === "verified" ||
    s === "checked" ||
    s === "ready" ||
    s === "ready-ship" ||
    s === "complete processing"
  ) {
    return "processing"
  }
  return "submitted"
}

const isCancelableStatus = (rawStatus: string | null) => {
  const normalized = rawStatus?.trim().toLowerCase() ?? ""
  return (
    normalized.length > 0 &&
    !["cancelled", "shipped", "completed", "delivered"].includes(normalized)
  )
}

// --- the adapter ------------------------------------------------------------------------

export type ConsumerConfig = {
  apiUrl: string
  apiToken: string
  practitionerIdentifier: string | null
  webhookSecret: string | null
  clinicName?: string
}

/**
 * `PharmetikaFulfillmentAdapter` over any `fetch`, with the payment repository's
 * `ensurePharmacyOrderId` (persist the UUIDv7 once per payment) as an in-memory map.
 */
export class PharmetikaConsumer {
  private clinicIdentifierCache: string | null | undefined
  /** paymentId → persisted medication_order_identifier. */
  readonly persisted = new Map<string, string>()
  /** Every URL + method the adapter called, in order (tests assert the call sequence). */
  readonly calls: string[] = []

  constructor(
    private readonly config: ConsumerConfig,
    private readonly send: Fetch,
    private readonly now: () => number = Date.now,
  ) {}

  private fetch(url: string, init: RequestInit) {
    this.calls.push(`${init.method ?? "GET"} ${new URL(url).pathname}`)
    return this.send(new Request(url, init))
  }

  private buildHeaders(): Record<string, string> {
    return {
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-pmk-authentication-token": this.config.apiToken,
    }
  }

  private base() {
    return this.config.apiUrl.replace(/\/$/, "")
  }

  private resolvePractitionerIdentifier(request: EnrichedRequest) {
    return request.prescriberPharmetikaIdentifier || this.config.practitionerIdentifier
  }

  private ensurePharmacyOrderId(paymentId: string, candidate: string) {
    const existing = this.persisted.get(paymentId)
    if (existing) return existing
    this.persisted.set(paymentId, candidate)
    return candidate
  }

  async submit(request: EnrichedRequest): Promise<FulfillmentResult> {
    const hasPractitionerIdentifier =
      !!this.config.practitionerIdentifier || !!request.prescriberPharmetikaIdentifier
    if (!this.config.apiUrl || !this.config.apiToken || !hasPractitionerIdentifier) {
      return {
        success: false,
        fulfillmentStatus: "error",
        error:
          "PHARMETIKA_API_URL, PHARMETIKA_PRACTITIONER_IDENTIFIER, or PHARMETIKA_API_TOKEN not configured",
      }
    }
    const orderUuid = this.ensurePharmacyOrderId(request.paymentId, generateUuidV7(this.now()))
    const baseUrl = this.base()

    const clinicIdentifier = await this.resolveClinicIdentifier(request)
    if (!clinicIdentifier) {
      return {
        success: false,
        fulfillmentStatus: "error",
        error: "Pharmetika clinic identifier could not be resolved",
      }
    }
    const patientId = await this.resolvePatientId(request, clinicIdentifier)
    if (!patientId) {
      return {
        success: false,
        fulfillmentStatus: "error",
        error: "Pharmetika patient could not be resolved",
      }
    }
    const payload = this.buildPayload({ request, clinicIdentifier, patientId, orderUuid })

    const validateResponse = await this.fetch(
      `${baseUrl}/api/v5/provider_portal/medication_order/id/${orderUuid}/validate`,
      { method: "PUT", headers: this.buildHeaders(), body: JSON.stringify(payload) },
    )
    const validateBody = safeParseJson(await validateResponse.text())
    if (!validateResponse.ok || !isPharmetikaSuccess(validateBody)) {
      return { success: false, fulfillmentStatus: "error", error: formatMessages(validateBody) }
    }

    if (validateBody && this.hasControlledSubstances(validateBody)) {
      const controlledPayload = this.buildControlledPayload(payload, validateBody, orderUuid)
      let prepareResponse: Response
      let prepareText: string
      try {
        prepareResponse = await this.fetch(
          `${baseUrl}/api/v5/provider_portal/medication_order/id/${orderUuid}`,
          { method: "PUT", headers: this.buildHeaders(), body: JSON.stringify(controlledPayload) },
        )
        prepareText = await prepareResponse.text()
      } catch (err) {
        return {
          success: false,
          fulfillmentStatus: "error",
          error: err instanceof Error ? err.message : String(err),
          pharmacyOrderId: orderUuid,
        }
      }
      const prepareBody = safeParseJson(prepareText)
      if (!prepareResponse.ok || !isPharmetikaSuccess(prepareBody)) {
        return {
          success: false,
          fulfillmentStatus: "error",
          error: formatMessages(prepareBody, `Prepare order failed: ${prepareResponse.status}`),
          pharmacyOrderId: orderUuid,
        }
      }
      return {
        success: true,
        fulfillmentStatus: "submitted",
        pharmacyOrderId: orderUuid,
        pharmacyStatus: "pending_prescriber_approval",
        pharmacyPortalUrl: this.config.apiUrl,
      }
    }

    const submitResponse = await this.fetch(
      `${baseUrl}/api/v5/provider_portal/medication_order/id/${orderUuid}/submit`,
      { method: "PUT", headers: this.buildHeaders(), body: JSON.stringify(payload) },
    )
    const submitBody = safeParseJson(await submitResponse.text())
    if (!submitResponse.ok || !isPharmetikaSuccess(submitBody)) {
      return {
        success: false,
        fulfillmentStatus: "error",
        error: formatMessages(submitBody, `Submit failed: ${submitResponse.status}`),
        pharmacyOrderId: orderUuid,
      }
    }
    return {
      success: true,
      fulfillmentStatus: "submitted",
      pharmacyOrderId: orderUuid,
      pharmacyStatus: "submitted",
    }
  }

  async cancelOrder(
    pharmacyOrderId: string | null,
    note?: string,
  ): Promise<{
    success: boolean
    fulfillmentStatus: FulfillmentStatus
    pharmacyStatus?: string
    error?: string
  }> {
    if (!pharmacyOrderId) {
      return { success: false, fulfillmentStatus: "error", error: "Pharmetika order id is missing" }
    }
    const response = await this.fetch(
      `${this.base()}/api/v7/provider_portal/medication_order/entry/cancel`,
      {
        method: "PUT",
        headers: this.buildHeaders(),
        body: JSON.stringify({
          note: note ?? "Cancelled from the Acme EMR",
          prescriber_order_number: pharmacyOrderId,
        }),
      },
    )
    const body = safeParseJson(await response.text()) as PharmetikaResponse | null
    // The adapter checks `success !== 1` strictly here (not isPharmetikaSuccess), and joins
    // `messages` as if they were strings.
    if (!response.ok || body?.success !== 1) {
      const messages = Array.isArray(body?.messages)
        ? body.messages.join("; ")
        : `Cancel failed: ${response.status}`
      return { success: false, fulfillmentStatus: "error", error: messages }
    }
    return { success: true, fulfillmentStatus: "cancelled", pharmacyStatus: "cancelled" }
  }

  async getOrderStatus(pharmacyOrderId: string | null) {
    if (!this.config.apiUrl || !this.config.apiToken || !pharmacyOrderId) return null
    const response = await this.fetch(
      `${this.base()}/api/v5/provider_portal/medication_order/id/${encodeURIComponent(pharmacyOrderId)}`,
      { method: "GET", headers: this.buildHeaders() },
    )
    const body = safeParseJson(await response.text()) as PharmetikaResponse | null
    if (!response.ok || !isPharmetikaSuccess(body)) return null

    const data = readRecord(body as Record<string, unknown>, ["data"])
    const payloadData = readRecord(data, ["data"])
    const statusNode = readRecord(payloadData, ["ancillary_order_data", "medication_order_status"])
    const rawStatus =
      readString(payloadData, ["order_status"]) ??
      readString(data, ["order_status"]) ??
      readString(statusNode, ["workflow_status"]) ??
      null
    const trackingNumber = readString(statusNode, ["tracking_id"]) ?? null
    const mappedStatus = mapStatus(rawStatus ?? "")
    const fulfillmentStatus =
      trackingNumber && (mappedStatus === "submitted" || mappedStatus === "processing")
        ? "shipped"
        : mappedStatus
    return {
      fulfillmentStatus,
      pharmacyStatus: rawStatus,
      trackingNumber,
      trackingCarrier: null,
      canCancel: isCancelableStatus(fulfillmentStatus),
    }
  }

  /** `parseWebhook`, after `ensureWebhookSecret` (plain equality on the header). */
  parseWebhook(headers: Headers, payload: unknown) {
    if (this.config.webhookSecret) {
      if (headers.get("x-pharmetika-webhook-secret") !== this.config.webhookSecret) {
        throw new Error("Invalid webhook secret")
      }
    }
    const body = payload as Record<string, unknown>
    const eventData = (body.event_data ?? body) as Record<string, unknown>
    const pharmacyOrderId =
      (eventData.electronic_prescription_order_number as string) ??
      (eventData.medication_order_identifier as string) ??
      ""
    const statusObj = eventData.medication_order_status as Record<string, unknown> | undefined
    const workflowStatus =
      (statusObj?.workflow_status as string) ??
      (eventData.status as string) ??
      (eventData.medication_order_workflow_status as string) ??
      ""
    const trackingId = (eventData.tracking_id as string) ?? undefined
    const mappedStatus = mapStatus(workflowStatus)
    const fulfillmentStatus =
      trackingId && (mappedStatus === "submitted" || mappedStatus === "processing")
        ? "shipped"
        : mappedStatus
    return {
      pharmacyId: "pharmetika" as const,
      pharmacyOrderId,
      fulfillmentStatus,
      pharmacyStatus: workflowStatus,
      trackingNumber: trackingId,
    }
  }

  private buildPayload(params: {
    request: EnrichedRequest
    clinicIdentifier: string
    patientId: number
    orderUuid: string
  }) {
    const { request, clinicIdentifier, patientId, orderUuid } = params
    const today = new Date(this.now()).toISOString()
    const entryUuid = generateUuidV7(this.now())
    const practitionerIdentifier = this.resolvePractitionerIdentifier(request) ?? undefined
    const instructions = request.instructions.trim() || "Take as directed by your provider"
    return {
      clinic_identifier: clinicIdentifier,
      ...(practitionerIdentifier ? { practitioner_identifier: practitionerIdentifier } : {}),
      medication_order_identifier: orderUuid,
      patient: {
        identification: { patient_id: patientId },
        name: {
          last_name: request.patient.lastName,
          first_name: request.patient.firstName,
          suffix: null,
        },
        gender: normalizePharmetikaGender(request.patient.gender),
        DOB: request.patient.dob,
        species: "human",
        address: {
          line_1: request.patient.address.line1,
          line_2: request.patient.address.line2 ?? "",
          city: request.patient.address.city,
          state: request.patient.address.state,
          postal_code: request.patient.address.zip,
        },
        email: request.patient.email,
        phone_primary: normalizeDigits(request.patient.phone),
      },
      medication_requests: [
        {
          product_identification: {
            product_identifier: normalizeProductIdentifier(
              request.catalogId ?? request.medicationId,
            ),
          },
          medication: request.medicationName,
          dose: request.strength ?? "",
          quantity_authorized: request.quantity,
          days_supply: request.daySupply ?? null,
          unit_of_measure: request.quantityUnit ?? "",
          refills_authorized: 0,
          sig: instructions,
          reason_for_compounding: request.reasonForCompounding
            ? {
                code: request.reasonForCompounding.code,
                description: request.reasonForCompounding.description ?? "",
                context: request.reasonForCompounding.context?.trim() || instructions,
              }
            : null,
          authorization_for_emergency_dispensing: false,
          authorization_for_emergency_dispensing_date_written: null,
          do_not_refill: false,
          do_not_fill: false,
          patient_contact_requested: false,
          date_issued: today,
          medication_order_entry_identifier: entryUuid,
        },
      ],
      ancillary_order_data: {
        patient_handoff_method: "ship",
        patient_handoff_method_text: "",
        priority: "normal",
        medication_order_status: {},
        documents: [],
      },
    }
  }

  private async resolveClinicIdentifier(request: EnrichedRequest) {
    if (request.clinic?.clinicIdentifier) return request.clinic.clinicIdentifier
    if (this.clinicIdentifierCache !== undefined) return this.clinicIdentifierCache
    const response = await this.fetch(`${this.base()}/api/v5/provider_portal/clinic/clinic_list`, {
      method: "GET",
      headers: this.buildHeaders(),
    })
    const body = safeParseJson(await response.text()) as PharmetikaResponse | null
    const clinics = Array.isArray(body?.data)
      ? (body.data as ClinicListEntry[])
      : body?.data && typeof body.data === "object"
        ? (Object.values(body.data) as ClinicListEntry[])
        : []
    const preferredName = request.clinic?.name ?? this.config.clinicName ?? ""
    const exact = clinics.find((clinic) => clinic.data?.name === preferredName)?.identifier
    const fallback = clinics[0]?.identifier ?? null
    this.clinicIdentifierCache = exact ?? fallback
    return this.clinicIdentifierCache
  }

  private async resolvePatientId(request: EnrichedRequest, clinicIdentifier: string) {
    const existing = await this.findExistingPatientId(request)
    if (existing) return existing
    const created = await this.createPatient(request, clinicIdentifier)
    if (created) return created
    return this.findExistingPatientId(request)
  }

  private async findExistingPatientId(request: EnrichedRequest) {
    const response = await this.fetch(
      `${this.base()}/api/v5/provider_portal/provider/patient_list`,
      { method: "GET", headers: this.buildHeaders() },
    )
    const body = safeParseJson(await response.text()) as PharmetikaResponse | null
    const patients = Array.isArray(body?.data) ? (body.data as PatientListEntry[]) : []
    const matches = patients
      .filter((entry) => isSamePatient(entry, request))
      .sort((l, r) => patientMatchScore(r, request) - patientMatchScore(l, request))
    const top = matches[0]
    return typeof top?.patient_id === "number" ? top.patient_id : null
  }

  private async createPatient(request: EnrichedRequest, clinicIdentifier: string) {
    const telecom: { system: string; value: string; use: string }[] = []
    if (request.patient.email) {
      telecom.push({ system: "email", value: request.patient.email, use: "default" })
    }
    if (request.patient.phone) {
      telecom.push({
        system: "phone",
        value: normalizeDigits(request.patient.phone),
        use: "default",
      })
    }
    const practitionerIdentifier = this.resolvePractitionerIdentifier(request)
    const payload = {
      active: true,
      resourceType: "Patient",
      birthDate: request.patient.dob,
      gender: normalizeFhirGender(request.patient.gender),
      name: [
        {
          family: request.patient.lastName,
          given: [request.patient.firstName, ""],
          use: "official",
        },
      ],
      address: [
        {
          line: [request.patient.address.line1, request.patient.address.line2 ?? ""],
          city: request.patient.address.city,
          state: request.patient.address.state,
          postalCode: request.patient.address.zip,
          country: "US",
          use: "home",
        },
      ],
      telecom,
      communication: [
        { language: { coding: [{ code: "en", system: "urn:ietf:bcp:47" }] }, preferred: true },
      ],
      identifier: [],
      extension: [{ extension: [], url: "http://pharmetika.com/fhir/extensions/patient/profile" }],
      meta: {
        lastUpdated: new Date(this.now()).toISOString(),
        profile: ["http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient"],
        versionId: "1",
      },
      species: "human",
      clinic_identifier: clinicIdentifier,
      ...(practitionerIdentifier ? { practitioner_identifier: practitionerIdentifier } : {}),
    }
    const response = await this.fetch(`${this.base()}/api/v5/provider_portal/patient/create_new`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify(payload),
    })
    const parsed = safeParseJson(await response.text()) as PharmetikaResponse | null
    if (!response.ok) return null
    if (isPharmetikaSuccess(parsed)) {
      return parsed && typeof parsed.patient_id === "number" ? parsed.patient_id : null
    }
    const duplicates = (Array.isArray(parsed?.duplicate_entries) ? parsed.duplicate_entries : [])
      .filter((entry) => isSamePatient(entry, request))
      .sort((l, r) => patientMatchScore(r, request) - patientMatchScore(l, request))
    const duplicate = duplicates[0]
    return typeof duplicate?.patient_id === "number" ? duplicate.patient_id : null
  }

  private extractMedicationRequests(body: Record<string, unknown>): Record<string, unknown>[] {
    const data = body.data as Record<string, unknown> | undefined
    const requests = data?.medication_list ?? data?.medication_requests ?? body.medication_requests
    return Array.isArray(requests) ? (requests as Record<string, unknown>[]) : []
  }

  private hasControlledSubstances(body: Record<string, unknown>): boolean {
    const data = body.data as Record<string, unknown> | undefined
    const count = data?.controlled_substance_list_count
    if (typeof count === "number" && count > 0) return true
    if (typeof count === "string" && Number.parseInt(count, 10) > 0) return true
    return this.extractMedicationRequests(body).some((r) => {
      const c = r.controlled
      return c === true || c === "true" || (typeof c === "number" && c > 0)
    })
  }

  private buildControlledPayload(
    basePayload: Record<string, unknown>,
    validateBody: Record<string, unknown>,
    orderUuid: string,
  ): Record<string, unknown> {
    const validateRequests = this.extractMedicationRequests(validateBody)
    const baseRequests = (basePayload.medication_requests ?? []) as Record<string, unknown>[]
    const mergedRequests = validateRequests.map((validated, idx) => {
      const original = baseRequests[idx] ?? {}
      return {
        ...validated,
        sig: original.sig ?? validated.sig,
        product_identification: original.product_identification ?? validated.product_identification,
        is_reauthorization: false,
      }
    })
    return {
      ...basePayload,
      medication_order_identifier: orderUuid,
      prepared_by:
        (basePayload.practitioner_identifier as string | undefined) ??
        this.config.practitionerIdentifier,
      medication_requests: mergedRequests,
    }
  }
}

// --- the catalog client ------------------------------------------------------------------

/**
 * `PharmetikaLiveClient.fetchCatalogItems`, reduced to what the mock can influence: the
 * token → Basic → none auth fallback and the template-node walk (one item per dose in
 * `map_dose_to_product`).
 */
export const fetchCatalogItems = async (
  config: { apiUrl: string; apiToken?: string; username?: string; password?: string },
  send: Fetch,
) => {
  const auth: Record<string, string> = config.apiToken
    ? { "x-pmk-authentication-token": config.apiToken }
    : config.username && config.password
      ? { Authorization: `Basic ${btoa(`${config.username}:${config.password}`)}` }
      : {}
  const response = await send(
    new Request(
      `${config.apiUrl.replace(/\/$/, "")}/api/pharmetika/provider_access/profile/medication_templates`,
      { headers: { Accept: "application/json", ...auth } },
    ),
  )
  if (!response.ok) {
    throw new Error(`Pharmetika catalog sync failed: ${response.status} ${await response.text()}`)
  }
  const collected = new Map<
    string,
    {
      vendorMedicationCode: string
      displayName: string
      strength: string | null
      availableStates: string[]
    }
  >()
  const walk = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry)
      return
    }
    if (!node || typeof node !== "object") return
    const record = node as Record<string, unknown>
    const name = record.medication_display_name
    const doseMap = record.map_dose_to_product
    if (typeof name === "string" && name.trim() && doseMap && typeof doseMap === "object") {
      for (const [dose, productId] of Object.entries(doseMap as Record<string, unknown>)) {
        if (typeof productId !== "string" || !productId.trim()) continue
        collected.set(productId.trim(), {
          vendorMedicationCode: productId.trim(),
          displayName: name.trim(),
          strength: dose.trim() || null,
          availableStates: Array.isArray(record.available_states)
            ? (record.available_states as string[])
            : [],
        })
      }
      return
    }
    for (const value of Object.values(record)) {
      if (typeof value === "object" && value !== null) walk(value)
    }
  }
  walk(await response.json())
  return [...collected.values()]
}

// --- the webhook → payment application (ErxFulfillmentService.handleWebhook) ---------------

const RANK: Record<FulfillmentStatus, number> = {
  pending: 0,
  submitted: 1,
  processing: 2,
  shipped: 3,
  delivered: 4,
  error: 5,
  cancelled: 5,
}
const TERMINAL = new Set<FulfillmentStatus>(["delivered", "cancelled", "error"])

/** `resolveMonotonicFulfillmentStatus`, verbatim. */
export const resolveMonotonic = (current: FulfillmentStatus, incoming: FulfillmentStatus) => {
  if (current === incoming) return current
  if (TERMINAL.has(incoming)) return incoming
  if (TERMINAL.has(current)) return current
  return RANK[incoming] >= RANK[current] ? incoming : current
}

export type Payment = {
  id: string
  pharmacyOrderId: string | null
  fulfillmentStatus: FulfillmentStatus
  trackingNumber: string | null
  pharmacyStatus: string | null
}

/** Apply a parsed webhook to our payments, found by pharmacy order id (unknown ids are dropped). */
export const applyWebhook = (
  payments: Payment[],
  result: ReturnType<PharmetikaConsumer["parseWebhook"]>,
): Payment | null => {
  if (!result.pharmacyOrderId) return null
  const payment = payments.find((p) => p.pharmacyOrderId === result.pharmacyOrderId)
  if (!payment) return null
  payment.fulfillmentStatus = resolveMonotonic(payment.fulfillmentStatus, result.fulfillmentStatus)
  payment.pharmacyStatus = result.pharmacyStatus ?? payment.pharmacyStatus
  payment.trackingNumber = result.trackingNumber ?? payment.trackingNumber
  return payment
}

/** An enriched request the way the enrichment service shapes one. */
export const sampleRequest = (
  paymentId: string,
  overrides: Partial<EnrichedRequest> = {},
): EnrichedRequest => ({
  paymentId,
  prescriberPharmetikaIdentifier: null,
  clinic: null,
  patient: {
    firstName: "Ada",
    lastName: "Lovelace",
    gender: "female",
    dob: "1985-02-14",
    email: "ada@example.com",
    phone: "+1 (602) 555-0142",
    address: { line1: "1 Main St", line2: null, city: "Phoenix", state: "AZ", zip: "85004" },
  },
  catalogId: "pharmetika:PMK-SERM-9",
  medicationId: "sermorelin",
  medicationName: "Sermorelin Acetate",
  strength: "9 mg",
  quantity: 1,
  quantityUnit: "vial",
  daySupply: 30,
  instructions: "Inject 300 mcg subcutaneously nightly",
  reasonForCompounding: null,
  ...overrides,
})
