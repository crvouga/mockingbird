import {
  type AdminRoutes,
  basicAuth,
  bearerToken,
  type Clock,
  createRuntime as createServiceRuntime,
  type FaultPreset,
  jsonRes,
  type MockControls,
  type RequestLog,
  type ServiceRuntime,
} from "@crvouga/mockingbird-service"
import { document } from "./generated/openapi.js"
import {
  type ActivityLogEntry,
  FITBIT_NAMESPACE,
  FitbitAPI,
  type FitbitAPIOptions,
  type SleepLogEntry,
} from "./index.js"

const envelope = (status: number, errorType: string, message: string) => ({
  status,
  body: { errors: [{ errorType, message }], success: false },
})
const limited = (retryAfter: boolean): FaultPreset => ({
  description: retryAfter
    ? "Rate limit reached: 429 with Retry-After: 2 and the fitbit-rate-limit-* headers. Body and headers are a best guess."
    : "Rate limit reached: 429 without Retry-After. Body and headers are a best guess.",
  rules: [
    {
      ...envelope(429, "too_many_requests", "Too Many Requests"),
      headers: {
        ...(retryAfter ? { "retry-after": "2" } : {}),
        "fitbit-rate-limit-limit": "150",
        "fitbit-rate-limit-remaining": "0",
        "fitbit-rate-limit-reset": "2",
      },
    },
  ],
})
export const FITBIT_PRESETS: Record<string, FaultPreset> = {
  unauthorized: {
    description: "Expired access token: 401 expired_token. Envelope is a best guess.",
    rules: [envelope(401, "expired_token", "Access token expired.")],
  },
  forbidden: {
    description: "Missing scope: 403 insufficient_scope. Envelope is a best guess.",
    rules: [
      envelope(
        403,
        "insufficient_scope",
        "This application does not have permission to access this resource.",
      ),
    ],
  },
  rate_limited: limited(true),
  rate_limited_no_retry_after: limited(false),
  server_error: {
    description: "Scripted server failure",
    rules: [envelope(500, "system", "Internal Server Error")],
  },
  connection_drop: { description: "Dropped connection", rules: [{ drop: true }] },
}

export type FitbitRuntimeOptions = Omit<FitbitAPIOptions, "now" | "namespace"> & {
  clock?: Clock
  seed?: string | number
  adminPrefix?: string
  adminKey?: string
  /** Admin controls to boot with: clock, latency, faults, seed, a starting snapshot. */
  adminControls?: MockControls
  onLog?: (entry: RequestLog) => void
}
export type FitbitRuntime = ServiceRuntime<FitbitAPI>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const adminError = (status: number, message: string) =>
  jsonRes(status, { error: { type: "mockingbird_admin", message } })

const adminRoutes = (runtime: FitbitRuntime): AdminRoutes => ({
  "GET /consent": ({ namespace }) =>
    jsonRes(200, runtime.instance(namespace).settings.get("consent") ?? { mode: "approve" }),
  // Decide what the authorize page does next: approve (default), deny, or error; and for which user.
  "PUT /consent": ({ body, namespace }) => {
    const api = runtime.instance(namespace)
    if (!isRecord(body) || !["approve", "deny", "error"].includes(String(body.mode)))
      return adminError(400, 'expected {"mode": "approve"|"deny"|"error", "userId"?: string}')
    if (
      body.userId !== undefined &&
      (typeof body.userId !== "string" || !api.users.has(body.userId))
    )
      return adminError(404, `no user ${String(body.userId)}`)
    const consent = {
      mode: body.mode as "approve" | "deny" | "error",
      ...(typeof body.userId === "string" ? { userId: body.userId } : {}),
    }
    api.setConsent(consent)
    return jsonRes(200, consent)
  },
  "POST /users": ({ body, namespace }) => {
    if (!isRecord(body) || typeof body.encodedId !== "string")
      return adminError(400, 'expected {"encodedId": string, "profile"?: object}')
    const user = {
      encodedId: body.encodedId,
      ...(isRecord(body.profile) ? { profile: body.profile } : {}),
    }
    runtime.instance(namespace).users.insert(user.encodedId, user)
    return jsonRes(201, user)
  },
  "POST /activity-logs": ({ body, namespace }) => {
    const api = runtime.instance(namespace)
    const userId = isRecord(body) && typeof body.userId === "string" ? body.userId : "ABC123"
    if (!isRecord(body) || !Array.isArray(body.logs) || !body.logs.every(isRecord))
      return adminError(400, 'expected {"userId"?: string, "logs": [{logId, startTime, ...}]}')
    if (!api.users.has(userId)) return adminError(404, `no user ${userId}`)
    for (const log of body.logs) api.addActivityLog(userId, log as ActivityLogEntry)
    return jsonRes(201, { created: body.logs.length })
  },
  "POST /sleep-logs": ({ body, namespace }) => {
    const api = runtime.instance(namespace)
    const userId = isRecord(body) && typeof body.userId === "string" ? body.userId : "ABC123"
    if (!isRecord(body) || !Array.isArray(body.logs) || !body.logs.every(isRecord))
      return adminError(
        400,
        'expected {"userId"?: string, "logs": [{logId, startTime, endTime, ...}]}',
      )
    if (!api.users.has(userId)) return adminError(404, `no user ${userId}`)
    for (const log of body.logs) api.addSleepLog(userId, log as SleepLogEntry)
    return jsonRes(201, { created: body.logs.length })
  },
  "POST /daily-summaries": ({ body, namespace }) => {
    const api = runtime.instance(namespace)
    if (!isRecord(body) || typeof body.date !== "string")
      return adminError(
        400,
        'expected {"userId"?: string, "date": "YYYY-MM-DD", "activities"?, "goals"?, "summary"?}',
      )
    const userId = typeof body.userId === "string" ? body.userId : "ABC123"
    if (!api.users.has(userId)) return adminError(404, `no user ${userId}`)
    api.setDailySummary({
      userId,
      date: body.date,
      ...(Array.isArray(body.activities) ? { activities: body.activities.filter(isRecord) } : {}),
      ...(isRecord(body.goals) ? { goals: body.goals } : {}),
      ...(isRecord(body.summary) ? { summary: body.summary } : {}),
    })
    return jsonRes(201, { userId, date: body.date })
  },
  // Make a user's access tokens expired now (refresh tokens still work), without moving the clock.
  "POST /tokens/expire": ({ body, namespace }) => {
    if (!isRecord(body) || typeof body.userId !== "string")
      return adminError(400, 'expected {"userId": string}')
    return jsonRes(200, { expired: runtime.instance(namespace).expireTokens(body.userId) })
  },
  // Revoke every token of a user, so the next refresh answers invalid_grant.
  "POST /tokens/revoke": ({ body, namespace }) => {
    if (!isRecord(body) || typeof body.userId !== "string")
      return adminError(400, 'expected {"userId": string}')
    return jsonRes(200, { revoked: runtime.instance(namespace).revokeTokens(body.userId) })
  },
})

export const createRuntime = (options: FitbitRuntimeOptions = {}): FitbitRuntime =>
  createServiceRuntime({
    name: FITBIT_NAMESPACE,
    document,
    presets: FITBIT_PRESETS,
    credential: (request) => bearerToken(request) ?? basicAuth(request)?.username,
    admin: adminRoutes,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminPrefix ? { adminPrefix: options.adminPrefix } : {}),
    ...(options.adminKey ? { adminKey: options.adminKey } : {}),
    ...(options.adminControls !== undefined ? { adminControls: options.adminControls } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    create: ({ sqlite, namespace, clock }) =>
      new FitbitAPI({ ...options, sqlite, namespace, now: clock.now }),
  })
