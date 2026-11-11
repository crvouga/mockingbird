import { type ComposableAdminApi, composeAdminRoutes } from "@crvouga/mockingbird-admin-ui/compose"

const ADMIN_BRANDS_URL = "https://mockingbird.chrisvouga.dev/brands.json"

/** One independently usable admin API. Its UI is supplied by the composed facade. */
export type MockAdmin = {
  id: string
  label: string
  fetch: (request: Request) => Promise<Response>
}

/**
 * Compose independent APIs without merging their state or control planes. This is the routing
 * and the UI's config only: the browser mounts the shared UI as bundled code, so no document
 * (and no copy of the UI as a string) is built here.
 */
export const composeMockAdmins = (admins: readonly MockAdmin[]) =>
  composeAdminRoutes(
    admins.map(
      (admin): ComposableAdminApi => ({
        ...admin,
        service: admin.id,
        adminPrefix: "/__admin",
        adminKeyHeader: "x-mockingbird-admin-key",
        standardRoutes: [],
      }),
    ),
    { brandsUrl: ADMIN_BRANDS_URL },
  )
