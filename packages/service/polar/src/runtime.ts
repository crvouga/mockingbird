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
import { document } from "./generated/openapi.js"
import {
  type ConsentMode,
  type ExerciseSeed,
  POLAR_NAMESPACE,
  PolarAPI,
  type PolarAPIOptions,
  type RegistrationSeed,
  type User,
} from "./index.js"

const apiError = (status: number, errorType: string, message: string) => ({
  error: { status, errorType, message },
})
// AccessLink sends "short term, long term" pairs. These are the documented default limits
// (500 per 15 minutes, 5000 per 24 hours), here exhausted.
const RATE_LIMIT_HEADERS = {
  "ratelimit-usage": "501, 501",
  "ratelimit-limit": "500, 5000",
  "ratelimit-reset": "899, 86399",
}
export const POLAR_PRESETS: Record<string, FaultPreset> = {
  unauthorized: {
    description: "Revoked or invalid access token (tokens have no refresh)",
    rules: [
      {
        status: 401,
        body: apiError(401, "Unauthorized", "Access token is missing, invalid or revoked."),
      },
    ],
  },
  rate_limited: {
    description: "Rate limit exceeded: RateLimit-* headers, no Retry-After",
    rules: [
      {
        status: 429,
        body: apiError(429, "Too Many Requests", "Rate limit exceeded."),
        headers: RATE_LIMIT_HEADERS,
      },
    ],
  },
  rate_limited_retry_after: {
    description: "Rate limit exceeded: RateLimit-* headers and Retry-After: 5",
    rules: [
      {
        status: 429,
        body: apiError(429, "Too Many Requests", "Rate limit exceeded."),
        headers: { ...RATE_LIMIT_HEADERS, "retry-after": "5" },
      },
    ],
  },
  server_error: {
    description: "Scripted server failure",
    rules: [{ status: 500, body: apiError(500, "Internal Server Error", "Internal error.") }],
  },
  connection_drop: { description: "Dropped connection", rules: [{ drop: true }] },
}

export type PolarRuntimeOptions = Omit<PolarAPIOptions, "now" | "namespace"> & {
  clock?: Clock
  seed?: string | number
  adminPrefix?: string
  adminKey?: string
  /** Admin controls to boot with: clock, latency, faults, seed, a starting snapshot. */
  adminControls?: MockControls
  onLog?: (entry: RequestLog) => void
}
export type PolarRuntime = ServiceRuntime<PolarAPI>

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const adminError = (status: number, message: string) =>
  json(status, { error: { type: "mockingbird_admin", message } })
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const CONSENT_MODES: readonly ConsentMode[] = ["approve", "deny", "error"]

const adminRoutes = (runtime: ServiceRuntime<PolarAPI>): AdminRoutes => ({
  "GET /settings": ({ namespace }) => json(200, runtime.instance(namespace).settings()),
  "PUT /settings": ({ body, namespace }) => {
    if (!isRecord(body)) return adminError(400, "expected a JSON object")
    const patch: { consent?: ConsentMode; consentUser?: number | null } = {}
    if (body.consent !== undefined) {
      if (!CONSENT_MODES.includes(body.consent as ConsentMode))
        return adminError(400, `consent: ${CONSENT_MODES.join(" | ")}`)
      patch.consent = body.consent as ConsentMode
    }
    if (body.consentUser !== undefined) {
      if (body.consentUser !== null && !Number.isInteger(body.consentUser))
        return adminError(400, "consentUser: integer | null")
      patch.consentUser = body.consentUser as number | null
    }
    return json(200, runtime.instance(namespace).updateSettings(patch))
  },
  "POST /users": ({ body, namespace }) => {
    if (!isRecord(body) || !Number.isInteger(body.xUserId))
      return adminError(400, 'expected {"xUserId": integer, "firstName"?, "lastName"?, ...}')
    return json(201, runtime.instance(namespace).addUser(body as User))
  },
  "POST /registrations": ({ body, namespace }) => {
    if (
      !isRecord(body) ||
      !Number.isInteger(body.xUserId) ||
      typeof body.memberId !== "string" ||
      typeof body.registeredAt !== "string"
    )
      return adminError(
        400,
        'expected {"xUserId": integer, "memberId": string, "registeredAt": ISO date-time, "clientId"?}',
      )
    try {
      return json(201, runtime.instance(namespace).addRegistration(body as RegistrationSeed))
    } catch (error) {
      return adminError(400, error instanceof Error ? error.message : String(error))
    }
  },
  "POST /exercises": ({ body, namespace }) => {
    if (
      !isRecord(body) ||
      !Number.isInteger(body.xUserId) ||
      typeof body.id !== "string" ||
      typeof body.upload_time !== "string" ||
      typeof body.start_time !== "string"
    )
      return adminError(
        400,
        'expected {"xUserId": integer, "id": string, "upload_time": ISO, "start_time": ISO, ...exercise fields}',
      )
    try {
      const { data, ...row } = runtime.instance(namespace).addExercise(body as ExerciseSeed)
      return json(201, { ...row, ...data })
    } catch (error) {
      return adminError(400, error instanceof Error ? error.message : String(error))
    }
  },
  "POST /tokens/revoke": ({ body, namespace }) => {
    if (!isRecord(body) || typeof body.token !== "string")
      return adminError(400, 'expected {"token": string}')
    return runtime.instance(namespace).revoke(body.token)
      ? json(200, { revoked: true })
      : adminError(404, "no such access token")
  },
})

/**
 * The Polar AccessLink mock with Mockingbird's full service contract: `/__admin/health`,
 * `/__admin/*`, namespaces by header, by `/__admin/ns/<name>` path prefix or by bearer token,
 * clock control (the 30-day exercise window follows it), fault presets and a request journal.
 */
export const createRuntime = (options: PolarRuntimeOptions = {}): PolarRuntime =>
  createServiceRuntime({
    name: POLAR_NAMESPACE,
    document,
    presets: POLAR_PRESETS,
    credential: bearerToken,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminPrefix ? { adminPrefix: options.adminPrefix } : {}),
    ...(options.adminKey ? { adminKey: options.adminKey } : {}),
    ...(options.adminControls !== undefined ? { adminControls: options.adminControls } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    create: ({ sqlite, namespace, clock }) =>
      new PolarAPI({ ...options, sqlite, namespace, now: clock.now }),
    admin: adminRoutes,
  })
