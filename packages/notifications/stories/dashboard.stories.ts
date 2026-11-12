import type { Meta, StoryObj } from "@storybook/html-vite"
import { type DashboardOptions, mountDashboard } from "../src/ui/dashboard.js"
import { renderPage } from "../src/ui/page.js"
import { base, everything } from "./fixtures.js"

/**
 * The dashboard shell `mountDashboard` draws: a tab bar over the emulators' admin UI and the
 * notifications UI, as the harness page and the fleet console embed it. The Emulators tab here
 * holds a stand-in panel; the admin UI itself is catalogued in the main catalog under Admin.
 */
const meta: Meta<DashboardOptions> = {
  title: "Harness/Dashboard",
  tags: ["vp-desktop"],
  render: (options) => {
    const host = document.createElement("div")
    host.style.height = "100vh"
    mountDashboard(host, options)
    return host
  },
}
export default meta
type Story = StoryObj<DashboardOptions>

const all = everything()

const emulators = {
  mount: (panel: HTMLElement) => {
    panel.innerHTML =
      '<div style="padding:24px;font:14px system-ui;color:#c7c7cc">The emulators\' admin UI mounts here.</div>'
  },
}

export const NotificationsTab: Story = {
  args: { title: "Mockingbird", emulators, notifications: base(all), initialTab: "notifications" },
}

export const EmulatorsTab: Story = {
  args: { title: "Mockingbird", emulators, notifications: base(all), initialTab: "emulators" },
}

/** `theme: "light"` for embedders with a light page. */
export const LightTheme: Story = {
  args: { title: "Mockingbird", emulators, notifications: base(all), theme: "light" },
}

/** An embedder's own tabs come first, before Emulators and Notifications. */
export const WithEmbedderTabs: Story = {
  args: {
    title: "Acme dev console",
    tabs: [
      {
        id: "logs",
        label: "Logs",
        mount: (panel) => {
          panel.innerHTML =
            '<pre style="padding:16px;color:#c7c7cc">GET /v1/customers 200 4ms</pre>'
        },
      },
    ],
    emulators,
    notifications: base(all),
    initialTab: "logs",
  },
}

/** Notifications only, no title: a bar of tabs alone. */
export const NotificationsOnly: Story = { args: { notifications: base(all) } }

/**
 * The harness page as served, before its script draws: `renderPage`'s shell and boot message.
 * (Its script, `src/ui/browser.ts`, mounts the dashboard the stories above draw.)
 */
export const ShellBeforeBoot: StoryObj = {
  render: () => {
    const iframe = document.createElement("iframe")
    iframe.style.cssText = "display:block;width:100%;height:100vh;border:0"
    iframe.srcdoc = renderPage({ title: "Notifications" }).replace(
      '<script type="module" src="./ui.js"></script>',
      "",
    )
    return iframe
  },
}
