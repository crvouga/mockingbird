import type { ReactNode } from "react"
import {
  CODE_BODY_CLASS,
  CODE_FRAME_CLASS,
  CODE_HEADER_CLASS,
  COPY_BUTTON_CLASS,
  COPY_ICONS_HTML,
} from "./code-frame.ts"
import { Icon, type IconName } from "./icon.tsx"

/**
 * The copy button of a code frame. It works without hydration: `client/site.ts` copies its
 * `copy` text, or the code of its frame (`data-copy-scope`).
 */
export function CopyButton({ copy, label = "Copy code" }: { copy?: string; label?: string }) {
  return (
    <button
      type="button"
      className={COPY_BUTTON_CLASS}
      data-copy={copy ?? ""}
      aria-label={label}
      dangerouslySetInnerHTML={{ __html: COPY_ICONS_HTML }}
    />
  )
}

/**
 * Highlighted code (Shiki HTML rendered at build time) in the frame of the shared `CodeBlock`: a
 * header with the file or language, an optional chip, and a copy button.
 */
export function CodeFrame({
  html,
  label,
  icon,
  badge,
  copy = true,
  className,
  children,
  ariaLabel,
}: {
  /** One or more Shiki `<pre>` blocks. */
  html: string
  label?: ReactNode
  icon?: IconName
  /** Right of the label: a StatusChip or Chip ("Declare", "Fleet"). */
  badge?: ReactNode
  copy?: boolean
  className?: string
  /** Under the code, inside the frame: a result line, a footer. */
  children?: ReactNode
  ariaLabel?: string
}) {
  return (
    <figure
      className={`${CODE_FRAME_CLASS} my-0 ${className ?? ""}`.trim()}
      data-copy-scope
      data-code-frame
      aria-label={ariaLabel}
    >
      {label || badge || copy ? (
        <figcaption className={CODE_HEADER_CLASS}>
          {icon ? <Icon name={icon} className="size-3.5 shrink-0" /> : null}
          <span className="min-w-0 truncate">{label}</span>
          {badge ? <span className="ml-auto flex shrink-0 font-sans">{badge}</span> : null}
          {copy ? (
            <span className={badge ? "" : "ml-auto"}>
              <CopyButton />
            </span>
          ) : null}
        </figcaption>
      ) : null}
      <div className={CODE_BODY_CLASS} dangerouslySetInnerHTML={{ __html: html }} />
      {children}
    </figure>
  )
}
