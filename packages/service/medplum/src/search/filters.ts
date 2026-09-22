/**
 * The server's search predicates (packages/server/src/fhir/search.ts `buildSearchFilterExpression`
 * and friends), compiled into JavaScript predicates over a resource's indexed columns.
 *
 * Compilation raises exactly the errors the server raises while building its SQL, before any
 * row is read; evaluation reproduces the SQL, including Postgres's three-valued logic (a
 * comparison with NULL is unknown, and `NOT unknown` is still unknown).
 */
import {
  badRequest,
  deriveIdentifierSearchParameter,
  FhirFilterComparison,
  FhirFilterConnective,
  type FhirFilterExpression,
  FhirFilterNegation,
  type Filter,
  getSearchParameter,
  invalidSearchOperator,
  isUUID,
  OperationOutcomeError,
  Operator,
  parseFilterParameter,
  parseParameter,
  resolveId,
  SearchParameterType,
  splitN,
  splitSearchOnComma,
} from "@medplum/core"
import type { Resource, SearchParameter } from "@medplum/fhirtypes"
import {
  type AddressRow,
  addressRows,
  type ColumnImpl,
  type ColumnValue,
  columnValue,
  DELIM,
  getSearchImpl,
  type HumanNameRow,
  humanNameRows,
  type LookupImpl,
  NULL_SYSTEM,
  referenceRows,
  type TokenColumns,
  type TokenImpl,
  tokenColumns,
} from "./columns.js"

/** SQL boolean: true, false, or NULL (unknown). */
export type Tri = boolean | null

const not = (v: Tri): Tri => (v === null ? null : !v)
const and = (values: Tri[]): Tri => {
  let unknown = false
  for (const v of values) {
    if (v === false) return false
    if (v === null) unknown = true
  }
  return unknown ? null : true
}
const or = (values: Tri[]): Tri => {
  let unknown = false
  for (const v of values) {
    if (v === true) return true
    if (v === null) unknown = true
  }
  return unknown ? null : false
}

/** A stored row as the search engine sees it: the resource plus lazily built index columns. */
export type IndexedRow = {
  resourceType: string
  id: string
  deleted: boolean
  lastUpdated: string
  projectId: string
  /** The stored content; for a deleted row, only `{ resourceType }` (what the server indexes). */
  resource: Resource
  compartments: string[]
  cache: Map<string, unknown>
}

/** Resolves rows of another type for chained search (joins through `<Type>_References`). */
export type RowSource = {
  get(resourceType: string, id: string): IndexedRow | undefined
  all(resourceType: string): IndexedRow[]
}

export type Predicate = (row: IndexedRow) => Tri

const cached = <T>(row: IndexedRow, key: string, build: () => T): T => {
  if (row.cache.has(key)) return row.cache.get(key) as T
  const value = build()
  row.cache.set(key, value)
  return value
}

const columnOf = (row: IndexedRow, impl: ColumnImpl, param: SearchParameter) =>
  cached(row, `c:${param.code}`, () => columnValue(row.resource, impl, param))
const tokensOf = (row: IndexedRow, impl: TokenImpl): TokenColumns =>
  cached(row, `t:${impl.code}`, () => tokenColumns(row.resource, impl))
const namesOf = (row: IndexedRow): HumanNameRow[] =>
  cached(row, "names", () => humanNameRows(row.resource))
const addressesOf = (row: IndexedRow): AddressRow[] =>
  cached(row, "addresses", () => addressRows(row.resource))
export const referencesOf = (row: IndexedRow): { code: string; targetId: string }[] =>
  cached(row, "refs", () => referenceRows(row.resource))

// ------------------------------------------------------------------ value comparisons

type ColumnKind = "text" | "date" | "timestamptz" | "number" | "boolean" | "uuid"

const kindOf = (impl: { type: SearchParameterType }): ColumnKind => {
  switch (impl.type) {
    case SearchParameterType.UUID:
      return "uuid"
    case SearchParameterType.BOOLEAN:
      return "boolean"
    case SearchParameterType.DATE:
      return "date"
    case SearchParameterType.DATETIME:
      return "timestamptz"
    case SearchParameterType.NUMBER:
    case SearchParameterType.QUANTITY:
      return "number"
    default:
      return "text"
  }
}

/** A parameter value as Postgres would coerce it to the column's type. */
const coerce = (kind: ColumnKind, value: string): string | number | boolean => {
  switch (kind) {
    case "date":
      return value.slice(0, 10)
    case "timestamptz":
      return toInstant(value)
    case "number": {
      const n = Number(value)
      if (value.trim() === "" || Number.isNaN(n)) {
        throw new OperationOutcomeError(
          badRequest(`invalid input syntax for type double precision: "${value}"`),
        )
      }
      return n
    }
    case "boolean":
      return value === "true"
    default:
      return value
  }
}

/** Epoch ms for a timestamp literal, read in UTC when it has no offset (the oracle runs in UTC). */
export const toInstant = (value: string): number => {
  let text = value.replace(" ", "T")
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) text += "T00:00:00Z"
  else if (!/(Z|[+-]\d{2}(:?\d{2})?)$/.test(text.slice(10))) text += "Z"
  else if (/[+-]\d{2}$/.test(text)) text += ":00"
  const ms = Date.parse(text)
  if (Number.isNaN(ms)) throw new OperationOutcomeError(badRequest(`Invalid date value: ${value}`))
  return ms
}

const stored = (kind: ColumnKind, value: ColumnValue): string | number | boolean | null => {
  if (value === undefined || value === null) return null
  if (kind === "timestamptz" && typeof value === "string") return Date.parse(value)
  return value
}

const compare = (a: string | number | boolean, b: string | number | boolean): number => {
  if (typeof a === "number" && typeof b === "number") return a - b
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b)
  const x = String(a)
  const y = String(b)
  return x < y ? -1 : x > y ? 1 : 0
}

type SqlOp = "=" | "!=" | "<" | "<=" | ">" | ">="

const sqlCompare = (
  left: string | number | boolean | null,
  op: SqlOp,
  right: string | number | boolean,
): Tri => {
  if (left === null) return null
  const c = compare(left, right)
  switch (op) {
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
    case ">=":
      return c >= 0
  }
}

const fhirOperatorToSql = (operator: Operator): SqlOp => {
  switch (operator) {
    case Operator.EQUALS:
    case Operator.EXACT:
      return "="
    case Operator.NOT:
    case Operator.NOT_EQUALS:
      return "!="
    case Operator.GREATER_THAN:
    case Operator.STARTS_AFTER:
      return ">"
    case Operator.GREATER_THAN_OR_EQUALS:
      return ">="
    case Operator.LESS_THAN:
    case Operator.ENDS_BEFORE:
      return "<"
    case Operator.LESS_THAN_OR_EQUALS:
      return "<="
    default:
      throw new Error(`Unknown FHIR operator: ${operator}`)
  }
}

const isNegated = (operator: Operator) =>
  operator === Operator.NOT_EQUALS || operator === Operator.NOT

/** `buildCondition`: array overlap, IN, or (IS DISTINCT FROM | =) on one column. */
const conditionOn = (
  get: (row: IndexedRow) => ColumnValue | ColumnValue[],
  kind: ColumnKind,
  array: boolean,
  filter: Filter,
  values: string[],
): Predicate => {
  const negated = isNegated(filter.operator)
  const wanted = values.map((v) => coerce(kind, v))
  if (array) {
    return (row) => {
      const column = get(row)
      const overlaps: Tri =
        column === null || column === undefined
          ? false
          : (column as ColumnValue[]).some((c) => {
              const s = stored(kind, c)
              return s !== null && wanted.some((w) => compare(s, w) === 0)
            })
      return negated ? not(overlaps) : overlaps
    }
  }
  if (values.length > 1) {
    return (row) => {
      const s = stored(kind, get(row) as ColumnValue)
      const inList: Tri = s === null ? null : wanted.some((w) => compare(s, w) === 0)
      return negated ? not(inList) : inList
    }
  }
  const [only] = wanted
  return (row) => {
    const s = stored(kind, get(row) as ColumnValue)
    if (negated) return s === null ? true : compare(s, only as string) !== 0 // IS DISTINCT FROM
    return s === null ? null : compare(s, only as string) === 0
  }
}

// ------------------------------------------------------------------ compilation

export type CompileContext = {
  /** Resolve other rows for chained search. */
  source: RowSource
  /** Validate a chained link's target type the way `validateSearchResourceType` does. */
  validateType: (resourceType: string) => void
}

export const compileFilter = (
  context: CompileContext,
  resourceType: string,
  filter: Filter,
): Predicate => {
  if (typeof filter.value !== "string") {
    throw new OperationOutcomeError(badRequest("Search filter value must be a string"))
  }
  if (filter.value.includes("\0")) {
    throw new OperationOutcomeError(badRequest("Search filter value cannot contain null bytes"))
  }
  if (filter.code.startsWith("_has:") || filter.code.includes(".")) {
    return compileChainedSearch(context, resourceType, parseChainedParameter(resourceType, filter))
  }
  const special = compileSpecial(context, resourceType, filter)
  if (special) return special

  let param = getSearchParameter(resourceType, filter.code)
  if (!param?.code)
    throw new OperationOutcomeError(badRequest(`Unknown search parameter: ${filter.code}`))
  if (filter.operator === Operator.IDENTIFIER) {
    param = deriveIdentifierSearchParameter(param)
    filter = { code: param.code, operator: Operator.EQUALS, value: filter.value }
  }
  const impl = getSearchImpl(resourceType, param)
  switch (impl.strategy) {
    case "token-column":
      return compileTokenColumns(impl, param, filter)
    case "lookup-table":
      return compileLookup(impl, filter)
    default:
      return compileColumn(impl, param, filter)
  }
}

const compileColumn = (impl: ColumnImpl, param: SearchParameter, filter: Filter): Predicate => {
  const get = (row: IndexedRow) => columnOf(row, impl, param)
  const isNull = (row: IndexedRow) => {
    const value = get(row)
    return value === null || value === undefined
  }
  if (filter.operator === Operator.MISSING) {
    return filter.value === "true" ? (row) => isNull(row) : (row) => !isNull(row)
  }
  if (filter.operator === Operator.PRESENT) {
    return filter.value === "true" ? (row) => !isNull(row) : (row) => isNull(row)
  }
  const kind = kindOf(impl)
  switch (param.type) {
    case "string":
      return compileString(
        get,
        Boolean(impl.array),
        filter.operator,
        splitSearchOnComma(filter.value),
      )
    case "token":
    case "uri":
      if (impl.type === SearchParameterType.BOOLEAN) return compileBoolean(get, filter)
      return conditionOn(get, kind, Boolean(impl.array), filter, splitSearchOnComma(filter.value))
    case "reference":
      return compileReference(impl, get, filter, splitSearchOnComma(filter.value))
    case "date":
      return compileDate(get, kind, Boolean(impl.array), filter)
    case "quantity":
      return compileQuantity(get, filter)
    default: {
      const op = fhirOperatorToSql(filter.operator)
      const values = splitSearchOnComma(filter.value).map((v) => coerce(kind, v))
      const one = (value: ColumnValue) =>
        or(values.map((v) => sqlCompare(stored(kind, value), op, v)))
      return (row) => {
        const column = get(row)
        if (impl.array) {
          if (column === null || column === undefined) return false
          return (column as ColumnValue[]).some((c) => one(c) === true)
        }
        return one(column as ColumnValue)
      }
    }
  }
}

const lower = (value: string) => value.toLowerCase()

const compileString = (
  get: (row: IndexedRow) => ColumnValue | ColumnValue[],
  array: boolean,
  operator: Operator,
  values: string[],
): Predicate => {
  const tests = values.map((v) => {
    if (operator === Operator.EXACT) return (c: string) => c === v
    if (operator === Operator.CONTAINS) {
      const needle = lower(v)
      return (c: string) => lower(c).includes(needle)
    }
    if (operator === Operator.EQUALS || operator === Operator.STARTS_WITH) {
      const needle = lower(v)
      return (c: string) => lower(c).startsWith(needle)
    }
    throw new OperationOutcomeError(badRequest(`Unsupported string search operator: ${operator}`))
  })
  const one = (c: ColumnValue): Tri => (typeof c === "string" ? tests.some((t) => t(c)) : null)
  return (row) => {
    const column = get(row)
    if (array) {
      if (column === null || column === undefined) return false
      return (column as ColumnValue[]).some((c) => one(c) === true)
    }
    return one(column as ColumnValue)
  }
}

const compileBoolean = (
  get: (row: IndexedRow) => ColumnValue | ColumnValue[],
  filter: Filter,
): Predicate => {
  if (filter.operator === Operator.IN || filter.operator === Operator.NOT_IN) {
    throw new OperationOutcomeError(invalidSearchOperator(filter.operator, filter.code))
  }
  if (filter.value !== "true" && filter.value !== "false") {
    throw new OperationOutcomeError(badRequest("Boolean search value must be 'true' or 'false'"))
  }
  const wanted = filter.value === "true"
  if (isNegated(filter.operator)) {
    return (row) => (get(row) as ColumnValue) !== wanted
  }
  return (row) => {
    const value = get(row) as ColumnValue
    return value === null || value === undefined ? null : value === wanted
  }
}

const compileReference = (
  impl: ColumnImpl,
  get: (row: IndexedRow) => ColumnValue | ColumnValue[],
  filter: Filter,
  rawValues: string[],
): Predicate => {
  if (filter.operator === Operator.IN || filter.operator === Operator.NOT_IN) {
    throw new OperationOutcomeError(invalidSearchOperator(filter.operator, filter.code))
  }
  const values = rawValues.map((v) => {
    if (v.includes("/")) return v
    if (impl.singleTargetType && isUUID(v)) return `${impl.singleTargetType}/${v}`
    if (impl.columnName === "subject" || impl.columnName === "patient") return `Patient/${v}`
    return v
  })
  const negated = isNegated(filter.operator)
  if (impl.array) {
    return (row) => {
      const column = get(row) as ColumnValue[] | null
      const overlaps =
        column === null || column === undefined
          ? false
          : column.some((c) => values.includes(c as string))
      return negated ? !overlaps : overlaps
    }
  }
  return (row) => {
    const value = get(row) as ColumnValue
    const match: Tri =
      value === null || value === undefined ? null : values.includes(value as string)
    return negated ? not(match) : match
  }
}

/**
 * From the dateTime regex on https://hl7.org/fhir/R4/datatypes.html#primitive, as the server
 * checks it (year, month and day required; seconds optional; space allowed for `T`).
 */
const SUPPORTED_DATE =
  /^(\d(\d(\d[1-9]|[1-9]0)|[1-9]00)|[1-9]000)-(0[1-9]|1[0-2])-(0[1-9]|[1-2]\d|3[0-1])([T ]([01]\d|2[0-3])(:[0-5]\d(:([0-5]\d|60))?(\.\d{1,9})?)?)?(Z|[+-]((0\d|1[0-3]):[0-5]\d|14:00)?)?$/

const validateDateValue = (value: string): void => {
  if (!SUPPORTED_DATE.test(value)) {
    throw new OperationOutcomeError(badRequest(`Invalid date value: ${value}`))
  }
  if (Number.isNaN(new Date(value).getTime())) {
    throw new OperationOutcomeError(badRequest(`Invalid date value: ${value}`))
  }
}

const compileDate = (
  get: (row: IndexedRow) => ColumnValue | ColumnValue[],
  kind: ColumnKind,
  array: boolean,
  filter: Filter,
): Predicate => {
  if (filter.operator === Operator.IN || filter.operator === Operator.NOT_IN) {
    throw new OperationOutcomeError(invalidSearchOperator(filter.operator, filter.code))
  }
  validateDateValue(filter.value)
  const wanted = coerce(kind, filter.value)
  if (array) {
    const negated = isNegated(filter.operator)
    return (row) => {
      const column = get(row) as ColumnValue[] | null
      const overlaps =
        column === null || column === undefined
          ? false
          : column.some((c) => {
              const s = stored(kind, c)
              return s !== null && compare(s, wanted) === 0
            })
      return negated ? !overlaps : overlaps
    }
  }
  const op = fhirOperatorToSql(filter.operator)
  return (row) => sqlCompare(stored(kind, get(row) as ColumnValue), op, wanted)
}

const compileQuantity = (
  get: (row: IndexedRow) => ColumnValue | ColumnValue[],
  filter: Filter,
): Predicate => {
  const [number] = splitN(filter.value, "|", 3)
  if (!number)
    throw new OperationOutcomeError(badRequest(`Invalid quantity value: ${filter.value}`))
  const n = coerce("number", number) as number
  if (filter.operator === Operator.APPROXIMATELY) {
    return (row) => {
      const value = stored("number", get(row) as ColumnValue)
      return and([sqlCompare(value, ">=", n * 0.9), sqlCompare(value, "<=", n * 1.1)])
    }
  }
  const op = fhirOperatorToSql(filter.operator)
  return (row) => sqlCompare(stored("number", get(row) as ColumnValue), op, n)
}

// ------------------------------------------------------------------ token columns

const escapeRegex = (value: string) => value.replaceAll(/[.^$*+?()[\]{}\\|]/g, "\\$&")

const compileTokenColumns = (
  impl: TokenImpl,
  param: SearchParameter,
  filter: Filter,
): Predicate => {
  switch (filter.operator) {
    case Operator.TEXT:
    case Operator.CONTAINS: {
      const patterns = splitSearchOnComma(filter.value).map((query) => {
        const source = impl.hasDedicatedColumns
          ? `^[^\\x03]*${escapeRegex(query.trim())}`
          : `^${escapeRegex(impl.code + DELIM)}[^\\x03]*${escapeRegex(query.trim())}`
        return new RegExp(source, "iu")
      })
      return (row) => {
        const text = tokensOf(row, impl).text
        return patterns.some((pattern) => text.some((entry) => pattern.test(entry)))
      }
    }
    case Operator.EQUALS:
    case Operator.EXACT:
    case Operator.NOT:
    case Operator.NOT_EQUALS: {
      const search = splitSearchOnComma(filter.value)
        .map((query) => query.trim())
        .map((query) => {
          let searchString: string
          const parts = splitN(query, "|", 2)
          if (parts.length === 2) {
            const system = parts[0] || NULL_SYSTEM
            let value = parts[1] as string
            if (value) {
              value = impl.caseInsensitive ? value.toLocaleLowerCase() : value
              searchString = system + DELIM + value
            } else {
              searchString = system
            }
          } else {
            const value = impl.caseInsensitive ? query.toLocaleLowerCase() : query
            searchString = DELIM + value
          }
          return impl.hasDedicatedColumns ? searchString : impl.code + DELIM + searchString
        })
      const negated = isNegated(filter.operator)
      return (row) => {
        const tokens = tokensOf(row, impl).tokens
        const overlaps = search.some((s) => tokens.has(s))
        return negated ? !overlaps : overlaps
      }
    }
    case Operator.MISSING:
    case Operator.PRESENT: {
      const shouldExist = tokenShouldExist(filter.operator, filter.value)
      return (row) => {
        const tokens = tokensOf(row, impl).tokens
        const exists = impl.hasDedicatedColumns ? tokens.size > 0 : tokens.has(impl.code)
        return shouldExist ? exists : !exists
      }
    }
    default:
      throw new OperationOutcomeError(
        invalidSearchOperator(filter.operator, param.id ?? param.code),
      )
  }
}

const tokenShouldExist = (operator: Operator, value: string): boolean => {
  const lowered = value.toLowerCase()
  if (operator === Operator.MISSING) {
    if (lowered === "true") return false
    if (lowered === "false") return true
    throw new OperationOutcomeError(
      badRequest("Search filter ':missing' must have a value of 'true' or 'false'"),
    )
  }
  if (lowered === "true") return true
  if (lowered === "false") return false
  throw new OperationOutcomeError(
    badRequest("Search filter ':present' must have a value of 'true' or 'false'"),
  )
}

// ------------------------------------------------------------------ lookup tables

/**
 * Postgres `to_tsvector('simple', …)` lexemes, approximated: lower-cased runs of letters and
 * digits, plus each hyphenated compound as a whole (the default parser emits both).
 */
export const tsLexemes = (text: string): string[] => {
  const lowered = text.toLowerCase()
  const out = new Set<string>()
  for (const word of lowered.match(/[\p{L}\p{N}]+/gu) ?? []) out.add(word)
  for (const compound of lowered.match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)+/gu) ?? [])
    out.add(compound)
  return [...out]
}

/** `formatTsquery` plus the parser: the prefixes a `TSVECTOR_SIMPLE` query requires, all of them. */
export const tsQueryPrefixes = (option: string): string[] | undefined => {
  const built = option
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => `${token}:*`)
    .join(" & ")
  const noPunctuation = built.replaceAll(/[^\p{Letter}\p{Number}-]/gu, " ").trim()
  if (!noPunctuation) return undefined
  const prefixes: string[] = []
  for (const token of noPunctuation.split(/\s+/)) {
    const lowered = token.toLowerCase()
    const parts = lowered.split("-").filter(Boolean)
    if (parts.length === 0) continue
    if (parts.length > 1) prefixes.push(parts.join("-"))
    prefixes.push(...parts)
  }
  return prefixes
}

const compileLookup = (impl: LookupImpl, filter: Filter): Predicate => {
  if (filter.operator === Operator.IN || filter.operator === Operator.NOT_IN) {
    throw new OperationOutcomeError(invalidSearchOperator(filter.operator, filter.code))
  }
  const column = impl.column
  const options = splitSearchOnComma(filter.value).map((option) => {
    if (filter.operator === Operator.EXACT) {
      const exact = option.trim()
      return (value: string | undefined) => value === exact
    }
    if (filter.operator === Operator.CONTAINS) {
      const needle = option.toLowerCase()
      return (value: string | undefined) => value?.toLowerCase().includes(needle)
    }
    const prefixes = tsQueryPrefixes(option)
    if (!prefixes) return (_value: string | undefined) => true
    return (value: string | undefined) => {
      if (value === undefined) return false
      const lexemes = tsLexemes(value)
      return prefixes.every((prefix) => lexemes.some((lexeme) => lexeme.startsWith(prefix)))
    }
  })
  const rowsOf = (row: IndexedRow): Record<string, string | undefined>[] =>
    (impl.table === "HumanName" ? namesOf(row) : addressesOf(row)) as Record<
      string,
      string | undefined
    >[]
  const exists = (row: IndexedRow) =>
    rowsOf(row).some((entry) => options.some((test) => test(entry[column])))
  if (isNegated(filter.operator)) return (row) => !exists(row)
  return exists
}

// ------------------------------------------------------------------ special parameters

const ZERO_UUID = "00000000-0000-0000-0000-000000000000"

const idValues = (filter: Filter): string[] => {
  if (filter.operator === Operator.IN || filter.operator === Operator.NOT_IN) {
    throw new OperationOutcomeError(invalidSearchOperator(filter.operator, filter.code))
  }
  return splitSearchOnComma(filter.value).map((raw) => {
    let value = raw
    if (value.includes("/")) value = value.split("/").pop() as string
    return isUUID(value) ? value : ZERO_UUID
  })
}

const compileSpecial = (
  context: CompileContext,
  resourceType: string,
  filter: Filter,
): Predicate | undefined => {
  switch (filter.code) {
    case "_id":
      return conditionOn((row) => row.id, "uuid", false, filter, idValues(filter))
    case "_lastUpdated":
      return compileDate((row) => row.lastUpdated, "timestamptz", false, filter)
    case "_deleted":
      return compileBoolean((row) => row.deleted, filter)
    case "_project": {
      if (filter.operator === Operator.MISSING || filter.operator === Operator.PRESENT) {
        const missing =
          (filter.operator === Operator.MISSING && filter.value === "true") ||
          (filter.operator === Operator.PRESENT && filter.value !== "true")
        const SYSTEM = "65897e4f-7add-55f3-9b17-035b5a4e6d52"
        return missing ? (row) => row.projectId === SYSTEM : (row) => row.projectId !== SYSTEM
      }
      return conditionOn((row) => row.projectId, "uuid", false, filter, idValues(filter))
    }
    case "_compartment":
      return conditionOn((row) => row.compartments, "uuid", true, filter, idValues(filter))
    case "_filter":
      return compileFilterExpression(context, resourceType, parseFilterParameter(filter.value))
    default:
      return undefined
  }
}

const compileFilterExpression = (
  context: CompileContext,
  resourceType: string,
  expression: FhirFilterExpression,
): Predicate => {
  if (expression instanceof FhirFilterNegation) {
    const child = compileFilterExpression(context, resourceType, expression.child)
    return (row) => not(child(row))
  }
  if (expression instanceof FhirFilterConnective) {
    const left = compileFilterExpression(context, resourceType, expression.left)
    const right = compileFilterExpression(context, resourceType, expression.right)
    return expression.keyword === "and"
      ? (row) => and([left(row), right(row)])
      : (row) => or([left(row), right(row)])
  }
  if (expression instanceof FhirFilterComparison) {
    return compileFilter(context, resourceType, {
      code: expression.path,
      operator: expression.operator,
      value: expression.value,
    })
  }
  throw new OperationOutcomeError(badRequest("Unknown filter expression type"))
}

// ------------------------------------------------------------------ chained search

type ChainLink = {
  originType: string
  targetType: string
  code: string
  impl: ColumnImpl
  param: SearchParameter
  direction: 1 | -1
}

type ChainedParameter = { chain: ChainLink[]; filter: Filter }

const splitChainedSearch = (input: string): string[] => {
  const params: string[] = []
  let chain = input
  while (chain) {
    if (chain.slice(0, 5) === "_has:") {
      const typeDelim = chain.indexOf(":", 5)
      const codeDelim = chain.indexOf(":", typeDelim + 1)
      if (typeDelim < 0 || typeDelim >= codeDelim) throw new Error(`Invalid search chain: ${chain}`)
      params.push(chain.slice(0, codeDelim))
      chain = chain.slice(codeDelim + 1)
    } else {
      let nextDot = chain.indexOf(".")
      if (nextDot === -1) nextDot = chain.length
      params.push(chain.slice(0, nextDot))
      chain = chain.slice(nextDot + 1)
    }
  }
  return params
}

const parseChainLink = (part: string, currentType: string): ChainLink => {
  const [code, modifier] = splitN(part, ":", 2) as [string, string | undefined]
  const param = getSearchParameter(currentType, code)
  if (!param) throw new Error(`Invalid search parameter in chain: ${currentType}?${code}`)
  let targetType: string
  if (param.target?.length === 1) targetType = param.target[0] as string
  else if (modifier && param.target?.includes(modifier as never)) targetType = modifier
  else
    throw new Error(
      `Unable to identify next resource type for search parameter: ${currentType}?${code}`,
    )
  const impl = getSearchImpl(currentType, param)
  if (impl.strategy !== "column")
    throw new Error(`Invalid search parameter in chain: ${currentType}?${code}`)
  return { originType: currentType, targetType, code, impl, param, direction: 1 }
}

const parseReverseChainLink = (part: string, targetType: string): ChainLink => {
  const [, resourceType, code] = splitN(part, ":", 3) as [string, string, string]
  const param = getSearchParameter(resourceType, code)
  if (!param) throw new Error(`Invalid search parameter in chain: ${resourceType}?${code}`)
  if (!param.target?.includes(targetType as never)) {
    throw new Error(
      `Invalid reverse chain link: search parameter ${resourceType}?${code} does not refer to ${targetType}`,
    )
  }
  const impl = getSearchImpl(resourceType, param)
  if (impl.strategy !== "column")
    throw new Error(`Invalid search parameter in chain: ${resourceType}?${code}`)
  return { originType: targetType, targetType: resourceType, code, impl, param, direction: -1 }
}

export const parseChainedParameter = (
  resourceType: string,
  searchFilter: Filter,
): ChainedParameter => {
  let currentType = resourceType
  const parts = splitChainedSearch(searchFilter.code)
  const chain: ChainLink[] = []
  let filter: Filter | undefined
  parts.forEach((part, index) => {
    if (part.startsWith("_has")) {
      const link = parseReverseChainLink(part, currentType)
      chain.push(link)
      currentType = link.targetType
    } else if (index === parts.length - 1) {
      const [code, modifier] = splitN(part, ":", 2) as [string, string | undefined]
      if (code === "_filter") {
        filter = { code: "_filter", operator: Operator.EQUALS, value: searchFilter.value }
      } else {
        const param = getSearchParameter(currentType, code)
        if (!param)
          throw new Error(`Invalid search parameter at end of chain: ${currentType}?${code}`)
        filter = parseParameter(param, searchFilter.operator, modifier ?? "", searchFilter.value)
      }
    } else {
      const link = parseChainLink(part, currentType)
      chain.push(link)
      currentType = link.targetType
    }
  })
  if (!filter) throw new OperationOutcomeError(badRequest("Unterminated chained search"))
  return { chain, filter }
}

const canonicalValues = (row: IndexedRow, link: ChainLink): string[] => {
  const value = columnOf(row, link.impl, link.param)
  if (value === null || value === undefined) return []
  return (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === "string")
}

/** The rows one link of a chain reaches from `row`. */
const followLink = (context: CompileContext, row: IndexedRow, link: ChainLink): IndexedRow[] => {
  if (link.code === "_compartment") {
    if (link.direction === 1) {
      return row.compartments
        .map((id) => context.source.get(link.targetType, id))
        .filter((r): r is IndexedRow => r !== undefined)
    }
    return context.source
      .all(link.targetType)
      .filter((candidate) => candidate.compartments.includes(row.id))
  }
  if (link.impl.type === SearchParameterType.CANONICAL) {
    if (!getSearchParameter(link.direction === 1 ? link.targetType : link.originType, "url")) {
      throw new OperationOutcomeError(
        badRequest(
          `${link.targetType} cannot be chained via canonical reference (${link.originType}:${link.code})`,
        ),
      )
    }
    const urlOf = (candidate: IndexedRow) => (candidate.resource as { url?: string }).url
    if (link.direction === 1) {
      const urls = canonicalValues(row, link)
      return context.source.all(link.targetType).filter((candidate) => {
        const url = urlOf(candidate)
        return url !== undefined && urls.includes(url)
      })
    }
    const url = urlOf(row)
    return url === undefined
      ? []
      : context.source
          .all(link.targetType)
          .filter((candidate) => canonicalValues(candidate, link).includes(url))
  }
  if (link.direction === 1) {
    return referencesOf(row)
      .filter((ref) => ref.code === link.code)
      .map((ref) => context.source.get(link.targetType, ref.targetId))
      .filter((r): r is IndexedRow => r !== undefined)
  }
  return context.source
    .all(link.targetType)
    .filter((candidate) =>
      referencesOf(candidate).some((ref) => ref.code === link.code && ref.targetId === row.id),
    )
}

const compileChainedSearch = (
  context: CompileContext,
  resourceType: string,
  parameter: ChainedParameter,
): Predicate => {
  if (parameter.chain.length > 3) {
    throw new OperationOutcomeError(
      badRequest("Search chains longer than three links are not currently supported"),
    )
  }
  const first = parameter.chain[0]
  if (
    parameter.chain.length === 1 &&
    first &&
    parameter.filter.code === "_id" &&
    first.direction === 1
  ) {
    return compileFilter(context, resourceType, {
      code: first.code,
      operator: parameter.filter.operator,
      value: `${first.targetType}/${parameter.filter.value}`,
    })
  }
  for (const link of parameter.chain) context.validateType(link.targetType)
  const last = parameter.chain[parameter.chain.length - 1] as ChainLink
  const terminal = compileFilter(context, last.targetType, parameter.filter)
  return (row) => {
    let frontier = [row]
    for (const link of parameter.chain) {
      const next: IndexedRow[] = []
      for (const current of frontier) next.push(...followLink(context, current, link))
      frontier = next
      if (frontier.length === 0) return false
    }
    return frontier.some((target) => terminal(target) === true)
  }
}

export { and, not, or, resolveId }
