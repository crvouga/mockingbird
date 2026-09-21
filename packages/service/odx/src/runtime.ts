import {
  type AdminRoutes,
  type Clock,
  createRuntime as createServiceRuntime,
  createWebhookHub,
  type FaultPreset,
  hmac,
  type RequestLog,
  type ServiceRuntime,
  signers,
  type WebhookHub,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { document } from "./generated/openapi.js"
import {
  apiKeyCredential,
  ODX_NAMESPACE,
  OdxAPI,
  type OdxEventType,
  type SignatureMode,
} from "./index.js"
import type { Settings } from "./state.js"

/** The header our guard (`OdxSignatureGuard`) reads. */
export const SIGNATURE_HEADER = "optimaldx-signature"

/** ODX's signature: UPPERCASE hex HMAC-SHA256 of the raw body under the webhook's signing key. */
export const signOdx = async (signingKey: string, body: string): Promise<string> =>
  (await hmac("SHA-256", signingKey, body, "hex")).toUpperCase()

const EMITTERS = ["CreatePatientTest", "UpdatePatientTest", "CreateTestResults"] as const

/**
 * Every named ODX misbehaviour our consumer branches on, switched on with
 * `POST /__admin/faults {"preset": "<name>"}` (add `count` to limit it).
 */
export const ODX_PRESETS: Record<string, FaultPreset> = {
  wrong_length_signature: {
    description:
      "The webhook for the next test import carries a short signature: our guard's timingSafeEqual throws (a 500, known consumer bug)",
    rules: EMITTERS.map((operationId) => ({ operationId, effect: "wrong_length_signature" })),
  },
  bad_signature: {
    description:
      "The webhook for the next test import is signed with the wrong key (same length): our guard rejects it (403)",
    rules: EMITTERS.map((operationId) => ({ operationId, effect: "bad_signature" })),
  },
  empty_success: {
    description:
      "Calls answer 200 with an empty body (our client throws 'Empty success response received')",
    rules: [{ effect: "empty_success" }],
  },
  no_content: {
    description: "Calls answer 204 No Content (our client throws on 204)",
    rules: [{ effect: "no_content" }],
  },
  not_found: {
    description: "Every call answers 404 {Message}",
    rules: [{ status: 404, body: { Message: "Not Found" } }],
  },
  server_error: {
    description: "Every call answers 500 {Message: 'An error has occurred.'}",
    rules: [{ status: 500, body: { Message: "An error has occurred." } }],
  },
  slow: {
    description: "Every call is held back 3 s",
    rules: [{ latencyMs: 3_000 }],
  },
  webhook_duplicate: {
    description: "The next webhook is delivered twice (ODX's rapid-fire duplicates)",
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

export type OdxRuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  seed?: number | string
  adminKey?: string
  onLog?: (entry: RequestLog) => void
  settings?: Partial<Settings>
  /**
   * Register this webhook in every namespace from the start (`POST /odx/webhook` on our
   * backend), with this signing key (random when omitted). More can be registered through
   * `POST /v1/webhook`, exactly as `manageWebhooks` does.
   */
  webhook?: { url: string; signingKey?: string }
  retryDelaysMs?: readonly number[]
  fetch?: (request: Request) => Promise<Response>
}

export type OdxRuntime = ServiceRuntime<OdxAPI> & { readonly webhooks: WebhookHub }

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const adminError = (status: number, message: string) =>
  json(status, { error: { type: "mockingbird_admin", message } })
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const EVENTS = ["Created", "Updated", "Deleted"]
const SIGNATURES = ["valid", "short", "bad"]

const adminRoutes = (runtime: ServiceRuntime<OdxAPI>): AdminRoutes => ({
  "GET /patients": ({ namespace }) =>
    json(200, { patients: runtime.instance(namespace).patients() }),
  "GET /tests": ({ namespace }) =>
    json(200, {
      // Results are the mock's own output; no HL7 (PHI) is ever stored.
      tests: runtime.instance(namespace).tests(),
    }),
  "POST /tests/:id/webhook": ({ params, body, namespace }) => {
    const input = isRecord(body) ? body : {}
    const eventType = String(input.eventType ?? "Updated")
    const signature = String(input.signature ?? "valid")
    if (!EVENTS.includes(eventType))
      return adminError(400, "eventType must be Created, Updated or Deleted")
    if (!SIGNATURES.includes(signature))
      return adminError(400, "signature must be valid, short or bad")
    const event = runtime
      .instance(namespace)
      .emit(params.id as string, eventType as OdxEventType, signature as SignatureMode)
    return event ? json(202, event) : adminError(404, `no patient test ${params.id}`)
  },
  "DELETE /tests/:id": ({ params, namespace }) => {
    const event = runtime.instance(namespace).emit(params.id as string, "Deleted")
    return event ? json(200, event) : adminError(404, `no patient test ${params.id}`)
  },
  "GET /settings": ({ namespace }) => json(200, runtime.instance(namespace).state.current()),
  "PUT /settings": ({ body, namespace }) => {
    if (!isRecord(body)) return adminError(400, "expected a JSON object")
    const patch: Partial<Settings> = {}
    if (body.apiKeys !== undefined) {
      if (!Array.isArray(body.apiKeys)) return adminError(400, "apiKeys: string[]")
      patch.apiKeys = body.apiKeys.map(String)
    }
    return json(200, runtime.instance(namespace).state.update(patch))
  },
})

/**
 * The ODX mock with Mockingbird's full service contract: `/health`, `/__admin/*`, namespaces
 * by header, by `/ns/<name>` path prefix, or by `ApiKey`
 * (`PUT /__admin/credentials {"credentials": {"<OPTIMAL_API_KEY>": "<namespace>"}}`), clock
 * control, fault presets, signed PatientTest webhooks and a request journal.
 */
export const createRuntime = (options: OdxRuntimeOptions = {}): OdxRuntime => {
  const hub = createWebhookHub({
    // The message id carries the signature mode a fault preset asked for (`~short`, `~bad`).
    signer: signers.custom(async ({ messageId, body, secret }) => {
      if (!secret) return {}
      const signature = await signOdx(secret, body)
      if (messageId.endsWith("~short")) return { [SIGNATURE_HEADER]: signature.slice(0, 32) }
      if (messageId.endsWith("~bad")) {
        return { [SIGNATURE_HEADER]: await signOdx(`${secret}-wrong`, body) }
      }
      return { [SIGNATURE_HEADER]: signature }
    }),
    ...(options.retryDelaysMs ? { retryDelaysMs: options.retryDelaysMs } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })
  const presetWebhook = options.webhook
    ? {
        url: options.webhook.url,
        signingKey: options.webhook.signingKey ?? `odx_${crypto.randomUUID().replace(/-/g, "")}`,
      }
    : null
  let sequence = 0
  const runtime = createServiceRuntime<OdxAPI>({
    name: ODX_NAMESPACE,
    document,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    credential: apiKeyCredential,
    presets: ODX_PRESETS,
    webhooks: hub,
    create: ({ sqlite, namespace, publicNamespace, clock }) => {
      const api: OdxAPI = new OdxAPI({
        sqlite,
        namespace,
        now: clock.now,
        settings: { ...options.settings, ...(presetWebhook ? { presetWebhook } : {}) },
        onWebhook: (event, signature) => {
          // Deliver to whatever is registered right now (also after a reset or a restore).
          hub.setEndpoints(
            publicNamespace,
            api.state.webhooks.list({ order: "oldest" }).map(({ value }) => ({
              id: `odx_webhook_${value.partnerWebhookId}`,
              url: value.webhookUrl,
              secret: value.signingKey,
              events: value.entityEvents.PatientTest,
            })),
          )
          const suffix = signature === "valid" ? "" : `~${signature}`
          hub.publish({
            namespace: publicNamespace,
            type: event.eventType,
            body: event,
            id: `${event.data.patientTestId}:${event.eventType}:${++sequence}${suffix}`,
          })
        },
      })
      return api
    },
    describe: () => ({ webhooks: presetWebhook ? "preset" : "registered" }),
    admin: adminRoutes,
  })
  return Object.assign(runtime, { webhooks: hub })
}
