/**
 * The vendor chip a published emulator embeds (`scripts/admin-brand.ts`): its record in
 * `sites/docs/src/data/brands.json`, logo inlined as a base64 `data:` URI. Emulators run from
 * source here carry none, so stories answer `GET <adminPrefix>/ui/brands.json` with it, through
 * `adminBrandCatalog` as the emulator would.
 */
import { adminBrandCatalog } from "../../../../../packages/service/core/src/admin-ui.js"
import { adminBrands } from "../../../../docs/src/lib/admin-brands.js"
import type { Brand } from "../../../../docs/src/lib/types.js"

const catalog = Object.values(
  import.meta.glob<Record<string, Brand>>("../../../../docs/src/data/brands.json", {
    eager: true,
    import: "default",
  }),
)[0] as Record<string, Brand>
const svgs = import.meta.glob<string>("../../../../docs/public/brands/*.svg", {
  query: "?raw",
  import: "default",
})
const images = import.meta.glob<string>("../../../../docs/public/brands/*.png", {
  query: "?inline",
  import: "default",
})

const base64 = (text: string) => {
  let binary = ""
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte)
  return btoa(binary)
}

async function logo(path: string): Promise<string> {
  const key = `../../../../docs/public${path}`
  if (svgs[key]) return `data:image/svg+xml;base64,${base64(await svgs[key]())}`
  if (images[key]) return images[key]()
  return ""
}

/** `GET <adminPrefix>/ui/brands.json` for `service`, as its published package answers it. */
export async function brandCatalog(service: string): Promise<Record<string, unknown>> {
  const brand = catalog[service]
  if (!brand) return {}
  const record = adminBrands([{ name: service, brand }])[service]
  if (!record) return {}
  return adminBrandCatalog(service, { ...record, logo: await logo(brand.logo) })
}
