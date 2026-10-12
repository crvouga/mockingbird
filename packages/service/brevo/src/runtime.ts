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
import { BREVO_NAMESPACE, BrevoAPI, type Contact } from "./index.js"
export const BREVO_PRESETS: Record<string, FaultPreset> = {
  unauthorized: {
    description: "API key rejected",
    rules: [{ status: 401, body: { code: "unauthorized", message: "Key not found" } }],
  },
  rate_limited: {
    description: "Scripted quota exhaustion",
    rules: [
      {
        status: 429,
        body: { code: "too_many_requests", message: "Rate limit exceeded" },
        headers: { "retry-after": "1" },
      },
    ],
  },
  server_error: {
    description: "Scripted transient failure",
    rules: [{ status: 503, body: { code: "internal_error", message: "Service unavailable" } }],
  },
  connection_drop: { description: "Connection closes before execution", rules: [{ drop: true }] },
}
export type BrevoRuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  seed?: number | string
  adminPrefix?: string
  adminKey?: string
  /** Admin controls to boot with: clock, latency, faults, seed, a starting snapshot. */
  adminControls?: MockControls
  onLog?: (entry: RequestLog) => void
  apiKeys?: string[]
  contacts?: Contact[]
}
export type BrevoRuntime = ServiceRuntime<BrevoAPI>
export const createRuntime = (options: BrevoRuntimeOptions = {}): BrevoRuntime =>
  createServiceRuntime({
    name: BREVO_NAMESPACE,
    document,
    presets: BREVO_PRESETS,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminPrefix ? { adminPrefix: options.adminPrefix } : {}),
    ...(options.adminKey ? { adminKey: options.adminKey } : {}),
    ...(options.adminControls !== undefined ? { adminControls: options.adminControls } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    credential: (request) => request.headers.get("api-key") ?? undefined,
    create: ({ sqlite, namespace, clock }) =>
      new BrevoAPI({
        sqlite,
        namespace,
        now: clock.now,
        ...(options.apiKeys ? { apiKeys: options.apiKeys } : {}),
        ...(options.contacts ? { contacts: options.contacts } : {}),
      }),
  })
