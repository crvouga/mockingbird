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
import { EVENTBRIDGE_NAMESPACE, EventBridgeAPI, type EventBridgeAPIOptions } from "./index.js"

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
export const EVENTBRIDGE_PRESETS: Record<string, FaultPreset> = {
  access_denied: failure(403, "AccessDeniedException", "Access denied"),
  throttled: failure(400, "ThrottlingException", "Rate exceeded"),
  rate_limited: failure(429, "ThrottlingException", "Injected HTTP rate limit"),
  internal_error: failure(500, "InternalException", "Internal service error"),
  connection_drop: { description: "Connection lost", rules: [{ drop: true }] },
}
export type EventBridgeRuntimeOptions = Omit<EventBridgeAPIOptions, "namespace" | "now"> & {
  clock?: Clock
  seed?: string | number
  adminPrefix?: string
  adminKey?: string
  /** Admin controls to boot with: clock, latency, faults, seed, a starting snapshot. */
  adminControls?: MockControls
  onLog?: (entry: RequestLog) => void
}
export type EventBridgeRuntime = ServiceRuntime<EventBridgeAPI>
export const createRuntime = (options: EventBridgeRuntimeOptions = {}): EventBridgeRuntime =>
  serviceRuntime({
    ...options,
    name: EVENTBRIDGE_NAMESPACE,
    document,
    credential: sigV4AccessKeyId,
    presets: EVENTBRIDGE_PRESETS,
    create: ({ sqlite, namespace, clock }) =>
      new EventBridgeAPI({ ...options, sqlite, namespace, now: clock.now }),
  })
