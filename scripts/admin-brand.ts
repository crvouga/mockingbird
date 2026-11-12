/**
 * The vendor chip an emulator's admin shell shows, embedded in the package at build time.
 *
 * The shell reads `GET <adminPrefix>/ui/brands.json` from the emulator itself; the record
 * comes from `sites/docs/src/data/brands.json` (`bun run brands:sync`) with the logo file
 * inlined as a `data:` URI, so opening the admin makes no request to another host.
 * Builds pass the result to esbuild as `define: { __MOCKINGBIRD_ADMIN_BRAND__: … }`
 * (see `packages/service/core/src/admin-ui.ts`).
 */
import { existsSync, readFileSync } from "node:fs"
import { basename, extname, join } from "node:path"
import { type AdminBrand, adminBrands } from "../sites/docs/src/lib/admin-brands.ts"
import type { Brand } from "../sites/docs/src/lib/types.ts"

const root = join(import.meta.dir, "..")
const BRANDS = join(root, "sites/docs/src/data/brands.json")
const PUBLIC = join(root, "sites/docs/public")
/** A logo larger than this is left out rather than bloating the bundle. */
export const MAX_LOGO_BYTES = 160 * 1024

const MIME: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
}

/** `logo` is a path under the docs site's public dir, e.g. `/brands/stripe.svg`. */
export function logoDataUri(logo: string, publicDir = PUBLIC): string {
  if (logo === "") return ""
  const mime = MIME[extname(logo).toLowerCase()]
  const file = join(publicDir, logo.replace(/^\/+/, ""))
  if (!mime || !existsSync(file)) return ""
  const bytes = readFileSync(file)
  if (bytes.byteLength > MAX_LOGO_BYTES) return ""
  return `data:${mime};base64,${bytes.toString("base64")}`
}

/** The brand record for the service in `packageDir` (keyed by its directory name), or undefined. */
export function adminBrandFor(
  packageDir: string,
  options: { brandsFile?: string; publicDir?: string } = {},
): AdminBrand | undefined {
  const name = basename(packageDir)
  const file = options.brandsFile ?? BRANDS
  if (!existsSync(file)) return undefined
  const catalog = JSON.parse(readFileSync(file, "utf8")) as Record<string, Brand>
  const brand = Object.hasOwn(catalog, name) ? catalog[name] : undefined
  if (!brand) return undefined
  const record = adminBrands([{ name, brand }])[name]
  if (!record) return undefined
  return { ...record, logo: logoDataUri(brand.logo, options.publicDir) }
}

/** esbuild `define` entries for a service build; empty when the package has no brand. */
export function adminBrandDefine(packageDir: string): Record<string, string> {
  const brand = adminBrandFor(packageDir)
  return brand ? { __MOCKINGBIRD_ADMIN_BRAND__: JSON.stringify(brand) } : {}
}
