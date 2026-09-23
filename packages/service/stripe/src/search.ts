import { invalidRequest } from "./errors.js"

export type SearchClause = { field: string; value: string; metadata: boolean }

const TOKEN =
  /^(metadata\['([^']+)'\]|metadata\["([^"]+)"\]|[A-Za-z0-9_]+)\s*:\s*("([^"]*)"|'([^']*)'|(\S+))$/

/** Stripe's `field:value` / `metadata['k']:'v'` query language, AND-combined. */
export const parseSearch = (query: string): SearchClause[] => {
  const text = query.trim()
  if (text === "")
    throw invalidRequest(
      "We couldn't parse your search query. Try using the format `field:value`.",
      "query",
    )
  const parts = text.split(/\s+AND\s+/)
  return parts.map((part) => {
    const match = TOKEN.exec(part.trim())
    if (!match)
      throw invalidRequest(
        "We couldn't parse your search query. Try using the format `field:value`.",
        "query",
      )
    const field = match[2] ?? match[3] ?? match[1] ?? ""
    const value = match[5] ?? match[6] ?? match[7] ?? ""
    return { field, value, metadata: match[2] !== undefined || match[3] !== undefined }
  })
}

export const matchesSearch = (
  clauses: SearchClause[],
  read: (field: string) => string | null | undefined,
  metadata: Record<string, string>,
) =>
  clauses.every((clause) => {
    if (clause.metadata) return metadata[clause.field] === clause.value
    const found = read(clause.field)
    if (found === undefined) return false
    return found === clause.value
  })

export const searchPage = (url: string, data: unknown[]) => ({
  object: "search_result",
  data,
  has_more: false,
  next_page: null,
  total_count: data.length,
  url,
})
