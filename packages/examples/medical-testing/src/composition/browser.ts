import { defineSystem, mountSystem, SYSTEM_ICONS, type SystemBuild } from "@crvouga/mockingbird-ui"
import { MOCKINGBIRD_CSS } from "@crvouga/mockingbird-ui/styles"
import { setFetcher } from "../client/api.js"
import { setInboxOpener } from "../client/inbox.js"
import { mountApp } from "../client/main.js"
import { followSignInLink } from "../client/signInLink.js"
import { buildDemo } from "./build.js"
import { createLabDevResources, DEV_DOCS_URL } from "./dev.js"
import { createInProcessFetcher } from "./inProcessFetcher.js"
import {
  API_READY,
  checkStripeKey,
  labBackends,
  labConfiguration,
  STRIPE_KEY_FIELDS,
  startupClock,
  withBrowserKey,
} from "./systemScreen.js"

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
  const clock = startupClock()
  const dev = createLabDevResources(options.devProxyUrl)
  // The emailed sign-in link points at this page, showing the app. A click on it in Notifications
  // is followed here, in the tab that issued it; pasted into the sign-in screen it works too.
  const signInPage = new URL(window.location.href)
  signInPage.search = ""
  signInPage.hash = ""
  signInPage.searchParams.set("surface", "app")
  const demo = await buildDemo(NO_CLIENT_ASSETS, {
    signInPage: signInPage.href,
    ...(dev.upstream ? { upstream: dev.upstream } : {}),
  })
  clock.mark("database and emulators")
  setFetcher(createInProcessFetcher(demo.app))
  clock.mark(API_READY)

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
  // The app registry: adding an app to this preview is one more entry here.
  const system = defineSystem({
    apps: [
      {
        id: "app",
        label: "Lab workspace",
        icon: LAB_ICON,
        description: "The patient, clinician and admin app, signed out and seeded with demo data.",
        part: {
          load: async () => ({
            mount: (panel) => {
              const root = document.createElement("div")
              panel.append(root)
              return mountApp(root, true)
            },
          }),
        },
      },
      {
        id: "emulators",
        label: "Emulators",
        icon: SYSTEM_ICONS.emulators,
        description: "The admin UI of every emulator: state, requests, clock, faults and SQL.",
        part: {
          load: async () => {
            const { mountEmulatorsPanel } = await import("./emulatorsPanel.js")
            return { mount: (panel) => mountEmulatorsPanel(panel, demo.admin) }
          },
        },
      },
      {
        id: "notifications",
        label: "Notifications",
        icon: SYSTEM_ICONS.notifications,
        description:
          "Every email, text, push and staff chat message the app sent, on lifelike devices.",
        part: {
          load: async () => {
            const { mountNotifications } = await import("@crvouga/mockingbird-notifications/ui")
            return {
              mount: (panel) => {
                notifications = mountNotifications(panel, {
                  harness: demo.notifications,
                  title: "Notifications",
                  shell: true,
                  openLink: (url) => {
                    if (!followSignInLink(url, signInPage.href)) return false
                    void dashboard.show("app")
                    return true
                  },
                })
                return () => notifications?.destroy()
              },
            }
          },
        },
      },
    ],
  })
  const dashboard = mountSystem(host, system, {
    initial: "app",
    syncUrl: options.syncUrl ?? false,
    // Stripe also takes a test key typed on the System screen, for previews with no dev proxy.
    services: withBrowserKey(dev.controls(demo.admins), {
      id: "stripe",
      fields: STRIPE_KEY_FIELDS,
      check: checkStripeKey,
    }),
    backends: labBackends(clock, demo.admins),
    sections: [labConfiguration({ devProxyUrl: options.devProxyUrl, keyed: ["stripe"] })],
    docsUrl: DEV_DOCS_URL,
    ...(options.build ? { build: options.build } : {}),
  })
  clock.mark("System mounted")
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
