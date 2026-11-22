/**
 * Lazy, swappable in-tab backends and emulators for a worker preview host. Each backend boots on
 * its first request (requests queue meanwhile) and can be replaced in place: the new handler boots
 * beside the old one, new requests move to it once it is ready, and the old one drains its
 * in-flight requests (bounded) before it is disposed. Other backends, emulators and databases keep
 * their state, because only that one handler changes.
 *
 * Portable: Fetch API only.
 */
import type { PreviewFetch } from "./bridge.js"
import type { PreviewSystem } from "./host.js"

/** Where a backend is. Lazy backends stay `not started` until their first request. */
export type PreviewBackendState = "not started" | "starting" | "ready" | "failed" | "updating"

/** What a backend's boot receives. */
export type PreviewBackendBootContext = {
  id: string
  /** 0 for the first boot, +1 for each replacement. */
  generation: number
  signal: AbortSignal
  /** Reports boot progress (0 to 1, with an optional note) to the status and subscribers. */
  progress(fraction: number, note?: string): void
}

export type PreviewBackendBoot = (
  context: PreviewBackendBootContext,
) => PreviewSystem | Promise<PreviewSystem>

export type PreviewBackendSpec = {
  label?: string
  kind?: "backend" | "emulator"
  /**
   * Which requests it serves: a host name ("api.internal"), a path prefix ("/api"), or a
   * predicate. Backends are tried in declaration order.
   */
  match: string | ((url: URL) => boolean)
  boot: PreviewBackendBoot
}

export type PreviewBackendStatus = {
  id: string
  label: string
  kind: "backend" | "emulator"
  state: PreviewBackendState
  /** The generation serving new requests (or booting, for the first boot). */
  generation: number
  /** Requests in flight on every generation. */
  inFlight: number
  progress?: { fraction: number; note?: string }
  /** The last boot or update failure. */
  message?: string
}

/** A request that was still running on a replaced backend when its drain deadline passed. */
export class PreviewBackendDrainError extends Error {
  readonly code = "preview_backend_drained"
  readonly backend: string
  readonly generation: number
  constructor(backend: string, generation: number, drainMs: number) {
    super(
      `Backend ${backend} generation ${generation} was replaced and did not finish this request within ${drainMs} ms`,
    )
    this.name = "PreviewBackendDrainError"
    this.backend = backend
    this.generation = generation
  }
}

/** The new code of a backend failed to boot; the previous generation keeps serving. */
export class PreviewBackendUpdateError extends Error {
  readonly code = "preview_backend_update_failed"
  readonly backend: string
  constructor(backend: string, cause: unknown) {
    super(
      `Backend ${backend} failed to boot its new code: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    )
    this.name = "PreviewBackendUpdateError"
    this.backend = backend
  }
}

type Generation = {
  number: number
  system: PreviewSystem
  inFlight: Set<{ abort: AbortController; settled: Promise<unknown> }>
  /** Set once replaced: requests still running past the deadline get this error. */
  drained?: PreviewBackendDrainError
}

type Slot = {
  id: string
  spec: PreviewBackendSpec
  boot: PreviewBackendBoot
  state: PreviewBackendState
  active?: Generation | undefined
  starting?: Promise<Generation> | undefined
  next: number
  progress?: { fraction: number; note?: string } | undefined
  message?: string | undefined
  /** Serializes replacements. */
  replacing: Promise<unknown>
  /** Requests waiting for or running on any generation (for `inFlight`). */
  retired: Set<Generation>
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error))

export type BackendHostOptions = {
  backends: Record<string, PreviewBackendSpec>
  /** How long a replaced generation may keep serving its in-flight requests. Default 10 s. */
  drainMs?: number
}

export type BackendHost = {
  /** Routes a request to its backend, booting it first if no request has reached it yet. */
  fetch(request: Request): Promise<Response>
  /** Boots these backends now (an app about to open calls them). Rejects if one fails. */
  ensure(ids: readonly string[], signal?: AbortSignal): Promise<void>
  /**
   * Swaps one backend's code. The new generation boots beside the old one; when it is ready, new
   * requests go to it and the old one drains (`drainMs`, then `PreviewBackendDrainError`) and is
   * disposed. If the new code fails to boot, the old one keeps serving and this rejects with
   * `PreviewBackendUpdateError`. A backend that has not started just takes the new code.
   */
  replace(id: string, boot: PreviewBackendBoot, options?: { drainMs?: number }): Promise<void>
  status(): PreviewBackendStatus[]
  /** Same as `status()`, shaped for the System screen's `backends` option. */
  list(): PreviewBackendStatus[]
  subscribe(listener: () => void): () => void
  dispose(): Promise<void>
}

const matcher = (match: PreviewBackendSpec["match"]): ((url: URL) => boolean) => {
  if (typeof match === "function") return match
  if (match.startsWith("/")) {
    const prefix = match.length > 1 && match.endsWith("/") ? match.slice(0, -1) : match
    return (url) =>
      prefix === "/" || url.pathname === prefix || url.pathname.startsWith(`${prefix}/`)
  }
  return (url) => url.host === match || url.hostname === match
}

/** Lazy, swappable backends behind one Fetch handler (pass it as a `createPreviewHost` system). */
export function createBackendHost(options: BackendHostOptions): BackendHost {
  const drainDefault = options.drainMs ?? 10_000
  const listeners = new Set<() => void>()
  const emit = () => {
    for (const listener of listeners) {
      try {
        listener()
      } catch {
        /* One listener failing must not stop the others. */
      }
    }
  }
  let disposed = false
  const lifetime = new AbortController()
  const slots = Object.entries(options.backends).map(
    ([id, spec]): Slot & { matches: (url: URL) => boolean } => ({
      id,
      spec,
      boot: spec.boot,
      state: "not started",
      next: 0,
      replacing: Promise.resolve(),
      retired: new Set(),
      matches: matcher(spec.match),
    }),
  )
  const slot = (id: string) => {
    const found = slots.find((candidate) => candidate.id === id)
    if (!found) throw new Error(`No backend ${id}`)
    return found
  }
  const bootGeneration = async (target: Slot, boot: PreviewBackendBoot): Promise<Generation> => {
    const number = target.next++
    const system = await boot({
      id: target.id,
      generation: number,
      signal: lifetime.signal,
      progress(fraction, note) {
        target.progress = {
          fraction: Math.max(0, Math.min(1, fraction)),
          ...(note ? { note } : {}),
        }
        emit()
      },
    })
    return { number, system, inFlight: new Set() }
  }
  const start = (target: Slot): Promise<Generation> => {
    if (target.active) return Promise.resolve(target.active)
    if (target.starting) return target.starting
    target.state = "starting"
    target.message = undefined
    emit()
    const starting = bootGeneration(target, target.boot).then(
      (generation) => {
        target.starting = undefined
        target.progress = undefined
        if (disposed) {
          void generation.system.dispose?.()
          throw new Error("Backend host is disposed")
        }
        target.active = generation
        target.state = "ready"
        emit()
        return generation
      },
      (error: unknown) => {
        target.starting = undefined
        target.progress = undefined
        target.state = "failed"
        target.message = describe(error)
        emit()
        throw error
      },
    )
    target.starting = starting
    return starting
  }
  const serve = async (_target: Slot, generation: Generation, request: Request) => {
    const abort = new AbortController()
    const signal = AbortSignal.any([request.signal, abort.signal])
    let finish: () => void = () => {}
    const settled = new Promise<void>((resolve) => {
      finish = resolve
    })
    const entry = { abort, settled }
    generation.inFlight.add(entry)
    const done = () => {
      if (generation.inFlight.delete(entry)) finish()
    }
    const drained = new Promise<never>((_, reject) => {
      abort.signal.addEventListener("abort", () => reject(generation.drained), { once: true })
    })
    drained.catch(() => {})
    try {
      const response = await Promise.race([
        Promise.resolve(generation.system.fetch(new Request(request, { signal }))),
        drained,
      ])
      if (!response.body) {
        done()
        return response
      }
      // The request is in flight until its body is read, cancelled or cut off by the drain.
      const reader = response.body.getReader()
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const chunk = await Promise.race([reader.read(), drained])
            if (chunk.done) {
              done()
              controller.close()
            } else controller.enqueue(chunk.value)
          } catch (error) {
            done()
            controller.error(error)
            void reader.cancel(error).catch(() => {})
          }
        },
        async cancel(reason) {
          done()
          await reader.cancel(reason)
        },
      })
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    } catch (error) {
      done()
      throw error
    }
  }
  const fetch = async (request: Request): Promise<Response> => {
    if (disposed) throw new Error("Backend host is disposed")
    const url = new URL(request.url)
    const target = slots.find((candidate) => candidate.matches(url))
    if (!target)
      return Response.json(
        { error: "preview_backend_not_found", url: request.url },
        { status: 404 },
      )
    let generation: Generation
    try {
      generation = await start(target)
    } catch (error) {
      return Response.json(
        { error: "preview_backend_failed", backend: target.id, message: describe(error) },
        { status: 503 },
      )
    }
    request.signal.throwIfAborted()
    return serve(target, generation, request)
  }
  const replace = (
    id: string,
    boot: PreviewBackendBoot,
    replaceOptions: { drainMs?: number } = {},
  ) => {
    const target = slot(id)
    const drainMs = replaceOptions.drainMs ?? drainDefault
    const run = async () => {
      if (disposed) throw new Error("Backend host is disposed")
      if (target.starting) await target.starting.catch(() => {})
      const previous = target.active
      if (!previous) {
        // Never started (or its last boot failed): the next request boots the new code.
        target.boot = boot
        if (target.state === "failed") target.state = "not started"
        emit()
        return
      }
      target.state = "updating"
      target.message = undefined
      emit()
      let fresh: Generation
      try {
        fresh = await bootGeneration(target, boot)
      } catch (error) {
        target.state = "ready"
        target.progress = undefined
        target.message = describe(error)
        emit()
        throw new PreviewBackendUpdateError(id, error)
      }
      if (disposed) {
        await fresh.system.dispose?.()
        throw new Error("Backend host is disposed")
      }
      target.boot = boot
      target.active = fresh
      target.state = "ready"
      target.progress = undefined
      target.retired.add(previous)
      emit()
      // Drain the old generation: let its requests finish, then cut off the rest.
      const all = Promise.all([...previous.inFlight].map((entry) => entry.settled))
      let timer: ReturnType<typeof setTimeout> | undefined
      const deadline = new Promise<"late">((resolve) => {
        timer = setTimeout(() => resolve("late"), drainMs)
      })
      const outcome = await Promise.race([all.then(() => "drained" as const), deadline])
      clearTimeout(timer)
      if (outcome === "late") {
        previous.drained = new PreviewBackendDrainError(id, previous.number, drainMs)
        for (const entry of previous.inFlight) entry.abort.abort(previous.drained)
        await Promise.all([...previous.inFlight].map((entry) => entry.settled))
      }
      target.retired.delete(previous)
      try {
        await previous.system.dispose?.()
      } finally {
        emit()
      }
    }
    const result = target.replacing.then(run, run)
    target.replacing = result.catch(() => {})
    return result
  }
  const status = (): PreviewBackendStatus[] =>
    slots.map((target) => ({
      id: target.id,
      label: target.spec.label ?? target.id,
      kind: target.spec.kind ?? "backend",
      state: target.state,
      generation: target.active?.number ?? Math.max(0, target.next - 1),
      inFlight:
        (target.active?.inFlight.size ?? 0) +
        [...target.retired].reduce((sum, generation) => sum + generation.inFlight.size, 0),
      ...(target.progress ? { progress: target.progress } : {}),
      ...(target.message ? { message: target.message } : {}),
    }))
  return {
    fetch,
    async ensure(ids, signal) {
      await Promise.all(
        ids.map(async (id) => {
          signal?.throwIfAborted()
          await start(slot(id))
        }),
      )
    },
    replace,
    status,
    list: status,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async dispose() {
      if (disposed) return
      disposed = true
      lifetime.abort()
      for (const target of slots) {
        await target.starting?.catch(() => {})
        const generations = [target.active, ...target.retired].filter(
          (generation): generation is Generation => generation !== undefined,
        )
        target.active = undefined
        target.retired.clear()
        for (const generation of generations) await generation.system.dispose?.()
      }
      emit()
      listeners.clear()
    },
  }
}

/**
 * The backend host's control routes, for a tab whose backends run in a worker: `GET` answers the
 * status list, `POST {"ensure": [ids]}` boots backends, `POST {"replace": id, "entry": url}`
 * swaps one to the code at `entry` (imported with `importBackend`). Without `importBackend`,
 * `replace` answers 501 `preview_backend_replace_unsupported`.
 */
export function backendControlHandler(
  host: BackendHost,
  options: {
    path?: string
    importBackend?: (entry: string) => Promise<PreviewBackendBoot>
  } = {},
): (request: Request) => Promise<Response> | undefined {
  const path = options.path ?? "/__preview/backends"
  return (request) => {
    if (new URL(request.url).pathname !== path) return undefined
    return (async () => {
      if (request.method === "GET") return Response.json({ backends: host.status() })
      if (request.method !== "POST")
        return Response.json({ error: "method_not_allowed" }, { status: 405 })
      let body: { ensure?: unknown; replace?: unknown; entry?: unknown }
      try {
        body = (await request.json()) as typeof body
      } catch {
        return Response.json({ error: "invalid_json" }, { status: 400 })
      }
      try {
        if (Array.isArray(body.ensure)) {
          await host.ensure(body.ensure.filter((id): id is string => typeof id === "string"))
          return Response.json({ backends: host.status() })
        }
        if (typeof body.replace === "string" && typeof body.entry === "string") {
          if (!options.importBackend)
            return Response.json(
              {
                error: "preview_backend_replace_unsupported",
                message:
                  "This preview host has no importBackend, so backends cannot be swapped in place",
              },
              { status: 501 },
            )
          const boot = await options.importBackend(body.entry)
          await host.replace(body.replace, boot)
          return Response.json({ backends: host.status() })
        }
      } catch (error) {
        return Response.json(
          {
            error:
              error instanceof PreviewBackendUpdateError
                ? error.code
                : "preview_backend_control_failed",
            message: describe(error),
          },
          { status: error instanceof PreviewBackendUpdateError ? 502 : 500 },
        )
      }
      return Response.json({ error: "invalid_request" }, { status: 400 })
    })()
  }
}

/**
 * The tab's side of `backendControlHandler`: `list` and `subscribe` (polling) for the System
 * screen's `backends`, `ensure` for `mountSystem`'s `ensureBackends`, and `replace` for its
 * `replaceBackend`.
 */
export function backendControls(
  fetch: PreviewFetch,
  options: { url?: string; pollMs?: number } = {},
) {
  const url = options.url ?? "http://preview.local/__preview/backends"
  const call = async (body?: unknown) => {
    const response = await fetch(
      new Request(
        url,
        body === undefined
          ? {}
          : {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            },
      ),
    )
    const json = (await response.json()) as { backends?: PreviewBackendStatus[]; message?: string }
    if (!response.ok) throw new Error(json.message ?? `Backend control answered ${response.status}`)
    return json.backends ?? []
  }
  return {
    list: () => call(),
    async ensure(ids: readonly string[]) {
      if (ids.length > 0) await call({ ensure: ids })
    },
    async replace(id: string, next: { entry: string }) {
      await call({ replace: id, entry: next.entry })
    },
    subscribe(listener: () => void) {
      const timer = setInterval(listener, options.pollMs ?? 2_000)
      return () => clearInterval(timer)
    },
  }
}
