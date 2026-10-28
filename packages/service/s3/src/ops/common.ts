/** Helpers several operation modules share. */
import type { Ctx } from "../context.js"
import { fail } from "../errors.js"
import type { ObjectVersion } from "../state.js"
import { parseVersionId, type S3Core } from "../store.js"
import { httpDate } from "../xml.js"

/** `x-amz-meta-*` request headers → stored metadata (lowercased names, prefix removed). */
export const userMetadata = (headers: Headers): Record<string, string> =>
  Object.fromEntries(
    [...headers]
      .filter(([name]) => name.startsWith("x-amz-meta-"))
      .map(([name, value]) => [name.slice("x-amz-meta-".length), value]),
  )

/** The bytes of a header value: one byte per char as HTTP carries it, else its UTF-8. */
const headerBytes = (value: string): Uint8Array =>
  [...value].every((char) => char.charCodeAt(0) <= 0xff)
    ? Uint8Array.from(value, (char) => char.charCodeAt(0))
    : new TextEncoder().encode(value)

const UPPER_HEX = "0123456789ABCDEF"
const MAX_CONTENT = 75 - "=?UTF-8?q?".length - "?=".length
const runeLength = (bytes: Uint8Array, at: number) => {
  const lead = bytes[at] as number
  const want = lead >= 0xf0 && lead < 0xf8 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1
  if (lead < 0xc2 || lead > 0xf4 || want === 1) return 1
  for (let index = 1; index < want; index++) {
    const next = bytes[at + index]
    if (next === undefined || (next & 0xc0) !== 0x80) return 1
  }
  return want
}
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))

/**
 * Go's `mime.BEncoding` / `mime.QEncoding` `Encode("UTF-8", value)`, which MinIO applies to user
 * metadata values that are not printable ASCII (`setObjectHeaders`).
 */
export const mimeEncodeMetadata = (value: string): string => {
  const bytes = headerBytes(value)
  const runes = new TextDecoder().decode(bytes)
  if (![...runes].some((char) => (char < " " || char > "~") && char !== "\t")) return value
  const b = /["#$%&'(),.:;<>@[\]^`{|}~]/.test(runes)
  const open = `=?UTF-8?${b ? "b" : "q"}?`
  const words: string[] = []
  if (b) {
    const maxRaw = Math.floor(MAX_CONTENT / 4) * 3
    if (Math.ceil(bytes.length / 3) * 4 <= MAX_CONTENT) words.push(base64(bytes))
    else {
      let last = 0
      let current = 0
      for (let index = 0; index < bytes.length; ) {
        const size = runeLength(bytes, index)
        if (current + size <= maxRaw) current += size
        else {
          words.push(base64(bytes.subarray(last, index)))
          last = index
          current = size
        }
        index += size
      }
      words.push(base64(bytes.subarray(last)))
    }
  } else {
    let word = ""
    let current = 0
    for (let index = 0; index < bytes.length; ) {
      const byte = bytes[index] as number
      const plain = byte >= 0x20 && byte <= 0x7e && byte !== 0x3d && byte !== 0x3f && byte !== 0x5f
      const size = plain ? 1 : runeLength(bytes, index)
      const encoded = plain ? 1 : 3 * size
      if (current + encoded > MAX_CONTENT) {
        words.push(word)
        word = ""
        current = 0
      }
      for (const part of bytes.subarray(index, index + size)) {
        if (part === 0x20) word += "_"
        else if (part >= 0x21 && part <= 0x7e && part !== 0x3d && part !== 0x3f && part !== 0x5f)
          word += String.fromCharCode(part)
        else word += `=${UPPER_HEX[part >> 4]}${UPPER_HEX[part & 0x0f]}`
      }
      current += encoded
      index += size
    }
    words.push(word)
  }
  return words.map((word) => `${open}${word}?=`).join(" ")
}

/** minio-go's `tags.ParseObjectTags` count of a stored `x-amz-tagging` value (0 if unparsable). */
export const tagCount = (tagging: string | undefined): number => {
  if (!tagging) return 0
  const keys = new Set<string>()
  for (const pair of tagging.split("&")) {
    if (!pair) continue
    const at = pair.indexOf("=")
    try {
      keys.add(decodeURIComponent((at < 0 ? pair : pair.slice(0, at)).replace(/\+/g, " ")))
    } catch {}
  }
  return keys.size
}

export type ObjectHeaderOptions = {
  /** `x-amz-tagging-directive: ACCESS`: MinIO's extension that returns the tags themselves. */
  tagging?: boolean
}

/**
 * The response headers of a stored object, as MinIO's `setObjectHeaders` writes them before the
 * range is applied: validators, content headers, `x-amz-tagging-count`, user metadata (lowercased,
 * RFC 2047-encoded when not printable ASCII), the storage class when not STANDARD, the version id
 * and the full `content-length`.
 */
export const objectHeaders = (
  version: ObjectVersion,
  options: ObjectHeaderOptions = {},
): Headers => {
  const headers = new Headers()
  headers.set("last-modified", httpDate(Math.floor(version.lastModified / 1000) * 1000))
  if (version.etag) headers.set("etag", `"${version.etag}"`)
  // An empty stored Content-Type still goes out, and Go's server answers it as a default.
  if (version.contentType !== undefined)
    headers.set("content-type", version.contentType || "application/octet-stream")
  if (version.contentEncoding) headers.set("content-encoding", version.contentEncoding)
  if (version.expires) headers.set("expires", version.expires)
  const tags = tagCount(version.tagging)
  if (tags > 0) {
    headers.set("x-amz-tagging-count", String(tags))
    if (options.tagging && version.tagging) headers.set("x-amz-tagging", version.tagging)
  }
  if (version.contentDisposition) headers.set("content-disposition", version.contentDisposition)
  if (version.contentLanguage) headers.set("content-language", version.contentLanguage)
  if (version.cacheControl) headers.set("cache-control", version.cacheControl)
  if (version.storageClass && version.storageClass !== "STANDARD")
    headers.set("x-amz-storage-class", version.storageClass)
  for (const [name, value] of Object.entries(version.metadata))
    headers.set(`x-amz-meta-${name}`, mimeEncodeMetadata(value))
  for (const [name, value] of Object.entries(version.extra ?? {}))
    headers.set(name, name.startsWith("x-minio-meta-") ? mimeEncodeMetadata(value) : value)
  if (version.retention) {
    headers.set("x-amz-object-lock-mode", version.retention.mode)
    headers.set("x-amz-object-lock-retain-until-date", version.retention.until)
  }
  if (version.legalHold) headers.set("x-amz-object-lock-legal-hold", version.legalHold)
  if (version.versionId && version.versionId !== "null")
    headers.set("x-amz-version-id", version.versionId)
  headers.set("content-length", String(version.size))
  return headers
}

/** The bucket must exist (NoSuchBucket otherwise). */
export const requireBucket = (ctx: Ctx) => ctx.core.requireBucket(ctx.bucket)

/**
 * `?versionId=` as MinIO's `getOpts` reads it: `""` when absent or empty, `"null"`, or a
 * canonical UUID; anything else is InvalidArgument (InvalidVersionID).
 */
export const requestVersionId = (ctx: Ctx): string => {
  const parsed = parseVersionId(ctx.query.get("versionId") ?? "")
  if (parsed === undefined) fail("InvalidVersionID")
  return parsed as string
}

/**
 * The version a GET/HEAD-style request names: `?versionId=` or the latest. Nothing at all is
 * NoSuchKey / NoSuchVersion; a latest delete marker is NoSuchKey and one named by id is
 * MethodNotAllowed. GetObject and HeadObject add MinIO's `x-amz-delete-marker` /
 * `x-amz-version-id` headers to those errors.
 */
export const targetVersion = (ctx: Ctx, core: S3Core = ctx.core): ObjectVersion => {
  const versionId = requestVersionId(ctx)
  const found = versionId
    ? core.version(ctx.bucket, ctx.key, versionId)
    : core.head(ctx.bucket, ctx.key)
  if (!found) fail(versionId ? "NoSuchVersion" : "NoSuchKey")
  const version = found as ObjectVersion
  if (version.deleteMarker) {
    const headers =
      ctx.op === "GetObject" || ctx.op === "HeadObject"
        ? { "x-amz-delete-marker": "true", "x-amz-version-id": version.versionId }
        : undefined
    fail(versionId ? "MethodNotAllowed" : "NoSuchKey", headers ? { headers } : {})
  }
  return version
}
