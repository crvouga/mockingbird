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
import { DEFAULT_ADMIN_KEY, OpenAIAPI, type OpenAIAPIOptions } from "./index.js"
import { object } from "./state.js"
import { createVaultKey } from "./vault.js"

const errorBody = (message: string, type: string, code: string) => ({
  error: { message, type, param: null, code },
})
export const OPENAI_PRESETS: Record<string, FaultPreset> = {
  rate_limited: {
    description: "Reject one request with a retryable vendor 429",
    rules: [
      {
        count: 1,
        status: 429,
        headers: { "retry-after-ms": "1", "retry-after": "1", "x-request-id": "fixture-request" },
        body: errorBody("Rate limit reached.", "rate_limit_error", "rate_limit_exceeded"),
      },
    ],
  },
  server_error: {
    description: "Reject one request before consuming its script",
    rules: [
      {
        count: 1,
        status: 500,
        headers: { "retry-after-ms": "1", "retry-after": "1", "x-request-id": "fixture-request" },
        body: errorBody("Internal server error.", "server_error", "internal_error"),
      },
    ],
  },
  service_unavailable: {
    description: "Reject one request with vendor 503",
    rules: [
      {
        count: 1,
        status: 503,
        headers: { "retry-after-ms": "1", "retry-after": "1", "x-request-id": "fixture-request" },
        body: errorBody("Service unavailable.", "server_error", "service_unavailable"),
      },
    ],
  },
  network_reset: {
    description: "Drop one request before consuming its script",
    rules: [{ count: 1, drop: true }],
  },
  invalid_json: {
    description: "Return malformed JSON from one chat request",
    rules: [{ count: 1, operationId: "CreateChatCompletion", effect: "invalid_json" }],
  },
  malformed_stream: {
    description: "Return a malformed Chat SSE frame",
    rules: [{ count: 1, operationId: "CreateChatCompletion", effect: "malformed_stream" }],
  },
  content_refusal: {
    description: "Return a scripted content refusal",
    rules: [{ count: 1, operationId: "CreateChatCompletion", effect: "content_refusal" }],
  },
  slow_response: {
    description: "Delay one request before dispatch for abort tests",
    rules: [{ count: 1, delayMs: 50 }],
  },
}
export type OpenAIRuntimeOptions = Omit<
  OpenAIAPIOptions,
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
export type OpenAIRuntime = ServiceRuntime<OpenAIAPI>
const fail = (status: number, message: string) =>
  Response.json({ error: { type: "mockingbird_admin", message } }, { status })
const routes = (runtime: OpenAIRuntime): AdminRoutes => ({
  "POST /scripts": ({ namespace, body }) => {
    try {
      return Response.json(runtime.instance(namespace).queue(body), { status: 201 })
    } catch {
      return fail(400, "Invalid script")
    }
  },
  "GET /scripts": ({ namespace }) =>
    Response.json({
      scripts: runtime
        .instance(namespace)
        .state.scripts.list({ order: "oldest" })
        .map(({ value: { id, kind, consumed } }) => ({ id, kind, consumed })),
    }),
  "POST /raw-faults": ({ namespace, body }) => {
    try {
      return Response.json(runtime.instance(namespace).queueRaw(body), { status: 201 })
    } catch {
      return fail(400, "Invalid raw fault")
    }
  },
  "GET /request-metadata": ({ namespace }) =>
    Response.json({
      requests: runtime
        .instance(namespace)
        .state.requests.list({ order: "oldest" })
        .map((r) => r.value),
    }),
  "POST /request-assertions": ({ namespace, body }) => {
    const b = object(body)
    const expected = b.fingerprints
    if (
      Object.keys(b).some((k) => k !== "fingerprints") ||
      !Array.isArray(expected) ||
      expected.some((v) => typeof v !== "string" || !/^[a-f0-9]{64}$/.test(v))
    )
      return fail(400, "fingerprints must be an ordered array of SHA-256 request hashes")
    const actual = runtime
      .instance(namespace)
      .state.requests.list({ order: "oldest" })
      .map((r) => r.value.fingerprint)
    return Response.json({
      matches: JSON.stringify(actual) === JSON.stringify(expected),
      count: actual.length,
    })
  },
  "GET /stream-metadata": ({ namespace }) =>
    Response.json({
      streams: runtime
        .instance(namespace)
        .state.streams.list()
        .map((r) => r.value),
    }),
  "GET /upload-metadata": ({ namespace }) =>
    Response.json({
      uploads: runtime
        .instance(namespace)
        .state.uploads.list()
        .map(
          ({ value: { file_expires_after: _expiry, completed_parts: _parts, ...value } }) => value,
        ),
    }),
})
export const createRuntime = (options: OpenAIRuntimeOptions = {}): OpenAIRuntime => {
  const adminKey = options.adminKey ?? DEFAULT_ADMIN_KEY
  if (!adminKey) throw new Error("OpenAI adminKey must not be empty")
  const vaultKey = options.vaultKey ?? createVaultKey()
  return createServiceRuntime({
    name: "openai",
    document,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminPrefix !== undefined ? { adminPrefix: options.adminPrefix } : {}),
    adminKey,
    ...(options.adminControls !== undefined ? { adminControls: options.adminControls } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    create: ({ sqlite, namespace, publicNamespace, clock }) =>
      new OpenAIAPI({ ...options, sqlite, namespace, publicNamespace, now: clock.now, vaultKey }),
    credential: bearerToken,
    presets: OPENAI_PRESETS,
    admin: routes,
  })
}
