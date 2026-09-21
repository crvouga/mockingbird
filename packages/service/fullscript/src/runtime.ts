import {
  type AdminRoutes,
  type Clock,
  createRuntime as createServiceRuntime,
  createWebhookHub,
  type FaultPreset,
  HttpError,
  type RequestLog,
  type ServiceRuntime,
  signers,
  type WebhookEndpoint,
  type WebhookHub,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { document } from "./generated/openapi.js"
import {
  envelope,
  FULLSCRIPT_NAMESPACE,
  FullscriptAPI,
  type SeedOrder,
  tokenCredential,
} from "./index.js"
import { isLabOrderState, type Settings } from "./state.js"

/** The header our receiver verifies: `t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>." + body)>`. */
export const SIGNATURE_HEADER = "Fullscript-Signature"

const API = "/api/"

/**
 * Every named Fullscript misbehaviour our EMR integration branches on, switched on with
 * `POST /__admin/faults {"preset": "<name>"}` (add `count` to limit it).
 */
export const FULLSCRIPT_PRESETS: Record<string, FaultPreset> = {
  token_expired: {
    description:
      "API calls answer 401 token_expired before the token's 2 h (our token service refreshes)",
    rules: [
      { pathPrefix: "/api/clinic", effect: "token_expired" },
      { pathPrefix: "/api/events", effect: "token_expired" },
    ],
  },
  invalid_grant: {
    description:
      "The refresh_token grant answers 400 invalid_grant (the practitioner must reconnect)",
    rules: [{ operationId: "OAuthToken", effect: "invalid_grant" }],
  },
  rate_limited: {
    description: "API calls answer 429 rate_limited",
    rules: [
      {
        pathPrefix: API,
        status: 429,
        body: { errors: [{ code: "rate_limited", message: "Too many requests" }] },
      },
    ],
  },
  server_error: {
    description: "API calls answer 500",
    rules: [
      {
        pathPrefix: API,
        status: 500,
        body: { errors: [{ code: "internal_server_error", message: "Something went wrong" }] },
      },
    ],
  },
  events_schema_drift: {
    description:
      "The lab-order events list answers an unexpected event type (our zod literal rejects it)",
    rules: [{ operationId: "ListLabOrderEvents", effect: "events_schema_drift" }],
  },
  pdf_not_pdf: {
    description: "Result PDF URLs answer 200 text/html (our downloader rejects the content type)",
    rules: [
      {
        operationId: "GetResultPdf",
        status: 200,
        body: "<html>Sign in</html>",
        headers: { "content-type": "text/html" },
      },
    ],
  },
  pdf_redirect: {
    description: "Result PDF URLs answer a 302 (our downloader refuses redirects)",
    rules: [
      {
        operationId: "GetResultPdf",
        status: 302,
        body: "",
        headers: { location: "https://login.fullscript.com/" },
      },
    ],
  },
  pdf_expired: {
    description: "Result PDF URLs answer 403 as if expired",
    rules: [
      {
        operationId: "GetResultPdf",
        status: 403,
        body: "Request has expired",
        headers: { "content-type": "text/plain" },
      },
    ],
  },
  connection_drop: {
    description: "The connection drops before any answer (fetch rejects)",
    rules: [{ pathPrefix: API, drop: true }],
  },
  slow: {
    description: "API calls answer after 12 s (past our client's 10 s timeout)",
    rules: [{ pathPrefix: API, latencyMs: 12_000 }],
  },
  webhook_duplicate: {
    description: "The next webhook is delivered twice",
    webhook: { mode: "duplicate" },
  },
  webhook_reorder: {
    description: "The next two webhooks arrive swapped",
    webhook: { mode: "reorder" },
  },
  webhook_drop: { description: "The next webhook is never delivered", webhook: { mode: "drop" } },
}

export type FullscriptRuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  seed?: number | string
  adminKey?: string
  onLog?: (entry: RequestLog) => void
  settings?: Partial<Settings>
  orders?: readonly SeedOrder[]
  /**
   * Where webhooks go (`POST /v1/fullscript/webhooks`), signed with `secret` (the app's
   * FULLSCRIPT_WEBHOOK_SECRET). With `challenge` (FULLSCRIPT_WEBHOOK_CHALLENGE_KEY), a delivery
   * counts only when the receiver echoes `{challenge}`, as Fullscript requires.
   */
  webhooks?: Omit<WebhookEndpoint, "id"> & {
    challenge?: string
    retryDelaysMs?: readonly number[]
    fetch?: (request: Request) => Promise<Response>
  }
}

export type FullscriptRuntime = ServiceRuntime<FullscriptAPI> & { readonly webhooks: WebhookHub }

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const adminError = (status: number, message: string) =>
  json(status, { error: { type: "mockingbird_admin", message } })
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Whether a receiver's answer echoes the challenge key (`{"challenge": "<key>"}`). */
const echoes = async (response: Response, challenge: string) => {
  try {
    const body = (await response.clone().json()) as { challenge?: unknown }
    return body.challenge === challenge
  } catch {
    return false
  }
}

const adminRoutes =
  (send: (request: Request) => Promise<Response>, challenge: string | undefined) =>
  (runtime: ServiceRuntime<FullscriptAPI>): AdminRoutes => ({
    "POST /oauth/codes": ({ body, namespace }) => {
      const input = isRecord(body) ? body : {}
      const api = runtime.instance(namespace)
      const practitionerId =
        typeof input.practitionerId === "string" ? input.practitionerId : "prac_mock_1"
      if (!api.state.practitioners.get(practitionerId))
        return adminError(404, `no practitioner ${practitionerId}`)
      const code = api.issueCode(
        practitionerId,
        typeof input.clientId === "string" ? input.clientId : "any",
        typeof input.redirectUri === "string" ? input.redirectUri : null,
      )
      return json(201, { code })
    },
    "POST /practitioners": ({ body, namespace }) => {
      if (!isRecord(body) || typeof body.id !== "string" || typeof body.clinicId !== "string") {
        return adminError(
          400,
          'expected {"id", "clinicId", "type"?: "Practitioner"|"Staff", "clinicName"?}',
        )
      }
      const api = runtime.instance(namespace)
      if (!api.state.clinics.get(body.clinicId)) {
        api.state.clinics.insert(body.clinicId, {
          id: body.clinicId,
          name: typeof body.clinicName === "string" ? body.clinicName : body.clinicId,
          created_at: new Date(runtime.clock.now()).toISOString(),
        })
      }
      const practitioner = {
        id: body.id,
        clinicId: body.clinicId,
        type: body.type === "Staff" ? ("Staff" as const) : ("Practitioner" as const),
      }
      api.state.practitioners.insert(practitioner.id, practitioner)
      return json(201, practitioner)
    },
    "GET /lab-orders": ({ namespace }) =>
      json(200, { orders: runtime.instance(namespace).labOrders() }),
    "POST /lab-orders": ({ body, namespace }) => {
      if (!isRecord(body) || typeof body.patientId !== "string") {
        return adminError(
          400,
          'expected {"patientId", "id"?, "clinicId"?, "treatmentPlanId"?, "name"?, "collectionMethod"?, "tests"?: [names]}',
        )
      }
      const text = (key: string) =>
        typeof body[key] === "string" ? { [key]: body[key] as string } : {}
      const order = runtime.instance(namespace).createOrder({
        patientId: body.patientId,
        ...text("id"),
        ...text("clinicId"),
        ...text("treatmentPlanId"),
        ...text("name"),
        ...text("collectionMethod"),
        ...(Array.isArray(body.tests) ? { tests: body.tests.map(String) } : {}),
      })
      return json(201, order)
    },
    "POST /lab-orders/:id/transition": ({ params, body, namespace }) => {
      if (!isRecord(body) || !isLabOrderState(body.to)) {
        return adminError(
          400,
          'expected {"to": "<purchased|schedule_appointment|upcoming_appointment|processing|partial_results|results_ready|interpretation_shared|results_amended>"}',
        )
      }
      try {
        return json(200, runtime.instance(namespace).transition(params.id as string, body.to))
      } catch (error) {
        if (error instanceof HttpError) return error.toResponse()
        throw error
      }
    },
    "GET /events": ({ namespace }) =>
      json(200, { events: runtime.instance(namespace).eventsList() }),
    "POST /webhooks/verify": async ({ namespace }) => {
      const endpoints = runtime.webhooks?.endpoints(namespace) ?? []
      const results = await Promise.all(
        endpoints.map(async (endpoint) => {
          try {
            const response = await send(
              new Request(endpoint.url, {
                method: "POST",
                headers: { "content-type": "application/json" },
              }),
            )
            return {
              url: endpoint.url,
              status: response.status,
              challengeEchoed: challenge ? await echoes(response, challenge) : null,
            }
          } catch (error) {
            return {
              url: endpoint.url,
              status: null,
              error: error instanceof Error ? error.message : String(error),
            }
          }
        }),
      )
      return json(200, { endpoints: results })
    },
    "GET /settings": ({ namespace }) => json(200, runtime.instance(namespace).state.current()),
    "PUT /settings": ({ body, namespace }) => {
      if (!isRecord(body)) return adminError(400, "expected a JSON object")
      const patch: Partial<Settings> = {}
      for (const key of ["accessTokenTtlSeconds", "codeTtlSeconds", "pdfUrlTtlSeconds"] as const) {
        if (body[key] !== undefined) {
          if (typeof body[key] !== "number") return adminError(400, `${key}: number`)
          patch[key] = body[key] as number
        }
      }
      if (body.resultsBaseUrl !== undefined) {
        if (body.resultsBaseUrl !== null && typeof body.resultsBaseUrl !== "string")
          return adminError(400, "resultsBaseUrl: string | null")
        patch.resultsBaseUrl = body.resultsBaseUrl as string | null
      }
      if (body.clients !== undefined) {
        if (!Array.isArray(body.clients))
          return adminError(400, "clients: [{clientId, clientSecret}]")
        patch.clients = body.clients
          .filter(isRecord)
          .map((c) => ({ clientId: String(c.clientId), clientSecret: String(c.clientSecret) }))
      }
      return json(200, runtime.instance(namespace).state.update(patch))
    },
  })

/**
 * The Fullscript mock with Mockingbird's full service contract: `/health`, `/__admin/*`,
 * namespaces by header, by `/ns/<name>` path prefix on FULLSCRIPT_API_URL, or by OAuth client
 * (for API calls), clock control, fault presets, signed webhooks and a request journal.
 */
export const createRuntime = (options: FullscriptRuntimeOptions = {}): FullscriptRuntime => {
  const { retryDelaysMs, fetch: rawSend, challenge, ...endpoint } = options.webhooks ?? { url: "" }
  const send = rawSend ?? ((request: Request) => fetch(request))
  const hub = createWebhookHub({
    signer: signers.timestamped(SIGNATURE_HEADER),
    ...(retryDelaysMs ? { retryDelaysMs } : {}),
    // Fullscript counts a delivery as acknowledged only when the receiver echoes the
    // challenge key; anything else is retried (recorded as a 502).
    fetch: async (request) => {
      const response = await send(request)
      if (!challenge || !response.ok || (await echoes(response, challenge))) return response
      return new Response(null, { status: 502, statusText: "challenge not echoed" })
    },
    endpoints: options.webhooks ? [endpoint as WebhookEndpoint] : [],
  })
  const runtime = createServiceRuntime<FullscriptAPI>({
    name: FULLSCRIPT_NAMESPACE,
    document,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    credential: tokenCredential,
    presets: FULLSCRIPT_PRESETS,
    webhooks: hub,
    create: ({ sqlite, namespace, publicNamespace, clock }) =>
      new FullscriptAPI({
        sqlite,
        namespace,
        publicNamespace,
        now: clock.now,
        ...(options.settings ? { settings: options.settings } : {}),
        ...(options.orders ? { orders: options.orders } : {}),
        onEvent: (event) =>
          hub.publish({
            namespace: publicNamespace,
            type: event.type,
            id: event.id,
            body: envelope(event),
          }),
      }),
    describe: () => ({ webhooks: hub.endpoints("default").length > 0 ? "on" : "off" }),
    admin: adminRoutes(send, challenge),
  })
  return Object.assign(runtime, { webhooks: hub })
}
