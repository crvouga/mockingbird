import type { Clock } from "./clock.js"
import {
  assertSnapshotDocument,
  CONTROL_HEADER_REFERENCE,
  CONTROL_HEADERS,
  ControlError,
  type ControlPlan,
  durationMs,
  isRecord,
  KEY_PATTERN,
  normalizeClock,
  normalizeControls,
  normalizeLatency,
  parseInstant,
  type SnapshotDocument,
} from "./controls.js"
import type { FaultPresetList } from "./faults.js"
import type { Journal } from "./journal.js"
import type { Metrics } from "./metrics.js"
import { createNamespaceControls, type NamespaceControls } from "./namespace-controls.js"
import { ADMIN_ROUTE_REFERENCE } from "./surface.js"

export { parseDuration } from "./controls.js"

/** Unauthenticated readiness probe, served ahead of every vendor auth gate. */
export const HEALTH_PATH = "/__admin/health"
/** Prefix of every control-plane route; never part of a vendor contract. */
export const ADMIN_PREFIX = "/__admin"
/** Resolve once at construction; ambiguous URL forms are never accepted. */
export const resolveAdminPrefix = (prefix: string = ADMIN_PREFIX): string => {
  if (!/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(prefix)) {
    throw new Error(
      "adminPrefix must be an absolute non-root path of literal segments, without a trailing slash",
    )
  }
  return prefix
}

/** Segment-boundary matching prevents /__administer from entering the control plane. */
export const isAdminPath = (path: string, prefix: string): boolean =>
  path === prefix || path.startsWith(`${prefix}/`)

/** SDK base URL namespace carrier, entirely inside the configured internal route tree. */
export const matchNamespacePath = (path: string, prefix: string): RegExpExecArray | null =>
  /^\/ns\/([^/]+)(\/.*)?$/.exec(isAdminPath(path, prefix) ? path.slice(prefix.length) : "")

/** Fail before serving when the declared vendor contract overlaps the reserved tree. */
export const assertAdminPrefixAvailable = (prefix: string, paths: readonly string[]): void => {
  const reserved = prefix.split("/").slice(1)
  for (const path of paths) {
    const segments = path.split("/").slice(1)
    // Catch-all vendor roots (e.g. S3 /{bucket}/{key}) share the listener.
    // The internal tree is reserved before vendor dispatch, regardless of the wildcard.
    if (segments.length < reserved.length || /^\{[^}]+\}$/.test(segments[0] ?? "")) continue
    if (
      reserved.every((part, i) => segments[i] === part || /^\{[^}]+\}$/.test(segments[i] ?? ""))
    ) {
      throw new Error(
        `vendor route ${path} collides with adminPrefix ${prefix}; choose a different adminPrefix`,
      )
    }
  }
}

/** Carries the admin key, which is separate from any vendor credential. */
export const ADMIN_KEY_HEADER = CONTROL_HEADERS.adminKey
/** Selects the isolated namespace a request reads and writes. */
export const NAMESPACE_HEADER = CONTROL_HEADERS.namespace
/** Where the admin controls are documented, for people and agents. */
export const ADMIN_DOCS_URL = "https://mockingbird.chrisvouga.dev/docs/admin-controls"

/**
 * The guide's page for each control, with the shared routes (by first path segment) and the
 * request headers that page defines. `GET /__admin` links every route and header to its page,
 * and the guide in `docs/admin-controls/` is checked against this list.
 */
export const ADMIN_CONTROL_PAGES: readonly {
  page: string
  title: string
  routes: readonly string[]
  headers: readonly string[]
}[] = [
  {
    page: "namespaces",
    title: "Namespaces",
    routes: ["/namespaces", "/credentials"],
    headers: [CONTROL_HEADERS.namespace],
  },
  { page: "reset", title: "Reset", routes: ["/reset"], headers: [CONTROL_HEADERS.reset] },
  {
    page: "snapshot-and-restore",
    title: "Snapshot and restore",
    routes: ["/snapshots"],
    headers: [CONTROL_HEADERS.restore, CONTROL_HEADERS.snapshot],
  },
  {
    page: "clock",
    title: "Clock",
    routes: ["/clock"],
    headers: [CONTROL_HEADERS.time, CONTROL_HEADERS.advance],
  },
  {
    page: "checkpoints-and-branches",
    title: "Checkpoints and branches",
    routes: ["/timeline", "/checkpoints", "/branches"],
    headers: [CONTROL_HEADERS.branch, CONTROL_HEADERS.at],
  },
  { page: "faults", title: "Faults", routes: ["/faults"], headers: [CONTROL_HEADERS.fault] },
  {
    page: "latency-and-timeouts",
    title: "Latency and timeouts",
    routes: ["/latency"],
    headers: [CONTROL_HEADERS.delay, CONTROL_HEADERS.timeout, CONTROL_HEADERS.virtualTime],
  },
  {
    page: "seed-and-determinism",
    title: "Seed and determinism",
    routes: [],
    headers: [CONTROL_HEADERS.seed],
  },
  { page: "control-document", title: "The control document", routes: ["/controls"], headers: [] },
  { page: "boot", title: "Boot", routes: [], headers: [] },
  { page: "request-headers", title: "Request headers", routes: [], headers: [] },
  {
    page: "journal-and-state",
    title: "Journal, metrics and state",
    routes: ["/requests", "/metrics", "/state", "/ui"],
    headers: [],
  },
  {
    page: "reference",
    title: "Reference",
    routes: ["/", "/health"],
    headers: [CONTROL_HEADERS.adminKey],
  },
]

const pageUrl = (page: string): string => `${ADMIN_DOCS_URL}/${page}`

/** The guide page that defines a shared route (`"GET /snapshots/:id"`), if it is one. */
const routeDocs = (route: string): string | undefined => {
  if (!Object.hasOwn(ADMIN_ROUTE_REFERENCE, route)) return undefined
  const path = route.slice(route.indexOf(" ") + 1)
  const segment = `/${path.split("/")[1] ?? ""}`
  const found = ADMIN_CONTROL_PAGES.find((each) => each.routes.includes(segment))
  return found && pageUrl(found.page)
}

const headerDocs = (header: string): string | undefined => {
  const found = ADMIN_CONTROL_PAGES.find((each) => each.headers.includes(header))
  return found && pageUrl(found.page)
}

export type AdminRequest = {
  request: Request
  url: URL
  /** `:param` segments of the matched route. */
  params: Record<string, string>
  /** Namespace the request targets: `?namespace=`, then the header, then the default. */
  namespace: string
  /** Parsed JSON body, or `undefined` when there is none. */
  body: unknown
}

export type AdminRoute = (request: AdminRequest) => Response | Promise<Response>

/**
 * Service-specific admin routes, keyed `METHOD /path` relative to `/__admin`, with
 * `:param` segments — e.g. `"POST /orders/:id/transition"`.
 */
export type AdminRoutes = Record<string, AdminRoute>

/** What `GET /__admin/snapshots` lists for each snapshot. */
export type SnapshotInfo = {
  id: string
  namespace: string
  /** Stored rows in the snapshot. */
  records: number
  /** The namespace clock when it was taken, epoch ms. */
  at: number
  /** Whether `GET /snapshots/:id` can return it as a {@link SnapshotDocument}. */
  portable: boolean
}

/** Named snapshots of a namespace. Ids are unique within a namespace, never across them. */
export type SnapshotStore = {
  /** Capture the namespace now. Reusing an id replaces that snapshot. */
  create(namespace: string, id?: string): SnapshotInfo
  list(namespace: string): SnapshotInfo[]
  get(namespace: string, id: string): SnapshotInfo | undefined
  /** The snapshot as portable JSON; `undefined` when there is none or it cannot leave the process. */
  export(namespace: string, id: string): SnapshotDocument | undefined
  /** Store a document as a snapshot without restoring it. Throws {@link ControlError}. */
  import(namespace: string, id: string | undefined, document: SnapshotDocument): SnapshotInfo
  /** Replace the namespace with the snapshot. `false` when there is none. */
  restore(namespace: string, id: string): boolean
  remove(namespace: string, id: string): boolean
  /** Forget one namespace's snapshots, or every namespace's. */
  clear(namespace?: string): void
}

export type ControlContext = {
  name: string
  startedAt: number
  wallNow: () => number
  clock: Clock
  namespaceClock?(namespace: string): Clock
  metrics: Metrics
  journal: Journal
  defaultNamespace: string
  namespaces(): string[]
  reset(namespace: string | "*"): Promise<void>
  timeTravel: {
    checkpoint(
      namespace: string,
      branch: string,
    ): { id: string; branch: string; parent: string | null; at: number; records?: number }
    branch(
      name: string,
      options: { namespace: string; at?: string },
    ): { id: string; branch: string; parent: string | null; at: number }
    checkout(checkpoint: string, options: { namespace: string; branch: string }): void
    retain(namespace: string, checkpoint: string): void
    release(namespace: string, checkpoint: string): boolean
    inspect(namespace: string): {
      branches: Readonly<Record<string, string>>
      checkpoints: readonly { id: string; branch: string; parent: string | null; at: number }[]
    }
  }
  /** Extra fields for `GET /__admin/health`, such as the loaded corpus version. */
  describe(): Record<string, unknown>
  routes: AdminRoutes
  adminPrefix?: string
  adminKey: string | undefined
  /** Reported by `GET /__admin`. */
  version?: string
  /**
   * Per-namespace seed, clock settings, latency and faults. Default: controls over this
   * context's clock, with the standard presets and no boot controls.
   */
  controls?: NamespaceControls
  /** Named snapshots. Default: pinned `timeTravel` checkpoints, which are not portable. */
  snapshots?: SnapshotStore
  /** Apply a control document, including its `snapshot`. Default: `controls.apply`. */
  applyControls?(namespace: string, plan: ControlPlan): void
  /** Reset a namespace and forget it. Default: reset. */
  dropNamespace?(namespace: string): Promise<void>
}

export type ControlPlane = {
  /** The control-plane response for `request`, or `undefined` for a vendor request. */
  handle(request: Request): Promise<Response | undefined>
  /**
   * Namespace a vendor request targets, from {@link NAMESPACE_HEADER}. Only admin routes
   * also accept `?namespace=`, so a vendor query parameter of that name can never
   * silently reroute a request.
   */
  namespaceOf(request: Request): string
  /** The per-namespace controls behind the routes. */
  readonly controls: NamespaceControls
  readonly snapshots: SnapshotStore
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  })

/** Admin errors use one documented shape, distinct from any vendor's error body. */
export const adminError = (status: number, message: string): Response =>
  json(status, { error: { type: "mockingbird_admin", message } })

/** Parameters before literals lose, so `/faults/presets` is never read as `/faults/:id`. */
const paramCount = (pattern: string): number => (pattern.match(/\/:/g) ?? []).length

const matchRoute = (pattern: string, path: string): Record<string, string> | undefined => {
  const want = pattern.split("/").filter(Boolean)
  const have = path.split("/").filter(Boolean)
  if (want.length !== have.length) return undefined
  const params: Record<string, string> = {}
  for (let i = 0; i < want.length; i++) {
    const segment = want[i] as string
    const actual = have[i] as string
    if (segment.startsWith(":")) params[segment.slice(1)] = decodeURIComponent(actual)
    else if (segment !== actual) return undefined
  }
  return params
}

const readJson = async (request: Request): Promise<unknown> => {
  const text = await request.text()
  if (text.trim() === "") return undefined
  return JSON.parse(text) as unknown
}

/** Snapshots as pinned Timeline checkpoints, for engines whose state is not rows of JSON. */
const timelineSnapshots = (timeTravel: ControlContext["timeTravel"]): SnapshotStore => {
  const stored = new Map<string, Map<string, { checkpoint: string; info: SnapshotInfo }>>()
  const counters = new Map<string, number>()
  const of = (namespace: string) => {
    let found = stored.get(namespace)
    if (!found) {
      found = new Map()
      stored.set(namespace, found)
    }
    return found
  }
  const remove = (namespace: string, id: string): boolean => {
    const found = stored.get(namespace)?.get(id)
    if (!found) return false
    stored.get(namespace)?.delete(id)
    timeTravel.release(namespace, found.checkpoint)
    return true
  }
  return {
    create(namespace, given) {
      const point = timeTravel.checkpoint(namespace, "main")
      timeTravel.retain(namespace, point.id)
      let id = given
      if (id === undefined) {
        let next = counters.get(namespace) ?? 0
        do id = `snap_${++next}`
        while (of(namespace).has(id))
        counters.set(namespace, next)
      } else remove(namespace, id)
      const info = { id, namespace, records: point.records ?? 0, at: point.at, portable: false }
      of(namespace).set(id, { checkpoint: point.id, info })
      return info
    },
    list: (namespace) => [...(stored.get(namespace)?.values() ?? [])].map((each) => each.info),
    get: (namespace, id) => stored.get(namespace)?.get(id)?.info,
    export: () => undefined,
    import() {
      throw new ControlError("this emulator's snapshots cannot be imported or exported")
    },
    restore(namespace, id) {
      const found = stored.get(namespace)?.get(id)
      if (!found) return false
      timeTravel.checkout(found.checkpoint, { namespace, branch: "main" })
      return true
    },
    remove,
    clear(namespace) {
      for (const [name, snapshots] of stored) {
        if (namespace !== undefined && name !== namespace) continue
        for (const id of [...snapshots.keys()]) {
          try {
            remove(name, id)
          } catch {
            // The checkpoint went with the history a reset discarded.
            snapshots.delete(id)
          }
        }
        stored.delete(name)
        counters.delete(name)
      }
    },
  }
}

export const createControlPlane = (context: ControlContext): ControlPlane => {
  const adminPrefix = resolveAdminPrefix(context.adminPrefix)
  const controls =
    context.controls ??
    createNamespaceControls({
      seed: 0,
      clock: (namespace) => context.namespaceClock?.(namespace) ?? context.clock,
    })
  const { faults } = controls
  const snapshots = context.snapshots ?? timelineSnapshots(context.timeTravel)
  /** A store the runtime owns is cleared by the runtime's own reset. */
  const forgetSnapshots = (namespace?: string) => {
    if (!context.snapshots) snapshots.clear(namespace)
  }
  const applyControls =
    context.applyControls ??
    ((namespace: string, plan: ControlPlan) => {
      if (plan.snapshot !== undefined)
        throw new ControlError("this emulator cannot start from a snapshot document")
      controls.apply(namespace, plan)
    })

  const headerNamespace = (request: Request): string =>
    request.headers.get(NAMESPACE_HEADER) ?? context.defaultNamespace
  const adminNamespace = (request: Request, url: URL): string =>
    url.searchParams.get("namespace") ?? headerNamespace(request)
  /** Whether the caller named a namespace, as opposed to landing on the default one. */
  const explicitNamespace = (request: Request, url: URL): boolean =>
    url.searchParams.has("namespace") || request.headers.has(NAMESPACE_HEADER)

  const health = (): Response => {
    return json(200, {
      ...context.describe(),
      status: "ok",
      service: context.name,
      uptimeMs: context.wallNow() - context.startedAt,
      clock: context.clock.state(),
      namespaces: context.namespaces().length,
      adminPrefix,
      adminUi: `${adminPrefix}/ui`,
    })
  }

  const describe = (namespace: string) => ({
    ...controls.describe(namespace),
    snapshots: snapshots.list(namespace),
  })

  /** Run a control change, answering `400` for a {@link ControlError}. */
  const guard = (run: () => Response): Response => {
    try {
      return run()
    } catch (error) {
      if (error instanceof ControlError) return adminError(400, error.message)
      throw error
    }
  }

  const presetList = (): FaultPresetList => ({
    presets: Object.entries(controls.presets).map(([name, preset]) => ({ name, ...preset })),
  })

  const removeFault = (id: string, namespace: string, everyNamespace: boolean): Response =>
    faults.remove(id, everyNamespace ? undefined : namespace)
      ? json(200, { status: "ok" })
      : adminError(404, `no fault ${id}`)

  const builtin: AdminRoutes = {
    "GET /health": health,
    "GET /": ({ namespace }) => {
      const routes = [...Object.keys(builtin), ...Object.keys(context.routes)].sort()
      const reference: Record<string, string> = ADMIN_ROUTE_REFERENCE
      return json(200, {
        service: context.name,
        ...(context.version !== undefined ? { version: context.version } : {}),
        namespace,
        adminPrefix,
        docs: ADMIN_DOCS_URL,
        guide: ADMIN_CONTROL_PAGES.map((each) => ({ title: each.title, docs: pageUrl(each.page) })),
        routes,
        reference: routes.map((route) => {
          const docs = routeDocs(route)
          return {
            route,
            summary: reference[route] ?? `Specific to ${context.name}.`,
            ...(docs !== undefined ? { docs } : {}),
          }
        }),
        headers: CONTROL_HEADER_REFERENCE.map((each) => ({
          ...each,
          docs: headerDocs(each.header) ?? ADMIN_DOCS_URL,
        })),
      })
    },

    "GET /controls": ({ namespace }) => json(200, describe(namespace)),
    "PUT /controls": ({ body, namespace }) =>
      guard(() => {
        applyControls(namespace, normalizeControls(body ?? {}, "controls"))
        return json(200, describe(namespace))
      }),
    "DELETE /controls": ({ namespace }) => {
      controls.reboot(namespace, "controls")
      return json(200, describe(namespace))
    },

    "POST /reset": async ({ url, namespace }) => {
      const target = url.searchParams.get("all") === "1" ? "*" : namespace
      await context.reset(target)
      forgetSnapshots(target === "*" ? undefined : target)
      return json(200, { status: "ok", reset: target === "*" ? context.namespaces() : [target] })
    },

    "GET /namespaces": () =>
      json(200, { default: context.defaultNamespace, namespaces: context.namespaces() }),
    "DELETE /namespaces/:name": async ({ params }) => {
      const name = params.name as string
      if (!KEY_PATTERN.test(name)) return adminError(400, "invalid namespace")
      if (context.dropNamespace) await context.dropNamespace(name)
      else await context.reset(name)
      forgetSnapshots(name)
      return json(200, { status: "ok", namespaces: context.namespaces() })
    },

    "GET /clock": ({ namespace }) => json(200, controls.clock(namespace)),
    "POST /clock": ({ body, namespace }) =>
      guard(() => {
        if (!isRecord(body)) return adminError(400, "expected a JSON object")
        const { advance, reset, ...rest } = body
        if (reset !== undefined && typeof reset !== "boolean")
          return adminError(400, "reset: expected a boolean")
        return json(
          200,
          controls.changeClock(namespace, {
            ...normalizeClock(rest),
            ...(advance !== undefined ? { advanceMs: durationMs(advance, "advance", true) } : {}),
            ...(reset === true ? { reset: true } : {}),
          }),
        )
      }),

    "GET /latency": ({ namespace }) => {
      controls.ensure(namespace)
      return json(200, controls.latency.get(namespace))
    },
    "PUT /latency": ({ body, namespace }) =>
      guard(() => {
        controls.ensure(namespace)
        return json(200, controls.latency.set(namespace, normalizeLatency(body ?? {})))
      }),
    "DELETE /latency": ({ namespace }) => {
      controls.ensure(namespace)
      controls.latency.clear(namespace)
      return json(200, controls.latency.get(namespace))
    },

    "GET /faults": ({ url, namespace }) => {
      controls.ensure(namespace)
      return json(200, {
        faults: faults.list(url.searchParams.get("all") === "1" ? undefined : namespace),
      })
    },
    "POST /faults": ({ body, namespace }) =>
      guard(() => {
        const preset = isRecord(body) && typeof body.preset === "string" ? body.preset : undefined
        if (preset !== undefined && !controls.presets[preset])
          return adminError(
            404,
            `no fault preset ${JSON.stringify(preset)}; GET ${adminPrefix}/faults/presets`,
          )
        const added = controls.addFault(namespace, body)
        return preset !== undefined ? json(201, { preset, rules: added }) : json(201, added[0])
      }),
    "PUT /faults": ({ body, namespace }) =>
      guard(() => {
        const list = isRecord(body) ? body.faults : undefined
        if (!Array.isArray(list)) return adminError(400, 'expected {"faults": [...]}')
        controls.apply(namespace, normalizeControls({ faults: list }))
        return json(200, { faults: faults.list(namespace) })
      }),
    "DELETE /faults": ({ url, namespace }) => {
      controls.ensure(namespace)
      const everyNamespace = url.searchParams.get("all") === "1"
      const id = url.searchParams.get("id")
      if (id !== null) return removeFault(id, namespace, everyNamespace)
      faults.clear(everyNamespace ? undefined : namespace)
      return json(200, { status: "ok" })
    },
    "GET /faults/presets": () => json(200, presetList()),
    "POST /faults/presets/:name": ({ params, body, namespace }) =>
      guard(() => {
        const name = params.name as string
        if (!controls.presets[name])
          return adminError(404, `no fault preset ${name}; GET ${adminPrefix}/faults/presets`)
        return json(201, {
          preset: name,
          rules: controls.addFault(namespace, { ...(isRecord(body) ? body : {}), preset: name }),
        })
      }),
    "GET /faults/:id": ({ params, namespace }) => {
      controls.ensure(namespace)
      const found = faults.get(params.id as string, namespace)
      return found ? json(200, found) : adminError(404, `no fault ${params.id}`)
    },
    "DELETE /faults/:id": ({ params, url, namespace }) => {
      controls.ensure(namespace)
      return removeFault(params.id as string, namespace, url.searchParams.get("all") === "1")
    },

    "GET /snapshots": ({ namespace }) => json(200, { snapshots: snapshots.list(namespace) }),
    "POST /snapshots": ({ body, namespace }) =>
      guard(() => {
        const id = isRecord(body) ? body.name : undefined
        if (id !== undefined && (typeof id !== "string" || !KEY_PATTERN.test(id)))
          return adminError(400, `name: must match ${KEY_PATTERN}`)
        return json(201, snapshots.create(namespace, id))
      }),
    "GET /snapshots/:id": ({ params, namespace }) => {
      const id = params.id as string
      const info = snapshots.get(namespace, id)
      if (!info) return adminError(404, `no snapshot ${id} in namespace ${namespace}`)
      return json(200, snapshots.export(namespace, id) ?? info)
    },
    "PUT /snapshots/:id": ({ params, body, namespace }) =>
      guard(() => {
        const id = params.id as string
        if (!KEY_PATTERN.test(id)) return adminError(400, `id: must match ${KEY_PATTERN}`)
        return json(200, snapshots.import(namespace, id, assertSnapshotDocument(body)))
      }),
    "POST /snapshots/:id/restore": ({ params, namespace }) =>
      guard(() => {
        const id = params.id as string
        if (!snapshots.restore(namespace, id))
          return adminError(404, `no snapshot ${id} in namespace ${namespace}`)
        return json(200, { status: "ok", id, namespace })
      }),
    "DELETE /snapshots/:id": ({ params, namespace }) => {
      const id = params.id as string
      return snapshots.remove(namespace, id)
        ? json(200, { status: "ok" })
        : adminError(404, `no snapshot ${id} in namespace ${namespace}`)
    },

    "GET /timeline": ({ namespace }) => json(200, context.timeTravel.inspect(namespace)),
    "POST /checkpoints": ({ body, namespace }) => {
      const branch = isRecord(body) && typeof body.branch === "string" ? body.branch : "main"
      try {
        return json(201, context.timeTravel.checkpoint(namespace, branch))
      } catch (error) {
        return adminError(409, error instanceof Error ? error.message : String(error))
      }
    },
    "POST /branches/:name": ({ params, body, namespace }) => {
      const at = isRecord(body) && typeof body.at === "string" ? body.at : undefined
      try {
        return json(
          201,
          context.timeTravel.branch(params.name as string, {
            namespace,
            ...(at !== undefined ? { at } : {}),
          }),
        )
      } catch (error) {
        return adminError(409, error instanceof Error ? error.message : String(error))
      }
    },
    "POST /branches/:name/checkout": ({ params, body, namespace }) => {
      if (!isRecord(body) || typeof body.checkpoint !== "string") {
        return adminError(400, 'expected {"checkpoint":"cp_..."}')
      }
      try {
        context.timeTravel.checkout(body.checkpoint, {
          namespace,
          branch: params.name as string,
        })
        return json(200, { status: "ok", branch: params.name, checkpoint: body.checkpoint })
      } catch (error) {
        return adminError(409, error instanceof Error ? error.message : String(error))
      }
    },

    "GET /requests": ({ url, namespace }) => {
      const status = url.searchParams.get("status")
      const since = url.searchParams.get("since")
      const limit = url.searchParams.get("limit")
      const sinceMs = since === null ? undefined : parseInstant(since)
      if (since !== null && sinceMs === undefined) {
        return adminError(400, "since: expected epoch ms or ISO-8601")
      }
      // `0` is a status here: it is how the journal records a dropped connection.
      if (status !== null && !/^(0|\d{3})$/.test(status))
        return adminError(400, "status: expected an HTTP status, or 0 for a dropped connection")
      if (limit !== null && !/^\d+$/.test(limit)) return adminError(400, "limit: expected a count")
      const operationId = url.searchParams.get("operationId")
      const method = url.searchParams.get("method")
      const path = url.searchParams.get("path")
      const faultId = url.searchParams.get("faultId")
      const everyNamespace = url.searchParams.get("all") === "1"
      return json(200, {
        size: context.journal.size,
        requests: context.journal.list({
          ...(everyNamespace ? {} : { namespace }),
          ...(operationId !== null ? { operationId } : {}),
          ...(method !== null ? { method } : {}),
          ...(path !== null ? { path } : {}),
          ...(faultId !== null ? { faultId } : {}),
          ...(status !== null ? { status: Number(status) } : {}),
          ...(sinceMs !== undefined ? { since: sinceMs } : {}),
          ...(limit !== null ? { limit: Number(limit) } : {}),
        }),
      })
    },
    "DELETE /requests": ({ url, namespace }) => {
      context.journal.clear(url.searchParams.get("all") === "1" ? undefined : namespace)
      return json(200, { status: "ok" })
    },

    // Totals across every namespace, unless the caller names one.
    "GET /metrics": ({ request, url, namespace }) =>
      json(200, context.metrics.report(explicitNamespace(request, url) ? namespace : undefined)),
    "DELETE /metrics": ({ request, url, namespace }) => {
      context.metrics.reset(explicitNamespace(request, url) ? namespace : undefined)
      return json(200, { status: "ok" })
    },
  }

  for (const key of Object.keys(context.routes)) {
    if (Object.hasOwn(builtin, key)) throw new Error(`admin route ${key} overrides a shared route`)
    const path = key.slice(key.indexOf(" ") + 1)
    if (isAdminPath(path, "/ns") || isAdminPath(path, "/blobs"))
      throw new Error(`admin route ${key} overlaps an internal transport`)
  }
  const routes = [...Object.entries(builtin), ...Object.entries(context.routes)]
    .map(([key, handler]) => {
      const space = key.indexOf(" ")
      return { method: key.slice(0, space), pattern: key.slice(space + 1), handler }
    })
    // Stable: among equally specific routes the shared ones still come first.
    .sort((a, b) => paramCount(a.pattern) - paramCount(b.pattern))

  return {
    namespaceOf: headerNamespace,
    controls,
    snapshots,
    async handle(request) {
      const url = new URL(request.url)
      if (url.pathname === `${adminPrefix}/health` && request.method === "GET") {
        return health()
      }
      if (!isAdminPath(url.pathname, adminPrefix)) {
        return undefined
      }
      const path = url.pathname.slice(adminPrefix.length) || "/"
      // The shell has no data. Panel markup stays on GET /ui/manifest, which is locked.
      const shell = request.method === "GET" && (path === "/ui" || path === "/ui/")
      if (
        !shell &&
        context.adminKey !== undefined &&
        request.headers.get(ADMIN_KEY_HEADER) !== context.adminKey
      ) {
        return adminError(401, `missing or wrong ${ADMIN_KEY_HEADER}`)
      }
      for (const route of routes) {
        if (route.method !== request.method) continue
        let params: Record<string, string> | undefined
        try {
          params = matchRoute(route.pattern, path)
        } catch {
          return adminError(400, "invalid path encoding")
        }
        if (!params) continue
        let body: unknown
        try {
          body = await readJson(request)
        } catch {
          return adminError(400, "request body is not valid JSON")
        }
        const namespace = adminNamespace(request, url)
        if (!KEY_PATTERN.test(namespace)) return adminError(400, "invalid namespace")
        return route.handler({
          request,
          url,
          params,
          namespace,
          body,
        })
      }
      return adminError(
        404,
        `no admin route ${request.method} ${path}; GET ${adminPrefix} lists them`,
      )
    },
  }
}
