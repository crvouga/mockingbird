/**
 * A vendor's logo on a white tile, at any pixel size (the landing figures draw them at 20, 28
 * and 44px). Logos are drawn for white, so the tile stays white in both themes, as `Monogram`'s.
 */
export function VendorLogo({
  logo,
  size,
  className,
}: {
  logo: string
  size: number
  className?: string
}) {
  return (
    <span
      className={`grid shrink-0 place-items-center rounded-md border border-border bg-white ${className ?? ""}`.trim()}
      style={{ width: size, height: size }}
    >
      <img
        src={logo}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        className="size-[58%] object-contain"
      />
    </span>
  )
}
