/**
 * Multipart uploads, after MinIO's `object-multipart-handlers.go` and the erasure layer under it
 * (`erasure-multipart.go`): CreateMultipartUpload, UploadPart, UploadPartCopy,
 * CompleteMultipartUpload, AbortMultipartUpload, ListParts and ListMultipartUploads, with MinIO's
 * validation order, upload-id format and quirks (abort of an unknown upload is a 204, listing
 * with a prefix only matches that exact key, a part-number marker that names no part lists nothing).
 */
import { sha256Hex } from "../auth.js"
import { type ChecksumAlgorithm, checksum } from "../checksums.js"
import { type Ctx, type Handlers, ok, xmlResponse } from "../context.js"
import { md5Hex, multipartEtag } from "../digest.js"
import { fail, S3Error } from "../errors.js"
import { child, children, decodeGoXml, GoXmlError } from "../goxml.js"
import type {
  ChecksumAlgorithmName,
  MultipartPart,
  MultipartUpload,
  ObjectVersion,
  PartInfo,
  StoredChecksum,
} from "../state.js"
import { el, httpDate, isoDate, wrap } from "../xml.js"
import { OWNER_ID } from "./buckets.js"
import { userMetadata } from "./common.js"
import {
  checkCopyPreconditions,
  findCopySource,
  parseCopySource,
  parseHttpDate,
  validateObjectTags,
  withSourceScope,
} from "./copy.js"
import { objectLockForWrite } from "./lock.js"

const MAX_PART_ID = 10000
const MAX_PARTS_LIST = 10000
const MAX_UPLOADS_LIST = 10000
const MIN_PART_SIZE = 5 * 1024 * 1024
/** MinIO's `globalMaxObjectSize` (5 TiB): the largest single part or copied range. */
const MAX_OBJECT_SIZE = 5 * 1024 ** 4
/** MinIO's `globalDeploymentID`, the prefix every upload id carries. */
const DEPLOYMENT_ID = "6d6f636b-696e-4762-a972-642d73335f69"

// ── Go parsing helpers ──────────────────────────────────────────────────────

const INT64_MAX = 9223372036854775807n

/** Go's `strconv.Atoi` (64-bit): `undefined` on any error. */
const atoi = (value: string): number | undefined => {
  if (!/^[+-]?[0-9]+$/.test(value)) return undefined
  const parsed = BigInt(value)
  if (parsed > INT64_MAX || parsed < -INT64_MAX - 1n) return undefined
  return Number(parsed)
}

/** `base64.RawURLEncoding.DecodeString` succeeds (Go skips `\r` and `\n`). */
const isRawUrlBase64 = (value: string) => {
  const stripped = value.replace(/[\r\n]/g, "")
  return /^[A-Za-z0-9_-]*$/.test(stripped) && stripped.length % 4 !== 1
}

const decodeRawUrlBase64 = (value: string) => {
  const padded = value
    .replace(/[\r\n]/g, "")
    .replace(/-/g, "+")
    .replace(/_/g, "/")
  try {
    return atob(padded + "=".repeat((4 - (padded.length % 4)) % 4))
  } catch {
    return ""
  }
}

const encodeRawUrlBase64 = (value: string) =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

/** MinIO's `s3URLEncode` (`encoding-type=url`): `/` and `*` kept, `~` encoded, space as `+`. */
const s3UrlEncode = (value: string) =>
  [...new TextEncoder().encode(value)]
    .map((byte) => {
      const char = String.fromCharCode(byte)
      if (/[A-Za-z0-9\-_./*]/.test(char)) return char
      if (char === " ") return "+"
      return `%${byte.toString(16).toUpperCase().padStart(2, "0")}`
    })
    .join("")

const encodeName = (value: string, encodingType: string) =>
  encodingType.toLowerCase() === "url" ? s3UrlEncode(value) : value

/** Go's `path.Clean`. */
const cleanPath = (value: string): string => {
  const rooted = value.startsWith("/")
  const out: string[] = []
  for (const segment of value.split("/")) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop()
      else if (!rooted) out.push("..")
    } else out.push(segment)
  }
  const joined = out.join("/")
  return rooted ? `/${joined}` : joined || "."
}

/** Go's `url.URL.EscapedPath` for a path with no raw form. */
const escapePath = (value: string) =>
  [...new TextEncoder().encode(value)]
    .map((byte) => {
      const char = String.fromCharCode(byte)
      if (/[A-Za-z0-9\-_.~$&+,/:;=@]/.test(char)) return char
      return `%${byte.toString(16).toUpperCase().padStart(2, "0")}`
    })
    .join("")

/** MinIO's `canonicalizeETag`: surrounding quotes removed. */
const canonicalEtag = (etag: string) => etag.replace(/"*?([^"]*?)"*?$/g, "$1")

/** MinIO's `isETagEqual` (`*` matches anything). */
const etagEqual = (etag: string, given: string) =>
  given.trim() === "*" || canonicalEtag(etag) === canonicalEtag(given)

// ── checksums ───────────────────────────────────────────────────────────────

/** `hash.BaseChecksumTypes`, in MinIO's precedence order. */
const BASE_TYPES: ChecksumAlgorithmName[] = ["SHA256", "SHA1", "CRC32", "CRC64NVME", "CRC32C"]
const RAW_LENGTH: Record<ChecksumAlgorithmName, number> = {
  CRC32: 4,
  CRC32C: 4,
  CRC64NVME: 8,
  SHA1: 20,
  SHA256: 32,
}
const canMerge = (algorithm: ChecksumAlgorithmName) =>
  algorithm === "CRC32" || algorithm === "CRC32C" || algorithm === "CRC64NVME"
const headerOf = (algorithm: ChecksumAlgorithmName) => `x-amz-checksum-${algorithm.toLowerCase()}`
const isAlgorithm = (value: string): value is ChecksumAlgorithmName =>
  (BASE_TYPES as string[]).includes(value)

/** `hash.NewChecksumType`: the upload's algorithm and type, or `"invalid"`. */
const checksumTypeOf = (
  algorithm: string,
  type: string,
): { algorithm: ChecksumAlgorithmName; full: boolean } | "invalid" | undefined => {
  let full: boolean
  if (type === "FULL_OBJECT") full = true
  else if (type === "COMPOSITE" || type === "") full = false
  else return "invalid"
  const upper = algorithm.toUpperCase()
  if (upper === "") return full ? "invalid" : undefined
  if (!isAlgorithm(upper)) return "invalid"
  if (upper === "CRC64NVME") return { algorithm: upper, full: true }
  if (full && !canMerge(upper)) return "invalid"
  return { algorithm: upper, full }
}

const base64Raw = (value: string): Uint8Array | undefined => {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) return undefined
  try {
    return Uint8Array.from(atob(value), (char) => char.charCodeAt(0))
  } catch {
    return undefined
  }
}

type ContentChecksum = {
  algorithm: ChecksumAlgorithmName
  full: boolean
  trailing: boolean
  /** The base64 digest (without any `-N`); "" when it arrives in a trailer. */
  encoded: string
  raw: Uint8Array
  /** `-N` on the value: a multipart checksum over N parts. */
  parts: number
}

/** `hash.NewChecksumWithType`: `undefined` when the value is malformed. */
const checksumValue = (
  algorithm: ChecksumAlgorithmName,
  full: boolean,
  value: string,
): ContentChecksum | undefined => {
  let encoded = value
  let parts = 0
  if (value.includes("-")) {
    const split = value.split("-")
    const count = split.length === 2 ? atoi(split[1] as string) : undefined
    if (count === undefined) return undefined
    encoded = split[0] as string
    parts = count
  }
  const raw = base64Raw(encoded)
  if (!raw || raw.length !== RAW_LENGTH[algorithm]) return undefined
  return { algorithm, full, trailing: false, encoded, raw, parts }
}

/**
 * `hash.GetContentChecksum`: the checksum a request carries (`x-amz-trailer`, or
 * `x-amz-checksum-algorithm` + its header, or the one `x-amz-checksum-*` header). `undefined` for
 * none; InvalidChecksum when it is malformed or ambiguous.
 */
const contentChecksum = (headers: Headers): ContentChecksum | undefined => {
  const typeHeader = headers.get("x-amz-checksum-type") ?? ""
  const trailer = headers.get("x-amz-trailer")
  if (trailer !== null) {
    let found: ChecksumAlgorithmName | undefined
    for (const name of trailer.split(",").map((item) => item.trim())) {
      for (const algorithm of BASE_TYPES)
        if (headerOf(algorithm) === name.toLowerCase()) {
          if (found) fail("InvalidChecksum")
          found = algorithm
        }
    }
    if (found) {
      let full = false
      if (typeHeader === "FULL_OBJECT") {
        if (!canMerge(found)) fail("InvalidChecksum")
        full = true
      } else if (typeHeader !== "COMPOSITE" && typeHeader !== "") fail("InvalidChecksum")
      return {
        algorithm: found,
        full,
        trailing: true,
        encoded: "",
        raw: new Uint8Array(),
        parts: 0,
      }
    }
  }
  let algorithm: ChecksumAlgorithmName | undefined
  let full = false
  let value = ""
  let invalid = false
  const named = headers.get("x-amz-checksum-algorithm") ?? ""
  if (named !== "") {
    const type = checksumTypeOf(named, typeHeader)
    if (type === "invalid" || type === undefined) return fail("InvalidChecksum")
    if (typeHeader === "FULL_OBJECT" && !canMerge(type.algorithm)) return fail("InvalidChecksum")
    value = headers.get(headerOf(type.algorithm)) ?? ""
    if (value === "") return undefined
    algorithm = type.algorithm
    full = type.full
  } else {
    for (const candidate of BASE_TYPES) {
      const got = headers.get(headerOf(candidate)) ?? ""
      if (got === "") continue
      if (algorithm || invalid) {
        invalid = true
        continue
      }
      algorithm = candidate
      value = got
      if (typeHeader === "FULL_OBJECT") {
        if (!canMerge(candidate)) invalid = true
        full = true
      }
    }
    if (invalid) fail("InvalidChecksum")
    if (!algorithm) return undefined
  }
  const parsed = checksumValue(algorithm as ChecksumAlgorithmName, full, value)
  if (!parsed) fail("InvalidChecksum")
  return parsed
}

const digest = async (algorithm: ChecksumAlgorithmName, bytes: Uint8Array) =>
  checksum(algorithm.toLowerCase() as ChecksumAlgorithm, bytes)

// ── uploads ─────────────────────────────────────────────────────────────────

/** The `<uuid>x<nanos>` an upload id wraps (MinIO's on-disk upload directory). */
const uploadUuid = (uploadId: string) => {
  const decoded = decodeRawUrlBase64(uploadId)
  const dot = decoded.indexOf(".")
  return dot < 0 ? uploadId : decoded.slice(dot + 1)
}

/** `bucket/sha256(bucket/key)/<uuid>x<nanos>`, as MinIO names an upload in its errors. */
const uploadPath = async (upload: MultipartUpload) =>
  `${upload.bucket}/${await sha256Hex(cleanPath(`${upload.bucket}/${upload.key}`))}/${uploadUuid(upload.id)}`

/** `checkObjectArgs`: KeyTooLongError over 1024 bytes; no trailing `/`, `.`/`..` segment or `//`. */
const checkObjectName = (key: string) => {
  if (new TextEncoder().encode(key).length > 1024) fail("KeyTooLongError")
  if (
    !key ||
    key.endsWith("/") ||
    key.includes("//") ||
    key.includes("\u0000") ||
    key.split("/").some((segment) => segment === "." || segment === "..")
  )
    fail("InvalidObjectName")
}

const uploadIdParam = (ctx: Ctx) => ctx.query.get("uploadId") ?? ""

/**
 * The upload a request names, as `GetMultipartInfo` finds it: an id that is not raw-URL base64
 * is NoSuchUpload before the bucket is even looked at; then NoSuchBucket; then NoSuchUpload for
 * an id that is unknown or belongs to another key.
 */
const findUpload = (ctx: Ctx, uploadId = uploadIdParam(ctx)): MultipartUpload => {
  if (!isRawUrlBase64(uploadId)) fail("NoSuchUpload")
  checkObjectName(ctx.key)
  ctx.core.requireBucket(ctx.bucket)
  const upload = uploadId ? ctx.core.state.uploads.get(uploadId) : undefined
  if (!upload || upload.bucket !== ctx.bucket || upload.key !== ctx.key) fail("NoSuchUpload")
  return upload as MultipartUpload
}

const partsOf = (ctx: Ctx, uploadId: string): MultipartPart[] =>
  ctx.core.state.parts
    .list({ where: (part) => part.uploadId === uploadId })
    .map(({ value }) => value)
    .sort((a, b) => a.partNumber - b.partNumber)

/** Remove an upload and every part it holds. */
const dropUpload = (ctx: Ctx, uploadId: string) => {
  for (const row of ctx.core.state.parts.list({ where: (part) => part.uploadId === uploadId })) {
    ctx.core.state.blobs.release(row.value.blob)
    ctx.core.state.parts.delete(row.id)
  }
  ctx.core.state.uploads.delete(uploadId)
}

/** `getObjectResources`: `max-parts` and `part-number-marker`, validated as MinIO parses them. */
const objectResources = (ctx: Ctx) => {
  let maxParts = MAX_PARTS_LIST
  let marker = 0
  const max = ctx.query.get("max-parts") ?? ""
  if (max !== "") {
    const parsed = atoi(max)
    if (parsed === undefined) fail("InvalidMaxParts")
    maxParts = parsed as number
  }
  const rawMarker = ctx.query.get("part-number-marker") ?? ""
  if (rawMarker !== "") {
    const parsed = atoi(rawMarker)
    if (parsed === undefined) fail("InvalidPartNumberMarker")
    marker = parsed as number
  }
  return { maxParts, marker, encodingType: ctx.query.get("encoding-type") ?? "" }
}

/** `checkPreconditionsPUT` against the current object, for initiate and complete. */
const checkPutPreconditions = (ctx: Ctx) => {
  const ifMatch = ctx.headers.get("if-match") ?? ""
  const ifNoneMatch = ctx.headers.get("if-none-match") ?? ""
  if (!ifMatch && !ifNoneMatch) return
  const current = ctx.core.head(ctx.bucket, ctx.key)
  if (!current || current.deleteMarker) {
    if (ifMatch && !current) fail("NoSuchKey")
    return
  }
  const failed = () =>
    fail("PreconditionFailed", {
      headers: {
        "last-modified": httpDate(Math.floor(current.lastModified / 1000) * 1000),
        ...(current.etag ? { etag: `"${current.etag}"` } : {}),
      },
    })
  if (ifMatch && !etagEqual(current.etag, ifMatch)) failed()
  if (ifNoneMatch && etagEqual(current.etag, ifNoneMatch)) failed()
}

const LOCK_HEADERS = ["x-amz-object-lock-mode", "x-amz-object-lock-retain-until-date"]

/** `x-amz-tagging` as `tags.ParseObjectTags` checks it (a bad escape is `url.EscapeError`). */
const checkTagging = (raw: string) => {
  for (const pair of raw.split("&")) {
    const bad = /%(?![0-9a-fA-F]{2})(.{0,2})/.exec(pair)
    if (bad)
      fail("InvalidObjectName", {
        message: `Object name contains unsupported characters. (invalid URL escape "${bad[0]}")`,
      })
  }
  validateObjectTags(raw)
}

/** The object fields `extractMetadataFromReq` keeps for the eventual object. */
const requestedFields = (headers: Headers) => {
  const encoding = (headers.get("content-encoding") ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part && part !== "aws-chunked")
    .join(",")
  const expires = headers.get("expires")
  const expiresAt = expires ? parseHttpDate(expires) : undefined
  const optional = (name: string) => headers.get(name) ?? undefined
  return {
    metadata: userMetadata(headers),
    contentType: headers.get("content-type") || "binary/octet-stream",
    contentEncoding: encoding || undefined,
    contentDisposition: optional("content-disposition"),
    contentLanguage: optional("content-language"),
    cacheControl: optional("cache-control"),
    expires: expiresAt === undefined ? undefined : httpDate(expiresAt),
  }
}

/** The record without its `undefined` fields, typed as if they were never optional-with-undefined. */
const defined = <T extends Record<string, unknown>>(
  record: T,
): { [K in keyof T]: Exclude<T[K], undefined> } =>
  Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as {
    [K in keyof T]: Exclude<T[K], undefined>
  }

/** The `Location` MinIO reports for a completed object (`getObjectLocation`). */
const objectLocation = (ctx: Ctx) => {
  const host = ctx.headers.get("host") ?? ctx.url.host
  let path = cleanPath(`/${ctx.bucket}/${ctx.key}`)
  if (host.startsWith(`${ctx.bucket}.`) && ctx.url.pathname.split("/")[1] !== ctx.bucket)
    path = cleanPath(`/${ctx.key}`)
  return `${ctx.url.protocol}//${host}${escapePath(path)}`
}

// ── UploadPart / UploadPartCopy ─────────────────────────────────────────────

/** The `partNumber` of an upload request: InvalidPart unless 1..; InvalidMaxParts over 10000. */
const partNumberOf = (ctx: Ctx, afterSize?: () => void) => {
  const partNumber = atoi(ctx.query.get("partNumber") ?? "")
  if (partNumber === undefined || partNumber <= 0) fail("InvalidPart")
  afterSize?.()
  if ((partNumber as number) > MAX_PART_ID) fail("InvalidMaxParts")
  return partNumber as number
}

/** Content-MD5 must be base64 of 16 bytes when present (InvalidDigest otherwise). */
const checkContentMd5 = (headers: Headers) => {
  const value = headers.get("content-md5")
  if (value === null) return
  const raw = base64Raw(value)
  if (raw?.length !== 16) fail("InvalidDigest")
}

/** Store a part (replacing any earlier one with the same number). */
const savePart = (
  ctx: Ctx,
  uploadId: string,
  partNumber: number,
  bytes: Uint8Array,
  checksums?: Partial<Record<ChecksumAlgorithmName, string>>,
): MultipartPart => {
  const id = ctx.core.state.partId(uploadId, partNumber)
  const prior = ctx.core.state.parts.get(id)
  if (prior) {
    ctx.core.state.blobs.release(prior.blob)
    ctx.core.state.parts.delete(id)
  }
  const part: MultipartPart = {
    uploadId,
    partNumber,
    blob: ctx.core.state.blobs.put(bytes),
    size: bytes.length,
    etag: md5Hex(bytes),
    lastModified: ctx.now,
    ...(checksums && Object.keys(checksums).length ? { checksums } : {}),
  }
  ctx.core.state.parts.insert(id, part)
  return part
}

/** The upload asks for a checksum algorithm the part does not carry. */
const requireUploadChecksum = async (upload: MultipartUpload, got: string) => {
  if (!upload.checksumAlgorithm || upload.checksumAlgorithm === got) return
  fail("InvalidArgument", {
    message: `Invalid arguments provided for ${await uploadPath(upload)}: (checksum missing, want ${JSON.stringify(upload.checksumAlgorithm)}, got ${JSON.stringify(got)})`,
  })
}

type ByteRange = { start: number; end: number }

/**
 * `parseCopyPartRangeSpec`: only `bytes=first-last`. A malformed value fails with Go's
 * message (InvalidArgument); a well-formed but unsupported one is InvalidCopyPartRange.
 */
const parseCopyRange = (value: string): ByteRange | S3Error => {
  const invalid = () => new S3Error("InvalidCopyPartRange")
  const wrong = (message: string) => new S3Error("InvalidCopyPartRangeSource", { message })
  if (!value.startsWith("bytes=")) return wrong(`'${value}' does not start with 'bytes='`)
  const spec = value.slice("bytes=".length)
  const dash = spec.indexOf("-")
  if (dash < 0) return wrong(`'${value}' does not have a valid range value`)
  const parse = (raw: string, which: string): number | S3Error => {
    if (raw === "") return -1
    if (raw.startsWith("+")) return wrong(`Byte position ('${raw}') must not have a sign`)
    const parsed = atoi(raw)
    if (parsed === undefined)
      return wrong(`'${value}' does not have a valid ${which} byte position value`)
    if (parsed < 0)
      return wrong(
        `${which === "first" ? "First" : "Last"} byte position is negative ('${parsed}')`,
      )
    return parsed
  }
  const start = parse(spec.slice(0, dash), "first")
  if (start instanceof S3Error) return start
  const end = parse(spec.slice(dash + 1), "last")
  if (end instanceof S3Error) return end
  if (start > -1 && end > -1) return start > end ? invalid() : { start, end }
  if (start > -1 || end > 0) return invalid()
  if (end === 0) return invalid()
  return wrong(`'${value}' does not have valid range value`)
}

// ── CompleteMultipartUpload ─────────────────────────────────────────────────

type CompletePart = {
  partNumber: number
  etag: string
  checksums: Partial<Record<ChecksumAlgorithmName, string>>
}

/** Go's `strconv.ParseInt(v, 10, 64)` as `encoding/xml` applies it to a trimmed element. */
const xmlInt = (raw: string): number => {
  const value = raw.trim()
  if (value === "") return 0
  const quoted = JSON.stringify(value)
  if (!/^[+-]?[0-9]+$/.test(value))
    throw new S3Error("InternalError", {
      message: `We encountered an internal error, please try again.: cause(strconv.ParseInt: parsing ${quoted}: invalid syntax)`,
    })
  const parsed = BigInt(value)
  if (parsed > INT64_MAX || parsed < -INT64_MAX - 1n)
    throw new S3Error("BadRequest", {
      message: `strconv.ParseInt: parsing ${quoted}: value out of range`,
    })
  return Number(parsed)
}

/** The `<CompleteMultipartUpload>` body as `xmlDecoder` reads it (any root element name). */
const parseComplete = (body: string): CompletePart[] => {
  let root: ReturnType<typeof decodeGoXml>
  try {
    root = decodeGoXml(body)
  } catch (error) {
    if (!(error instanceof GoXmlError)) throw error
    const detail = error.kind === "eof" ? "XML syntax error on line 0: EOF" : error.message
    return fail("MalformedXML", {
      message: `The XML you provided was not well-formed or did not validate against our published schema. (${detail})`,
    })
  }
  return children(root, "Part").map((part) => {
    const text = (name: string) => child(part, name)?.text
    const checksums: Partial<Record<ChecksumAlgorithmName, string>> = {}
    for (const algorithm of BASE_TYPES) {
      const value = text(`Checksum${algorithm}`)
      if (value !== undefined) checksums[algorithm] = value
    }
    const size = text("Size")
    if (size !== undefined) xmlInt(size)
    return {
      partNumber: xmlInt(text("PartNumber") ?? ""),
      etag: text("ETag") ?? "",
      checksums,
    }
  })
}

const concat = (chunks: Uint8Array[]) => {
  const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/** `ObjType()` of a checksum type as MinIO names it in a type-mismatch error. */
const objType = (full: boolean, multipart: boolean) =>
  !full && multipart ? "COMPOSITE" : "FULL_OBJECT"

// ── handlers ────────────────────────────────────────────────────────────────

const ownerXml = (name: string, id: string) => wrap(name, el("ID", id) + el("DisplayName", id))

export const multipartHandlers: Handlers = {
  async CreateMultipartUpload(ctx) {
    const storageClass = ctx.headers.get("x-amz-storage-class") ?? ""
    if (storageClass && storageClass !== "STANDARD" && storageClass !== "REDUCED_REDUNDANCY")
      fail("InvalidStorageClass")
    const fields = requestedFields(ctx.headers)
    const tagging = ctx.headers.get("x-amz-tagging") ?? ""
    if (tagging) checkTagging(tagging)
    const lock = objectLockForWrite(ctx.core, ctx.bucket, ctx.headers, ctx.now)
    const type = checksumTypeOf(
      ctx.headers.get("x-amz-checksum-algorithm") ?? "",
      ctx.headers.get("x-amz-checksum-type") ?? "",
    )
    if (type === "invalid") fail("InvalidChecksum")
    checkObjectName(ctx.key)
    ctx.core.requireBucket(ctx.bucket)
    checkPutPreconditions(ctx)
    const uuid = `${ctx.core.uuid()}x${ctx.now}000000`
    const id = encodeRawUrlBase64(`${DEPLOYMENT_ID}.${uuid}`)
    const checksumType = type && type !== "invalid" ? type : undefined
    const upload: MultipartUpload = defined({
      id,
      bucket: ctx.bucket,
      key: ctx.key,
      initiated: ctx.now,
      ...fields,
      ...(tagging ? { tagging } : {}),
      ...(storageClass && storageClass !== "STANDARD" ? { storageClass } : {}),
      ...lock,
      ...(checksumType
        ? {
            checksumAlgorithm: checksumType.algorithm,
            checksumType: checksumType.full ? "FULL_OBJECT" : "COMPOSITE",
          }
        : {}),
    } as MultipartUpload)
    ctx.core.state.uploads.insert(id, upload)
    const headers: Record<string, string> = {}
    if (upload.checksumAlgorithm) {
      headers["x-amz-checksum-algorithm"] = upload.checksumAlgorithm
      headers["x-amz-checksum-type"] = upload.checksumType as string
    }
    return xmlResponse(
      "InitiateMultipartUploadResult",
      el("Bucket", ctx.bucket) + el("Key", ctx.key) + el("UploadId", id),
      { headers },
    )
  },

  async UploadPart(ctx) {
    if (ctx.headers.has("x-amz-copy-source")) fail("InvalidCopySource")
    checkContentMd5(ctx.headers)
    const decoded = ctx.headers.get("x-amz-decoded-content-length")
    if (decoded === "" && ctx.auth.startsWith("streaming")) fail("MissingContentLength")
    const partNumber = partNumberOf(ctx, () => {
      const size = Number(decoded ?? ctx.headers.get("content-length") ?? 0)
      if (size > MAX_OBJECT_SIZE) fail("EntityTooLarge")
    })
    const upload = findUpload(ctx)
    const wanted = contentChecksum(ctx.headers)
    await requireUploadChecksum(upload, wanted?.algorithm ?? "")
    const bytes = await ctx.body()
    const checksums: Partial<Record<ChecksumAlgorithmName, string>> = {}
    const headers: Record<string, string> = {}
    if (wanted) {
      const computed = await digest(wanted.algorithm, bytes)
      let given = wanted.encoded
      if (wanted.trailing) {
        given = (await ctx.trailers())[headerOf(wanted.algorithm)] ?? ""
        if (!base64Raw(given)?.length) fail("ContentChecksumMismatch")
      }
      if (computed !== given) fail("ContentChecksumMismatch")
      checksums[wanted.algorithm] = computed
      headers[headerOf(wanted.algorithm)] = given
    }
    const part = savePart(ctx, upload.id, partNumber, bytes, checksums)
    return ok({ etag: `"${part.etag}"`, ...headers })
  },

  async UploadPartCopy(ctx) {
    const source = parseCopySource(ctx)
    return withSourceScope(source, async () => {
      const partNumber = partNumberOf(ctx)
      const rangeHeader = ctx.headers.get("x-amz-copy-source-range")
      const range =
        rangeHeader === null
          ? undefined
          : rangeHeader === ""
            ? new S3Error("InvalidCopyPartRange")
            : parseCopyRange(rangeHeader)
      const found = findCopySource(ctx, source)
      checkCopyPreconditions(ctx.headers, found)
      if (range instanceof S3Error) throw range
      const size = found.size
      if (range && range.start >= size)
        fail("InvalidRange", {
          message: `The requested range 'bytes=${range.start}-${range.end}' is not satisfiable`,
          actualObjectSize: String(size),
          rangeRequested: `${range.start}-${range.end}`,
        })
      if (range && range.end >= size) fail("InvalidCopyPartRangeSource")
      const length = range ? range.end - range.start + 1 : size
      if (length > MAX_OBJECT_SIZE) fail("EntityTooLarge")
      const upload = findUpload(ctx)
      await requireUploadChecksum(upload, "")
      const all = ctx.core.bytes(found)
      const bytes = range ? all.slice(range.start, range.end + 1) : all
      const part = savePart(ctx, upload.id, partNumber, bytes)
      return xmlResponse(
        "CopyPartResult",
        el("LastModified", isoDate(Math.floor(part.lastModified / 1000) * 1000)) +
          el("ETag", `"${part.etag}"`),
      )
    })
  },

  async CompleteMultipartUpload(ctx) {
    objectResources(ctx)
    const body = await ctx.text()
    if (!body.length) fail("MissingPart")
    const requested = parseComplete(body)
    if (!requested.length) fail("MissingPart")
    for (let index = 1; index < requested.length; index++)
      if (
        (requested[index] as CompletePart).partNumber <
        (requested[index - 1] as CompletePart).partNumber
      )
        fail("InvalidPartOrder")
    if (
      LOCK_HEADERS.some((name) => ctx.headers.has(name)) ||
      ctx.headers.has("x-amz-object-lock-legal-hold") ||
      ctx.headers.has("x-amz-bypass-governance-retention")
    )
      fail("InvalidRequest")
    const wantChecksum = contentChecksum(ctx.headers)
    const uploadId = uploadIdParam(ctx)
    if (!isRawUrlBase64(uploadId)) fail("NoSuchUpload")
    checkObjectName(ctx.key)
    ctx.core.requireBucket(ctx.bucket)
    checkPutPreconditions(ctx)
    const upload = findUpload(ctx, uploadId)
    const stored = new Map(partsOf(ctx, upload.id).map((part) => [part.partNumber, part]))
    for (const part of requested) if (!stored.has(part.partNumber)) fail("InvalidPart")
    const algorithm = upload.checksumAlgorithm
    const full = upload.checksumType === "FULL_OBJECT"
    if (algorithm && wantChecksum) {
      // `WantChecksum.Type.Is(checksumType)`: the FULL_OBJECT flag (not implied for CRC64NVME) must match too.
      const fullFlag = full && algorithm !== "CRC64NVME"
      const matches = wantChecksum.algorithm === algorithm && (!fullFlag || wantChecksum.full)
      if (!matches)
        fail("InvalidArgument", {
          message: `Invalid arguments provided for ${await uploadPath(upload)}: (checksum type mismatch. got ${JSON.stringify(algorithm)} (FULL_OBJECT) expected ${JSON.stringify(wantChecksum.algorithm)} (${objType(wantChecksum.full, wantChecksum.parts > 0)}))`,
        })
    }
    const chunks: Uint8Array[] = []
    const parts: PartInfo[] = []
    const rawChecksums: Uint8Array[] = []
    for (const [index, part] of requested.entries()) {
      const found = stored.get(part.partNumber) as MultipartPart
      if (canonicalEtag(part.etag) !== found.etag) fail("InvalidPart")
      let partChecksum: string | undefined
      if (algorithm) {
        const crc = found.checksums?.[algorithm] ?? ""
        if (!crc || part.checksums[algorithm] !== crc) fail("InvalidPart")
        partChecksum = crc
        rawChecksums.push(base64Raw(crc) as Uint8Array)
      }
      if (index < requested.length - 1 && found.size < MIN_PART_SIZE) fail("EntityTooSmall")
      chunks.push(ctx.core.state.blobs.get(found.blob))
      parts.push({
        number: part.partNumber,
        size: found.size,
        etag: found.etag,
        ...(partChecksum ? { checksum: partChecksum } : {}),
      })
    }
    const bytes = concat(chunks)
    let objectChecksum: StoredChecksum | undefined
    if (algorithm) {
      const value = full
        ? await digest(algorithm, bytes)
        : `${await digest(algorithm, concat(rawChecksums))}-${requested.length}`
      objectChecksum = { algorithm, value, type: full ? "FULL_OBJECT" : "COMPOSITE" }
    }
    if (wantChecksum) {
      if (algorithm && full) {
        if (wantChecksum.encoded !== objectChecksum?.value) fail("ContentChecksumMismatch")
      } else {
        const combined = await digest(wantChecksum.algorithm, concat(rawChecksums))
        if (
          (wantChecksum.parts > 0 && wantChecksum.parts !== requested.length) ||
          combined !== wantChecksum.encoded
        )
          fail("ContentChecksumMismatch")
      }
    }
    const etag = multipartEtag(requested.map((part) => canonicalEtag(part.etag)))
    const version: ObjectVersion = ctx.core.write(
      defined({
        bucket: ctx.bucket,
        key: ctx.key,
        etag,
        lastModified: ctx.now,
        metadata: upload.metadata,
        contentType: upload.contentType,
        contentEncoding: upload.contentEncoding,
        contentDisposition: upload.contentDisposition,
        contentLanguage: upload.contentLanguage,
        cacheControl: upload.cacheControl,
        expires: upload.expires,
        tagging: upload.tagging,
        storageClass: upload.storageClass,
        retention: upload.retention,
        legalHold: upload.legalHold,
        parts,
        checksum: objectChecksum,
      }),
      bytes,
    )
    dropUpload(ctx, upload.id)
    ctx.core.notify({
      eventName: "ObjectCreated:CompleteMultipartUpload",
      bucket: ctx.bucket,
      key: ctx.key,
      etag: version.etag,
      size: version.size,
      ...(version.versionId !== "null" ? { versionId: version.versionId } : {}),
    })
    const headers: Record<string, string> = { etag: `"${version.etag}"` }
    if (version.versionId !== "null") headers["x-amz-version-id"] = version.versionId
    if (objectChecksum) {
      headers[headerOf(objectChecksum.algorithm)] = objectChecksum.value
      headers["x-amz-checksum-type"] = objectChecksum.type
    }
    return xmlResponse(
      "CompleteMultipartUploadResult",
      el("Location", objectLocation(ctx)) +
        el("Bucket", ctx.bucket) +
        el("Key", ctx.key) +
        el("ETag", `"${version.etag}"`) +
        (objectChecksum ? el(`Checksum${objectChecksum.algorithm}`, objectChecksum.value) : ""),
      { headers },
    )
  },

  AbortMultipartUpload(ctx) {
    objectResources(ctx)
    const uploadId = uploadIdParam(ctx)
    if (!isRawUrlBase64(uploadId)) fail("NoSuchUpload")
    checkObjectName(ctx.key)
    ctx.core.requireBucket(ctx.bucket)
    const upload = uploadId ? ctx.core.state.uploads.get(uploadId) : undefined
    // MinIO answers 204 for an upload it does not know.
    if (upload && upload.bucket === ctx.bucket && upload.key === ctx.key) dropUpload(ctx, upload.id)
    return ok({}, 204)
  },

  ListParts(ctx) {
    const { maxParts: requestedMax, marker, encodingType } = objectResources(ctx)
    if (marker < 0) fail("InvalidPartNumberMarker")
    if (requestedMax < 0) fail("InvalidMaxParts")
    const upload = findUpload(ctx)
    const maxParts = Math.min(requestedMax, MAX_PARTS_LIST)
    let listed: MultipartPart[] = []
    let truncated = false
    if (maxParts > 0) {
      let all = partsOf(ctx, upload.id)
      const start = all.findIndex((part) => part.partNumber === marker)
      if (marker > 0) all = start < 0 ? [] : all.slice(start + 1)
      listed = all.slice(0, maxParts)
      truncated = all.length > listed.length
    }
    const next = truncated ? (listed[listed.length - 1] as MultipartPart).partNumber : 0
    const partXml = listed
      .map((part) =>
        wrap(
          "Part",
          el("PartNumber", part.partNumber) +
            el("LastModified", isoDate(Math.floor(part.lastModified / 1000) * 1000)) +
            el("ETag", `"${part.etag}"`) +
            el("Size", part.size) +
            (["CRC32", "CRC32C", "SHA1", "SHA256", "CRC64NVME"] as const)
              .map((algorithm) => {
                const value = part.checksums?.[algorithm]
                return value ? el(`Checksum${algorithm}`, value) : ""
              })
              .join(""),
        ),
      )
      .join("")
    return xmlResponse(
      "ListPartsResult",
      el("Bucket", ctx.bucket) +
        el("Key", encodeName(ctx.key, encodingType)) +
        el("UploadId", upload.id) +
        ownerXml("Initiator", OWNER_ID) +
        ownerXml("Owner", OWNER_ID) +
        el("StorageClass", "STANDARD") +
        el("PartNumberMarker", marker) +
        el("NextPartNumberMarker", next) +
        el("MaxParts", maxParts) +
        el("IsTruncated", truncated) +
        el("ChecksumAlgorithm", upload.checksumAlgorithm ?? "") +
        el("ChecksumType", upload.checksumType ?? "") +
        partXml,
    )
  },

  ListMultipartUploads(ctx) {
    const query = ctx.query
    let maxUploads = MAX_UPLOADS_LIST
    const rawMax = query.get("max-uploads") ?? ""
    if (rawMax !== "") {
      const parsed = atoi(rawMax)
      if (parsed === undefined) fail("InvalidMaxUploads")
      maxUploads = parsed as number
    }
    if (maxUploads < 0) fail("InvalidMaxUploads")
    const prefix = query.get("prefix") ?? ""
    const keyMarker = query.get("key-marker") ?? ""
    const uploadIdMarker = query.get("upload-id-marker") ?? ""
    const delimiter = query.get("delimiter") ?? ""
    const encodingType = query.get("encoding-type") ?? ""
    if (keyMarker && !keyMarker.startsWith(prefix)) fail("NotImplemented")
    if (uploadIdMarker) {
      if (keyMarker.endsWith("/"))
        fail("NotImplemented", {
          message: `A header you provided implies functionality that is not implemented (Invalid combination of uploadID marker '${uploadIdMarker}' and marker '${keyMarker}')`,
        })
      if (!isRawUrlBase64(uploadIdMarker)) fail("NoSuchUpload")
    }
    ctx.core.requireBucket(ctx.bucket)
    const all = ctx.core.state.uploads
      .list({ where: (upload) => upload.bucket === ctx.bucket, order: "oldest" })
      .sort((a, b) => a.value.initiated - b.value.initiated || a.seq - b.seq)
      .map(({ value }) => value)
    let listed: MultipartUpload[]
    let truncated = false
    let nextUploadIdMarker = ""
    if (!prefix) listed = all
    else {
      // With a prefix MinIO lists the uploads of exactly that key, paged by upload id.
      const uploads = all.filter((upload) => upload.key === prefix)
      let index = 0
      if (uploadIdMarker) {
        while (index < uploads.length && (uploads[index] as MultipartUpload).id !== uploadIdMarker)
          index++
        index++
      }
      listed = []
      while (index < uploads.length) {
        const upload = uploads[index] as MultipartUpload
        listed.push(upload)
        nextUploadIdMarker = upload.id
        index++
        if (listed.length === maxUploads) break
      }
      truncated = index < uploads.length
      if (!truncated) nextUploadIdMarker = ""
    }
    const uploadXml = listed
      .map((upload) =>
        wrap(
          "Upload",
          el("Key", encodeName(upload.key, encodingType)) +
            el("UploadId", upload.id) +
            ownerXml("Initiator", "") +
            ownerXml("Owner", "") +
            el("StorageClass", "") +
            el("Initiated", isoDate(upload.initiated)),
        ),
      )
      .join("")
    return xmlResponse(
      "ListMultipartUploadsResult",
      el("Bucket", ctx.bucket) +
        el("KeyMarker", encodeName(keyMarker, encodingType)) +
        el("UploadIdMarker", "") +
        el("NextKeyMarker", "") +
        el("NextUploadIdMarker", nextUploadIdMarker) +
        (delimiter ? el("Delimiter", encodeName(delimiter, encodingType)) : "") +
        el("Prefix", encodeName(prefix, encodingType)) +
        (encodingType ? el("EncodingType", encodingType) : "") +
        el("MaxUploads", maxUploads) +
        el("IsTruncated", truncated) +
        uploadXml,
    )
  },
}
