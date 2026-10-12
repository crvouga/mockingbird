import {
  type AdminRoutes,
  bearerToken,
  type Clock,
  createRuntime as createServiceRuntime,
  type FaultPreset,
  type MockControls,
  type RequestLog,
  type ServiceRuntime,
} from "@crvouga/mockingbird-service"
import { adsFailure, record } from "./errors.js"
import { document } from "./generated/openapi.js"
import { DEFAULT_ADMIN_KEY, GoogleAdsAPI, type GoogleAdsAPIOptions } from "./index.js"
import { createVaultKey } from "./vault.js"

const faultBody = (
  status: number,
  name: string,
  kind: string,
  code: string,
  message: string,
  details?: Record<string, unknown>,
) => ({
  error: {
    code: status,
    message,
    status: code,
    details: [
      adsFailure(
        [{ errorCode: { [kind]: name }, message, ...(details ? { details } : {}) }],
        "fixture-request",
      ),
    ],
  },
})
// Google carries the backoff in QuotaErrorDetails (a protobuf JSON Duration), not an HTTP header.
const quotaFault = (name: string, message: string) => ({
  count: 1,
  status: 429,
  headers: { "request-id": "fixture-request" },
  body: faultBody(429, name, "quotaError", "RESOURCE_EXHAUSTED", message, {
    quotaErrorDetails: { rateScope: "ACCOUNT", rateName: "Requests per account", retryDelay: "1s" },
  }),
})
export const GOOGLE_ADS_PRESETS: Record<string, FaultPreset> = {
  quota_exhausted: {
    description: "Reject one request before mutation with Google RPC quota exhaustion",
    rules: [quotaFault("RESOURCE_EXHAUSTED", "Too many requests.")],
  },
  rate_limited: {
    description: "Reject one request before mutation with Google's short-term rate limit",
    rules: [
      quotaFault("RESOURCE_TEMPORARILY_EXHAUSTED", "Too many requests in a short amount of time."),
    ],
  },
  server_error: {
    description: "Reject one request before mutation",
    rules: [
      {
        count: 1,
        status: 500,
        headers: { "request-id": "fixture-request" },
        body: faultBody(500, "INTERNAL_ERROR", "internalError", "INTERNAL", "INTERNAL_ERROR"),
      },
    ],
  },
  network_reset: {
    description: "Drop one request before dispatch",
    rules: [{ count: 1, drop: true }],
  },
  slow_response: {
    description: "Delay one request by 50 milliseconds",
    rules: [{ count: 1, delayMs: 50 }],
  },
  ambiguous_budget_write: {
    description:
      "Commit the next executed budget mutation then return 503; inspect before replaying",
    rules: [{ count: 1, operationId: "MutateCampaignBudgets", effect: "ambiguous_mutation" }],
  },
  partial_budget_failure: {
    description: "Fail the last operation in one budget batch",
    rules: [{ count: 1, operationId: "MutateCampaignBudgets", effect: "partial_failure" }],
  },
  partial_conversion_failure: {
    description: "Fail the last row in one conversion batch",
    rules: [{ count: 1, operationId: "UploadClickConversions", effect: "partial_failure" }],
  },
}
export type GoogleAdsRuntimeOptions = Omit<
  GoogleAdsAPIOptions,
  "now" | "namespace" | "publicNamespace"
> & {
  adminPrefix?: string
  clock?: Clock
  seed?: number | string
  adminKey?: string
  /** Admin controls to boot with: clock, latency, faults, seed, a starting snapshot. */
  adminControls?: MockControls
  onLog?: (entry: RequestLog) => void
}
export type GoogleAdsRuntime = ServiceRuntime<GoogleAdsAPI>
const routes = (runtime: GoogleAdsRuntime): AdminRoutes => {
  const guarded = (fn: () => Response): Response => {
    try {
      return fn()
    } catch {
      return Response.json({ error: "Invalid fixture control" }, { status: 400 })
    }
  }
  return {
    "GET /events": ({ namespace }) =>
      Response.json({ events: runtime.instance(namespace).inspectEvents() }),
    "GET /conversions": ({ namespace }) =>
      Response.json({ conversions: runtime.instance(namespace).inspectConversions() }),
    "GET /budgets": ({ namespace }) =>
      Response.json({
        budgets: runtime
          .instance(namespace)
          .state.budgets.list({ order: "oldest" })
          .map((r) => r.value),
      }),
    "GET /budget-mutations": ({ namespace }) =>
      Response.json({
        mutations: runtime
          .instance(namespace)
          .state.mutations.list({ order: "oldest" })
          .map((r) => r.value),
      }),
    "GET /request-metadata": ({ namespace }) =>
      Response.json({
        requests: runtime
          .instance(namespace)
          .state.requests.list({ order: "oldest" })
          .map((r) => r.value),
      }),
    "POST /daily-metrics": ({ namespace, body }) =>
      guarded(() =>
        Response.json({ inserted: runtime.instance(namespace).seedMetrics(body) }, { status: 201 }),
      ),
    "POST /page-tokens/expire": ({ namespace }) =>
      Response.json({ expired: runtime.instance(namespace).expirePageTokens() }),
    "GET /settings": ({ namespace }) => Response.json(runtime.instance(namespace).state.view()),
    "PUT /settings": ({ namespace, body }) =>
      guarded(() => {
        const api = runtime.instance(namespace)
        api.configure(record(body))
        return Response.json(api.state.view())
      }),
  }
}
export const createRuntime = (options: GoogleAdsRuntimeOptions = {}): GoogleAdsRuntime => {
  const adminKey = options.adminKey ?? DEFAULT_ADMIN_KEY
  if (!adminKey) throw new Error("Google Ads adminKey must not be empty")
  const vaultKey = options.vaultKey ?? createVaultKey()
  return createServiceRuntime({
    name: "google-ads",
    document,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminPrefix !== undefined ? { adminPrefix: options.adminPrefix } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    adminKey,
    ...(options.adminControls !== undefined ? { adminControls: options.adminControls } : {}),
    create: ({ sqlite, namespace, publicNamespace, clock }) =>
      new GoogleAdsAPI({
        ...options,
        sqlite,
        namespace,
        publicNamespace,
        now: clock.now,
        vaultKey,
      }),
    credential: bearerToken,
    presets: GOOGLE_ADS_PRESETS,
    admin: routes,
  })
}
