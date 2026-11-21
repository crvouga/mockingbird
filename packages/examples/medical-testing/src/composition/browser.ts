import { mountSystemHarness } from "@crvouga/mockingbird-ui"
import { setFetcher } from "../client/api.js"
import { setInboxOpener } from "../client/inbox.js"
import { mountApp } from "../client/main.js"
import { STYLES } from "../client/theme.js"
import { buildDemo } from "./build.js"
import { createInProcessFetcher } from "./inProcessFetcher.js"
import { createLabSandbox, SANDBOX_DOCS_URL } from "./sandbox.js"

export { createInProcessFetcher }

const NO_CLIENT_ASSETS = { html: "", js: "" }

/** Mount one browser-local system. Only one lab instance may be mounted per document:
 * the existing client's fetch and inbox ports are module-scoped.
 */
export const mount = async (
  host: HTMLElement,
  options: {
    syncUrl?: boolean
    /** The sandbox proxy, absolute or relative to this page. Without it every service stays emulated. */
    sandboxProxyUrl?: string
  } = {},
): Promise<() => void> => {
  const sandbox = createLabSandbox(options.sandboxProxyUrl)
  const demo = await buildDemo(
    NO_CLIENT_ASSETS,
    sandbox.upstream ? { upstream: sandbox.upstream } : {},
  )
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
        description: "The patient, clinician and admin app, signed out and seeded with demo data.",
        mount: (panel) => {
          const root = document.createElement("div")
          panel.append(root)
          return mountApp(root, true)
        },
      },
      {
        id: "emulators",
        label: "Emulators",
        description: "The admin UI of every emulator: state, requests, clock, faults and SQL.",
        mount: async (panel) => {
          const { mountEmulatorsPanel } = await import("./emulatorsPanel.js")
          return mountEmulatorsPanel(panel, demo.admin)
        },
      },
      {
        id: "notifications",
        label: "Notifications",
        description:
          "Every email, text, push and staff chat message the app sent, on lifelike devices.",
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
    {
      initial: "app",
      syncUrl: options.syncUrl ?? false,
      services: sandbox.controls(demo.admins),
      docsUrl: SANDBOX_DOCS_URL,
    },
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
