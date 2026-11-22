import { createDevResources, type DevResourcesOptions } from "@crvouga/mockingbird-preview"
import type { MockAdmin } from "../adapters/admin.js"
import { SYSTEM_SERVICES } from "./services.js"

/** Where the preview Worker serves the dev proxy (`src/worker.ts`). */
export const DEV_PROXY_PATH = "/__dev"

/** The page that explains dev resources, linked from the System screen. */
export const DEV_DOCS_URL = "https://github.com/crvouga/mockingbird/blob/main/docs/DEV_RESOURCES.md"

/**
 * The browser half of dev resources: transports for the emulators to forward through, and the
 * System screen's service controls. The proxy, on this page's own origin, holds and injects the
 * credentials; this side never handles one.
 */
export const createLabDevResources = (
  proxyUrl: string | undefined,
  /** Tests inject the proxy and a storage in place of the network and localStorage. */
  overrides: Pick<DevResourcesOptions, "fetch" | "storage"> = {},
) => {
  const dev = createDevResources({ ...overrides, ...(proxyUrl ? { proxyUrl } : {}) })
  return {
    upstream: proxyUrl ? (service: string) => dev.upstream(service) : undefined,
    controls: (admins: readonly MockAdmin[]) =>
      dev.controls(
        SYSTEM_SERVICES.flatMap((service) => {
          const admin = admins.find((candidate) => candidate.id === service.id)
          return admin
            ? [
                {
                  id: service.id,
                  label: service.label,
                  category: service.category,
                  admin: admin.fetch,
                  ...(service.unsupported ? { unsupported: service.unsupported } : {}),
                },
              ]
            : []
        }),
      ),
  }
}
