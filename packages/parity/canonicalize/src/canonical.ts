import type { DecodedBody } from "@crvouga/mockingbird-http-codec"
import { canonicalToken, type ResourceTable, type Side } from "@crvouga/mockingbird-model"
import type { OpenAPIDocument, SchemaObject } from "@crvouga/mockingbird-openapi"
import { jsonTypeOf } from "@crvouga/mockingbird-openapi"
import {
  type Annotation,
  annotateValue,
  type JsonPath,
  pathKey,
} from "@crvouga/mockingbird-openapi-metadata"

/** One side of a differential comparison, already decoded. */
export type Exchange = {
  status: number
  /** Lower-cased header names. */
  headers: Record<string, string>
  body: DecodedBody
}

export type CanonicalBody =
  | { kind: "empty" }
  | { kind: "json"; value: unknown }
  | { kind: "form"; value: unknown }
  | { kind: "text"; value: string }
  | { kind: "bytes" }
  | { kind: "invalid"; mediaType: string; text: string }

export type CanonicalExchange = {
  status: number
  headers: Record<string, string>
  body: CanonicalBody
}

export type CanonicalizeOptions = {
  document: OpenAPIDocument
  /** Response body schema for this status/media type. Without one, every value is compared strictly. */
  schema: SchemaObject | undefined
  /** Lower-cased names of the headers that take part in the comparison. */
  parityHeaders: readonly string[]
  side: Side
  table: ResourceTable
}

export const volatileToken = (kind: string, value: unknown) =>
  // `opaque` collapses null vs present (sandbox races like sample_id assignment).
  kind === "opaque" ? `volatile:${kind}` : `volatile:${kind}:${jsonTypeOf(value)}`
export const unknownToken = (type: string, id: string) => `unknown:${type}:${id}`

const setAt = (root: unknown, path: JsonPath, value: unknown): unknown => {
  if (path.length === 0) return value
  const [head, ...rest] = path
  if (Array.isArray(root) && typeof head === "number") {
    const copy = [...root]
    copy[head] = setAt(root[head], rest, value)
    return copy
  }
  if (typeof root === "object" && root !== null && typeof head === "string") {
    const record = root as Record<string, unknown>
    return { ...record, [head]: setAt(record[head], rest, value) }
  }
  return root
}

const getAt = (root: unknown, path: JsonPath): unknown => {
  let current = root
  for (const segment of path) {
    if (Array.isArray(current) && typeof segment === "number") current = current[segment]
    else if (typeof current === "object" && current !== null && typeof segment === "string") {
      current = (current as Record<string, unknown>)[segment]
    } else return undefined
  }
  return current
}

/**
 * Replace every known concrete id of `side` inside a string with its symbolic token.
 * Longest ids first so an id that is a prefix of another never clobbers it.
 */
export const replaceKnownIds = (text: string, table: ResourceTable, side: Side): string => {
  let out = text
  for (const { id, resource } of table.knownIds(side)) {
    if (id.length === 0) continue
    out = out.split(id).join(canonicalToken(resource.type, resource.handle))
  }
  return out
}

const mapStrings = (value: unknown, f: (s: string) => string): unknown => {
  if (typeof value === "string") return f(value)
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, f))
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) out[f(key)] = mapStrings(item, f)
    return out
  }
  return value
}

/**
 * Canonicalise a decoded JSON-like value:
 * 1. declared identity locations become `resource:<type>:<handle>` (or `unknown:<type>:<id>`)
 * 2. declared volatile locations become `volatile:<kind>:<json type>`
 * 3. every remaining occurrence of a known id (inside messages, urls, keys…) becomes its token
 *
 * Nothing else is touched: omitted vs null, ordering, numeric vs string all survive.
 */
export const canonicalizeValue = (value: unknown, options: CanonicalizeOptions): unknown => {
  const annotations: Annotation[] = options.schema
    ? annotateValue(options.document, options.schema, value)
    : []
  const seen = new Set<string>()
  let out = value
  for (const annotation of annotations) {
    const key = pathKey(annotation.path)
    if (seen.has(key)) continue
    seen.add(key)
    const current = getAt(out, annotation.path)
    if (annotation.kind === "identity") {
      if (typeof current !== "string") continue
      const resource = options.table.lookup(options.side, annotation.type, current)
      const replacement = resource
        ? canonicalToken(resource.type, resource.handle)
        : unknownToken(annotation.type, current)
      out = setAt(out, annotation.path, replacement)
    } else {
      out = setAt(out, annotation.path, volatileToken(annotation.volatile, current))
    }
  }
  return mapStrings(out, (s) => replaceKnownIds(s, options.table, options.side))
}

const canonicalizeBody = (body: DecodedBody, options: CanonicalizeOptions): CanonicalBody => {
  switch (body.kind) {
    case "empty":
      return { kind: "empty" }
    case "json":
      return { kind: "json", value: canonicalizeValue(body.value, options) }
    case "form":
      return { kind: "form", value: canonicalizeValue(body.value, options) }
    case "text":
      return { kind: "text", value: replaceKnownIds(body.value, options.table, options.side) }
    case "bytes":
      // Provider-rendered PDFs differ in length; presence of bytes is enough.
      return { kind: "bytes" }
    case "invalid":
      return {
        kind: "invalid",
        mediaType: body.mediaType,
        text: replaceKnownIds(body.text, options.table, options.side),
      }
  }
}

/** Canonicalise a whole exchange. Only declared parity headers survive. */
export const canonicalizeExchange = (
  exchange: Exchange,
  options: CanonicalizeOptions,
): CanonicalExchange => {
  const headers: Record<string, string> = {}
  for (const name of [...options.parityHeaders].sort()) {
    const raw = exchange.headers[name.toLowerCase()]
    if (raw !== undefined)
      headers[name.toLowerCase()] = replaceKnownIds(raw, options.table, options.side)
  }
  return { status: exchange.status, headers, body: canonicalizeBody(exchange.body, options) }
}

export type DiscoveredIdentity = { path: JsonPath; type: string; real: string; mock: string }

/**
 * Pair identity locations of two responses to the same command and bind unknown ids as new
 * symbolic resources. Only locations where both sides carry an unbound string are registered;
 * every other combination is left alone so canonicalisation reports it as a difference.
 */
export const discoverIdentities = (
  document: OpenAPIDocument,
  schema: SchemaObject | undefined,
  real: unknown,
  mock: unknown,
  table: ResourceTable,
): DiscoveredIdentity[] => {
  if (!schema) return []
  const realIdentities = new Map<string, { path: JsonPath; type: string; id: string }>()
  for (const annotation of annotateValue(document, schema, real)) {
    if (annotation.kind !== "identity") continue
    const id = getAt(real, annotation.path)
    if (typeof id === "string")
      realIdentities.set(pathKey(annotation.path), {
        path: annotation.path,
        type: annotation.type,
        id,
      })
  }
  const discovered: DiscoveredIdentity[] = []
  for (const annotation of annotateValue(document, schema, mock)) {
    if (annotation.kind !== "identity") continue
    const counterpart = realIdentities.get(pathKey(annotation.path))
    if (!counterpart || counterpart.type !== annotation.type) continue
    const mockId = getAt(mock, annotation.path)
    if (typeof mockId !== "string") continue
    const knownReal = table.lookup("real", counterpart.type, counterpart.id)
    const knownMock = table.lookup("mock", annotation.type, mockId)
    if (knownReal || knownMock) continue
    table.register(annotation.type, { real: counterpart.id, mock: mockId })
    discovered.push({
      path: annotation.path,
      type: annotation.type,
      real: counterpart.id,
      mock: mockId,
    })
  }
  return discovered
}
