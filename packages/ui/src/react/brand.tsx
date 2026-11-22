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
   * The surface's name, shown instead of the Mockingbird lockup: "Emulators", "Fleet Cloud",
   * "Notifications", or the emulated product on an emulator's page ("Google sign-in").
   */
  product?: ReactNode
  /** Makes the wordmark a link (the surface's home). */
  href?: string
  /** Mark size in pixels. Default 24. */
  size?: number
  className?: string
}

/**
 * The name at the top of a surface. With a `product` it is that name alone, with no Mockingbird
 * mark: an admin, a harness or an example app should read like any other app, not like an ad.
 * Without one it is the Mockingbird lockup (mark and wordmark), which only Mockingbird's own site
 * shows.
 */
export function Brand({ product, href, size = 24, className }: BrandProps) {
  const lockup = product ? (
    <span className="truncate font-semibold tracking-tight text-foreground">{product}</span>
  ) : (
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
          className="inline-flex min-w-0 items-center gap-2 rounded-sm no-underline outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          {lockup}
        </a>
      ) : (
        lockup
      )}
    </span>
  )
}
