/// <reference lib="dom" />
import type { NotificationHarness } from "../harness.js"
import { type AppHandle, type AppOptions, createApp } from "./app.js"
import { STYLES } from "./styles.js"

export type MountOptions = Omit<AppOptions, "fetch"> & {
  /** An in-process harness (anything with a Fetch handler). Omit it to read `baseUrl` over HTTP. */
  harness?: Pick<NotificationHarness, "fetch">
  /** Any Fetch-compatible transport to the harness API. Ignored when `harness` is given. */
  fetch?: NonNullable<AppOptions["fetch"]>
  /** Add the stylesheet to the host's document or shadow root. Default true. */
  injectStyles?: boolean
}

/** Add one stylesheet, once, to the document or shadow root `host` lives in. */
export const installStyles = (host: HTMLElement, id: string, css: string) => {
  const rootNode = host.getRootNode() as Document | ShadowRoot
  const target = rootNode instanceof ShadowRoot ? rootNode : document.head
  if (target.querySelector(`#${id}`)) return
  const style = document.createElement("style")
  style.id = id
  style.textContent = css
  target.append(style)
}

/**
 * Mount the live harness UI inside `host`. It fills the element and scrolls inside it
 * (`embedded`), and leaves the page URL alone unless `syncUrl` is set.
 */
export const mountNotifications = (host: HTMLElement, options: MountOptions = {}): AppHandle => {
  const { harness, injectStyles = true, ...rest } = options
  if (injectStyles) installStyles(host, "mockingbird-notifications-styles", STYLES)
  if (harness) rest.fetch = (request) => harness.fetch(request)
  return createApp(host, { embedded: true, syncUrl: false, ...rest })
}
