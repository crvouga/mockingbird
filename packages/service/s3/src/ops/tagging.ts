/**
 * Bucket and object tagging, validated as minio-go's `tags` package does: every `<Tag>` is
 * checked while decoding (key 1-128 characters, value up to 256, `[a-zA-Z0-9+\-._:/@ =]`), then
 * the count (50 for a bucket, 10 for an object), then duplicate keys.
 */
import { GoError, parseGoXml, type XNode } from "../bucket-config/goxml.js"
import { type Ctx, type Handlers, ok } from "../context.js"
import { fail, S3Error } from "../errors.js"
import { requireAccess } from "../policy.js"
import type { ObjectVersion } from "../state.js"
import { esc, wrap } from "../xml.js"
import { requireBucket, targetVersion } from "./common.js"

type Tag = [key: string, value: string]

class TagError extends Error {
  constructor(
    readonly code: "BadRequest" | "InvalidTag",
    message: string,
  ) {
    super(message)
  }
}

const VALID = /^[a-zA-Z0-9+\-._:/@ =]+$/
const runes = (value: string) => [...value].length

const checkTag = ([key, value]: Tag) => {
  if (key.length === 0 || runes(key) > 128 || !VALID.test(key))
    throw new TagError("InvalidTag", "The TagKey you have provided is invalid")
  if (value !== "" && (runes(value) > 256 || !VALID.test(value)))
    throw new TagError("InvalidTag", "The TagValue you have provided is invalid")
}

/** `tags.ParseBucketXML` / `tags.ParseObjectXML`; throws `TagError` or `GoError`. */
const parseTagging = (body: string, isObject: boolean): Tag[] => {
  const root = parseGoXml(body)
  if (root.name !== "Tagging")
    throw new GoError("unmarshal", `expected element type <Tagging> but have <${root.name}>`)
  let tags: Tag[] = []
  for (const set of root.children) {
    if (set.name !== "TagSet") continue
    const decoded: Tag[] = []
    for (const node of set.children) {
      if (node.name !== "Tag") continue
      const field = (name: string) =>
        node.children.filter((child: XNode) => child.name === name).at(-1)?.text ?? ""
      const tag: Tag = [field("Key"), field("Value")]
      checkTag(tag)
      decoded.push(tag)
    }
    if (decoded.length > (isObject ? 10 : 50))
      throw new TagError("BadRequest", `Tags cannot be more than ${isObject ? 10 : 50}`)
    const seen = new Set<string>()
    for (const [key] of decoded) {
      if (seen.has(key))
        throw new TagError("InvalidTag", "Cannot provide multiple Tags with the same key")
      seen.add(key)
    }
    tags = decoded
  }
  return tags
}

/** Go's `url.QueryEscape`. */
const queryEscape = (value: string) =>
  [...new TextEncoder().encode(value)]
    .map((byte) => {
      const char = String.fromCharCode(byte)
      if (/[A-Za-z0-9\-_.~]/.test(char)) return char
      if (char === " ") return "+"
      return `%${byte.toString(16).toUpperCase().padStart(2, "0")}`
    })
    .join("")

/** `tags.String()`: sorted by key, query-escaped. */
const encodeTags = (tags: Tag[]) =>
  [...tags]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${queryEscape(key)}=${queryEscape(value)}`)
    .join("&")

const decodeTags = (encoded: string | undefined): Tag[] => {
  const out = new Map<string, string>()
  for (const [key, value] of new URLSearchParams(encoded ?? "")) if (key) out.set(key, value)
  return [...out]
}

const tagSetXml = (tags: Tag[]) =>
  wrap(
    "Tagging",
    wrap(
      "TagSet",
      tags
        .map(([key, value]) => `<Tag><Key>${esc(key)}</Key><Value>${esc(value)}</Value></Tag>`)
        .join(""),
    ),
  )

const xml = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, { status: 200, headers: { "content-type": "application/xml", ...headers } })

/** The object a tagging request addresses (MinIO's `getOpts` + `GetObjectInfo`). */
const taggedVersion = (ctx: Ctx): ObjectVersion => {
  requireBucket(ctx)
  return targetVersion(ctx)
}

const versionHeader = (versionId: string): Record<string, string> =>
  versionId && versionId !== "null" ? { "x-amz-version-id": versionId } : {}

export const taggingHandlers: Handlers = {
  async PutBucketTagging(ctx) {
    requireBucket(ctx)
    requireAccess(ctx, "s3:PutBucketTagging", "")
    let tags: Tag[]
    try {
      tags = parseTagging(await ctx.text(), false)
    } catch (error) {
      if (error instanceof TagError || error instanceof GoError)
        return fail("MalformedXML", { message: error.message })
      throw error
    }
    ctx.core.setConfig(ctx.bucket, "tagging", JSON.stringify(tags))
    return ok()
  },
  GetBucketTagging(ctx) {
    const stored = ctx.core.bucket(ctx.bucket) ? ctx.core.config(ctx.bucket, "tagging") : undefined
    if (stored === undefined) fail("BucketTaggingNotFound")
    return xml(tagSetXml(JSON.parse(stored as string) as Tag[]))
  },
  DeleteBucketTagging(ctx) {
    if (ctx.core.bucket(ctx.bucket)) ctx.core.setConfig(ctx.bucket, "tagging", undefined)
    return ok({}, 204)
  },

  GetObjectTagging(ctx) {
    const version = taggedVersion(ctx)
    requireAccess(ctx, "s3:GetObjectTagging")
    const tags = decodeTags(version.tagging).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return xml(
      `<?xml version="1.0" encoding="UTF-8"?>\n${tagSetXml(tags)}`,
      versionHeader(ctx.query.get("versionId") ?? ""),
    )
  },
  async PutObjectTagging(ctx) {
    let tags: Tag[]
    try {
      tags = parseTagging(await ctx.text(), true)
    } catch (error) {
      if (error instanceof TagError)
        return fail("BadRequest", { code: error.code, message: error.message })
      if (error instanceof GoError && error.kind === "syntax")
        return fail("MalformedXML", {
          message: `${new S3Error("MalformedXML").message} (${error.message})`,
        })
      if (error instanceof GoError)
        return fail("InternalError", {
          message: `${new S3Error("InternalError").message}: cause(${error.message})`,
        })
      throw error
    }
    requireAccess(ctx, "s3:PutObjectTagging")
    const version = taggedVersion(ctx)
    const encoded = encodeTags(tags)
    const { tagging: _previous, ...rest } = version
    ctx.core.update(encoded ? { ...rest, tagging: encoded } : rest)
    return ok(versionHeader(version.versionId))
  },
  DeleteObjectTagging(ctx) {
    const version = taggedVersion(ctx)
    requireAccess(ctx, "s3:DeleteObjectTagging")
    const { tagging: _previous, ...rest } = version
    ctx.core.update(rest)
    return ok(versionHeader(version.versionId), 204)
  },
}
