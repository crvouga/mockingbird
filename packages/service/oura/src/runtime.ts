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
import { OURA_NAMESPACE, OuraAPI, type OuraAPIOptions } from "./index.js"
export const OURA_PRESETS: Record<string, FaultPreset> = {
  unauthorized: {
    description: "Expired access token",
    rules: [
      {
        status: 401,
        body: {
          detail:
            "The access token provided is expired, revoked, malformed, or invalid for other reasons.",
        },
      },
    ],
  },
  rate_limited: {
    description: "Scripted quota failure; body is a local fixture",
    rules: [
      {
        status: 429,
        body: { detail: "Rate limit exceeded." },
        headers: {
          "retry-after": "1",
          "x-ratelimit-limit": "1",
          "x-ratelimit-window": "1",
          "x-ratelimit-reset": "0",
          "x-ratelimit-tier": "access-token",
        },
      },
    ],
  },
  server_error: {
    description: "Scripted server failure",
    rules: [{ status: 500, body: { detail: "Internal Server Error" } }],
  },
  connection_drop: { description: "Dropped connection", rules: [{ drop: true }] },
}
export type OuraRuntimeOptions = Omit<OuraAPIOptions, "now" | "namespace"> & {
  clock?: Clock
  seed?: string | number
  adminPrefix?: string
  adminKey?: string
  /** Admin controls to boot with: clock, latency, faults, seed, a starting snapshot. */
  adminControls?: MockControls
  onLog?: (entry: RequestLog) => void
}
export type OuraRuntime = ServiceRuntime<OuraAPI>
export const createRuntime = (options: OuraRuntimeOptions = {}): OuraRuntime =>
  createServiceRuntime({
    name: OURA_NAMESPACE,
    document,
    presets: OURA_PRESETS,
    credential: bearerToken,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminPrefix ? { adminPrefix: options.adminPrefix } : {}),
    ...(options.adminKey ? { adminKey: options.adminKey } : {}),
    ...(options.adminControls !== undefined ? { adminControls: options.adminControls } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    create: ({ sqlite, namespace, clock }) =>
      new OuraAPI({ ...options, sqlite, namespace, now: clock.now }),
  })
