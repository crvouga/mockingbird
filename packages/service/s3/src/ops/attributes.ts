/**
 * Object attributes and the object-content APIs: GetObjectAttributes
 * (`getObjectAttributesHandler`), RestoreObject (`PostRestoreObjectHandler`) and
 * SelectObjectContent (`SelectObjectContentHandler` + `internal/s3select`).
 */
import { type Ctx, type Handlers, xmlResponse } from "../context.js"
import { fail, S3Error } from "../errors.js"
import { parseSelectRequest, runSelect, SelectError } from "../select/index.js"
import type { ObjectVersion } from "../state.js"
import { parseVersionId } from "../store.js"
import { doc, el, httpDate, wrap } from "../xml.js"
import { requireBucket, targetVersion } from "./common.js"

/** The `<HostId>` every error carries (the request pipeline fills `<RequestId>`). */
const HOST_ID = "dd9025bab4ad464b049177c95eb6ebf374d3b3fd1af9251148b658df7ac2e3e8"
const ATTRIBUTES = ["ETag", "Checksum", "StorageClass", "ObjectSize", "ObjectParts"]
const MAX_PARTS_LIST = 10000

/** An error body MinIO builds by hand: optional leading fields, and `<Region>` only sometimes. */
const errorXml = (
  ctx: Ctx,
  status: number,
  code: string,
  message: string,
  options: { leading?: string; region?: boolean } = {},
) =>
  new Response(
    doc(
      "Error",
      (options.leading ?? "") +
        el("Code", code) +
        el("Message", message) +
        (ctx.key ? el("Key", ctx.key) : "") +
        el("BucketName", ctx.bucket) +
        el("Resource", ctx.path) +
        (options.region === false ? "" : el("Region", ctx.core.region)) +
        "<RequestId></RequestId>" +
        `<HostId>${HOST_ID}</HostId>`,
      false,
    ),
    { status, headers: { "content-type": "application/xml" } },
  )

class AttributesError {
  constructor(
    readonly name: string,
    readonly value: string,
    readonly error: S3Error,
  ) {}
}

/** Go's `strconv.Atoi` of a trimmed header (`""` is 0). */
const intHeader = (ctx: Ctx, header: string, canonical: string): number => {
  const raw = (ctx.headers.get(header) ?? "").trim()
  if (raw === "") return 0
  if (!/^[+-]?\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)))
    throw new AttributesError(
      header,
      "",
      new S3Error("InvalidArgument", {
        message: `Invalid arguments provided for ${ctx.bucket}/${ctx.key}: (Unable to parse ${canonical}, value should be an integer)`,
      }),
    )
  return Number(raw)
}

/** `getAndValidateAttributesOpts`. */
const attributesOptions = (ctx: Ctx) => {
  const rawVersion = (ctx.query.get("versionId") ?? "").trim()
  if (parseVersionId(rawVersion) === undefined)
    throw new AttributesError("versionid", rawVersion, new S3Error("InvalidVersionID"))
  let maxParts = intHeader(ctx, "x-amz-max-parts", "X-Amz-Max-Parts")
  if (maxParts === 0) maxParts = MAX_PARTS_LIST
  const marker = intHeader(ctx, "x-amz-part-number-marker", "X-Amz-Part-Number-Marker")
  const requested = new Set<string>()
  for (const item of (ctx.headers.get("x-amz-object-attributes") ?? "").trim().split(","))
    if (item !== "") requested.add(item)
  if (!requested.size)
    throw new AttributesError("x-amz-object-attributes", "", new S3Error("InvalidAttributeName"))
  for (const item of requested)
    if (!ATTRIBUTES.includes(item))
      throw new AttributesError(
        "x-amz-object-attributes",
        item,
        new S3Error("InvalidAttributeName"),
      )
  return { maxParts, marker, requested }
}

const etagEqual = (etag: string, header: string) =>
  header.trim() === "*" || etag.replace(/"/g, "") === header.replace(/^"*|"*$/g, "")

/** `checkPreconditions` for a GET-style read: a 304 response, a 412 error, or nothing. */
const checkPreconditions = (ctx: Ctx, version: ObjectVersion): Response | undefined => {
  const modified = Math.floor(version.lastModified / 1000) * 1000
  const headers: Record<string, string> = { "last-modified": httpDate(modified) }
  if (version.etag) headers.etag = `"${version.etag}"`
  if (version.versionId && version.versionId !== "null")
    headers["x-amz-version-id"] = version.versionId
  if (version.expires) headers.expires = version.expires
  if (version.cacheControl) headers["cache-control"] = version.cacheControl
  const since = (name: string) => {
    const value = ctx.headers.get(name)
    if (!value) return undefined
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? undefined : parsed
  }
  // `ifModifiedSince`: the object is newer than the given time plus one second.
  const newer = (given: number) => version.lastModified >= given + 1000
  const noneMatch = ctx.headers.get("if-none-match")
  if (noneMatch && etagEqual(version.etag, noneMatch))
    return new Response(null, { status: 304, headers })
  const modifiedSince = since("if-modified-since")
  if (modifiedSince !== undefined && !newer(modifiedSince))
    return new Response(null, { status: 304, headers })
  const match = ctx.headers.get("if-match")
  if (match && !etagEqual(version.etag, match)) fail("PreconditionFailed", { headers })
  const unmodifiedSince = since("if-unmodified-since")
  if (!match && unmodifiedSince !== undefined && newer(unmodifiedSince))
    fail("PreconditionFailed", { headers })
  return undefined
}

const CHECKSUM_ORDER = ["CRC32", "CRC32C", "SHA1", "SHA256", "CRC64NVME"] as const

const getObjectAttributes = (ctx: Ctx): Response => {
  let options: ReturnType<typeof attributesOptions>
  try {
    options = attributesOptions(ctx)
  } catch (error) {
    if (!(error instanceof AttributesError)) throw error
    return errorXml(ctx, error.error.status, error.error.code, error.error.message, {
      leading: el("ArgumentValue", error.value) + el("ArgumentName", error.name),
    })
  }
  const bucket = requireBucket(ctx)
  const version = targetVersion(ctx)
  const notModified = checkPreconditions(ctx, version)
  if (notModified) return notModified
  const { requested, maxParts, marker } = options
  let body = ""
  if (requested.has("ETag") && version.etag) body += el("ETag", version.etag)
  if (requested.has("Checksum") && version.checksum) {
    const { algorithm, value, type } = version.checksum
    body += wrap(
      "Checksum",
      CHECKSUM_ORDER.map((name) =>
        name === algorithm ? el(`Checksum${name}`, value.split("-")[0]) : "",
      ).join("") + el("ChecksumType", type),
    )
  }
  if (requested.has("ObjectParts")) {
    const parts = version.parts ?? [{ number: 1, size: version.size, etag: version.etag }]
    let next = 0
    let listed = ""
    let count = 0
    if (maxParts > -1)
      for (const part of parts) {
        if (part.number <= marker) continue
        if (count === maxParts) break
        next = part.number
        count++
        const algorithm = version.checksum?.algorithm
        listed += wrap(
          "Part",
          el("PartNumber", part.number) +
            el("Size", part.size) +
            (part.checksum && algorithm ? el(`Checksum${algorithm}`, part.checksum) : ""),
        )
      }
    body += wrap(
      "ObjectParts",
      el("IsTruncated", next !== parts.length) +
        el("MaxParts", maxParts) +
        el("NextPartNumberMarker", next) +
        el("PartNumberMarker", marker) +
        el("PartsCount", parts.length) +
        listed,
    )
  }
  if (requested.has("StorageClass")) body += el("StorageClass", version.storageClass || "STANDARD")
  if (requested.has("ObjectSize") && version.size) body += el("ObjectSize", version.size)
  const headers: Record<string, string> = {
    "last-modified": httpDate(Math.floor(version.lastModified / 1000) * 1000),
  }
  if (bucket.versioning === "Enabled") headers["x-amz-version-id"] = version.versionId
  return xmlResponse("getObjectAttributesResponse", body, { headers, xmlns: false })
}

const restoreObject = async (ctx: Ctx): Promise<Response> => {
  if ((await ctx.body()).length === 0) fail("EmptyRequestBody")
  const versionId = (ctx.query.get("versionId") ?? "").trim()
  if (versionId && versionId !== "null") {
    if (parseVersionId(versionId) === undefined) fail("InvalidVersionID")
    if (!ctx.core.bucket(ctx.bucket)?.versioning)
      fail("InvalidArgument", {
        message: `Invalid arguments provided for ${ctx.bucket}/${ctx.key}: (version-id specified  but versioning is not enabled on ${ctx.bucket})`,
      })
  }
  requireBucket(ctx)
  targetVersion(ctx)
  // Nothing in the emulator is ever transitioned to a remote tier.
  return fail("InvalidObjectState")
}

const isSseRequested = (headers: Headers) => {
  const value = headers.get("x-amz-server-side-encryption")
  return value === "AES256" || value === "aws:kms"
}

const selectObjectContent = async (ctx: Ctx): Promise<Response> => {
  if (isSseRequested(ctx.headers)) fail("BadRequest")
  const versionId = (ctx.query.get("versionId") ?? "").trim()
  if (parseVersionId(versionId) === undefined) fail("InvalidVersionID")
  if (ctx.headers.get("range")) fail("UnsupportedRangeHeader")
  const payload = await ctx.body()
  if (payload.length === 0) fail("EmptyRequestBody")
  requireBucket(ctx)
  const found = versionId
    ? ctx.core.version(ctx.bucket, ctx.key, versionId)
    : ctx.core.head(ctx.bucket, ctx.key)
  if (!found) fail(versionId ? "NoSuchVersion" : "NoSuchKey")
  const version = found as ObjectVersion
  if (version.deleteMarker)
    fail(versionId ? "MethodNotAllowed" : "NoSuchKey", {
      headers: { "x-amz-delete-marker": "true", "x-amz-version-id": version.versionId },
    })
  const selectError = (error: unknown) => {
    if (error instanceof SelectError)
      return errorXml(ctx, error.status, error.code, error.message, { region: false })
    throw error
  }
  let request: ReturnType<typeof parseSelectRequest>
  try {
    request = parseSelectRequest(new TextDecoder().decode(payload))
  } catch (error) {
    if (error instanceof Error && error.message === "EOF" && !(error instanceof SelectError))
      fail("InternalError", {
        message: "We encountered an internal error, please try again.: cause(EOF)",
      })
    return selectError(error)
  }
  let events: Uint8Array
  try {
    events = await runSelect(request, ctx.core.bytes(version))
  } catch (error) {
    return selectError(error)
  }
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(events)
      controller.close()
    },
  })
  // MinIO streams the event stream straight to the connection, without its common headers
  // (`x-mockingbird-s3-unrouted: streamed` tells the pipeline, see `api.ts`).
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      "x-mockingbird-s3-unrouted": "streamed",
    },
  })
}

export const attributesHandlers: Handlers = {
  GetObjectAttributes: getObjectAttributes,
  RestoreObject: restoreObject,
  SelectObjectContent: selectObjectContent,
}
