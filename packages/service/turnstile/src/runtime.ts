import {
  type Clock,
  createRuntime as createServiceRuntime,
  type FaultPreset,
  type MockControls,
  type RequestLog,
  type ServiceRuntime,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { document } from "./generated/openapi.js"
import { type Site, type Token, TURNSTILE_NAMESPACE, TurnstileAPI } from "./index.js"
export const TURNSTILE_PRESETS: Record<string, FaultPreset> = {
  internal_error: {
    description: "Verification failure, not transport failure",
    rules: [{ status: 200, body: { success: false, "error-codes": ["internal-error"] } }],
  },
  rate_limited: {
    description: "Scripted transport throttle",
    rules: [{ status: 429, body: { success: false }, headers: { "retry-after": "1" } }],
  },
  server_error: {
    description: "Scripted transport failure",
    rules: [{ status: 503, body: { success: false } }],
  },
  connection_drop: {
    description: "Connection closes before verification",
    rules: [{ drop: true }],
  },
}
export type TurnstileRuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  seed?: string | number
  adminPrefix?: string
  adminKey?: string
  /** Admin controls to boot with: clock, latency, faults, seed, a starting snapshot. */
  adminControls?: MockControls
  onLog?: (entry: RequestLog) => void
  sites?: Site[]
  tokens?: Token[]
}
export type TurnstileRuntime = ServiceRuntime<TurnstileAPI>
export const createRuntime = (options: TurnstileRuntimeOptions = {}): TurnstileRuntime =>
  createServiceRuntime({
    name: TURNSTILE_NAMESPACE,
    document,
    presets: TURNSTILE_PRESETS,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminPrefix ? { adminPrefix: options.adminPrefix } : {}),
    ...(options.adminKey ? { adminKey: options.adminKey } : {}),
    ...(options.adminControls !== undefined ? { adminControls: options.adminControls } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    create: ({ sqlite, namespace, clock }) =>
      new TurnstileAPI({
        sqlite,
        namespace,
        now: clock.now,
        ...(options.sites ? { sites: options.sites } : {}),
        ...(options.tokens ? { tokens: options.tokens } : {}),
      }),
    admin: (runtime) => ({
      "POST /issue": ({ body, namespace }) => runtime.instance(namespace).issue(body),
      "GET /attempts": ({ namespace }) =>
        Response.json({
          data: runtime
            .instance(namespace)
            .attempts.list()
            .map(({ value }) => value),
        }),
    }),
  })
