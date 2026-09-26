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
import { accessKeyCredential, BEDROCK_NAMESPACE, BedrockAPI, clockSleep } from "./index.js"
import { parseScript, type Script } from "./scripts.js"
import type { Settings } from "./state.js"

const MODEL_PATH = "/model/"

/** A preset that switches on one `bedrock_fault` for every model and harness call. */
const everyCall = (description: string, params: Record<string, unknown>): FaultPreset => ({
  description,
  rules: [
    { pathPrefix: MODEL_PATH, effect: "bedrock_fault", params },
    { pathPrefix: "/harnesses/", effect: "bedrock_fault", params },
  ],
})

/**
 * Every named Bedrock misbehaviour our consumer branches on, switched on with
 * `POST /__admin/faults {"preset": "<name>", "count"?: n}` (a scripted turn can carry the
 * same `fault` for one conversation step).
 */
export const BEDROCK_PRESETS: Record<string, FaultPreset> = {
  throttling: everyCall(
    "429 ThrottlingException before the first chunk (our backend retries 3× with 500 ms·2^n backoff)",
    { type: "throttling" },
  ),
  mid_stream_exception: everyCall(
    "The stream starts, sends one content chunk, then a modelStreamErrorException frame",
    { type: "mid_stream_exception", afterChunks: 1 },
  ),
  mid_stream_throttling: everyCall(
    "The stream starts, sends one content chunk, then a throttlingException frame",
    { type: "mid_stream_exception", afterChunks: 1, exceptionType: "throttlingException" },
  ),
  validation_exception: everyCall("400 ValidationException", { type: "validation" }),
  max_tokens: everyCall("Output cut in half and stopReason max_tokens", { type: "max_tokens" }),
  latency: everyCall("2 s (mock clock) before the response starts", {
    type: "latency",
    latencyMs: 2_000,
  }),
  truncated_frame: everyCall(
    "The stream ends half-way through a frame (the event-stream decoders throw)",
    { type: "truncated_frame", afterChunks: 1 },
  ),
  model_timeout: everyCall("408 ModelTimeoutException", { type: "model_timeout" }),
  service_unavailable: everyCall("503 ServiceUnavailableException", {
    type: "service_unavailable",
  }),
  access_denied: everyCall("403 AccessDeniedException", { type: "access_denied" }),
  internal_server: everyCall("500 InternalServerException", { type: "internal_server" }),
}

export type BedrockRuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  seed?: number | string
  adminKey?: string
  onLog?: (entry: RequestLog) => void
  settings?: Partial<Settings>
  /** Scripts every namespace starts with (and returns to on reset). */
  scripts?: readonly Script[]
}

export type BedrockRuntime = ServiceRuntime<BedrockAPI>

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const adminError = (status: number, message: string) =>
  json(status, { error: { type: "mockingbird_admin", message } })
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const parseScripts = (body: unknown): Script[] | string => {
  const list = Array.isArray(body)
    ? body
    : isRecord(body)
      ? (body.scripts ?? (body.id ? [body] : undefined))
      : undefined
  if (!Array.isArray(list)) return 'expected {"scripts": [{id, match?, turns: [...]}]}'
  const out: Script[] = []
  for (const [index, each] of list.entries()) {
    const parsed = parseScript(each, index)
    if (typeof parsed === "string") return parsed
    out.push(parsed)
  }
  const ids = out.map((s) => s.id)
  const duplicate = ids.find((id, i) => ids.indexOf(id) !== i)
  return duplicate ? `duplicate script id ${duplicate}` : out
}

const SETTING_CHECKS: Record<keyof Settings, (value: unknown) => boolean> = {
  defaultText: (value) => typeof value === "string",
  chunkSize: (value) => typeof value === "number" && value >= 1,
  delayMsPerChunk: (value) => typeof value === "number" && value >= 0,
  audioTurnChunks: (value) => typeof value === "number" && value >= 0,
}

const adminRoutes = (runtime: ServiceRuntime<BedrockAPI>): AdminRoutes => {
  const store =
    (replace: boolean): AdminRoutes[string] =>
    ({ body, namespace }) => {
      const scripts = parseScripts(body)
      if (typeof scripts === "string") return adminError(400, scripts)
      return json(200, { scripts: runtime.instance(namespace).putScripts(scripts, replace) })
    }
  return {
    "GET /scripts": ({ namespace }) => {
      const api = runtime.instance(namespace)
      return json(200, { scripts: api.scripts(), stats: api.stats() })
    },
    "PUT /scripts": store(true),
    "POST /scripts": store(false),
    "DELETE /scripts": ({ url, namespace }) =>
      json(200, {
        removed: runtime.instance(namespace).removeScripts(url.searchParams.get("id") ?? undefined),
      }),
    "GET /model-metrics": ({ namespace }) => json(200, runtime.instance(namespace).stats()),
    "GET /settings": ({ namespace }) => json(200, runtime.instance(namespace).state.current()),
    "PUT /settings": ({ body, namespace }) => {
      if (!isRecord(body)) return adminError(400, "expected a JSON object")
      const patch: Partial<Settings> = {}
      for (const [key, value] of Object.entries(body)) {
        const check = SETTING_CHECKS[key as keyof Settings]
        if (!check) return adminError(400, `unknown setting ${key}`)
        if (!check(value)) return adminError(400, `bad value for ${key}`)
        ;(patch as Record<string, unknown>)[key] = value
      }
      return json(200, runtime.instance(namespace).state.update(patch))
    },
  }
}

/**
 * The Bedrock mock with Mockingbird's full service contract: `/health`, `/__admin/*`,
 * namespaces by header, by `/ns/<name>` path prefix, or by SigV4 access key id
 * (`PUT /__admin/credentials {"credentials": {"<AWS_ACCESS_KEY_ID>": "<namespace>"}}`),
 * clock control (script pacing runs on it), fault presets, scripts and a request journal
 * that records metadata only.
 */
export const createRuntime = (options: BedrockRuntimeOptions = {}): BedrockRuntime => {
  let runtime: BedrockRuntime | undefined
  const totals = () => {
    let scripted = 0
    let unscripted = 0
    for (const name of runtime?.namespaces() ?? []) {
      const stats = runtime?.instance(name).stats()
      scripted += stats?.scripted ?? 0
      unscripted += stats?.unscripted ?? 0
    }
    return { scripted, unscripted }
  }
  runtime = createServiceRuntime<BedrockAPI>({
    name: BEDROCK_NAMESPACE,
    document,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    credential: accessKeyCredential,
    presets: BEDROCK_PRESETS,
    create: ({ sqlite, namespace, clock }) =>
      new BedrockAPI({
        sqlite,
        namespace,
        now: clock.now,
        sleep: clockSleep(clock.now),
        ...(options.settings ? { settings: options.settings } : {}),
        ...(options.scripts ? { scripts: options.scripts } : {}),
      }),
    describe: () => ({ scripts: options.scripts?.length ?? 0, modelCalls: totals() }),
    admin: adminRoutes,
  })
  return runtime
}
