/// <reference lib="dom" />

import type { SystemBuild } from "./system-build-status.js"
import { SYSTEM_ICONS, type SystemIcon } from "./system-icons.js"
import {
  readExcluded,
  readOrder,
  reconcileOrder,
  writeExcluded,
  writeOrder,
} from "./system-rotation.js"
import type {
  HarnessController,
  HarnessSnapshot,
  PanelStatus,
  SystemServices,
} from "./system-types.js"

export type { SystemBuild, SystemBuildState } from "./system-build-status.js"
export { ORDER_KEY, ROTATION_KEY } from "./system-rotation.js"
export type {
  SystemDevStatus,
  SystemService,
  SystemServiceMode,
  SystemServices,
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
}
export type SystemHarness = {
  show(id: string): Promise<void>
  active(): string
  destroy(): void
}

const SYSTEM_APP: Required<Omit<SystemSurface, "mount">> = {
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
 * page. The harness's own UI (the switcher pill, its tooltip and update toast, each panel's
 * loading and error state, and the System screen) is React and HeroUI with Mockingbird's
 * stylesheet scoped to it, so it restyles nothing else on the page. The view loads lazily
 * (`system-view.tsx`), so importing this module costs no React.
 *
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
  for (const surface of surfaces) {
    if (!surface.id || ids.has(surface.id))
      throw new Error(`Duplicate or reserved surface: ${surface.id}`)
    ids.add(surface.id)
  }
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
  const controller = new AbortController()
  const listeners = new Set<() => void>()
  let snapshot: HarnessSnapshot = {
    current: "",
    order: readOrder(storage, ["system", ...surfaces.map((surface) => surface.id)]),
    excluded: readExcluded(storage),
    statuses: [],
  }
  const update = (patch: Partial<HarnessSnapshot>) => {
    snapshot = { ...snapshot, ...patch }
    for (const listener of listeners) listener()
  }
  const setStatus = (id: string, status?: PanelStatus) =>
    update({
      statuses: [
        ...snapshot.statuses.filter((candidate) => candidate.id !== id),
        ...(status ? [status] : []),
      ],
    })

  type Entry = {
    spec: SystemSurface
    panel: HTMLElement
    pending?: Promise<void> | undefined
    dispose?: (() => void) | undefined
  }
  const all: SystemSurface[] = [
    {
      ...SYSTEM_APP,
      mount(content) {
        content.dataset.systemScreen = ""
        update({ systemHost: content })
        return () => {
          if (snapshot.systemHost === content) update({ systemHost: undefined })
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
    return { spec, panel }
  })

  const view: HarnessController = {
    shell,
    apps: all.map(({ id, label, description, icon }) => ({ id, label, description, icon })),
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
      const excluded = new Set(snapshot.excluded)
      if (included) excluded.delete(id)
      else excluded.add(id)
      writeExcluded(storage, excluded)
      update({ excluded })
    },
    setOrder(order) {
      const next = reconcileOrder(order, snapshot.order)
      writeOrder(storage, next)
      update({ order: next })
    },
    services: options.services,
    docsUrl: options.docsUrl,
    build: options.build,
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
    entry.panel.setAttribute("aria-busy", "true")
    const status = doc.createElement("div")
    status.className = "msh-status"
    status.setAttribute("role", "status")
    const content = doc.createElement("div")
    content.style.height = "100%"
    entry.panel.replaceChildren(status, content)
    setStatus(id, { id, host: status, state: "loading" })
    entry.pending = Promise.resolve()
      .then(() => {
        if (destroyed) return
        return entry.spec.mount(content, controller.signal)
      })
      .then((dispose) => {
        status.remove()
        if (destroyed) {
          dispose?.()
          return
        }
        entry.dispose = dispose
        setStatus(id)
      })
      .catch((error: unknown) => {
        if (destroyed) return
        content.remove()
        const message = `Unable to open ${label}: ${error instanceof Error ? error.message : String(error)}`
        setStatus(id, { id, host: status, state: "error", message })
      })
      // Settled once the view has drawn what the mount left: the surface, or its error and Retry.
      .then(() => viewReady)
      .finally(() => entry.panel.removeAttribute("aria-busy"))
    return entry.pending
  }

  async function show(id: string): Promise<void> {
    if (destroyed) return
    const entry = entries.find((e) => e.spec.id === id) ?? entries[0]
    if (!entry) return
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
    update({ current: entry.spec.id })
    if (options.syncUrl) {
      const url = new URL(win.location.href)
      url.searchParams.set("surface", entry.spec.id)
      if (url.href !== win.location.href) win.history.pushState(null, "", url)
    }
    await load(entry)
  }

  const fromUrl = () =>
    new URL(win.location.href).searchParams.get("surface") ?? options.initial ?? "system"
  const pop = () => {
    void show(fromUrl())
  }
  if (options.syncUrl) win.addEventListener("popstate", pop)
  void show(options.syncUrl ? fromUrl() : (options.initial ?? "system"))
  return {
    show,
    active: () => snapshot.current,
    destroy() {
      if (destroyed) return
      destroyed = true
      controller.abort()
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
