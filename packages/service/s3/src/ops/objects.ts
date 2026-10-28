/**
 * Object reads and writes, after MinIO's `PutObjectHandler`, `getObjectHandler` and
 * `headObjectHandler`: request validation in MinIO's order, `extractMetadataFromReq`,
 * `checkPreconditions` / `checkPreconditionsPUT`, `parseRequestRangeSpec` and `partNumber`
 * reads, `x-amz-checksum-*` verification and `x-amz-checksum-mode`, `response-*` overrides.
 */

import { faultEffect } from "@crvouga/mockingbird-service"
import {
  type ChecksumAlgorithm,
  checksum,
  InvalidChecksumError,
  type RequestChecksum,
  requestChecksum,
} from "../checksums.js"
import { type Ctx, type Handlers, ok } from "../context.js"
import { md5Hex } from "../digest.js"
import { fail, S3Error } from "../errors.js"
import type { ChecksumAlgorithmName, ObjectVersion, StoredChecksum } from "../state.js"
import { parseVersionId } from "../store.js"
import { httpDate } from "../xml.js"
import { objectHeaders, requireBucket, targetVersion } from "./common.js"
import { objectLockForWrite } from "./lock.js"

/** The most a single PUT takes (AWS's limit; MinIO's own is 5 TiB). */
const MAX_PUT_BYTES = 5 * 1024 ** 3
const encoder = new TextEncoder()

// ── object names ────────────────────────────────────────────────────────────

const hasBadPathComponent = (key: string) =>
  key.split(/[/\\]/).some((segment) => /^\s*\.{1,2}\s*$/.test(segment))

/**
 * MinIO's object-name checks (`checkObjectNameForLengthAndSlash`, `IsValidObjectPrefix`) plus the
 * backend's 255-byte limit on one path segment. `put` adds the length and leading-slash checks.
 */
const checkObjectName = (key: string, put: boolean) => {
  const bytes = encoder.encode(key).length
  if (put && bytes > 1024) fail("KeyTooLongError")
  if (put && key.startsWith("/")) fail("InvalidObjectNamePrefixSlash")
  if (
    hasBadPathComponent(key) ||
    key.includes("//") ||
    key.includes("\0") ||
    key.includes("�") ||
    key.split("/").some((segment) => encoder.encode(segment).length > 255)
  )
    fail("InvalidObjectName")
}

// ── metadata ────────────────────────────────────────────────────────────────

/** Go's `url.QueryUnescape`: `+` is a space, a malformed `%` escape is an error. */
const queryUnescape = (value: string): string | undefined => {
  if (/%(?![0-9a-fA-F]{2})/.test(value)) return undefined
  try {
    return decodeURIComponent(value.replace(/\+/g, " "))
  } catch {
    return undefined
  }
}

const TAG_CHARS = /^[a-zA-Z0-9-+\-._:/@ =]+$/
const tagError = (code: string, message: string) => fail("BadRequest", { code, message })

/** minio-go's `tags.ParseObjectTags`, which PutObject applies to `x-amz-tagging`. */
const validateTagging = (raw: string) => {
  const seen = new Set<string>()
  let unescapeError = false
  for (const pair of raw.split("&")) {
    if (!pair) continue
    const at = pair.indexOf("=")
    const key = queryUnescape(at < 0 ? pair : pair.slice(0, at))
    const value = queryUnescape(at < 0 ? "" : pair.slice(at + 1))
    if (key === undefined || value === undefined) {
      unescapeError = true
      continue
    }
    if (seen.has(key)) tagError("InvalidTag", "Cannot provide multiple Tags with the same key")
    if (!key || [...key].length > 128 || !TAG_CHARS.test(key))
      tagError("InvalidTag", "The TagKey you have provided is invalid")
    if (value && ([...value].length > 256 || !TAG_CHARS.test(value)))
      tagError("InvalidTag", "The TagValue you have provided is invalid")
    if (seen.size === 10) tagError("BadRequest", "Tags cannot be more than 10")
    seen.add(key)
  }
  if (unescapeError) fail("InvalidArgument", { message: "invalid URL escape" })
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
const HTTP_DATE =
  /^([A-Za-z]{3}), (\d{1,2}) ([A-Za-z]{3}) (\d{4}) (\d{1,2}):(\d{2}):(\d{2})(?:[.,](\d+))? GMT$/

/**
 * MinIO's `amztime.ParseHeader`: Go's `time.Parse` with `http.TimeFormat` or its one-digit-day
 * variant. Returns epoch milliseconds, or `undefined` when Go would not parse it.
 */
export const parseHttpDate = (value: string): number | undefined => {
  const match = HTTP_DATE.exec(value)
  if (!match) return undefined
  const [, weekday, day, month, year, hour, minute, second, fraction] = match
  if (!DAYS.includes((weekday as string).toLowerCase())) return undefined
  const monthIndex = MONTHS.indexOf((month as string).toLowerCase())
  if (monthIndex < 0) return undefined
  const [y, d, h, m, s] = [year, day, hour, minute, second].map(Number) as number[]
  const daysInMonth = new Date(Date.UTC(y as number, monthIndex + 1, 0)).getUTCDate()
  if ((d as number) < 1 || (d as number) > daysInMonth) return undefined
  if ((h as number) > 23 || (m as number) > 59 || (s as number) > 59) return undefined
  const millis = fraction ? Math.floor(Number(`0.${fraction}`) * 1000) : 0
  const at = new Date(0)
  at.setUTCFullYear(y as number, monthIndex, d as number)
  at.setUTCHours(h as number, m as number, s as number, millis)
  return at.getTime()
}

/** Headers `extractMetadataFromReq` keeps (`supportedHeaders`), lowercased. */
const SUPPORTED = [
  "content-type",
  "cache-control",
  "content-language",
  "content-encoding",
  "content-disposition",
  "x-amz-storage-class",
  "x-amz-tagging",
  "expires",
]

type Extracted = {
  system: Map<string, string>
  user: Record<string, string>
  minio: Record<string, string>
}

/**
 * `extractMetadataFromReq`: the query string first, then the headers (which win), keeping the
 * supported system headers and every `x-amz-meta-` / `x-minio-meta-` entry.
 */
const extractMetadata = (ctx: Ctx): Extracted => {
  const system = new Map<string, string>()
  const user: Record<string, string> = {}
  const minio: Record<string, string> = {}
  const take = (pairs: Iterable<[string, string]>) => {
    const grouped = new Map<string, string[]>()
    for (const [name, value] of pairs) {
      const lower = name.toLowerCase()
      grouped.set(lower, [...(grouped.get(lower) ?? []), value])
    }
    for (const [name, values] of grouped) {
      const value = values.join(",")
      if (SUPPORTED.includes(name)) system.set(name, value)
      else if (name.startsWith("x-amz-meta-")) user[name.slice("x-amz-meta-".length)] = value
      else if (name.startsWith("x-minio-meta-")) minio[name] = value
    }
  }
  take(ctx.query)
  take(ctx.headers)
  return { system, user, minio }
}

/** `trimAwsChunkedContentEncoding`. */
const trimAwsChunked = (value: string) =>
  value
    .split(",")
    .filter((part) => part !== "aws-chunked")
    .join(",")

// ── preconditions ───────────────────────────────────────────────────────────

/** `canonicalizeETag`: Go's `"*?([^"]*?)"*?$` replaced by `$1`. */
const canonicalEtag = (value: string) => value.replace(/"*?([^"]*?)"*?$/g, "$1")
/** `isETagEqual`. */
const etagMatches = (etag: string, header: string) =>
  header.trim() === "*" || canonicalEtag(etag) === canonicalEtag(header)

/** MinIO's `ifModifiedSince`: modified when mtime ≥ the given second + 1s. */
const modifiedSince = (version: ObjectVersion, given: number) =>
  version.lastModified >= given + 1000

/** `writeHeadersPrecondition`: what a 304 or a GET/HEAD 412 still carries. */
const preconditionHeaders = (version: ObjectVersion): Record<string, string> => {
  const headers: Record<string, string> = {
    "last-modified": httpDate(Math.floor(version.lastModified / 1000) * 1000),
  }
  if (version.etag) headers.etag = `"${version.etag}"`
  if (version.versionId && version.versionId !== "null")
    headers["x-amz-version-id"] = version.versionId
  if (version.expires) headers.expires = version.expires
  if (version.cacheControl) headers["cache-control"] = version.cacheControl
  return headers
}

/**
 * An error `checkPreconditions` writes with `writeErrorResponse` even for HEAD: no
 * `x-minio-error-*` headers, just the XML content type and whatever headers were set.
 */
const precheckError = (
  ctx: Ctx,
  name: "PreconditionFailed" | "InvalidPartNumber",
  headers: Record<string, string> = {},
): never => {
  if (ctx.method === "HEAD") {
    const error = new S3Error(name)
    throw new HeadResponse(
      new Response(null, {
        status: error.status,
        headers: { ...headers, "content-type": "application/xml" },
      }),
    )
  }
  return fail(name, { headers })
}

/** A finished response thrown out of the read path (HEAD answers without an error body). */
class HeadResponse extends Error {
  constructor(readonly response: Response) {
    super("head response")
  }
}

/** `checkPreconditions` for GET and HEAD: a 304 response, or throws 412 / 416. */
const checkPreconditions = (ctx: Ctx, version: ObjectVersion, partNumber: number) => {
  if (partNumber > 1) {
    const parts = version.parts?.map((part) => part.number) ?? [1]
    if (!parts.includes(partNumber)) precheckError(ctx, "InvalidPartNumber")
  }
  const ifNoneMatch = ctx.headers.get("if-none-match") ?? ""
  if (ifNoneMatch && etagMatches(version.etag, ifNoneMatch))
    return new Response(null, { status: 304, headers: preconditionHeaders(version) })
  const ifModifiedSince = ctx.headers.get("if-modified-since") ?? ""
  if (ifModifiedSince) {
    const given = parseHttpDate(ifModifiedSince)
    if (given !== undefined && !modifiedSince(version, given))
      return new Response(null, { status: 304, headers: preconditionHeaders(version) })
  }
  const ifMatch = ctx.headers.get("if-match") ?? ""
  if (ifMatch && !etagMatches(version.etag, ifMatch))
    precheckError(ctx, "PreconditionFailed", preconditionHeaders(version))
  const ifUnmodifiedSince = ctx.headers.get("if-unmodified-since") ?? ""
  if (ifUnmodifiedSince && !ifMatch) {
    const given = parseHttpDate(ifUnmodifiedSince)
    if (given !== undefined && modifiedSince(version, given))
      precheckError(ctx, "PreconditionFailed", preconditionHeaders(version))
  }
  return undefined
}

/** `checkPreconditionsPUT` (with `putObject`'s rule that If-Match needs an existing object). */
const checkPutPreconditions = (ctx: Ctx) => {
  const ifMatch = ctx.headers.get("if-match") ?? ""
  const ifNoneMatch = ctx.headers.get("if-none-match") ?? ""
  if (!ifMatch && !ifNoneMatch) return
  const current = ctx.core.head(ctx.bucket, ctx.key)
  if (!current || current.deleteMarker) {
    if (ifMatch) fail("NoSuchKey")
    return
  }
  const failed = () =>
    fail("PreconditionFailed", {
      headers: {
        "last-modified": httpDate(Math.floor(current.lastModified / 1000) * 1000),
        ...(current.etag ? { etag: `"${current.etag}"` } : {}),
      },
    })
  if (ifMatch && !etagMatches(current.etag, ifMatch)) failed()
  if (ifNoneMatch && etagMatches(current.etag, ifNoneMatch)) failed()
}

// ── ranges ──────────────────────────────────────────────────────────────────

type RangeSpec = { suffix: boolean; start: bigint; end: bigint }
const INT64_MAX = (1n << 63n) - 1n

/** Go's `strconv.ParseInt(value, 10, 64)`. */
const parseInt64 = (value: string): bigint | undefined => {
  if (!/^[+-]?\d+$/.test(value)) return undefined
  const parsed = BigInt(value)
  return parsed > INT64_MAX || parsed < -INT64_MAX - 1n ? undefined : parsed
}

/**
 * `parseRequestRangeSpec`: `undefined` for a header MinIO ignores (anything malformed), a spec,
 * or InvalidRange for a reversed range or `bytes=-0`.
 */
const parseRange = (header: string): RangeSpec | undefined => {
  if (!header.startsWith("bytes=")) return undefined
  const spec = header.slice("bytes=".length)
  const dash = spec.indexOf("-")
  if (dash < 0) return undefined
  const parse = (text: string): bigint | undefined | null => {
    if (!text) return -1n
    if (text.startsWith("+")) return null
    const value = parseInt64(text)
    return value === undefined || value < 0n ? null : value
  }
  const start = parse(spec.slice(0, dash))
  const end = parse(spec.slice(dash + 1))
  if (start === null || end === null || start === undefined || end === undefined) return undefined
  if (start > -1n && end > -1n) {
    if (start > end) fail("InvalidRange")
    return { suffix: false, start, end }
  }
  if (start > -1n) return { suffix: false, start, end: -1n }
  if (end > -1n) {
    if (end === 0n) fail("InvalidRange")
    return { suffix: true, start: -end, end: -1n }
  }
  return undefined
}

/** `HTTPRangeSpec.GetOffsetLength`: `[start, length]`, or InvalidRange with MinIO's details. */
const resolveRange = (
  spec: RangeSpec,
  size: number,
  headers?: Headers,
): [start: number, length: number] => {
  const total = BigInt(size)
  if (spec.suffix) {
    const length = -spec.start < total ? -spec.start : total
    const start = total + spec.start > 0n ? total + spec.start : 0n
    return [Number(start), Number(length)]
  }
  if (spec.start >= total)
    fail("InvalidRange", {
      message: `The requested range 'bytes=${spec.start}-${spec.end}' is not satisfiable`,
      actualObjectSize: String(size),
      rangeRequested: `${spec.start}-${spec.end}`,
      // setObjectHeaders fails before it writes Content-Length.
      ...(headers
        ? {
            headers: Object.fromEntries([...headers].filter(([name]) => name !== "content-length")),
          }
        : {}),
    })
  const end = spec.end > -1n ? (spec.end >= total ? total - 1n : spec.end) : total - 1n
  return [Number(spec.start), Number(end - spec.start + 1n)]
}

/** `partNumberToRangeSpec`: the byte range of one part (`undefined` for an empty object). */
const partRange = (version: ObjectVersion, partNumber: number): RangeSpec | undefined => {
  if (version.size === 0) return undefined
  const sizes = version.parts?.map((part) => part.size) ?? [version.size]
  let start = 0n
  let end = -1n
  for (let index = 0; index < sizes.length && index < partNumber; index++) {
    start = end + 1n
    end = start + BigInt(sizes[index] as number) - 1n
  }
  return { suffix: false, start, end }
}

// ── request options ─────────────────────────────────────────────────────────

/** `getOpts`' `partNumber` (0 when absent). */
const requestPartNumber = (ctx: Ctx): number => {
  const raw = ctx.query.get("partNumber") ?? ""
  if (!raw) return 0
  const parsed = /^[+-]?\d+$/.test(raw) ? BigInt(raw) : undefined
  if (parsed === undefined || parsed > INT64_MAX || parsed < -INT64_MAX - 1n)
    fail("InternalError", {
      message: `We encountered an internal error, please try again.: cause(strconv.Atoi: parsing ${JSON.stringify(raw)}: ${parsed === undefined ? "invalid syntax" : "value out of range"})`,
    })
  const value = Number(parsed)
  if (value > 10000) fail("InvalidMaxParts")
  if (value <= 0) fail("AdminInvalidArgument")
  return value
}

const RESPONSE_OVERRIDES: Record<string, string> = {
  "response-expires": "expires",
  "response-content-type": "content-type",
  "response-cache-control": "cache-control",
  "response-content-encoding": "content-encoding",
  "response-content-language": "content-language",
  "response-content-disposition": "content-disposition",
}

/** `setHeadGetRespHeaders`: `response-*` query parameters (any case) replace object headers. */
const applyOverrides = (ctx: Ctx, headers: Headers) => {
  const values = new Map<string, string[]>()
  for (const [name, value] of ctx.query) {
    const header = RESPONSE_OVERRIDES[name.toLowerCase()]
    if (header) values.set(name, [...(values.get(name) ?? []), value])
  }
  for (const [name, list] of values)
    headers.set(RESPONSE_OVERRIDES[name.toLowerCase()] as string, list.join(","))
}

const hasOverrides = (ctx: Ctx) =>
  [...ctx.query.keys()].some((name) => RESPONSE_OVERRIDES[name.toLowerCase()] !== undefined)

/** SSE-S3 / SSE-KMS request headers make a GET or HEAD a BadRequest. */
const requestsServerSideEncryption = (headers: Headers) =>
  headers.has("x-amz-server-side-encryption") ||
  headers.has("x-amz-server-side-encryption-aws-kms-key-id") ||
  headers.has("x-amz-server-side-encryption-context")

/** The checksum headers `x-amz-checksum-mode: ENABLED` adds (`decryptChecksums`). */
const checksumHeaders = (version: ObjectVersion, partNumber: number): Record<string, string> => {
  const stored = version.checksum
  if (!stored) return {}
  const name = `x-amz-checksum-${stored.algorithm.toLowerCase()}`
  if (partNumber > 0) {
    const part = version.parts?.find((entry) => entry.number === partNumber)
    return part?.checksum ? { [name]: part.checksum } : {}
  }
  return { [name]: stored.value, "x-amz-checksum-type": stored.type }
}

// ── GET / HEAD ──────────────────────────────────────────────────────────────

/** The shared read path of GetObject and HeadObject, in MinIO's order of checks. */
const read = async (ctx: Ctx): Promise<Response> => {
  const head = ctx.method === "HEAD"
  if (requestsServerSideEncryption(ctx.headers)) fail("BadRequest")
  const partNumber = requestPartNumber(ctx)
  if (
    !head &&
    hasOverrides(ctx) &&
    ctx.auth === "anonymous" &&
    ctx.core.options.authentication === "lenient"
  )
    fail("BadRequest", {
      code: "InvalidRequest",
      message: "Request specific response headers cannot be used for anonymous GET requests.",
    })
  const rangeHeader = ctx.headers.get("range") ?? ""
  let range: RangeSpec | undefined
  if (rangeHeader) {
    if (partNumber > 0) fail("InvalidRangePartNumber")
    range = parseRange(rangeHeader)
  }
  checkObjectName(ctx.key, false)
  requireBucket(ctx)
  const version = targetVersion(ctx)
  const notModified = checkPreconditions(ctx, version, partNumber)
  if (notModified) return notModified
  const tagging = ctx.headers.get("x-amz-tagging-directive") === "ACCESS"
  const headers = objectHeaders(version, { tagging })
  if (ctx.headers.get("x-amz-checksum-mode") === "ENABLED" && !range)
    for (const [name, value] of Object.entries(checksumHeaders(version, partNumber)))
      headers.set(name, value)
  const spec = range ?? (partNumber > 0 ? partRange(version, partNumber) : undefined)
  let start = 0
  let length = version.size
  if (spec) {
    // HEAD fails here after setObjectHeaders, so its error carries the object headers.
    ;[start, length] = resolveRange(spec, version.size, head ? headers : undefined)
    headers.set("content-length", String(length))
    headers.set("content-range", `bytes ${start}-${start + length - 1}/${version.size}`)
  }
  if (partNumber > 0 && version.parts?.length && version.etag.includes("-"))
    headers.set("x-amz-mp-parts-count", String(version.parts.length))
  applyOverrides(ctx, headers)
  const status = spec || partNumber > 0 ? 206 : 200
  if (head) return new Response(null, { status, headers })
  const all = ctx.core.bytes(version)
  if (faultEffect(ctx.request, "truncate_stream") !== undefined) {
    const half = all.slice(0, Math.floor(all.length / 2))
    headers.set("content-length", String(half.length))
    headers.set("x-mockingbird-truncated", "true")
    return new Response(half, { status: 200, headers })
  }
  return new Response(spec ? all.slice(start, start + length) : all, { status, headers })
}

const readObject = async (ctx: Ctx) => {
  try {
    return await read(ctx)
  } catch (error) {
    if (error instanceof HeadResponse) return error.response
    throw error
  }
}

// ── PUT ─────────────────────────────────────────────────────────────────────

/** `etag.FromContentMD5`: a present Content-MD5 must be base64 of 16 bytes. */
const checkContentMd5 = (headers: Headers) => {
  const value = headers.get("content-md5")
  if (value === null) return
  let length = -1
  try {
    if (/^[A-Za-z0-9+/]*={0,2}$/.test(value) && value.length % 4 === 0) length = atob(value).length
  } catch {}
  if (length !== 16) fail("InvalidDigest")
}

/** The declared payload size (`x-amz-decoded-content-length` for streaming uploads). */
const declaredSize = (ctx: Ctx): number => {
  const streaming = ctx.auth.startsWith("streaming")
  const decoded = ctx.headers.get("x-amz-decoded-content-length")
  if (streaming && decoded !== null) {
    if (decoded === "") fail("MissingContentLength")
    const value = Number(decoded)
    if (!/^[+-]?\d+$/.test(decoded)) fail("InvalidArgument")
    return value
  }
  const length = ctx.headers.get("content-length")
  if (length === null) {
    // A chunked transfer has no length; an in-process Request simply carries its body.
    if (ctx.headers.has("transfer-encoding")) fail("MissingContentLength")
    return 0
  }
  return Number(length)
}

const parseChecksum = (headers: Headers): RequestChecksum | undefined => {
  try {
    return requestChecksum(headers)
  } catch (error) {
    if (error instanceof InvalidChecksumError) fail("InvalidChecksum")
    throw error
  }
}

const verifyChecksum = async (
  ctx: Ctx,
  wanted: RequestChecksum,
  bytes: Uint8Array,
): Promise<StoredChecksum> => {
  let value = wanted.value
  if (wanted.trailing) value = (await ctx.trailers())[`x-amz-checksum-${wanted.algorithm}`] ?? ""
  const actual = await checksum(wanted.algorithm as ChecksumAlgorithm, bytes)
  if (!value || actual !== value) fail("ContentChecksumMismatch")
  return {
    algorithm: wanted.algorithm.toUpperCase() as ChecksumAlgorithmName,
    value:
      wanted.parts !== undefined && wanted.type === "COMPOSITE"
        ? `${value}-${wanted.parts}`
        : value,
    type: wanted.type,
  }
}

/**
 * `putOpts`' `?versionId=`: `null` or a UUID, and a UUID only in a versioning-enabled bucket. A
 * directory object (`key/`) is never versioned.
 */
const putVersionId = (ctx: Ctx): string | undefined => {
  const raw = (ctx.query.get("versionId") ?? "").trim()
  if (raw && raw !== "null") {
    if (parseVersionId(raw) === undefined) fail("InvalidVersionID")
    if (ctx.core.bucket(ctx.bucket)?.versioning !== "Enabled")
      fail("InvalidArgument", {
        message: `Invalid arguments provided for ${ctx.bucket}/${ctx.key}: (VersionID specified , but versioning not enabled on bucket=${ctx.bucket})`,
      })
  }
  if (raw) return raw
  return ctx.key.endsWith("/") ? "null" : undefined
}

const putObject = async (ctx: Ctx): Promise<Response> => {
  const headers = ctx.headers
  if (headers.has("x-amz-copy-source")) fail("InvalidCopySource")
  const storageClass = headers.get("x-amz-storage-class") ?? ""
  if (storageClass && storageClass !== "STANDARD" && storageClass !== "REDUCED_REDUNDANCY")
    fail("InvalidStorageClass")
  checkContentMd5(headers)
  if (declaredSize(ctx) > MAX_PUT_BYTES) fail("EntityTooLarge")
  const { system, user, minio } = extractMetadata(ctx)
  const tagging = headers.get("x-amz-tagging") ?? ""
  if (tagging) validateTagging(tagging)
  const versionId = putVersionId(ctx)
  const wanted = parseChecksum(headers)
  checkObjectName(ctx.key, true)
  requireBucket(ctx)
  checkPutPreconditions(ctx)
  const lock = objectLockForWrite(ctx.core, ctx.bucket, headers, ctx.now)
  const bytes = await ctx.body()
  const stored = wanted ? await verifyChecksum(ctx, wanted, bytes) : undefined
  const encoding = trimAwsChunked(system.get("content-encoding") ?? "")
  const expires = parseHttpDate(system.get("expires") ?? "")
  const objectTags = tagging || system.get("x-amz-tagging") || ""
  const objectClass = system.get("x-amz-storage-class")
  const version = ctx.core.write(
    {
      ...(versionId ? { versionId } : {}),
      bucket: ctx.bucket,
      key: ctx.key,
      etag: md5Hex(bytes),
      lastModified: ctx.now,
      metadata: user,
      contentType: system.get("content-type") ?? "binary/octet-stream",
      ...(encoding ? { contentEncoding: encoding } : {}),
      ...(system.has("content-disposition")
        ? { contentDisposition: system.get("content-disposition") as string }
        : {}),
      ...(system.has("content-language")
        ? { contentLanguage: system.get("content-language") as string }
        : {}),
      ...(system.has("cache-control")
        ? { cacheControl: system.get("cache-control") as string }
        : {}),
      ...(expires !== undefined ? { expires: httpDate(expires) } : {}),
      ...(objectTags ? { tagging: objectTags } : {}),
      ...(objectClass && objectClass !== "STANDARD" ? { storageClass: objectClass } : {}),
      ...(Object.keys(minio).length ? { extra: minio } : {}),
      ...(stored ? { checksum: stored } : {}),
      ...lock,
    },
    bytes,
  )
  ctx.core.notify({
    eventName: "ObjectCreated:Put",
    bucket: ctx.bucket,
    key: ctx.key,
    etag: version.etag,
    size: version.size,
    ...(version.versionId !== "null" ? { versionId: version.versionId } : {}),
  })
  return ok({
    etag: `"${version.etag}"`,
    ...(version.versionId !== "null" ? { "x-amz-version-id": version.versionId } : {}),
    ...(stored
      ? {
          [`x-amz-checksum-${stored.algorithm.toLowerCase()}`]: stored.value.replace(/-\d+$/, ""),
          "x-amz-checksum-type": stored.type,
        }
      : {}),
  })
}

export const objectHandlers: Handlers = {
  PutObject: putObject,
  GetObject: readObject,
  HeadObject: readObject,
}
