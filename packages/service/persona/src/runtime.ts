import {
  type AdminRoutes,
  bearerToken,
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
import { document } from "./generated/openapi.js"
import {
  INQUIRY_ACTIONS,
  type InquiryAction,
  inquiryResource,
  PERSONA_NAMESPACE,
  PersonaAPI,
} from "./index.js"
import type { Settings } from "./state.js"

/** The header our receiver verifies: `t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`. */
export const PERSONA_SIGNATURE_HEADER = "Persona-Signature"

const jsonApiError = (status: number, title: string, detail: string) => ({
  status,
  body: { errors: [{ title, detail, status: String(status) }] },
})

/**
 * Every named Persona misbehaviour our consumer branches on, switched on with
 * `POST /__admin/faults {"preset": "<name>"}` (add `count` to limit it).
 */
export const PERSONA_PRESETS: Record<string, FaultPreset> = {
  list_fails: {
    description:
      "GET /inquiries answers 500: our reusable-inquiry lookup fails open and creates a new one",
    rules: [
      {
        operationId: "ListInquiries",
        ...jsonApiError(500, "Internal Server Error", "Something went wrong"),
      },
    ],
  },
  create_fails: {
    description: "POST /inquiries answers 500 (our createInquiry throws with the composed message)",
    rules: [
      {
        operationId: "CreateInquiry",
        ...jsonApiError(500, "Internal Server Error", "Something went wrong"),
      },
    ],
  },
  not_found: {
    description: "GET /inquiries/{id} answers 404 even for a real inquiry",
    rules: [{ operationId: "GetInquiry", effect: "not_found" }],
  },
  unauthorized: {
    description: "Every API call answers 401 (a revoked PERSONA_API_KEY)",
    rules: [
      {
        pathPrefix: "/inquiries",
        ...jsonApiError(401, "Must be authenticated to access this endpoint", "Invalid API key"),
      },
    ],
  },
  rate_limited: {
    description: "Every API call answers 429 Too Many Requests",
    rules: [
      {
        pathPrefix: "/inquiries",
        ...jsonApiError(429, "Too Many Requests", "Rate limit exceeded"),
        headers: { "retry-after": "1" },
      },
    ],
  },
  server_error: {
    description: "Every API call answers 500",
    rules: [
      {
        pathPrefix: "/inquiries",
        ...jsonApiError(500, "Internal Server Error", "Something went wrong"),
      },
    ],
  },
  slow: {
    description: "Every API call takes 3 s",
    rules: [{ pathPrefix: "/inquiries", latencyMs: 3_000 }],
  },
  webhook_duplicate: {
    description: "The next webhook is delivered twice",
    webhook: { mode: "duplicate" },
  },
  webhook_reorder: {
    description: "The next two webhooks arrive swapped",
    webhook: { mode: "reorder" },
  },
  webhook_drop: {
    description: "The next webhook is never delivered",
    webhook: { mode: "drop" },
  },
}

/**
 * How the next webhooks are signed wrong (`POST /__admin/signature-faults`): `mismatch` keeps
 * the length (our receiver answers 401), `short` truncates the hex (our receiver's
 * `timingSafeEqual` throws on the length mismatch, a 500).
 */
export type SignatureFault = "mismatch" | "short"

export type PersonaRuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  seed?: number | string
  adminKey?: string
  onLog?: (entry: RequestLog) => void
  settings?: Partial<Settings>
  /** Where events go (`POST /v1/identify-verification/webhook`), signed with `secret`. */
  webhooks?: Omit<WebhookEndpoint, "id"> & {
    retryDelaysMs?: readonly number[]
    fetch?: (request: Request) => Promise<Response>
  }
}

export type PersonaRuntime = ServiceRuntime<PersonaAPI> & { readonly webhooks: WebhookHub }

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const adminError = (status: number, message: string) =>
  json(status, { error: { type: "mockingbird_admin", message } })
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const adminRoutes = (
  runtime: ServiceRuntime<PersonaAPI>,
  signatureFaults: Map<string, SignatureFault[]>,
): AdminRoutes => {
  const routes: AdminRoutes = {
    "GET /inquiries": ({ namespace }) =>
      json(200, { inquiries: runtime.instance(namespace).inquiries().map(inquiryResource) }),
    "GET /settings": ({ namespace }) => json(200, runtime.instance(namespace).state.current()),
    "PUT /settings": ({ body, namespace }) => {
      if (!isRecord(body)) return adminError(400, "expected a JSON object")
      const patch: Partial<Settings> = {}
      for (const key of ["apiKeys", "templates"] as const) {
        if (body[key] === undefined) continue
        if (!Array.isArray(body[key])) return adminError(400, `${key}: string[]`)
        patch[key] = (body[key] as unknown[]).map(String)
      }
      return json(200, runtime.instance(namespace).state.update(patch))
    },
    "POST /signature-faults": ({ body, namespace }) => {
      const mode = isRecord(body) ? body.mode : undefined
      if (mode !== "mismatch" && mode !== "short") {
        return adminError(400, 'expected {"mode": "mismatch" | "short", "count"?: n}')
      }
      const count = isRecord(body) && typeof body.count === "number" ? body.count : 1
      const queue = signatureFaults.get(namespace) ?? []
      for (let i = 0; i < Math.max(1, count); i++) queue.push(mode)
      signatureFaults.set(namespace, queue)
      return json(201, { namespace, mode, pending: queue.length })
    },
  }
  for (const action of INQUIRY_ACTIONS) {
    routes[`POST /inquiries/:id/${action}`] = ({ params, namespace }) => {
      const moved = runtime
        .instance(namespace)
        .transition(params.id as string, action as InquiryAction)
      if (typeof moved === "string") {
        return adminError(moved.startsWith("no inquiry") ? 404 : 409, moved)
      }
      return json(200, inquiryResource(moved))
    }
  }
  return routes
}

/**
 * The Persona mock with Mockingbird's full service contract: `/health`, `/__admin/*`,
 * namespaces by header, by `/ns/<name>` path prefix, or by API key
 * (`PUT /__admin/credentials {"credentials": {"<PERSONA_API_KEY>": "<namespace>"}}`), clock
 * control, fault presets, `Persona-Signature` webhooks and a request journal.
 */
export const createRuntime = (options: PersonaRuntimeOptions = {}): PersonaRuntime => {
  const { retryDelaysMs, fetch: send, ...endpoint } = options.webhooks ?? { url: "" }
  /** Signature faults queued per namespace, and the message ids they were assigned to. */
  const signatureFaults = new Map<string, SignatureFault[]>()
  const badMessages = new Map<string, SignatureFault>()
  const sign = signers.timestamped(PERSONA_SIGNATURE_HEADER)
  const hub = createWebhookHub({
    signer: signers.custom(async (input) => {
      const headers = await sign(input)
      const fault = badMessages.get(input.messageId)
      const value = headers[PERSONA_SIGNATURE_HEADER]
      if (!fault || !value) return headers
      if (fault === "short") {
        return {
          [PERSONA_SIGNATURE_HEADER]: value.replace(
            /v1=([0-9a-f]+)/,
            (_, hex: string) => `v1=${hex.slice(0, 16)}`,
          ),
        }
      }
      const wrong = await sign({ ...input, secret: `${input.secret}-wrong` })
      return { [PERSONA_SIGNATURE_HEADER]: wrong[PERSONA_SIGNATURE_HEADER] as string }
    }),
    ...(retryDelaysMs ? { retryDelaysMs } : {}),
    ...(send ? { fetch: send } : {}),
    endpoints: options.webhooks ? [endpoint as WebhookEndpoint] : [],
  })
  const runtime = createServiceRuntime<PersonaAPI>({
    name: PERSONA_NAMESPACE,
    document,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    credential: bearerToken,
    presets: PERSONA_PRESETS,
    webhooks: hub,
    create: ({ sqlite, namespace, publicNamespace, clock }) =>
      new PersonaAPI({
        sqlite,
        namespace,
        publicNamespace,
        now: clock.now,
        ...(options.settings ? { settings: options.settings } : {}),
        onWebhook: (event) => {
          const queue = signatureFaults.get(publicNamespace)
          const fault = queue?.shift()
          // Event ids repeat across namespaces (per-namespace sequences); message ids must not.
          const id = `${publicNamespace}:${event.data.id}`
          if (fault) badMessages.set(id, fault)
          hub.publish({
            namespace: publicNamespace,
            type: event.data.attributes.name,
            body: event,
            id,
          })
        },
      }),
    describe: () => ({ webhooks: hub.endpoints("default").length > 0 ? "on" : "off" }),
    admin: (rt) => adminRoutes(rt, signatureFaults),
  })
  return Object.assign(runtime, { webhooks: hub })
}
