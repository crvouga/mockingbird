/**
 * The harness page: Mockingbird's document (`renderDocument`: the bird favicon, the title suffix,
 * light and dark) with the shared stylesheet and the device skins inline, and an empty `#app` that
 * `/ui.js` (`browser.ts`) draws into: the dashboard when the harness fronts emulator admin APIs,
 * else the notifications UI alone. No inline script, so it runs under a strict CSP.
 *
 * The harness imports this module lazily, on the request for the page, so a harness that only
 * serves the JSON API (in a test, in a browser tab) never loads the stylesheet.
 */
import { escapeHtml, renderDocument } from "@crvouga/mockingbird-ui/document"
import { MOCKINGBIRD_CSS } from "@crvouga/mockingbird-ui/styles"
import { STYLES } from "./skins.js"

export const renderPage = ({
  title,
  defaultTab = "notifications",
}: {
  title: string
  defaultTab?: "emulators" | "notifications"
}): string =>
  renderDocument({
    title,
    css: MOCKINGBIRD_CSS + STYLES,
    head: '<script type="module" src="./ui.js"></script>',
    body: `<div id="app" data-title="${escapeHtml(title)}" data-default-tab="${defaultTab}"><p role="status" style="padding:48px;opacity:.7">Loading notifications…</p></div>`,
  })
