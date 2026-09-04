import type { Collection, Stored } from "@crvouga/mockingbird-service"
import { invalidRequest, resourceMissing } from "./errors.js"
import type { Params } from "./params.js"

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 100

/** Stripe clamps `limit` into 1..100 instead of rejecting it. */
export const clampLimit = (limit: unknown) => {
  if (typeof limit !== "number") return DEFAULT_LIMIT
  return Math.min(MAX_LIMIT, Math.max(1, limit))
}

type CreatedFilter = number | { gt?: number; gte?: number; lt?: number; lte?: number }

export const matchesCreated = (created: number, filter: unknown) => {
  if (filter === undefined) return true
  const spec = filter as CreatedFilter
  if (typeof spec === "number") return created === spec
  if (spec.gt !== undefined && !(created > spec.gt)) return false
  if (spec.gte !== undefined && !(created >= spec.gte)) return false
  if (spec.lt !== undefined && !(created < spec.lt)) return false
  if (spec.lte !== undefined && !(created <= spec.lte)) return false
  return true
}

export type Page<T> = { object: "list"; data: T[]; has_more: boolean; url: string }

/**
 * Cursor pagination over records sorted newest first. `starting_after` continues past a record,
 * `ending_before` yields the records immediately newer than one, both in newest-first order.
 */
export const paginate = async <T>(
  collection: Collection<T>,
  params: Params,
  options: {
    url: string
    kind: string
    where: (record: T) => boolean
    /** Existence check for cursors; deleted tombstones count as missing. */
    exists?: (record: T) => boolean
    render: (record: T) => unknown
  },
): Promise<Page<unknown>> => {
  const startingAfter = params.starting_after
  const endingBefore = params.ending_before
  if (
    typeof startingAfter === "string" &&
    startingAfter !== "" &&
    typeof endingBefore === "string" &&
    endingBefore !== ""
  ) {
    throw invalidRequest(
      "Received both starting_after and ending_before parameters. Please pass in only one.",
    )
  }
  const limit = clampLimit(params.limit)
  const all = await collection.list({ order: "newest" })
  const exists = options.exists ?? (() => true)
  const cursorIndex = (id: string, param: string) => {
    const index = all.findIndex(
      (entry: Stored<T> & { id: string }) => entry.id === id && exists(entry.value),
    )
    if (index === -1) throw resourceMissing(options.kind, id, param, 400)
    return index
  }
  const matching = (entries: Array<Stored<T> & { id: string }>) =>
    entries.filter((entry) => options.where(entry.value))

  let data: T[]
  let hasMore: boolean
  if (typeof startingAfter === "string" && startingAfter !== "") {
    const rest = matching(all.slice(cursorIndex(startingAfter, "starting_after") + 1))
    data = rest.slice(0, limit).map((e) => e.value)
    hasMore = rest.length > limit
  } else if (typeof endingBefore === "string" && endingBefore !== "") {
    const before = matching(all.slice(0, cursorIndex(endingBefore, "ending_before")))
    data = before.slice(Math.max(0, before.length - limit)).map((e) => e.value)
    hasMore = before.length > limit
  } else {
    const rows = matching(all)
    data = rows.slice(0, limit).map((e) => e.value)
    hasMore = rows.length > limit
  }
  return { object: "list", data: data.map(options.render), has_more: hasMore, url: options.url }
}
