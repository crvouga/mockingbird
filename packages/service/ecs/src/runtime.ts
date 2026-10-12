import {
  type Clock,
  type FaultPreset,
  type MockControls,
  type RequestLog,
  type ServiceRuntime,
  createRuntime as serviceRuntime,
  sigV4AccessKeyId,
} from "@crvouga/mockingbird-service"
import { document } from "./generated/openapi.js"
import { ECS_NAMESPACE, ECSAPI, type ECSAPIOptions } from "./index.js"

const failure = (status: number, type: string, message: string): FaultPreset => ({
  description: message,
  rules: [
    {
      status,
      body: { __type: type, message },
      headers: { "content-type": "application/x-amz-json-1.1" },
    },
  ],
})
export const ECS_PRESETS: Record<string, FaultPreset> = {
  access_denied: failure(400, "AccessDeniedException", "Access denied"),
  throttled: failure(400, "ThrottlingException", "Rate exceeded"),
  rate_limited: failure(429, "ThrottlingException", "Injected HTTP rate limit"),
  internal_error: failure(500, "ServerException", "Internal service error"),
  connection_drop: { description: "Connection lost", rules: [{ drop: true }] },
}
export type ECSRuntimeOptions = Omit<ECSAPIOptions, "namespace" | "now"> & {
  clock?: Clock
  seed?: string | number
  adminPrefix?: string
  adminKey?: string
  /** Admin controls to boot with: clock, latency, faults, seed, a starting snapshot. */
  adminControls?: MockControls
  onLog?: (entry: RequestLog) => void
}
export type ECSRuntime = ServiceRuntime<ECSAPI>
export const createRuntime = (options: ECSRuntimeOptions = {}): ECSRuntime =>
  serviceRuntime({
    ...options,
    name: ECS_NAMESPACE,
    document,
    credential: sigV4AccessKeyId,
    presets: ECS_PRESETS,
    create: ({ sqlite, namespace, clock }) =>
      new ECSAPI({ ...options, sqlite, namespace, now: clock.now }),
  })
