import { invalidRequest } from "./errors.js"
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
    throw invalidRequest("Invalid search query: unable to parse the query.", "query")
  return filters
}

export type SearchPage<T> = {
  object: "search_result"
  data: T[]
  has_more: boolean
  next_page: string | null
  total_count: number
  url: string
}

/**
 * Search page newest-first. `limit` clamps into 1..100 (default 10) exactly like a list; cursor
 * pagination is not exercised by the e2e path, so `next_page` is always null.
 */
export const searchRecords = <T extends RecordValue>(
  records: readonly T[],
  params: Params,
  options: { url: string; render: (record: T) => unknown },
): SearchPage<unknown> => {
  const { query } = params
  if (typeof query !== "string" || query.trim() === "")
    throw invalidRequest("Missing required param: query.", "query", "parameter_missing")
  const filters = parseSearchQuery(query)
  const matched = records.filter((record) =>
    filters.every((filter) => {
      const actual =
        filter.field === "metadata"
          ? filter.metadataKey === null ||
            record.metadata === null ||
            typeof record.metadata !== "object"
            ? undefined
            : (record.metadata as RecordValue)[filter.metadataKey]
          : record[filter.field]
      const hit = String(actual ?? "") === filter.value
      return filter.negated ? !hit : hit
    }),
  )
  const limit = clampLimit(params.limit !== undefined ? Number(params.limit) : 10)
  return {
    object: "search_result",
    data: matched.slice(0, limit).map(options.render),
    has_more: matched.length > limit,
    next_page: null,
    total_count: matched.length,
    url: options.url,
  }
}
