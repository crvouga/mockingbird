import type { Clock } from "./clock.js"
import type { FaultRegistry, FaultRule } from "./faults.js"
import type { Metrics } from "./metrics.js"
import type { NamespaceSnapshot } from "./snapshot.js"

/** Unauthenticated readiness probe, served ahead of every vendor auth gate. */
export const HEALTH_PATH = "/health"
/** Prefix of every control-plane route; never part of a vendor contract. */
export const ADMIN_PREFIX = "/__admin"
/** Carries the admin key, which is separate from any vendor credential. */
export const ADMIN_KEY_HEADER = "x-mockingbird-admin-key"
/** Selects the isolated namespace a request reads and writes. */
export const NAMESPACE_HEADER = "x-mockingbird-namespace"

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

export type ControlContext = {
  name: string
  startedAt: number
  clock: Clock
  faults: FaultRegistry
  metrics: Metrics
  defaultNamespace: string
  namespaces(): string[]
  reset(namespace: string | "*"): Promise<void>
  snapshot(namespace: string): NamespaceSnapshot
  restore(namespace: string, snapshot: NamespaceSnapshot): void
  /** Extra fields for `GET /health`, such as the loaded corpus version. */
  describe(): Record<string, unknown>
  routes: AdminRoutes
  adminKey: string | undefined
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
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })

/** Admin errors use one documented shape, distinct from any vendor's error body. */
const adminError = (status: number, message: string): Response =>
  json(status, { error: { type: "mockingbird_admin", message } })

const UNITS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
}

/** Milliseconds from a number, or a duration like `"90s"`, `"15m"`, `"2h"`, `"3d"`. */
export const parseDuration = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value !== "string") return undefined
  const match = /^(-?\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/.exec(value.trim())
  if (!match) return undefined
  return Number(match[1]) * (UNITS[match[2] as string] as number)
}

/** Epoch milliseconds from a number or an ISO-8601 string. */
const parseInstant = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value !== "string") return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const createControlPlane = (context: ControlContext): ControlPlane => {
  const snapshots = new Map<string, NamespaceSnapshot>()
  let snapshotCounter = 0

  const headerNamespace = (request: Request): string =>
    request.headers.get(NAMESPACE_HEADER) ?? context.defaultNamespace
  const adminNamespace = (request: Request, url: URL): string =>
    url.searchParams.get("namespace") ?? headerNamespace(request)

  const builtin: AdminRoutes = {
    "GET /": () =>
      json(200, {
        service: context.name,
        routes: [...Object.keys(builtin), ...Object.keys(context.routes)].sort(),
      }),

    "POST /reset": async ({ url, namespace }) => {
      const target = url.searchParams.get("all") === "1" ? "*" : namespace
      await context.reset(target)
      return json(200, { status: "ok", reset: target === "*" ? context.namespaces() : [target] })
    },

    "GET /namespaces": () =>
      json(200, { default: context.defaultNamespace, namespaces: context.namespaces() }),

    "GET /clock": () => json(200, context.clock.state()),
    "POST /clock": ({ body }) => {
      if (!isRecord(body)) return adminError(400, "expected a JSON object")
      if (body.reset === true) context.clock.reset()
      if (body.set !== undefined) {
        const instant = parseInstant(body.set)
        if (instant === undefined) return adminError(400, "set: expected epoch ms or ISO-8601")
        context.clock.set(instant)
      }
      if (body.advance !== undefined) {
        const delta = parseDuration(body.advance)
        if (delta === undefined) return adminError(400, 'advance: expected ms or "15m"-style')
        context.clock.advance(delta)
      }
      if (body.freeze === true) context.clock.freeze()
      if (body.freeze === false) context.clock.unfreeze()
      return json(200, context.clock.state())
    },

    "GET /faults": () => json(200, { faults: context.faults.list() }),
    "POST /faults": ({ body, namespace }) => {
      if (!isRecord(body) || typeof body.status !== "number") {
        return adminError(400, "a fault needs a numeric status")
      }
      const rule = {
        // Scoped to the caller's namespace unless it asks for every one, so one worker's
        // injected failure never lands on another's request.
        namespace,
        ...body,
        id: typeof body.id === "string" ? body.id : `fault_${context.faults.list().length + 1}`,
      } as FaultRule
      return json(201, context.faults.add(rule))
    },
    "DELETE /faults": ({ url }) => {
      const id = url.searchParams.get("id")
      if (id === null) {
        context.faults.clear()
        return json(200, { status: "ok" })
      }
      return context.faults.remove(id)
        ? json(200, { status: "ok" })
        : adminError(404, `no fault ${id}`)
    },

    "POST /snapshots": ({ namespace }) => {
      const snapshot = context.snapshot(namespace)
      snapshotCounter++
      const id = `snap_${snapshotCounter}`
      snapshots.set(id, snapshot)
      return json(201, { id, namespace, records: snapshot.records.length })
    },
    "POST /snapshots/:id/restore": ({ params, namespace }) => {
      const snapshot = snapshots.get(params.id as string)
      if (!snapshot) return adminError(404, `no snapshot ${params.id}`)
      context.restore(namespace, snapshot)
      return json(200, { status: "ok", id: params.id, namespace })
    },
    "DELETE /snapshots/:id": ({ params }) =>
      snapshots.delete(params.id as string)
        ? json(200, { status: "ok" })
        : adminError(404, `no snapshot ${params.id}`),

    "GET /metrics": () => json(200, context.metrics.report()),
    "DELETE /metrics": () => {
      context.metrics.reset()
      return json(200, { status: "ok" })
    },
  }

  const routes = [...Object.entries(context.routes), ...Object.entries(builtin)].map(
    ([key, handler]) => {
      const space = key.indexOf(" ")
      return { method: key.slice(0, space), pattern: key.slice(space + 1), handler }
    },
  )

  return {
    namespaceOf: headerNamespace,
    async handle(request) {
      const url = new URL(request.url)
      if (url.pathname === HEALTH_PATH && request.method === "GET") {
        return json(200, {
          status: "ok",
          service: context.name,
          uptimeMs: Date.now() - context.startedAt,
          clock: context.clock.state(),
          namespaces: context.namespaces().length,
          ...context.describe(),
        })
      }
      if (url.pathname !== ADMIN_PREFIX && !url.pathname.startsWith(`${ADMIN_PREFIX}/`)) {
        return undefined
      }
      if (
        context.adminKey !== undefined &&
        request.headers.get(ADMIN_KEY_HEADER) !== context.adminKey
      ) {
        return adminError(401, `missing or wrong ${ADMIN_KEY_HEADER}`)
      }
      const path = url.pathname.slice(ADMIN_PREFIX.length) || "/"
      for (const route of routes) {
        if (route.method !== request.method) continue
        const params = matchRoute(route.pattern, path)
        if (!params) continue
        let body: unknown
        try {
          body = await readJson(request)
        } catch {
          return adminError(400, "request body is not valid JSON")
        }
        return route.handler({
          request,
          url,
          params,
          namespace: adminNamespace(request, url),
          body,
        })
      }
      return adminError(
        404,
        `no admin route ${request.method} ${path}; GET ${ADMIN_PREFIX} lists them`,
      )
    },
  }
}
