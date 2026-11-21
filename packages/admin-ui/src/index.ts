import { escapeHtml, renderDocument } from "@crvouga/mockingbird-ui/document"
import { type ComposableAdminApi, composeAdminRoutes } from "./compose.js"
import { adminClientSource } from "./document.js"
import type { AdminConfig } from "./model.js"

export type { ComposableAdminApi, ComposedAdminRoutes } from "./compose.js"
export { composeAdminRoutes } from "./compose.js"
export { adminClientScript, adminClientSource, membersClientSource } from "./document.js"
export type { AdminApiConfig, AdminConfig, MembersConfig } from "./model.js"

/**
 * Compose independent admin APIs behind one fetch handler and one UI. The shell is only a
 * facade: every data/control request is forwarded unchanged to the selected API.
 */
export const composeAdminApis = (
  apis: readonly ComposableAdminApi[],
  options: { brandsUrl: string; prefix?: string; title?: string },
): { config: AdminConfig; fetch(request: Request): Promise<Response> } => {
  const { config, prefix, fetch: forward } = composeAdminRoutes(apis, options)
  const title = options.title ?? "Mockingbird"
  // The same document head as every Mockingbird page; the client brings the stylesheet itself.
  const document = renderDocument({
    title: `${title} admin`,
    css: "html,body,[data-mockingbird-root],#admin-root{min-height:100%}body{margin:0}",
    body: `<main id="admin-root" data-mockingbird-admin data-admin-ui-library="heroui" data-service="${escapeHtml(title)}"><noscript>Enable JavaScript to use administration.</noscript></main>${adminClientSource(config)}`,
  })
  return {
    config,
    async fetch(request) {
      const url = new URL(request.url)
      if (
        request.method === "GET" &&
        (url.pathname === `${prefix}/ui` || url.pathname === `${prefix}/ui/`)
      )
        return new Response(document, {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        })
      return forward(request)
    },
  }
}
