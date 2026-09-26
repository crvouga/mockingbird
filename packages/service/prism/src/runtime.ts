import {
  type AdminRoutes,
  bearerToken,
  type Clock,
  createRuntime as createServiceRuntime,
  type FaultPreset,
  type RequestLog,
  type ServiceRuntime,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { document } from "./generated/openapi.js"
import { PRISM_NAMESPACE, PrismAPI } from "./index.js"
import { type AutoAdvance, type Settings, STAGES, type Stage } from "./state.js"

/**
 * Every Prism misbehaviour our body-scan adapter branches on, switched on with
 * `POST /__admin/faults {"preset": "<name>"}` (add `count` to limit it). Our adapter turns every
 * non-404 failure into `unavailable`, and a 404 into `not_found`.
 */
export const PRISM_PRESETS: Record<string, FaultPreset> = {
  unauthorized: {
    description: "Every call answers 401 (PRISM_API_KEY revoked)",
    rules: [
      { pathPrefix: "/users", status: 401, body: { message: "Unauthorized" } },
      { pathPrefix: "/scans", status: 401, body: { message: "Unauthorized" } },
    ],
  },
  server_error: {
    description: "Every API call answers 500",
    rules: [
      { pathPrefix: "/users", status: 500, body: { message: "Internal Server Error" } },
      { pathPrefix: "/scans", status: 500, body: { message: "Internal Server Error" } },
    ],
  },
  scan_not_found: {
    description: "Scan reads answer 404 (our adapter reports not_found)",
    rules: [{ operationId: "GetScan", status: 404, body: { message: "Scan not found" } }],
  },
  schema_drift: {
    description: "GetScan answers an unknown status (QUEUED): our zod enum rejects it",
    rules: [{ operationId: "GetScan", effect: "schema_drift" }],
  },
  stage_states_slow: {
    description: "scan-assets answers after 6 s, past our adapter's 5 s timeout",
    rules: [{ operationId: "GetScanAssets", latencyMs: 6_000 }],
  },
  metabolic_age_missing: {
    description: "The health report carries metabolicAgeReport: null",
    rules: [{ operationId: "GetHealthReport", effect: "metabolic_age_missing" }],
  },
  metabolic_age_implausible: {
    description: "The health report's metabolic age is 150 years",
    rules: [{ operationId: "GetHealthReport", effect: "metabolic_age_implausible" }],
  },
  upload_forbidden: {
    description: "The presigned PUT answers 403 (as S3 does for an expired URL)",
    rules: [
      {
        operationId: "UploadCapture",
        status: 403,
        body: "<Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>",
        headers: { "content-type": "application/xml" },
      },
    ],
  },
  connection_drop: {
    description: "The connection drops before any answer (fetch rejects)",
    rules: [{ pathPrefix: "/scans", drop: true }],
  },
}

export type PrismRuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  seed?: number | string
  adminKey?: string
  onLog?: (entry: RequestLog) => void
  settings?: Partial<Settings>
  /** Run auto-advance on this real-time interval (ms). The served mock uses 100 ms. */
  tickMs?: number
}

export type PrismRuntime = ServiceRuntime<PrismAPI> & {
  /** Stop the background ticker, if one runs. */
  stop(): void
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const adminError = (status: number, message: string) =>
  json(status, { error: { type: "mockingbird_admin", message } })
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const parseAutoAdvance = (value: unknown): AutoAdvance | null | string => {
  if (value === null) return null
  if (!isRecord(value) || typeof value.afterMs !== "number" || value.afterMs < 0) {
    return "autoAdvance must be {afterMs, failAt?} or null"
  }
  if (value.failAt !== undefined && !STAGES.includes(value.failAt as Stage)) {
    return `autoAdvance.failAt must be one of ${STAGES.join(", ")}`
  }
  return { afterMs: value.afterMs, ...(value.failAt ? { failAt: value.failAt as Stage } : {}) }
}

const adminRoutes = (runtime: ServiceRuntime<PrismAPI>): AdminRoutes => ({
  "GET /scans": ({ namespace }) => json(200, { scans: runtime.instance(namespace).scans() }),
  "POST /scans/:id/advance": ({ params, body, namespace }) => {
    const api = runtime.instance(namespace)
    const steps = isRecord(body) && body.to === "READY" ? STAGES.length : 1
    let scan = api.state.scans.get(params.id as string)
    if (!scan) return adminError(404, `no scan ${params.id}`)
    if (scan.status !== "PROCESSING") {
      return adminError(409, `scan ${params.id} is ${scan.status}; upload its capture first`)
    }
    for (let i = 0; i < steps && scan?.status === "PROCESSING"; i++) scan = api.advance(scan.id)
    return json(200, scan)
  },
  "POST /scans/:id/fail": ({ params, namespace }) => {
    const scan = runtime.instance(namespace).advance(params.id as string, true)
    return scan ? json(200, scan) : adminError(404, `no scan ${params.id}`)
  },
  "GET /settings": ({ namespace }) => json(200, runtime.instance(namespace).state.current()),
  "PUT /settings": ({ body, namespace }) => {
    if (!isRecord(body)) return adminError(400, "expected a JSON object")
    const patch: Partial<Settings> = {}
    if (body.apiKeys !== undefined) {
      if (!Array.isArray(body.apiKeys)) return adminError(400, "apiKeys: string[]")
      patch.apiKeys = body.apiKeys.map(String)
    }
    if (body.uploadUrlTtlMs !== undefined) {
      if (typeof body.uploadUrlTtlMs !== "number") return adminError(400, "uploadUrlTtlMs: number")
      patch.uploadUrlTtlMs = body.uploadUrlTtlMs
    }
    if (body.autoAdvance !== undefined) {
      const parsed = parseAutoAdvance(body.autoAdvance)
      if (typeof parsed === "string") return adminError(400, parsed)
      patch.autoAdvance = parsed
    }
    return json(200, runtime.instance(namespace).state.update(patch))
  },
  "POST /tick": ({ namespace }) => json(200, { applied: runtime.instance(namespace).tick() }),
})

/**
 * The Prism mock with Mockingbird's full service contract: `/health`, `/__admin/*`,
 * namespaces by header, by `/ns/<name>` path prefix, or by API key
 * (`PUT /__admin/credentials {"credentials": {"<PRISM_API_KEY>": "<namespace>"}}`), clock
 * control, fault presets and a request journal.
 */
export const createRuntime = (options: PrismRuntimeOptions = {}): PrismRuntime => {
  const runtime = createServiceRuntime<PrismAPI>({
    name: PRISM_NAMESPACE,
    document,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    credential: bearerToken,
    presets: PRISM_PRESETS,
    create: ({ sqlite, namespace, publicNamespace, clock }) =>
      new PrismAPI({
        sqlite,
        namespace,
        publicNamespace,
        now: clock.now,
        ...(options.settings ? { settings: options.settings } : {}),
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
    stop: () => {
      if (timer !== undefined) clearInterval(timer)
    },
  })
}
