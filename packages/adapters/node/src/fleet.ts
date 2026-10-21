import { AsyncLocalStorage } from "node:async_hooks"
import { createHash, randomUUID } from "node:crypto"
import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises"
import type { FetchAPI } from "@crvouga/mockingbird-core"
import type {
  Clock,
  RequestLog,
  ServiceInstance,
  ServiceRuntime,
} from "@crvouga/mockingbird-service"
import {
  createClock,
  normalizeBootControls,
  ownedTransport,
  parseDuration,
  resolveAdminPrefix,
  restoreClock,
} from "@crvouga/mockingbird-service"
import { checkSettings } from "./boot-settings.js"
import type { CommonServeOptions, ConfigService, MockingbirdConfig, ServeTarget } from "./cli.js"
import { FleetManagement, type ManagementOptions } from "./fleet-management.js"
import type { EndpointManifest } from "./fleet-manifest.js"
import { preflightFleet } from "./fleet-preflight.js"
import { advertisedHttpBase } from "./fleet-proxy.js"
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
  targetName?: string
  dependencies?: string[]
  coverage?: { included: string[]; excluded: string[] }
  outboundPolicy?: "webhook-hub" | "unsupported"
  packageVersion?: string
  protocol: "http" | "postgres" | "redis" | "external"
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
  nextEvent?(namespace: string): number | undefined | Promise<number | undefined>
  settle?(namespace: string, signal?: AbortSignal): Promise<void>
  exportCheckpoint?(namespace: string, checkpoint: unknown): Promise<unknown>
  importCheckpoint?(namespace: string, document: unknown): Promise<unknown>
  createNamespace?(namespace: string): Promise<void>
  deleteNamespace?(namespace: string): Promise<void>
  inspect?(
    namespace: string,
    options: { offset: number; limit: number; collection?: string },
  ): Promise<unknown>
  configure?(namespace: string, controls: Record<string, unknown>): Promise<unknown>
  unmatched?(namespace: string, limit: number): { entries: unknown[]; truncated: boolean }
  lastActivity?(namespace: string): number
  setAdmission?(allow: (namespace: string) => boolean): void
  initializationAccess?(): Promise<{ connections: Record<string, string>; close(): Promise<void> }>
}

export type ProtocolTarget = {
  packageVersion?: string
  name: string
  protocol: "postgres" | "redis" | "external"
  defaultPort: number
  start(entry: ConfigService): Promise<FleetChild>
}
/** Bundled service declarations contain distinct private runtime classes. The loader boundary
 * accepts their opaque runtime and validates the fleet protocol before starting a listener. */
export type FleetHttpTarget = Pick<
  ServeTarget,
  | "name"
  | "defaultPort"
  | "options"
  | "packageVersion"
  | "listening"
  | "parseSettings"
  | "maxBodyBytes"
> & {
  create(values: Parameters<ServeTarget["create"]>[0], common: CommonServeOptions): unknown
}
export type FleetTarget = FleetHttpTarget | ProtocolTarget

export type FleetOptions = ManagementOptions & {
  participants?: Record<string, FleetChild>
  load(name: string): Promise<FleetTarget>
  onLog?: CommonServeOptions["onLog"]
  readyFile?: string | undefined
  connectionsFile?: string | undefined
  onReady?(manifest: EndpointManifest): void
  initialize?(context: {
    manifest: EndpointManifest
    connections: Record<string, unknown>
    headers: Record<string, string>
    signal: AbortSignal
  }): Promise<void>
  initializationTimeoutMs?: number
  beforeClose?(context: {
    manifest: EndpointManifest
    signal: AbortSignal
    capture(namespaces: string[]): Promise<unknown>
  }): Promise<void>
  shutdownTimeoutMs?: number
  shutdownFailure?: "abort" | "close"
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
const json = (status: number, value: unknown) => {
  if (status >= 400 && isObject(value)) {
    const message =
      typeof value.error === "string"
        ? value.error
        : typeof value.message === "string"
          ? value.message
          : value.status === "failed"
            ? "fleet operation failed"
            : "fleet request rejected"
    return Response.json(
      {
        ...value,
        error: {
          type: "mockingbird_admin",
          code:
            (
              {
                400: "invalid_request",
                401: "unauthorized",
                404: "not_found",
                409: "conflict",
                500: "operation_failed",
              } as Record<number, string>
            )[status] ?? "request_failed",
          message,
        },
      },
      { status },
    )
  }
  return Response.json(value, { status })
}
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
  target: FleetHttpTarget,
  entry: ConfigService,
  options: FleetOptions,
  admission: (namespace: string, request: Request) => Response | undefined,
  generation: (namespace: string) => string | undefined,
  privateAccess: (namespace: string, request: Request) => boolean,
  observer: {
    begin(namespace: string, request: Request): unknown
    finish(
      namespace: string,
      request: Request,
      response: Response,
      log: RequestLog,
      token: unknown,
    ): Promise<void>
    delivery(event: { namespace: string; state: string; deliveryId: string }): void
  },
): Promise<FleetChild> => {
  const requestLog = new AsyncLocalStorage<{ entry?: RequestLog }>()
  const created: unknown = await target.create(entry.options ?? {}, {
    adminPrefix: resolveAdminPrefix(entry.adminPrefix),
    adminKey: entry.adminKey,
    seed: entry.seed,
    onLog: (entry) => {
      const current = requestLog.getStore()
      if (current) current.entry = entry
      options.onLog?.(entry)
    },
    ...(entry.adminControls !== undefined ? { adminControls: entry.adminControls } : {}),
    ...(entry.settings !== undefined
      ? { settings: checkSettings(target, entry.settings, "settings") }
      : {}),
    ...(entry.fixtures !== undefined ? { fixtures: entry.fixtures } : {}),
    ...((advertisedHttpBase(entry) ?? entry.baseUrl) !== undefined
      ? { baseUrl: advertisedHttpBase(entry) ?? entry.baseUrl }
      : {}),
  })
  if (
    !isObject(created) ||
    [
      "fetch",
      "fleetSnapshot",
      "fleetRestore",
      "fleetExport",
      "fleetImport",
      "namespaceOf",
      "instance",
      "namespaceClock",
      "reset",
      "configure",
      "dropNamespace",
    ].some((method) => typeof created[method] !== "function")
  )
    throw new Error(
      "HTTP target does not implement the fleet runtime protocol; build/install matching supported service versions",
    )
  const runtime = created as unknown as ServiceRuntime<ServiceInstance>
  if (entry.idBase !== undefined) runtime.setIdBase?.(entry.idBase)
  const unobserve = runtime.webhooks?.observeDeliveries(observer.delivery)
  if (options.outbound && runtime.webhooks)
    runtime.webhooks.setTransportPolicy(ownedTransport(options.outbound))
  const adminPrefix = resolveAdminPrefix(entry.adminPrefix)
  const locked = new Set<string>()
  const active = new Map<string, number>()
  const activity = new Map<string, number>()
  const api: FetchAPI = {
    async fetch(request) {
      const namespace = runtime.namespaceOf(request)
      if (locked.has(namespace) && !privateAccess(namespace, request))
        return json(409, { error: "fleet control in progress", namespace })
      if (!new URL(request.url).pathname.endsWith(`${adminPrefix}/health`)) {
        const refused = admission(namespace, request)
        if (refused) return refused
      }
      activity.set(namespace, Date.now())
      active.set(namespace, (active.get(namespace) ?? 0) + 1)
      let complete = false
      const finish = () => {
        if (complete) return
        complete = true
        active.set(namespace, (active.get(namespace) ?? 1) - 1)
        request.signal.removeEventListener("abort", finish)
      }
      request.signal.addEventListener("abort", finish, { once: true })
      try {
        const log: { entry?: RequestLog } = {},
          traceToken = observer.begin(namespace, request),
          started = performance.now()
        const response = await requestLog.run(log, () => runtime.fetch(request))
        await observer.finish(
          namespace,
          request,
          response,
          log.entry ?? {
            service: target.name,
            namespace,
            operationId: undefined,
            method: request.method,
            path: new URL(request.url).pathname,
            status: response.status,
            durationMs: performance.now() - started,
            unmatched: response.status === 404,
          },
          traceToken,
        )
        if (!response.body) {
          finish()
          return response
        }
        const reader = response.body.getReader()
        const headers = new Headers(response.headers)
        const epoch = generation(namespace)
        if (epoch) headers.set("x-mockingbird-generation", epoch)
        return new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                const next = await reader.read()
                if (next.done) {
                  finish()
                  controller.close()
                  reader.releaseLock()
                } else controller.enqueue(next.value)
              } catch (error) {
                finish()
                controller.error(error)
              }
            },
            async cancel(reason) {
              try {
                await reader.cancel(reason)
              } finally {
                finish()
                reader.releaseLock()
              }
            },
          }),
          { status: response.status, statusText: response.statusText, headers },
        )
      } catch (error) {
        finish()
        throw error
      }
    },
  }
  let server: Listening | undefined
  try {
    server = await listen(api, {
      port: entry.port ?? target.defaultPort,
      host: entry.host ?? "127.0.0.1",
      ...(target.maxBodyBytes !== undefined ? { maxBodyBytes: target.maxBodyBytes } : {}),
    })
    target.listening?.(server)
  } catch (error) {
    unobserve?.()
    runtime.stop?.()
    await server?.close()
    runtime.webhooks?.clear()
    await runtime.webhooks?.idle()
    throw error
  }
  return {
    protocol: "http",
    outboundPolicy: runtime.webhooks ? "webhook-hub" : "unsupported",
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
      unobserve?.()
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
    unmatched(namespace, limit) {
      const entries = runtime.metrics.report(namespace).unmatched
      return {
        entries: entries.slice(0, limit).map(({ method, path, count }) => ({
          method,
          pathFingerprint: createHash("sha256").update(path).digest("hex"),
          count,
        })),
        truncated: entries.length > limit,
      }
    },
    lastActivity: (namespace) => activity.get(namespace) ?? 0,
    async exportCheckpoint(_namespace, point) {
      return runtime.fleetExport(point)
    },
    async importCheckpoint(namespace, document) {
      return runtime.fleetImport(namespace, document)
    },
    async createNamespace(namespace) {
      runtime.instance(namespace)
    },
    deleteNamespace: (namespace) => runtime.dropNamespace(namespace),
    async configure(namespace, controls) {
      return runtime.configure(controls, namespace)
    },
    async inspect(namespace, { offset, limit, collection }) {
      const doc = runtime.fleetExport(runtime.fleetSnapshot(namespace))
      const rows = collection
        ? doc.records.filter((row) => row.collection === collection)
        : doc.records
      return {
        total: rows.length,
        offset,
        records: rows.slice(offset, offset + limit),
        collections: [...new Set(doc.records.map((row) => row.collection))],
      }
    },
    ...(typeof (runtime.instance() as ServiceInstance & { nextEvent?: unknown }).nextEvent ===
    "function"
      ? {
          nextEvent: (namespace: string) =>
            (
              runtime.instance(namespace) as ServiceInstance & { nextEvent(): number | undefined }
            ).nextEvent(),
        }
      : {}),
    async settle(namespace) {
      const instance = runtime.instance(namespace) as ServiceInstance & { tick?(): unknown }
      await instance.tick?.()
      await runtime.webhooks?.idle(namespace)
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
  if (config.cors && options.cors === undefined) options = { ...options, cors: config.cors }
  const targets = await preflightFleet(config, options)
  const id = randomUUID()
  const startedAt = new Date().toISOString()
  const children = new Map<string, FleetChild>()
  const clocks = new Map<string, Clock>()
  const checkpoints = new Map<
    string,
    { namespace: string; values: Map<string, unknown>; clock: ReturnType<Clock["state"]> }
  >()
  let supervisor: Listening | undefined
  let management: FleetManagement | undefined
  let manifest: EndpointManifest
  const privateConnections = () =>
    Object.fromEntries(
      [...children].map(([name, child]) => [
        name,
        { url: child.connection ?? child.url, namespaces: child.connections },
      ]),
    )
  const publish = async () => {
    if (!manifest || (management && management.lifecycle !== "ready")) return
    manifest.state = recovery.size ? "recovery-required" : "ready"
    for (const [name, child] of children)
      if (manifest.services[name]) manifest.services[name].namespaces = child.namespaces
    if (options.connectionsFile)
      await atomicWrite(options.connectionsFile, {
        version: 1,
        id,
        pid: process.pid,
        services: privateConnections(),
      })
    if (options.readyFile) await atomicWrite(options.readyFile, manifest)
  }
  let stopped = false
  const controlling = new Map<string, string>()
  const recovery = new Map<string, (() => void)[]>()
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => {
    if (closing) return closing
    closing = (async () => {
      management?.stopPolicies()
      let gateFailure: unknown
      if (options.beforeClose && management && ["ready", "failed"].includes(management.lifecycle)) {
        management.lifecycle = "draining"
        const signal = AbortSignal.timeout(options.shutdownTimeoutMs ?? 30000)
        try {
          await Promise.race([
            options.beforeClose({
              manifest,
              signal,
              capture: (namespaces) => (management as FleetManagement).capture(namespaces),
            }),
            new Promise<never>((_, reject) =>
              signal.addEventListener(
                "abort",
                () => reject(new Error("pre-shutdown hook timed out")),
                { once: true },
              ),
            ),
          ])
        } catch (error) {
          management.lifecycle = "failed"
          if (options.shutdownFailure !== "close") {
            closing = undefined
            throw error
          }
          gateFailure = error
        }
      }
      stopped = true
      if (management) management.lifecycle = "stopped"
      const entries = [...children]
      const results: PromiseSettledResult<void>[] = []
      for (const [, child] of [...entries].reverse()) {
        try {
          await child.close()
          results.unshift({ status: "fulfilled", value: undefined })
        } catch (reason) {
          results.unshift({ status: "rejected", reason })
        }
      }
      const cleanup = await Promise.allSettled([
        supervisor?.close(),
        removeOwned(options.readyFile, id),
        removeOwned(options.connectionsFile, id),
      ])
      const failures = results.flatMap((r, i) =>
        r.status === "rejected" ? [{ service: entries[i]?.[0], cause: r.reason }] : [],
      )
      if (gateFailure) failures.push({ service: "pre-shutdown", cause: gateFailure })
      failures.push(
        ...cleanup.flatMap((r) =>
          r.status === "rejected" ? [{ service: "controller", cause: r.reason }] : [],
        ),
      )
      if (failures.length)
        throw new AggregateError(
          failures.map((f) => f.cause),
          `fleet shutdown failed: ${failures.map((f) => f.service).join(", ")}`,
        )
    })()
    return closing
  }
  // Invalidate a previous process's artifacts before attempting startup.
  if (options.readyFile) await rm(options.readyFile, { force: true })
  if (options.connectionsFile) await rm(options.connectionsFile, { force: true })

  const clock = (namespace: string) => {
    let value = clocks.get(namespace)
    if (!value) {
      value = createClock()
      const plan = normalizeBootControls(config.adminControls)
      const boot = { ...plan.shared.clock, ...plan.namespaces[namespace]?.clock }
      if (boot.frozen) value.freeze()
      if (boot.now !== undefined) value.set(boot.now)
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
  const diagnostics = (namespace: string, selected: Map<string, FleetChild> = children) =>
    Object.fromEntries([...selected].map(([name, child]) => [name, child.diagnostics(namespace)]))
  const missingNamespace = (namespace: string, selected: Map<string, FleetChild>) => {
    const missing = [...selected]
      .filter(
        ([, c]) =>
          c.protocol !== "http" &&
          !Object.hasOwn((c.namespaces.endpoints ?? {}) as object, namespace),
      )
      .map(([name]) => name)
    return missing.length
      ? json(404, { error: "namespace is not configured", namespace, services: missing })
      : undefined
  }
  const transaction = async (
    namespace: string,
    selected: Map<string, FleetChild>,
    run: (name: string, child: FleetChild) => Promise<unknown>,
    recover = false,
  ): Promise<Response> => {
    const unavailable = missingNamespace(namespace, selected)
    if (unavailable) return unavailable
    if (management?.topologyBusy(namespace))
      return json(409, { error: "namespace topology operation in progress" })
    if (controlling.has(namespace))
      return json(409, {
        error: "another fleet operation is in progress",
        operationId: controlling.get(namespace),
      })
    if (recovery.has(namespace) && !recover)
      return json(409, {
        error: "namespace requires explicit reset or restore recovery",
        namespace,
      })
    const held = recovery.get(namespace)
    if (held) {
      for (const unlock of held.reverse()) unlock()
      recovery.delete(namespace)
    }
    controlling.set(namespace, management?.operationId(namespace) ?? randomUUID())
    const release: (() => void)[] = []
    let keepFence = false
    const before = new Map<string, unknown>()
    const results: Record<string, unknown> = {}
    let failure: string | undefined
    try {
      if (![...selected.keys()].every((name) => management?.environmentFence(namespace, name)))
        await management?.hook("prepare", namespace, selected)
      management?.phase(namespace, "checkpointing")
      for (const [name, child] of selected) {
        failure = name
        if (!management?.environmentFence(namespace, name)) release.push(child.lock(namespace))
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
        management?.phase(namespace, "checkpointing", before.size, selected.size, name)
        before.set(name, await child.checkpoint(namespace))
      }
      management?.checkCancelled(namespace)
      management?.phase(namespace, "committing")
      for (const [name, child] of selected) {
        failure = name
        management?.phase(namespace, "committing", Object.keys(results).length, selected.size, name)
        results[name] = { status: "ok", result: await run(name, child) }
        management?.phase(namespace, "committing", Object.keys(results).length, selected.size)
      }
      await management?.hook("verify", namespace, selected)
      try {
        await management?.hook("resume", namespace, selected)
      } catch (error) {
        keepFence = true
        throw error
      }
      return json(200, { status: "ok", namespace, services: results })
    } catch (error) {
      if ((error as { code?: string }).code === "MOCKINGBIRD_WORKLOAD_UNCERTAIN") keepFence = true
      const rollback: Record<string, string> = {}
      // Roll back even the child whose mutation failed; it may have partially changed state.
      for (const [name, point] of before) {
        try {
          management?.phase(namespace, "rolling-back", undefined, undefined, name)
          await selected.get(name)?.restore(namespace, point)
          rollback[name] = "restored"
        } catch {
          rollback[name] = "failed"
          management?.phase(namespace, "rollback-failed", undefined, undefined, name)
        }
      }
      keepFence = keepFence || Object.values(rollback).includes("failed") || held !== undefined
      if (!keepFence)
        try {
          await management?.hook("resume", namespace, selected)
        } catch {
          keepFence = true
        }
      if (keepFence && release.length === 0)
        for (const child of selected.values())
          try {
            release.push(child.lock(namespace))
          } catch {}
      return json(500, {
        error: error instanceof Error ? error.message : "fleet operation failed",
        status: "failed",
        namespace,
        failedService: failure,
        services: results,
        rollback,
        rolledBack:
          before.size > 0 && Object.values(rollback).every((value) => value === "restored"),
      })
    } finally {
      if (keepFence) recovery.set(namespace, release)
      else for (const unlock of release.reverse()) unlock()
      controlling.delete(namespace)
    }
  }

  const coreApi: FetchAPI = {
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
      const route = /^\/fleet\/namespaces\/([^/]+)\/(reset|snapshots)(?:\/([^/]+)\/restore)?$/.exec(
        path,
      )
      let namespace: string
      try {
        namespace = route
          ? decodeURIComponent(route[1] as string)
          : (url.searchParams.get("namespace") ??
            request.headers.get("x-mockingbird-namespace") ??
            config.namespace ??
            "default")
      } catch {
        return json(400, { error: "invalid namespace encoding" })
      }
      if (!NS.test(namespace)) return json(400, { error: "invalid namespace" })
      if (request.method === "GET") {
        const unavailable = missingNamespace(namespace, children)
        if (unavailable) return unavailable
      }
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
      const allowed = route?.[3]
        ? []
        : path === "/fleet/clock"
          ? ["services", "set", "advance", "freeze"]
          : route?.[2] === "snapshots"
            ? ["services", "label"]
            : ["services"]
      if (Object.keys(body).some((key) => !allowed.includes(key)))
        return json(400, { error: "unknown control field" })
      if (body.label !== undefined && (typeof body.label !== "string" || body.label.length > 256))
        return json(400, { error: "label must be a string of at most 256 characters" })
      const unavailable = missingNamespace(namespace, selected)
      if (unavailable) return unavailable
      if (path === "/fleet/wait-until-idle") {
        const services = diagnostics(namespace, selected)
        const idle = Object.values(services).every((d) => pending(d) === 0)
        return json(idle ? 200 : 409, { status: idle ? "idle" : "busy", namespace, services })
      }
      if (path === "/fleet/clock") {
        const current = clock(namespace)
        if (body.set === undefined && body.advance === undefined && body.freeze === undefined)
          return json(200, {
            namespace,
            ...current.state(),
            services: Object.fromEntries(
              [...selected].map(([name, child]) => [name, child.clock(namespace).state()]),
            ),
          })
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
          restoreClock(childClock, {
            now:
              body.set !== undefined
                ? target
                : childClock.now() +
                  (body.advance !== undefined ? (parseDuration(body.advance) ?? 0) : 0),
            frozen: body.freeze === undefined ? childClock.state().frozen : frozen,
          })
          await child.settle?.(namespace)
          return childClock.state()
        })
        if (response.ok) restoreClock(current, { now: target, frozen })
        return response
      }
      if (!route) return json(404, { error: "not found" })
      if (route[2] === "reset") {
        if (route[3]) return json(404, { error: "not found" })
        const response = await transaction(
          namespace,
          selected,
          async (_name, child) => child.reset(namespace),
          true,
        )
        if (response.ok && selected.size === children.size) {
          clocks.delete(namespace)
          clock(namespace)
        }
        return response
      }
      if (route[3]) {
        const point = checkpoints.get(route[3])
        if (!point || point.namespace !== namespace)
          return json(404, { error: "no snapshot in this namespace" })
        const restored = new Map(
          [...point.values].map(([name]) => [name, children.get(name) as FleetChild]),
        )
        const response = await transaction(
          namespace,
          restored,
          async (name, child) => child.restore(namespace, point.values.get(name)),
          true,
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
    if (!isObject(config.services) || targets.size === 0)
      throw new Error("config must contain at least one service")
    for (const [name, target] of targets) {
      const entry = config.services[name] ?? {}
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error("invalid service name")
      // Checked before the child starts, so a bad document is reported by name.
      if (config.adminControls !== undefined || entry.adminControls !== undefined)
        normalizeBootControls(
          { ...config.adminControls, ...entry.adminControls },
          `services.${name}.adminControls`,
        )
      try {
        if (entry.protocol && entry.protocol !== ("protocol" in target ? target.protocol : "http"))
          throw new Error("configured protocol does not match target")
        const adminKey = entry.adminKey ?? config.adminKey ?? process.env.MOCKINGBIRD_ADMIN_KEY
        const child =
          "start" in target
            ? await target.start({
                ...entry,
                ...(config.adminControls !== undefined || entry.adminControls !== undefined
                  ? { adminControls: { ...config.adminControls, ...entry.adminControls } }
                  : {}),
              })
            : await httpChild(
                target,
                {
                  ...entry,
                  adminPrefix: resolveAdminPrefix(entry.adminPrefix ?? adminPrefix),
                  ...(adminKey !== undefined ? { adminKey } : {}),
                  ...((entry.idBase ?? config.idBase) !== undefined
                    ? { idBase: entry.idBase ?? config.idBase }
                    : {}),
                  // Fleet-wide controls, with the service's own keys replacing them.
                  ...(config.adminControls !== undefined || entry.adminControls !== undefined
                    ? { adminControls: { ...config.adminControls, ...entry.adminControls } }
                    : {}),
                },
                options,
                (namespace, request) => management?.admit(namespace, request),
                (namespace) => management?.generation(namespace),
                (namespace, request) => management?.privateRequest(namespace, request) ?? false,
                {
                  begin: (namespace, request) => management?.beginRequest(name, namespace, request),
                  finish: async (namespace, request, response, log, token) => {
                    await management?.finishRequest(name, namespace, request, response, log, token)
                  },
                  delivery: (event) => management?.observeDelivery(name, event),
                },
              )
        child.targetName = entry.target ?? name
        if (target.packageVersion) child.packageVersion = target.packageVersion
        children.set(name, child)
        if (!(await child.ready())) throw new Error("protocol readiness failed")
      } catch (error) {
        throw new Error(
          `service ${name} failed to start; all started listeners were closed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        )
      }
    }
    management = new FleetManagement({
      id,
      config: { ...config, adminPrefix },
      options,
      children,
      checkpoints,
      clock,
      transaction,
      manifest: () => manifest,
      publish,
      recovery,
      controlling,
    })
    const api: FetchAPI = {
      fetch: (request) =>
        (management as FleetManagement).dispatch(request, () => coreApi.fetch(request)),
    }
    supervisor = await listen(api, {
      port: config.control?.port ?? 0,
      host: config.control?.host ?? "127.0.0.1",
    })
    manifest = {
      version: 1,
      capabilityVersion: 1,
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
            url: advertisedHttpBase(config.services[name] ?? {}) ?? publicUrl(child.url),
            healthUrl: child.healthUrl ?? `${supervisor?.url}${adminPrefix}/health`,
            adminUrl: child.adminUrl ?? `${supervisor?.url}${adminPrefix}/fleet`,
            namespaces: child.namespaces,
            processReady: true,
            protocolReady: true,
          },
        ]),
      ),
    }
    await management.recoverOperations()
    if (options.initialize) {
      management.lifecycle = "initializing"
      const access: { connections: Record<string, string>; close(): Promise<void> }[] = []
      const connections = privateConnections()
      try {
        for (const [name, child] of children)
          if (child.initializationAccess) {
            const privateAccess = await child.initializationAccess()
            access.push(privateAccess)
            connections[name] = {
              url: privateAccess.connections.default ?? child.connection ?? child.url,
              namespaces: privateAccess.connections,
            }
          }
        const signal = AbortSignal.timeout(options.initializationTimeoutMs ?? 30000)
        await Promise.race([
          options.initialize({
            manifest,
            connections,
            headers: { "x-mockingbird-initializer": management.initializationToken },
            signal,
          }),
          new Promise<never>((_, reject) =>
            signal.addEventListener(
              "abort",
              () => reject(new Error("fleet initialization timed out")),
              { once: true },
            ),
          ),
        ])
      } finally {
        await Promise.all(access.map((entry) => entry.close()))
      }
    }
    await management.startPolicies()
    await publish()
    if (manifest.state === "ready") options.onReady?.(manifest)
    return { manifest, children, fetch: api.fetch, close }
  } catch (error) {
    try {
      await close()
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        `fleet startup and cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    throw error
  }
}
