import { GUIDE_CHILDREN, GUIDE_ORDER } from "./content.ts"

export interface GuideSource {
  /** Path under `docs/` without `.md`: `AUTHORING_A_SERVICE`, `admin-controls/RESET`. */
  file: string
  markdown: string
}

export interface GuideInfo {
  file: string
  slug: string
  title: string
  summary: string
  /** Slug of the guide this one is a page of: `admin-controls` for `admin-controls/reset`. */
  parent?: string
  /** Extra words the page should be found by, from its `<!-- search: … -->` comment. */
  keywords: string
}

/**
 * `AUTHORING_A_SERVICE` → `authoring-a-service`, `admin-controls/RESET` → `admin-controls/reset`;
 * the site serves it at `/docs/<slug>`.
 */
export const guideSlug = (file: string): string => file.toLowerCase().replace(/_/g, "-")

/** The first `# ` heading and the first paragraph after it, as plain one-line text. */
export function guideInfo({ file, markdown }: GuideSource): GuideInfo {
  const lines = markdown.split("\n")
  const h1 = lines.findIndex((l) => l.startsWith("# "))
  const title = h1 === -1 ? file : (lines[h1]?.slice(2).trim() ?? file)
  const paragraph: string[] = []
  for (const line of lines.slice(h1 + 1)) {
    if (line.trim() === "") {
      if (paragraph.length > 0) break
      continue
    }
    if (/^(#|```|\||- |\d+\. |>|<!--)/.test(line)) {
      if (paragraph.length > 0) break
      continue
    }
    paragraph.push(line.trim())
  }
  const slug = guideSlug(file)
  const parent = slug.includes("/") ? slug.slice(0, slug.lastIndexOf("/")) : undefined
  return {
    file,
    slug,
    title,
    summary: paragraph.join(" "),
    ...(parent !== undefined ? { parent } : {}),
    keywords: /<!--\s*search:\s*([\s\S]*?)-->/.exec(markdown)?.[1]?.trim() ?? "",
  }
}

/** A summary as plain text, for a card or a search result: its markdown code marks removed. */
export const plainSummary = (summary: string): string => summary.replace(/`/g, "")

/** A guide's pages follow it, in the order `GUIDE_CHILDREN` gives; others follow by name. */
export function sortGuides<T extends { file: string }>(guides: T[]): T[] {
  const rank = (order: readonly string[], name: string) => {
    const i = order.indexOf(name)
    return i === -1 ? order.length : i
  }
  const top = guides
    .filter((g) => !g.file.includes("/"))
    .sort(
      (a, b) =>
        rank(GUIDE_ORDER, a.file) - rank(GUIDE_ORDER, b.file) || a.file.localeCompare(b.file),
    )
  return top.flatMap((parent) => {
    const dir = `${guideSlug(parent.file)}/`
    const children: Record<string, readonly string[]> = GUIDE_CHILDREN
    const order = children[parent.file] ?? []
    const name = (g: T) => g.file.slice(dir.length)
    const pages = guides
      .filter((g) => g.file.startsWith(dir))
      .sort((a, b) => rank(order, name(a)) - rank(order, name(b)) || a.file.localeCompare(b.file))
    return [parent, ...pages]
  })
}
