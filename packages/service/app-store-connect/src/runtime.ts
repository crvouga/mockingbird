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
import {
  APP_STORE_CONNECT_NAMESPACE,
  AppStoreConnectAPI,
  type AppStoreConnectAPIOptions,
} from "./index.js"

const fault = (status: number, code: string) => ({
  errors: [
    {
      status: String(status),
      code,
      title: "Synthetic vendor failure",
      detail: "Injected for testing",
    },
  ],
})
export const APP_STORE_CONNECT_PRESETS: Record<string, FaultPreset> = {
  unauthorized: {
    description: "Expired or invalid token",
    rules: [{ status: 401, body: fault(401, "NOT_AUTHORIZED") }],
  },
  forbidden: {
    description: "Role denied",
    rules: [{ status: 403, body: fault(403, "FORBIDDEN_ERROR") }],
  },
  duplicate: {
    description: "Duplicate tester or invitation",
    rules: [{ status: 409, body: fault(409, "ENTITY_ERROR.ATTRIBUTE.UNIQUE") }],
  },
  rate_limited: {
    description: "Quota limit",
    rules: [
      { status: 429, body: fault(429, "RATE_LIMIT_EXCEEDED"), headers: { "retry-after": "1" } },
    ],
  },
  server_error: {
    description: "Temporary server error",
    rules: [{ status: 500, body: fault(500, "UNEXPECTED_ERROR") }],
  },
  connection_drop: { description: "Connection failure", rules: [{ drop: true }] },
}
export type AppStoreConnectRuntimeOptions = Omit<
  AppStoreConnectAPIOptions,
  "namespace" | "now" | "publicNamespace"
> & {
  clock?: Clock
  seed?: string | number
  adminKey?: string
  /** Admin controls to boot with: clock, latency, faults, seed, a starting snapshot. */
  adminControls?: MockControls
  onLog?: (entry: RequestLog) => void
}
export type AppStoreConnectRuntime = ServiceRuntime<AppStoreConnectAPI>
export const createRuntime = (
  options: AppStoreConnectRuntimeOptions = {},
): AppStoreConnectRuntime =>
  createServiceRuntime({
    ...options,
    name: APP_STORE_CONNECT_NAMESPACE,
    document,
    credential: bearerToken,
    presets: APP_STORE_CONNECT_PRESETS,
    create: ({ sqlite, namespace, publicNamespace, adminPrefix, clock }) =>
      new AppStoreConnectAPI({
        ...options,
        sqlite,
        namespace,
        publicNamespace,
        adminPrefix,
        now: clock.now,
      }),
  })
