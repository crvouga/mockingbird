import type { AttributeValue, Item } from "./state.js"

/**
 * Condition, filter and key-condition expressions, parsed by the grammar AWS documents:
 * https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Expressions.OperatorsAndFunctions.html
 *
 *   condition  := or
 *   or         := and ( OR and )*
 *   and        := not ( AND not )*
 *   not        := NOT not | primary
 *   primary    := "(" condition ")" | function | operand comparator operand
 *               | operand BETWEEN operand AND operand | operand IN "(" operand ("," operand)* ")"
 *   operand    := path | :value | size(path)
 *
 * Precedence, highest first: = <> < <= > >=, IN, BETWEEN, functions, parentheses, NOT, AND, OR.
 * A malformed expression or an undefined `#name`/`:value` throws, which the caller answers as a
 * ValidationException, as DynamoDB does.
 */
type Names = Record<string, string>
type Values = Record<string, AttributeValue>
type Segment = string | number
type Operand =
  | { kind: "path"; path: Segment[] }
  | { kind: "value"; value: AttributeValue }
  | { kind: "size"; path: Segment[] }
type Node =
  | { kind: "or" | "and"; left: Node; right: Node }
  | { kind: "not"; operand: Node }
  | { kind: "compare"; op: string; left: Operand; right: Operand }
  | { kind: "between"; subject: Operand; low: Operand; high: Operand }
  | { kind: "in"; subject: Operand; candidates: Operand[] }
  | { kind: "call"; name: string; args: Operand[] }

type Token = { type: "word" | "name" | "value" | "number" | "punct"; text: string }

const COMPARATORS = new Set(["=", "<>", "<", "<=", ">", ">="])
const FUNCTIONS = new Set([
  "attribute_exists",
  "attribute_not_exists",
  "attribute_type",
  "begins_with",
  "contains",
])
const TYPES = new Set(["S", "SS", "N", "NS", "B", "BS", "BOOL", "NULL", "L", "M"])

const tokenize = (source: string): Token[] => {
  const tokens: Token[] = []
  const pattern =
    /\s+|(<>|<=|>=|[=<>(),.[\]])|(#[A-Za-z0-9_]+)|(:[A-Za-z0-9_]+)|([0-9]+)(?![A-Za-z_])|([A-Za-z_][A-Za-z0-9_-]*)/y
  let index = 0
  while (index < source.length) {
    pattern.lastIndex = index
    const match = pattern.exec(source)
    if (!match)
      throw new SyntaxError(`Invalid ConditionExpression: Syntax error; token: "${source[index]}"`)
    index = pattern.lastIndex
    if (match[1]) tokens.push({ type: "punct", text: match[1] })
    else if (match[2]) tokens.push({ type: "name", text: match[2] })
    else if (match[3]) tokens.push({ type: "value", text: match[3] })
    else if (match[4]) tokens.push({ type: "number", text: match[4] })
    else if (match[5]) tokens.push({ type: "word", text: match[5] })
  }
  return tokens
}

class Parser {
  private index = 0
  constructor(
    private readonly tokens: Token[],
    private readonly names: Names,
    private readonly values: Values,
  ) {}
  parse(): Node {
    const node = this.or()
    if (this.peek()) this.fail()
    return node
  }
  private peek(offset = 0) {
    return this.tokens[this.index + offset]
  }
  private fail(): never {
    const token = this.peek()
    throw new SyntaxError(
      `Invalid ConditionExpression: Syntax error; token: "${token?.text ?? "<EOF>"}"`,
    )
  }
  private keyword(word: string) {
    const token = this.peek()
    if (token?.type === "word" && token.text.toUpperCase() === word) {
      this.index++
      return true
    }
    return false
  }
  private punct(text: string) {
    if (this.peek()?.type === "punct" && this.peek()?.text === text) {
      this.index++
      return true
    }
    return false
  }
  private expect(text: string) {
    if (!this.punct(text)) this.fail()
  }
  private or(): Node {
    let node = this.and()
    while (this.keyword("OR")) node = { kind: "or", left: node, right: this.and() }
    return node
  }
  private and(): Node {
    let node = this.not()
    while (this.keyword("AND")) node = { kind: "and", left: node, right: this.not() }
    return node
  }
  private not(): Node {
    if (this.keyword("NOT")) return { kind: "not", operand: this.not() }
    return this.primary()
  }
  private primary(): Node {
    if (this.punct("(")) {
      const node = this.or()
      this.expect(")")
      return node
    }
    const token = this.peek()
    if (
      token?.type === "word" &&
      FUNCTIONS.has(token.text) &&
      this.peek(1)?.type === "punct" &&
      this.peek(1)?.text === "("
    ) {
      this.index += 2
      const args = [this.operand()]
      while (this.punct(",")) args.push(this.operand())
      this.expect(")")
      const arity =
        token.text === "attribute_exists" || token.text === "attribute_not_exists" ? 1 : 2
      if (args.length !== arity || args[0]?.kind !== "path")
        throw new SyntaxError(`Invalid ConditionExpression: Incorrect operands for ${token.text}`)
      return { kind: "call", name: token.text, args }
    }
    const left = this.operand()
    if (this.keyword("BETWEEN")) {
      const low = this.operand()
      if (!this.keyword("AND")) this.fail()
      return { kind: "between", subject: left, low, high: this.operand() }
    }
    if (this.keyword("IN")) {
      this.expect("(")
      const candidates = [this.operand()]
      while (this.punct(",")) candidates.push(this.operand())
      this.expect(")")
      return { kind: "in", subject: left, candidates }
    }
    const op = this.peek()
    if (op?.type !== "punct" || !COMPARATORS.has(op.text)) this.fail()
    this.index++
    return { kind: "compare", op: op.text, left, right: this.operand() }
  }
  private operand(): Operand {
    const token = this.peek()
    if (token?.type === "value") {
      this.index++
      const value = this.values[token.text]
      if (!value)
        throw new SyntaxError(
          `Invalid ConditionExpression: An expression attribute value used in expression is not defined; attribute value: ${token.text}`,
        )
      return { kind: "value", value }
    }
    if (
      token?.type === "word" &&
      token.text === "size" &&
      this.peek(1)?.type === "punct" &&
      this.peek(1)?.text === "("
    ) {
      this.index += 2
      const path = this.path()
      this.expect(")")
      return { kind: "size", path }
    }
    return { kind: "path", path: this.path() }
  }
  private segment(): string {
    const token = this.peek()
    if (token?.type === "name") {
      this.index++
      const name = this.names[token.text]
      if (name === undefined)
        throw new SyntaxError(
          `Invalid ConditionExpression: An expression attribute name used in the document path is not defined; attribute name: ${token.text}`,
        )
      return name
    }
    if (token?.type === "word") {
      this.index++
      return token.text
    }
    return this.fail()
  }
  private path(): Segment[] {
    const path: Segment[] = [this.segment()]
    for (;;) {
      if (this.punct(".")) path.push(this.segment())
      else if (this.punct("[")) {
        const token = this.peek()
        if (token?.type !== "number") this.fail()
        this.index++
        path.push(Number(token.text))
        this.expect("]")
      } else return path
    }
  }
}

const resolve = (item: Item, path: Segment[]): AttributeValue | undefined => {
  let value: AttributeValue | undefined = item[path[0] as string]
  for (const segment of path.slice(1))
    value = typeof segment === "number" ? value?.L?.[segment] : value?.M?.[segment]
  return value
}

const typeOf = (value: AttributeValue) => Object.keys(value)[0] as string

const bytes = (base64: string) => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))

/** Order two values of the same scalar type (N, S, B); undefined when they cannot be ordered. */
const order = (left?: AttributeValue, right?: AttributeValue): number | undefined => {
  if (left?.N !== undefined && right?.N !== undefined) return Number(left.N) - Number(right.N)
  if (left?.S !== undefined && right?.S !== undefined)
    return left.S < right.S ? -1 : left.S > right.S ? 1 : 0
  if (left?.B !== undefined && right?.B !== undefined) {
    const a = bytes(String(left.B))
    const b = bytes(String(right.B))
    for (let i = 0; i < Math.min(a.length, b.length); i++)
      if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number)
    return a.length - b.length
  }
  return undefined
}

const sameSet = (left: unknown[], right: unknown[]) =>
  left.length === right.length && left.every((entry) => right.includes(entry))

const equal = (left?: AttributeValue, right?: AttributeValue): boolean => {
  if (left === undefined || right === undefined) return false
  if (left.N !== undefined && right.N !== undefined) return Number(left.N) === Number(right.N)
  for (const set of ["SS", "NS", "BS"] as const) {
    const a = left[set] as unknown[] | undefined
    const b = right[set] as unknown[] | undefined
    if (a && b) return sameSet(a, b)
  }
  return JSON.stringify(left) === JSON.stringify(right)
}

const operandValue = (item: Item, operand: Operand): AttributeValue | undefined => {
  if (operand.kind === "value") return operand.value
  const value = resolve(item, operand.path)
  if (operand.kind === "path" || value === undefined) return value
  if (value.S !== undefined) return { N: String([...value.S].length) }
  if (value.B !== undefined) return { N: String(bytes(String(value.B)).length) }
  const collection = value.SS ?? value.NS ?? value.BS ?? value.L
  if (collection) return { N: String(collection.length) }
  if (value.M) return { N: String(Object.keys(value.M).length) }
  return undefined
}

const call = (item: Item, name: string, args: Operand[]): boolean => {
  const subject = operandValue(item, args[0] as Operand)
  const argument = args[1] ? operandValue(item, args[1]) : undefined
  switch (name) {
    case "attribute_exists":
      return subject !== undefined
    case "attribute_not_exists":
      return subject === undefined
    case "attribute_type":
      if (argument?.S === undefined || !TYPES.has(argument.S))
        throw new SyntaxError(
          `Invalid ConditionExpression: Invalid attribute type name found in type`,
        )
      return subject !== undefined && typeOf(subject) === argument.S
    case "begins_with":
      if (subject?.S !== undefined && argument?.S !== undefined)
        return subject.S.startsWith(argument.S)
      if (subject?.B !== undefined && argument?.B !== undefined) {
        const whole = bytes(String(subject.B))
        const prefix = bytes(String(argument.B))
        return prefix.every((byte, i) => whole[i] === byte)
      }
      return false
    case "contains":
      if (subject === undefined || argument === undefined) return false
      if (subject.S !== undefined && argument.S !== undefined) return subject.S.includes(argument.S)
      if (subject.SS && argument.S !== undefined) return subject.SS.includes(argument.S)
      if (subject.NS && argument.N !== undefined)
        return subject.NS.some((entry) => Number(entry) === Number(argument.N))
      if (subject.BS && argument.B !== undefined) return subject.BS.includes(argument.B)
      if (subject.L) return subject.L.some((entry) => equal(entry, argument))
      return false
  }
  return false
}

const evaluate = (node: Node, item: Item): boolean => {
  switch (node.kind) {
    case "or":
      return evaluate(node.left, item) || evaluate(node.right, item)
    case "and":
      return evaluate(node.left, item) && evaluate(node.right, item)
    case "not":
      return !evaluate(node.operand, item)
    case "call":
      return call(item, node.name, node.args)
    case "in": {
      const subject = operandValue(item, node.subject)
      return node.candidates.some((candidate) => equal(subject, operandValue(item, candidate)))
    }
    case "between": {
      const subject = operandValue(item, node.subject)
      const low = order(subject, operandValue(item, node.low))
      const high = order(subject, operandValue(item, node.high))
      return low !== undefined && high !== undefined && low >= 0 && high <= 0
    }
    case "compare": {
      const left = operandValue(item, node.left)
      const right = operandValue(item, node.right)
      if (node.op === "=") return equal(left, right)
      // A missing attribute is "not equal" to any value, as DynamoDB evaluates <>.
      if (node.op === "<>") return !equal(left, right)
      const sign = order(left, right)
      if (sign === undefined) return false
      return node.op === "<"
        ? sign < 0
        : node.op === "<="
          ? sign <= 0
          : node.op === ">"
            ? sign > 0
            : sign >= 0
    }
  }
}

/** Compile an expression once; the returned predicate tests one item (absent item = `{}`). */
export const compileCondition = (
  expression: unknown,
  names: Names,
  values: Values,
): ((item: Item | undefined) => boolean) => {
  if (typeof expression !== "string" || !expression.trim()) return () => true
  const tree = new Parser(tokenize(expression), names, values).parse()
  return (item) => evaluate(tree, item ?? {})
}

export const condition = (
  expression: unknown,
  item: Item | undefined,
  names: Names,
  values: Values,
): boolean => compileCondition(expression, names, values)(item)
