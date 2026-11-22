/// <reference lib="dom" />

import type { SystemBuild } from "./system-build-status.js"
import { SYSTEM_ICONS, type SystemIcon } from "./system-icons.js"
import {
  createPartRuntime,
  defineSystem,
  type PreviewApp,
  type PreviewLoadManifestLike,
  type PreviewPartLoader,
  type PreviewSystem,
  type PreviewSystemDefinition,
  type PreviewSystemRuntime,
  type PreviewSystemSurface,
  planPartUpdate,
} from "./system-registry.js"
import {
  excludedWithDefaults,
  initialExcluded,
  readSavedOrder,
  reconcileOrder,
  SWITCHER_BAR_HEIGHT,
  setRotation,
  writeOrder,
} from "./system-rotation.js"
import { matchRoute } from "./system-routes.js"
import {
  DEFAULT_NEXT_SHORTCUT,
  DEFAULT_PREVIOUS_SHORTCUT,
  DEFAULT_SYSTEM_SHORTCUT,
  parseShortcut,
  SYSTEM_SECTION_PARAM,
  validateSections,
} from "./system-shortcut.js"
import type {
  HarnessController,
  HarnessSnapshot,
  PanelStatus,
  SystemApp,
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
export {
  DOCK_KEY,
  INCLUDED_KEY,
  ORDER_KEY,
  ROTATION_KEY,
  SWITCHER_BAR_HEIGHT,
} from "./system-rotation.js"
export {
  DEFAULT_NEXT_SHORTCUT,
  DEFAULT_PREVIOUS_SHORTCUT,
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
  /**
   * Called each time the surface becomes visible: shown by a switch, or its browser tab coming
   * back to the foreground. Only once it is mounted (the first call follows its mount), and
   * alternating with `onHide`, so a surface can restart what `onHide` paused (polling, media).
   */
  onShow?(): void
  /**
   * Called each time a shown surface stops being visible: a switch away, or its browser tab
   * going to the background. Not called when it is disposed (by `update()`, eviction or
   * `destroy()`); its disposer releases everything then.
   */
  onHide?(): void
}

/** Maps surfaces to the host's own addresses, in place of `syncUrl`'s `?surface=` and routes. */
export type SystemHarnessUrl = {
  /** The surface an address opens ("system" for System); `undefined` means `initial`. */
  read(location: Location): string | undefined
  /**
   * The address (absolute, or relative to the current one) for a surface just shown, asked only
   * when `read` says the current address opens another surface (so a deep link into a surface
   * stays as it is); pushed onto history when it differs. `undefined` leaves the address bar.
   */
  write(id: string, location: Location): string | undefined
}

/** Where the harness keeps the switcher's preferences. */
export type SystemHarnessStorage = Pick<Storage, "getItem" | "setItem">

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
   * "Alt+Shift+S"); `false` turns it off. The bar's System button opens it too.
   */
  systemShortcut?: string | false
  /**
   * The keyboard shortcuts that step to the previous and next app in the rotation (default
   * `DEFAULT_PREVIOUS_SHORTCUT` and `DEFAULT_NEXT_SHORTCUT`, "Alt+Shift+[" and "Alt+Shift+]");
   * `false` turns them off. Written as `systemShortcut` is.
   */
  switchShortcuts?: { previous: string; next: string } | false
  /**
   * Called after the shown surface changes, with its id ("system" for System): by `show()`, the
   * bar's arrows, a System row's Open, or back/forward. Called once per change, synchronously,
   * after the address bar is written and before the surface's mount resolves. Not called for the
   * surface shown when the harness mounts (read `active()`), nor when the shown one is shown again.
   */
  onShow?(id: string): void
  /**
   * Maps surfaces to the host's own URLs (`read` on load and back/forward, `write` on each
   * switch). Turns URL sync on and replaces `syncUrl`'s `?surface=` and `route` handling.
   */
  url?: SystemHarnessUrl
  /**
   * Unmounts a surface hidden this long (its disposer runs, its signal aborts); it mounts again
   * when shown, with the usual Retry on failure. System is never evicted. Default: never.
   */
  evictHiddenAfterMs?: number
  /**
   * Where the switcher's preferences live: the surfaces left out of it and the order they go
   * in (`ROTATION_KEY`, `INCLUDED_KEY`, `ORDER_KEY`). Default
   * `localStorage`, which same-origin apps may clear on sign-out; pass a store they never touch.
   */
  storage?: SystemHarnessStorage
  /**
   * Surfaces left out of the switcher until a person switches them on, as `defaultEnabled:
   * false` does. A missing or cleared store means these defaults, not everything on.
   */
  defaultExcluded?: readonly string[]
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
  /**
   * Declares the surfaces the running harness has now, in switcher order: call it with the whole
   * list (an empty one too) whenever the topology changes. Surfaces are matched by `id`:
   *
   * - one still listed keeps its panel, its mount and its state, and takes the new descriptor's
   *   label, description, icon, route, backends, health and hooks, even from a freshly allocated
   *   object. Its code is not replaced: a new `mount` runs the next time it mounts, and `update()`
   *   still swaps it (what `update()` set stays in force);
   * - a new one gets a panel, a place in the switcher and on System, and its route; it mounts on
   *   its first open. One that `show()` or the address asked for before it existed opens now;
   * - one no longer listed is disposed exactly once and its panel removed. A mount still pending
   *   is aborted and its late result disposed, also when the same id has been added again since.
   *
   * When the surface shown is removed, the harness shows `initial` if it is still there, else the
   * first surface in the switcher, else System, and replaces the address with URL sync on. The
   * switcher's preferences (order, the ones switched off or on) hold across changes, including
   * for a surface removed and added back.
   *
   * Throws on a duplicate or reserved id or two surfaces with one route, before changing
   * anything: the preview stays as it was.
   */
  setSurfaces(surfaces: readonly SystemSurface[]): void
  /** Shows a notice over the apps until dismissed or replaced; `undefined` clears it. */
  notify(notice: SystemNotice | undefined): void
  destroy(): void
}

const SYSTEM_APP: Required<
  Omit<
    SystemSurface,
    "mount" | "defaultEnabled" | "route" | "backends" | "version" | "health" | "onShow" | "onHide"
  >
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
 * page. The harness's own UI (the switcher bar, its tooltip and update toast, the notice over
 * the apps, each panel's loading and error state, and the System screen) is React and HeroUI
 * with Mockingbird's stylesheet scoped to it, so it restyles nothing else on the page. The view
 * loads lazily (`system-view.tsx`), so importing this module costs no React.
 *
 * The switcher is a thin bar across the top of the shell (`SWITCHER_BAR_HEIGHT`), part of the
 * layout, so the surfaces sit below it and it never covers them. The System screen's "In switcher" toggles choose which surfaces the arrows cycle through, and
 * dragging its rows sets the order they go in (kept under ROTATION_KEY, INCLUDED_KEY and
 * ORDER_KEY); `show(id)`, the URL and each row's Open still reach every surface. These live in
 * `options.storage`, default localStorage.
 *
 * A surface's `onShow` and `onHide` follow whether it is visible (shown, in a foreground tab);
 * with `evictHiddenAfterMs`, one hidden that long is unmounted and mounts again when shown.
 */
export function mountSystemHarness(
  host: HTMLElement,
  surfaces: readonly SystemSurface[],
  options: SystemHarnessOptions = {},
): SystemHarness {
  validateSurfaces(surfaces)
  /** The surfaces now, as last declared (at mount, or by `setSurfaces`). */
  let specs: readonly SystemSurface[] = [...surfaces]
  validateSections(options.sections ?? [])
  const systemShortcut = options.systemShortcut ?? DEFAULT_SYSTEM_SHORTCUT
  // A shortcut that cannot be parsed fails here, not on the first key press.
  if (systemShortcut !== false) parseShortcut(systemShortcut)
  const switchShortcuts = options.switchShortcuts ?? {
    previous: DEFAULT_PREVIOUS_SHORTCUT,
    next: DEFAULT_NEXT_SHORTCUT,
  }
  if (switchShortcuts !== false) {
    parseShortcut(switchShortcuts.previous)
    parseShortcut(switchShortcuts.next)
  }
  const evictAfter = options.evictHiddenAfterMs
  if (evictAfter !== undefined && !(evictAfter >= 0))
    throw new Error(`evictHiddenAfterMs must be a number of milliseconds, not ${evictAfter}`)
  const defaultOffOf = (list: readonly SystemSurface[]) => [
    ...new Set([
      ...list.filter((s) => s.defaultEnabled === false).map((s) => s.id),
      ...(options.defaultExcluded ?? []).filter((id) => id !== "system"),
    ]),
  ]
  let defaultOff = defaultOffOf(specs)
  const doc = host.ownerDocument
  const win = doc.defaultView ?? window
  // Light DOM, styled inline: nothing here adds a stylesheet to the host page.
  const shell = doc.createElement("div")
  shell.className = "msh"
  shell.dataset.testid = "system-harness"
  shell.style.cssText =
    "position:relative;display:flex;flex-direction:column;height:100%;min-height:240px;isolation:isolate;background:Canvas;color:CanvasText"
  // The switcher bar: a thin strip across the top, in the layout, so it never covers a surface.
  // Shown only while there are surfaces to switch between; `setSurfaces` can change that.
  let barHeight = 0
  const bar = doc.createElement("div")
  bar.className = "msh-bar"
  const chrome = doc.createElement("div")
  chrome.className = "msh-chrome"
  const layoutBar = () => {
    barHeight = specs.length > 0 ? SWITCHER_BAR_HEIGHT : 0
    bar.style.cssText = `flex:none;height:${barHeight}px;position:relative;z-index:1001`
    bar.hidden = barHeight === 0
    chrome.style.cssText = `position:absolute;inset:${barHeight}px 0 0 0;pointer-events:none;z-index:1000`
  }
  layoutBar()
  shell.append(bar, chrome)
  host.append(shell)
  // What a full-height page inside a panel fills (`AppShell`): the panel, not the viewport.
  const fit = () =>
    shell.style.setProperty("--mb-app-height", `${Math.max(0, shell.clientHeight - barHeight)}px`)
  const resize = typeof win.ResizeObserver === "function" ? new win.ResizeObserver(fit) : undefined
  resize?.observe(shell)
  fit()

  let destroyed = false
  const storage = (): SystemHarnessStorage => options.storage ?? win.localStorage
  const rotation = initialExcluded(storage, defaultOff)
  const listeners = new Set<() => void>()
  /** The order a person chose (saved, or set this session), ids no longer declared included. */
  let preferredOrder: readonly unknown[] = readSavedOrder(storage)
  const orderOf = (list: readonly SystemSurface[]) =>
    reconcileOrder(preferredOrder, ["system", ...list.map((surface) => surface.id)])
  let snapshot: HarnessSnapshot = {
    current: "",
    order: orderOf(specs),
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
    /** Its mount resolved, and it has not been disposed since. */
    ready?: boolean
    /** `onShow` was the last of `onShow`/`onHide` called. */
    visible?: boolean
    /** Pending eviction while hidden. */
    evictTimer?: number | undefined
    /** `setSurfaces` dropped it: it never mounts again. */
    removed?: boolean
  }
  const systemSpec: SystemSurface = {
    ...SYSTEM_APP,
    mount(content) {
      content.dataset.systemScreen = ""
      patch({ systemHost: content })
      return () => {
        if (snapshot.systemHost === content) patch({ systemHost: undefined })
      }
    },
  }
  // A panel is appended once and never moved: moving an iframe app's panel would reload it.
  const createEntry = (spec: SystemSurface): Entry => {
    const panel = doc.createElement("section")
    panel.className = "msh-panel"
    panel.dataset.surface = spec.id
    panel.setAttribute("aria-label", spec.label)
    panel.tabIndex = -1
    // Positioned, so absolutely placed descendants scroll and clip with the panel.
    panel.style.cssText = "position:relative;flex:1 1 0;min-height:0;overflow:auto;outline:none"
    setHidden(panel, true)
    panel.inert = true
    shell.insertBefore(panel, chrome)
    return { spec, panel, abort: new AbortController() }
  }
  let entries: Entry[] = [systemSpec, ...specs].map(createEntry)
  /** The version a surface runs now: what `update()` set, else its own (which may be a getter). */
  const versionOf = (entry: Entry) => entry.version ?? entry.spec.version
  const appsOf = (list: readonly SystemSurface[]): SystemApp[] =>
    [systemSpec, ...list].map(({ id, label, description, icon, backends, health }) => ({
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
    }))
  let apps = appsOf(specs)

  const view: HarnessController = {
    shell,
    bar,
    get apps() {
      return apps
    },
    get switcher() {
      return specs.length > 0
    },
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
      preferredOrder = next
      writeOrder(storage, next)
      patch({ order: next })
    },
    dismissNotice: () => notify(undefined),
    storage,
    services: options.services,
    docsUrl: options.docsUrl,
    build: options.build,
    backends: options.backends,
    sections: options.sections,
    snapshot: options.snapshot,
    systemShortcut,
    switchShortcuts,
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
    if (entry.removed) return Promise.resolve()
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
        if (destroyed || signal.aborted) return
        return (entry.mount ?? entry.spec.mount)(content, signal)
      })
      .then((dispose) => {
        status.remove()
        if (destroyed || signal.aborted) {
          dispose?.()
          return
        }
        entry.dispose = dispose
        entry.ready = true
        setStatus(id)
        syncVisible(entry)
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
      // Evicted meanwhile: the new code mounts when it is next shown.
      if (destroyed || !entry.pending) return
      unmount(entry)
      await load(entry)
    }
    entry.updating = (entry.updating ?? Promise.resolve()).then(run, run)
    return entry.updating
  }

  /** Disposes a surface's mount (without `onHide`), so its next `load()` mounts it afresh. */
  function unmount(entry: Entry) {
    entry.abort.abort()
    entry.abort = new AbortController()
    entry.ready = false
    entry.visible = false
    try {
      entry.dispose?.()
    } catch {
      /* The old mount failing to tear down must not keep the next one out. */
    }
    entry.dispose = undefined
    entry.pending = undefined
  }

  /** Calls `onShow` or `onHide` when whether the surface is visible changed. */
  function syncVisible(entry: Entry) {
    const visible =
      !destroyed &&
      entry.ready === true &&
      snapshot.current === entry.spec.id &&
      doc.visibilityState !== "hidden"
    if (visible === (entry.visible === true)) return
    entry.visible = visible
    try {
      if (visible) entry.spec.onShow?.()
      else entry.spec.onHide?.()
    } catch (error) {
      console.error(`mockingbird: ${entry.spec.id}'s ${visible ? "onShow" : "onHide"} threw`, error)
    }
  }

  /** Starts or cancels each surface's eviction timer after a switch. */
  function scheduleEviction() {
    if (evictAfter === undefined || evictAfter === Number.POSITIVE_INFINITY) return
    for (const entry of entries) {
      const hidden = entry.spec.id !== snapshot.current
      if (!hidden || entry.spec.id === "system" || !entry.pending) {
        if (entry.evictTimer !== undefined) win.clearTimeout(entry.evictTimer)
        entry.evictTimer = undefined
      } else if (entry.evictTimer === undefined) {
        entry.evictTimer = win.setTimeout(() => {
          entry.evictTimer = undefined
          if (destroyed || entry.spec.id === snapshot.current || !entry.pending) return
          unmount(entry)
          entry.panel.replaceChildren()
          entry.panel.removeAttribute("aria-busy")
          setStatus(entry.spec.id)
        }, evictAfter)
      }
    }
  }

  function notify(next: SystemNotice | undefined) {
    if (destroyed) return
    patch({ notice: next })
  }

  const hostUrl = options.url
  /** The last path each routed surface was at when someone switched away from it. */
  const lastPath = new Map<string, string>()
  const withoutSurface = (url: URL) => {
    const copy = new URL(url)
    copy.searchParams.delete("surface")
    return copy.pathname + copy.search + copy.hash
  }

  /** A surface asked for before it was declared: `setSurfaces` opens it when it arrives. */
  let wanted: string | undefined
  /** `how`: a switch pushes an address, a fallback replaces it, back/forward leaves it. */
  async function show(id: string, how: "push" | "replace" | "history" = "push"): Promise<void> {
    if (destroyed) return
    const known = entries.find((e) => e.spec.id === id)
    wanted = known ? undefined : id
    const entry = known ?? entries[0]
    if (!entry) return
    const fromHistory = how === "history"
    const go = (url: URL) => {
      if (url.href === win.location.href) return
      if (how === "replace") win.history.replaceState(win.history.state, "", url)
      else win.history.pushState(null, "", url)
    }
    const previous = entries.find((candidate) => candidate.spec.id === snapshot.current)
    const first = snapshot.current === ""
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
    // Hide what was shown before showing what is shown now.
    for (const candidate of entries) if (candidate !== entry) syncVisible(candidate)
    syncVisible(entry)
    scheduleEviction()
    if (hostUrl && !fromHistory && hostUrl.read(win.location) !== entry.spec.id) {
      const next = hostUrl.write(entry.spec.id, win.location)
      if (next !== undefined) go(new URL(next, win.location.href))
    } else if (options.syncUrl && !fromHistory) {
      let url = new URL(win.location.href)
      const route = entry.spec.route
      const was = previous?.spec.route
      if (
        previous &&
        previous !== entry &&
        was !== undefined &&
        matchRoute(specs, url.pathname) === previous.spec.id
      )
        lastPath.set(previous.spec.id, withoutSurface(url))
      // The System section belongs to System's own URL.
      if (entry.spec.id !== "system") url.searchParams.delete(SYSTEM_SECTION_PARAM)
      if (route === undefined) url.searchParams.set("surface", entry.spec.id)
      else if (previous === entry && matchRoute(specs, url.pathname) === entry.spec.id)
        url.searchParams.delete("surface")
      else {
        const path = lastPath.get(entry.spec.id)
        const saved =
          path && matchRoute(specs, new URL(path, url).pathname) === entry.spec.id
            ? path
            : undefined
        // A fallback's address belonged to the surface that left, so it is not kept.
        const here =
          how !== "replace" &&
          !url.searchParams.has("surface") &&
          matchRoute(specs, url.pathname) === entry.spec.id
            ? withoutSurface(url)
            : undefined
        url = new URL(saved ?? here ?? route, url)
      }
      go(url)
    }
    if (!first && previous !== entry)
      try {
        options.onShow?.(entry.spec.id)
      } catch (error) {
        console.error("mockingbird: the host's onShow threw", error)
      }
    await load(entry)
  }

  function setSurfaces(next: readonly SystemSurface[]): void {
    if (destroyed) return
    const list = [...next]
    // Throws before anything changes, so a rejected list leaves the preview as it was.
    validateSurfaces(list)
    const kept = new Map(entries.map((entry) => [entry.spec.id, entry]))
    const listed = new Set(["system", ...list.map((surface) => surface.id)])
    const oldRoute = kept.get(snapshot.current)?.spec.route
    const gone = entries.filter(({ spec }) => !listed.has(spec.id))
    const focused = doc.activeElement
    let refocus = false
    for (const entry of gone) {
      if (entry.panel.contains(focused)) refocus = true
      entry.removed = true
      if (entry.evictTimer !== undefined) win.clearTimeout(entry.evictTimer)
      entry.evictTimer = undefined
      // Aborts a pending mount (its late result is disposed by `load`) and disposes a settled one.
      unmount(entry)
      entry.panel.remove()
      lastPath.delete(entry.spec.id)
    }
    entries = [
      entries[0] as Entry,
      ...list.map((spec) => {
        const entry = kept.get(spec.id)
        if (!entry) return createEntry(spec)
        entry.spec = spec
        entry.panel.setAttribute("aria-label", spec.label)
        return entry
      }),
    ]
    specs = list
    apps = appsOf(specs)
    layoutBar()
    fit()
    fit()
    // As a reload would find them: an off-by-default surface is out until someone switches it on.
    defaultOff = defaultOffOf(specs)
    rotation.excluded = excludedWithDefaults(rotation, defaultOff)
    patch({
      order: orderOf(specs),
      excluded: new Set(rotation.excluded),
      statuses: snapshot.statuses.filter((status) => listed.has(status.id)),
      versions: Object.fromEntries(
        Object.entries(snapshot.versions).filter(([id]) => listed.has(id)),
      ),
    })
    const target =
      wanted !== undefined && listed.has(wanted)
        ? wanted
        : listed.has(snapshot.current)
          ? undefined
          : options.initial !== undefined && listed.has(options.initial)
            ? options.initial
            : (snapshot.order.find((id) => id !== "system" && !snapshot.excluded.has(id)) ??
              "system")
    if (target === undefined) {
      const current = kept.get(snapshot.current)?.spec
      if (
        options.syncUrl &&
        !hostUrl &&
        current &&
        (oldRoute !== current.route ||
          (current.route !== undefined && matchRoute(specs, win.location.pathname) !== current.id))
      )
        void show(current.id, "replace")
      return
    }
    // The panels and the address change now; the surface's own mount settles later.
    void show(target, "replace")
    if (refocus) entries.find((entry) => entry.spec.id === snapshot.current)?.panel.focus()
  }

  const fromUrl = () => {
    if (hostUrl) return hostUrl.read(win.location) ?? options.initial ?? "system"
    const url = new URL(win.location.href)
    return (
      url.searchParams.get("surface") ??
      matchRoute(specs, url.pathname) ??
      options.initial ??
      "system"
    )
  }
  const pop = () => {
    void show(fromUrl(), "history")
  }
  const onVisibility = () => {
    for (const entry of entries) syncVisible(entry)
  }
  const syncing = options.syncUrl === true || hostUrl !== undefined
  if (syncing) win.addEventListener("popstate", pop)
  doc.addEventListener("visibilitychange", onVisibility)
  void show(syncing ? fromUrl() : (options.initial ?? "system"))
  return {
    show: (id) => show(id),
    active: () => snapshot.current,
    update,
    setSurfaces,
    notify,
    destroy() {
      if (destroyed) return
      destroyed = true
      for (const entry of entries) {
        entry.abort.abort()
        if (entry.evictTimer !== undefined) win.clearTimeout(entry.evictTimer)
      }
      win.removeEventListener("popstate", pop)
      doc.removeEventListener("visibilitychange", onVisibility)
      rendered?.dispose()
      listeners.clear()
      for (const entry of entries) {
        try {
          entry.dispose?.()
        } catch {
          /* Other surfaces must still be disposed. */
        }
      }
      resize?.disconnect()
      shell.remove()
    },
  }
}

/** Throws on a missing, duplicate or reserved id, or two surfaces declaring one route. */
function validateSurfaces(surfaces: readonly SystemSurface[]): void {
  const ids = new Set(["system"])
  const routes = new Map<string, string>()
  for (const surface of surfaces) {
    if (!surface?.id || ids.has(surface.id))
      throw new Error(`Duplicate or reserved surface: ${surface?.id}`)
    ids.add(surface.id)
    if (surface.route !== undefined) {
      const owner = routes.get(surface.route)
      if (owner !== undefined)
        throw new Error(`Surfaces ${owner} and ${surface.id} both own the route ${surface.route}`)
      routes.set(surface.route, surface.id)
    }
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
  /** The registry the preview runs now: the one mounted, or the last one `setApps` took. */
  system(): PreviewSystem
  /**
   * Declares the apps the running preview has now, in switcher order: the registry's own
   * `setSurfaces`. Call it with the whole list (a plain array, an empty one too, or a definition
   * with its `backends`) whenever the topology changes. Apps are matched by `id`: one still
   * listed keeps its mount and state, a new one loads its part on its first open, and one no
   * longer listed is disposed. The switcher, the System screen's Apps and Backends lists, the
   * routes and the part loader all follow.
   *
   * A plain array declares the backends its apps name, keeping the label and kind of the ones
   * already declared. Throws a `PreviewRegistryError`, as `defineSystem` does, before changing
   * anything. On a preview, use this in place of `setSurfaces`.
   */
  setApps(next: readonly PreviewApp[] | PreviewSystemDefinition): void
}

/**
 * Mounts a registry (`defineSystem`) as a system preview: the switcher, the System screen, routes
 * and the build's parts all come from the one declaration. Each app's part, and the backends it
 * calls, load on its first open; `prefetch` parts load at idle priority after the first app is up.
 */
export function mountSystem(
  host: HTMLElement,
  initial: PreviewSystem,
  options: MountSystemOptions = {},
): SystemPreview {
  let manifest = options.manifest
  let system = initial
  const win = host.ownerDocument.defaultView ?? window
  const parts = createPartRuntime(() => system, { ...options, manifest: () => manifest })
  const { loader } = parts
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
  let prefetching = false
  const schedulePrefetch = () => {
    if (prefetching) return
    prefetching = true
    idle(() => void loader.prefetch())
  }
  const wrap = (surfaces: readonly PreviewSystemSurface[]): SystemSurface[] =>
    surfaces.map((surface) =>
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
  const backendListeners = new Set<() => void>()
  const backends: SystemBackends = options.backends ?? {
    list: () => system.backends.map((backend) => ({ ...backend })),
    subscribe(listener) {
      backendListeners.add(listener)
      return () => backendListeners.delete(listener)
    },
  }
  const harness = mountSystemHarness(host, wrap(parts.surfaces(system)), { ...options, backends })
  const setApps = (next: readonly PreviewApp[] | PreviewSystemDefinition): void => {
    const previous = system
    const definition: PreviewSystemDefinition =
      "apps" in next
        ? next
        : {
            apps: next,
            backends: [...new Set(next.flatMap((app) => app?.backends ?? []))].map(
              (id) => previous.backends.find((backend) => backend.id === id) ?? { id },
            ),
          }
    // Throws before anything changes, and so does the harness.
    const defined = defineSystem(definition)
    system = defined
    try {
      harness.setSurfaces(wrap(parts.surfaces(defined)))
    } catch (error) {
      system = previous
      throw error
    }
    parts.forget(previous.apps.filter((app) => !defined.app(app.id)).map((app) => app.id))
    for (const listener of backendListeners) listener()
    // A new app's `prefetch` part loads at idle priority too, once the first app has opened.
    if (prefetching) idle(() => void loader.prefetch())
  }
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
  return {
    ...harness,
    loader,
    manifest: () => manifest,
    applyManifest,
    system: () => system,
    setApps,
  }
}
