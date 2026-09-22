/**
 * How a search answer's entries may be compared: in order, as a set (no `_sort`: the server
 * returns heap order), or as ordered tie groups (`_sort`: ties come back in any order).
 */
import { parseSearchRequest } from "@medplum/core"
import { sortValues } from "../../src/search/search.js"
import type { EntryOrder } from "./canonical.js"

/** Call (and await) `ensureSchema()` from ../../src/schema.js before this. */
export const entryOrderFor = (method: string, path: string, entries?: number): EntryOrder => {
  if (method !== "GET") return { kind: "ordered" }
  const [pathname = "", query = ""] = path.split("?")
  const segments = pathname.split("/").filter(Boolean)
  const isSearch =
    (segments[0] === "fhir" && segments.length <= 3) || pathname.includes("$everything")
  if (!isSearch) return { kind: "ordered" }
  const resourceType = segments[2] ?? "Patient"
  let request: ReturnType<typeof parseSearchRequest>
  try {
    request = parseSearchRequest(`${resourceType}?${query}`)
  } catch {
    // An invalid query is an error answer: no entries to order.
    return { kind: "ordered" }
  }
  const count = request.count ?? 20
  const pageFull = entries !== undefined && count > 0 && entries >= count
  const offset = (request.offset ?? 0) > 0
  const rules = request.sortRules ?? []
  if (rules.length === 0) return { kind: "unordered", partial: pageFull || offset }
  return {
    kind: "sorted",
    keyOf: (resource) => JSON.stringify(sortValues(resource as never, rules)),
    pageFull,
    offset,
  }
}

/** The number of `match` entries in a searchset body, for the page-cut rule. */
export const matchCount = (body: unknown): number =>
  ((body as { entry?: { search?: { mode?: string } }[] })?.entry ?? []).filter(
    (e) => e.search?.mode !== "include",
  ).length
