/**
 * attributes/: GetObjectAttributes, RestoreObject and SelectObjectContent (S3 Select, with the
 * AWS event-stream response framing decoded and recorded message by message).
 */
import { type Ctx, keyPath, type Res, type Scenario } from "../harness.js"

const XMLNS = 'xmlns="http://s3.amazonaws.com/doc/2006-03-01/"'

/** Decode an `application/vnd.amazon.eventstream` body into readable messages. */
const decodeEvents = (bytes: Uint8Array) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const messages: Record<string, string>[] = []
  let offset = 0
  const decoder = new TextDecoder()
  while (offset + 12 <= bytes.length) {
    const total = view.getUint32(offset)
    const headerLength = view.getUint32(offset + 4)
    let cursor = offset + 12
    const end = cursor + headerLength
    const message: Record<string, string> = {}
    while (cursor < end) {
      const nameLength = bytes[cursor] as number
      const name = decoder.decode(bytes.subarray(cursor + 1, cursor + 1 + nameLength))
      cursor += 1 + nameLength + 1
      const valueLength = view.getUint16(cursor)
      message[name] = decoder.decode(bytes.subarray(cursor + 2, cursor + 2 + valueLength))
      cursor += 2 + valueLength
    }
    message.payload = decoder.decode(bytes.subarray(end, offset + total - 4))
    messages.push(message)
    offset += total
  }
  return messages
}

const recordEvents = (s: Ctx, step: string, res: Res) => {
  if (res.headers.get("content-type") === "application/octet-stream" || res.status === 200)
    s.record(`${step} (events)`, decodeEvents(res.bytes))
}

type SelectOptions = {
  expression: string
  input: string
  output?: string
  extra?: string
  type?: string
}
const selectBody = ({
  expression,
  input,
  output = "<CSV/>",
  extra = "",
  type = "SQL",
}: SelectOptions) =>
  `<?xml version="1.0" encoding="UTF-8"?><SelectObjectContentRequest ${XMLNS}><Expression>${expression.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</Expression><ExpressionType>${type}</ExpressionType><InputSerialization>${input}</InputSerialization><OutputSerialization>${output}</OutputSerialization>${extra}</SelectObjectContentRequest>`

const SELECT_QUERY: [string, string][] = [
  ["select", ""],
  ["select-type", "2"],
]

const select = async (
  s: Ctx,
  step: string,
  bucket: string,
  key: string,
  body: string,
  headers: Record<string, string> = {},
) => {
  const res = await s.req(step, {
    method: "POST",
    path: keyPath(bucket, key),
    query: SELECT_QUERY,
    body,
    headers,
  })
  recordEvents(s, step, res)
  return res
}

const put = (
  s: Ctx,
  bucket: string,
  key: string,
  body: string,
  headers: Record<string, string> = {},
) => s.raw({ method: "PUT", path: keyPath(bucket, key), body, headers })

const attrs = (
  s: Ctx,
  step: string,
  bucket: string,
  key: string,
  headers: Record<string, string>,
  query: Record<string, string> = {},
) =>
  s.req(step, {
    method: "GET",
    path: keyPath(bucket, key),
    query: { attributes: "", ...query },
    headers,
  })

const PEOPLE = "name,age,city\nalice,30,paris\nbob,25,berlin\ncarol,35,rome\ndave,40,oslo\n"
const PEOPLE_JSON_LINES =
  '{"name":"alice","age":30,"city":"paris"}\n{"name":"bob","age":25,"city":"berlin"}\n{"name":"carol","age":35.5,"city":"rome","tags":["a","b"]}\n'

export const scenarios: Scenario[] = [
  // ── GetObjectAttributes ────────────────────────────────────────────────────
  {
    name: "attributes-each-value",
    async run(s) {
      const b = await s.bucket("attrs")
      await put(s, b, "k", "hello world")
      for (const value of ["ETag", "ObjectSize", "StorageClass", "Checksum", "ObjectParts"])
        await attrs(s, value, b, "k", { "x-amz-object-attributes": value })
      await attrs(s, "all", b, "k", {
        "x-amz-object-attributes": "ETag,Checksum,ObjectParts,StorageClass,ObjectSize",
      })
      await attrs(s, "duplicates", b, "k", { "x-amz-object-attributes": "ETag,ETag,,ObjectSize," })
      await attrs(s, "trimmed", b, "k", { "x-amz-object-attributes": "  ETag,ObjectSize  " })
    },
  },
  {
    name: "attributes-errors",
    async run(s) {
      const b = await s.bucket("attrs-err")
      await put(s, b, "k", "abc")
      await attrs(s, "no header", b, "k", {})
      await attrs(s, "empty header", b, "k", { "x-amz-object-attributes": "" })
      await attrs(s, "only commas", b, "k", { "x-amz-object-attributes": ",," })
      await attrs(s, "unknown", b, "k", { "x-amz-object-attributes": "Foo" })
      await attrs(s, "lowercase", b, "k", { "x-amz-object-attributes": "etag" })
      await attrs(s, "space inside", b, "k", { "x-amz-object-attributes": "ETag, ObjectSize" })
      await attrs(s, "bad max-parts", b, "k", {
        "x-amz-object-attributes": "ObjectParts",
        "x-amz-max-parts": "abc",
      })
      await attrs(s, "bad marker", b, "k", {
        "x-amz-object-attributes": "ObjectParts",
        "x-amz-part-number-marker": "1.5",
      })
      await attrs(s, "bad attr and bad max-parts", b, "k", {
        "x-amz-object-attributes": "Nope",
        "x-amz-max-parts": "x",
      })
      await attrs(s, "missing key", b, "nope", { "x-amz-object-attributes": "ETag" })
      await attrs(s, "missing bucket", s.name("attrs-none"), "k", {
        "x-amz-object-attributes": "ETag",
      })
      await attrs(
        s,
        "bad version id",
        b,
        "k",
        { "x-amz-object-attributes": "ETag" },
        { versionId: "abc" },
      )
      await attrs(
        s,
        "null version id",
        b,
        "k",
        { "x-amz-object-attributes": "ETag" },
        { versionId: "null" },
      )
      await attrs(
        s,
        "uuid version id",
        b,
        "k",
        { "x-amz-object-attributes": "ETag" },
        { versionId: "c3a5c3f6-3e3a-4b89-a4d8-2c9b0f1d5e6a" },
      )
    },
  },
  {
    name: "attributes-parts-headers-on-simple-object",
    async run(s) {
      const b = await s.bucket("attrs-sp")
      await put(s, b, "k", "abc")
      const h = { "x-amz-object-attributes": "ObjectParts" }
      await attrs(s, "max-parts 1", b, "k", { ...h, "x-amz-max-parts": "1" })
      await attrs(s, "max-parts 0", b, "k", { ...h, "x-amz-max-parts": "0" })
      await attrs(s, "max-parts -1", b, "k", { ...h, "x-amz-max-parts": "-1" })
      await attrs(s, "max-parts -5", b, "k", { ...h, "x-amz-max-parts": "-5" })
      await attrs(s, "marker 3", b, "k", { ...h, "x-amz-part-number-marker": "3" })
      await attrs(s, "marker -1", b, "k", { ...h, "x-amz-part-number-marker": "-1" })
      await attrs(s, "padded", b, "k", { ...h, "x-amz-max-parts": " 7 " })
    },
  },
  {
    name: "attributes-checksums",
    async run(s) {
      const b = await s.bucket("attrs-ck")
      await put(s, b, "sha", "hello", {
        "x-amz-checksum-sha256": "LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=",
      })
      await put(s, b, "crc", "hello", { "x-amz-checksum-crc32": "NhCmhg==" })
      await attrs(s, "sha256", b, "sha", { "x-amz-object-attributes": "Checksum,ETag" })
      await attrs(s, "crc32", b, "crc", { "x-amz-object-attributes": "Checksum" })
    },
  },
  {
    name: "attributes-content-type-and-meta",
    async run(s) {
      const b = await s.bucket("attrs-ct")
      await put(s, b, "k", "data", {
        "content-type": "text/plain",
        "x-amz-meta-a": "1",
        "cache-control": "no-cache",
        "x-amz-storage-class": "STANDARD",
      })
      await attrs(s, "attrs", b, "k", { "x-amz-object-attributes": "ETag,StorageClass,ObjectSize" })
      await put(s, b, "rr", "data", { "x-amz-storage-class": "REDUCED_REDUNDANCY" })
      await attrs(s, "reduced redundancy", b, "rr", { "x-amz-object-attributes": "StorageClass" })
      await put(s, b, "empty", "")
      await attrs(s, "empty object", b, "empty", { "x-amz-object-attributes": "ETag,ObjectSize" })
    },
  },
  {
    name: "attributes-unicode-key",
    async run(s) {
      const b = await s.bucket("attrs-uni")
      await put(s, b, "dir/ünï cødé & <x>.txt", "x")
      await attrs(s, "attrs", b, "dir/ünï cødé & <x>.txt", {
        "x-amz-object-attributes": "ObjectSize",
      })
      await attrs(s, "missing", b, "dir/ünï cødé & <y>.txt", {
        "x-amz-object-attributes": "ObjectSize",
      })
    },
  },
  {
    name: "attributes-conditional",
    async run(s) {
      const b = await s.bucket("attrs-cond")
      const created = await put(s, b, "k", "abc")
      const etag = created.headers.get("etag") ?? ""
      const h = { "x-amz-object-attributes": "ETag" }
      await attrs(s, "if-match ok", b, "k", { ...h, "if-match": etag })
      await attrs(s, "if-match bad", b, "k", { ...h, "if-match": '"0000"' })
      await attrs(s, "if-none-match hit", b, "k", { ...h, "if-none-match": etag })
      await attrs(s, "if-none-match miss", b, "k", { ...h, "if-none-match": '"0000"' })
      await attrs(s, "if-modified-since future", b, "k", {
        ...h,
        "if-modified-since": "Tue, 01 Jan 2999 00:00:00 GMT",
      })
      await attrs(s, "if-unmodified-since past", b, "k", {
        ...h,
        "if-unmodified-since": "Mon, 01 Jan 2001 00:00:00 GMT",
      })
    },
  },
  {
    name: "attributes-versioned",
    async run(s) {
      const b = await s.bucket("attrs-ver", { versioning: "Enabled" })
      const first = await put(s, b, "k", "one")
      await put(s, b, "k", "second")
      const v1 = first.headers.get("x-amz-version-id") ?? ""
      const h = { "x-amz-object-attributes": "ETag,ObjectSize" }
      await attrs(s, "latest", b, "k", h)
      await attrs(s, "by version", b, "k", h, { versionId: v1 })
      await attrs(s, "unknown uuid", b, "k", h, {
        versionId: "c3a5c3f6-3e3a-4b89-a4d8-2c9b0f1d5e6a",
      })
      const marker = await s.raw({ method: "DELETE", path: keyPath(b, "k") })
      await attrs(s, "latest is delete marker", b, "k", h)
      await attrs(s, "delete marker by version", b, "k", h, {
        versionId: marker.headers.get("x-amz-version-id") ?? "",
      })
    },
  },
  {
    name: "attributes-suspended",
    async run(s) {
      const b = await s.bucket("attrs-sus", { versioning: "Suspended" })
      await put(s, b, "k", "one")
      await attrs(s, "latest", b, "k", { "x-amz-object-attributes": "ETag" })
      await attrs(s, "null", b, "k", { "x-amz-object-attributes": "ETag" }, { versionId: "null" })
    },
  },
  {
    name: "attributes-multipart",
    async run(s) {
      const b = await s.bucket("attrs-mp")
      const created = await s.raw({
        method: "POST",
        path: keyPath(b, "big"),
        query: { uploads: "" },
      })
      const uploadId = created.tag("UploadId") ?? ""
      const parts = ["a".repeat(5 * 1024 * 1024), "b".repeat(5 * 1024 * 1024), "tail"]
      const etags: string[] = []
      for (let index = 0; index < parts.length; index++) {
        const res = await s.raw({
          method: "PUT",
          path: keyPath(b, "big"),
          query: { partNumber: String(index + 1), uploadId },
          body: parts[index] as string,
        })
        etags.push(res.headers.get("etag") ?? "")
      }
      await s.raw({
        method: "POST",
        path: keyPath(b, "big"),
        query: { uploadId },
        body: `<CompleteMultipartUpload>${etags
          .map(
            (etag, index) =>
              `<Part><PartNumber>${index + 1}</PartNumber><ETag>${etag}</ETag></Part>`,
          )
          .join("")}</CompleteMultipartUpload>`,
      })
      const h = { "x-amz-object-attributes": "ObjectParts" }
      await attrs(s, "all parts", b, "big", {
        "x-amz-object-attributes": "ETag,ObjectParts,ObjectSize",
      })
      await attrs(s, "max-parts 1", b, "big", { ...h, "x-amz-max-parts": "1" })
      await attrs(s, "max-parts 2", b, "big", { ...h, "x-amz-max-parts": "2" })
      await attrs(s, "marker 1", b, "big", { ...h, "x-amz-part-number-marker": "1" })
      await attrs(s, "marker 1 max 1", b, "big", {
        ...h,
        "x-amz-part-number-marker": "1",
        "x-amz-max-parts": "1",
      })
      await attrs(s, "marker 3", b, "big", { ...h, "x-amz-part-number-marker": "3" })
      await attrs(s, "marker 9", b, "big", { ...h, "x-amz-part-number-marker": "9" })
      await attrs(s, "max-parts -1", b, "big", { ...h, "x-amz-max-parts": "-1" })
    },
  },

  // ── RestoreObject ──────────────────────────────────────────────────────────
  {
    name: "restore-not-transitioned",
    async run(s) {
      const b = await s.bucket("restore")
      await put(s, b, "k", "abc")
      const body = `<RestoreRequest ${XMLNS}><Days>1</Days></RestoreRequest>`
      const restore = (
        step: string,
        key: string,
        payload: string | undefined,
        query: Record<string, string> = {},
        bucket = b,
      ) =>
        s.req(step, {
          method: "POST",
          path: keyPath(bucket, key),
          query: { restore: "", ...query },
          ...(payload === undefined ? {} : { body: payload }),
        })
      await restore("days", "k", body)
      await restore("empty body", "k", undefined)
      await restore("malformed body", "k", "<RestoreRequest><Days>")
      await restore(
        "select type",
        "k",
        `<RestoreRequest ${XMLNS}><Type>SELECT</Type></RestoreRequest>`,
      )
      await restore("missing key", "nope", body)
      await restore("missing key empty body", "nope", undefined)
      await restore("missing bucket", "k", body, {}, s.name("restore-none"))
      await restore("bad version", "k", body, { versionId: "abc" })
      await restore("uuid version unversioned", "k", body, {
        versionId: "c3a5c3f6-3e3a-4b89-a4d8-2c9b0f1d5e6a",
      })
      await restore("null version", "k", body, { versionId: "null" })
    },
  },
  {
    name: "restore-versioned",
    async run(s) {
      const b = await s.bucket("restore-ver", { versioning: "Enabled" })
      const first = await put(s, b, "k", "abc")
      const body = `<RestoreRequest ${XMLNS}><Days>1</Days></RestoreRequest>`
      await s.req("by version", {
        method: "POST",
        path: keyPath(b, "k"),
        query: { restore: "", versionId: first.headers.get("x-amz-version-id") ?? "" },
        body,
      })
      await s.req("unknown version", {
        method: "POST",
        path: keyPath(b, "k"),
        query: { restore: "", versionId: "c3a5c3f6-3e3a-4b89-a4d8-2c9b0f1d5e6a" },
        body,
      })
      await s.raw({ method: "DELETE", path: keyPath(b, "k") })
      await s.req("delete marker", {
        method: "POST",
        path: keyPath(b, "k"),
        query: { restore: "" },
        body,
      })
    },
  },

  // ── SelectObjectContent: CSV ───────────────────────────────────────────────
  {
    name: "select-csv-basics",
    async run(s) {
      const b = await s.bucket("sel-csv")
      await put(s, b, "people.csv", PEOPLE)
      const input = "<CSV><FileHeaderInfo>USE</FileHeaderInfo></CSV>"
      await select(
        s,
        "select all none",
        b,
        "people.csv",
        selectBody({ expression: "SELECT * FROM S3Object", input: "<CSV/>" }),
      )
      await select(
        s,
        "select all use",
        b,
        "people.csv",
        selectBody({ expression: "SELECT * FROM S3Object", input }),
      )
      await select(
        s,
        "select all ignore",
        b,
        "people.csv",
        selectBody({
          expression: "select * from s3object",
          input: "<CSV><FileHeaderInfo>IGNORE</FileHeaderInfo></CSV>",
        }),
      )
      await select(
        s,
        "positional",
        b,
        "people.csv",
        selectBody({ expression: "SELECT s._1, s._3 FROM S3Object s", input: "<CSV/>" }),
      )
      await select(
        s,
        "named",
        b,
        "people.csv",
        selectBody({ expression: "SELECT s.name, s.city FROM S3Object s", input }),
      )
      await select(
        s,
        "bare names",
        b,
        "people.csv",
        selectBody({ expression: "SELECT name FROM S3Object", input }),
      )
      await select(
        s,
        "where number",
        b,
        "people.csv",
        selectBody({ expression: "SELECT s.name FROM S3Object s WHERE s.age > 28", input }),
      )
      await select(
        s,
        "where string",
        b,
        "people.csv",
        selectBody({ expression: "SELECT * FROM S3Object s WHERE s.city = 'rome'", input }),
      )
      await select(
        s,
        "where and or",
        b,
        "people.csv",
        selectBody({
          expression:
            "SELECT s.name FROM S3Object s WHERE (s.age >= 30 AND s.age <= 35) OR s.name = 'dave'",
          input,
        }),
      )
      await select(
        s,
        "where not equal",
        b,
        "people.csv",
        selectBody({
          expression: "SELECT s.name FROM S3Object s WHERE s.city <> 'paris' AND s.city != 'oslo'",
          input,
        }),
      )
      await select(
        s,
        "where less",
        b,
        "people.csv",
        selectBody({ expression: "SELECT s.name, s.age FROM S3Object s WHERE s.age < 35", input }),
      )
      await select(
        s,
        "limit",
        b,
        "people.csv",
        selectBody({ expression: "SELECT * FROM S3Object LIMIT 2", input }),
      )
      await select(
        s,
        "limit 0",
        b,
        "people.csv",
        selectBody({ expression: "SELECT * FROM S3Object LIMIT 0", input }),
      )
      await select(
        s,
        "where limit",
        b,
        "people.csv",
        selectBody({ expression: "SELECT s.name FROM S3Object s WHERE s.age > 26 LIMIT 1", input }),
      )
      await select(
        s,
        "count",
        b,
        "people.csv",
        selectBody({ expression: "SELECT COUNT(*) FROM S3Object", input }),
      )
      await select(
        s,
        "count where",
        b,
        "people.csv",
        selectBody({ expression: "SELECT count(*) FROM S3Object s WHERE s.age > 30", input }),
      )
      await select(
        s,
        "count none header",
        b,
        "people.csv",
        selectBody({ expression: "SELECT COUNT(*) FROM S3Object", input: "<CSV/>" }),
      )
      await select(
        s,
        "alias",
        b,
        "people.csv",
        selectBody({
          expression: "SELECT s.name AS who FROM S3Object s",
          input,
          output: "<JSON/>",
        }),
      )
      await select(
        s,
        "missing column",
        b,
        "people.csv",
        selectBody({ expression: "SELECT s._9 FROM S3Object s", input: "<CSV/>" }),
      )
      await select(
        s,
        "no match",
        b,
        "people.csv",
        selectBody({ expression: "SELECT * FROM S3Object s WHERE s.age > 100", input }),
      )
    },
  },
  {
    name: "select-csv-output-formats",
    async run(s) {
      const b = await s.bucket("sel-out")
      await put(s, b, "q.csv", 'a,b\n"x,1","say ""hi"""\nplain,\n')
      const input = "<CSV><FileHeaderInfo>USE</FileHeaderInfo></CSV>"
      await select(
        s,
        "json output",
        b,
        "q.csv",
        selectBody({ expression: "SELECT * FROM S3Object", input, output: "<JSON/>" }),
      )
      await select(
        s,
        "json output none",
        b,
        "q.csv",
        selectBody({ expression: "SELECT * FROM S3Object", input: "<CSV/>", output: "<JSON/>" }),
      )
      await select(
        s,
        "json delimiter",
        b,
        "q.csv",
        selectBody({
          expression: "SELECT s.a FROM S3Object s",
          input,
          output: "<JSON><RecordDelimiter>;</RecordDelimiter></JSON>",
        }),
      )
      await select(
        s,
        "csv as needed",
        b,
        "q.csv",
        selectBody({ expression: "SELECT * FROM S3Object", input }),
      )
      await select(
        s,
        "csv always",
        b,
        "q.csv",
        selectBody({
          expression: "SELECT * FROM S3Object",
          input,
          output: "<CSV><QuoteFields>ALWAYS</QuoteFields></CSV>",
        }),
      )
      await select(
        s,
        "csv delimiters",
        b,
        "q.csv",
        selectBody({
          expression: "SELECT * FROM S3Object",
          input,
          output:
            "<CSV><FieldDelimiter>|</FieldDelimiter><RecordDelimiter>\r\n</RecordDelimiter></CSV>",
        }),
      )
      await select(
        s,
        "csv crlf entity",
        b,
        "q.csv",
        selectBody({
          expression: "SELECT s.a FROM S3Object s",
          input,
          output: "<CSV><RecordDelimiter>&#13;&#10;</RecordDelimiter></CSV>",
        }),
      )
      await select(
        s,
        "csv quote char",
        b,
        "q.csv",
        selectBody({
          expression: "SELECT * FROM S3Object",
          input,
          output: "<CSV><QuoteCharacter>'</QuoteCharacter><QuoteFields>ALWAYS</QuoteFields></CSV>",
        }),
      )
    },
  },
  {
    name: "select-csv-input-options",
    async run(s) {
      const b = await s.bucket("sel-in")
      await put(s, b, "semi.csv", "a;b\n1;2\n#skip;me\n3;4")
      await put(s, b, "crlf.csv", "a,b\r\n1,2\r\n3,4\r\n")
      await put(s, b, "pipe.csv", "a,b|1,2|3,4|")
      await select(
        s,
        "field delimiter",
        b,
        "semi.csv",
        selectBody({
          expression: "SELECT * FROM S3Object",
          input: "<CSV><FieldDelimiter>;</FieldDelimiter></CSV>",
        }),
      )
      await select(
        s,
        "comments off",
        b,
        "semi.csv",
        selectBody({
          expression: "SELECT * FROM S3Object",
          input: "<CSV><FieldDelimiter>;</FieldDelimiter><Comments>%</Comments></CSV>",
        }),
      )
      await select(
        s,
        "crlf",
        b,
        "crlf.csv",
        selectBody({
          expression: "SELECT * FROM S3Object",
          input: "<CSV><FileHeaderInfo>USE</FileHeaderInfo></CSV>",
          output: "<JSON/>",
        }),
      )
      await select(
        s,
        "record delimiter",
        b,
        "pipe.csv",
        selectBody({
          expression: "SELECT * FROM S3Object",
          input:
            "<CSV><RecordDelimiter>|</RecordDelimiter><FileHeaderInfo>USE</FileHeaderInfo></CSV>",
          output: "<JSON/>",
        }),
      )
      await select(
        s,
        "progress enabled",
        b,
        "crlf.csv",
        selectBody({
          expression: "SELECT * FROM S3Object",
          input: "<CSV/>",
          extra: "<RequestProgress><Enabled>true</Enabled></RequestProgress>",
        }),
      )
      await select(
        s,
        "compression none",
        b,
        "crlf.csv",
        selectBody({
          expression: "SELECT * FROM S3Object",
          input: "<CompressionType>NONE</CompressionType><CSV/>",
        }),
      )
    },
  },
  {
    name: "select-empty-object",
    async run(s) {
      const b = await s.bucket("sel-empty")
      await put(s, b, "empty.csv", "")
      await put(s, b, "header.csv", "a,b\n")
      await select(
        s,
        "empty",
        b,
        "empty.csv",
        selectBody({ expression: "SELECT * FROM S3Object", input: "<CSV/>" }),
      )
      await select(
        s,
        "header only",
        b,
        "header.csv",
        selectBody({
          expression: "SELECT * FROM S3Object",
          input: "<CSV><FileHeaderInfo>USE</FileHeaderInfo></CSV>",
        }),
      )
      await select(
        s,
        "header only count",
        b,
        "header.csv",
        selectBody({
          expression: "SELECT COUNT(*) FROM S3Object",
          input: "<CSV><FileHeaderInfo>USE</FileHeaderInfo></CSV>",
        }),
      )
    },
  },

  // ── SelectObjectContent: JSON ──────────────────────────────────────────────
  {
    name: "select-json",
    async run(s) {
      const b = await s.bucket("sel-json")
      await put(s, b, "p.jsonl", PEOPLE_JSON_LINES)
      await put(s, b, "doc.json", '{"name":"x","n":1}\n{"name":"y","n":2.25}')
      const lines = "<JSON><Type>LINES</Type></JSON>"
      await select(
        s,
        "lines all json",
        b,
        "p.jsonl",
        selectBody({ expression: "SELECT * FROM S3Object", input: lines, output: "<JSON/>" }),
      )
      await select(
        s,
        "lines all csv",
        b,
        "p.jsonl",
        selectBody({ expression: "SELECT * FROM S3Object", input: lines, output: "<CSV/>" }),
      )
      await select(
        s,
        "projection json",
        b,
        "p.jsonl",
        selectBody({
          expression: "SELECT s.name, s.age FROM S3Object s",
          input: lines,
          output: "<JSON/>",
        }),
      )
      await select(
        s,
        "projection csv",
        b,
        "p.jsonl",
        selectBody({ expression: "SELECT s.name, s.age FROM S3Object s", input: lines }),
      )
      await select(
        s,
        "where",
        b,
        "p.jsonl",
        selectBody({
          expression: "SELECT s.name FROM S3Object s WHERE s.age > 26",
          input: lines,
          output: "<JSON/>",
        }),
      )
      await select(
        s,
        "where string",
        b,
        "p.jsonl",
        selectBody({
          expression: "SELECT * FROM S3Object s WHERE s.city = 'berlin'",
          input: lines,
          output: "<JSON/>",
        }),
      )
      await select(
        s,
        "missing field",
        b,
        "p.jsonl",
        selectBody({
          expression: "SELECT s.tags FROM S3Object s",
          input: lines,
          output: "<JSON/>",
        }),
      )
      await select(
        s,
        "count",
        b,
        "p.jsonl",
        selectBody({
          expression: "SELECT COUNT(*) FROM S3Object",
          input: lines,
          output: "<JSON/>",
        }),
      )
      await select(
        s,
        "limit",
        b,
        "p.jsonl",
        selectBody({
          expression: "SELECT s.name FROM S3Object s LIMIT 1",
          input: lines,
          output: "<JSON/>",
        }),
      )
      await select(
        s,
        "document",
        b,
        "doc.json",
        selectBody({
          expression: "SELECT * FROM S3Object",
          input: "<JSON><Type>DOCUMENT</Type></JSON>",
          output: "<JSON/>",
        }),
      )
      await select(
        s,
        "document csv",
        b,
        "doc.json",
        selectBody({
          expression: "SELECT s.n FROM S3Object s",
          input: "<JSON><Type>document</Type></JSON>",
        }),
      )
    },
  },

  // ── SelectObjectContent: errors ────────────────────────────────────────────
  {
    name: "select-request-errors",
    async run(s) {
      const b = await s.bucket("sel-err")
      await put(s, b, "k.csv", "a,b\n1,2\n")
      const all = "SELECT * FROM S3Object"
      const csv = "<CSV/>"
      await select(
        s,
        "expression type",
        b,
        "k.csv",
        selectBody({ expression: all, input: csv, type: "XPATH" }),
      )
      await select(
        s,
        "lower expression type",
        b,
        "k.csv",
        selectBody({ expression: all, input: csv, type: "sql" }),
      )
      await select(
        s,
        "no input",
        b,
        "k.csv",
        `<SelectObjectContentRequest><Expression>${all}</Expression><ExpressionType>SQL</ExpressionType><OutputSerialization><CSV/></OutputSerialization></SelectObjectContentRequest>`,
      )
      await select(
        s,
        "no output",
        b,
        "k.csv",
        `<SelectObjectContentRequest><Expression>${all}</Expression><ExpressionType>SQL</ExpressionType><InputSerialization><CSV/></InputSerialization></SelectObjectContentRequest>`,
      )
      await select(
        s,
        "two inputs",
        b,
        "k.csv",
        selectBody({ expression: all, input: "<CSV/><JSON><Type>LINES</Type></JSON>" }),
      )
      await select(
        s,
        "no input format",
        b,
        "k.csv",
        selectBody({ expression: all, input: "<CompressionType>NONE</CompressionType>" }),
      )
      await select(
        s,
        "two outputs",
        b,
        "k.csv",
        selectBody({ expression: all, input: csv, output: "<CSV/><JSON/>" }),
      )
      await select(
        s,
        "empty output",
        b,
        "k.csv",
        selectBody({ expression: all, input: csv, output: "" }),
      )
      await select(
        s,
        "bad compression",
        b,
        "k.csv",
        selectBody({ expression: all, input: "<CompressionType>ZIP</CompressionType><CSV/>" }),
      )
      await select(
        s,
        "gzip on plain",
        b,
        "k.csv",
        selectBody({ expression: all, input: "<CompressionType>GZIP</CompressionType><CSV/>" }),
      )
      await select(
        s,
        "bad json type",
        b,
        "k.csv",
        selectBody({ expression: all, input: "<JSON><Type>XML</Type></JSON>" }),
      )
      await select(s, "json no type", b, "k.csv", selectBody({ expression: all, input: "<JSON/>" }))
      await select(
        s,
        "bad header info",
        b,
        "k.csv",
        selectBody({ expression: all, input: "<CSV><FileHeaderInfo>MAYBE</FileHeaderInfo></CSV>" }),
      )
      await select(
        s,
        "unknown csv option",
        b,
        "k.csv",
        selectBody({ expression: all, input: "<CSV><Foo>1</Foo></CSV>" }),
      )
      await select(
        s,
        "long quote char",
        b,
        "k.csv",
        selectBody({ expression: all, input: "<CSV><QuoteCharacter>ab</QuoteCharacter></CSV>" }),
      )
      await select(s, "parquet", b, "k.csv", selectBody({ expression: all, input: "<Parquet/>" }))
      await select(
        s,
        "parquet gzip",
        b,
        "k.csv",
        selectBody({ expression: all, input: "<CompressionType>GZIP</CompressionType><Parquet/>" }),
      )
      await select(
        s,
        "scan range reversed",
        b,
        "k.csv",
        selectBody({
          expression: all,
          input: csv,
          extra: "<ScanRange><Start>5</Start><End>1</End></ScanRange>",
        }),
      )
      await select(
        s,
        "scan range empty",
        b,
        "k.csv",
        selectBody({ expression: all, input: csv, extra: "<ScanRange></ScanRange>" }),
      )
      await select(s, "malformed xml", b, "k.csv", "<SelectObjectContentRequest><Expression>")
      await select(s, "wrong root", b, "k.csv", "<Foo></Foo>")
      await select(
        s,
        "bad table",
        b,
        "k.csv",
        selectBody({ expression: "SELECT * FROM t", input: csv }),
      )
      await select(
        s,
        "negative limit",
        b,
        "k.csv",
        selectBody({ expression: "SELECT * FROM S3Object LIMIT -1", input: csv }),
      )
    },
  },
  {
    name: "select-http-errors",
    async run(s) {
      const b = await s.bucket("sel-http")
      await put(s, b, "k.csv", "a,b\n1,2\n")
      const body = selectBody({ expression: "SELECT * FROM S3Object", input: "<CSV/>" })
      await select(s, "missing key", b, "nope.csv", body)
      await select(s, "missing bucket", s.name("sel-none"), "k.csv", body)
      await select(s, "range header", b, "k.csv", body, { range: "bytes=0-1" })
      await s.req("empty body", { method: "POST", path: keyPath(b, "k.csv"), query: SELECT_QUERY })
      await s.req("missing select-type", {
        method: "POST",
        path: keyPath(b, "k.csv"),
        query: { select: "" },
        body,
      })
      await s.req("select-type 1", {
        method: "POST",
        path: keyPath(b, "k.csv"),
        query: { select: "", "select-type": "1" },
        body,
      })
      await select(s, "sse header", b, "k.csv", body, { "x-amz-server-side-encryption": "AES256" })
    },
  },
  {
    name: "select-versioned",
    async run(s) {
      const b = await s.bucket("sel-ver", { versioning: "Enabled" })
      const first = await put(s, b, "k.csv", "a\n1\n")
      await put(s, b, "k.csv", "a\n2\n")
      const body = selectBody({ expression: "SELECT * FROM S3Object", input: "<CSV/>" })
      await s.req("by version", {
        method: "POST",
        path: keyPath(b, "k.csv"),
        query: [...SELECT_QUERY, ["versionId", first.headers.get("x-amz-version-id") ?? ""]],
        body,
      })
      await s.raw({ method: "DELETE", path: keyPath(b, "k.csv") })
      await select(s, "delete marker", b, "k.csv", body)
    },
  },
  {
    name: "select-gzip",
    async run(s) {
      const b = await s.bucket("sel-gz")
      await s.raw({
        method: "PUT",
        path: keyPath(b, "k.csv.gz"),
        body: Bun.gzipSync(new TextEncoder().encode("a,b\n1,2\n3,4\n"), { level: 6 }),
      })
      await select(
        s,
        "gzip",
        b,
        "k.csv.gz",
        selectBody({
          expression: "SELECT s._2 FROM S3Object s",
          input: "<CompressionType>GZIP</CompressionType><CSV/>",
        }),
      )
      await select(
        s,
        "gzip lower",
        b,
        "k.csv.gz",
        selectBody({
          expression: "SELECT COUNT(*) FROM S3Object",
          input: "<CompressionType>gzip</CompressionType><CSV/>",
        }),
      )
    },
  },
  {
    name: "select-sql-features",
    async run(s) {
      const b = await s.bucket("sel-sql")
      await put(
        s,
        b,
        "p.csv",
        "name,age,score,note\nalice,30,1.5,\nbob,25,2.25,x\ncarol,35,1000000,<b>&\ndave,40,0.00001,y\n",
      )
      const input = "<CSV><FileHeaderInfo>USE</FileHeaderInfo></CSV>"
      const q = (step: string, expression: string, output = "<CSV/>") =>
        select(s, step, b, "p.csv", selectBody({ expression, input, output }))
      await q(
        "sum avg min max",
        "SELECT SUM(s.age), AVG(s.age), MIN(s.age), MAX(s.age) FROM S3Object s",
      )
      await q(
        "sum avg json",
        "SELECT SUM(s.score) AS total, AVG(s.score) FROM S3Object s",
        "<JSON/>",
      )
      await q("min max float", "SELECT MIN(s.score), MAX(s.score) FROM S3Object s", "<JSON/>")
      await q("count column", "SELECT COUNT(s.note) FROM S3Object s")
      await q(
        "aggregate no rows",
        "SELECT COUNT(*), SUM(s.age), AVG(s.age), MIN(s.age) FROM S3Object s WHERE s.age > 100",
        "<JSON/>",
      )
      await q("like", "SELECT s.name FROM S3Object s WHERE s.name LIKE '%a%'")
      await q("not like", "SELECT s.name FROM S3Object s WHERE s.name NOT LIKE 'a%'")
      await q("like underscore", "SELECT s.name FROM S3Object s WHERE s.name LIKE '_ob'")
      await q("between", "SELECT s.name FROM S3Object s WHERE s.age BETWEEN 26 AND 36")
      await q("not between", "SELECT s.name FROM S3Object s WHERE s.age NOT BETWEEN 26 AND 36")
      await q("in list", "SELECT s.name FROM S3Object s WHERE s.name IN ('bob', 'dave')")
      await q("is null", "SELECT s.name FROM S3Object s WHERE s._9 IS NULL")
      await q("is not null", "SELECT s.name FROM S3Object s WHERE s.name IS NOT NULL")
      await q("not", "SELECT s.name FROM S3Object s WHERE NOT s.age > 30")
      await q(
        "arithmetic csv",
        "SELECT s.age + 1, s.age * 2, s.age - 0.5, s.age / 4, s.age % 7 FROM S3Object s",
      )
      await q(
        "arithmetic json",
        "SELECT s.age + 1, s.score * 2, s.age / 4 FROM S3Object s",
        "<JSON/>",
      )
      await q("float formatting csv", "SELECT s.score * 1.0 FROM S3Object s")
      await q("negation", "SELECT -s.age FROM S3Object s LIMIT 1")
      await q("literals", "SELECT 'lit', 42, 1.5, TRUE, NULL FROM S3Object LIMIT 1", "<JSON/>")
      await q("literals csv", "SELECT 'it''s', 42, 1.5, FALSE, NULL FROM S3Object LIMIT 1")
      await q(
        "lower upper",
        "SELECT LOWER('ABC'), UPPER(s.name), CHAR_LENGTH(s.name) FROM S3Object s LIMIT 2",
      )
      await q(
        "cast",
        "SELECT CAST(s.age AS INT) + 1, CAST(s.score AS FLOAT), CAST(s.age AS STRING) FROM S3Object s LIMIT 2",
        "<JSON/>",
      )
      await q("quoted identifier", 'SELECT s."name" FROM S3Object s WHERE s."age" = 25')
      await q("bracket key", "SELECT s['name'] FROM S3Object s LIMIT 1", "<JSON/>")
      await q("s star", "SELECT s.* FROM S3Object s LIMIT 1")
      await q(
        "html escaping json",
        "SELECT s.note FROM S3Object s WHERE s.name = 'carol'",
        "<JSON/>",
      )
      await q("string compare", "SELECT s.name FROM S3Object s WHERE s.name > 'b'")
      await q("ne operator", "SELECT s.name FROM S3Object s WHERE s.name != 'bob'")
      await q("alias quoted", "SELECT s.name AS 'n' FROM S3Object s LIMIT 1", "<JSON/>")
      await q("unknown column", "SELECT s.nope FROM S3Object s")
      await q("case insensitive keywords", "select S.name from s3object S where S.age = 40")
      await q("table alias with as", "SELECT x.name FROM S3Object AS x LIMIT 1")
    },
  },
  {
    name: "select-json-paths",
    async run(s) {
      const b = await s.bucket("sel-jp")
      await put(
        s,
        b,
        "n.jsonl",
        '{"id":1,"user":{"name":"ann","langs":["go","ts"]},"ok":true}\n{"id":2,"user":{"name":"ben","langs":[]},"ok":false,"extra":null}\n',
      )
      await put(s, b, "arr.json", '{"items":[{"v":1},{"v":2},{"v":3}]}')
      await put(s, b, "scalars.jsonl", '1\n"two"\n[3]\n')
      const lines = "<JSON><Type>LINES</Type></JSON>"
      const q = (
        step: string,
        key: string,
        expression: string,
        output = "<JSON/>",
        input = lines,
      ) => select(s, step, b, key, selectBody({ expression, input, output }))
      await q("nested key", "n.jsonl", "SELECT s.user.name FROM S3Object s")
      await q("nested object", "n.jsonl", "SELECT s.user FROM S3Object s")
      await q("nested object csv", "n.jsonl", "SELECT s.user FROM S3Object s", "<CSV/>")
      await q("array index", "n.jsonl", "SELECT s.user.langs[0] FROM S3Object s")
      await q("bool where", "n.jsonl", "SELECT s.id FROM S3Object s WHERE s.ok = true")
      await q("null field", "n.jsonl", "SELECT s.extra FROM S3Object s")
      await q("is missing", "n.jsonl", "SELECT s.id FROM S3Object s WHERE s.extra IS MISSING")
      await q("select all nested csv", "n.jsonl", "SELECT * FROM S3Object", "<CSV/>")
      await q(
        "from array wildcard",
        "arr.json",
        "SELECT s.v FROM S3Object[*].items[*] s",
        "<JSON/>",
        "<JSON><Type>DOCUMENT</Type></JSON>",
      )
      await q("scalars", "scalars.jsonl", "SELECT * FROM S3Object")
      await q("scalars _1", "scalars.jsonl", "SELECT s._1 FROM S3Object s", "<CSV/>")
      await q("count json", "n.jsonl", "SELECT COUNT(*) FROM S3Object", "<CSV/>")
    },
  },
  {
    name: "select-csv-edge-cases",
    async run(s) {
      const b = await s.bucket("sel-edge")
      await put(s, b, "noeol.csv", "a,b")
      await put(s, b, "ragged.csv", "a,b,c\n1\n1,2,3,4\n")
      await put(s, b, "spaces.csv", ' lead,trail \n\n\nx,"multi\nline"\n')
      await put(s, b, "many.csv", Array.from({ length: 250 }, (_, i) => `${i},row${i}`).join("\n"))
      await s.raw({
        method: "PUT",
        path: keyPath(b, "latin1.csv"),
        body: new Uint8Array([0x61, 0x2c, 0xe9, 0x0a]),
      })
      const q = (
        step: string,
        key: string,
        expression: string,
        input = "<CSV/>",
        output = "<CSV/>",
        extra = "",
      ) => select(s, step, b, key, selectBody({ expression, input, output, extra }))
      await q(
        "header without newline use",
        "noeol.csv",
        "SELECT * FROM S3Object",
        "<CSV><FileHeaderInfo>USE</FileHeaderInfo></CSV>",
      )
      await q("no newline none", "noeol.csv", "SELECT * FROM S3Object")
      await q("ragged json", "ragged.csv", "SELECT * FROM S3Object", "<CSV/>", "<JSON/>")
      await q("ragged csv", "ragged.csv", "SELECT * FROM S3Object")
      await q("ragged positional", "ragged.csv", "SELECT s._4 FROM S3Object s", "<CSV/>", "<JSON/>")
      await q("spaces and multiline", "spaces.csv", "SELECT * FROM S3Object")
      await q("spaces json", "spaces.csv", "SELECT * FROM S3Object", "<CSV/>", "<JSON/>")
      await q("many rows", "many.csv", "SELECT s._2 FROM S3Object s WHERE s._1 >= 10")
      await q("many rows limit", "many.csv", "SELECT * FROM S3Object LIMIT 150")
      await q("invalid utf8", "latin1.csv", "SELECT * FROM S3Object")
      await q(
        "scan range",
        "many.csv",
        "SELECT * FROM S3Object",
        "<CSV/>",
        "<CSV/>",
        "<ScanRange><Start>0</Start><End>20</End></ScanRange>",
      )
      await q(
        "scan range end only",
        "many.csv",
        "SELECT * FROM S3Object",
        "<CSV/>",
        "<CSV/>",
        "<ScanRange><End>12</End></ScanRange>",
      )
      await q(
        "scan range past end",
        "noeol.csv",
        "SELECT * FROM S3Object",
        "<CSV/>",
        "<CSV/>",
        "<ScanRange><Start>50</Start></ScanRange>",
      )
      await q(
        "bad scan value",
        "noeol.csv",
        "SELECT * FROM S3Object",
        "<CSV/>",
        "<CSV/>",
        "<ScanRange><Start>x</Start></ScanRange>",
      )
    },
  },
  {
    name: "select-parse-errors",
    async run(s) {
      const b = await s.bucket("sel-parse")
      await put(s, b, "k.csv", "a,b\n1,2\n")
      const q = (step: string, expression: string) =>
        select(s, step, b, "k.csv", selectBody({ expression, input: "<CSV/>" }))
      await q("limit string", "SELECT * FROM S3Object LIMIT 'x'")
      await q("limit float", "SELECT * FROM S3Object LIMIT 1.5")
      await q("aggregate in where", "SELECT * FROM S3Object s WHERE COUNT(*) > 1")
      await q("keypath table", "SELECT * FROM S3Object.a")
      await q("empty expression", "")
      await q("trailing garbage", "SELECT * FROM S3Object s s")
      await q("missing from", "SELECT *")
    },
  },
  {
    name: "attributes-multipart-checksum",
    async run(s) {
      const b = await s.bucket("attrs-mpc")
      const created = await s.raw({
        method: "POST",
        path: keyPath(b, "big"),
        query: { uploads: "" },
        headers: { "x-amz-checksum-algorithm": "CRC32" },
      })
      const uploadId = created.tag("UploadId") ?? ""
      const parts = ["a".repeat(5 * 1024 * 1024), "tail"]
      const sent: { etag: string; crc: string }[] = []
      for (let index = 0; index < parts.length; index++) {
        const res = await s.raw({
          method: "PUT",
          path: keyPath(b, "big"),
          query: { partNumber: String(index + 1), uploadId },
          body: parts[index] as string,
          headers: { "x-amz-checksum-crc32": index === 0 ? "r/zBbw==" : "fDe0XQ==" },
        })
        sent.push({
          etag: res.headers.get("etag") ?? "",
          crc: res.headers.get("x-amz-checksum-crc32") ?? "",
        })
      }
      await s.raw({
        method: "POST",
        path: keyPath(b, "big"),
        query: { uploadId },
        body: `<CompleteMultipartUpload>${sent
          .map(
            (part, index) =>
              `<Part><PartNumber>${index + 1}</PartNumber><ETag>${part.etag}</ETag><ChecksumCRC32>${part.crc}</ChecksumCRC32></Part>`,
          )
          .join("")}</CompleteMultipartUpload>`,
      })
      await attrs(s, "checksum and parts", b, "big", {
        "x-amz-object-attributes": "Checksum,ObjectParts",
      })
    },
  },
  {
    name: "select-runtime-error",
    async run(s) {
      const b = await s.bucket("sel-rt")
      await put(s, b, "k.csv", "a\n1\nxyz\n3\n")
      await select(
        s,
        "number compare on text",
        b,
        "k.csv",
        selectBody({ expression: "SELECT * FROM S3Object s WHERE s._1 > 0", input: "<CSV/>" }),
      )
    },
  },
]
