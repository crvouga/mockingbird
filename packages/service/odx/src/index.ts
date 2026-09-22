import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  annotateResponse,
  bootSqlite,
  createService,
  defineOperations,
  faultEffect,
  jsonRes,
  type OperationContext,
  type Service,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { Hono } from "hono"
import { ELEMENTS, LABS, labElement } from "./catalog.js"
import { document, type SupportedOperationId } from "./generated/openapi.js"
import { jsonReport, pdfReport } from "./report.js"
import { importObservations, matchElement, parseObservations, resultFor } from "./results.js"
import { OdxState, type PatientRecord, type PatientTestRecord, type Settings } from "./state.js"

export type { FetchAPI } from "@crvouga/mockingbird-core"
export type { SqliteClient } from "@crvouga/mockingbird-sqlite"
export type { ElementDef, OdxLab } from "./catalog.js"
export { ELEMENTS, LABS } from "./catalog.js"
export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export type { ImportLog, Observation, ResultElement } from "./results.js"
export { parseObservations } from "./results.js"
export type { PatientRecord, PatientTestRecord, Settings, WebhookRecord } from "./state.js"
export { DEFAULT_SETTINGS } from "./state.js"

export const ODX_NAMESPACE = "odx"

export type OdxEventType = "Created" | "Updated" | "Deleted"

/** How the next webhook is signed: correctly, with a short (wrong-length) or a wrong digest. */
export type SignatureMode = "valid" | "short" | "bad"

/** The webhook body ODX posts (`OdxWebhookDataSchema` in our receiver). */
export type OdxWebhook = {
  entityType: "PatientTest"
  eventType: OdxEventType
  data: PatientTestRecord
}

export type OdxAPIOptions = APIOptions & {
  settings?: Partial<Settings>
  /** Called for every PatientTest event; the runtime signs and delivers it. */
  onWebhook?: (event: OdxWebhook, signature: SignatureMode) => void
}

/** The `ApiKey` header (how requests map to namespaces). */
export const apiKeyCredential = (request: Request): string | undefined =>
  request.headers.get("apikey") ?? undefined

const MISSING_KEY =
  "Access denied due to missing subscription key. Make sure to include subscription key when making requests to an API."
const INVALID_KEY =
  "Access denied due to invalid subscription key. Make sure to provide a valid key for an active subscription."

const message = (status: number, text: string) => jsonRes(status, { Message: text })

/** ASP.NET Core's validation problem details. */
const problem = (errors: Record<string, string[]>) =>
  jsonRes(400, {
    type: "https://tools.ietf.org/html/rfc7231#section-6.5.1",
    title: "One or more validation errors occurred.",
    status: 400,
    errors,
  })

type Json = Record<string, unknown>
const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const text = (value: unknown): string | null =>
  typeof value === "string" ? value : typeof value === "number" ? String(value) : null

const jsonBody = (context: OperationContext): Json | undefined =>
  context.body.kind === "json" && isRecord(context.body.value) ? context.body.value : undefined

/** `1985-12-10` / `1985-12-10T00:00:00Z` → `1985-12-10T00:00:00` (.NET DateTime, no offset). */
const dotnetDate = (value: unknown): string | null => {
  const raw = text(value)
  if (!raw) return null
  const match = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}:\d{2}))?/.exec(raw)
  return match ? `${match[1]}T${match[2] ?? "00:00:00"}` : null
}

const gender = (value: unknown) => {
  const raw = (text(value) ?? "").toLowerCase()
  return raw === "male" || raw === "m"
    ? "Male"
    : raw === "female" || raw === "f"
      ? "Female"
      : "Unknown"
}

const PHASES = ["Unknown", "Follicular", "Ovulation", "Luteal", "PostMenopausal"]

/**
 * Stateful mock of the Optimal DX partner API.
 *
 * Patients and tests live per practice; HL7 imports map OBX codes to elements through the lab
 * element corpus; every test create/update emits a signed PatientTest webhook to each
 * registered webhook URL.
 */
export class OdxAPI implements FetchAPI {
  readonly app: Hono
  readonly sqlite: SqliteClient
  readonly state: OdxState
  private readonly service: Service
  private readonly now: () => number
  private readonly onWebhook: OdxAPIOptions["onWebhook"]

  constructor(options: OdxAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite)
    const namespace = options.namespace ?? ODX_NAMESPACE
    this.now = options.now ?? (() => Date.now())
    this.onWebhook = options.onWebhook
    this.state = new OdxState(sqlite, namespace, {
      settings: options.settings ?? {},
      timestamp: () => this.iso(),
    })
    const handlers = defineOperations<SupportedOperationId>({
      ListPartnerLabs: () => jsonRes(200, LABS),
      ListElements: (context) => this.listElements(context),
      CreatePatient: (context) => this.savePatient(context, undefined),
      UpdatePatient: (context) => this.savePatient(context, context.params.patientId),
      DeletePatient: (context) => this.deletePatient(context),
      LinkPartnerUser: (context) => this.linkPartner(context),
      ListPatients: (context) => this.listPatients(context),
      CreateTestResults: (context) => this.createTestResults(context),
      CreatePatientTest: (context) => this.saveHl7Test(context, undefined),
      UpdatePatientTest: (context) => this.saveHl7Test(context, context.params.patientTestId),
      ListPatientTests: (context) => this.listTests(context),
      GenerateFunctionalHealthReport: (context) => this.report(context),
      ListWebhooks: () =>
        jsonRes(
          200,
          this.state.webhooks.list({ order: "oldest" }).map((row) => row.value),
        ),
      RegisterWebhook: (context) => this.saveWebhook(context, undefined),
      UpdateWebhook: (context) => this.saveWebhook(context, context.params.partnerWebhookId),
    })
    this.service = createService({
      document,
      handlers,
      sqlite,
      namespace,
      now: this.now,
      notFound: () => jsonRes(404, { statusCode: 404, message: "Resource not found" }),
      onError: (error) => {
        throw error
      },
      before: (context) => {
        const key = apiKeyCredential(context.request)
        if (!key) return jsonRes(401, { statusCode: 401, message: MISSING_KEY })
        const keys = this.state.current().apiKeys
        if (keys.length > 0 && !keys.includes(key)) {
          return jsonRes(401, { statusCode: 401, message: INVALID_KEY })
        }
        const effect = (name: string) => faultEffect(context.request, name) !== undefined
        if (effect("no_content")) return new Response(null, { status: 204 })
        if (effect("empty_success")) return new Response("", { status: 200 })
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

  private listElements(context: OperationContext): Response {
    const labId = Number(context.params.labId)
    if (!LABS.some((lab) => lab.labId === labId))
      return message(404, `Lab ${context.params.labId} not found.`)
    return jsonRes(
      200,
      ELEMENTS.map((element) => labElement(labId, element)),
    )
  }

  private savePatient(context: OperationContext, patientId: string | undefined): Response {
    const practiceId = context.params.practiceId as string
    const existing = patientId === undefined ? undefined : this.state.patient(practiceId, patientId)
    if (patientId !== undefined && !existing) return message(404, "Patient not found.")
    const body = jsonBody(context)
    if (!body) return problem({ "": ["A non-empty request body is required."] })
    const errors: Record<string, string[]> = {}
    for (const [key, label] of [
      ["firstName", "FirstName"],
      ["lastName", "LastName"],
      ["email", "Email"],
    ] as const) {
      if (!text(body[key])?.trim()) errors[label] = [`The ${label} field is required.`]
    }
    if (
      body.dateOfBirth !== undefined &&
      body.dateOfBirth !== null &&
      !dotnetDate(body.dateOfBirth)
    ) {
      errors.DateOfBirth = ["The value is not a valid date."]
    }
    if (Object.keys(errors).length > 0) return problem(errors)
    const now = this.iso()
    const patient: PatientRecord = {
      patientId: existing?.patientId ?? this.state.nextId("patient"),
      practiceId,
      createdDate: existing?.createdDate ?? now,
      lastUpdatedDate: now,
      userTitle: null,
      userFirstName: null,
      userLastName: null,
      firstName: text(body.firstName) as string,
      lastName: text(body.lastName) as string,
      nickname: text(body.nickname),
      dateOfBirth: dotnetDate(body.dateOfBirth),
      gender: gender(body.gender),
      homePhone: null,
      workPhone: null,
      mobile: null,
      email: text(body.email) as string,
      address: null,
      address2: null,
      address3: null,
      city: null,
      province: null,
      postalCode: null,
      country: null,
      userId: text(body.userId),
      workspaceId: typeof body.workspaceId === "number" ? body.workspaceId : 0,
      partnerUserId: existing?.partnerUserId ?? null,
    }
    this.state.patients.insert(String(patient.patientId), patient)
    return annotateResponse(jsonRes(200, publicPatient(patient)), {
      ids: { patientId: String(patient.patientId) },
    })
  }

  private deletePatient(context: OperationContext): Response {
    const patient = this.state.patient(
      context.params.practiceId as string,
      context.params.patientId as string,
    )
    if (!patient) return message(404, "Patient not found.")
    this.state.patients.delete(String(patient.patientId))
    for (const row of this.state.tests.list({ where: (t) => t.patientId === patient.patientId })) {
      this.state.tests.delete(row.id)
    }
    return annotateResponse(new Response(null, { status: 204 }), {
      ids: { patientId: String(patient.patientId) },
    })
  }

  private linkPartner(context: OperationContext): Response {
    const patient = this.state.patient(
      context.params.practiceId as string,
      context.params.patientId as string,
    )
    if (!patient) return message(404, "Patient not found.")
    this.state.patients.update(String(patient.patientId), {
      ...patient,
      partnerUserId: context.params.localUserId as string,
      lastUpdatedDate: this.iso(),
    })
    return annotateResponse(jsonRes(200, true), { ids: { patientId: String(patient.patientId) } })
  }

  private listPatients(context: OperationContext): Response {
    const practiceId = context.params.practiceId as string
    const q = context.url.searchParams
    const filters = {
      email: q.get("email"),
      firstName: q.get("firstName"),
      lastName: q.get("lastName"),
      dateOfBirth: q.get("dateOfBirth"),
    }
    const searching = Object.values(filters).some((v) => v)
    const eq = (a: string | null, b: string | null) =>
      !b || (a ?? "").toLowerCase() === b.toLowerCase()
    const rows = this.state.patients
      .list({ where: (p) => p.practiceId === practiceId, order: "oldest" })
      .map((row) => row.value)
      .filter(
        (p) =>
          eq(p.email, filters.email) &&
          eq(p.firstName, filters.firstName) &&
          eq(p.lastName, filters.lastName) &&
          (!filters.dateOfBirth ||
            p.dateOfBirth?.slice(0, 10) === dotnetDate(filters.dateOfBirth)?.slice(0, 10)),
      )
    if (searching && rows.length === 0) return message(404, "No patients found.")
    return jsonRes(200, rows.map(publicPatient))
  }

  private listTests(context: OperationContext): Response {
    const patient = this.state.patient(
      context.params.practiceId as string,
      context.params.patientId as string,
    )
    if (!patient) return message(404, "Patient not found.")
    return jsonRes(
      200,
      this.state.tests
        .list({ where: (t) => t.patientId === patient.patientId, order: "oldest" })
        .map((row) => row.value),
    )
  }

  private testBase(body: Json, errors: Record<string, string[]>) {
    const labId = Number(body.labId)
    if (!Number.isInteger(labId) || !LABS.some((lab) => lab.labId === labId)) {
      errors.LabId = [`Lab ${text(body.labId) ?? ""} is not available to this partner.`]
    }
    if (typeof body.labProfileId !== "number")
      errors.LabProfileId = ["The LabProfileId field is required."]
    const testDate = dotnetDate(body.testDate)
    if (!testDate) errors.TestDate = ["The TestDate field is required."]
    const unitType = text(body.unitType) ?? ""
    if (!["ConventionalUS", "SI"].includes(unitType))
      errors.UnitType = ["The UnitType field is invalid."]
    const phase = text(body.menstrualPhase) ?? "Unknown"
    if (!PHASES.includes(phase)) errors.MenstrualPhase = ["The MenstrualPhase field is invalid."]
    return { labId, testDate: testDate ?? "", unitType, phase }
  }

  private createTestResults(context: OperationContext): Response {
    const practiceId = context.params.practiceId as string
    const patient = this.state.patient(practiceId, context.params.patientId as string)
    if (!patient) return message(404, "Patient not found.")
    const body = jsonBody(context)
    if (!body) return problem({ "": ["A non-empty request body is required."] })
    const errors: Record<string, string[]> = {}
    const base = this.testBase(body, errors)
    if (!Array.isArray(body.results)) errors.Results = ["The Results field is required."]
    if (Object.keys(errors).length > 0) return problem(errors)
    const results = []
    const importLogs = []
    for (const raw of body.results as unknown[]) {
      const item = isRecord(raw) ? raw : {}
      const element = ELEMENTS.find((e) => e.elementId === item.elementId)
      if (!element || typeof item.value !== "number") {
        importLogs.push({
          observationIdentifier: text(item.elementId),
          observationIdentifierText: null,
          status: element ? "InvalidValue" : "NotMapped",
        })
        continue
      }
      results.push(resultFor(element, item.value, text(item.comparison) ?? "", base.unitType))
      importLogs.push({
        observationIdentifier: String(element.elementId),
        observationIdentifierText: element.elementName,
        status: "Imported",
      })
    }
    const test = this.storeTest(patient, body, base, { results, importLogs }, undefined)
    return this.testResponse(context, test, "Created")
  }

  private saveHl7Test(context: OperationContext, patientTestId: string | undefined): Response {
    const practiceId = context.params.practiceId as string
    const patient = this.state.patient(practiceId, context.params.patientId as string)
    if (!patient) return message(404, "Patient not found.")
    const existing = patientTestId === undefined ? undefined : this.state.tests.get(patientTestId)
    if (patientTestId !== undefined && (!existing || existing.patientId !== patient.patientId)) {
      return message(404, "Patient test not found.")
    }
    const body = jsonBody(context)
    if (!body) return problem({ "": ["A non-empty request body is required."] })
    const errors: Record<string, string[]> = {}
    const base = this.testBase(body, errors)
    const observations = parseObservations(text(body.hl7) ?? "")
    if (!observations) errors.Hl7 = ["The HL7 message could not be parsed (missing MSH segment)."]
    else if (observations.length === 0) errors.Hl7 = ["The HL7 message contains no OBX segments."]
    if (Object.keys(errors).length > 0) return problem(errors)
    const imported = importObservations(observations ?? [], patient.gender, base.unitType)
    const test = this.storeTest(patient, body, base, imported, existing)
    return this.testResponse(context, test, existing ? "Updated" : "Created")
  }

  private storeTest(
    patient: PatientRecord,
    body: Json,
    base: { labId: number; testDate: string; unitType: string; phase: string },
    imported: Pick<PatientTestRecord, "results" | "importLogs">,
    existing: PatientTestRecord | undefined,
  ): PatientTestRecord {
    const now = this.iso()
    const test: PatientTestRecord = {
      patientTestId: existing?.patientTestId ?? this.state.nextId("test"),
      patientId: patient.patientId,
      labProfileId: body.labProfileId as number,
      testDate: base.testDate,
      unitType: base.unitType,
      createdDate: existing?.createdDate ?? now,
      lastUpdatedDate: now,
      userId: text(body.userId),
      practiceId: patient.practiceId,
      labId: base.labId,
      externalReference: text(body.externalReference),
      externalMessageControlId: text(body.externalMessageControlId),
      externalPatientTestId: text(body.externalPatientTestId),
      results: imported.results,
      importLogs: imported.importLogs,
      menstrualPhase: base.phase,
      isFasting: body.isFasting === true,
    }
    this.state.tests.insert(String(test.patientTestId), test)
    return test
  }

  private testResponse(
    context: OperationContext,
    test: PatientTestRecord,
    eventType: OdxEventType,
  ) {
    const signature: SignatureMode =
      faultEffect(context.request, "wrong_length_signature") !== undefined
        ? "short"
        : faultEffect(context.request, "bad_signature") !== undefined
          ? "bad"
          : "valid"
    this.emit(test.patientTestId, eventType, signature)
    return annotateResponse(jsonRes(200, test), {
      ids: { patientId: String(test.patientId), patientTestId: String(test.patientTestId) },
    })
  }

  /** Emit a PatientTest webhook for a stored test (tests, the admin route, `Deleted`). */
  emit(
    patientTestId: number | string,
    eventType: OdxEventType,
    signature: SignatureMode = "valid",
  ) {
    const test = this.state.tests.get(String(patientTestId))
    if (!test) return undefined
    const event: OdxWebhook = { entityType: "PatientTest", eventType, data: test }
    this.onWebhook?.(event, signature)
    if (eventType === "Deleted") this.state.tests.delete(String(test.patientTestId))
    return event
  }

  private report(context: OperationContext): Response {
    const body = jsonBody(context)
    if (!body) return problem({ "": ["A non-empty request body is required."] })
    const output = (text(body.outputType) ?? "").toLowerCase()
    if (output !== "json" && output !== "pdf") {
      return problem({
        OutputType: [`The value '${text(body.outputType) ?? ""}' is not valid for OutputType.`],
      })
    }
    const test = this.state.tests.get(String(body.patientTestId))
    if (!test || (body.patientId !== undefined && test.patientId !== Number(body.patientId))) {
      return message(404, "Patient test not found.")
    }
    const ids = { patientId: String(test.patientId), patientTestId: String(test.patientTestId) }
    if (output === "pdf") {
      const pdf = pdfReport(test)
      return annotateResponse(
        new Response(pdf as BodyInit, {
          status: 200,
          headers: { "content-type": "application/pdf", "content-length": String(pdf.byteLength) },
        }),
        { ids },
      )
    }
    return annotateResponse(jsonRes(200, jsonReport(test, body)), { ids })
  }

  private saveWebhook(context: OperationContext, id: string | undefined): Response {
    const existing = id === undefined ? undefined : this.state.webhooks.get(id)
    if (id !== undefined && !existing) return message(404, "Webhook not found.")
    const body = jsonBody(context)
    const url = text(body?.webhookUrl)
    const events = isRecord(body?.entityEvents) ? body.entityEvents.PatientTest : undefined
    const errors: Record<string, string[]> = {}
    let valid = false
    try {
      valid = url !== null && ["http:", "https:"].includes(new URL(url).protocol)
    } catch {
      valid = false
    }
    if (!valid) errors.WebhookUrl = ["The WebhookUrl field is not a valid URL."]
    if (
      !Array.isArray(events) ||
      events.length === 0 ||
      events.some((e) => !["Created", "Updated", "Deleted"].includes(String(e)))
    ) {
      errors["EntityEvents.PatientTest"] = [
        "PatientTest events must be Created, Updated or Deleted.",
      ]
    }
    if (Object.keys(errors).length > 0) return problem(errors)
    const webhook = existing
      ? {
          ...existing,
          webhookUrl: url as string,
          entityEvents: { PatientTest: (events as string[]).map(String) },
        }
      : this.state.addWebhook(url as string, (events as string[]).map(String))
    this.state.webhooks.insert(String(webhook.partnerWebhookId), webhook)
    return annotateResponse(jsonRes(200, webhook), {
      ids: { partnerWebhookId: String(webhook.partnerWebhookId) },
    })
  }

  patients(): PatientRecord[] {
    return this.state.patients.list({ order: "oldest" }).map((row) => row.value)
  }

  tests(): PatientTestRecord[] {
    return this.state.tests.list({ order: "oldest" }).map((row) => row.value)
  }
}

/** A patient as the API returns it (the partner user id is admin-only). */
const publicPatient = ({ partnerUserId: _partner, ...patient }: PatientRecord) => patient

export type { OdxRuntime, OdxRuntimeOptions } from "./runtime.js"
export { createRuntime, ODX_PRESETS, SIGNATURE_HEADER, signOdx } from "./runtime.js"
export { matchElement }
