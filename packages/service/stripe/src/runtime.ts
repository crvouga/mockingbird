import {
  type Clock,
  createRuntime as createServiceRuntime,
  type RequestLog,
  type ServiceRuntime,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { STRIPE_NAMESPACE } from "./constants.js"
import { document } from "./generated/openapi.js"
import { StripeAPI, type StripeAPIOptions } from "./index.js"

export type StripeRuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  /** Seeds every random choice the runtime makes (fault rates). */
  seed?: number | string
  /** Require `x-mockingbird-admin-key` on `/__admin/*`. */
  adminKey?: string
  onLog?: (entry: RequestLog) => void
  /** Called in-process with every event the mock records. */
  onWebhook?: StripeAPIOptions["onWebhook"]
}

export type StripeRuntime = ServiceRuntime<StripeAPI>

/**
 * The Stripe mock with Mockingbird's full service contract: unauthenticated
 * `/health`, the `/__admin/*` control plane, per-request namespaces
 * (`x-mockingbird-namespace`), clock control, fault injection and request metrics.
 * Runtime-neutral: serve it with any Fetch-native server, or use `./server` for Node.
 */
export const createRuntime = (options: StripeRuntimeOptions = {}): StripeRuntime =>
  createServiceRuntime<StripeAPI>({
    name: STRIPE_NAMESPACE,
    document,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    create: ({ sqlite, namespace, clock }) =>
      new StripeAPI({
        sqlite,
        namespace,
        now: clock.now,
        ...(options.onWebhook ? { onWebhook: options.onWebhook } : {}),
      }),
  })
