import { Logo } from "@crvouga/mockingbird-ui/react"
import { buttonVariants, Card } from "@heroui/react"
import { Icon } from "./icon.tsx"
import { Actions, ButtonLink } from "./primitives.tsx"

/**
 * The 404 page: the shared EmptyState's layout (mark, title, what to do) with the page's `h1`, and
 * two ways on (the catalog, the site search).
 */
export function NotFound() {
  return (
    <Card className="mx-auto mt-10 max-w-xl">
      <Card.Content className="flex flex-col items-center gap-3 px-4 py-12 text-center">
        <Logo size={48} />
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Page not found.</h1>
        <p className="max-w-md text-sm text-muted">
          The link may be old, or the service may have a different name. Search from the top bar, or
          start from the catalog.
        </p>
        <Actions className="mt-2 justify-center">
          <ButtonLink href="/services" variant="primary" arrow>
            Browse services
          </ButtonLink>
          {/* Opens the site search (src/ui/search.tsx listens for it). */}
          <button
            type="button"
            className={buttonVariants({ variant: "secondary" })}
            data-palette-open
          >
            <Icon name="search" /> Search
          </button>
        </Actions>
      </Card.Content>
    </Card>
  )
}
