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
import { NOTION_NAMESPACE, NotionAPI, type NotionAPIOptions } from "./index.js"
export const NOTION_PRESETS: Record<string, FaultPreset> = {
  unauthorized: {
    description: "Rejected bearer token",
    rules: [
      {
        status: 401,
        body: {
          object: "error",
          status: 401,
          code: "unauthorized",
          message: "API token is invalid.",
        },
      },
    ],
  },
  rate_limited: {
    description: "Scripted API throttle",
    rules: [
      {
        status: 429,
        body: {
          object: "error",
          status: 429,
          code: "rate_limited",
          message: "Rate limit exceeded.",
        },
        headers: { "retry-after": "1" },
      },
    ],
  },
  server_error: {
    description: "Transient API failure",
    rules: [
      {
        status: 503,
        body: {
          object: "error",
          status: 503,
          code: "service_unavailable",
          message: "Service unavailable.",
        },
      },
    ],
  },
  connection_drop: { description: "Connection closes before write", rules: [{ drop: true }] },
}
export type NotionRuntimeOptions = Omit<NotionAPIOptions, "now" | "namespace"> & {
  clock?: Clock
  seed?: string | number
  adminPrefix?: string
  adminKey?: string
  /** Admin controls to boot with: clock, latency, faults, seed, a starting snapshot. */
  adminControls?: MockControls
  onLog?: (entry: RequestLog) => void
}
export type NotionRuntime = ServiceRuntime<NotionAPI>
export const createRuntime = (options: NotionRuntimeOptions = {}): NotionRuntime =>
  createServiceRuntime({
    name: NOTION_NAMESPACE,
    document,
    presets: NOTION_PRESETS,
    credential: bearerToken,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminPrefix ? { adminPrefix: options.adminPrefix } : {}),
    ...(options.adminKey ? { adminKey: options.adminKey } : {}),
    ...(options.adminControls !== undefined ? { adminControls: options.adminControls } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    create: ({ sqlite, namespace, clock }) =>
      new NotionAPI({ ...options, sqlite, namespace, now: clock.now }),
  })
