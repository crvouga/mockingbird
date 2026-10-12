import { marked } from "marked"

/**
 * Render the shared copy's inline markdown (code, bold, links) to HTML at build time. The copy
 * links guides by their repo path, which is right in the README; here `docs/FLEETS.md` becomes
 * the page the site serves it at, `/docs/fleets`.
 */
export const inline = (markdown: string): string =>
  marked
    .parseInline(markdown, { async: false })
    .replace(
      /href="docs\/((?:[a-z0-9-]+\/)?[A-Z0-9_]+)\.md(#[^"]*)?"/g,
      (_, file: string, hash = "") =>
        `href="/docs/${file.toLowerCase().replace(/_/g, "-")}${hash}"`,
    )
