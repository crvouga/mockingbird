/// <reference lib="dom" />
/**
 * The harness page's entry, bundled into `/ui.js` (`packages/ui/scripts/bundle.ts --client`). With
 * emulator admin APIs behind the harness (`GET api/admin`) it mounts the dashboard, Emulators and
 * Notifications tabs; otherwise the notifications UI alone, in the same shell. The page already
 * carries the stylesheets (`page.ts`).
 */
import { THEME_STORAGE_KEY } from "@crvouga/mockingbird-ui/react"
import { type AdminInfo, mountHarnessPage } from "./mount.js"

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

/** The shared admin UI in a shadow root, so it keeps its styles to itself. */
const mountAdmin = (panel: HTMLElement, config: unknown) =>
  new Promise<() => void>((resolve, reject) => {
    const frame = document.createElement("div")
    frame.style.cssText = "color-scheme:light dark"
    const root = document.createElement("main")
    root.id = "admin-root"
    root.setAttribute("data-mockingbird-admin", "")
    root.style.cssText = "display:block"
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

/** The light or dark choice made with the theme switch on any Mockingbird page of this origin. */
const applyStoredTheme = () => {
  try {
    const theme = localStorage.getItem(THEME_STORAGE_KEY)
    if (theme !== "light" && theme !== "dark") return
    document.documentElement.classList.add(theme)
    document.documentElement.dataset.theme = theme
  } catch {}
}

const start = async () => {
  applyStoredTheme()
  mountHarnessPage(host, {
    title: host.dataset.title ?? "Notifications",
    defaultTab: host.dataset.defaultTab ?? "notifications",
    info: await readAdmin(),
    mountAdmin,
  })
}

void start()
