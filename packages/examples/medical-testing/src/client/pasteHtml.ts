/**
 * Embedded browsers (IDE panes, in-app webviews) refuse nested frames.
 * Example apps fetch a provider's real HTML and paste it into ordinary light
 * DOM. `:root` / `html` / `body` are rewritten onto an inner `.page`, and all
 * selectors are scoped to the host, so the document's sheet cannot restyle
 * the surrounding app. Keeping the elements in light DOM lets browser and IDE
 * inspection tools select and annotate them normally.
 *
 * The document's `<script>` elements are dropped and never run. Running one means evaluating
 * its text, which a Content Security Policy without `'unsafe-eval'` refuses (the docs site
 * sends one). `hostedPages.ts` implements what those scripts do as ordinary code.
 *
 * Width breakpoints are rewritten onto that `.page` as container queries.
 * A viewport query would still see the browser window, so a desktop-width
 * window would keep a two-column layout inside a narrow popup.
 */

export type HostedSubmit = (action: string, method: string, body: string) => void

export type PasteOptions = {
  /** Intercept form submits and same-document link clicks. */
  onSubmit?: HostedSubmit
}

let pasteSequence = 0

/** Scope a full document's CSS so it applies only inside one light-DOM host. */
export const scopeEmbeddedCss = (
  css: string,
  scopeSelector = '[data-mockingbird-paste="test"]',
): string => {
  let out = ""
  let cursor = 0
  while (cursor < css.length) {
    const brace = css.indexOf("{", cursor)
    if (brace === -1) {
      out += css.slice(cursor)
      break
    }
    const prelude = css.slice(cursor, brace)
    const trimmed = prelude.trimStart()
    if (trimmed.startsWith("@keyframes") || trimmed.startsWith("@font-face")) {
      const end = skipBlock(css, brace)
      out += css.slice(cursor, end)
      cursor = end
      continue
    }
    if (trimmed.startsWith("@")) {
      out += `${rewriteWidthMedia(css.slice(cursor, brace))}{`
      cursor = brace + 1
      continue
    }
    const close = prelude.lastIndexOf("}")
    const head = close === -1 ? "" : prelude.slice(0, close + 1)
    const selector = close === -1 ? prelude : prelude.slice(close + 1)
    const selectorTrimmed = selector.trimStart()
    if (
      close !== -1 &&
      (selectorTrimmed.startsWith("@keyframes") || selectorTrimmed.startsWith("@font-face"))
    ) {
      const end = skipBlock(css, brace)
      out += head + css.slice(cursor + close + 1, end)
      cursor = end
      continue
    }
    if (close !== -1 && selectorTrimmed.startsWith("@")) {
      out += `${head}${rewriteWidthMedia(selector)}{`
      cursor = brace + 1
      continue
    }
    const rewritten = rewriteSelectorList(selector, scopeSelector)
    out += `${head}${rewritten}{`
    if (isDocumentBox(rewritten, scopeSelector)) {
      const end = skipBlock(css, brace)
      out += `${loosenDocumentHeight(css.slice(brace + 1, end - 1))}}`
      cursor = end
      continue
    }
    cursor = brace + 1
  }
  const sized = out.replaceAll("100svh", "100%").replaceAll("100vh", "100%")
  // `.page` is the query container. Its inline size is the host's width, not
  // the min-content of a wide layout, so the rewritten queries stack inside a popup.
  return `${scopeSelector}{display:block;box-sizing:border-box;width:100%;max-width:100%;min-width:0}${scopeSelector}>.page{box-sizing:border-box;width:100%;max-width:100%;min-width:0;min-height:100%;container-type:inline-size}${sized}`
}

/**
 * `@media (min-width: …)` measures the browser. Inside a pasted popup the
 * browser is often wide while the host is not, so a width-only query becomes
 * a container query. Preference queries stay media queries.
 */
const rewriteWidthMedia = (prelude: string): string => {
  const at = prelude.search(/@media\b/i)
  if (at === -1) return prelude
  const condition = prelude.slice(at + "@media".length)
  if (!isWidthOnlyMedia(condition)) return prelude
  // Container queries have no media type. Drop a leading `screen and`.
  const query = condition.replace(/^\s*(?:only\s+)?(?:all|screen|print|speech)\s+and\s+/i, " ")
  return `${prelude.slice(0, at)}@container${query}`
}

const isWidthOnlyMedia = (condition: string): boolean => {
  const body = condition.replace(/\/\*[\s\S]*?\*\//g, " ")
  if (/\bnot\b/i.test(body)) return false
  if (!/(?:min-|max-)?width/i.test(body)) return false
  const stripped = body
    .replace(/\bonly\b/gi, " ")
    .replace(/\b(?:all|screen|print|speech)\b/gi, " ")
    .replace(/\b(?:and|or)\b/gi, " ")
    .replace(/\(\s*(?:min-|max-)?width\s*:\s*[^)]+\)/gi, " ")
    .replace(/\(\s*[^)]*?\bwidth\b[^)]*\)/gi, " ")
  return !/[a-z]/i.test(stripped)
}

/** Paste `html` into `host`. Returns a cleanup that drops the tree. */
export const pasteHtml = (
  host: HTMLElement,
  html: string,
  options: PasteOptions = {},
): (() => void) => {
  const owner = host.ownerDocument
  const parsed = new DOMParser().parseFromString(html, "text/html")
  for (const script of parsed.querySelectorAll("script")) script.remove()
  const css = [...parsed.querySelectorAll("style")]
    .map((style) => style.textContent ?? "")
    .join("\n")
  for (const style of parsed.querySelectorAll("style")) style.remove()

  const pasteId = `p${++pasteSequence}`
  const scopeSelector = `[data-mockingbird-paste="${pasteId}"]`
  host.dataset.mockingbirdPaste = pasteId
  host.replaceChildren()
  const style = owner.createElement("style")
  style.textContent = scopeEmbeddedCss(css, scopeSelector)
  const page = owner.createElement("div")
  page.className = "page"
  host.append(style, page)
  for (const node of [...parsed.body.childNodes]) page.append(owner.adoptNode(node))

  const detach = options.onSubmit ? attachFormInterceptor(host, options.onSubmit) : () => {}
  return () => {
    detach()
    host.replaceChildren()
    delete host.dataset.mockingbirdPaste
  }
}

const attachFormInterceptor = (
  root: ParentNode & EventTarget,
  onSubmit: HostedSubmit,
): (() => void) => {
  const submit = (event: Event) => {
    const formEvent = event as SubmitEvent
    formEvent.preventDefault()
    const form = formEvent.target as HTMLFormElement
    const submitter = formEvent.submitter as HTMLButtonElement | null
    const formData = new FormData(form)
    if (submitter?.name) formData.set(submitter.name, submitter.value)
    const params = new URLSearchParams()
    for (const [key, value] of formData.entries()) {
      if (typeof value === "string") params.append(key, value)
    }
    // `form.action` / `form.method` are unreliable: these hosted pages carry a
    // hidden `<input name="action">`, and a same-named control shadows the
    // form's IDL properties. The content attributes are immune.
    onSubmit(
      form.getAttribute("action") ?? "",
      form.getAttribute("method") ?? "GET",
      params.toString(),
    )
  }

  const click = (event: Event) => {
    const anchor = (event.target as Element | null)?.closest?.("a")
    if (!(anchor instanceof HTMLAnchorElement) || anchor.getAttribute("href") === null) return
    event.preventDefault()
    onSubmit(anchor.href, "GET", "")
  }

  root.addEventListener("submit", submit, { capture: true })
  root.addEventListener("click", click, { capture: true })
  return () => {
    root.removeEventListener("submit", submit, { capture: true })
    root.removeEventListener("click", click, { capture: true })
  }
}

/** Comments are not selectors. A comma inside one must not split the list. */
const stripComments = (value: string): string => value.replace(/\/\*[\s\S]*?\*\//g, "")

/** True when every selector is the pasted document box (rewritten html/body/:root). */
const isDocumentBox = (selector: string, scopeSelector: string): boolean =>
  splitSelectorList(stripComments(selector)).every(
    (part) => part.trim() === `${scopeSelector}>.page`,
  )

/**
 * A pasted document has no canvas. `height: 100%` on the document box paints
 * only the first screen, and the host page shows through the rest of the scroll.
 * `min-height` still fills the frame and grows with the content.
 */
const loosenDocumentHeight = (declarations: string): string =>
  declarations.replace(/(^|;)\s*height(\s*:\s*100%)/g, "$1min-height$2")

const rewriteSelectorList = (selector: string, scopeSelector: string): string => {
  if (selector.trim() === "") return selector
  return splitSelectorList(selector)
    .map((part) => {
      const leading = part.match(/^(?:\s|\/\*[\s\S]*?\*\/)+/)?.[0] ?? ""
      const value = replaceDocumentSelectors(part.slice(leading.length)).trimStart()
      const documentRoot = value.startsWith(".page")
      return `${leading}${scopeSelector}>.page${documentRoot ? value.slice(".page".length) : ` ${value}`}`
    })
    .join(",")
}

/** Rewrite document selectors without changing words inside CSS comments. */
const replaceDocumentSelectors = (selector: string): string =>
  selector
    .split(/(\/\*[\s\S]*?\*\/)/)
    .map((part, index) =>
      index % 2 === 0 ? part.replace(/:root\b|(?<![.\w-])(?:html|body)\b/g, ".page") : part,
    )
    .join("")

/** Split only top-level commas; functional selectors can contain their own lists. */
const splitSelectorList = (selector: string): string[] => {
  const parts: string[] = []
  let start = 0
  let round = 0
  let square = 0
  let quote = ""
  let comment = false
  for (let index = 0; index < selector.length; index++) {
    const char = selector[index] ?? ""
    const next = selector[index + 1] ?? ""
    if (comment) {
      if (char === "*" && next === "/") {
        comment = false
        index++
      }
      continue
    }
    if (quote) {
      if (char === "\\") index++
      else if (char === quote) quote = ""
      continue
    }
    if (char === "/" && next === "*") {
      comment = true
      index++
    } else if (char === '"' || char === "'") quote = char
    else if (char === "(") round++
    else if (char === ")") round = Math.max(0, round - 1)
    else if (char === "[") square++
    else if (char === "]") square = Math.max(0, square - 1)
    else if (char === "," && round === 0 && square === 0) {
      parts.push(selector.slice(start, index))
      start = index + 1
    }
  }
  parts.push(selector.slice(start))
  return parts
}

const skipBlock = (css: string, openBrace: number): number => {
  let depth = 0
  for (let index = openBrace; index < css.length; index++) {
    const char = css[index]
    if (char === "{") depth++
    else if (char === "}") {
      depth--
      if (depth === 0) return index + 1
    }
  }
  return css.length
}
