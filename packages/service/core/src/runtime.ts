import type { FetchAPI } from "@crvouga/mockingbird-core"
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
import { createMetrics, type Metrics, type RequestLog } from "./metrics.js"
import { createRng, type Rng } from "./rng.js"
import { bootSqlite } from "./service.js"
import { type NamespaceSnapshot, restoreNamespace, snapshotNamespace } from "./snapshot.js"
import { PACKAGE_VERSION } from "./version.js"
import { type WebhookHub, webhookAdminRoutes } from "./webhooks.js"

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
}

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
}

/** The namespace used when a request names none. */
export const DEFAULT_NAMESPACE = "default"

const NAMESPACE_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/

/** `/ns/<namespace>/…`: the namespace carrier for SDKs that only take a base URL. */
const PATH_PREFIX = /^\/ns\/([^/]+)(\/.*)?$/

const effects = new WeakMap<Request, FaultHit["effect"][]>()

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
  const faults = createFaultRegistry(createRng(options.seed ?? 0))
  const metrics = createMetrics()
  const journal = createJournal(options.journalSize ?? DEFAULT_JOURNAL_SIZE)
  const version = options.version ?? PACKAGE_VERSION
  const instances = new Map<string, T>()
  const credentials = createCredentialRegistry()
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
      options.webhooks?.clear()
      for (const each of instances.values()) await each.reset()
      return
    }
    options.webhooks?.clear(name)
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
    namespaces: () => [...instances.keys()].sort(),
    reset,
    snapshot,
    restore,
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
      const response = await instance(namespace).fetch(request)
      log(response.status, fired[0]?.id, response)
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
