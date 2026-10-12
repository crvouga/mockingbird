import {
  type AdminRoutes,
  type Clock,
  createRuntime as createServiceRuntime,
  type FaultPreset,
  type MockControls,
  type RequestLog,
  type RuntimeIO,
  type ServiceRuntime,
} from "@crvouga/mockingbird-service"
import type { ErrorDetail } from "./errors.js"
import { document } from "./generated/openapi.js"
import {
  API_KEY_HEADER,
  ELEVENLABS_NAMESPACE,
  ElevenLabsAPI,
  type ElevenLabsAPIOptions,
} from "./index.js"
import { parseKeys, parseModels, parseVoices } from "./state.js"
import { createVaultKey } from "./vault.js"

/** The `request_id` (and `x-trace-id`) every preset answers with. */
const PRESET_TRACE_ID = "00000000000000000000000000000000"

const failure = (
  httpStatus: number,
  detail: Omit<ErrorDetail, "request_id">,
): Pick<NonNullable<FaultPreset["rules"]>[number], "count" | "status" | "headers" | "body"> => ({
  // One answer, then the rule retires: the request after it reaches the mock again.
  count: 1,
  status: httpStatus,
  headers: { "x-trace-id": PRESET_TRACE_ID },
  body: { detail: { ...detail, request_id: PRESET_TRACE_ID } },
})

/**
 * Vendor failures a suite switches on by name: `POST /__admin/faults/presets/<name>`, with
 * `{"count": n}` to fail more than the next request. Each fires in front of the mock, so the
 * failed request records no call and uses up no script.
 */
export const ELEVENLABS_PRESETS: Record<string, FaultPreset> = {
  invalid_api_key: {
    description: "Reject one request with 401: the key is not valid",
    rules: [
      failure(401, {
        type: "authentication_error",
        code: "unauthorized",
        message: "Invalid API key",
        status: "invalid_api_key",
      }),
    ],
  },
  quota_exceeded: {
    description: "Reject one request with 402: the account is out of credits",
    rules: [
      failure(402, {
        type: "payment_required",
        code: "insufficient_credits",
        message: "Your account does not have enough credits for this operation.",
        status: "quota_exceeded",
      }),
    ],
  },
  rate_limited: {
    description: "Reject one request with 429: too many requests",
    rules: [
      failure(429, {
        type: "rate_limit_error",
        code: "rate_limit_exceeded",
        message: "Too many requests. Wait before retrying.",
        status: "rate_limit_exceeded",
      }),
    ],
  },
  too_many_concurrent_requests: {
    description: "Reject one request with 429: the plan's concurrency limit is reached",
    rules: [
      failure(429, {
        type: "rate_limit_error",
        code: "concurrent_limit_exceeded",
        message:
          "Maximum number of concurrent requests exceeded. Higher subscription tiers have a higher concurrency limit.",
        status: "too_many_concurrent_requests",
      }),
    ],
  },
  system_busy: {
    description: "Reject one request with 429: the vendor is under heavy load",
    rules: [
      failure(429, {
        type: "rate_limit_error",
        code: "system_busy",
        message: "The system is currently busy. Try again later.",
        status: "system_busy",
      }),
    ],
  },
  server_error: {
    description: "Reject one request with 500",
    rules: [
      failure(500, {
        type: "internal_error",
        code: "internal_error",
        message: "An unexpected error occurred. Contact support if this persists.",
        status: "internal_error",
      }),
    ],
  },
  service_unavailable: {
    description: "Reject one request with 503",
    rules: [
      failure(503, {
        type: "service_unavailable",
        code: "service_unavailable",
        message: "The service is temporarily unavailable. Try again later.",
        status: "service_unavailable",
      }),
    ],
  },
  network_reset: {
    description: "Drop the connection of one request without answering",
    rules: [{ count: 1, drop: true }],
  },
  slow_response: {
    description:
      "Hold one request back 250 ms before the mock sees it, for timeout and abort tests",
    rules: [{ count: 1, latencyMs: 250 }],
  },
}

export type ElevenLabsRuntimeOptions = Omit<
  ElevenLabsAPIOptions,
  "now" | "namespace" | "publicNamespace"
> & {
  clock?: Clock
  seed?: number | string
  adminPrefix?: string
  adminKey?: string
  /** Admin controls to boot with: clock, latency, faults, seed, a starting snapshot. */
  adminControls?: MockControls
  onLog?: (entry: RequestLog) => void
  /** Replace the process clock and sleep, e.g. to make a `latencyMs` fault take no real time. */
  io?: Partial<RuntimeIO>
}

export type ElevenLabsRuntime = ServiceRuntime<ElevenLabsAPI>

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const adminError = (status: number, message: string) =>
  json(status, { error: { type: "mockingbird_admin", message } })
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Run an admin write, turning a rejected body into a 400 that says why. */
const attempt = (write: () => Response): Response => {
  try {
    return write()
  } catch (error) {
    return adminError(400, error instanceof Error ? error.message : String(error))
  }
}

const adminRoutes = (runtime: ElevenLabsRuntime): AdminRoutes => ({
  "GET /voices": ({ namespace }) =>
    json(200, {
      voices: runtime
        .instance(namespace)
        .state.voices.list({ order: "oldest" })
        .map((row) => row.value),
    }),
  "PUT /voices": ({ body, namespace }) =>
    attempt(() => {
      const voices = parseVoices(isRecord(body) ? body.voices : undefined)
      return json(200, { count: runtime.instance(namespace).state.putVoices(voices) })
    }),
  "GET /models": ({ namespace }) =>
    json(200, {
      models: runtime
        .instance(namespace)
        .state.models.list({ order: "oldest" })
        .map((row) => row.value),
    }),
  "PUT /models": ({ body, namespace }) =>
    attempt(() => {
      const models = parseModels(isRecord(body) ? body.models : undefined)
      return json(200, { count: runtime.instance(namespace).state.putModels(models) })
    }),
  "GET /keys": ({ namespace }) =>
    json(200, {
      keys: runtime
        .instance(namespace)
        .state.keys.list({ order: "oldest" })
        .map((row) => row.value),
    }),
  "PUT /keys": ({ body, namespace }) =>
    attempt(() => {
      const keys = parseKeys(isRecord(body) ? body.keys : undefined)
      return json(200, { count: runtime.instance(namespace).state.putKeys(keys) })
    }),
  "GET /scripts": ({ namespace }) => json(200, { scripts: runtime.instance(namespace).scripts() }),
  "POST /scripts": ({ body, namespace }) =>
    attempt(() => json(201, runtime.instance(namespace).queue(body))),
  "DELETE /scripts": ({ namespace }) =>
    json(200, { deleted: runtime.instance(namespace).clearScripts() }),
  "GET /calls": ({ url, namespace }) => {
    const fingerprint = url.searchParams.get("fingerprint")
    const calls = runtime
      .instance(namespace)
      .calls()
      .filter((call) => fingerprint === null || call.fingerprint === fingerprint)
    const counts: Record<string, number> = {}
    for (const call of calls) counts[call.fingerprint] = (counts[call.fingerprint] ?? 0) + 1
    return json(200, { count: calls.length, by_fingerprint: counts, calls })
  },
})

/**
 * The ElevenLabs mock with Mockingbird's full service contract: `/__admin/health`,
 * `/__admin/*`, namespaces by header, by `/__admin/ns/<name>` path prefix, or by API key
 * (`PUT /__admin/credentials {"credentials": {"<ELEVENLABS_API_KEY>": "<namespace>"}}`), clock
 * control, fault presets and a request journal.
 */
export const createRuntime = (options: ElevenLabsRuntimeOptions = {}): ElevenLabsRuntime => {
  const { clock, seed, adminPrefix, adminKey, adminControls, onLog, io, ...api } = options
  // One key for every namespace and history branch, so a restored script still opens.
  const vaultKey = api.vaultKey ?? createVaultKey()
  return createServiceRuntime<ElevenLabsAPI>({
    name: ELEVENLABS_NAMESPACE,
    document,
    ...(api.sqlite ? { sqlite: api.sqlite } : {}),
    ...(clock ? { clock } : {}),
    ...(seed !== undefined ? { seed } : {}),
    ...(adminPrefix !== undefined ? { adminPrefix } : {}),
    ...(adminKey !== undefined ? { adminKey } : {}),
    ...(adminControls !== undefined ? { adminControls } : {}),
    ...(onLog ? { onLog } : {}),
    ...(io ? { io } : {}),
    credential: (request) => request.headers.get(API_KEY_HEADER) ?? undefined,
    presets: ELEVENLABS_PRESETS,
    create: ({ sqlite, namespace, publicNamespace, clock: instanceClock }) =>
      new ElevenLabsAPI({
        ...api,
        sqlite,
        namespace,
        publicNamespace,
        now: instanceClock.now,
        vaultKey,
      }),
    admin: adminRoutes,
  })
}
