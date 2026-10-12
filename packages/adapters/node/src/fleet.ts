import { randomUUID } from "node:crypto"
import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises"
import type { FetchAPI } from "@crvouga/mockingbird-core"
import type { Clock, ServiceInstance, ServiceRuntime } from "@crvouga/mockingbird-service"
import {
  createClock,
  normalizeBootControls,
  parseDuration,
  resolveAdminPrefix,
  restoreClock,
} from "@crvouga/mockingbird-service"
import type { CommonServeOptions, ConfigService, MockingbirdConfig, ServeTarget } from "./cli.js"
import type { EndpointManifest } from "./fleet-manifest.js"
import { type Listening, listen } from "./listen.js"

export type { EndpointManifest } from "./fleet-manifest.js"

export type FleetDiagnostics = {
  activeRequests: number
  activeConnections: number
  blockedCommands: number
  pendingJobs: number
  activeJobs?: number
  pendingWebhooks: number
  unmatchedRequests: number
}

/** Protocol packages own their state, listeners, credentials and namespace selection. */
export type FleetChild = {
  protocol: "http" | "postgres" | "redis"
  url: string
  connection?: string
  connections?: Record<string, string>
  healthUrl?: string
  adminUrl?: string
  namespaces: Record<string, unknown>
  ready(): Promise<boolean>
  close(): Promise<void>
  /** Fence new work synchronously; diagnostics must also account for work already in flight. */
  lock(namespace: string): () => void
  diagnostics(namespace: string): FleetDiagnostics
  checkpoint(namespace: string): Promise<unknown>
  restore(namespace: string, checkpoint: unknown): Promise<void>
  reset(namespace: string): Promise<void>
  clock(namespace: string): Clock
  settle?(namespace: string): Promise<void>
}

export type ProtocolTarget = {
  name: string
  protocol: "postgres" | "redis"
  defaultPort: number
  start(entry: ConfigService): Promise<FleetChild>
}
export type FleetTarget = ServeTarget | ProtocolTarget

export type FleetOptions = {
  load(name: string): Promise<FleetTarget>
  onLog?: CommonServeOptions["onLog"]
  readyFile?: string | undefined
  connectionsFile?: string | undefined
  onReady?(manifest: EndpointManifest): void
}

const EMPTY: FleetDiagnostics = {
  activeRequests: 0,
  activeConnections: 0,
  blockedCommands: 0,
  pendingJobs: 0,
  pendingWebhooks: 0,
  unmatchedRequests: 0,
}
const NS = /^[A-Za-z0-9_.-]{1,64}$/
const json = (status: number, value: unknown) => Response.json(value, { status })
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const pending = (d: FleetDiagnostics) =>
  d.activeRequests + d.blockedCommands + d.pendingJobs + d.pendingWebhooks

const publicUrl = (raw: string): string => {
  const url = new URL(raw)
  url.password = ""
  return url.href
}

/** Atomic publication; credentials only go in an explicitly requested 0600 file. */
const atomicWrite = async (path: string, value: unknown) => {
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" })
    await chmod(temp, 0o600)
    await rename(temp, path)
  } finally {
    await rm(temp, { force: true })
  }
}

const removeOwned = async (path: string | undefined, id: string) => {
  if (!path) return
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"))
    if (isObject(value) && value.id === id) await rm(path, { force: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
}

const httpChild = async (
  target: ServeTarget,
  entry: ConfigService,
  options: FleetOptions,
): Promise<FleetChild> => {
  const runtime: ServiceRuntime<ServiceInstance> = await target.create(entry.options ?? {}, {
    adminPrefix: resolveAdminPrefix(entry.adminPrefix),
    adminKey: entry.adminKey,
    seed: entry.seed,
    onLog: options.onLog,
    ...(entry.adminControls !== undefined ? { adminControls: entry.adminControls } : {}),
    ...(entry.fixtures !== undefined ? { fixtures: entry.fixtures } : {}),
    ...(entry.baseUrl !== undefined ? { baseUrl: entry.baseUrl } : {}),
  })
  const adminPrefix = resolveAdminPrefix(entry.adminPrefix)
  const locked = new Set<string>()
  const active = new Map<string, number>()
  const api: FetchAPI = {
    async fetch(request) {
      const namespace = runtime.namespaceOf(request)
      if (locked.has(namespace)) return json(409, { error: "fleet control in progress", namespace })
      active.set(namespace, (active.get(namespace) ?? 0) + 1)
      try {
        return await runtime.fetch(request)
      } finally {
        active.set(namespace, (active.get(namespace) ?? 1) - 1)
      }
    },
  }
  let server: Listening | undefined
  try {
    server = await listen(api, {
      port: entry.port ?? target.defaultPort,
      host: entry.host ?? "127.0.0.1",
    })
    target.listening?.(server)
  } catch (error) {
    runtime.stop?.()
    await server?.close()
    runtime.webhooks?.clear()
    await runtime.webhooks?.idle()
    throw error
  }
  return {
    protocol: "http",
    url: server.url,
    healthUrl: `${server.url}${adminPrefix}/health`,
    adminUrl: `${server.url}${adminPrefix}`,
    namespaces: { header: "x-mockingbird-namespace", path: `${adminPrefix}/ns/{name}` },
    ready: async () => {
      try {
        return (
          await fetch(`${server.url}${adminPrefix}/health`, { signal: AbortSignal.timeout(2000) })
        ).ok
      } catch {
        return false
      }
    },
    async close() {
      runtime.stop?.()
      runtime.webhooks?.clear()
      await server.close()
      await runtime.webhooks?.idle()
    },
    lock(namespace) {
      if (locked.has(namespace)) throw new Error("namespace already locked")
      locked.add(namespace)
      return () => locked.delete(namespace)
    },
    diagnostics(namespace) {
      return {
        ...EMPTY,
        activeRequests: active.get(namespace) ?? 0,
        pendingWebhooks: runtime.webhooks?.pending(namespace) ?? 0,
        unmatchedRequests: runtime.metrics
          .report(namespace)
          .unmatched.reduce((n, r) => n + r.count, 0),
      }
    },
    async checkpoint(namespace) {
      return runtime.fleetSnapshot(namespace)
    },
    async restore(namespace, checkpoint) {
      runtime.fleetRestore(checkpoint, namespace)
    },
    reset: (namespace) => runtime.reset(namespace),
    clock: (namespace) => runtime.namespaceClock(namespace),
    async settle(namespace) {
      const instance = runtime.instance(namespace) as ServiceInstance & { tick?(): unknown }
      instance.tick?.()
      await runtime.webhooks?.idle()
    },
  }
}

export type Fleet = {
  readonly manifest: EndpointManifest
  readonly children: ReadonlyMap<string, FleetChild>
  fetch(request: Request): Promise<Response>
  close(): Promise<void>
}

/** Resolves only after every child and the aggregate control listener are healthy. */
export async function startFleet(config: MockingbirdConfig, options: FleetOptions): Promise<Fleet> {
  const id = randomUUID()
  const startedAt = new Date().toISOString()
  const children = new Map<string, FleetChild>()
  const clocks = new Map<string, Clock>()
  const checkpoints = new Map<
    string,
    { namespace: string; values: Map<string, unknown>; clock: ReturnType<Clock["state"]> }
  >()
  let supervisor: Listening | undefined
  let stopped = false
  let controlling = false
  const close = async () => {
    if (stopped) return
    stopped = true
    await Promise.allSettled([...children.values()].map((child) => child.close()))
    await supervisor?.close()
    await removeOwned(options.readyFile, id)
    await removeOwned(options.connectionsFile, id)
  }
  // Invalidate a previous process's artifacts before attempting startup.
  if (options.readyFile) await rm(options.readyFile, { force: true })
  if (options.connectionsFile) await rm(options.connectionsFile, { force: true })

  const clock = (namespace: string) => {
    let value = clocks.get(namespace)
    if (!value) {
      value = createClock()
      clocks.set(namespace, value)
    }
    return value
  }
  const select = (body: Record<string, unknown>): Map<string, FleetChild> => {
    if (body.services === undefined) return children
    if (!Array.isArray(body.services) || body.services.length === 0)
      throw new Error("services must be a nonempty list")
    const selected = new Map<string, FleetChild>()
    for (const name of body.services) {
      if (typeof name !== "string" || !children.has(name))
        throw new Error("unknown service in selection")
      selected.set(name, children.get(name) as FleetChild)
    }
    return selected
  }
  const diagnostics = (namespace: string) =>
    Object.fromEntries([...children].map(([name, child]) => [name, child.diagnostics(namespace)]))
  const transaction = async (
    namespace: string,
    selected: Map<string, FleetChild>,
    run: (name: string, child: FleetChild) => Promise<unknown>,
  ): Promise<Response> => {
    if (controlling) return json(409, { error: "another fleet operation is in progress" })
    controlling = true
    const release: (() => void)[] = []
    const before = new Map<string, unknown>()
    const results: Record<string, unknown> = {}
    let failure: string | undefined
    try {
      for (const [name, child] of selected) {
        failure = name
        release.push(child.lock(namespace))
      }
      const busy = Object.fromEntries(
        [...selected]
          .filter(([, child]) => {
            const state = child.diagnostics(namespace)
            return (
              state.activeRequests +
                state.blockedCommands +
                state.pendingWebhooks +
                (state.activeJobs ?? 0) >
              0
            )
          })
          .map(([name, child]) => [name, child.diagnostics(namespace)]),
      )
      if (Object.keys(busy).length)
        return json(409, { error: "namespace is not quiescent", services: busy })
      for (const [name, child] of selected) {
        failure = name
        before.set(name, await child.checkpoint(namespace))
      }
      for (const [name, child] of selected) {
        failure = name
        results[name] = { status: "ok", result: await run(name, child) }
      }
      return json(200, { status: "ok", namespace, services: results })
    } catch {
      const rollback: Record<string, string> = {}
      // Roll back even the child whose mutation failed; it may have partially changed state.
      for (const [name, point] of before) {
        try {
          await selected.get(name)?.restore(namespace, point)
          rollback[name] = "restored"
        } catch {
          rollback[name] = "failed"
        }
      }
      return json(500, {
        status: "failed",
        namespace,
        failedService: failure,
        services: results,
        rollback,
        rolledBack:
          before.size > 0 && Object.values(rollback).every((value) => value === "restored"),
      })
    } finally {
      for (const unlock of release.reverse()) unlock()
      controlling = false
    }
  }

  const api: FetchAPI = {
    async fetch(request) {
      const url = new URL(request.url)
      const adminPrefix = resolveAdminPrefix(config.adminPrefix)
      const path = url.pathname.startsWith(`${adminPrefix}/`)
        ? url.pathname.slice(adminPrefix.length)
        : ""
      if (path === "/health" && request.method === "GET") {
        const states = await Promise.all(
          [...children].map(async ([name, child]) => {
            let protocolReady = false
            try {
              protocolReady = await child.ready()
            } catch {
              /* reported as failed */
            }
            return [
              name,
              {
                processReady: !stopped,
                protocolReady,
                status: protocolReady ? "ready" : "failed",
                url: publicUrl(child.url),
              },
            ]
          }),
        )
        const ready =
          !stopped &&
          states.every(([, state]) => (state as { protocolReady: boolean }).protocolReady)
        return json(ready ? 200 : 503, {
          status: ready ? "ready" : "failed",
          id,
          services: Object.fromEntries(states),
        })
      }
      if (!path.startsWith("/fleet/")) return json(404, { error: "not found" })
      const adminKey = config.adminKey ?? process.env.MOCKINGBIRD_ADMIN_KEY
      if (adminKey !== undefined && request.headers.get("x-mockingbird-admin-key") !== adminKey)
        return json(401, { error: "admin key required" })
      const route = /^\/fleet\/namespaces\/([^/]+)\/(reset|snapshots)(?:\/([^/]+)\/restore)?$/.exec(
        path,
      )
      const namespace = route
        ? decodeURIComponent(route[1] as string)
        : (url.searchParams.get("namespace") ??
          request.headers.get("x-mockingbird-namespace") ??
          config.namespace ??
          "default")
      if (!NS.test(namespace)) return json(400, { error: "invalid namespace" })
      if (request.method === "GET" && path === "/fleet/metrics")
        return json(200, { namespace, services: diagnostics(namespace) })
      if (request.method === "GET" && path === "/fleet/clock")
        return json(200, {
          namespace,
          ...clock(namespace).state(),
          services: Object.fromEntries(
            [...children].map(([name, child]) => [name, child.clock(namespace).state()]),
          ),
        })
      if (request.method !== "POST") return json(405, { error: "method not allowed" })
      let body: Record<string, unknown>
      try {
        const text = await request.text()
        const value: unknown = text ? JSON.parse(text) : {}
        if (!isObject(value)) throw new Error("expected object")
        body = value
      } catch {
        return json(400, { error: "expected JSON object" })
      }
      let selected: Map<string, FleetChild>
      try {
        selected = select(body)
      } catch (error) {
        return json(400, { error: error instanceof Error ? error.message : "bad selection" })
      }
      if (path === "/fleet/wait-until-idle") {
        const services = diagnostics(namespace)
        const idle = Object.values(services).every((d) => pending(d) === 0)
        return json(idle ? 200 : 409, { status: idle ? "idle" : "busy", namespace, services })
      }
      if (path === "/fleet/clock") {
        const current = clock(namespace)
        let target = current.now()
        if (body.set !== undefined) {
          target =
            typeof body.set === "number"
              ? body.set
              : typeof body.set === "string"
                ? Date.parse(body.set)
                : NaN
          if (!Number.isFinite(target))
            return json(400, { error: "set must be epoch ms or ISO-8601" })
        }
        if (body.advance !== undefined) {
          const delta = parseDuration(body.advance)
          if (delta === undefined) return json(400, { error: "invalid advance" })
          target += delta
        }
        const frozen = body.freeze === undefined ? current.state().frozen : body.freeze
        if (typeof frozen !== "boolean") return json(400, { error: "freeze must be boolean" })
        const response = await transaction(namespace, selected, async (_name, child) => {
          const childClock = child.clock(namespace)
          restoreClock(childClock, { now: target, frozen })
          await child.settle?.(namespace)
          return childClock.state()
        })
        if (response.ok) restoreClock(current, { now: target, frozen })
        return response
      }
      if (!route) return json(404, { error: "not found" })
      if (route[2] === "reset") {
        if (route[3]) return json(404, { error: "not found" })
        const response = await transaction(namespace, selected, async (_name, child) =>
          child.reset(namespace),
        )
        if (response.ok && selected.size === children.size) clock(namespace).reset()
        return response
      }
      if (route[3]) {
        const point = checkpoints.get(route[3])
        if (!point || point.namespace !== namespace)
          return json(404, { error: "no snapshot in this namespace" })
        const restored = new Map(
          [...point.values].map(([name]) => [name, children.get(name) as FleetChild]),
        )
        const response = await transaction(namespace, restored, async (name, child) =>
          child.restore(namespace, point.values.get(name)),
        )
        if (response.ok) restoreClock(clock(namespace), point.clock)
        return response
      }
      const snapshotId = randomUUID()
      const values = new Map<string, unknown>()
      const response = await transaction(namespace, selected, async (name, child) => {
        values.set(name, await child.checkpoint(namespace))
        return { checkpoint: `${snapshotId}:${name}` }
      })
      if (!response.ok) return response
      checkpoints.set(snapshotId, { namespace, values, clock: clock(namespace).state() })
      return json(201, {
        ...((await response.json()) as Record<string, unknown>),
        id: snapshotId,
        label: body.label,
      })
    },
  }
  try {
    const adminPrefix = resolveAdminPrefix(config.adminPrefix)
    if (!isObject(config.services) || Object.keys(config.services).length === 0)
      throw new Error("config must contain at least one service")
    for (const [name, entry] of Object.entries(config.services)) {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error("invalid service name")
      // Checked before the child starts, so a bad document is reported by name.
      if (config.adminControls !== undefined || entry.adminControls !== undefined)
        normalizeBootControls(
          { ...config.adminControls, ...entry.adminControls },
          `services.${name}.adminControls`,
        )
      try {
        const target = await options.load(name)
        if (entry.protocol && entry.protocol !== ("protocol" in target ? target.protocol : "http"))
          throw new Error("configured protocol does not match target")
        const adminKey = entry.adminKey ?? config.adminKey ?? process.env.MOCKINGBIRD_ADMIN_KEY
        const child =
          "start" in target
            ? await target.start(entry)
            : await httpChild(
                target,
                {
                  ...entry,
                  adminPrefix: resolveAdminPrefix(entry.adminPrefix ?? adminPrefix),
                  ...(adminKey !== undefined ? { adminKey } : {}),
                  // Fleet-wide controls, with the service's own keys replacing them.
                  ...(config.adminControls !== undefined || entry.adminControls !== undefined
                    ? { adminControls: { ...config.adminControls, ...entry.adminControls } }
                    : {}),
                },
                options,
              )
        children.set(name, child)
        if (!(await child.ready())) throw new Error("protocol readiness failed")
      } catch {
        throw new Error(`service ${name} failed to start; all started listeners were closed`)
      }
    }
    supervisor = await listen(api, {
      port: config.control?.port ?? 0,
      host: config.control?.host ?? "127.0.0.1",
    })
    const manifest: EndpointManifest = {
      version: 1,
      state: "ready",
      pid: process.pid,
      id,
      startedAt,
      adminBase: `${supervisor.url}${adminPrefix}/fleet`,
      healthUrl: `${supervisor.url}${adminPrefix}/health`,
      services: Object.fromEntries(
        [...children].map(([name, child]) => [
          name,
          {
            protocol: child.protocol,
            url: publicUrl(child.url),
            healthUrl: child.healthUrl ?? `${supervisor?.url}${adminPrefix}/health`,
            adminUrl: child.adminUrl ?? `${supervisor?.url}${adminPrefix}/fleet`,
            namespaces: child.namespaces,
            processReady: true,
            protocolReady: true,
          },
        ]),
      ),
    }
    if (options.connectionsFile)
      await atomicWrite(options.connectionsFile, {
        version: 1,
        id,
        pid: process.pid,
        services: Object.fromEntries(
          [...children].map(([name, child]) => [
            name,
            { url: child.connection ?? child.url, namespaces: child.connections },
          ]),
        ),
      })
    if (options.readyFile) await atomicWrite(options.readyFile, manifest)
    options.onReady?.(manifest)
    return { manifest, children, fetch: api.fetch, close }
  } catch (error) {
    await close()
    throw error
  }
}
