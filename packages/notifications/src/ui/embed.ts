/// <reference lib="dom" />
/**
 * What `@crvouga/mockingbird-notifications/ui` runs: the harness UI mounted on an embedder's
 * element. Prebuilt with React and HeroUI inside (`packages/ui/scripts/bundle.ts --ssr`, into
 * `dist-ui/embed.js`), so an embedder installs neither; the stylesheet comes from
 * `@crvouga/mockingbird-ui/styles`, a dependency, and is added once to the host's document (or to
 * the shadow root the host is in).
 */
import { MOCKINGBIRD_CSS } from "@crvouga/mockingbird-ui/styles"
import { DASHBOARD_ROOT_CLASS } from "./dashboard.js"
import { createApp, mountDashboardOn, storeOptions } from "./mount.js"
import { ROOT_CLASS, STYLES } from "./skins.js"
import type { AppHandle, DashboardHandle, DashboardOptions, MountOptions } from "./types.js"

export { createApp, DASHBOARD_ROOT_CLASS, ROOT_CLASS, STYLES }

/** Everything the dashboard needs besides Mockingbird's stylesheet: the device skins. */
export const DASHBOARD_STYLES: string = STYLES

/** Add one stylesheet, once, to the document or shadow root `host` lives in. */
export const installStyles = (host: HTMLElement, id: string, css: string): void => {
  const rootNode = host.getRootNode() as Document | ShadowRoot
  const shadow = typeof ShadowRoot !== "undefined" && rootNode instanceof ShadowRoot
  const target = shadow ? rootNode : document.head
  if (target.querySelector(`#${id}`)) return
  const style = document.createElement("style")
  style.id = id
  // In a shadow root the theme's `:root` tokens belong on the shadow host.
  style.textContent = shadow ? css.replace(/:root\b/g, ":root, :host") : css
  target.append(style)
}

const install = (host: HTMLElement) => {
  installStyles(host, "mockingbird-ui-styles", MOCKINGBIRD_CSS)
  installStyles(host, "mockingbird-notifications-styles", STYLES)
}

/**
 * Mount the live harness UI inside `host`. It fills the element and scrolls inside it
 * (`embedded`), and leaves the page URL alone unless `syncUrl` is set.
 */
export const mountNotifications = (host: HTMLElement, options: MountOptions = {}): AppHandle => {
  if (options.injectStyles ?? true) install(host)
  return createApp(host, { embedded: true, syncUrl: false, ...storeOptions(options) })
}

/**
 * Mount the dashboard inside `host`, which it fills: give the host a height. Tabs are, in order,
 * the embedder's `tabs`, Emulators, Notifications. A tab is drawn the first time it is shown and
 * stays mounted afterwards, so switching away keeps its state. The Notifications tab counts what
 * arrives while another tab is open.
 */
export const mountDashboard = (host: HTMLElement, options: DashboardOptions): DashboardHandle => {
  if (options.injectStyles ?? true) install(host)
  return mountDashboardOn(host, options)
}
