import {
  type ArchiveCompatibilityPolicy,
  assertArchiveCompatibility,
  diffArchives,
  type FleetArchive,
  inspectArchive,
  sealArchive,
} from "@crvouga/mockingbird-core"
import {
  createNotificationHarness,
  type NotificationHarness,
} from "@crvouga/mockingbird-notifications"
import {
  type Clock,
  createClock,
  parseDuration,
  restoreClock,
  type UpstreamOptions,
} from "@crvouga/mockingbird-service"
import { createAdmission, FleetAdmissionTimeout } from "./admission.js"

export {
  mountedParticipant,
  postgresParticipant,
  redisParticipant,
  snapshotParticipant,
} from "./participants.js"

/** Listener-free fleet host. All stateful traffic must pass through this coordinator. */
export type InProcessRuntime = {
  dispose?(): void | Promise<void>
  webhooks?: { pending(namespace: string): number } | undefined
  fetch(request: Request): Promise<Response>
  namespaces(): string[]
  namespaceOf?(request: Request): string
  reset(namespace?: string): Promise<void>
  dropNamespace(namespace: string): Promise<void>
  snapshots: {
    create(options?: { name?: string; namespace?: string }): { id: string }
    list(namespace?: string): { id: string }[]
    restore(id: string, namespace?: string): void
    delete(id: string, namespace?: string): boolean
  }
  fleetSnapshot(namespace: string): object
  fleetExport(point: object): unknown
  fleetImport(namespace: string, document: unknown): object
  fleetRestore(point: object, namespace: string): void
}
export type InProcessService = {
  /** Pin the installed package version for archive compatibility. */
  version: string
  target?: string
  protocol?: "http" | "postgres" | "redis" | "external"
  adminPrefix?: string
  adminKey?: string
  upstream?: { baseUrl: string; mode?: "emulated" | "forward" }
  create(context: {
    fetch: typeof globalThis.fetch
    upstream?: UpstreamOptions
  }): InProcessRuntime | Promise<InProcessRuntime>
  /** Required for factories owning background work/resources; omitted means passive runtime. */
  dispose?(runtime: InProcessRuntime): void | Promise<void>
}
export type InProcessArchive = {
  format: "mockingbird.in-process/v1"
  services: Record<string, { version: string; state: Record<string, unknown> | null }>
}
export type InProcessFleetOptions<
  S extends Record<string, InProcessService> = Record<string, InProcessService>,
> = {
  services: S
  upstreams?: Record<string, Pick<UpstreamOptions, "fetch" | "rewriteAuth">>
  archiveCompatibility?: ArchiveCompatibilityPolicy
  controlTimeoutMs?: number
  /** Factories must forward this transport to their webhook options. */
  fetch?: typeof globalThis.fetch
}
const json = (status: number, body: unknown) => Response.json(body, { status })
const unsupported = () =>
  json(501, {
    error: {
      type: "mockingbird_unsupported",
      message: "This control is not supported by the in-process fleet host",
    },
  })

/**
 * Lazy runtime ownership with shared application admission and exclusive control operations.
 * Streams retain admission until consumed or cancelled; draining admits awaited webhook reentry.
 */
export function createFleet<S extends Record<string, InProcessService>>(
  options: InProcessFleetOptions<S>,
) {
  const entries = Object.entries(options.services)
  const sourceId = crypto.randomUUID()
  let dashboard: NotificationHarness | undefined
  const active = new Map<string, number>()
  const startedAt = new Date().toISOString()
  const namespaces = new Map<
    string,
    { generation: string; createdAt: number; activityAt: number; pinned: boolean }
  >()
  const clocks = new Map<string, Clock>()
  const checkpoints = new Map<
    string,
    {
      namespace: string
      label?: string
      createdAt: string
      values: Map<string, unknown>
      clock: ReturnType<Clock["state"]>
    }
  >()
  const remember = (namespace: string) => {
    let state = namespaces.get(namespace)
    if (!state) {
      state = {
        generation: crypto.randomUUID(),
        createdAt: Date.now(),
        activityAt: Date.now(),
        pinned: false,
      }
      namespaces.set(namespace, state)
    }
    return state
  }
  remember("default")
  const manifest = () => ({
    version: 1,
    state: "ready",
    pid: 0,
    id: sourceId,
    startedAt,
    adminBase: "http://fleet.internal/__admin/fleet",
    healthUrl: "http://fleet.internal/__admin/health",
    services: Object.fromEntries(
      entries.map(([name, definition]) => [
        name,
        {
          protocol: definition.protocol ?? "http",
          url: `http://${name}.fleet.internal`,
          healthUrl: `http://${name}.fleet.internal${definition.adminPrefix ?? "/__admin"}/health`,
          adminUrl: `http://${name}.fleet.internal${definition.adminPrefix ?? "/__admin"}`,
          namespaces: { mode: "header", header: "x-mockingbird-namespace", default: "default" },
          processReady: !failures.has(name),
          protocolReady: !failures.has(name),
        },
      ]),
    ),
  })
  const select = (input: Record<string, unknown>) => {
    const selected = input.services ?? [...definitions.keys()]
    if (
      !Array.isArray(selected) ||
      !selected.length ||
      selected.some((name) => typeof name !== "string" || !definitions.has(name))
    )
      throw new Error("invalid services selection")
    return [...new Set(selected)] as string[]
  }
  const clockOf = async (namespace: string) => {
    let clock = clocks.get(namespace)
    if (!clock) {
      clock = createClock()
      const first = entries[0]?.[0]
      if (first) {
        const response = await clockRequest(first, namespace)
        if (!response.ok) throw new Error(`clock control rejected by ${first}`)
        restoreClock(clock, await response.json())
      }
      clocks.set(namespace, clock)
    }
    return clock
  }
  const clockRequest = async (name: string, namespace: string, body?: Record<string, unknown>) => {
    const definition = definitions.get(name) as InProcessService
    return (await runtime(name)).fetch(
      new Request(`http://fleet.internal${definition.adminPrefix ?? "/__admin"}/clock`, {
        method: body ? "POST" : "GET",
        headers: {
          "content-type": "application/json",
          "x-mockingbird-namespace": namespace,
          ...(definition.adminKey ? { "x-mockingbird-admin-key": definition.adminKey } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    )
  }
  const boot = (name: string, entry: InProcessService) => {
    const injected = options.upstreams?.[name]
    if (entry.upstream && !injected?.fetch)
      throw new Error(`upstream requires a host-injected fetch: ${name}`)
    return entry.create({
      fetch: options.fetch ?? globalThis.fetch,
      ...(entry.upstream && injected ? { upstream: { ...entry.upstream, ...injected } } : {}),
    })
  }
  if (!entries.length) throw new Error("services must not be empty")
  for (const [name, entry] of entries) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || !entry.version)
      throw new Error(`invalid service configuration: ${name}`)
  }
  const definitions = new Map(entries)
  const runtimes = new Map<string, Promise<InProcessRuntime>>()
  const resolved = new WeakMap<Promise<InProcessRuntime>, InProcessRuntime>()
  const failures = new Map<string, string>()
  const cleanupFailures = new Map<string, string>()
  const admission = createAdmission(options.controlTimeoutMs ?? 30000)
  async function exclusive<T>(work: () => Promise<T>): Promise<T> {
    const release = await admission.write()
    try {
      return await work()
    } finally {
      release()
    }
  }
  async function shared<T>(work: () => Promise<T>): Promise<T> {
    const release = await admission.read()
    try {
      return await work()
    } finally {
      release()
    }
  }
  function runtime(name: string) {
    const definition = definitions.get(name)
    if (!definition) throw new Error(`unknown service: ${name}`)
    let promise = runtimes.get(name)
    if (!promise) {
      promise = Promise.resolve()
        .then(() => boot(name, definition))
        .catch((error: unknown) => {
          failures.set(name, error instanceof Error ? error.message : "factory failed")
          throw error
        })
      runtimes.set(name, promise)
      const pending = promise
      void pending.then(
        (instance) => resolved.set(pending, instance),
        () => {},
      )
    }
    return promise
  }
  async function disposeRuntime(name: string, instance: InProcessRuntime) {
    const dispose = definitions.get(name)?.dispose
    if (dispose) await dispose(instance)
    else await instance.dispose?.()
  }
  const status = () =>
    Object.fromEntries(
      entries.map(([name]) => [
        name,
        {
          status: failures.has(name) ? "failed" : runtimes.has(name) ? "created" : "idle",
          ...(failures.has(name) ? { error: failures.get(name) } : {}),
          ...(cleanupFailures.has(name) ? { cleanupError: cleanupFailures.get(name) } : {}),
        },
      ]),
    )
  async function capture(): Promise<InProcessArchive> {
    const services: InProcessArchive["services"] = {}
    for (const [name, definition] of entries) {
      const existing = runtimes.get(name)
      if (!existing) {
        services[name] = { version: definition.version, state: null }
        continue
      }
      const instance = await existing
      const state: Record<string, unknown> = {}
      for (const namespace of instance.namespaces()) {
        state[namespace] = instance.fleetExport(instance.fleetSnapshot(namespace))
      }
      services[name] = { version: definition.version, state }
    }
    return structuredClone({ format: "mockingbird.in-process/v1", services })
  }
  function validate(input: unknown): InProcessArchive {
    if (!input || typeof input !== "object") throw new Error("invalid in-process archive")
    const archive = input as InProcessArchive
    if (
      archive.format !== "mockingbird.in-process/v1" ||
      !archive.services ||
      typeof archive.services !== "object"
    )
      throw new Error("unsupported archive format")
    for (const name of new Set([...definitions.keys(), ...Object.keys(archive.services)])) {
      const definition = definitions.get(name),
        saved = archive.services[name]
      if (!definition || !saved || saved.version !== definition.version)
        throw new Error(`archive compatibility mismatch: ${name}`)
      if (
        saved.state !== null &&
        (!saved.state || typeof saved.state !== "object" || Array.isArray(saved.state))
      )
        throw new Error(`invalid archive state: ${name}`)
      for (const namespace of Object.keys(saved.state ?? {}))
        if (!/^[A-Za-z0-9_.-]{1,64}$/.test(namespace)) throw new Error(`invalid namespace: ${name}`)
    }
    return structuredClone(archive)
  }
  async function restore(input: unknown) {
    let selected = input
    if (
      input &&
      typeof input === "object" &&
      "format" in input &&
      input.format === "mockingbird.fleet/v1"
    ) {
      const incoming = fromArchive(input)
      const current = await capture()
      for (const [name, saved] of Object.entries(incoming.services)) {
        current.services[name] =
          saved.state === null
            ? saved
            : {
                version: saved.version,
                state: { ...current.services[name]?.state, ...saved.state },
              }
      }
      selected = current
    }
    const archive = validate(selected)
    // Stage in fresh, unregistered runtimes. Failed factories/codecs/restores cannot change
    // either live state or idle/failed boot status. Commit ownership only after every restore.
    const staged = new Map<string, Promise<InProcessRuntime>>()
    const dispose = async (instances: Map<string, Promise<InProcessRuntime>>) => {
      const errors: Record<string, string> = {}
      for (const [name, promise] of instances) {
        const instance = await promise.catch(() => undefined)
        if (!instance) continue
        try {
          await disposeRuntime(name, instance)
        } catch (error) {
          const message = error instanceof Error ? error.message : "runtime cleanup failed"
          cleanupFailures.set(name, message)
          errors[name] = message
        }
      }
      return errors
    }
    try {
      for (const [name, saved] of Object.entries(archive.services)) {
        if (saved.state === null) continue
        const definition = definitions.get(name) as InProcessService
        const instance = await boot(name, definition)
        const prior = await runtimes.get(name)?.catch(() => undefined)
        if (instance === prior) throw new Error(`factory must return a fresh runtime: ${name}`)
        staged.set(name, Promise.resolve(instance))
        const prepared = Object.entries(saved.state).map(([namespace, document]) => ({
          namespace,
          point:
            document &&
            typeof document === "object" &&
            "format" in document &&
            document.format === "mockingbird.boot/v1"
              ? undefined
              : instance.fleetImport(namespace, document),
        }))
        for (const namespace of instance.namespaces()) await instance.dropNamespace(namespace)
        for (const item of prepared) {
          if (item.point) instance.fleetRestore(item.point, item.namespace)
          else {
            await instance.reset(item.namespace)
            instance.fleetSnapshot(item.namespace)
          }
        }
      }
    } catch (error) {
      const cleanupErrors = await dispose(staged)
      if (Object.keys(cleanupErrors).length)
        throw new AggregateError(
          [error],
          `archive rejected; staged cleanup also failed: ${Object.keys(cleanupErrors).join(", ")}`,
        )
      throw error
    }
    const retired = new Map(runtimes)
    runtimes.clear()
    for (const [name, instance] of staged) {
      runtimes.set(name, instance)
      resolved.set(instance, await instance)
    }
    failures.clear()
    for (const saved of Object.values(archive.services))
      for (const namespace of Object.keys(saved.state ?? {})) remember(namespace)
    clocks.clear()
    if (
      input &&
      typeof input === "object" &&
      "format" in input &&
      input.format === "mockingbird.fleet/v1"
    ) {
      const document = input as FleetArchive
      for (const [namespace, saved] of Object.entries(document.namespaces)) {
        const clock = createClock()
        restoreClock(clock, saved.clock)
        clocks.set(namespace, clock)
      }
    }
    // State has committed. Cleanup errors cannot truthfully be described as rollback;
    // return them explicitly and retain diagnostics in status.
    const cleanupErrors = await dispose(retired)
    return { committed: true, cleanupErrors }
  }

  async function fetchService(name: string, request: Request): Promise<Response> {
    if (!definitions.has(name)) return json(404, { error: "unknown service" })
    const unlock = await admission.read()
    let activeKey = `${name}\0${request.headers.get("x-mockingbird-namespace") ?? "default"}`
    active.set(activeKey, (active.get(activeKey) ?? 0) + 1)
    let released = false
    const release = () => {
      if (released) return
      released = true
      active.set(activeKey, (active.get(activeKey) ?? 1) - 1)
      unlock()
    }
    try {
      request.signal.throwIfAborted()
      let instance: InProcessRuntime
      try {
        instance = await runtime(name)
      } catch {
        release()
        return json(503, {
          error: { type: "service_creation_failed", service: name, message: failures.get(name) },
        })
      }
      const namespace =
        instance.namespaceOf?.(request) ??
        request.headers.get("x-mockingbird-namespace") ??
        "default"
      const key = `${name}\0${namespace}`
      if (key !== activeKey) {
        active.set(activeKey, (active.get(activeKey) ?? 1) - 1)
        activeKey = key
        active.set(key, (active.get(key) ?? 0) + 1)
      }
      remember(namespace).activityAt = Date.now()
      const response = await instance.fetch(request)
      if (!response.body) {
        release()
        return response
      }
      const reader = response.body.getReader()
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await reader.read()
            if (next.done) {
              controller.close()
              release()
            } else controller.enqueue(next.value)
          } catch (error) {
            controller.error(error)
            release()
          }
        },
        async cancel(reason) {
          try {
            await reader.cancel(reason)
          } finally {
            release()
          }
        },
      })
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    } catch (error) {
      release()
      throw error
    }
  }
  async function archive(
    selection: { services?: string[]; namespace?: string } = {},
  ): Promise<FleetArchive> {
    const captured = await capture()
    const namespaces = new Set([
      "default",
      ...Object.values(captured.services).flatMap((entry) => Object.keys(entry.state ?? {})),
    ])
    const result: FleetArchive["namespaces"] = {}
    for (const namespace of namespaces) {
      if (selection.namespace && namespace !== selection.namespace) continue
      const services: FleetArchive["namespaces"][string]["services"] = {}
      let clock = { now: 0, frozen: true }
      for (const [name, definition] of entries) {
        if (selection.services && !selection.services.includes(name)) continue
        const saved = captured.services[name]
        if (!saved) continue
        if (
          saved.state !== null &&
          Object.keys(saved.state).length > 0 &&
          !(namespace in saved.state)
        )
          continue
        const state = saved.state?.[namespace] ?? { format: "mockingbird.boot/v1" }
        if (
          state &&
          typeof state === "object" &&
          "clock" in state &&
          state.clock &&
          typeof state.clock === "object" &&
          "now" in state.clock &&
          typeof state.clock.now === "number" &&
          "frozen" in state.clock &&
          typeof state.clock.frozen === "boolean"
        )
          clock = { now: state.clock.now, frozen: state.clock.frozen }
        services[name] = {
          protocol: definition.protocol ?? "http",
          target: definition.target ?? name,
          version: 1,
          packageVersion: definition.version,
          state,
        }
      }
      if (Object.keys(services).length) {
        const state = clocks.get(namespace)?.state() ?? clock
        result[namespace] = { clock: { now: state.now, frozen: state.frozen }, services }
      }
    }
    return sealArchive({
      format: "mockingbird.fleet/v1",
      sourceId,
      createdAt: new Date().toISOString(),
      namespaces: result,
      ...(options.archiveCompatibility ? { compatibility: options.archiveCompatibility.tags } : {}),
    })
  }
  function fromArchive(input: unknown): InProcessArchive {
    const checked = assertArchiveCompatibility(input, options.archiveCompatibility)
    const services: InProcessArchive["services"] = {}
    for (const [namespace, entry] of Object.entries(checked.namespaces)) {
      for (const [name, saved] of Object.entries(entry.services)) {
        const definition = definitions.get(name)
        if (
          !definition ||
          (saved.packageVersion !== undefined && saved.packageVersion !== definition.version) ||
          saved.protocol !== (definition.protocol ?? "http") ||
          (saved.target ?? name) !== (definition.target ?? name)
        )
          throw new Error(`archive compatibility mismatch: ${name}`)
        const state = services[name]?.state ?? {}
        state[namespace] = saved.state
        services[name] = { version: definition.version, state }
      }
    }
    return { format: "mockingbird.in-process/v1", services }
  }
  async function handleControl(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname
    if (path === "/__admin/health" && request.method === "GET")
      return json(failures.size ? 503 : 200, {
        status: failures.size ? "failed" : "ready",
        services: status(),
      })
    if (!path.startsWith("/__admin/fleet")) return json(404, { error: "not found" })
    if (path === "/__admin/fleet/status" && request.method === "GET")
      return json(200, { services: status() })
    if (path === "/__admin/fleet/archives/export" && request.method === "POST") {
      try {
        const text = await request.text()
        const body = (text ? JSON.parse(text) : {}) as Record<string, unknown>
        if (
          !body ||
          typeof body !== "object" ||
          Array.isArray(body) ||
          Object.keys(body).some((key) => !["services", "allNamespaces"].includes(key)) ||
          (body.allNamespaces !== undefined && typeof body.allNamespaces !== "boolean")
        )
          throw new Error("invalid export options")
        if (
          body.services !== undefined &&
          (!Array.isArray(body.services) ||
            !body.services.length ||
            body.services.some((name) => typeof name !== "string" || !definitions.has(name)))
        )
          throw new Error("invalid services selection")
        const namespace =
          new URL(request.url).searchParams.get("namespace") ??
          request.headers.get("x-mockingbird-namespace") ??
          "default"
        if (!/^[A-Za-z0-9_.-]{1,64}$/.test(namespace)) throw new Error("invalid namespace")
        return json(
          200,
          await exclusive(() =>
            archive({
              ...(body.services ? { services: body.services as string[] } : {}),
              ...(body.allNamespaces === true ? {} : { namespace }),
            }),
          ),
        )
      } catch (error) {
        return json(error instanceof FleetAdmissionTimeout ? 409 : 400, {
          error: error instanceof Error ? error.message : "invalid archive",
        })
      }
    }
    if (path === "/__admin/fleet/archives/import" && request.method === "POST") {
      try {
        const body = (await request.json()) as Record<string, unknown>
        if (
          !body ||
          typeof body !== "object" ||
          Array.isArray(body) ||
          Object.keys(body).some((key) => !["archive", "namespace"].includes(key))
        )
          throw new Error("unknown import option")
        let document = assertArchiveCompatibility(body.archive, options.archiveCompatibility)
        const sourceHash = document.sha256
        if (body.namespace !== undefined) {
          if (
            typeof body.namespace !== "string" ||
            !/^[A-Za-z0-9_.-]{1,64}$/.test(body.namespace) ||
            !document.namespaces[body.namespace]
          )
            throw new Error("selected namespace absent from archive")
          const entry = document.namespaces[body.namespace] as FleetArchive["namespaces"][string]
          const { sha256: _hash, ...unsigned } = document
          document = sealArchive({ ...unsigned, namespaces: { [body.namespace]: entry } })
        }
        const result = await exclusive(() => restore(document))
        return json(200, {
          status: "restored",
          sha256: sourceHash,
          namespaces: Object.keys(document.namespaces),
          ...(Object.keys(result.cleanupErrors).length
            ? { cleanupErrors: result.cleanupErrors }
            : {}),
        })
      } catch (error) {
        return json(error instanceof FleetAdmissionTimeout ? 409 : 400, {
          error: error instanceof Error ? error.message : "invalid archive",
        })
      }
    }
    if (
      ["/__admin/fleet/archives/inspect", "/__admin/fleet/archives/diff"].includes(path) &&
      request.method === "POST"
    ) {
      try {
        const body = (await request.json()) as Record<string, unknown>
        return json(
          200,
          path.endsWith("/inspect")
            ? inspectArchive(body.archive)
            : diffArchives(body.left, body.right),
        )
      } catch (error) {
        return json(error instanceof FleetAdmissionTimeout ? 409 : 400, {
          error: error instanceof Error ? error.message : "invalid archive",
        })
      }
    }
    const upstreamService = /^\/__admin\/fleet\/services\/([a-z0-9-]+)\/upstream$/.exec(path)?.[1]
    if (upstreamService && ["GET", "PUT"].includes(request.method)) {
      const definition = definitions.get(upstreamService)
      if (!definition) return json(404, { error: "unknown service" })
      return exclusive(async () => {
        const instance = await runtime(upstreamService)
        return instance.fetch(
          new Request(`http://fleet.internal${definition.adminPrefix ?? "/__admin"}/upstream`, {
            method: request.method,
            headers: {
              "content-type": "application/json",
              "x-mockingbird-namespace":
                new URL(request.url).searchParams.get("namespace") ??
                request.headers.get("x-mockingbird-namespace") ??
                "default",
              ...(definition.adminKey ? { "x-mockingbird-admin-key": definition.adminKey } : {}),
            },
            ...(request.method === "PUT" ? { body: await request.text() } : {}),
          }),
        )
      })
    }
    if (path === "/__admin/fleet/wait-until-idle" && request.method === "POST") {
      const namespace =
        new URL(request.url).searchParams.get("namespace") ??
        request.headers.get("x-mockingbird-namespace") ??
        "default"
      let names: string[]
      try {
        const text = await request.text()
        const body = (text ? JSON.parse(text) : {}) as Record<string, unknown>
        if (
          !body ||
          typeof body !== "object" ||
          Array.isArray(body) ||
          Object.keys(body).some((key) => key !== "services")
        )
          throw new Error("unknown control field")
        names = select(body)
      } catch (error) {
        return json(400, { error: error instanceof Error ? error.message : "invalid selection" })
      }
      const services: Record<string, unknown> = {}
      let busy = false
      for (const name of names) {
        const created = runtimes.get(name)
        const pendingWebhooks = created
          ? (resolved.get(created)?.webhooks?.pending(namespace) ?? 0)
          : 0
        const activeRequests = (active.get(`${name}\0${namespace}`) ?? 0) + (active.get(name) ?? 0)
        busy ||= activeRequests > 0 || pendingWebhooks > 0
        services[name] = {
          activeRequests,
          activeConnections: 0,
          blockedCommands: 0,
          pendingJobs: 0,
          pendingWebhooks,
          unmatchedRequests: 0,
        }
      }
      return json(busy ? 409 : 200, { status: busy ? "busy" : "idle", namespace, services })
    }
    const route =
      /^\/__admin\/fleet\/namespaces\/([A-Za-z0-9_.-]{1,64})(?:\/(reset|snapshots)(?:\/([A-Za-z0-9_.-]{1,64})(?:\/(restore))?)?)?$/.exec(
        path,
      )
    const isClock = path === "/__admin/fleet/clock"
    if (path === "/__admin/fleet" && request.method === "GET")
      return json(200, { manifest: manifest() })
    if (path === "/__admin/fleet/namespaces" && request.method === "GET") {
      return exclusive(async () => {
        for (const instance of runtimes.values())
          for (const namespace of (await instance).namespaces()) remember(namespace)
        return json(200, {
          namespaces: [...namespaces].map(([namespace, state]) => ({
            namespace,
            ...state,
            status: "ready",
          })),
        })
      })
    }
    if (route || isClock) {
      try {
        const url = new URL(request.url)
        const namespace =
          route?.[1] ??
          url.searchParams.get("namespace") ??
          request.headers.get("x-mockingbird-namespace") ??
          "default"
        if (!/^[A-Za-z0-9_.-]{1,64}$/.test(namespace)) throw new Error("invalid namespace")
        const text = request.method === "GET" ? "" : await request.text()
        const body: unknown = text ? JSON.parse(text) : {}
        if (!body || typeof body !== "object" || Array.isArray(body))
          throw new Error("expected JSON object")
        const input = body as Record<string, unknown>
        const snapshot = route?.[2] === "snapshots"
        const pointId = route?.[3]
        const restoring = route?.[4] === "restore"
        const creatingNamespace = !!route && !route[2] && request.method === "POST"
        const droppingNamespace = !!route && !route[2] && request.method === "DELETE"
        const allowed =
          restoring || request.method !== "POST"
            ? []
            : isClock
              ? ["services", "set", "advance", "freeze"]
              : creatingNamespace
                ? ["baseline"]
                : snapshot
                  ? ["services", "label"]
                  : ["services"]
        if (Object.keys(input).some((key) => !allowed.includes(key)))
          throw new Error("unknown control field")
        let names = select(input)
        if (
          input.label !== undefined &&
          (typeof input.label !== "string" || input.label.length > 256)
        )
          throw new Error("label must be a string of at most 256 characters")
        if (input.baseline !== undefined && typeof input.baseline !== "string")
          throw new Error("baseline must be a checkpoint id")
        if (isClock) {
          if (
            input.set !== undefined &&
            !Number.isFinite(
              typeof input.set === "number"
                ? input.set
                : typeof input.set === "string"
                  ? Date.parse(input.set)
                  : NaN,
            )
          )
            throw new Error("set must be epoch ms or ISO-8601")
          if (input.advance !== undefined && parseDuration(input.advance) === undefined)
            throw new Error("invalid advance")
          if (input.freeze !== undefined && typeof input.freeze !== "boolean")
            throw new Error("freeze must be boolean")
        }
        const read = request.method === "GET"
        if (
          !read &&
          request.method !== "POST" &&
          !droppingNamespace &&
          !(snapshot && request.method === "DELETE")
        )
          return json(405, { error: "method not allowed" })
        if (
          (read && !isClock && !snapshot) ||
          (restoring && request.method !== "POST") ||
          (pointId && !restoring && request.method === "POST")
        )
          return json(405, { error: "method not allowed" })
        return await exclusive(async () => {
          const info = (id: string, point: NonNullable<ReturnType<typeof checkpoints.get>>) => ({
            id,
            namespace: point.namespace,
            label: point.label,
            createdAt: point.createdAt,
            services: [...point.values.keys()],
            portable: true,
          })
          const saved = pointId ? checkpoints.get(pointId) : undefined
          if (snapshot && (read || request.method === "DELETE" || restoring)) {
            if (!pointId)
              return read
                ? json(200, {
                    snapshots: [...checkpoints]
                      .filter(([, point]) => point.namespace === namespace)
                      .map(([id, point]) => info(id, point)),
                  })
                : json(405, { error: "select a checkpoint to delete" })
            if (!saved || saved.namespace !== namespace)
              return json(404, { error: "no checkpoint in this namespace" })
            if (read) return json(200, info(pointId, saved))
            if (request.method === "DELETE") {
              checkpoints.delete(pointId)
              return json(200, { status: "deleted", id: pointId })
            }
            names = [...saved.values.keys()]
          }
          const baseline =
            typeof input.baseline === "string" ? checkpoints.get(input.baseline) : undefined
          if (creatingNamespace && namespaces.has(namespace))
            return json(409, { error: "namespace already exists" })
          if (creatingNamespace && input.baseline && !baseline)
            return json(404, { error: "baseline checkpoint not found" })
          if (droppingNamespace && namespace === "default")
            return json(409, { error: "default namespace cannot be deleted" })
          if (droppingNamespace && !namespaces.has(namespace))
            return json(404, { error: "namespace not found" })
          const originalRuntimes = new Map(runtimes)
          const originalFailures = new Map(failures)
          const previousClock = clocks.get(namespace)?.state()
          const before: {
            instance: InProcessRuntime
            present: boolean
            point: object
            name: string
          }[] = []
          const results: Record<string, unknown> = {}
          let failedService: string | undefined
          const snapshotId = snapshot && !restoring ? crypto.randomUUID() : undefined
          const values = new Map<string, unknown>()
          try {
            for (const name of names) {
              failedService = name
              const instance = await runtime(name)
              const present = instance.namespaces().includes(namespace)
              before.push({ instance, present, point: instance.fleetSnapshot(namespace), name })
            }
            const currentClock = await clockOf(namespace)
            const clockBefore = currentClock.state()
            const clockRead =
              isClock &&
              (read ||
                (input.set === undefined &&
                  input.advance === undefined &&
                  input.freeze === undefined))
            let target = clockBefore.now
            if (isClock && !clockRead) {
              if (input.set !== undefined)
                target =
                  typeof input.set === "number"
                    ? input.set
                    : typeof input.set === "string"
                      ? Date.parse(input.set)
                      : NaN
              if (!Number.isFinite(target)) throw new Error("set must be epoch ms or ISO-8601")
              if (input.advance !== undefined) {
                const advance = parseDuration(input.advance)
                if (advance === undefined) throw new Error("invalid advance")
                target += advance
              }
              if (input.freeze !== undefined && typeof input.freeze !== "boolean")
                throw new Error("freeze must be boolean")
            }
            for (const { name, instance } of before) {
              failedService = name
              let result: unknown
              if (isClock) {
                const { services: _selection, ...clock } = input
                const response = await clockRequest(name, namespace, clockRead ? undefined : clock)
                if (!response.ok) throw new Error(`clock control rejected by ${name}`)
                const state = (await response.json()) as {
                  now: number
                  frozen: boolean
                  offsetMs: number
                }
                result = { now: state.now, frozen: state.frozen, offsetMs: state.offsetMs }
              } else if (restoring && saved) {
                instance.fleetRestore(
                  instance.fleetImport(namespace, saved.values.get(name)),
                  namespace,
                )
              } else if (snapshotId) {
                values.set(
                  name,
                  structuredClone(instance.fleetExport(instance.fleetSnapshot(namespace))),
                )
                result = { checkpoint: `${snapshotId}:${name}` }
              } else if (droppingNamespace) await instance.dropNamespace(namespace)
              else if (creatingNamespace) {
                if (baseline?.values.has(name))
                  instance.fleetRestore(
                    instance.fleetImport(namespace, baseline.values.get(name)),
                    namespace,
                  )
              } else await instance.reset(namespace)
              results[name] = clockRead
                ? result
                : { status: "ok", ...(result === undefined ? {} : { result }) }
            }
            if (clockRead)
              return json(200, { namespace, ...currentClock.state(), services: results })
            if (isClock)
              restoreClock(currentClock, {
                now: target,
                frozen: (input.freeze as boolean | undefined) ?? clockBefore.frozen,
              })
            if (restoring && saved) restoreClock(currentClock, saved.clock)
            if (snapshotId)
              checkpoints.set(snapshotId, {
                namespace,
                ...(typeof input.label === "string" ? { label: input.label } : {}),
                createdAt: new Date().toISOString(),
                values,
                clock: currentClock.state(),
              })
            if (droppingNamespace) {
              namespaces.delete(namespace)
              clocks.delete(namespace)
              for (const [id, point] of checkpoints)
                if (point.namespace === namespace) checkpoints.delete(id)
              return json(200, { status: "deleted", namespace })
            }
            if (!isClock && !snapshot && !creatingNamespace && names.length === entries.length)
              clocks.delete(namespace)
            remember(namespace)
            if (creatingNamespace) {
              if (baseline) restoreClock(currentClock, baseline.clock)
              return json(201, {
                namespace,
                generation: remember(namespace).generation,
                manifest: manifest(),
                connections: Object.fromEntries(
                  entries.map(([name, definition]) => [
                    name,
                    `http://${name}.fleet.internal${definition.adminPrefix ?? "/__admin"}/ns/${namespace}`,
                  ]),
                ),
              })
            }
            return json(snapshotId ? 201 : 200, {
              status: "ok",
              namespace,
              services: results,
              ...(snapshotId ? { id: snapshotId, label: input.label } : {}),
            })
          } catch (error) {
            const rollback: Record<string, string> = {}
            for (const item of before) {
              try {
                if (item.present) item.instance.fleetRestore(item.point, namespace)
                else await item.instance.dropNamespace(namespace)
                rollback[item.name] = "restored"
              } catch {
                rollback[item.name] = "failed"
                failures.set(item.name, "rollback failed")
              }
            }
            for (const [name, promise] of runtimes) {
              if (originalRuntimes.has(name)) continue
              const instance = await promise.catch(() => undefined)
              if (instance)
                try {
                  await disposeRuntime(name, instance)
                } catch (cleanupError) {
                  cleanupFailures.set(
                    name,
                    cleanupError instanceof Error ? cleanupError.message : "runtime cleanup failed",
                  )
                }
            }
            runtimes.clear()
            for (const [name, instance] of originalRuntimes) runtimes.set(name, instance)
            failures.clear()
            for (const [name, failure] of originalFailures) failures.set(name, failure)
            for (const [name, state] of Object.entries(rollback))
              if (state === "failed") failures.set(name, "rollback failed")
            if (previousClock) restoreClock(clocks.get(namespace) as Clock, previousClock)
            else clocks.delete(namespace)
            return json(500, {
              error: error instanceof Error ? error.message : "control failed",
              status: "failed",
              namespace,
              failedService,
              services: results,
              rollback,
              rolledBack: Object.values(rollback).every((state) => state === "restored"),
            })
          }
        })
      } catch (error) {
        return json(error instanceof FleetAdmissionTimeout ? 409 : 400, {
          error: error instanceof Error ? error.message : "invalid control",
        })
      }
    }

    return unsupported()
  }
  async function control(request: Request) {
    try {
      return await handleControl(request)
    } catch (error) {
      if (error instanceof FleetAdmissionTimeout) return json(409, { error: error.message })
      throw error
    }
  }
  return {
    async run<K extends keyof S & string, T>(
      name: K,
      work: (instance: Awaited<ReturnType<S[K]["create"]>>) => T | Promise<T>,
    ): Promise<T> {
      active.set(name, (active.get(name) ?? 0) + 1)
      try {
        return await shared(async () =>
          work((await runtime(name)) as Awaited<ReturnType<S[K]["create"]>>),
        )
      } finally {
        active.set(name, (active.get(name) ?? 1) - 1)
      }
    },
    async dashboard(options: { title?: string } = {}) {
      if (!dashboard) {
        const { adminGateway } = await import("@crvouga/mockingbird-notifications/admin-gateway")
        dashboard = createNotificationHarness({
          title: options.title ?? "Mockingbird",
          admin: adminGateway(),
          defaultTab: "emulators",
          pollIntervalMs: 0,
          services: Object.fromEntries(
            entries
              .filter(([, definition]) => !definition.protocol || definition.protocol === "http")
              .map(([name]) => [
                name,
                { fetch: (request: Request) => fetchService(name, request) },
              ]),
          ),
          adminKeys: Object.fromEntries(
            entries.flatMap(([name, definition]) =>
              definition.adminKey ? [[name, definition.adminKey]] : [],
            ),
          ),
        })
      }
      return dashboard
    },
    async dispose() {
      return exclusive(async () => {
        dashboard?.close()
        dashboard = undefined
        for (const [name, promise] of runtimes) {
          const instance = await promise.catch(() => undefined)
          if (instance) await disposeRuntime(name, instance)
        }
        runtimes.clear()
        failures.clear()
      })
    },
    exportArchive: () => exclusive(archive),
    fetch: fetchService,
    control,
    status,
    export: () => exclusive(capture),
    import: (archive: unknown) => exclusive(() => restore(archive)),
  }
}
