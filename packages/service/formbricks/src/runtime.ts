import {
  type AdminRoutes,
  type Clock,
  createRuntime as createServiceRuntime,
  createWebhookHub,
  type FaultPreset,
  type RequestLog,
  type ServiceRuntime,
  signers,
  signSvix,
  type WebhookEndpoint,
  type WebhookHub,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { document } from "./generated/openapi.js"
import { FORMBRICKS_NAMESPACE, FormbricksAPI } from "./index.js"
import type { Settings, Survey } from "./state.js"

/** Where our backend receives the webhook (`onboarding-tasks.controller.ts`; `?token=` checked). */
export const WEBHOOK_PATH = "/onboarding-tasks/formbricks-webhook"

const error = (code: string, message: string) => ({ code, message, details: {} })

/**
 * Every named Formbricks misbehaviour our consumers branch on, switched on with
 * `POST /__admin/faults {"preset": "<name>"}` (add `count` to limit it).
 */
export const FORMBRICKS_PRESETS: Record<string, FaultPreset> = {
  rate_limited: {
    description: "Response creation answers 429 (the member app retries 3 times with backoff)",
    rules: [
      {
        operationId: "CreateClientResponse",
        status: 429,
        body: error("too_many_requests", "Too many requests, please try again later"),
      },
    ],
  },
  server_error: {
    description: "Response creation answers 500 (the backend maps it to 502)",
    rules: [
      {
        operationId: "CreateClientResponse",
        status: 500,
        body: error("internal_server_error", "Internal server error"),
      },
    ],
  },
  missing_response_id: {
    description:
      "Response creation stores the response but answers without an id (502 / 503 in our backend)",
    rules: [{ operationId: "CreateClientResponse", effect: "missing_response_id" }],
  },
  environment_unavailable: {
    description: "The environment state answers 500 (the member app cannot load surveys)",
    rules: [
      {
        operationId: "GetEnvironmentState",
        status: 500,
        body: error("internal_server_error", "Internal server error"),
      },
    ],
  },
  data_as_string: {
    description: "Management reads return each response's data as a JSON string",
    rules: [
      { operationId: "ListResponses", effect: "data_as_string" },
      { operationId: "GetResponse", effect: "data_as_string" },
    ],
  },
  management_unauthorized: {
    description: "Management calls answer 401 not_authenticated (a revoked API key)",
    rules: [
      {
        pathPrefix: "/api/v1/management",
        status: 401,
        body: {
          code: "not_authenticated",
          message: "Not authenticated",
          details: { "x-Api-Key": "Header not provided or API Key invalid" },
        },
      },
    ],
  },
  connection_drop: {
    description: "Response creation drops the connection (our 30 s backend timeout path)",
    rules: [{ operationId: "CreateClientResponse", drop: true }],
  },
  duplicate: {
    description: "The next webhook is delivered twice (our receiver does not dedupe)",
    webhook: { mode: "duplicate" },
  },
  webhook_drop: {
    description: "The next webhook is never delivered",
    webhook: { mode: "drop" },
  },
  webhook_reorder: {
    description: "The next two webhooks arrive swapped",
    webhook: { mode: "reorder" },
  },
}

type WebhookHubOptionsSubset = {
  retryDelaysMs?: readonly number[]
  fetch?: (request: Request) => Promise<Response>
}

export type FormbricksRuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  seed?: number | string
  adminKey?: string
  onLog?: (entry: RequestLog) => void
  surveys?: readonly Survey[]
  settings?: Partial<Settings>
  /**
   * Where webhooks go: `url` carries our `?token=<FORMBRICKS_WEBHOOK_SECRET>`; `secret` (a
   * `whsec_…` Standard Webhooks key) signs `webhook-signature`; `events` defaults to
   * `["responseFinished"]` (add `"responseCreated"` for both).
   */
  webhooks?: Omit<WebhookEndpoint, "id"> & WebhookHubOptionsSubset
}

export type FormbricksRuntime = ServiceRuntime<FormbricksAPI> & { readonly webhooks: WebhookHub }

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const adminError = (status: number, message: string) =>
  json(status, { error: { type: "mockingbird_admin", message } })
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const adminRoutes = (runtime: ServiceRuntime<FormbricksAPI>): AdminRoutes => ({
  "GET /responses": ({ url, namespace }) => {
    const surveyId = url.searchParams.get("surveyId")
    return json(200, {
      responses: runtime
        .instance(namespace)
        .responses()
        .filter((r) => surveyId === null || r.surveyId === surveyId),
    })
  },
  "GET /surveys": ({ namespace }) =>
    json(200, { surveys: runtime.instance(namespace).state.allSurveys() }),
  "PUT /surveys": ({ body, namespace }) => {
    const list = Array.isArray(body) ? body : isRecord(body) ? body.surveys : undefined
    if (!Array.isArray(list)) return adminError(400, "expected [survey] or {surveys: [survey]}")
    const state = runtime.instance(namespace).state
    for (const [index, survey] of list.entries()) {
      if (!isRecord(survey) || typeof survey.id !== "string" || typeof survey.name !== "string") {
        return adminError(400, `surveys[${index}]: id and name are required`)
      }
    }
    for (const survey of list as Survey[]) {
      state.surveys.insert(survey.id, {
        ...survey,
        type: survey.type ?? "app",
        status: survey.status ?? "inProgress",
        environmentId: survey.environmentId ?? null,
      })
    }
    return json(200, { surveys: state.allSurveys().map((s) => s.id) })
  },
  "GET /settings": ({ namespace }) => json(200, runtime.instance(namespace).state.current()),
  "PUT /settings": ({ body, namespace }) => {
    if (!isRecord(body)) return adminError(400, "expected a JSON object")
    const patch: Partial<Settings> = {}
    if (Array.isArray(body.environments)) patch.environments = body.environments.map(String)
    if (Array.isArray(body.apiKeys)) patch.apiKeys = body.apiKeys.map(String)
    if (typeof body.webhookId === "string") patch.webhookId = body.webhookId
    if (typeof body.contactsEnabled === "boolean") patch.contactsEnabled = body.contactsEnabled
    return json(200, runtime.instance(namespace).state.update(patch))
  },
})

/**
 * The namespace carrier for the client API is the environment id in the path (the member app's
 * fetch cannot add headers); the management API's is its `x-api-key`.
 */
export const formbricksCredential = (request: Request): string | undefined => {
  const key = request.headers.get("x-api-key")?.trim()
  if (key) return key
  return /\/api\/v[12]\/client\/([^/]+)\//.exec(new URL(request.url).pathname)?.[1]
}

/**
 * The Formbricks mock with Mockingbird's full service contract: `/health`, `/__admin/*`,
 * namespaces by header, by `/ns/<name>` prefix on `FORMBRICKS_APP_URL`, or by environment id /
 * API key (`PUT /__admin/credentials {"credentials": {"<env id or key>": "<namespace>"}}`),
 * clock control, fault presets, and Standard-Webhooks-signed `responseFinished` webhooks.
 */
export const createRuntime = (options: FormbricksRuntimeOptions = {}): FormbricksRuntime => {
  const { retryDelaysMs, fetch: send, ...endpoint } = options.webhooks ?? { url: "" }
  const hub = createWebhookHub({
    // Formbricks always sends webhook-id and webhook-timestamp; webhook-signature only when
    // the webhook has a secret (Standard Webhooks, `v1,<base64 HMAC>` over "id.ts.body").
    signer: signers.custom(async ({ messageId, timestampSeconds, body, secret }) => ({
      "webhook-id": messageId,
      "webhook-timestamp": String(timestampSeconds),
      ...(secret?.startsWith("whsec_")
        ? { "webhook-signature": await signSvix(secret, messageId, timestampSeconds, body) }
        : {}),
    })),
    ...(retryDelaysMs ? { retryDelaysMs } : {}),
    ...(send ? { fetch: send } : {}),
    endpoints: options.webhooks
      ? [{ events: ["responseFinished"], ...endpoint } as WebhookEndpoint]
      : [],
  })
  const runtime = createServiceRuntime<FormbricksAPI>({
    name: FORMBRICKS_NAMESPACE,
    document,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    credential: formbricksCredential,
    presets: FORMBRICKS_PRESETS,
    webhooks: hub,
    create: ({ sqlite, namespace, publicNamespace, clock }) =>
      new FormbricksAPI({
        sqlite,
        namespace,
        now: clock.now,
        ...(options.surveys ? { surveys: options.surveys } : {}),
        ...(options.settings ? { settings: options.settings } : {}),
        // Formbricks calls only the webhooks whose triggers include the event: publish nothing
        // (so no webhook fault is spent) when no endpoint subscribes to it.
        onWebhook: (event) => {
          const subscribed = hub
            .endpoints(publicNamespace)
            .some((e) => !e.events || e.events.includes("*") || e.events.includes(event.event))
          if (subscribed)
            hub.publish({ namespace: publicNamespace, type: event.event, body: event })
        },
      }),
    describe: () => ({ webhooks: hub.endpoints("default").length > 0 ? "on" : "off" }),
    admin: adminRoutes,
  })
  return Object.assign(runtime, { webhooks: hub })
}
