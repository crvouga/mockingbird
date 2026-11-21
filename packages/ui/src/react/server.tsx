/**
 * Server rendering for pages served as strings (an emulator's sign-in or consent page, an
 * inspector, a report). Import this module only through a dynamic `import()` on the request path
 * that serves the page, so a runtime that never serves it never loads React.
 *
 * It renders with `react-dom/server.browser`, the build of React's server renderer that needs no
 * Node API, so the same page renders in Node, Bun, Deno, Workers and browsers.
 */
import type { ReactNode } from "react"
import { renderToString } from "react-dom/server.browser"
import { type DocumentOptions, renderDocument } from "../document.js"
import { MockingbirdProvider } from "./provider.js"

/**
 * `element` inside `MockingbirdProvider`, as HTML. `renderToString` (not `renderToStaticMarkup`)
 * so a client bundle can hydrate it; without one it is still a complete, working page.
 */
export function renderToHtml(element: ReactNode): string {
  return renderToString(<MockingbirdProvider>{element}</MockingbirdProvider>)
}

export type PageOptions = Omit<DocumentOptions, "body">

/**
 * A whole page: `element` server-rendered into `renderDocument`. Forms inside post natively, so
 * the page works with no client JavaScript at all; pass `script` to hydrate it (the client entry
 * calls `mount` from `@crvouga/mockingbird-ui/react/client` with the same element).
 */
export function renderPage(element: ReactNode, options: PageOptions): string {
  return renderDocument({ ...options, body: renderToHtml(element) })
}
