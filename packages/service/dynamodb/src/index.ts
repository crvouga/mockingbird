import { type APIOptions, bootSqlite, sigV4AccessKeyId } from "@crvouga/mockingbird-service"
import { clearNamespace } from "@crvouga/mockingbird-sqlite"
import { compileCondition, condition } from "./expression.js"
import { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
import {
  type AttributeValue,
  DynamoState,
  type DynamoTable,
  type Item,
  type KeySchemaElement,
} from "./state.js"

export type { DynamoRuntime, DynamoRuntimeOptions } from "./runtime.js"
export { createRuntime, DYNAMODB_PRESETS } from "./runtime.js"
export type {
  AttributeValue,
  DynamoIndex,
  DynamoItem,
  DynamoTable,
  Item,
  KeySchemaElement,
  StreamRecord,
} from "./state.js"
export { document, operationIds, supportedOperationIds }
export const DYNAMODB_NAMESPACE = "dynamodb"
export const accessKeyCredential = sigV4AccessKeyId
export type DynamoSeedTable = {
  name: string
  keySchema: KeySchemaElement[]
  attributeDefinitions?: { AttributeName: string; AttributeType: string }[]
  globalSecondaryIndexes?: DynamoTable["globalSecondaryIndexes"]
  items?: Item[]
  ttlAttribute?: string
}
export type DynamoAPIOptions = APIOptions & {
  region?: string
  accountId?: string
  tables?: readonly DynamoSeedTable[]
  onStreamRecord?: (record: ReturnType<DynamoAPI["emit"]>) => void
}
type Input = Record<string, unknown>
type Names = Record<string, string>
type Values = Record<string, AttributeValue>

const clone = <T>(value: T): T => structuredClone(value)
const scalar = (value: AttributeValue | undefined): string | number | boolean | undefined =>
  value?.S ?? (value?.N !== undefined ? Number(value.N) : (value?.BOOL ?? value?.B))
const resolveName = (name: string, names: Names) =>
  name
    .split(".")
    .map((part) => names[part] ?? part)
    .join(".")
const get = (item: Item, path: string, names: Names): AttributeValue | undefined => {
  const parts = resolveName(path.trim(), names).split(".")
  let value: AttributeValue | undefined = item[parts.shift() as string]
  for (const part of parts) value = value?.M?.[part]
  return value
}
const set = (item: Item, path: string, value: AttributeValue, names: Names) => {
  const parts = resolveName(path.trim(), names).split(".")
  const leaf = parts.pop() as string
  if (parts.length === 0) {
    item[leaf] = clone(value)
    return
  }
  let current = item
  for (const part of parts) {
    const existing = current[part]
    if (!existing?.M) current[part] = { M: {} }
    current = current[part]?.M as Item
  }
  current[leaf] = clone(value)
}
const utf8 = new TextEncoder()
const bytes = (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0))
const compareBytes = (left: Uint8Array, right: Uint8Array) => {
  for (let i = 0; i < Math.min(left.length, right.length); i++)
    if (left[i] !== right[i]) return (left[i] as number) - (right[i] as number)
  return left.length - right.length
}
/**
 * Key order as DynamoDB sorts it: N by numeric value, S by its UTF-8 bytes and B by its raw
 * bytes (unsigned). An item without the key attribute sorts after every item that has one.
 */
const compareKeyValues = (left: AttributeValue | undefined, right: AttributeValue | undefined) => {
  if (left === undefined || right === undefined)
    return left === right ? 0 : left === undefined ? 1 : -1
  if (left.N !== undefined && right.N !== undefined) return Number(left.N) - Number(right.N)
  if (left.S !== undefined && right.S !== undefined)
    return compareBytes(utf8.encode(left.S), utf8.encode(right.S))
  if (left.B !== undefined && right.B !== undefined)
    return compareBytes(bytes(left.B), bytes(right.B))
  return 0
}
const remove = (item: Item, path: string, names: Names) => {
  const parts = resolveName(path.trim(), names).split(".")
  const leaf = parts.pop() as string
  let current: Item | undefined = item
  for (const part of parts) current = current?.[part]?.M
  if (current) delete current[leaf]
}
/**
 * The right-hand side of a SET action, as DynamoDB's grammar defines it:
 *   value   ::= operand | operand '+' operand | operand '-' operand
 *   operand ::= path | :placeholder | if_not_exists(path, operand) | list_append(operand, operand)
 */
type SetOperand =
  | { kind: "path"; path: string }
  | { kind: "value"; name: string }
  | { kind: "call"; fn: "if_not_exists" | "list_append"; args: [SetOperand, SetOperand] }
type SetValue = { left: SetOperand; op?: "+" | "-"; right?: SetOperand }
const updateSyntax = (near: string) =>
  new SyntaxError(`Invalid UpdateExpression: Syntax error; token: "${near.trim().split(/\s/)[0]}"`)
const parseSetValue = (source: string): SetValue => {
  let at = 0
  const skip = () => {
    while (/\s/.test(source[at] ?? "")) at++
  }
  const operand = (): SetOperand => {
    skip()
    const token = /^[:#\w][\w#:.[\]]*/.exec(source.slice(at))?.[0]
    if (!token) throw updateSyntax(source.slice(at) || "<EOF>")
    at += token.length
    skip()
    if (source[at] !== "(")
      return token.startsWith(":") ? { kind: "value", name: token } : { kind: "path", path: token }
    if (token !== "if_not_exists" && token !== "list_append")
      throw new SyntaxError(`Invalid UpdateExpression: Invalid function name; function: ${token}`)
    at++
    const args = [operand()]
    skip()
    while (source[at] === ",") {
      at++
      args.push(operand())
      skip()
    }
    if (source[at] !== ")") throw updateSyntax(source.slice(at) || "<EOF>")
    at++
    if (args.length !== 2)
      throw new SyntaxError(
        `Invalid UpdateExpression: Incorrect number of operands for operator or function; operator or function: ${token}, number of operands: ${args.length}`,
      )
    if (token === "if_not_exists" && args[0]?.kind !== "path")
      throw new SyntaxError(
        "Invalid UpdateExpression: Operator or function requires a document path; operator or function: if_not_exists",
      )
    return { kind: "call", fn: token, args: args as [SetOperand, SetOperand] }
  }
  const left = operand()
  skip()
  if (at === source.length) return { left }
  const op = source[at]
  if (op !== "+" && op !== "-") throw updateSyntax(source.slice(at))
  at++
  const right = operand()
  skip()
  if (at !== source.length) throw updateSyntax(source.slice(at))
  return { left, op, right }
}
const MISSING_ATTRIBUTE =
  "The provided expression refers to an attribute that does not exist in the item"
const operandType = (fn: string, value: AttributeValue) =>
  new SyntaxError(
    `Invalid UpdateExpression: Incorrect operand type for operator or function; operator or function: ${fn}, operand type: ${Object.keys(value)[0]}`,
  )
/** Evaluates a SET operand against the item as it was before the update (DynamoDB's rule). */
const evaluateOperand = (
  operand: SetOperand,
  item: Item,
  names: Names,
  values: Values,
): AttributeValue | undefined => {
  if (operand.kind === "value") {
    const value = values[operand.name]
    if (!value)
      throw new SyntaxError(
        `Invalid UpdateExpression: An expression attribute value used in expression is not defined; attribute value: ${operand.name}`,
      )
    return value
  }
  if (operand.kind === "path") return get(item, operand.path, names)
  const [first, second] = operand.args
  if (operand.fn === "if_not_exists")
    return (
      get(item, (first as { path: string }).path, names) ??
      evaluateOperand(second, item, names, values)
    )
  const head = evaluateOperand(first, item, names, values)
  const tail = evaluateOperand(second, item, names, values)
  if (!head || !tail) throw new SyntaxError(MISSING_ATTRIBUTE)
  if (!head.L) throw operandType("list_append", head)
  if (!tail.L) throw operandType("list_append", tail)
  return { L: [...head.L, ...tail.L] }
}
const evaluateSetValue = (value: SetValue, item: Item, names: Names, values: Values) => {
  const left = evaluateOperand(value.left, item, names, values)
  if (!left) throw new SyntaxError(MISSING_ATTRIBUTE)
  if (!value.op || !value.right) return left
  const right = evaluateOperand(value.right, item, names, values)
  if (!right) throw new SyntaxError(MISSING_ATTRIBUTE)
  if (left.N === undefined) throw operandType(value.op, left)
  if (right.N === undefined) throw operandType(value.op, right)
  const sum = value.op === "+" ? Number(left.N) + Number(right.N) : Number(left.N) - Number(right.N)
  return { N: String(sum) }
}
const splitTop = (value: string, separator = ",") => {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "(") depth++
    else if (value[i] === ")") depth--
    else if (value.slice(i, i + separator.length) === separator && depth === 0) {
      out.push(value.slice(start, i).trim())
      start = i + separator.length
      i += separator.length - 1
    }
  }
  out.push(value.slice(start).trim())
  return out.filter(Boolean)
}
const project = (item: Item, expression: unknown, names: Names) =>
  typeof expression !== "string"
    ? clone(item)
    : Object.fromEntries(
        splitTop(expression)
          .map((path) => [resolveName(path, names), get(item, path, names)])
          .filter((entry) => entry[1] !== undefined),
      )

const OPERAND_TYPE = "An operand in the update expression has an incorrect data type"
const SET_TYPES = ["SS", "NS", "BS"] as const
type SetType = (typeof SET_TYPES)[number]
const setType = (value: AttributeValue | undefined): SetType | undefined =>
  SET_TYPES.find((type) => value?.[type] !== undefined)
/** Set members compare by value: numbers numerically ("1" = "1.0"), strings and blobs exactly. */
const setEntryKey = (type: SetType, entry: string) =>
  type === "NS" ? String(Number(entry)) : entry

export class DynamoAPI {
  readonly state: DynamoState
  private readonly sqlite
  private readonly namespace: string
  private readonly now: () => number
  private readonly region: string
  private readonly accountId: string
  constructor(private readonly options: DynamoAPIOptions = {}) {
    this.sqlite = bootSqlite(options.sqlite)
    this.namespace = options.namespace ?? DYNAMODB_NAMESPACE
    this.now = options.now ?? Date.now
    this.region = options.region ?? "us-east-1"
    this.accountId = options.accountId ?? "000000000000"
    this.state = new DynamoState(this.sqlite, this.namespace)
    this.seed()
  }
  private seed() {
    for (const input of this.options.tables ?? []) {
      const table = this.createTable(
        input.name,
        input.keySchema,
        input.attributeDefinitions ?? [],
        input.globalSecondaryIndexes ?? [],
        input.ttlAttribute,
      )
      for (const item of input.items ?? []) this.store(table, item)
    }
  }
  async reset() {
    clearNamespace(this.sqlite, this.namespace)
    this.seed()
  }
  private response(body: unknown, status = 200) {
    const id = this.state.ids.next("req-", 20)
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/x-amz-json-1.0", "x-amzn-requestid": id },
    })
  }
  private error(type: string, message: string, status = 400) {
    return this.response({ __type: `com.amazonaws.dynamodb.v20120810#${type}`, message }, status)
  }
  private createTable(
    name: string,
    keySchema: KeySchemaElement[],
    definitions: DynamoTable["attributeDefinitions"],
    indexes: DynamoTable["globalSecondaryIndexes"],
    ttlAttribute?: string,
  ) {
    const table: DynamoTable = {
      name,
      arn: `arn:aws:dynamodb:${this.region}:${this.accountId}:table/${name}`,
      id: this.state.ids.next("tbl-", 24),
      createdAt: this.now(),
      keySchema: clone(keySchema),
      attributeDefinitions: clone(definitions),
      globalSecondaryIndexes: clone(indexes),
      ...(ttlAttribute ? { ttlAttribute } : {}),
    }
    this.state.tables.insert(name, table)
    return table
  }
  private table(name: unknown) {
    return typeof name === "string" ? this.state.tables.get(name) : undefined
  }
  private key(table: DynamoTable, item: Item) {
    const key = Object.fromEntries(
      table.keySchema.map(({ AttributeName }) => [AttributeName, item[AttributeName]]),
    )
    if (Object.values(key).some((value) => value === undefined))
      throw new TypeError("One of the required keys was not given a value")
    return JSON.stringify(key)
  }
  private keyItem(table: DynamoTable, item: Item) {
    return Object.fromEntries(
      table.keySchema.map(({ AttributeName }) => [
        AttributeName,
        clone(item[AttributeName] as AttributeValue),
      ]),
    )
  }
  /** The table key plus, when reading an index, the index key: what AWS returns as a cursor. */
  private lastKey(table: DynamoTable, item: Item, schema: KeySchemaElement[]) {
    const key = this.keyItem(table, item)
    for (const { AttributeName } of schema)
      key[AttributeName] = clone(item[AttributeName] as AttributeValue)
    return key
  }
  private rows(table: DynamoTable) {
    this.expire(table)
    return this.state.items
      .list({ where: (row) => row.table === table.name })
      .map(({ value }) => value)
      .sort((a, b) => this.compare(table, a.value, b.value))
  }
  private compare(table: DynamoTable, left: Item, right: Item, schema = table.keySchema) {
    for (const key of schema) {
      const order = compareKeyValues(left[key.AttributeName], right[key.AttributeName])
      if (order !== 0) return order < 0 ? -1 : 1
    }
    return 0
  }
  private store(table: DynamoTable, value: Item) {
    const key = this.key(table, value)
    const prior = this.state.items.get(`${table.name}:${key}`)
    this.state.items.insert(`${table.name}:${key}`, {
      table: table.name,
      key,
      value: clone(value),
      updatedAt: this.now(),
    })
    this.emit(table, prior ? "MODIFY" : "INSERT", prior?.value, value)
    return prior?.value
  }
  private delete(table: DynamoTable, keyValue: Item) {
    const key = this.key(table, keyValue)
    const id = `${table.name}:${key}`
    const prior = this.state.items.get(id)
    if (prior) {
      this.state.items.delete(id)
      this.emit(table, "REMOVE", prior.value)
    }
    return prior?.value
  }
  emit(
    table: DynamoTable,
    eventName: "INSERT" | "MODIFY" | "REMOVE",
    oldImage?: Item,
    newImage?: Item,
  ) {
    const image = newImage ?? oldImage ?? {}
    const record = {
      id: this.state.ids.next("str-", 24),
      table: table.name,
      eventName,
      keys: this.keyItem(table, image),
      ...(oldImage ? { oldImage: clone(oldImage) } : {}),
      ...(newImage ? { newImage: clone(newImage) } : {}),
      createdAt: this.now(),
    }
    this.state.streams.insert(record.id, record)
    this.options.onStreamRecord?.(record)
    return record
  }
  private expire(table: DynamoTable) {
    if (!table.ttlAttribute) return
    for (const row of this.state.items.list({ where: (value) => value.table === table.name })) {
      const expires = Number(row.value.value[table.ttlAttribute]?.N)
      if (Number.isFinite(expires) && expires <= Math.floor(this.now() / 1000))
        this.delete(table, row.value.value)
    }
  }
  private names(input: Input) {
    return (input.ExpressionAttributeNames ?? {}) as Names
  }
  private values(input: Input) {
    return (input.ExpressionAttributeValues ?? {}) as Values
  }
  private applyUpdate(item: Item, expression: unknown, names: Names, values: Values) {
    if (typeof expression !== "string") throw new SyntaxError("UpdateExpression is required")
    // Every operand reads the item as it was before the update, not after earlier actions.
    const original = clone(item)
    const clauses = [...expression.matchAll(/(?:^|\s)(SET|ADD|REMOVE|DELETE)\s+/gi)]
    for (let index = 0; index < clauses.length; index++) {
      const clause = clauses[index] as RegExpMatchArray
      const kind = (clause[1] as string).toUpperCase()
      const start = (clause.index as number) + clause[0].length
      const end =
        index + 1 < clauses.length ? (clauses[index + 1]?.index as number) : expression.length
      const body = expression.slice(start, end).trim()
      if (kind === "SET") {
        const assignments = splitTop(body).map((assignment) => {
          const split = assignment.indexOf("=")
          if (split < 0) throw updateSyntax(assignment)
          const value = parseSetValue(assignment.slice(split + 1))
          return { path: assignment.slice(0, split).trim(), value }
        })
        for (const { path, value } of assignments)
          set(item, path, evaluateSetValue(value, original, names, values), names)
      } else if (kind === "ADD")
        for (const addition of splitTop(body)) {
          const [path, token] = addition.split(/\s+/)
          const value = values[token as string]
          const prior = get(item, path as string, names)
          if (value?.N !== undefined) {
            if (prior && prior.N === undefined) throw new SyntaxError(OPERAND_TYPE)
            set(item, path as string, { N: String(Number(prior?.N ?? 0) + Number(value.N)) }, names)
            continue
          }
          const type = setType(value)
          if (!type) throw new SyntaxError(`${OPERAND_TYPE}; ADD supports numbers and sets`)
          if (prior && prior[type] === undefined) throw new SyntaxError(OPERAND_TYPE)
          const merged = [...(prior?.[type] ?? [])]
          const seen = new Set(merged.map((entry) => setEntryKey(type, entry)))
          for (const entry of value?.[type] ?? [])
            if (!seen.has(setEntryKey(type, entry))) {
              seen.add(setEntryKey(type, entry))
              merged.push(entry)
            }
          set(item, path as string, { [type]: merged }, names)
        }
      else if (kind === "REMOVE") for (const path of splitTop(body)) remove(item, path, names)
      else if (kind === "DELETE")
        for (const deletion of splitTop(body)) {
          const [path, token] = deletion.split(/\s+/)
          const value = values[token as string]
          const prior = get(item, path as string, names)
          const type = setType(value)
          if (!type) throw new SyntaxError(`${OPERAND_TYPE}; DELETE supports only sets`)
          if (!prior) continue
          if (prior[type] === undefined) throw new SyntaxError(OPERAND_TYPE)
          const dropped = new Set(value?.[type]?.map((entry) => setEntryKey(type, entry)))
          const kept = prior[type]?.filter((entry) => !dropped.has(setEntryKey(type, entry))) ?? []
          // DynamoDB has no empty sets: deleting the last element removes the attribute.
          if (kept.length > 0) set(item, path as string, { [type]: kept }, names)
          else remove(item, path as string, names)
        }
    }
  }
  private readPage(table: DynamoTable, input: Input, query: boolean) {
    const names = this.names(input)
    const values = this.values(input)
    const index =
      typeof input.IndexName === "string"
        ? table.globalSecondaryIndexes.find((value) => value.IndexName === input.IndexName)
        : undefined
    const schema = index?.KeySchema ?? table.keySchema
    // A GSI is sparse: an item missing any of the index key attributes is not in the index.
    let rows = this.rows(table)
      .filter((row) => schema.every(({ AttributeName }) => row.value[AttributeName] !== undefined))
      .sort((a, b) => this.compare(table, a.value, b.value, schema))
    if (query && input.ScanIndexForward === false) rows.reverse()
    if (input.ExclusiveStartKey && typeof input.ExclusiveStartKey === "object") {
      const start = this.key(table, input.ExclusiveStartKey as Item)
      const found = rows.findIndex((row) => row.key === start)
      if (found >= 0) rows = rows.slice(found + 1)
    }
    const keyCondition = compileCondition(query ? input.KeyConditionExpression : "", names, values)
    const filter = compileCondition(input.FilterExpression, names, values)
    const matching = rows.filter((row) => keyCondition(row.value))
    const limit = input.Limit === undefined ? matching.length : Math.max(0, Number(input.Limit))
    const evaluated = matching.slice(0, limit)
    const filtered = evaluated.filter((row) => filter(row.value))
    const last = matching.length > evaluated.length ? evaluated.at(-1) : undefined
    return {
      Items: filtered.map((row) => project(row.value, input.ProjectionExpression, names)),
      Count: filtered.length,
      ScannedCount: evaluated.length,
      ...(last ? { LastEvaluatedKey: this.lastKey(table, last.value, schema) } : {}),
    }
  }
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST")
      return this.error("ValidationException", "Only POST is supported")
    const operation = (request.headers.get("x-amz-target") ?? "").split(".").at(-1) ?? ""
    const input = (await request.json().catch(() => ({}))) as Input
    try {
      if (operation === "CreateTable") {
        const name = String(input.TableName ?? "")
        if (!name) return this.error("ValidationException", "TableName is required")
        if (this.table(name)) return this.error("ResourceInUseException", "Table already exists")
        const table = this.createTable(
          name,
          (input.KeySchema as KeySchemaElement[]) ?? [],
          (input.AttributeDefinitions as DynamoTable["attributeDefinitions"]) ?? [],
          (input.GlobalSecondaryIndexes as DynamoTable["globalSecondaryIndexes"]) ?? [],
        )
        return this.response({ TableDescription: this.describe(table) })
      }
      if (operation === "DescribeTable") {
        const table = this.table(input.TableName)
        return table
          ? this.response({ Table: this.describe(table) })
          : this.error("ResourceNotFoundException", "Requested resource not found")
      }
      const table = this.table(input.TableName)
      if (
        !table &&
        !["BatchGetItem", "BatchWriteItem", "TransactGetItems", "TransactWriteItems"].includes(
          operation,
        )
      )
        return this.error("ResourceNotFoundException", "Requested resource not found")
      if (operation === "GetItem") {
        this.expire(table as DynamoTable)
        const row = this.state.items.get(
          `${table?.name}:${this.key(table as DynamoTable, input.Key as Item)}`,
        )
        return this.response(
          row ? { Item: project(row.value, input.ProjectionExpression, this.names(input)) } : {},
        )
      }
      if (operation === "PutItem") {
        const item = input.Item as Item
        const key = this.key(table as DynamoTable, item)
        const prior = this.state.items.get(`${table?.name}:${key}`)?.value
        if (!condition(input.ConditionExpression, prior, this.names(input), this.values(input)))
          return this.error("ConditionalCheckFailedException", "The conditional request failed")
        this.store(table as DynamoTable, item)
        return this.response(input.ReturnValues === "ALL_OLD" && prior ? { Attributes: prior } : {})
      }
      if (operation === "DeleteItem") {
        const key = input.Key as Item
        const prior = this.state.items.get(
          `${table?.name}:${this.key(table as DynamoTable, key)}`,
        )?.value
        if (!condition(input.ConditionExpression, prior, this.names(input), this.values(input)))
          return this.error("ConditionalCheckFailedException", "The conditional request failed")
        const deleted = this.delete(table as DynamoTable, key)
        return this.response(
          input.ReturnValues === "ALL_OLD" && deleted ? { Attributes: deleted } : {},
        )
      }
      if (operation === "UpdateItem") {
        const key = input.Key as Item
        const id = `${table?.name}:${this.key(table as DynamoTable, key)}`
        const prior = this.state.items.get(id)?.value
        if (!condition(input.ConditionExpression, prior, this.names(input), this.values(input)))
          return this.error("ConditionalCheckFailedException", "The conditional request failed")
        const next = clone(prior ?? key)
        this.applyUpdate(next, input.UpdateExpression, this.names(input), this.values(input))
        this.store(table as DynamoTable, next)
        return this.response(
          input.ReturnValues === "ALL_NEW"
            ? { Attributes: next }
            : input.ReturnValues === "ALL_OLD" && prior
              ? { Attributes: prior }
              : {},
        )
      }
      if (operation === "Query")
        return this.response(this.readPage(table as DynamoTable, input, true))
      if (operation === "Scan")
        return this.response(this.readPage(table as DynamoTable, input, false))
      if (operation === "BatchGetItem") return this.batchGet(input)
      if (operation === "BatchWriteItem") return this.batchWrite(input)
      if (operation === "TransactGetItems") return this.transactGet(input)
      if (operation === "TransactWriteItems") return this.transactWrite(input)
      return this.error("ValidationException", `Unknown operation ${operation}`)
    } catch (error) {
      return this.error(
        "ValidationException",
        error instanceof Error ? error.message : "Invalid request",
      )
    }
  }
  private describe(table: DynamoTable) {
    return {
      TableName: table.name,
      TableArn: table.arn,
      TableId: table.id,
      TableStatus: "ACTIVE",
      CreationDateTime: table.createdAt / 1000,
      ItemCount: this.rows(table).length,
      TableSizeBytes: 0,
      KeySchema: table.keySchema,
      AttributeDefinitions: table.attributeDefinitions,
      GlobalSecondaryIndexes: table.globalSecondaryIndexes.map((index) => ({
        ...index,
        IndexArn: `${table.arn}/index/${index.IndexName}`,
        IndexStatus: "ACTIVE",
        ItemCount: this.rows(table).filter((row) =>
          index.KeySchema.every(({ AttributeName }) => row.value[AttributeName] !== undefined),
        ).length,
        IndexSizeBytes: 0,
      })),
    }
  }
  private batchGet(input: Input) {
    const responses: Record<string, Item[]> = {}
    for (const [name, request] of Object.entries(
      (input.RequestItems as Record<string, Input>) ?? {},
    )) {
      const table = this.table(name)
      if (!table) return this.error("ResourceNotFoundException", "Requested resource not found")
      responses[name] = ((request.Keys as Item[]) ?? []).flatMap((key) => {
        const row = this.state.items.get(`${name}:${this.key(table, key)}`)
        return row ? [project(row.value, request.ProjectionExpression, this.names(request))] : []
      })
    }
    return this.response({ Responses: responses, UnprocessedKeys: {} })
  }
  private batchWrite(input: Input) {
    for (const [name, requests] of Object.entries(
      (input.RequestItems as Record<string, Input[]>) ?? {},
    )) {
      const table = this.table(name)
      if (!table) return this.error("ResourceNotFoundException", "Requested resource not found")
      for (const request of requests) {
        if (request.PutRequest) this.store(table, (request.PutRequest as Input).Item as Item)
        if (request.DeleteRequest) this.delete(table, (request.DeleteRequest as Input).Key as Item)
      }
    }
    return this.response({ UnprocessedItems: {} })
  }
  private transactGet(input: Input) {
    const responses: { Item?: Item }[] = []
    for (const request of (input.TransactItems as Input[]) ?? []) {
      const getInput = request.Get as Input
      const table = this.table(getInput.TableName)
      if (!table) return this.error("ResourceNotFoundException", "Requested resource not found")
      const row = this.state.items.get(`${table.name}:${this.key(table, getInput.Key as Item)}`)
      responses.push(
        row
          ? { Item: project(row.value, getInput.ProjectionExpression, this.names(getInput)) }
          : {},
      )
    }
    return this.response({ Responses: responses })
  }
  private transactWrite(input: Input) {
    const actions = (input.TransactItems as Input[]) ?? []
    const targeted = new Set<string>()
    // One reason per action, in request order: "None" when its condition held.
    const reasons: { Code: string; Message?: string; Item?: Item }[] = []
    for (const action of actions) {
      const request = (action.Put ??
        action.Update ??
        action.Delete ??
        action.ConditionCheck) as Input
      const table = this.table(request.TableName)
      if (!table) return this.error("ResourceNotFoundException", "Requested resource not found")
      const keyItem = (request.Item ?? request.Key) as Item
      const id = `${table.name}:${this.key(table, keyItem)}`
      if (targeted.has(id))
        return this.error(
          "ValidationException",
          "Transaction request cannot include multiple operations on one item",
        )
      targeted.add(id)
      const prior = this.state.items.get(id)?.value
      if (condition(request.ConditionExpression, prior, this.names(request), this.values(request)))
        reasons.push({ Code: "None" })
      else
        reasons.push({
          Code: "ConditionalCheckFailed",
          Message: "The conditional request failed",
          ...(request.ReturnValuesOnConditionCheckFailure === "ALL_OLD" && prior
            ? { Item: clone(prior) }
            : {}),
        })
    }
    if (reasons.some((reason) => reason.Code !== "None"))
      return this.response(
        {
          __type: "com.amazonaws.dynamodb.v20120810#TransactionCanceledException",
          message: `Transaction cancelled, please refer cancellation reasons for specific reasons [${reasons.map((reason) => reason.Code).join(", ")}]`,
          CancellationReasons: reasons,
        },
        400,
      )
    for (const action of actions) {
      if (action.Put) {
        const request = action.Put as Input
        this.store(this.table(request.TableName) as DynamoTable, request.Item as Item)
      } else if (action.Delete) {
        const request = action.Delete as Input
        this.delete(this.table(request.TableName) as DynamoTable, request.Key as Item)
      } else if (action.Update) {
        const request = action.Update as Input
        const table = this.table(request.TableName) as DynamoTable
        const id = `${table.name}:${this.key(table, request.Key as Item)}`
        const next = clone(this.state.items.get(id)?.value ?? (request.Key as Item))
        this.applyUpdate(next, request.UpdateExpression, this.names(request), this.values(request))
        this.store(table, next)
      }
    }
    return this.response({})
  }
}
