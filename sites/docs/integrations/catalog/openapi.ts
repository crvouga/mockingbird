import type { Operation } from "../../src/lib/types.ts"

// biome-ignore lint/suspicious/noExplicitAny: OpenAPI documents are untyped JSON here.
type Json = any

const METHODS = ["get", "post", "put", "patch", "delete", "head", "options"] as const
const MAX_DEPTH = 6
const PLACEHOLDER_KEY = "test_key"

/** The descriptions of the security schemes the contract applies, e.g. the expected key format. */
export function authHint(doc: Json): string | null {
  const schemes = doc.components?.securitySchemes ?? {}
  const firstSecured = Object.values<Json>(doc.paths ?? {})
    .flatMap((item) => METHODS.map((m) => item?.[m]))
    .find((op) => op?.security?.length)
  const requirement: Json =
    (doc.security ?? []).find((r: Json) => r && Object.keys(r).length > 0) ??
    firstSecured?.security?.[0]
  if (!requirement) return null
  const hints = Object.keys(requirement)
    .map((name) => resolveRef(doc, schemes[name])?.description)
    .filter((d): d is string => typeof d === "string" && d.trim() !== "")
    .map((d) => d.trim())
  return hints.length > 0 ? hints.join(" ") : null
}

export function extractOperations(
  doc: Json,
  supportedIds: readonly string[],
  headerOverrides: Record<string, string> = {},
): Operation[] {
  const supported = new Set(supportedIds)
  const resolve = (node: Json): Json => resolveRef(doc, node)
  const operations: Operation[] = []

  for (const [path, rawItem] of Object.entries<Json>(doc.paths ?? {})) {
    const item = resolve(rawItem)
    for (const method of METHODS) {
      const op = item?.[method]
      if (!op) continue
      const id: string = op.operationId ?? `${method.toUpperCase()} ${path}`
      const params: Json[] = [...(item.parameters ?? []), ...(op.parameters ?? [])].map(resolve)

      let resolvedPath = path
      const query: string[] = []
      const headers: Record<string, string> = { ...authHeaders(doc, op) }
      for (const p of params) {
        if (!p?.name) continue
        const value = paramExample(doc, p)
        if (p.in === "path" && value !== undefined) {
          resolvedPath = resolvedPath.replace(`{${p.name}}`, encodeURIComponent(String(value)))
        } else if (p.in === "query" && p.required) {
          query.push(`${encodeURIComponent(p.name)}=${encodeURIComponent(String(value ?? ""))}`)
        } else if (
          p.in === "header" &&
          p.required &&
          !/^(authorization|content-type)$/i.test(p.name)
        ) {
          headers[p.name] = String(value ?? "")
        }
      }

      const { contentType, body, bodyNote } = requestBody(doc, resolve(op.requestBody))
      if (contentType) headers["content-type"] = contentType
      for (const [name, value] of Object.entries(headerOverrides))
        headers[name.toLowerCase()] = value

      operations.push({
        id,
        method: method.toUpperCase(),
        path: resolvedPath,
        summary: firstLine(op.summary ?? op.description),
        tag: op.tags?.[0] ?? null,
        supported: supported.has(id),
        contentType,
        body,
        bodyNote,
        query: query.join("&"),
        headers,
        verified: false,
      })
    }
  }
  return operations
}

export function serverOrigin(doc: Json): string | null {
  const url = doc.servers?.[0]?.url
  if (typeof url !== "string") return null
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

function resolveRef(doc: Json, node: Json, seen = 0): Json {
  if (!node || typeof node !== "object" || typeof node.$ref !== "string" || seen > 20) return node
  const ref: string = node.$ref
  if (!ref.startsWith("#/")) return {}
  let target: Json = doc
  for (const part of ref.slice(2).split("/")) {
    target = target?.[part.replace(/~1/g, "/").replace(/~0/g, "~")]
  }
  return resolveRef(doc, target, seen + 1)
}

function firstLine(text: unknown): string | null {
  if (typeof text !== "string") return null
  const line = text.trim().split("\n")[0]?.trim()
  if (!line) return null
  return line.length > 140 ? `${line.slice(0, 137)}…` : line
}

function authHeaders(doc: Json, op: Json): Record<string, string> {
  const requirements: Json[] = op.security ?? doc.security ?? []
  const first = requirements.find((r) => r && Object.keys(r).length > 0)
  if (!first) return {}
  const schemes = doc.components?.securitySchemes ?? {}
  const headers: Record<string, string> = {}
  for (const name of Object.keys(first)) {
    const scheme = resolveRef(doc, schemes[name])
    if (!scheme) continue
    if (scheme.type === "http" && /^basic$/i.test(scheme.scheme)) {
      headers.authorization = `Basic ${btoa(`${PLACEHOLDER_KEY}:`)}`
    } else if (
      scheme.type === "http" ||
      scheme.type === "oauth2" ||
      scheme.type === "openIdConnect"
    ) {
      headers.authorization = `Bearer ${PLACEHOLDER_KEY}`
    } else if (
      scheme.type === "apiKey" &&
      scheme.in === "header" &&
      typeof scheme.name === "string"
    ) {
      headers[scheme.name.toLowerCase()] = PLACEHOLDER_KEY
    }
  }
  return headers
}

function paramExample(doc: Json, param: Json): unknown {
  if (param.example !== undefined) return param.example
  const examples = param.examples && Object.values<Json>(param.examples)[0]
  if (examples) return resolveRef(doc, examples)?.value
  const schema = resolveRef(doc, param.schema)
  if (schema?.example !== undefined) return schema.example
  if (schema?.default !== undefined) return schema.default
  if (Array.isArray(schema?.enum)) return schema.enum[0]
  return param.in === "path" ? undefined : sample(doc, schema, 0)
}

const TEXT_TYPES = /json|x-www-form-urlencoded|^text\//

function requestBody(
  doc: Json,
  rb: Json,
): { contentType: string | null; body: string; bodyNote: string | null } {
  const content: Record<string, Json> = rb?.content ?? {}
  const types = Object.keys(content)
  if (types.length === 0) return { contentType: null, body: "", bodyNote: null }
  const contentType =
    types.find((t) => t === "application/json") ??
    types.find((t) => t === "application/x-www-form-urlencoded") ??
    types.find((t) => TEXT_TYPES.test(t)) ??
    types[0] ??
    null
  if (!contentType) return { contentType: null, body: "", bodyNote: null }
  if (!TEXT_TYPES.test(contentType)) {
    return {
      contentType,
      body: "",
      bodyNote: `This operation takes a ${contentType} body, which the playground cannot compose as text.`,
    }
  }
  const media = content[contentType] ?? {}
  const example =
    media.example ??
    (media.examples ? resolveRef(doc, Object.values<Json>(media.examples)[0])?.value : undefined) ??
    sample(doc, media.schema, 0)
  if (example === undefined) return { contentType, body: "", bodyNote: null }
  if (contentType.includes("x-www-form-urlencoded")) {
    return { contentType, body: formEncode(example), bodyNote: null }
  }
  if (contentType.includes("json")) {
    return { contentType, body: JSON.stringify(example, null, 2), bodyNote: null }
  }
  return {
    contentType,
    body: typeof example === "string" ? example : String(example),
    bodyNote: null,
  }
}

function sample(doc: Json, raw: Json, depth: number, key = ""): unknown {
  const schema = resolveRef(doc, raw)
  if (!schema || typeof schema !== "object" || depth > MAX_DEPTH) return undefined
  if (schema.example !== undefined) return schema.example
  if (Array.isArray(schema.examples) && schema.examples.length > 0) return schema.examples[0]
  if (schema.default !== undefined) return schema.default
  if (schema.const !== undefined) return schema.const
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0]
  if (Array.isArray(schema.allOf)) {
    const parts = schema.allOf.map((s: Json) => sample(doc, s, depth, key))
    if (parts.every((p: unknown) => p && typeof p === "object" && !Array.isArray(p))) {
      return Object.assign({}, ...parts)
    }
    return parts.find((p: unknown) => p !== undefined)
  }
  const variant = schema.oneOf?.[0] ?? schema.anyOf?.[0]
  if (variant) return sample(doc, variant, depth, key)

  const type = Array.isArray(schema.type)
    ? schema.type.find((t: string) => t !== "null")
    : (schema.type ?? (schema.properties ? "object" : undefined))
  switch (type) {
    case "object": {
      const out: Record<string, unknown> = {}
      const properties: Record<string, Json> = schema.properties ?? {}
      const required: string[] = Array.isArray(schema.required) ? schema.required : []
      const keys =
        depth === 0
          ? [
              ...new Set([
                ...required,
                ...likelyFields(doc, properties, required.length === 0 ? 2 : 1),
              ]),
            ]
          : required
      for (const key of keys) {
        const value = sample(doc, properties[key], depth + 1, key)
        if (value !== undefined) out[key] = value
      }
      return out
    }
    case "array": {
      const item = sample(doc, schema.items, depth + 1, key)
      return item === undefined ? [] : [item]
    }
    case "string":
      return stringSample(schema, key)
    case "integer":
    case "number":
      return typeof schema.minimum === "number" ? schema.minimum : 1
    case "boolean":
      return true
    default:
      return undefined
  }
}

const PREFERRED_FIELDS = ["text", "name", "email", "title", "description", "message", "subject"]

/** Scalar fields that make a sample more likely to be accepted: any two when nothing is required, else one well-known field. */
function likelyFields(doc: Json, properties: Record<string, Json>, limit: number): string[] {
  const scalar = Object.keys(properties).filter((key) => {
    const type = resolveRef(doc, properties[key])?.type
    return type === "string" || type === "integer" || type === "number" || type === "boolean"
  })
  const rank = (key: string) => {
    const i = PREFERRED_FIELDS.indexOf(key)
    return i === -1 ? PREFERRED_FIELDS.length : i
  }
  return scalar
    .filter((key) => limit === 2 || PREFERRED_FIELDS.includes(key))
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, limit)
}

function stringSample(schema: Json, key: string): string {
  switch (schema.format) {
    case "email":
      return "ada@example.com"
    case "date-time":
      return "2026-01-01T00:00:00Z"
    case "date":
      return "2026-01-01"
    case "uuid":
      return "00000000-0000-4000-8000-000000000000"
    case "uri":
    case "url":
      return "https://example.com"
  }
  const name = key.toLowerCase()
  if (/e-?mail|^(from|to|reply_?to|cc|bcc)$/.test(name)) return "ada@example.com"
  if (/phone|^to_number$|^from_number$/.test(name)) return "+15555550100"
  if (/url|uri|website|link/.test(name)) return "https://example.com"
  if (/(^|_)date$|birth/.test(name)) return "1990-01-01"
  if (name === "name" || /full_?name/.test(name)) return "Ada Lovelace"
  if (/currency/.test(name)) return "usd"
  return "example"
}

function formEncode(value: unknown, prefix = ""): string {
  const parts: string[] = []
  const walk = (v: unknown, key: string) => {
    if (v === undefined || v === null) return
    if (Array.isArray(v)) {
      for (const [i, item] of v.entries()) walk(item, `${key}[${i}]`)
    } else if (typeof v === "object") {
      for (const [k, inner] of Object.entries(v)) walk(inner, key ? `${key}[${k}]` : k)
    } else parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`)
  }
  walk(value, prefix)
  return parts.join("&").replace(/%5B/g, "[").replace(/%5D/g, "]")
}
