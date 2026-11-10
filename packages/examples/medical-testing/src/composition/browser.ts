import { mountNotifications } from "@crvouga/mockingbird-notifications/ui"
import { setFetcher } from "../client/api.js"
import { mountApp } from "../client/main.js"
import { STYLES } from "../client/theme.js"
import { buildDemo } from "./build.js"
import { mountDemoShell } from "./demoShell.js"
import { createInProcessFetcher } from "./inProcessFetcher.js"

export { createInProcessFetcher }

const NO_CLIENT_ASSETS = { html: "", js: "" }

/**
 * Boots a fresh in-process instance of the whole app and mounts the SPA
 * into `host`. Everything below runs in this JS heap — no server to start,
 * no real network call anywhere, including to any third-party provider.
 *
 * `setFetcher` is a module-level global in client/api.ts, so only mount one
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

  const unmountShell = mountDemoShell(host, {
    admin: demo.admin,
    mountApp: (panel) => mountApp(panel, true),
    mountNotifications: (panel) => {
      const ui = mountNotifications(panel, {
        harness: demo.notifications,
        title: "Cove notifications",
      })
      return () => ui.destroy()
    },
    notificationCount: async () => (await demo.notifications.list()).length,
  })
  return () => {
    unmountShell()
    demo.notifications.close()
  }
}
