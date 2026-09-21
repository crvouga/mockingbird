import {
  type Clock,
  createRuntime as createServiceRuntime,
  type RequestLog,
  type ServiceRuntime,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { document } from "./generated/openapi.js"
import { GENEBYGENE_NAMESPACE, GeneByGeneAPI } from "./index.js"

export type GeneByGeneRuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  /** Seeds every random choice the runtime makes (fault rates). */
  seed?: number | string
  /** Require `x-mockingbird-admin-key` on `/__admin/*`. */
  adminKey?: string
  onLog?: (entry: RequestLog) => void
}

export type GeneByGeneRuntime = ServiceRuntime<GeneByGeneAPI>

/**
 * The GeneByGene mock with Mockingbird's full service contract: unauthenticated
 * `/health`, the `/__admin/*` control plane, per-request namespaces
 * (`x-mockingbird-namespace`), clock control, fault injection and request metrics.
 * Runtime-neutral: serve it with any Fetch-native server, or use `./server` for Node.
 */
export const createRuntime = (options: GeneByGeneRuntimeOptions = {}): GeneByGeneRuntime =>
  createServiceRuntime<GeneByGeneAPI>({
    name: GENEBYGENE_NAMESPACE,
    document,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    create: ({ sqlite, namespace, clock }) =>
      new GeneByGeneAPI({
        sqlite,
        namespace,
        now: clock.now,
      }),
  })
