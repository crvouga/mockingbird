import { mountSystemHarness, SYSTEM_ICONS, type SystemBuild } from "@crvouga/mockingbird-ui"
import { MOCKINGBIRD_CSS } from "@crvouga/mockingbird-ui/styles"
import { setFetcher } from "../client/api.js"
import { setInboxOpener } from "../client/inbox.js"
import { mountApp } from "../client/main.js"
import { buildDemo } from "./build.js"
import { createLabDevResources, DEV_DOCS_URL } from "./dev.js"
import { createInProcessFetcher } from "./inProcessFetcher.js"

export { createInProcessFetcher }

const NO_CLIENT_ASSETS = { html: "", js: "" }

/** The app's own mark, a plus, for its row in the switcher. */
const LAB_ICON = {
  svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
}

/** Mount one browser-local system. Only one lab instance may be mounted per document:
 * the existing client's fetch and inbox ports are module-scoped.
 */
export const mount = async (
  host: HTMLElement,
  options: {
    syncUrl?: boolean
    /** The dev proxy, absolute or relative to this page. Without it every service stays emulated. */
    devProxyUrl?: string
    /** The preview's live build status and updates (the boot loader in `preview.ts`). */
    build?: SystemBuild
  } = {},
): Promise<() => void> => {
  const dev = createLabDevResources(options.devProxyUrl)
  const demo = await buildDemo(NO_CLIENT_ASSETS, dev.upstream ? { upstream: dev.upstream } : {})
  setFetcher(createInProcessFetcher(demo.app))

  // The design system's stylesheet, once per document: the app is React and HeroUI, drawn with
  // the same tokens as the System screen around it.
  const styleId = "mockingbird-example-styles"
  if (!document.getElementById(styleId)) {
    const style = document.createElement("style")
    style.id = styleId
    style.textContent = MOCKINGBIRD_CSS
    document.head.appendChild(style)
  }

  let notifications: import("@crvouga/mockingbird-notifications/ui").AppHandle | undefined
  const dashboard = mountSystemHarness(
    host,
    [
      {
        id: "app",
        label: "Lab workspace",
        icon: LAB_ICON,
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
        icon: SYSTEM_ICONS.emulators,
        description: "The admin UI of every emulator: state, requests, clock, faults and SQL.",
        mount: async (panel) => {
          const { mountEmulatorsPanel } = await import("./emulatorsPanel.js")
          return mountEmulatorsPanel(panel, demo.admin)
        },
      },
      {
        id: "notifications",
        label: "Notifications",
        icon: SYSTEM_ICONS.notifications,
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
      services: dev.controls(demo.admins),
      docsUrl: DEV_DOCS_URL,
      ...(options.build ? { build: options.build } : {}),
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
