import {
  type AdminRoutes,
  bearerToken,
  type Clock,
  createRuntime as createServiceRuntime,
  type FaultPreset,
  NAMESPACE_HEADER,
  parseSince,
  type RequestLog,
  type ServiceRuntime,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { requestToken } from "./body.js"
import { GEVITI_FLAG_STATE } from "./flag-state-fixture.js"
import { adminView, type FlagSpec, parseFlagSpec } from "./flags.js"
import { document } from "./generated/openapi.js"
import { type FlagStateFile, specsFromState } from "./import.js"
import { POSTHOG_NAMESPACE, PostHogAPI } from "./index.js"
import type { QueryResult, Settings } from "./state.js"

const FLAG_OPERATIONS = ["EvaluateFlags", "Decide"] as const

const flagRules = (rule: Record<string, unknown>) =>
  FLAG_OPERATIONS.map((operationId) => ({ operationId, ...rule }))

/**
 * Every named PostHog misbehaviour our consumers branch on, switched on with
 * `POST /__admin/faults {"preset": "<name>"}` (add `count` to limit it). All of them fault
 * `/flags` and `/decide` only; capture keeps working.
 */
export const POSTHOG_PRESETS: Record<string, FaultPreset> = {
  flags_5xx: {
    description: "/flags and /decide answer 500 (SDKs return undefined; our adapters fall back)",
    rules: flagRules({
      status: 500,
      body: {
        type: "server_error",
        code: "error",
        detail: "A server error occurred.",
        attr: null,
      },
    }),
  },
  flags_429: {
    description: "/flags and /decide answer 429 rate_limited",
    rules: flagRules({
      status: 429,
      body: {
        type: "validation_error",
        code: "rate_limited",
        detail: "Rate limit exceeded",
        attr: null,
      },
      headers: { "retry-after": "1" },
    }),
  },
  flags_hang: {
    description:
      "/flags and /decide answer after 1.5 s (trips the backend strict 1 s race and the EMR 1 s race)",
    rules: flagRules({ latencyMs: 1_500 }),
  },
  errors_while_computing: {
    description: "/flags answers errorsWhileComputingFlags: true (flags still present)",
    rules: flagRules({ effect: "errors_while_computing" }),
  },
  quota_limited: {
    description: '/flags answers quotaLimited: ["feature_flags"] with no flags',
    rules: flagRules({ effect: "quota_limited" }),
  },
  capture_5xx: {
    description: "Capture endpoints (/batch/, /e/, /i/v0/e/) answer 500",
    rules: ["CaptureBatch", "CaptureEvent", "CaptureEventV0"].map((operationId) => ({
      operationId,
      status: 500,
      body: { type: "server_error", code: "error", detail: "A server error occurred.", attr: null },
    })),
  },
}

export type PostHogRuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  seed?: number | string
  adminKey?: string
  onLog?: (entry: RequestLog) => void
  /** Flags every namespace starts with (and returns to on reset). */
  flags?: Record<string, FlagSpec>
  settings?: Partial<Settings>
}

export type PostHogRuntime = ServiceRuntime<PostHogAPI>

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const adminError = (status: number, message: string) =>
  json(status, { error: { type: "mockingbird_admin", message } })
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** `{flags: {key: spec}}`, `{key: spec}`, or `[{key, …spec}]`; a string is the error. */
const parseBulk = (body: unknown): Record<string, FlagSpec> | string => {
  const source = isRecord(body) && isRecord(body.flags) ? body.flags : body
  const entries: [string, unknown][] = Array.isArray(source)
    ? source.map((each) => [isRecord(each) ? String(each.key ?? "") : "", each])
    : isRecord(source)
      ? Object.entries(source).filter(([key]) => key !== "replace")
      : []
  if (!Array.isArray(source) && !isRecord(source)) return "expected {flags: {<key>: spec}}"
  const specs: Record<string, FlagSpec> = {}
  for (const [key, value] of entries) {
    if (!key) return "every flag needs a key"
    const spec = parseFlagSpec(value)
    if (typeof spec === "string") return `${key}: ${spec}`
    specs[key] = spec
  }
  return specs
}

const parseQueryResults = (value: unknown): QueryResult[] | string => {
  if (!Array.isArray(value)) return "queryResults: [{match?, columns?, results: [[…]]}]"
  const out: QueryResult[] = []
  for (const each of value) {
    if (!isRecord(each) || !Array.isArray(each.results) || !each.results.every(Array.isArray)) {
      return "each queryResults entry needs results: unknown[][]"
    }
    out.push({
      ...(typeof each.match === "string" ? { match: each.match } : {}),
      ...(Array.isArray(each.columns) ? { columns: each.columns.map(String) } : {}),
      results: each.results as unknown[][],
    })
  }
  return out
}

const adminRoutes = (runtime: ServiceRuntime<PostHogAPI>): AdminRoutes => {
  const api = (namespace: string) => runtime.instance(namespace)
  return {
    "GET /flags": ({ namespace }) => json(200, { flags: api(namespace).flagList() }),
    "GET /flags/evaluate": ({ url, namespace }) => {
      const distinctId = url.searchParams.get("distinct_id")
      if (!distinctId) return adminError(400, "distinct_id is required")
      const email = url.searchParams.get("email")
      const evaluations = api(namespace).evaluate({
        distinct_id: distinctId,
        ...(email ? { person_properties: { email } } : {}),
      })
      return json(200, {
        flags: Object.fromEntries(evaluations.map((e) => [e.key, e.value])),
      })
    },
    "GET /flags/:key": ({ params, namespace }) => {
      const flag = api(namespace).state.flags.get(params.key as string)
      return flag ? json(200, adminView(flag)) : adminError(404, `no flag ${params.key}`)
    },
    "PUT /flags/:key": ({ params, body, namespace }) => {
      const spec = parseFlagSpec(body)
      if (typeof spec === "string") return adminError(400, spec)
      return json(200, adminView(api(namespace).state.putFlag(params.key as string, spec)))
    },
    "DELETE /flags/:key": ({ params, namespace }) =>
      api(namespace).state.flags.delete(params.key as string)
        ? json(200, { deleted: params.key })
        : adminError(404, `no flag ${params.key}`),
    "PUT /flags": ({ body, namespace }) => {
      const specs = parseBulk(body)
      if (typeof specs === "string") return adminError(400, specs)
      const state = api(namespace).state
      if (isRecord(body) && body.replace === true) {
        for (const flag of state.listFlags()) state.flags.delete(flag.key)
      }
      for (const [key, spec] of Object.entries(specs)) state.putFlag(key, spec)
      return json(200, { flags: api(namespace).flagList() })
    },
    "POST /flags/import": ({ body, namespace }) => {
      const input = isRecord(body) ? body : {}
      const env = input.env ?? "dev"
      if (env !== "dev" && env !== "prod") return adminError(400, 'env must be "dev" or "prod"')
      const from = input.from ?? "state.json"
      let file: FlagStateFile
      if (isRecord(input.state) && Array.isArray(input.state.flags)) {
        file = input.state as unknown as FlagStateFile
      } else if (from === "state.json") {
        file = GEVITI_FLAG_STATE
      } else {
        return adminError(400, 'from must be "state.json" (the bundled copy) or pass "state"')
      }
      const project = typeof input.project === "string" ? input.project : undefined
      const specs = specsFromState(file, { env, ...(project ? { project } : {}) })
      const state = api(namespace).state
      if (input.replace === true) {
        for (const flag of state.listFlags()) state.flags.delete(flag.key)
      }
      for (const [key, spec] of Object.entries(specs)) state.putFlag(key, spec)
      return json(200, {
        imported: Object.keys(specs).length,
        env,
        project: project ?? "member-app",
      })
    },
    "POST /flags/bump": ({ namespace }) => {
      const state = api(namespace).state
      const next = state.update({ generation: state.current().generation + 1 })
      return json(200, {
        generation: next.generation,
        note: "Nothing changed server-side. Clear the app's flag caches now (backend 60 s per user, EMR frontend 60 s / 10 s).",
      })
    },
    "GET /events": ({ url, namespace }) => {
      const since = parseSince(url.searchParams.get("since"))
      if (since === null) return adminError(400, "since must be epoch ms or ISO-8601")
      const distinct = url.searchParams.get("distinct_id")
      const event = url.searchParams.get("event")
      return json(200, {
        events: api(namespace).events({
          ...(distinct !== null ? { distinct_id: distinct } : {}),
          ...(event !== null ? { event } : {}),
          ...(since !== undefined ? { since } : {}),
        }),
      })
    },
    "GET /recordings": ({ namespace }) =>
      json(200, { count: api(namespace).state.current().recordings }),
    "GET /settings": ({ namespace }) => json(200, api(namespace).state.current()),
    "PUT /settings": ({ body, namespace }) => {
      if (!isRecord(body)) return adminError(400, "expected a JSON object")
      const patch: Partial<Settings> = {}
      if (body.sessionRecording !== undefined) {
        if (typeof body.sessionRecording !== "boolean")
          return adminError(400, "sessionRecording: boolean")
        patch.sessionRecording = body.sessionRecording
      }
      if (body.queryResults !== undefined) {
        const parsed = parseQueryResults(body.queryResults)
        if (typeof parsed === "string") return adminError(400, parsed)
        patch.queryResults = parsed
      }
      return json(200, api(namespace).state.update(patch))
    },
  }
}

/**
 * The PostHog mock with Mockingbird's full service contract: `/health`, `/__admin/*`, clock,
 * fault presets and a request journal. PostHog SDKs cannot add headers, so a namespace is
 * chosen by the `/ns/<name>` host prefix (`POSTHOG_HOST=http://127.0.0.1:8795/ns/w1`), or by
 * project token: `PUT /__admin/credentials {"credentials": {"<phc_token>": "<namespace>"}}`.
 * The token is read from `/array/{token}/…`, `?token=`, the body (`token`, `api_key`, a
 * batch's first event), or a personal API key's `Authorization: Bearer`.
 */
export const createRuntime = (options: PostHogRuntimeOptions = {}): PostHogRuntime => {
  const tokens = new WeakMap<Request, string>()
  const runtime = createServiceRuntime<PostHogAPI>({
    name: POSTHOG_NAMESPACE,
    document,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    credential: (request) => tokens.get(request),
    presets: POSTHOG_PRESETS,
    create: ({ sqlite, namespace, clock }) =>
      new PostHogAPI({
        sqlite,
        namespace,
        now: clock.now,
        ...(options.flags ? { flags: options.flags } : {}),
        ...(options.settings ? { settings: options.settings } : {}),
      }),
    describe: () => ({ flagsImportedFrom: GEVITI_FLAG_STATE.generatedAt ?? null }),
    admin: adminRoutes,
  })
  const inner = runtime.fetch
  // The credential hook is synchronous and PostHog carries its token in the body, so peek at
  // it here (decoding once; the handler reuses the decoded body) before the runtime routes.
  const fetch = async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname
    if (
      !request.headers.has(NAMESPACE_HEADER) &&
      !path.startsWith("/ns/") &&
      !path.startsWith("/__admin") &&
      path !== "/health"
    ) {
      const token = (await requestToken(request, path)) ?? bearerToken(request)
      if (token !== undefined) tokens.set(request, token)
    }
    return inner(request)
  }
  return Object.assign(runtime, { fetch })
}
