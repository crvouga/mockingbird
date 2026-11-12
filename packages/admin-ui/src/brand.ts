import { isRecord } from "./model.js"

export const httpUrl = (value: unknown): string | undefined => {
  if (typeof value !== "string" || value.length > 2000) return undefined
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined
  } catch {
    return undefined
  }
}
/**
 * A logo the emulator embeds in its own brand record: a base64 image, never markup.
 * An SVG in an `<img>` runs no script, so it is as safe as a PNG.
 */
const IMAGE_DATA_URI =
  /^data:image\/(?:png|jpeg|gif|webp|svg\+xml|x-icon|vnd\.microsoft\.icon);base64,[A-Za-z0-9+/]+={0,2}$/
const logoUrl = (value: unknown): string | undefined =>
  typeof value === "string" && value.length <= 240_000 && IMAGE_DATA_URI.test(value)
    ? value
    : httpUrl(value)
/**
 * Where the brand catalog is read from. `fallback` may be relative (an emulator serves its own
 * record at `<adminPrefix>/ui/brands.json`), so it resolves against the page.
 */
export const brandCatalogUrl = (fallback: string, href: string): string => {
  const page = new URL(href)
  const requested = page.searchParams.get("brands")
  if (!requested) return new URL(fallback, page).href
  try {
    const url = new URL(requested, page)
    const local =
      ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname) ||
      url.origin === page.origin
    return local && httpUrl(url.href) ? url.href : new URL(fallback, page).href
  } catch {
    return new URL(fallback, page).href
  }
}
export const brandFor = (service: string, catalog: unknown) => {
  if (!isRecord(catalog) || !Object.hasOwn(catalog, service)) return null
  const item = catalog[service]
  if (!isRecord(item) || typeof item.vendor !== "string" || !item.vendor.trim()) return null
  return {
    vendor: item.vendor.slice(0, 80),
    website: httpUrl(item.website),
    docs: httpUrl(item.docs),
    guide: httpUrl(item.guide),
    logo: logoUrl(item.logo),
    description: typeof item.description === "string" ? item.description.slice(0, 280) : "",
  }
}
