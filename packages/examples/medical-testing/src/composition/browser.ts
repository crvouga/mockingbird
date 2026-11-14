import { mountSystemHarness } from "@crvouga/mockingbird-ui"
import { setFetcher } from "../client/api.js"
import { setInboxOpener } from "../client/inbox.js"
import { mountApp } from "../client/main.js"
import { STYLES } from "../client/theme.js"
import { buildDemo } from "./build.js"
import { createInProcessFetcher } from "./inProcessFetcher.js"

export { createInProcessFetcher }

const NO_CLIENT_ASSETS = { html: "", js: "" }

/** Mount one browser-local system. Only one lab instance may be mounted per document:
 * the existing client's fetch and inbox ports are module-scoped.
 */
export const mount = async (
  host: HTMLElement,
  options: { syncUrl?: boolean } = {},
): Promise<() => void> => {
  const demo = await buildDemo(NO_CLIENT_ASSETS)
  setFetcher(createInProcessFetcher(demo.app))

  const styleId = "cove-app-styles"
  if (!document.getElementById(styleId)) {
    const style = document.createElement("style")
    style.id = styleId
    style.textContent = STYLES
    document.head.appendChild(style)
  }

  let notifications: import("@crvouga/mockingbird-notifications/ui").AppHandle | undefined
  const dashboard = mountSystemHarness(
    host,
    [
      {
        id: "app",
        label: "Lab workspace",
        mount: (panel) => {
          const root = document.createElement("div")
          panel.append(root)
          return mountApp(root, true)
        },
      },
      {
        id: "emulators",
        label: "Emulators",
        mount: async (panel) => {
          const { mountEmulatorsPanel } = await import("./emulatorsPanel.js")
          return mountEmulatorsPanel(panel, demo.admin)
        },
      },
      {
        id: "notifications",
        label: "Notifications",
        mount: async (panel) => {
          const { mountNotifications } = await import("@crvouga/mockingbird-notifications/ui")
          notifications = mountNotifications(panel, {
            harness: demo.notifications,
            title: "Cove notifications",
          })
          return () => notifications?.destroy()
        },
      },
    ],
    { initial: "app", syncUrl: options.syncUrl ?? false },
  )
  setInboxOpener((target) => {
    void dashboard.show("notifications").then(() => notifications?.show(target))
  })

  return () => {
    dashboard.destroy()
    demo.notifications.close()
    setInboxOpener(() => {})
    setFetcher((path, init) => fetch(path, init))
  }
}
