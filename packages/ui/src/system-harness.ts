/// <reference lib="dom" />

import { mountBuildChrome, type SystemBuild } from "./system-build.js"
import { paintIcon, SYSTEM_ICONS, type SystemIcon } from "./system-icons.js"
import {
  type PreviewPartLoader,
  type PreviewPartsManifestLike,
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
  stepRotation,
  writeOrder,
} from "./system-rotation.js"
import { matchRoute } from "./system-routes.js"
import {
  mountSystemScreen,
  SYSTEM_CSS,
  type SystemBackends,
  type SystemServices,
} from "./system-screen.js"

export type { SystemBuild, SystemBuildState } from "./system-build.js"
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
  type PreviewPartLoader,
  type PreviewPartsManifestLike,
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
export type {
  SystemBackend,
  SystemBackendState,
  SystemBackends,
  SystemDevStatus,
  SystemService,
  SystemServiceMode,
  SystemServices,
} from "./system-screen.js"

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
/** What a surface's `health` probe answers. */
export type SystemHealth = { ok: boolean; message?: string }
/** A message the shell shows over the apps, such as why an update needs a reload. */
export type SystemNotice = {
  tone: "info" | "warning" | "error"
  text: string
  /** One button beside the text (Retry, Reload). */
  action?: { label: string; run(): void }
}
export type SystemHarnessOptions = {
  /** The surface shown first (default "system"); with `syncUrl`, the URL's `?surface=` wins. */
  initial?: string
  /** Keep `?surface=` in the address bar and follow back/forward. */
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

/**
 * One visible surface, with mounted surfaces retained while hidden. Resolving mount means ready;
 * rejecting means failed. Abort and late disposal make teardown safe during asynchronous loading.
 * The reserved System surface is always reachable. URL state is opt-in for embedded hosts.
 * The switcher pill docks to the middle of the left edge until dragged; the edge and the
 * position along it are kept in localStorage, so it returns there after a reload or resize.
 * The System screen's "In switcher" toggles choose which surfaces the arrows cycle through, and
 * dragging its rows sets the order they go in (kept in localStorage under ROTATION_KEY and
 * ORDER_KEY); `show(id)`, the URL and each row's Open still reach every surface.
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
  const defaultOff = surfaces.filter((s) => s.defaultEnabled === false).map((s) => s.id)
  const doc = host.ownerDocument
  const win = doc.defaultView ?? window
  const shell = doc.createElement("div")
  shell.className = "msh"
  const style = doc.createElement("style")
  style.textContent = SYSTEM_CSS
  const chrome = doc.createElement("div")
  chrome.className = "msh-chrome"
  const switcher = doc.createElement("div")
  switcher.className = "msh-switcher"
  switcher.setAttribute("role", "group")
  switcher.setAttribute("aria-label", "Switch apps")
  switcher.dataset.testid = "system-switcher"
  switcher.hidden = surfaces.length === 0
  const arrow = (direction: "previous" | "next") => {
    const button = doc.createElement("button")
    button.type = "button"
    button.setAttribute("aria-label", direction === "next" ? "Next app" : "Previous app")
    button.dataset.testid = `system-switcher-${direction}`
    const path = direction === "next" ? "M5 12h14M13 6l6 6-6 6" : "M19 12H5M11 6l-6 6 6 6"
    button.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`
    return button
  }
  const previousButton = arrow("previous")
  const nextButton = arrow("next")
  switcher.append(previousButton, doc.createElement("hr"), nextButton)
  const tip = doc.createElement("div")
  tip.className = "msh-tip"
  tip.setAttribute("role", "tooltip")
  tip.hidden = true
  chrome.append(switcher, tip)
  shell.append(style, chrome)
  host.append(shell)
  let destroyed = false
  let current = ""
  const storage = () => win.localStorage
  const rotation = initialExcluded(storage, defaultOff)
  const excluded = rotation.excluded
  let order = readOrder(storage, ["system", ...surfaces.map((surface) => surface.id)])
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
  const entries: Entry[] = []
  const all: SystemSurface[] = [
    {
      id: "system",
      label: "System",
      mount: (panel) =>
        mountSystemScreen(panel, {
          apps: order.map((id) =>
            id === "system"
              ? {
                  id,
                  label: "System",
                  description: "This screen: the apps, the switcher and the services behind them.",
                  icon: SYSTEM_ICONS.system,
                }
              : (() => {
                  const entry = entries.find((candidate) => candidate.spec.id === id) as Entry
                  // The row shows the version running now, which `update()` may have changed.
                  const version = entry.version ?? entry.spec.version
                  return version === undefined ? entry.spec : { ...entry.spec, version }
                })(),
          ),
          open: (id) => void show(id),
          inRotation: (id) => id === "system" || !excluded.has(id),
          setInRotation(id, included) {
            setRotation(storage, rotation, defaultOff, id, included)
            paintArrows()
          },
          setOrder(ids) {
            order = reconcileOrder(ids, order)
            writeOrder(storage, order)
            paintArrows()
          },
          services: options.services,
          docsUrl: options.docsUrl,
          build: options.build,
          backends: options.backends,
        }),
    },
    ...surfaces,
  ]
  for (const spec of all) {
    const panel = doc.createElement("section")
    panel.className = "msh-panel"
    panel.dataset.surface = spec.id
    panel.setAttribute("aria-label", spec.label)
    panel.tabIndex = -1
    panel.hidden = true
    shell.insertBefore(panel, chrome)
    entries.push({ spec, panel, abort: new AbortController() })
  }
  function load(entry: Entry): Promise<void> {
    if (entry.pending) return entry.pending
    const version = entry.version ?? entry.spec.version
    if (version === undefined) delete entry.panel.dataset.version
    else entry.panel.dataset.version = version
    entry.panel.setAttribute("aria-busy", "true")
    const status = doc.createElement("div")
    status.className = "msh-status"
    status.setAttribute("role", "status")
    status.textContent = "Loading…"
    const content = doc.createElement("div")
    content.style.height = "100%"
    entry.panel.replaceChildren(status, content)
    const signal = entry.abort.signal
    entry.pending = Promise.resolve()
      .then(() => {
        if (destroyed) return
        return (entry.mount ?? entry.spec.mount)(content, signal)
      })
      .then((dispose) => {
        status.remove()
        if (destroyed || signal.aborted) dispose?.()
        else entry.dispose = dispose
      })
      .catch((error: unknown) => {
        if (destroyed || signal.aborted) return
        content.remove()
        status.textContent = `Unable to open ${entry.spec.label}: ${error instanceof Error ? error.message : String(error)}`
        const retry = doc.createElement("button")
        retry.textContent = "Retry"
        retry.onclick = () => {
          entry.pending = undefined
          void load(entry)
        }
        status.append(retry)
      })
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
  const notice = doc.createElement("div")
  notice.className = "msh-notice"
  notice.hidden = true
  notice.dataset.testid = "system-notice"
  chrome.append(notice)
  function notify(next: SystemNotice | undefined) {
    notice.replaceChildren()
    notice.hidden = next === undefined
    if (!next) return
    notice.dataset.tone = next.tone
    notice.setAttribute("role", next.tone === "error" ? "alert" : "status")
    const text = doc.createElement("span")
    text.className = "msh-notice-text"
    text.textContent = next.text
    notice.append(text)
    if (next.action) {
      const { label, run } = next.action
      const action = doc.createElement("button")
      action.type = "button"
      action.className = "msh-btn msh-btn-primary"
      action.textContent = label
      action.onclick = () => run()
      notice.append(action)
    }
    const dismiss = doc.createElement("button")
    dismiss.type = "button"
    dismiss.className = "msh-btn msh-btn-ghost"
    dismiss.textContent = "Dismiss"
    dismiss.onclick = () => notify(undefined)
    notice.append(dismiss)
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
    const previous = entries.find((candidate) => candidate.spec.id === current)
    current = entry.spec.id
    paintArrows()
    for (const candidate of entries) {
      candidate.panel.hidden = candidate !== entry
      candidate.panel.inert = candidate !== entry
    }
    if (
      entries.some(
        (candidate) => candidate.panel.hidden && candidate.panel.contains(doc.activeElement),
      )
    ) {
      entry.panel.focus()
    }
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
      if (route === undefined) url.searchParams.set("surface", current)
      else if (previous === entry) url.searchParams.delete("surface")
      else {
        const saved = lastPath.get(current)
        const here =
          !url.searchParams.has("surface") && matchRoute(surfaces, url.pathname) === current
            ? withoutSurface(url)
            : undefined
        url = new URL(saved ?? here ?? route, url)
      }
      if (url.href !== win.location.href) win.history.pushState(null, "", url)
    }
    await load(entry)
  }
  function neighbour(step: -1 | 1): Entry {
    const id = stepRotation(order, excluded, current, step)
    return entries.find((entry) => entry.spec.id === id) ?? (entries[0] as Entry)
  }
  /** Each arrow names where it goes; the rotation or the current surface changed. */
  function paintArrows() {
    for (const [button, step] of [
      [previousButton, -1],
      [nextButton, 1],
    ] as const) {
      const label = `${step < 0 ? "Previous" : "Next"}: ${neighbour(step).spec.label}`
      button.dataset.tip = label
      button.setAttribute("aria-description", label)
    }
    if (tipFor) showTip(tipFor)
  }
  let tipFor: HTMLButtonElement | undefined
  function showTip(button: HTMLButtonElement) {
    tipFor = button
    if (buildChrome && button === buildChrome.dot) {
      const status = buildChrome.tip()
      const tone = doc.createElement("span")
      tone.className = "msh-tip-tone"
      tone.dataset.tone = status.tone
      tone.setAttribute("aria-hidden", "true")
      tip.replaceChildren(tone, status.text)
    } else {
      const destination = neighbour(button === previousButton ? -1 : 1).spec
      const mark = doc.createElement("span")
      mark.className = "msh-tip-icon"
      mark.setAttribute("aria-hidden", "true")
      paintIcon(
        mark,
        destination.icon ?? (destination.id === "system" ? SYSTEM_ICONS.system : undefined),
        destination.label,
      )
      tip.replaceChildren(mark, button.dataset.tip ?? "")
    }
    tip.hidden = false
    const box = shell.getBoundingClientRect()
    const target = button.getBoundingClientRect()
    const pill = switcher.getBoundingClientRect()
    const left = target.left - box.left + (target.width - tip.offsetWidth) / 2
    const above = pill.top - box.top - tip.offsetHeight - 8
    tip.style.left = `${Math.max(4, Math.min(left, shell.clientWidth - tip.offsetWidth - 4))}px`
    tip.style.top = `${above >= 4 ? above : pill.bottom - box.top + 8}px`
  }
  const hideTip = () => {
    tipFor = undefined
    tip.hidden = true
  }
  const buildChrome = options.build
    ? mountBuildChrome({
        build: options.build,
        shell,
        chrome,
        switcher,
        open: () => void show("system"),
        dragging: () => dragged,
        changed() {
          if (tipFor && tipFor === buildChrome?.dot) showTip(tipFor)
        },
      })
    : undefined
  const tipped: HTMLButtonElement[] = [previousButton, nextButton]
  if (buildChrome) tipped.push(buildChrome.dot)
  for (const [button, step] of [
    [previousButton, -1],
    [nextButton, 1],
  ] as const) {
    button.onclick = () => {
      if (dragged) return
      void show(neighbour(step).spec.id)
    }
  }
  for (const button of tipped) {
    button.onpointerenter = (event) => {
      if (event.pointerType === "mouse" && !drag) showTip(button)
    }
    button.onpointerleave = () => {
      if (tipFor === button) hideTip()
    }
    button.onfocus = () => {
      if (button.matches(":focus-visible")) showTip(button)
    }
    button.onblur = () => {
      if (tipFor === button) hideTip()
    }
  }
  switcher.onkeydown = (event) => {
    if (event.key === "Escape") hideTip()
  }

  // Where the pill rests: an edge, and how far along it (0 = start, 1 = end).
  type Dock = { edge: "left" | "right" | "top" | "bottom"; at: number }
  const DOCK_KEY = "mockingbird.system-switcher.dock"
  const MARGIN = 8
  const readDock = (): Dock => {
    try {
      const saved = JSON.parse(win.localStorage.getItem(DOCK_KEY) ?? "null") as Partial<Dock>
      if (
        saved &&
        ["left", "right", "top", "bottom"].includes(saved.edge ?? "") &&
        typeof saved.at === "number" &&
        saved.at >= 0 &&
        saved.at <= 1
      )
        return saved as Dock
    } catch {
      /* Storage can be unavailable or hold something else; fall back to the default. */
    }
    return { edge: "left", at: 0.5 }
  }
  const writeDock = (value: Dock) => {
    try {
      win.localStorage.setItem(DOCK_KEY, JSON.stringify(value))
    } catch {
      /* The position is a convenience; switching still works without storage. */
    }
  }
  let dock = readDock()
  let x = 0
  let y = 0
  const limits = () => {
    const maxX = Math.max(0, shell.clientWidth - switcher.offsetWidth - MARGIN)
    const maxY = Math.max(0, shell.clientHeight - switcher.offsetHeight - MARGIN)
    return { minX: Math.min(MARGIN, maxX), minY: Math.min(MARGIN, maxY), maxX, maxY }
  }
  const position = () => {
    const { maxX, maxY } = limits()
    x = Math.max(0, Math.min(x, maxX + MARGIN))
    y = Math.max(0, Math.min(y, maxY + MARGIN))
    switcher.style.left = `${x}px`
    switcher.style.top = `${y}px`
    buildChrome?.place()
  }
  const settle = () => {
    const { minX, minY, maxX, maxY } = limits()
    const along = (min: number, max: number) => min + (max - min) * dock.at
    x = dock.edge === "left" ? minX : dock.edge === "right" ? maxX : along(minX, maxX)
    y = dock.edge === "top" ? minY : dock.edge === "bottom" ? maxY : along(minY, maxY)
    position()
  }
  const snap = () => {
    const { minX, minY, maxX, maxY } = limits()
    x = Math.max(minX, Math.min(x, maxX))
    y = Math.max(minY, Math.min(y, maxY))
    const fraction = (value: number, min: number, max: number) =>
      max > min ? (value - min) / (max - min) : 0.5
    const distances = { left: x - minX, right: maxX - x, top: y - minY, bottom: maxY - y }
    const edge = (Object.keys(distances) as Dock["edge"][]).reduce((a, b) =>
      distances[b] < distances[a] ? b : a,
    )
    dock = {
      edge,
      at: edge === "left" || edge === "right" ? fraction(y, minY, maxY) : fraction(x, minX, maxX),
    }
    writeDock(dock)
    switcher.style.transition = win.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "none"
      : "left 160ms ease-out, top 160ms ease-out"
    settle()
  }
  let drag: { x: number; y: number; left: number; top: number } | undefined
  let dragged = false
  switcher.onpointerdown = (event) => {
    if (event.button !== 0) return
    dragged = false
    switcher.style.transition = "none"
    drag = { x: event.clientX, y: event.clientY, left: x, top: y }
  }
  switcher.onpointermove = (event) => {
    if (!drag) return
    const dx = event.clientX - drag.x
    const dy = event.clientY - drag.y
    if (!dragged && Math.hypot(dx, dy) > 5) {
      dragged = true
      hideTip()
      switcher.classList.add("msh-dragging")
      // Capture only once it is a drag, so a plain press still clicks the arrow under it.
      switcher.setPointerCapture(event.pointerId)
    }
    if (!dragged) return
    x = drag.left + dx
    y = drag.top + dy
    position()
  }
  const release = () => {
    if (!drag) return
    drag = undefined
    switcher.classList.remove("msh-dragging")
    if (dragged) {
      snap()
      // The click that ends a drag arrives after pointerup; let it through on the next task.
      win.setTimeout(() => {
        dragged = false
      })
    }
  }
  switcher.onpointerup = release
  switcher.onpointercancel = release
  switcher.onlostpointercapture = release
  const resize = new ResizeObserver(() => {
    switcher.style.transition = "none"
    settle()
  })
  resize.observe(shell)
  resize.observe(switcher)
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
    active: () => current,
    update,
    notify,
    destroy() {
      if (destroyed) return
      destroyed = true
      for (const entry of entries) entry.abort.abort()
      resize.disconnect()
      buildChrome?.dispose()
      win.removeEventListener("popstate", pop)
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

/** What applying a newer parts manifest did. */
export type PreviewPartUpdateResult =
  | { status: "unchanged" }
  | { status: "updated"; apps: string[]; backends: string[] }
  | { status: "reload-required"; reason: string }
  | { status: "failed"; backend: string; error: Error }

export type MountSystemOptions = Omit<SystemHarnessOptions, "backends"> &
  Omit<PreviewSystemRuntime, "manifest"> & {
    /** The parts manifest this tab starts from (`parts.json`). */
    manifest?: PreviewPartsManifestLike
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
  /** The parts manifest the tab runs now. */
  manifest(): PreviewPartsManifestLike | undefined
  /**
   * Takes a newer parts manifest: swaps only the backends and apps whose pin changed (backends
   * first, so a new app never talks to an old backend), and keeps every other app, backend and
   * emulator as it is. A change to the shared runtime is refused with a notice saying why and a
   * Reload button. A backend that fails to boot leaves the old one serving and shows Retry.
   */
  applyManifest(next: PreviewPartsManifestLike): Promise<PreviewPartUpdateResult>
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
  const applyManifest = async (
    next: PreviewPartsManifestLike,
  ): Promise<PreviewPartUpdateResult> => {
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
