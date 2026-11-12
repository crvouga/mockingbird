/**
 * The shared admin is a prebuilt React + Ant Design bundle (about 1.3 MB as a string). The
 * runtime loads it lazily, on the first request for an admin page, through a dynamic `import()`
 * with a literal specifier: Node, Bun and every bundler resolve it, a bundler that splits code
 * keeps it in a chunk of its own, and an app that never serves `/__admin/ui` never parses it.
 * `scripts/bundle-service.ts` emits it as `dist/admin-ui.js` beside each service's entries.
 * Service imports stay DOM-free and nothing here imports the bundle statically.
 */
export type { AdminConfig as AdminBootConfig } from "@crvouga/mockingbird-admin-ui"

export type AdminClient = typeof import("@crvouga/mockingbird-admin-ui/document")

let loading: Promise<AdminClient> | undefined

/** The browser client, imported once per process on first use. A failed import is retried. */
export const loadAdminClient = (): Promise<AdminClient> => {
  loading ??= import("@crvouga/mockingbird-admin-ui/document").catch((error: unknown) => {
    loading = undefined
    throw error
  })
  return loading
}
