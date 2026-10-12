import {
  type AdminRoutes,
  type Clock,
  createRuntime as createServiceRuntime,
  type FaultPreset,
  type MockControls,
  type RequestLog,
  type ServiceRuntime,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { document } from "./generated/openapi.js"
import { RECAPTCHA_NAMESPACE, RecaptchaAPI } from "./index.js"
import type { Settings } from "./state.js"

export const RECAPTCHA_PRESETS: Record<string, FaultPreset> = {
  human: {
    description: "Successful verification has score 0.9",
    rules: [{ operationId: "Siteverify", effect: "human" }],
  },
  bot: {
    description: "Successful verification has score 0.1",
    rules: [{ operationId: "Siteverify", effect: "bot" }],
  },
  threshold_boundary: {
    description: "Successful verification has score 0.5",
    rules: [{ operationId: "Siteverify", effect: "threshold_boundary" }],
  },
  expired: {
    description: "Verification reports an expired token",
    rules: [{ operationId: "Siteverify", effect: "expired" }],
  },
  replayed: {
    description: "Verification reports a reused token",
    rules: [{ operationId: "Siteverify", effect: "replayed" }],
  },
  script_failure: {
    description: "Browser script load fails",
    rules: [{ operationId: "BrowserScript", status: 503, body: "Script unavailable" }],
  },
  rate_limited: {
    description: "Scripted verification throttle",
    rules: [
      {
        operationId: "Siteverify",
        status: 429,
        body: { success: false },
        headers: { "retry-after": "1" },
      },
    ],
  },
  server_error: {
    description: "Scripted verification server error",
    rules: [{ operationId: "Siteverify", status: 503, body: { success: false } }],
  },
}
export type RecaptchaRuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  seed?: number | string
  adminPrefix?: string
  adminKey?: string
  /** Admin controls to boot with: clock, latency, faults, seed, a starting snapshot. */
  adminControls?: MockControls
  onLog?: (entry: RequestLog) => void
  settings?: Partial<Settings>
}
export type RecaptchaRuntime = ServiceRuntime<RecaptchaAPI>
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)
const score = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
const routes = (runtime: RecaptchaRuntime): AdminRoutes => ({
  "OPTIONS /issue": () =>
    new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type",
      },
    }),
  "POST /issue": ({ body, namespace }) => {
    const response = runtime.instance(namespace).issue(body)
    response.headers.set("access-control-allow-origin", "*")
    return response
  },
  "GET /attempts": ({ namespace }) =>
    Response.json({
      data: runtime
        .instance(namespace)
        .state.attempts.list()
        .map((row) => row.value),
    }),
  "GET /settings": ({ namespace }) => Response.json(runtime.instance(namespace).state.current()),
  "PUT /settings": ({ body, namespace }) => {
    if (!record(body)) return Response.json({ error: "Expected settings object" }, { status: 400 })
    for (const [key, value] of Object.entries(body)) {
      const valid =
        key === "score"
          ? score(value)
          : key === "scores"
            ? record(value) && Object.values(value).every(score)
            : key === "sites"
              ? Array.isArray(value) &&
                value.every(
                  (site) =>
                    record(site) &&
                    typeof site.siteKey === "string" &&
                    !!site.siteKey &&
                    typeof site.secret === "string" &&
                    !!site.secret,
                )
              : ["executeError", "expired", "replayed"].includes(key)
                ? typeof value === "boolean"
                : ["action", "hostname"].includes(key)
                  ? typeof value === "string"
                  : key === "errorCodes"
                    ? Array.isArray(value) && value.every((code) => typeof code === "string")
                    : false
      if (!valid) return Response.json({ error: `Invalid setting: ${key}` }, { status: 400 })
    }
    return Response.json(runtime.instance(namespace).state.update(body))
  },
})
export const createRuntime = (options: RecaptchaRuntimeOptions = {}): RecaptchaRuntime =>
  createServiceRuntime({
    name: RECAPTCHA_NAMESPACE,
    document,
    presets: RECAPTCHA_PRESETS,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminPrefix ? { adminPrefix: options.adminPrefix } : {}),
    ...(options.adminKey ? { adminKey: options.adminKey } : {}),
    ...(options.adminControls !== undefined ? { adminControls: options.adminControls } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    create: ({ sqlite, namespace, clock, adminPrefix, publicNamespace }) =>
      new RecaptchaAPI({
        sqlite,
        namespace,
        now: clock.now,
        issuePath: `${adminPrefix}/issue`,
        publicNamespace,
        ...(options.settings ? { settings: options.settings } : {}),
      }),
    admin: routes,
  })
