import { GUIDE_ORDER } from "./content.ts"

export interface GuideSource {
  /** File name without `.md`, e.g. `AUTHORING_A_SERVICE`. */
  file: string
  markdown: string
}

export interface GuideInfo {
  file: string
  slug: string
  title: string
  summary: string
}

/** `AUTHORING_A_SERVICE` → `authoring-a-service`; the site serves it at `/docs/<slug>`. */
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
    if (/^(#|```|\||- |\d+\. |>)/.test(line)) {
      if (paragraph.length > 0) break
      continue
    }
    paragraph.push(line.trim())
  }
  return { file, slug: guideSlug(file), title, summary: paragraph.join(" ") }
}

export function sortGuides<T extends { file: string }>(guides: T[]): T[] {
  const rank = (file: string) => {
    const i = GUIDE_ORDER.indexOf(file)
    return i === -1 ? GUIDE_ORDER.length : i
  }
  return [...guides].sort((a, b) => rank(a.file) - rank(b.file) || a.file.localeCompare(b.file))
}
