import {
  type AdminRoutes,
  type Clock,
  createRuntime as createServiceRuntime,
  type FaultPreset,
  type FaultRule,
  type RequestLog,
  type ServiceRuntime,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { document, supportedOperationIds } from "./generated/openapi.js"
import { type PatientInput, tokenCredential, VPI_NAMESPACE, VpiAPI } from "./index.js"
import type { Account, Seed, Settings, StatusEnvelope } from "./state.js"
import type { PrescriptionList } from "./statuses.js"

const AUTHORIZED_OPERATIONS = supportedOperationIds.filter((id) => id !== "Authenticate")

/** One canned rule per authorized operation, so a `count` applies to each call site separately. */
const everyAuthorized = (rule: Omit<FaultRule, "id" | "operationId">): Omit<FaultRule, "id">[] =>
  AUTHORIZED_OPERATIONS.map((operationId) => ({ operationId, ...rule }))

/**
 * Every named VPI misbehaviour our consumer branches on, switched on with
 * `POST /__admin/faults {"preset": "<name>"}` (add `count` to limit it).
 */
export const VPI_PRESETS: Record<string, FaultPreset> = {
  token_expired: {
    description:
      'Authorized calls answer 401 "jwt expired" before exp; with count 1 our client re-authenticates once and the retry succeeds',
    rules: everyAuthorized({ status: 401, body: { message: "jwt expired" } }),
  },
  unauthorized_twice: {
    description:
      "Authorized calls answer 401 twice: the single re-auth retry fails too (VpiApiHttpError 401)",
    rules: everyAuthorized({ status: 401, body: { message: "Unauthorized" }, count: 2 }),
  },
  auth_rejected: {
    description: "POST /accounts/authenticate answers 401 (bad credentials)",
    rules: [
      {
        operationId: "Authenticate",
        status: 401,
        body: { message: "Email or password is incorrect" },
      },
    ],
  },
  server_error: {
    description: "Every call answers 500",
    rules: [{ status: 500, body: { message: "Internal Server Error" } }],
  },
  duplicate_prescription: {
    description: "checkProviderSignatureNeededDuplicate reports isDuplicate: true",
    rules: [
      { operationId: "CheckProviderSignatureNeededDuplicate", effect: "duplicate_prescription" },
    ],
  },
  save_ambiguous_409: {
    description:
      "saveNewPrescription saves the draft, then answers 409: the draft state is unknown (needs_review)",
    rules: [{ operationId: "SaveNewPrescription", effect: "save_ambiguous_409" }],
  },
  save_rate_limited: {
    description: "saveNewPrescription answers 429 without saving (ambiguous: needs_review)",
    rules: [
      { operationId: "SaveNewPrescription", status: 429, body: { message: "Too Many Requests" } },
    ],
  },
  save_400: {
    description:
      "saveNewPrescription answers 400 without saving (definitive: retry via the browser agent)",
    rules: [{ operationId: "SaveNewPrescription", status: 400, body: { message: "Bad Request" } }],
  },
  response_drift: {
    description:
      "Taxonomy answers categories as a string and product details unitPrice as a string: our zod parse fails closed",
    rules: [
      { operationId: "GetAllFamiliesAndCategories", effect: "response_drift" },
      { operationId: "GetProductDetailsByProductId", effect: "response_drift" },
    ],
  },
}

export type VpiRuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  seed?: number | string
  adminKey?: string
  onLog?: (entry: RequestLog) => void
  /** Replace the seeded clinic, providers, products or patients. */
  data?: Seed
  settings?: Partial<Settings>
}

export type VpiRuntime = ServiceRuntime<VpiAPI>

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const adminError = (status: number, message: string) =>
  json(status, { error: { type: "mockingbird_admin", message } })
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const isString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0

const ENVELOPES: StatusEnvelope[] = [
  "vendor",
  "array",
  "prescriptions",
  "message",
  "message.prescriptions",
]
const LISTS: PrescriptionList[] = ["incomplete", "submitted", "archived"]

const parsePatient = (body: unknown): PatientInput | string => {
  if (!isRecord(body)) return "expected a JSON object"
  for (const key of ["firstName", "lastName", "dateOfBirth"]) {
    if (!isString(body[key])) return `${key}: non-empty string`
  }
  const addresses = body.addresses ?? []
  if (!Array.isArray(addresses)) return "addresses: [{addressLine1, city, state, zipcode}]"
  for (const a of addresses) {
    if (!isRecord(a) || !["addressLine1", "city", "state", "zipcode"].every((k) => isString(a[k])))
      return "addresses: [{addressLine1, addressLine2?, city, state, zipcode}]"
  }
  const optional = (key: string) =>
    typeof body[key] === "string" || body[key] === null ? { [key]: body[key] } : {}
  return {
    firstName: body.firstName as string,
    lastName: body.lastName as string,
    dateOfBirth: body.dateOfBirth as string,
    ...optional("id"),
    ...optional("clinicId"),
    ...optional("email"),
    ...optional("phoneNumber"),
    ...optional("cellPhone"),
    addresses: (addresses as Record<string, unknown>[]).map((a) => ({
      addressLine1: a.addressLine1 as string,
      city: a.city as string,
      state: a.state as string,
      zipcode: a.zipcode as string,
      ...(typeof a.id === "string" ? { id: a.id } : {}),
      ...(typeof a.addressLine2 === "string" || a.addressLine2 === null
        ? { addressLine2: a.addressLine2 as string | null }
        : {}),
    })),
  } as PatientInput
}

const adminRoutes = (runtime: ServiceRuntime<VpiAPI>): AdminRoutes => ({
  "GET /prescriptions": ({ namespace }) =>
    json(200, { prescriptions: runtime.instance(namespace).prescriptions() }),
  "POST /prescriptions/:id/transition": ({ params, body, namespace }) => {
    if (!isRecord(body) || !isString(body.to)) {
      return adminError(400, 'expected {"to": "<VPI status>", "trackingNumber"?, "list"?}')
    }
    if (body.list !== undefined && !LISTS.includes(body.list as PrescriptionList)) {
      return adminError(400, `list: one of ${LISTS.join(", ")}`)
    }
    const updated = runtime.instance(namespace).transition(params.id as string, {
      to: body.to,
      ...(typeof body.trackingNumber === "string" ? { trackingNumber: body.trackingNumber } : {}),
      ...(body.list !== undefined ? { list: body.list as PrescriptionList } : {}),
    })
    return updated ? json(200, updated) : adminError(404, `no prescription ${params.id}`)
  },
  "GET /patients": ({ namespace }) =>
    json(200, {
      patients: runtime
        .instance(namespace)
        .state.patients.list({ order: "oldest" })
        .map((row) => row.value),
    }),
  "POST /patients": ({ body, namespace }) => {
    const parsed = parsePatient(body)
    if (typeof parsed === "string") return adminError(400, parsed)
    return json(201, runtime.instance(namespace).addPatient(parsed))
  },
  "GET /catalog": ({ namespace }) => {
    const state = runtime.instance(namespace).state
    return json(200, {
      products: state.products.list({ order: "oldest" }).map((row) => row.value),
      providers: state.providers.list({ order: "oldest" }).map((row) => row.value),
      clinicLocations: state.locations.list({ order: "oldest" }).map((row) => row.value),
    })
  },
  "GET /settings": ({ namespace }) => json(200, runtime.instance(namespace).state.current()),
  "PUT /settings": ({ body, namespace }) => {
    if (!isRecord(body)) return adminError(400, "expected a JSON object")
    const patch: Partial<Settings> = {}
    if (body.tokenTtlSeconds !== undefined) {
      if (typeof body.tokenTtlSeconds !== "number" || body.tokenTtlSeconds <= 0)
        return adminError(400, "tokenTtlSeconds: positive number")
      patch.tokenTtlSeconds = body.tokenTtlSeconds
    }
    if (body.accounts !== undefined) {
      if (!Array.isArray(body.accounts) || !body.accounts.every(isRecord))
        return adminError(400, "accounts: [{email, password, id}]")
      patch.accounts = body.accounts.map(
        (a): Account => ({
          email: String(a.email),
          password: String(a.password),
          id: String(a.id ?? ""),
        }),
      )
    }
    if (body.statusEnvelope !== undefined) {
      if (!ENVELOPES.includes(body.statusEnvelope as StatusEnvelope))
        return adminError(400, `statusEnvelope: one of ${ENVELOPES.join(", ")}`)
      patch.statusEnvelope = body.statusEnvelope as StatusEnvelope
    }
    if (body.isProviderSignatureNeeded !== undefined) {
      if (typeof body.isProviderSignatureNeeded !== "boolean")
        return adminError(400, "isProviderSignatureNeeded: boolean")
      patch.isProviderSignatureNeeded = body.isProviderSignatureNeeded
    }
    return json(200, runtime.instance(namespace).state.update(patch))
  },
})

/**
 * The VPI mock with Mockingbird's full service contract: `/health`, `/__admin/*`, namespaces
 * by header, by `/ns/<name>` path prefix, or by login email
 * (`PUT /__admin/credentials {"credentials": {"<VPI_API_EMAIL>": "<namespace>"}}`), clock
 * control, fault presets and a request journal. VPI sends no webhooks: our client polls.
 */
export const createRuntime = (options: VpiRuntimeOptions = {}): VpiRuntime =>
  createServiceRuntime<VpiAPI>({
    name: VPI_NAMESPACE,
    document,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    credential: tokenCredential,
    presets: VPI_PRESETS,
    create: ({ sqlite, namespace, clock }) =>
      new VpiAPI({
        sqlite,
        namespace,
        now: clock.now,
        ...(options.data ? { seed: options.data } : {}),
        ...(options.settings ? { settings: options.settings } : {}),
      }),
    admin: adminRoutes,
  })
