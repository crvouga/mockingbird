import { posix } from "node:path"
import GithubSlugger from "github-slugger"
import { Marked, type Tokens } from "marked"
import { createHighlighter, type Highlighter } from "shiki"
import { guideSlug } from "../../src/lib/guides.ts"
import type { TocEntry } from "../../src/lib/types.ts"

const LANGS = [
  "typescript",
  "javascript",
  "json",
  "jsonc",
  "bash",
  "yaml",
  "sql",
  "http",
  "diff",
  "graphql",
  "python",
  "toml",
  "xml",
  "html",
] as const

const ALIASES: Record<string, string> = {
  ts: "typescript",
  js: "javascript",
  mjs: "javascript",
  sh: "bash",
  shell: "bash",
  console: "bash",
  zsh: "bash",
  yml: "yaml",
  py: "python",
}

let highlighter: Promise<Highlighter> | undefined

const getHighlighter = () => {
  highlighter ??= createHighlighter({ themes: ["github-light", "github-dark"], langs: [...LANGS] })
  return highlighter
}

const LANG_LABELS: Record<string, string> = {
  typescript: "TypeScript",
  javascript: "JavaScript",
  bash: "Shell",
  json: "JSON",
  jsonc: "JSON",
  yaml: "YAML",
  sql: "SQL",
  http: "HTTP",
  graphql: "GraphQL",
  python: "Python",
}

export async function highlight(code: string, lang: string | undefined): Promise<string> {
  return renderCode(await getHighlighter(), code, lang)
}

function renderCode(h: Highlighter, code: string, rawLang: string | undefined): string {
  const requested = (rawLang ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? ""
  const lang = ALIASES[requested] ?? requested
  const known = (LANGS as readonly string[]).includes(lang)
  const html = h.codeToHtml(code.replace(/\n$/, ""), {
    lang: known ? lang : "text",
    themes: { light: "github-light", dark: "github-dark" },
    defaultColor: false,
  })
  const label = LANG_LABELS[lang] ?? (known ? lang : requested || "Text")
  return `<figure class="code"><figcaption><span>${escapeHtml(label)}</span><button type="button" class="copy" data-copy aria-label="Copy code"><svg class="i i-copy" aria-hidden="true"><use href="#i-copy"/></svg><svg class="i i-check" aria-hidden="true"><use href="#i-check"/></svg></button></figcaption>${html}</figure>`
}

export interface LinkContext {
  /** Repo-relative directory the markdown file lives in, e.g. `packages/service/stripe`. */
  dir: string
  repo: string
  /** Published service names, so links to their READMEs stay on the site. */
  services: ReadonlySet<string>
}

export async function renderMarkdown(
  markdown: string,
  ctx: LinkContext,
): Promise<{ html: string; toc: TocEntry[] }> {
  const h = await getHighlighter()
  const slugger = new GithubSlugger()
  const toc: TocEntry[] = []
  let droppedTitle = false

  const marked = new Marked({
    gfm: true,
    renderer: {
      heading(
        this: { parser: { parseInline(t: Tokens.Generic[]): string } },
        token: Tokens.Heading,
      ) {
        if (token.depth === 1 && !droppedTitle) {
          droppedTitle = true
          return ""
        }
        const inner = this.parser.parseInline(token.tokens)
        const text = decodeEntities(inner.replace(/<[^>]+>/g, ""))
        const slug = slugger.slug(text)
        if (token.depth === 2 || token.depth === 3) toc.push({ depth: token.depth, slug, text })
        const level = Math.max(2, token.depth)
        return `<h${level} id="${slug}"><a class="anchor" href="#${slug}" aria-hidden="true" tabindex="-1">#</a>${inner}</h${level}>\n`
      },
      code(token: Tokens.Code) {
        return renderCode(h, token.text, token.lang)
      },
      link(this: { parser: { parseInline(t: Tokens.Generic[]): string } }, token: Tokens.Link) {
        const inner = this.parser.parseInline(token.tokens)
        const href = rewriteHref(token.href, ctx)
        const external = /^https?:\/\//.test(href)
        const title = token.title ? ` title="${escapeHtml(token.title)}"` : ""
        return `<a href="${escapeHtml(href)}"${title}${external ? ' target="_blank" rel="noopener"' : ""}>${inner}</a>`
      },
      image(token: Tokens.Image) {
        const src = rewriteHref(token.href, ctx, "raw")
        return `<img src="${escapeHtml(src)}" alt="${escapeHtml(token.text)}" loading="lazy" decoding="async" />`
      },
    },
  })

  const html = (await marked.parse(markdown))
    .replace(/<table>/g, '<div class="table-wrap"><table>')
    .replace(/<\/table>/g, "</table></div>")
  return { html, toc }
}

const GITHUB_SERVICE =
  /^https:\/\/github\.com\/crvouga\/mockingbird\/(?:blob|tree)\/main\/packages\/service\/([a-z0-9-]+)(\/README\.md)?\/?(#.*)?$/

export function rewriteHref(href: string, ctx: LinkContext, mode: "link" | "raw" = "link"): string {
  if (href.startsWith("#")) return href
  const github = GITHUB_SERVICE.exec(href)
  if (github?.[1] && ctx.services.has(github[1]) && mode === "link") {
    return `/services/${github[1]}${github[3] ?? ""}`
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return href

  const [pathPart = "", hash = ""] = href.split(/(?=#)/)
  const resolved = posix.normalize(posix.join(ctx.dir, pathPart)).replace(/\/$/, "")
  const service = /^packages\/service\/([a-z0-9-]+)(?:\/README\.md)?$/.exec(resolved)?.[1]
  if (service && ctx.services.has(service) && mode === "link") return `/services/${service}${hash}`
  if (mode === "link") {
    const guide = /^docs\/([A-Za-z0-9_-]+)\.md$/.exec(resolved)?.[1]
    if (guide) return `/docs/${guideSlug(guide)}${hash}`
    if (resolved === "README.md") return hash === "#services" ? "/services" : `/${hash}`
    if (resolved === "llms.txt") return "/llms.txt"
  }
  if (mode === "raw")
    return `${ctx.repo.replace("github.com", "raw.githubusercontent.com")}/main/${resolved}`
  return `${ctx.repo}/blob/main/${resolved}${hash}`
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
}

const decodeEntities = (s: string) =>
  s.replace(/&(?:amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m] ?? m)

export const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
