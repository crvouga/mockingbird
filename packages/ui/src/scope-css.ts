/**
 * Scope a stylesheet to one subtree: every style rule's selectors are prefixed with
 * `:where(<scope>)`, so they match only inside an element matching `scope`, with their
 * specificity unchanged (the cascade inside the subtree is exactly the original's). `:root`,
 * `:host`, `html` and `body` become the scope itself. Rules nested in another style rule keep
 * their selectors (`&…` already is relative); `@keyframes`, `@property`, `@font-face` and other
 * non-conditional at-rules pass through, as do comments.
 *
 * The System harness injects Mockingbird's stylesheet this way, so mounting it in any page
 * restyles nothing outside it: Tailwind's Preflight and HeroUI's component classes (`.button`,
 * `.card`, …) reach only the harness's own UI.
 */

/** At-rules whose block holds style rules that apply under a condition (or in a layer). */
const CONDITIONAL = new Set([
  "media",
  "supports",
  "layer",
  "container",
  "scope",
  "starting-style",
  "document",
])
const ROOT = /^(?::root|:host|html|body)(?![\w-])/

type Context = "top" | "style"

export function scopeCss(css: string, scope: string): string {
  const root = `:where(${scope})`
  let i = 0
  const n = css.length

  /** Index of the end of the string starting at `at` (the quote), past its closing quote. */
  const skipString = (at: number) => {
    const quote = css[at]
    let j = at + 1
    while (j < n && css[j] !== quote) j += css[j] === "\\" ? 2 : 1
    return j + 1
  }
  /** Text up to (not including) the first `stop` char at depth 0, skipping strings, escapes and comments. */
  const readUntil = (stops: string): string => {
    const start = i
    let depth = 0
    while (i < n) {
      const c = css[i] as string
      if (c === "\\") i += 2
      else if (c === '"' || c === "'") i = skipString(i)
      else if (c === "/" && css[i + 1] === "*") {
        const end = css.indexOf("*/", i + 2)
        i = end < 0 ? n : end + 2
      } else if (c === "(" || c === "[") {
        depth++
        i++
      } else if (c === ")" || c === "]") {
        depth--
        i++
      } else if (depth === 0 && stops.includes(c)) break
      else i++
    }
    return css.slice(start, i)
  }
  const prefix = (selectors: string) =>
    splitTopLevel(selectors)
      .map((raw) => {
        const selector = raw.trim()
        if (!selector) return selector
        if (ROOT.test(selector)) return selector.replace(ROOT, root)
        return `${root} ${selector}`
      })
      .join(",")

  /** Parses statements until a closing brace (consumed) or the end; returns them rewritten. */
  const block = (context: Context): string => {
    let out = ""
    while (i < n) {
      const c = css[i] as string
      if (/\s/.test(c)) {
        out += c
        i++
        continue
      }
      if (c === "}") {
        i++
        return out
      }
      if (c === "/" && css[i + 1] === "*") {
        const end = css.indexOf("*/", i + 2)
        const stop = end < 0 ? n : end + 2
        out += css.slice(i, stop)
        i = stop
        continue
      }
      const prelude = readUntil(context === "style" ? "{;}" : "{;")
      const next = css[i]
      if (next !== "{") {
        // A declaration, or a statement at-rule (`@layer a, b;`, `@import …;`).
        out += prelude
        if (next === ";") {
          out += ";"
          i++
        }
        continue
      }
      i++ // past "{"
      const head = prelude.trim()
      if (head.startsWith("@")) {
        const name = /^@(-[a-z]+-)?([\w-]+)/i.exec(head)?.[2]?.toLowerCase() ?? ""
        if (CONDITIONAL.has(name)) out += `${prelude}{${block(context)}}`
        else out += `${prelude}{${raw()}}`
      } else if (context === "style") out += `${prelude}{${block("style")}}`
      else out += `${prefix(prelude)}{${block("style")}}`
    }
    return out
  }
  /** A block copied as it is (keyframes, @property, @font-face), through its closing brace. */
  const raw = (): string => {
    const start = i
    let depth = 1
    while (i < n) {
      const c = css[i] as string
      if (c === "\\") i += 2
      else if (c === '"' || c === "'") i = skipString(i)
      else if (c === "/" && css[i + 1] === "*") {
        const end = css.indexOf("*/", i + 2)
        i = end < 0 ? n : end + 2
      } else {
        if (c === "{") depth++
        else if (c === "}" && --depth === 0) {
          i++
          return css.slice(start, i - 1)
        }
        i++
      }
    }
    return css.slice(start)
  }
  return block("top")
}

/** `a, b:is(c, d), e` → ["a", " b:is(c, d)", " e"]: commas outside parentheses, brackets and strings. */
function splitTopLevel(list: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < list.length; i++) {
    const c = list[i]
    if (c === "\\") i++
    else if (c === '"' || c === "'") {
      const quote = c
      i++
      while (i < list.length && list[i] !== quote) i += list[i] === "\\" ? 2 : 1
    } else if (c === "(" || c === "[") depth++
    else if (c === ")" || c === "]") depth--
    else if (c === "," && depth === 0) {
      parts.push(list.slice(start, i))
      start = i + 1
    }
  }
  parts.push(list.slice(start))
  return parts
}
