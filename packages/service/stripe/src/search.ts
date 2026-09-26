import { invalidRequest, parameterInvalidEmpty, StripeError } from "./errors.js"
import { expandPathsOf } from "./expand.js"
import { clampLimit } from "./list.js"
import type { Params } from "./params.js"

type RecordValue = Record<string, unknown>

export type SearchFilter = {
  field: string
  metadataKey: string | null
  value: string
  negated: boolean
}

const METADATA = /^metadata(?:\[['"]([^'"]+)['"]\])?$/
const TOKEN =
  /(-)?(metadata\[['"][^'"]+['"]\]|[A-Za-z_][A-Za-z0-9_.]*)[:]\s*(?:'([^']*)'|"([^"]*)"|(\S+))/g

/**
 * Stripe's documented search subset: `field:'value'`, `metadata['key']:'value'`, `-` negates, and
 * terms are combined with implicit AND. Anything the parser cannot consume is a 400, matching how
 * Stripe refuses a malformed query instead of silently ignoring it.
 */
export const parseSearchQuery = (query: string): SearchFilter[] => {
  const text = query.trim()
  const filters: SearchFilter[] = []
  for (const match of text.matchAll(TOKEN)) {
    const [whole, negated, field, single, double, bare] = match
    if (field === undefined) continue
    const metadata = METADATA.exec(field)
    filters.push({
      field: metadata === null ? field : "metadata",
      metadataKey: metadata?.[1] ?? null,
      value: single ?? double ?? bare ?? "",
      negated: negated === "-",
    })
    void whole
  }
  if (
    filters.length === 0 ||
    text
      .replace(TOKEN, "")
      .replace(/\b(?:AND|and|OR|or)\b/g, "")
      .trim() !== ""
  )
    throw invalidRequest(
      'We were unable to parse your search query. Try using the format `metadata["key"]:"value"` to query for metadata or key:"value" to query for other fields.',
    )
  return filters
}

export type SearchPage<T> = {
  object: "search_result"
  data: T[]
  has_more: boolean
  next_page: string | null
  /** Only with `expand[]=total_count`. */
  total_count?: number
  url: string
}

const fieldValue = (record: RecordValue, filter: SearchFilter): unknown => {
  if (filter.field !== "metadata") return record[filter.field]
  if (
    filter.metadataKey === null ||
    record.metadata === null ||
    typeof record.metadata !== "object"
  )
    return undefined
  return (record.metadata as RecordValue)[filter.metadataKey]
}

const matches = (record: RecordValue, filter: SearchFilter) => {
  const hit = String(fieldValue(record, filter) ?? "") === filter.value
  return filter.negated ? !hit : hit
}

const PAGE = /^page_(\d+)$/

/**
 * Search, newest first. Clauses joined by `OR` are alternatives; within one, terms are ANDed.
 * `limit` clamps into 1..100 (default 10) and `page` continues from a previous `next_page`.
 * Search is consistent by default; the `search_lag` fault hides records created in the last
 * `lagSeconds` (default 60), reproducing Stripe's index lag.
 */
export const searchRecords = <T extends RecordValue>(
  records: readonly T[],
  params: Params,
  options: {
    url: string
    render: (record: T) => unknown
    lag?: Record<string, unknown> | undefined
    now?: () => number
  },
): SearchPage<unknown> => {
  const { query } = params
  if (params.expand === "") throw parameterInvalidEmpty("expand")
  if (query === "") throw parameterInvalidEmpty("query")
  if (params.page === "") throw parameterInvalidEmpty("page")
  if (params.limit !== undefined) {
    const limit = Number(params.limit)
    if (limit < 1 || limit > 100)
      throw new StripeError({
        status: 400,
        code: "parameter_invalid_integer",
        message:
          limit < 1
            ? "This value must be greater than or equal to 1."
            : `This value must be less than or equal to 100 (it currently is '${limit}').`,
        param: "limit",
      })
  }
  if (query === "") throw parameterInvalidEmpty("query")
  if (typeof query !== "string" || query.trim() === "")
    throw invalidRequest("Missing required param: query.", "query", "parameter_missing")
  const groups = query.split(/\s+OR\s+/).map(parseSearchQuery)
  const lagSeconds =
    options.lag === undefined
      ? undefined
      : typeof options.lag.lagSeconds === "number"
        ? options.lag.lagSeconds
        : 60
  const nowSeconds = Math.floor((options.now?.() ?? Date.now()) / 1000)
  const visible =
    lagSeconds === undefined
      ? records
      : records.filter((record) => Number(record.created ?? 0) <= nowSeconds - lagSeconds)
  const matched = visible.filter((record) =>
    groups.some((filters) => filters.every((filter) => matches(record, filter))),
  )
  const limit = clampLimit(params.limit !== undefined ? Number(params.limit) : 10)
  const page = typeof params.page === "string" ? PAGE.exec(params.page) : null
  if (typeof params.page === "string" && params.page !== "" && page === null)
    // Stripe names the bad token itself as the param (verified in test mode).
    throw invalidRequest(
      `${params.page.length > 1000 ? `${params.page.slice(0, 100)}...${params.page.slice(-100)}` : params.page} is an invalid page.`,
      params.page,
    )
  const offset = page === null ? 0 : Number(page[1])
  const window = matched.slice(offset, offset + limit)
  const more = matched.length > offset + limit
  return {
    object: "search_result",
    data: window.map(options.render),
    has_more: more,
    next_page: more ? `page_${offset + limit}` : null,
    ...(expandPathsOf(params.expand).includes("total_count")
      ? { total_count: matched.length }
      : {}),
    url: options.url,
  }
}
