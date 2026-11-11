import type { SentTo } from "./api.js"

/**
 * "Open Notifications" buttons across the app call `openInbox` with the
 * channel and recipient of a message the app just sent. Where that lands
 * depends on how the app is running, so the opener is swappable:
 *
 * - Standalone server: the harness lives at `/notifications/`, opened in a
 *   new tab already filtered to that recipient (the default below).
 * - Embedded: `composition/browser.ts` switches the dashboard to its
 *   Notifications tab instead.
 */
export type InboxTarget = Partial<SentTo>
export type InboxOpener = (target: InboxTarget) => void

const openStandalone: InboxOpener = (target) => {
  const params = new URLSearchParams()
  if (target.channel) params.set("view", target.channel)
  if (target.to) params.set("to", target.to)
  const query = params.toString()
  window.open(`/notifications/${query ? `?${query}` : ""}`, "cove-notifications")
}

let opener: InboxOpener = openStandalone

export const setInboxOpener = (next: InboxOpener): void => {
  opener = next
}

export const openInbox = (target: InboxTarget = {}): void => opener(target)
