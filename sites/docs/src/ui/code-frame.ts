/**
 * The frame around highlighted code, shared by the React `CodeFrame` (src/ui/code.tsx) and the
 * build-time markdown renderer (integrations/catalog/markdown.ts), which emits it as a string for
 * every code fence in a README or guide. It is the shared `CodeBlock`'s frame (packages/ui), with
 * Shiki's colors inside. The copy button works through `client/site.ts`: it copies `data-copy`,
 * or the text of the `<pre>` in its `[data-copy-scope]`.
 */
import { buttonVariants } from "@heroui/styles"

export const CODE_FRAME_CLASS =
  "my-4 min-w-0 overflow-hidden rounded-lg border border-border bg-surface-secondary"

export const CODE_HEADER_CLASS =
  "flex min-h-9 items-center gap-2 border-b border-separator py-1 pr-1 pl-3 font-mono text-xs text-muted"

/** Shiki's `<pre>` (or several), as the shared CodeBlock draws its own. */
export const CODE_BODY_CLASS =
  "[&_pre]:m-0 [&_pre]:overflow-x-auto [&_pre]:bg-transparent! [&_pre]:p-3 [&_pre]:font-mono [&_pre]:text-[13px] [&_pre]:leading-relaxed [&_pre]:[tab-size:2] [&_pre]:outline-none"

export const COPY_BUTTON_CLASS = `${buttonVariants({ variant: "ghost", size: "sm", isIconOnly: true })} group ml-auto size-7 min-w-7 text-muted`

const COPY_SVG =
  '<svg aria-hidden="true" class="size-3.5 group-data-[copied]:hidden" viewBox="0 0 16 16" fill="none"><path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M12 2.5H8A1.5 1.5 0 0 0 6.5 4v1H8a3 3 0 0 1 3 3v1.5h1A1.5 1.5 0 0 0 13.5 8V4A1.5 1.5 0 0 0 12 2.5M11 11h1a3 3 0 0 0 3-3V4a3 3 0 0 0-3-3H8a3 3 0 0 0-3 3v1H4a3 3 0 0 0-3 3v4a3 3 0 0 0 3 3h4a3 3 0 0 0 3-3zM4 6.5h4A1.5 1.5 0 0 1 9.5 8v4A1.5 1.5 0 0 1 8 13.5H4A1.5 1.5 0 0 1 2.5 12V8A1.5 1.5 0 0 1 4 6.5"/></svg>'
const CHECK_SVG =
  '<svg aria-hidden="true" class="hidden size-3.5 group-data-[copied]:block" viewBox="0 0 16 16" fill="none"><path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M13.488 3.43a.75.75 0 0 1 .081 1.058l-6 7a.75.75 0 0 1-1.1.042l-3.5-3.5A.75.75 0 0 1 4.03 6.97l2.928 2.927 5.473-6.385a.75.75 0 0 1 1.057-.081"/></svg>'

/** The copy button's two icons, swapped by `data-copied` while "Copied" shows. */
export const COPY_ICONS_HTML = `${COPY_SVG}${CHECK_SVG}`

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

/** A highlighted code block with its language and a copy button, as an HTML string. */
export function codeFrameHtml(label: string, shikiHtml: string): string {
  return `<figure class="${CODE_FRAME_CLASS}" data-copy-scope data-code-frame><figcaption class="${CODE_HEADER_CLASS}"><span class="truncate">${escapeHtml(label)}</span><button type="button" class="${COPY_BUTTON_CLASS}" data-copy aria-label="Copy code">${COPY_ICONS_HTML}</button></figcaption><div class="${CODE_BODY_CLASS}">${shikiHtml}</div></figure>`
}
