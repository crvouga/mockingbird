/**
 * CopyObject, after MinIO's `CopyObjectHandler`: the copy source is parsed like Go's `url.Parse`,
 * validated in MinIO's order (source, version id, directives, storage class), read with the
 * `x-amz-copy-source-if-*` preconditions, and written as a new version that shares the source's
 * bytes. The source parsing, lookup and preconditions are exported for UploadPartCopy.
 */
import { CHECKSUM_ALGORITHMS, type ChecksumAlgorithm, checksum } from "../checksums.js"
import { type Ctx, type Handlers, xmlResponse } from "../context.js"
import { md5Hex } from "../digest.js"
import { fail, S3Error } from "../errors.js"
import type { ChecksumAlgorithmName, ObjectVersion, StoredChecksum } from "../state.js"
import { isValidBucketNameStrict } from "../validation.js"
import { el, httpDate, isoDate } from "../xml.js"
import { userMetadata } from "./common.js"

export type CopySource = {
  bucket: string
  key: string
  /** The trimmed `?versionId=` of the copy source; `""` when none was given. */
  versionId: string
}

// ── copy-source parsing ─────────────────────────────────────────────────────

/** Go's `url.unescape` in path mode: `+` stays, a malformed `%` escape is an error. */
const unescapePath = (value: string): string | undefined => {
  const bytes: number[] = []
  const encoder = new TextEncoder()
  for (let index = 0; index < value.length; index++) {
    const char = value[index] as string
    if (char === "%") {
      const hex = value.slice(index + 1, index + 3)
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) return undefined
      bytes.push(Number.parseInt(hex, 16))
      index += 2
    } else {
      const code = value.codePointAt(index) as number
      if (code > 0xffff) index++
      bytes.push(...encoder.encode(String.fromCodePoint(code)))
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

/** Go's `url.QueryUnescape`: `+` is a space. */
const unescapeQuery = (value: string) => unescapePath(value.replace(/\+/g, " "))

/** The first value of `name` in a raw query, as Go's `url.Values.Get` reads it. */
const queryValue = (rawQuery: string, name: string): string => {
  for (const pair of rawQuery.split("&")) {
    if (!pair || pair.includes(";")) continue
    const at = pair.indexOf("=")
    const key = unescapeQuery(at < 0 ? pair : pair.slice(0, at))
    const value = unescapeQuery(at < 0 ? "" : pair.slice(at + 1))
    if (key === undefined || value === undefined) continue
    if (key === name) return value
  }
  return ""
}

/** `url.Parse(raw)` reduced to what MinIO reads: the unescaped path and `versionId`. */
const parseUrl = (raw: string): { path: string; versionId: string } | undefined => {
  const hash = raw.indexOf("#")
  let rest = hash < 0 ? raw : raw.slice(0, hash)
  if (hash >= 0 && unescapePath(raw.slice(hash + 1)) === undefined) return undefined
  if ([...rest].some((char) => char < " " || char === "\x7f")) return undefined
  if (rest.startsWith(":")) return undefined
  let rawQuery = ""
  const question = rest.indexOf("?")
  if (question >= 0) {
    rawQuery = rest.slice(question + 1)
    rest = rest.slice(0, question)
  }
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.exec(rest)
  if (scheme) {
    rest = rest.slice(scheme[0].length)
    // An opaque `scheme:rest` has no path at all.
    if (!rest.startsWith("/")) return { path: "", versionId: queryValue(rawQuery, "versionId") }
  } else {
    const firstSegment = rest.split("/")[0] ?? ""
    if (firstSegment.includes(":")) return undefined
  }
  if (rest.startsWith("//") && (scheme || !rest.startsWith("///"))) {
    const slash = rest.indexOf("/", 2)
    rest = slash < 0 ? "" : rest.slice(slash)
  }
  const path = unescapePath(rest)
  if (path === undefined) return undefined
  return { path, versionId: queryValue(rawQuery, "versionId") }
}

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

/** MinIO's `trimLeadingSlash`. */
const trimLeadingSlash = (value: string) => {
  if (!value.startsWith("/")) return value
  const cleaned =
    value.length > 1 && value.endsWith("/") ? `${cleanPath(value)}/` : cleanPath(value)
  return cleaned.slice(1)
}

/** `github.com/google/uuid.Parse`: the canonical, braced, `urn:uuid:` and bare-hex forms. */
const isUuid = (value: string) =>
  /^(urn:uuid:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ||
  /^\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/i.test(value) ||
  /^[0-9a-f]{32}$/i.test(value)

/**
 * The `x-amz-copy-source` header as MinIO reads it: `[/]bucket/key[?versionId=...]`, URL-decoded.
 * InvalidCopySource without a bucket and key; NoSuchVersion for a version id that is not a UUID.
 * Errors carry the destination as their `<Key>`/`<BucketName>`, as MinIO's do at this point.
 */
export const parseCopySource = (ctx: Ctx): CopySource => {
  const header = ctx.headers.get("x-amz-copy-source") ?? ""
  const parsed = parseUrl(header)
  const path = parsed ? parsed.path : header
  const versionId = parsed ? parsed.versionId.trim() : ""
  const trimmed = path.startsWith("/") ? path.slice(1) : path
  const slash = trimmed.indexOf("/")
  const bucket = slash < 0 ? trimmed : trimmed.slice(0, slash)
  const rawKey = slash < 0 ? "" : trimmed.slice(slash + 1)
  if (!bucket || !rawKey) fail("InvalidCopySource")
  const key = trimLeadingSlash(rawKey)
  if (versionId && versionId !== "null" && !isUuid(versionId)) fail("NoSuchVersion")
  return { bucket, key, versionId }
}

/** Run `action` with errors attributed to the copy source, as MinIO's request info is by then. */
export const withSourceScope = async <T>(
  source: CopySource,
  action: () => T | Promise<T>,
): Promise<T> => {
  try {
    return await action()
  } catch (error) {
    if (!(error instanceof S3Error)) throw error
    throw new S3Error(error.errorName, {
      ...error.options,
      code: error.code,
      status: error.status,
      message: error.message,
      bucket: error.options.bucket ?? source.bucket,
      key: error.options.key ?? source.key,
    })
  }
}

// ── the source object ───────────────────────────────────────────────────────

/** MinIO's `IsValidObjectPrefix`: no `.`/`..` segment, no `//`, no NUL. */
const isValidObjectName = (key: string) =>
  !key.split(/[/\\]/).some((segment) => /^\s*\.{1,2}\s*$/.test(segment)) &&
  !key.includes("//") &&
  !key.includes("\u0000") &&
  !key.includes("�")

/**
 * The source version, as `GetObjectNInfo` finds it: InvalidBucketName, XMinioInvalidObjectName,
 * NoSuchBucket, NoSuchVersion / NoSuchKey; a delete marker is NoSuchKey (latest) or
 * MethodNotAllowed (named by version), with `x-amz-version-id` / `x-amz-delete-marker`.
 */
export const findCopySource = (ctx: Ctx, source: CopySource): ObjectVersion => {
  if (!isValidBucketNameStrict(source.bucket)) fail("InvalidBucketName")
  if (!isValidObjectName(source.key)) fail("InvalidObjectName")
  ctx.core.requireBucket(source.bucket)
  const found = source.versionId
    ? ctx.core.version(source.bucket, source.key, source.versionId)
    : ctx.core.head(source.bucket, source.key)
  if (!found) return fail(source.versionId ? "NoSuchVersion" : "NoSuchKey")
  if (found.deleteMarker) {
    const headers: Record<string, string> =
      found.versionId !== "null"
        ? { "x-amz-version-id": found.versionId, "x-amz-delete-marker": "true" }
        : {}
    fail(source.versionId ? "MethodNotAllowed" : "NoSuchKey", { headers })
  }
  return found
}

// ── preconditions ───────────────────────────────────────────────────────────

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/**
 * MinIO's `amztime.ParseHeader`: `http.TimeFormat` (`Mon, 02 Jan 2006 15:04:05 GMT`) or its
 * single-digit-day variant. Anything else is `undefined` (and the condition is ignored).
 */
export const parseHttpDate = (value: string): number | undefined => {
  const match =
    /^([A-Za-z]{3}), (\d{1,2}) ([A-Za-z]{3}) (\d{4}) (\d{1,2}):(\d{2}):(\d{2}) GMT$/.exec(value)
  if (!match) return undefined
  const [, weekday, day, monthName, year, hour, minute, second] = match as unknown as string[]
  const month = MONTHS.indexOf(monthName as string)
  if (!WEEKDAYS.includes(weekday as string) || month < 0) return undefined
  const [d, h, m, s, y] = [day, hour, minute, second, year].map(Number) as number[]
  const daysInMonth = new Date(Date.UTC(y as number, month + 1, 0)).getUTCDate()
  if (
    !d ||
    (d as number) > daysInMonth ||
    (h as number) > 23 ||
    (m as number) > 59 ||
    (s as number) > 59
  )
    return undefined
  return Date.UTC(y as number, month, d, h, m, s)
}

/** MinIO's `canonicalizeETag` + `isETagEqual` (`*` matches anything). */
const etagMatches = (etag: string, given: string) =>
  given.trim() === "*" ||
  etag.replace(/"*?([^"]*?)"*?$/g, "$1") === given.replace(/"*?([^"]*?)"*?$/g, "$1")

/** Go's `ifModifiedSince`: the second-truncated header time, so `mtime >= t + 1s`. */
const modifiedSince = (lastModified: number, given: number) => lastModified >= given + 1000

/**
 * `checkCopyObjectPreconditions`: if-modified-since, if-unmodified-since, if-match, then
 * if-none-match (in that order, each failing on its own). A failure is 412 PreconditionFailed
 * carrying the source's `ETag` and `Last-Modified`.
 */
export const checkCopyPreconditions = (headers: Headers, source: ObjectVersion) => {
  if (!source.lastModified) return
  const failed = () =>
    fail("PreconditionFailed", {
      headers: {
        "last-modified": httpDate(Math.floor(source.lastModified / 1000) * 1000),
        ...(source.etag ? { etag: `"${source.etag}"` } : {}),
      },
    })
  const since = headers.get("x-amz-copy-source-if-modified-since")
  const sinceTime = since ? parseHttpDate(since) : undefined
  if (sinceTime !== undefined && !modifiedSince(source.lastModified, sinceTime)) failed()
  const unmodified = headers.get("x-amz-copy-source-if-unmodified-since")
  const unmodifiedTime = unmodified ? parseHttpDate(unmodified) : undefined
  if (unmodifiedTime !== undefined && modifiedSince(source.lastModified, unmodifiedTime)) failed()
  const match = headers.get("x-amz-copy-source-if-match")
  if (match && !etagMatches(source.etag, match)) failed()
  const noneMatch = headers.get("x-amz-copy-source-if-none-match")
  if (noneMatch && etagMatches(source.etag, noneMatch)) failed()
}

// ── tags ────────────────────────────────────────────────────────────────────

const TAG_CHARS = /^[a-zA-Z0-9-+\-._:/@ =]+$/
const tagError = (code: string, message: string) =>
  fail("BadRequest", { code, message, status: 400 })

/** minio-go's `tags.ParseObjectTags` validation of an `x-amz-tagging` value. */
export const validateObjectTags = (raw: string) => {
  const seen = new Set<string>()
  for (const pair of raw.split("&")) {
    if (!pair) continue
    const at = pair.indexOf("=")
    const key = unescapeQuery(at < 0 ? pair : pair.slice(0, at))
    const value = unescapeQuery(at < 0 ? "" : pair.slice(at + 1))
    if (key === undefined || value === undefined) continue
    if (seen.has(key)) tagError("InvalidTag", "Cannot provide multiple Tags with the same key")
    if (!key || [...key].length > 128 || !TAG_CHARS.test(key))
      tagError("InvalidTag", "The TagKey you have provided is invalid")
    if (value && ([...value].length > 256 || !TAG_CHARS.test(value)))
      tagError("InvalidTag", "The TagValue you have provided is invalid")
    if (seen.size === 10) tagError("BadRequest", "Tags cannot be more than 10")
    seen.add(key)
  }
}

// ── checksums ───────────────────────────────────────────────────────────────

/** `hash.NewChecksumHeader` → the base algorithm a copy must compute, if a valid one was asked. */
const requestedChecksum = (headers: Headers): ChecksumAlgorithmName | undefined => {
  const algorithm = (headers.get("x-amz-checksum-algorithm") ?? "").toUpperCase()
  const type = headers.get("x-amz-checksum-type") ?? ""
  if (type !== "" && type !== "FULL_OBJECT" && type !== "COMPOSITE") return undefined
  if (!CHECKSUM_ALGORITHMS.includes(algorithm.toLowerCase() as ChecksumAlgorithm)) return undefined
  if (type === "FULL_OBJECT" && (algorithm === "SHA1" || algorithm === "SHA256")) return undefined
  return algorithm as ChecksumAlgorithmName
}

const computeChecksum = async (
  algorithm: ChecksumAlgorithmName,
  bytes: Uint8Array,
): Promise<StoredChecksum> => ({
  algorithm,
  value: await checksum(algorithm.toLowerCase() as ChecksumAlgorithm, bytes),
  type: "FULL_OBJECT",
})

// ── CopyObject ──────────────────────────────────────────────────────────────

const isDirectiveValid = (value: string | null) =>
  value === null || value === "" || value === "COPY" || value === "REPLACE"

/** MinIO keeps only these two classes; STANDARD is the default and never shown. */
const isValidStorageClass = (value: string) =>
  value === "STANDARD" || value === "REDUCED_REDUNDANCY"

/** The fields `extractMetadataFromReq` takes from a REPLACE request. */
const replacedFields = (headers: Headers) => {
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
    contentType: headers.get("content-type") ?? "binary/octet-stream",
    contentEncoding: encoding || undefined,
    contentDisposition: optional("content-disposition"),
    contentLanguage: optional("content-language"),
    cacheControl: optional("cache-control"),
    expires: expiresAt === undefined ? undefined : httpDate(expiresAt),
  }
}

/** Drop `undefined` fields so stored records stay minimal. */
const defined = <T extends Record<string, unknown>>(record: T): T =>
  Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T

export const copyHandlers: Handlers = {
  async CopyObject(ctx) {
    const source = parseCopySource(ctx)
    return withSourceScope(source, () => copyObject(ctx, source))
  },
}

const copyObject = async (ctx: Ctx, source: CopySource): Promise<Response> => {
  const { headers, core } = ctx
  const metadataDirective = headers.get("x-amz-metadata-directive")
  const taggingDirective = headers.get("x-amz-tagging-directive")
  if (!isDirectiveValid(metadataDirective)) fail("InvalidMetadataDirective")
  if (!isDirectiveValid(taggingDirective)) fail("InvalidTagDirective")
  const storageClass = headers.get("x-amz-storage-class") ?? ""
  if (storageClass && !isValidStorageClass(storageClass)) fail("InvalidStorageClass")
  // copyDstOpts: a `?versionId=` on the destination must be a UUID of a versioned bucket.
  const destinationVersion = (ctx.query.get("versionId") ?? "").trim()
  if (destinationVersion && destinationVersion !== "null") {
    if (!isUuid(destinationVersion)) fail("InvalidVersionID")
    if (core.bucket(ctx.bucket)?.versioning !== "Enabled")
      fail("InvalidArgument", {
        message: `Invalid arguments provided for ${ctx.bucket}/${ctx.key}: (VersionID specified , but versioning not enabled on bucket=${ctx.bucket})`,
      })
  }

  const found = findCopySource(ctx, source)
  checkCopyPreconditions(headers, found)

  const sameObject = source.bucket === ctx.bucket && source.key === ctx.key
  const sourceClass = found.storageClass ?? "STANDARD"
  const changesClass = storageClass !== "" && storageClass !== sourceClass
  let metadataOnly = sameObject && !changesClass
  const replaceMetadata = metadataDirective === "REPLACE"
  const replaceTags = taggingDirective === "REPLACE"

  const fields = replaceMetadata
    ? replacedFields(headers)
    : {
        metadata: { ...found.metadata },
        contentType: found.contentType,
        contentEncoding: found.contentEncoding,
        contentDisposition: found.contentDisposition,
        contentLanguage: found.contentLanguage,
        cacheControl: found.cacheControl,
        expires: found.expires,
        websiteRedirect: found.websiteRedirect,
        ...(found.extra ? { extra: { ...found.extra } } : {}),
      }
  const nextClass = storageClass || (replaceMetadata ? "" : (found.storageClass ?? ""))

  // Tags: REPLACE takes the header (validated); otherwise the source's, or, when only the
  // metadata is replaced and the source has none, the request's own `x-amz-tagging`.
  let tagging = found.tagging ?? ""
  if (replaceTags) {
    tagging = headers.get("x-amz-tagging") ?? ""
    validateObjectTags(tagging)
  } else if (!tagging && replaceMetadata) tagging = headers.get("x-amz-tagging") ?? ""

  if (!replaceMetadata && !replaceTags && metadataOnly && !source.versionId) fail("InvalidCopyDest")

  const bytes = core.bytes(found)
  const requested = requestedChecksum(headers)
  let stored: StoredChecksum
  if (requested) stored = await computeChecksum(requested, bytes)
  else if (found.checksum && found.checksum.type === "FULL_OBJECT") stored = { ...found.checksum }
  else stored = await computeChecksum(found.checksum?.algorithm ?? "CRC64NVME", bytes)
  // A server-side checksum means the bytes are read and rewritten.
  if (requested || !found.checksum || found.checksum.type !== "FULL_OBJECT") metadataOnly = false

  core.requireBucket(ctx.bucket)
  const multipart = found.etag.includes("-")
  const version = core.writeShared(
    defined({
      bucket: ctx.bucket,
      key: ctx.key,
      blob: found.blob,
      size: found.size,
      etag: metadataOnly || !multipart ? found.etag : md5Hex(bytes),
      lastModified: ctx.now,
      ...fields,
      ...(nextClass && nextClass !== "STANDARD" ? { storageClass: nextClass } : {}),
      ...(tagging ? { tagging } : {}),
      checksum: stored,
      ...(metadataOnly && found.parts ? { parts: found.parts } : {}),
      ...(destinationVersion ? { versionId: destinationVersion } : {}),
    }) as Omit<ObjectVersion, "versionId"> & { versionId?: string },
  )

  core.notify({
    eventName: "ObjectCreated:Copy",
    bucket: ctx.bucket,
    key: ctx.key,
    etag: version.etag,
    size: version.size,
    ...(version.versionId !== "null" ? { versionId: version.versionId } : {}),
  })
  return xmlResponse(
    "CopyObjectResult",
    el("LastModified", isoDate(version.lastModified)) + el("ETag", `"${version.etag}"`),
    {
      headers: {
        etag: `"${version.etag}"`,
        ...(version.versionId !== "null" ? { "x-amz-version-id": version.versionId } : {}),
        [`x-amz-checksum-${stored.algorithm.toLowerCase()}`]: stored.value,
        "x-amz-checksum-type": stored.type,
        ...(source.versionId ? { "x-amz-copy-source-version-id": source.versionId } : {}),
      },
    },
  )
}
