import { PageHeader } from "@crvouga/mockingbird-ui/react"
import { Card, Link } from "@heroui/react"
import type { ReactNode } from "react"
import { Icon } from "./icon.tsx"
import { Crumbs, Pager, Toc } from "./primitives.tsx"
import { Prose } from "./prose.tsx"

export type GuideLink = { slug: string; title: string; summary?: string }
export type GuideNavGroup = GuideLink & { pages: GuideLink[] }

/** A side-navigation link, drawn like the AppShell's own section links. */
function NavLink({
  href,
  current,
  children,
  nested = false,
}: {
  href: string
  current?: boolean
  children: ReactNode
  nested?: boolean
}) {
  return (
    <a
      href={href}
      {...(current ? { "aria-current": "page" as const } : {})}
      className={`flex items-center gap-2 rounded-md px-2.5 py-1.5 leading-snug no-underline transition-colors hover:bg-default hover:text-foreground ${
        current ? "bg-default font-medium text-foreground" : "text-muted"
      } ${nested ? "text-[13px]" : "text-sm"}`}
    >
      {children}
    </a>
  )
}

function NavHeading({ children }: { children: ReactNode }) {
  return (
    <p className="mt-6 mb-1.5 px-2.5 text-xs font-semibold tracking-wide text-muted uppercase">
      {children}
    </p>
  )
}

/** Every guide, its pages, the reference pages and the featured emulators. */
export function GuideNav({
  groups,
  current,
  featured,
}: {
  groups: GuideNavGroup[]
  current: string
  featured: { name: string; displayName: string }[]
}) {
  return (
    <nav
      aria-label="Documentation"
      className="sticky top-20 hidden max-h-[calc(100dvh-6rem)] self-start overflow-y-auto pb-6 lg:block"
    >
      <NavLink href="/docs">
        <Icon name="file" /> <span className="font-medium text-foreground">Documentation</span>
      </NavLink>
      <NavHeading>Guides</NavHeading>
      <ul className="m-0 grid list-none gap-0.5 p-0">
        {groups.map((group) => (
          <li key={group.slug}>
            <NavLink href={`/docs/${group.slug}`} current={group.slug === current}>
              {group.title}
            </NavLink>
            {group.pages.length > 0 ? (
              <ul className="my-1 ml-3 grid list-none gap-0.5 border-l border-separator p-0 pl-1.5">
                {group.pages.map((page) => (
                  <li key={page.slug}>
                    <NavLink href={`/docs/${page.slug}`} current={page.slug === current} nested>
                      {page.title}
                    </NavLink>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
      <NavHeading>Reference</NavHeading>
      <NavLink href="/services">Emulator catalog</NavLink>
      <NavLink href="/coverage">Operation coverage</NavLink>
      <NavLink href="/examples">Application examples</NavLink>
      <NavHeading>Featured emulators</NavHeading>
      {featured.map((s) => (
        <NavLink key={s.name} href={`/services/${s.name}`}>
          <Icon name="star" className="size-3.5 text-accent" /> {s.displayName}
        </NavLink>
      ))}
    </nav>
  )
}

export type GuideArticleProps = {
  nav: GuideNavGroup[]
  featured: { name: string; displayName: string }[]
  guide: { slug: string; title: string; file: string; html: string; toc: GuideTocEntry[] }
  parent?: GuideLink
  previous?: GuideLink
  next?: GuideLink
  repo: string
  /** Above the article's text: the admin controls directory on a control page. */
  lead?: ReactNode
  /** After the pager: a call to action. */
  children?: ReactNode
}

type GuideTocEntry = { depth: number; slug: string; text: string }

/**
 * A guide (`docs/*.md`): the documentation nav, the article (crumbs, title, its source, the
 * rendered markdown, previous and next), and "On this page".
 */
export function GuideArticle({
  nav,
  featured,
  guide,
  parent,
  previous,
  next,
  repo,
  lead,
  children,
}: GuideArticleProps) {
  return (
    <div className="grid gap-8 lg:grid-cols-[13rem_minmax(0,1fr)] xl:grid-cols-[13rem_minmax(0,1fr)_11rem]">
      <GuideNav groups={nav} current={guide.slug} featured={featured} />
      <article className="min-w-0 max-w-3xl">
        <Crumbs
          items={[
            { label: "Docs", href: "/docs" },
            ...(parent ? [{ label: parent.title, href: `/docs/${parent.slug}` }] : []),
            { label: guide.title },
          ]}
        />
        <PageHeader
          title={guide.title}
          description={
            <>
              <code className="font-mono text-xs">docs/{guide.file}.md</code> · the same file GitHub
              renders ·{" "}
              <Link
                href={`${repo}/blob/main/docs/${guide.file}.md`}
                target="_blank"
                rel="noopener"
                className="text-sm"
              >
                Edit on GitHub
              </Link>{" "}
              ·{" "}
              <Link href={`/docs/${guide.slug}.md`} className="text-sm">
                Markdown
              </Link>
            </>
          }
        />
        {lead}
        <Prose html={guide.html} />
        <Pager
          label="More in this guide"
          previous={previous ? { href: `/docs/${previous.slug}`, title: previous.title } : null}
          next={next ? { href: `/docs/${next.slug}`, title: next.title } : null}
        />
        {children}
      </article>
      <Toc items={guide.toc} />
    </div>
  )
}

/** A guide as a link card, on the docs index. */
export function GuideCard({ guide, icon = false }: { guide: GuideLink; icon?: boolean }) {
  return (
    <a
      href={`/docs/${guide.slug}`}
      className="group block h-full rounded-xl text-foreground no-underline outline-none focus-visible:ring-2 focus-visible:ring-focus"
    >
      <Card className="h-full flex-row items-start gap-3 transition-colors group-hover:bg-surface-secondary">
        {icon ? (
          <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent-soft-foreground">
            <Icon name="file" />
          </span>
        ) : null}
        <div className="min-w-0 flex-1">
          <Card.Title className="text-base font-semibold">{guide.title}</Card.Title>
          {guide.summary ? (
            <Card.Description className="mt-1 line-clamp-3 text-sm leading-relaxed">
              {guide.summary}
            </Card.Description>
          ) : null}
        </div>
        <Icon name="arrow-right" className="mt-1 size-4 shrink-0 text-muted" />
      </Card>
    </a>
  )
}
