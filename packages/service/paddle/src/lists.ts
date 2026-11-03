import type { OperationContext } from "@crvouga/mockingbird-service"
import { invalidField } from "./errors.js"

export type Page<T> = {
  data: T[]
  pagination: { per_page: number; next: string; has_more: boolean; estimated_total: number }
}

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined

/** A comma-separated query value as a list (`id=a,b`). */
export const listParam = (value: unknown): string[] | undefined => {
  const raw = asString(value)
  if (raw === undefined) return undefined
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "")
}

/** An unfiltered collection: every row's id and creation sequence. */
type CreationOrder = { list(): { id: string; seq: number }[] }

/**
 * Paddle's cursor pagination over an already-filtered list: `order_by` (`id[ASC]` or the
 * default `id[DESC]`, newest first), `per_page` (a request above the maximum gets the maximum,
 * as Paddle documents; below 1 is invalid), and `after=<id>` for the entities past that one.
 * `next` is an absolute URL carrying the same filters, as the SDK follows it verbatim.
 *
 * Paddle ids sort by creation date, and a page holds the entities past the cursor in that
 * order. When the cursor entity is no longer in the filtered list (archived between pages),
 * `limits.source` (the unfiltered collection) still places it, so paging goes on.
 */
export const paginate = <T extends { id: string }>(
  context: OperationContext,
  publicPrefix: string,
  rowsNewestFirst: T[],
  limits: { defaultPerPage: number; maxPerPage: number; source?: CreationOrder },
): Page<T> => {
  const errors: { field: string; message: string }[] = []
  const orderBy = asString(context.query.order_by) ?? "id[DESC]"
  if (orderBy !== "id[ASC]" && orderBy !== "id[DESC]") {
    errors.push({ field: "order_by", message: "order_by: must be id[ASC] or id[DESC]" })
  }
  let perPage = limits.defaultPerPage
  const rawPerPage = context.query.per_page
  if (rawPerPage !== undefined) {
    const parsed = typeof rawPerPage === "string" ? Number(rawPerPage) : Number.NaN
    if (!Number.isInteger(parsed) || parsed < 1) {
      errors.push({
        field: "per_page",
        message: `per_page: must be an integer between 1 and ${limits.maxPerPage}`,
      })
    } else perPage = Math.min(parsed, limits.maxPerPage)
  }
  if (errors.length > 0) throw invalidField(errors)
  const ordered = orderBy === "id[ASC]" ? [...rowsNewestFirst].reverse() : rowsNewestFirst
  const after = asString(context.query.after)
  let start = 0
  if (after !== undefined) {
    const index = ordered.findIndex((row) => row.id === after)
    start =
      index < 0
        ? pastMissingCursor(ordered, after, orderBy === "id[ASC]", limits.source)
        : index + 1
  }
  const data = ordered.slice(start, start + perPage)
  const hasMore = start + perPage < ordered.length
  const next = new URL(context.url.href)
  next.pathname = `${publicPrefix}${context.url.pathname}`
  const last = data[data.length - 1]
  if (last) next.searchParams.set("after", last.id)
  return {
    data,
    pagination: {
      per_page: perPage,
      next: next.href,
      has_more: hasMore,
      estimated_total: ordered.length,
    },
  }
}

/** Where a page starts after a cursor that the filters left out: the first row created past it. */
const pastMissingCursor = <T extends { id: string }>(
  ordered: T[],
  after: string,
  ascending: boolean,
  source: CreationOrder | undefined,
): number => {
  const created = new Map(source?.list().map((row) => [row.id, row.seq]))
  const cursor = created.get(after)
  if (cursor === undefined) return ordered.length
  const index = ordered.findIndex((row) => {
    const seq = created.get(row.id)
    return seq !== undefined && (ascending ? seq > cursor : seq < cursor)
  })
  return index < 0 ? ordered.length : index
}
