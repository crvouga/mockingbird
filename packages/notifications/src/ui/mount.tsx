/// <reference lib="dom" />
/**
 * Mounting the harness UI on an element: `createApp` (the notifications UI), `mountDashboardOn`
 * (the dashboard) and `mountHarnessPage` (what the harness's own page runs). These render with
 * React into the host and hand back plain handles. They add no stylesheet: the page, or `embed.tsx`
 * for an embedder, brings Mockingbird's stylesheet and the device skins.
 */
import { MockingbirdProvider, StatusChip } from "@crvouga/mockingbird-ui/react"
import { ArrowUpRightFromSquare } from "@gravity-ui/icons"
import { Link } from "@heroui/react"
import type { ReactNode } from "react"
import { flushSync } from "react-dom"
import { createRoot, type Root } from "react-dom/client"
import { NotificationsApp } from "./app.js"
import { DASHBOARD_ROOT_CLASS, Dashboard, NotificationsPage } from "./dashboard.js"
import { createDashboardModel, NOTIFICATIONS_TAB } from "./dashboard-model.js"
import { createStore, type Store } from "./store.js"
import type {
  AppHandle,
  AppOptions,
  DashboardHandle,
  DashboardOptions,
  MountOptions,
} from "./types.js"

const THEMES = { dark: "dark", light: "light", auto: "system" } as const

/** Render `element` into `host`, synchronously, so the handle's elements exist on return. */
const render = (host: HTMLElement, element: ReactNode): Root => {
  host.replaceChildren()
  const root = createRoot(host)
  flushSync(() => root.render(element))
  return root
}

const handleFor = (store: Store, destroy: () => void): AppHandle => ({
  render: store.emit,
  state: store.state,
  ready: store.ready,
  show: store.handle.show,
  setNamespace: store.handle.setNamespace,
  setSound: store.handle.setSound,
  setScale: store.handle.setScale,
  destroy,
})

/**
 * The notifications UI on `host`. Live, it reads a harness through `fetch` (an in-process
 * harness's Fetch handler, or HTTP) and follows its event stream; otherwise it draws the
 * notifications it is given, which is how the Storybook catalog shows every state.
 */
export function createApp(host: HTMLElement, options: AppOptions = {}): AppHandle {
  const title = options.title ?? host.dataset.title
  const store = createStore(title ? { ...options, title } : options)
  store.start()
  const root = render(
    host,
    <MockingbirdProvider {...(options.embedded ? { className: "h-full" } : {})}>
      <NotificationsApp store={store} />
    </MockingbirdProvider>,
  )
  let destroyed = false
  return handleFor(store, () => {
    if (destroyed) return
    destroyed = true
    store.destroy()
    root.unmount()
    host.replaceChildren()
  })
}

/** `MountOptions` as the store takes them: the harness becomes the transport. */
export const storeOptions = (options: MountOptions): AppOptions => {
  const { harness, injectStyles: _injectStyles, ...rest } = options
  return harness ? { ...rest, fetch: (request) => harness.fetch(request) } : rest
}

/** The dashboard on `host` (see `mountDashboard`), without adding stylesheets. */
export function mountDashboardOn(
  host: HTMLElement,
  options: DashboardOptions,
  extra: { actions?: ReactNode } = {},
): DashboardHandle {
  const model = createDashboardModel(options)
  let store: Store | undefined
  if (options.notifications) {
    const { label: _label, onArrive: _onArrive, ...rest } = options.notifications
    store = createStore({
      syncUrl: false,
      ...storeOptions(rest),
      onArrive: (added) => model.arrive(added),
    })
    store.start()
  }
  let aside: HTMLElement | null = null
  host.classList.add(DASHBOARD_ROOT_CLASS)
  const root = render(
    host,
    <MockingbirdProvider theme={THEMES[options.theme ?? "auto"]} className="h-full overflow-auto">
      <Dashboard
        model={model}
        {...(store ? { store } : {})}
        title={options.title ?? "Notifications"}
        asideRef={(el) => {
          aside = el ?? aside
        }}
        actions={extra.actions}
      />
    </MockingbirdProvider>,
  )
  let destroyed = false
  const destroy = () => {
    if (destroyed) return
    destroyed = true
    model.destroy()
    store?.destroy()
    root.unmount()
    host.replaceChildren()
    host.classList.remove(DASHBOARD_ROOT_CLASS)
  }
  return {
    show: model.show,
    active: model.active,
    tabs: model.tabs,
    aside: aside ?? document.createElement("div"),
    // Destroying the notifications UI alone stops its reads; the tab stays until the dashboard goes.
    ...(store ? { notifications: handleFor(store, () => store?.destroy()) } : {}),
    destroy,
  }
}

/** What the harness page learns from `GET api/admin`. */
export type AdminInfo = {
  /** What `MockingbirdAdmin.mount` takes. */
  admin: Record<string, unknown> | null
  emulators: { name: string; target: string }[]
  fleet: { adminBase: string; consoleUrl: string } | null
}

/**
 * The harness's own page. With emulator admin APIs behind the harness it is the dashboard
 * (Emulators and Notifications tabs); otherwise the notifications UI alone, in the same shell.
 */
export function mountHarnessPage(
  host: HTMLElement,
  page: {
    title: string
    defaultTab: string
    info: AdminInfo | null
    mountAdmin: (panel: HTMLElement, config: unknown) => Promise<() => void>
  },
): void {
  const { info, title } = page
  if (!info?.admin) {
    const store = createStore({ live: true })
    store.start()
    render(
      host,
      <MockingbirdProvider>
        <NotificationsPage store={store} title={title} />
      </MockingbirdProvider>,
    )
    return
  }
  const params = new URLSearchParams(location.search)
  // A link written for the notifications page (`?view=sms&to=…`) still opens on it.
  const deepLink = ["view", "to", "from", "id"].some((key) => params.has(key))
  const config = info.admin
  const count = info.emulators.length
  mountDashboardOn(
    host,
    {
      title,
      syncUrl: true,
      initialTab: deepLink ? NOTIFICATIONS_TAB : page.defaultTab,
      emulators: { mount: (panel) => page.mountAdmin(panel, config) },
      notifications: { syncUrl: true, baseUrl: location.href },
    },
    {
      actions: (
        <>
          <span className="max-sm:hidden">
            <StatusChip status="ok" dot>
              {count} emulator{count === 1 ? "" : "s"}
            </StatusChip>
          </span>
          {info.fleet ? (
            <Link
              href={info.fleet.consoleUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-sm"
            >
              Fleet console
              <ArrowUpRightFromSquare className="size-3.5" />
            </Link>
          ) : null}
        </>
      ),
    },
  )
}
