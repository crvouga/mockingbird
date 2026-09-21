import {
  type AdminRoutes,
  type Clock,
  createRuntime as createServiceRuntime,
  type FaultPreset,
  type RequestLog,
  type ServiceRuntime,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { FullFormDto } from "./forms.js"
import { document } from "./generated/openapi.js"
import { CARETALK_NAMESPACE, CareTalkAPI, tokenCredential } from "./index.js"
import type { Settings } from "./state.js"

const API = "/externalapi/"

const AUTHENTICATED = [
  "GetForm",
  "SavePatientForm",
  "SearchForPatient",
  "ListStates",
  "InsertPatient",
  "GetFreeSlots",
  "ScheduleAppointment",
  "GetPatientAppointments",
] as const

/**
 * Every CareTalk failure our client branches on, switched on with
 * `POST /__admin/faults {"preset": "<name>"}` (add `count` to limit it).
 */
export const CARETALK_PRESETS: Record<string, FaultPreset> = {
  login_failure: {
    description: "client-login answers 500 (our client throws 'Failed to get auth token')",
    rules: [{ operationId: "ClientLogin", status: 500, body: { message: "An error occurred." } }],
  },
  invalid_credentials: {
    description: "client-login answers 401 Invalid username or password",
    rules: [
      {
        operationId: "ClientLogin",
        status: 401,
        body: { message: "Invalid username or password." },
      },
    ],
  },
  token_expired: {
    description:
      "Authenticated calls answer 401 before the cached token's hour is up (our client logs in again and retries once); count applies per operation",
    // One rule per authenticated operation, so client-login never uses up the count.
    rules: AUTHENTICATED.map((operationId) => ({ operationId, effect: "token_expired" })),
  },
  server_error: {
    description: "Every call answers 500 ProblemDetails",
    rules: [
      {
        pathPrefix: API,
        status: 500,
        body: { title: "An unexpected error occurred.", status: 500 },
      },
    ],
  },
  gateway_html: {
    description: "Every call answers a 502 HTML page (our client's JSON parse throws)",
    rules: [
      {
        pathPrefix: API,
        status: 502,
        body: "<html><body>502 Bad Gateway</body></html>",
        headers: { "content-type": "text/html" },
      },
    ],
  },
  form_not_found: {
    description: "GetForm answers an empty list",
    rules: [{ operationId: "GetForm", effect: "form_not_found" }],
  },
  patient_not_found: {
    description: "SearchForPatient answers 400 (our client reads it as 'no such patient')",
    rules: [{ operationId: "SearchForPatient", effect: "patient_not_found" }],
  },
  save_rejected: {
    description: "SavePatientForm answers 400 ProblemDetails",
    rules: [{ operationId: "SavePatientForm", effect: "save_rejected" }],
  },
  connection_drop: {
    description: "The connection drops before any answer (fetch rejects)",
    rules: [{ pathPrefix: API, drop: true }],
  },
  slow: {
    description: "Every call answers after 10 s",
    rules: [{ pathPrefix: API, latencyMs: 10_000 }],
  },
}

export type CareTalkRuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  seed?: number | string
  adminKey?: string
  onLog?: (entry: RequestLog) => void
  forms?: readonly FullFormDto[]
  settings?: Partial<Settings>
}

export type CareTalkRuntime = ServiceRuntime<CareTalkAPI>

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const adminError = (status: number, message: string) =>
  json(status, { error: { type: "mockingbird_admin", message } })
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const adminRoutes = (runtime: ServiceRuntime<CareTalkAPI>): AdminRoutes => ({
  "GET /patients": ({ namespace }) =>
    json(200, { patients: runtime.instance(namespace).patients() }),
  "POST /patients": ({ body, namespace }) => {
    if (!isRecord(body))
      return adminError(400, "expected a patient object (the Patients POST body)")
    return json(201, runtime.instance(namespace).addPatient(body))
  },
  "GET /form-submissions": ({ namespace, url }) => {
    const patientId = url.searchParams.get("patientId")
    const rounds = runtime
      .instance(namespace)
      .rounds()
      .filter((r) => patientId === null || String(r.patientId) === patientId)
    return json(200, { submissions: rounds })
  },
  "GET /forms": ({ namespace }) =>
    json(200, {
      forms: runtime
        .instance(namespace)
        .state.forms.list({ order: "oldest" })
        .map((r) => r.value),
    }),
  "PUT /forms/:id": ({ params, body, namespace }) => {
    if (!isRecord(body) || typeof body.name !== "string" || !Array.isArray(body.groups)) {
      return adminError(400, "expected a fullFormDto {id, name, slug, groups, …}")
    }
    const form = { ...body, id: Number(params.id) } as unknown as FullFormDto
    return json(200, runtime.instance(namespace).upsertForm(form))
  },
  "POST /appointments/:id/status": ({ params, body, namespace }) => {
    if (!isRecord(body) || typeof body.appointmentStatus !== "number") {
      return adminError(400, 'expected {"appointmentStatus": <number>}')
    }
    const appointment = runtime
      .instance(namespace)
      .setAppointmentStatus(Number(params.id), body.appointmentStatus)
    return appointment ? json(200, appointment) : adminError(404, `no appointment ${params.id}`)
  },
  "GET /settings": ({ namespace }) => json(200, runtime.instance(namespace).state.current()),
  "PUT /settings": ({ body, namespace }) => {
    if (!isRecord(body)) return adminError(400, "expected a JSON object")
    const patch: Partial<Settings> = {}
    if (body.tokenTtlSeconds !== undefined) {
      if (typeof body.tokenTtlSeconds !== "number")
        return adminError(400, "tokenTtlSeconds: number")
      patch.tokenTtlSeconds = body.tokenTtlSeconds
    }
    if (body.users !== undefined) {
      if (!Array.isArray(body.users)) return adminError(400, "users: [{userName, password}]")
      patch.users = body.users.filter(isRecord).map((u) => ({
        userName: String(u.userName),
        password: String(u.password),
      }))
    }
    if (body.apiKeys !== undefined) {
      if (!Array.isArray(body.apiKeys)) return adminError(400, "apiKeys: string[]")
      patch.apiKeys = body.apiKeys.map(String)
    }
    if (body.programId !== undefined) {
      if (typeof body.programId !== "number") return adminError(400, "programId: number")
      patch.programId = body.programId
    }
    return json(200, runtime.instance(namespace).state.update(patch))
  },
})

/**
 * The CareTalk mock with Mockingbird's full service contract: `/health`, `/__admin/*`,
 * namespaces by header, by `/ns/<name>` path prefix, or by credential (the API user a token
 * was issued to, or a static API key), clock control, fault presets and a request journal.
 */
export const createRuntime = (options: CareTalkRuntimeOptions = {}): CareTalkRuntime =>
  createServiceRuntime<CareTalkAPI>({
    name: CARETALK_NAMESPACE,
    document,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    credential: tokenCredential,
    presets: CARETALK_PRESETS,
    create: ({ sqlite, namespace, clock }) =>
      new CareTalkAPI({
        sqlite,
        namespace,
        now: clock.now,
        ...(options.forms ? { forms: options.forms } : {}),
        ...(options.settings ? { settings: options.settings } : {}),
      }),
    admin: adminRoutes,
  })
