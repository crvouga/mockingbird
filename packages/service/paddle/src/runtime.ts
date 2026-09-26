import {
  type AdminRoutes,
  bearerToken,
  type Clock,
  createRuntime as createServiceRuntime,
  createWebhookHub,
  type FaultPreset,
  hmac,
  type RequestLog,
  type ServiceRuntime,
  signers,
  type WebhookEndpoint,
  type WebhookHub,
  type WebhookSigner,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { errorBody, PaddleError } from "./errors.js"
import { document } from "./generated/openapi.js"
import { type CardInput, type CheckoutInput, PADDLE_NAMESPACE, PaddleAPI } from "./index.js"

const paddleError = (status: number, code: string, detail: string) =>
  errorBody(status, code, detail, "00000000-0000-4000-8000-000000000000")

/**
 * Every named Paddle misbehaviour a consumer branches on, switched on with
 * `POST /__admin/faults {"preset": "<name>"}` (add `count` to limit it). The SDK turns each
 * error body into an `ApiError` (with `retryAfter` from the header).
 */
export const PADDLE_PRESETS: Record<string, FaultPreset> = {
  invalid_token: {
    description: "Every request answers 403 invalid_token (a revoked or wrong API key)",
    rules: [
      {
        status: 403,
        body: paddleError(
          403,
          "invalid_token",
          "Invalid API key. Check the key and its environment.",
        ),
      },
    ],
  },
  rate_limited: {
    description: "Every request answers 429 too_many_requests with a Retry-After header",
    rules: [
      {
        status: 429,
        headers: { "retry-after": "2" },
        body: paddleError(429, "too_many_requests", "Rate limit exceeded. Retry after 2 seconds."),
      },
    ],
  },
  transactions_500: {
    description: "Creating a transaction answers a JSON 500 internal_error",
    rules: [
      {
        operationId: "CreateTransaction",
        status: 500,
        body: paddleError(500, "internal_error", "An unexpected error occurred."),
      },
    ],
  },
  bad_gateway_html: {
    description: "Reads answer a 502 HTML page (not Paddle's JSON envelope)",
    rules: [
      {
        method: "GET",
        status: 502,
        headers: { "content-type": "text/html; charset=utf-8" },
        body: "<html><head><title>502 Bad Gateway</title></head><body><h1>502 Bad Gateway</h1></body></html>",
      },
    ],
  },
  network_drop: {
    description: "Creating a transaction drops the connection before answering",
    rules: [{ operationId: "CreateTransaction", drop: true }],
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

/**
 * Paddle's `Paddle-Signature: ts=<unix seconds>;h1=<hex HMAC-SHA256(secret, "<ts>:<body>")>`,
 * over the exact bytes sent. The secret is the notification destination's `pdl_ntfset_…` key.
 */
export const paddleSigner = (): WebhookSigner =>
  signers.custom(async ({ body, timestampSeconds, secret }) =>
    secret
      ? {
          "Paddle-Signature": `ts=${timestampSeconds};h1=${await hmac("SHA-256", secret, `${timestampSeconds}:${body}`, "hex")}`,
        }
      : {},
  )

export type PaddleRuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  seed?: number | string
  adminKey?: string
  onLog?: (entry: RequestLog) => void
  /**
   * Where notifications go, signed with the endpoint's `pdl_ntfset_…` secret in
   * `Paddle-Signature`. `events` limits the event types (default all).
   */
  webhooks?: Omit<WebhookEndpoint, "id"> & {
    retryDelaysMs?: readonly number[]
    fetch?: (request: Request) => Promise<Response>
  }
  /** The default payment link `checkout.url` is built from (`<link>?_ptxn=<id>`). */
  paymentLink?: string
  /** Seed every namespace with the fixture account on first use (`seedFixtures`). */
  fixtures?: boolean
}

export type PaddleRuntime = ServiceRuntime<PaddleAPI> & { readonly webhooks: WebhookHub }

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const adminError = (status: number, message: string, code = "mockingbird_admin") =>
  json(status, { error: { type: "mockingbird_admin", code, message } })

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const attempt = (run: () => Response): Response => {
  try {
    return run()
  } catch (error) {
    if (error instanceof PaddleError) return adminError(error.status, error.detail, error.code)
    throw error
  }
}

const adminRoutes =
  () =>
  (runtime: ServiceRuntime<PaddleAPI>): AdminRoutes => ({
    "POST /transactions/:id/pay": ({ params, namespace, body }) =>
      attempt(() => {
        const card = isRecord(body) && isRecord(body.card) ? (body.card as CardInput) : undefined
        const result = runtime.instance(namespace).payTransaction(params.id as string, card)
        return json(200, result)
      }),
    "POST /checkout": ({ namespace, body }) =>
      attempt(() => {
        if (!isRecord(body) || !Array.isArray(body.items) || body.items.length === 0) {
          return adminError(400, "items: [{price_id, quantity?}] is required")
        }
        return json(201, runtime.instance(namespace).checkout(body as unknown as CheckoutInput))
      }),
    "POST /subscriptions/:id/renew": ({ params, namespace }) =>
      attempt(() => json(200, runtime.instance(namespace).renewSubscription(params.id as string))),
    "POST /subscriptions/:id/payment-failed": ({ params, namespace }) =>
      attempt(() => json(200, runtime.instance(namespace).failPayment(params.id as string))),
    "POST /seed": ({ namespace }) =>
      attempt(() => json(201, runtime.instance(namespace).seedFixtures())),
    "GET /events": ({ namespace, url }) => {
      const type = url.searchParams.get("type")
      const events = runtime
        .instance(namespace)
        .events()
        .filter((event) => type === null || event.event_type === type)
      return json(200, { events })
    },
  })

/**
 * The Paddle mock with Mockingbird's full service contract: `/health`, `/__admin/*`,
 * namespaces by header, by `/ns/<name>` path prefix, or by API key
 * (`PUT /__admin/credentials {"credentials": {"<PADDLE_API_KEY>": "<namespace>"}}`),
 * clock control, fault presets, `Paddle-Signature` webhooks, a request journal, and the
 * admin routes that stand in for the hosted checkout and the billing engine.
 */
export const createRuntime = (options: PaddleRuntimeOptions = {}): PaddleRuntime => {
  const { retryDelaysMs, fetch: send, ...endpoint } = options.webhooks ?? { url: "" }
  const hub = createWebhookHub({
    signer: paddleSigner(),
    ...(retryDelaysMs ? { retryDelaysMs } : {}),
    ...(send ? { fetch: send } : {}),
    endpoints: options.webhooks ? [endpoint as WebhookEndpoint] : [],
  })
  const runtime = createServiceRuntime<PaddleAPI>({
    name: PADDLE_NAMESPACE,
    document,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    credential: bearerToken,
    presets: PADDLE_PRESETS,
    webhooks: hub,
    create: ({ sqlite, namespace, publicNamespace, clock }) => {
      const api = new PaddleAPI({
        sqlite,
        namespace,
        publicNamespace,
        now: clock.now,
        ...(options.paymentLink ? { paymentLink: options.paymentLink } : {}),
        // Seeded on first use and again on every reset, without notifications.
        ...(options.fixtures ? { fixtures: true } : {}),
        onEvent: (event) => {
          hub.publish({
            namespace: publicNamespace,
            type: event.event_type,
            body: { ...event, notification_id: event.event_id.replace(/^evt_/, "ntf_") },
            tags: { event: event.event_type.split(".")[0] ?? event.event_type },
          })
        },
      })
      return api
    },
    describe: () => ({
      webhooks: hub.endpoints("default").length > 0 ? "on" : "off",
      paymentLink: options.paymentLink ?? null,
      fixtures: options.fixtures === true,
    }),
    admin: (base) => adminRoutes()(base),
  })
  return Object.assign(runtime, { webhooks: hub })
}
