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
  text: string
}

const PAGES: [string, string, string][] = [
  ["/services", "Services", "Browse and filter every mock"],
  ["/coverage", "Coverage", "Operations mocked per service, and every surface"],
  ["/why", "Why Mockingbird", "The case for stateful, contract-driven mocks"],
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
      text: [
        s.packageName,
        s.description,
        CATEGORIES[s.category as CategorySlug].label,
        ...s.keywords,
        ...s.operations.map((o) => o.id),
      ].join(" "),
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
      text: subtitle,
    })),
  ]
  return new Response(JSON.stringify(entries), { headers: { "content-type": "application/json" } })
}
