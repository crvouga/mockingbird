/** Listener-free fleet host. All stateful traffic must pass through this coordinator. */
export type InProcessRuntime = {
  fetch(request: Request): Promise<Response>
  namespaces(): string[]
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
  create(context: { fetch: typeof globalThis.fetch }): InProcessRuntime | Promise<InProcessRuntime>
  /** Required for factories owning background work/resources; omitted means passive runtime. */
  dispose?(runtime: InProcessRuntime): void | Promise<void>
}
export type InProcessArchive = {
  format: "mockingbird.in-process/v1"
  services: Record<string, { version: string; state: Record<string, unknown> | null }>
}
export type InProcessFleetOptions = {
  services: Record<string, InProcessService>
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
 * Lazy runtime ownership and a serial admission barrier for requests and archive operations.
 * Streams retain admission until consumed or cancelled. Do not recursively route an outbound
 * webhook back into this fleet while its initiating request is still awaiting that webhook.
 */
export function createFleet(options: InProcessFleetOptions) {
  const entries = Object.entries(options.services)
  if (!entries.length) throw new Error("services must not be empty")
  for (const [name, entry] of entries) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || !entry.version)
      throw new Error(`invalid service configuration: ${name}`)
  }
  const definitions = new Map(entries)
  const runtimes = new Map<string, Promise<InProcessRuntime>>()
  const failures = new Map<string, string>()
  const cleanupFailures = new Map<string, string>()
  let tail = Promise.resolve()
  async function admission() {
    const previous = tail
    let release!: () => void
    tail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    return release
  }
  async function exclusive<T>(work: () => Promise<T>): Promise<T> {
    const release = await admission()
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
        .then(() => definition.create({ fetch: options.fetch ?? globalThis.fetch }))
        .catch((error: unknown) => {
          failures.set(name, error instanceof Error ? error.message : "factory failed")
          throw error
        })
      runtimes.set(name, promise)
    }
    return promise
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
    const archive = validate(input)
    // Stage in fresh, unregistered runtimes. Failed factories/codecs/restores cannot change
    // either live state or idle/failed boot status. Commit ownership only after every restore.
    const staged = new Map<string, Promise<InProcessRuntime>>()
    const dispose = async (instances: Map<string, Promise<InProcessRuntime>>) => {
      const errors: Record<string, string> = {}
      for (const [name, promise] of instances) {
        const instance = await promise.catch(() => undefined)
        if (!instance) continue
        try {
          await definitions.get(name)?.dispose?.(instance)
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
        const instance = await definition.create({ fetch: options.fetch ?? globalThis.fetch })
        const prior = await runtimes.get(name)?.catch(() => undefined)
        if (instance === prior) throw new Error(`factory must return a fresh runtime: ${name}`)
        staged.set(name, Promise.resolve(instance))
        const prepared = Object.entries(saved.state).map(([namespace, document]) => ({
          namespace,
          point: instance.fleetImport(namespace, document),
        }))
        for (const namespace of instance.namespaces()) await instance.dropNamespace(namespace)
        for (const item of prepared) instance.fleetRestore(item.point, item.namespace)
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
    for (const [name, instance] of staged) runtimes.set(name, instance)
    failures.clear()
    // State has committed. Cleanup errors cannot truthfully be described as rollback;
    // return them explicitly and retain diagnostics in status.
    const cleanupErrors = await dispose(retired)
    return { committed: true, cleanupErrors }
  }

  async function fetchService(name: string, request: Request): Promise<Response> {
    if (!definitions.has(name)) return json(404, { error: "unknown service" })
    const release = await admission()
    try {
      let instance: InProcessRuntime
      try {
        instance = await runtime(name)
      } catch {
        release()
        return json(503, {
          error: { type: "service_creation_failed", service: name, message: failures.get(name) },
        })
      }
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
  async function control(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname
    if (!path.startsWith("/__admin/fleet")) return json(404, { error: "not found" })
    if (path === "/__admin/fleet/status" && request.method === "GET")
      return json(200, { services: status() })
    if (path === "/__admin/fleet/archives/export" && request.method === "POST")
      return json(200, await exclusive(capture))
    if (path === "/__admin/fleet/archives/import" && request.method === "POST") {
      try {
        const body = (await request.json()) as { archive?: unknown }
        const result = await exclusive(() => restore(body.archive))
        return json(200, { status: "ok", ...result })
      } catch (error) {
        return json(400, { error: error instanceof Error ? error.message : "invalid archive" })
      }
    }
    const route =
      /^\/__admin\/fleet\/namespaces\/([A-Za-z0-9_.-]{1,64})(?:\/(reset|snapshots)(?:\/([A-Za-z0-9_.-]{1,64})\/(restore))?)?$/.exec(
        path,
      )
    const isClock = path === "/__admin/fleet/clock"
    if (path === "/__admin/fleet/namespaces" && request.method === "GET") {
      return exclusive(async () => {
        const namespaces = new Set<string>()
        for (const instance of runtimes.values())
          for (const namespace of (await instance).namespaces()) namespaces.add(namespace)
        return json(200, { namespaces: [...namespaces].sort() })
      })
    }
    if (route || isClock) {
      try {
        const url = new URL(request.url)
        const namespace = route?.[1] ?? url.searchParams.get("namespace") ?? "default"
        if (!/^[A-Za-z0-9_.-]{1,64}$/.test(namespace)) throw new Error("invalid namespace")
        const text = request.method === "GET" ? "" : await request.text()
        const body: unknown = text ? JSON.parse(text) : {}
        if (!body || typeof body !== "object" || Array.isArray(body))
          throw new Error("expected JSON object")
        const input = body as Record<string, unknown>
        const allowed = isClock
          ? ["services", "set", "advance", "freeze"]
          : route?.[2] === "snapshots" && !route[3]
            ? ["services", "label"]
            : ["services"]
        if (Object.keys(input).some((key) => !allowed.includes(key)))
          throw new Error("unknown control field")
        const selected = input.services ?? [...definitions.keys()]
        if (
          !Array.isArray(selected) ||
          selected.length === 0 ||
          selected.some((name) => typeof name !== "string" || !definitions.has(name))
        )
          throw new Error("invalid services selection")
        const names = [...new Set(selected)] as string[]
        if (
          input.label !== undefined &&
          (typeof input.label !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(input.label))
        )
          throw new Error("label must be a snapshot identifier")
        const read = request.method === "GET"
        const snapshot = route?.[2] === "snapshots"
        const restoring = !!route?.[3]
        const creatingNamespace = !!route && !route[2] && request.method === "POST"
        const droppingNamespace = !!route && !route[2] && request.method === "DELETE"
        if (!read && request.method !== "POST" && !droppingNamespace)
          return json(405, { error: "method not allowed" })
        if (read && !isClock && !snapshot) return unsupported()
        return await exclusive(async () => {
          const originalRuntimes = new Map(runtimes)
          const originalFailures = new Map(failures)
          const before: { instance: InProcessRuntime; present: boolean; point: object }[] = []
          const created: { instance: InProcessRuntime; id: string }[] = []
          const results: Record<string, unknown> = {}
          const snapshotId =
            snapshot && !read && !restoring
              ? ((input.label as string | undefined) ?? crypto.randomUUID())
              : undefined
          try {
            const instances = await Promise.all(names.map((name) => runtime(name)))
            for (const instance of instances) {
              const present = instance.namespaces().includes(namespace)
              // The opaque checkpoint is owned by the runtime; no parallel snapshot store.
              before.push({ instance, present, point: instance.fleetSnapshot(namespace) })
              if (
                snapshotId &&
                instance.snapshots.list(namespace).some((point) => point.id === snapshotId)
              )
                throw new Error("snapshot already exists")
              if (
                restoring &&
                !instance.snapshots.list(namespace).some((point) => point.id === route?.[3])
              )
                throw new Error("snapshot not found")
            }
            for (const [index, name] of names.entries()) {
              const instance = instances[index] as InProcessRuntime
              if (isClock) {
                const { services: _selection, ...clock } = input
                const response = await instance.fetch(
                  new Request("http://fleet.internal/__admin/clock", {
                    method: read ? "GET" : "POST",
                    headers: {
                      "content-type": "application/json",
                      "x-mockingbird-namespace": namespace,
                    },
                    ...(read ? {} : { body: JSON.stringify(clock) }),
                  }),
                )
                const result = await response.json()
                if (!response.ok) throw new Error(`clock control rejected by ${name}`)
                results[name] = result
              } else if (snapshot) {
                if (read) results[name] = instance.snapshots.list(namespace)
                else if (restoring) {
                  instance.snapshots.restore(route?.[3] as string, namespace)
                  results[name] = { restored: route?.[3] }
                } else {
                  const point = instance.snapshots.create({ name: snapshotId as string, namespace })
                  created.push({ instance, id: point.id })
                  results[name] = point
                }
              } else if (droppingNamespace) {
                await instance.dropNamespace(namespace)
                results[name] = { deleted: true }
              } else if (creatingNamespace) {
                results[name] = { created: true }
              } else {
                await instance.reset(namespace)
                results[name] = { reset: true }
              }
            }
            return json(creatingNamespace || snapshotId ? 201 : 200, {
              namespace,
              ...(snapshotId ? { id: snapshotId } : {}),
              services: results,
            })
          } catch (error) {
            for (const item of created) item.instance.snapshots.delete(item.id, namespace)
            for (const item of before) {
              if (item.present) item.instance.fleetRestore(item.point, namespace)
              else await item.instance.dropNamespace(namespace)
            }
            for (const [name, promise] of runtimes) {
              if (originalRuntimes.has(name)) continue
              const instance = await promise.catch(() => undefined)
              if (!instance) continue
              try {
                await definitions.get(name)?.dispose?.(instance)
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
            throw error
          }
        })
      } catch (error) {
        return json(400, { error: error instanceof Error ? error.message : "invalid control" })
      }
    }

    return unsupported()
  }
  return {
    fetch: fetchService,
    control,
    status,
    export: () => exclusive(capture),
    import: (archive: unknown) => exclusive(() => restore(archive)),
  }
}
