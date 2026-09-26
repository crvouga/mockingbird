/**
 * A port of our backend's VPI rail: `VpiApiClient` (`erx/clients/vpi-api.client.ts`: JWT cached
 * until `exp` minus 30 s, one re-auth on 401, every response parsed with the zod contracts),
 * `VpiApiFulfillmentService` (`prescriptions/adapters/vpi-api-fulfillment.service.ts`:
 * submitDraft and getOrderStatus), `VpiOrderPayloadBuilder`, `mapVpiPrescriptionStatus`,
 * `classifyVpiApiFailure` and `resolveMonotonicFulfillmentStatus`. The acceptance tests drive
 * the mock through it, so "the mock works" means "our consumer's own logic reaches the right
 * outcome". The clock is injectable so token expiry follows the mock clock.
 */
import { z } from "zod"
import {
  denormalizeVpiStateCodeToName,
  jwtPayloadSchema,
  normalizeVpiStateToCode,
  type VpiDaySupplyInput,
  type VpiPatient,
  type VpiPatientAddress,
  type VpiProductDetails,
  type VpiProductDiscount,
  type VpiProvider,
  type VpiProviderSignatureCheckInput,
  type VpiSavePrescriptionPayload,
  type VpiShippingRateInput,
  type VpiShippingRateResponse,
  vpiAuthTokensSchema,
  vpiClinicLocationSchema,
  vpiDaySupplyResponseSchema,
  vpiPatientAddressesResponseSchema,
  vpiPatientRosterPageSchema,
  vpiPatientSchema,
  vpiPrescriptionStatusRowsSchema,
  vpiPrescriptionStatusSchema,
  vpiProductDetailsSchema,
  vpiProductDiscountsResponseSchema,
  vpiProductsByCategorySchema,
  vpiProviderSignatureCheckInputSchema,
  vpiProviderSignatureCheckSchema,
  vpiProvidersResponseSchema,
  vpiRequiredStringSchema,
  vpiSavePrescriptionPayloadSchema,
  vpiSavePrescriptionResponseSchema,
  vpiShippingRateResponseSchema,
  vpiShippingStatesSchema,
  vpiTaxonomySchema,
} from "./vpi-contracts.js"

export type Fetch = (request: Request) => Promise<Response>

export type FulfillmentStatus =
  | "pending"
  | "submitted"
  | "processing"
  | "shipped"
  | "delivered"
  | "error"
  | "cancelled"

const TOKEN_EXPIRY_SKEW_MS = 30_000
const VPI_PATIENT_ROSTER_LIMIT = 100
const VPI_PATIENT_ROSTER_FIRST_PAGE = 1
const VPI_PATIENT_ROSTER_MAX_PAGES = 20
const VPI_PRESCRIPTION_STATUS_MINIMUM_LIMIT = 5
const VPI_INCOMPLETE_PRESCRIPTIONS_PATH =
  "/clinic/rxOrdering/getIncompleteSavedPrescriptionsInClinicLocation"
const VPI_SUBMITTED_PRESCRIPTIONS_PATH =
  "/clinic/rxOrdering/getSubmittedPrescriptionsInClinicLocation"
const VPI_ARCHIVED_PRESCRIPTIONS_PATH = "/clinic/rxOrdering/getArchivedPrescriptionsInClinic"

export class VpiApiHttpError extends Error {
  constructor(
    readonly status: number,
    readonly endpoint: string,
  ) {
    super(`${endpoint} failed with HTTP ${status}`)
    this.name = "VpiApiHttpError"
  }
}

type VpiAuthTokens = z.infer<typeof vpiAuthTokensSchema>
type CachedTokens = VpiAuthTokens & { expiresAtMs: number }

/** `VpiApiClient`, over any `fetch` and clock. */
export class VpiConsumer {
  private readonly apiUrl: string
  private cachedTokens: CachedTokens | null = null
  private authenticationPromise: Promise<VpiAuthTokens> | null = null
  readonly warnings: string[] = []

  constructor(
    private readonly config: { apiUrl: string; email?: string; password?: string },
    private readonly fetch: Fetch,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.apiUrl = new URL(config.apiUrl).toString().replace(/\/$/, "")
  }

  async authenticate(): Promise<VpiAuthTokens> {
    if (this.cachedTokens && this.cachedTokens.expiresAtMs > this.now()) {
      return this.toAuthTokens(this.cachedTokens)
    }
    if (this.authenticationPromise) return this.authenticationPromise
    const authenticationPromise = this.requestAuthentication()
    this.authenticationPromise = authenticationPromise
    try {
      return await authenticationPromise
    } finally {
      if (this.authenticationPromise === authenticationPromise) this.authenticationPromise = null
    }
  }

  getAllFamiliesAndCategories() {
    return this.authorizedRequest(
      "/products/getAllFamiliesAndCategories",
      { method: "GET" },
      vpiTaxonomySchema,
    )
  }

  getProductsByCategory(category: string, subCategory1: string) {
    return this.authorizedRequest(
      "/products/getProductsByCategory",
      { method: "POST", body: JSON.stringify({ category, subCategory1 }) },
      vpiProductsByCategorySchema,
    )
  }

  getShippingStates() {
    return this.authorizedRequest(
      "/admin/rxOrdering/getShippingStates",
      { method: "GET" },
      vpiShippingStatesSchema,
    )
  }

  async getAuthenticatedUserId() {
    const authentication = await this.authenticate()
    return authentication.id ?? null
  }

  checkProviderSignatureNeededDuplicate(input: VpiProviderSignatureCheckInput) {
    const payload = this.validatePayload(
      input,
      vpiProviderSignatureCheckInputSchema,
      "provider signature check",
    )
    return this.authorizedRequest(
      "/clinic/rxOrdering/checkProviderSignatureNeededDuplicate",
      { method: "POST", body: JSON.stringify(payload) },
      vpiProviderSignatureCheckSchema,
    )
  }

  saveNewPrescription(input: VpiSavePrescriptionPayload) {
    const payload = this.validatePayload(
      input,
      vpiSavePrescriptionPayloadSchema,
      "save prescription",
    )
    return this.authorizedRequest(
      "/clinic/rxOrdering/saveNewPrescription",
      { method: "POST", body: JSON.stringify(payload) },
      vpiSavePrescriptionResponseSchema,
    )
  }

  async getPatientsInClinic(clinicId: string, userId: string) {
    const rows = await this.fetchPatientRosterPages(clinicId, userId)
    return this.parsePatientRoster(rows)
  }

  getIncompleteSavedPrescriptionsInClinicLocation(
    clinicLocationId: string,
    userId: string,
    limit: number,
    currentPage: number,
  ) {
    return this.getPrescriptionStatuses(
      VPI_INCOMPLETE_PRESCRIPTIONS_PATH,
      clinicLocationId,
      userId,
      limit,
      currentPage,
    )
  }

  getSubmittedPrescriptionsInClinicLocation(
    clinicLocationId: string,
    userId: string,
    limit: number,
    currentPage: number,
  ) {
    return this.getPrescriptionStatuses(
      VPI_SUBMITTED_PRESCRIPTIONS_PATH,
      clinicLocationId,
      userId,
      limit,
      currentPage,
    )
  }

  getArchivedPrescriptionsInClinic(
    clinicLocationId: string,
    userId: string,
    limit: number,
    currentPage: number,
  ) {
    return this.getPrescriptionStatuses(
      VPI_ARCHIVED_PRESCRIPTIONS_PATH,
      clinicLocationId,
      userId,
      limit,
      currentPage,
    )
  }

  getPatientByPatientId(patientId: string, userId: string) {
    return this.authorizedRequest(
      "/patients/getPatientByPatientId",
      { method: "POST", body: JSON.stringify({ patientId, userId }) },
      vpiPatientSchema,
    )
  }

  getPatientAddressesByPatientId(patientId: string, userId: string) {
    return this.authorizedRequest(
      "/patients/getPatientAddressesByPatientId",
      { method: "POST", body: JSON.stringify({ patientId, userId }) },
      vpiPatientAddressesResponseSchema,
    )
  }

  getAllProvidersByClinicLocationId(clinicLocationId: string, clinicId: string) {
    return this.authorizedRequest(
      "/staffs/getAllProvidersByClinicLocationId",
      { method: "POST", body: JSON.stringify({ clinicLocationId, clinicId }) },
      vpiProvidersResponseSchema,
    )
  }

  getClinicLocationByClinicLocationId(clinicLocationId: string) {
    return this.authorizedRequest(
      "/clinicLocations/getClinicLocationByClinicLocationId",
      { method: "POST", body: JSON.stringify({ clinicLocationId }) },
      vpiClinicLocationSchema,
    )
  }

  getProductDetailsByProductId(productId: string) {
    return this.authorizedRequest(
      `/products/getProductDetailsByProductId/${encodeURIComponent(productId)}`,
      { method: "GET" },
      vpiProductDetailsSchema,
    )
  }

  getProductDiscountByProductIds(clinicId: string, productIds: string[]) {
    const ids = z
      .array(vpiRequiredStringSchema)
      .min(1)
      .parse(productIds, { path: ["productIds"] })
    return this.authorizedRequest(
      "/products/getProductDiscountByProductIds",
      { method: "POST", body: JSON.stringify({ clinicId, productIds: ids }) },
      vpiProductDiscountsResponseSchema,
    )
  }

  calculateDaySupply(input: VpiDaySupplyInput) {
    return this.authorizedRequest(
      "/products/calculateDaySupply",
      { method: "POST", body: JSON.stringify(input) },
      vpiDaySupplyResponseSchema,
    )
  }

  getShippingRate(input: VpiShippingRateInput) {
    const payload = this.validatePayload(
      input,
      z.object({
        clinicId: vpiRequiredStringSchema,
        clinicLocationId: vpiRequiredStringSchema,
        patientId: vpiRequiredStringSchema,
        productIds: z.array(vpiRequiredStringSchema).min(1),
        shippingState: vpiRequiredStringSchema.regex(/^[a-z]{2}$/i),
        isRushOrder: z.boolean(),
      }),
      "shipping rate",
    )
    return this.authorizedRequest(
      "/portal/getShippingRate",
      { method: "POST", body: JSON.stringify(payload) },
      vpiShippingRateResponseSchema,
    )
  }

  private async requestAuthentication() {
    const email = this.config.email?.trim()
    const password = this.config.password
    if (!email || !password) throw new Error("VPI API credentials are not configured")
    const response = await this.fetch(
      new Request(this.endpoint("/accounts/authenticate"), {
        method: "POST",
        headers: this.jsonHeaders(),
        body: JSON.stringify({ email, password, isPatientLogin: false }),
      }),
    )
    const tokens = await this.parseResponse(response, vpiAuthTokensSchema, "VPI authentication")
    const expiresAtMs = this.readJwtExpiry(tokens.jwtToken) - TOKEN_EXPIRY_SKEW_MS
    if (expiresAtMs <= this.now()) {
      throw new Error("VPI authentication response contains an expired JWT")
    }
    this.cachedTokens = { ...tokens, expiresAtMs }
    return tokens
  }

  private async authorizedRequest<TSchema extends z.ZodTypeAny>(
    path: string,
    init: RequestInit,
    schema: TSchema,
  ): Promise<z.output<TSchema>> {
    let tokens = await this.authenticate()
    let response = await this.fetch(
      new Request(this.endpoint(path), this.withAuthorization(init, tokens.jwtToken)),
    )
    if (response.status === 401) {
      this.warnings.push(`VPI API returned 401 for ${path}; refreshing authentication`)
      this.cachedTokens = null
      tokens = await this.authenticate()
      response = await this.fetch(
        new Request(this.endpoint(path), this.withAuthorization(init, tokens.jwtToken)),
      )
    }
    return this.parseResponse(response, schema, `VPI ${path}`)
  }

  private async parseResponse<TSchema extends z.ZodTypeAny>(
    response: Response,
    schema: TSchema,
    endpoint: string,
  ): Promise<z.output<TSchema>> {
    if (!response.ok) throw new VpiApiHttpError(response.status, endpoint)
    let payload: unknown
    try {
      payload = (await response.json()) as unknown
    } catch {
      throw new Error(`${endpoint} returned invalid JSON`)
    }
    const result = schema.safeParse(payload)
    if (!result.success) {
      const issues = result.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ")
      throw new Error(`${endpoint} response validation failed: ${issues}`)
    }
    return result.data
  }

  private withAuthorization(init: RequestInit, jwtToken: string): RequestInit {
    return {
      ...init,
      headers: { ...this.jsonHeaders(), ...init.headers, Authorization: `Bearer ${jwtToken}` },
    }
  }

  private jsonHeaders() {
    return { Accept: "application/json", "Content-Type": "application/json" }
  }

  private endpoint(path: string) {
    return `${this.apiUrl}${path}`
  }

  private validatePayload<TSchema extends z.ZodTypeAny>(
    value: unknown,
    schema: TSchema,
    operation: string,
  ): z.output<TSchema> {
    const result = schema.safeParse(value)
    if (!result.success) {
      const issues = result.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ")
      throw new Error(`VPI ${operation} payload validation failed: ${issues}`)
    }
    return result.data
  }

  private async fetchPatientRosterPages(clinicId: string, userId: string) {
    const rows: unknown[] = []
    for (let pageIndex = 0; pageIndex < VPI_PATIENT_ROSTER_MAX_PAGES; pageIndex += 1) {
      const currentPage = VPI_PATIENT_ROSTER_FIRST_PAGE + pageIndex
      const page = await this.authorizedRequest(
        "/patients/getPatientsInClinic",
        {
          method: "POST",
          body: JSON.stringify({ clinicId, userId, limit: VPI_PATIENT_ROSTER_LIMIT, currentPage }),
        },
        vpiPatientRosterPageSchema,
      )
      rows.push(...page.patients)
      if (!page.pagination.hasNextPage) return rows
    }
    throw new Error(
      `VPI patient roster still reported additional pages after ${VPI_PATIENT_ROSTER_MAX_PAGES} pages`,
    )
  }

  private parsePatientRoster(rows: unknown[]) {
    const patients: VpiPatient[] = []
    let invalidCount = 0
    for (const row of rows) {
      const result = vpiPatientSchema.safeParse(row)
      if (result.success) patients.push(result.data)
      else invalidCount += 1
    }
    if (invalidCount > 0)
      this.warnings.push(`VPI patient roster skipped ${invalidCount} invalid row(s)`)
    return patients
  }

  private async getPrescriptionStatuses(
    path: string,
    clinicLocationId: string,
    userId: string,
    limit: number,
    currentPage: number,
  ) {
    const validatedLimit = z
      .number()
      .int()
      .min(VPI_PRESCRIPTION_STATUS_MINIMUM_LIMIT)
      .parse(limit, { path: ["limit"] })
    const validatedCurrentPage = z
      .number()
      .int()
      .positive()
      .parse(currentPage, { path: ["currentPage"] })
    const rows = await this.authorizedRequest(
      path,
      {
        method: "POST",
        body: JSON.stringify({
          clinicLocationId,
          userId,
          limit: validatedLimit,
          currentPage: validatedCurrentPage,
        }),
      },
      vpiPrescriptionStatusRowsSchema,
    )
    const prescriptions: z.output<typeof vpiPrescriptionStatusSchema>[] = []
    let invalidCount = 0
    for (const row of rows) {
      const result = vpiPrescriptionStatusSchema.safeParse(row)
      if (result.success) prescriptions.push(result.data)
      else invalidCount += 1
    }
    if (invalidCount > 0) {
      this.warnings.push(`VPI prescription status list skipped ${invalidCount} invalid row(s)`)
    }
    return prescriptions
  }

  private readJwtExpiry(jwtToken: string) {
    const encodedPayload = jwtToken.split(".")[1]
    if (!encodedPayload) throw new Error("VPI authentication response contains an invalid JWT")
    let payload: unknown
    try {
      payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as unknown
    } catch {
      throw new Error("VPI authentication response contains an invalid JWT")
    }
    const result = jwtPayloadSchema.safeParse(payload)
    if (!result.success)
      throw new Error("VPI authentication response JWT is missing a valid expiry")
    return result.data.exp * 1000
  }

  private toAuthTokens(tokens: CachedTokens): VpiAuthTokens {
    return {
      ...(tokens.id ? { id: tokens.id } : {}),
      jwtToken: tokens.jwtToken,
      refreshToken: tokens.refreshToken,
    }
  }
}

// --- vpi-status-mapping.ts ---

const VPI_STATUS_MAPPING: Readonly<Record<string, FulfillmentStatus>> = {
  "provider signature needed": "processing",
  "signature needed": "processing",
  "in process": "processing",
  "order in process": "processing",
  "prescriptions in process": "processing",
  "new formula pending": "processing",
  "on hold": "processing",
  "order on hold": "processing",
  received: "submitted",
  "order received": "submitted",
  "order completed": "shipped",
  "order complete": "shipped",
  completed: "shipped",
  cancelled: "cancelled",
  "order cancelled": "cancelled",
}

export const mapVpiPrescriptionStatus = (vpiStatus: string): FulfillmentStatus | null =>
  VPI_STATUS_MAPPING[vpiStatus.trim().toLowerCase()] ?? null

// --- prescription-fulfillment-status.ts ---

const TERMINAL = new Set<FulfillmentStatus>(["delivered", "cancelled", "error"])
const RANK: Record<FulfillmentStatus, number> = {
  pending: 0,
  submitted: 1,
  processing: 2,
  shipped: 3,
  delivered: 4,
  error: 5,
  cancelled: 5,
}

/** How our payment row applies a refreshed status: terminal wins, otherwise never backwards. */
export const resolveMonotonicFulfillmentStatus = (
  current: FulfillmentStatus,
  incoming: FulfillmentStatus,
): FulfillmentStatus => {
  if (current === incoming) return current
  if (TERMINAL.has(incoming)) return incoming
  if (TERMINAL.has(current)) return current
  return RANK[incoming] >= RANK[current] ? incoming : current
}

// --- vpi-failover.classifier.ts ---

export type VpiFailoverVerdict = "retry_via_browser" | "needs_review"

const AMBIGUOUS_DRAFT_STATUSES = new Set([408, 409, 423, 425, 429])

export const NEVER_RETRY_REASONS = new Set([
  "vpi_duplicate_prescription",
  "vpi_patient_match_ambiguous",
  "vpi_patient_identity_mismatch",
  "vpi_patient_address_mismatch",
  "vpi_provider_match_ambiguous",
])

export class VpiDraftAttemptError extends Error {
  constructor(override readonly cause: unknown) {
    super("VPI draft creation failed after the request was dispatched")
    this.name = "VpiDraftAttemptError"
  }
}

export const classifyVpiApiFailure = (error: unknown, reason?: string): VpiFailoverVerdict => {
  if (reason !== undefined && NEVER_RETRY_REASONS.has(reason)) return "needs_review"
  if (!(error instanceof VpiDraftAttemptError)) return "retry_via_browser"
  const cause = error.cause
  if (!(cause instanceof VpiApiHttpError)) return "needs_review"
  if (cause.status >= 400 && cause.status < 500 && !AMBIGUOUS_DRAFT_STATUSES.has(cause.status)) {
    return "retry_via_browser"
  }
  return "needs_review"
}

// --- vpi-order-payload.builder.ts ---

export type VpiApiProductMapping = {
  id: string
  productId: string
  name: string
  unitPrice?: number
  family?: string
  subCategory1?: string
  subCategory2?: string
  commonName?: string
  productSize: string
  medicalAccessories?: "0" | "1"
  coldShipped?: "0" | "1"
  controlledSubstance?: "0" | "1"
  dispenseType: string
  isReasonForCompoundedMedicationNeeded?: boolean
  productType?: "S" | "NS"
}

/** The subset of `ErxEnrichedRequest` the VPI rail reads. */
export type ErxRequest = {
  paymentId: string
  patient: {
    firstName: string
    lastName: string
    dob: string
    email: string
    phone: string
    address: { line1: string; line2: string | null; city: string; state: string; zip: string }
  }
  prescriber: { firstName: string; lastName: string; npi: string | null }
  instructions: string
  quantity: number
  dispensedQuantity?: number | null
  daySupply: number | null
  refills: number
  drugFamily?: string | null
  reasonForCompounding?: {
    code: number
    description?: string | null
    context?: string | null
  } | null
}

export class VpiOrderPayloadValidationError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message)
    this.name = "VpiOrderPayloadValidationError"
  }
}

export const buildVpiOrderPayload = (input: {
  request: ErxRequest
  mapping: VpiApiProductMapping
  patientId: string
  clinicLocationId: string
  providerId: string
  clinicId: string
  userId: string
  productDetails: VpiProductDetails
  discount: VpiProductDiscount | null
  daySupply: number
  daySupplyReason: string
  shippingRate: VpiShippingRateResponse
}): VpiSavePrescriptionPayload => {
  const { request, mapping, productDetails, discount } = input
  if (mapping.id !== productDetails.id || mapping.productId !== productDetails.productId) {
    throw new VpiOrderPayloadValidationError(
      "vpi_product_identity_mismatch",
      "VPI catalog mapping does not match the current VPI product details",
    )
  }
  if (mapping.controlledSubstance === "1" || productDetails.controlledSubstance === "1") {
    throw new VpiOrderPayloadValidationError(
      "controlled_substance_excluded",
      "VPI fulfillment excludes controlled substances",
    )
  }
  const needsCompoundingReason =
    mapping.isReasonForCompoundedMedicationNeeded ??
    productDetails.isReasonForCompoundedMedicationNeeded
  let reasonForCompoundedMedication = ""
  if (needsCompoundingReason) {
    const reason =
      request.reasonForCompounding?.description?.trim() ||
      request.reasonForCompounding?.context?.trim()
    if (!reason) {
      throw new VpiOrderPayloadValidationError(
        "vpi_compounding_reason_missing",
        "VPI requires a reason for compounded medication",
      )
    }
    reasonForCompoundedMedication = reason
  }
  const accessoryIndicator = mapping.medicalAccessories ?? productDetails.medicalAccessories
  let medicalAccessories: Record<string, unknown>[]
  if (Array.isArray(accessoryIndicator)) medicalAccessories = accessoryIndicator
  else if (accessoryIndicator === "0") medicalAccessories = []
  else
    throw new VpiOrderPayloadValidationError(
      "vpi_medical_accessory_selection_required",
      "VPI product requires an uncaptured medical accessory selection",
    )
  let ndc = ""
  if (productDetails.ndc !== null && productDetails.ndc !== undefined) {
    ndc = String(productDetails.ndc)
    if (!/^\d{11}$/.test(ndc)) {
      throw new VpiOrderPayloadValidationError(
        "vpi_ndc_not_integral",
        "VPI product NDC could not be represented as an 11-digit identifier",
      )
    }
  }
  if (productDetails.patientPayAmount === null || productDetails.patientPayAmount === undefined) {
    throw new VpiOrderPayloadValidationError(
      "vpi_patient_pay_amount_missing",
      "VPI product details did not include a patient-pay amount",
    )
  }
  const stateCode = normalizeVpiStateToCode(request.patient.address.state)
  if (!stateCode) {
    throw new VpiOrderPayloadValidationError(
      "vpi_shipping_state_not_denormalisable",
      "VPI shipping state code could not be converted to a full state name",
    )
  }
  const listPrice = mapping.unitPrice ?? productDetails.unitPrice
  const line2 = request.patient.address.line2?.trim() ?? ""
  return {
    patientIds: [input.patientId],
    clinicLocationId: input.clinicLocationId,
    providerId: input.providerId,
    clinicId: input.clinicId,
    userId: input.userId,
    products: [
      {
        id: mapping.id,
        productId: mapping.productId,
        name: mapping.name,
        unitPrice: listPrice,
        family: mapping.family ?? request.drugFamily ?? productDetails.family,
        subCategory1: mapping.subCategory1 ?? productDetails.subCategory1,
        subCategory2: mapping.subCategory2 ?? productDetails.subCategory2,
        commonName: mapping.commonName ?? productDetails.commonName,
        sigOptions: productDetails.sigOptions,
        productSize: mapping.productSize,
        medicalAccessories,
        coldShipped: mapping.coldShipped ?? productDetails.coldShipped,
        controlledSubstance: "0",
        dispenseType: mapping.dispenseType,
        reasonForCompoundedMedication,
        isReasonForCompoundedMedicationNeeded: needsCompoundingReason,
        productType: mapping.productType ?? productDetails.productType,
        patientPay: productDetails.patientPayAmount,
        ndc,
        quantity: request.dispensedQuantity ?? request.quantity,
        sig: request.instructions,
        daySupply: input.daySupply,
        daySupplyReason: input.daySupplyReason,
        refills: request.refills,
        isCustomSig: true,
        discountedPercentage: discount?.discountedPercentage ?? 0,
        discountedPrice: discount?.discountedPrice ?? listPrice,
        displayedGeneratedSig: request.instructions,
      },
    ],
    rxPadProducts: [],
    shippingInfo: {
      isRushOrder: false,
      isSignatureRequired: input.shippingRate.isSignatureRequired,
      orderNotes: "",
      shipTo: "Patient",
      isNewAddressUsed: false,
      shippingMethod: input.shippingRate.shippingMethod,
      shippingAddress: {
        addressLine1: request.patient.address.line1,
        addressLine2: line2.length > 0 ? line2 : "-",
        city: request.patient.address.city,
        state: denormalizeVpiStateCodeToName(stateCode) as string,
        zipcode: request.patient.address.zip,
      },
      rushOrderCost: input.shippingRate.rushOrderCost,
      rushOrderMethod: input.shippingRate.rushOrderMethod,
    },
    patientNotificationRecipients: [],
  }
}

// --- vpi-api-fulfillment.service.ts ---

export type FulfillmentResult = {
  success: boolean
  fulfillmentStatus: FulfillmentStatus
  pharmacyOrderId?: string
  portalDraftOrderId?: string
  pharmacyStatus?: string
  portalAgentStatus?: string
  error?: string
  errorCode?: string
}

export type VpiApiSubmitOutcome = {
  verdict: "submitted" | VpiFailoverVerdict
  result: FulfillmentResult
}

class VpiNeedsReviewError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message)
    this.name = "VpiNeedsReviewError"
  }
}

/** VPI patient creation is not captured in our client: an unmatched patient needs review. */
export class VpiPatientCreateNotCapturedError extends Error {
  constructor() {
    super("VPI patient creation is unavailable until its API contract is captured")
    this.name = "VpiPatientCreateNotCapturedError"
  }
}

export type VpiConfig = {
  VPI_USER_ID?: string
  VPI_CLINIC_LOCATION_ID?: string
  VPI_CLINIC_ID?: string
  VPI_PROVIDER_ID?: string
}

const normalizeValue = (value: string | null | undefined) => value?.trim().toLowerCase() ?? ""
const normalizePhone = (value: string | null | undefined) => value?.replace(/\D/g, "") ?? ""
const normalizePostalCode = (value: string) => value.trim().toLowerCase().replace(/\s/g, "")

const normalizeDate = (value: string) => {
  const trimmedValue = value.trim()
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmedValue)
  const isoTimestampMatch =
    /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/.exec(
      trimmedValue,
    )
  const localMatch = /^(\d{2})[/-](\d{2})[/-](\d{4})$/.exec(trimmedValue)
  const year = Number(isoMatch?.[1] ?? isoTimestampMatch?.[1] ?? localMatch?.[3])
  const month = Number(isoMatch?.[2] ?? isoTimestampMatch?.[2] ?? localMatch?.[1])
  const day = Number(isoMatch?.[3] ?? isoTimestampMatch?.[3] ?? localMatch?.[2])
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null
  const parsed = new Date(Date.UTC(year, month - 1, day))
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  )
    return null
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
}

const patientsCoreMatch = (request: ErxRequest, patient: VpiPatient) => {
  const patientDob = normalizeDate(patient.dob)
  const requestDob = normalizeDate(request.patient.dob)
  return (
    normalizeValue(patient.firstName) === normalizeValue(request.patient.firstName) &&
    normalizeValue(patient.lastName) === normalizeValue(request.patient.lastName) &&
    patientDob !== null &&
    requestDob !== null &&
    patientDob === requestDob
  )
}

const matchPatient = (request: ErxRequest, patients: VpiPatient[]) => {
  const coreMatches = patients.filter((patient) => patientsCoreMatch(request, patient))
  if (coreMatches.length === 0) return null
  if (coreMatches.length === 1) return coreMatches[0] as VpiPatient
  const contactMatches = coreMatches.filter(
    (patient) =>
      normalizeValue(patient.email) === normalizeValue(request.patient.email) &&
      normalizePhone(patient.phone) === normalizePhone(request.patient.phone),
  )
  if (contactMatches.length === 1) return contactMatches[0] as VpiPatient
  throw new VpiNeedsReviewError(
    "vpi_patient_match_ambiguous",
    "Multiple VPI patients match the prescription patient",
  )
}

const addressesMatch = (expected: ErxRequest["patient"]["address"], actual: VpiPatientAddress) =>
  normalizeValue(expected.line1) === normalizeValue(actual.addressLine1) &&
  normalizeValue(expected.line2) === normalizeValue(actual.addressLine2) &&
  normalizeValue(expected.city) === normalizeValue(actual.city) &&
  (normalizeVpiStateToCode(expected.state) ?? normalizeValue(expected.state)) ===
    (normalizeVpiStateToCode(actual.state) ?? normalizeValue(actual.state)) &&
  normalizePostalCode(expected.zip) === normalizePostalCode(actual.zipcode)

const VPI_PRESCRIPTION_STATUS_LIST_LIMIT = 5
const VPI_PRESCRIPTION_STATUS_FIRST_PAGE = 1

/** `VpiApiFulfillmentService`: the draft rail and the status refresh. */
export class VpiFulfillment {
  readonly warnings: string[] = []

  constructor(
    private readonly client: VpiConsumer,
    private readonly config: VpiConfig,
  ) {}

  async submitDraft(
    request: ErxRequest,
    mapping: VpiApiProductMapping,
  ): Promise<VpiApiSubmitOutcome> {
    try {
      await this.client.authenticate()
      const userId = (await this.client.getAuthenticatedUserId()) ?? this.optional("VPI_USER_ID")
      if (!userId) {
        throw new VpiNeedsReviewError(
          "vpi_user_not_resolved",
          "VPI prescribing user id could not be resolved",
        )
      }
      const clinicLocationId = this.required("VPI_CLINIC_LOCATION_ID")
      const clinicLocation = await this.client.getClinicLocationByClinicLocationId(clinicLocationId)
      if (clinicLocation.id !== clinicLocationId) {
        throw new VpiNeedsReviewError(
          "vpi_clinic_location_mismatch",
          "Configured VPI clinic location does not match the API response",
        )
      }
      const configuredClinicId = this.optional("VPI_CLINIC_ID")
      if (
        configuredClinicId &&
        clinicLocation.clinicId &&
        configuredClinicId !== clinicLocation.clinicId
      ) {
        throw new VpiNeedsReviewError(
          "vpi_clinic_mismatch",
          "Configured VPI clinic does not match the clinic location",
        )
      }
      const clinicId = clinicLocation.clinicId ?? configuredClinicId
      if (!clinicId) {
        throw new VpiNeedsReviewError(
          "vpi_clinic_not_resolved",
          "VPI clinic id could not be resolved",
        )
      }
      const providers = await this.client.getAllProvidersByClinicLocationId(
        clinicLocationId,
        clinicId,
      )
      const provider = this.resolveProvider(request, providers)
      const patients = await this.client.getPatientsInClinic(clinicId, userId)
      const patient = matchPatient(request, patients)
      if (!patient) {
        const error = new VpiPatientCreateNotCapturedError()
        throw new VpiNeedsReviewError("vpi_patient_create_unavailable", error.message)
      }
      const verified = await this.client.getPatientByPatientId(patient.id, userId)
      if (!patientsCoreMatch(request, verified)) {
        throw new VpiNeedsReviewError(
          "vpi_patient_identity_mismatch",
          "Resolved VPI patient does not match the current prescription patient",
        )
      }
      const addresses = await this.client.getPatientAddressesByPatientId(patient.id, userId)
      if (!addresses.some((address) => addressesMatch(request.patient.address, address))) {
        throw new VpiNeedsReviewError(
          "vpi_patient_address_mismatch",
          "VPI patient does not have an exact match for the current shipping address",
        )
      }
      const [productDetails, discounts, daySupply, shippingRate] = await Promise.all([
        this.client.getProductDetailsByProductId(mapping.id),
        this.client.getProductDiscountByProductIds(clinicId, [mapping.id]),
        request.daySupply
          ? Promise.resolve({ daySupply: request.daySupply, daySupplyReason: "" })
          : this.client.calculateDaySupply({
              productId: mapping.id,
              quantity: request.dispensedQuantity ?? request.quantity,
              sig: request.instructions,
            }),
        this.client.getShippingRate({
          clinicId,
          clinicLocationId,
          patientId: patient.id,
          productIds: [mapping.id],
          shippingState:
            normalizeVpiStateToCode(request.patient.address.state) ?? request.patient.address.state,
          isRushOrder: false,
        }),
      ])
      const matches = discounts.filter(
        (discount) => discount.id === mapping.id || discount.productId === mapping.productId,
      )
      if (matches.length > 1) {
        throw new VpiNeedsReviewError(
          "vpi_product_discount_ambiguous",
          "VPI returned multiple discounts for one product",
        )
      }
      const signatureCheck = await this.client.checkProviderSignatureNeededDuplicate({
        clinicId,
        patientIds: [patient.id],
        productIds: [mapping.id],
        clinicLocationIds: [clinicLocationId],
      })
      if (signatureCheck.isDuplicate) {
        throw new VpiNeedsReviewError(
          "vpi_duplicate_prescription",
          "VPI identified a possible duplicate prescription",
        )
      }
      const payload = buildVpiOrderPayload({
        request,
        mapping,
        patientId: patient.id,
        clinicLocationId,
        providerId: provider.id,
        clinicId,
        userId,
        productDetails,
        discount: matches[0] ?? null,
        daySupply: daySupply.daySupply,
        daySupplyReason: daySupply.daySupplyReason ?? "",
        shippingRate,
      })
      let saved: Awaited<ReturnType<VpiConsumer["saveNewPrescription"]>>
      try {
        saved = await this.client.saveNewPrescription(payload)
      } catch (error) {
        throw new VpiDraftAttemptError(error)
      }
      return {
        verdict: "submitted",
        result: {
          success: true,
          fulfillmentStatus: "processing",
          pharmacyOrderId: saved.prescriptionId,
          portalDraftOrderId: saved.prescriptionId,
          pharmacyStatus: "vpi_api_draft_ready",
          portalAgentStatus: "draft_ready",
        },
      }
    } catch (error) {
      const reason = error instanceof VpiNeedsReviewError ? error.reason : undefined
      return {
        verdict: classifyVpiApiFailure(error, reason),
        result: this.toNeedsReviewResult(request, error),
      }
    }
  }

  async getOrderStatus(payment: { pharmacyOrderId: string | null }) {
    try {
      const pharmacyOrderId = payment.pharmacyOrderId?.trim()
      if (!pharmacyOrderId) return null
      await this.client.authenticate()
      const userId = (await this.client.getAuthenticatedUserId()) ?? this.optional("VPI_USER_ID")
      const clinicLocationId = this.optional("VPI_CLINIC_LOCATION_ID")
      if (!userId || !clinicLocationId) return null
      const lists = [
        () =>
          this.client.getSubmittedPrescriptionsInClinicLocation(
            clinicLocationId,
            userId,
            VPI_PRESCRIPTION_STATUS_LIST_LIMIT,
            VPI_PRESCRIPTION_STATUS_FIRST_PAGE,
          ),
        () =>
          this.client.getArchivedPrescriptionsInClinic(
            clinicLocationId,
            userId,
            VPI_PRESCRIPTION_STATUS_LIST_LIMIT,
            VPI_PRESCRIPTION_STATUS_FIRST_PAGE,
          ),
        () =>
          this.client.getIncompleteSavedPrescriptionsInClinicLocation(
            clinicLocationId,
            userId,
            VPI_PRESCRIPTION_STATUS_LIST_LIMIT,
            VPI_PRESCRIPTION_STATUS_FIRST_PAGE,
          ),
      ]
      let prescription:
        | { prescriptionId: string; prescriptionStatus: string; trackingNumber: string | null }
        | undefined
      for (const read of lists) {
        prescription = (await read()).find((row) => row.prescriptionId === pharmacyOrderId)
        if (prescription) break
      }
      if (!prescription) return null
      const fulfillmentStatus = mapVpiPrescriptionStatus(prescription.prescriptionStatus)
      if (!fulfillmentStatus || fulfillmentStatus === "pending") return null
      return {
        fulfillmentStatus,
        pharmacyStatus: prescription.prescriptionStatus,
        ...(prescription.trackingNumber ? { trackingNumber: prescription.trackingNumber } : {}),
      }
    } catch {
      this.warnings.push("VPI order status refresh failed closed")
      return null
    }
  }

  private resolveProvider(request: ErxRequest, providers: VpiProvider[]) {
    const configuredProviderId = this.optional("VPI_PROVIDER_ID")
    let matches: VpiProvider[]
    if (request.prescriber.npi) {
      matches = providers.filter(
        (provider) => normalizeValue(provider.npi) === normalizeValue(request.prescriber.npi),
      )
      if (matches.length === 0 && configuredProviderId) {
        matches = providers.filter((provider) => provider.id === configuredProviderId)
      }
    } else if (configuredProviderId) {
      matches = providers.filter((provider) => provider.id === configuredProviderId)
    } else {
      matches = providers.filter(
        (provider) =>
          normalizeValue(provider.firstName) === normalizeValue(request.prescriber.firstName) &&
          normalizeValue(provider.lastName) === normalizeValue(request.prescriber.lastName),
      )
    }
    if (matches.length !== 1) {
      throw new VpiNeedsReviewError(
        matches.length > 1 ? "vpi_provider_match_ambiguous" : "vpi_provider_not_resolved",
        matches.length > 1
          ? "Multiple VPI providers match the prescription prescriber"
          : "No VPI provider matches the prescription prescriber",
      )
    }
    return matches[0] as VpiProvider
  }

  private toNeedsReviewResult(request: ErxRequest, error: unknown): FulfillmentResult {
    let reason = "vpi_api_fulfillment_failed"
    let message = "VPI API draft creation failed closed"
    const resolved = error instanceof VpiDraftAttemptError ? error.cause : error
    if (
      resolved instanceof VpiNeedsReviewError ||
      resolved instanceof VpiOrderPayloadValidationError
    ) {
      reason = resolved.reason
      message = resolved.message
    } else if (error instanceof VpiDraftAttemptError) {
      reason = "vpi_draft_state_unknown"
      message =
        "VPI draft state unknown — needs review before re-ordering; check VPI for an existing draft"
    }
    this.warnings.push(`VPI API draft blocked for ${request.paymentId}: reason=${reason}`)
    return {
      success: false,
      fulfillmentStatus: "error",
      pharmacyOrderId: `vpi:${request.paymentId}`,
      pharmacyStatus: `vpi_needs_review errorCode=${reason}`,
      portalAgentStatus: "needs_review",
      error: message,
      errorCode: reason,
    }
  }

  private required(key: keyof VpiConfig) {
    const value = this.optional(key)
    if (!value) {
      throw new VpiNeedsReviewError(
        "vpi_configuration_missing",
        `VPI fulfillment configuration is missing ${key}`,
      )
    }
    return value
  }

  private optional(key: keyof VpiConfig) {
    return this.config[key]?.trim() || null
  }
}

/** An eRx request the way enrichment shapes one, for the seeded patient and provider. */
export const sampleRequest = (paymentId: string): ErxRequest => ({
  paymentId,
  patient: {
    firstName: "Ada",
    lastName: "Lovelace",
    dob: "1985-02-14",
    email: "ada@example.com",
    phone: "602-555-0142",
    address: { line1: "1 Main St", line2: null, city: "Phoenix", state: "AZ", zip: "85004" },
  },
  prescriber: { firstName: "Grace", lastName: "Hopper", npi: "1234567893" },
  instructions: "Inject 0.5 mL intramuscularly once weekly",
  quantity: 10,
  dispensedQuantity: null,
  daySupply: 28,
  refills: 0,
  drugFamily: "Hormone Restoration",
  reasonForCompounding: {
    code: 1,
    description: "Different Strength - patient needs a strength not commercially available",
    context: null,
  },
})

/** The catalog mapping our erx catalog stores for the seeded testosterone product. */
export const TESTOSTERONE_MAPPING: VpiApiProductMapping = {
  id: "64f1c2a9e4b0a1b2c3d4e5f6",
  productId: "2185_INJ",
  name: "Testosterone Cypionate",
  productSize: "10mL",
  dispenseType: "Vial",
}
