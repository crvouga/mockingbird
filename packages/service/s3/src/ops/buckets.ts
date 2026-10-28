/**
 * Bucket lifecycle: CreateBucket, HeadBucket, DeleteBucket, ListBuckets, GetBucketLocation, as
 * MinIO's `PutBucketHandler`, `HeadBucketHandler`, `DeleteBucketHandler`, `ListBucketsHandler`
 * and `GetBucketLocationHandler` (`cmd/bucket-handlers.go`) answer them.
 */

import type { Ctx } from "../context.js"
import { type Handlers, ok, xmlResponse } from "../context.js"
import { fail, S3Error } from "../errors.js"
import type { S3Core } from "../store.js"
import { el, esc, isoDate, wrap } from "../xml.js"

export const OWNER_ID = "02d6176db174dc93cb1b899f7c6078f08654445fe8cf1b6ce98d8855f66bdbf4"
export const OWNER_NAME = "minio"

/** `"true"` / `"false"` in any case, `undefined` when absent; anything else is InvalidRequest. */
const boolHeader = (headers: Headers, name: string): boolean | undefined => {
  const value = headers.get(name)
  if (!value) return undefined
  const lower = value.toLowerCase()
  if (lower !== "true" && lower !== "false") fail("InvalidRequest")
  return lower === "true"
}

/**
 * The header checks `PutBucketHandler` makes before it authenticates the request
 * (`x-amz-bucket-object-lock-enabled`, then `x-minio-force-create`).
 */
export const createBucketPreflight = (headers: Headers) => {
  boolHeader(headers, "x-amz-bucket-object-lock-enabled")
  boolHeader(headers, "x-minio-force-create")
}

/**
 * The CreateBucket body. MinIO decodes the XML straight from the hashing reader, so a digest,
 * checksum or chunk-signature failure while reading surfaces as MalformedXML; only a malformed
 * `Content-MD5` header (InvalidDigest) is reported as itself, before any read.
 */
const bodyOrMalformed = async (ctx: Ctx) => {
  try {
    return await ctx.text()
  } catch (error) {
    if (error instanceof S3Error && error.errorName !== "InvalidDigest") fail("MalformedXML")
    throw error
  }
}

/** Go's `strconv.ParseBool`. */
const parseBool = (value: string): boolean | undefined => {
  if (["1", "t", "T", "TRUE", "true", "True"].includes(value)) return true
  if (["0", "f", "F", "FALSE", "false", "False"].includes(value)) return false
  return undefined
}

/**
 * Remove a bucket, its versions and its configuration. MinIO keeps incomplete multipart uploads
 * (they live under `.minio.sys`, keyed by bucket name), so a bucket recreated under the same name
 * lists them again; they are left in place here too.
 */
const dropKeepingUploads = (core: S3Core, bucket: string) => {
  const { state } = core
  for (const row of state.versions.list({ where: (value) => value.bucket === bucket })) {
    state.blobs.release(row.value.blob)
    state.versions.delete(row.id)
  }
  for (const row of state.heads.list({ where: (value) => value.bucket === bucket }))
    state.heads.delete(row.id)
  for (const row of state.configurations.list({ where: (value) => value.bucket === bucket }))
    state.configurations.delete(row.id)
  state.buckets.delete(bucket)
}

export const bucketHandlers: Handlers = {
  async CreateBucket(ctx) {
    const objectLock = boolHeader(ctx.headers, "x-amz-bucket-object-lock-enabled") === true
    const force = boolHeader(ctx.headers, "x-minio-force-create") === true
    const region = locationConstraint(await bodyOrMalformed(ctx))
    if (region === undefined) fail("MalformedXML")
    if ((region || ctx.core.region) !== ctx.core.region && ctx.core.region) fail("InvalidRegion")
    if (ctx.core.bucket(ctx.bucket)) {
      if (!force) fail("BucketAlreadyOwnedByYou")
    } else
      ctx.core.saveBucket(ctx.bucket, {
        createdAt: ctx.now,
        ...(objectLock ? { objectLock: true, versioning: "Enabled" as const } : {}),
      })
    return ok({ location: `/${ctx.bucket}` })
  },
  HeadBucket(ctx) {
    ctx.core.requireBucket(ctx.bucket)
    return ok({ "content-type": "application/xml" })
  },
  DeleteBucket(ctx) {
    const header = ctx.headers.get("x-minio-force-delete")
    let force = false
    if (header) {
      const parsed = parseBool(header)
      if (parsed === undefined)
        fail("InvalidRequest", {
          message: `strconv.ParseBool: parsing ${JSON.stringify(header)}: invalid syntax`,
        })
      force = parsed as boolean
    }
    const bucket = force ? ctx.core.bucket(ctx.bucket) : ctx.core.requireBucket(ctx.bucket)
    if (!bucket) return ok({}, 204)
    if (force && bucket.objectLock) fail("MethodNotAllowed")
    // Delete markers count; incomplete multipart uploads do not (they go with the bucket).
    if (
      !force &&
      ctx.core.state.versions.list({ where: (value) => value.bucket === ctx.bucket }).length
    )
      fail(
        "BucketNotEmpty",
        bucket.versioning
          ? {
              message:
                "The bucket you tried to delete is not empty. You must delete all versions in the bucket.",
            }
          : {},
      )
    dropKeepingUploads(ctx.core, ctx.bucket)
    return ok({}, 204)
  },
  ListBuckets(ctx) {
    const buckets = ctx.core.state.buckets
      .list()
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map(({ id, value }) =>
        wrap("Bucket", el("Name", id) + el("CreationDate", isoDate(value.createdAt))),
      )
      .join("")
    return xmlResponse(
      "ListAllMyBucketsResult",
      wrap("Owner", el("ID", OWNER_ID) + el("DisplayName", OWNER_NAME)) + wrap("Buckets", buckets),
    )
  },
  GetBucketLocation(ctx) {
    ctx.core.requireBucket(ctx.bucket)
    return xmlResponse("LocationConstraint", esc(ctx.core.region))
  },
}

// ── CreateBucketConfiguration, decoded the way Go's encoding/xml does ───────────────────────

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", apos: "'", quot: '"' }
const NAME_START = /[A-Za-z_:À-￿]/
const NAME_CHAR = /[A-Za-z0-9_:.\-·À-￿]/
const SPACE = /[ \t\r\n]/

/** Thrown inside the decoder for any syntax error Go's `xml.Decoder` (strict mode) reports. */
class Syntax extends Error {}

/**
 * The `LocationConstraint` of a CreateBucket body as MinIO's `parseLocationConstraint` reads it:
 * `""` for an empty body or none given, `undefined` when Go's decoder would fail (MalformedXML).
 * Like `xml.Decoder.Decode`, anything before the root element that is not markup is skipped,
 * nothing after it is read, namespaces are ignored, nested unknown elements are skipped and the
 * last `LocationConstraint` wins.
 */
export const locationConstraint = (body: string): string | undefined => {
  if (body === "") return ""
  try {
    return decodeConfiguration(body)
  } catch (error) {
    if (error instanceof Syntax) return undefined
    throw error
  }
}

const decodeConfiguration = (input: string): string => {
  let at = 0
  const syntax = (): never => {
    throw new Syntax()
  }
  const startsWith = (value: string) => input.startsWith(value, at)
  const checkChars = (text: string) => {
    for (const char of text) {
      const code = char.codePointAt(0) as number
      if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) syntax()
      if (code === 0xfffe || code === 0xffff) syntax()
    }
  }
  const name = () => {
    const start = at
    if (!NAME_START.test(input.charAt(at))) syntax()
    at++
    while (at < input.length && NAME_CHAR.test(input.charAt(at))) at++
    return input.slice(start, at)
  }
  const local = (qualified: string) => {
    const colon = qualified.indexOf(":")
    return colon > 0 && colon < qualified.length - 1 ? qualified.slice(colon + 1) : qualified
  }
  const skipSpace = () => {
    while (SPACE.test(input.charAt(at))) at++
  }
  /** Character data up to the next `<`, entities decoded. */
  const text = () => {
    let out = ""
    while (at < input.length && input.charAt(at) !== "<") {
      const char = input.charAt(at)
      if (char === "]" && startsWith("]]>")) syntax()
      if (char !== "&") {
        out += char
        at++
        continue
      }
      const end = input.indexOf(";", at)
      if (end < 0) syntax()
      const entity = input.slice(at + 1, end)
      at = end + 1
      if (entity in ENTITIES) out += ENTITIES[entity]
      else if (/^#[0-9]+$/.test(entity)) out += String.fromCodePoint(Number(entity.slice(1)))
      else if (/^#x[0-9a-fA-F]+$/.test(entity))
        out += String.fromCodePoint(Number.parseInt(entity.slice(2), 16))
      else syntax()
    }
    checkChars(out)
    return out
  }
  type Tag =
    | { kind: "start"; name: string; empty: boolean }
    | { kind: "end"; name: string }
    | { kind: "text"; value: string }
    | { kind: "eof" }
  const token = (): Tag => {
    if (at >= input.length) return { kind: "eof" }
    if (input.charAt(at) !== "<") return { kind: "text", value: text() }
    if (startsWith("<?")) {
      const end = input.indexOf("?>", at + 2)
      if (end < 0) syntax()
      const content = input.slice(at + 2, end)
      at += 2
      const target = name()
      if (target === "xml") {
        const version = /version\s*=\s*["']([^"']*)["']/.exec(content)?.[1]
        if (version !== undefined && version !== "1.0") syntax()
      }
      at = end + 2
      return token()
    }
    if (startsWith("<!--")) {
      const end = input.indexOf("--", at + 4)
      if (end < 0 || input.charAt(end + 2) !== ">") syntax()
      at = end + 3
      return token()
    }
    if (startsWith("<![CDATA[")) {
      const end = input.indexOf("]]>", at + 9)
      if (end < 0) syntax()
      const value = input.slice(at + 9, end)
      checkChars(value)
      at = end + 3
      return { kind: "text", value }
    }
    if (startsWith("<!")) {
      // A directive (DOCTYPE, ...): skip to its matching `>`, minding quotes and nesting.
      let depth = 0
      let quote = ""
      for (at += 2; at < input.length; at++) {
        const char = input.charAt(at)
        if (quote) {
          if (char === quote) quote = ""
        } else if (char === '"' || char === "'") quote = char
        else if (char === "<") depth++
        else if (char === ">") {
          if (depth === 0) {
            at++
            return token()
          }
          depth--
        }
      }
      return syntax()
    }
    if (startsWith("</")) {
      at += 2
      const tag = name()
      skipSpace()
      if (input.charAt(at) !== ">") syntax()
      at++
      return { kind: "end", name: tag }
    }
    at++
    const tag = name()
    for (;;) {
      skipSpace()
      const char = input.charAt(at)
      if (char === "/") {
        if (input.charAt(at + 1) !== ">") syntax()
        at += 2
        return { kind: "start", name: tag, empty: true }
      }
      if (char === ">") {
        at++
        return { kind: "start", name: tag, empty: false }
      }
      if (at >= input.length) syntax()
      name()
      skipSpace()
      if (input.charAt(at) !== "=") syntax()
      at++
      skipSpace()
      const quote = input.charAt(at)
      if (quote !== '"' && quote !== "'") syntax()
      const end = input.indexOf(quote, at + 1)
      if (end < 0 || input.slice(at + 1, end).includes("<")) syntax()
      at = end + 1
    }
  }
  /** Read to the end of an element whose start tag was just read; returns its own text. */
  const element = (
    tag: string,
    empty: boolean,
    onChild?: (name: string, value: string) => void,
  ) => {
    let own = ""
    if (empty) return own
    for (;;) {
      const next = token()
      if (next.kind === "eof") return syntax()
      if (next.kind === "text") own += next.value
      else if (next.kind === "end") {
        if (next.name !== tag) syntax()
        return own
      } else {
        const value = element(next.name, next.empty)
        onChild?.(local(next.name), value)
      }
    }
  }
  for (;;) {
    const next = token()
    if (next.kind === "eof") return syntax()
    if (next.kind === "end") return syntax()
    if (next.kind !== "start") continue
    if (local(next.name) !== "CreateBucketConfiguration") return syntax()
    let constraint = ""
    element(next.name, next.empty, (child, value) => {
      if (child === "LocationConstraint") constraint = value
    })
    return constraint
  }
}
