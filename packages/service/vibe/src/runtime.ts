import {
  bearerToken,
  type Clock,
  createRuntime as createServiceRuntime,
  type FaultPreset,
  type MockControls,
  type RequestLog,
  type ServiceRuntime,
} from "@crvouga/mockingbird-service"
import { document } from "./generated/openapi.js"
import { VIBE_NAMESPACE, VibeAPI, type VibeAPIOptions } from "./index.js"

const envelope = (status: number, type: string) => ({
  error: {
    type,
    status,
    message: "Scripted failure",
    request_id: "mock_request",
    detail: null,
    doc_url: null,
  },
})
export const VIBE_PRESETS: Record<string, FaultPreset> = {
  rate_limited: {
    description: "Scripted quota failure",
    rules: [
      {
        operationId: "CreateReport",
        status: 429,
        body: envelope(429, "rate_limit_exceeded"),
        headers: { "retry-after": "1" },
      },
    ],
  },
  server_error: {
    description: "Transient report error",
    rules: [{ operationId: "CreateReport", status: 500, body: envelope(500, "internal_error") }],
  },
  connection_drop: { description: "Dropped connection", rules: [{ drop: true }] },
  report_failed: {
    description: "Report reaches FAILED",
    rules: [{ operationId: "CreateReport", effect: "failed" }],
  },
  report_stuck: {
    description: "Report remains PROCESSING",
    rules: [{ operationId: "CreateReport", effect: "stuck" }],
  },
}
export type VibeRuntimeOptions = Omit<VibeAPIOptions, "now" | "namespace" | "publicNamespace"> & {
  clock?: Clock
  seed?: string | number
  adminKey?: string
  /** Admin controls to boot with: clock, latency, faults, seed, a starting snapshot. */
  adminControls?: MockControls
  onLog?: (entry: RequestLog) => void
}
export type VibeRuntime = ServiceRuntime<VibeAPI>
export const createRuntime = (options: VibeRuntimeOptions = {}): VibeRuntime =>
  createServiceRuntime({
    name: VIBE_NAMESPACE,
    document,
    presets: VIBE_PRESETS,
    credential: bearerToken,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminPrefix ? { adminPrefix: options.adminPrefix } : {}),
    ...(options.adminKey ? { adminKey: options.adminKey } : {}),
    ...(options.adminControls !== undefined ? { adminControls: options.adminControls } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    create: ({ sqlite, namespace, clock, publicNamespace, adminPrefix }) =>
      new VibeAPI({ ...options, sqlite, namespace, publicNamespace, adminPrefix, now: clock.now }),
  })
