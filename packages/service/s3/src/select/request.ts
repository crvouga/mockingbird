/**
 * The `SelectObjectContentRequest` body as MinIO's `s3select.S3Select.UnmarshalXML` decodes it,
 * with its validation order and its error codes and messages.
 */
import { parseSelect, type Select, SelectError } from "./sql.js"

type Element = { name: string; children: Element[]; text: string }

/** Go `encoding/xml` errors are prefixed like this. */
const syntax = (line: number, message: string) =>
  new Error(`XML syntax error on line ${line}: ${message}`)

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", apos: "'", quot: '"' }

/** A small, strict-enough XML reader: elements, text, entities, CDATA, comments. */
const parseXml = (input: string): Element => {
  const source = input.replace(/\r\n?/g, "\n")
  let index = 0
  let line = 1
  const advance = (count: number) => {
    for (let step = 0; step < count; step++) if (source[index + step] === "\n") line++
    index += count
  }
  const decode = (raw: string) =>
    raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);?/g, (match, entity: string) => {
      if (!match.endsWith(";"))
        throw syntax(line, `invalid character entity ${match} (no semicolon)`)
      if (entity.startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16))
      if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10))
      const known = ENTITIES[entity]
      if (known === undefined) throw syntax(line, `invalid character entity ${match}`)
      return known
    })
  const skipMisc = () => {
    for (;;) {
      if (source.startsWith("<?", index)) {
        const end = source.indexOf("?>", index)
        if (end < 0) throw syntax(line, "unexpected EOF")
        advance(end + 2 - index)
      } else if (source.startsWith("<!--", index)) {
        const end = source.indexOf("-->", index)
        if (end < 0) throw syntax(line, "unexpected EOF")
        advance(end + 3 - index)
      } else if (/\s/.test(source[index] ?? "")) advance(1)
      else return
    }
  }
  const nameAt = () => {
    const match = /^[A-Za-z_:][-A-Za-z0-9_:.]*/.exec(source.slice(index, index + 256))
    return match ? match[0] : undefined
  }
  const local = (name: string) => name.slice(name.indexOf(":") + 1)
  const element = (): Element => {
    advance(1) // <
    const name = nameAt()
    if (!name) throw syntax(line, "expected element name after <")
    advance(name.length)
    // Attributes are skipped.
    for (;;) {
      if (index >= source.length) throw syntax(line, "unexpected EOF")
      if (source.startsWith("/>", index)) {
        advance(2)
        return { name: local(name), children: [], text: "" }
      }
      if (source[index] === ">") {
        advance(1)
        break
      }
      if (source[index] === '"' || source[index] === "'") {
        const end = source.indexOf(source[index] as string, index + 1)
        if (end < 0) throw syntax(line, "unexpected EOF")
        advance(end + 1 - index)
      } else advance(1)
    }
    const node: Element = { name: local(name), children: [], text: "" }
    for (;;) {
      if (index >= source.length) throw syntax(line, "unexpected EOF")
      if (source.startsWith("</", index)) {
        advance(2)
        const closing = nameAt()
        if (!closing) throw syntax(line, "expected element name after </")
        advance(closing.length)
        while (/\s/.test(source[index] ?? "")) advance(1)
        if (source[index] !== ">") {
          if (index >= source.length) throw syntax(line, "unexpected EOF")
          throw syntax(line, `invalid characters between </${closing} and >`)
        }
        advance(1)
        if (closing !== name) throw syntax(line, `element <${name}> closed by </${closing}>`)
        return node
      }
      if (source.startsWith("<![CDATA[", index)) {
        const end = source.indexOf("]]>", index)
        if (end < 0) throw syntax(line, "unexpected EOF in CDATA section")
        node.text += source.slice(index + 9, end)
        advance(end + 3 - index)
        continue
      }
      if (source.startsWith("<!--", index) || source.startsWith("<?", index)) {
        skipMisc()
        continue
      }
      if (source[index] === "<") {
        node.children.push(element())
        continue
      }
      const next = source.indexOf("<", index)
      const raw = next < 0 ? source.slice(index) : source.slice(index, next)
      node.text += decode(raw)
      advance(raw.length)
    }
  }
  skipMisc()
  if (index >= source.length) throw new Error("EOF")
  if (source[index] !== "<") throw syntax(line, "unexpected EOF")
  return element()
}

const MALFORMED =
  "The XML provided was not well-formed or did not validate against our published schema. Check the service documentation and try again: "
const malformed = (cause: string) => new SelectError("MalformedXML", MALFORMED + cause)

const runes = (value: string) => [...value].length
const parseBool = (raw: string) => {
  const value = raw.trim()
  if (value === "") return false
  if (["1", "t", "T", "TRUE", "true", "True"].includes(value)) return true
  if (["0", "f", "F", "FALSE", "false", "False"].includes(value)) return false
  throw new Error(`strconv.ParseBool: parsing ${JSON.stringify(value)}: invalid syntax`)
}

export type CsvInput = {
  fileHeaderInfo: "none" | "use" | "ignore"
  recordDelimiter: string
  fieldDelimiter: string
  quoteCharacter: string
  quoteEscapeCharacter: string
  comments: string
  allowQuotedRecordDelimiter: boolean
}
export type CsvOutput = {
  quoteFields: string
  recordDelimiter: string
  fieldDelimiter: string
  quoteCharacter: string
  quoteEscapeCharacter: string
}
export type SelectRequest = {
  expression: string
  statement: Select
  compression: string
  input: { format: "csv"; csv: CsvInput } | { format: "json"; type: string } | { format: "parquet" }
  output: { format: "csv"; csv: CsvOutput } | { format: "json"; recordDelimiter: string }
  progress: boolean
  scanRange?: { start?: number; end?: number }
}

const csvInput = (node: Element): CsvInput => {
  const args: CsvInput = {
    fileHeaderInfo: "none",
    recordDelimiter: "\n",
    fieldDelimiter: ",",
    quoteCharacter: '"',
    quoteEscapeCharacter: '"',
    comments: "#",
    allowQuotedRecordDelimiter: false,
  }
  for (const child of node.children) {
    const value = child.text
    switch (child.name) {
      case "AllowQuotedRecordDelimiter":
        args.allowQuotedRecordDelimiter = parseBool(value)
        break
      case "FileHeaderInfo": {
        const lower = value.toLowerCase()
        if (lower) {
          if (lower !== "none" && lower !== "use" && lower !== "ignore")
            throw new Error("unsupported FileHeaderInfo")
          args.fileHeaderInfo = lower
        }
        break
      }
      case "RecordDelimiter":
        if (value) args.recordDelimiter = value
        break
      case "FieldDelimiter":
        if (value) args.fieldDelimiter = value
        break
      case "QuoteCharacter":
        if (runes(value) > 1) throw new Error(`unsupported QuoteCharacter '${value}'`)
        args.quoteCharacter = value
        break
      case "QuoteEscapeCharacter":
        if (runes(value) > 1) throw new Error(`unsupported QuoteEscapeCharacter '${value}'`)
        args.quoteEscapeCharacter = value || '"'
        break
      case "Comments":
        if (value) args.comments = value
        break
      default:
        throw new Error("unrecognized option")
    }
  }
  return args
}

const csvOutput = (node: Element): CsvOutput => {
  const args: CsvOutput = {
    quoteFields: "asneeded",
    recordDelimiter: "\n",
    fieldDelimiter: ",",
    quoteCharacter: '"',
    quoteEscapeCharacter: '"',
  }
  for (const child of node.children) {
    const value = child.text
    switch (child.name) {
      case "QuoteFields":
        args.quoteFields = value.toLowerCase()
        break
      case "RecordDelimiter":
        args.recordDelimiter = value
        break
      case "FieldDelimiter":
        args.fieldDelimiter = value
        break
      case "QuoteCharacter":
        if (runes(value) > 1) throw new Error(`unsupported QuoteCharacter '${value}'`)
        args.quoteCharacter = value || "\u0000"
        break
      case "QuoteEscapeCharacter":
        if (runes(value) > 1) throw new Error(`unsupported QuoteCharacter '${value}'`)
        args.quoteEscapeCharacter = value || '"'
        break
      default:
        throw new Error("unrecognized option")
    }
  }
  return args
}

const COMPRESSION = ["NONE", "GZIP", "BZIP2", "SNAPPY", "S2", "ZSTD", "LZ4"]
const INVALID_COMPRESSION =
  "The file is not in a supported compression format. GZIP, BZIP2, ZSTD, LZ4, S2 and SNAPPY are supported."
const JSON_TYPE = "The JsonType is invalid. Only DOCUMENT and LINES are supported."

const inputSerialization = (node: Element): SelectRequest["input"] & { compression: string } => {
  let compression = ""
  let csv: CsvInput | undefined
  let json: string | undefined
  let parquet = false
  try {
    for (const child of node.children) {
      if (child.name === "CompressionType") {
        const upper = child.text.toUpperCase()
        const parsed = child.text === "" || upper === "NONE" ? "NONE" : upper
        if (!COMPRESSION.includes(parsed)) throw new Error(INVALID_COMPRESSION)
        compression = parsed
      } else if (child.name === "CSV") csv = csvInput(child)
      else if (child.name === "JSON") {
        const type = child.children.filter((inner) => inner.name === "Type").pop()?.text ?? ""
        const lower = type.toLowerCase()
        if (lower !== "document" && lower !== "lines") throw new Error(JSON_TYPE)
        json = lower
      } else if (child.name === "Parquet") parquet = true
    }
  } catch (error) {
    throw malformed((error as Error).message)
  }
  if (!compression) compression = "NONE"
  let found = 0
  let input: SelectRequest["input"] | undefined
  if (csv) {
    input = { format: "csv", csv }
    found++
  }
  if (json !== undefined) {
    input = { format: "json", type: json }
    found++
  }
  if (parquet) {
    if (compression !== "NONE")
      throw new SelectError(
        "InvalidRequestParameter",
        "The value of a parameter in SelectRequest element is invalid. Check the service API documentation and try again.",
      )
    input = { format: "parquet" }
    found++
  }
  if (found !== 1 || !input)
    throw new SelectError(
      "InvalidDataSource",
      "Invalid data source type. Only CSV, JSON, and Parquet are supported.",
    )
  return { ...input, compression }
}

const outputSerialization = (node: Element): SelectRequest["output"] => {
  let csv: CsvOutput | undefined
  let json: string | undefined
  try {
    for (const child of node.children) {
      if (child.name === "CSV") csv = csvOutput(child)
      else if (child.name === "JSON") {
        const delimiter =
          child.children.filter((inner) => inner.name === "RecordDelimiter").pop()?.text ?? ""
        const length = new TextEncoder().encode(delimiter).length
        if (length > 2) throw new Error(`invalid RecordDelimiter '${delimiter}'`)
        json = length === 0 ? "\n" : delimiter
      }
    }
  } catch (error) {
    throw malformed((error as Error).message)
  }
  if ((csv ? 1 : 0) + (json !== undefined ? 1 : 0) !== 1)
    throw new SelectError(
      "ObjectSerializationConflict",
      "InputSerialization specifies more than one format (CSV, JSON, or Parquet), or OutputSerialization specifies more than one format (CSV or JSON). InputSerialization and OutputSerialization can only specify one format each.",
    )
  return csv ? { format: "csv", csv } : { format: "json", recordDelimiter: json as string }
}

const parseUint = (raw: string) => {
  const value = raw.trim()
  if (!/^\d+$/.test(value))
    throw malformed(`strconv.ParseUint: parsing ${JSON.stringify(value)}: invalid syntax`)
  return Number(value)
}

/**
 * `s3select.NewS3Select`. Throws a `SelectError` for anything MinIO answers with an S3 Select
 * error, or a plain `Error` for the generic (InternalError) failures.
 */
export const parseSelectRequest = (body: string): SelectRequest => {
  let root: Element
  try {
    root = parseXml(body)
  } catch (error) {
    const message = (error as Error).message
    if (message === "EOF") throw new Error("EOF")
    throw malformed(message)
  }
  if (root.name !== "SelectRequest" && root.name !== "SelectObjectContentRequest")
    throw malformed(`expected element type <SelectRequest> but have <${root.name}>`)
  let expression = ""
  let expressionType = ""
  let input: ReturnType<typeof inputSerialization> | undefined
  let output: SelectRequest["output"] | undefined
  let progress = false
  let scanRange: { start?: number; end?: number } | undefined
  for (const child of root.children) {
    switch (child.name) {
      case "Expression":
        expression = child.text
        break
      case "ExpressionType":
        expressionType = child.text
        break
      case "InputSerialization":
        input = inputSerialization(child)
        break
      case "OutputSerialization":
        output = outputSerialization(child)
        break
      case "RequestProgress":
        for (const inner of child.children)
          if (inner.name === "Enabled") {
            try {
              progress = parseBool(inner.text)
            } catch (error) {
              throw malformed((error as Error).message)
            }
          }
        break
      case "ScanRange": {
        scanRange = {}
        for (const inner of child.children) {
          if (inner.name === "Start") scanRange.start = parseUint(inner.text)
          if (inner.name === "End") scanRange.end = parseUint(inner.text)
        }
        break
      }
    }
  }
  const invalidScanRange = () =>
    new SelectError(
      "InvalidRequestParameter",
      "The value of a parameter in ScanRange element is invalid. Check the service API documentation and try again.",
    )
  if (scanRange) {
    if (scanRange.start === undefined && scanRange.end === undefined) throw invalidScanRange()
    if (
      scanRange.start !== undefined &&
      scanRange.end !== undefined &&
      scanRange.start > scanRange.end
    )
      throw invalidScanRange()
  }
  if (expressionType.toLowerCase() !== "sql")
    throw new SelectError(
      "InvalidExpressionType",
      "The ExpressionType is invalid. Only SQL expressions are supported.",
    )
  const missing = () =>
    new SelectError(
      "MissingRequiredParameter",
      "The SelectRequest entity is missing a required parameter. Check the service documentation and try again.",
    )
  if (!input) throw missing()
  if (!output) throw missing()
  const statement = parseSelect(expression)
  const { compression, ...format } = input
  return {
    expression,
    statement,
    compression,
    input: format as SelectRequest["input"],
    output,
    progress,
    ...(scanRange ? { scanRange } : {}),
  }
}
