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
import { WORKOS_NAMESPACE, WorkOSAPI, type WorkOSAPIOptions } from "./index.js"
export const WORKOS_PRESETS: Record<string, FaultPreset> = {
  auth_failure: {
    description: "Reject authentication",
    rules: [
      {
        operationId: "Authenticate",
        status: 401,
        body: { error: "invalid_client", error_description: "Invalid client credentials" },
      },
    ],
  },
  rate_limited: {
    description: "Rate limit vendor requests",
    rules: [
      { status: 429, body: { message: "Too many requests" }, headers: { "retry-after": "1" } },
    ],
  },
  server_error: {
    description: "Temporary server failure",
    rules: [{ status: 500, body: { message: "Internal Server Error" } }],
  },
  connection_drop: { description: "Drop the transport connection", rules: [{ drop: true }] },
}
export type WorkOSRuntimeOptions = Omit<WorkOSAPIOptions, "namespace" | "now"> & {
  clock?: Clock
  seed?: string | number
  adminPrefix?: string
  adminKey?: string
  /** Admin controls to boot with: clock, latency, faults, seed, a starting snapshot. */
  adminControls?: MockControls
  onLog?: (entry: RequestLog) => void
}
export type WorkOSRuntime = ServiceRuntime<WorkOSAPI>
export const createRuntime = (options: WorkOSRuntimeOptions = {}): WorkOSRuntime =>
  createServiceRuntime({
    ...options,
    name: WORKOS_NAMESPACE,
    document,
    credential: bearerToken,
    presets: WORKOS_PRESETS,
    create: ({ sqlite, namespace, clock }) =>
      new WorkOSAPI({ ...options, sqlite, namespace, now: clock.now }),
  })
