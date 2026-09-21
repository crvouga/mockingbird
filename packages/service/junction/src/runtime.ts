import {
  type Clock,
  createRuntime as createServiceRuntime,
  type RequestLog,
  type ServiceRuntime,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { junctionAdminRoutes } from "./admin.js"
import { document } from "./generated/openapi.js"
import { JUNCTION_NAMESPACE, JunctionAPI } from "./index.js"
import type { LabAccountInput } from "./lab-accounts.js"
import type { SealedCorpus } from "./sealed-corpus.js"
import type { GeoMode, WebhookPublisher } from "./state.js"
import {
  createWebhookDispatcher,
  type WebhookDispatcher,
  type WebhookEndpoint,
} from "./webhooks.js"

export type JunctionRuntimeOptions = {
  /**
   * Recorded vendor data every namespace starts from. The served mock loads the corpus
   * shipped at `@crvouga/mockingbird-service-junction/corpus` unless told otherwise.
   */
  corpus?: SealedCorpus
  /** Default: `corpus` when a corpus is loaded, otherwise `synthetic`. */
  geo?: GeoMode
  /** The team's lab accounts; see {@link JunctionAPIOptions.labAccounts}. */
  labAccounts?: readonly LabAccountInput[]
  /** Deliver signed webhooks here, with Svix's retry schedule. */
  webhooks?: WebhookEndpoint
  /** Called in-process for every webhook event, delivered or not. */
  onWebhook?: (event: Parameters<WebhookPublisher>[0], namespace: string) => void
  sqlite?: SqliteClient
  clock?: Clock
  /** Seeds fault rates and webhook retry jitter. */
  seed?: number | string
  /** Require `x-mockingbird-admin-key` on `/__admin/*`. */
  adminKey?: string
  onLog?: (entry: RequestLog) => void
}

export type JunctionRuntime = ServiceRuntime<JunctionAPI> & {
  /** Signed delivery, when `webhooks` was configured. */
  readonly webhooks: WebhookDispatcher | undefined
}

/**
 * The Junction mock with Mockingbird's full service contract: unauthenticated
 * `/health`, the `/__admin/*` control plane, per-request namespaces
 * (`x-mockingbird-namespace`), clock control, fault injection and request metrics.
 * Runtime-neutral: serve it with any Fetch-native server, or use `./server` for Node.
 */
export const createRuntime = (options: JunctionRuntimeOptions = {}): JunctionRuntime => {
  const webhooks = options.webhooks ? createWebhookDispatcher(options.webhooks) : undefined
  const runtime: ServiceRuntime<JunctionAPI> = createServiceRuntime<JunctionAPI>({
    name: JUNCTION_NAMESPACE,
    document,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    create: ({ namespace, publicNamespace, sqlite, clock, rng }) => {
      const api = new JunctionAPI({
        sqlite,
        namespace,
        now: clock.now,
        webhook: { seed: rng.seed },
        ...(options.corpus ? { corpus: options.corpus } : {}),
        ...(options.geo ? { geo: options.geo } : {}),
        ...(options.labAccounts ? { labAccounts: options.labAccounts } : {}),
        onWebhook: (event) => {
          options.onWebhook?.(event, publicNamespace)
          webhooks?.publish(event, publicNamespace)
        },
      })
      // A namespace reset also forgets that namespace's deliveries and pending retries.
      const reset = api.reset.bind(api)
      api.reset = async () => {
        webhooks?.clear(publicNamespace)
        await reset()
      }
      return api
    },
    describe: (): Record<string, unknown> => {
      const info = runtime.instance().corpusInfo()
      return {
        corpus: info?.label ?? null,
        geo: runtime.instance().geoMode,
        webhooks: webhooks ? "on" : "off",
      }
    },
    admin: junctionAdminRoutes({ webhooks }),
  })
  return Object.assign(runtime, { webhooks })
}
