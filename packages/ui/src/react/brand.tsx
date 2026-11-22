import type { ReactNode } from "react"
import { MARK_FONT_FAMILY, MOCKINGBIRD } from "../brand.js"

export type LogoProps = {
  /** Pixel size of the mark. Default 24. */
  size?: number
  className?: string
}

/** The Mockingbird mark: the black bird emoji, decorative (pair it with the wordmark or a label). */
export function Logo({ size = 24, className }: LogoProps) {
  return (
    <span
      aria-hidden="true"
      className={`inline-grid shrink-0 place-items-center leading-none ${className ?? ""}`.trim()}
      style={{ width: size, height: size, fontSize: size, fontFamily: MARK_FONT_FAMILY }}
    >
      {MOCKINGBIRD.icon}
    </span>
  )
}

export type BrandProps = {
  /**
   * The surface's name after the wordmark: "Admin", "Fleet Cloud", "Notifications", or the
   * emulated product on an emulator's page ("Google sign-in").
   */
  product?: ReactNode
  /** Makes the wordmark a link (the surface's home). */
  href?: string
  /** Mark size in pixels. Default 24. */
  size?: number
  className?: string
}

/** Mark, wordmark and the surface's name: the same lockup at the top of every surface. */
export function Brand({ product, href, size = 24, className }: BrandProps) {
  const lockup = (
    <>
      <Logo size={size} />
      <span className="font-semibold tracking-tight text-foreground">{MOCKINGBIRD.name}</span>
    </>
  )
  return (
    <span
      className={`inline-flex min-w-0 items-center gap-2 text-base ${className ?? ""}`.trim()}
      data-mockingbird-brand
    >
      {href ? (
        <a
          href={href}
          className="inline-flex items-center gap-2 rounded-sm no-underline outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          {lockup}
        </a>
      ) : (
        lockup
      )}
      {product ? (
        <>
          <span aria-hidden="true" className="text-muted">
            /
          </span>
          <span className="truncate font-medium text-muted">{product}</span>
        </>
      ) : null}
    </span>
  )
}
