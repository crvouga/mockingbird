import {
  type Checkpoint,
  type FetchAPI,
  forwardMountContext,
  type MountedAPI,
  mount,
  Timeline,
} from "@crvouga/mockingbird-core"
import { listOperations, type OpenAPIDocument } from "@crvouga/mockingbird-openapi"
import { clearNamespace, type SqliteClient } from "@crvouga/mockingbird-sqlite"
import { adminUiRoutes } from "./admin-ui.js"
import {
  type Clock,
  type ClockState,
  createClock,
  type DerivedClock,
  deriveClock,
  restoreClock,
} from "./clock.js"
import {
  ADMIN_KEY_HEADER,
  ADMIN_PREFIX,
  type AdminRoutes,
  assertAdminPrefixAvailable,
  createControlPlane,
  isAdminPath,
  matchNamespacePath,
  NAMESPACE_HEADER,
  resolveAdminPrefix,
  type SnapshotInfo,
  type SnapshotStore,
} from "./control.js"
import {
  assertSnapshotDocument,
  CONTROL_HEADERS,
  ControlError,
  type ControlHeaderInput,
  type ControlPlan,
  controlHeaders,
  isRecord,
  KEY_PATTERN,
  type MockControls,
  type NamespaceControls as NamespaceControlsInput,
  normalizeBootControls,
  normalizeClock,
  normalizeControls,
  normalizeLatency,
  normalizeSeed,
  parseControlHeaders,
  type RequestControls,
  SNAPSHOT_FORMAT,
  type SnapshotDocument,
} from "./controls.js"
import { type CredentialRegistry, createCredentialRegistry, maskCredential } from "./credentials.js"
import {
  type FaultHit,
  type FaultPreset,
  type FaultRegistry,
  type FaultRule,
  normalizeFault,
} from "./faults.js"
import {
  createJournal,
  DEFAULT_JOURNAL_SIZE,
  type Journal,
  type ResponseNotes,
  responseNotes,
} from "./journal.js"
import type { LatencyRegistry } from "./latency.js"
import { createMetrics, type Metrics, type RejectedRequest, type RequestLog } from "./metrics.js"
import {
  type BootScope,
  type ControlSettings,
  type ControlState,
  type ControlsSnapshot,
  createNamespaceControls,
} from "./namespace-controls.js"
import { operationPath } from "./path.js"
import { createRng, type Rng, seedFrom } from "./rng.js"
import { bootSqlite } from "./service.js"
import { type NamespaceSnapshot, restoreNamespace, snapshotNamespace } from "./snapshot.js"
import {
  inspectState,
  type StateDeclaration,
  type StateView,
  stateAdminRoutes,
} from "./state-view.js"
import { type AdminUi, assertAdminUi, defineMock, type MockSurface } from "./surface.js"
import { PACKAGE_VERSION } from "./version.js"
import { type WebhookHub, webhookAdminRoutes } from "./webhooks.js"

/**
 * Stamped on every response the runtime returns — vendor, fault, admin and health alike —
 * as `<service>@<version>; ns=<namespace>`, so a consumer can tell the mock from the vendor.
 */
export const MOCKINGBIRD_HEADER = "x-mockingbird"
/** Selects a named copy-on-write history branch. `main` is the compatibility default. */
export const BRANCH_HEADER = CONTROL_HEADERS.branch
/** Reads a historical checkpoint. With a branch header, initializes that branch from it. */
export const AT_HEADER = CONTROL_HEADERS.at
/** Identifies the resulting checkpoint on successful mutations. */
export const CHECKPOINT_HEADER = "x-mockingbird-checkpoint"
/** On a response a fault rule answered or shaped: that rule's id. */
export const FAULT_HEADER = CONTROL_HEADERS.fault
/** On a response to a request that asked for a snapshot: the snapshot's id. */
export const SNAPSHOT_HEADER = CONTROL_HEADERS.snapshot

/** What the runtime needs from a service: a Fetch handler it can reset. */
export type ServiceInstance = FetchAPI & { reset(): Promise<void> }

/** Everything an instance shares with the runtime that owns it. */
export type InstanceContext = {
  /** Storage namespace for this instance's records. */
  namespace: string
  /** The public namespace name a request selects it by. */
  adminPrefix: string
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
  /** Seeds every random choice the runtime makes (fault rates, jitter). Default `0`. */
  seed?: number | string
  /**
   * Admin controls to boot with: clock, latency, faults, a starting snapshot, credential
   * mappings and per-namespace overrides. `reset` returns a namespace to exactly this.
   */
  adminControls?: MockControls
  /** Extra `GET /__admin/health` fields, such as the loaded corpus version. */
  describe?: () => Record<string, unknown>
  /** Service-specific admin routes, given the runtime so they can reach any namespace. */
  admin?: (runtime: ServiceRuntime<T>) => AdminRoutes
  /** Reserved tree for every internal HTTP endpoint, UI and namespace carrier. Default /__admin. */
  adminPrefix?: string
  /**
   * A namespace's clock was moved — by `/__admin/clock`, a header, a restore, a reset, or a
   * wait spent in virtual time. Run whatever the service schedules by that clock, so what
   * came due is seen at once and not on the next request. Moving the base clock in process
   * (`runtime.clock`) is the caller's own doing and is not reported here.
   */
  onClockChange?: (namespace: string) => void
  /** Invalidate transient handles before replacing an existing instance's stored state. */
  beforeRestore?: (instance: T) => void
  /** Require this value in `x-mockingbird-admin-key` on admin data routes. */
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
  /**
   * Named faults, switched on with `POST /__admin/faults {"preset": "<name>"}`. They join the
   * standard presets every mock has; one with a standard name replaces it.
   */
  presets?: Record<string, FaultPreset>
  /** Outbound webhooks; adds the `/__admin/webhooks*` routes and clears on reset. */
  webhooks?: WebhookHub
  /** Retained time-travel checkpoints per namespace. Default 1,000. */
  maxCheckpoints?: number
  /** Injectable process IO used for observability and delays; logical service time uses `clock`. */
  io?: Partial<RuntimeIO>
  /**
   * Collections the admin UI should show even before any row exists.
   * Stored collections are always included, whether or not they are declared.
   * A function may describe collections that depend on the live instance.
   */
  state?: readonly StateDeclaration[] | ((api: T, namespace: string) => readonly StateDeclaration[])
  /**
   * Panels added to the default admin UI, or a function that replaces the document.
   * `render` receives `defaultHtml()` so a bespoke UI can wrap the shared shell.
   */
  adminUi?: AdminUi
}

export type RuntimeIO = {
  wallNow(): number
  monotonicNow(): number
  /** Wait on the wall clock. Rejects with the signal's reason when it aborts first. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>
}

export type ServiceTimelineState = Readonly<{
  snapshot: NamespaceSnapshot
  /** `pinned`: the namespace's clock was frozen itself, not just following a frozen base. */
  clock: Readonly<ClockState & { pinned?: boolean }>
  rngState: number
}>

export type ServiceCheckpoint = Checkpoint<ServiceTimelineState>

export type ServiceRuntime<T extends ServiceInstance> = FetchAPI & {
  /** Stop package-owned lifecycle timers when a supervisor closes the runtime. */
  stop?(): void
  readonly name: string
  /** Same-origin Fetch handler and App Router method exports, sharing this runtime. */
  mount(prefix: string): MountedAPI
  readonly sqlite: SqliteClient
  readonly clock: Clock
  readonly faults: FaultRegistry
  /** Baseline response time per namespace. */
  readonly latency: LatencyRegistry
  readonly metrics: Metrics
  readonly journal: Journal
  readonly rng: Rng
  readonly credentials: CredentialRegistry
  /** The webhook hub, when the service has outbound webhooks. */
  readonly webhooks: WebhookHub | undefined
  /**
   * A namespace's clock. Each follows the base clock, {@link ServiceRuntime.clock}, with an
   * offset and a freeze of its own, so moving one never moves another.
   */
  namespaceClock(namespace?: string): Clock
  namespaceOf(request: Request): string
  /** Opaque in-process checkpoint including records, controls and webhook history. */
  fleetSnapshot(namespace: string): object
  fleetRestore(snapshot: unknown, namespace: string): void
  fleetExport(snapshot: unknown): SnapshotDocument
  fleetImport(namespace: string, document: unknown): object
  /** Expand a named preset into fault rules (and webhook faults) for `namespace`. */
  applyPreset(name: string, namespace?: string, overrides?: Partial<FaultRule>): FaultRule[]
  /** The instance behind `namespace` (the default one when omitted), created on first use. */
  instance(namespace?: string): T
  /** Public names of every namespace created so far. */
  namespaces(): string[]
  /** Return one namespace to its boot state, or every namespace with `"*"`. */
  reset(namespace?: string): Promise<void>
  /** Reset a namespace and forget it, releasing everything it held. */
  dropNamespace(namespace: string): Promise<void>
  /** A namespace's controls: seed, clock, virtual time, latency, faults and snapshots. */
  controls(namespace?: string): ControlState & { snapshots: SnapshotInfo[] }
  /** Apply a control document to a namespace. A given key replaces that control. */
  configure(
    controls: NamespaceControlsInput,
    namespace?: string,
  ): ControlState & { snapshots: SnapshotInfo[] }
  /** Named snapshots of a namespace: records, clock, random streams, faults and latency. */
  readonly snapshots: {
    /** Capture the namespace now. Reusing a name replaces that snapshot. */
    create(options?: { name?: string; namespace?: string }): SnapshotInfo
    list(namespace?: string): SnapshotInfo[]
    /** The snapshot as portable JSON, to commit beside a suite or boot another mock from. */
    export(id: string, namespace?: string): SnapshotDocument
    /** Store a document as a snapshot without restoring it. */
    import(
      document: SnapshotDocument,
      options?: { name?: string; namespace?: string },
    ): SnapshotInfo
    restore(id: string, namespace?: string): void
    delete(id: string, namespace?: string): boolean
  }
  /** Request headers that carry controls, checked: spread them into a `fetch` or an SDK's defaults. */
  headers(input: ControlHeaderInput): Record<string, string>
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
  /** Collections in one namespace: declared shape plus what the rows actually hold. */
  state(namespace?: string): StateView
}

type _MockSurfaceProof = ServiceRuntime<ServiceInstance> extends MockSurface ? true : never
const mockSurfaceProof: _MockSurfaceProof = true
void mockSurfaceProof

/** The namespace used when a request names none. */
export const DEFAULT_NAMESPACE = "default"

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"])

const effects = new WeakMap<Request, FaultHit["effect"][]>()

const acceptance = new WeakMap<Request, (notes: ResponseNotes) => void>()

/** Notify only after a durable mutation commits. No-op outside an active runtime request. */
export const markMutationAccepted = (request: Request, notes: ResponseNotes = {}): void => {
  acceptance.get(request)?.(notes)
}

/** Preserve request-bound effects and acceptance when a provider must rebuild a Request. */
export const forwardRequestContext = (source: Request, target: Request): Request => {
  const fired = effects.get(source)
  const accepted = acceptance.get(source)
  if (fired) effects.set(target, fired)
  if (accepted) acceptance.set(target, accepted)
  return forwardMountContext(source, target)
}

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
  /** Why the connection died: a `drop`, a `timeout` that ran out, or a `truncate`d body. */
  readonly reason: "drop" | "timeout" | "truncate"
  constructor(reason: "drop" | "timeout" | "truncate" = "drop") {
    super(
      reason === "timeout"
        ? "fetch failed: request timed out by Mockingbird fault"
        : reason === "truncate"
          ? "fetch failed: response truncated by Mockingbird fault"
          : "fetch failed: connection dropped by Mockingbird fault",
    )
    this.name = "TypeError"
    this.reason = reason
  }
}

const realSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const abort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort)
      resolve()
    }, ms)
    signal?.addEventListener("abort", abort, { once: true })
  })

const NULL_BODY_STATUS = new Set([101, 204, 205, 304])

/** Let `bytes` of the body through, then fail the stream the way a dying connection does. */
const truncateResponse = (response: Response, bytes: number): Response => {
  if (NULL_BODY_STATUS.has(response.status)) return response
  const reader = response.body?.getReader()
  let sent = 0
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const chunk = sent < bytes && reader ? await reader.read() : undefined
      if (!chunk || chunk.done) {
        await reader?.cancel().catch(() => {})
        controller.error(new DroppedConnectionError("truncate"))
        return
      }
      const part = chunk.value.subarray(0, bytes - sent)
      sent += part.length
      controller.enqueue(part)
    },
    cancel: (reason) => reader?.cancel(reason),
  })
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  return new Response(body, { status: response.status, statusText: response.statusText, headers })
}

/** What a snapshot holds for one namespace. Only `records` is always there. */
type Kept = {
  records: NamespaceSnapshot
  clock?: { now: number; frozen: boolean; pinned?: boolean }
  /** Where the service's own random stream stands. */
  rngState?: number
  controls: ControlsSnapshot
  webhooks?: unknown
}
type Stored = Kept & { info: SnapshotInfo }

type Matcher = { operationId: string; method: string; pattern: RegExp; params: number }

/** Resolve a request to its operationId: static segments beat parameters, as in routing. */
const operationMatcher = (document: OpenAPIDocument) => {
  const matchers: Matcher[] = listOperations(document)
    .map((operation) => ({
      operationId: operation.operationId,
      method: operation.method.toUpperCase(),
      pattern: operationPath(operation).pattern,
      params: (operation.path.match(/\{/g) ?? []).length,
    }))
    .sort((a, b) => a.params - b.params)
  return (request: Request, path: string): string | undefined =>
    matchers.find((m) => m.method === request.method && m.pattern.test(path))?.operationId
}

/**
 * Wrap a service in the shared Mockingbird contract: an unauthenticated `/__admin/health`,
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
  const adminPrefix = resolveAdminPrefix(options.adminPrefix)
  const internalPaths = Object.entries(options.document?.paths ?? {})
    .filter(([, item]) => item["x-mockingbird-internal"] === true)
    .map(([path]) => path)
  for (const path of internalPaths) {
    if (!path.startsWith(`${ADMIN_PREFIX}/blobs/`))
      throw new Error(`internal transport ${path} must live under ${ADMIN_PREFIX}/blobs/`)
  }
  assertAdminPrefixAvailable(
    adminPrefix,
    Object.keys(options.document?.paths ?? {}).filter((path) => !internalPaths.includes(path)),
  )
  const internalMatch = (path: string): string | undefined => {
    for (const pattern of internalPaths) {
      const actual = path.split("/")
      const expected = pattern.split("/")
      if (
        actual.length === expected.length &&
        expected.every((part, i) => part.startsWith("{") || part === actual[i])
      )
        return pattern
    }
    return undefined
  }
  assertAdminUi(options.adminUi)
  const boot = normalizeBootControls(options.adminControls, "adminControls")
  const seed = normalizeSeed(options.seed ?? boot.shared.seed ?? 0)
  // Named outright, the seed is a boot control like any other: it wins over a boot snapshot's.
  if (options.seed !== undefined) boot.shared.seed = seed
  const sqlite = bootSqlite(options.sqlite)
  const clock = options.clock ?? createClock()
  // The shared boot clock is the base clock, which every namespace follows. What a namespace
  // keeps of it for itself is how far its own clock steps before each request.
  const { now: bootNow, frozen: bootFrozen, ...stepping } = boot.shared.clock ?? {}
  if (bootFrozen === true) clock.freeze()
  if (bootNow !== undefined) clock.set(bootNow)
  if (bootFrozen === false) clock.unfreeze()
  const bootClockGiven = bootNow !== undefined || bootFrozen !== undefined
  if (stepping.autoAdvanceMs !== undefined) boot.shared.clock = stepping
  else delete boot.shared.clock
  /** Where the base clock stood when the runtime was created: what a full reset returns it to. */
  const bootClock = clock.state()
  const rng = createRng(seed)
  const wallNow = options.io?.wallNow ?? Date.now
  const monotonicNow = options.io?.monotonicNow ?? (() => performance.now())
  const sleep = options.io?.sleep ?? realSleep
  const metrics = createMetrics()
  const journal = createJournal(options.journalSize ?? DEFAULT_JOURNAL_SIZE)
  const version = options.version ?? PACKAGE_VERSION
  const instances = new Map<string, T>()
  const publicNamespaces = new Set<string>()
  /** The service's own random stream, by storage key. `default` uses {@link rng}. */
  const rngs = new Map<string, Rng>()
  const namespaceClocks = new Map<string, DerivedClock>()
  const namespaceForStorage = new Map<string, string>()
  /**
   * Every namespace has a clock of its own that follows the base clock. Moving one never
   * moves another; moving the base (`runtime.clock`) moves every namespace that is not frozen.
   */
  const namespaceClock = (name = DEFAULT_NAMESPACE): DerivedClock => {
    let found = namespaceClocks.get(name)
    if (!found) {
      found = deriveClock(clock, () => options.onClockChange?.(name))
      namespaceClocks.set(name, found)
    }
    return found
  }
  const fleetPoints = new WeakMap<object, { namespace: string } & Kept>()
  const timelines = new Map<string, Timeline<ServiceTimelineState>>()
  const branchStorage = new Map<string, string>()
  const captured = new Map<string, NamespaceSnapshot>()
  const credentials = createCredentialRegistry()
  for (const [credential, target] of Object.entries(boot.credentials))
    credentials.set(credential, target)
  const operationIdFor = options.document ? operationMatcher(options.document) : () => undefined

  const controls = createNamespaceControls({
    seed,
    clock: namespaceClock,
    boot,
    ...(options.presets ? { presets: options.presets } : {}),
    sleep: (ms) => sleep(ms),
    onReseed: (namespace, next) => {
      rngFor(namespace).reseed(next)
      for (const [mapping, storage] of branchStorage)
        if (mapping.startsWith(`${namespace}\0`)) rngs.get(storage)?.reseed(next)
    },
    onPreset: (preset, namespace, overrides) => {
      if (preset.webhook)
        options.webhooks?.fault(namespace, {
          ...preset.webhook,
          ...(overrides.count !== undefined ? { count: overrides.count } : {}),
        })
    },
    restoreDocument: (namespace, document, scope) => {
      const { clock: carried, ...point } = fromDocument(namespace, document)
      // A boot clock named outright is the base clock's; the snapshot's does not override it.
      restoreAll(
        namespace,
        bootClockGiven || !carried ? point : { ...point, clock: carried },
        scope,
      )
    },
  })
  const { faults, latency } = controls

  /** The random stream behind a storage key, created at its namespace's seed. */
  const rngFor = (storage: string): Rng => {
    if (storage === DEFAULT_NAMESPACE) return rng
    let found = rngs.get(storage)
    if (!found) {
      found = createRng(seed)
      rngs.set(storage, found)
    }
    return found
  }
  const seedOf = (namespace: string): number | string => controls.settings(namespace).seed

  const storageNamespace = (name: string) =>
    name === DEFAULT_NAMESPACE ? options.name : `${options.name}:${name}`

  const instanceFor = (key: string, publicNamespace = key, isolatedRng?: Rng): T => {
    const existing = instances.get(key)
    if (existing) return existing
    if (!KEY_PATTERN.test(key) || !KEY_PATTERN.test(publicNamespace)) {
      throw new RangeError(
        `namespace must match ${KEY_PATTERN}: ${JSON.stringify(publicNamespace)}`,
      )
    }
    if (isolatedRng) rngs.set(key, isolatedRng)
    const created = options.create({
      namespace: storageNamespace(key),
      publicNamespace,
      adminPrefix,
      sqlite,
      clock: namespaceClock(publicNamespace),
      rng: rngFor(key),
    })
    instances.set(key, created)
    namespaceForStorage.set(key, publicNamespace)
    publicNamespaces.add(publicNamespace)
    // A namespace starts from its boot controls and, when one is given, its boot snapshot.
    if (key === publicNamespace) controls.ensure(key)
    return created
  }

  const instance = (name: string = DEFAULT_NAMESPACE): T => instanceFor(name)

  /** A namespace's clock as a checkpoint keeps it, and how one is put back. */
  const clockOf = (namespace: string): ServiceTimelineState["clock"] => {
    const own = namespaceClock(namespace)
    return Object.freeze({ ...own.state(), pinned: own.pinned() })
  }
  const placeClock = (
    namespace: string,
    state: { now: number; frozen: boolean; pinned?: boolean },
  ): void =>
    // A document only says frozen or not; frozen there means frozen at that instant.
    namespaceClock(namespace).place({ now: state.now, pinned: state.pinned ?? state.frozen })

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
      clock: clockOf(namespaceForStorage.get(storage) ?? storage),
      rngState: rngFor(storage).state(),
    })
  }

  const timeline = (name: string = DEFAULT_NAMESPACE): Timeline<ServiceTimelineState> => {
    let found = timelines.get(name)
    if (found) return found
    instance(name)
    found = new Timeline<ServiceTimelineState>({
      now: namespaceClock(name).now,
      ...(options.maxCheckpoints !== undefined ? { maxCheckpoints: options.maxCheckpoints } : {}),
    })
    found.commit(capture(name))
    timelines.set(name, found)
    return found
  }

  const restoreStorage = (storage: string, snapshot: NamespaceSnapshot): void => {
    const current = instances.get(storage)
    if (current) options.beforeRestore?.(current)
    restoreNamespace(sqlite, storageNamespace(storage), snapshot)
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
    if (!KEY_PATTERN.test(branch)) throw new RangeError(`branch must match ${KEY_PATTERN}`)
    const history = timeline(namespace)
    if (branch === "main") {
      if (at !== undefined) {
        const point = history.checkout("main", at)
        restoreStorage(namespace, point.value.snapshot)
        captured.set(namespace, point.value.snapshot)
        rngFor(namespace).setState(point.value.rngState)
        placeClock(namespace, point.value.clock)
      }
      return namespace
    }
    const storage = physicalBranch(namespace, branch)
    if (!history.hasBranch(branch)) {
      // Capture unobserved background work before branching from the current main head.
      if (at === undefined) history.commit(capture(namespace))
      const point = history.fork(branch, at === undefined ? {} : { from: at })
      const branchRng = createRng(seedOf(namespace))
      if (point) branchRng.setState(point.value.rngState)
      instanceFor(storage, namespace, branchRng)
      if (point) restoreStorage(storage, point.value.snapshot)
      if (point) captured.set(storage, point.value.snapshot)
    } else if (at !== undefined && history.head(branch)?.id !== at) {
      const point = history.checkout(branch, at)
      if (!instances.has(storage)) {
        const branchRng = createRng(seedOf(namespace))
        branchRng.setState(point.value.rngState)
        instanceFor(storage, namespace, branchRng)
      }
      rngFor(storage).setState(point.value.rngState)
      restoreStorage(storage, point.value.snapshot)
      captured.set(storage, point.value.snapshot)
    } else {
      if (!instances.has(storage)) {
        const point = history.head(branch)
        const branchRng = createRng(seedOf(namespace))
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
    restoreStorage(storage, point.value.snapshot)
    captured.set(storage, point.value.snapshot)
    placeClock(namespace, point.value.clock)
    rngFor(storage).setState(point.value.rngState)
  }

  const reset = async (name: string = DEFAULT_NAMESPACE): Promise<void> => {
    if (name === "*") {
      options.webhooks?.clear()
      for (const each of instances.values()) await each.reset()
      timelines.clear()
      for (const storage of branchStorage.values()) {
        instances.delete(storage)
        rngs.delete(storage)
        namespaceForStorage.delete(storage)
      }
      branchStorage.clear()
      captured.clear()
      snapshotStore.clear()
      journal.clear()
      metrics.reset()
      // The base clock goes back to where the runtime found it; a live one keeps running.
      if (bootClock.frozen) restoreClock(clock, bootClock)
      else {
        clock.reset()
        clock.advance(bootClock.offsetMs)
      }
      controls.rebootAll()
      for (const each of new Set([DEFAULT_NAMESPACE, ...publicNamespaces])) controls.ensure(each)
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
      instances.delete(storage)
      namespaceForStorage.delete(storage)
      rngs.delete(storage)
      captured.delete(storage)
    }
    timelines.delete(name)
    captured.delete(name)
    snapshotStore.clear(name)
    journal.clear(name)
    metrics.reset(name)
    // Seed, clock, faults, latency and every stream, then the boot snapshot and controls again.
    controls.reboot(name)
  }

  const dropNamespace = async (name: string): Promise<void> => {
    await reset(name)
    if (name === DEFAULT_NAMESPACE) return
    instances.delete(name)
    namespaceForStorage.delete(name)
    publicNamespaces.delete(name)
    rngs.delete(name)
    namespaceClocks.delete(name)
    controls.forget(name)
  }

  /** Everything a namespace is: records, clock, random streams, faults, latency, webhooks. */
  const captureAll = (namespace: string): Kept => {
    instance(namespace)
    const state = capture(namespace)
    return {
      records: state.snapshot,
      clock: state.clock,
      rngState: state.rngState,
      controls: controls.snapshot(namespace),
      webhooks: options.webhooks?.snapshot(namespace),
    }
  }

  /** Put back what `point` holds. What it does not hold stays as it is. */
  const restoreAll = (namespace: string, point: Kept, scope: BootScope = "all"): void => {
    instance(namespace)
    if (scope === "all") {
      restoreStorage(namespace, point.records)
      captured.set(namespace, point.records)
    }
    if (point.clock) placeClock(namespace, point.clock)
    // Controls before the service's stream: a restored seed restarts it, then it is placed.
    controls.restore(namespace, point.controls)
    if (point.rngState !== undefined) rngFor(namespace).setState(point.rngState)
    if (scope !== "all") return
    if (point.webhooks !== undefined) options.webhooks?.restore(namespace, point.webhooks)
    // History continues from the restored state instead of being rewritten.
    timelines.get(namespace)?.commit(capture(namespace), { branch: "main" })
  }

  const toDocument = (point: Kept): SnapshotDocument => {
    const { settings, streams, faults: rules, latency: waits } = point.controls
    return {
      format: SNAPSHOT_FORMAT,
      service: options.name,
      records: point.records.records.map((row) => {
        // A Collection row is stored as `{seq, value}`; anything else travels as its raw text.
        let parsed: unknown
        try {
          parsed = JSON.parse(row.value)
        } catch {
          parsed = undefined
        }
        const base = { collection: row.collection, id: row.id, seq: row.seq }
        return isRecord(parsed) &&
          "value" in parsed &&
          JSON.stringify({ seq: row.seq, value: parsed.value }) === row.value
          ? { ...base, value: parsed.value }
          : { ...base, raw: row.value }
      }),
      sequences: point.records.sequences.map((row) => ({ ...row })),
      ...(point.clock
        ? {
            clock: {
              now: point.clock.now,
              frozen: point.clock.frozen,
              ...(settings?.autoAdvanceMs !== undefined
                ? { autoAdvanceMs: settings.autoAdvanceMs }
                : {}),
            },
          }
        : {}),
      ...(settings?.seed !== undefined ? { seed: settings.seed } : {}),
      ...(point.rngState !== undefined ? { rng: { state: point.rngState, ...streams } } : {}),
      ...(rules ? { faults: rules } : {}),
      ...(waits ? { latency: waits } : {}),
      ...(settings?.virtualTime !== undefined ? { virtualTime: settings.virtualTime } : {}),
      ...(point.webhooks !== undefined
        ? { webhooks: options.webhooks?.exportSnapshot(point.webhooks) }
        : {}),
    }
  }

  const position = (value: unknown, label: string): number => {
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value > 0xffffffff
    )
      throw new ControlError(`${label}: expected an unsigned 32-bit integer`)
    return value
  }

  /** A document as restorable state. Checks all of it; touches nothing. */
  const fromDocument = (namespace: string, document: SnapshotDocument): Kept => {
    if (document.service !== undefined && document.service !== options.name)
      throw new ControlError(`snapshot was taken from ${document.service}, not ${options.name}`)
    const highest = new Map<string, number>()
    const seen = new Set<string>()
    const records = document.records.map((row) => {
      const key = `${row.collection}\0${row.id}`
      if (seen.has(key))
        throw new ControlError(`snapshot.records: duplicate ${row.collection}/${row.id}`)
      seen.add(key)
      const seq = row.seq ?? (highest.get(row.collection) ?? 0) + 1
      highest.set(row.collection, Math.max(highest.get(row.collection) ?? 0, seq))
      return Object.freeze({
        collection: row.collection,
        id: row.id,
        seq,
        value: typeof row.raw === "string" ? row.raw : JSON.stringify({ seq, value: row.value }),
      })
    })
    records.sort((left, right) =>
      left.collection < right.collection
        ? -1
        : left.collection > right.collection
          ? 1
          : left.seq - right.seq,
    )
    const sequences = new Map<string, { name: string; kind: string; value: number }>()
    for (const row of document.sequences ?? [])
      sequences.set(`${row.name}\0${row.kind}`, { ...row })
    // A collection's counter never trails its rows, so the next insert cannot reuse a seq.
    for (const [collection, seq] of highest) {
      const key = `${collection}\0collection`
      if ((sequences.get(key)?.value ?? 0) < seq)
        sequences.set(key, { name: collection, kind: "collection", value: seq })
    }
    const stored: NamespaceSnapshot = Object.freeze({
      namespace: storageNamespace(namespace),
      records: Object.freeze(records) as NamespaceSnapshot["records"],
      sequences: Object.freeze(
        [...sequences.values()]
          .sort((left, right) =>
            left.name < right.name
              ? -1
              : left.name > right.name
                ? 1
                : left.kind < right.kind
                  ? -1
                  : left.kind > right.kind
                    ? 1
                    : 0,
          )
          .map((row) => Object.freeze(row)),
      ) as NamespaceSnapshot["sequences"],
    })

    const settings: Partial<ControlSettings> = {}
    if (document.seed !== undefined) settings.seed = normalizeSeed(document.seed, "snapshot.seed")
    if (document.virtualTime !== undefined) {
      if (typeof document.virtualTime !== "boolean")
        throw new ControlError("snapshot.virtualTime: expected a boolean")
      settings.virtualTime = document.virtualTime
    }
    const stepping =
      document.clock?.autoAdvanceMs !== undefined
        ? normalizeClock({ autoAdvance: document.clock.autoAdvanceMs }, "snapshot.clock")
            .autoAdvanceMs
        : undefined
    if (stepping !== undefined) settings.autoAdvanceMs = stepping
    const held: ControlsSnapshot = {}
    if (Object.keys(settings).length > 0) held.settings = settings
    if (document.rng?.faults !== undefined || document.rng?.latency !== undefined)
      held.streams = {
        ...(document.rng.faults !== undefined
          ? { faults: position(document.rng.faults, "snapshot.rng.faults") }
          : {}),
        ...(document.rng.latency !== undefined
          ? { latency: position(document.rng.latency, "snapshot.rng.latency") }
          : {}),
      }
    if (document.faults !== undefined) {
      const given = document.faults
      if (!isRecord(given) || !Array.isArray(given.rules))
        throw new ControlError("snapshot.faults: expected {rules: [...]}")
      held.faults = {
        rules: given.rules.map((each: unknown) => {
          const rule = normalizeFault(each)
          const kept = each as Record<string, unknown>
          return {
            ...rule,
            remaining: typeof kept.remaining === "number" ? kept.remaining : (rule.count ?? null),
            hits: typeof kept.hits === "number" ? kept.hits : 0,
            seen: typeof kept.seen === "number" ? kept.seen : 0,
            ...(typeof kept.position === "number" ? { position: kept.position } : {}),
          }
        }),
        nextId: typeof given.nextId === "number" ? given.nextId : 0,
      }
    }
    if (document.latency !== undefined)
      held.latency = normalizeLatency(document.latency, "snapshot.latency")
    return {
      records: stored,
      ...(document.clock
        ? { clock: { now: document.clock.now, frozen: document.clock.frozen } }
        : {}),
      ...(document.rng?.state !== undefined
        ? { rngState: position(document.rng.state, "snapshot.rng.state") }
        : {}),
      controls: held,
      ...(document.webhooks !== undefined
        ? { webhooks: options.webhooks?.importSnapshot(namespace, document.webhooks) }
        : {}),
    }
  }

  const kept = new Map<string, Map<string, Stored>>()
  const snapshotCounters = new Map<string, number>()
  const keep = (namespace: string, given: string | undefined, point: Kept): SnapshotInfo => {
    let store = kept.get(namespace)
    if (!store) {
      store = new Map()
      kept.set(namespace, store)
    }
    let id = given
    if (id === undefined) {
      let next = snapshotCounters.get(namespace) ?? 0
      do id = `snap_${++next}`
      while (store.has(id))
      snapshotCounters.set(namespace, next)
    }
    const info: SnapshotInfo = {
      id,
      namespace,
      records: point.records.records.length,
      at: point.clock?.now ?? namespaceClock(namespace).now(),
      portable: true,
    }
    store.set(id, { ...point, info })
    return info
  }
  /** Named snapshots, kept per namespace so two workers never see each other's ids. */
  const snapshotStore: SnapshotStore = {
    create: (namespace, id) => keep(namespace, id, captureAll(namespace)),
    list: (namespace) => [...(kept.get(namespace)?.values() ?? [])].map((each) => each.info),
    get: (namespace, id) => kept.get(namespace)?.get(id)?.info,
    export(namespace, id) {
      const found = kept.get(namespace)?.get(id)
      return found ? toDocument(found) : undefined
    },
    import: (namespace, id, document) => keep(namespace, id, fromDocument(namespace, document)),
    restore(namespace, id) {
      const found = kept.get(namespace)?.get(id)
      if (!found) return false
      restoreAll(namespace, found)
      return true
    },
    remove: (namespace, id) => kept.get(namespace)?.delete(id) ?? false,
    clear(namespace) {
      if (namespace === undefined) {
        kept.clear()
        snapshotCounters.clear()
        return
      }
      kept.delete(namespace)
      snapshotCounters.delete(namespace)
    },
  }

  const applyControls = (namespace: string, plan: ControlPlan): void => {
    const { snapshot: document, ...rest } = plan
    // Everything is checked before anything is touched: a rejected document changes nothing.
    controls.check(rest)
    const point = document ? fromDocument(namespace, document) : undefined
    // The snapshot first, so a control given beside it wins over the one it carries.
    if (point) restoreAll(namespace, point)
    controls.apply(namespace, rest)
  }

  const describeControls = (namespace: string) => ({
    ...controls.describe(namespace),
    snapshots: snapshotStore.list(namespace),
  })

  const snapshot = (name: string = DEFAULT_NAMESPACE): NamespaceSnapshot => {
    return checkpoint(name, "main").value.snapshot
  }

  const restore = (from: NamespaceSnapshot, name: string = DEFAULT_NAMESPACE): void => {
    instance(name)
    restoreStorage(name, from)
    captured.set(name, from)
    // Import legacy snapshots into the canonical history instead of creating a second rollback
    // mechanism. The compatibility method stays synchronous and keeps its original return type.
    const history = timelines.get(name)
    if (history) history.commit(capture(name), { branch: "main" })
    else timeline(name)
  }

  const declarationsFor = (namespace: string): readonly StateDeclaration[] => {
    const declared = options.state
    if (!declared) return []
    return typeof declared === "function" ? declared(instance(namespace), namespace) : declared
  }

  const stateScope = (namespace: string) => ({
    sqlite,
    namespace,
    storageNamespace: storageNamespace(namespace),
    root: instance(namespace),
    declarations: declarationsFor(namespace),
  })

  const runtime: ServiceRuntime<T> = {
    name: options.name,
    mount: (prefix) =>
      mount(runtime, prefix, (request) => {
        const namespace = runtime.namespaceOf(request)
        return namespace === DEFAULT_NAMESPACE
          ? ""
          : `${adminPrefix}/ns/${encodeURIComponent(namespace)}`
      }),
    sqlite,
    clock,
    faults,
    latency,
    metrics,
    journal,
    rng,
    credentials,
    webhooks: options.webhooks,
    namespaceClock,
    namespaceOf(request) {
      const url = new URL(request.url)
      const prefixed = matchNamespacePath(url.pathname, adminPrefix)
      const selected =
        request.headers.get(NAMESPACE_HEADER) ??
        (prefixed ? decodeURIComponent(prefixed[1] as string) : undefined)
      const path = prefixed ? (prefixed[2] ?? "/") : url.pathname
      if (isAdminPath(path, adminPrefix))
        return url.searchParams.get("namespace") ?? selected ?? DEFAULT_NAMESPACE
      if (selected !== undefined) return selected
      const credential = options.credential?.(request)
      return (
        (credential !== undefined ? credentials.get(credential) : undefined) ?? DEFAULT_NAMESPACE
      )
    },
    fleetSnapshot(namespace) {
      const handle = {}
      fleetPoints.set(handle, { namespace, ...captureAll(namespace) })
      return handle
    },
    fleetRestore(handle, namespace) {
      const point =
        typeof handle === "object" && handle !== null ? fleetPoints.get(handle) : undefined
      if (!point || point.namespace !== namespace) throw new Error("invalid fleet checkpoint")
      restoreAll(namespace, point)
      timelines.delete(namespace)
    },
    fleetExport(handle) {
      const point =
        typeof handle === "object" && handle !== null ? fleetPoints.get(handle) : undefined
      if (!point) throw new Error("invalid fleet checkpoint")
      return toDocument(point)
    },
    fleetImport(namespace, document) {
      const handle = {}
      fleetPoints.set(handle, {
        namespace,
        ...fromDocument(namespace, assertSnapshotDocument(document)),
      })
      return handle
    },
    applyPreset: (name, namespace = DEFAULT_NAMESPACE, overrides = {}) =>
      controls.addFault(namespace, { ...overrides, preset: name }),
    instance,
    namespaces: () => [...publicNamespaces].sort(),
    reset,
    dropNamespace,
    controls: (namespace = DEFAULT_NAMESPACE) => describeControls(namespace),
    configure(document, namespace = DEFAULT_NAMESPACE) {
      applyControls(namespace, normalizeControls(document))
      return describeControls(namespace)
    },
    snapshots: {
      create: (given = {}) =>
        snapshotStore.create(given.namespace ?? DEFAULT_NAMESPACE, given.name),
      list: (namespace = DEFAULT_NAMESPACE) => snapshotStore.list(namespace),
      export(id, namespace = DEFAULT_NAMESPACE) {
        const document = snapshotStore.export(namespace, id)
        if (!document) throw new RangeError(`no snapshot ${id} in namespace ${namespace}`)
        return document
      },
      import: (document, given = {}) =>
        snapshotStore.import(given.namespace ?? DEFAULT_NAMESPACE, given.name, document),
      restore(id, namespace = DEFAULT_NAMESPACE) {
        if (!snapshotStore.restore(namespace, id))
          throw new RangeError(`no snapshot ${id} in namespace ${namespace}`)
      },
      delete: (id, namespace = DEFAULT_NAMESPACE) => snapshotStore.remove(namespace, id),
    },
    headers: controlHeaders,
    snapshot,
    restore,
    checkpoint,
    branch,
    checkout,
    timeline,
    state: (namespace = DEFAULT_NAMESPACE) => inspectState(stateScope(namespace)),
    fetch: async (incoming) => {
      let request = incoming
      // `/__admin/ns/<name>/…` selects a namespace (and is stripped) for SDKs that cannot add headers.
      const prefixed = matchNamespacePath(new URL(request.url).pathname, adminPrefix)
      if (prefixed) {
        const url = new URL(request.url)
        url.pathname = prefixed[2] ?? "/"
        const headers = new Headers(request.headers)
        if (!headers.has(NAMESPACE_HEADER)) {
          headers.set(NAMESPACE_HEADER, decodeURIComponent(prefixed[1] as string))
        }
        const hasBody = request.method !== "GET" && request.method !== "HEAD"
        request = forwardRequestContext(
          request,
          new Request(url, {
            method: request.method,
            headers,
            ...(hasBody ? { body: await request.arrayBuffer() } : {}),
            signal: request.signal,
          }),
        )
      }
      const internalUrl = new URL(request.url)
      const internalPath = isAdminPath(internalUrl.pathname, adminPrefix)
        ? `${ADMIN_PREFIX}${internalUrl.pathname.slice(adminPrefix.length)}`
        : ""
      const internal = internalMatch(internalPath)
      const obsoleteInternalPath =
        adminPrefix !== ADMIN_PREFIX && internalMatch(internalUrl.pathname) && !internal
      if (internal) {
        internalUrl.pathname = internalPath
        request = forwardRequestContext(request, new Request(internalUrl, request))
      }
      let namespace = internal
        ? (internalUrl.searchParams.get("namespace") ?? control.namespaceOf(request))
        : control.namespaceOf(request)
      if (!request.headers.has(NAMESPACE_HEADER) && options.credential) {
        const credential = options.credential(request)
        const mapped = credential !== undefined ? credentials.get(credential) : undefined
        if (mapped !== undefined) namespace = mapped
      }
      const selectedBranch = request.headers.get(BRANCH_HEADER) ?? "main"
      const at = request.headers.get(AT_HEADER) ?? undefined
      const stamp = (response: Response): Response => {
        // An invalid namespace is not echoed back.
        const value = KEY_PATTERN.test(namespace)
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
      if (obsoleteInternalPath)
        return stamp(adminFail(404, "internal transport is only available under adminPrefix"))
      const handled = internal ? undefined : await control.handle(request)
      if (handled) return stamp(handled)
      const started = monotonicNow()
      const url = new URL(request.url)
      const operationId = operationIdFor(request, url.pathname)
      let accepted: ServiceCheckpoint | undefined
      let acceptedNotes: ResponseNotes | undefined
      // Injected wait this request spent: latency, fault delays, a timeout.
      let waitedMs = 0
      // With virtual time the wait is the whole duration, so a journal replays byte for byte.
      let virtualTime = false
      let requestClock = clock
      // What a rejection records about the body. The runtime never reads the request stream —
      // consuming it would break a streaming request (e.g. a bidirectional model stream) — so the
      // byte count comes from `content-length` when the client sent it, and is null otherwise.
      const contentLength = request.headers.get("content-length")
      const received: RejectedRequest = {
        contentType: request.headers.get("content-type"),
        bodyBytes:
          contentLength !== null && /^\d+$/.test(contentLength) ? Number(contentLength) : null,
        transferEncoding: request.headers.get("transfer-encoding"),
      }
      const log = (status: number, faultId?: string, response?: Response) => {
        const noted = { ...acceptedNotes, ...(response ? responseNotes(response) : {}) }
        const rejected = status >= 400 && faultId === undefined
        const entry: RequestLog = {
          service: options.name,
          namespace,
          operationId,
          method: request.method,
          path: url.pathname,
          status,
          durationMs: virtualTime ? waitedMs : Math.round((monotonicNow() - started) * 100) / 100,
          unmatched: options.document !== undefined && operationId === undefined,
          ...(faultId !== undefined ? { faultId } : {}),
          ...(waitedMs > 0 ? { delayMs: waitedMs } : {}),
          ...(noted?.ids && Object.keys(noted.ids).length > 0 ? { ids: noted.ids } : {}),
          ...(noted?.adopted ? { adopted: true } : {}),
          ...(accepted ? { accepted: true, checkpoint: accepted.id } : {}),
          ...(rejected ? { request: { ...received } } : {}),
          ...(rejected && noted?.issues && noted.issues.length > 0
            ? { issues: noted.issues.map((issue) => ({ ...issue })) }
            : {}),
        }
        metrics.record(entry)
        journal.record({ ...entry, at: new Date(requestClock.now()).toISOString() })
        options.onLog?.(entry)
      }
      if (!KEY_PATTERN.test(namespace)) {
        log(400)
        return stamp(
          new Response(
            JSON.stringify({
              error: {
                type: "mockingbird_admin",
                message: `${NAMESPACE_HEADER} must match ${KEY_PATTERN}`,
              },
            }),
            { status: 400, headers: { "content-type": "application/json; charset=utf-8" } },
          ),
        )
      }
      if (!KEY_PATTERN.test(selectedBranch)) {
        log(400)
        return stamp(adminFail(400, `${BRANCH_HEADER} must match ${KEY_PATTERN}`))
      }
      requestClock = namespaceClock(namespace)
      const refuse = (status: number, message: string): Response => {
        log(status)
        return stamp(adminFail(status, message))
      }
      // Controls carried by this request. Whatever could refuse the request is checked before
      // anything is applied, so a request that is refused has changed nothing.
      let requested: RequestControls | undefined
      let scripted: FaultRule[] = []
      try {
        requested = parseControlHeaders(request.headers)
        if (requested)
          scripted = controls.scriptFaults(namespace, {
            ...(requested.fault ? { fault: requested.fault } : {}),
            ...(requested.timeout !== undefined ? { timeoutMs: requested.timeout } : {}),
          })
        const lost = requested?.restore !== undefined ? CONTROL_HEADERS.restore : at && AT_HEADER
        if (requested?.reset && lost)
          throw new ControlError(
            `${CONTROL_HEADERS.reset}: a reset discards snapshots and history, so ${lost} cannot follow it`,
          )
      } catch (error) {
        if (error instanceof ControlError) return refuse(400, error.message)
        throw error
      }
      // A write that names a checkpoint on `main` first moves `main` back to it. That changes
      // the namespace, so it is guarded like the headers that say so outright.
      const rewinds =
        at !== undefined && selectedBranch === "main" && MUTATING_METHODS.has(request.method)
      if (
        (requested || rewinds) &&
        options.adminKey !== undefined &&
        request.headers.get(ADMIN_KEY_HEADER) !== options.adminKey
      )
        return refuse(401, `control headers need ${ADMIN_KEY_HEADER}`)
      controls.ensure(namespace)
      if (requested?.restore !== undefined && !snapshotStore.get(namespace, requested.restore))
        return refuse(404, `no snapshot ${requested.restore} in namespace ${namespace}`)
      if (at !== undefined) {
        try {
          timeline(namespace).get(at)
        } catch (error) {
          return refuse(409, error instanceof Error ? error.message : String(error))
        }
      }
      if (requested) {
        // The order the guide lists them in: reset, restore, seed, time, advance, virtual time.
        if (requested.reset) await reset(namespace)
        if (requested.restore !== undefined) snapshotStore.restore(namespace, requested.restore)
        if (requested.seed !== undefined) controls.reseed(namespace, requested.seed)
        if (requested.time !== undefined)
          controls.changeClock(namespace, { frozen: true, now: requested.time })
        if (requested.advance !== undefined)
          controls.changeClock(namespace, { advanceMs: requested.advance })
        if (requested.virtualTime !== undefined)
          controls.apply(namespace, { virtualTime: requested.virtualTime })
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
          let viewRng = rngs.get(storage)
          if (!viewRng) {
            viewRng = createRng(seedOf(namespace))
            instanceFor(storage, namespace, viewRng)
          }
          viewRng.setState(point.value.rngState)
          restoreStorage(storage, point.value.snapshot)
          captured.set(storage, point.value.snapshot)
        } else {
          storage = ensureBranch(namespace, selectedBranch, at)
        }
      } catch (error) {
        log(409)
        return stamp(adminFail(409, error instanceof Error ? error.message : String(error)))
      }
      const settings = controls.settings(namespace)
      virtualTime = settings.virtualTime
      if (settings.autoAdvanceMs > 0) requestClock.advance(settings.autoAdvanceMs)
      const wait = async (ms: number): Promise<void> => {
        if (!(ms > 0)) return
        waitedMs += ms
        // Virtual: the mock clock pays for the wait and the request carries on at once.
        if (virtualTime) requestClock.advance(ms)
        else await sleepUnlessAborted(ms, request.signal)
      }
      const candidate = {
        operationId,
        method: request.method,
        path: url.pathname,
        namespace,
        headers: request.headers,
        query: url.searchParams,
        wait,
      }
      let hits: FaultHit[]
      try {
        await wait(latency.take(namespace, operationId) + (requested?.delay ?? 0))
        hits = scripted.length > 0 ? await faults.fire(scripted, candidate) : []
        if (!hits.some((hit) => hit.drop || hit.response))
          hits.push(...(await faults.take({ ...candidate, now: requestClock.now() })))
      } catch (error) {
        // The client gave up while the request was being held.
        log(0)
        throw error
      }
      const final = hits.find((hit) => hit.drop || hit.response)
      /** A response is done: cut it short if asked to, name the fault, take the snapshot. */
      const finish = (response: Response): Response => {
        let out = response
        const truncate = hits.find((hit) => hit.truncate !== undefined)?.truncate
        if (truncate !== undefined) out = truncateResponse(out, truncate)
        // The rule the journal names: the one that answered, or the first that shaped it.
        const shaped = final ?? hits[0]
        if (shaped) {
          out = mutableResponse(out)
          out.headers.set(FAULT_HEADER, shaped.id)
        }
        if (requested?.snapshot !== undefined) {
          out = mutableResponse(out)
          out.headers.set(SNAPSHOT_HEADER, snapshotStore.create(namespace, requested.snapshot).id)
        }
        return stamp(out)
      }
      if (final?.drop) {
        log(0, final.id)
        throw new DroppedConnectionError(final.timeout ? "timeout" : "drop")
      }
      if (final?.response) {
        log(final.response.status, final.id)
        return finish(final.response)
      }
      const fired = hits.filter((hit) => hit.effect !== undefined)
      if (fired.length > 0)
        effects.set(
          request,
          fired.map((hit) => hit.effect),
        )
      let active = true
      acceptance.set(request, (notes) => {
        if (!active || accepted || !MUTATING_METHODS.has(request.method)) return
        accepted = timeline(namespace).commit(capture(storage), { branch: selectedBranch })
        acceptedNotes = notes
      })
      let response: Response
      try {
        response = await instanceFor(storage, namespace).fetch(request)
      } catch (error) {
        log(error instanceof DroppedConnectionError ? 0 : 500, hits[0]?.id)
        throw error
      } finally {
        active = false
        acceptance.delete(request)
      }
      const wireStatus = responseNotes(response)?.wireStatus ?? response.status
      if (MUTATING_METHODS.has(request.method) && wireStatus >= 200 && wireStatus < 400) {
        const current = capture(storage)
        const unchanged =
          accepted &&
          timeline(namespace).head(selectedBranch)?.id === accepted.id &&
          current.snapshot.records === accepted.value.snapshot.records &&
          current.snapshot.sequences === accepted.value.snapshot.sequences &&
          current.rngState === accepted.value.rngState
        const point =
          unchanged && accepted
            ? accepted
            : timeline(namespace).commit(current, { branch: selectedBranch })
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
      log(wireStatus, hits[0]?.id, response)
      return finish(response)
    },
  }

  /** Wait on the wall clock, giving up the moment the caller does. */
  const sleepUnlessAborted = async (ms: number, signal: AbortSignal | undefined): Promise<void> => {
    if (!signal) return sleep(ms)
    if (signal.aborted) throw signal.reason
    let stop = () => {}
    const aborted = new Promise<never>((_, reject) => {
      const abort = () => reject(signal.reason)
      signal.addEventListener("abort", abort, { once: true })
      stop = () => signal.removeEventListener("abort", abort)
    })
    try {
      await Promise.race([sleep(ms, signal), aborted])
    } finally {
      stop()
    }
  }

  const control = createControlPlane({
    name: options.name,
    version,
    startedAt: wallNow(),
    wallNow,
    clock,
    namespaceClock,
    metrics,
    journal,
    defaultNamespace: DEFAULT_NAMESPACE,
    namespaces: runtime.namespaces,
    reset,
    dropNamespace,
    controls,
    snapshots: snapshotStore,
    applyControls,
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
    routes: {
      ...credentialRoutes(credentials),
      ...(options.webhooks ? webhookAdminRoutes(options.webhooks) : {}),
      ...(options.admin?.(runtime) ?? {}),
      ...stateAdminRoutes({
        open: stateScope,
        afterWrite: (namespace) => {
          checkpoint(namespace, "main")
        },
      }),
      ...adminUiRoutes(options.name, options.adminUi, adminPrefix),
    },
    adminPrefix,
    adminKey: options.adminKey,
  })

  // The default namespace boots now, so its rules precede anything a caller adds later.
  controls.ensure(DEFAULT_NAMESPACE)
  return defineMock(runtime)
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
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  })

const adminFail = (status: number, message: string): Response =>
  adminJson(status, { error: { type: "mockingbird_admin", message } })

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
    const list = Array.isArray(body) ? body : isRecord(body) ? body.credentials : undefined
    if (Array.isArray(list)) {
      for (const each of list) {
        if (typeof each === "string") pairs.push([each, namespace])
        else if (isRecord(each) && typeof each.credential === "string") {
          pairs.push([
            each.credential,
            typeof each.namespace === "string" ? each.namespace : namespace,
          ])
        } else return adminFail(400, "each entry is a credential string or {credential, namespace}")
      }
    } else if (isRecord(list)) {
      for (const [credential, target] of Object.entries(list)) {
        if (typeof target !== "string")
          return adminFail(400, `namespace for ${credential} must be a string`)
        pairs.push([credential, target])
      }
    } else if (isRecord(body) && typeof body.credential === "string") {
      pairs.push([body.credential, typeof body.namespace === "string" ? body.namespace : namespace])
    } else {
      return adminFail(400, 'expected {"credentials": {"<credential>": "<namespace>"}}')
    }
    for (const [credential, target] of pairs) {
      if (!KEY_PATTERN.test(target))
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
