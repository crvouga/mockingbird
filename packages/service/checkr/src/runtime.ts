import {
  basicAuth,
  type Clock,
  createRuntime as createServiceRuntime,
  type FaultPreset,
  type MockControls,
  type RequestLog,
  type ServiceRuntime,
} from "@crvouga/mockingbird-service"
import { document } from "./generated/openapi.js"
import { CHECKR_NAMESPACE, CheckrAPI, type CheckrAPIOptions } from "./index.js"
export const CHECKR_PRESETS: Record<string, FaultPreset> = {
  forbidden: {
    description: "Insufficient API access",
    rules: [{ status: 403, body: { error: "Forbidden" } }],
  },
  hierarchy_denied: {
    description: "Hierarchy API unavailable",
    rules: [{ operationId: "ListNodes", status: 403, body: { error: "Hierarchy not enabled" } }],
  },
  rate_limited: {
    description: "Rate limit",
    rules: [{ status: 429, body: { error: "Too many requests" }, headers: { "retry-after": "1" } }],
  },
  server_error: {
    description: "Server failure",
    rules: [{ status: 500, body: { error: "Internal server error" } }],
  },
  non_json: {
    description: "Proxy HTML failure",
    rules: [
      {
        status: 502,
        body: "<html>synthetic upstream error</html>",
        headers: { "content-type": "text/html" },
      },
    ],
  },
  connection_drop: { description: "Transport failure", rules: [{ drop: true }] },
}
export type CheckrRuntimeOptions = Omit<CheckrAPIOptions, "namespace" | "now"> & {
  clock?: Clock
  seed?: string | number
  adminPrefix?: string
  adminKey?: string
  /** Admin controls to boot with: clock, latency, faults, seed, a starting snapshot. */
  adminControls?: MockControls
  onLog?: (entry: RequestLog) => void
}
export type CheckrRuntime = ServiceRuntime<CheckrAPI>
export const createRuntime = (options: CheckrRuntimeOptions = {}): CheckrRuntime =>
  createServiceRuntime({
    ...options,
    name: CHECKR_NAMESPACE,
    document,
    credential: (request) => basicAuth(request)?.username,
    presets: CHECKR_PRESETS,
    create: ({ sqlite, namespace, clock, publicNamespace, adminPrefix }) =>
      new CheckrAPI({
        ...options,
        sqlite,
        namespace,
        publicNamespace,
        adminPrefix,
        now: clock.now,
      }),
  })
