/**
 * Just enough of Go's `encoding/xml` decoder to reproduce what MinIO answers for a configuration
 * document: an ordered element tree (local names, direct character data), the `SyntaxError`
 * messages Go reports, and Go's scalar conversions (`strconv.ParseInt` / `ParseBool`).
 */

export type XNode = {
  /** Local name (any `prefix:` dropped, as Go's `Name.Local`). */
  name: string
  /** Child elements, in document order. */
  children: XNode[]
  /** The element's own character data, concatenated (what Go decodes into a string). */
  text: string
}

/** A Go error as MinIO would see it, tagged by the type `toAPIError` switches on. */
export class GoError extends Error {
  constructor(
    readonly kind:
      | "syntax"
      | "eof"
      | "unmarshal"
      | "strconv-syntax"
      | "strconv-range"
      | "lifecycle"
      | "plain",
    message: string,
  ) {
    super(message)
  }
}

const NAME_START = /[A-Za-z_:À-￿]/
const NAME_CHAR = /[A-Za-z0-9_:.\-·À-￿]/

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", apos: "'", quot: '"' }

/** Parse a whole document; throws `GoError` ("EOF" when there is no root element). */
export const parseGoXml = (input: string): XNode => {
  let pos = 0
  const line = () => {
    let count = 1
    for (let index = 0; index < Math.min(pos, input.length); index++)
      if (input.charCodeAt(index) === 10) count++
    return count
  }
  const syntax = (message: string): never => {
    throw new GoError("syntax", `XML syntax error on line ${line()}: ${message}`)
  }
  const eof = (): never => syntax("unexpected EOF")

  const readName = () => {
    const start = pos
    if (pos >= input.length) eof()
    if (!NAME_START.test(input[pos] as string)) return ""
    while (pos < input.length && NAME_CHAR.test(input[pos] as string)) pos++
    return input.slice(start, pos)
  }
  const local = (name: string) => {
    const colon = name.indexOf(":")
    return colon < 0 ? name : name.slice(colon + 1)
  }
  const skipSpace = () => {
    while (pos < input.length && /\s/.test(input[pos] as string)) pos++
  }
  /** Character data up to the next `<`, entities decoded. */
  const readText = () => {
    let out = ""
    while (pos < input.length && input[pos] !== "<") {
      const char = input[pos] as string
      if (char !== "&") {
        out += char
        pos++
        continue
      }
      pos++
      let name = ""
      if (input[pos] === "#") {
        pos++
        let digits = ""
        const hex = input[pos] === "x"
        if (hex) pos++
        while (pos < input.length && (hex ? /[0-9a-fA-F]/ : /[0-9]/).test(input[pos] as string))
          digits += input[pos++]
        name = `#${hex ? "x" : ""}${digits}`
        if (input[pos] !== ";") syntax(`invalid character entity &${name} (no semicolon)`)
        pos++
        const code = Number.parseInt(digits, hex ? 16 : 10)
        if (!digits || Number.isNaN(code) || code > 0x10ffff)
          syntax(`invalid character entity &${name};`)
        out += String.fromCodePoint(code)
        continue
      }
      while (pos < input.length && NAME_CHAR.test(input[pos] as string)) name += input[pos++]
      if (input[pos] !== ";") syntax(`invalid character entity &${name} (no semicolon)`)
      pos++
      const value = ENTITIES[name]
      if (value === undefined) syntax(`invalid character entity &${name};`)
      out += value
    }
    return out.replace(/\r\n?/g, "\n")
  }
  /** Skip `<?...?>`, `<!--...-->`, `<!DOCTYPE ...>`; returns CDATA text when it was one. */
  const skipSpecial = (): string | undefined => {
    if (input.startsWith("<?", pos)) {
      const end = input.indexOf("?>", pos + 2)
      if (end < 0) {
        pos = input.length
        eof()
      }
      pos = end + 2
      return undefined
    }
    if (input.startsWith("<!--", pos)) {
      const end = input.indexOf("-->", pos + 4)
      if (end < 0) {
        pos = input.length
        eof()
      }
      pos = end + 3
      return undefined
    }
    if (input.startsWith("<![CDATA[", pos)) {
      const end = input.indexOf("]]>", pos + 9)
      if (end < 0) {
        pos = input.length
        eof()
      }
      const data = input.slice(pos + 9, end)
      pos = end + 3
      return data
    }
    const end = input.indexOf(">", pos)
    if (end < 0) {
      pos = input.length
      eof()
    }
    pos = end + 1
    return undefined
  }
  const readAttributes = () => {
    for (;;) {
      skipSpace()
      if (pos >= input.length) eof()
      const char = input[pos]
      if (char === ">" || char === "/") return
      const name = readName()
      if (!name) syntax("expected attribute name in element")
      skipSpace()
      if (input[pos] !== "=") syntax("attribute name without = in element")
      pos++
      skipSpace()
      const quote = input[pos]
      if (quote !== '"' && quote !== "'") syntax("unquoted or missing attribute value in element")
      const end = input.indexOf(quote as string, pos + 1)
      if (end < 0) {
        pos = input.length
        eof()
      }
      pos = end + 1
    }
  }
  const readElement = (): XNode => {
    pos++ // <
    const raw = readName()
    if (!raw) syntax(`expected element name after <`)
    const node: XNode = { name: local(raw), children: [], text: "" }
    readAttributes()
    if (input[pos] === "/") {
      pos++
      if (input[pos] !== ">") syntax(`expected /> in element`)
      pos++
      return node
    }
    pos++ // >
    for (;;) {
      if (pos >= input.length) eof()
      if (input[pos] !== "<") {
        node.text += readText()
        continue
      }
      if (input[pos + 1] === "/") {
        pos += 2
        const closing = readName()
        skipSpace()
        if (pos >= input.length) eof()
        if (input[pos] !== ">") syntax(`invalid characters between </${closing} and >`)
        pos++
        if (closing !== raw) syntax(`element <${raw}> closed by </${closing}>`)
        return node
      }
      if (input[pos + 1] === "?" || input[pos + 1] === "!") {
        const data = skipSpecial()
        if (data !== undefined) node.text += data
        continue
      }
      node.children.push(readElement())
    }
  }

  for (;;) {
    while (pos < input.length && input[pos] !== "<") {
      readText()
    }
    if (pos >= input.length) throw new GoError("eof", "EOF")
    if (input[pos + 1] === "?" || input[pos + 1] === "!") {
      skipSpecial()
      continue
    }
    if (input[pos + 1] === "/") {
      pos += 2
      syntax(`unexpected end element </${readName()}>`)
    }
    return readElement()
  }
}

/** Go's `%q` for the ASCII strings these messages quote. */
export const goQuote = (value: string) =>
  `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t")}"`

const MAX_INT64 = 9223372036854775807n
const MIN_INT64 = -9223372036854775808n

/** `encoding/xml` into an `int`/`int64`: trimmed `strconv.ParseInt(s, 10, 64)`, "" is 0. */
export const goInt = (text: string): number => {
  if (text.length === 0) return 0
  const value = text.trim()
  if (!/^[+-]?[0-9]+$/.test(value))
    throw new GoError(
      "strconv-syntax",
      `strconv.ParseInt: parsing ${goQuote(value)}: invalid syntax`,
    )
  const big = BigInt(value)
  if (big > MAX_INT64 || big < MIN_INT64)
    throw new GoError(
      "strconv-range",
      `strconv.ParseInt: parsing ${goQuote(value)}: value out of range`,
    )
  return Number(big)
}

/** `encoding/xml` into a `bool`: trimmed `strconv.ParseBool`, "" is false. */
export const goBool = (text: string): boolean => {
  if (text.length === 0) return false
  const value = text.trim()
  if (["1", "t", "T", "TRUE", "true", "True"].includes(value)) return true
  if (["0", "f", "F", "FALSE", "false", "False"].includes(value)) return false
  throw new GoError(
    "strconv-syntax",
    `strconv.ParseBool: parsing ${goQuote(value)}: invalid syntax`,
  )
}

/** Go's `xml.EscapeText` (what `xml.Marshal` writes for character data). */
export const goEscape = (value: string): string =>
  value.replace(/[&<>"'\t\n\r]/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;"
      case "<":
        return "&lt;"
      case ">":
        return "&gt;"
      case '"':
        return "&#34;"
      case "'":
        return "&#39;"
      case "\t":
        return "&#x9;"
      case "\n":
        return "&#xA;"
      default:
        return "&#xD;"
    }
  })

/** `<name>escaped</name>`. */
export const goEl = (name: string, value: string | number | boolean) =>
  `<${name}>${goEscape(String(value))}</${name}>`
