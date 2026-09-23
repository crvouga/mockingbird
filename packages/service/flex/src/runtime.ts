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
  svixSecretBytes,
  type WebhookEndpoint,
  type WebhookHub,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { document } from "./generated/openapi.js"
import { FLEX_NAMESPACE, FlexAPI, isNextActionType } from "./index.js"
import {
  PAYMENT_INTENT_STATUSES,
  type PaymentIntentStatus,
  type ProductRecord,
  type Settings,
} from "./state.js"

const errorBody = (type: string, message: string) => ({ error: { type, message } })

/**
 * Every named Flex misbehaviour our consumer branches on, switched on with
 * `POST /__admin/faults {"preset": "<name>"}` (add `count` to limit it).
 */
export const FLEX_PRESETS: Record<string, FaultPreset> = {
  create_4xx: {
    description:
      "Session create answers 400 without creating anything: recovery finds no session, the attempt fails",
    rules: [
      {
        operationId: "CreateCheckoutSession",
        status: 400,
        body: errorBody("invalid_request_error", "The checkout session could not be created."),
      },
    ],
  },
  create_5xx: {
    description:
      "Session create creates the session, then answers 500: recovery by client_reference_id adopts it",
    rules: [{ operationId: "CreateCheckoutSession", effect: "created_but_500" }],
  },
  create_5xx_not_created: {
    description: "Session create answers 500 without creating anything",
    rules: [
      {
        operationId: "CreateCheckoutSession",
        status: 500,
        body: errorBody("api_error", "An unexpected error occurred."),
      },
    ],
  },
  timeout: {
    description:
      "Session create creates the session, then answers only after 16 s, past our client's 15 s abort (params.delayMs overrides)",
    rules: [
      { operationId: "CreateCheckoutSession", effect: "timeout", params: { delayMs: 16_000 } },
    ],
  },
  invalid_shape: {
    description:
      "Session responses omit both redirect_url and url, so our zod validation rejects them",
    rules: [{ pathPrefix: "/v1/checkout/sessions", effect: "invalid_shape" }],
  },
  amount_mismatch: {
    description:
      "Session responses report amount_total 100 cents above the real total (our orchestrator quarantines)",
    rules: [{ pathPrefix: "/v1/checkout/sessions", effect: "amount_mismatch" }],
  },
  duplicate_sessions_for_client_reference: {
    description:
      "Session create creates two sessions for one client_reference_id, then answers 500 (quarantine as duplicate_provider_sessions)",
    rules: [
      { operationId: "CreateCheckoutSession", effect: "duplicate_sessions_for_client_reference" },
    ],
  },
  refund_4xx: {
    description: "Refund answers 400 (our orchestrator quarantines as flex_refund_http_400)",
    rules: [
      {
        operationId: "RefundCheckoutSession",
        status: 400,
        body: errorBody("invalid_request_error", "The refund could not be created."),
      },
    ],
  },
  server_error: {
    description: "Every API call answers 500",
    rules: [
      {
        pathPrefix: "/v1/",
        status: 500,
        body: errorBody("api_error", "An unexpected error occurred."),
      },
    ],
  },
  webhook_duplicate: {
    description: "The next webhook is delivered twice (same event_id)",
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

type WebhookHubOptionsSubset = {
  retryDelaysMs?: readonly number[]
  fetch?: (request: Request) => Promise<Response>
}

export type FlexRuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  seed?: number | string
  adminKey?: string
  onLog?: (entry: RequestLog) => void
  /** Products every namespace starts with. Default: the recorded corpus. */
  products?: readonly ProductRecord[]
  settings?: Partial<Settings>
  /**
   * Where webhooks go (`POST /billing/webhooks/flex`), Svix-signed with `secret`
   * (`fwhsec_<base64>` or `whsec_<base64>`, the app's `FLEX_WEBHOOK_SECRET`).
   */
  webhooks?: Omit<WebhookEndpoint, "id"> & WebhookHubOptionsSubset
  /**
   * Expire due sessions on this real-time interval (ms), so `expired` webhooks fire without
   * a request arriving. The served mock uses 100 ms; in-process runtimes default to off.
   */
  tickMs?: number
}

export type FlexRuntime = ServiceRuntime<FlexAPI> & {
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

const parseSettings = (body: unknown): Partial<Settings> | string => {
  if (!isRecord(body)) return "expected a JSON object"
  const patch: Partial<Settings> = {}
  if (body.eventNaming !== undefined) {
    if (body.eventNaming !== "dotted" && body.eventNaming !== "underscored") {
      return 'eventNaming: "dotted" | "underscored"'
    }
    patch.eventNaming = body.eventNaming
  }
  if (body.offSessionOutcome !== undefined) {
    if (!["succeeded", "declined", "requires_action"].includes(String(body.offSessionOutcome))) {
      return 'offSessionOutcome: "succeeded" | "declined" | "requires_action"'
    }
    patch.offSessionOutcome = body.offSessionOutcome as Settings["offSessionOutcome"]
  }
  if (body.sessionTtlSeconds !== undefined) {
    if (typeof body.sessionTtlSeconds !== "number" || body.sessionTtlSeconds <= 0) {
      return "sessionTtlSeconds: positive number"
    }
    patch.sessionTtlSeconds = body.sessionTtlSeconds
  }
  if (body.lmnOnRegularCard !== undefined) {
    if (typeof body.lmnOnRegularCard !== "boolean") return "lmnOnRegularCard: boolean"
    patch.lmnOnRegularCard = body.lmnOnRegularCard
  }
  if (body.publicUrl !== undefined) {
    if (body.publicUrl !== null && typeof body.publicUrl !== "string")
      return "publicUrl: string | null"
    patch.publicUrl = body.publicUrl as string | null
  }
  return patch
}

const adminRoutes = (runtime: ServiceRuntime<FlexAPI>): AdminRoutes => {
  const session = (namespace: string, id: string) =>
    runtime.instance(namespace).state.sessions.get(id)
  const found = (value: unknown, what: string) =>
    value ? json(200, value) : adminError(404, `no ${what}`)
  /** Only an open session can be paid, declined, expired or asked for an action. */
  const notOpen = (namespace: string, id: string) => {
    const current = session(namespace, id)
    if (!current) return adminError(404, `no session ${id}`)
    return current.status === "open"
      ? undefined
      : adminError(409, `session ${id} is ${current.status}, not open`)
  }
  return {
    "GET /sessions": ({ namespace }) =>
      json(200, { sessions: runtime.instance(namespace).sessions() }),
    "GET /sessions/:id": ({ namespace, params }) =>
      found(session(namespace, params.id as string), `session ${params.id}`),
    "POST /sessions/:id/complete": ({ namespace, params, body }) => {
      const closed = notOpen(namespace, params.id as string)
      if (closed) return closed
      const hsa = !(isRecord(body) && body.card === "4242424242424242")
      return found(
        runtime.instance(namespace).settle(params.id as string, { hsa }),
        `session ${params.id}`,
      )
    },
    "POST /sessions/:id/decline": ({ namespace, params }) =>
      notOpen(namespace, params.id as string) ??
      found(runtime.instance(namespace).decline(params.id as string), `session ${params.id}`),
    "POST /sessions/:id/expire": ({ namespace, params }) =>
      notOpen(namespace, params.id as string) ??
      found(runtime.instance(namespace).expire(params.id as string), `session ${params.id}`),
    "POST /sessions/:id/require_action": ({ namespace, params, body }) => {
      const closed = notOpen(namespace, params.id as string)
      if (closed) return closed
      const type = isRecord(body) ? body.next_action_type : undefined
      if (type !== undefined && !isNextActionType(type)) {
        return adminError(
          400,
          "next_action_type: collect_letter_of_medical_necessity | provide_second_payment_method | provide_alternative_payment_method | payment_failed",
        )
      }
      return found(
        runtime.instance(namespace).requireAction(params.id as string, type),
        `session ${params.id}`,
      )
    },
    "PUT /sessions/:id/payment-intent": ({ namespace, params, body }) => {
      if (
        !isRecord(body) ||
        !(PAYMENT_INTENT_STATUSES as readonly string[]).includes(String(body.status))
      ) {
        return adminError(400, `status: ${PAYMENT_INTENT_STATUSES.join(" | ")}`)
      }
      const api = runtime.instance(namespace)
      const intent = api.setPaymentIntent(params.id as string, {
        status: body.status as PaymentIntentStatus,
        ...(typeof body.amount_received === "number" || body.amount_received === null
          ? { amount_received: body.amount_received as number | null }
          : {}),
      })
      return found(intent, `session ${params.id}`)
    },
    "PUT /products/:id": ({ namespace, params, body }) => {
      if (!isRecord(body)) return adminError(400, "expected a JSON object")
      const api = runtime.instance(namespace)
      const product = api.state.products.get(params.id as string)
      if (!product) return adminError(404, `no product ${params.id}`)
      const next: ProductRecord = { ...product }
      for (const key of ["hsa_fsa_eligibility", "visit_type", "client_reference_id"] as const) {
        const value = body[key]
        if (value === undefined) continue
        if (value !== null && typeof value !== "string")
          return adminError(400, `${key}: string | null`)
        next[key] = value
      }
      for (const key of ["active", "test_mode"] as const) {
        const value = body[key]
        if (value === undefined) continue
        if (typeof value !== "boolean") return adminError(400, `${key}: boolean`)
        next[key] = value
      }
      if (body.name !== undefined) {
        if (typeof body.name !== "string") return adminError(400, "name: string")
        next.name = body.name
      }
      if (body.metadata !== undefined) {
        if (body.metadata !== null && !isRecord(body.metadata))
          return adminError(400, "metadata: object | null")
        next.metadata = body.metadata as Record<string, string> | null
      }
      return json(200, api.putProduct(next))
    },
    "POST /events": ({ namespace, body }) => {
      if (!isRecord(body) || typeof body.type !== "string") {
        return adminError(400, 'expected {"type": "<event type>", "session"?: id, "product"?: id}')
      }
      const event = runtime.instance(namespace).emitFor(body.type, {
        ...(typeof body.session === "string" ? { sessionId: body.session } : {}),
        ...(typeof body.product === "string" ? { productId: body.product } : {}),
      })
      return event ? json(201, event) : adminError(404, "no such session or product")
    },
    "GET /settings": ({ namespace }) => json(200, runtime.instance(namespace).state.current()),
    "PUT /settings": ({ body, namespace }) => {
      const patch = parseSettings(body)
      if (typeof patch === "string") return adminError(400, patch)
      return json(200, runtime.instance(namespace).state.update(patch))
    },
    "POST /tick": ({ namespace }) => json(200, { expired: runtime.instance(namespace).tick() }),
  }
}

/**
 * The Flex mock with Mockingbird's full service contract: `/health`, `/__admin/*`,
 * namespaces by header, by `/ns/<name>` path prefix, or by API key
 * (`PUT /__admin/credentials {"credentials": {"<FLEX_API_KEY>": "<namespace>"}}`), clock
 * control, fault presets, Svix-signed webhooks and a request journal.
 */
export const createRuntime = (options: FlexRuntimeOptions = {}): FlexRuntime => {
  const { retryDelaysMs, fetch: send, ...endpoint } = options.webhooks ?? { url: "" }
  if (options.webhooks?.secret !== undefined) {
    if (
      !/^f?whsec_/.test(options.webhooks.secret) ||
      svixSecretBytes(options.webhooks.secret).length === 0
    ) {
      throw new TypeError("Flex webhook secret must be fwhsec_<base64> or whsec_<base64>")
    }
  }
  const hub = createWebhookHub({
    signer: signers.svix(),
    ...(retryDelaysMs ? { retryDelaysMs } : {}),
    ...(send ? { fetch: send } : {}),
    endpoints: options.webhooks ? [endpoint as WebhookEndpoint] : [],
  })
  const runtime = createServiceRuntime<FlexAPI>({
    name: FLEX_NAMESPACE,
    document,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    credential: bearerToken,
    presets: FLEX_PRESETS,
    webhooks: hub,
    create: ({ sqlite, namespace, publicNamespace, clock }) =>
      new FlexAPI({
        sqlite,
        namespace,
        publicNamespace,
        now: clock.now,
        ...(options.products ? { products: options.products } : {}),
        ...(options.settings ? { settings: options.settings } : {}),
        onEvent: (event) =>
          hub.publish({
            namespace: publicNamespace,
            type: event.event_type,
            body: { event },
            id: `msg_${event.event_id.replace(/^fevt_/, "")}`,
          }),
      }),
    describe: () => ({
      corpus: options.products
        ? `custom (${options.products.length} products)`
        : "flexCatalogMappings",
      webhooks: hub.endpoints("default").length > 0 ? "on" : "off",
    }),
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
