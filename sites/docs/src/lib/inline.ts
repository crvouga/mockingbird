import { marked } from "marked"

/** Render the shared copy's inline markdown (code, bold, links) to HTML at build time. */
export const inline = (markdown: string): string => marked.parseInline(markdown, { async: false })
