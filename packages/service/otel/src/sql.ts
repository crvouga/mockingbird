/**
 * The subset of OpenObserve's SQL our clients send to `POST /api/{org}/_search`:
 *
 *   SELECT * | <expr> [AS alias], … FROM "<stream>"
 *   [WHERE <predicate>] [GROUP BY <expr>, …] [HAVING <predicate>]
 *   [ORDER BY <expr> [ASC|DESC], …] [LIMIT n [OFFSET m]]
 *
 * Predicates: `AND`/`OR`/`NOT`, parentheses, `=`, `!=`/`<>`, `<`, `<=`, `>`, `>=`,
 * `IS [NOT] NULL`, `[NOT] IN (…)`, `[NOT] LIKE`/`ILIKE`, `[NOT] BETWEEN … AND …`.
 * Functions: `str_match`, `str_match_ignore_case`, `match_all`, `re_match`, `lower`, `upper`,
 * `tostring`, `length`, `coalesce`, and the aggregates `count(*)`, `count([DISTINCT] x)`,
 * `min`, `max`, `sum`, `avg`.
 *
 * Column names are matched exactly (O2 stores them lowercased, so `clientUserId` is an unknown
 * field); a column the stream's schema has never seen is a 400, as on the real server.
 */
import type { Row, Scalar } from "./otlp.js"

export class SqlError extends Error {
  constructor(
    message: string,
    readonly kind: "syntax" | "unknown_field" = "syntax",
  ) {
    super(message)
    this.name = "SqlError"
  }
}

type Token =
  | { t: "ident"; v: string; quoted: boolean }
  | { t: "str"; v: string }
  | { t: "num"; v: number }
  | { t: "op"; v: string }

const tokenize = (sql: string): Token[] => {
  const tokens: Token[] = []
  let i = 0
  while (i < sql.length) {
    const c = sql[i] as string
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++
      continue
    }
    if (c === "'") {
      let value = ""
      i++
      for (;;) {
        if (i >= sql.length) throw new SqlError("unterminated string literal")
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            value += "'"
            i += 2
            continue
          }
          i++
          break
        }
        value += sql[i++]
      }
      tokens.push({ t: "str", v: value })
      continue
    }
    if (c === '"') {
      const end = sql.indexOf('"', i + 1)
      if (end < 0) throw new SqlError("unterminated quoted identifier")
      tokens.push({ t: "ident", v: sql.slice(i + 1, end), quoted: true })
      i = end + 1
      continue
    }
    const number = /^\d+(\.\d+)?/.exec(sql.slice(i))
    if (number) {
      tokens.push({ t: "num", v: Number(number[0]) })
      i += number[0].length
      continue
    }
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(i))
    if (word) {
      tokens.push({ t: "ident", v: word[0], quoted: false })
      i += word[0].length
      continue
    }
    const op = /^(<=|>=|<>|!=|=|<|>|\(|\)|,|\*|;|\+|-)/.exec(sql.slice(i))
    if (op) {
      tokens.push({ t: "op", v: op[0] })
      i += op[0].length
      continue
    }
    throw new SqlError(`unexpected character ${JSON.stringify(c)}`)
  }
  return tokens
}

export type Expr =
  | { k: "lit"; v: Scalar | null }
  | { k: "col"; name: string }
  | { k: "star" }
  | { k: "fn"; name: string; args: Expr[]; distinct: boolean }
  | { k: "not"; e: Expr }
  | { k: "and" | "or"; l: Expr; r: Expr }
  | { k: "cmp"; op: string; l: Expr; r: Expr }
  | { k: "null"; e: Expr; not: boolean }
  | { k: "in"; e: Expr; list: Expr[]; not: boolean }
  | { k: "like"; e: Expr; pattern: Expr; not: boolean; ci: boolean }
  | { k: "between"; e: Expr; lo: Expr; hi: Expr; not: boolean }

export type SelectItem = { expr: Expr; alias: string | undefined; text: string }

export type Query = {
  star: boolean
  items: SelectItem[]
  stream: string
  where: Expr | undefined
  groupBy: Expr[]
  having: Expr | undefined
  orderBy: { expr: Expr; desc: boolean }[]
  limit: number | undefined
  offset: number
}

const KEYWORDS = new Set([
  "select",
  "from",
  "where",
  "group",
  "by",
  "having",
  "order",
  "limit",
  "offset",
  "and",
  "or",
  "not",
  "is",
  "null",
  "in",
  "like",
  "ilike",
  "between",
  "as",
  "asc",
  "desc",
  "distinct",
  "true",
  "false",
])

const AGGREGATES = new Set(["count", "min", "max", "sum", "avg"])
const FUNCTIONS = new Set([
  ...AGGREGATES,
  "str_match",
  "str_match_ignore_case",
  "match_all",
  "match_all_ignore_case",
  "re_match",
  "lower",
  "upper",
  "tostring",
  "length",
  "coalesce",
])

class Parser {
  private pos = 0
  constructor(private readonly tokens: Token[]) {}

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.pos + offset]
  }

  private isKeyword(word: string, offset = 0): boolean {
    const token = this.peek(offset)
    return token?.t === "ident" && !token.quoted && token.v.toLowerCase() === word
  }

  private isOp(op: string): boolean {
    const token = this.peek()
    return token?.t === "op" && token.v === op
  }

  private keyword(word: string): void {
    if (!this.isKeyword(word)) throw new SqlError(`expected ${word.toUpperCase()}`)
    this.pos++
  }

  private op(op: string): void {
    if (!this.isOp(op)) throw new SqlError(`expected ${op}`)
    this.pos++
  }

  private accept(word: string): boolean {
    if (!this.isKeyword(word)) return false
    this.pos++
    return true
  }

  parse(): Query {
    this.keyword("select")
    this.accept("distinct")
    let star = false
    const items: SelectItem[] = []
    do {
      if (this.isOp("*")) {
        this.pos++
        star = true
        continue
      }
      const start = this.pos
      const expr = this.expr()
      const end = this.pos
      let alias: string | undefined
      if (this.accept("as")) alias = this.identifier()
      else {
        const next = this.peek()
        if (next?.t === "ident" && (next.quoted || !KEYWORDS.has(next.v.toLowerCase()))) {
          alias = this.identifier()
        }
      }
      items.push({ expr, alias, text: this.text(start, end) })
    } while (this.isOp(",") && ++this.pos)
    this.keyword("from")
    const stream = this.identifier()
    let where: Expr | undefined
    if (this.accept("where")) where = this.expr()
    const groupBy: Expr[] = []
    if (this.accept("group")) {
      this.keyword("by")
      do groupBy.push(this.expr())
      while (this.isOp(",") && ++this.pos)
    }
    let having: Expr | undefined
    if (this.accept("having")) having = this.expr()
    const orderBy: { expr: Expr; desc: boolean }[] = []
    if (this.accept("order")) {
      this.keyword("by")
      do {
        const expr = this.expr()
        const desc = this.accept("desc")
        if (!desc) this.accept("asc")
        orderBy.push({ expr, desc })
      } while (this.isOp(",") && ++this.pos)
    }
    let limit: number | undefined
    let offset = 0
    if (this.accept("limit")) limit = this.integer()
    if (this.accept("offset")) offset = this.integer()
    if (this.isOp(";")) this.pos++
    if (this.pos < this.tokens.length) throw new SqlError("unexpected tokens after the query")
    return { star, items, stream, where, groupBy, having, orderBy, limit, offset }
  }

  private text(from: number, to: number): string {
    return this.tokens
      .slice(from, to)
      .map((t) => (t.t === "str" ? `'${t.v}'` : String(t.v)))
      .join("")
      .toLowerCase()
  }

  private integer(): number {
    const token = this.peek()
    if (token?.t !== "num" || !Number.isInteger(token.v)) throw new SqlError("expected an integer")
    this.pos++
    return token.v
  }

  private identifier(): string {
    const token = this.peek()
    if (token?.t !== "ident") throw new SqlError("expected an identifier")
    this.pos++
    return token.v
  }

  private expr(): Expr {
    let left = this.and()
    while (this.accept("or")) left = { k: "or", l: left, r: this.and() }
    return left
  }

  private and(): Expr {
    let left = this.not()
    while (this.accept("and")) left = { k: "and", l: left, r: this.not() }
    return left
  }

  private not(): Expr {
    if (this.accept("not")) return { k: "not", e: this.not() }
    return this.predicate()
  }

  private predicate(): Expr {
    const e = this.primary()
    if (this.accept("is")) {
      const not = this.accept("not")
      this.keyword("null")
      return { k: "null", e, not }
    }
    const not =
      this.isKeyword("not") &&
      (this.isKeyword("in", 1) ||
        this.isKeyword("like", 1) ||
        this.isKeyword("ilike", 1) ||
        this.isKeyword("between", 1))
    if (not) this.pos++
    if (this.accept("in")) {
      this.op("(")
      const list: Expr[] = []
      do list.push(this.primary())
      while (this.isOp(",") && ++this.pos)
      this.op(")")
      return { k: "in", e, list, not }
    }
    if (this.isKeyword("like") || this.isKeyword("ilike")) {
      const ci = this.isKeyword("ilike")
      this.pos++
      return { k: "like", e, pattern: this.primary(), not, ci }
    }
    if (this.accept("between")) {
      const lo = this.primary()
      this.keyword("and")
      return { k: "between", e, lo, hi: this.primary(), not }
    }
    if (not) throw new SqlError("expected IN, LIKE or BETWEEN after NOT")
    const token = this.peek()
    if (token?.t === "op" && ["=", "!=", "<>", "<", "<=", ">", ">="].includes(token.v)) {
      this.pos++
      return { k: "cmp", op: token.v === "<>" ? "!=" : token.v, l: e, r: this.primary() }
    }
    return e
  }

  private primary(): Expr {
    const token = this.peek()
    if (!token) throw new SqlError("unexpected end of query")
    if (token.t === "str") {
      this.pos++
      return { k: "lit", v: token.v }
    }
    if (token.t === "num") {
      this.pos++
      return { k: "lit", v: token.v }
    }
    if (token.t === "op" && token.v === "-") {
      this.pos++
      const next = this.peek()
      if (next?.t !== "num") throw new SqlError("expected a number after -")
      this.pos++
      return { k: "lit", v: -next.v }
    }
    if (token.t === "op" && token.v === "(") {
      this.pos++
      const inner = this.expr()
      this.op(")")
      return inner
    }
    if (token.t === "op" && token.v === "*") {
      this.pos++
      return { k: "star" }
    }
    if (token.t === "ident") {
      this.pos++
      if (!token.quoted) {
        const lower = token.v.toLowerCase()
        if (lower === "null") return { k: "lit", v: null }
        if (lower === "true" || lower === "false") return { k: "lit", v: lower === "true" }
        if (this.isOp("(")) {
          if (!FUNCTIONS.has(lower)) throw new SqlError(`unsupported function ${token.v}`)
          this.pos++
          const distinct = this.accept("distinct")
          const args: Expr[] = []
          if (!this.isOp(")")) {
            do args.push(this.expr())
            while (this.isOp(",") && ++this.pos)
          }
          this.op(")")
          return { k: "fn", name: lower, args, distinct }
        }
        if (KEYWORDS.has(lower)) throw new SqlError(`unexpected keyword ${token.v.toUpperCase()}`)
      }
      return { k: "col", name: token.v }
    }
    throw new SqlError(`unexpected ${token.v}`)
  }
}

export const parseSql = (sql: string): Query => new Parser(tokenize(sql)).parse()

/** Every column a query reads, minus select aliases (which ORDER BY / HAVING may name). */
export const referencedColumns = (query: Query): string[] => {
  const aliases = new Set(query.items.map((i) => i.alias).filter(Boolean) as string[])
  const out = new Set<string>()
  const visit = (e: Expr | undefined, aliasOk: boolean) => {
    if (!e) return
    switch (e.k) {
      case "col":
        if (!(aliasOk && aliases.has(e.name))) out.add(e.name)
        return
      case "fn":
        for (const a of e.args) visit(a, aliasOk)
        return
      case "not":
      case "null":
        visit(e.e, aliasOk)
        return
      case "and":
      case "or":
      case "cmp":
        visit(e.l, aliasOk)
        visit(e.r, aliasOk)
        return
      case "in":
        visit(e.e, aliasOk)
        for (const x of e.list) visit(x, aliasOk)
        return
      case "like":
        visit(e.e, aliasOk)
        visit(e.pattern, aliasOk)
        return
      case "between":
        visit(e.e, aliasOk)
        visit(e.lo, aliasOk)
        visit(e.hi, aliasOk)
        return
      default:
        return
    }
  }
  for (const item of query.items) visit(item.expr, false)
  visit(query.where, false)
  for (const g of query.groupBy) visit(g, true)
  visit(query.having, true)
  for (const o of query.orderBy) visit(o.expr, true)
  return [...out]
}

type Value = Scalar | null

const hasAggregate = (e: Expr): boolean => {
  switch (e.k) {
    case "fn":
      return AGGREGATES.has(e.name) || e.args.some(hasAggregate)
    case "not":
    case "null":
      return hasAggregate(e.e)
    case "and":
    case "or":
    case "cmp":
      return hasAggregate(e.l) || hasAggregate(e.r)
    default:
      return false
  }
}

/** A string that reads as a date, compared against a µs timestamp column. */
const asMicros = (value: string): number | undefined => {
  if (/^\d+(\.\d+)?$/.test(value)) return Number(value)
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? undefined : ms * 1000
}

const compare = (a: Value, b: Value): number | null => {
  if (a === null || b === null) return null
  if (typeof a === "number" && typeof b === "string") {
    const n = asMicros(b)
    return n === undefined ? String(a).localeCompare(b) : a - n
  }
  if (typeof a === "string" && typeof b === "number") {
    const n = asMicros(a)
    return n === undefined ? a.localeCompare(String(b)) : n - b
  }
  if (typeof a === "number" && typeof b === "number") return a - b
  if (typeof a === "boolean" || typeof b === "boolean") return String(a) === String(b) ? 0 : 1
  return a < b ? -1 : a > b ? 1 : 0
}

const likeRegex = (pattern: string, ci: boolean) =>
  new RegExp(
    `^${pattern
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/%/g, ".*")
      .replace(/_/g, ".")}$`,
    ci ? "is" : "s",
  )

const text = (v: Value): string | null => (v === null ? null : String(v))

type Context = { row: Row; group?: Row[]; aliases?: Record<string, Value> }

const truthy = (v: Value): boolean => v === true

export const evaluate = (e: Expr, ctx: Context): Value => {
  switch (e.k) {
    case "lit":
      return e.v
    case "col":
      if (ctx.aliases && e.name in ctx.aliases) return ctx.aliases[e.name] ?? null
      return ctx.row[e.name] ?? null
    case "star":
      return null
    case "not": {
      const v = evaluate(e.e, ctx)
      return v === null ? null : !truthy(v)
    }
    case "and": {
      const l = evaluate(e.l, ctx)
      if (l === false) return false
      const r = evaluate(e.r, ctx)
      if (r === false) return false
      return l === null || r === null ? null : truthy(l) && truthy(r)
    }
    case "or": {
      const l = evaluate(e.l, ctx)
      if (truthy(l)) return true
      const r = evaluate(e.r, ctx)
      if (truthy(r)) return true
      return l === null || r === null ? null : false
    }
    case "cmp": {
      const c = compare(evaluate(e.l, ctx), evaluate(e.r, ctx))
      if (c === null) return null
      switch (e.op) {
        case "=":
          return c === 0
        case "!=":
          return c !== 0
        case "<":
          return c < 0
        case "<=":
          return c <= 0
        case ">":
          return c > 0
        default:
          return c >= 0
      }
    }
    case "null": {
      const isNull = evaluate(e.e, ctx) === null
      return e.not ? !isNull : isNull
    }
    case "in": {
      const v = evaluate(e.e, ctx)
      if (v === null) return null
      const found = e.list.some((x) => compare(v, evaluate(x, ctx)) === 0)
      return e.not ? !found : found
    }
    case "like": {
      const v = text(evaluate(e.e, ctx))
      const p = text(evaluate(e.pattern, ctx))
      if (v === null || p === null) return null
      const matched = likeRegex(p, e.ci).test(v)
      return e.not ? !matched : matched
    }
    case "between": {
      const v = evaluate(e.e, ctx)
      const lo = compare(v, evaluate(e.lo, ctx))
      const hi = compare(v, evaluate(e.hi, ctx))
      if (lo === null || hi === null) return null
      const inside = lo >= 0 && hi <= 0
      return e.not ? !inside : inside
    }
    case "fn":
      return call(e, ctx)
  }
}

const call = (e: Extract<Expr, { k: "fn" }>, ctx: Context): Value => {
  if (AGGREGATES.has(e.name)) {
    const rows = ctx.group ?? [ctx.row]
    const arg = e.args[0]
    if (e.name === "count") {
      if (!arg || arg.k === "star") return rows.length
      const values = rows.map((row) => evaluate(arg, { row })).filter((v) => v !== null)
      return e.distinct ? new Set(values.map((v) => JSON.stringify(v))).size : values.length
    }
    if (!arg) throw new SqlError(`${e.name}() needs an argument`)
    const values = rows.map((row) => evaluate(arg, { row })).filter((v) => v !== null)
    if (values.length === 0) return null
    if (e.name === "min" || e.name === "max") {
      return values.reduce((best, v) => {
        const c = compare(v, best) ?? 0
        return (e.name === "min" ? c < 0 : c > 0) ? v : best
      })
    }
    const numbers = values.map(Number).filter((n) => Number.isFinite(n))
    const sum = numbers.reduce((a, b) => a + b, 0)
    return e.name === "sum" ? sum : numbers.length === 0 ? null : sum / numbers.length
  }
  const args = e.args.map((a) => evaluate(a, ctx))
  const [a, b] = args
  switch (e.name) {
    case "str_match":
      return a === null || b === null ? false : String(a).includes(String(b))
    case "str_match_ignore_case":
      return a === null || b === null
        ? false
        : String(a).toLowerCase().includes(String(b).toLowerCase())
    case "match_all":
    case "match_all_ignore_case": {
      if (a === null) return false
      const needle = String(a).toLowerCase()
      return Object.values(ctx.row).some(
        (v) => typeof v === "string" && v.toLowerCase().includes(needle),
      )
    }
    case "re_match":
      if (a === null || b === null) return false
      try {
        return new RegExp(String(b)).test(String(a))
      } catch {
        throw new SqlError(`invalid regular expression ${String(b)}`)
      }
    case "lower":
      return a === null || a === undefined ? null : String(a).toLowerCase()
    case "upper":
      return a === null || a === undefined ? null : String(a).toUpperCase()
    case "tostring":
      return a === null || a === undefined ? null : String(a)
    case "length":
      return a === null || a === undefined ? null : [...String(a)].length
    case "coalesce":
      return args.find((v) => v !== null) ?? null
    default:
      throw new SqlError(`unsupported function ${e.name}`)
  }
}

const columnName = (item: SelectItem): string =>
  item.alias ?? (item.expr.k === "col" ? item.expr.name : item.text)

const project = (query: Query, ctx: Context): Record<string, Value> => {
  const out: Record<string, Value> = {}
  if (query.star) Object.assign(out, ctx.row)
  for (const item of query.items) out[columnName(item)] = evaluate(item.expr, ctx)
  return out
}

const sortBy = <T>(items: T[], keys: { desc: boolean; value: (item: T) => Value }[]): T[] =>
  [...items].sort((x, y) => {
    for (const key of keys) {
      const a = key.value(x)
      const b = key.value(y)
      if (a === null && b === null) continue
      if (a === null) return 1
      if (b === null) return -1
      const c = compare(a, b) ?? 0
      if (c !== 0) return key.desc ? -c : c
    }
    return 0
  })

/** Drop null columns, as O2's JSON writer does. */
const compact = (row: Record<string, Value>): Row => {
  const out: Row = {}
  for (const [key, value] of Object.entries(row)) if (value !== null) out[key] = value
  return out
}

/** Run a parsed query over rows already filtered to the stream and time window. */
export const execute = (query: Query, rows: Row[]): Row[] => {
  const where = query.where
  const matched = where ? rows.filter((row) => truthy(evaluate(where, { row }))) : rows
  const aggregated = query.groupBy.length > 0 || query.items.some((item) => hasAggregate(item.expr))
  let output: Record<string, Value>[]
  if (aggregated) {
    if (query.star) throw new SqlError("SELECT * cannot be combined with GROUP BY or aggregates")
    const groups = new Map<string, Row[]>()
    if (query.groupBy.length === 0) groups.set("", matched)
    for (const row of query.groupBy.length > 0 ? matched : []) {
      const key = JSON.stringify(query.groupBy.map((g) => evaluate(g, { row })))
      groups.set(key, [...(groups.get(key) ?? []), row])
    }
    output = []
    for (const group of groups.values()) {
      const ctx: Context = { row: group[0] ?? {}, group }
      const projected = project(query, ctx)
      const having = query.having
      if (having && !truthy(evaluate(having, { ...ctx, aliases: projected }))) continue
      output.push(projected)
    }
    output = sortBy(
      output,
      query.orderBy.map((o) => ({
        desc: o.desc,
        value: (r) => evaluate(o.expr, { row: {}, aliases: r }),
      })),
    )
  } else {
    const aliasExprs = new Map(
      query.items.filter((i) => i.alias).map((i) => [i.alias as string, i.expr]),
    )
    const order =
      query.orderBy.length > 0
        ? query.orderBy
        : [{ expr: { k: "col", name: "_timestamp" } as Expr, desc: true }]
    const sorted = sortBy(
      matched,
      order.map((o) => ({
        desc: o.desc,
        value: (row: Row) =>
          evaluate(
            o.expr.k === "col" && aliasExprs.has(o.expr.name)
              ? (aliasExprs.get(o.expr.name) as Expr)
              : o.expr,
            { row },
          ),
      })),
    )
    output = sorted.map((row) => project(query, { row }))
  }
  const start = query.offset
  const end = query.limit === undefined ? undefined : start + query.limit
  return output.slice(start, end).map(compact)
}
