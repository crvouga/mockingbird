import { type Checkpoint, type FetchAPI, Timeline } from "@crvouga/mockingbird-core"
import { listOperations, type OpenAPIDocument } from "@crvouga/mockingbird-openapi"
import { clearNamespace, type SqliteClient } from "@crvouga/mockingbird-sqlite"
import { type Clock, createClock } from "./clock.js"
import { type AdminRoutes, createControlPlane, NAMESPACE_HEADER } from "./control.js"
import { type CredentialRegistry, createCredentialRegistry, maskCredential } from "./credentials.js"
import {
  createFaultRegistry,
  type FaultHit,
  type FaultPreset,
  type FaultRegistry,
  type FaultRule,
} from "./faults.js"
import { createJournal, DEFAULT_JOURNAL_SIZE, type Journal, responseNotes } from "./journal.js"
import { createMetrics, type Metrics, type RejectedRequest, type RequestLog } from "./metrics.js"
import { createRng, type Rng, seedFrom } from "./rng.js"
import { bootSqlite } from "./service.js"
import { type NamespaceSnapshot, restoreNamespace, snapshotNamespace } from "./snapshot.js"
import { PACKAGE_VERSION } from "./version.js"
import { type WebhookHub, webhookAdminRoutes } from "./webhooks.js"

/**
 * Stamped on every response the runtime returns — vendor, fault, admin and health alike —
 * as `<service>@<version>; ns=<namespace>`, so a consumer can tell the mock from the vendor.
 */
export const MOCKINGBIRD_HEADER = "x-mockingbird"
/** Selects a named copy-on-write history branch. `main` is the compatibility default. */
export const BRANCH_HEADER = "x-mockingbird-branch"
/** Reads a historical checkpoint. With a branch header, initializes that branch from it. */
export const AT_HEADER = "x-mockingbird-at"
/** Identifies the resulting checkpoint on successful mutations. */
export const CHECKPOINT_HEADER = "x-mockingbird-checkpoint"

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
  /**
   * The vendor credential a request carries (API key, token, account SID, AWS access key
   * id), for SDKs that cannot send `x-mockingbird-namespace`: a suite maps credentials to
   * namespaces with `PUT /__admin/credentials`. See `bearerToken`, `basicAuth`,
   * `sigV4AccessKeyId`.
   */
  credential?: (request: Request) => string | undefined
  /** Named faults, switched on with `POST /__admin/faults {"preset": "<name>"}`. */
  presets?: Record<string, FaultPreset>
  /** Outbound webhooks; adds the `/__admin/webhooks*` routes and clears on reset. */
  webhooks?: WebhookHub
  /** Retained time-travel checkpoints per namespace. Default 1,000. */
  maxCheckpoints?: number
  /** Injectable process IO used for observability and delays; logical service time uses `clock`. */
  io?: Partial<RuntimeIO>
}

export type RuntimeIO = {
  wallNow(): number
  monotonicNow(): number
  sleep(ms: number): Promise<void>
}

export type ServiceTimelineState = Readonly<{
  snapshot: NamespaceSnapshot
  clock: Readonly<ReturnType<Clock["state"]>>
  rngState: number
}>

export type ServiceCheckpoint = Checkpoint<ServiceTimelineState>

export type ServiceRuntime<T extends ServiceInstance> = FetchAPI & {
  readonly name: string
  readonly sqlite: SqliteClient
  readonly clock: Clock
  readonly faults: FaultRegistry
  readonly metrics: Metrics
  readonly journal: Journal
  readonly rng: Rng
  readonly credentials: CredentialRegistry
  /** The webhook hub, when the service has outbound webhooks. */
  readonly webhooks: WebhookHub | undefined
  /** Expand a named preset into fault rules (and webhook faults) for `namespace`. */
  applyPreset(name: string, namespace?: string, overrides?: Partial<FaultRule>): FaultRule[]
  /** The instance behind `namespace` (the default one when omitted), created on first use. */
  instance(namespace?: string): T
  /** Public names of every namespace created so far. */
  namespaces(): string[]
  /** Reset one namespace, or every namespace with `"*"`. */
  reset(namespace?: string): Promise<void>
  snapshot(namespace?: string): NamespaceSnapshot
  restore(snapshot: NamespaceSnapshot, namespace?: string): void
  /** Capture the current branch. Mutating HTTP calls do this automatically. */
  checkpoint(namespace?: string, branch?: string): ServiceCheckpoint
  /** Create an isolated branch, optionally from a historical checkpoint. */
  branch(name: string, options?: { namespace?: string; at?: string }): ServiceCheckpoint
  /** Restore a branch, clock, and PRNG to a checkpoint. */
  checkout(checkpoint: string, options?: { namespace?: string; branch?: string }): void
  /** Inspect the retained history for a namespace. */
  timeline(namespace?: string): Timeline<ServiceTimelineState>
}

/** The namespace used when a request names none. */
export const DEFAULT_NAMESPACE = "default"

const NAMESPACE_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/

/** `/ns/<namespace>/…`: the namespace carrier for SDKs that only take a base URL. */
const PATH_PREFIX = /^\/ns\/([^/]+)(\/.*)?$/
const BRANCH_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"])

const effects = new WeakMap<Request, FaultHit["effect"][]>()

/**
 * Merge two sorted snapshot row arrays, retaining byte-identical old objects. Unlike the previous
 * Map/string-key implementation this is allocation-free apart from the result array and O(n).
 */
const reuseSorted = <T>(
  fresh: T[],
  previous: T[] | undefined,
  compare: (left: T, right: T) => number,
  equal: (left: T, right: T) => boolean,
): T[] => {
  if (!previous || previous.length === 0) return fresh.map((row) => Object.freeze(row))
  const result = new Array<T>(fresh.length)
  let unchanged = fresh.length === previous.length
  let oldIndex = 0
  for (let index = 0; index < fresh.length; index++) {
    const row = fresh[index] as T
    while (oldIndex < previous.length && compare(previous[oldIndex] as T, row) < 0) {
      oldIndex++
    }
    const old = previous[oldIndex]
    result[index] =
      old !== undefined && compare(old, row) === 0 && equal(old, row) ? old : Object.freeze(row)
    if (result[index] !== previous[index]) unchanged = false
  }
  return unchanged ? previous : result
}

/**
 * The fault effects (`{"effect": "created_but_500"}` rules) that fired for this request, in
 * rule order. Handlers read this to switch on a named vendor misbehaviour.
 */
export const faultEffects = (
  request: Request,
): { name: string; params: Record<string, unknown> }[] =>
  (effects.get(request) ?? []).filter((e): e is NonNullable<typeof e> => e !== undefined)

/** Whether the named effect fired for this request; its params when it did. */
export const faultEffect = (request: Request, name: string): Record<string, unknown> | undefined =>
  faultEffects(request).find((e) => e.name === name)?.params

/**
 * Thrown by an in-process `runtime.fetch` when a `drop` fault fires: the same thing a real
 * `fetch` does when the connection dies mid-request. A served mock destroys the socket.
 */
export class DroppedConnectionError extends TypeError {
  readonly code = "MOCKINGBIRD_DROP"
  constructor() {
    super("fetch failed: connection dropped by Mockingbird fault")
    this.name = "TypeError"
  }
}

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
  const wallNow = options.io?.wallNow ?? Date.now
  const monotonicNow = options.io?.monotonicNow ?? (() => performance.now())
  const sleep =
    options.io?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const faults = createFaultRegistry(createRng(options.seed ?? 0), sleep)
  const metrics = createMetrics()
  const journal = createJournal(options.journalSize ?? DEFAULT_JOURNAL_SIZE)
  const version = options.version ?? PACKAGE_VERSION
  const instances = new Map<string, T>()
  const publicNamespaces = new Set<string>()
  const branchRngs = new Map<string, Rng>()
  const timelines = new Map<string, Timeline<ServiceTimelineState>>()
  const branchStorage = new Map<string, string>()
  const captured = new Map<string, NamespaceSnapshot>()
  const credentials = createCredentialRegistry()
  const operationIdFor = options.document ? operationMatcher(options.document) : () => undefined

  const storageNamespace = (name: string) =>
    name === DEFAULT_NAMESPACE ? options.name : `${options.name}:${name}`

  const instanceFor = (key: string, publicNamespace = key, isolatedRng?: Rng): T => {
    const existing = instances.get(key)
    if (existing) return existing
    if (!NAMESPACE_PATTERN.test(key) || !NAMESPACE_PATTERN.test(publicNamespace)) {
      throw new RangeError(
        `namespace must match ${NAMESPACE_PATTERN}: ${JSON.stringify(publicNamespace)}`,
      )
    }
    const created = options.create({
      namespace: storageNamespace(key),
      publicNamespace,
      sqlite,
      clock,
      rng: isolatedRng ?? rng,
    })
    instances.set(key, created)
    publicNamespaces.add(publicNamespace)
    if (isolatedRng) branchRngs.set(key, isolatedRng)
    return created
  }

  const instance = (name: string = DEFAULT_NAMESPACE): T => instanceFor(name)

  const capture = (storage: string): ServiceTimelineState => {
    const fresh = snapshotNamespace(sqlite, storageNamespace(storage))
    const previous = captured.get(storage)
    const snapshot: NamespaceSnapshot = {
      namespace: fresh.namespace,
      records: reuseSorted(
        fresh.records,
        previous?.records,
        (left, right) =>
          left.collection < right.collection
            ? -1
            : left.collection > right.collection
              ? 1
              : left.seq - right.seq,
        (left, right) => left.id === right.id && left.value === right.value,
      ),
      sequences: reuseSorted(
        fresh.sequences,
        previous?.sequences,
        (left, right) =>
          left.name < right.name
            ? -1
            : left.name > right.name
              ? 1
              : left.kind < right.kind
                ? -1
                : left.kind > right.kind
                  ? 1
                  : 0,
        (left, right) => left.value === right.value,
      ),
    }
    Object.freeze(snapshot.records)
    Object.freeze(snapshot.sequences)
    Object.freeze(snapshot)
    captured.set(storage, snapshot)
    return Object.freeze({
      snapshot,
      clock: Object.freeze(clock.state()),
      rngState: (branchRngs.get(storage) ?? rng).state(),
    })
  }

  const timeline = (name: string = DEFAULT_NAMESPACE): Timeline<ServiceTimelineState> => {
    let found = timelines.get(name)
    if (found) return found
    instance(name)
    found = new Timeline<ServiceTimelineState>({
      now: clock.now,
      ...(options.maxCheckpoints !== undefined ? { maxCheckpoints: options.maxCheckpoints } : {}),
    })
    found.commit(capture(name))
    timelines.set(name, found)
    return found
  }

  const physicalBranch = (namespace: string, branch: string): string => {
    if (branch === "main") return namespace
    const mapKey = `${namespace}\0${branch}`
    const existing = branchStorage.get(mapKey)
    if (existing) return existing
    // The hash keeps the internal instance key inside the 64-character namespace contract.
    const key = `branch_${seedFrom(`${options.name}\0${namespace}\0${branch}`).toString(36)}`
    branchStorage.set(mapKey, key)
    return key
  }

  const ensureBranch = (namespace: string, branch: string, at?: string): string => {
    if (!BRANCH_PATTERN.test(branch)) throw new RangeError(`branch must match ${BRANCH_PATTERN}`)
    const history = timeline(namespace)
    if (branch === "main") {
      if (at !== undefined) {
        const point = history.checkout("main", at)
        restoreNamespace(sqlite, storageNamespace(namespace), point.value.snapshot)
        captured.set(namespace, point.value.snapshot)
        rng.setState(point.value.rngState)
        clock.set(point.value.clock.now)
        if (point.value.clock.frozen) clock.freeze()
        else clock.unfreeze()
      }
      return namespace
    }
    const storage = physicalBranch(namespace, branch)
    if (!history.hasBranch(branch)) {
      // Capture unobserved background work before branching from the current main head.
      if (at === undefined) history.commit(capture(namespace))
      const point = history.fork(branch, at === undefined ? {} : { from: at })
      const branchRng = createRng(options.seed ?? 0)
      if (point) branchRng.setState(point.value.rngState)
      instanceFor(storage, namespace, branchRng)
      if (point) restoreNamespace(sqlite, storageNamespace(storage), point.value.snapshot)
      if (point) captured.set(storage, point.value.snapshot)
    } else if (at !== undefined && history.head(branch)?.id !== at) {
      const point = history.checkout(branch, at)
      if (!instances.has(storage)) {
        const branchRng = createRng(options.seed ?? 0)
        branchRng.setState(point.value.rngState)
        instanceFor(storage, namespace, branchRng)
      }
      branchRngs.get(storage)?.setState(point.value.rngState)
      restoreNamespace(sqlite, storageNamespace(storage), point.value.snapshot)
      captured.set(storage, point.value.snapshot)
    } else {
      if (!instances.has(storage)) {
        const point = history.head(branch)
        const branchRng = createRng(options.seed ?? 0)
        if (point) branchRng.setState(point.value.rngState)
        instanceFor(storage, namespace, branchRng)
      }
    }
    return storage
  }

  const checkpoint = (namespace = DEFAULT_NAMESPACE, branch = "main"): ServiceCheckpoint => {
    const storage = ensureBranch(namespace, branch)
    return timeline(namespace).commit(capture(storage), { branch })
  }

  const branch = (
    name: string,
    branchOptions: { namespace?: string; at?: string } = {},
  ): ServiceCheckpoint => {
    const namespace = branchOptions.namespace ?? DEFAULT_NAMESPACE
    ensureBranch(namespace, name, branchOptions.at)
    const head = timeline(namespace).head(name)
    if (!head) throw new RangeError(`branch ${name} has no checkpoint`)
    return head
  }

  const checkout = (
    checkpointId: string,
    checkoutOptions: { namespace?: string; branch?: string } = {},
  ): void => {
    const namespace = checkoutOptions.namespace ?? DEFAULT_NAMESPACE
    const branchName = checkoutOptions.branch ?? "main"
    const history = timeline(namespace)
    const point = history.checkout(branchName, checkpointId)
    const storage = ensureBranch(namespace, branchName)
    restoreNamespace(sqlite, storageNamespace(storage), point.value.snapshot)
    captured.set(storage, point.value.snapshot)
    clock.set(point.value.clock.now)
    if (point.value.clock.frozen) clock.freeze()
    else clock.unfreeze()
    ;(branchRngs.get(storage) ?? rng).setState(point.value.rngState)
  }

  const reset = async (name: string = DEFAULT_NAMESPACE): Promise<void> => {
    if (name === "*") {
      options.webhooks?.clear()
      for (const each of instances.values()) await each.reset()
      timelines.clear()
      branchStorage.clear()
      branchRngs.clear()
      captured.clear()
      return
    }
    options.webhooks?.clear(name)
    const target = instances.get(name)
    if (target) await target.reset()
    else clearNamespace(sqlite, storageNamespace(name))
    for (const [mapping, storage] of branchStorage) {
      if (!mapping.startsWith(`${name}\0`)) continue
      const branchInstance = instances.get(storage)
      if (branchInstance) await branchInstance.reset()
      else clearNamespace(sqlite, storageNamespace(storage))
      branchStorage.delete(mapping)
      branchRngs.delete(storage)
      captured.delete(storage)
    }
    timelines.delete(name)
    captured.delete(name)
  }

  const snapshot = (name: string = DEFAULT_NAMESPACE): NamespaceSnapshot => {
    return checkpoint(name, "main").value.snapshot
  }

  const restore = (from: NamespaceSnapshot, name: string = DEFAULT_NAMESPACE): void => {
    instance(name)
    restoreNamespace(sqlite, storageNamespace(name), from)
    captured.set(name, from)
    // Import legacy snapshots into the canonical history instead of creating a second rollback
    // mechanism. The compatibility method stays synchronous and keeps its original return type.
    const history = timelines.get(name)
    if (history) history.commit(capture(name), { branch: "main" })
    else timeline(name)
  }

  const runtime: ServiceRuntime<T> = {
    name: options.name,
    sqlite,
    clock,
    faults,
    metrics,
    journal,
    rng,
    credentials,
    webhooks: options.webhooks,
    applyPreset: (name, namespace = DEFAULT_NAMESPACE, overrides = {}) => {
      const preset = options.presets?.[name]
      if (!preset) throw new RangeError(`no fault preset ${JSON.stringify(name)}`)
      const added = (preset.rules ?? []).map((rule, index) =>
        faults.add({
          namespace,
          ...rule,
          ...overrides,
          preset: name,
          id: `${overrides.id ?? name}${(preset.rules ?? []).length > 1 ? `_${index + 1}` : ""}`,
        } as FaultRule),
      )
      if (preset.webhook && options.webhooks) {
        options.webhooks.fault(namespace, {
          ...preset.webhook,
          ...(overrides.count !== undefined ? { count: overrides.count } : {}),
        })
      }
      return added
    },
    instance,
    namespaces: () => [...publicNamespaces].sort(),
    reset,
    snapshot,
    restore,
    checkpoint,
    branch,
    checkout,
    timeline,
    fetch: async (incoming) => {
      let request = incoming
      // `/ns/<name>/…` selects a namespace (and is stripped) for SDKs that cannot add headers.
      const prefixed = PATH_PREFIX.exec(new URL(request.url).pathname)
      if (prefixed) {
        const url = new URL(request.url)
        url.pathname = prefixed[2] ?? "/"
        const headers = new Headers(request.headers)
        if (!headers.has(NAMESPACE_HEADER)) {
          headers.set(NAMESPACE_HEADER, decodeURIComponent(prefixed[1] as string))
        }
        const hasBody = request.method !== "GET" && request.method !== "HEAD"
        request = new Request(url, {
          method: request.method,
          headers,
          ...(hasBody ? { body: await request.arrayBuffer() } : {}),
          signal: request.signal,
        })
      }
      let namespace = control.namespaceOf(request)
      if (!request.headers.has(NAMESPACE_HEADER) && options.credential) {
        const credential = options.credential(request)
        const mapped = credential !== undefined ? credentials.get(credential) : undefined
        if (mapped !== undefined) namespace = mapped
      }
      const selectedBranch = request.headers.get(BRANCH_HEADER) ?? "main"
      const at = request.headers.get(AT_HEADER) ?? undefined
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
      const started = monotonicNow()
      const url = new URL(request.url)
      const operationId = operationIdFor(request, url.pathname)
      // The body is buffered so a rejection can record how many bytes arrived (never what).
      const received: RejectedRequest = {
        contentType: request.headers.get("content-type"),
        bodyBytes: 0,
        transferEncoding: request.headers.get("transfer-encoding"),
      }
      if (request.method !== "GET" && request.method !== "HEAD" && request.body !== null) {
        const bytes = await request.arrayBuffer()
        received.bodyBytes = bytes.byteLength
        request = new Request(request.url, {
          method: request.method,
          headers: request.headers,
          body: bytes,
          signal: request.signal,
        })
      }
      const log = (status: number, faultId?: string, response?: Response) => {
        const noted = response ? responseNotes(response) : undefined
        const rejected = status >= 400 && faultId === undefined
        const entry: RequestLog = {
          service: options.name,
          namespace,
          operationId,
          method: request.method,
          path: url.pathname,
          status,
          durationMs: Math.round((monotonicNow() - started) * 100) / 100,
          unmatched: options.document !== undefined && operationId === undefined,
          ...(faultId !== undefined ? { faultId } : {}),
          ...(noted?.ids && Object.keys(noted.ids).length > 0 ? { ids: noted.ids } : {}),
          ...(noted?.adopted ? { adopted: true } : {}),
          ...(rejected ? { request: { ...received } } : {}),
          ...(rejected && noted?.issues && noted.issues.length > 0
            ? { issues: noted.issues.map((issue) => ({ ...issue })) }
            : {}),
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
      if (!BRANCH_PATTERN.test(selectedBranch)) {
        log(400)
        return stamp(adminFail(400, `${BRANCH_HEADER} must match ${BRANCH_PATTERN}`))
      }
      let storage: string
      try {
        if (
          at !== undefined &&
          selectedBranch === "main" &&
          !MUTATING_METHODS.has(request.method)
        ) {
          const point = timeline(namespace).get(at)
          storage = physicalBranch(namespace, `at_${at}`)
          let viewRng = branchRngs.get(storage)
          if (!viewRng) {
            viewRng = createRng(options.seed ?? 0)
            instanceFor(storage, namespace, viewRng)
          }
          viewRng.setState(point.value.rngState)
          restoreNamespace(sqlite, storageNamespace(storage), point.value.snapshot)
          captured.set(storage, point.value.snapshot)
        } else {
          storage = ensureBranch(namespace, selectedBranch, at)
        }
      } catch (error) {
        log(409)
        return stamp(adminFail(409, error instanceof Error ? error.message : String(error)))
      }
      const hits = await faults.take({
        operationId,
        method: request.method,
        path: url.pathname,
        namespace,
      })
      const final = hits.find((hit) => hit.drop || hit.response)
      if (final?.drop) {
        log(0, final.id)
        throw new DroppedConnectionError()
      }
      if (final?.response) {
        log(final.response.status, final.id)
        return stamp(final.response)
      }
      const fired = hits.filter((hit) => hit.effect !== undefined)
      if (fired.length > 0)
        effects.set(
          request,
          fired.map((hit) => hit.effect),
        )
      let response = await instanceFor(storage, namespace).fetch(request)
      if (MUTATING_METHODS.has(request.method) && response.status >= 200 && response.status < 400) {
        const point = timeline(namespace).commit(capture(storage), { branch: selectedBranch })
        response = mutableResponse(response)
        response.headers.set(CHECKPOINT_HEADER, point.id)
      }
      if (selectedBranch !== "main") {
        response = mutableResponse(response)
        response.headers.set(BRANCH_HEADER, selectedBranch)
      }
      if (at !== undefined) {
        response = mutableResponse(response)
        response.headers.set(AT_HEADER, at)
      }
      log(response.status, fired[0]?.id, response)
      return stamp(response)
    },
  }

  const control = createControlPlane({
    name: options.name,
    startedAt: wallNow(),
    wallNow,
    clock,
    faults,
    metrics,
    journal,
    defaultNamespace: DEFAULT_NAMESPACE,
    namespaces: runtime.namespaces,
    reset,
    timeTravel: {
      checkpoint: (name, branchName) => {
        const point = checkpoint(name, branchName)
        return {
          id: point.id,
          branch: point.branch,
          parent: point.parent,
          at: point.at,
          records: point.value.snapshot.records.length,
        }
      },
      branch: (branchName, branchOptions) => {
        const point = branch(branchName, branchOptions)
        return { id: point.id, branch: point.branch, parent: point.parent, at: point.at }
      },
      checkout: (checkpointId, checkoutOptions) => checkout(checkpointId, checkoutOptions),
      retain: (name, checkpointId) => {
        timeline(name).retain(checkpointId)
      },
      release: (name, checkpointId) => timeline(name).release(checkpointId),
      inspect: (name) => {
        const history = timeline(name)
        return {
          branches: history.branches(),
          checkpoints: history.checkpoints().map(({ id, branch: branchName, parent, at }) => ({
            id,
            branch: branchName,
            parent,
            at,
          })),
        }
      },
    },
    describe: options.describe ?? (() => ({})),
    ...(options.presets
      ? {
          applyPreset: (name: string, namespace: string, overrides: Partial<FaultRule>) =>
            runtime.applyPreset(name, namespace, overrides),
        }
      : {}),
    routes: {
      ...credentialRoutes(credentials),
      ...(options.presets ? presetRoutes(options.presets, runtime) : {}),
      ...(options.webhooks ? webhookAdminRoutes(options.webhooks) : {}),
      ...(options.admin?.(runtime) ?? {}),
    },
    adminKey: options.adminKey,
  })

  return runtime
}

const mutableResponse = (response: Response): Response => {
  try {
    response.headers.set("x-mockingbird-mutable-probe", "1")
    response.headers.delete("x-mockingbird-mutable-probe")
    return response
  } catch {
    return new Response(response.body, response)
  }
}

const adminJson = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const adminFail = (status: number, message: string): Response =>
  adminJson(status, { error: { type: "mockingbird_admin", message } })

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * `PUT /__admin/credentials` accepts `{ credentials: { "<credential>": "<namespace>" } }`,
 * `[{ credential, namespace }]`, or `{ credentials: ["<credential>"] }` with `?namespace=`
 * (maps each to the calling namespace). `GET` lists them masked; `DELETE` removes one
 * (`?credential=`) or all.
 */
const credentialRoutes = (registry: CredentialRegistry): AdminRoutes => ({
  "GET /credentials": () =>
    adminJson(200, {
      credentials: registry.entries().map(({ credential, namespace }) => ({
        credential: maskCredential(credential),
        namespace,
      })),
    }),
  "PUT /credentials": ({ body, namespace }) => {
    const pairs: [string, string][] = []
    const list = Array.isArray(body) ? body : isObject(body) ? body.credentials : undefined
    if (Array.isArray(list)) {
      for (const each of list) {
        if (typeof each === "string") pairs.push([each, namespace])
        else if (isObject(each) && typeof each.credential === "string") {
          pairs.push([
            each.credential,
            typeof each.namespace === "string" ? each.namespace : namespace,
          ])
        } else return adminFail(400, "each entry is a credential string or {credential, namespace}")
      }
    } else if (isObject(list)) {
      for (const [credential, target] of Object.entries(list)) {
        if (typeof target !== "string")
          return adminFail(400, `namespace for ${credential} must be a string`)
        pairs.push([credential, target])
      }
    } else if (isObject(body) && typeof body.credential === "string") {
      pairs.push([body.credential, typeof body.namespace === "string" ? body.namespace : namespace])
    } else {
      return adminFail(400, 'expected {"credentials": {"<credential>": "<namespace>"}}')
    }
    for (const [credential, target] of pairs) {
      if (!NAMESPACE_PATTERN.test(target))
        return adminFail(400, `bad namespace ${JSON.stringify(target)}`)
      registry.set(credential, target)
    }
    return adminJson(200, { mapped: pairs.length })
  },
  "DELETE /credentials": ({ url }) => {
    const credential = url.searchParams.get("credential")
    if (credential === null) registry.clear()
    else registry.remove(credential)
    return adminJson(200, { status: "ok" })
  },
})

const presetRoutes = <T extends ServiceInstance>(
  presets: Record<string, FaultPreset>,
  runtime: ServiceRuntime<T>,
): AdminRoutes => ({
  "GET /faults/presets": () =>
    adminJson(200, {
      presets: Object.entries(presets).map(([name, preset]) => ({ name, ...preset })),
    }),
  "POST /faults/presets/:name": ({ params, body, namespace }) => {
    const name = params.name as string
    if (!presets[name])
      return adminFail(404, `no fault preset ${name}; GET /__admin/faults/presets`)
    const overrides = isObject(body) ? (body as Partial<FaultRule>) : {}
    return adminJson(201, { preset: name, rules: runtime.applyPreset(name, namespace, overrides) })
  },
})
