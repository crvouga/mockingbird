/** S3 Select input readers and output writers: CSV (`minio/csvparser`) and JSON (`jstream`). */
import { RuntimeError } from "./sql.js"
import { htmlEscape, JsonObject, type JsonValue } from "./values.js"

export type CsvReadOptions = {
  fieldDelimiter: string
  comment: string
  /** `""` disables quoting. */
  quote: string
  quoteEscape: string
}

/** `encoding/csv` with `LazyQuotes`, `FieldsPerRecord = -1` and MinIO's quote escape rune. */
export const parseCsv = (text: string, options: CsvReadOptions): string[][] => {
  const records: string[][] = []
  const comma = options.fieldDelimiter
  const quote = options.quote
  const quoteEscape = options.quoteEscape
  let offset = 0
  const readLine = (): string | undefined => {
    if (offset >= text.length) return undefined
    const end = text.indexOf("\n", offset)
    let line = end < 0 ? text.slice(offset) : text.slice(offset, end + 1)
    offset = end < 0 ? text.length : end + 1
    if (line.endsWith("\r\n")) line = `${line.slice(0, -2)}\n`
    else if (end < 0 && line.endsWith("\r")) line = line.slice(0, -1)
    return line
  }
  const lengthNL = (line: string) => (line.endsWith("\n") ? 1 : 0)
  for (;;) {
    let line = readLine()
    if (line === undefined) break
    if (options.comment && line.startsWith(options.comment)) continue
    if (line.length === lengthNL(line)) continue
    const fields: string[] = []
    for (;;) {
      if (!quote || !line.startsWith(quote)) {
        const index = line.indexOf(comma)
        if (index >= 0) {
          fields.push(line.slice(0, index))
          line = line.slice(index + comma.length)
          continue
        }
        fields.push(line.slice(0, line.length - lengthNL(line)))
        break
      }
      // Quoted field.
      line = line.slice(quote.length)
      let field = ""
      let done = false
      for (;;) {
        const quoteAt = line.indexOf(quote)
        const escapeAt = quoteEscape !== quote ? line.indexOf(quoteEscape) : -1
        if (
          escapeAt >= 0 &&
          (quoteAt < 0 || escapeAt < quoteAt) &&
          line.startsWith(quote, escapeAt + quoteEscape.length)
        ) {
          field += line.slice(0, escapeAt) + quote
          line = line.slice(escapeAt + quoteEscape.length + quote.length)
          continue
        }
        if (quoteAt >= 0) {
          field += line.slice(0, quoteAt)
          line = line.slice(quoteAt + quote.length)
          if (quoteEscape === quote && line.startsWith(quote)) {
            field += quote
            line = line.slice(quote.length)
          } else if (line.startsWith(comma)) {
            line = line.slice(comma.length)
            fields.push(field)
            break
          } else if (line.length === lengthNL(line)) {
            fields.push(field)
            done = true
            break
          } else field += quote
          continue
        }
        if (line.length > 0) {
          field += line
          const next = readLine()
          if (next === undefined) {
            fields.push(field)
            done = true
            break
          }
          line = next
          continue
        }
        fields.push(field)
        done = true
        break
      }
      if (done) break
    }
    records.push(fields)
  }
  return records
}

export type CsvWriteOptions = {
  fieldDelimiter: string
  quote: string
  quoteEscape: string
  always: boolean
}

/** `csvparser.Writer.Write` of one record, without the trailing newline. */
export const writeCsv = (fields: string[], options: CsvWriteOptions): string => {
  const { fieldDelimiter: comma, quote, quoteEscape } = options
  const needsQuotes = (field: string) => {
    if (field === "") return false
    if (field === "\\." || /[\r\n]/.test(field) || field.includes(quote) || field.includes(comma))
      return true
    return /^\s/u.test(field)
  }
  return fields
    .map((field) => {
      if (!options.always && !needsQuotes(field)) return field
      let out = quote
      for (const char of field) out += char === quote ? quoteEscape + quote : char
      return out + quote
    })
    .join(comma)
}

/** A stream of JSON values as `jstream` decodes them: objects keep key order, numbers are floats. */
export const parseJsonDocuments = (
  text: string,
): { documents: JsonObject[]; error?: RuntimeError } => {
  const out: JsonObject[] = []
  let index = 0
  const fail = (): never => {
    throw new RuntimeError(
      "Encountered an error parsing the JSON file. Check the file and try again.",
    )
  }
  const space = () => {
    while (index < text.length && /[ \t\r\n]/.test(text[index] as string)) index++
  }
  const value = (): JsonValue => {
    space()
    const char = text[index]
    if (char === "{") {
      index++
      const kvs: [string, JsonValue][] = []
      space()
      if (text[index] === "}") {
        index++
        return new JsonObject(kvs)
      }
      for (;;) {
        space()
        if (text[index] !== '"') fail()
        const key = string()
        space()
        if (text[index] !== ":") fail()
        index++
        kvs.push([key, value()])
        space()
        if (text[index] === ",") {
          index++
          continue
        }
        if (text[index] === "}") {
          index++
          return new JsonObject(kvs)
        }
        fail()
      }
    }
    if (char === "[") {
      index++
      const items: JsonValue[] = []
      space()
      if (text[index] === "]") {
        index++
        return items
      }
      for (;;) {
        items.push(value())
        space()
        if (text[index] === ",") {
          index++
          continue
        }
        if (text[index] === "]") {
          index++
          return items
        }
        fail()
      }
    }
    if (char === '"') return string()
    const literal = /^(true|false|null|-?(0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?)/.exec(
      text.slice(index, index + 400),
    )
    if (!literal) return fail()
    index += (literal[0] as string).length
    const word = literal[0] as string
    if (word === "true") return true
    if (word === "false") return false
    if (word === "null") return null
    return Number(word)
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: JSON forbids raw control characters in strings.
  const STRING = /"(?:[^"\\\u0000-\u001f]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*"/y
  const string = (): string => {
    STRING.lastIndex = index
    const match = STRING.exec(text)
    if (!match) return fail()
    index += (match[0] as string).length
    return JSON.parse(match[0] as string) as string
  }
  try {
    for (;;) {
      space()
      if (index >= text.length) break
      const item = value()
      out.push(item instanceof JsonObject ? item : new JsonObject([["_1", item]]))
    }
  } catch (error) {
    if (error instanceof RuntimeError) return { documents: out, error }
    throw error
  }
  return { documents: out }
}

/** `json.NewEncoder(w).Encode(kvs)` for a CSV record's named fields. */
export const csvRecordJson = (names: string[], fields: string[]) =>
  htmlEscape(
    `{${names
      .slice(0, fields.length)
      .map((name, index) => `"${name}":${JSON.stringify(fields[index])}`)
      .join(",")}}`,
  )
