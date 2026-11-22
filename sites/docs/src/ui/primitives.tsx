/**
 * The docs site's building blocks, composed from HeroUI and the shared Mockingbird components so
 * every page reads like every other Mockingbird surface. Pages (`src/pages/*.astro`) only arrange
 * these; none of them carries styles of its own.
 */

import { PageHeader } from "@crvouga/mockingbird-ui/react"
import { avatarVariants, Breadcrumbs, buttonVariants, Card, Chip, Link } from "@heroui/react"
import type { ElementType, ReactNode } from "react"
import { initials } from "../lib/format.ts"
import { Icon, type IconName } from "./icon.tsx"

/** Markup rendered at build time (inline markdown, Shiki, a README), as `set:html` does in Astro. */
export function Html({
  html,
  as: Tag = "span",
  className,
  id,
}: {
  html: string
  as?: ElementType
  className?: string
  id?: string
}) {
  return <Tag className={className} id={id} dangerouslySetInnerHTML={{ __html: html }} />
}

type ButtonLinkProps = {
  href: string
  children: ReactNode
  variant?: "primary" | "secondary" | "tertiary" | "outline" | "ghost"
  size?: "sm" | "md" | "lg"
  icon?: IconName
  /** An arrow after the label: the link leads somewhere further. */
  arrow?: boolean
  external?: boolean
  className?: string
}

/**
 * A link that looks like a HeroUI Button (HeroUI v3's Button is a `<button>`, so links take its
 * classes): "Get started", "Source", "Live demo".
 */
export function ButtonLink({
  href,
  children,
  variant = "secondary",
  size = "md",
  icon,
  arrow = false,
  external = false,
  className,
}: ButtonLinkProps) {
  return (
    <a
      href={href}
      className={`${buttonVariants({ variant, size })} no-underline ${className ?? ""}`.trim()}
      {...(external ? { target: "_blank", rel: "noopener" } : {})}
    >
      {icon ? <Icon name={icon} /> : null}
      {children}
      {arrow ? <Icon name="arrow-right" /> : null}
    </a>
  )
}

/** An inline text link with an optional trailing arrow ("All 130 emulators →"). */
export function TextLink({
  href,
  children,
  arrow = false,
  external = false,
  className,
}: {
  href: string
  children: ReactNode
  arrow?: boolean
  external?: boolean
  className?: string
}) {
  return (
    <Link
      href={href}
      className={`gap-1.5 text-sm ${className ?? ""}`.trim()}
      {...(external ? { target: "_blank", rel: "noopener" } : {})}
    >
      {children}
      {arrow ? <Icon name="arrow-right" className="size-3.5" /> : null}
    </Link>
  )
}

/**
 * A service's mark: its vendor logo on a white tile (logos are drawn for white, so the tile stays
 * white in both themes), or its initials when it has none. HeroUI's Avatar, with a plain `<img>`
 * so it shows without JavaScript.
 */
export function Monogram({
  name,
  logo,
  size = "md",
}: {
  name: string
  logo?: string | null
  size?: "sm" | "md" | "lg"
}) {
  const slots = avatarVariants({ size })
  return (
    <span
      aria-hidden="true"
      className={`${slots.base()} rounded-md ${logo ? "border border-border bg-white" : ""}`}
    >
      {logo ? (
        <img
          src={logo}
          alt=""
          loading="lazy"
          decoding="async"
          className="absolute inset-[18%] size-[64%] object-contain"
        />
      ) : (
        <span className={`${slots.fallback()} font-mono`}>{initials(name)}</span>
      )}
    </span>
  )
}

/** The star chip every featured emulator wears. */
export function FeaturedChip() {
  return (
    <Chip color="accent" variant="soft" size="sm" className="shrink-0" title="Featured emulator">
      <Icon name="star-fill" className="size-3" />
      <Chip.Label>Featured</Chip.Label>
    </Chip>
  )
}

/** A neutral fact about a service ("Parity: v1", "Node server"). */
export function FactChip({
  children,
  color = "default",
}: {
  children: ReactNode
  color?: "default" | "accent" | "success" | "warning"
}) {
  return (
    <Chip color={color} variant="soft" size="sm">
      <Chip.Label>{children}</Chip.Label>
    </Chip>
  )
}

/** A chip that links: the services an example uses, a category. */
export function LinkChip({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} className="no-underline transition-opacity hover:opacity-80">
      <Chip variant="soft" size="sm">
        <Chip.Label>{children}</Chip.Label>
      </Chip>
    </a>
  )
}

/**
 * A titled section of a long page: the shared PageHeader at level 2 (eyebrow, title,
 * description, actions), then its content.
 */
export function Section({
  id,
  eyebrow,
  title,
  description,
  actions,
  children,
  className,
}: {
  id?: string
  eyebrow?: ReactNode
  title: ReactNode
  /** Plain text, or build-time HTML (inline markdown) as `{ html }`. */
  description?: ReactNode | { html: string }
  actions?: ReactNode
  children?: ReactNode
  className?: string
}) {
  const body =
    description && typeof description === "object" && "html" in description ? (
      <Html html={description.html} className="[&_a]:text-link [&_code]:font-mono" />
    ) : (
      (description as ReactNode)
    )
  return (
    <section id={id} className={`scroll-mt-20 pt-16 first:pt-0 ${className ?? ""}`.trim()}>
      <PageHeader level={2} eyebrow={eyebrow} title={title} description={body} actions={actions} />
      {children}
    </section>
  )
}

/** "Docs › Guide › Page", from HeroUI's Breadcrumbs. */
export function Crumbs({ items }: { items: { label: ReactNode; href?: string }[] }) {
  return (
    <Breadcrumbs className="mb-4 text-sm">
      {items.map((item, index) => (
        <Breadcrumbs.Item
          // biome-ignore lint/suspicious/noArrayIndexKey: a breadcrumb trail is fixed per page.
          key={index}
          {...(item.href ? { href: item.href } : {})}
        >
          {item.label}
        </Breadcrumbs.Item>
      ))}
    </Breadcrumbs>
  )
}

/** Previous / next links at the end of a page in a sequence. */
export function Pager({
  label,
  previous,
  next,
}: {
  label: string
  previous?: { href: string; title: ReactNode } | null
  next?: { href: string; title: ReactNode } | null
}) {
  if (!previous && !next) return null
  return (
    <nav aria-label={label} className="mt-16 grid grid-cols-2 gap-3">
      {previous ? (
        <PagerCard href={previous.href} rel="prev" hint="Previous" title={previous.title} />
      ) : (
        <span />
      )}
      {next ? (
        <PagerCard href={next.href} rel="next" hint="Next" title={next.title} align="end" />
      ) : null}
    </nav>
  )
}

function PagerCard({
  href,
  rel,
  hint,
  title,
  align = "start",
}: {
  href: string
  rel: "prev" | "next"
  hint: string
  title: ReactNode
  align?: "start" | "end"
}) {
  return (
    <a href={href} rel={rel} className="group no-underline">
      <Card
        className={`h-full gap-0.5 p-4 transition-colors group-hover:bg-surface-secondary ${align === "end" ? "text-right" : ""}`}
      >
        <span className="text-xs text-muted">{hint}</span>
        <strong className="text-sm font-semibold text-foreground">{title}</strong>
      </Card>
    </a>
  )
}

/** "On this page": the headings of a long page; `client/toc.ts` marks the one in view. */
export function Toc({ items }: { items: { depth: number; slug: string; text: string }[] }) {
  if (items.length === 0) return null
  return (
    <aside
      aria-label="On this page"
      className="sticky top-20 hidden max-h-[calc(100dvh-6rem)] self-start overflow-y-auto pt-2 text-sm xl:block"
      data-toc
    >
      <p className="mb-2 font-semibold text-foreground">On this page</p>
      <ul className="m-0 list-none border-l border-border p-0">
        {items.map((item) => (
          <li key={item.slug}>
            <a
              href={`#${item.slug}`}
              className={`-ml-px block border-l border-transparent py-1 pr-1 leading-snug text-muted no-underline hover:text-foreground aria-[current=true]:border-accent aria-[current=true]:text-foreground ${
                item.depth >= 4 ? "pl-8 text-xs" : item.depth === 3 ? "pl-6" : "pl-3"
              }`}
            >
              {item.text}
            </a>
          </li>
        ))}
      </ul>
    </aside>
  )
}

/** A small icon tile for a feature or a device: the icon in the accent color, on a soft tile. */
export function IconTile({ name }: { name: IconName | (string & {}) }) {
  return (
    <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent-soft-foreground">
      <Icon name={name} />
    </span>
  )
}

/** A feature: icon, title and a line of build-time HTML, in a HeroUI Card. */
export function FeatureCard({
  icon,
  title,
  html,
  href,
  linkLabel,
}: {
  icon: string
  title: ReactNode
  html: string
  href?: string
  linkLabel?: string
}) {
  return (
    <Card className="h-full">
      <Card.Header className="gap-3">
        <IconTile name={icon} />
        <Card.Title className="text-base font-semibold">
          {href ? (
            <a href={href} className="text-foreground no-underline hover:text-accent">
              {title}
            </a>
          ) : (
            title
          )}
        </Card.Title>
      </Card.Header>
      <Card.Content>
        <Html
          as="p"
          html={html}
          className="text-sm leading-relaxed text-muted [&_a]:text-link [&_code]:font-mono [&_code]:text-[0.85em] [&_code]:text-foreground"
        />
      </Card.Content>
      {href && linkLabel ? (
        <Card.Footer>
          <TextLink href={href} arrow>
            {linkLabel}
          </TextLink>
        </Card.Footer>
      ) : null}
    </Card>
  )
}

/** A row of actions (ButtonLinks) under a section or at the end of a page. */
export function Actions({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={`flex flex-wrap gap-2.5 ${className ?? ""}`.trim()}>{children}</div>
}
