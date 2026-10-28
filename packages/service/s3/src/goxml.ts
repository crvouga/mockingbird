/**
 * A request-body XML reader that fails the way Go's `encoding/xml` `Decoder.Decode` does, so
 * MinIO's error messages (`XML syntax error on line 1: unexpected EOF`, `EOF`, `expected element
 * type <A> but have <B>`) can be reproduced byte for byte. It reads only the first element (Go
 * ignores whatever follows it), skipping prolog, comments, directives and stray text before it.
 */

/** One element: names are local names (any `prefix:` dropped), text is its direct character data. */
export type GoNode = {
  name: string
  attrs: Record<string, string>
  children: GoNode[]
  text: string
}

export type GoXmlErrorKind =
  /** `*xml.SyntaxError`: malformed XML. */
  | "syntax"
  /** `io.EOF`: no element at all. */
  | "eof"
  /** `xml.UnmarshalError` and friends: well-formed but not the expected shape/type. */
  | "unmarshal"

export class GoXmlError extends Error {
  constructor(
    readonly kind: GoXmlErrorKind,
    message: string,
  ) {
    super(message)
  }
}

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", apos: "'", quot: '"' }
const NAME_START = /[A-Za-z_:\u0080-￿]/
const NAME_CHAR = /[A-Za-z0-9_:.\-\u0080-￿]/
const local = (name: string) => {
  const colon = name.indexOf(":")
  return colon > 0 && colon < name.length - 1 ? name.slice(colon + 1) : name
}

class Reader {
  pos = 0
  constructor(readonly src: string) {}
  line() {
    let line = 1
    for (let index = 0; index < this.pos && index < this.src.length; index++)
      if (this.src.charCodeAt(index) === 10) line++
    return line
  }
  syntax(message: string): never {
    throw new GoXmlError("syntax", `XML syntax error on line ${this.line()}: ${message}`)
  }
  eof() {
    return this.pos >= this.src.length
  }
  peek() {
    return this.src.charAt(this.pos)
  }
  next() {
    if (this.eof()) this.syntax("unexpected EOF")
    return this.src.charAt(this.pos++)
  }
  name(): string | undefined {
    if (this.eof()) this.syntax("unexpected EOF")
    if (!NAME_START.test(this.peek())) return undefined
    const start = this.pos
    while (!this.eof() && NAME_CHAR.test(this.peek())) this.pos++
    if (this.eof()) this.syntax("unexpected EOF")
    return this.src.slice(start, this.pos)
  }
  space() {
    while (!this.eof() && /[ \t\r\n]/.test(this.peek())) this.pos++
  }
  /** Character data up to `stop` (exclusive), entities decoded. */
  text(stop: string, quoted = false): string {
    let out = ""
    while (true) {
      if (this.eof()) this.syntax("unexpected EOF")
      const char = this.peek()
      if (char === stop) return out
      if (quoted && char === "<") this.syntax("unescaped < inside quoted string")
      if (!quoted && char === "]" && this.src.startsWith("]]>", this.pos))
        this.syntax("unescaped ]]> not in CDATA section")
      this.pos++
      if (char === "&") out += this.entity()
      else if (char === "\r") {
        out += "\n"
        if (this.peek() === "\n") this.pos++
      } else out += char
    }
  }
  entity(): string {
    const start = this.pos - 1
    if (this.peek() === "#") {
      this.pos++
      let base = 10
      if (this.peek() === "x") {
        base = 16
        this.pos++
      }
      const digits = this.pos
      while (!this.eof() && (base === 16 ? /[0-9a-fA-F]/ : /[0-9]/).test(this.peek())) this.pos++
      if (this.eof()) this.syntax("unexpected EOF")
      const value = this.src.slice(digits, this.pos)
      if (this.peek() === ";") {
        this.pos++
        const code = Number.parseInt(value, base)
        if (value && code <= 0x10ffff) return String.fromCodePoint(code)
        this.syntax(`invalid character entity ${this.src.slice(start, this.pos)}`)
      }
      this.syntax(`invalid character entity ${this.src.slice(start, this.pos)} (no semicolon)`)
    }
    const name = this.name()
    if (this.eof()) this.syntax("unexpected EOF")
    if (name !== undefined && this.peek() === ";") {
      this.pos++
      const value = ENTITIES[name]
      if (value !== undefined) return value
      this.syntax(`invalid character entity ${this.src.slice(start, this.pos)}`)
    }
    this.syntax(`invalid character entity ${this.src.slice(start, this.pos)} (no semicolon)`)
  }
  /** Skip `<?...?>`, `<!--...-->`, `<!...>`, `<![CDATA[...]]>` (returning CDATA text). */
  special(): string {
    if (this.src.startsWith("<?", this.pos)) {
      this.pos += 2
      if (this.name() === undefined) this.syntax("expected target name after <?")
      const end = this.src.indexOf("?>", this.pos)
      if (end < 0) {
        this.pos = this.src.length
        this.syntax("unexpected EOF")
      }
      this.pos = end + 2
      return ""
    }
    if (this.src.startsWith("<!--", this.pos)) {
      const end = this.src.indexOf("-->", this.pos + 4)
      if (end < 0) {
        this.pos = this.src.length
        this.syntax("unexpected EOF")
      }
      this.pos = end + 3
      return ""
    }
    if (this.src.startsWith("<![CDATA[", this.pos)) {
      const end = this.src.indexOf("]]>", this.pos + 9)
      if (end < 0) {
        this.pos = this.src.length
        this.syntax("unexpected EOF in CDATA section")
      }
      const out = this.src.slice(this.pos + 9, end)
      this.pos = end + 3
      return out
    }
    // <!DOCTYPE ...> and other directives
    this.pos += 2
    let depth = 1
    while (depth > 0) {
      const char = this.next()
      if (char === "<") depth++
      else if (char === ">") depth--
    }
    return ""
  }
  /** At `<name`: the element and everything inside it. */
  element(): GoNode {
    this.pos++
    const raw = this.name()
    if (raw === undefined) this.syntax("expected element name after <")
    const node: GoNode = { name: local(raw as string), attrs: {}, children: [], text: "" }
    while (true) {
      this.space()
      const char = this.next()
      if (char === "/") {
        if (this.next() !== ">") this.syntax("expected /> in element")
        return node
      }
      if (char === ">") break
      this.pos--
      const attr = this.name()
      if (attr === undefined) this.syntax("expected attribute name in element")
      this.space()
      if (this.next() !== "=") this.syntax("attribute name without = in element")
      this.space()
      const quote = this.next()
      if (quote !== '"' && quote !== "'")
        this.syntax("unquoted or missing attribute value in element")
      const value = this.text(quote, true)
      this.pos++
      node.attrs[attr as string] = value
    }
    while (true) {
      node.text += this.text("<")
      if (this.src.startsWith("</", this.pos)) {
        this.pos += 2
        const end = this.name()
        if (end === undefined) this.syntax("expected element name after </")
        this.space()
        if (this.next() !== ">") this.syntax(`invalid characters between </${end} and >`)
        if (local(end as string) !== node.name)
          this.syntax(`element <${node.name}> closed by </${local(end as string)}>`)
        return node
      }
      if (this.src.startsWith("<!", this.pos) || this.src.startsWith("<?", this.pos))
        node.text += this.special()
      else node.children.push(this.element())
    }
  }
}

/**
 * Decode the first element of `body`. With `root`, a differently named first element is Go's
 * `expected element type <root> but have <name>` (an unmarshal error).
 */
export const decodeGoXml = (body: string, root?: string): GoNode => {
  const reader = new Reader(body)
  while (true) {
    const next = body.indexOf("<", reader.pos)
    if (next < 0) {
      // Character data before EOF: Go reports the bare io.EOF.
      for (; reader.pos < body.length; reader.pos++)
        if (body.charAt(reader.pos) === "&") {
          reader.pos++
          reader.entity()
          reader.pos--
        }
      throw new GoXmlError("eof", "EOF")
    }
    reader.pos = next
    if (body.startsWith("</", next)) {
      reader.pos += 2
      const name = reader.name()
      if (name === undefined) reader.syntax("expected element name after </")
      reader.space()
      if (reader.next() !== ">") reader.syntax(`invalid characters between </${name} and >`)
      reader.syntax(`unexpected end element </${local(name as string)}>`)
    }
    if (body.startsWith("<!", next) || body.startsWith("<?", next)) {
      reader.special()
      continue
    }
    const node = reader.element()
    if (root && node.name !== root)
      throw new GoXmlError("unmarshal", `expected element type <${root}> but have <${node.name}>`)
    return node
  }
}

/** The last child named `name` (Go overwrites a scalar field on every occurrence). */
export const child = (node: GoNode, name: string): GoNode | undefined => {
  let found: GoNode | undefined
  for (const item of node.children) if (item.name === name) found = item
  return found
}

/** Every child named `name`. */
export const children = (node: GoNode, name: string): GoNode[] =>
  node.children.filter((item) => item.name === name)

/** Go's `strconv.ParseBool` as `encoding/xml` applies it to a trimmed element ("" is false). */
export const goBool = (node: GoNode): boolean => {
  const value = node.text.trim()
  if (value === "") return false
  if (["1", "t", "T", "TRUE", "true", "True"].includes(value)) return true
  if (["0", "f", "F", "FALSE", "false", "False"].includes(value)) return false
  throw new GoXmlError(
    "unmarshal",
    `strconv.ParseBool: parsing ${JSON.stringify(value)}: invalid syntax`,
  )
}

/** Go's `strconv.ParseUint(value, 10, 64)` on a trimmed element ("" is 0). */
export const goUint = (node: GoNode): number => {
  const value = node.text.trim()
  if (value === "") return 0
  if (!/^[0-9]+$/.test(value))
    throw new GoXmlError(
      "unmarshal",
      `strconv.ParseUint: parsing ${JSON.stringify(value)}: invalid syntax`,
    )
  const parsed = BigInt(value)
  if (parsed > 18446744073709551615n)
    throw new GoXmlError(
      "unmarshal",
      `strconv.ParseUint: parsing ${JSON.stringify(value)}: value out of range`,
    )
  return Number(parsed)
}
