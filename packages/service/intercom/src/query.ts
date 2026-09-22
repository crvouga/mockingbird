import { fromBase64, toBase64 } from "@crvouga/mockingbird-service"

/**
 * Intercom's search query language, shared by contact and conversation search: a filter
 * `{field, operator, value}` or a compound `{operator: "AND" | "OR", value: [query, …]}`,
 * nested up to two levels.
 */

export type Filter = { field: string; operator: string; value: unknown }
export type Compound = { operator: "AND" | "OR"; value: Query[] }
export type Query = Filter | Compound

export class QueryError extends Error {}

const FILTER_OPERATORS = ["=", "!=", "IN", "NIN", "<", ">", "~", "!~", "^", "$"]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Parse and validate a query against the searchable fields. */
export const parseQuery = (value: unknown, fields: readonly string[], depth = 0): Query => {
  if (!isRecord(value)) throw new QueryError("query must be an object")
  const operator = value.operator
  if (operator === "AND" || operator === "OR") {
    if (depth >= 2) throw new QueryError("queries can be nested at most two levels deep")
    if (!Array.isArray(value.value) || value.value.length === 0) {
      throw new QueryError(`${operator} requires a non-empty value array`)
    }
    return { operator, value: value.value.map((each) => parseQuery(each, fields, depth + 1)) }
  }
  if (typeof value.field !== "string") throw new QueryError("query field is required")
  const custom = value.field.startsWith("custom_attributes.")
  if (!fields.includes(value.field) && !(custom && fields.includes("custom_attributes.*"))) {
    throw new QueryError(`${value.field} is not a searchable field`)
  }
  if (typeof operator !== "string" || !FILTER_OPERATORS.includes(operator)) {
    throw new QueryError(`operator ${String(operator)} is not supported`)
  }
  if ((operator === "IN" || operator === "NIN") !== Array.isArray(value.value)) {
    throw new QueryError(
      `operator ${operator} ${Array.isArray(value.value) ? "does not take" : "requires"} an array value`,
    )
  }
  if (value.value === undefined) throw new QueryError("query value is required")
  return { field: value.field, operator, value: value.value }
}

const same = (actual: unknown, expected: unknown): boolean => {
  if (actual === null || actual === undefined) return expected === null || expected === "null"
  if (Array.isArray(actual)) return actual.some((each) => same(each, expected))
  return String(actual).toLowerCase() === String(expected).toLowerCase()
}

const text = (value: unknown) =>
  value === null || value === undefined ? "" : String(value).toLowerCase()

const matchFilter = (filter: Filter, resolve: (field: string) => unknown): boolean => {
  const actual = resolve(filter.field)
  const expected = filter.value
  switch (filter.operator) {
    case "=":
      return same(actual, expected)
    case "!=":
      return !same(actual, expected)
    case "IN":
      return (expected as unknown[]).some((each) => same(actual, each))
    case "NIN":
      return !(expected as unknown[]).some((each) => same(actual, each))
    case "<":
      return actual !== null && actual !== undefined && Number(actual) < Number(expected)
    case ">":
      return actual !== null && actual !== undefined && Number(actual) > Number(expected)
    case "~":
      return text(actual).includes(text(expected))
    case "!~":
      return !text(actual).includes(text(expected))
    case "^":
      return text(actual).startsWith(text(expected))
    case "$":
      return text(actual).endsWith(text(expected))
    default:
      return false
  }
}

export const matches = (query: Query, resolve: (field: string) => unknown): boolean => {
  if ("field" in query) return matchFilter(query, resolve)
  return query.operator === "AND"
    ? query.value.every((each) => matches(each, resolve))
    : query.value.some((each) => matches(each, resolve))
}

/** Opaque cursors: base64 of `[offset]`, the shape Intercom's own cursors have. */
export const encodeCursor = (offset: number): string =>
  toBase64(new TextEncoder().encode(`[${offset}]`))

export const decodeCursor = (cursor: string): number => {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(fromBase64(cursor))) as unknown
    if (Array.isArray(parsed) && Number.isInteger(parsed[0]) && (parsed[0] as number) >= 0) {
      return parsed[0] as number
    }
  } catch {
    // fall through
  }
  throw new QueryError("starting_after is not a valid cursor")
}

export type Page<T> = {
  items: T[]
  pages: {
    type: "pages"
    page: number
    per_page: number
    total_pages: number
    next?: { page: number; starting_after: string }
  }
}

export const paginate = <T>(
  items: readonly T[],
  pagination: unknown,
  defaultPerPage: number,
): Page<T> => {
  const options = isRecord(pagination) ? pagination : {}
  const perPage = options.per_page === undefined ? defaultPerPage : Number(options.per_page)
  if (!Number.isInteger(perPage) || perPage < 1 || perPage > 150) {
    throw new QueryError("per_page must be between 1 and 150")
  }
  const offset =
    typeof options.starting_after === "string" && options.starting_after.length > 0
      ? decodeCursor(options.starting_after)
      : 0
  const slice = items.slice(offset, offset + perPage)
  const page = Math.floor(offset / perPage) + 1
  const total = Math.max(1, Math.ceil(items.length / perPage))
  const hasMore = offset + perPage < items.length
  return {
    items: slice,
    pages: {
      type: "pages",
      page,
      per_page: perPage,
      total_pages: total,
      ...(hasMore
        ? { next: { page: page + 1, starting_after: encodeCursor(offset + perPage) } }
        : {}),
    },
  }
}

// ─── Message bodies ─────────────────────────────────────────────────────────────────────

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

/** A body as Intercom stores it: HTML as given, plain text wrapped in paragraphs. */
export const toHtml = (body: string): string => {
  if (/<[a-z][\s\S]*>/i.test(body)) return body
  return body
    .split(/\r?\n/)
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join("")
}

/** `?display_as=plaintext`: paragraphs and breaks become newlines, tags go, entities decode. */
export const toPlaintext = (html: string | null): string | null => {
  if (html === null) return null
  return html
    .replace(/<\/p>\s*<p[^>]*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .trim()
}
