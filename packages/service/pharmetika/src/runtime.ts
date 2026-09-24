import {
  type AdminRoutes,
  type Clock,
  createRuntime as createServiceRuntime,
  createWebhookHub,
  type FaultPreset,
  type RequestLog,
  type ServiceRuntime,
  signers,
  type WebhookEndpoint,
  type WebhookHub,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { Clinic, MedicationTemplate } from "./catalog.js"
import { document } from "./generated/openapi.js"
import { PHARMETIKA_NAMESPACE, PharmetikaAPI, tokenCredential } from "./index.js"
import type { AutoAdvance, PatientRecord, Settings, WebhookVariant } from "./state.js"

/** Header our receiver compares to `PHARMETIKA_WEBHOOK_SECRET` (plain equality). */
export const WEBHOOK_SECRET_HEADER = "x-pharmetika-webhook-secret"

const PORTAL = "/api/v5/provider_portal"

/**
 * Every named Pharmetika misbehaviour our consumer branches on, switched on with
 * `POST /__admin/faults {"preset": "<name>"}` (add `count` to limit it).
 */
export const PHARMETIKA_PRESETS: Record<string, FaultPreset> = {
  validate_success_zero: {
    description: "Validate answers HTTP 200 with success: 0 and a message (e.g. Invalid DEA)",
    rules: [{ operationId: "ValidateMedicationOrder", effect: "validate_success_zero" }],
  },
  submit_success_zero: {
    description: "Submit answers HTTP 200 with success: 0 (our client must treat it as a failure)",
    rules: [{ operationId: "SubmitMedicationOrder", effect: "submit_success_zero" }],
  },
  prepare_success_zero: {
    description: "EPCS prepare answers HTTP 200 with success: 0",
    rules: [{ operationId: "PrepareMedicationOrder", effect: "prepare_success_zero" }],
  },
  lookup_success_zero: {
    description: "Order lookup answers HTTP 200 with success: 0 (the status refresh returns null)",
    rules: [{ operationId: "GetMedicationOrder", effect: "lookup_success_zero" }],
  },
  validate_422: {
    description: "Validate answers 422 with success: 0 and messages [{message}]",
    rules: [
      {
        operationId: "ValidateMedicationOrder",
        status: 422,
        body: { success: 0, messages: [{ message: "Please provide instructions", type: "error" }] },
      },
    ],
  },
  success_boolean: {
    description: "Every success answers success: true instead of 1 (accepted, except by cancel)",
    rules: [{ pathPrefix: "/api/", effect: "success_boolean" }],
  },
  success_string: {
    description: 'Every success answers success: "1" (a string: our client treats it as failure)',
    rules: [{ pathPrefix: "/api/", effect: "success_string" }],
  },
  cancel_success_true: {
    description: "Cancel answers success: true; our cancel checks success === 1 strictly",
    rules: [{ operationId: "CancelMedicationOrder", effect: "cancel_success_true" }],
  },
  submitted_but_500: {
    description: "Submit records the order, then answers 500 (unknown outcome; retry replays)",
    rules: [{ operationId: "SubmitMedicationOrder", effect: "submitted_but_500" }],
  },
  patient_create_duplicate: {
    description: "Patient create answers success: 0 with duplicate_entries naming the patient",
    rules: [{ operationId: "CreatePatient", effect: "patient_create_duplicate" }],
  },
  patient_create_500: {
    description: "Patient create answers 500",
    rules: [
      {
        operationId: "CreatePatient",
        status: 500,
        body: { success: 0, messages: [{ message: "Server Error", type: "error" }] },
      },
    ],
  },
  clinic_list_keyed: {
    description: "clinic_list answers data as an object keyed by identifier, not an array",
    rules: [{ operationId: "ListClinics", effect: "clinic_list_keyed" }],
  },
  controlled_count_string: {
    description: 'Validate answers controlled_substance_list_count as a string ("1")',
    rules: [{ operationId: "ValidateMedicationOrder", effect: "controlled_count_string" }],
  },
  controlled_nested_requests: {
    description: "Validate answers the entries under data.medication_requests",
    rules: [{ operationId: "ValidateMedicationOrder", effect: "controlled_nested_requests" }],
  },
  unauthorized: {
    description: "Every call answers 401 (a revoked PHARMETIKA_API_TOKEN)",
    rules: [{ pathPrefix: "/api/", effect: "unauthorized" }],
  },
  server_error: {
    description: "Every provider-portal call answers 500",
    rules: [
      {
        pathPrefix: PORTAL,
        status: 500,
        body: { success: 0, messages: [{ message: "Server Error", type: "error" }] },
      },
    ],
  },
  webhook_duplicate: {
    description: "The next status webhook is delivered twice",
    webhook: { mode: "duplicate" },
  },
  webhook_reorder: {
    description: "The next two status webhooks arrive swapped",
    webhook: { mode: "reorder" },
  },
  webhook_drop: {
    description: "The next status webhook is never delivered",
    webhook: { mode: "drop" },
  },
}

export type PharmetikaRuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  seed?: number | string
  adminKey?: string
  onLog?: (entry: RequestLog) => void
  templates?: readonly MedicationTemplate[]
  clinics?: readonly Clinic[]
  patients?: readonly PatientRecord[]
  settings?: Partial<Settings>
  /** Where status webhooks go (`POST /prescriptions/webhooks/pharmetika`), sent with the secret header. */
  webhooks?: Omit<WebhookEndpoint, "id"> & {
    retryDelaysMs?: readonly number[]
    fetch?: (request: Request) => Promise<Response>
  }
  /**
   * Run auto-advance on this real-time interval (ms), so webhooks fire without a request
   * arriving. The served mock uses 100 ms; in-process runtimes default to off.
   */
  tickMs?: number
}

export type PharmetikaRuntime = ServiceRuntime<PharmetikaAPI> & {
  readonly webhooks: WebhookHub
  /** Stop the background ticker, if one runs. */
  stop(): void
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const adminError = (status: number, message: string) =>
  json(status, { error: { type: "mockingbird_admin", message } })
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const VARIANTS: WebhookVariant[] = ["workflow_status", "status", "flat"]

const parseAutoAdvance = (value: unknown): AutoAdvance | null | string => {
  if (value === null) return null
  if (!isRecord(value)) return "autoAdvance must be {afterMs, path} or null"
  if (typeof value.afterMs !== "number" || value.afterMs < 0)
    return "autoAdvance.afterMs must be ms"
  if (!Array.isArray(value.path) || value.path.some((s) => typeof s !== "string")) {
    return "autoAdvance.path must be a list of workflow statuses"
  }
  return { afterMs: value.afterMs, path: value.path as string[] }
}

const parseSettings = (body: Record<string, unknown>): Partial<Settings> | string => {
  const patch: Partial<Settings> = {}
  if (body.tokens !== undefined) {
    if (!Array.isArray(body.tokens)) return "tokens: string[]"
    patch.tokens = body.tokens.map(String)
  }
  if (body.basic !== undefined) {
    if (!Array.isArray(body.basic)) return "basic: [{username, password}]"
    patch.basic = body.basic.filter(isRecord).map((b) => ({
      username: String(b.username),
      password: String(b.password),
    }))
  }
  if (body.anonymousCatalog !== undefined) {
    if (typeof body.anonymousCatalog !== "boolean") return "anonymousCatalog: boolean"
    patch.anonymousCatalog = body.anonymousCatalog
  }
  if (body.webhookVariant !== undefined) {
    if (!VARIANTS.includes(body.webhookVariant as WebhookVariant)) {
      return `webhookVariant: one of ${VARIANTS.join(", ")}`
    }
    patch.webhookVariant = body.webhookVariant as WebhookVariant
  }
  if (body.autoAdvance !== undefined) {
    const parsed = parseAutoAdvance(body.autoAdvance)
    if (typeof parsed === "string") return parsed
    patch.autoAdvance = parsed
  }
  return patch
}

const parsePatient = (value: unknown, id: number): PatientRecord | string => {
  if (!isRecord(value)) return "expected a patient object"
  const d = isRecord(value.demographics) ? value.demographics : value
  for (const key of ["first_name", "last_name", "DOB"]) {
    if (typeof d[key] !== "string" || !(d[key] as string).trim()) return `${key} is required`
  }
  const text = (key: string) => (typeof d[key] === "string" ? (d[key] as string) : "")
  return {
    patient_id: typeof value.patient_id === "number" ? value.patient_id : id,
    clinic_identifier:
      typeof value.clinic_identifier === "string" ? value.clinic_identifier : "clinic-acme-0001",
    demographics: {
      first_name: text("first_name"),
      last_name: text("last_name"),
      DOB: text("DOB"),
      email: text("email"),
      phone_primary: text("phone_primary"),
      line_1: text("line_1"),
      postal_code: text("postal_code"),
    },
  }
}

const adminRoutes = (runtime: ServiceRuntime<PharmetikaAPI>): AdminRoutes => ({
  "GET /orders": ({ namespace }) => json(200, { orders: runtime.instance(namespace).orders() }),
  "POST /orders/:id/transition": ({ params, body, namespace }) => {
    if (!isRecord(body) || typeof body.to !== "string" || !body.to.trim()) {
      return adminError(400, 'expected {"to": "<workflow status>", "tracking_id"?}')
    }
    const order = runtime.instance(namespace).transition(params.id as string, {
      to: body.to,
      ...(typeof body.tracking_id === "string" ? { tracking_id: body.tracking_id } : {}),
    })
    return order ? json(200, order) : adminError(404, `no order ${params.id}`)
  },
  "GET /patients": ({ namespace }) =>
    json(200, {
      patients: runtime
        .instance(namespace)
        .state.patients.list({ order: "oldest" })
        .map((row) => row.value),
    }),
  "POST /patients": ({ body, namespace }) => {
    const state = runtime.instance(namespace).state
    const parsed = parsePatient(body, state.nextPatientId())
    if (typeof parsed === "string") return adminError(400, parsed)
    state.patients.insert(String(parsed.patient_id), parsed)
    return json(201, parsed)
  },
  "PUT /templates": ({ body, namespace }) => {
    const rows = isRecord(body) ? body.templates : body
    if (!Array.isArray(rows)) return adminError(400, 'expected {"templates": [...]}')
    const state = runtime.instance(namespace).state
    for (const { id } of state.templates.list()) state.templates.delete(id)
    for (const row of rows as MedicationTemplate[]) {
      if (!isRecord(row) || typeof row.template_identifier !== "string") {
        return adminError(400, "every template needs template_identifier")
      }
      state.templates.insert(row.template_identifier, { ...row, controlled: row.controlled ?? 0 })
    }
    return json(200, { templates: rows.length })
  },
  "GET /settings": ({ namespace }) => json(200, runtime.instance(namespace).state.current()),
  "PUT /settings": ({ body, namespace }) => {
    if (!isRecord(body)) return adminError(400, "expected a JSON object")
    const patch = parseSettings(body)
    if (typeof patch === "string") return adminError(400, patch)
    return json(200, runtime.instance(namespace).state.update(patch))
  },
  "POST /tick": ({ namespace }) => json(200, { applied: runtime.instance(namespace).tick() }),
})

/**
 * The Pharmetika mock with Mockingbird's full service contract: `/health`, `/__admin/*`,
 * namespaces by header, by `/ns/<name>` path prefix, or by credential
 * (`PUT /__admin/credentials {"credentials": {"<PHARMETIKA_API_TOKEN>": "<namespace>"}}`),
 * clock control, fault presets, status webhooks and a request journal.
 */
export const createRuntime = (options: PharmetikaRuntimeOptions = {}): PharmetikaRuntime => {
  const { retryDelaysMs, fetch: send, ...endpoint } = options.webhooks ?? { url: "" }
  const hub = createWebhookHub({
    signer: signers.header(WEBHOOK_SECRET_HEADER),
    ...(retryDelaysMs ? { retryDelaysMs } : {}),
    ...(send ? { fetch: send } : {}),
    endpoints: options.webhooks ? [endpoint as WebhookEndpoint] : [],
  })
  const runtime = createServiceRuntime<PharmetikaAPI>({
    name: PHARMETIKA_NAMESPACE,
    document,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    credential: tokenCredential,
    presets: PHARMETIKA_PRESETS,
    webhooks: hub,
    create: ({ sqlite, namespace, publicNamespace, clock }) =>
      new PharmetikaAPI({
        sqlite,
        namespace,
        now: clock.now,
        ...(options.templates ? { templates: options.templates } : {}),
        ...(options.clinics ? { clinics: options.clinics } : {}),
        ...(options.patients ? { patients: options.patients } : {}),
        ...(options.settings ? { settings: options.settings } : {}),
        onWebhook: (event) =>
          hub.publish({
            namespace: publicNamespace,
            type: "medication_order.status_updated",
            body: event.body,
            id: `${event.orderId}:${clock.now()}:${event.status}`,
          }),
      }),
    describe: () => ({ webhooks: hub.endpoints("default").length > 0 ? "on" : "off" }),
    admin: adminRoutes,
  })
  let timer: ReturnType<typeof setInterval> | undefined
  if (options.tickMs !== undefined && options.tickMs > 0) {
    timer = setInterval(() => {
      for (const name of runtime.namespaces()) runtime.instance(name).tick()
    }, options.tickMs)
    ;(timer as { unref?: () => void }).unref?.()
  }
  return Object.assign(runtime, {
    webhooks: hub,
    stop: () => {
      if (timer !== undefined) clearInterval(timer)
    },
  })
}
