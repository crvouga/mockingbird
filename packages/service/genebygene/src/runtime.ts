import {
  type AdminRoutes,
  type Clock,
  createRuntime as createServiceRuntime,
  createWebhookHub,
  type FaultPreset,
  type RequestLog,
  type S3Target,
  type ServiceRuntime,
  type WebhookEndpoint,
  type WebhookHub,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { CORPUS_VERSION } from "./corpus.js"
import { type CustomResults, RESULT_FIXTURES, type ResultFixture } from "./fixtures/index.js"
import { document } from "./generated/openapi.js"
import { GENEBYGENE_NAMESPACE, GeneByGeneAPI, tokenCredential } from "./index.js"
import type { BlockMode, ProductDto, Settings } from "./types.js"
import { gxgSigner } from "./webhooks.js"

const NUCLEUS_ERROR = (status: number, message: string, errorType: string) => ({
  statusCode: status,
  message,
  payload: null,
  errorType,
})

/**
 * Every named Gene by Gene misbehaviour our consumer branches on, switched on with
 * `POST /__admin/faults {"preset": "<name>"}` (add `count` to limit it, `latencyMs` to tune
 * `slow_orders`).
 */
export const GENEBYGENE_PRESETS: Record<string, FaultPreset> = {
  invalid_client: {
    description:
      'The auth host answers 400 {"error":"invalid_client"}: our client blocks the credential for the process lifetime',
    rules: [{ operationId: "PostConnectToken", status: 400, body: { error: "invalid_client" } }],
  },
  token_unauthorized: {
    description: "The auth host answers 401 (also a permanent credential block in our client)",
    rules: [{ operationId: "PostConnectToken", status: 401, body: { error: "invalid_client" } }],
  },
  token_forbidden: {
    description: "The auth host answers 403 (also a permanent credential block in our client)",
    rules: [
      { operationId: "PostConnectToken", status: 403, body: { error: "unauthorized_client" } },
    ],
  },
  token_revoked: {
    description:
      "API calls answer 401 invalid_token: our client invalidates its cached token and retries once",
    rules: [{ pathPrefix: "/api/v2", effect: "token_revoked" }],
  },
  rate_limited: {
    description: "Every API call answers 429 with a Retry-After",
    rules: [
      {
        pathPrefix: "/api/v2",
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "1" },
        body: NUCLEUS_ERROR(429, "Too many requests. Please retry later.", "RateLimit"),
      },
    ],
  },
  shipping_empty_500: {
    description:
      "getShippingOptions answers an empty 500, as GxG prod does for the standard bundle",
    rules: [{ operationId: "GetShippingOptions", status: 500, body: null }],
  },
  address_not_validated: {
    description:
      'Shipping options report "Address not found"; order placement and address updates answer 400 "shipping address(es) not validated"',
    rules: [
      { operationId: "GetShippingOptions", effect: "address_not_validated" },
      { operationId: "CreateOrder", effect: "address_not_validated" },
      { operationId: "UpdateShipmentAddress", effect: "address_not_validated" },
    ],
  },
  slow_orders: {
    description: "POST /api/v2/orders takes 5 s (override with latencyMs)",
    rules: [{ operationId: "CreateOrder", latencyMs: 5_000 }],
  },
  no_kit_numbers: {
    description:
      "Orders are placed without kit numbers (as staging often does); POST /__admin/orders/:id/kit-numbers mints them later",
    rules: [{ operationId: "CreateOrder", effect: "no_kit_numbers" }],
  },
  cancel_conflict: {
    description: "The three cancel layers answer 409 (the 'invalid state' variant)",
    rules: [
      { operationId: "CancelFulfillment", effect: "cancel_conflict" },
      { operationId: "CancelKitOrderLines", effect: "cancel_conflict" },
      { operationId: "CancelOrderLine", effect: "cancel_conflict" },
    ],
  },
  presigned_access_denied: {
    description: "The presigned result URL answers 403 AccessDenied (our fetcher's denied path)",
    rules: [
      {
        operationId: "GetResultBlob",
        status: 403,
        headers: { "content-type": "application/xml" },
        body: '<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>',
      },
    ],
  },
  server_error: {
    description: "Every API call answers an empty 500",
    rules: [{ pathPrefix: "/api/v2", status: 500, body: null }],
  },
  webhook_duplicate: {
    description: "The next notification is delivered twice",
    webhook: { mode: "duplicate" },
  },
  webhook_reorder: {
    description: "The next two notifications arrive swapped",
    webhook: { mode: "reorder" },
  },
  webhook_drop: {
    description: "The next notification is never delivered",
    webhook: { mode: "drop" },
  },
}

/** GxG retries a failed delivery up to three times (`GXG/docs/llm/05-webhooks.md`). */
export const GXG_RETRY_DELAYS_MS = [0, 10_000, 60_000, 300_000] as const

export type GeneByGeneRuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  /** Seeds every random choice the runtime makes (fault rates). */
  seed?: number | string
  /** Require `x-mockingbird-admin-key` on `/__admin/*`. */
  adminKey?: string
  onLog?: (entry: RequestLog) => void
  /** Catalog every namespace starts with. Default: the recorded staging catalog. */
  products?: readonly ProductDto[]
  settings?: Partial<Settings>
  /**
   * Webhook delivery. Notifications always go to each active subscription created through
   * `POST /api/v2/notificationSubscriptions` (signed with its secret); `url` adds one endpoint
   * every namespace delivers to, signed with `secret` (the value seeded into our backend's KV).
   */
  webhooks?: {
    url?: string
    secret?: string
    events?: string[]
    retryDelaysMs?: readonly number[]
    fetch?: (request: Request) => Promise<Response>
  }
  /** Write result files into this S3 (s3rver) bucket and report `s3://<bucket>/<key>`. */
  resultsS3?: S3Target
}

export type GeneByGeneRuntime = ServiceRuntime<GeneByGeneAPI> & { readonly webhooks: WebhookHub }

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const adminError = (status: number, message: string) =>
  json(status, { error: { type: "mockingbird_admin", message } })
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const BLOCK_MODES: readonly BlockMode[] = ["invalid_client", "unauthorized", "forbidden"]

const parseSettings = (body: Record<string, unknown>): Partial<Settings> | string => {
  const patch: Partial<Settings> = {}
  if (body.tokenTtlSeconds !== undefined) {
    if (typeof body.tokenTtlSeconds !== "number") return "tokenTtlSeconds: number"
    patch.tokenTtlSeconds = body.tokenTtlSeconds
  }
  if (body.clients !== undefined) {
    if (!Array.isArray(body.clients)) return "clients: [{client_id, client_secret}]"
    patch.clients = body.clients.filter(isRecord).map((c) => ({
      client_id: String(c.client_id),
      client_secret: String(c.client_secret),
    }))
  }
  if (body.blockedClients !== undefined) {
    if (!isRecord(body.blockedClients)) {
      return `blockedClients: {"<client_id>": ${BLOCK_MODES.map((m) => `"${m}"`).join(" | ")}}`
    }
    const blocked: Record<string, BlockMode> = {}
    for (const [clientId, mode] of Object.entries(body.blockedClients)) {
      if (!BLOCK_MODES.includes(mode as BlockMode)) {
        return `blockedClients.${clientId} must be one of ${BLOCK_MODES.join(", ")}`
      }
      blocked[clientId] = mode as BlockMode
    }
    patch.blockedClients = blocked
  }
  if (body.generateKitNumbers !== undefined) {
    if (typeof body.generateKitNumbers !== "boolean") return "generateKitNumbers: boolean"
    patch.generateKitNumbers = body.generateKitNumbers
  }
  if (body.presignedUrlTtlSeconds !== undefined) {
    if (typeof body.presignedUrlTtlSeconds !== "number") return "presignedUrlTtlSeconds: number"
    patch.presignedUrlTtlSeconds = body.presignedUrlTtlSeconds
  }
  if (body.resultsBucket !== undefined) {
    if (typeof body.resultsBucket !== "string") return "resultsBucket: string"
    patch.resultsBucket = body.resultsBucket
  }
  return patch
}

const adminRoutes = (runtime: ServiceRuntime<GeneByGeneAPI>): AdminRoutes => ({
  "GET /orders": ({ namespace }) => json(200, { orders: runtime.instance(namespace).orders() }),
  "GET /kits": ({ namespace }) => json(200, { kits: runtime.instance(namespace).kits() }),
  "POST /orders/:id/ship": ({ params, body, namespace }) => {
    const input = isRecord(body) ? body : {}
    const shipped = runtime.instance(namespace).ship(params.id as string, {
      ...(typeof input.trackingNumber === "string" ? { trackingNumber: input.trackingNumber } : {}),
      ...(typeof input.returnTrackingNumber === "string"
        ? { returnTrackingNumber: input.returnTrackingNumber }
        : {}),
    })
    if (typeof shipped === "string") {
      return adminError(shipped.startsWith("no order") ? 404 : 409, shipped)
    }
    return json(200, shipped.order)
  },
  "POST /orders/:id/kit-numbers": ({ params, namespace }) => {
    const api = runtime.instance(namespace)
    const order = api.generateKitNumbers(params.id as string)
    return order ? json(200, api.order(order.id)) : adminError(404, `no order ${params.id}`)
  },
  "POST /kits/:kitNumber/transition": async ({ params, body, namespace }) => {
    if (!isRecord(body) || typeof body.to !== "string") {
      return adminError(
        400,
        'expected {"to": "Received" | "In Lab" | … | "Completed" | "Error" | "Canceled", "errorCode"?, "errorMessage"?, "fixture"?}',
      )
    }
    if (body.fixture !== undefined && !RESULT_FIXTURES.includes(body.fixture as ResultFixture)) {
      return adminError(400, `fixture must be one of ${RESULT_FIXTURES.join(", ")}`)
    }
    const kit = await runtime.instance(namespace).transition(params.kitNumber as string, {
      to: body.to,
      ...(typeof body.errorCode === "number" ? { errorCode: body.errorCode } : {}),
      ...(typeof body.errorMessage === "string" ? { errorMessage: body.errorMessage } : {}),
      ...(typeof body.fixture === "string" ? { fixture: body.fixture as ResultFixture } : {}),
    })
    if (typeof kit === "string") {
      return adminError(
        kit.startsWith("no kit") ? 404 : kit.startsWith("results S3") ? 502 : 409,
        kit,
      )
    }
    return json(200, kit)
  },
  "PUT /results/:kitNumber": ({ params, body, namespace }) => {
    if (!isRecord(body)) {
      return adminError(
        400,
        'expected {"fixture": "normal" | "pgx" | "ancestry"} or {json?, csv?, pdfBase64?}',
      )
    }
    const api = runtime.instance(namespace)
    let staged: boolean
    if (typeof body.fixture === "string") {
      if (!RESULT_FIXTURES.includes(body.fixture as ResultFixture)) {
        return adminError(400, `fixture must be one of ${RESULT_FIXTURES.join(", ")}`)
      }
      staged = api.setPendingResults(params.kitNumber as string, {
        fixture: body.fixture as ResultFixture,
      })
    } else {
      const custom: CustomResults = {
        ...(body.json !== undefined ? { json: body.json } : {}),
        ...(typeof body.csv === "string" ? { csv: body.csv } : {}),
        ...(typeof body.pdfBase64 === "string" ? { pdfBase64: body.pdfBase64 } : {}),
      }
      staged = api.setPendingResults(params.kitNumber as string, { custom })
    }
    return staged
      ? json(200, { kitNumber: params.kitNumber, staged: true })
      : adminError(404, `no kit ${params.kitNumber}`)
  },
  "GET /settings": ({ namespace }) => json(200, runtime.instance(namespace).state.current()),
  "PUT /settings": ({ body, namespace }) => {
    if (!isRecord(body)) return adminError(400, "expected a JSON object")
    const patch = parseSettings(body)
    if (typeof patch === "string") return adminError(400, patch)
    return json(200, runtime.instance(namespace).state.update(patch))
  },
  "POST /tokens/revoke": ({ namespace }) => {
    const state = runtime.instance(namespace).state
    const next = state.update({ tokenGeneration: state.current().tokenGeneration + 1 })
    return json(200, { tokenGeneration: next.tokenGeneration })
  },
})

const SUBSCRIPTION_PREFIX = "gxg_sub_"

/**
 * The Gene by Gene mock with Mockingbird's full service contract: `/health`, `/__admin/*`,
 * namespaces by header, by `/ns/<name>` path prefix (use it on both the API and the token URL),
 * or by client id (`PUT /__admin/credentials {"credentials": {"<client_id>": "<namespace>"}}`),
 * clock control, fault presets, GxG-signed notifications and a request journal.
 */
export const createRuntime = (options: GeneByGeneRuntimeOptions = {}): GeneByGeneRuntime => {
  const eventTypes = new Map<string, string>()
  const { url, secret, events, retryDelaysMs, fetch: send } = options.webhooks ?? {}
  const hub = createWebhookHub({
    signer: gxgSigner((id) => eventTypes.get(id)),
    retryDelaysMs: retryDelaysMs ?? GXG_RETRY_DELAYS_MS,
    ...(send ? { fetch: send } : {}),
    endpoints: url
      ? [{ url, ...(secret ? { secret } : {}), ...(events ? { events } : {}) } as WebhookEndpoint]
      : [],
  })

  /** Point the namespace's hub endpoints at its active subscriptions (keeping admin-set ones). */
  const syncSubscriptions = (namespace: string, api: GeneByGeneAPI) => {
    const kept = hub
      .endpoints(namespace)
      .filter((e) => !e.id?.startsWith("we_global_") && !e.id?.startsWith(SUBSCRIPTION_PREFIX))
    hub.setEndpoints(namespace, [
      ...kept,
      ...api.activeSubscriptions().map((sub) => ({
        id: `${SUBSCRIPTION_PREFIX}${sub.id}`,
        url: sub.endPoint,
        secret: sub.secret,
        events: [...sub.events],
      })),
    ])
  }

  const runtime = createServiceRuntime<GeneByGeneAPI>({
    name: GENEBYGENE_NAMESPACE,
    document,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    credential: tokenCredential,
    presets: GENEBYGENE_PRESETS,
    webhooks: hub,
    create: ({ sqlite, namespace, publicNamespace, clock }) => {
      const api: GeneByGeneAPI = new GeneByGeneAPI({
        sqlite,
        namespace,
        publicNamespace,
        now: clock.now,
        ...(options.products ? { products: options.products } : {}),
        ...(options.settings ? { settings: options.settings } : {}),
        ...(options.resultsS3 ? { resultsS3: options.resultsS3 } : {}),
        onWebhook: (event) => {
          syncSubscriptions(publicNamespace, api)
          const id = crypto.randomUUID()
          eventTypes.set(id, event.type)
          hub.publish({ namespace: publicNamespace, type: event.type, body: event.body, id })
        },
      })
      return api
    },
    describe: () => ({
      corpus: CORPUS_VERSION,
      webhooks: url ? "on" : "subscriptions",
      resultsS3: options.resultsS3
        ? `${options.resultsS3.endpoint}/${options.resultsS3.bucket}`
        : "off",
    }),
    admin: adminRoutes,
  })
  return Object.assign(runtime, { webhooks: hub })
}
