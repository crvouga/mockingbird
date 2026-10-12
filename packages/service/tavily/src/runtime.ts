import {
  bearerToken,
  type Clock,
  type FaultPreset,
  type MockControls,
  type RequestLog,
  type ServiceRuntime,
  createRuntime as serviceRuntime,
} from "@crvouga/mockingbird-service"
import { document } from "./generated/openapi.js"
import { TAVILY_NAMESPACE, TavilyAPI, type TavilyAPIOptions } from "./index.js"

const failure = (status: number, error: string): FaultPreset => ({
  description: error,
  rules: [{ status, body: { detail: { error } } }],
})
export const TAVILY_PRESETS: Record<string, FaultPreset> = {
  invalid_key: failure(401, "Unauthorized: missing or invalid API key."),
  quota_exceeded: failure(429, "Your request has been blocked due to excessive requests."),
  plan_limit: failure(432, "This request exceeds your plan's set usage limit."),
  payg_limit: failure(433, "This request exceeds the pay-as-you-go limit."),
  internal_error: failure(500, "Internal Server Error"),
  timeout: { description: "Delay beyond a short client timeout", rules: [{ latencyMs: 1000 }] },
  connection_drop: { description: "Connection lost", rules: [{ drop: true }] },
}
export type TavilyRuntimeOptions = Omit<TavilyAPIOptions, "namespace" | "now"> & {
  clock?: Clock
  seed?: string | number
  adminPrefix?: string
  adminKey?: string
  /** Admin controls to boot with: clock, latency, faults, seed, a starting snapshot. */
  adminControls?: MockControls
  onLog?: (entry: RequestLog) => void
}
export type TavilyRuntime = ServiceRuntime<TavilyAPI>
export const createRuntime = (options: TavilyRuntimeOptions = {}): TavilyRuntime =>
  serviceRuntime({
    ...options,
    name: TAVILY_NAMESPACE,
    document,
    credential: bearerToken,
    presets: TAVILY_PRESETS,
    create: ({ sqlite, namespace, clock }) =>
      new TavilyAPI({ ...options, sqlite, namespace, now: clock.now }),
  })
