import type { FetchAPI } from "@crvouga/mockingbird-core"
import { listOperations, type OpenAPIDocument } from "@crvouga/mockingbird-openapi"
import { clearNamespace, type SqliteClient } from "@crvouga/mockingbird-sqlite"
import { type Clock, createClock } from "./clock.js"
import { type AdminRoutes, createControlPlane, NAMESPACE_HEADER } from "./control.js"
import { createFaultRegistry, type FaultRegistry } from "./faults.js"
import { createJournal, DEFAULT_JOURNAL_SIZE, type Journal, responseNotes } from "./journal.js"
import { createMetrics, type Metrics, type RequestLog } from "./metrics.js"
import { createRng, type Rng } from "./rng.js"
import { bootSqlite } from "./service.js"
import { type NamespaceSnapshot, restoreNamespace, snapshotNamespace } from "./snapshot.js"
import { PACKAGE_VERSION } from "./version.js"

/**
 * Stamped on every response the runtime returns — vendor, fault, admin and health alike —
 * as `<service>@<version>; ns=<namespace>`, so a consumer can tell the mock from the vendor.
 */
export const MOCKINGBIRD_HEADER = "x-mockingbird"

/** What the runtime needs from a service: a Fetch handler it can reset. */
export type ServiceInstance = FetchAPI & { reset(): Promise<void> }

/** Everything an instance shares with the runtime that owns it. */
export type InstanceContext = {
  /** Storage namespace for this instance's records. */
  namespace: string
  /** The public namespace name a request selects it by. */
  publicNamespace: string
  sqlite: SqliteClient
  clock: Clock
  rng: Rng
}

export type RuntimeOptions<T extends ServiceInstance> = {
  /** Service name, e.g. `"junction"`. Also the default namespace's storage key. */
  name: string
  /** Build the instance backing one namespace. Called once per namespace, on first use. */
  create: (context: InstanceContext) => T
  /** The vendor contract, used to name each request's operation in logs, metrics and faults. */
  document?: OpenAPIDocument
  /** Shared by every namespace. Defaults to a fresh `@crvouga/mockingbird-service-sqlite`. */
  sqlite?: SqliteClient
  /** Defaults to a live clock over `Date.now`. */
  clock?: Clock
  /** Seeds every random choice the runtime makes (fault rates). Default `0`. */
  seed?: number | string
  /** Extra `GET /health` fields, such as the loaded corpus version. */
  describe?: () => Record<string, unknown>
  /** Service-specific admin routes, given the runtime so they can reach any namespace. */
  admin?: (runtime: ServiceRuntime<T>) => AdminRoutes
  /** Require this value in `x-mockingbird-admin-key` on `/__admin/*`. Omit to leave admin open. */
  adminKey?: string
  /** Structured request log sink, called once per request. */
  onLog?: (entry: RequestLog) => void
  /** Requests each namespace's journal keeps (`GET /__admin/requests`). Default 1000; 0 turns it off. */
  journalSize?: number
  /** Reported in the `x-mockingbird` header. Default: the bundled package's version. */
  version?: string
}

export type ServiceRuntime<T extends ServiceInstance> = FetchAPI & {
  readonly name: string
  readonly sqlite: SqliteClient
  readonly clock: Clock
  readonly faults: FaultRegistry
  readonly metrics: Metrics
  readonly journal: Journal
  readonly rng: Rng
  /** The instance behind `namespace` (the default one when omitted), created on first use. */
  instance(namespace?: string): T
  /** Public names of every namespace created so far. */
  namespaces(): string[]
  /** Reset one namespace, or every namespace with `"*"`. */
  reset(namespace?: string): Promise<void>
  snapshot(namespace?: string): NamespaceSnapshot
  restore(snapshot: NamespaceSnapshot, namespace?: string): void
}

/** The namespace used when a request names none. */
export const DEFAULT_NAMESPACE = "default"

const NAMESPACE_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/

type Matcher = { operationId: string; method: string; pattern: RegExp; params: number }

/** Resolve a request to its operationId: static segments beat parameters, as in routing. */
const operationMatcher = (document: OpenAPIDocument) => {
  const matchers: Matcher[] = listOperations(document)
    .map((operation) => ({
      operationId: operation.operationId,
      method: operation.method.toUpperCase(),
      pattern: new RegExp(
        `^${operation.path
          .split("/")
          .map((segment) =>
            segment.startsWith("{") ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
          )
          .join("/")}/?$`,
      ),
      params: (operation.path.match(/\{/g) ?? []).length,
    }))
    .sort((a, b) => a.params - b.params)
  return (request: Request, path: string): string | undefined =>
    matchers.find((m) => m.method === request.method && m.pattern.test(path))?.operationId
}

/**
 * Wrap a service in the shared Mockingbird contract: an unauthenticated `/health`,
 * the `/__admin/*` control plane, per-request namespaces, a controllable clock,
 * fault injection, and request metrics.
 *
 * Namespaces isolate parallel workers inside one process: each gets its own
 * instance over the same SQLite database, so rows are partitioned by namespace
 * and a worker's reset or restore never touches another worker's data.
 */
export const createRuntime = <T extends ServiceInstance>(
  options: RuntimeOptions<T>,
): ServiceRuntime<T> => {
  const sqlite = bootSqlite(options.sqlite)
  const clock = options.clock ?? createClock()
  const rng = createRng(options.seed ?? 0)
  const faults = createFaultRegistry(createRng(options.seed ?? 0))
  const metrics = createMetrics()
  const journal = createJournal(options.journalSize ?? DEFAULT_JOURNAL_SIZE)
  const version = options.version ?? PACKAGE_VERSION
  const instances = new Map<string, T>()
  const operationIdFor = options.document ? operationMatcher(options.document) : () => undefined

  const storageNamespace = (name: string) =>
    name === DEFAULT_NAMESPACE ? options.name : `${options.name}:${name}`

  const instance = (name: string = DEFAULT_NAMESPACE): T => {
    const existing = instances.get(name)
    if (existing) return existing
    if (!NAMESPACE_PATTERN.test(name)) {
      throw new RangeError(`namespace must match ${NAMESPACE_PATTERN}: ${JSON.stringify(name)}`)
    }
    const created = options.create({
      namespace: storageNamespace(name),
      publicNamespace: name,
      sqlite,
      clock,
      rng,
    })
    instances.set(name, created)
    return created
  }

  const reset = async (name: string = DEFAULT_NAMESPACE): Promise<void> => {
    if (name === "*") {
      for (const each of instances.values()) await each.reset()
      return
    }
    const target = instances.get(name)
    if (target) await target.reset()
    else clearNamespace(sqlite, storageNamespace(name))
  }

  const snapshot = (name: string = DEFAULT_NAMESPACE): NamespaceSnapshot => {
    instance(name)
    return snapshotNamespace(sqlite, storageNamespace(name))
  }

  const restore = (from: NamespaceSnapshot, name: string = DEFAULT_NAMESPACE): void => {
    instance(name)
    restoreNamespace(sqlite, storageNamespace(name), from)
  }

  const runtime: ServiceRuntime<T> = {
    name: options.name,
    sqlite,
    clock,
    faults,
    metrics,
    journal,
    rng,
    instance,
    namespaces: () => [...instances.keys()].sort(),
    reset,
    snapshot,
    restore,
    fetch: async (request) => {
      const namespace = control.namespaceOf(request)
      const stamp = (response: Response): Response => {
        // An invalid namespace is not echoed back.
        const value = NAMESPACE_PATTERN.test(namespace)
          ? `${options.name}@${version}; ns=${namespace}`
          : `${options.name}@${version}`
        try {
          response.headers.set(MOCKINGBIRD_HEADER, value)
          return response
        } catch {
          // Immutable headers (a response passed through from `fetch`): copy it.
          const copy = new Response(response.body, response)
          copy.headers.set(MOCKINGBIRD_HEADER, value)
          return copy
        }
      }
      const handled = await control.handle(request)
      if (handled) return stamp(handled)
      const started = performance.now()
      const url = new URL(request.url)
      const operationId = operationIdFor(request, url.pathname)
      const log = (status: number, faultId?: string, response?: Response) => {
        const noted = response ? responseNotes(response) : undefined
        const entry: RequestLog = {
          service: options.name,
          namespace,
          operationId,
          method: request.method,
          path: url.pathname,
          status,
          durationMs: Math.round((performance.now() - started) * 100) / 100,
          unmatched: options.document !== undefined && operationId === undefined,
          ...(faultId !== undefined ? { faultId } : {}),
          ...(noted?.ids && Object.keys(noted.ids).length > 0 ? { ids: noted.ids } : {}),
          ...(noted?.adopted ? { adopted: true } : {}),
        }
        metrics.record(entry)
        journal.record({ ...entry, at: new Date(clock.now()).toISOString() })
        options.onLog?.(entry)
      }
      if (!NAMESPACE_PATTERN.test(namespace)) {
        log(400)
        return stamp(
          new Response(
            JSON.stringify({
              error: {
                type: "mockingbird_admin",
                message: `${NAMESPACE_HEADER} must match ${NAMESPACE_PATTERN}`,
              },
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          ),
        )
      }
      const faulted = await faults.take({
        operationId,
        method: request.method,
        path: url.pathname,
        namespace,
      })
      if (faulted) {
        log(faulted.response.status, faulted.id)
        return stamp(faulted.response)
      }
      const response = await instance(namespace).fetch(request)
      log(response.status, undefined, response)
      return stamp(response)
    },
  }

  const control = createControlPlane({
    name: options.name,
    startedAt: Date.now(),
    clock,
    faults,
    metrics,
    journal,
    defaultNamespace: DEFAULT_NAMESPACE,
    namespaces: runtime.namespaces,
    reset,
    snapshot: (name) => snapshot(name),
    restore: (name, from) => restore(from, name),
    describe: options.describe ?? (() => ({})),
    routes: options.admin?.(runtime) ?? {},
    adminKey: options.adminKey,
  })

  return runtime
}
