import { Link } from "@heroui/react"
import type { ReactNode } from "react"
import { Brand } from "./brand.js"

export type AppShellNavItem = {
  label: ReactNode
  href: string
  /** The page being shown: highlighted, and announced as the current page. */
  current?: boolean
  icon?: ReactNode
}

export type AppShellProps = {
  children?: ReactNode
  /** The surface's name beside the wordmark ("Admin", "Fleet Cloud", "Stripe"). */
  product?: ReactNode
  /** Where the wordmark links: the surface's home. */
  brandHref?: string
  /**
   * Top-level sections. A row beside the brand on wide screens, its own scrolling row under it on
   * a phone. With `MockingbirdProvider navigate`, following one is client-side.
   */
  nav?: AppShellNavItem[]
  /** Right side of the bar: a theme switch, a user menu, a primary action. Keep it short. */
  actions?: ReactNode
  /** Full width content for dense screens (tables, logs). Default: centered, at most 1280px. */
  fluid?: boolean
  /** Below the content, for a status line or links. */
  footer?: ReactNode
}

/**
 * The frame of every full-page Mockingbird surface: a sticky top bar (brand, product, nav,
 * actions) over the page content. One layout everywhere, so every surface reads as the same
 * product. Single-purpose pages (sign-in, consent, pairing) use `CenteredCard` instead.
 */
export function AppShell({
  children,
  product,
  brandHref,
  nav,
  actions,
  fluid = false,
  footer,
}: AppShellProps) {
  const width = fluid ? "w-full" : "mx-auto w-full max-w-[1280px]"
  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground" data-mockingbird-shell>
      <header className="sticky top-0 z-40 border-b border-separator bg-background/90 backdrop-blur">
        <div
          className={`${width} flex flex-wrap items-center gap-x-6 gap-y-0 px-4 sm:px-6 min-h-14`}
        >
          <Brand product={product} {...(brandHref ? { href: brandHref } : {})} className="py-3" />
          {nav && nav.length > 0 ? (
            <nav
              aria-label="Primary"
              className="order-last -mx-4 flex w-[calc(100%+2rem)] items-center gap-1 overflow-x-auto px-3 pb-2 md:order-none md:mx-0 md:w-auto md:overflow-visible md:p-0"
            >
              {nav.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  {...(item.current ? { "aria-current": "page" as const } : {})}
                  className={`inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium no-underline transition-colors hover:bg-default hover:text-foreground ${
                    item.current ? "bg-default text-foreground" : "text-muted"
                  }`}
                >
                  {item.icon}
                  {item.label}
                </Link>
              ))}
            </nav>
          ) : null}
          {actions ? <div className="ml-auto flex items-center gap-2 py-2">{actions}</div> : null}
        </div>
      </header>
      <main className={`${width} flex-1 px-4 py-6 sm:px-6`}>{children}</main>
      {footer ? (
        <footer className="border-t border-separator">
          <div className={`${width} px-4 py-4 text-sm text-muted sm:px-6`}>{footer}</div>
        </footer>
      ) : null}
    </div>
  )
}
