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

/** A conventional path for the consumer app's webhook receiver (examples and the CLI help use it). */
export const WEBHOOK_PATH = "/webhooks/formbricks"

const error = (code: string, message: string) => ({ code, message, details: {} })

/**
 * Every named Formbricks misbehaviour a consumer app may branch on, switched on with
 * `POST /__admin/faults {"preset": "<name>"}` (add `count` to limit it).
 */
export const FORMBRICKS_PRESETS: Record<string, FaultPreset> = {
  rate_limited: {
    description: "Response creation answers 429 too_many_requests (the client rate limit)",
    rules: [
      {
        operationId: "CreateClientResponse",
        status: 429,
        body: error("too_many_requests", "Too many requests, please try again later"),
      },
    ],
  },
  server_error: {
    description: "Response creation answers 500 internal_server_error",
    rules: [
      {
        operationId: "CreateClientResponse",
        status: 500,
        body: error("internal_server_error", "Internal server error"),
      },
    ],
  },
  missing_response_id: {
    description: "Response creation stores the response but answers without an id",
    rules: [{ operationId: "CreateClientResponse", effect: "missing_response_id" }],
  },
  environment_unavailable: {
    description: "The environment state answers 500 (the SDK cannot load surveys)",
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
    description: "Response creation drops the connection (a client timeout path)",
    rules: [{ operationId: "CreateClientResponse", drop: true }],
  },
  duplicate: {
    description: "The next webhook is delivered twice (receivers should dedupe on webhook-id)",
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
   * Where webhooks go: `url` (any query, e.g. a `?token=` your receiver checks, is kept); `secret`
   * (a `whsec_…` Standard Webhooks key) signs `webhook-signature`; `events` defaults to
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
    for (const survey of list as (Survey & { environmentId?: string })[]) {
      const { environmentId, ...rest } = survey
      const owner = survey.workspaceId ?? environmentId
      state.surveys.insert(survey.id, {
        ...rest,
        type: survey.type ?? "app",
        status: survey.status ?? "inProgress",
        workspaceId: owner ? (state.resolveWorkspace(owner) ?? owner) : null,
      })
    }
    return json(200, { surveys: state.allSurveys().map((s) => s.id) })
  },
  "GET /contacts": ({ namespace }) =>
    json(200, {
      contacts: runtime
        .instance(namespace)
        .state.contacts.list({ order: "oldest" })
        .map((row) => row.value),
    }),
  "PUT /contacts": ({ body, namespace }) => {
    const list = Array.isArray(body) ? body : isRecord(body) ? body.contacts : undefined
    if (!Array.isArray(list)) return adminError(400, "expected [contact] or {contacts: [contact]}")
    const state = runtime.instance(namespace).state
    for (const [index, contact] of list.entries()) {
      if (!isRecord(contact) || typeof contact.id !== "string") {
        return adminError(400, `contacts[${index}]: id is required`)
      }
    }
    for (const contact of list as Record<string, unknown>[]) {
      const attributes = isRecord(contact.attributes)
        ? Object.fromEntries(Object.entries(contact.attributes).map(([k, v]) => [k, String(v)]))
        : {}
      if (typeof contact.userId === "string") attributes.userId = contact.userId
      state.contacts.insert(contact.id as string, {
        id: contact.id as string,
        workspaceId: typeof contact.workspaceId === "string" ? contact.workspaceId : null,
        attributes,
      })
    }
    return json(200, { contacts: state.contacts.list({ order: "oldest" }).map((r) => r.value.id) })
  },
  "GET /settings": ({ namespace }) => json(200, runtime.instance(namespace).state.current()),
  "PUT /settings": ({ body, namespace }) => {
    if (!isRecord(body)) return adminError(400, "expected a JSON object")
    const patch: Partial<Settings> = {}
    if (Array.isArray(body.workspaces)) patch.workspaces = body.workspaces.map(String)
    if (isRecord(body.legacyEnvironmentIds)) {
      patch.legacyEnvironmentIds = Object.fromEntries(
        Object.entries(body.legacyEnvironmentIds).map(([k, v]) => [k, String(v)]),
      )
    }
    if (Array.isArray(body.apiKeys)) patch.apiKeys = body.apiKeys.map(String)
    if (typeof body.webhookId === "string") patch.webhookId = body.webhookId
    if (typeof body.contactsEnabled === "boolean") patch.contactsEnabled = body.contactsEnabled
    return json(200, runtime.instance(namespace).state.update(patch))
  },
})

/**
 * The namespace carrier for the client API is the workspace (or legacy environment) id in the
 * path (the SDK cannot add headers); the management API's is its `x-api-key`.
 */
export const formbricksCredential = (request: Request): string | undefined => {
  const key = request.headers.get("x-api-key")?.trim()
  if (key) return key
  return /\/api\/v[12]\/client\/([^/]+)\//.exec(new URL(request.url).pathname)?.[1]
}

/**
 * The Formbricks mock with Mockingbird's full service contract: `/health`, `/__admin/*`,
 * namespaces by header, by `/ns/<name>` prefix on the app URL, or by workspace id / API key
 * (`PUT /__admin/credentials {"credentials": {"<workspace id or key>": "<namespace>"}}`),
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
