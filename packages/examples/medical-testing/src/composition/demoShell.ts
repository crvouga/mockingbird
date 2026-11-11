import { scopeReset } from "@crvouga/mockingbird-ui"
import type { MockAdmin } from "../adapters/admin.js"
import { type PastedLocation, type PasteFetch, pasteHtml } from "../client/pasteHtml.js"

const ADMIN_ORIGIN = "https://emulator.local"
const ADMIN_LOCATION: PastedLocation = {
  href: `${ADMIN_ORIGIN}/__admin/ui`,
  origin: ADMIN_ORIGIN,
  pathname: "/__admin/ui",
  search: "",
  hash: "",
}

/** Relative admin calls stay in-process. Absolute catalog URLs use the network. */
const adminFetch = (fetchImpl: MockAdmin["fetch"]): PasteFetch => {
  return (input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const url = new URL(raw, `${ADMIN_ORIGIN}/`)
    if (url.origin !== ADMIN_ORIGIN) return fetch(input, init)
    return fetchImpl(new Request(url, init))
  }
}

const STYLES = `
${scopeReset(".demo-shell")}
.demo-shell {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: var(--bg, #fff);
  color: var(--fg, #111);
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
.demo-tabs {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
  overflow-x: auto;
  min-height: 56px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border, #e7e7ea);
  background: var(--bg, #fff);
}
.demo-tabs button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  border: 0;
  background: transparent;
  color: var(--fg-muted, #5c5c66);
  border-radius: 999px;
  height: 36px;
  padding: 0 14px;
  font: inherit;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
}
.demo-tabs button:hover { color: var(--fg, #111); }
.demo-tabs button[aria-selected="true"] {
  background: var(--bg-subtle, #f4f4f5);
  color: var(--fg, #111);
  font-weight: 600;
  box-shadow: inset 0 -2px 0 var(--accent, #5b4fe0);
}
.demo-tabs button:focus-visible { outline: 2px solid var(--accent, #5b4fe0); outline-offset: 2px; }
.demo-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  margin-left: 6px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--accent, #5b4fe0);
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.demo-badge[hidden] { display: none; }
.demo-notifications { flex: 1; width: 100%; height: 100%; min-height: 0; overflow: auto; }
.demo-stage { position: relative; flex: 1; min-height: 0; min-width: 0; }
.demo-panel { position: absolute; inset: 0; display: flex; flex-direction: column; min-width: 0; }
.demo-panel[hidden] { display: none !important; }
.demo-panel > .cove-app { height: 100%; }
.demo-frame { flex: 1; width: 100%; height: 100%; min-height: 0; overflow: auto; background: var(--bg, #fff); }
.demo-status { margin: 24px; color: var(--fg-muted, #5c5c66); font-size: 13.5px; }
.demo-retry { margin: 0 24px; padding: 8px 12px; align-self: flex-start; cursor: pointer; }
.demo-error { color: var(--danger, #a33b32); }
`

const installStyles = (): void => {
  if (document.getElementById("cove-demo-shell")) return
  const style = document.createElement("style")
  style.id = "cove-demo-shell"
  style.textContent = STYLES
  document.head.appendChild(style)
}

const BADGE_POLL_MS = 1_500

/**
 * The fullscreen example: the app, the notifications it sent, and one shared
 * UI that fronts every independent admin API it uses. Tabs and panels carry
 * `data-testid="demo-tab-<id>"` / `"demo-panel-<id>"` for end-to-end tests.
 */
export const mountDemoShell = (
  host: HTMLElement,
  options: {
    mountApp: (panel: HTMLElement) => () => void
    admin: Pick<MockAdmin, "fetch">
    /** Mounts the notification harness UI into its panel the first time the tab opens. */
    mountNotifications?: (panel: HTMLElement) => () => void
    /** How many notifications exist now; drives the tab's unread badge. */
    notificationCount?: () => Promise<number>
  },
): (() => void) => {
  installStyles()
  host.style.position = "relative"
  host.style.overflow = "hidden"

  const shell = document.createElement("div")
  shell.className = "demo-shell"
  const tabs = document.createElement("div")
  tabs.className = "demo-tabs"
  tabs.setAttribute("role", "tablist")
  tabs.setAttribute("aria-label", "Example app and the services it is using")
  const stage = document.createElement("div")
  stage.className = "demo-stage"
  shell.append(tabs, stage)
  host.append(shell)

  const tabPrefix = `demo-${crypto.randomUUID()}`
  const panels = new Map<string, HTMLElement>()
  const buttons: HTMLButtonElement[] = []
  let selected = "app"
  let adminTicket = 0
  let unpaste: (() => void) | undefined
  let adminLoading: Promise<void> | undefined
  let unmountNotifications: (() => void) | undefined
  let badgeTimer: ReturnType<typeof setInterval> | undefined
  let seenCount = 0
  let latestCount = 0

  const addTab = (id: string, label: string): HTMLElement => {
    const button = document.createElement("button")
    button.type = "button"
    button.setAttribute("role", "tab")
    button.id = `${tabPrefix}-tab-${id}`
    button.setAttribute("aria-controls", `${tabPrefix}-panel-${id}`)
    button.dataset.demoTab = id
    button.dataset.testid = `demo-tab-${id}`
    button.textContent = label
    button.setAttribute("aria-selected", "false")
    button.tabIndex = -1
    tabs.append(button)
    buttons.push(button)
    const panel = document.createElement("div")
    panel.id = `${tabPrefix}-panel-${id}`
    panel.setAttribute("aria-labelledby", button.id)
    panel.className = "demo-panel"
    panel.dataset.demoPanel = id
    panel.dataset.testid = `demo-panel-${id}`
    panel.setAttribute("role", "tabpanel")
    panel.hidden = true
    stage.append(panel)
    panels.set(id, panel)
    return panel
  }

  const appPanel = addTab("app", "Example")
  const appRoot = document.createElement("div")
  appPanel.append(appRoot)
  const unmountApp = options.mountApp(appRoot)
  const notificationsPanel = options.mountNotifications
    ? addTab("notifications", "Notifications")
    : undefined
  addTab("admin", "Emulators")

  const badge = document.createElement("span")
  badge.className = "demo-badge"
  badge.dataset.testid = "demo-notifications-badge"
  badge.hidden = true
  buttons.find((button) => button.dataset.demoTab === "notifications")?.append(badge)

  const renderBadge = (): void => {
    const unread = selected === "notifications" ? 0 : Math.max(0, latestCount - seenCount)
    badge.hidden = unread === 0
    badge.textContent = unread > 99 ? "99+" : String(unread)
    badge.setAttribute("aria-label", `${unread} new`)
  }

  const refreshBadge = async (): Promise<void> => {
    if (!options.notificationCount) return
    try {
      latestCount = await options.notificationCount()
      if (selected === "notifications") seenCount = latestCount
      renderBadge()
    } catch {
      // The badge is a nicety; the panel shows the harness's own errors.
    }
  }
  if (notificationsPanel && options.notificationCount) {
    void refreshBadge()
    badgeTimer = setInterval(() => void refreshBadge(), BADGE_POLL_MS)
  }

  const showNotifications = (): void => {
    if (unmountNotifications || !notificationsPanel || !options.mountNotifications) return
    const root = document.createElement("div")
    root.className = "demo-notifications"
    root.setAttribute("role", "region")
    root.setAttribute("aria-label", "Notifications the example sent")
    notificationsPanel.replaceChildren(root)
    try {
      unmountNotifications = options.mountNotifications(root)
    } catch (error) {
      showStatus(notificationsPanel, error instanceof Error ? error.message : String(error), true)
    }
  }

  const showStatus = (panel: HTMLElement, text: string, isError = false): void => {
    panel.replaceChildren()
    const status = document.createElement("p")
    status.className = isError ? "demo-status demo-error" : "demo-status"
    status.textContent = text
    status.setAttribute("role", isError ? "alert" : "status")
    panel.append(status)
  }

  const showAdmin = (): Promise<void> => {
    if (unpaste) return Promise.resolve()
    if (adminLoading) return adminLoading
    const panel = panels.get("admin")
    if (!panel) return Promise.resolve()
    const ticket = ++adminTicket
    showStatus(panel, "Loading emulator administration…")
    adminLoading = (async () => {
      try {
        const response = await options.admin.fetch(new Request(`${ADMIN_ORIGIN}/__admin/ui`))
        const html = await response.text()
        if (ticket !== adminTicket) return
        if (!response.ok) throw new Error(`Emulator admin returned ${response.status}`)
        const frame = document.createElement("div")
        frame.className = "demo-frame"
        frame.setAttribute("role", "region")
        frame.setAttribute("aria-label", "Emulator administration")
        panel.replaceChildren(frame)
        unpaste = pasteHtml(frame, html, {
          fetch: adminFetch(options.admin.fetch),
          location: ADMIN_LOCATION,
        })
      } catch (error) {
        if (ticket !== adminTicket) return
        showStatus(panel, error instanceof Error ? error.message : String(error), true)
        const retry = document.createElement("button")
        retry.type = "button"
        retry.className = "demo-retry"
        retry.textContent = "Try again"
        retry.addEventListener("click", () => {
          adminLoading = undefined
          void showAdmin()
        })
        panel.append(retry)
      } finally {
        adminLoading = undefined
      }
    })()
    return adminLoading
  }

  const select = (id: string): void => {
    selected = id
    for (const button of buttons) {
      const on = button.dataset.demoTab === id
      button.setAttribute("aria-selected", String(on))
      button.tabIndex = on ? 0 : -1
      if (on) button.scrollIntoView({ inline: "nearest", block: "nearest" })
    }
    for (const [panelId, panel] of panels) panel.hidden = panelId !== id
    if (id === "admin") void showAdmin()
    if (id === "notifications") {
      seenCount = latestCount
      showNotifications()
    }
    renderBadge()
  }

  tabs.addEventListener("click", (event) => {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>("[data-demo-tab]")
    if (!button?.dataset.demoTab) return
    select(button.dataset.demoTab)
    button.focus()
  })
  tabs.addEventListener("keydown", (event) => {
    if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return
    const current = buttons.findIndex((button) => button.dataset.demoTab === selected)
    if (current < 0) return
    event.preventDefault()
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : (current + (event.key === "ArrowRight" ? 1 : buttons.length - 1)) % buttons.length
    const button = buttons[next]
    if (!button?.dataset.demoTab) return
    select(button.dataset.demoTab)
    button.focus()
  })

  select("app")

  return () => {
    adminTicket++
    if (badgeTimer) clearInterval(badgeTimer)
    unpaste?.()
    unmountNotifications?.()
    unmountApp()
    shell.remove()
  }
}
