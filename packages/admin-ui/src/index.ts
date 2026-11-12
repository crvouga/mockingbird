import { type ComposableAdminApi, composeAdminRoutes } from "./compose.js"
import { adminClientSource } from "./document.js"
import type { AdminConfig } from "./model.js"

export type { ComposableAdminApi, ComposedAdminRoutes } from "./compose.js"
export { composeAdminRoutes } from "./compose.js"
export { adminClientScript, adminClientSource, membersClientSource } from "./document.js"
export type { AdminApiConfig, AdminConfig, MembersConfig } from "./model.js"

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  )

/**
 * Compose independent admin APIs behind one fetch handler and one UI. The shell is only a
 * facade: every data/control request is forwarded unchanged to the selected API.
 */
export const composeAdminApis = (
  apis: readonly ComposableAdminApi[],
  options: { brandsUrl: string; prefix?: string; title?: string },
): { config: AdminConfig; fetch(request: Request): Promise<Response> } => {
  const { config, prefix, fetch: forward } = composeAdminRoutes(apis, options)
  const title = escapeHtml(options.title ?? "Mockingbird")
  const document = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${title} admin</title><style>html,body{margin:0;min-height:100%}#admin-root{min-height:100%}</style></head><body><main id="admin-root" data-mockingbird-admin data-admin-ui-library="antd" data-service="${title}"><noscript>Enable JavaScript to use administration.</noscript></main>${adminClientSource(config)}</body></html>`
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
