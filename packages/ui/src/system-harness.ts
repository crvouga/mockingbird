/// <reference lib="dom" />

import type { SystemBuild } from "./system-build-status.js"
import { SYSTEM_ICONS, type SystemIcon } from "./system-icons.js"
import {
  type PreviewLoadManifestLike,
  type PreviewPartLoader,
  type PreviewSystem,
  type PreviewSystemRuntime,
  planPartUpdate,
  systemSurfaces,
} from "./system-registry.js"
import {
  initialExcluded,
  readOrder,
  reconcileOrder,
  setRotation,
  writeOrder,
} from "./system-rotation.js"
import { matchRoute } from "./system-routes.js"
import {
  DEFAULT_SYSTEM_SHORTCUT,
  parseShortcut,
  SYSTEM_SECTION_PARAM,
  validateSections,
} from "./system-shortcut.js"
import type {
  HarnessController,
  HarnessSnapshot,
  PanelStatus,
  SystemBackends,
  SystemHealth,
  SystemNotice,
  SystemSection,
  SystemServices,
  SystemSnapshot,
} from "./system-types.js"

export type { SystemBuild, SystemBuildState } from "./system-build-status.js"
export {
  defineSystem,
  PREVIEW_FRAME_CONNECT,
  type PreviewApp,
  type PreviewAppContext,
  type PreviewAppHealth,
  type PreviewAppModule,
  type PreviewAppMountKind,
  type PreviewAppPart,
  type PreviewBackendDeclaration,
  type PreviewLoadManifestLike,
  type PreviewPartLoader,
  type PreviewPartUpdatePlan,
  PreviewRegistryError,
  type PreviewRegistryErrorCode,
  type PreviewSystem,
  type PreviewSystemDefinition,
  type PreviewSystemPart,
  type PreviewSystemRuntime,
  type PreviewSystemSurface,
  planPartUpdate,
  systemSurfaces,
} from "./system-registry.js"
export { INCLUDED_KEY, ORDER_KEY, ROTATION_KEY } from "./system-rotation.js"
export {
  DEFAULT_SYSTEM_SHORTCUT,
  SYSTEM_SECTION_IDS,
  SYSTEM_SECTION_PARAM,
} from "./system-shortcut.js"
export type {
  SystemBackend,
  SystemBackendState,
  SystemBackends,
  SystemDevStatus,
  SystemHealth,
  SystemNotice,
  SystemSection,
  SystemService,
  SystemServiceCall,
  SystemServiceMode,
  SystemServices,
  SystemServiceTest,
  SystemSnapshot,
} from "./system-types.js"

/** Product code supplies lazy surfaces; the shell knows nothing about their services. */
export type SystemSurface = {
  id: string
  label: string
  /** One line shown on the surface's row on the System screen. */
  description?: string
  /** Shown on its row and in the switcher's tooltips; see `SystemIcon`. Defaults to its first letter. */
  icon?: SystemIcon
  mount(host: HTMLElement, signal: AbortSignal): Promise<() => void> | (() => void)
  /** `false` keeps it out of the switcher until switched on (kept under `INCLUDED_KEY`). Default true. */
  defaultEnabled?: boolean
  /**
   * The path prefix it owns ("/", "/clinician"). With `syncUrl`, a deep link into it opens it, and
   * switching away and back restores its last path. Routes must be distinct.
   */
  route?: string
  /** The backends and emulators it calls, listed on the System screen. */
  backends?: readonly string[]
  /** The version of its code (a part pin); `update()` swaps it. */
  version?: string
  /** A cheap probe the System screen shows on its row. */
  health?: (signal: AbortSignal) => Promise<SystemHealth> | SystemHealth
}
export type SystemHarnessOptions = {
  /** The surface shown first (default "system"); with `syncUrl`, the URL's `?surface=` wins. */
  initial?: string
  /** Keep `?surface=` (or a surface's `route`) in the address bar and follow back/forward. */
  syncUrl?: boolean
  /** The services the System screen lists and switches between emulated and a real non-production resource. */
  services?: SystemServices
  /** Where the System screen's "How dev resources work" link points. */
  docsUrl?: string
  /**
   * A live preview's build status (such as `createLivePreview()` from `@crvouga/mockingbird-preview`):
   * adds a status dot to the switcher, an update toast beside it, and a Preview card to System.
   */
  build?: SystemBuild
  /** The in-tab backends and emulators and their state, for the System screen's Backends list. */
  backends?: SystemBackends
  /**
   * The consumer's own System sections (feature flags, start-up timings), after the built-in
   * ones and each deep-linkable as `?system=<id>` with `syncUrl`, instead of another surface.
   */
  sections?: readonly SystemSection[]
  /** Save, load and reset of the whole in-tab state: adds a Data card to System. */
  snapshot?: SystemSnapshot
  /**
   * The keyboard shortcut that opens System from anywhere (default `DEFAULT_SYSTEM_SHORTCUT`,
   * "Alt+Shift+S"); `false` turns it off. A long-press or right-click on the pill opens it too.
   */
  systemShortcut?: string | false
}
export type SystemHarness = {
  show(id: string): Promise<void>
  active(): string
  /**
   * Swaps one surface's code in place: a mounted surface is disposed and mounted again with
   * `next.mount` (or its own `mount`, which may now load newer code); every other surface keeps
   * its DOM and state. A surface not opened yet takes `next` on its first open. Resolves when
   * the remount settles; a failed remount shows Retry in that surface only.
   */
  update(id: string, next?: Partial<Pick<SystemSurface, "mount" | "version">>): Promise<void>
  /** Shows a notice over the apps until dismissed or replaced; `undefined` clears it. */
  notify(notice: SystemNotice | undefined): void
  destroy(): void
}

const SYSTEM_APP: Required<
  Omit<SystemSurface, "mount" | "defaultEnabled" | "route" | "backends" | "version" | "health">
> = {
  id: "system",
  label: "System",
  description: "This screen: the apps, the switcher and the services behind them.",
  icon: SYSTEM_ICONS.system,
}

/**
 * One visible surface, with mounted surfaces retained while hidden. Resolving mount means ready;
 * rejecting means failed. Abort and late disposal make teardown safe during asynchronous loading.
 * The reserved System surface is always reachable. URL state is opt-in for embedded hosts.
 *
 * The surfaces draw into panels (`section[data-surface]`) inside `host`, styled by the host
 * page. The harness's own UI (the switcher pill, its tooltip and update toast, the notice over
 * the apps, each panel's loading and error state, and the System screen) is React and HeroUI
 * with Mockingbird's stylesheet scoped to it, so it restyles nothing else on the page. The view
 * loads lazily (`system-view.tsx`), so importing this module costs no React.
 *
 * The switcher pill docks to the middle of the left edge until dragged; the edge and the
 * position along it are kept in localStorage, so it returns there after a reload or resize.
 * The System screen's "In switcher" toggles choose which surfaces the arrows cycle through, and
 * dragging its rows sets the order they go in (kept in localStorage under ROTATION_KEY,
 * INCLUDED_KEY and ORDER_KEY); `show(id)`, the URL and each row's Open still reach every surface.
 */
export function mountSystemHarness(
  host: HTMLElement,
  surfaces: readonly SystemSurface[],
  options: SystemHarnessOptions = {},
): SystemHarness {
  const ids = new Set(["system"])
  const routes = new Map<string, string>()
  for (const surface of surfaces) {
    if (!surface.id || ids.has(surface.id))
      throw new Error(`Duplicate or reserved surface: ${surface.id}`)
    ids.add(surface.id)
    if (surface.route !== undefined) {
      const owner = routes.get(surface.route)
      if (owner !== undefined)
        throw new Error(`Surfaces ${owner} and ${surface.id} both own the route ${surface.route}`)
      routes.set(surface.route, surface.id)
    }
  }
  validateSections(options.sections ?? [])
  const systemShortcut = options.systemShortcut ?? DEFAULT_SYSTEM_SHORTCUT
  // A shortcut that cannot be parsed fails here, not on the first key press.
  if (systemShortcut !== false) parseShortcut(systemShortcut)
  const defaultOff = surfaces.filter((s) => s.defaultEnabled === false).map((s) => s.id)
  const doc = host.ownerDocument
  const win = doc.defaultView ?? window
  // Light DOM, styled inline: nothing here adds a stylesheet to the host page.
  const shell = doc.createElement("div")
  shell.className = "msh"
  shell.dataset.testid = "system-harness"
  shell.style.cssText =
    "position:relative;height:100%;min-height:240px;isolation:isolate;background:Canvas;color:CanvasText"
  const chrome = doc.createElement("div")
  chrome.className = "msh-chrome"
  chrome.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:1000"
  shell.append(chrome)
  host.append(shell)

  let destroyed = false
  const storage = () => win.localStorage
  const rotation = initialExcluded(storage, defaultOff)
  const listeners = new Set<() => void>()
  let snapshot: HarnessSnapshot = {
    current: "",
    order: readOrder(storage, ["system", ...surfaces.map((surface) => surface.id)]),
    excluded: new Set(rotation.excluded),
    statuses: [],
    versions: {},
  }
  const patch = (next: Partial<HarnessSnapshot>) => {
    snapshot = { ...snapshot, ...next }
    for (const listener of listeners) listener()
  }
  const setStatus = (id: string, status?: PanelStatus) =>
    patch({
      statuses: [
        ...snapshot.statuses.filter((candidate) => candidate.id !== id),
        ...(status ? [status] : []),
      ],
    })

  type Entry = {
    spec: SystemSurface
    panel: HTMLElement
    /** Aborted when this mount is destroyed or replaced by `update()`. */
    abort: AbortController
    /** Set by `update()`: the code that replaces `spec.mount` and its version. */
    mount?: SystemSurface["mount"] | undefined
    version?: string | undefined
    pending?: Promise<void> | undefined
    dispose?: (() => void) | undefined
    updating?: Promise<void> | undefined
  }
  const all: SystemSurface[] = [
    {
      ...SYSTEM_APP,
      mount(content) {
        content.dataset.systemScreen = ""
        patch({ systemHost: content })
        return () => {
          if (snapshot.systemHost === content) patch({ systemHost: undefined })
        }
      },
    },
    ...surfaces,
  ]
  const entries: Entry[] = all.map((spec) => {
    const panel = doc.createElement("section")
    panel.className = "msh-panel"
    panel.dataset.surface = spec.id
    panel.setAttribute("aria-label", spec.label)
    panel.tabIndex = -1
    // Positioned, so absolutely placed descendants scroll and clip with the panel.
    panel.style.cssText = "position:relative;height:100%;overflow:auto;outline:none"
    setHidden(panel, true)
    shell.insertBefore(panel, chrome)
    return { spec, panel, abort: new AbortController() }
  })
  /** The version a surface runs now: what `update()` set, else its own (which may be a getter). */
  const versionOf = (entry: Entry) => entry.version ?? entry.spec.version

  const view: HarnessController = {
    shell,
    apps: all.map(({ id, label, description, icon, backends, health }) => ({
      id,
      label,
      description,
      icon,
      backends,
      health,
      get version() {
        const entry = entries.find((candidate) => candidate.spec.id === id)
        return entry ? versionOf(entry) : undefined
      },
    })),
    switcher: surfaces.length > 0,
    get: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    show: (id) => void show(id),
    retry(id) {
      const entry = entries.find((candidate) => candidate.spec.id === id)
      if (!entry || destroyed) return
      entry.pending = undefined
      void load(entry)
    },
    setInRotation(id, included) {
      if (id === "system") return
      setRotation(storage, rotation, defaultOff, id, included)
      patch({ excluded: new Set(rotation.excluded) })
    },
    setOrder(order) {
      const next = reconcileOrder(order, snapshot.order)
      writeOrder(storage, next)
      patch({ order: next })
    },
    dismissNotice: () => notify(undefined),
    services: options.services,
    docsUrl: options.docsUrl,
    build: options.build,
    backends: options.backends,
    sections: options.sections,
    snapshot: options.snapshot,
    systemShortcut,
    syncUrl: options.syncUrl,
  }

  // The React view loads on its own, beside the first mount; `show()` settles once it has drawn.
  // A view that cannot load leaves the surfaces working.
  let rendered: { dispose(): void } | undefined
  const viewReady = import("./system-view.js").then(
    ({ renderHarness }) => {
      if (!destroyed) rendered = renderHarness(chrome, view)
    },
    (error: unknown) => {
      console.error("mockingbird: the System harness UI did not load", error)
    },
  )

  function load(entry: Entry): Promise<void> {
    if (entry.pending) return entry.pending
    const { id, label } = entry.spec
    const version = versionOf(entry)
    if (version === undefined) delete entry.panel.dataset.version
    else entry.panel.dataset.version = version
    if (version !== snapshot.versions[id])
      patch({
        versions:
          version === undefined
            ? Object.fromEntries(Object.entries(snapshot.versions).filter(([key]) => key !== id))
            : { ...snapshot.versions, [id]: version },
      })
    entry.panel.setAttribute("aria-busy", "true")
    const status = doc.createElement("div")
    status.className = "msh-status"
    status.setAttribute("role", "status")
    const content = doc.createElement("div")
    content.style.height = "100%"
    entry.panel.replaceChildren(status, content)
    setStatus(id, { id, host: status, state: "loading" })
    const signal = entry.abort.signal
    entry.pending = Promise.resolve()
      .then(() => {
        if (destroyed) return
        return (entry.mount ?? entry.spec.mount)(content, signal)
      })
      .then((dispose) => {
        status.remove()
        if (destroyed || signal.aborted) {
          dispose?.()
          return
        }
        entry.dispose = dispose
        setStatus(id)
      })
      .catch((error: unknown) => {
        if (destroyed || signal.aborted) return
        content.remove()
        const message = `Unable to open ${label}: ${error instanceof Error ? error.message : String(error)}`
        setStatus(id, { id, host: status, state: "error", message })
      })
      // Settled once the view has drawn what the mount left: the surface, or its error and Retry.
      .then(() => viewReady)
      .finally(() => {
        if (!signal.aborted) entry.panel.removeAttribute("aria-busy")
      })
    return entry.pending
  }

  function update(
    id: string,
    next: Partial<Pick<SystemSurface, "mount" | "version">> = {},
  ): Promise<void> {
    const entry = entries.find((candidate) => candidate.spec.id === id)
    if (!entry || id === "system") return Promise.reject(new Error(`No surface ${id} to update`))
    const run = async () => {
      if (destroyed) return
      if (next.mount) entry.mount = next.mount
      if (next.version !== undefined) entry.version = next.version
      // Not opened yet: the new code mounts on first open.
      if (!entry.pending) return
      await entry.pending
      if (destroyed) return
      entry.abort.abort()
      entry.abort = new AbortController()
      try {
        entry.dispose?.()
      } catch {
        /* The old code failing to tear down must not keep the new code out. */
      }
      entry.dispose = undefined
      entry.pending = undefined
      await load(entry)
    }
    entry.updating = (entry.updating ?? Promise.resolve()).then(run, run)
    return entry.updating
  }

  function notify(next: SystemNotice | undefined) {
    if (destroyed) return
    patch({ notice: next })
  }

  /** The last path each routed surface was at when someone switched away from it. */
  const lastPath = new Map<string, string>()
  const withoutSurface = (url: URL) => {
    const copy = new URL(url)
    copy.searchParams.delete("surface")
    return copy.pathname + copy.search + copy.hash
  }

  async function show(id: string, fromHistory = false): Promise<void> {
    if (destroyed) return
    const entry = entries.find((e) => e.spec.id === id) ?? entries[0]
    if (!entry) return
    const previous = entries.find((candidate) => candidate.spec.id === snapshot.current)
    for (const candidate of entries) {
      setHidden(candidate.panel, candidate !== entry)
      candidate.panel.inert = candidate !== entry
    }
    if (
      entries.some(
        (candidate) => candidate.panel.hidden && candidate.panel.contains(doc.activeElement),
      )
    ) {
      entry.panel.focus()
    }
    patch({ current: entry.spec.id })
    if (options.syncUrl && !fromHistory) {
      let url = new URL(win.location.href)
      const route = entry.spec.route
      const was = previous?.spec.route
      if (
        previous &&
        previous !== entry &&
        was !== undefined &&
        matchRoute(surfaces, url.pathname) === previous.spec.id
      )
        lastPath.set(previous.spec.id, withoutSurface(url))
      // The System section belongs to System's own URL.
      if (entry.spec.id !== "system") url.searchParams.delete(SYSTEM_SECTION_PARAM)
      if (route === undefined) url.searchParams.set("surface", entry.spec.id)
      else if (previous === entry) url.searchParams.delete("surface")
      else {
        const saved = lastPath.get(entry.spec.id)
        const here =
          !url.searchParams.has("surface") && matchRoute(surfaces, url.pathname) === entry.spec.id
            ? withoutSurface(url)
            : undefined
        url = new URL(saved ?? here ?? route, url)
      }
      if (url.href !== win.location.href) win.history.pushState(null, "", url)
    }
    await load(entry)
  }

  const fromUrl = () => {
    const url = new URL(win.location.href)
    return (
      url.searchParams.get("surface") ??
      matchRoute(surfaces, url.pathname) ??
      options.initial ??
      "system"
    )
  }
  const pop = () => {
    void show(fromUrl(), true)
  }
  if (options.syncUrl) win.addEventListener("popstate", pop)
  void show(options.syncUrl ? fromUrl() : (options.initial ?? "system"))
  return {
    show: (id) => show(id),
    active: () => snapshot.current,
    update,
    notify,
    destroy() {
      if (destroyed) return
      destroyed = true
      for (const entry of entries) entry.abort.abort()
      win.removeEventListener("popstate", pop)
      rendered?.dispose()
      listeners.clear()
      for (const entry of entries) {
        try {
          entry.dispose?.()
        } catch {
          /* Other surfaces must still be disposed. */
        }
      }
      shell.remove()
    },
  }
}

/** `hidden`, and `display: none` too, which a host page's own `section { display }` cannot undo. */
function setHidden(panel: HTMLElement, hidden: boolean) {
  panel.hidden = hidden
  panel.style.display = hidden ? "none" : ""
}

/** What applying a newer load manifest did. */
export type PreviewPartUpdateResult =
  | { status: "unchanged" }
  | { status: "updated"; apps: string[]; backends: string[] }
  | { status: "reload-required"; reason: string }
  | { status: "failed"; backend: string; error: Error }

export type MountSystemOptions = Omit<SystemHarnessOptions, "backends"> &
  Omit<PreviewSystemRuntime, "manifest"> & {
    /** The load manifest this tab starts from (`parts.json`). */
    manifest?: PreviewLoadManifestLike
    /** The backends' state for the System screen; defaults to the registry's list without state. */
    backends?: SystemBackends
    /**
     * Swaps one backend to the code a newer manifest names (such as `backendControls().replace`
     * from `@crvouga/mockingbird-preview`). Rejects when the new code fails to boot; the old one
     * must keep serving. Without it, a manifest that changes a backend needs a reload.
     */
    replaceBackend?: (
      id: string,
      next: { entry: string; pin: string; bytes: number },
    ) => Promise<void> | void
    /** Runs `prefetch` parts at idle priority. Default `requestIdleCallback`, else a timeout. */
    idle?: (run: () => void) => void
    /** How a required reload happens. Default `location.reload()`. */
    reload?: () => void
  }

export type SystemPreview = SystemHarness & {
  /** The part loader: what has been fetched so far, and prefetching. */
  loader: PreviewPartLoader
  /** The load manifest the tab runs now. */
  manifest(): PreviewLoadManifestLike | undefined
  /**
   * Takes a newer load manifest: swaps only the backends and apps whose pin changed (backends
   * first, so a new app never talks to an old backend), and keeps every other app, backend and
   * emulator as it is. A change to the shared runtime is refused with a notice saying why and a
   * Reload button. A backend that fails to boot leaves the old one serving and shows Retry.
   */
  applyManifest(next: PreviewLoadManifestLike): Promise<PreviewPartUpdateResult>
}

/**
 * Mounts a registry (`defineSystem`) as a system preview: the switcher, the System screen, routes
 * and the build's parts all come from the one declaration. Each app's part, and the backends it
 * calls, load on its first open; `prefetch` parts load at idle priority after the first app is up.
 */
export function mountSystem(
  host: HTMLElement,
  system: PreviewSystem,
  options: MountSystemOptions = {},
): SystemPreview {
  let manifest = options.manifest
  const win = host.ownerDocument.defaultView ?? window
  const { surfaces, loader } = systemSurfaces(system, {
    ...options,
    manifest: () => manifest,
  })
  let prefetching = false
  const schedulePrefetch = () => {
    if (prefetching) return
    prefetching = true
    const idle =
      options.idle ??
      ((run: () => void) => {
        const request = (
          win as unknown as {
            requestIdleCallback?: (run: () => void, options?: { timeout: number }) => void
          }
        ).requestIdleCallback
        if (request) request.call(win, run, { timeout: 5_000 })
        else win.setTimeout(run, 1)
      })
    idle(() => void loader.prefetch())
  }
  const wrapped: SystemSurface[] = surfaces.map((surface) =>
    Object.defineProperty(
      {
        ...surface,
        mount: async (panel: HTMLElement, signal: AbortSignal) => {
          const dispose = await surface.mount(panel, signal)
          schedulePrefetch()
          return dispose
        },
      },
      "version",
      { enumerable: true, get: () => surface.version },
    ),
  )
  const backends: SystemBackends = options.backends ?? {
    list: () => system.backends.map((backend) => ({ ...backend })),
  }
  const harness = mountSystemHarness(host, wrapped, { ...options, backends })
  const reload = options.reload ?? (() => win.location.reload())
  const applyManifest = async (next: PreviewLoadManifestLike): Promise<PreviewPartUpdateResult> => {
    if (!manifest) {
      manifest = next
      return { status: "unchanged" }
    }
    const plan = planPartUpdate(manifest, next)
    if (plan.kind === "none") {
      manifest = next
      return { status: "unchanged" }
    }
    const refuse = (reason: string): PreviewPartUpdateResult => {
      harness.notify({
        tone: "warning",
        text: `This update needs a full reload. ${reason}`,
        action: { label: "Reload", run: reload },
      })
      return { status: "reload-required", reason }
    }
    if (plan.kind === "reload") return refuse(plan.reason)
    if (plan.backends.length > 0 && !options.replaceBackend)
      return refuse("A backend changed, and this preview cannot swap backends in place.")
    for (const id of plan.backends) {
      const part = next.backends?.[id] as { entry: string; pin: string; bytes: number }
      try {
        await options.replaceBackend?.(id, part)
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause))
        harness.notify({
          tone: "error",
          text: `Backend ${id} could not update, so its previous version keeps serving: ${error.message}`,
          action: { label: "Retry", run: () => void applyManifest(next) },
        })
        return { status: "failed", backend: id, error }
      }
      // Swapped: a retry after a later failure does not swap it again.
      manifest = { ...manifest, backends: { ...manifest.backends, [id]: part } }
    }
    manifest = next
    harness.notify(undefined)
    await Promise.all(plan.apps.map((id) => harness.update(id)))
    return { status: "updated", apps: plan.apps, backends: plan.backends }
  }
  return { ...harness, loader, manifest: () => manifest, applyManifest }
}
