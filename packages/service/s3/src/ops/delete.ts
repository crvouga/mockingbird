/**
 * Deletes: DeleteObject (MinIO's `DeleteObjectHandler`) and DeleteObjects
 * (`DeleteMultipleObjectsHandler`), with their versioning and object-lock rules.
 */
import { type Ctx, type Handlers, ok, xmlResponse } from "../context.js"
import { fail, S3Error } from "../errors.js"
import { child, children, decodeGoXml, GoXmlError, goBool } from "../goxml.js"
import { uuidError } from "../store.js"
import { el, esc, wrap } from "../xml.js"
import { requestVersionId } from "./common.js"
import { checkDeleteAllowed, hasContentChecksum, lenientBody } from "./lock.js"
import { goXmlApiError } from "./versioning.js"

const MAX_DELETE_LIST = 1000
const MAX_BODY = 2 * 100000 * 1024

/** `isDirObject`: a key ending in `/`. */
const isDir = (key: string) => key.endsWith("/")

/** Go's `strconv.ParseBool`, failing as MinIO reports it (an InternalError with the cause). */
const parseBoolHeader = (value: string) => {
  if (["1", "t", "T", "TRUE", "true", "True"].includes(value)) return true
  if (["0", "f", "F", "FALSE", "false", "False"].includes(value)) return false
  return fail("InternalError", {
    message: `We encountered an internal error, please try again.: cause(strconv.ParseBool: parsing ${JSON.stringify(value)}: invalid syntax)`,
  })
}

/** Go's `path.Clean`. */
const cleanPath = (path: string) => {
  if (path === "") return "."
  const rooted = path.startsWith("/")
  const out: string[] = []
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop()
      else if (!rooted) out.push("..")
    } else out.push(part)
  }
  const joined = out.join("/")
  return rooted ? `/${joined}` : joined || "."
}

/** MinIO's `trimLeadingSlash`. */
const trimLeadingSlash = (key: string) => {
  if (!key.startsWith("/")) return key
  const cleaned = key.length > 1 && key.endsWith("/") ? `${cleanPath(key)}/` : cleanPath(key)
  return cleaned.slice(1)
}

/** `checkDelObjArgs` → `IsValidObjectPrefix`: no `.`/`..` segment, no `//`, no NUL. */
const validObjectName = (key: string) =>
  key !== "" &&
  !key.split(/[/\\]/).some((segment) => /^\s*\.{1,2}\s*$/.test(segment)) &&
  !key.includes("//") &&
  !key.includes("\0")

export const deleteHandlers: Handlers = {
  DeleteObject(ctx) {
    let versionId = requestVersionId(ctx)
    const force = ctx.headers.get("x-minio-force-delete")
    const forceDelete = force ? parseBoolHeader(force) : false
    if (isDir(ctx.key) && versionId === "") versionId = "null"
    const record = ctx.core.bucket(ctx.bucket)
    if (record?.objectLock && forceDelete)
      fail("AdminInvalidArgument", {
        message: "force-delete is forbidden on Object Locking enabled buckets",
      })
    if (!record) fail("NoSuchBucket")
    if (forceDelete) {
      // MinIO's deletePrefix: the object and everything under it, every version, no markers.
      const prefix = ctx.key
      for (const version of ctx.core.allVersions(ctx.bucket))
        if (
          version.key === prefix ||
          version.key.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`)
        )
          ctx.core.removeVersion(ctx.bucket, version.key, version.versionId)
      return ok({}, 204)
    }
    if (versionId) checkDeleteAllowed(ctx, ctx.core.version(ctx.bucket, ctx.key, versionId))
    const result = ctx.core.deleteObject(ctx.bucket, ctx.key, versionId, ctx.now)
    if (!result) return ok({}, 204)
    const headers: Record<string, string> = {}
    if (result.version.versionId !== "null") {
      headers["x-amz-version-id"] = result.version.versionId
      if (result.marker) headers["x-amz-delete-marker"] = "true"
    }
    ctx.core.notify({
      eventName:
        result.marker && !versionId ? "ObjectRemoved:DeleteMarkerCreated" : "ObjectRemoved:Delete",
      bucket: ctx.bucket,
      key: ctx.key,
      ...(result.version.versionId !== "null" ? { versionId: result.version.versionId } : {}),
    })
    return ok(headers, 204)
  },
  async DeleteObjects(ctx) {
    if (!hasContentChecksum(ctx.headers)) fail("MissingContentMD5")
    const { text } = await lenientBody(ctx)
    const length = new TextEncoder().encode(text).length
    if (length <= 0) fail("MissingContentLength")
    if (length > MAX_BODY) fail("EntityTooLarge")
    const request = parseDelete(text)
    if (request.objects.length === 0 || request.objects.length > MAX_DELETE_LIST)
      fail("MalformedXML", { key: "" })
    const last = request.objects[request.objects.length - 1]
    if (!ctx.core.bucket(ctx.bucket)) fail("NoSuchBucket", { key: last?.key ?? "" })
    return xmlResponse("DeleteResult", deleteMany(ctx, request.objects, request.quiet))
  },
}

type Entry = { key: string; versionId: string }
type Deleted = { key: string; versionId?: string; marker?: boolean; markerVersionId?: string }
type DeleteError = { code: string; message: string; key: string; versionId: string }

/** `DeleteObjectsRequest` as `xmlDecoder` reads it (any root name; io.EOF is a syntax error). */
const parseDelete = (body: string): { quiet: boolean; objects: Entry[] } => {
  try {
    const root = decodeGoXml(body)
    const quietNode = child(root, "Quiet")
    return {
      quiet: quietNode ? goBool(quietNode) : false,
      objects: children(root, "Object").map((node) => ({
        key: trimLeadingSlash(child(node, "Key")?.text ?? ""),
        versionId: child(node, "VersionId")?.text ?? "",
      })),
    }
  } catch (error) {
    if (error instanceof GoXmlError)
      throw goXmlApiError(
        error.kind === "eof" ? new GoXmlError("syntax", "XML syntax error on line 0: EOF") : error,
      )
    throw error
  }
}

/**
 * The body of the multi-delete loop, MinIO's quirks included: results stay in request order
 * (Deleted first, then Errors); a repeated entry is deleted once and reported as an empty
 * `<Deleted>`; an invalid key's error lands on the first entry; an unversioned key's
 * VersionId-less delete leaves a marker report even when nothing existed.
 */
const deleteMany = (ctx: Ctx, entries: Entry[], quiet: boolean): string => {
  const core = ctx.core
  const lockEnabled = !!core.bucket(ctx.bucket)?.objectLock
  const results: { deleted?: Deleted; error?: DeleteError }[] = entries.map(() => ({}))
  const unique = new Map<string, number>()
  entries.forEach((entry, index) => {
    if (entry.versionId !== "" && entry.versionId !== "null") {
      const problem = uuidError(entry.versionId)
      if (problem !== undefined) {
        results[index] = {
          error: {
            code: "NoSuchVersion",
            message: `The specified version does not exist. (${problem})`,
            key: entry.key,
            versionId: entry.versionId,
          },
        }
        return
      }
    }
    const target = { ...entry }
    if (isDir(target.key) && target.versionId === "") target.versionId = "null"
    if (target.versionId !== "" && lockEnabled) {
      try {
        checkDeleteAllowed(ctx, findVersion(ctx, target))
      } catch (error) {
        if (!(error instanceof S3Error)) throw error
        results[index] = {
          error: {
            code: error.code,
            message: error.message,
            key: target.key,
            versionId: target.versionId,
          },
        }
        return
      }
    }
    const id = JSON.stringify([target.key, target.versionId])
    if (!unique.has(id)) unique.set(id, index)
    entries[index] = target
  })
  // Per key: version deletes first, then at most one delete marker (MinIO's dedupVersions).
  const byKey = new Map<string, number[]>()
  for (const index of unique.values()) {
    const key = (entries[index] as Entry).key
    byKey.set(key, [...(byKey.get(key) ?? []), index])
  }
  const invalid: number[] = []
  for (const [key, indexes] of byKey) {
    if (!validObjectName(key)) {
      invalid.push(...indexes)
      continue
    }
    const ordered = [
      ...indexes.filter((index) => (entries[index] as Entry).versionId !== ""),
      ...indexes.filter((index) => (entries[index] as Entry).versionId === ""),
    ]
    for (const index of ordered)
      results[index] = { deleted: deleteOne(ctx, entries[index] as Entry) }
  }
  // MinIO looks an invalid name's result up by an empty name and files it under that entry
  // (index 0 when there is none).
  for (const index of invalid) {
    const entry = entries[index] as Entry
    const home = unique.get(JSON.stringify(["", ""])) ?? 0
    results[home] = {
      ...results[home],
      error: {
        code: "XMinioInvalidObjectName",
        message: "Object name contains unsupported characters.",
        key: entry.key,
        versionId: entry.versionId,
      },
    }
  }
  const deleted: string[] = []
  const errors: string[] = []
  for (const result of results) {
    if (result.error) {
      const { code, message, key, versionId } = result.error
      errors.push(
        wrap(
          "Error",
          el("Code", code) +
            el("Message", message) +
            `<Key>${esc(key)}</Key>` +
            `<VersionId>${esc(versionId)}</VersionId>`,
        ),
      )
      continue
    }
    const item = result.deleted
    const versionId =
      item && isDir(item.key) && item.versionId === "null" ? undefined : item?.versionId
    deleted.push(
      wrap(
        "Deleted",
        item
          ? (item.marker ? el("DeleteMarker", "true") : "") +
              (item.markerVersionId ? el("DeleteMarkerVersionId", item.markerVersionId) : "") +
              (item.key ? el("Key", item.key) : "") +
              (versionId ? el("VersionId", versionId) : "")
          : "",
      ),
    )
  }
  return (quiet ? "" : deleted.join("")) + errors.join("")
}

const findVersion = (ctx: Ctx, entry: Entry) => {
  const canonical = entry.versionId === "null" ? "null" : canonicalId(entry.versionId)
  return ctx.core.version(ctx.bucket, entry.key, canonical)
}

const canonicalId = (versionId: string) => {
  const hex = (
    versionId.length === 45
      ? versionId.slice(9)
      : versionId.length === 38
        ? versionId.slice(1, 37)
        : versionId
  )
    .replace(/-/g, "")
    .toLowerCase()
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** One entry of a multi-delete (`erasureObjects.DeleteObjects`). */
const deleteOne = (ctx: Ctx, entry: Entry): Deleted => {
  const core = ctx.core
  const { key } = entry
  if (entry.versionId !== "") {
    const versionId = entry.versionId === "null" ? "null" : canonicalId(entry.versionId)
    const removed = core.removeVersion(ctx.bucket, key, versionId)
    if (removed)
      core.notify({
        eventName: "ObjectRemoved:Delete",
        bucket: ctx.bucket,
        key,
        ...(versionId !== "null" ? { versionId } : {}),
      })
    return { key, versionId: entry.versionId }
  }
  const versioned = core.versioned(ctx.bucket, key)
  if (!versioned && !core.suspended(ctx.bucket)) {
    if (core.removeVersion(ctx.bucket, key, "null"))
      core.notify({ eventName: "ObjectRemoved:Delete", bucket: ctx.bucket, key })
    return { key }
  }
  // A delete marker is reported whether or not the key exists, but only written when it does.
  const markerId = versioned ? core.uuid() : "null"
  if (core.versionsOf(ctx.bucket, key).length) {
    core.write(
      {
        bucket: ctx.bucket,
        key,
        versionId: markerId,
        deleteMarker: true,
        etag: "",
        lastModified: ctx.now,
        metadata: {},
      },
      new Uint8Array(),
    )
    core.notify({
      eventName: "ObjectRemoved:DeleteMarkerCreated",
      bucket: ctx.bucket,
      key,
      ...(versioned ? { versionId: markerId } : {}),
    })
  }
  return { key, marker: true, ...(versioned ? { markerVersionId: markerId } : {}) }
}
