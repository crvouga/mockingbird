import type { Brand } from "./types.ts"

/**
 * Public docs origin. The site publishes the whole catalog at `/brands.json`; each emulator
 * embeds its own entry at build time (`scripts/admin-brand.ts`) and serves it at
 * `/__admin/ui/brands.json`, so admin shells never fetch this origin.
 */
export const DOCS_ORIGIN = "https://mockingbird.chrisvouga.dev"

/** What `GET /brands.json` returns for one service. Absolute URLs, so the admin does not invent the origin. */
export interface AdminBrand {
  vendor: string
  website: string
  /** Vendor API reference, when we have one. */
  docs: string | null
  /** This site's page for the service. */
  guide: string
  logo: string
  color: string | null
  description: string | null
}

/** The record published for admin shells. A docs deploy updates it; published emulators do not embed it. */
export const adminBrands = (
  services: readonly { name: string; brand: Brand }[],
  origin = DOCS_ORIGIN,
): Record<string, AdminBrand> => {
  const out: Record<string, AdminBrand> = {}
  for (const service of [...services].sort((a, b) => a.name.localeCompare(b.name))) {
    if (service.name === "") continue
    out[service.name] = {
      vendor: service.brand.vendor,
      website: service.brand.website,
      docs: service.brand.docs,
      guide: new URL(`/services/${encodeURIComponent(service.name)}`, origin).href,
      logo: service.brand.logo === "" ? "" : new URL(service.brand.logo, origin).href,
      color: service.brand.color,
      description: service.brand.description,
    }
  }
  return out
}
