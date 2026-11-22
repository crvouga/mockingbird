import type { ReactNode } from "react"

export type PageHeaderProps = {
  title: ReactNode
  description?: ReactNode
  /** Buttons for the page as a whole, right-aligned (wrapping under the title on a phone). */
  actions?: ReactNode
  /** Small text above the title: a breadcrumb, the resource type, a status chip. */
  eyebrow?: ReactNode
  /** Heading level of the title. Default 1. */
  level?: 1 | 2
}

/** The title block at the top of a page or a major section, the same size on every surface. */
export function PageHeader({ title, description, actions, eyebrow, level = 1 }: PageHeaderProps) {
  const Heading = level === 1 ? "h1" : "h2"
  return (
    <div
      className="mb-6 flex flex-wrap items-start justify-between gap-x-6 gap-y-3"
      data-mockingbird-page-header
    >
      <div className="min-w-0 flex-1 basis-80">
        {eyebrow ? <div className="mb-1 text-sm text-muted">{eyebrow}</div> : null}
        <Heading
          className={`font-semibold tracking-tight text-foreground ${level === 1 ? "text-2xl" : "text-xl"}`}
        >
          {title}
        </Heading>
        {description ? <p className="mt-1 max-w-prose text-sm text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  )
}
