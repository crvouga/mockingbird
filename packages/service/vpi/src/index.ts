import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  annotateResponse,
  type BodyIssue,
  bearerToken,
  bodyIssues,
  bootSqlite,
  createService,
  defineOperations,
  faultEffect,
  fromBase64,
  HttpError,
  jsonRes,
  type OperationContext,
  opaqueToken,
  type Service,
  toBase64,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { Hono } from "hono"
import {
  type ClinicLocation,
  DEFAULT_USER_ID,
  type Patient,
  type PatientAddress,
  type Product,
  SHIPPING_STATES,
  STATE_CODES,
} from "./catalog.js"
import { document, type SupportedOperationId } from "./generated/openapi.js"
import { type PrescriptionRecord, type Seed, type Settings, VpiState } from "./state.js"
import {
  DRAFT_STATUS,
  isActive,
  isCompleted,
  type PrescriptionList,
  resolveStatus,
} from "./statuses.js"

export type { FetchAPI } from "@crvouga/mockingbird-core"
export type { SqliteClient } from "@crvouga/mockingbird-sqlite"
export type {
  ClinicLocation,
  Patient,
  PatientAddress,
  Product,
  Provider,
} from "./catalog.js"
export {
  DEFAULT_CLINIC_ID,
  DEFAULT_CLINIC_LOCATION,
  DEFAULT_CLINIC_LOCATION_ID,
  DEFAULT_PATIENT_ID,
  DEFAULT_PATIENTS,
  DEFAULT_PRODUCTS,
  DEFAULT_PROVIDER_ID,
  DEFAULT_PROVIDERS,
  DEFAULT_USER_ID,
  SHIPPING_STATES,
} from "./catalog.js"
export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export type { Account, PrescriptionRecord, Seed, Settings, StatusEnvelope } from "./state.js"
export type { PrescriptionList } from "./statuses.js"

export const VPI_NAMESPACE = "vpi"

export type VpiAPIOptions = APIOptions & {
  /** Replace the seeded clinic, providers, products or patients. */
  seed?: Seed
  /** Initial per-namespace settings (token TTL, accounts, status envelope). */
  settings?: Partial<Settings>
}

const base64url = (value: string) =>
  toBase64(new TextEncoder().encode(value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
const fromBase64url = (value: string) => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      fromBase64(value.replace(/-/g, "+").replace(/_/g, "/")),
    )
  } catch {
    return undefined
  }
}

const JWT_HEADER = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))

type JwtClaims = { sub: string; email: string; iat: number; exp: number }

const signJwt = (unsigned: string) => opaqueToken(`vpi-jwt:${unsigned}`, 43)

/** A JWT whose payload carries `sub` (the user id), `email`, `iat` and `exp` (mock clock). */
export const issueJwt = (claims: JwtClaims): string => {
  const unsigned = `${JWT_HEADER}.${base64url(JSON.stringify(claims))}`
  return `${unsigned}.${signJwt(unsigned)}`
}

const readClaims = (token: string): JwtClaims | undefined => {
  const [header, payload, signature] = token.split(".")
  if (!header || !payload || !signature) return undefined
  if (signature !== signJwt(`${header}.${payload}`)) return undefined
  const json = fromBase64url(payload)
  if (!json) return undefined
  try {
    const claims = JSON.parse(json) as JwtClaims
    return typeof claims.exp === "number" && typeof claims.email === "string" ? claims : undefined
  } catch {
    return undefined
  }
}

/**
 * The login email a bearer JWT was issued to (how `PUT /__admin/credentials` maps
 * `VPI_API_EMAIL` to a namespace: the app's `fetch` cannot add a namespace header).
 */
export const tokenCredential = (request: Request): string | undefined => {
  const token = bearerToken(request)
  if (!token) return undefined
  const payload = token.split(".")[1]
  if (!payload) return undefined
  const json = fromBase64url(payload)
  if (!json) return undefined
  try {
    const email = (JSON.parse(json) as { email?: unknown }).email
    return typeof email === "string" ? email : undefined
  } catch {
    return undefined
  }
}

const error = (status: number, message: string, errors?: BodyIssue[]) =>
  jsonRes(status, errors ? { message, errors } : { message })

const notFound = (what: string): never => {
  throw new HttpError(404, { message: `${what} not found` })
}

const record = (context: OperationContext): Record<string, unknown> => {
  const issues = bodyIssues(context)
  if (issues.length > 0) {
    throw new HttpError(400, { message: "Validation failed", errors: issues })
  }
  return context.body.kind === "json" ? (context.body.value as Record<string, unknown>) : {}
}

const round2 = (value: number) => Math.round(value * 100) / 100

const patientBody = (patient: Patient) => ({
  id: patient.id,
  firstName: patient.firstName,
  lastName: patient.lastName,
  dateOfBirth: patient.dateOfBirth,
  email: patient.email,
  phoneNumber: patient.phoneNumber,
  cellPhone: patient.cellPhone,
})

const productSummary = (p: Product) => ({
  id: p.id,
  name: p.name,
  unitPrice: p.unitPrice,
  productId: p.productId,
  productSize: p.productSize,
  medicalAccessories: p.medicalAccessories,
  coldShipped: p.coldShipped,
  controlledSubstance: p.controlledSubstance,
  dispenseType: p.dispenseType,
  productType: p.productType,
  isReasonForCompoundedMedicationNeeded: p.isReasonForCompoundedMedicationNeeded,
})

const productDetails = (p: Product) => ({
  id: p.id,
  productId: p.productId,
  name: p.name,
  unitPrice: p.unitPrice,
  family: p.family,
  subCategory1: p.subCategory1,
  subCategory2: p.subCategory2,
  commonName: p.commonName,
  sigOptions: p.sigOptions,
  productSize: p.productSize,
  medicalAccessories: p.medicalAccessories,
  coldShipped: p.coldShipped,
  controlledSubstance: p.controlledSubstance,
  dispenseType: p.dispenseType,
  reasonForCompoundedMedication: p.reasonForCompoundedMedication,
  isReasonForCompoundedMedicationNeeded: p.isReasonForCompoundedMedicationNeeded,
  productType: p.productType,
  patientPayAmount: p.patientPayAmount,
  ndc: p.ndc,
  isActive: true,
  isAvailable: true,
})

export type TransitionInput = {
  /** A VPI status, e.g. `Order Received`, `In Process`, `Order Completed`, `Cancelled`. */
  to: string
  trackingNumber?: string
  /** Force the list the prescription shows in (default: by status). */
  list?: PrescriptionList
}

export type PatientInput = {
  id?: string
  clinicId?: string
  firstName: string
  lastName: string
  dateOfBirth: string
  email?: string | null
  phoneNumber?: string | null
  cellPhone?: string | null
  addresses?: (Omit<PatientAddress, "id" | "addressLine2"> & {
    id?: string
    addressLine2?: string | null
  })[]
}

/**
 * Stateful mock of the VPI clinic API our backend drives as a draft-only rail.
 *
 * `saveNewPrescription` creates a draft awaiting provider signature; prescriptions move only
 * through admin transitions, between the incomplete, submitted and archived lists our status
 * poller reads (page 1, limit 5).
 */
export class VpiAPI implements FetchAPI {
  readonly app: Hono
  readonly sqlite: SqliteClient
  readonly state: VpiState
  private readonly service: Service
  private readonly now: () => number

  constructor(options: VpiAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite)
    const namespace = options.namespace ?? VPI_NAMESPACE
    this.now = options.now ?? (() => Date.now())
    this.state = new VpiState(sqlite, namespace, {
      data: options.seed ?? {},
      settings: options.settings ?? {},
    })
    const handlers = defineOperations<SupportedOperationId>({
      Authenticate: (context) => this.authenticate(context),
      GetAllFamiliesAndCategories: (context) => this.taxonomy(context),
      GetProductsByCategory: (context) => this.productsByCategory(context),
      GetProductDetailsByProductId: (context) => this.productDetails(context),
      GetProductDiscountByProductIds: (context) => this.discounts(context),
      CalculateDaySupply: (context) => this.daySupply(context),
      GetShippingStates: () => jsonRes(200, { data: [{ states: SHIPPING_STATES }] }),
      GetShippingRate: (context) => this.shippingRate(context),
      CheckProviderSignatureNeededDuplicate: (context) => this.duplicateCheck(context),
      SaveNewPrescription: (context) => this.savePrescription(context),
      GetPatientByPatientId: (context) => {
        const body = record(context)
        const patient = this.patient(String(body.patientId))
        return annotateResponse(jsonRes(200, patientBody(patient)), {
          ids: { patientId: patient.id },
        })
      },
      GetPatientAddressesByPatientId: (context) => {
        const body = record(context)
        const patient = this.patient(String(body.patientId))
        return annotateResponse(jsonRes(200, { addresses: patient.addresses }), {
          ids: { patientId: patient.id },
        })
      },
      GetPatientsInClinic: (context) => this.roster(context),
      GetAllProvidersByClinicLocationId: (context) => {
        const body = record(context)
        const location = this.location(String(body.clinicLocationId))
        if (location.clinicId !== body.clinicId) notFound("Clinic location")
        return jsonRes(
          200,
          this.state.providers
            .list({ order: "oldest", where: (p) => p.clinicLocationId === location.id })
            .map(({ value: p }) => ({
              id: p.id,
              firstName: p.firstName,
              lastName: p.lastName,
              npi: p.npi,
              deaInfo: [],
              providerLicenses: [],
              allowExostar: false,
              isSuperUserSameAsProvider: false,
            })),
        )
      },
      GetClinicLocationByClinicLocationId: (context) => {
        const body = record(context)
        return jsonRes(200, this.location(String(body.clinicLocationId)))
      },
      GetIncompleteSavedPrescriptionsInClinicLocation: (context) =>
        this.prescriptionPage(context, "incomplete"),
      GetSubmittedPrescriptionsInClinicLocation: (context) =>
        this.prescriptionPage(context, "submitted"),
      GetArchivedPrescriptionsInClinic: (context) => this.prescriptionPage(context, "archived"),
    })
    this.service = createService({
      document,
      handlers,
      sqlite,
      namespace,
      now: this.now,
      notFound: () => jsonRes(404, { message: "Cannot find the requested route" }),
      onError: (thrown) => {
        if (thrown instanceof HttpError) return thrown.toResponse()
        throw thrown
      },
      before: (context) => {
        if (context.operation.operationId === "Authenticate") return undefined
        const token = bearerToken(context.request)
        if (!token) return error(401, "Unauthorized")
        const claims = readClaims(token)
        if (!claims) return error(401, "Unauthorized")
        if (this.now() / 1000 >= claims.exp) return error(401, "jwt expired")
        return undefined
      },
    })
    this.app = this.service.app
    this.sqlite = this.service.sqlite
  }

  fetch(request: Request): Promise<Response> {
    return this.service.fetch(request)
  }

  async reset(): Promise<void> {
    await this.service.reset()
    this.state.ensureSeeded()
  }

  private iso(): string {
    return new Date(this.now()).toISOString()
  }

  private authenticate(context: OperationContext): Response {
    const body = record(context)
    const email = String(body.email).trim()
    const settings = this.state.current()
    let userId = DEFAULT_USER_ID
    if (settings.accounts.length > 0) {
      const account = settings.accounts.find(
        (a) => a.email.toLowerCase() === email.toLowerCase() && a.password === body.password,
      )
      if (!account) return error(401, "Email or password is incorrect")
      userId = account.id
    }
    if (body.isPatientLogin === true) return error(401, "Email or password is incorrect")
    const iat = Math.floor(this.now() / 1000)
    const jwtToken = issueJwt({ sub: userId, email, iat, exp: iat + settings.tokenTtlSeconds })
    return jsonRes(200, {
      id: userId,
      jwtToken,
      refreshToken: opaqueToken(`vpi-refresh:${jwtToken}`, 80),
    })
  }

  private product(id: string): Product {
    return this.state.products.get(id) ?? notFound("Product")
  }

  private patient(id: string): Patient {
    return this.state.patients.get(id) ?? notFound("Patient")
  }

  private location(id: string): ClinicLocation {
    return this.state.locations.get(id) ?? notFound("Clinic location")
  }

  private clinic(id: string): void {
    if (!this.state.hasClinic(id)) notFound("Clinic")
  }

  private taxonomy(context: OperationContext): Response {
    const families = new Map<string, string[]>()
    for (const { value: p } of this.state.products.list({ order: "oldest" })) {
      const categories = families.get(p.family) ?? []
      if (!categories.includes(p.subCategory1)) categories.push(p.subCategory1)
      families.set(p.family, categories)
    }
    const drift = faultEffect(context.request, "response_drift") !== undefined
    return jsonRes(
      200,
      [...families].map(([family, categories]) => ({
        family,
        categories: drift ? categories.join(",") : categories,
      })),
    )
  }

  private productsByCategory(context: OperationContext): Response {
    const body = record(context)
    const groups = new Map<string, Map<string, Product[]>>()
    for (const { value: p } of this.state.products.list({ order: "oldest" })) {
      if (p.family !== body.category || p.subCategory1 !== body.subCategory1) continue
      const byName = groups.get(p.subCategory2) ?? new Map<string, Product[]>()
      byName.set(p.commonName, [...(byName.get(p.commonName) ?? []), p])
      groups.set(p.subCategory2, byName)
    }
    return jsonRes(
      200,
      [...groups].map(([subCategory2, byName]) => ({
        subCategory2_item: subCategory2,
        commonNames: [...byName].map(([commonName, products]) => ({
          commonName,
          products: products.map(productSummary),
        })),
      })),
    )
  }

  private productDetails(context: OperationContext): Response {
    const product = this.product(context.params.productId ?? "")
    const body = productDetails(product)
    if (faultEffect(context.request, "response_drift") !== undefined) {
      return jsonRes(200, { ...body, unitPrice: String(body.unitPrice) })
    }
    return jsonRes(200, body)
  }

  private discounts(context: OperationContext): Response {
    const body = record(context)
    this.clinic(String(body.clinicId))
    const rows = (body.productIds as string[])
      .map((id) => this.state.products.get(id))
      .filter((p): p is Product => p !== undefined)
      .map((p) => ({
        id: p.id,
        productId: p.productId,
        discountedPrice: round2(p.unitPrice * (1 - p.discountedPercentage / 100)),
        unitPrice: p.unitPrice,
        discountedPercentage: p.discountedPercentage,
        controlledSubstance: p.controlledSubstance,
      }))
    return jsonRes(200, rows)
  }

  private daySupply(context: OperationContext): Response {
    const body = record(context)
    const product = this.product(String(body.productId))
    const quantity = Number(body.quantity)
    const perUnit = /ea$/i.test(product.productSize)
    const daySupply = perUnit ? Math.max(1, Math.round(quantity)) : 30
    return jsonRes(200, {
      daySupply,
      daySupplyReason: perUnit ? "Calculated from quantity (1 per day)" : "Default 30-day supply",
    })
  }

  private shippingRate(context: OperationContext): Response {
    const body = record(context)
    this.clinic(String(body.clinicId))
    this.location(String(body.clinicLocationId))
    this.patient(String(body.patientId))
    const products = (body.productIds as string[]).map((id) => this.product(id))
    const code = String(body.shippingState).toUpperCase()
    const state = SHIPPING_STATES.find((s) => STATE_CODES[s.name] === code)
    if (!state) return error(400, `VPI does not ship to ${code}`)
    if (products.some((p) => p.productType === "S") && !state.sterile) {
      return error(400, `VPI does not ship sterile products to ${state.name}`)
    }
    const cold = products.some((p) => p.coldShipped === "1")
    const rush = body.isRushOrder === true
    return jsonRes(200, {
      shippingMethod: cold ? "FedEx Priority Overnight" : "UPS Ground",
      rushOrderCost: rush ? 35 : 0,
      rushOrderMethod: rush ? "FedEx Standard Overnight" : "",
      isSignatureRequired: products.some((p) => p.productType === "S"),
    })
  }

  private duplicateCheck(context: OperationContext): Response {
    const body = record(context)
    const patients = body.patientIds as string[]
    const products = body.productIds as string[]
    const duplicate =
      faultEffect(context.request, "duplicate_prescription") !== undefined ||
      this.state.prescriptions
        .list()
        .some(
          ({ value: rx }) =>
            isActive(rx.list) &&
            patients.includes(rx.patientId) &&
            rx.productIds.some((id) => products.includes(id)),
        )
    return jsonRes(200, {
      isDuplicate: duplicate,
      isProviderSignatureNeeded: this.state.current().isProviderSignatureNeeded,
    })
  }

  private savePrescription(context: OperationContext): Response {
    const body = record(context)
    const location = this.location(String(body.clinicLocationId))
    if (location.clinicId !== body.clinicId) notFound("Clinic location")
    const provider = this.state.providers.get(String(body.providerId))
    if (!provider || provider.clinicLocationId !== location.id) notFound("Provider")
    const patientId = (body.patientIds as string[])[0] as string
    const patient = this.patient(patientId)
    if (patient.clinicId !== location.clinicId) notFound("Patient")
    const lines = body.products as { id: string; productId: string }[]
    for (const line of lines) {
      const product = this.product(line.id)
      if (product.productId !== line.productId) {
        return error(400, `Product ${line.id} does not match product code ${line.productId}`)
      }
      if (product.controlledSubstance === "1") {
        return error(400, "Controlled substances cannot be prescribed through this endpoint")
      }
    }
    const now = this.iso()
    const created: PrescriptionRecord = {
      prescriptionId: this.state.nextPrescriptionId(),
      clinicId: location.clinicId,
      clinicLocationId: location.id,
      patientId,
      providerId: provider?.id ?? "",
      productIds: lines.map((line) => line.id),
      prescriptionStatus: DRAFT_STATUS,
      list: "incomplete",
      trackingNumber: null,
      createdAt: now,
      updatedAt: now,
    }
    this.state.prescriptions.insert(created.prescriptionId, created)
    const ids = { prescriptionId: created.prescriptionId, patientId }
    if (faultEffect(context.request, "save_ambiguous_409") !== undefined) {
      return annotateResponse(error(409, "Request conflicted with a concurrent save"), { ids })
    }
    return annotateResponse(
      jsonRes(200, {
        message: "Prescription saved successfully",
        prescriptionId: created.prescriptionId,
        isRefillRequest: false,
        refillFromPrescriptionId: null,
      }),
      { ids },
    )
  }

  private roster(context: OperationContext): Response {
    const body = record(context)
    this.clinic(String(body.clinicId))
    const limit = Number(body.limit)
    const page = Number(body.currentPage)
    const all = this.state.patients
      .list({ order: "oldest", where: (p) => p.clinicId === body.clinicId })
      .map((row) => row.value)
    const rows = all.slice((page - 1) * limit, page * limit)
    return jsonRes(200, {
      pagination: {
        hasNextPage: page * limit < all.length,
        currentPage: page,
        limit,
        totalCount: all.length,
      },
      patients: rows.map(patientBody),
    })
  }

  private prescriptionPage(context: OperationContext, list: PrescriptionList): Response {
    const body = record(context)
    const location = this.location(String(body.clinicLocationId))
    const limit = Number(body.limit)
    const page = Number(body.currentPage)
    const rows = this.state.list(list, location).slice((page - 1) * limit, page * limit)
    const envelope = this.state.current().statusEnvelope
    const useId = envelope === "vendor" && list === "archived"
    const shaped = rows.map((rx) => ({
      ...(useId ? { id: rx.prescriptionId } : { prescriptionId: rx.prescriptionId }),
      prescriptionStatus: rx.prescriptionStatus,
      trackingNumber: rx.trackingNumber,
      patientId: rx.patientId,
      createdAt: rx.createdAt,
    }))
    const kind =
      envelope !== "vendor"
        ? envelope
        : list === "submitted"
          ? "message.prescriptions"
          : list === "archived"
            ? "message"
            : "array"
    const payload =
      kind === "array"
        ? shaped
        : kind === "prescriptions"
          ? { prescriptions: shaped }
          : kind === "message"
            ? { message: shaped }
            : { message: { prescriptions: shaped } }
    return jsonRes(200, payload)
  }

  /** Move a prescription to a VPI status (and its list); completion adds a tracking number. */
  transition(id: string, input: TransitionInput): PrescriptionRecord | undefined {
    const rx = this.state.prescriptions.get(id)
    if (!rx) return undefined
    const resolved = resolveStatus(input.to)
    const next: PrescriptionRecord = {
      ...rx,
      prescriptionStatus: resolved.status,
      list: input.list ?? resolved.list,
      trackingNumber:
        input.trackingNumber ??
        rx.trackingNumber ??
        (isCompleted(resolved.status) ? `1Z${opaqueToken(id, 16).toUpperCase()}` : null),
      updatedAt: this.iso(),
    }
    this.state.prescriptions.update(id, next)
    return next
  }

  /** Seed a clinic patient (VPI patient creation is not part of our client's contract). */
  addPatient(input: PatientInput): Patient {
    const patient: Patient = {
      id: input.id ?? this.state.nextPatientId(),
      clinicId:
        input.clinicId ?? this.state.locations.list({ order: "oldest" })[0]?.value.clinicId ?? "",
      firstName: input.firstName,
      lastName: input.lastName,
      dateOfBirth: input.dateOfBirth,
      email: input.email ?? null,
      phoneNumber: input.phoneNumber ?? null,
      cellPhone: input.cellPhone ?? null,
      addresses: (input.addresses ?? []).map((a) => ({
        id: a.id ?? this.state.nextAddressId(),
        addressLine1: a.addressLine1,
        addressLine2: a.addressLine2 ?? null,
        city: a.city,
        state: a.state,
        zipcode: a.zipcode,
      })),
    }
    this.state.patients.insert(patient.id, patient)
    return patient
  }

  prescriptions(): PrescriptionRecord[] {
    return this.state.prescriptions.list({ order: "oldest" }).map((row) => row.value)
  }
}

export type { VpiRuntime, VpiRuntimeOptions } from "./runtime.js"
export { createRuntime, VPI_PRESETS } from "./runtime.js"
