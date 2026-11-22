/**
 * The HTML document around every page Mockingbird serves as a string: an emulator's sign-in,
 * consent or pairing page, an inspector, a report, a harness. One function, so every one of them
 * has the same head (charset, viewport, color scheme, title suffix, the bird favicon), the same
 * stylesheet, the same theme switch and the same way of starting a prebuilt client bundle.
 *
 * Framework-free and DOM-free: it runs in any runtime, on the request path, and pulls in neither
 * React nor the stylesheet. The caller passes the markup (`renderPage` from
 * `@crvouga/mockingbird-ui/react/server` renders it with React) and the CSS (`MOCKINGBIRD_CSS`
 * from `@crvouga/mockingbird-ui/styles`, or a URL the page links to).
 */
import { MARK_FONT_FAMILY, MOCKINGBIRD } from "./brand.js"
import { THEME_SCRIPT } from "./theme-preference.js"

export type DocumentTheme = "system" | "light" | "dark"

/** A prebuilt browser bundle (see packages/ui/scripts/bundle.ts) and how to start it. */
export type DocumentScript = {
  /** The bundle's source: the string `scripts/bundle.ts` emits. */
  source: string
  /**
   * The global function the bundle defines that starts the page, called as
   * `call(document.getElementById(rootId), props)` once the bundle has run. Example:
   * `"MockingbirdOAuth.mountConsent"`.
   */
  call: string
  /** JSON-serializable; it is embedded in the page, so never put a secret here. */
  props?: unknown
}

export type DocumentOptions = {
  /** The page's own title; " · Mockingbird" is appended. */
  title: string
  /**
   * Markup for the root element: server-rendered HTML, which works without JavaScript (forms
   * post natively). A `script` hydrates it, or renders into an empty root.
   */
  body?: string
  /** The stylesheet: `MOCKINGBIRD_CSS` inlined, or `{ href }` to link a served copy. */
  css: string | { href: string }
  /** Extra trusted markup for `<head>` (meta tags, a page-specific `<style>`). */
  head?: string
  script?: DocumentScript
  /** Default "system": follows the visitor's light or dark preference. */
  theme?: DocumentTheme
  /**
   * With theme "system", apply the light or dark choice the visitor made with `ThemeSwitch` (or on
   * the docs site) before first paint. Adds a small inline script (it carries `nonce`).
   */
  rememberTheme?: boolean
  lang?: string
  /** The root element's id. Default "root". */
  rootId?: string
  /** A Content-Security-Policy nonce for the inline `<style>` and `<script>` elements. */
  nonce?: string
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}

/** Escape text for an HTML text node or a quoted attribute. */
export const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char)

/**
 * A value as a JavaScript expression that is safe inside `<script>`: JSON with `<` escaped, so
 * no `</script>` or `<!--` in the data can end the element early. Also escapes U+2028/2029.
 */
export const scriptJson = (value: unknown): string =>
  (JSON.stringify(value ?? null) ?? "null")
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")

/** A JavaScript source that is safe inside `<script>`: no `</script` can end the element. */
export const scriptSource = (source: string): string => source.replace(/<\/script/gi, "<\\/script")

/** The bird, as a favicon that needs no request. */
export const MARK_FAVICON = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><text x="32" y="53" text-anchor="middle" font-size="54" font-family='${MARK_FONT_FAMILY}'>${MOCKINGBIRD.icon}</text></svg>`,
)}`

const CALL = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/

/** A complete `<!doctype html>` document for a Mockingbird page. */
export function renderDocument(options: DocumentOptions): string {
  const rootId = options.rootId ?? "root"
  const nonce = options.nonce ? ` nonce="${escapeHtml(options.nonce)}"` : ""
  const theme = options.theme ?? "system"
  // `data-theme` pins light or dark for the whole page, overlays included (they render into
  // <body>); without it the tokens follow the system preference.
  const themeAttr = theme === "system" ? "" : ` data-theme="${theme}" class="${theme}"`
  const css =
    typeof options.css === "string"
      ? `<style${nonce}>${options.css.replace(/<\/style/gi, "<\\/style")}</style>`
      : `<link rel="stylesheet" href="${escapeHtml(options.css.href)}">`
  const remember =
    options.rememberTheme && theme === "system" ? `<script${nonce}>${THEME_SCRIPT}</script>` : ""
  let script = ""
  if (options.script) {
    const { call, source, props } = options.script
    if (!CALL.test(call))
      throw new Error(`renderDocument: script.call must be a global name, got ${call}`)
    script = `<script${nonce}>${scriptSource(source)}\n;${call}(document.getElementById(${scriptJson(rootId)}), ${scriptJson(props)});</script>`
  }
  return `<!doctype html><html lang="${escapeHtml(options.lang ?? "en")}"${themeAttr}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="${theme === "system" ? "light dark" : theme}"><title>${escapeHtml(options.title)} · ${MOCKINGBIRD.name}</title><link rel="icon" href="${MARK_FAVICON}">${remember}${css}${options.head ?? ""}</head><body><div id="${escapeHtml(rootId)}" data-mockingbird-root>${options.body ?? ""}</div>${script}</body></html>`
}
