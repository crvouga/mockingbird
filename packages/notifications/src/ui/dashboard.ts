/// <reference lib="dom" />
/**
 * One dashboard: a tab bar over the emulator admin dashboard and the notifications UI.
 *
 *   const dashboard = mountDashboard(host, {
 *     emulators: { mount: (panel) => mountAdmin(panel) },   // returns an optional dispose
 *     notifications: { harness },
 *   })
 *   dashboard.show("notifications")
 *   dashboard.destroy()
 *
 * The shell is plain DOM with no framework: the emulators panel is whatever `mount` draws. It adds
 * no inline script and evaluates nothing, so it runs under a strict Content-Security-Policy.
 */
import { TEST_IDS } from "../testids.js"
import type { AppHandle } from "./app.js"
import { DASHBOARD_ROOT_CLASS, DASHBOARD_STYLES } from "./dashboard-styles.js"
import { installStyles, type MountOptions, mountNotifications } from "./mount.js"

type Dispose = () => void
/** Returns nothing, a dispose function, or a promise of either. */
type Mount = (panel: HTMLElement) => unknown

export type DashboardTab = {
  /** Unique; also the `?tab=` value. `emulators` and `notifications` are taken. */
  id: string
  label: string
  /** Draw the tab into `panel`, the first time it is shown. May return a dispose function. */
  mount: Mount
}

export type DashboardOptions = {
  /** Shown at the start of the tab bar. Omit it for a bar of tabs only. */
  title?: string
  /** The embedder's own tabs, shown first. */
  tabs?: DashboardTab[]
  /** The emulator admin dashboard. `mount` may be async (for example, to load a script first). */
  emulators?: { label?: string; mount: Mount }
  /** The notifications UI: what `mountNotifications` takes, plus a tab label. */
  notifications?: MountOptions & { label?: string }
  /** The tab to open. `?tab=` wins over it when `syncUrl` is set. Default: the first tab. */
  initialTab?: string
  /** Read `?tab=` from the page URL and keep it current. Default false. */
  syncUrl?: boolean
  onTabChange?: (id: string) => void
  /** Tab bar colors. `auto` follows the viewer's color scheme. Default `dark`, like the notifications UI. */
  theme?: "dark" | "light" | "auto"
  /** Add the stylesheets to the host's document or shadow root. Default true. */
  injectStyles?: boolean
}

export type DashboardHandle = {
  /** Open a tab by id. Unknown ids are ignored. */
  show(id: string): void
  /** The id of the open tab. */
  active(): string
  /** Tab ids, in bar order. */
  tabs(): string[]
  /** An empty element at the end of the tab bar, for a status or a link. */
  aside: HTMLElement
  /** The notifications UI, when the dashboard has one. */
  notifications?: AppHandle
  /** Dispose every mounted tab, remove listeners and empty the host. */
  destroy(): void
}

export const EMULATORS_TAB = "emulators"
export const NOTIFICATIONS_TAB = "notifications"

type Entry = {
  id: string
  button: HTMLElement
  panel: HTMLElement
  mount: Mount | null
  mounted: boolean
  dispose: Dispose | null
}

const el = (tag: string, className: string, attrs: Record<string, string> = {}) => {
  const node = document.createElement(tag)
  node.className = className
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value)
  return node
}

let instances = 0

/** For tests: `mountDashboard` with the notifications mount supplied. */
export const createDashboard = (
  host: HTMLElement,
  options: DashboardOptions,
  mountUi: typeof mountNotifications,
): DashboardHandle => {
  const uid = `mbd-${++instances}`
  const specs: { id: string; label: string; mount: Mount | null }[] = [
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

  if (options.injectStyles ?? true)
    installStyles(host, "mockingbird-dashboard-styles", DASHBOARD_STYLES)
  host.classList.add(DASHBOARD_ROOT_CLASS)
  host.setAttribute("data-testid", TEST_IDS.dashboard)
  host.setAttribute("data-theme", options.theme ?? "dark")
  host.replaceChildren()

  const bar = el("header", "mbd-bar")
  if (options.title) {
    const brand = el("div", "mbd-brand")
    const mark = el("i", "mbd-mark", { "aria-hidden": "true" })
    mark.textContent = "◆"
    const name = el("span", "")
    name.textContent = options.title
    brand.append(mark, name)
    bar.append(brand)
  }
  const tablist = el("div", "mbd-tabs", {
    role: "tablist",
    "aria-label": options.title ?? "Dashboard",
  })
  const aside = el("div", "mbd-aside")
  const panels = el("div", "mbd-panels")
  bar.append(tablist, aside)
  host.append(bar, panels)

  const badge = el("span", "mbd-badge", { "data-testid": TEST_IDS.dashboardBadge })
  badge.hidden = true
  let unread = 0
  const drawBadge = () => {
    badge.hidden = unread === 0
    badge.textContent = unread > 99 ? "99+" : String(unread)
    badge.setAttribute("data-count", String(unread))
    badge.setAttribute("aria-label", `${unread} new`)
  }
  drawBadge()

  const entries: Entry[] = specs.map((spec) => {
    const button = el("button", "mbd-tab", {
      type: "button",
      role: "tab",
      id: `${uid}-tab-${spec.id}`,
      "aria-controls": `${uid}-panel-${spec.id}`,
      "aria-selected": "false",
      tabindex: "-1",
      "data-testid": TEST_IDS.dashboardTab,
      "data-tab": spec.id,
    })
    const label = el("span", "")
    label.textContent = spec.label
    button.append(label)
    if (spec.id === NOTIFICATIONS_TAB) button.append(badge)
    const panel = el("section", "mbd-panel", {
      role: "tabpanel",
      id: `${uid}-panel-${spec.id}`,
      "aria-labelledby": `${uid}-tab-${spec.id}`,
      "data-testid": TEST_IDS.dashboardPanel,
      "data-tab": spec.id,
    })
    panel.hidden = true
    tablist.append(button)
    panels.append(panel)
    return { id: spec.id, button, panel, mount: spec.mount, mounted: false, dispose: null }
  })

  let destroyed = false
  let current = ""

  const status = (entry: Entry, kind: "loading" | "error", text: string) => {
    const note = el("div", "mbd-status", { "data-kind": kind })
    note.textContent = text
    entry.panel.append(note)
    return note
  }

  const mountEntry = (entry: Entry) => {
    if (entry.mounted || !entry.mount) return
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
      entry.panel.setAttribute("aria-busy", "true")
      const loading = status(entry, "loading", "Loading…")
      result.then(
        (dispose) => {
          loading.remove()
          entry.panel.removeAttribute("aria-busy")
          settle(dispose)
        },
        (error: unknown) => {
          loading.remove()
          entry.panel.removeAttribute("aria-busy")
          if (!destroyed)
            status(entry, "error", error instanceof Error ? error.message : String(error))
        },
      )
    } catch (error) {
      status(entry, "error", error instanceof Error ? error.message : String(error))
    }
  }

  const show = (id: string) => {
    const next = entries.find((entry) => entry.id === id)
    if (!next || destroyed || id === current) return
    const first = current === ""
    current = id
    host.setAttribute("data-tab", id)
    for (const entry of entries) {
      const on = entry === next
      entry.button.setAttribute("aria-selected", String(on))
      entry.button.setAttribute("tabindex", on ? "0" : "-1")
      entry.panel.hidden = !on
    }
    if (id === NOTIFICATIONS_TAB) {
      unread = 0
      drawBadge()
    }
    mountEntry(next)
    if (options.syncUrl && typeof location !== "undefined" && typeof history !== "undefined") {
      const url = new URL(location.href)
      if (url.searchParams.get("tab") !== id && !(first && !url.searchParams.has("tab"))) {
        url.searchParams.set("tab", id)
        history.replaceState(history.state, "", url)
      }
    }
    if (!first) options.onTabChange?.(id)
  }

  const onClick = (entry: Entry) => () => show(entry.id)
  const onKey = (entry: Entry) => (event: Event) => {
    const key = (event as KeyboardEvent).key
    const at = entries.indexOf(entry)
    const to =
      key === "ArrowRight"
        ? (at + 1) % entries.length
        : key === "ArrowLeft"
          ? (at - 1 + entries.length) % entries.length
          : key === "Home"
            ? 0
            : key === "End"
              ? entries.length - 1
              : -1
    const target = entries[to]
    if (!target) return
    event.preventDefault()
    show(target.id)
    target.button.focus()
  }
  const unlisten: Dispose[] = entries.map((entry) => {
    const click = onClick(entry)
    const key = onKey(entry)
    entry.button.addEventListener("click", click)
    entry.button.addEventListener("keydown", key)
    return () => {
      entry.button.removeEventListener("click", click)
      entry.button.removeEventListener("keydown", key)
    }
  })

  // The notifications UI is mounted up front, hidden or not: it is what counts arrivals for the badge.
  let notifications: AppHandle | undefined
  const notificationsEntry = entries.find((entry) => entry.id === NOTIFICATIONS_TAB)
  if (options.notifications && notificationsEntry) {
    const { label: _label, onArrive, ...rest } = options.notifications
    notificationsEntry.mounted = true
    // In its own element: the UI writes `data-testid` and `data-tab` on its root, and the panel's must stay.
    const frame = el("div", "mbd-fill")
    notificationsEntry.panel.append(frame)
    notifications = mountUi(frame, {
      ...rest,
      onArrive(added) {
        if (current !== NOTIFICATIONS_TAB) {
          unread += added.length
          drawBadge()
        }
        onArrive?.(added)
      },
    })
  }

  const fromUrl =
    options.syncUrl && typeof location !== "undefined"
      ? new URL(location.href).searchParams.get("tab")
      : null
  const wanted = [fromUrl, options.initialTab].find(
    (id) => id != null && entries.some((entry) => entry.id === id),
  )
  show(wanted ?? (entries[0] as Entry).id)

  return {
    show,
    active: () => current,
    tabs: () => entries.map((entry) => entry.id),
    aside,
    ...(notifications ? { notifications } : {}),
    destroy() {
      if (destroyed) return
      destroyed = true
      for (const off of unlisten) off()
      notifications?.destroy()
      for (const entry of entries) {
        try {
          entry.dispose?.()
        } catch {}
        entry.dispose = null
      }
      host.replaceChildren()
      host.classList.remove(DASHBOARD_ROOT_CLASS)
      for (const name of ["data-testid", "data-theme", "data-tab"]) host.removeAttribute(name)
    },
  }
}

/**
 * Mount the dashboard inside `host`, which it fills: give the host a height. Tabs are, in order,
 * the embedder's `tabs`, Emulators, Notifications. A tab is drawn the first time it is shown and
 * stays mounted afterwards, so switching away keeps its state. The Notifications tab counts what
 * arrives while another tab is open.
 */
export const mountDashboard = (host: HTMLElement, options: DashboardOptions): DashboardHandle =>
  createDashboard(host, options, mountNotifications)
