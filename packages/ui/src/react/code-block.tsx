import { Check, Copy } from "@gravity-ui/icons"
import { Button, useIsHydrated } from "@heroui/react"
import { type ReactNode, useEffect, useState } from "react"

export type CodeBlockProps = {
  code: string
  /** Shown above the code: a file name, a route, "Request body". Defaults to `language`. */
  label?: ReactNode
  /** The code's language, shown when there is no label ("json", "sql", "http"). */
  language?: string
  /** Show a copy button (once the page has JavaScript). Default true. */
  copyable?: boolean
  /** Scroll inside the block past this height (CSS length). Default: grow with the code. */
  maxHeight?: string
  /** Wrap long lines instead of scrolling sideways. Default false. */
  wrap?: boolean
  /** The copy button's accessible name ("Copy mockingbird.yaml"). Default "Copy". */
  copyLabel?: string
  /** More buttons beside the copy button (a download, say). */
  actions?: ReactNode
}

/**
 * Monospace code with a copy button: request and response bodies, SQL, config snippets, tokens.
 * Plain text, no highlighting, so it renders the same on the server and in any surface.
 */
export function CodeBlock({
  code,
  label,
  language,
  copyable = true,
  maxHeight,
  wrap = false,
  copyLabel = "Copy",
  actions,
}: CodeBlockProps) {
  // The copy button needs JavaScript; a server-rendered page without a client bundle omits it.
  const hydrated = useIsHydrated()
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  const title = label ?? language
  const copyButton =
    hydrated && copyable ? (
      <Button
        isIconOnly
        size="sm"
        variant="ghost"
        aria-label={copied ? "Copied" : copyLabel}
        className="size-7 min-w-7"
        onPress={() => {
          void navigator.clipboard?.writeText(code).then(() => setCopied(true))
        }}
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </Button>
    ) : null
  return (
    <div
      className="min-w-0 overflow-hidden rounded-lg border border-border bg-surface-secondary"
      data-mockingbird-code
    >
      {title || copyButton || actions ? (
        <div className="flex min-h-9 items-center justify-between gap-2 border-b border-separator py-1 pr-1 pl-3">
          <span className="truncate font-mono text-xs text-muted">{title}</span>
          <span className="flex shrink-0 items-center gap-1">
            {actions}
            {copyButton}
          </span>
        </div>
      ) : null}
      <pre
        className={`m-0 overflow-auto p-3 font-mono text-[13px] leading-relaxed text-foreground ${wrap ? "break-words whitespace-pre-wrap" : "whitespace-pre"}`}
        style={maxHeight ? { maxHeight } : undefined}
      >
        <code>{code}</code>
      </pre>
    </div>
  )
}

export type JsonViewProps = Omit<CodeBlockProps, "code" | "language"> & {
  /** Any JSON-serializable value; pretty-printed with two spaces. */
  value: unknown
}

/** A JSON value in a `CodeBlock`. */
export function JsonView({ value, ...props }: JsonViewProps) {
  const code = value === undefined ? "undefined" : (JSON.stringify(value, null, 2) ?? String(value))
  return <CodeBlock {...props} code={code} language="json" />
}
