import catalog from "virtual:mockingbird/catalog"
import type { APIRoute } from "astro"
import { CATEGORIES, type CategorySlug } from "../lib/categories.ts"
import { initials } from "../lib/format.ts"
import { plainSummary } from "../lib/guides.ts"

export interface PaletteEntry {
  kind: "service" | "page"
  href: string
  name: string
  displayName: string
  initials: string
  subtitle: string
  category: string
  parity: string
  featured: boolean
  hue: number
  logo: string | null
  /** A guide page's own subject: its search words and the interface it defines. */
  keywords: string
  text: string
}

const codeSpans = (markdown: string): string[] =>
  [...markdown.matchAll(/`([^`\n]+)`/g)].map(([, code]) => code as string)

/** A page's `## Interface` section: the routes, headers and options that page defines. */
const interfaceOf = (markdown: string): string =>
  /^## Interface\n([\s\S]*?)(?=^## )/m.exec(markdown)?.[1] ?? ""

const PAGES: [string, string, string][] = [
  ["/services", "Emulators", "Browse and filter every emulator"],
  ["/coverage", "Coverage", "Operations emulated per service, and every surface"],
  ["/docs", "Docs", "Guides for using, testing and contributing"],
  ["/llms.txt", "llms.txt", "Index for coding agents"],
  ["/catalog.json", "catalog.json", "Machine-readable catalog"],
]

export const GET: APIRoute = () => {
  const entries: PaletteEntry[] = [
    ...catalog.services.map((s) => ({
      kind: "service" as const,
      href: `/services/${s.name}`,
      name: s.name,
      displayName: s.displayName,
      initials: initials(s.displayName),
      subtitle: s.description,
      category: CATEGORIES[s.category as CategorySlug].label,
      parity: s.parity,
      featured: s.featured,
      hue: s.hue,
      logo: s.brand.logo,
      keywords: "",
      text: [
        s.packageName,
        s.description,
        s.parity,
        s.featured ? "featured" : "",
        s.brand.vendor,
        CATEGORIES[s.category as CategorySlug].label,
        ...s.keywords,
        ...s.operations.map((o) => o.id),
      ].join(" "),
    })),
    // Each page of a guide is an entry of its own. It is found first by its title, then by
    // the words people look for it by and the interface it defines, then by what it mentions.
    ...catalog.guides.map((g) => ({
      kind: "page" as const,
      href: `/docs/${g.slug}`,
      name: `docs/${g.slug}`,
      displayName: g.title,
      initials: "",
      subtitle: plainSummary(g.summary),
      category: "",
      parity: "",
      featured: false,
      hue: 0,
      logo: null,
      keywords: [g.keywords, ...codeSpans(interfaceOf(g.markdown))].join(" "),
      text: [g.summary, ...g.toc.map((t) => t.text), ...codeSpans(g.markdown)].join(" "),
    })),
    ...PAGES.map(([href, displayName, subtitle]) => ({
      kind: "page" as const,
      href,
      name: href.slice(1),
      displayName,
      initials: "",
      subtitle,
      category: "",
      parity: "",
      featured: false,
      hue: 0,
      logo: null,
      keywords: "",
      text: subtitle,
    })),
  ]
  return new Response(JSON.stringify(entries), { headers: { "content-type": "application/json" } })
}
