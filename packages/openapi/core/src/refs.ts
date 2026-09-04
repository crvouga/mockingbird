import type { OpenAPIDocument, ReferenceObject } from "./types.js"

export class OpenAPIReferenceError extends Error {
  constructor(readonly ref: string) {
    super(`unresolvable $ref: ${ref}`)
    this.name = "OpenAPIReferenceError"
  }
}

const unescapePointer = (segment: string) => segment.replace(/~1/g, "/").replace(/~0/g, "~")

/** True when `value` is a `{ $ref }` object. */
export const isReference = (value: unknown): value is ReferenceObject =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { $ref?: unknown }).$ref === "string"

/** Resolve a local JSON pointer reference (`#/components/schemas/customer`) inside `document`. */
export const resolveRef = (document: OpenAPIDocument, ref: string): unknown => {
  if (!ref.startsWith("#/")) throw new OpenAPIReferenceError(ref)
  let cursor: unknown = document
  for (const raw of ref.slice(2).split("/")) {
    const segment = unescapePointer(raw)
    if (typeof cursor !== "object" || cursor === null || !(segment in cursor)) {
      throw new OpenAPIReferenceError(ref)
    }
    cursor = (cursor as Record<string, unknown>)[segment]
  }
  if (cursor === undefined) throw new OpenAPIReferenceError(ref)
  return cursor
}

/**
 * Follow `$ref` chains until a concrete object is reached. Guards against cycles.
 * Sibling keys next to `$ref` are ignored, as in OpenAPI 3.0/3.1 for non-schema objects.
 */
export const deref = <T>(document: OpenAPIDocument, value: T | ReferenceObject): T => {
  let current: unknown = value
  const seen = new Set<string>()
  while (isReference(current)) {
    if (seen.has(current.$ref)) throw new OpenAPIReferenceError(`${current.$ref} (cycle)`)
    seen.add(current.$ref)
    current = resolveRef(document, current.$ref)
  }
  return current as T
}

/** The component name at the end of a `#/components/<kind>/<name>` reference, if any. */
export const componentNameOf = (ref: string): string | undefined => {
  const match = /^#\/components\/[^/]+\/(.+)$/.exec(ref)
  return match?.[1] === undefined ? undefined : unescapePointer(match[1])
}
