/**
 * The dashboard's tabs, framework-free: which tab is open, which have been drawn, what arrived on
 * the Notifications tab while another was open, and the `?tab=` link. `dashboard.tsx` draws it
 * with the shared Mockingbird shell and HeroUI tabs.
 *
 * A tab is drawn the first time it is shown (its `mount` gets an element to draw into) and stays
 * drawn, so switching away keeps its state; `destroy` disposes every one.
 */
import type { Notification } from "../model.js"
import type { DashboardMount, DashboardOptions } from "./types.js"

export const EMULATORS_TAB = "emulators"
export const NOTIFICATIONS_TAB = "notifications"

type Dispose = () => void

export type DashboardEntry = {
  id: string
  label: string
  /** `null` for the Notifications tab, which the dashboard draws itself. */
  mount: DashboardMount | null
  mounted: boolean
  dispose: Dispose | null
  panel: HTMLElement | null
  /** While an async `mount` runs, or after one failed. */
  status: { kind: "loading" } | { kind: "error"; message: string } | null
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

export type DashboardModel = ReturnType<typeof createDashboardModel>

export function createDashboardModel(options: DashboardOptions) {
  const specs: { id: string; label: string; mount: DashboardMount | null }[] = [
    ...(options.tabs ?? []),
    ...(options.emulators
      ? [
          {
            id: EMULATORS_TAB,
            label: options.emulators.label ?? "Emulators",
            mount: options.emulators.mount,
          },
        ]
      : []),
    ...(options.notifications
      ? [
          {
            id: NOTIFICATIONS_TAB,
            label: options.notifications.label ?? "Notifications",
            mount: null,
          },
        ]
      : []),
  ]
  if (specs.length === 0) throw new Error("mountDashboard: pass tabs, emulators or notifications")
  const seen = new Set<string>()
  for (const spec of specs) {
    if (seen.has(spec.id)) throw new Error(`mountDashboard: duplicate tab id ${spec.id}`)
    seen.add(spec.id)
  }

  const entries: DashboardEntry[] = specs.map((spec) => ({
    ...spec,
    // The notifications UI is drawn up front, shown or not: it is what counts arrivals.
    mounted: spec.mount === null,
    dispose: null,
    panel: null,
    status: null,
  }))
  let current = ""
  let unread = 0
  let destroyed = false
  let version = 0
  const listeners = new Set<() => void>()
  const emit = () => {
    version++
    for (const listener of [...listeners]) listener()
  }

  const mountEntry = (entry: DashboardEntry) => {
    if (entry.mounted || !entry.mount || !entry.panel || destroyed) return
    entry.mounted = true
    const settle = (result: unknown) => {
      if (typeof result !== "function") return
      const dispose = result as Dispose
      if (destroyed) dispose()
      else entry.dispose = dispose
    }
    try {
      const result = entry.mount(entry.panel)
      if (!(result instanceof Promise)) return settle(result)
      entry.status = { kind: "loading" }
      emit()
      result.then(
        (dispose) => {
          entry.status = null
          settle(dispose)
          emit()
        },
        (error: unknown) => {
          entry.status = destroyed ? null : { kind: "error", message: message(error) }
          emit()
        },
      )
    } catch (error) {
      entry.status = { kind: "error", message: message(error) }
      emit()
    }
  }

  const show = (id: string) => {
    const next = entries.find((entry) => entry.id === id)
    if (!next || destroyed || id === current) return
    const first = current === ""
    current = id
    if (id === NOTIFICATIONS_TAB) unread = 0
    mountEntry(next)
    if (options.syncUrl && typeof location !== "undefined" && typeof history !== "undefined") {
      const url = new URL(location.href)
      if (url.searchParams.get("tab") !== id && !(first && !url.searchParams.has("tab"))) {
        url.searchParams.set("tab", id)
        history.replaceState(history.state, "", url)
      }
    }
    emit()
    if (!first) options.onTabChange?.(id)
  }

  const fromUrl =
    options.syncUrl && typeof location !== "undefined"
      ? new URL(location.href).searchParams.get("tab")
      : null
  const wanted = [fromUrl, options.initialTab].find(
    (id) => id != null && entries.some((entry) => entry.id === id),
  )
  show(wanted ?? (entries[0] as DashboardEntry).id)

  return {
    entries,
    show,
    active: () => current,
    tabs: () => entries.map((entry) => entry.id),
    /** Notifications that arrived while another tab was open. */
    unread: () => unread,
    /** The element a tab draws into, once it exists: draws the tab if it is the open one. */
    attach(id: string, panel: HTMLElement | null) {
      const entry = entries.find((e) => e.id === id)
      if (!entry || entry.panel === panel) return
      entry.panel = panel
      if (panel && id === current) mountEntry(entry)
    },
    /** The notifications UI's `onArrive`: counts arrivals for the badge, then the embedder's own. */
    arrive(added: Notification[]) {
      if (current !== NOTIFICATIONS_TAB) {
        unread += added.length
        emit()
      }
      options.notifications?.onArrive?.(added)
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getVersion: () => version,
    get destroyed() {
      return destroyed
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      for (const entry of entries) {
        try {
          entry.dispose?.()
        } catch {}
        entry.dispose = null
      }
      listeners.clear()
    },
  }
}
