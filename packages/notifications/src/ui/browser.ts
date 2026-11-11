/// <reference lib="dom" />
/**
 * The harness page's entry. With emulator admin APIs behind the harness (`GET api/admin`) it
 * mounts the dashboard, Emulators and Notifications tabs; otherwise the notifications UI alone.
 */
import { createApp } from "./app.js"
import { mountDashboard, NOTIFICATIONS_TAB } from "./dashboard.js"

type AdminInfo = {
  /** What `MockingbirdAdmin.mount` takes. */
  admin: Record<string, unknown> | null
  emulators: { name: string; target: string }[]
  fleet: { adminBase: string; consoleUrl: string } | null
}
type AdminGlobal = { mount(host: HTMLElement, config: unknown): unknown }

const host = document.getElementById("app") as HTMLElement

const readAdmin = async (): Promise<AdminInfo | null> => {
  try {
    const response = await fetch(new URL("api/admin", location.href))
    return response.ok ? ((await response.json()) as AdminInfo) : null
  } catch {
    return null
  }
}

/** The shared admin UI in a shadow root, so it sizes to the panel and keeps its styles to itself. */
const mountAdmin = (panel: HTMLElement, config: unknown) =>
  new Promise<() => void>((resolve, reject) => {
    const frame = document.createElement("div")
    frame.style.cssText = "height:100%;color-scheme:light dark"
    const root = document.createElement("main")
    root.id = "admin-root"
    root.setAttribute("data-mockingbird-admin", "")
    root.style.cssText = "display:block;height:100%;overflow:auto"
    frame.attachShadow({ mode: "open" }).append(root)
    panel.append(frame)
    const script = document.createElement("script")
    script.src = new URL("admin/ui.js", location.href).href
    script.onload = () => {
      const admin = (globalThis as { MockingbirdAdmin?: AdminGlobal }).MockingbirdAdmin
      if (!admin) return reject(new Error("The admin UI did not load."))
      const dispose = admin.mount(root, config)
      resolve(() => {
        if (typeof dispose === "function") dispose()
        else document.dispatchEvent(new Event("mockingbird:unmount"))
        frame.remove()
      })
    }
    script.onerror = () => reject(new Error("The admin UI could not be loaded."))
    document.head.append(script)
  })

const start = async () => {
  const info = await readAdmin()
  if (!info?.admin) {
    createApp(host, { live: true })
    return
  }
  const params = new URLSearchParams(location.search)
  // A link written for the notifications page (`?view=sms&to=…`) still opens on it.
  const deepLink = ["view", "to", "from", "id"].some((key) => params.has(key))
  document.documentElement.classList.add("mbd-page")
  const config = info.admin
  const dashboard = mountDashboard(host, {
    title: host.dataset.title ?? "Mockingbird",
    syncUrl: true,
    injectStyles: false,
    initialTab: deepLink ? NOTIFICATIONS_TAB : (host.dataset.defaultTab ?? NOTIFICATIONS_TAB),
    emulators: { mount: (panel) => mountAdmin(panel, config) },
    notifications: { syncUrl: true, baseUrl: location.href, injectStyles: false },
  })
  const count = document.createElement("span")
  count.className = "mbd-pill"
  const dot = document.createElement("i")
  dot.className = "mbd-dot"
  const number = document.createElement("b")
  number.textContent = String(info.emulators.length)
  count.append(dot, number, ` emulator${info.emulators.length === 1 ? "" : "s"}`)
  dashboard.aside.append(count)
  if (info.fleet) {
    const link = document.createElement("a")
    link.href = info.fleet.consoleUrl
    link.target = "_blank"
    link.rel = "noopener noreferrer"
    link.textContent = "Fleet console ↗"
    dashboard.aside.append(link)
  }
}

void start()
