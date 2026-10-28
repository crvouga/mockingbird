/** S3 Select values: MinIO's `sql.Value` types, JSON documents, and Go's number formatting. */

/** A JSON object with its keys in document order (MinIO's `jstream.KVS`). */
export class JsonObject {
  constructor(readonly kvs: [string, JsonValue][] = []) {}
}
export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[]

/** A SQL value. `bytes` is untyped input (a CSV field, or JSON text of an object). */
export type Value =
  | { k: "null" }
  | { k: "missing" }
  | { k: "bool"; v: boolean }
  | { k: "int"; v: number }
  | { k: "float"; v: number }
  | { k: "string"; v: string }
  | { k: "bytes"; v: string }
  | { k: "array"; v: Value[] }

export const NULL: Value = { k: "null" }
export const MISSING: Value = { k: "missing" }

/** Go's `json.Marshal` of a string (HTML-safe escaping). */
const goString = (value: string) => htmlEscape(JSON.stringify(value))

/** Go's encoder escapes `<`, `>`, `&`, U+2028 and U+2029 everywhere in its output. */
export const htmlEscape = (json: string) =>
  json.replace(/[<>&\u2028\u2029]/g, (char) => {
    switch (char) {
      case "<":
        return "\\u003c"
      case ">":
        return "\\u003e"
      case "&":
        return "\\u0026"
      case "\u2028":
        return "\\u2028"
      default:
        return "\\u2029"
    }
  })

/** Go's `encoding/json` float formatting (ES6 number-to-string, as JavaScript does). */
export const jsonNumber = (value: number) => (Object.is(value, -0) ? "-0" : String(value))

/** `json.Marshal` of a decoded JSON value, keys raw as `jstream.KVS.MarshalJSON` writes them. */
export const encodeJson = (value: JsonValue): string => {
  if (value === null) return "null"
  if (typeof value === "string") return goString(value)
  if (typeof value === "number") return jsonNumber(value)
  if (typeof value === "boolean") return String(value)
  if (Array.isArray(value)) return `[${value.map(encodeJson).join(",")}]`
  return `{${value.kvs.map(([key, inner]) => `"${key}":${encodeJson(inner)}`).join(",")}}`
}

/** `json.Marshal` of a SQL value (`Value.MarshalJSON`: bytes verbatim). */
export const encodeValue = (value: Value): string => {
  switch (value.k) {
    case "null":
    case "missing":
      return "null"
    case "bool":
      return String(value.v)
    case "int":
      return String(value.v)
    case "float":
      return jsonNumber(value.v)
    case "string":
      return goString(value.v)
    case "bytes":
      return value.v
    case "array":
      return `[${value.v.map(encodeValue).join(",")}]`
  }
}

/** `strconv.FormatFloat(value, 'g', -1, 64)`. */
export const goFloatG = (value: number): string => {
  if (Number.isNaN(value)) return "NaN"
  if (value === Number.POSITIVE_INFINITY) return "+Inf"
  if (value === Number.NEGATIVE_INFINITY) return "-Inf"
  if (value === 0) return Object.is(value, -0) ? "-0" : "0"
  const [mantissa, exponent] = value.toExponential().split("e") as [string, string]
  const exp = Number(exponent)
  if (exp < -4 || exp >= 6) {
    const abs = Math.abs(exp)
    return `${mantissa}e${exp < 0 ? "-" : "+"}${abs < 10 ? `0${abs}` : abs}`
  }
  // Plain decimal notation with the shortest digits.
  const digits = mantissa.replace("-", "").replace(".", "")
  const sign = value < 0 ? "-" : ""
  if (exp < 0) return `${sign}0.${"0".repeat(-exp - 1)}${digits}`
  const whole = digits.slice(0, exp + 1).padEnd(exp + 1, "0")
  const fraction = digits.slice(exp + 1)
  return `${sign}${whole}${fraction ? `.${fraction}` : ""}`
}

/** `Value.CSVString`. */
export const csvString = (value: Value): string => {
  switch (value.k) {
    case "null":
    case "missing":
      return ""
    case "bool":
      return value.v ? "true" : "false"
    case "string":
    case "bytes":
      return value.v
    case "int":
      return String(value.v)
    case "float":
      return goFloatG(value.v)
    case "array":
      return htmlEscape(`[${value.v.map(encodeValue).join(",")}]`)
  }
}

/** `jsonToValue`: a decoded JSON value as a SQL value. */
export const fromJson = (value: JsonValue | undefined): Value => {
  if (value === undefined) return MISSING
  if (value === null) return NULL
  if (typeof value === "string") return { k: "string", v: value }
  if (typeof value === "number") return { k: "float", v: value }
  if (typeof value === "boolean") return { k: "bool", v: value }
  if (Array.isArray(value)) return { k: "array", v: value.map(fromJson) }
  return { k: "bytes", v: encodeJson(value) }
}

/** Go's `%#v` of a byte slice, e.g. `[]byte{0x61, 0x62}`. */
export const goBytes = (text: string) =>
  `[]byte{${[...new TextEncoder().encode(text)].map((byte) => `0x${byte.toString(16)}`).join(", ")}}`
