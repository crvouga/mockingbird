import { useMemo, useState } from "react"
import { iconSources, type SystemIcon } from "./system-icons.js"

export type IconMarkProps = {
  icon?: SystemIcon | undefined
  label: string
  /** "md" on the System screen's rows, "sm" in the switcher's tooltip. */
  size?: "sm" | "md"
}

/**
 * An app's icon: its inline SVG, or each image source in turn, ending at the label's first
 * letter. `data-icon` says which one shows.
 */
export function IconMark({ icon, label, size = "md" }: IconMarkProps) {
  const sources = useMemo(() => iconSources(icon), [icon])
  // Which source failed last, per list of sources: a new icon starts again from the first.
  const [failed, setFailed] = useState({ sources, count: 0 })
  const attempt = failed.sources === sources ? failed.count : 0
  const box =
    size === "md"
      ? "size-9 rounded-lg bg-default text-sm [&_img]:size-5 [&_svg]:size-5"
      : "size-4 rounded-sm text-[10px] [&_img]:size-4 [&_svg]:size-4"
  const className = `msh-mark inline-grid shrink-0 place-items-center overflow-hidden font-semibold text-foreground ${box}`
  if (icon && "svg" in icon)
    return (
      <span
        className={className}
        data-icon="svg"
        aria-hidden="true"
        // Trusted markup from the host app's own code (see SystemIcon).
        // biome-ignore lint/security/noDangerouslySetInnerHtml: SystemIcon.svg is the host's own markup.
        dangerouslySetInnerHTML={{ __html: icon.svg }}
      />
    )
  const source = sources[attempt]
  if (source === undefined)
    return (
      <span className={className} data-icon="letter" aria-hidden="true">
        {(label.trim()[0] ?? "?").toUpperCase()}
      </span>
    )
  return (
    <span className={className} data-icon="image" aria-hidden="true">
      <img
        src={source}
        alt=""
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setFailed({ sources, count: attempt + 1 })}
      />
    </span>
  )
}
