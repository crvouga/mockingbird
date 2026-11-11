import { mountDashboard } from "@crvouga/mockingbird-notifications/ui"
import { setFetcher } from "../client/api.js"
import { setInboxOpener } from "../client/inbox.js"
import { mountApp } from "../client/main.js"
import { STYLES } from "../client/theme.js"
import { buildDemo } from "./build.js"
import { mountEmulatorsPanel } from "./emulatorsPanel.js"
import { createInProcessFetcher } from "./inProcessFetcher.js"

export { createInProcessFetcher }

const NO_CLIENT_ASSETS = { html: "", js: "" }

/** The dashboard's tab bar follows the page's `<html data-theme>` (the docs site sets it). */
const followPageTheme = (host: HTMLElement): (() => void) => {
  const root = document.documentElement
  const apply = (): void => {
    const theme = root.dataset.theme
    host.setAttribute("data-theme", theme === "light" || theme === "dark" ? theme : "auto")
  }
  apply()
  const observer = new MutationObserver(apply)
  observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] })
  return () => observer.disconnect()
}

/**
 * Boots a fresh in-process instance of the whole app and mounts it into
 * `host` as one dashboard with three tabs: the app itself (Example), the
 * admin UI of every emulator it talks to (Emulators), and every email, text,
 * push and staff chat message it sent (Notifications). Everything runs in
 * this JS heap: no server to start and no network call to any provider.
 *
 * Tabs and panels carry `data-testid="dashboard-tab"` / `"dashboard-panel"`
 * with `data-tab="app" | "emulators" | "notifications"`.
 *
 * `setFetcher` and `setInboxOpener` are module-level, so only mount one
 * instance of this app on a page at a time.
 */
export const mount = async (host: HTMLElement): Promise<() => void> => {
  const demo = await buildDemo(NO_CLIENT_ASSETS)
  setFetcher(createInProcessFetcher(demo.app))

  const styleId = "cove-app-styles"
  if (!document.getElementById(styleId)) {
    const style = document.createElement("style")
    style.id = styleId
    style.textContent = STYLES
    document.head.appendChild(style)
  }

  const dashboard = mountDashboard(host, {
    tabs: [
      {
        id: "app",
        label: "Example",
        mount: (panel) => {
          const root = document.createElement("div")
          panel.append(root)
          return mountApp(root, true)
        },
      },
    ],
    emulators: { mount: (panel) => mountEmulatorsPanel(panel, demo.admin) },
    notifications: { harness: demo.notifications, title: "Cove notifications" },
  })
  const unfollowTheme = followPageTheme(host)
  // "Open Notifications" in the app switches tabs and lands on the message's device.
  setInboxOpener((target) => {
    dashboard.show("notifications")
    dashboard.notifications?.show(target)
  })

  return () => {
    unfollowTheme()
    dashboard.destroy()
    demo.notifications.close()
  }
}
