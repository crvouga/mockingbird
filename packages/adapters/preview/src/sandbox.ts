/**
 * Browser side of sandbox mode: wires an emulator runtime's `upstream` to the sandbox proxy and
 * gives the System screen its per-service Emulated / Sandbox switches.
 *
 * Portable: Fetch API only; `localStorage` is used when present and never required.
 */
import { SANDBOX_KEY_HEADER, type SandboxManifest } from "./sandbox-proxy.js"

/** `value` without trailing slashes, in linear time (a `/\/+$/` regex backtracks on long runs). */
const withoutTrailingSlashes = (value: string): string => {
  let end = value.length
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--
  return value.slice(0, end)
}

export type SandboxMode = "emulated" | "sandbox"

export type SandboxServiceSpec = {
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
export type SystemServiceModeLike = "emulated" | "sandbox"

/** Structurally identical to `SystemService` in `@crvouga/mockingbird-ui`. */
export type SystemServiceLike = {
  id: string
  label: string
  category?: string
  mode: SystemServiceModeLike
  /** Why sandbox cannot be chosen; undefined when it can. */
  unavailable?: string
}

/** Structurally identical to `SystemSandboxStatus` in `@crvouga/mockingbird-ui`. */
export type SystemSandboxStatusLike = {
  state: "ready" | "locked" | "off" | "unreachable" | "none"
  /** One sentence shown in the access panel. */
  message: string
  /** The proxy URL, displayed. */
  endpoint?: string
}

/** Structurally identical to `SystemServices` in `@crvouga/mockingbird-ui`. */
export type SystemServicesLike = {
  list(): Promise<{ sandbox: SystemSandboxStatusLike; services: readonly SystemServiceLike[] }>
  setMode(id: string, mode: SystemServiceModeLike): Promise<void>
  setAccessKey(key: string | null): Promise<void>
  hasAccessKey(): boolean
}

export type SandboxUpstream = {
  baseUrl: string
  fetch: (request: Request) => Promise<Response>
  rewriteAuth: (request: Request) => Request
}

export type Sandbox = {
  /** For createRuntime({ upstream }): baseUrl `${proxy}/${id}`, fetch adds SANDBOX_KEY_HEADER, rewriteAuth drops authorization. */
  upstream(id: string): SandboxUpstream
  /** The SystemServices provider the UI harness takes. */
  controls(services: readonly SandboxServiceSpec[]): SystemServicesLike
}

export type SandboxStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">

export type SandboxOptions = {
  /** Absolute, or relative to location.origin (e.g. "/__sandbox"). Undefined = sandbox not offered. */
  proxyUrl?: string
  /** Per-viewer storage for the access key and chosen modes. Default: localStorage, try/catch wrapped. */
  storage?: SandboxStorage
  fetch?: (request: Request) => Promise<Response>
}

/** Storage keys (per origin). */
export const SANDBOX_STORAGE_KEYS = {
  accessKey: "mockingbird.sandbox.access-key",
  modes: "mockingbird.sandbox.modes",
} as const

export const SANDBOX_MESSAGES = {
  none: "No sandbox proxy is configured for this preview",
  off: "The proxy has no SANDBOX_PROXY_TOKEN, so sandbox mode is off",
  locked: "Enter the sandbox access key",
  ready: "Sandbox access is granted: switch a service to send its requests to the vendor's sandbox",
} as const

const unreachableMessage = (endpoint: string) => `The sandbox proxy at ${endpoint} did not answer`

/** Memory fallback for when browser storage is missing or blocked. */
const memoryStorage = (): SandboxStorage => {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  }
}

/** Wrap a storage so a throwing accessor (private mode, blocked site data) never breaks the page. */
const safeStorage = (storage: SandboxStorage | undefined): SandboxStorage => {
  const fallback = memoryStorage()
  const resolve = (): SandboxStorage => {
    if (storage) return storage
    try {
      const local = (globalThis as { localStorage?: SandboxStorage }).localStorage
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
      `sandbox proxyUrl ${JSON.stringify(proxyUrl)} must be absolute outside a browser page`,
    )
  }
  url.search = ""
  url.hash = ""
  return withoutTrailingSlashes(url.toString())
}

/** Where emulators point when no proxy is configured: refused locally, never on the network. */
const NO_PROXY_BASE = "https://sandbox-proxy.invalid"

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
const readMode = async (spec: SandboxServiceSpec): Promise<SandboxMode> => {
  try {
    const response = await spec.admin(new Request("http://mockingbird.local/__admin/upstream"))
    if (!response.ok) return "emulated"
    const body = (await response.json()) as { mode?: unknown }
    return body.mode === "forward" ? "sandbox" : "emulated"
  } catch {
    return "emulated"
  }
}

const writeMode = (spec: SandboxServiceSpec, mode: SandboxMode) =>
  spec.admin(
    new Request("http://mockingbird.local/__admin/upstream", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: mode === "sandbox" ? "forward" : "emulated" }),
    }),
  )

export const createSandbox = (options: SandboxOptions = {}): Sandbox => {
  const endpoint = resolveProxyUrl(options.proxyUrl)
  const storage = safeStorage(options.storage)
  const send = options.fetch ?? ((request: Request) => globalThis.fetch(request))

  const accessKey = () => storage.getItem(SANDBOX_STORAGE_KEYS.accessKey) || null
  const storedModes = (): Record<string, SandboxMode> => {
    try {
      const value = JSON.parse(storage.getItem(SANDBOX_STORAGE_KEYS.modes) ?? "{}") as unknown
      if (!value || typeof value !== "object" || Array.isArray(value)) return {}
      return Object.fromEntries(
        Object.entries(value).filter(([, mode]) => mode === "sandbox"),
      ) as Record<string, SandboxMode>
    } catch {
      return {}
    }
  }
  const storeMode = (id: string, mode: SandboxMode) => {
    const modes = storedModes()
    if (mode === "sandbox") modes[id] = "sandbox"
    else delete modes[id]
    storage.setItem(SANDBOX_STORAGE_KEYS.modes, JSON.stringify(modes))
  }

  const withKey = (request: Request): Request => {
    const out = new Request(request)
    const key = accessKey()
    if (key) out.headers.set(SANDBOX_KEY_HEADER, key)
    else out.headers.delete(SANDBOX_KEY_HEADER)
    return out
  }

  const upstream = (id: string): SandboxUpstream => ({
    baseUrl: `${endpoint ?? NO_PROXY_BASE}/${encodeURIComponent(id)}`,
    fetch: async (request) => {
      if (!endpoint)
        return Response.json(
          { error: { code: "sandbox_unavailable", message: SANDBOX_MESSAGES.none } },
          { status: 503 },
        )
      return send(withKey(request))
    },
    rewriteAuth: (request) => {
      const out = new Request(request)
      out.headers.delete("authorization")
      out.headers.delete("cookie")
      return out
    },
  })

  type Manifest = { status: SystemSandboxStatusLike; manifest?: SandboxManifest }
  const readManifest = async (): Promise<Manifest> => {
    if (!endpoint) return { status: { state: "none", message: SANDBOX_MESSAGES.none } }
    let manifest: SandboxManifest
    try {
      const response = await send(withKey(new Request(`${endpoint}/`)))
      if (!response.ok) throw new Error(`status ${response.status}`)
      manifest = (await response.json()) as SandboxManifest
      if (!manifest || !Array.isArray(manifest.providers)) throw new Error("not a manifest")
    } catch {
      return {
        status: { state: "unreachable", message: unreachableMessage(endpoint), endpoint },
      }
    }
    const status: SystemSandboxStatusLike =
      manifest.access === "granted"
        ? { state: "ready", message: SANDBOX_MESSAGES.ready, endpoint }
        : manifest.access === "denied"
          ? { state: "locked", message: SANDBOX_MESSAGES.locked, endpoint }
          : { state: "off", message: SANDBOX_MESSAGES.off, endpoint }
    return { status, manifest }
  }

  /** Why `spec` cannot be switched to sandbox, in the documented precedence; undefined = it can. */
  const reason = (spec: SandboxServiceSpec, { status, manifest }: Manifest) => {
    if (spec.unsupported) return spec.unsupported
    if (status.state !== "ready") return status.message
    const provider = manifest?.providers.find((candidate) => candidate.id === spec.id)
    if (!provider) return `The sandbox proxy does not offer ${spec.label}`
    if (provider.missing.length > 0) return `Missing ${provider.missing.join(", ")} on the proxy`
    if (provider.error) return provider.error
    if (!provider.configured) return `${spec.label} is not configured on the sandbox proxy`
    return undefined
  }

  const controls = (services: readonly SandboxServiceSpec[]): SystemServicesLike => {
    const specs = new Map(services.map((spec) => [spec.id, spec]))
    let restored = false

    const find = (id: string) => {
      const spec = specs.get(id)
      if (!spec) throw new Error(`Unknown service ${id}`)
      return spec
    }

    const apply = async (spec: SandboxServiceSpec, mode: SandboxMode) => {
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

    return {
      list: async () => {
        const state = await readManifest()
        if (!restored) {
          restored = true
          const stored = storedModes()
          await Promise.all(
            services.map(async (spec) => {
              if (stored[spec.id] !== "sandbox" || reason(spec, state) !== undefined) return
              if ((await readMode(spec)) === "sandbox") return
              await apply(spec, "sandbox").catch(() => {})
            }),
          )
        }
        const rows = await Promise.all(
          services.map(async (spec): Promise<SystemServiceLike> => {
            const unavailable = reason(spec, state)
            return {
              id: spec.id,
              label: spec.label,
              ...(spec.category !== undefined ? { category: spec.category } : {}),
              mode: await readMode(spec),
              ...(unavailable !== undefined ? { unavailable } : {}),
            }
          }),
        )
        return { sandbox: state.status, services: rows }
      },
      setMode: async (id, mode) => {
        const spec = find(id)
        if (mode === "sandbox") {
          const why = reason(spec, await readManifest())
          if (why !== undefined) throw new Error(why)
        } else if (mode !== "emulated") throw new Error(`Unknown mode ${String(mode)}`)
        await apply(spec, mode)
        storeMode(id, mode)
      },
      setAccessKey: async (key) => {
        const value = key?.trim()
        if (value) storage.setItem(SANDBOX_STORAGE_KEYS.accessKey, value)
        else storage.removeItem(SANDBOX_STORAGE_KEYS.accessKey)
      },
      hasAccessKey: () => accessKey() !== null,
    }
  }

  return { upstream, controls }
}
