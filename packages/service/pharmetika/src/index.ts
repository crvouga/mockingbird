import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  annotateResponse,
  basicAuth,
  bodyIssues,
  bootSqlite,
  createService,
  defineOperations,
  faultEffect,
  HttpError,
  IdempotencyStore,
  jsonRes,
  type OperationContext,
  opaqueToken,
  type Service,
  stableStringify,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { Hono } from "hono"
import type { Clinic, MedicationTemplate } from "./catalog.js"
import { document, type SupportedOperationId } from "./generated/openapi.js"
import {
  type OrderRecord,
  type PatientRecord,
  PharmetikaState,
  SANDBOX_PATIENT,
  type Settings,
} from "./state.js"
import {
  isCancellable,
  isShippedOrLater,
  PENDING_APPROVAL_STATUS,
  SUBMITTED_STATUS,
} from "./statuses.js"

export type { FetchAPI } from "@crvouga/mockingbird-core"
export type { SqliteClient } from "@crvouga/mockingbird-sqlite"
export type { Clinic, MedicationTemplate } from "./catalog.js"
export { DEFAULT_CLINICS, DEFAULT_TEMPLATES } from "./catalog.js"
export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export type {
  AutoAdvance,
  OrderRecord,
  PatientRecord,
  Settings,
  WebhookVariant,
} from "./state.js"
export { SANDBOX_PATIENT } from "./state.js"
export { KNOWN_STATUSES, PENDING_APPROVAL_STATUS, SUBMITTED_STATUS } from "./statuses.js"

export const PHARMETIKA_NAMESPACE = "pharmetika"

/** The header our adapter authenticates every provider-portal call with. */
export const TOKEN_HEADER = "x-pmk-authentication-token"

/**
 * The status webhook Pharmetika posts. Which fields carry the id and status depends on the
 * namespace's `webhookVariant`; our receiver reads every variant.
 */
export type PharmetikaWebhook = Record<string, unknown> & {
  event_type?: "medication_order.status_updated"
}

export type PharmetikaAPIOptions = APIOptions & {
  /** Medication templates every namespace starts with. Default: {@link DEFAULT_TEMPLATES}. */
  templates?: readonly MedicationTemplate[]
  /** Clinics every namespace starts with. Default: {@link DEFAULT_CLINICS}. */
  clinics?: readonly Clinic[]
  /** Patients every namespace's roster starts with. Default: [{@link SANDBOX_PATIENT}]. */
  patients?: readonly PatientRecord[]
  /** Initial per-namespace settings (tokens, catalog auth, webhook variant, auto-advance). */
  settings?: Partial<Settings>
  /** Called for every status change; the runtime delivers it with the secret header. */
  onWebhook?: (event: { orderId: string; status: string; body: PharmetikaWebhook }) => void
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type Message = { message: string; type: "info" | "warning" | "error" }
const error = (message: string): Message => ({ message, type: "error" })

/**
 * The credential a request carries: the portal token, else the Basic username (the catalog
 * client's fallback). Suites map either to a namespace with `PUT /__admin/credentials`.
 */
export const tokenCredential = (request: Request): string | undefined =>
  request.headers.get(TOKEN_HEADER)?.trim() || basicAuth(request)?.username || undefined

const record = (context: OperationContext): Record<string, unknown> => {
  if (
    context.body.kind !== "json" ||
    typeof context.body.value !== "object" ||
    !context.body.value ||
    Array.isArray(context.body.value)
  ) {
    throw new HttpError(200, {
      success: 0,
      messages: [error("The request body must be a JSON object.")],
    })
  }
  return context.body.value as Record<string, unknown>
}

/** Pharmetika answers a failed check with HTTP 200 and `success: 0` — the rule our client guards. */
const failure = (messages: Message[], status = 200) => jsonRes(status, { success: 0, messages })

type OrderLine = {
  product_identification: { product_identifier: string }
  quantity_authorized: number
  sig: string
  medication_order_entry_identifier?: string
} & Record<string, unknown>

type CheckedOrder = {
  id: string
  body: Record<string, unknown>
  clinic: string
  practitioner: string | null
  patientId: number
  lines: (OrderLine & { controlled: number })[]
  controlled: number
}

export type TransitionInput = { to: string; tracking_id?: string }

/**
 * Stateful mock of the Pharmetika provider portal.
 *
 * Orders are keyed by our UUIDv7 `medication_order_identifier`. Submit parks a
 * non-controlled order at `prescription_entered`; EPCS prepare parks a controlled one at
 * `pending_prescriber_approval` and it can never be submitted. After that, orders move only
 * through admin transitions or auto-advance, each emitting the status webhook.
 */
export class PharmetikaAPI implements FetchAPI {
  readonly app: Hono
  readonly sqlite: SqliteClient
  readonly state: PharmetikaState
  private readonly service: Service
  private readonly idempotency: IdempotencyStore
  private readonly now: () => number
  private readonly onWebhook: PharmetikaAPIOptions["onWebhook"]

  constructor(options: PharmetikaAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite)
    const namespace = options.namespace ?? PHARMETIKA_NAMESPACE
    this.now = options.now ?? (() => Date.now())
    this.onWebhook = options.onWebhook
    this.state = new PharmetikaState(sqlite, namespace, {
      templates: options.templates ?? [],
      clinics: options.clinics ?? [],
      patients: options.patients ?? [SANDBOX_PATIENT],
      settings: options.settings ?? {},
    })
    this.idempotency = new IdempotencyStore(sqlite, namespace, "submit_idempotency")
    const handlers = defineOperations<SupportedOperationId>({
      ListClinics: (context) => this.listClinics(context),
      ListPatients: (context) =>
        this.ok(context, {
          data: this.state.patients.list({ order: "oldest" }).map(({ value }) => ({
            patient_id: value.patient_id,
            demographics: value.demographics,
          })),
        }),
      CreatePatient: (context) => this.createPatient(context),
      ValidateMedicationOrder: (context) => this.validate(context),
      PrepareMedicationOrder: (context) => this.prepare(context),
      SubmitMedicationOrder: (context) => this.submit(context),
      GetMedicationOrder: (context) => this.getOrder(context),
      CancelMedicationOrder: (context) => this.cancel(context),
      ListMedicationTemplates: (context) =>
        this.ok(context, {
          data: this.state.templates.list({ order: "oldest" }).map(({ value }) => value),
        }),
    })
    this.service = createService({
      document,
      handlers,
      sqlite,
      namespace,
      now: this.now,
      notFound: () => jsonRes(404, { success: 0, messages: [error("Not Found")] }),
      onError: (thrown) => {
        if (thrown instanceof HttpError) return thrown.toResponse()
        throw thrown
      },
      before: (context) => {
        this.tick()
        return this.authenticate(context)
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

  private authenticate(context: OperationContext): Response | undefined {
    const settings = this.state.current()
    const rejected = failure([error("Invalid authentication token.")], 401)
    if (faultEffect(context.request, "unauthorized") !== undefined) return rejected
    const token = context.request.headers.get(TOKEN_HEADER)?.trim()
    if (token) {
      return settings.tokens.length === 0 || settings.tokens.includes(token) ? undefined : rejected
    }
    if (context.operation.operationId !== "ListMedicationTemplates") {
      return failure([error("Authentication token is required.")], 401)
    }
    const basic = basicAuth(context.request)
    if (basic) {
      const known =
        settings.basic.length === 0 ||
        settings.basic.some((b) => b.username === basic.username && b.password === basic.password)
      return known ? undefined : rejected
    }
    return settings.anonymousCatalog ? undefined : rejected
  }

  /** `success: 1`, or the value a success-flag preset substitutes. */
  private successFlag(context: OperationContext): 1 | true | "1" {
    if (faultEffect(context.request, "success_string") !== undefined) return "1"
    if (faultEffect(context.request, "success_boolean") !== undefined) return true
    return 1
  }

  private ok(context: OperationContext, body: Record<string, unknown>, messages: Message[] = []) {
    return jsonRes(200, { success: this.successFlag(context), messages, ...body })
  }

  private listClinics(context: OperationContext): Response {
    const clinics = this.state.clinics.list({ order: "oldest" }).map(({ value }) => value)
    if (faultEffect(context.request, "clinic_list_keyed") !== undefined) {
      // The adapter also accepts `data` as an object keyed by identifier.
      return this.ok(context, { data: Object.fromEntries(clinics.map((c) => [c.identifier, c])) })
    }
    return this.ok(context, { data: clinics })
  }

  private createPatient(context: OperationContext): Response {
    const body = record(context)
    const issues = bodyIssues(context)
    if (issues.length > 0) {
      return failure(issues.map((i) => error(`${i.path || "body"}: ${i.message}`)))
    }
    const clinic = String(body.clinic_identifier)
    if (!this.state.clinics.has(clinic)) return failure([error(`Unknown clinic ${clinic}.`)])
    const name = (body.name as { family: string; given: string[] }[])[0] as {
      family: string
      given: string[]
    }
    const telecom = (body.telecom as { system: string; value: string }[] | undefined) ?? []
    const address = (body.address as { line?: string[]; postalCode?: string }[] | undefined)?.[0]
    const demographics: PatientRecord["demographics"] = {
      first_name: name.given[0] ?? "",
      last_name: name.family,
      DOB: String(body.birthDate),
      email: telecom.find((t) => t.system === "email")?.value ?? "",
      phone_primary: telecom.find((t) => t.system === "phone")?.value ?? "",
      line_1: address?.line?.[0] ?? "",
      postal_code: address?.postalCode ?? "",
    }
    const same = (p: PatientRecord) =>
      p.demographics.first_name.trim().toLowerCase() ===
        demographics.first_name.trim().toLowerCase() &&
      p.demographics.last_name.trim().toLowerCase() ===
        demographics.last_name.trim().toLowerCase() &&
      p.demographics.DOB.slice(0, 10) === demographics.DOB.slice(0, 10)
    let duplicates = this.state.patients.list({ where: same }).map(({ value }) => value)
    if (duplicates.length === 0 && faultEffect(context.request, "patient_create_duplicate")) {
      // The pharmacy already knows this person (e.g. from another clinic): it refuses the
      // create and names the existing record, which our adapter adopts.
      duplicates = [this.insertPatient(clinic, demographics)]
    }
    if (duplicates.length > 0) {
      return annotateResponse(
        jsonRes(200, {
          success: 0,
          messages: [{ message: "Possible duplicate patient found.", type: "warning" }],
          duplicate_entry_count: duplicates.length,
          duplicate_entries: duplicates.map((p) => ({
            patient_id: p.patient_id,
            demographics: p.demographics,
          })),
        }),
        { ids: { patientId: String(duplicates[0]?.patient_id) } },
      )
    }
    const created = this.insertPatient(clinic, demographics)
    return annotateResponse(
      this.ok(context, { patient_id: created.patient_id }, [
        { message: "Added Patient!", type: "info" },
      ]),
      { ids: { patientId: String(created.patient_id) } },
    )
  }

  private insertPatient(clinic: string, demographics: PatientRecord["demographics"]) {
    const patient: PatientRecord = {
      patient_id: this.state.nextPatientId(),
      clinic_identifier: clinic,
      demographics,
    }
    this.state.patients.insert(String(patient.patient_id), patient)
    return patient
  }

  /** Every check validate, prepare and submit share. A `Response` is the vendor's refusal. */
  private check(context: OperationContext): CheckedOrder | Response {
    const body = record(context)
    const issues = bodyIssues(context)
    if (issues.length > 0) {
      return failure(issues.map((i) => error(`${i.path || "body"}: ${i.message}`)))
    }
    const id = context.params.orderId ?? ""
    if (!UUID.test(id)) {
      return failure([error("medication_order_identifier must be a UUID.")])
    }
    // The identifier in the URL is authoritative; the body's copy is not cross-checked.
    const clinic = String(body.clinic_identifier)
    if (!this.state.clinics.has(clinic)) return failure([error(`Unknown clinic ${clinic}.`)])
    const patientId = (body.patient as { identification: { patient_id: number } }).identification
      .patient_id
    if (!this.state.patients.has(String(patientId))) {
      return failure([error(`Patient ${patientId} was not found.`)])
    }
    const messages: Message[] = []
    const lines = (body.medication_requests as OrderLine[]).map((line) => {
      const productId = line.product_identification.product_identifier
      const product = this.state.product(productId)
      if (!product) messages.push(error(`Unknown product_identifier ${productId}.`))
      if (line.sig.trim().length === 0) messages.push(error("Please provide instructions"))
      return { ...line, controlled: product?.template.controlled ?? 0 }
    })
    if (messages.length > 0) return failure(messages)
    return {
      id,
      body,
      clinic,
      practitioner:
        typeof body.practitioner_identifier === "string" ? body.practitioner_identifier : null,
      patientId,
      lines,
      controlled: Math.max(0, ...lines.map((l) => l.controlled)),
    }
  }

  private validate(context: OperationContext): Response {
    const checked = this.check(context)
    if (checked instanceof Response) return checked
    if (faultEffect(context.request, "validate_success_zero") !== undefined) {
      return failure([error("Invalid DEA")])
    }
    const entries = checked.lines.map((line, index) => ({
      ...line,
      medication_order_entry_identifier:
        line.medication_order_entry_identifier ??
        `${checked.id.slice(0, 24)}${String(index).padStart(12, "0")}`,
      controlled: line.controlled,
      control_level: line.controlled,
    }))
    const count = entries.filter((e) => e.controlled > 0).length
    const data =
      faultEffect(context.request, "controlled_nested_requests") !== undefined
        ? // The adapter also finds the entries under `data.medication_requests`.
          { controlled_substance_list_count: count, medication_requests: entries }
        : {
            controlled_substance_list_count:
              faultEffect(context.request, "controlled_count_string") !== undefined
                ? String(count)
                : count,
            medication_list: entries,
          }
    return annotateResponse(this.ok(context, { data }), { ids: { orderId: checked.id } })
  }

  private newOrder(checked: CheckedOrder, status: string): OrderRecord {
    const now = this.iso()
    return {
      medication_order_identifier: checked.id,
      clinic_identifier: checked.clinic,
      practitioner_identifier: checked.practitioner,
      patient_id: checked.patientId,
      product_identifiers: checked.lines.map((l) => l.product_identification.product_identifier),
      controlled: checked.controlled,
      workflow_status: status,
      tracking_id: null,
      created_at: now,
      updated_at: now,
      createdAtMs: this.now(),
      advanced: 0,
    }
  }

  private ack(context: OperationContext, order: OrderRecord, message: string): Response {
    return annotateResponse(
      this.ok(
        context,
        {
          data: {
            medication_order_identifier: order.medication_order_identifier,
            order_status: order.workflow_status,
          },
        },
        [{ message, type: "info" }],
      ),
      { ids: { orderId: order.medication_order_identifier } },
    )
  }

  private prepare(context: OperationContext): Response {
    const checked = this.check(context)
    if (checked instanceof Response) return checked
    if (faultEffect(context.request, "prepare_success_zero") !== undefined) {
      return failure([error("Prescriber is not enrolled for EPCS.")])
    }
    if (typeof checked.body.prepared_by !== "string" || checked.body.prepared_by.length === 0) {
      return failure([error("prepared_by is required to prepare an order.")])
    }
    const existing = this.state.orders.get(checked.id)
    if (existing && existing.workflow_status !== PENDING_APPROVAL_STATUS) {
      return failure([error(`Medication order ${checked.id} has already been submitted.`)])
    }
    const order = existing ?? this.newOrder(checked, PENDING_APPROVAL_STATUS)
    if (!existing) this.state.orders.insert(order.medication_order_identifier, order)
    return this.ack(context, order, "Order prepared; awaiting prescriber approval.")
  }

  /**
   * What makes two submits "the same order" for idempotency: the clinic, patient and the
   * products, quantities and sigs. Our adapter regenerates `date_issued` and each entry id on
   * every attempt, so those are left out.
   */
  private fingerprint(checked: CheckedOrder): string {
    return stableStringify({
      clinic: checked.clinic,
      patient: checked.patientId,
      lines: checked.lines.map((l) => [
        l.product_identification.product_identifier,
        l.quantity_authorized,
        l.sig.trim(),
      ]),
    })
  }

  private async submit(context: OperationContext): Promise<Response> {
    const checked = this.check(context)
    if (checked instanceof Response) return checked
    if (checked.controlled > 0) {
      return failure([
        error("Controlled substances must be prepared and signed by the prescriber (EPCS)."),
      ])
    }
    if (faultEffect(context.request, "submit_success_zero") !== undefined) {
      return failure([error("Order could not be submitted.")])
    }
    const fingerprint = this.fingerprint(checked)
    const conflict = () =>
      failure(
        [error(`Medication order ${checked.id} is already being submitted with other contents.`)],
        409,
      )
    return this.idempotency.run(
      checked.id,
      fingerprint,
      {
        mismatch: conflict,
        conflict: () =>
          failure([error(`Medication order ${checked.id} is still being submitted.`)], 409),
      },
      () => {
        const existing = this.state.orders.get(checked.id)
        if (existing) {
          // Only a response the mock withheld (`submitted_but_500`) lands here: the retry
          // with the same contents answers as the first attempt should have.
          return existing.workflow_status === PENDING_APPROVAL_STATUS
            ? failure([error(`Medication order ${checked.id} awaits prescriber approval.`)])
            : this.ack(context, existing, "Order submitted.")
        }
        const order = this.newOrder(checked, SUBMITTED_STATUS)
        this.state.orders.insert(order.medication_order_identifier, order)
        if (faultEffect(context.request, "submitted_but_500") !== undefined) {
          return annotateResponse(failure([error("Server Error")], 500), {
            ids: { orderId: order.medication_order_identifier },
          })
        }
        return this.ack(context, order, "Order submitted.")
      },
    )
  }

  private lookupBody(order: OrderRecord) {
    return {
      medication_order_identifier: order.medication_order_identifier,
      electronic_prescription_order_number: order.medication_order_identifier,
      order_status: order.workflow_status,
      data: {
        order_status: order.workflow_status,
        clinic_identifier: order.clinic_identifier,
        patient_id: order.patient_id,
        product_identifiers: order.product_identifiers,
        created_at: order.created_at,
        updated_at: order.updated_at,
        ancillary_order_data: {
          medication_order_status: {
            workflow_status: order.workflow_status,
            tracking_id: order.tracking_id,
          },
        },
      },
    }
  }

  private getOrder(context: OperationContext): Response {
    const id = context.params.orderId ?? ""
    const order = this.state.orders.get(id)
    if (!order) return failure([error(`Medication order ${id} was not found.`)], 404)
    if (faultEffect(context.request, "lookup_success_zero") !== undefined) {
      return failure([error("Order lookup is temporarily unavailable.")])
    }
    return annotateResponse(this.ok(context, { data: this.lookupBody(order) }), {
      ids: { orderId: id },
    })
  }

  private cancel(context: OperationContext): Response {
    const body = record(context)
    const issues = bodyIssues(context)
    if (issues.length > 0) {
      return failure(issues.map((i) => error(`${i.path || "body"}: ${i.message}`)))
    }
    const id = String(body.prescriber_order_number)
    const order = this.state.orders.get(id)
    if (!order) return failure([error(`Medication order ${id} was not found.`)])
    if (!isCancellable(order.workflow_status)) {
      return failure([
        error(`Medication order ${id} cannot be cancelled in status ${order.workflow_status}.`),
      ])
    }
    this.transition(id, { to: "cancelled" })
    const success = faultEffect(context.request, "cancel_success_true") !== undefined ? true : 1
    return annotateResponse(jsonRes(200, { success, messages: [] }), { ids: { orderId: id } })
  }

  /** Move an order to a workflow status and emit the status webhook. */
  transition(id: string, input: TransitionInput): OrderRecord | undefined {
    const order = this.state.orders.get(id)
    if (!order) return undefined
    const tracking_id =
      input.tracking_id ??
      order.tracking_id ??
      (isShippedOrLater(input.to) ? `1Z${opaqueToken(id, 16).toUpperCase()}` : null)
    const next: OrderRecord = {
      ...order,
      workflow_status: input.to,
      tracking_id,
      updated_at: this.iso(),
    }
    this.state.orders.update(id, next)
    this.onWebhook?.({ orderId: id, status: input.to, body: this.webhookBody(next) })
    return this.state.orders.get(id)
  }

  /** The webhook body in the namespace's variant (each is one of our receiver's fallbacks). */
  webhookBody(order: OrderRecord): PharmetikaWebhook {
    const id = order.medication_order_identifier
    const tracking = order.tracking_id ? { tracking_id: order.tracking_id } : {}
    switch (this.state.current().webhookVariant) {
      case "status":
        return {
          event_type: "medication_order.status_updated",
          event_data: {
            medication_order_identifier: id,
            status: order.workflow_status,
            ...tracking,
          },
        }
      case "flat":
        return {
          medication_order_identifier: id,
          medication_order_workflow_status: order.workflow_status,
          ...tracking,
        }
      default:
        return {
          event_type: "medication_order.status_updated",
          event_data: {
            electronic_prescription_order_number: id,
            medication_order_identifier: id,
            medication_order_status: {
              workflow_status: order.workflow_status,
              tracking_id: order.tracking_id,
            },
            ...tracking,
            updated_at: order.updated_at,
          },
        }
    }
  }

  /**
   * Apply every auto-advance step that is due on the mock clock. Runs before each vendor
   * request, on `POST /__admin/tick`, and from the served runtime's background ticker.
   * Orders awaiting prescriber approval never move on their own.
   */
  tick(): number {
    const plan = this.state.current().autoAdvance
    if (!plan || plan.path.length === 0) return 0
    let applied = 0
    for (const { value: order } of this.state.orders.list({ order: "oldest" })) {
      if (order.workflow_status === PENDING_APPROVAL_STATUS) continue
      let current = order
      while (current.advanced < plan.path.length) {
        const due = current.createdAtMs + plan.afterMs * (current.advanced + 1)
        if (this.now() < due) break
        const to = plan.path[current.advanced] as string
        const moved = this.transition(current.medication_order_identifier, { to })
        if (!moved) break
        current = { ...moved, advanced: current.advanced + 1 }
        this.state.orders.update(current.medication_order_identifier, current)
        applied++
      }
    }
    return applied
  }

  orders(): OrderRecord[] {
    return this.state.orders.list({ order: "oldest" }).map((row) => row.value)
  }
}

export type { PharmetikaRuntime, PharmetikaRuntimeOptions } from "./runtime.js"
export { createRuntime, PHARMETIKA_PRESETS, WEBHOOK_SECRET_HEADER } from "./runtime.js"
