/**
 * Browser side of dev resources: wires an emulator runtime's `upstream` to the dev proxy (which
 * reaches a real non-production resource) and gives the System screen its per-service
 * Emulated / Dev switches.
 *
 * The proxy is mounted on the app's own origin and trusts it: the client sends no key and never
 * handles a credential.
 *
 * Portable: Fetch API only; `localStorage` is used when present and never required.
 */
import type { DevManifest } from "./dev-proxy.js"

/** `value` without trailing slashes, in linear time (a `/\/+$/` regex backtracks on long runs). */
const withoutTrailingSlashes = (value: string): string => {
  let end = value.length
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--
  return value.slice(0, end)
}

export type DevMode = "emulated" | "dev"

export type DevServiceSpec = {
  /** Provider id at the proxy, e.g. "stripe". */
  id: string
  /** "Stripe" */
  label: string
  /** "Payments" */
  category?: string
  /** The emulator runtime's own fetch (for /__admin/upstream). */
  admin: (request: Request) => Promise<Response>
  /** A reason when this emulator cannot forward (no `upstream` support). */
  unsupported?: string
}

/** Structurally identical to `SystemServiceMode` in `@crvouga/mockingbird-ui`. */
export type SystemServiceModeLike = "emulated" | "dev"

/** Structurally identical to `SystemService` in `@crvouga/mockingbird-ui`. */
export type SystemServiceLike = {
  id: string
  label: string
  category?: string
  mode: SystemServiceModeLike
  /** Why dev cannot be chosen; undefined when it can. */
  unavailable?: string
  /** The last request this tab sent the dev resource through the proxy. */
  lastCall?: { at: string; ok: boolean; status?: number }
}

/** Structurally identical to `SystemDevStatus` in `@crvouga/mockingbird-ui`. */
export type SystemDevStatusLike = {
  state: "ready" | "unreachable" | "none"
  /** One sentence shown in the access panel. */
  message: string
  /** The proxy URL, displayed. */
  endpoint?: string
}

/** Structurally identical to `SystemServices` in `@crvouga/mockingbird-ui`. */
export type SystemServicesLike = {
  list(): Promise<{ dev: SystemDevStatusLike; services: readonly SystemServiceLike[] }>
  setMode(id: string, mode: SystemServiceModeLike): Promise<void>
  /**
   * Calls `listener` when a mode changes here or in another tab of this origin (a `storage`
   * event on the modes key, which this tab then applies to its own emulators).
   */
  subscribe?(listener: () => void): () => void
  /** Sends `GET <proxy>/<id>/` through the dev proxy and says whether the dev resource answered. */
  test?(id: string): Promise<{ ok: boolean; message?: string }>
}

/** What `controls()` returns: a `SystemServicesLike` with live updates and Test. */
export type DevControls = SystemServicesLike &
  Required<Pick<SystemServicesLike, "subscribe" | "test">>

export type DevUpstream = {
  baseUrl: string
  fetch: (request: Request) => Promise<Response>
  rewriteAuth: (request: Request) => Request
}

export type DevResources = {
  /** For createRuntime({ upstream }): baseUrl `${proxy}/${id}`, fetch goes to the proxy as-is, rewriteAuth drops authorization and cookies. */
  upstream(id: string): DevUpstream
  /** The SystemServices provider the UI harness takes. */
  controls(services: readonly DevServiceSpec[]): DevControls
}

export type DevStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">

export type DevResourcesOptions = {
  /** Absolute, or relative to location.origin (e.g. "/__dev"). Undefined = dev resources not offered. */
  proxyUrl?: string
  /** Per-viewer storage for the chosen modes. Default: localStorage, try/catch wrapped. */
  storage?: DevStorage
  fetch?: (request: Request) => Promise<Response>
}

/** Storage keys (per origin). */
export const DEV_STORAGE_KEYS = {
  modes: "mockingbird.dev.modes",
} as const

export const DEV_MESSAGES = {
  none: "No dev proxy is configured for this preview",
  ready: "Dev resources are available: switch a service to send its requests to its dev resource",
} as const

const unreachableMessage = (endpoint: string) => `The dev proxy at ${endpoint} did not answer`
const refusedMessage = (endpoint: string, reason: string) =>
  `The dev proxy at ${endpoint} refused the request: ${reason}`

/** Memory fallback for when browser storage is missing or blocked. */
const memoryStorage = (): DevStorage => {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  }
}

/** Wrap a storage so a throwing accessor (private mode, blocked site data) never breaks the page. */
const safeStorage = (storage: DevStorage | undefined): DevStorage => {
  const fallback = memoryStorage()
  const resolve = (): DevStorage => {
    if (storage) return storage
    try {
      const local = (globalThis as { localStorage?: DevStorage }).localStorage
      if (local) return local
    } catch {}
    return fallback
  }
  return {
    getItem: (key) => {
      try {
        return resolve().getItem(key)
      } catch {
        return fallback.getItem(key)
      }
    },
    setItem: (key, value) => {
      try {
        resolve().setItem(key, value)
      } catch {
        fallback.setItem(key, value)
      }
    },
    removeItem: (key) => {
      try {
        resolve().removeItem(key)
      } catch {}
      fallback.removeItem(key)
    },
  }
}

const resolveProxyUrl = (proxyUrl: string | undefined): string | undefined => {
  if (proxyUrl === undefined || proxyUrl.trim() === "") return undefined
  const origin = (globalThis as { location?: { origin?: string } }).location?.origin
  let url: URL
  try {
    url = origin ? new URL(proxyUrl, origin) : new URL(proxyUrl)
  } catch {
    throw new Error(
      `dev proxyUrl ${JSON.stringify(proxyUrl)} must be absolute outside a browser page`,
    )
  }
  url.search = ""
  url.hash = ""
  return withoutTrailingSlashes(url.toString())
}

/** Where emulators point when no proxy is configured: refused locally, never on the network. */
const NO_PROXY_BASE = "https://dev-proxy.invalid"

const errorMessage = async (response: Response, fallback: string) => {
  try {
    const body = (await response.json()) as { error?: unknown }
    const error = body.error
    if (typeof error === "string") return error
    if (error && typeof error === "object" && "message" in error)
      return String((error as { message: unknown }).message)
  } catch {}
  return fallback
}

/** Read an emulator's upstream mode. */
const readMode = async (spec: DevServiceSpec): Promise<DevMode> => {
  try {
    const response = await spec.admin(new Request("http://mockingbird.local/__admin/upstream"))
    if (!response.ok) return "emulated"
    const body = (await response.json()) as { mode?: unknown }
    return body.mode === "forward" ? "dev" : "emulated"
  } catch {
    return "emulated"
  }
}

const writeMode = (spec: DevServiceSpec, mode: DevMode) =>
  spec.admin(
    new Request("http://mockingbird.local/__admin/upstream", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: mode === "dev" ? "forward" : "emulated" }),
    }),
  )

export const createDevResources = (options: DevResourcesOptions = {}): DevResources => {
  const endpoint = resolveProxyUrl(options.proxyUrl)
  const storage = safeStorage(options.storage)
  const send = options.fetch ?? ((request: Request) => globalThis.fetch(request))

  const storedModes = (): Record<string, DevMode> => {
    try {
      const value = JSON.parse(storage.getItem(DEV_STORAGE_KEYS.modes) ?? "{}") as unknown
      if (!value || typeof value !== "object" || Array.isArray(value)) return {}
      return Object.fromEntries(
        Object.entries(value).filter(([, mode]) => mode === "dev"),
      ) as Record<string, DevMode>
    } catch {
      return {}
    }
  }
  const storeMode = (id: string, mode: DevMode) => {
    const modes = storedModes()
    if (mode === "dev") modes[id] = "dev"
    else delete modes[id]
    storage.setItem(DEV_STORAGE_KEYS.modes, JSON.stringify(modes))
  }

  /** The last call each service sent through the proxy from this tab. */
  const lastCalls = new Map<string, NonNullable<SystemServiceLike["lastCall"]>>()
  const upstream = (id: string): DevUpstream => ({
    baseUrl: `${endpoint ?? NO_PROXY_BASE}/${encodeURIComponent(id)}`,
    fetch: async (request) => {
      if (!endpoint)
        return Response.json(
          { error: { code: "dev_unavailable", message: DEV_MESSAGES.none } },
          { status: 503 },
        )
      try {
        const response = await send(request)
        lastCalls.set(id, {
          at: new Date().toISOString(),
          ok: response.ok,
          status: response.status,
        })
        return response
      } catch (error) {
        lastCalls.set(id, { at: new Date().toISOString(), ok: false })
        throw error
      }
    },
    rewriteAuth: (request) => {
      const out = new Request(request)
      out.headers.delete("authorization")
      out.headers.delete("cookie")
      return out
    },
  })

  type Manifest = { status: SystemDevStatusLike; manifest?: DevManifest }
  const readManifest = async (): Promise<Manifest> => {
    if (!endpoint) return { status: { state: "none", message: DEV_MESSAGES.none } }
    let manifest: DevManifest
    try {
      const response = await send(new Request(`${endpoint}/`))
      if (!response.ok) {
        const reason = await errorMessage(response, "")
        if (reason)
          return {
            status: { state: "unreachable", message: refusedMessage(endpoint, reason), endpoint },
          }
        throw new Error(`status ${response.status}`)
      }
      manifest = (await response.json()) as DevManifest
      if (!manifest || !Array.isArray(manifest.providers)) throw new Error("not a manifest")
    } catch {
      return {
        status: { state: "unreachable", message: unreachableMessage(endpoint), endpoint },
      }
    }
    return { status: { state: "ready", message: DEV_MESSAGES.ready, endpoint }, manifest }
  }

  /** Why `spec` cannot be switched to dev, in the documented precedence; undefined = it can. */
  const reason = (spec: DevServiceSpec, { status, manifest }: Manifest) => {
    if (spec.unsupported) return spec.unsupported
    if (status.state !== "ready") return status.message
    const provider = manifest?.providers.find((candidate) => candidate.id === spec.id)
    if (!provider) return `The dev proxy does not offer ${spec.label}`
    if (provider.missing.length > 0) return `Missing ${provider.missing.join(", ")} on the proxy`
    if (provider.blocked) return provider.blocked
    if (!provider.configured) return `${spec.label} is not configured on the dev proxy`
    return undefined
  }

  const controls = (services: readonly DevServiceSpec[]): DevControls => {
    const specs = new Map(services.map((spec) => [spec.id, spec]))
    let restored = false

    const find = (id: string) => {
      const spec = specs.get(id)
      if (!spec) throw new Error(`Unknown service ${id}`)
      return spec
    }

    const apply = async (spec: DevServiceSpec, mode: DevMode) => {
      const response = await writeMode(spec, mode)
      if (response.ok) return
      // An emulator without upstream support is already emulated; that is the goal.
      if (mode === "emulated" && (await readMode(spec)) === "emulated") return
      throw new Error(
        await errorMessage(
          response,
          `${spec.label} could not switch to ${mode} (status ${response.status})`,
        ),
      )
    }

    const listeners = new Set<() => void>()
    const emit = () => {
      for (const listener of [...listeners]) listener()
    }
    /** Another tab changed the stored modes: make this tab's emulators match, then tell the UI. */
    const follow = async () => {
      const stored = storedModes()
      const state = await readManifest()
      await Promise.all(
        services.map(async (spec) => {
          const wanted: DevMode = stored[spec.id] === "dev" ? "dev" : "emulated"
          if (wanted === "dev" && reason(spec, state) !== undefined) return
          if ((await readMode(spec)) === wanted) return
          await apply(spec, wanted).catch(() => {})
        }),
      )
      emit()
    }
    let detach: (() => void) | undefined
    const attach = () => {
      const target = globalThis as {
        addEventListener?: (
          type: string,
          listener: (event: { key?: string | null }) => void,
        ) => void
        removeEventListener?: (
          type: string,
          listener: (event: { key?: string | null }) => void,
        ) => void
      }
      if (!target.addEventListener) return undefined
      const onStorage = (event: { key?: string | null }) => {
        if (event.key === DEV_STORAGE_KEYS.modes || event.key === null) void follow()
      }
      target.addEventListener("storage", onStorage)
      return () => target.removeEventListener?.("storage", onStorage)
    }

    return {
      subscribe: (listener) => {
        listeners.add(listener)
        if (listeners.size === 1) detach = attach()
        return () => {
          listeners.delete(listener)
          if (listeners.size === 0) {
            detach?.()
            detach = undefined
          }
        }
      },
      test: async (id) => {
        const spec = find(id)
        const why = reason(spec, await readManifest())
        if (why !== undefined || !endpoint) return { ok: false, message: why ?? DEV_MESSAGES.none }
        let response: Response
        try {
          response = await send(new Request(`${endpoint}/${encodeURIComponent(id)}/`))
        } catch (error) {
          return {
            ok: false,
            message: `The dev proxy did not answer: ${error instanceof Error ? error.message : String(error)}`,
          }
        }
        const status = response.status
        if (status === 401 || status === 403 || status >= 500)
          return {
            ok: false,
            message: await errorMessage(response, `${spec.label} answered HTTP ${status}`),
          }
        return {
          ok: true,
          message: `${spec.label} answered through the dev proxy (HTTP ${status})`,
        }
      },
      list: async () => {
        const state = await readManifest()
        if (!restored) {
          restored = true
          const stored = storedModes()
          await Promise.all(
            services.map(async (spec) => {
              if (stored[spec.id] !== "dev" || reason(spec, state) !== undefined) return
              if ((await readMode(spec)) === "dev") return
              await apply(spec, "dev").catch(() => {})
            }),
          )
        }
        const rows = await Promise.all(
          services.map(async (spec): Promise<SystemServiceLike> => {
            const unavailable = reason(spec, state)
            const lastCall = lastCalls.get(spec.id)
            return {
              id: spec.id,
              label: spec.label,
              ...(spec.category !== undefined ? { category: spec.category } : {}),
              mode: await readMode(spec),
              ...(unavailable !== undefined ? { unavailable } : {}),
              ...(lastCall ? { lastCall: { ...lastCall } } : {}),
            }
          }),
        )
        return { dev: state.status, services: rows }
      },
      setMode: async (id, mode) => {
        const spec = find(id)
        if (mode === "dev") {
          const why = reason(spec, await readManifest())
          if (why !== undefined) throw new Error(why)
        } else if (mode !== "emulated") throw new Error(`Unknown mode ${String(mode)}`)
        await apply(spec, mode)
        storeMode(id, mode)
        emit()
      },
    }
  }

  return { upstream, controls }
}
