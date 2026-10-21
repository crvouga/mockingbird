/** Lua 5.1 lexer and parser. Names are resolved to local slots, upvalues or globals while parsing. */

export interface VarInfo {
  name: string
  slot: number
  /** Referenced by an inner function, so its value lives in a shared box. */
  captured: boolean
}

export interface UpDesc {
  /** True when the enclosing function holds the variable in a local slot. */
  fromLocal: boolean
  index: number
  name: string
}

export interface Proto {
  params: VarInfo[]
  vararg: boolean
  nslots: number
  ups: UpDesc[]
  body: Stmt[]
  line: number
}

export type Expr =
  | { k: "nil" }
  | { k: "bool"; v: boolean }
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "dots" }
  | { k: "local"; v: VarInfo }
  | { k: "up"; index: number; name: string }
  | { k: "global"; name: string; line: number }
  | { k: "index"; obj: Expr; key: Expr; line: number }
  | { k: "call"; fn: Expr; args: Expr[]; line: number }
  | { k: "method"; obj: Expr; name: string; args: Expr[]; line: number }
  | { k: "fn"; proto: Proto }
  | { k: "bin"; op: string; a: Expr; b: Expr; line: number }
  | { k: "un"; op: string; a: Expr; line: number }
  | { k: "and"; a: Expr; b: Expr }
  | { k: "or"; a: Expr; b: Expr }
  | { k: "table"; fields: TableField[]; line: number }
  | { k: "paren"; e: Expr }

export type TableField = { kind: "pos"; value: Expr } | { kind: "keyed"; key: Expr; value: Expr }

export type Stmt =
  | { k: "local"; vars: VarInfo[]; values: Expr[]; line: number }
  | { k: "localfn"; v: VarInfo; proto: Proto }
  | { k: "assign"; targets: Expr[]; values: Expr[]; line: number }
  | { k: "call"; e: Expr }
  | { k: "do"; body: Stmt[] }
  | { k: "while"; cond: Expr; body: Stmt[] }
  | { k: "repeat"; body: Stmt[]; cond: Expr }
  | { k: "if"; arms: Array<{ cond: Expr; body: Stmt[] }>; otherwise: Stmt[] | null }
  | {
      k: "fornum"
      v: VarInfo
      start: Expr
      stop: Expr
      step: Expr | null
      body: Stmt[]
      line: number
    }
  | { k: "forin"; vars: VarInfo[]; iter: Expr[]; body: Stmt[]; line: number; hidden: VarInfo[] }
  | { k: "return"; values: Expr[] }
  | { k: "break" }

type Token =
  | { t: "num"; v: number; line: number; text: string }
  | { t: "str"; v: string; line: number; text: string }
  | { t: "name"; v: string; line: number; text: string }
  | { t: "kw"; v: string; line: number; text: string }
  | { t: "sym"; v: string; line: number; text: string }
  | { t: "eof"; v: string; line: number; text: string }

const KEYWORDS = new Set([
  "and",
  "break",
  "do",
  "else",
  "elseif",
  "end",
  "false",
  "for",
  "function",
  "if",
  "in",
  "local",
  "nil",
  "not",
  "or",
  "repeat",
  "return",
  "then",
  "true",
  "until",
  "while",
])

/** The chunk name in syntax errors; `parseChunk` sets it for the duration of one parse. */
let chunkName = "user_script"

export class LuaSyntaxError extends Error {}

function fail(line: number, message: string, near?: string): never {
  throw new LuaSyntaxError(
    `${chunkName}:${line}: ${message}${near === undefined ? "" : ` near '${near}'`}`,
  )
}

const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9"
const isAlpha = (c: string | undefined) =>
  c !== undefined && ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_")

const ESCAPES: Record<string, string> = {
  n: "\n",
  r: "\r",
  t: "\t",
  a: "\u0007",
  b: "\b",
  f: "\f",
  v: "\v",
  "\\": "\\",
  '"': '"',
  "'": "'",
  "\n": "\n",
}

function longBracket(src: string, at: number): { level: number; start: number } | null {
  let i = at + 1
  let level = 0
  while (src[i] === "=") {
    level++
    i++
  }
  return src[i] === "[" ? { level, start: i + 1 } : null
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  let line = 1
  const readLong = (level: number, start: number, what: string): string => {
    const close = `]${"=".repeat(level)}]`
    const end = src.indexOf(close, start)
    if (end < 0) fail(line, `unfinished long ${what}`, "<eof>")
    let text = src.slice(start, end)
    line += text.split("\n").length - 1
    i = end + close.length
    if (text.startsWith("\r\n")) text = text.slice(2)
    else if (text.startsWith("\n")) text = text.slice(1)
    return text
  }
  if (src.startsWith("#")) {
    while (i < src.length && src[i] !== "\n") i++
  }
  while (i < src.length) {
    const c = src[i] as string
    if (c === "\n") {
      line++
      i++
      continue
    }
    if (c === " " || c === "\t" || c === "\r" || c === "\v" || c === "\f") {
      i++
      continue
    }
    if (c === "-" && src[i + 1] === "-") {
      i += 2
      if (src[i] === "[") {
        const bracket = longBracket(src, i)
        if (bracket) {
          readLong(bracket.level, bracket.start, "comment")
          continue
        }
      }
      while (i < src.length && src[i] !== "\n") i++
      continue
    }
    if (c === '"' || c === "'") {
      const startLine = line
      let value = ""
      i++
      for (;;) {
        const ch = src[i]
        if (ch === undefined) fail(line, "unfinished string", "<eof>")
        if (ch === c) break
        if (ch === "\n") fail(line, "unfinished string", src.slice(i - value.length - 1, i))
        if (ch === "\\") {
          i++
          const esc = src[i]
          if (esc === undefined) fail(line, "unfinished string", "<eof>")
          if (isDigit(esc)) {
            let digits = esc
            for (let n = 0; n < 2 && isDigit(src[i + 1]); n++) digits += src[++i]
            const code = Number(digits)
            if (code > 255) fail(line, "escape sequence too large", `\\${digits}`)
            value += String.fromCharCode(code)
          } else {
            if (esc === "\n") line++
            value += ESCAPES[esc] ?? esc
          }
          i++
          continue
        }
        value += ch
        i++
      }
      i++
      tokens.push({ t: "str", v: value, line: startLine, text: value })
      continue
    }
    if (c === "[") {
      const bracket = longBracket(src, i)
      if (bracket) {
        const startLine = line
        const value = readLong(bracket.level, bracket.start, "string")
        tokens.push({ t: "str", v: value, line: startLine, text: value })
        continue
      }
      if (src[i + 1] === "=") fail(line, "invalid long string delimiter", "[=")
    }
    if (isDigit(c) || (c === "." && isDigit(src[i + 1]))) {
      // Lua reads digits and dots greedily, an optional exponent sign, then any word characters.
      const start = i
      do {
        i++
      } while (isDigit(src[i]) || src[i] === ".")
      if (src[i] === "e" || src[i] === "E") {
        i++
        if (src[i] === "+" || src[i] === "-") i++
      }
      while (isAlpha(src[i]) || isDigit(src[i])) i++
      const text = src.slice(start, i)
      if (!/^(0[xX][0-9a-fA-F]+|(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?)$/.test(text)) {
        fail(line, "malformed number", text)
      }
      tokens.push({ t: "num", v: Number(text), line, text })
      continue
    }
    if (isAlpha(c)) {
      const start = i
      while (isAlpha(src[i]) || isDigit(src[i])) i++
      const word = src.slice(start, i)
      tokens.push({ t: KEYWORDS.has(word) ? "kw" : "name", v: word, line, text: word })
      continue
    }
    const three = src.slice(i, i + 3)
    if (three === "...") {
      tokens.push({ t: "sym", v: three, line, text: three })
      i += 3
      continue
    }
    const two = src.slice(i, i + 2)
    if (two === "==" || two === "~=" || two === "<=" || two === ">=" || two === "..") {
      tokens.push({ t: "sym", v: two, line, text: two })
      i += 2
      continue
    }
    if ("+-*/%^#<>=(){}[];:,.".includes(c)) {
      tokens.push({ t: "sym", v: c, line, text: c })
      i++
      continue
    }
    // Any other character is a one-character token the parser will reject where it matters.
    tokens.push({ t: "sym", v: c, line, text: c })
    i++
  }
  tokens.push({ t: "eof", v: "<eof>", line, text: "<eof>" })
  return tokens
}

class FuncState {
  readonly actives: VarInfo[] = []
  readonly ups: UpDesc[] = []
  readonly upIndex = new Map<VarInfo, number>()
  nslots = 0
  vararg = false
  loopDepth = 0
  constructor(readonly parent: FuncState | null) {}

  declare(name: string): VarInfo {
    return { name, slot: this.nslots++, captured: false }
  }

  find(name: string): VarInfo | null {
    for (let i = this.actives.length - 1; i >= 0; i--) {
      const v = this.actives[i] as VarInfo
      if (v.name === name) return v
    }
    return null
  }
}

function lookupUp(fs: FuncState, name: string): { v: VarInfo; index: number } | null {
  const parent = fs.parent
  if (parent === null) return null
  let v = parent.find(name)
  let fromLocal = true
  let index = 0
  if (v) {
    v.captured = true
    index = v.slot
  } else {
    const outer = lookupUp(parent, name)
    if (outer === null) return null
    v = outer.v
    fromLocal = false
    index = outer.index
  }
  const existing = fs.upIndex.get(v)
  if (existing !== undefined) return { v, index: existing }
  fs.ups.push({ fromLocal, index, name })
  fs.upIndex.set(v, fs.ups.length - 1)
  return { v, index: fs.ups.length - 1 }
}

const BINARY: Record<string, [number, number]> = {
  or: [1, 1],
  and: [2, 2],
  "<": [3, 3],
  ">": [3, 3],
  "<=": [3, 3],
  ">=": [3, 3],
  "~=": [3, 3],
  "==": [3, 3],
  "..": [5, 4],
  "+": [6, 6],
  "-": [6, 6],
  "*": [7, 7],
  "/": [7, 7],
  "%": [7, 7],
  "^": [10, 9],
}
const UNARY_PRIORITY = 8

class Parser {
  private i = 0
  private fs: FuncState
  constructor(
    private readonly toks: Token[],
    fs: FuncState,
  ) {
    this.fs = fs
  }

  private get tok(): Token {
    return this.toks[this.i] as Token
  }

  private next(): Token {
    const tok = this.tok
    if (tok.t !== "eof") this.i++
    return tok
  }

  private near(): string {
    return this.tok.text
  }

  private check(value: string): boolean {
    const tok = this.tok
    return (tok.t === "sym" || tok.t === "kw") && tok.v === value
  }

  private accept(value: string): boolean {
    if (!this.check(value)) return false
    this.i++
    return true
  }

  private expect(value: string): void {
    if (!this.accept(value)) fail(this.tok.line, `'${value}' expected`, this.near())
  }

  private expectMatch(what: string, who: string, line: number): void {
    if (this.accept(what)) return
    if (line === this.tok.line) fail(this.tok.line, `'${what}' expected`, this.near())
    fail(this.tok.line, `'${what}' expected (to close '${who}' at line ${line})`, this.near())
  }

  private name(): string {
    const tok = this.tok
    if (tok.t !== "name") fail(tok.line, "'<name>' expected", this.near())
    this.i++
    return tok.v
  }

  chunk(): Proto {
    this.fs.vararg = true
    const body = this.block()
    if (this.tok.t !== "eof") fail(this.tok.line, "'<eof>' expected", this.near())
    return this.proto(this.fs, [], body, 0)
  }

  private proto(fs: FuncState, params: VarInfo[], body: Stmt[], line: number): Proto {
    return { params, vararg: fs.vararg, nslots: fs.nslots, ups: fs.ups, body, line }
  }

  private blockEnd(): boolean {
    const tok = this.tok
    if (tok.t === "eof") return true
    return (
      tok.t === "kw" &&
      (tok.v === "end" || tok.v === "else" || tok.v === "elseif" || tok.v === "until")
    )
  }

  /** The body of a loop: a block in which `break` is allowed. */
  private loopBlock(): Stmt[] {
    this.fs.loopDepth++
    const body = this.block()
    this.fs.loopDepth--
    return body
  }

  /** A block in its own scope. */
  private block(): Stmt[] {
    const mark = this.fs.actives.length
    const body = this.statements()
    this.fs.actives.length = mark
    return body
  }

  private statements(): Stmt[] {
    const body: Stmt[] = []
    while (!this.blockEnd()) {
      if (this.check("return")) {
        this.next()
        const values: Expr[] = []
        if (!this.blockEnd() && !this.check(";")) values.push(...this.exprList())
        this.accept(";")
        body.push({ k: "return", values })
        break
      }
      if (this.check("break")) {
        this.next()
        if (this.fs.loopDepth === 0) fail(this.tok.line, "no loop to break", this.near())
        this.accept(";")
        body.push({ k: "break" })
        break
      }
      body.push(this.statement())
      this.accept(";")
    }
    return body
  }

  private statement(): Stmt {
    const tok = this.tok
    const line = tok.line
    if (tok.t === "kw") {
      switch (tok.v) {
        case "if":
          return this.ifStatement(line)
        case "while": {
          this.next()
          const cond = this.expr()
          this.expect("do")
          const body = this.loopBlock()
          this.expectMatch("end", "while", line)
          return { k: "while", cond, body }
        }
        case "do": {
          this.next()
          const body = this.block()
          this.expectMatch("end", "do", line)
          return { k: "do", body }
        }
        case "for":
          return this.forStatement(line)
        case "repeat": {
          this.next()
          const mark = this.fs.actives.length
          this.fs.loopDepth++
          const body = this.statements()
          this.fs.loopDepth--
          this.expectMatch("until", "repeat", line)
          const cond = this.expr()
          this.fs.actives.length = mark
          return { k: "repeat", body, cond }
        }
        case "function":
          return this.functionStatement(line)
        case "local":
          this.next()
          if (this.accept("function")) {
            const v = this.fs.declare(this.name())
            this.fs.actives.push(v)
            const proto = this.functionBody(false, line)
            return { k: "localfn", v, proto }
          }
          return this.localStatement(line)
        default:
          break
      }
    }
    const target = this.suffixedExpr()
    if (this.check("=") || this.check(",")) {
      const targets = [target]
      while (this.accept(",")) targets.push(this.suffixedExpr())
      for (const t of targets) {
        if (t.k !== "local" && t.k !== "up" && t.k !== "global" && t.k !== "index") {
          fail(this.tok.line, "syntax error", this.near())
        }
      }
      this.expect("=")
      return { k: "assign", targets, values: this.exprList(), line }
    }
    if (target.k === "call" || target.k === "method") return { k: "call", e: target }
    if (
      target.k === "local" ||
      target.k === "up" ||
      target.k === "global" ||
      target.k === "index"
    ) {
      fail(this.tok.line, "'=' expected", this.near())
    }
    return fail(this.tok.line, "syntax error", this.near())
  }

  private ifStatement(line: number): Stmt {
    const arms: Array<{ cond: Expr; body: Stmt[] }> = []
    let otherwise: Stmt[] | null = null
    this.next()
    for (;;) {
      const cond = this.expr()
      this.expect("then")
      arms.push({ cond, body: this.block() })
      if (this.accept("elseif")) continue
      if (this.accept("else")) otherwise = this.block()
      break
    }
    this.expectMatch("end", "if", line)
    return { k: "if", arms, otherwise }
  }

  private forStatement(line: number): Stmt {
    this.next()
    const first = this.name()
    const mark = this.fs.actives.length
    if (this.check("=")) {
      this.next()
      const start = this.expr()
      this.expect(",")
      const stop = this.expr()
      const step = this.accept(",") ? this.expr() : null
      this.expect("do")
      const v = this.fs.declare(first)
      this.fs.actives.push(v)
      const body = this.loopBlock()
      this.fs.actives.length = mark
      this.expectMatch("end", "for", line)
      return { k: "fornum", v, start, stop, step, body, line }
    }
    if (!this.check(",") && !this.check("in"))
      fail(this.tok.line, "'=' or 'in' expected", this.near())
    const names = [first]
    while (this.accept(",")) names.push(this.name())
    this.expect("in")
    const iter = this.exprList()
    this.expect("do")
    const hidden = [
      this.fs.declare("(for generator)"),
      this.fs.declare("(for state)"),
      this.fs.declare("(for control)"),
    ]
    const vars = names.map((n) => this.fs.declare(n))
    this.fs.actives.push(...hidden, ...vars)
    const body = this.loopBlock()
    this.fs.actives.length = mark
    this.expectMatch("end", "for", line)
    return { k: "forin", vars, iter, body, line, hidden }
  }

  private functionStatement(line: number): Stmt {
    this.next()
    let target = this.resolve(this.name(), line)
    let method = false
    while (this.check(".") || this.check(":")) {
      const colon = this.next().v === ":"
      const key: Expr = { k: "str", v: this.name() }
      target = { k: "index", obj: target, key, line }
      if (colon) {
        method = true
        break
      }
    }
    const proto = this.functionBody(method, line)
    return { k: "assign", targets: [target], values: [{ k: "fn", proto }], line }
  }

  private localStatement(line: number): Stmt {
    const names = [this.name()]
    while (this.accept(",")) names.push(this.name())
    const values = this.accept("=") ? this.exprList() : []
    const vars = names.map((n) => this.fs.declare(n))
    this.fs.actives.push(...vars)
    return { k: "local", vars, values, line }
  }

  private functionBody(method: boolean, line: number): Proto {
    const fs = new FuncState(this.fs)
    const outer = this.fs
    this.fs = fs
    const params: VarInfo[] = []
    if (method) params.push(fs.declare("self"))
    this.expect("(")
    if (!this.check(")")) {
      do {
        if (this.accept("...")) {
          fs.vararg = true
          break
        }
        params.push(fs.declare(this.name()))
      } while (this.accept(","))
    }
    this.expect(")")
    fs.actives.push(...params)
    const body = this.statements()
    this.expectMatch("end", "function", line)
    this.fs = outer
    return this.proto(fs, params, body, line)
  }

  private exprList(): Expr[] {
    const list = [this.expr()]
    while (this.accept(",")) list.push(this.expr())
    return list
  }

  private resolve(name: string, line: number): Expr {
    const v = this.fs.find(name)
    if (v) return { k: "local", v }
    const up = lookupUp(this.fs, name)
    if (up) return { k: "up", index: up.index, name }
    return { k: "global", name, line }
  }

  private primaryExpr(): Expr {
    const tok = this.tok
    if (tok.t === "name") {
      this.next()
      return this.resolve(tok.v, tok.line)
    }
    if (this.accept("(")) {
      const e = this.expr()
      this.expectMatch(")", "(", tok.line)
      return e.k === "call" || e.k === "method" || e.k === "dots" ? { k: "paren", e } : e
    }
    return fail(tok.line, "unexpected symbol", this.near())
  }

  private suffixedExpr(): Expr {
    let e = this.primaryExpr()
    for (;;) {
      const tok = this.tok
      if (tok.t === "sym") {
        if (tok.v === ".") {
          this.next()
          e = { k: "index", obj: e, key: { k: "str", v: this.name() }, line: tok.line }
          continue
        }
        if (tok.v === "[") {
          this.next()
          const key = this.expr()
          this.expect("]")
          e = { k: "index", obj: e, key, line: tok.line }
          continue
        }
        if (tok.v === ":") {
          this.next()
          const name = this.name()
          e = { k: "method", obj: e, name, args: this.callArgs(), line: tok.line }
          continue
        }
        if (tok.v === "(" || tok.v === "{") {
          e = { k: "call", fn: e, args: this.callArgs(), line: tok.line }
          continue
        }
      } else if (tok.t === "str") {
        e = { k: "call", fn: e, args: this.callArgs(), line: tok.line }
        continue
      }
      return e
    }
  }

  private callArgs(): Expr[] {
    const tok = this.tok
    if (tok.t === "str") {
      this.next()
      return [{ k: "str", v: tok.v }]
    }
    if (this.check("{")) return [this.tableConstructor()]
    if (this.accept("(")) {
      if (this.accept(")")) return []
      const args = this.exprList()
      this.expectMatch(")", "(", tok.line)
      return args
    }
    return fail(tok.line, "function arguments expected", this.near())
  }

  private tableConstructor(): Expr {
    const line = this.tok.line
    this.expect("{")
    const fields: TableField[] = []
    while (!this.check("}")) {
      if (this.check("[")) {
        this.next()
        const key = this.expr()
        this.expect("]")
        this.expect("=")
        fields.push({ kind: "keyed", key, value: this.expr() })
      } else if (
        this.tok.t === "name" &&
        this.toks[this.i + 1]?.v === "=" &&
        this.toks[this.i + 1]?.t === "sym"
      ) {
        const key: Expr = { k: "str", v: this.name() }
        this.next()
        fields.push({ kind: "keyed", key, value: this.expr() })
      } else fields.push({ kind: "pos", value: this.expr() })
      if (!this.accept(",") && !this.accept(";")) break
    }
    this.expectMatch("}", "{", line)
    return { k: "table", fields, line }
  }

  private simpleExpr(): Expr {
    const tok = this.tok
    switch (tok.t) {
      case "num":
        this.next()
        return { k: "num", v: tok.v }
      case "str":
        this.next()
        return { k: "str", v: tok.v }
      case "kw":
        switch (tok.v) {
          case "nil":
            this.next()
            return { k: "nil" }
          case "true":
            this.next()
            return { k: "bool", v: true }
          case "false":
            this.next()
            return { k: "bool", v: false }
          case "function": {
            this.next()
            return { k: "fn", proto: this.functionBody(false, tok.line) }
          }
          default:
            break
        }
        break
      case "sym":
        if (tok.v === "...") {
          if (!this.fs.vararg) fail(tok.line, "cannot use '...' outside a vararg function", "...")
          this.next()
          return { k: "dots" }
        }
        if (tok.v === "{") return this.tableConstructor()
        break
      default:
        break
    }
    return this.suffixedExpr()
  }

  expr(limit = 0): Expr {
    let left: Expr
    const tok = this.tok
    if (
      (tok.t === "kw" && tok.v === "not") ||
      (tok.t === "sym" && (tok.v === "-" || tok.v === "#"))
    ) {
      this.next()
      const operand = this.expr(UNARY_PRIORITY)
      left =
        tok.v === "-" && operand.k === "num"
          ? { k: "num", v: -operand.v }
          : { k: "un", op: tok.v, a: operand, line: tok.line }
    } else left = this.simpleExpr()
    for (;;) {
      const op = this.tok
      if (op.t !== "sym" && op.t !== "kw") break
      const priority = BINARY[op.v]
      if (priority === undefined || priority[0] <= limit) break
      this.next()
      const right = this.expr(priority[1])
      if (op.v === "and") left = { k: "and", a: left, b: right }
      else if (op.v === "or") left = { k: "or", a: left, b: right }
      else left = { k: "bin", op: op.v, a: left, b: right, line: op.line }
    }
    return left
  }
}

/** Parse a chunk into a vararg function prototype. Throws `LuaSyntaxError` in Lua's message format. */
export function parseChunk(source: string, name = "user_script"): Proto {
  const previous = chunkName
  chunkName = name
  try {
    const parser = new Parser(tokenize(source), new FuncState(null))
    return parser.chunk()
  } finally {
    chunkName = previous
  }
}
