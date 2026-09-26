import catalog from "virtual:mockingbird/catalog"
import type { APIRoute } from "astro"
import { CATEGORIES, type CategorySlug } from "../lib/categories.ts"
import { initials } from "../lib/format.ts"

export interface PaletteEntry {
  kind: "service" | "page"
  href: string
  name: string
  displayName: string
  initials: string
  subtitle: string
  category: string
  tier: string
  hue: number
  logo: string | null
  text: string
}

const PAGES: [string, string, string][] = [
  ["/services", "Services", "Browse and filter every mock"],
  ["/coverage", "Coverage", "Operations mocked per service, and every surface"],
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
      tier: s.status,
      hue: s.hue,
      logo: s.brand.logo,
      text: [
        s.packageName,
        s.description,
        s.brand.vendor,
        CATEGORIES[s.category as CategorySlug].label,
        ...s.keywords,
        ...s.operations.map((o) => o.id),
      ].join(" "),
    })),
    ...catalog.guides.map((g) => ({
      kind: "page" as const,
      href: `/docs/${g.slug}`,
      name: `docs/${g.slug}`,
      displayName: g.title,
      initials: "",
      subtitle: g.summary,
      category: "",
      tier: "",
      hue: 0,
      logo: null,
      text: `${g.summary} ${g.toc.map((t) => t.text).join(" ")}`,
    })),
    ...PAGES.map(([href, displayName, subtitle]) => ({
      kind: "page" as const,
      href,
      name: href.slice(1),
      displayName,
      initials: "",
      subtitle,
      category: "",
      tier: "",
      hue: 0,
      logo: null,
      text: subtitle,
    })),
  ]
  return new Response(JSON.stringify(entries), { headers: { "content-type": "application/json" } })
}
