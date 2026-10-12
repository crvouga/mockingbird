import { posix } from "node:path"
import GithubSlugger from "github-slugger"
import { Marked, type Tokens } from "marked"
import { createHighlighter, type Highlighter, type ThemedToken } from "shiki"
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
  "css",
] as const

const ALIASES: Record<string, string> = {
  ts: "typescript",
  js: "javascript",
  tsx: "typescript",
  jsx: "javascript",
  mjs: "javascript",
  sh: "bash",
  shell: "bash",
  console: "bash",
  zsh: "bash",
  yml: "yaml",
  py: "python",
  postgres: "sql",
  postgresql: "sql",
  pgsql: "sql",
  sqlite: "sql",
}

const THEMES = { light: "github-light", dark: "github-dark" } as const
const SQLISH =
  /\b(select|insert|update|delete|create|alter|drop|with|begin|commit|rollback|from|where|join|values)\b/i

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

/** Syntax-highlighted source for components that supply their own frame. */
export async function highlightSource(code: string, lang: string): Promise<string> {
  return renderSource(await getHighlighter(), code, lang).html
}

function renderSource(h: Highlighter, code: string, rawLang: string | undefined) {
  const requested = (rawLang ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? ""
  const lang = ALIASES[requested] ?? requested
  const known = (LANGS as readonly string[]).includes(lang)
  const use = known ? lang : "text"
  const source = code.replace(/\n$/, "")
  const html =
    use === "typescript" || use === "javascript"
      ? renderScript(h, source, use)
      : h.codeToHtml(source, {
          lang: use,
          themes: THEMES,
          defaultColor: false,
        })
  const label = LANG_LABELS[lang] ?? (known ? lang : requested || "Text")
  return { html, label }
}

function renderCode(h: Highlighter, code: string, rawLang: string | undefined): string {
  const { html, label } = renderSource(h, code, rawLang)
  return `<figure class="code"><figcaption><span>${escapeHtml(label)}</span><button type="button" class="copy" data-copy aria-label="Copy code"><svg class="i i-copy" aria-hidden="true"><use href="#i-copy"/></svg><svg class="i i-check" aria-hidden="true"><use href="#i-check"/></svg></button></figcaption>${html}</figure>`
}

/** TypeScript and JavaScript blocks recolor SQL inside template strings with the SQL grammar. */
function renderScript(h: Highlighter, source: string, lang: "typescript" | "javascript"): string {
  const { tokens, fg, bg } = h.codeToTokens(source, {
    lang,
    themes: THEMES,
    defaultColor: false,
    includeExplanation: true,
  })
  const embedded = tokens.some((line) => line.some(isSqlTemplate))
  if (!embedded) {
    return h.codeToHtml(source, { lang, themes: THEMES, defaultColor: false })
  }
  const lines = tokens
    .map(
      (line) =>
        `<span class="line">${line.map((token) => (isSqlTemplate(token) ? sqlTemplate(h, token) : tokenSpan(token))).join("")}</span>`,
    )
    .join("\n")
  return `<pre class="shiki shiki-themes github-light github-dark" style="--shiki-light:${fg};--shiki-dark:${fg};--shiki-light-bg:${bg};--shiki-dark-bg:${bg}" tabindex="0"><code>${lines}</code></pre>`
}

function isSqlTemplate(token: ThemedToken): boolean {
  const scopes =
    token.explanation?.flatMap((part) => part.scopes.map((scope) => scope.scopeName)) ?? []
  if (!scopes.some((scope) => scope === "string.template.ts" || scope === "string.template.js"))
    return false
  return SQLISH.test(token.content.replace(/^`+|`+$/g, ""))
}

/** A one-line template can include its backticks in the same token. Keep those in the string color. */
function sqlTemplate(h: Highlighter, token: ThemedToken): string {
  let content = token.content
  let lead = ""
  let tail = ""
  if (content.startsWith("`")) {
    lead = tokenSpan({ ...token, content: "`" })
    content = content.slice(1)
  }
  if (content.endsWith("`")) {
    tail = tokenSpan({ ...token, content: "`" })
    content = content.slice(0, -1)
  }
  return `${lead}${sqlSpans(h, content)}${tail}`
}

function sqlSpans(h: Highlighter, content: string): string {
  const { tokens } = h.codeToTokens(content, { lang: "sql", themes: THEMES, defaultColor: false })
  return tokens.map((line) => line.map(tokenSpan).join("")).join("\n")
}

function tokenSpan(token: ThemedToken): string {
  const style = token.htmlStyle ?? {}
  const light = style["--shiki-light"] ?? style.color ?? "inherit"
  const dark = style["--shiki-dark"] ?? light
  return `<span style="--shiki-light:${light};--shiki-dark:${dark}">${escapeHtml(token.content)}</span>`
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
    const guide = /^docs\/((?:[a-z0-9-]+\/)?[A-Za-z0-9_-]+)\.md$/.exec(resolved)?.[1]
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
