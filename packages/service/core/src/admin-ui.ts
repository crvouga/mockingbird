import { requestBaseUrl } from "@crvouga/mockingbird-core"
import { adminClientSource } from "./admin-client.js"
import type { AdminRoutes } from "./control.js"
import { ADMIN_BRANDS_PATH, ADMIN_KEY_HEADER, ADMIN_PREFIX } from "./control.js"
import type { AdminExtension, AdminUi } from "./surface.js"
import { STANDARD_ADMIN_ROUTES } from "./surface.js"

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;"
      case "<":
        return "&lt;"
      case ">":
        return "&gt;"
      case '"':
        return "&quot;"
      default:
        return "&#39;"
    }
  })

/** One service's vendor chip: what `GET <adminPrefix>/ui/brands.json` returns under its name. */
export type AdminBrand = {
  vendor: string
  website: string
  /** Vendor API reference, when there is one. */
  docs: string | null
  /** The service's page on the docs site. A link only; the admin never fetches it. */
  guide: string
  /** A `data:image/…;base64,` URI, so the chip loads nothing from the network; "" for none. */
  logo: string
  color: string | null
  description: string | null
}

/**
 * The brand record of the package this runtime was bundled into. `scripts/bundle-service.ts`
 * defines it from `sites/docs/src/data/brands.json` and the logo file; unbundled (tests,
 * source checkouts) it is absent and the admin shows no chip.
 */
declare const __MOCKINGBIRD_ADMIN_BRAND__: AdminBrand | undefined
const EMBEDDED_BRAND: AdminBrand | undefined =
  typeof __MOCKINGBIRD_ADMIN_BRAND__ === "object" ? __MOCKINGBIRD_ADMIN_BRAND__ : undefined

/**
 * The catalog the shared client reads: `{ [service]: brand }`, or `{}` without one. It ships
 * inside the package and is served by the emulator, so opening the admin makes no request to
 * any other host (no CORS failure, works offline).
 */
export const adminBrandCatalog = (
  service: string,
  brand: AdminBrand | undefined = EMBEDDED_BRAND,
): Record<string, AdminBrand> => (brand ? { [service]: brand } : {})

/**
 * The default admin document. It talks only to `/__admin/*`, so every mock can serve it.
 * Bespoke panels arrive later from `GET /ui/manifest`, which stays behind the admin key.
 * The header chip is filled from `GET <adminPrefix>/ui/brands.json` on the same emulator.
 */
export const renderAdminDocument = (service: string, adminPrefix = ADMIN_PREFIX): string => {
  const name = escapeHtml(service)
  const script = adminClientSource({
    standardRoutes: STANDARD_ADMIN_ROUTES,
    adminPrefix,
    adminKeyHeader: ADMIN_KEY_HEADER,
    brandsUrl: `${adminPrefix}${ADMIN_BRANDS_PATH}`,
    service,
  })
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${name} admin</title>
<style>html,body{margin:0;min-height:100%}#admin-root{min-height:100%}</style>
</head>
<body>
<main id="admin-root" data-mockingbird-admin data-admin-ui-library="antd" data-service="${name}">
<noscript>Enable JavaScript to use administration.</noscript>
</main>
${script}
</body>
</html>`
}

const htmlResponse = (body: string): Response =>
  new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  })

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  })

const describeExtension = (extension: AdminExtension): Record<string, unknown> => {
  if (extension.kind === "route") return { ...extension }
  if (extension.kind === "sql") {
    return {
      kind: "sql",
      id: extension.id ?? "sql",
      title: extension.title ?? "SQL",
      ...(extension.description !== undefined ? { description: extension.description } : {}),
    }
  }
  return {
    kind: "panel",
    id: extension.id,
    title: extension.title,
    ...(extension.description !== undefined ? { description: extension.description } : {}),
    html: extension.html,
    ...(extension.script !== undefined ? { script: extension.script } : {}),
  }
}

/** `GET /__admin/ui` plus the manifest a bespoke panel list is read from. */
export const adminUiRoutes = (
  service: string,
  ui: AdminUi | undefined,
  adminPrefix = ADMIN_PREFIX,
): AdminRoutes => {
  const document = (request: Request) => {
    const mountPrefix = new URL(requestBaseUrl(request)).pathname.replace(/\/$/, "")
    const shell = () => renderAdminDocument(service, `${mountPrefix}${adminPrefix}`)
    return ui?.render ? ui.render({ service, defaultHtml: shell }) : shell()
  }
  return {
    "GET /ui": ({ request }) => htmlResponse(document(request)),
    "GET /ui/": ({ request }) => htmlResponse(document(request)),
    [`GET ${ADMIN_BRANDS_PATH}`]: () => json(adminBrandCatalog(service)),
    "GET /ui/manifest": () =>
      json({
        service,
        standardRoutes: STANDARD_ADMIN_ROUTES,
        panels: (ui?.panels ?? []).map((panel) => ({
          id: panel.id,
          title: panel.title,
          ...(panel.description !== undefined ? { description: panel.description } : {}),
          html: panel.html,
          ...(panel.script !== undefined ? { script: panel.script } : {}),
        })),
        extensions: (ui?.extensions ?? []).map(describeExtension),
      }),
  }
}
