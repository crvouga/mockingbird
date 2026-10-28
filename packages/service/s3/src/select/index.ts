/**
 * S3 Select (`SelectObjectContent`) over a stored object, as MinIO's `internal/s3select` runs it:
 * open (scan range, decompression, CSV header), evaluate row by row in batches of 100 output
 * records, and frame the result as an AWS event stream.
 */
import { S3Error } from "../errors.js"
import { EventStream } from "./eventstream.js"
import { csvRecordJson, parseCsv, parseJsonDocuments, writeCsv } from "./formats.js"
import type { SelectRequest } from "./request.js"
import { Evaluator, type InputRecord, type OutputRecord, RuntimeError, SelectError } from "./sql.js"
import { encodeJson, htmlEscape, JsonObject, type JsonValue, jsonNumber } from "./values.js"

export { parseSelectRequest } from "./request.js"
export { SelectError } from "./sql.js"

const internal = (cause: string) =>
  new S3Error("InternalError", {
    message: `We encountered an internal error, please try again.: cause(${cause})`,
  })

const compressionNotApplicable = (type: string) =>
  new SelectError(
    "InvalidCompressionFormat",
    `${type} is not applicable to the queried object. Please correct the request and try again.`,
  )

const gunzip = async (bytes: Uint8Array): Promise<Uint8Array> => {
  if (bytes.length < 10)
    throw new SelectError(
      "TruncatedInput",
      "Object decompression failed. Check that the object is properly compressed using the format specified in the request.",
    )
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b || bytes[2] !== 8)
    throw compressionNotApplicable("GZIP")
  try {
    const stream = new Blob([bytes as Uint8Array<ArrayBuffer>])
      .stream()
      .pipeThrough(new DecompressionStream("gzip"))
    return new Uint8Array(await new Response(stream).arrayBuffer())
  } catch {
    throw compressionNotApplicable("GZIP")
  }
}

/** The `[offset, end)` window a ScanRange selects, or MinIO's seek error. */
const window = (request: SelectRequest, size: number): [number, number] => {
  const range = request.scanRange
  let offset = 0
  let end = size
  if (range?.start !== undefined && range.end !== undefined) {
    offset = range.start
    end = Math.min(size, range.end + 1)
  } else if (range?.start !== undefined) offset = range.start
  else if (range?.end !== undefined) offset = size - range.end
  if (offset < 0) throw internal("seek to invalid negative offset")
  if (offset >= size) throw internal("seek past end of object")
  return [offset, end]
}

type Opened = { records: InputRecord[]; error?: RuntimeError; scanned: number; processed: number }

const open = async (request: SelectRequest, object: Uint8Array): Promise<Opened> => {
  if (request.input.format === "parquet")
    throw internal("parquet format parsing not enabled on server")
  const [offset, end] = window(request, object.length)
  const raw = object.subarray(offset, end)
  let data: Uint8Array
  switch (request.compression) {
    case "NONE":
      data = raw
      break
    case "GZIP":
      data = await gunzip(raw)
      break
    default:
      throw new S3Error("NotImplemented", {
        message: `${request.compression} decompression is not supported by the emulator`,
      })
  }
  const scanned = raw.length
  const processed = data.length
  if (request.input.format === "json") {
    const { documents, error } = parseJsonDocuments(new TextDecoder().decode(data))
    return {
      records: documents.map((object) => ({ format: "json", object })),
      ...(error ? { error } : {}),
      scanned,
      processed,
    }
  }
  const args = request.input.csv
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data)
  } catch {
    throw new SelectError("InvalidTextEncoding", "UTF-8 encoding is required.")
  }
  if (args.recordDelimiter !== "\n") text = text.split(args.recordDelimiter).join("\n")
  const options = {
    fieldDelimiter: [...args.fieldDelimiter][0] as string,
    comment: [...args.comments][0] as string,
    quote: [...args.quoteCharacter][0] ?? "",
    quoteEscape: [...args.quoteEscapeCharacter][0] as string,
  }
  let names: string[] | undefined
  if (args.fileHeaderInfo !== "none") {
    const newline = text.indexOf("\n")
    if (newline < 0) throw internal("EOF")
    const header = parseCsv(text.slice(0, newline + 1), options)[0]
    if (!header) throw internal("EOF")
    if (args.fileHeaderInfo === "use") names = header
    text = text.slice(newline + 1)
  }
  const rows = parseCsv(text, options)
  const columns = names ?? (rows[0] ?? []).map((_, index) => `_${index + 1}`)
  const index = new Map<string, number>()
  columns.forEach((name, position) => {
    index.set(name, position)
  })
  return {
    records: rows.map((fields) => ({ format: "csv", names: columns, fields, index })),
    scanned,
    processed,
  }
}

const jsonInputCsvFields = (object: JsonObject): string[] =>
  object.kvs.map(([, value]: [string, JsonValue]) => {
    if (value === null) return ""
    if (typeof value === "number") return jsonNumber(value)
    if (typeof value === "string") return value
    if (typeof value === "boolean") return String(value)
    if (value instanceof JsonObject)
      throw new RuntimeError("Cannot marshal unhandled type: jstream.KVS")
    return encodeJson(value)
  })

const marshal = (request: SelectRequest, record: OutputRecord): string => {
  const output = request.output
  if (output.format === "json") {
    if (record.kind === "csv")
      return csvRecordJson(record.names, record.fields) + output.recordDelimiter
    if (record.kind === "json-input") return encodeJson(record.object) + output.recordDelimiter
    return (
      htmlEscape(`{${record.entries.map(([name, value]) => `"${name}":${value}`).join(",")}}`) +
      output.recordDelimiter
    )
  }
  const csv = output.csv
  const fields =
    record.kind === "csv"
      ? record.fields
      : record.kind === "json-input"
        ? jsonInputCsvFields(record.object)
        : record.entries.map(([, value]) => value)
  return (
    writeCsv(fields, {
      fieldDelimiter: [...csv.fieldDelimiter][0] ?? ",",
      quote: [...csv.quoteCharacter][0] ?? '"',
      quoteEscape: [...csv.quoteEscapeCharacter][0] ?? '"',
      always: csv.quoteFields === "always",
    }) + csv.recordDelimiter
  )
}

/** Run a parsed request over the object's bytes; resolves to the event-stream body. */
export const runSelect = async (
  request: SelectRequest,
  object: Uint8Array,
): Promise<Uint8Array> => {
  const opened = await open(request, object)
  const evaluator = new Evaluator(request.statement, request.output.format)
  const stream = new EventStream()
  const encoder = new TextEncoder()
  let queue: OutputRecord[] = []
  const send = () => {
    const text = queue.map((record) => marshal(request, record)).join("")
    queue = []
    stream.send(encoder.encode(text))
  }
  const finish = () => stream.finish(opened.scanned, opened.processed)
  try {
    for (const input of opened.records) {
      if (evaluator.limitReached()) {
        send()
        return finish()
      }
      for (const record of evaluator.from(input)) {
        if (evaluator.isAggregated) {
          evaluator.aggregate(record)
          continue
        }
        const out = evaluator.evaluate(record)
        if (!out) continue
        queue.push(out)
        if (evaluator.limitReached()) {
          send()
          return finish()
        }
        if (queue.length === 100) send()
      }
    }
    if (opened.error) throw opened.error
    if (evaluator.limitReached()) {
      send()
      return finish()
    }
    if (evaluator.isAggregated) queue.push(evaluator.aggregateResult())
    send()
    return finish()
  } catch (error) {
    if (error instanceof RuntimeError) return stream.fail("InternalError", error.message)
    throw error
  }
}
