/**
 * Prefix every selector in a stylesheet with `scope`, so the harness UI can sit inside another
 * application without its rules leaking out. `:root`, `html` and `body` become the scope element
 * itself; `@media`, `@container` and `@supports` blocks are scoped recursively; `@keyframes` and
 * other at-rules are left alone.
 */
export const scopeCss = (css: string, scope: string): string => {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "")
  let out = ""
  let i = 0
  while (i < source.length) {
    const open = source.indexOf("{", i)
    if (open < 0) break
    const head = source.slice(i, open).trim()
    let depth = 1
    let j = open + 1
    while (j < source.length && depth > 0) {
      if (source[j] === "{") depth++
      else if (source[j] === "}") depth--
      j++
    }
    const body = source.slice(open + 1, j - 1)
    if (/^@(media|container|supports|layer)\b/.test(head))
      out += `${head} {\n${scopeCss(body, scope)}}\n`
    else if (head.startsWith("@")) out += `${head} {${body}}\n`
    else out += `${scopeSelectors(head, scope)} {${body}}\n`
    i = j
  }
  return out
}

const scopeSelectors = (selectors: string, scope: string): string =>
  splitTopLevel(selectors)
    .map((raw) => {
      const sel = raw.trim()
      if (sel === ":root" || sel === "html" || sel === "body") return scope
      if (sel.startsWith(":root")) return `${scope}${sel.slice(5)}`
      // `&` addresses the scope element itself: `&[data-motion="reduce"] .x`.
      if (sel.startsWith("&")) return `${scope}${sel.slice(1)}`
      return `${scope} ${sel}`
    })
    .join(", ")

/** Split on commas outside parentheses (`:is(a, b)` stays whole). */
const splitTopLevel = (value: string): string[] => {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let k = 0; k < value.length; k++) {
    const c = value[k]
    if (c === "(") depth++
    else if (c === ")") depth--
    else if (c === "," && depth === 0) {
      parts.push(value.slice(start, k))
      start = k + 1
    }
  }
  parts.push(value.slice(start))
  return parts
}
