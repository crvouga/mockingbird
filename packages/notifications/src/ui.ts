/// <reference lib="dom" />
/**
 * The harness UI as a component, for an app that wants its notifications on a tab or panel of its
 * own page: in the browser, against an in-process harness, with no server and no network.
 *
 *   const harness = createNotificationHarness({ services: { twilio, resend, fcm } })
 *   const ui = mountNotifications(panel, { harness })
 *   await ui.ready
 *   ui.destroy()
 *
 * Every rule of the stylesheet is scoped to the UI root (`.mb-notifications`), so it can sit next
 * to the host app's own styles.
 */
import type { NotificationHarness } from "./harness.js"
import { type AppHandle, type AppOptions, createApp } from "./ui/app.js"
import { ROOT_CLASS, STYLES } from "./ui/styles.js"

export { selectors, TEST_IDS, type TestId } from "./testids.js"
export {
  type AppHandle,
  type AppOptions,
  createApp,
  type MotionPreference,
  type PushSkin,
  type View,
} from "./ui/app.js"
export { ROOT_CLASS, STYLES }

export type MountOptions = Omit<AppOptions, "fetch"> & {
  /** An in-process harness (anything with a Fetch handler). Omit it to read `baseUrl` over HTTP. */
  harness?: Pick<NotificationHarness, "fetch">
  /** Any Fetch-compatible transport to the harness API. Ignored when `harness` is given. */
  fetch?: NonNullable<AppOptions["fetch"]>
  /** Add the stylesheet to the host's document or shadow root. Default true. */
  injectStyles?: boolean
}

const STYLE_ID = "mockingbird-notifications-styles"

const installStyles = (host: HTMLElement) => {
  const rootNode = host.getRootNode() as Document | ShadowRoot
  const target = rootNode instanceof ShadowRoot ? rootNode : document.head
  if (target.querySelector(`#${STYLE_ID}`)) return
  const style = document.createElement("style")
  style.id = STYLE_ID
  style.textContent = STYLES
  target.append(style)
}

/**
 * Mount the live harness UI inside `host`. It fills the element and scrolls inside it
 * (`embedded`), and leaves the page URL alone unless `syncUrl` is set.
 */
export const mountNotifications = (host: HTMLElement, options: MountOptions = {}): AppHandle => {
  const { harness, injectStyles = true, ...rest } = options
  if (injectStyles) installStyles(host)
  if (harness) rest.fetch = (request) => harness.fetch(request)
  return createApp(host, { embedded: true, syncUrl: false, ...rest })
}
