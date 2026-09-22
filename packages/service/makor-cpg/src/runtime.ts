import {
  type AdminRoutes,
  type Clock,
  createRuntime as createServiceRuntime,
  type FaultPreset,
  type RequestLog,
  type ServiceRuntime,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { document } from "./generated/openapi.js"
import {
  apiKeyCredential,
  defaultScriptContent,
  MAKOR_CPG_NAMESPACE,
  MakorCpgAPI,
} from "./index.js"
import type {
  CarePlanRecord,
  FullUserSummary,
  OrderRecord,
  ReviewRecord,
  ScriptContent,
  Settings,
  SubscriptionRecord,
} from "./state.js"

const GENERATION_OPS = ["GenerateUserSummary", "GenerateReviewScript", "RegenerateReviewScript"]

/**
 * Every named Makor CPG misbehaviour our consumers branch on, switched on with
 * `POST /__admin/faults {"preset": "<name>"}` (add `count` to limit it).
 */
export const MAKOR_CPG_PRESETS: Record<string, FaultPreset> = {
  slow_generation: {
    description:
      "Summary and review-script generation take 40 s, the real server's 30-50 s (override with latencyMs); the EMR's 50 s summary timeout is the edge",
    rules: GENERATION_OPS.map((operationId) => ({ operationId, latencyMs: 40_000 })),
  },
  generation_failed: {
    description:
      "Generation fails: summaries answer 500; review scripts answer 500 {status: 'failed', errorMessage} and store a failed review",
    rules: GENERATION_OPS.map((operationId) => ({ operationId, effect: "generation_failed" })),
  },
  care_plan_invalid_shape: {
    description:
      "Care-plan details answer 200 without pricing (the backend's schema check fails: 'Invalid response format', null)",
    rules: [{ operationId: "GetCurrentCarePlan", effect: "care_plan_invalid_shape" }],
  },
  bloodwork_not_accepted: {
    description:
      "The bloodwork webhook answers 200 instead of 202 (the backend warns and returns null)",
    rules: [{ operationId: "BloodworkResultsReceived", effect: "bloodwork_not_accepted" }],
  },
  route_missing: {
    description:
      "Every call answers 404 'Cannot GET …': a wrong route, which the backend logs at error level (unlike the no-plan 404)",
    rules: [{ pathPrefix: "/api/", effect: "route_missing" }],
  },
  unauthorized: {
    description: "Every call answers 401 Invalid API key",
    rules: [
      {
        pathPrefix: "/api/",
        status: 401,
        body: { error: "Unauthorized", message: "Invalid API key", statusCode: 401 },
      },
    ],
  },
  server_error: {
    description: "Every call answers 500",
    rules: [
      {
        pathPrefix: "/api/",
        status: 500,
        body: { error: "Internal Server Error", message: "Something went wrong", statusCode: 500 },
      },
    ],
  },
}

/**
 * CORS: the EMR frontend calls this API straight from the browser with `x-api-key` (and a
 * JSON content type), so every request is preflighted. The mock answers every `OPTIONS` with
 * 204 and these headers, and stamps them on every other response too (vendor, fault, admin and
 * health alike), so a test browser never sees a CORS failure in place of the real status.
 */
export const CORS_HEADERS = {
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, x-api-key, x-mockingbird-namespace, authorization",
  "access-control-expose-headers": "x-mockingbird",
  "access-control-max-age": "600",
} as const

const corsHeaders = (request: Request): Record<string, string> => ({
  ...CORS_HEADERS,
  "access-control-allow-origin": request.headers.get("origin") ?? "*",
  ...(request.headers.get("access-control-request-headers")
    ? {
        "access-control-allow-headers": request.headers.get(
          "access-control-request-headers",
        ) as string,
      }
    : {}),
  vary: "Origin",
})

/** Add permissive CORS headers to a response (copying it when its headers are immutable). */
export const withCors = (request: Request, response: Response): Response => {
  const headers = corsHeaders(request)
  try {
    for (const [name, value] of Object.entries(headers)) response.headers.set(name, value)
    return response
  } catch {
    const copy = new Response(response.body, response)
    for (const [name, value] of Object.entries(headers)) copy.headers.set(name, value)
    return copy
  }
}

export type MakorCpgRuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  seed?: number | string
  adminKey?: string
  onLog?: (entry: RequestLog) => void
  settings?: Partial<Settings>
}

export type MakorCpgRuntime = ServiceRuntime<MakorCpgAPI>

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const adminError = (status: number, message: string) =>
  json(status, { error: { type: "mockingbird_admin", message } })
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const DEFAULT_PRICING = {
  subtotal_cents: 18_900,
  shipping_cents: 0,
  tax_cents: 1_512,
  total_cost_cents_before_discount: 20_412,
  total_cost_cents: 20_412,
  discount_percent: null,
  discount_type: null,
}

const subscriptionRow = (userId: string, patch: Record<string, unknown>, at: string) =>
  ({
    id: `sub_row_${userId}`,
    user_id: userId,
    stripe_customer_id: `cus_mock_${userId}`,
    stripe_subscription_id: `sub_mock_${userId}`,
    stripe_checkout_session_id: null,
    checkout_url: null,
    cp_id: null,
    price_cents: 18_900,
    subtotal_price: null,
    tax_cents: 1_512,
    shipping_cents: 0,
    discount_percent: null,
    coupon_id: null,
    interval_days: 30,
    idempotency_key: null,
    subscription_intent_id: null,
    stripe_latest_invoice_id: null,
    status_reason: null,
    status: "active",
    last_fulfilled_invoice_id: null,
    next_renewal_date: null,
    last_invoice_paid_at: null,
    created_at: at,
    updated_at: at,
    ...patch,
  }) as SubscriptionRecord

const isScript = (value: unknown): value is ScriptContent =>
  isRecord(value) && isRecord(value.overview) && isRecord(value.labFindings)

const adminRoutes = (runtime: ServiceRuntime<MakorCpgAPI>): AdminRoutes => {
  const state = (namespace: string) => runtime.instance(namespace).state
  const iso = () => new Date(runtime.clock.now()).toISOString()
  return {
    "GET /care-plans/:userId": ({ params, namespace }) => {
      const plan = state(namespace).carePlans.get(params.userId as string)
      return plan ? json(200, plan) : adminError(404, `no care plan for ${params.userId}`)
    },
    "PUT /care-plans/:userId": ({ params, body, namespace }) => {
      if (!isRecord(body))
        return adminError(400, "expected {carePlanId?, status?, pricing?, state?}")
      const userId = params.userId as string
      const plan: CarePlanRecord = {
        carePlanId: typeof body.carePlanId === "string" ? body.carePlanId : `cp_${userId}`,
        status: typeof body.status === "string" ? body.status : "Active",
        pricing: {
          ...DEFAULT_PRICING,
          ...(isRecord(body.pricing) ? body.pricing : {}),
        } as CarePlanRecord["pricing"],
        state: typeof body.state === "string" ? body.state : "TX",
        plusUser: body.plusUser === true,
      }
      state(namespace).carePlans.insert(userId, plan)
      return json(200, plan)
    },
    "DELETE /care-plans/:userId": ({ params, namespace }) =>
      json(200, { deleted: state(namespace).carePlans.delete(params.userId as string) }),
    "PUT /subscriptions/:userId": ({ params, body, namespace }) => {
      if (!isRecord(body)) return adminError(400, "expected subscription fields (status, …)")
      const row = subscriptionRow(params.userId as string, body, iso())
      state(namespace).subscriptions.insert(params.userId as string, row)
      return json(200, row)
    },
    "PUT /wholescripts-orders/:userId": ({ params, body, namespace }) => {
      const list = Array.isArray(body) ? body : isRecord(body) ? body.orders : undefined
      if (!Array.isArray(list) || !list.every(isRecord)) {
        return adminError(400, "expected [order, …] or {orders: [order, …]}")
      }
      const orders = list.map((order, index) => ({ id: index + 1, ...order })) as OrderRecord[]
      state(namespace).orders.insert(params.userId as string, orders)
      return json(200, { orders })
    },
    "GET /bloodwork": ({ namespace }) =>
      json(200, {
        webhooks: state(namespace)
          .bloodwork.list({ order: "oldest" })
          .map((row) => row.value),
      }),
    "PUT /fixtures/summary": ({ body, namespace }) => {
      if (!isRecord(body) || !isRecord(body.summary)) {
        return adminError(
          400,
          "expected {userId?, summary: {general_summary, past_visits}, biomarker_analysis?}",
        )
      }
      const userId = typeof body.userId === "string" ? body.userId : "*"
      const fixture = {
        summary: body.summary as FullUserSummary["summary"],
        biomarker_analysis: isRecord(body.biomarker_analysis) ? body.biomarker_analysis : {},
      }
      state(namespace).setSummaryFixture(userId, fixture)
      return json(200, { userId, ...fixture })
    },
    "PUT /fixtures/review-script": ({ body, namespace }) => {
      if (!isRecord(body) || !isScript(body.scriptContent)) {
        return adminError(400, "expected {userId?, labTestId?, scriptContent: ScriptContent}")
      }
      const userId = typeof body.userId === "string" ? body.userId : "*"
      const labTestId = typeof body.labTestId === "string" ? body.labTestId : "*"
      state(namespace).setReviewFixture(userId, labTestId, body.scriptContent)
      return json(200, { userId, labTestId })
    },
    "POST /summaries": ({ body, namespace }) => {
      if (!isRecord(body) || typeof body.cpgUserId !== "string") {
        return adminError(
          400,
          "expected {cpgUserId, summary?: {summary, biomarker_analysis}, createdAt?}",
        )
      }
      const given = isRecord(body.summary) ? body.summary : {}
      const summary: FullUserSummary = {
        user_id: body.cpgUserId,
        summary: (isRecord(given.summary)
          ? given.summary
          : {
              general_summary: ["Seeded summary (mock)."],
              past_visits: [],
            }) as FullUserSummary["summary"],
        biomarker_analysis: isRecord(given.biomarker_analysis) ? given.biomarker_analysis : {},
      }
      const record = {
        cpgUserId: body.cpgUserId,
        summary,
        createdAt: typeof body.createdAt === "string" ? body.createdAt : iso(),
      }
      state(namespace).addSummary(record)
      return json(201, record)
    },
    "GET /reviews": ({ url, namespace }) => {
      const userId = url.searchParams.get("userId")
      const rows = state(namespace)
        .reviews.list({ order: "oldest" })
        .map((row) => row.value)
        .filter((review) => userId === null || review.userId === userId)
      return json(200, { reviews: rows })
    },
    "POST /reviews": ({ body, namespace }) => {
      if (
        !isRecord(body) ||
        typeof body.userId !== "string" ||
        typeof body.labTestId !== "string"
      ) {
        return adminError(400, "expected {userId, labTestId, status?, scriptContent?, reviewType?}")
      }
      const s = state(namespace)
      const status =
        body.status === "processing" || body.status === "failed" ? body.status : "complete"
      const content = isScript(body.scriptContent)
        ? body.scriptContent
        : defaultScriptContent(body.labTestId)
      const at = runtime.clock.now()
      const review: ReviewRecord = {
        id: s.nextReviewId(),
        userId: body.userId,
        labTestId: body.labTestId,
        reviewType: body.reviewType === "comparative" ? "comparative" : "initial",
        status,
        pending: content,
        scriptContent: status === "complete" ? content : null,
        errorMessage:
          status === "failed"
            ? typeof body.errorMessage === "string"
              ? body.errorMessage
              : "Review generation failed (seeded)"
            : null,
        createdAt: new Date(at).toISOString(),
        updatedAt: new Date(at).toISOString(),
        readyAtMs:
          status === "processing"
            ? at + (typeof body.readyInMs === "number" ? body.readyInMs : s.current().processingMs)
            : at,
      }
      s.reviews.insert(String(review.id), review)
      return json(201, review)
    },
    "GET /settings": ({ namespace }) => json(200, state(namespace).current()),
    "PUT /settings": ({ body, namespace }) => {
      if (!isRecord(body)) return adminError(400, "expected a JSON object")
      const patch: Partial<Settings> = {}
      if (body.apiKeys !== undefined) {
        if (!Array.isArray(body.apiKeys)) return adminError(400, "apiKeys: string[]")
        patch.apiKeys = body.apiKeys.map(String)
      }
      if (body.processingMs !== undefined) {
        if (typeof body.processingMs !== "number" || body.processingMs < 0)
          return adminError(400, "processingMs: ms >= 0")
        patch.processingMs = body.processingMs
      }
      return json(200, state(namespace).update(patch))
    },
    "POST /tick": ({ namespace }) => json(200, { settled: runtime.instance(namespace).tick() }),
  }
}

/**
 * The Makor CPG mock with Mockingbird's full service contract: `/health`, `/__admin/*`,
 * namespaces by header, by `/ns/<name>` path prefix, or by API key
 * (`PUT /__admin/credentials {"credentials": {"<x-api-key>": "<namespace>"}}`), clock control,
 * fault presets, a request journal (ids only, never intake text or summaries) and permissive
 * CORS for the browser-direct EMR calls.
 */
export const createRuntime = (options: MakorCpgRuntimeOptions = {}): MakorCpgRuntime => {
  const runtime = createServiceRuntime<MakorCpgAPI>({
    name: MAKOR_CPG_NAMESPACE,
    document,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    credential: apiKeyCredential,
    presets: MAKOR_CPG_PRESETS,
    create: ({ sqlite, namespace, clock }) =>
      new MakorCpgAPI({
        sqlite,
        namespace,
        now: clock.now,
        ...(options.settings ? { settings: options.settings } : {}),
      }),
    admin: adminRoutes,
  })
  const inner = runtime.fetch
  return Object.assign(runtime, {
    fetch: async (request: Request): Promise<Response> => {
      if (request.method === "OPTIONS") {
        return withCors(request, new Response(null, { status: 204 }))
      }
      return withCors(request, await inner(request))
    },
  })
}
