/**
 * The smallest instance of a JSON Schema: what an unscripted structured-output call
 * answers with. The model never generates language here, so a caller's schema
 * (`Output.object`, a forced tool's `inputSchema`, `outputConfig.textFormat`) is the only
 * thing that decides the shape, and the object always validates against it.
 *
 * Handles what zod-to-json-schema, the AI SDK and hand-written tool schemas emit: `type`
 * (including `["string","null"]`), `enum`, `const`, `anyOf`/`oneOf`/`allOf`, `$ref` into
 * `definitions`/`$defs`, required properties, array bounds and `uniqueItems`, string
 * lengths and common formats, and numeric bounds.
 */

type Schema = Record<string, unknown>

const isSchema = (value: unknown): value is Schema =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const FORMATS: Record<string, string> = {
  "date-time": "2026-01-01T00:00:00.000Z",
  date: "2026-01-01",
  time: "00:00:00",
  email: "user@example.com",
  uri: "https://example.com/",
  url: "https://example.com/",
  uuid: "00000000-0000-4000-8000-000000000000",
  ipv4: "127.0.0.1",
}

const resolveRef = (root: Schema, ref: string): Schema | undefined => {
  if (!ref.startsWith("#")) return undefined
  let node: unknown = root
  for (const part of ref.slice(1).split("/").filter(Boolean)) {
    if (!isSchema(node)) return undefined
    node = node[decodeURIComponent(part.replace(/~1/g, "/").replace(/~0/g, "~"))]
  }
  return isSchema(node) ? node : undefined
}

const typesOf = (schema: Schema): string[] => {
  if (Array.isArray(schema.type))
    return schema.type.filter((t): t is string => typeof t === "string")
  if (typeof schema.type === "string") return [schema.type]
  if (isSchema(schema.properties) || Array.isArray(schema.required)) return ["object"]
  if (schema.items !== undefined) return ["array"]
  return []
}

const sampleNumber = (schema: Schema, integer: boolean): number => {
  const min = typeof schema.minimum === "number" ? schema.minimum : undefined
  const exclusiveMin =
    typeof schema.exclusiveMinimum === "number"
      ? schema.exclusiveMinimum
      : schema.exclusiveMinimum === true && min !== undefined
        ? min
        : undefined
  const max = typeof schema.maximum === "number" ? schema.maximum : undefined
  const exclusiveMax =
    typeof schema.exclusiveMaximum === "number" ? schema.exclusiveMaximum : undefined
  let value = 0
  if (exclusiveMin !== undefined)
    value = integer
      ? Math.floor(exclusiveMin) + 1
      : exclusiveMin + (max !== undefined ? Math.min(1, (max - exclusiveMin) / 2) : 1)
  else if (min !== undefined) value = integer ? Math.ceil(min) : min
  else if (max !== undefined && max < 0) value = integer ? Math.floor(max) : max
  else if (exclusiveMax !== undefined && exclusiveMax <= 0)
    value = integer ? Math.ceil(exclusiveMax) - 1 : exclusiveMax - 1
  if (typeof schema.multipleOf === "number" && schema.multipleOf > 0) {
    value = Math.ceil(value / schema.multipleOf) * schema.multipleOf
  }
  return value
}

const sampleString = (schema: Schema): string => {
  const format = typeof schema.format === "string" ? FORMATS[schema.format] : undefined
  let value = format ?? ""
  const min = typeof schema.minLength === "number" ? schema.minLength : 0
  if (!format && typeof schema.pattern === "string") {
    // A pattern we cannot invert: try a few plain candidates before giving up.
    const pattern = new RegExp(schema.pattern)
    value =
      ["x", "a", "A", "0", "a1", "x".repeat(Math.max(1, min))].find((c) => pattern.test(c)) ?? "x"
  }
  while (value.length < min) value += "x"
  if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
    value = value.slice(0, schema.maxLength)
  }
  return value
}

/** A value that validates against `schema` (resolved against `root` for `$ref`s). */
export const sampleSchema = (schema: unknown, root: unknown = schema, depth = 0): unknown => {
  if (!isSchema(schema) || depth > 32) return null
  const rootSchema = isSchema(root) ? root : {}
  if (typeof schema.$ref === "string") {
    return sampleSchema(resolveRef(rootSchema, schema.$ref), rootSchema, depth + 1)
  }
  if ("const" in schema) return schema.const
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0]
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    const merged: Schema = { ...schema }
    delete merged.allOf
    for (const part of schema.allOf) {
      const resolved =
        isSchema(part) && typeof part.$ref === "string" ? resolveRef(rootSchema, part.$ref) : part
      if (!isSchema(resolved)) continue
      for (const [key, value] of Object.entries(resolved)) {
        if (key === "properties" && isSchema(merged.properties) && isSchema(value)) {
          merged.properties = { ...merged.properties, ...value }
        } else if (key === "required" && Array.isArray(merged.required) && Array.isArray(value)) {
          merged.required = [...new Set([...merged.required, ...value])]
        } else merged[key] = value
      }
    }
    return sampleSchema(merged, rootSchema, depth + 1)
  }
  const union = (
    Array.isArray(schema.anyOf)
      ? schema.anyOf
      : Array.isArray(schema.oneOf)
        ? schema.oneOf
        : undefined
  ) as unknown[] | undefined
  if (union && union.length > 0) {
    // Prefer a concrete branch over `null`, so optional-but-nullable fields still read well.
    const concrete = union.find((branch) => !(isSchema(branch) && branch.type === "null"))
    return sampleSchema(concrete ?? union[0], rootSchema, depth + 1)
  }
  const types = typesOf(schema)
  const type = types.find((t) => t !== "null") ?? types[0]
  switch (type) {
    case "object": {
      const properties = isSchema(schema.properties) ? schema.properties : {}
      const required = Array.isArray(schema.required)
        ? schema.required.filter((key): key is string => typeof key === "string")
        : []
      const out: Record<string, unknown> = {}
      for (const key of required)
        out[key] = sampleSchema(properties[key] ?? {}, rootSchema, depth + 1)
      const minProperties = typeof schema.minProperties === "number" ? schema.minProperties : 0
      for (const key of Object.keys(properties)) {
        if (Object.keys(out).length >= minProperties) break
        if (!(key in out)) out[key] = sampleSchema(properties[key], rootSchema, depth + 1)
      }
      return out
    }
    case "array": {
      const min = typeof schema.minItems === "number" ? schema.minItems : 0
      const items = Array.isArray(schema.prefixItems) ? schema.prefixItems : undefined
      const out: unknown[] = []
      for (let i = 0; i < min; i++) {
        const itemSchema =
          items?.[i] ?? (Array.isArray(schema.items) ? schema.items[i] : schema.items)
        let value = sampleSchema(itemSchema ?? {}, rootSchema, depth + 1)
        if (schema.uniqueItems === true && isSchema(itemSchema)) {
          const choices = Array.isArray(itemSchema.enum) ? itemSchema.enum : undefined
          if (choices && choices.length > i) value = choices[i]
          else if (typeof value === "string") value = `${value}${i}`
          else if (typeof value === "number") value = value + i
        }
        out.push(value)
      }
      return out
    }
    case "string":
      return sampleString(schema)
    case "integer":
      return sampleNumber(schema, true)
    case "number":
      return sampleNumber(schema, false)
    case "boolean":
      return false
    case "null":
      return null
    default:
      return {}
  }
}
