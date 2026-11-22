/**
 * Embedded browsers refuse nested frames, so the example pastes each
 * fetched document into its own shadow tree. `:root` / `html` / `body`
 * land on an inner `.page` and do not restyle the shell around it.
 * Returns that `.page` element.
 */
export function pasteDocument(host: HTMLElement, html: string): HTMLElement {
  const owner = host.ownerDocument
  const parsed = new DOMParser().parseFromString(html, "text/html")
  for (const script of parsed.querySelectorAll("script")) script.remove()
  const css = [...parsed.querySelectorAll("style")]
    .map((style) => style.textContent ?? "")
    .join("\n")
  for (const style of parsed.querySelectorAll("style")) style.remove()
  registerProperties(owner, css)

  const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" })
  shadow.replaceChildren()
  const style = owner.createElement("style")
  style.textContent = scopeEmbeddedCss(css)
  const page = owner.createElement("div")
  page.className = "page"
  shadow.append(style, page)
  for (const node of [...parsed.body.childNodes]) page.append(owner.adoptNode(node))
  return page
}

const scopeEmbeddedCss = (css: string): string => {
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
    const rewritten = rewriteSelectorList(selector)
    out += `${head}${rewritten}{`
    if (isDocumentBox(rewritten)) {
      const end = skipBlock(css, brace)
      out += `${loosenDocumentHeight(css.slice(brace + 1, end - 1))}}`
      cursor = end
      continue
    }
    cursor = brace + 1
  }
  const sized = out
    .replaceAll("100svh", "100%")
    .replaceAll("100dvh", "100%")
    .replaceAll("100vh", "100%")
  return `:host{display:block;box-sizing:border-box;width:100%;max-width:100%;min-width:0}.page{box-sizing:border-box;width:100%;max-width:100%;min-width:0;min-height:100%;container-type:inline-size}${sized}`
}

/** Width queries follow the pasted box. Preference queries stay on the viewport. */
const rewriteWidthMedia = (prelude: string): string => {
  const at = prelude.search(/@media\b/i)
  if (at === -1) return prelude
  const condition = prelude.slice(at + "@media".length)
  if (!isWidthOnlyMedia(condition)) return prelude
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

/** Comments are not selectors. A comma inside one must not split the list. */
const stripComments = (value: string): string => value.replace(/\/\*[\s\S]*?\*\//g, "")

const isDocumentBox = (selector: string): boolean =>
  stripComments(selector)
    .split(",")
    .every((part) => part.trim() === ".page")

const loosenDocumentHeight = (declarations: string): string =>
  declarations.replace(/(^|;)\s*height(\s*:\s*100%)/g, "$1min-height$2")

const rewriteSelectorList = (selector: string): string => {
  if (selector.trim() === "") return selector
  return selector
    .split(",")
    .map((part) => part.replace(/:root\b|(?<![.\w-])(?:html|body)\b/g, ".page"))
    .join(",")
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

/**
 * `@property` rules only register from a document's own stylesheets, never from a shadow tree's,
 * and Tailwind's utilities (borders, shadows, rings) read the initial values they declare. Hoist
 * them, once per distinct set, into the document that owns the shadow trees. Registering a custom
 * property changes nothing until something uses it.
 */
export function registerProperties(owner: Document, css: string): void {
  const rules = css.match(/@property\s+--[\w-]+\s*\{[^}]*\}/g)
  if (!rules?.length) return
  const text = rules.join("\n")
  const marker = "data-example-properties"
  for (const style of owner.head.querySelectorAll(`style[${marker}]`))
    if (style.textContent === text) return
  const style = owner.createElement("style")
  style.setAttribute(marker, "")
  style.textContent = text
  owner.head.append(style)
}
