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
import { AIRTABLE_NAMESPACE, AirtableAPI, type AirtableAPIOptions } from "./index.js"
export const AIRTABLE_PRESETS: Record<string, FaultPreset> = {
  unauthorized: {
    description: "Expired access token",
    rules: [
      {
        status: 401,
        body: {
          error: { type: "AUTHENTICATION_REQUIRED", message: "Authentication required" },
        },
      },
    ],
  },
  rate_limited: {
    description: "Scripted quota failure; body is a local fixture",
    rules: [
      {
        status: 429,
        body: {
          error: {
            type: "TOO_MANY_REQUESTS",
            message: "Rate limit exceeded. Please try again later",
          },
        },
        headers: {
          "retry-after": "30",
        },
      },
    ],
  },
  server_error: {
    description: "Scripted server failure",
    rules: [
      { status: 500, body: { error: { type: "SERVER_ERROR", message: "Internal Server Error" } } },
    ],
  },
  invalid_schema: {
    description: "Scripted schema validation failure",
    rules: [
      {
        status: 422,
        body: { error: { type: "INVALID_REQUEST_UNKNOWN", message: "Invalid schema" } },
      },
    ],
  },
  connection_drop: { description: "Dropped connection", rules: [{ drop: true }] },
}
export type AirtableRuntimeOptions = Omit<AirtableAPIOptions, "now" | "namespace"> & {
  clock?: Clock
  seed?: string | number
  adminPrefix?: string
  adminKey?: string
  /** Admin controls to boot with: clock, latency, faults, seed, a starting snapshot. */
  adminControls?: MockControls
  onLog?: (entry: RequestLog) => void
}
export type AirtableRuntime = ServiceRuntime<AirtableAPI>
export const createRuntime = (options: AirtableRuntimeOptions = {}): AirtableRuntime =>
  createServiceRuntime({
    name: AIRTABLE_NAMESPACE,
    document,
    presets: AIRTABLE_PRESETS,
    credential: bearerToken,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminPrefix ? { adminPrefix: options.adminPrefix } : {}),
    ...(options.adminKey ? { adminKey: options.adminKey } : {}),
    ...(options.adminControls !== undefined ? { adminControls: options.adminControls } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    create: ({ sqlite, namespace, clock }) =>
      new AirtableAPI({ ...options, sqlite, namespace, now: clock.now }),
  })
