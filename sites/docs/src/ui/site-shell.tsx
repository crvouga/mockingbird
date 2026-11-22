import { AppShell, Brand, MOCKINGBIRD } from "@crvouga/mockingbird-ui/react"
import { Alert, buttonVariants, Link } from "@heroui/react"
import type { ReactNode } from "react"
import { Icon } from "./icon.tsx"

export const SITE_NAV = [
  { href: "/services", label: "Emulators" },
  { href: "/examples", label: "Examples" },
  { href: "/coverage", label: "Coverage" },
  { href: "/docs", label: "Guides" },
  { href: "/docs/admin-controls", label: "Controls" },
  { href: "/docs/notifications", label: "Notifications" },
  { href: "/why", label: "Why" },
] as const

/** `/docs` prefixes `/docs/admin-controls`, so the longest match is the current section. */
export const currentNav = (path: string): string | undefined =>
  SITE_NAV.filter((item) => path === item.href || path.startsWith(`${item.href}/`)).sort(
    (a, b) => b.href.length - a.href.length,
  )[0]?.href

export type SiteShellProps = {
  /** The page's path, which marks its section in the top bar. */
  path: string
  repo: string
  /** Build-time HTML of a site-wide notice, shown above every page. */
  notice?: string
  /** The top bar's controls: search, GitHub, theme. Islands, passed from Base.astro. */
  actions?: ReactNode
  children?: ReactNode
}

/**
 * Every docs page: the shared AppShell (brand, sections, search, theme) over the page, and the
 * site map below it. The same top bar as the admin, Fleet Cloud and every other surface.
 */
export function SiteShell({ path, repo, notice, actions, children }: SiteShellProps) {
  const current = currentNav(path)
  return (
    <AppShell
      brandHref="/"
      nav={SITE_NAV.map((item) => ({ ...item, current: item.href === current }))}
      actions={actions}
      footer={<SiteFooter repo={repo} />}
    >
      <a
        href="#main"
        className="sr-only rounded-md bg-accent px-3 py-2 text-accent-foreground focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50"
      >
        Skip to content
      </a>
      {notice ? (
        <Alert status="warning" className="mb-6">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description dangerouslySetInnerHTML={{ __html: notice }} />
          </Alert.Content>
        </Alert>
      ) : null}
      <div id="main" tabIndex={-1} className="outline-none">
        {children}
      </div>
    </AppShell>
  )
}

const FOOTER_COLUMNS = (repo: string) => [
  {
    title: "Docs",
    links: [
      { href: "/services", label: "Emulators" },
      { href: "/examples", label: "Examples" },
      { href: "/coverage", label: "Coverage" },
      { href: "/docs", label: "Guides" },
      { href: "/why", label: "Why Mockingbird" },
      { href: "/identity", label: "Design system" },
    ],
  },
  {
    title: "For agents",
    links: [
      { href: "/llms.txt", label: "llms.txt" },
      { href: "/llms-full.txt", label: "llms-full.txt" },
      { href: "/catalog.json", label: "catalog.json" },
    ],
  },
  {
    title: "Project",
    links: [
      { href: repo, label: "GitHub", external: true },
      {
        href: "https://www.npmjs.com/search?q=%40crvouga%2Fmockingbird-service",
        label: "npm",
        external: true,
      },
      {
        href: `${repo}/blob/main/docs/AUTHORING_A_SERVICE.md`,
        label: "Add a service",
        external: true,
      },
    ],
  },
]

function SiteFooter({ repo }: { repo: string }) {
  return (
    <div className="flex flex-col gap-8 py-6">
      <div className="grid grid-cols-2 gap-8 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
        <div className="col-span-2 flex flex-col gap-2 md:col-span-1">
          <Brand href="/" />
          <p className="font-medium text-foreground">{MOCKINGBIRD.tagline}</p>
          <p>Stateful emulators for the third-party APIs and databases your app depends on.</p>
        </div>
        {FOOTER_COLUMNS(repo).map((column) => (
          <div key={column.title}>
            <h2 className="mb-3 text-xs font-semibold tracking-wide text-foreground uppercase">
              {column.title}
            </h2>
            <ul className="m-0 grid list-none gap-2 p-0">
              {column.links.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    className="text-sm text-muted hover:text-foreground"
                    {...("external" in link ? { target: "_blank", rel: "noopener" } : {})}
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap justify-between gap-2 border-t border-separator pt-4 text-xs">
        <span>MIT licensed.</span>
        <span>Every page is generated from the service packages at build time.</span>
      </div>
    </div>
  )
}

/** The GitHub link in the top bar (the footer has it too, so a phone drops it). */
export function GithubAction({ repo }: { repo: string }) {
  return (
    <a
      href={repo}
      target="_blank"
      rel="noopener"
      aria-label="Mockingbird on GitHub"
      className={`${buttonVariants({ variant: "ghost", size: "sm", isIconOnly: true })} hidden sm:inline-flex`}
    >
      <Icon name="github" />
    </a>
  )
}
