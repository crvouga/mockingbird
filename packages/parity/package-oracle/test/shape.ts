/**
 * Structural contract of a JSON value: every leaf becomes its type name. Arrays keep their
 * length and order, so a route that returns a different number of items, or items in a
 * different order, is a difference rather than being folded into a set of item shapes.
 */
export function shape(value: unknown): unknown {
  if (value === null) return "null"
  if (Array.isArray(value)) return value.map(shape)
  if (typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, shape(item)]),
    )
  return typeof value
}
