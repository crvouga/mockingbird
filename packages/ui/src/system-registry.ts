/// <reference lib="dom" />
/**
 * The app registry: each app of a system preview declared once, and everything else (the
 * switcher, the System screen, routes, the build's part list, lazy loading, per-app updates)
 * derived from it.
 */
import type { SystemIcon } from "./system-icons.js"
import { matchRoute, normalizeRoute, routeConflicts } from "./system-routes.js"

/** How an app's document is hosted: in the shell's own document, or an isolated `<iframe>`. */
export type PreviewAppMountKind = "inline" | "iframe"

/** What an inline part's module exports. */
export type PreviewAppModule = {
  mount(host: HTMLElement, context: PreviewAppContext): Promise<() => void> | (() => void)
}

/** What an inline app's `mount` receives besides its host element. */
export type PreviewAppContext = {
  app: string
  /** The route the app owns, when it declares one. */
  route?: string | undefined
  /** The content pin of the code being mounted (from the parts manifest), when known. */
  version?: string | undefined
  signal: AbortSignal
}

/** A cheap probe the System screen shows on the app's row. */
export type PreviewAppHealth = { ok: boolean; message?: string }

/** How an app's code is built and where it is loaded from. */
export type PreviewAppPart = {
  /** Build: the module the build bundles into this app's part (see `buildPreviewParts`). */
  source?: string
  /**
   * Load: the built entry URL, relative to the page. Inline: an ES module exporting `mount`;
   * iframe: an HTML document. The parts manifest's entry for this app wins over it.
   */
  entry?: string
  /** Load: code the shell's own bundle imports on first open (`() => import("./app.js")`). Inline only. */
  load?: () => Promise<PreviewAppModule>
  /** Load this part at idle priority once the first app is open. */
  prefetch?: boolean
}

/** One app in a system preview. */
export type PreviewApp = {
  id: string
  label: string
  icon?: SystemIcon
  /** One line on the app's row on the System screen. */
  description?: string
  /** `false` keeps the app out of the switcher until someone switches it on. Default true. */
  defaultEnabled?: boolean
  /** The path prefix the app owns ("/", "/clinician"). Deep links open it at that path. */
  route?: string
  part: PreviewAppPart
  /** The in-tab backends and emulators it calls: booted when it opens, listed on the System screen. */
  backends?: readonly string[]
  /** Default "inline". */
  mount?: PreviewAppMountKind
  health?: (signal: AbortSignal) => Promise<PreviewAppHealth> | PreviewAppHealth
}

/** A backend or emulator the apps can name in `backends`. */
export type PreviewBackendDeclaration = {
  id: string
  label?: string
  kind?: "backend" | "emulator"
}

/**
 * The parts manifest the build writes (`parts.json`). Structurally identical to
 * `PreviewPartsManifest` in `@crvouga/mockingbird-preview`.
 */
export type PreviewPartsManifestLike = {
  version: 1
  /** Content pin of the shared runtime (the shell, the worker host, the bridge). */
  runtime: string
  parts: Record<
    string,
    {
      entry: string
      pin: string
      bytes: number
      backends?: readonly string[]
      prefetch?: boolean
    }
  >
  backends?: Record<string, { entry: string; pin: string; bytes: number }>
}

export type PreviewRegistryErrorCode =
  | "invalid_app"
  | "duplicate_app"
  | "reserved_app"
  | "invalid_route"
  | "route_conflict"
  | "unknown_backend"
  | "invalid_part"

/** A registry that cannot be used; thrown by `defineSystem`, so the build fails on it. */
export class PreviewRegistryError extends Error {
  readonly code: PreviewRegistryErrorCode
  constructor(code: PreviewRegistryErrorCode, message: string) {
    super(message)
    this.name = "PreviewRegistryError"
    this.code = code
  }
}

export type PreviewSystemDefinition = {
  /** In switcher order. */
  apps: readonly PreviewApp[]
  /**
   * The backends and emulators apps may name. When given, naming any other id is an error; when
   * left out, every named id is declared implicitly as a backend.
   */
  backends?: readonly PreviewBackendDeclaration[]
}

/** One entry of the build's part list. */
export type PreviewSystemPart = {
  id: string
  mount: PreviewAppMountKind
  source?: string
  entry?: string
  route?: string
  backends: string[]
  prefetch: boolean
}

/** A validated registry and everything derived from it. */
export type PreviewSystem = {
  readonly apps: readonly PreviewApp[]
  readonly backends: readonly Required<PreviewBackendDeclaration>[]
  app(id: string): PreviewApp | undefined
  /** The app whose route owns `pathname` (the longest route wins). */
  route(pathname: string): PreviewApp | undefined
  /** The build's part list, in registry order. */
  parts(): PreviewSystemPart[]
  /** Each backend and emulator, with the ids of the apps that call it. */
  dependents(): (Required<PreviewBackendDeclaration> & { apps: string[] })[]
}

const ID = /^[A-Za-z0-9][\w.-]*$/

/**
 * Validates a registry: unique app ids (never "system"), well-formed and distinct routes, known
 * backends and a loadable part per app. Throws `PreviewRegistryError`, so a build script that
 * imports the registry fails with the reason.
 */
export function defineSystem(definition: PreviewSystemDefinition): PreviewSystem {
  const seen = new Set<string>()
  const declared = new Map<string, Required<PreviewBackendDeclaration>>()
  for (const backend of definition.backends ?? []) {
    if (!ID.test(backend.id ?? "") || declared.has(backend.id))
      throw new PreviewRegistryError(
        "invalid_app",
        `Backend ids must be unique and non-empty: ${JSON.stringify(backend.id)}`,
      )
    declared.set(backend.id, {
      id: backend.id,
      label: backend.label ?? backend.id,
      kind: backend.kind ?? "backend",
    })
  }
  const apps: PreviewApp[] = []
  for (const app of definition.apps) {
    if (!app || !ID.test(app.id ?? "") || !app.label)
      throw new PreviewRegistryError(
        "invalid_app",
        `Every app needs an id (letters, digits, ".", "_", "-") and a label: ${JSON.stringify(app?.id)}`,
      )
    if (app.id === "system")
      throw new PreviewRegistryError("reserved_app", `"system" is the System screen's own id`)
    if (seen.has(app.id))
      throw new PreviewRegistryError("duplicate_app", `Two apps are declared as "${app.id}"`)
    seen.add(app.id)
    const kind = app.mount ?? "inline"
    if (kind !== "inline" && kind !== "iframe")
      throw new PreviewRegistryError("invalid_app", `App "${app.id}" has mount ${String(kind)}`)
    const part = app.part
    if (!part || (part.entry === undefined && part.source === undefined && !part.load))
      throw new PreviewRegistryError(
        "invalid_part",
        `App "${app.id}" needs a part: a source to build, an entry to load or a load()`,
      )
    if (kind === "iframe" && part.load)
      throw new PreviewRegistryError(
        "invalid_part",
        `App "${app.id}" is an iframe app: its part needs an entry document, not load()`,
      )
    let route: string | undefined
    if (app.route !== undefined) {
      try {
        route = normalizeRoute(app.route)
      } catch (error) {
        throw new PreviewRegistryError(
          "invalid_route",
          `App "${app.id}": ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    for (const backend of app.backends ?? []) {
      if (declared.has(backend)) continue
      if (definition.backends)
        throw new PreviewRegistryError(
          "unknown_backend",
          `App "${app.id}" calls "${backend}", which the registry does not declare`,
        )
      declared.set(backend, { id: backend, label: backend, kind: "backend" })
    }
    apps.push({ ...app, ...(route === undefined ? {} : { route }), mount: kind })
  }
  const conflict = routeConflicts(apps)[0]
  if (conflict)
    throw new PreviewRegistryError(
      "route_conflict",
      `Apps "${conflict.ids[0]}" and "${conflict.ids[1]}" both declare the route "${conflict.route}"`,
    )
  const backends = [...declared.values()]
  return {
    apps,
    backends,
    app: (id) => apps.find((app) => app.id === id),
    route(pathname) {
      const id = matchRoute(apps, pathname)
      return id === undefined ? undefined : apps.find((app) => app.id === id)
    },
    parts: () =>
      apps.map((app) => ({
        id: app.id,
        mount: app.mount ?? "inline",
        ...(app.part.source === undefined ? {} : { source: app.part.source }),
        ...(app.part.entry === undefined ? {} : { entry: app.part.entry }),
        ...(app.route === undefined ? {} : { route: app.route }),
        backends: [...(app.backends ?? [])],
        prefetch: app.part.prefetch === true,
      })),
    dependents: () =>
      backends.map((backend) => ({
        ...backend,
        apps: apps.filter((app) => app.backends?.includes(backend.id)).map((app) => app.id),
      })),
  }
}

/** What applying a newer parts manifest to an open tab takes. */
export type PreviewPartUpdatePlan =
  | { kind: "none" }
  | { kind: "parts"; apps: string[]; backends: string[] }
  | { kind: "reload"; reason: string }

const sameKeys = (a: Record<string, unknown> = {}, b: Record<string, unknown> = {}) => {
  const left = Object.keys(a).sort()
  const right = Object.keys(b).sort()
  return left.length === right.length && left.every((key, index) => key === right[index])
}

/**
 * Compares two parts manifests. Only the apps and backends whose pin changed are swapped; a
 * change to the shared runtime, or apps or backends added or removed, needs a full reload.
 */
export function planPartUpdate(
  current: PreviewPartsManifestLike,
  next: PreviewPartsManifestLike,
): PreviewPartUpdatePlan {
  if (current.runtime !== next.runtime)
    return {
      kind: "reload",
      reason: "The shared runtime (the shell, worker host or bridge) changed in this build.",
    }
  if (!sameKeys(current.parts, next.parts))
    return { kind: "reload", reason: "This build adds or removes apps." }
  if (!sameKeys(current.backends, next.backends))
    return { kind: "reload", reason: "This build adds or removes backends." }
  const apps = Object.keys(next.parts).filter(
    (id) => current.parts[id]?.pin !== next.parts[id]?.pin,
  )
  const backends = Object.keys(next.backends ?? {}).filter(
    (id) => current.backends?.[id]?.pin !== next.backends?.[id]?.pin,
  )
  return apps.length === 0 && backends.length === 0
    ? { kind: "none" }
    : { kind: "parts", apps, backends }
}

/** What the shell needs at run time to turn a registry into surfaces. */
export type PreviewSystemRuntime = {
  /** The parts manifest (`parts.json`); its entries and pins win over the registry's. */
  manifest?: PreviewPartsManifestLike | (() => PreviewPartsManifestLike | undefined)
  /** Where relative entries resolve. Default the document's URL. */
  baseUrl?: string
  /** Imports an inline part's entry. Default dynamic `import()`. */
  importModule?: (url: string) => Promise<unknown>
  /** Boots the backends an app calls before it mounts (see `createBackendHost().ensure`). */
  ensureBackends?: (ids: readonly string[], signal: AbortSignal) => Promise<void> | void
  /**
   * Serves one iframe app's requests: hands the shell's end of a `MessageChannel` to the same
   * Fetch bridge inline apps use (`previewHost.connect` or `servePreviewPort`). Returns a disposer.
   */
  bridge?: (port: MessagePort, app: string) => (() => void) | undefined
}

/** One surface the registry derives, with the registry's fields the harness and System use. */
export type PreviewSystemSurface = {
  id: string
  label: string
  description?: string
  icon?: SystemIcon
  defaultEnabled?: boolean
  route?: string
  backends?: readonly string[]
  version?: string
  health?: (signal: AbortSignal) => Promise<PreviewAppHealth> | PreviewAppHealth
  mount(host: HTMLElement, signal: AbortSignal): Promise<() => void>
}

/** The part loader behind the surfaces: one fetch per pin, failures retried on the next open. */
export type PreviewPartLoader = {
  /** Loads (or reuses) an inline app's module. */
  load(id: string): Promise<PreviewAppModule>
  /** Loads every `prefetch` part not loaded yet; errors are left for the app's own open. */
  prefetch(): Promise<void>
  /** `id@pin` of every part loaded so far, in load order. */
  loaded(): string[]
}

/** The registry's apps as harness surfaces, plus the part loader they share. */
export function systemSurfaces(
  system: PreviewSystem,
  runtime: PreviewSystemRuntime = {},
): { surfaces: PreviewSystemSurface[]; loader: PreviewPartLoader } {
  const manifest = () =>
    typeof runtime.manifest === "function" ? runtime.manifest() : runtime.manifest
  const base = () => runtime.baseUrl ?? globalThis.location?.href ?? "http://localhost/"
  const importModule = runtime.importModule ?? ((url: string) => import(/* @vite-ignore */ url))
  const cache = new Map<string, Promise<PreviewAppModule>>()
  const order: string[] = []
  const resolvePart = (app: PreviewApp) => {
    const fromManifest = manifest()?.parts[app.id]
    return {
      entry: fromManifest?.entry ?? app.part.entry,
      pin: fromManifest?.pin,
      prefetch: fromManifest?.prefetch ?? app.part.prefetch === true,
    }
  }
  const load = (id: string): Promise<PreviewAppModule> => {
    const app = system.app(id)
    if (!app) return Promise.reject(new Error(`No app "${id}" in the registry`))
    const { entry, pin } = resolvePart(app)
    const key = `${id}@${pin ?? entry ?? "bundled"}`
    const cached = cache.get(key)
    if (cached) return cached
    const pending = (async () => {
      const module = (
        entry !== undefined
          ? await importModule(new URL(entry, base()).href)
          : await (app.part.load as () => Promise<PreviewAppModule>)()
      ) as Partial<PreviewAppModule> | undefined
      if (typeof module?.mount !== "function")
        throw new Error(`The part for "${id}" exports no mount()`)
      order.push(key)
      return module as PreviewAppModule
    })()
    cache.set(key, pending)
    // A failed part is fetched again on the next open, not cached as failed.
    pending.catch(() => {
      if (cache.get(key) === pending) cache.delete(key)
    })
    return pending
  }
  const surfaces = system.apps.map((app): PreviewSystemSurface => {
    const surface: PreviewSystemSurface = {
      id: app.id,
      label: app.label,
      ...(app.description === undefined ? {} : { description: app.description }),
      ...(app.icon === undefined ? {} : { icon: app.icon }),
      ...(app.defaultEnabled === undefined ? {} : { defaultEnabled: app.defaultEnabled }),
      ...(app.route === undefined ? {} : { route: app.route }),
      ...(app.backends === undefined ? {} : { backends: app.backends }),
      ...(app.health === undefined ? {} : { health: app.health }),
      async mount(host, signal) {
        if (app.backends?.length) await runtime.ensureBackends?.(app.backends, signal)
        signal.throwIfAborted()
        const { entry, pin } = resolvePart(app)
        if (app.mount === "iframe") {
          if (entry === undefined) throw new Error(`App "${app.id}" has no entry document`)
          return mountFrame(host, app, new URL(entry, base()).href, runtime)
        }
        const module = await load(app.id)
        signal.throwIfAborted()
        return module.mount(host, { app: app.id, route: app.route, version: pin, signal })
      },
    }
    Object.defineProperty(surface, "version", {
      enumerable: true,
      get: () => resolvePart(app).pin,
    })
    return surface
  })
  return {
    surfaces,
    loader: {
      load,
      async prefetch() {
        for (const app of system.apps) {
          if (app.mount === "iframe" || !resolvePart(app).prefetch) continue
          await load(app.id).catch(() => {})
        }
      },
      loaded: () => [...order],
    },
  }
}

/** The message an iframe app receives with its end of the bridge (see `acceptPreviewFrame`). */
export const PREVIEW_FRAME_CONNECT = "mockingbird-preview-connect"

/**
 * An iframe app: its own document and globals. Each time the frame loads, it gets a fresh
 * `MessagePort` to the shell's Fetch bridge, so it reaches the same backends as inline apps.
 */
function mountFrame(
  host: HTMLElement,
  app: PreviewApp,
  src: string,
  runtime: PreviewSystemRuntime,
): Promise<() => void> {
  const doc = host.ownerDocument
  const frame = doc.createElement("iframe")
  frame.title = app.label
  frame.dataset.app = app.id
  frame.style.cssText = "display:block;width:100%;height:100%;border:0"
  let stopBridge: (() => void) | undefined
  const connect = () => {
    stopBridge?.()
    stopBridge = undefined
    const target = frame.contentWindow
    if (!target) return
    const channel = new MessageChannel()
    stopBridge = runtime.bridge?.(channel.port1, app.id) ?? undefined
    const path = doc.defaultView?.location.pathname
    target.postMessage(
      { type: PREVIEW_FRAME_CONNECT, app: app.id, bridge: runtime.bridge !== undefined, path },
      new URL(src).origin === "null" ? "*" : new URL(src).origin,
      [channel.port2],
    )
  }
  return new Promise((resolve, reject) => {
    let first = true
    frame.addEventListener("load", () => {
      connect()
      if (first) {
        first = false
        resolve(() => {
          stopBridge?.()
          frame.remove()
        })
      }
    })
    frame.addEventListener("error", () => {
      if (first) reject(new Error(`Unable to load ${app.label}'s document`))
    })
    frame.src = src
    host.append(frame)
  })
}
