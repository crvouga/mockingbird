import {
  type AdminRoutes,
  type Clock,
  createRuntime as createServiceRuntime,
  type FaultPreset,
  type MockControls,
  type RequestLog,
  type ServiceRuntime,
} from "@crvouga/mockingbird-service"
import { document } from "./generated/openapi.js"
import {
  accessToken,
  type SeedDailyStatistic,
  type SeedSample,
  type SeedWorkout,
  type Settings,
  SUUNTO_NAMESPACE,
  SuuntoAPI,
  type SuuntoAPIOptions,
} from "./index.js"

/** The data routes (workouts and 24/7), where the gateway and the API answer; not the OAuth origin. */
const DATA = "^/(v3/workouts|247)"

export const SUUNTO_PRESETS: Record<string, FaultPreset> = {
  unauthorized: {
    description: "Data calls answer the gateway's 401 (the consumer refreshes once and retries)",
    rules: [
      {
        pathPattern: DATA,
        status: 401,
        body: { statusCode: 401, message: "Unauthorized. Access token is missing or invalid." },
      },
    ],
  },
  invalid_subscription_key: {
    description: "Data calls answer the gateway's 401 for a wrong subscription key",
    rules: [
      {
        pathPattern: DATA,
        status: 401,
        body: {
          statusCode: 401,
          message:
            "Access denied due to invalid subscription key. Make sure to provide a valid key for an active subscription.",
        },
      },
    ],
  },
  rate_limited: {
    description:
      "Data calls answer 429 with Retry-After: 2 (body is the usual API Management form)",
    rules: [
      {
        pathPattern: DATA,
        status: 429,
        body: { statusCode: 429, message: "Rate limit is exceeded. Try again in 2 seconds." },
        headers: { "retry-after": "2" },
      },
    ],
  },
  rate_limited_no_retry_after: {
    description: "Data calls answer 429 without a Retry-After header",
    rules: [
      {
        pathPattern: DATA,
        status: 429,
        body: { statusCode: 429, message: "Rate limit is exceeded. Try again later." },
      },
    ],
  },
  server_error: {
    description: "Data calls answer 500",
    rules: [
      {
        pathPattern: DATA,
        status: 500,
        body: { statusCode: 500, message: "Internal server error" },
      },
    ],
  },
  error_in_body: {
    description: "Data calls answer 200 with the error in the body: {error, code: 429}",
    rules: [{ pathPattern: DATA, status: 200, body: { error: "rate_limited", code: 429 } }],
  },
  connection_drop: {
    description: "The connection drops before any answer (fetch rejects)",
    rules: [{ pathPattern: DATA, drop: true }],
  },
}

export type SuuntoRuntimeOptions = Omit<SuuntoAPIOptions, "now" | "namespace"> & {
  clock?: Clock
  seed?: string | number
  adminPrefix?: string
  adminKey?: string
  /** Admin controls to boot with: clock, latency, faults, seed, a starting snapshot. */
  adminControls?: MockControls
  onLog?: (entry: RequestLog) => void
}
export type SuuntoRuntime = ServiceRuntime<SuuntoAPI>

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const adminError = (status: number, message: string) =>
  json(status, { error: { type: "mockingbird_admin", message } })
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Run a seeding call on a JSON object body; a message from the seeder is a 400. */
const seeded = (seed: () => unknown, body: unknown) => {
  if (!isRecord(body)) return adminError(400, "expected a JSON object")
  try {
    return json(201, seed())
  } catch (error) {
    return adminError(400, error instanceof Error ? error.message : String(error))
  }
}

const SETTING_TYPES: Record<keyof Settings, (value: unknown) => boolean> = {
  subscriptionKey: (v) => v === null || (typeof v === "string" && v !== ""),
  accessTokenTtlSeconds: (v) => typeof v === "number" && Number.isInteger(v) && v > 0,
  codeTtlSeconds: (v) => typeof v === "number" && Number.isInteger(v) && v > 0,
  consent: (v) => v === "approve" || v === "deny" || v === "error",
  consentUser: (v) => v === null || typeof v === "string",
  scope: (v) => typeof v === "string",
  rotateRefreshTokens: (v) => typeof v === "boolean",
  maxWindowDays: (v) => typeof v === "number" && v > 0,
}

const adminRoutes = (runtime: ServiceRuntime<SuuntoAPI>): AdminRoutes => ({
  "GET /settings": ({ namespace }) => json(200, runtime.instance(namespace).current()),
  "PUT /settings": ({ body, namespace }) => {
    if (!isRecord(body)) return adminError(400, "expected a JSON object")
    const patch: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(body)) {
      const valid = SETTING_TYPES[key as keyof Settings]
      if (!valid) return adminError(400, `unknown setting ${key}`)
      if (!valid(value)) return adminError(400, `invalid value for ${key}`)
      patch[key] = value
    }
    return json(200, runtime.instance(namespace).updateSettings(patch as Partial<Settings>))
  },
  "POST /users": ({ body, namespace }) => {
    if (!isRecord(body) || typeof body.username !== "string" || !body.username)
      return adminError(400, 'expected {"username", "subject"?}')
    const api = runtime.instance(namespace)
    const subject =
      typeof body.subject === "string" && body.subject
        ? body.subject
        : `00000000-0000-4000-8000-${String(api.users.count() + 1).padStart(12, "0")}`
    const user = { subject, username: body.username }
    api.users.insert(subject, user)
    return json(201, user)
  },
  "POST /workouts": ({ body, namespace }) =>
    seeded(() => runtime.instance(namespace).seedWorkout(body as SeedWorkout), body),
  "POST /samples/:kind": ({ params, body, namespace }) =>
    params.kind === "sleep" || params.kind === "activity"
      ? seeded(
          () =>
            runtime
              .instance(namespace)
              .seedSample(params.kind as "sleep" | "activity", body as SeedSample),
          body,
        )
      : adminError(404, "kind is sleep or activity"),
  "POST /daily-statistics": ({ body, namespace }) =>
    seeded(() => runtime.instance(namespace).seedStatistic(body as SeedDailyStatistic), body),
  "POST /tokens": ({ body, namespace }) => {
    const input = isRecord(body) ? body : {}
    const api = runtime.instance(namespace)
    const users = api.users.list({ order: "oldest" }).map((r) => r.value)
    const user = users.find(
      (u) =>
        (typeof input.username !== "string" || u.username === input.username) &&
        (typeof input.subject !== "string" || u.subject === input.subject),
    )
    if (!user) return adminError(404, "no such user")
    const clientId = typeof input.clientId === "string" ? input.clientId : null
    const { access, refresh } = api.issueTokens(user, clientId)
    return json(201, { access_token: access, refresh_token: refresh })
  },
  "POST /tokens/expire": ({ body, namespace }) => {
    const token =
      isRecord(body) && typeof body.accessToken === "string" ? body.accessToken : undefined
    return json(200, { expired: runtime.instance(namespace).expireTokens(token) })
  },
})

export const createRuntime = (options: SuuntoRuntimeOptions = {}): SuuntoRuntime =>
  createServiceRuntime({
    name: SUUNTO_NAMESPACE,
    document,
    presets: SUUNTO_PRESETS,
    credential: accessToken,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminPrefix ? { adminPrefix: options.adminPrefix } : {}),
    ...(options.adminKey ? { adminKey: options.adminKey } : {}),
    ...(options.adminControls !== undefined ? { adminControls: options.adminControls } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    create: ({ sqlite, namespace, clock }) =>
      new SuuntoAPI({ ...options, sqlite, namespace, now: clock.now }),
    admin: adminRoutes,
  })
