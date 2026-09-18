type RecordValue = Record<string, unknown>

export type Expander = (id: string) => unknown

/** Resolver table for one operation, keyed by the expansion path as Stripe spells it. */
export type ExpandResolvers = Readonly<Record<string, Expander | undefined>>

const expandInto = (node: unknown, parts: readonly string[], resolver: Expander): void => {
  if (parts.length === 0 || node === null || typeof node !== "object") return
  if (Array.isArray(node)) {
    for (const item of node) expandInto(item, parts, resolver)
    return
  }
  const record = node as RecordValue
  const [head, ...rest] = parts
  if (head === undefined) return
  if (rest.length === 0) {
    const current = record[head]
    if (typeof current === "string" && current !== "") {
      const resolved = resolver(current)
      if (resolved !== undefined && resolved !== null) record[head] = resolved
    }
    return
  }
  expandInto(record[head], rest, resolver)
}

/**
 * Replace id strings with full objects wherever `expand` names a path the caller resolves.
 * Paths are matched literally (including a leading `data.` on list envelopes, where the walker
 * descends into every element). Unknown paths leave the id in place, as the mock never expands
 * anything it has not been taught.
 */
export const applyExpand = <T>(value: T, expand: unknown, resolvers: ExpandResolvers): T => {
  const requested = Array.isArray(expand)
    ? expand.filter((entry): entry is string => typeof entry === "string")
    : typeof expand === "string" && expand !== ""
      ? [expand]
      : []
  for (const entry of requested) {
    const path = entry.replace(/\[\]$/, "")
    const resolver = resolvers[path]
    if (!resolver) continue
    expandInto(value, path.split("."), resolver)
  }
  return value
}
