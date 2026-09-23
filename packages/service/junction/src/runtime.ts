import {
  type Clock,
  createRuntime as createServiceRuntime,
  type RequestLog,
  type ServiceRuntime,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { junctionAdminRoutes } from "./admin.js"
import type { IdentityMode, JunctionFixtures } from "./fixtures.js"
import { document } from "./generated/openapi.js"
import { JUNCTION_NAMESPACE, JunctionAPI } from "./index.js"
import type { LabAccountLayout } from "./lab-account-presets.js"
import type { JunctionLimitsInput } from "./limits.js"
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
  /** The team's lab accounts, or `{ presets, accounts }`; see {@link JunctionAPIOptions.labAccounts}. */
  labAccounts?: LabAccountLayout
  /** The team the mock answers as. Default: the corpus's recorded team, else a fixed id. */
  teamId?: string
  /** Sandbox-only restrictions, every one off by default; per namespace via `PUT /__admin/limits`. */
  limits?: JunctionLimitsInput
  /** `adopt-users` creates unknown user ids on first use. Default `strict`. */
  identity?: IdentityMode
  /** Users and orders every namespace starts with, re-applied on each reset. */
  fixtures?: JunctionFixtures
  /** Requests each namespace's journal keeps (`GET /__admin/requests`). Default 1000. */
  journalSize?: number
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
    ...(options.journalSize !== undefined ? { journalSize: options.journalSize } : {}),
    create: ({ namespace, publicNamespace, sqlite, clock, rng }) => {
      const api = new JunctionAPI({
        sqlite,
        namespace,
        now: clock.now,
        webhook: { seed: rng.seed },
        ...(options.corpus ? { corpus: options.corpus } : {}),
        ...(options.geo ? { geo: options.geo } : {}),
        ...(options.labAccounts ? { labAccounts: options.labAccounts } : {}),
        ...(options.teamId !== undefined ? { teamId: options.teamId } : {}),
        ...(options.limits ? { limits: options.limits } : {}),
        ...(options.identity ? { identity: options.identity } : {}),
        ...(options.fixtures ? { fixtures: options.fixtures } : {}),
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
        teamId: runtime.instance().teamId,
        webhooks: webhooks ? "on" : "off",
      }
    },
    admin: junctionAdminRoutes({ webhooks }),
  })
  return Object.assign(runtime, { webhooks })
}
