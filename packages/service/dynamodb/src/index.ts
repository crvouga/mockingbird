import { type APIOptions, bootSqlite, sigV4AccessKeyId } from "@crvouga/mockingbird-service"
import { clearNamespace } from "@crvouga/mockingbird-sqlite"
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
const equal = (left: AttributeValue | undefined, right: AttributeValue | undefined) =>
  JSON.stringify(left) === JSON.stringify(right)
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
const remove = (item: Item, path: string, names: Names) => {
  const parts = resolveName(path.trim(), names).split(".")
  const leaf = parts.pop() as string
  let current: Item | undefined = item
  for (const part of parts) current = current?.[part]?.M
  if (current) delete current[leaf]
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
const condition = (
  expression: unknown,
  item: Item | undefined,
  names: Names,
  values: Values,
): boolean => {
  if (typeof expression !== "string" || !expression.trim()) return true
  const source = expression.trim().replace(/^\((.*)\)$/, "$1")
  const ors = source.split(/\s+OR\s+/i)
  if (ors.length > 1) return ors.some((part) => condition(part, item, names, values))
  const ands = source.split(/\s+AND\s+/i)
  if (ands.length > 1 && !/\s+BETWEEN\s+/i.test(source))
    return ands.every((part) => condition(part, item, names, values))
  const exists = /^attribute_(not_)?exists\s*\(([^)]+)\)$/i.exec(source)
  if (exists)
    return exists[1]
      ? get(item ?? {}, exists[2] as string, names) === undefined
      : get(item ?? {}, exists[2] as string, names) !== undefined
  const begins = /^begins_with\s*\(([^,]+),\s*(:\w+)\)$/i.exec(source)
  if (begins)
    return String(scalar(get(item ?? {}, begins[1] as string, names)) ?? "").startsWith(
      String(scalar(values[begins[2] as string]) ?? ""),
    )
  const between = /^(.+?)\s+BETWEEN\s+(:\w+)\s+AND\s+(:\w+)$/i.exec(source)
  if (between) {
    const actual = scalar(get(item ?? {}, between[1] as string, names))
    const low = scalar(values[between[2] as string])
    const high = scalar(values[between[3] as string])
    return (
      actual !== undefined &&
      low !== undefined &&
      high !== undefined &&
      actual >= low &&
      actual <= high
    )
  }
  const comparison = /^(.+?)\s*(=|<>|<=|>=|<|>)\s*(:\w+)$/.exec(source)
  if (comparison) {
    const leftValue = get(item ?? {}, comparison[1] as string, names)
    const rightValue = values[comparison[3] as string]
    const left = scalar(leftValue)
    const right = scalar(rightValue)
    switch (comparison[2]) {
      case "=":
        return equal(leftValue, rightValue)
      case "<>":
        return !equal(leftValue, rightValue)
      case "<":
        return left !== undefined && right !== undefined && left < right
      case "<=":
        return left !== undefined && right !== undefined && left <= right
      case ">":
        return left !== undefined && right !== undefined && left > right
      case ">=":
        return left !== undefined && right !== undefined && left >= right
    }
  }
  throw new SyntaxError(`Unsupported expression: ${expression}`)
}
const project = (item: Item, expression: unknown, names: Names) =>
  typeof expression !== "string"
    ? clone(item)
    : Object.fromEntries(
        splitTop(expression)
          .map((path) => [resolveName(path, names), get(item, path, names)])
          .filter((entry) => entry[1] !== undefined),
      )

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
  private rows(table: DynamoTable) {
    this.expire(table)
    return this.state.items
      .list({ where: (row) => row.table === table.name })
      .map(({ value }) => value)
      .sort((a, b) => this.compare(table, a.value, b.value))
  }
  private compare(table: DynamoTable, left: Item, right: Item, schema = table.keySchema) {
    for (const key of schema) {
      const a = scalar(left[key.AttributeName])
      const b = scalar(right[key.AttributeName])
      if (a === b) continue
      return a !== undefined && b !== undefined && a < b ? -1 : 1
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
    const clauses = [...expression.matchAll(/(?:^|\s)(SET|ADD|REMOVE|DELETE)\s+/gi)]
    for (let index = 0; index < clauses.length; index++) {
      const clause = clauses[index] as RegExpMatchArray
      const kind = (clause[1] as string).toUpperCase()
      const start = (clause.index as number) + clause[0].length
      const end =
        index + 1 < clauses.length ? (clauses[index + 1]?.index as number) : expression.length
      const body = expression.slice(start, end).trim()
      if (kind === "SET")
        for (const assignment of splitTop(body)) {
          const [path, raw = ""] = assignment.split(/\s*=\s*/, 2)
          const fallback = /^if_not_exists\(([^,]+),\s*(:\w+)\)(?:\s*\+\s*(:\w+))?$/.exec(raw)
          const addition = /^(.+?)\s*\+\s*(:\w+)$/.exec(raw)
          if (fallback) {
            const base = get(item, fallback[1] as string, names) ?? values[fallback[2] as string]
            const plus = fallback[3]
              ? Number(base?.N ?? "0") + Number(values[fallback[3]]?.N ?? "0")
              : undefined
            set(
              item,
              path as string,
              plus === undefined ? (base as AttributeValue) : { N: String(plus) },
              names,
            )
          } else if (addition) {
            const base = Number(get(item, addition[1] as string, names)?.N ?? "0")
            set(
              item,
              path as string,
              { N: String(base + Number(values[addition[2] as string]?.N ?? "0")) },
              names,
            )
          } else {
            const value = values[raw.trim()]
            if (!value) throw new SyntaxError(`Unknown value ${raw}`)
            set(item, path as string, value, names)
          }
        }
      else if (kind === "ADD")
        for (const addition of splitTop(body)) {
          const [path, token] = addition.split(/\s+/)
          const value = values[token as string]
          const prior = get(item, path as string, names)
          if (value?.N !== undefined)
            set(item, path as string, { N: String(Number(prior?.N ?? 0) + Number(value.N)) }, names)
          else if (value?.SS)
            set(
              item,
              path as string,
              { SS: [...new Set([...(prior?.SS ?? []), ...value.SS])] },
              names,
            )
          else throw new SyntaxError("ADD supports numbers and string sets")
        }
      else if (kind === "REMOVE") for (const path of splitTop(body)) remove(item, path, names)
      else if (kind === "DELETE")
        for (const deletion of splitTop(body)) {
          const [path, token] = deletion.split(/\s+/)
          const value = values[token as string]
          const prior = get(item, path as string, names)
          if (value?.SS && prior?.SS)
            set(
              item,
              path as string,
              { SS: prior.SS.filter((entry) => !value.SS?.includes(entry)) },
              names,
            )
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
    let rows = this.rows(table).sort((a, b) => this.compare(table, a.value, b.value, schema))
    if (query && input.ScanIndexForward === false) rows.reverse()
    if (input.ExclusiveStartKey && typeof input.ExclusiveStartKey === "object") {
      const start = this.key(table, input.ExclusiveStartKey as Item)
      const found = rows.findIndex((row) => row.key === start)
      if (found >= 0) rows = rows.slice(found + 1)
    }
    const matching = rows.filter(
      (row) => !query || condition(input.KeyConditionExpression, row.value, names, values),
    )
    const limit = input.Limit === undefined ? matching.length : Math.max(0, Number(input.Limit))
    const evaluated = matching.slice(0, limit)
    const filtered = evaluated.filter((row) =>
      condition(input.FilterExpression, row.value, names, values),
    )
    const last = matching.length > evaluated.length ? evaluated.at(-1) : undefined
    return {
      Items: filtered.map((row) => project(row.value, input.ProjectionExpression, names)),
      Count: filtered.length,
      ScannedCount: evaluated.length,
      ...(last ? { LastEvaluatedKey: this.keyItem(table, last.value) } : {}),
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
        ItemCount: this.rows(table).length,
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
    for (const action of actions) {
      const request = (action.Put ??
        action.Update ??
        action.Delete ??
        action.ConditionCheck) as Input
      const table = this.table(request.TableName)
      if (!table) return this.error("ResourceNotFoundException", "Requested resource not found")
      const keyItem = (request.Item ?? request.Key) as Item
      const prior = this.state.items.get(`${table.name}:${this.key(table, keyItem)}`)?.value
      if (!condition(request.ConditionExpression, prior, this.names(request), this.values(request)))
        return this.error(
          "TransactionCanceledException",
          "Transaction cancelled, please refer cancellation reasons for specific reasons [ConditionalCheckFailed]",
        )
    }
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
