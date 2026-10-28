/**
 * MinIO's S3 Select SQL (`internal/s3select/sql`): the participle grammar's lexer, a recursive
 * descent parser over the same productions, and the evaluator with MinIO's type inference.
 * Supported: projections, aliases, WHERE with comparisons / AND / OR / NOT / IS [NOT] / BETWEEN /
 * IN / LIKE, arithmetic, LIMIT, and the COUNT / SUM / AVG / MIN / MAX aggregates.
 */
import {
  csvString,
  encodeValue,
  fromJson,
  goBytes,
  type JsonObject,
  JsonObject as JsonObjectClass,
  type JsonValue,
  jsonNumber,
  MISSING,
  NULL,
  type Value,
} from "./values.js"

/** An S3 Select error with its own code (rendered without `<Region>`, like MinIO). */
export class SelectError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message)
  }
}

/** A failure while evaluating rows: the event stream ends with an `InternalError` message. */
export class RuntimeError extends Error {}

// ── lexer ────────────────────────────────────────────────────────────────────
type TokenType =
  | "Timeword"
  | "Keyword"
  | "Ident"
  | "QuotIdent"
  | "Float"
  | "Int"
  | "LitString"
  | "Operators"
  | "EOF"
type Token = { type: TokenType; value: string; line: number; column: number }

const KEYWORDS =
  "SELECT|FROM|TOP|DISTINCT|ALL|WHERE|GROUP|BY|HAVING|UNION|MINUS|EXCEPT|INTERSECT|ORDER|LIMIT|OFFSET|TRUE|FALSE|NULL|IS|NOT|ANY|SOME|BETWEEN|AND|OR|LIKE|ESCAPE|AS|IN|BOOL|INT|INTEGER|STRING|FLOAT|DECIMAL|NUMERIC|TIMESTAMP|AVG|COUNT|MAX|MIN|SUM|COALESCE|NULLIF|CAST|DATE_ADD|DATE_DIFF|EXTRACT|TO_STRING|TO_TIMESTAMP|UTCNOW|CHAR_LENGTH|CHARACTER_LENGTH|LOWER|SUBSTRING|TRIM|UPPER|LEADING|TRAILING|BOTH|FOR|MISSING"
const RULES: [TokenType | "space", RegExp][] = [
  ["space", /\s+/y],
  ["Timeword", /\b(?:YEAR|MONTH|DAY|HOUR|MINUTE|SECOND|TIMEZONE_HOUR|TIMEZONE_MINUTE)\b/iy],
  ["Keyword", new RegExp(`\\b(?:${KEYWORDS})\\b`, "iy")],
  ["Ident", /[a-zA-Z_][a-zA-Z0-9_]*/y],
  ["QuotIdent", /"([^"]*("")?)*"/y],
  ["Float", /\d*\.\d+([eE][-+]?\d+)?/y],
  ["Int", /\d+/y],
  ["LitString", /'([^']*('')?)*'/y],
  ["Operators", /<>|!=|<=|>=|\.\*|\[\*\]|[-+*/%,.()=<>[\]]/y],
]

const lex = (input: string): Token[] => {
  const tokens: Token[] = []
  let offset = 0
  let line = 1
  let column = 1
  while (offset < input.length) {
    let matched = false
    for (const [type, pattern] of RULES) {
      pattern.lastIndex = offset
      const match = pattern.exec(input)
      if (!match || match[0] === "") continue
      if (type !== "space") tokens.push({ type, value: match[0], line, column })
      for (const char of match[0]) {
        if (char === "\n") {
          line++
          column = 1
        } else column++
      }
      offset += match[0].length
      matched = true
      break
    }
    if (!matched)
      throw new SelectError(
        "ParseSelectFailure",
        `${line}:${column}: invalid input text "${input.slice(offset, offset + 10)}..."`,
      )
  }
  tokens.push({ type: "EOF", value: "", line, column })
  return tokens
}

// ── AST ──────────────────────────────────────────────────────────────────────
type PathElement =
  | { key: string; lit?: boolean }
  | { index: number }
  | { objectWildcard: true }
  | { arrayWildcard: true }
type JsonPath = { base: string; path: PathElement[]; text: string }
type Lit =
  | { int: number }
  | { float: number }
  | { string: string }
  | { bool: boolean }
  | { null: true }
  | { missing: true }
type Agg = { count: number; sum: Value; seen: boolean; min: Value; max: Value }
type Func = {
  name: string
  star?: boolean
  args: Expression[]
  cast?: string
  agg?: Agg
}
type Primary = { lit: Lit } | { path: JsonPath } | { list: Expression[] } | { func: Func }
type Unary = { negated: boolean; primary: Primary }
type MultOp = { left: Unary; right: [string, Unary][] }
type Operand = { left: MultOp; right: [string, MultOp][] }
type Rhs =
  | { compare: string; operand: Operand }
  | { between: { not: boolean; start: Operand; end: Operand } }
  | { in: { list?: Expression[]; path?: JsonPath } }
  | { like: { not: boolean; pattern: Operand; escape?: Operand } }
type Condition = { not: Condition } | { operand: Operand; rhs?: Rhs }
type AndCondition = Condition[]
type Expression = AndCondition[]
type Aliased = { expr: Expression; as: string }
export type Select = {
  all: boolean
  expressions: Aliased[]
  table: JsonPath
  alias: string
  where?: Expression
  limit: number
}

const AGGREGATES = ["COUNT", "SUM", "AVG", "MIN", "MAX"]
const SIMPLE_FUNCTIONS = [
  "AVG",
  "MAX",
  "MIN",
  "SUM",
  "COALESCE",
  "NULLIF",
  "TO_STRING",
  "TO_TIMESTAMP",
  "UTCNOW",
  "CHAR_LENGTH",
  "CHARACTER_LENGTH",
  "LOWER",
  "UPPER",
]

class Parser {
  private position = 0
  constructor(private readonly tokens: Token[]) {}
  private get token() {
    return this.tokens[this.position] as Token
  }
  private peek(offset = 1) {
    return this.tokens[Math.min(this.position + offset, this.tokens.length - 1)] as Token
  }
  private next() {
    const token = this.token
    if (token.type !== "EOF") this.position++
    return token
  }
  private isKeyword(word: string, token = this.token) {
    return token.type === "Keyword" && token.value.toUpperCase() === word
  }
  private isOp(op: string, token = this.token) {
    return token.type === "Operators" && token.value === op
  }
  fail(expected?: string): never {
    const token = this.token
    const shown = token.type === "EOF" ? "<EOF>" : token.value
    throw new SelectError(
      "ParseSelectFailure",
      `${token.line}:${token.column}: unexpected token "${shown}"${expected ? ` (expected ${expected})` : ""}`,
    )
  }
  private keyword(word: string) {
    if (!this.isKeyword(word)) this.fail(`"${word}"`)
    this.next()
  }
  private op(op: string) {
    if (!this.isOp(op)) this.fail(`"${op}"`)
    this.next()
  }

  select(): Select {
    if (!this.isKeyword("SELECT")) this.fail()
    this.next()
    let all = false
    const expressions: Aliased[] = []
    if (this.isOp("*")) {
      this.next()
      all = true
    } else {
      expressions.push(this.aliased())
      while (this.isOp(",")) {
        this.next()
        expressions.push(this.aliased())
      }
    }
    this.keyword("FROM")
    const table = this.jsonPath()
    let alias = ""
    if (this.isKeyword("AS")) {
      this.next()
      if (this.token.type !== "Ident") this.fail("<ident>")
      alias = this.next().value
    } else if (this.token.type === "Ident") alias = this.next().value
    let where: Expression | undefined
    if (this.isKeyword("WHERE")) {
      this.next()
      where = this.expression()
    }
    let limit = -1
    let limitToken: Lit | undefined
    if (this.isKeyword("LIMIT")) {
      this.next()
      limitToken = this.literal()
      if (!limitToken)
        this.fail('<float> | <int> | <litstring> | "TRUE" | "FALSE" | "NULL" | "MISSING"')
    }
    if (this.token.type !== "EOF") this.fail()
    if (limitToken) {
      if (!("int" in limitToken) || limitToken.int < 0)
        throw new SelectError("InvalidQuery", "Limit value must be a positive integer")
      limit = limitToken.int
    }
    return { all, expressions, table, alias, ...(where ? { where } : {}), limit }
  }
  private aliased(): Aliased {
    const expr = this.expression()
    let as = ""
    if (this.isKeyword("AS")) {
      this.next()
      if (this.token.type !== "Ident" && this.token.type !== "LitString") this.fail()
      as = this.next().value
    }
    return { expr, as }
  }
  expression(): Expression {
    const out: Expression = [this.andCondition()]
    while (this.isKeyword("OR")) {
      this.next()
      out.push(this.andCondition())
    }
    return out
  }
  private andCondition(): AndCondition {
    const out: AndCondition = [this.condition()]
    while (this.isKeyword("AND")) {
      this.next()
      out.push(this.condition())
    }
    return out
  }
  private condition(): Condition {
    if (this.isKeyword("NOT")) {
      this.next()
      return { not: this.condition() }
    }
    const operand = this.operand()
    const rhs = this.rhs()
    return rhs ? { operand, rhs } : { operand }
  }
  private rhs(): Rhs | undefined {
    const token = this.token
    if (
      token.type === "Operators" &&
      ["<>", "<=", ">=", "=", "<", ">", "!="].includes(token.value)
    ) {
      this.next()
      return { compare: token.value, operand: this.operand() }
    }
    if (this.isKeyword("IS")) {
      this.next()
      let compare = "IS"
      if (this.isKeyword("NOT")) {
        this.next()
        compare = "ISNOT"
      }
      return { compare, operand: this.operand() }
    }
    const not = this.isKeyword("NOT")
    const after = not ? this.peek() : token
    if (this.isKeyword("BETWEEN", after)) {
      if (not) this.next()
      this.next()
      const start = this.operand()
      this.keyword("AND")
      return { between: { not, start, end: this.operand() } }
    }
    if (this.isKeyword("LIKE", after)) {
      if (not) this.next()
      this.next()
      const pattern = this.operand()
      if (this.isKeyword("ESCAPE")) {
        this.next()
        return { like: { not, pattern, escape: this.operand() } }
      }
      return { like: { not, pattern } }
    }
    if (!not && this.isKeyword("IN")) {
      this.next()
      if (this.isOp("(") || this.isOp("[")) return { in: { list: this.list() } }
      return { in: { path: this.jsonPath() } }
    }
    return undefined
  }
  private operand(): Operand {
    const left = this.multOp()
    const right: [string, MultOp][] = []
    while (this.isOp("+") || this.isOp("-")) right.push([this.next().value, this.multOp()])
    return { left, right }
  }
  private multOp(): MultOp {
    const left = this.unary()
    const right: [string, Unary][] = []
    while (this.isOp("*") || this.isOp("/") || this.isOp("%"))
      right.push([this.next().value, this.unary()])
    return { left, right }
  }
  private unary(): Unary {
    if (this.isOp("-")) {
      this.next()
      return { negated: true, primary: this.primary() }
    }
    return { negated: false, primary: this.primary() }
  }
  private literal(): Lit | undefined {
    const token = this.token
    switch (token.type) {
      case "Float":
        this.next()
        return { float: Number(token.value) }
      case "Int":
        this.next()
        return { int: Number(token.value) }
      case "LitString":
        this.next()
        return { string: token.value.slice(1, -1).replace(/''/g, "'") }
      case "Keyword": {
        const word = token.value.toUpperCase()
        if (word === "TRUE" || word === "FALSE") {
          this.next()
          return { bool: word === "TRUE" }
        }
        if (word === "NULL") {
          this.next()
          return { null: true }
        }
        if (word === "MISSING") {
          this.next()
          return { missing: true }
        }
        return undefined
      }
      default:
        return undefined
    }
  }
  private list(): Expression[] {
    const close = this.isOp("(") ? ")" : "]"
    this.next()
    const out = [this.expression()]
    while (this.isOp(",")) {
      this.next()
      out.push(this.expression())
    }
    this.op(close)
    return out
  }
  private primary(): Primary {
    const lit = this.literal()
    if (lit) return { lit }
    const token = this.token
    if (token.type === "Ident" || token.type === "QuotIdent") return { path: this.jsonPath() }
    if (this.isOp("(") || this.isOp("[")) return { list: this.list() }
    if (token.type === "Keyword") {
      const name = token.value.toUpperCase()
      if (name === "COUNT") {
        this.next()
        this.op("(")
        if (this.isOp("*")) {
          this.next()
          this.op(")")
          return { func: { name, star: true, args: [] } }
        }
        const arg = this.expression()
        this.op(")")
        return { func: { name, args: [arg] } }
      }
      if (name === "CAST") {
        this.next()
        this.op("(")
        const expr = this.expression()
        this.keyword("AS")
        const cast = this.next().value.toUpperCase()
        this.op(")")
        return { func: { name, args: [expr], cast } }
      }
      if (SIMPLE_FUNCTIONS.includes(name)) {
        this.next()
        this.op("(")
        const args: Expression[] = []
        if (!this.isOp(")")) {
          args.push(this.expression())
          while (this.isOp(",")) {
            this.next()
            args.push(this.expression())
          }
        }
        this.op(")")
        return { func: { name, args } }
      }
    }
    return this.fail()
  }
  private identifier(): string {
    const token = this.token
    if (token.type === "Ident") return this.next().value
    if (token.type === "QuotIdent") return this.next().value.slice(1, -1).replace(/""/g, '"')
    return this.fail()
  }
  jsonPath(): JsonPath {
    const base = this.identifier()
    const path: PathElement[] = []
    let text = base
    for (;;) {
      if (this.isOp(".") && (this.peek().type === "Ident" || this.peek().type === "QuotIdent")) {
        this.next()
        const key = this.identifier()
        path.push({ key })
        text += `.${key}`
      } else if (this.isOp("[") && this.peek().type === "LitString") {
        this.next()
        const key = this.next().value.slice(1, -1).replace(/''/g, "'")
        this.op("]")
        path.push({ key, lit: true })
        text += `['${key}']`
      } else if (this.isOp("[") && this.peek().type === "Int") {
        this.next()
        const index = Number(this.next().value)
        this.op("]")
        path.push({ index })
        text += `[${index}]`
      } else if (this.isOp(".*")) {
        this.next()
        path.push({ objectWildcard: true })
        text += ".*"
      } else if (this.isOp("[*]")) {
        this.next()
        path.push({ arrayWildcard: true })
        text += "[*]"
      } else break
    }
    return { base, path, text }
  }
}

const walkFuncs = (expr: Expression, visit: (func: Func) => void) => {
  const operand = (o: Operand) => {
    for (const m of [o.left, ...o.right.map(([, r]) => r)])
      for (const u of [m.left, ...m.right.map(([, r]) => r)]) primary(u.primary)
  }
  const primary = (p: Primary) => {
    if ("func" in p) {
      visit(p.func)
      for (const arg of p.func.args) walkFuncs(arg, visit)
    } else if ("list" in p) for (const e of p.list) walkFuncs(e, visit)
  }
  const condition = (c: Condition) => {
    if ("not" in c) return condition(c.not)
    operand(c.operand)
    const rhs = c.rhs
    if (!rhs) return
    if ("compare" in rhs) operand(rhs.operand)
    else if ("between" in rhs) {
      operand(rhs.between.start)
      operand(rhs.between.end)
    } else if ("like" in rhs) {
      operand(rhs.like.pattern)
      if (rhs.like.escape) operand(rhs.like.escape)
    } else if (rhs.in.list) for (const e of rhs.in.list) walkFuncs(e, visit)
  }
  for (const and of expr) for (const c of and) condition(c)
}

/** `sql.ParseSelectStatement`. */
export const parseSelect = (input: string): Select => {
  const statement = new Parser(lex(input)).select()
  if (statement.where) {
    let aggregated = false
    walkFuncs(statement.where, (func) => {
      if (AGGREGATES.includes(func.name) && !func.cast) aggregated = true
    })
    if (aggregated) throw new SelectError("InvalidQuery", "WHERE clause cannot have an aggregation")
  }
  if (statement.table.base.toLowerCase() !== "s3object")
    throw new SelectError(
      "BadTableName",
      "The table name is not supported: table name must be `s3object`",
    )
  if (statement.table.path.length && !("arrayWildcard" in (statement.table.path[0] as object)))
    throw new SelectError(
      "BadTableName",
      "The table name is not supported: keypath table name is invalid - please check the service documentation",
    )
  // `SELECT s.* FROM S3Object s` is `SELECT *`.
  if (!statement.all && statement.expressions.length === 1) {
    const only = singlePath(statement.expressions[0]?.expr as Expression)
    if (only && only.text === `${statement.alias}.*`) statement.all = true
  }
  for (const expression of statement.expressions)
    if (expression.as.length >= 2 && expression.as.startsWith("'") && expression.as.endsWith("'"))
      expression.as = expression.as.slice(1, -1)
  return statement
}

const singlePath = (expr: Expression): JsonPath | undefined => {
  if (expr.length !== 1 || expr[0]?.length !== 1) return undefined
  const condition = expr[0][0] as Condition
  if ("not" in condition || condition.rhs) return undefined
  const operand = condition.operand
  if (operand.right.length || operand.left.right.length || operand.left.left.negated)
    return undefined
  const primary = operand.left.left.primary
  return "path" in primary ? primary.path : undefined
}

/** `getLastKeypathComponent`: the output column name of a bare path expression. */
const lastComponent = (expr: Expression): string | undefined => {
  const path = singlePath(expr)
  if (!path) return undefined
  const last = path.path[path.path.length - 1]
  if (last && !("key" in last)) return undefined
  const index = path.text.lastIndexOf(".")
  return index >= 0 ? path.text.slice(index + 1) : path.text
}

export const isAggregated = (statement: Select) => {
  let aggregated = false
  for (const { expr } of statement.expressions)
    walkFuncs(expr, (func) => {
      if (AGGREGATES.includes(func.name) && !func.cast) aggregated = true
    })
  return aggregated
}

// ── records ──────────────────────────────────────────────────────────────────
export type InputRecord =
  | { format: "csv"; names: string[]; fields: string[]; index: Map<string, number> }
  | { format: "json"; object: JsonObject }

/** A row to serialize: a CSV record, a decoded JSON object, or projected JSON output. */
export type OutputRecord =
  | { kind: "csv"; names: string[]; fields: string[] }
  | { kind: "json-input"; object: JsonObject }
  | { kind: "json"; entries: [string, string][] }

// ── evaluation ───────────────────────────────────────────────────────────────
const isNumeric = (value: Value) => value.k === "int" || value.k === "float"
const bytesToInt = (text: string) => {
  const trimmed = text.trim()
  return /^[+-]?\d+$/.test(trimmed) && Number.isSafeInteger(Number(trimmed))
    ? Number(trimmed)
    : undefined
}
const bytesToFloat = (text: string) => {
  const trimmed = text.trim()
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$|^[+-]?(inf|infinity|nan)$/i.test(trimmed))
    return undefined
  const lower = trimmed.toLowerCase().replace(/^\+/, "")
  if (lower === "inf" || lower === "infinity") return Number.POSITIVE_INFINITY
  if (lower === "-inf" || lower === "-infinity") return Number.NEGATIVE_INFINITY
  if (lower.endsWith("nan")) return Number.NaN
  return Number(trimmed)
}
const bytesToBool = (text: string) => {
  switch (text.trim().toLowerCase()) {
    case "t":
    case "true":
    case "1":
      return true
    case "f":
    case "false":
    case "0":
      return false
    default:
      return undefined
  }
}

/** Go's `Value.String()` of an untyped value inside conversion errors. */
const describe = (value: Value) =>
  value.k === "bytes" ? goBytes(value.v) : String((value as { v?: unknown }).v)

/** `inferTypesForCmp`: give untyped (bytes) operands a type. */
const inferForCompare = (a: Value, b: Value): [Value, Value] => {
  const aBytes = a.k === "bytes"
  const bBytes = b.k === "bytes"
  if (!aBytes && !bBytes) return [a, b]
  if (aBytes && bBytes) {
    const ia = bytesToInt(a.v)
    const ib = bytesToInt(b.v)
    if (ia !== undefined && ib !== undefined)
      return [
        { k: "int", v: ia },
        { k: "int", v: ib },
      ]
    const fa = bytesToFloat(a.v)
    const fb = bytesToFloat(b.v)
    if (fa !== undefined && fb !== undefined)
      return [
        { k: "float", v: fa },
        { k: "float", v: fb },
      ]
    const ba = bytesToBool(a.v)
    const bb = bytesToBool(b.v)
    if (ba !== undefined && bb !== undefined)
      return [
        { k: "bool", v: ba },
        { k: "bool", v: bb },
      ]
    return [
      { k: "string", v: a.v },
      { k: "string", v: b.v },
    ]
  }
  if (!aBytes) {
    const [y, x] = inferForCompare(b, a)
    return [x, y]
  }
  const text = (a as { v: string }).v
  switch (b.k) {
    case "string":
      return [{ k: "string", v: text }, b]
    case "int":
    case "float": {
      const i = bytesToInt(text)
      if (i !== undefined) return [{ k: "int", v: i }, b]
      const f = bytesToFloat(text)
      if (f !== undefined) return [{ k: "float", v: f }, b]
      throw new RuntimeError(`Could not convert ${describe(a)} to a number`)
    }
    case "bool": {
      const parsed = bytesToBool(text)
      if (parsed !== undefined) return [{ k: "bool", v: parsed }, b]
      throw new RuntimeError(`Could not convert ${describe(a)} to a boolean`)
    }
    default:
      throw new RuntimeError("cannot compare values of different types")
  }
}

const ordered = (op: string, cmp: number) => {
  switch (op) {
    case "<":
      return cmp < 0
    case "<=":
      return cmp <= 0
    case ">":
      return cmp > 0
    case ">=":
      return cmp >= 0
    case "=":
      return cmp === 0
    default:
      return cmp !== 0
  }
}

const compare = (opIn: string, left: Value, right: Value): boolean => {
  let op = opIn
  if (!["<", "<=", ">", ">=", "=", "!=", "IS", "ISNOT"].includes(op))
    throw new RuntimeError("invalid arithmetic operator")
  if (op === "IS") {
    if (right.k === "null") return left.k === "null" || left.k === "missing"
    if (right.k === "missing") return left.k === "missing"
    op = "="
  } else if (op === "ISNOT") {
    if (right.k === "null") return left.k !== "null" && left.k !== "missing"
    if (right.k === "missing") return left.k !== "missing"
    op = "!="
  }
  const [a, b] = inferForCompare(left, right)
  const boolCompare = (x: boolean, y: boolean) => {
    if (op === "=") return x === y
    if (op === "!=") return x !== y
    throw new RuntimeError("invalid comparison operator for boolean arguments")
  }
  if (a.k === "null" || b.k === "null") return boolCompare(a.k === "null", b.k === "null")
  if (a.k === "missing" || b.k === "missing")
    return boolCompare(a.k === "missing", b.k === "missing")
  if (a.k === "array" && b.k === "array") {
    if (op !== "=" && op !== "!=")
      throw new RuntimeError("invalid comparison operator for array arguments")
    const equal = encodeValue(a) === encodeValue(b)
    return op === "=" ? equal : !equal
  }
  if (isNumeric(a) && isNumeric(b)) {
    const x = (a as { v: number }).v
    const y = (b as { v: number }).v
    return ordered(op, x < y ? -1 : x > y ? 1 : x === y ? 0 : Number.NaN)
  }
  if (a.k === "string" && b.k === "string") return ordered(op, a.v < b.v ? -1 : a.v > b.v ? 1 : 0)
  if (a.k === "bool" && b.k === "bool") return boolCompare(a.v, b.v)
  if (op === "=") return false
  if (op === "!=") return true
  throw new RuntimeError("invalid comparison operator for boolean arguments")
}

const toNumber = (value: Value): Value => {
  if (value.k !== "bytes") return value
  const i = bytesToInt(value.v)
  if (i !== undefined) return { k: "int", v: i }
  const f = bytesToFloat(value.v)
  if (f !== undefined) return { k: "float", v: f }
  throw new RuntimeError(`Could not convert "${value.v}" to a number`)
}

const arith = (op: string, leftIn: Value, rightIn: Value): Value => {
  const left = toNumber(leftIn)
  const right = toNumber(rightIn)
  if (!isNumeric(left) || !isNumeric(right))
    throw new RuntimeError("mismatched types for arithmetic operation")
  const x = (left as { v: number }).v
  const y = (right as { v: number }).v
  if (left.k === "int" && right.k === "int") {
    if ((op === "/" || op === "%") && y === 0) throw new RuntimeError("Division by zero")
    const value =
      op === "+"
        ? x + y
        : op === "-"
          ? x - y
          : op === "*"
            ? x * y
            : op === "/"
              ? Math.trunc(x / y)
              : x % y
    return { k: "int", v: value }
  }
  if ((op === "/" || op === "%") && y === 0) throw new RuntimeError("Division by zero")
  const value =
    op === "+" ? x + y : op === "-" ? x - y : op === "*" ? x * y : op === "/" ? x / y : x % y
  return { k: "float", v: value }
}

const toBool = (value: Value): boolean => {
  if (value.k === "bool") return value.v
  throw new RuntimeError("expected bool")
}

const likeMatch = (text: string, pattern: string, escapeChar: string) => {
  let source = ""
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index] as string
    if (escapeChar && char === escapeChar && index + 1 < pattern.length) {
      source += (pattern[++index] as string).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    } else if (char === "%") source += "[\\s\\S]*"
    else if (char === "_") source += "[\\s\\S]"
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  }
  return new RegExp(`^${source}$`).test(text)
}

const asText = (value: Value): string | undefined =>
  value.k === "string" || value.k === "bytes" ? value.v : undefined

export class Evaluator {
  outputCount = 0
  private readonly alias: string
  private readonly aggregated: boolean
  constructor(
    readonly statement: Select,
    private readonly output: "csv" | "json",
  ) {
    this.alias = statement.alias
    this.aggregated = isAggregated(statement)
    for (const { expr } of statement.expressions)
      walkFuncs(expr, (func) => {
        if (AGGREGATES.includes(func.name) && !func.cast)
          func.agg = {
            count: 0,
            sum: { k: "float", v: 0 },
            seen: false,
            min: { k: "int", v: 0 },
            max: { k: "int", v: 0 },
          }
      })
  }
  get isAggregated() {
    return this.aggregated
  }
  limitReached() {
    return this.statement.limit !== -1 && this.outputCount >= this.statement.limit
  }

  private lookup(path: JsonPath, record: InputRecord | undefined): Value {
    const alias = this.alias || "s3object"
    const stripped: PathElement[] =
      path.base === alias || path.base.toLowerCase() === "s3object"
        ? path.path
        : [{ key: path.base }, ...path.path]
    if (!record) return NULL
    if (record.format === "json") {
      const elements: PathElement[] = stripped.length ? stripped : [{ key: path.base }]
      return fromJson(jsonPathEval(elements, record.object))
    }
    const last = stripped[stripped.length - 1]
    if (!last || !("key" in last)) throw new RuntimeError("Invalid keypath")
    return csvGet(record, last.key)
  }

  private primary(primary: Primary, record: InputRecord | undefined): Value {
    if ("lit" in primary) {
      const lit = primary.lit
      if ("int" in lit) return { k: "int", v: lit.int }
      if ("float" in lit) return { k: "float", v: lit.float }
      if ("string" in lit) return { k: "string", v: lit.string }
      if ("bool" in lit) return { k: "bool", v: lit.bool }
      if ("missing" in lit) return MISSING
      return NULL
    }
    if ("path" in primary) return this.lookup(primary.path, record)
    if ("list" in primary) {
      if (primary.list.length === 1) return this.expression(primary.list[0] as Expression, record)
      return { k: "array", v: primary.list.map((expr) => this.expression(expr, record)) }
    }
    return this.func(primary.func, record)
  }

  private func(func: Func, record: InputRecord | undefined): Value {
    if (func.agg) {
      const agg = func.agg
      switch (func.name) {
        case "COUNT":
          return { k: "int", v: agg.count }
        case "AVG":
          return agg.count === 0 ? NULL : arith("/", agg.sum, { k: "int", v: agg.count })
        case "MIN":
          return agg.seen ? agg.min : NULL
        case "MAX":
          return agg.seen ? agg.max : NULL
        default:
          return agg.sum
      }
    }
    const args = func.args.map((arg) => this.expression(arg, record))
    switch (func.name) {
      case "LOWER":
      case "UPPER": {
        const text = args[0] ? asText(args[0]) : undefined
        if (text === undefined) throw new RuntimeError(`${func.name}() requires a string argument`)
        return { k: "string", v: func.name === "LOWER" ? text.toLowerCase() : text.toUpperCase() }
      }
      case "CHAR_LENGTH":
      case "CHARACTER_LENGTH": {
        const text = args[0] ? asText(args[0]) : undefined
        if (text === undefined) throw new RuntimeError(`${func.name}() requires a string argument`)
        return { k: "int", v: [...text].length }
      }
      case "COALESCE":
        return args.find((arg) => arg.k !== "null" && arg.k !== "missing") ?? NULL
      case "NULLIF": {
        const [a = NULL, b = NULL] = args
        return a.k !== "null" && b.k !== "null" && compare("=", a, b) ? NULL : a
      }
      case "CAST":
        return cast(args[0] ?? NULL, func.cast ?? "")
      default:
        throw new RuntimeError("not implemented")
    }
  }

  private operand(operand: Operand, record: InputRecord | undefined): Value {
    let value = this.multOp(operand.left, record)
    for (const [op, right] of operand.right) value = arith(op, value, this.multOp(right, record))
    return value
  }
  private multOp(multOp: MultOp, record: InputRecord | undefined): Value {
    let value = this.unary(multOp.left, record)
    for (const [op, right] of multOp.right) value = arith(op, value, this.unary(right, record))
    return value
  }
  private unary(unary: Unary, record: InputRecord | undefined): Value {
    const value = this.primary(unary.primary, record)
    if (!unary.negated) return value
    const number = toNumber(value)
    if (!isNumeric(number)) throw new RuntimeError("negation is only valid on numbers")
    return { ...(number as { k: "int"; v: number }), v: -(number as { v: number }).v }
  }
  private condition(condition: Condition, record: InputRecord | undefined): Value {
    if ("not" in condition) return { k: "bool", v: !toBool(this.condition(condition.not, record)) }
    const left = this.operand(condition.operand, record)
    const rhs = condition.rhs
    if (!rhs) return left
    if ("compare" in rhs)
      return {
        k: "bool",
        v: compare(rhs.compare.toUpperCase(), left, this.operand(rhs.operand, record)),
      }
    if ("between" in rhs) {
      const start = this.operand(rhs.between.start, record)
      const end = this.operand(rhs.between.end, record)
      const result = compare("<=", start, left) && compare("<=", left, end)
      return { k: "bool", v: rhs.between.not ? !result : result }
    }
    if ("like" in rhs) {
      const pattern = this.operand(rhs.like.pattern, record)
      const escapeValue = rhs.like.escape ? this.operand(rhs.like.escape, record) : undefined
      const text = asText(left)
      const patternText = asText(pattern)
      if (text === undefined || patternText === undefined)
        throw new RuntimeError("LIKE clause requires string arguments")
      const result = likeMatch(text, patternText, escapeValue ? (asText(escapeValue) ?? "") : "")
      return { k: "bool", v: rhs.like.not ? !result : result }
    }
    const candidates = rhs.in.list
      ? rhs.in.list.map((expr) => this.expression(expr, record))
      : (() => {
          const value = this.lookup(rhs.in.path as JsonPath, record)
          return value.k === "array" ? value.v : [value]
        })()
    return {
      k: "bool",
      v: candidates.some((candidate) => {
        try {
          return compare("=", left, candidate)
        } catch {
          return false
        }
      }),
    }
  }
  expression(expr: Expression, record: InputRecord | undefined): Value {
    if (expr.length === 1) return this.andCondition(expr[0] as AndCondition, record)
    for (const and of expr)
      if (toBool(this.andCondition(and, record))) return { k: "bool", v: true }
    return { k: "bool", v: false }
  }
  private andCondition(and: AndCondition, record: InputRecord | undefined): Value {
    if (and.length === 1) return this.condition(and[0] as Condition, record)
    for (const condition of and)
      if (!toBool(this.condition(condition, record))) return { k: "bool", v: false }
    return { k: "bool", v: true }
  }

  passes(record: InputRecord): boolean {
    if (!this.statement.where) return true
    const value = this.expression(this.statement.where, record)
    if (value.k !== "bool") throw new RuntimeError("WHERE expression did not return bool")
    return value.v
  }

  /** `SelectStatement.Eval`: the output row, or undefined when WHERE filters it out. */
  evaluate(record: InputRecord): OutputRecord | undefined {
    if (!this.passes(record)) return undefined
    if (this.statement.all) {
      this.outputCount++
      return record.format === "csv"
        ? { kind: "csv", names: record.names, fields: record.fields }
        : { kind: "json-input", object: record.object }
    }
    const out = this.newOutput()
    this.statement.expressions.forEach((expression, index) => {
      const value = this.expression(expression.expr, record)
      this.set(out, expression.as || lastComponent(expression.expr) || `_${index + 1}`, value)
    })
    this.outputCount++
    return out
  }

  /** `SelectStatement.EvalFrom`: a `FROM S3Object[*].path` keypath expands one JSON document. */
  from(record: InputRecord): InputRecord[] {
    const path = this.statement.table.path
    if (path.length <= 1) return [record]
    if (record.format !== "json") throw new RuntimeError("Data source: path not supported")
    const result = jsonPathEval(path.slice(1), record.object)
    if (result instanceof JsonObjectClass) return [{ format: "json", object: result }]
    if (Array.isArray(result))
      return result.map((item) => {
        if (!(item instanceof JsonObjectClass))
          throw new RuntimeError(
            `cannot replace internal data in json record with type ${goTypeName(item)}`,
          )
        return { format: "json", object: item }
      })
    return [{ format: "json", object: new JsonObjectClass([["_1", result ?? null]]) }]
  }

  /** `SelectStatement.AggregateRow`. */
  aggregate(record: InputRecord) {
    if (!this.passes(record)) return
    for (const { expr } of this.statement.expressions)
      walkFuncs(expr, (func) => {
        if (!func.agg) return
        const agg = func.agg
        if (func.name === "COUNT" && func.star) {
          agg.count++
          return
        }
        let value = this.expression(func.args[0] as Expression, record)
        if (value.k === "null") return
        if (func.name !== "COUNT" && !isNumeric(value)) {
          const i = value.k === "bytes" ? bytesToInt(value.v) : undefined
          const f = value.k === "bytes" ? bytesToFloat(value.v) : undefined
          if (i !== undefined) value = { k: "int", v: i }
          else if (f !== undefined) value = { k: "float", v: f }
          else throw new RuntimeError(`${func.name}() requires a numeric argument`)
        }
        const first = !agg.seen
        agg.seen = true
        switch (func.name) {
          case "COUNT":
            agg.count++
            break
          case "AVG":
          case "SUM":
            agg.count++
            agg.sum = arith("+", agg.sum, { k: "float", v: (value as { v: number }).v })
            break
          case "MIN":
          case "MAX": {
            if (first) {
              if (func.name === "MIN") agg.min = value
              else agg.max = value
              break
            }
            const current = func.name === "MIN" ? agg.min : agg.max
            const better =
              func.name === "MIN" ? compare("<", value, current) : compare(">", value, current)
            if (better) {
              const next =
                current.k === "int" && value.k === "int"
                  ? value
                  : { k: "float" as const, v: (value as { v: number }).v }
              if (func.name === "MIN") agg.min = next
              else agg.max = next
            } else if (current.k === "int" && value.k === "float") {
              if (func.name === "MIN") agg.min = { k: "float", v: current.v }
              else agg.max = { k: "float", v: current.v }
            }
            break
          }
        }
      })
  }

  /** `SelectStatement.AggregateResult`. */
  aggregateResult(): OutputRecord {
    const out = this.newOutput()
    this.statement.expressions.forEach((expression, index) => {
      this.set(out, expression.as || `_${index + 1}`, this.expression(expression.expr, undefined))
    })
    return out
  }

  private newOutput(): OutputRecord {
    return this.output === "csv"
      ? { kind: "csv", names: [], fields: [] }
      : { kind: "json", entries: [] }
  }

  private set(out: OutputRecord, name: string, value: Value) {
    if (out.kind === "csv") {
      out.names.push(name)
      out.fields.push(csvString(value))
      return
    }
    if (out.kind !== "json") return
    let encoded: string
    switch (value.k) {
      case "missing":
        return
      case "bytes":
        encoded =
          value.v.startsWith("{") || value.v.startsWith("[")
            ? compactJson(value.v)
            : JSON.stringify(value.v)
        break
      case "float":
        encoded = jsonNumber(value.v)
        break
      default:
        encoded = encodeValue(value)
    }
    out.entries.push([name.replace(/\*/g, "__ALL__"), encoded])
  }
}

/** Go's `json.Compact` of raw JSON (whitespace outside strings removed). */
const compactJson = (text: string) => {
  try {
    JSON.parse(text)
  } catch {
    throw new RuntimeError(
      "json: error calling MarshalJSON for type json.RawJSON: invalid character",
    )
  }
  let out = ""
  let inString = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index] as string
    if (inString) {
      out += char
      if (char === "\\") out += text[++index] ?? ""
      else if (char === '"') inString = false
    } else if (char === '"') {
      inString = true
      out += char
    } else if (!/\s/.test(char)) out += char
  }
  return out
}

const cast = (value: Value, type: string): Value => {
  switch (type) {
    case "INT":
    case "INTEGER": {
      const number =
        value.k === "bytes" || value.k === "string" ? toNumber({ k: "bytes", v: value.v }) : value
      if (number.k === "int") return number
      if (number.k === "float") return { k: "int", v: Math.trunc(number.v) }
      throw new RuntimeError("Cannot convert to INT")
    }
    case "FLOAT":
    case "DECIMAL":
    case "NUMERIC": {
      const number =
        value.k === "bytes" || value.k === "string" ? toNumber({ k: "bytes", v: value.v }) : value
      if (isNumeric(number)) return { k: "float", v: (number as { v: number }).v }
      throw new RuntimeError("Cannot convert to FLOAT")
    }
    case "STRING":
      return { k: "string", v: csvString(value) }
    case "BOOL": {
      if (value.k === "bool") return value
      const parsed = value.k === "bytes" || value.k === "string" ? bytesToBool(value.v) : undefined
      if (parsed === undefined) throw new RuntimeError("Cannot convert to BOOL")
      return { k: "bool", v: parsed }
    }
    default:
      throw new RuntimeError("not implemented")
  }
}

/** `csv.Record.Get`. */
const csvGet = (record: Extract<InputRecord, { format: "csv" }>, name: string): Value => {
  const index = record.index.get(name)
  if (index === undefined) {
    if (name.startsWith("_")) {
      const position = /^[+-]?\d+$/.test(name.slice(1)) ? Number(name.slice(1)) - 1 : Number.NaN
      if (Number.isNaN(position)) throw new RuntimeError(`column ${name} not found`)
      if (position < 0 || position >= record.fields.length) return NULL
      return { k: "bytes", v: record.fields[position] as string }
    }
    throw new RuntimeError(`column ${name} not found`)
  }
  if (index >= record.fields.length) return NULL
  return { k: "bytes", v: record.fields[index] as string }
}

const MISSING_MARK = Symbol("missing")
/** `jsonpathEval` over a decoded document; `undefined` means MISSING. */
const jsonPathEval = (path: PathElement[], value: JsonValue): JsonValue | undefined => {
  const result = evalPath(path, value)
  return result === MISSING_MARK ? undefined : (result as JsonValue)
}
const evalPath = (path: PathElement[], value: JsonValue): JsonValue | typeof MISSING_MARK => {
  if (!path.length || value === null) return value
  const [head, ...rest] = path as [PathElement, ...PathElement[]]
  if ("key" in head) {
    if (typeof value !== "object" || Array.isArray(value))
      throw new RuntimeError("Cannot look up key in non-object value")
    const found = value.kvs.find(([key]) => key === head.key)
    return found ? evalPath(rest, found[1]) : MISSING_MARK
  }
  if ("index" in head) {
    if (!Array.isArray(value))
      throw new RuntimeError("Cannot look up array index in non-array value")
    return head.index >= value.length ? null : evalPath(rest, value[head.index] as JsonValue)
  }
  if ("objectWildcard" in head) {
    if (typeof value !== "object" || Array.isArray(value))
      throw new RuntimeError("Object wildcard used on non-object value")
    if (rest.length) throw new RuntimeError("Invalid usage of object wildcard")
    return value
  }
  if (!Array.isArray(value)) throw new RuntimeError("Array wildcard used on non-array value")
  return value.map((item) => {
    const inner = evalPath(rest, item)
    return inner === MISSING_MARK ? null : inner
  })
}

/** Go's `%T` of a decoded JSON value. */
const goTypeName = (value: JsonValue) =>
  value === null
    ? "<nil>"
    : typeof value === "string"
      ? "string"
      : typeof value === "number"
        ? "float64"
        : typeof value === "boolean"
          ? "bool"
          : Array.isArray(value)
            ? "[]interface {}"
            : "jstream.KVS"
