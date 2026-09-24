/**
 * Vendor branding for the docs site: each mocked service's logo, brand color and a one-line
 * description of the vendor, fetched from the web so nobody hand-collects them.
 *
 * Inputs are the `mockingbird.vendor` block in each service's package.json:
 *
 *   "vendor": {
 *     "website": "https://stripe.com",          required: the vendor's homepage
 *     "docs": "https://docs.stripe.com/api",   optional: the API reference the mock follows
 *     "name": "Stripe",                         optional: when it differs from displayName
 *     "icon": "stripe" | false,                 optional: Simple Icons slug, or false to skip it
 *     "description": "…",                       optional: overrides the fetched description
 *     "color": "#635BFF",                       optional: overrides the fetched brand color
 *     "logo": "https://…/logo.svg"              optional: a logo URL, when the site's icons are poor
 *   }
 *
 * Output (committed, read by the docs build): sites/docs/src/data/brands.json and one logo per
 * service in sites/docs/public/brands/. Logos come from Simple Icons (https://simpleicons.org,
 * CC0) when the vendor is listed there, else the site's own icon, else Google's favicon service.
 *
 *   bun run brands:sync                  fetch services that are new or whose vendor block changed
 *   bun run brands:sync -- stripe s3     refetch the named services
 *   bun run brands:sync -- --all         refetch everything
 *   bun run brands:sync -- --links       also check every website and docs link answers
 *   bun run check:brands                 offline: fail if brands.json is stale (CI)
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { discoverPackages, root } from "./release/lib.ts"

const DATA = join(root, "sites/docs/src/data/brands.json")
const LOGOS = join(root, "sites/docs/public/brands")
const SIMPLE_ICONS = "https://cdn.jsdelivr.net/npm/simple-icons@15"
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36"
const TIMEOUT_MS = 15_000
const DESCRIPTION_MAX = 220

interface Vendor {
  website: string
  docs?: string
  name?: string
  icon?: string | false
  description?: string
  color?: string
  logo?: string
}

export interface Brand {
  /** The vendor's name, which can differ from the mock's display name (LlamaCloud → LlamaIndex). */
  vendor: string
  website: string
  docs: string | null
  description: string | null
  /** `#RRGGBB`, or null when the vendor publishes none. */
  color: string | null
  /** Path under the docs site's public dir. */
  logo: string
  logoSource: "simple-icons" | "site" | "favicon-service"
  /** The vendor block this entry was fetched for; a change marks the entry stale. */
  input: Vendor
}

interface Target {
  name: string
  displayName: string
  vendor: Vendor
}

function logoFile(b: Brand): string {
  return join(LOGOS, b.logo.split("/").pop() ?? "")
}

async function fetchBrand(t: Target, icons: SimpleIcon[]): Promise<Brand> {
  const v = t.vendor
  const vendor = v.name ?? t.displayName
  const page = await get(v.website)
    .then(async (r) => ({ url: r.url, html: await r.text() }))
    .catch(() => ({ url: v.website, html: "" }))
  const meta = parseHead(page.html)

  const description = clean(v.description ?? meta.description)
  const icon = v.icon === false ? null : findIcon(icons, v.icon, [vendor, t.displayName])

  for (const f of readdirSync(LOGOS)) if (f.startsWith(`${t.name}.`)) rmSync(join(LOGOS, f))
  const base = { vendor, website: v.website, docs: v.docs ?? null, description, input: v }

  if (icon) {
    const svg = await (await get(`${SIMPLE_ICONS}/icons/${icon.slug}.svg`)).text()
    // Logos sit on a white tile, where a near-white brand color would vanish.
    const fill = luminance(icon.hex) > 0.8 ? "000000" : icon.hex
    writeFileSync(join(LOGOS, `${t.name}.svg`), svg.replace("<svg ", `<svg fill="#${fill}" `))
    return {
      ...base,
      color: v.color ?? `#${icon.hex}`,
      logo: `/brands/${t.name}.svg`,
      logoSource: "simple-icons",
    }
  }

  const color = v.color ?? meta.themeColor
  const host = new URL(page.url).hostname
  const candidates = v.logo
    ? [{ url: new URL(v.logo, page.url).href, source: "site" as const }]
    : [
        ...meta.icons
          .slice(0, 8)
          .map((i) => ({ url: new URL(i, page.url).href, source: "site" as const })),
        { url: new URL("/favicon.ico", page.url).href, source: "site" as const },
        {
          url: `https://www.google.com/s2/favicons?domain=${host}&sz=256`,
          source: "favicon-service" as const,
        },
      ]
  const images = (
    await Promise.all(
      candidates.map(async (c) => {
        const image = await download(c.url).catch(() => null)
        return image ? { ...image, source: c.source } : null
      }),
    )
  ).filter((i) => i !== null)
  // The site's own icon wins ties, so the favicon service is only a fallback.
  const best = images.sort((a, b) => b.size - a.size || (a.source === "site" ? -1 : 1))[0]
  if (!best) throw new Error(`no logo found for ${v.website}`)
  const file = `${t.name}.${best.ext}`
  writeFileSync(join(LOGOS, file), best.body)
  return { ...base, color, logo: `/brands/${file}`, logoSource: best.source }
}

interface SimpleIcon {
  title: string
  slug: string
  hex: string
}

async function simpleIcons(): Promise<SimpleIcon[]> {
  const data = (await (await get(`${SIMPLE_ICONS}/data/simple-icons.json`)).json()) as
    | SimpleIcon[]
    | { icons: SimpleIcon[] }
  const list = Array.isArray(data) ? data : data.icons
  return list.map((i) => ({ ...i, slug: i.slug ?? slugify(i.title) }))
}

/** An explicit slug, else an exact (case- and punctuation-insensitive) title match. */
function findIcon(
  icons: SimpleIcon[],
  slug: string | undefined,
  names: string[],
): SimpleIcon | null {
  if (slug) {
    const hit = icons.find((i) => i.slug === slug)
    if (!hit) throw new Error(`Simple Icons has no slug "${slug}"`)
    return hit
  }
  const keys = new Set(names.map(norm))
  return icons.find((i) => keys.has(norm(i.title))) ?? null
}

/** WCAG relative luminance of a `RRGGBB` hex, 0 (black) to 1 (white). */
function luminance(hex: string): number {
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0)
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "")

/** Simple Icons' own title → slug rule, for data files that omit `slug`. */
const slugify = (title: string) =>
  title
    .toLowerCase()
    .replace(/\+/g, "plus")
    .replace(/\./g, "dot")
    .replace(/&/g, "and")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "")

interface Head {
  description: string | null
  themeColor: string | null
  /** Icon hrefs, best first: SVG, then the largest raster. */
  icons: string[]
}

function parseHead(html: string): Head {
  const end = html.search(/<\/head>/i)
  const head = end < 0 ? html : html.slice(0, end)
  const tags = [...head.matchAll(/<(meta|link)\b([^>]*)>/gi)].map((m) => ({
    tag: m[1]?.toLowerCase(),
    attrs: attrs(m[2] ?? ""),
  }))
  const meta = (key: string) =>
    tags.find((t) => t.tag === "meta" && (t.attrs.name ?? t.attrs.property)?.toLowerCase() === key)
      ?.attrs.content ?? null

  const icons = tags
    .filter(
      (t) =>
        t.tag === "link" &&
        /(^|\s)(icon|apple-touch-icon)(\s|$)/i.test(t.attrs.rel ?? "") &&
        t.attrs.href,
    )
    .map((t) => {
      const svg = /svg/i.test(t.attrs.type ?? "") || /\.svg(\?|$)/i.test(t.attrs.href ?? "")
      const size = Number(
        /(\d+)x\d+/.exec(t.attrs.sizes ?? "")?.[1] ??
          (/apple-touch/i.test(t.attrs.rel ?? "") ? 180 : 16),
      )
      return { href: t.attrs.href ?? "", rank: svg ? 10_000 : size }
    })
    .sort((a, b) => b.rank - a.rank)
    .map((i) => i.href)

  const theme = meta("theme-color")
  return {
    description: meta("description") ?? meta("og:description") ?? meta("twitter:description"),
    themeColor:
      theme && /^#[0-9a-f]{6}$/i.test(theme) && !/^#(f{6}|0{6})$/i.test(theme)
        ? theme.toUpperCase()
        : null,
    icons,
  }
}

function attrs(source: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of source.matchAll(/([a-zA-Z:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    out[(m[1] ?? "").toLowerCase()] = decode(m[2] ?? m[3] ?? m[4] ?? "")
  }
  return out
}

const decode = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)))

function clean(text: string | null | undefined): string | null {
  const t = text
    ?.replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim()
  if (!t) return null
  if (t.length <= DESCRIPTION_MAX) return t
  const cut = t.slice(0, DESCRIPTION_MAX)
  return `${cut.slice(0, cut.lastIndexOf(" "))}…`
}

interface Image {
  body: Uint8Array
  ext: "svg" | "png" | "ico" | "jpg" | "gif" | "webp"
  /** Pixel width; SVG counts as large as anything, so it always wins. */
  size: number
}

/** Download an image and identify it by its bytes, since servers mislabel icons freely. */
async function download(url: string): Promise<Image | null> {
  const body = new Uint8Array(await (await get(url)).arrayBuffer())
  if (body.byteLength < 100) return null
  const b = (i: number) => body[i] ?? 0
  const u16 = (i: number) => b(i) | (b(i + 1) << 8)
  const u32be = (i: number) => ((b(i) << 24) | (b(i + 1) << 16) | (b(i + 2) << 8) | b(i + 3)) >>> 0
  if (b(0) === 0x89 && b(1) === 0x50) return { body, ext: "png", size: u32be(16) }
  if (b(0) === 0 && b(1) === 0 && b(2) === 1 && b(3) === 0) {
    // ICO: the largest entry; a width byte of 0 means 256.
    const sizes = Array.from({ length: u16(4) }, (_, i) => b(6 + i * 16) || 256)
    return { body, ext: "ico", size: Math.max(0, ...sizes) }
  }
  if (b(0) === 0xff && b(1) === 0xd8) {
    // JPEG: walk the segments to the start-of-frame, which carries the dimensions.
    for (let i = 2; i + 9 < body.length; i += 2 + ((b(i + 2) << 8) | b(i + 3))) {
      if (b(i) !== 0xff) break
      if (b(i + 1) >= 0xc0 && b(i + 1) <= 0xc3)
        return { body, ext: "jpg", size: (b(i + 7) << 8) | b(i + 8) }
    }
    return { body, ext: "jpg", size: 0 }
  }
  if (b(0) === 0x47 && b(1) === 0x49) return { body, ext: "gif", size: u16(6) }
  if (b(0) === 0x52 && b(8) === 0x57) return { body, ext: "webp", size: 128 }
  const text = new TextDecoder().decode(body.slice(0, 2048))
  // An SVG wrapping a base64 raster is no better than the raster and can weigh megabytes.
  if (/<svg[\s>]/i.test(text) && body.byteLength <= 32_000)
    return { body, ext: "svg", size: 100_000 }
  return null
}

async function get(url: string, method = "GET"): Promise<Response> {
  const res = await fetch(url, {
    method,
    redirect: "follow",
    headers: { "user-agent": UA, accept: "text/html,image/*,*/*;q=0.8" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status}`)
  return res
}

async function checkLinks(targets: Target[]): Promise<string[]> {
  const urls = targets.flatMap((t) =>
    [t.vendor.website, t.vendor.docs]
      .filter((u): u is string => !!u)
      .map((u) => ({ name: t.name, u })),
  )
  const broken: string[] = []
  await pool(urls, 8, async ({ name, u }) => {
    // Some hosts refuse HEAD or bots; only a 404/410 or a dead host counts as broken.
    const res = await fetch(u, {
      redirect: "follow",
      headers: { "user-agent": UA },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch((e: Error) => e)
    if (res instanceof Error) broken.push(`${name}: ${u} → ${res.message}`)
    else if (res.status === 404 || res.status === 410) broken.push(`${name}: ${u} → ${res.status}`)
  })
  console.log(`checked ${urls.length} links`)
  return broken
}

async function pool<T>(items: T[], size: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      for (let i = next++; i < items.length; i = next++) await run(items[i] as T)
    }),
  )
}

// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
const check = args.includes("--check")
const all = args.includes("--all")
const links = args.includes("--links")
const named = args.filter((a) => !a.startsWith("--"))

const targets: Target[] = discoverPackages()
  .filter((p) => p.isPublic && p.relDir.startsWith("packages/service/"))
  .map((p) => {
    const pkg = JSON.parse(readFileSync(p.manifestPath, "utf8"))
    const vendor = pkg.mockingbird?.vendor as Vendor | undefined
    if (!vendor?.website) {
      console.error(`::error::${p.relDir}/package.json: mockingbird.vendor.website is required`)
      process.exit(1)
    }
    return {
      name: p.relDir.split("/").pop() ?? "",
      displayName: pkg.mockingbird.displayName,
      vendor,
    }
  })
  .sort((a, b) => a.name.localeCompare(b.name))

const brands: Record<string, Brand> = existsSync(DATA) ? JSON.parse(readFileSync(DATA, "utf8")) : {}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const stale = targets.filter((t) => {
  const b = brands[t.name]
  return !b || !same(b.input, t.vendor) || !existsSync(logoFile(b))
})
const orphans = Object.keys(brands).filter((n) => !targets.some((t) => t.name === n))

if (check) {
  const problems = [
    ...stale.map((t) => `${t.name}: missing or out of date (vendor block changed)`),
    ...orphans.map((n) => `${n}: in brands.json but no longer a service`),
  ]
  if (problems.length > 0) {
    console.error(
      `::error::sites/docs/src/data/brands.json is stale; run \`bun run brands:sync\`:\n  - ${problems.join("\n  - ")}`,
    )
    process.exit(1)
  }
  console.log(`brands.json is up to date (${targets.length} services)`)
  process.exit(0)
}

const todo =
  named.length > 0 ? targets.filter((t) => named.includes(t.name)) : all ? targets : stale
for (const n of named) if (!targets.some((t) => t.name === n)) console.warn(`unknown service: ${n}`)
for (const n of orphans) {
  const logo = brands[n] ? logoFile(brands[n]) : null
  if (logo && existsSync(logo)) rmSync(logo)
  delete brands[n]
}

mkdirSync(LOGOS, { recursive: true })
mkdirSync(join(DATA, ".."), { recursive: true })
const icons = todo.length > 0 ? await simpleIcons() : []
const failures: string[] = []
await pool(todo, 8, async (t) => {
  try {
    const b = await fetchBrand(t, icons)
    brands[t.name] = b
    console.log(
      `${t.name.padEnd(16)} ${b.logoSource.padEnd(15)} ${(b.color ?? "-").padEnd(8)} ${b.description?.slice(0, 70) ?? "(no description)"}`,
    )
  } catch (error) {
    failures.push(`${t.name}: ${(error as Error).message}`)
  }
})

// Drop logos no entry points at (a service switched from .png to .svg, say).
const used = new Set(Object.values(brands).map((b) => b.logo.split("/").pop()))
for (const f of readdirSync(LOGOS)) if (!used.has(f)) rmSync(join(LOGOS, f))

const sorted = Object.fromEntries(Object.entries(brands).sort(([a], [b]) => a.localeCompare(b)))
writeFileSync(DATA, `${JSON.stringify(sorted, null, 2)}\n`)
console.log(
  `\n${todo.length} fetched, ${targets.length - todo.length} unchanged → ${DATA.replace(`${root}/`, "")}`,
)

if (links) failures.push(...(await checkLinks(targets)))
if (failures.length > 0) {
  console.error(`\n${failures.length} problem(s):\n  - ${failures.join("\n  - ")}`)
  process.exit(1)
}
