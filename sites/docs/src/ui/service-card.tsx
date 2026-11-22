import { Card } from "@heroui/react"
import { CATEGORIES, type CategorySlug } from "../lib/categories.ts"
import type { Service } from "../lib/types.ts"
import { Icon } from "./icon.tsx"
import { FeaturedChip, Monogram } from "./primitives.tsx"

/** The fields a service card shows and the catalog's search reads. */
export type ServiceSummary = Pick<
  Service,
  "name" | "displayName" | "description" | "category" | "kind" | "featured" | "parity"
> & {
  logo: string | null
  opsSupported: number
  cli: boolean
}

export const summarize = (s: Service): ServiceSummary => ({
  name: s.name,
  displayName: s.displayName,
  description: s.description,
  category: s.category,
  kind: s.kind,
  featured: s.featured,
  parity: s.parity,
  logo: s.brand.logo,
  opsSupported: s.opsSupported,
  cli: Boolean(s.surfaces.cli),
})

const categoryLabel = (slug: string) => CATEGORIES[slug as CategorySlug]?.label ?? slug

/**
 * One emulator in a grid (or a row of the catalog's list view): a HeroUI Card that links to its
 * page. `data-service` is what the catalog's tests and scripts look for.
 */
export function ServiceCard({
  service: s,
  view = "grid",
}: {
  service: ServiceSummary
  view?: "grid" | "list"
}) {
  const what =
    s.kind === "sql"
      ? "SQL engine"
      : s.kind === "node"
        ? "Real server"
        : `${s.opsSupported} operations`
  if (view === "list") {
    return (
      <a
        href={`/services/${s.name}`}
        data-service={s.name}
        className="grid grid-cols-1 items-center gap-2 px-4 py-3 text-foreground no-underline transition-colors hover:bg-surface-secondary md:grid-cols-[minmax(14rem,18rem)_1fr_auto] md:gap-5"
      >
        <span className="flex min-w-0 items-center gap-3">
          <Monogram name={s.displayName} logo={s.logo} size="sm" />
          <span className="min-w-0">
            <span className="block truncate font-semibold">{s.displayName}</span>
            <span className="block text-xs text-muted">{categoryLabel(s.category)}</span>
          </span>
        </span>
        <span className="line-clamp-1 text-sm text-muted">{s.description}</span>
        <span className="flex items-center gap-3 text-xs whitespace-nowrap text-muted">
          {s.featured ? <FeaturedChip /> : null}
          <span>Parity: {s.parity}</span>
          <span>{what}</span>
        </span>
      </a>
    )
  }
  return (
    <a
      href={`/services/${s.name}`}
      data-service={s.name}
      className="group block h-full rounded-xl text-foreground no-underline outline-none focus-visible:ring-2 focus-visible:ring-focus"
    >
      <Card className="h-full transition-colors group-hover:bg-surface-secondary">
        <Card.Header className="flex-row items-center gap-3">
          <Monogram name={s.displayName} logo={s.logo} />
          <div className="min-w-0 flex-1">
            <Card.Title className="truncate text-base font-semibold">{s.displayName}</Card.Title>
            <Card.Description className="text-xs">{categoryLabel(s.category)}</Card.Description>
          </div>
          {s.featured ? <FeaturedChip /> : null}
        </Card.Header>
        <Card.Content>
          <p className="line-clamp-2 text-sm leading-relaxed text-muted">{s.description}</p>
        </Card.Content>
        <Card.Footer className="mt-auto flex-wrap gap-x-4 gap-y-1 border-t border-separator pt-3 text-xs text-muted">
          <span>Parity: {s.parity}</span>
          <span>{what}</span>
          {s.cli ? (
            <span className="hidden items-center gap-1 sm:inline-flex">
              <Icon name="terminal" className="size-3.5" /> CLI
            </span>
          ) : null}
        </Card.Footer>
      </Card>
    </a>
  )
}

/** A responsive grid of service cards. */
export function ServiceGrid({ services }: { services: ServiceSummary[] }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,16rem),1fr))] gap-4">
      {services.map((s) => (
        <ServiceCard key={s.name} service={s} />
      ))}
    </div>
  )
}
