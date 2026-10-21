import {
  type APIOptions,
  awsMd5,
  awsParseXml,
  awsXmlEscape,
  bootSqlite,
  faultEffect,
  sigV4AccessKeyId,
} from "@crvouga/mockingbird-service"
import { clearNamespace } from "@crvouga/mockingbird-sqlite"
import { CHECKSUM_ALGORITHMS, type ChecksumAlgorithm, checksum } from "./checksums.js"
import { decodeAwsChunked, isAwsChunked } from "./chunked.js"
import {
  CORS_METHODS,
  type CorsRule,
  corsHeaders,
  invalidCors,
  matchRule,
  PREFLIGHT_VARY,
  parseCors,
} from "./cors.js"
import { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
import {
  DEFAULT_VIRTUAL_HOSTS,
  toPathStyle,
  VIRTUAL_BUCKET_HEADER,
  virtualBucket,
} from "./hosting.js"
import { type S3Object, type S3SeedObject, S3State } from "./state.js"

export type { S3Runtime, S3RuntimeOptions } from "./runtime.js"
export { createRuntime, S3_PRESETS } from "./runtime.js"
export type { S3Object, S3SeedObject } from "./state.js"
export { document, operationIds, supportedOperationIds }
export const S3_NAMESPACE = "s3"
/** S3 accepts at most 5 GB in a single PUT and in each multipart part. */
export const S3_MAX_UPLOAD_BYTES = 5 * 1024 ** 3
export const accessKeyCredential = sigV4AccessKeyId
export type S3APIOptions = APIOptions & {
  buckets?: readonly string[]
  objects?: readonly S3SeedObject[]
  credentials?: Readonly<Record<string, string>>
  /**
   * Base hosts for virtual-hosted-style addressing: `Host: <bucket>.<base>` names the bucket and
   * the path is the key. Default `["localhost"]`; `[]` leaves every request path-style.
   */
  virtualHosts?: readonly string[]
  onNotification?: (event: S3Notification) => void
  /** A seeded stream of `[0, 1)` for request ids, so an error body replays from its seed. */
  random?: () => number
}
export type S3Notification = {
  eventName:
    | "ObjectCreated:Put"
    | "ObjectCreated:Copy"
    | "ObjectCreated:CompleteMultipartUpload"
    | "ObjectRemoved:Delete"
  bucket: string
  key: string
  etag?: string
  size?: number
  occurredAt: string
}
const encoder = new TextEncoder()
const xmlEscape = awsXmlEscape
const xml = (body: string, status = 200, headers: HeadersInit = {}) =>
  new Response(body, { status, headers: { "content-type": "application/xml", ...headers } })
const digest = async (bytes: Uint8Array) => `"${awsMd5(bytes)}"`

const metadata = (headers: Headers) =>
  Object.fromEntries(
    [...headers]
      .filter(([name]) => name.startsWith("x-amz-meta-"))
      .map(([name, value]) => [name.slice(11), value]),
  )
const HEX = "0123456789ABCDEF"
const requestId = (random: () => number = Math.random) =>
  Array.from({ length: 16 }, () => HEX.charAt(Math.floor(random() * 16))).join("")
const hex = (bytes: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(bytes instanceof Uint8Array ? bytes : bytes)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")
const sha256 = async (value: string) =>
  hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)))
const hmac = async (key: Uint8Array, value: string) => {
  const imported = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, encoder.encode(value)))
}
/** GetObject / HeadObject `response-*` query parameters and the response header each replaces. */
const RESPONSE_OVERRIDES = [
  ["response-cache-control", "cache-control"],
  ["response-content-disposition", "content-disposition"],
  ["response-content-encoding", "content-encoding"],
  ["response-content-language", "content-language"],
  ["response-content-type", "content-type"],
  ["response-expires", "expires"],
] as const
const CHECKSUM_HEADER = /^x-amz-checksum-(?!algorithm$|type$)/
const hexBytes = (value: string) =>
  Uint8Array.from([...value.matchAll(/../g)].map((match) => Number.parseInt(match[0], 16)))
const awsEncode = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  )

export class S3API {
  readonly state: S3State
  private readonly sqlite
  private readonly namespace: string
  private readonly now: () => number
  private readonly ready: Promise<void>
  constructor(private readonly options: S3APIOptions = {}) {
    this.sqlite = bootSqlite(options.sqlite)
    this.namespace = options.namespace ?? S3_NAMESPACE
    this.now = options.now ?? Date.now
    this.state = new S3State(this.sqlite, this.namespace)
    this.ready = this.seed()
  }
  private async seed() {
    for (const bucket of this.options.buckets ?? [])
      if (!this.state.buckets.has(bucket))
        this.state.buckets.insert(bucket, { createdAt: this.now() })
    for (const object of this.options.objects ?? []) await this.putSeed(object)
  }
  async reset() {
    clearNamespace(this.sqlite, this.namespace)
    await this.seed()
  }
  async putSeed(input: S3SeedObject) {
    if (!this.state.buckets.has(input.bucket))
      this.state.buckets.insert(input.bucket, { createdAt: this.now() })
    const bytes = typeof input.body === "string" ? encoder.encode(input.body) : input.body
    const object: S3Object = {
      bucket: input.bucket,
      key: input.key,
      bytes,
      etag: input.etag ?? (await digest(bytes)),
      lastModified: input.lastModified ?? this.now(),
      metadata: input.metadata,
      ...(input.tags ? { tags: input.tags } : {}),
      ...(input.checksums ? { checksums: input.checksums } : {}),
      ...(input.storageClass ? { storageClass: input.storageClass } : {}),
      ...(input.contentType ? { contentType: input.contentType } : {}),
      ...(input.cacheControl ? { cacheControl: input.cacheControl } : {}),
      ...(input.contentDisposition ? { contentDisposition: input.contentDisposition } : {}),
    }
    const mode = this.versioning(input.bucket)
    if (mode) {
      const prior = this.state.object(input.bucket, input.key)
      if (prior && !prior.versionId)
        this.state.versions.insert(this.versionKey(input.bucket, input.key, "null"), {
          ...prior,
          versionId: "null",
        })
      object.versionId = mode === "Enabled" ? this.state.ids.next("version-", 24) : "null"
      this.state.versions.insert(this.versionKey(input.bucket, input.key, object.versionId), object)
    }
    this.state.objects.insert(this.state.objectId(input.bucket, input.key), object)
    return object
  }
  private error(
    code: string,
    message: string,
    status: number,
    resource: string,
    extra: Record<string, string> = {},
  ) {
    const id = requestId(this.options.random)
    const fields = Object.entries(extra)
      .map(([name, value]) => `<${name}>${xmlEscape(value)}</${name}>`)
      .join("")
    return xml(
      `<Error><Code>${code}</Code><Message>${xmlEscape(message)}</Message>${fields}<Resource>${xmlEscape(resource)}</Resource><RequestId>${id}</RequestId><HostId>mockingbird</HostId></Error>`,
      status,
      { "x-amz-request-id": id, "x-amz-id-2": "mockingbird" },
    )
  }
  private notify(
    eventName: S3Notification["eventName"],
    object: Pick<S3Object, "bucket" | "key" | "etag" | "bytes">,
  ) {
    this.options.onNotification?.({
      eventName,
      bucket: object.bucket,
      key: object.key,
      etag: object.etag,
      size: object.bytes.length,
      occurredAt: new Date(this.now()).toISOString(),
    })
  }
  private async verifyPresign(
    request: Request,
    url: URL,
    path: string,
  ): Promise<Response | undefined> {
    if (!url.searchParams.has("X-Amz-Signature")) return
    const algorithm = url.searchParams.get("X-Amz-Algorithm")
    const credential = url.searchParams.get("X-Amz-Credential") ?? ""
    const signedHeaders = url.searchParams.get("X-Amz-SignedHeaders") ?? ""
    const signature = url.searchParams.get("X-Amz-Signature") ?? ""
    const stamp = url.searchParams.get("X-Amz-Date") ?? ""
    const expires = Number(url.searchParams.get("X-Amz-Expires"))
    const parts = credential.split("/")
    if (
      algorithm !== "AWS4-HMAC-SHA256" ||
      parts.length !== 5 ||
      parts[3] !== "s3" ||
      parts[4] !== "aws4_request"
    )
      return this.error(
        "AuthorizationQueryParametersError",
        "Invalid credential scope",
        400,
        path,
      )
    const [accessKey, date, region] = parts as [string, string, string]
    const secret = (this.options.credentials ?? { fixture: "fixture" })[accessKey]
    if (!secret) return this.error("AccessDenied", "Invalid access key", 403, path)
    const signedAt = /^\d{8}T\d{6}Z$/.test(stamp)
      ? Date.UTC(
          Number(stamp.slice(0, 4)),
          Number(stamp.slice(4, 6)) - 1,
          Number(stamp.slice(6, 8)),
          Number(stamp.slice(9, 11)),
          Number(stamp.slice(11, 13)),
          Number(stamp.slice(13, 15)),
        )
      : Number.NaN
    if (
      !Number.isFinite(signedAt) ||
      !Number.isFinite(expires) ||
      expires < 1 ||
      expires > 604800 ||
      !Number.isInteger(expires) ||
      signedAt > this.now() + 900000 ||
      this.now() > signedAt + expires * 1000
    )
      return this.error("AccessDenied", "Request has expired", 403, path)
    const names = signedHeaders.split(";").filter(Boolean)
    if (!names.includes("host"))
      return this.error(
        "SignatureDoesNotMatch",
        "SignedHeaders must include host",
        403,
        path,
      )
    const canonicalHeaders = names
      .map(
        (name) =>
          `${name}:${name === "host" ? url.host : (request.headers.get(name) ?? "").trim().replace(/\s+/g, " ")}\n`,
      )
      .join("")
    const canonicalQuery = [...url.searchParams]
      .filter(([name]) => name !== "X-Amz-Signature")
      .map(([name, value]) => `${awsEncode(name)}=${awsEncode(value)}`)
      .sort()
      .join("&")
    const canonical = [
      request.method,
      path,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      "UNSIGNED-PAYLOAD",
    ].join("\n")
    const scope = `${date}/${region}/s3/aws4_request`
    const stringToSign = ["AWS4-HMAC-SHA256", stamp, scope, await sha256(canonical)].join("\n")
    let key = await hmac(encoder.encode(`AWS4${secret}`), date)
    key = await hmac(key, region)
    key = await hmac(key, "s3")
    key = await hmac(key, "aws4_request")
    if (hex(await hmac(key, stringToSign)) !== signature.toLowerCase())
      return this.error(
        "SignatureDoesNotMatch",
        "The request signature we calculated does not match the signature you provided",
        403,
        path,
      )
    return undefined
  }
  private objectHeaders(object: S3Object) {
    const headers = new Headers({
      etag: object.etag,
      "last-modified": new Date(object.lastModified).toUTCString(),
      "content-length": String(object.bytes.length),
      "accept-ranges": "bytes",
      ...(object.contentType ? { "content-type": object.contentType } : {}),
      ...(object.cacheControl ? { "cache-control": object.cacheControl } : {}),
      ...(object.contentDisposition ? { "content-disposition": object.contentDisposition } : {}),
    })
    if (object.versionId) headers.set("x-amz-version-id", object.versionId)
    if (object.storageClass && object.storageClass !== "STANDARD")
      headers.set("x-amz-storage-class", object.storageClass)
    for (const [name, value] of Object.entries(object.checksums ?? {})) headers.set(name, value)
    for (const [name, value] of Object.entries(object.metadata))
      headers.set(`x-amz-meta-${name}`, value)
    return headers
  }
  async fetch(input: Request): Promise<Response> {
    await this.ready
    const bases = this.options.virtualHosts ?? DEFAULT_VIRTUAL_HOSTS
    const request = toPathStyle(input, bases)
    const url = new URL(request.url)
    const slash = url.pathname.indexOf("/", 1)
    const bucket = decodeURIComponent(url.pathname.slice(1, slash < 0 ? undefined : slash))
    const key = slash < 0 ? "" : decodeURIComponent(url.pathname.slice(slash + 1))
    // A rewritten virtual-hosted request was signed without its bucket in the path.
    const signedPath =
      virtualBucket(url.host, bases) !== undefined &&
      request.headers.get(VIRTUAL_BUCKET_HEADER) === bucket
        ? url.pathname.slice(bucket.length + 1) || "/"
        : url.pathname
    // A browser preflight carries no credentials, so a presigned query string is not checked.
    if (request.method === "OPTIONS" && bucket) return this.preflight(bucket, request, url)
    const response = await this.handle(request, url, bucket, key, signedPath)
    return this.withCors(bucket, request, response)
  }
  private async handle(
    request: Request,
    url: URL,
    bucket: string,
    key: string,
    signedPath: string,
  ): Promise<Response> {
    const invalidPresign = await this.verifyPresign(request, url, signedPath)
    if (invalidPresign) return invalidPresign
    if (!bucket) {
      if (request.method === "GET")
        return xml(
          `<ListAllMyBucketsResult><Owner><ID>000000000000</ID><DisplayName>mockingbird</DisplayName></Owner><Buckets>${this.state.buckets
            .list()
            .map(
              ({ id, value }) =>
                `<Bucket><Name>${xmlEscape(id)}</Name><CreationDate>${new Date(value.createdAt).toISOString()}</CreationDate></Bucket>`,
            )
            .join("")}</Buckets></ListAllMyBucketsResult>`,
        )
      return this.error("InvalidURI", "Could not parse the specified URI", 400, url.pathname)
    }
    const exists = this.state.buckets.has(bucket)
    if (
      request.method === "PUT" &&
      !key &&
      ![...url.searchParams.keys()].some((name) => !name.startsWith("X-Amz-") && name !== "x-id")
    ) {
      if (!exists) this.state.buckets.insert(bucket, { createdAt: this.now() })
      return new Response(null, { status: 200, headers: { location: `/${bucket}` } })
    }
    if (!exists)
      return this.error("NoSuchBucket", "The specified bucket does not exist", 404, url.pathname, {
        BucketName: bucket,
      })
    if (request.method === "HEAD" && !key)
      return new Response(null, { status: 200, headers: { "x-amz-bucket-region": "us-east-1" } })
    const config = await this.bucketConfiguration(bucket, key, request, url)
    if (config) return config
    if (request.method === "DELETE" && !key) {
      if (
        this.state.objects.list({ where: (value) => value.bucket === bucket }).length ||
        this.state.versions.list({ where: (value) => value.bucket === bucket }).length
      )
        return this.error(
          "BucketNotEmpty",
          "The bucket you tried to delete is not empty",
          409,
          url.pathname,
        )
      this.state.buckets.delete(bucket)
      for (const row of this.state.configurations
        .list()
        .filter((row) => row.id.startsWith(`${bucket}:`)))
        this.state.configurations.delete(row.id)
      return new Response(null, { status: 204 })
    }
    if (request.method === "GET" && !key && url.searchParams.has("versions"))
      return this.listVersions(bucket, url)
    if (request.method === "GET" && !key && url.searchParams.has("uploads"))
      return this.listUploads(bucket, url)
    if (request.method === "GET" && !key) return this.list(bucket, url)
    if (request.method === "POST" && !key && url.searchParams.has("delete"))
      return this.deleteMany(bucket, request)
    if (!key) return this.error("InvalidRequest", "A key is required", 400, url.pathname)
    if (request.method === "POST" && url.searchParams.has("uploads")) {
      const id = this.state.ids.next("upload-", 24)
      this.state.uploads.insert(id, {
        id,
        bucket,
        key,
        initiated: this.now(),
        metadata: metadata(request.headers),
        ...(request.headers.get("content-type")
          ? { contentType: request.headers.get("content-type") as string }
          : {}),
        ...(request.headers.get("cache-control")
          ? { cacheControl: request.headers.get("cache-control") as string }
          : {}),
        ...(request.headers.get("content-disposition")
          ? { contentDisposition: request.headers.get("content-disposition") as string }
          : {}),
      })
      return xml(
        `<InitiateMultipartUploadResult><Bucket>${xmlEscape(bucket)}</Bucket><Key>${xmlEscape(key)}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
      )
    }
    if (request.method === "PUT" && url.searchParams.has("uploadId"))
      return this.uploadPart(bucket, key, url, request)
    if (request.method === "POST" && url.searchParams.has("uploadId"))
      return this.complete(bucket, key, url, request)
    if (request.method === "DELETE" && url.searchParams.has("uploadId")) {
      const id = url.searchParams.get("uploadId") as string
      const upload = this.state.uploads.get(id)
      if (!upload || upload.bucket !== bucket || upload.key !== key)
        return this.error("NoSuchUpload", "The specified upload does not exist", 404, url.pathname)
      this.state.uploads.delete(id)
      for (const part of this.state.parts.list({ where: (value) => value.uploadId === id }))
        this.state.parts.delete(part.id)
      return new Response(null, { status: 204 })
    }
    if (request.method === "GET" && url.searchParams.has("uploadId"))
      return this.listParts(bucket, key, url)
    if (url.searchParams.has("tagging")) return this.objectTagging(bucket, key, request, url)
    if (request.method === "PUT") return this.put(bucket, key, request)
    if (request.method === "DELETE")
      return this.removeObject(bucket, key, url.searchParams.get("versionId"))
    const overrides = RESPONSE_OVERRIDES.filter(([param]) => url.searchParams.has(param))
    if (
      overrides.length &&
      !request.headers.has("authorization") &&
      !url.searchParams.has("X-Amz-Signature")
    )
      return this.error(
        "InvalidRequest",
        "Request specific response headers cannot be used for anonymous GET requests.",
        400,
        url.pathname,
      )
    const object = url.searchParams.has("versionId")
      ? this.state.versions.get(
          this.versionKey(bucket, key, url.searchParams.get("versionId") as string),
        )
      : this.state.object(bucket, key)
    if (!object || object.deleteMarker) {
      const response = this.error(
        url.searchParams.has("versionId") ? "NoSuchVersion" : "NoSuchKey",
        "The specified key does not exist.",
        404,
        url.pathname,
      )
      if (object?.deleteMarker) {
        response.headers.set("x-amz-delete-marker", "true")
        response.headers.set("x-amz-version-id", object.versionId ?? "null")
      }
      return response
    }
    const condition = this.conditions(object, request)
    if (condition) return condition
    if (request.method === "HEAD")
      return this.overridden(
        new Response(null, { status: 200, headers: this.objectHeaders(object) }),
        url,
        overrides,
      )
    if (request.method === "GET")
      return this.overridden(this.get(object, request, url.pathname), url, overrides)
    return this.error("MethodNotAllowed", "The specified method is not allowed", 405, url.pathname)
  }
  /** `response-*` query parameters replace the stored headers on a 200 or 206. */
  private overridden(response: Response, url: URL, overrides: readonly (readonly [string, string])[]) {
    if (response.status === 200 || response.status === 206)
      for (const [param, header] of overrides) {
        const value = url.searchParams.get(param)
        if (value) response.headers.set(header, value)
      }
    return response
  }
  /**
   * `x-amz-copy-source-if-*`, evaluated as the CopyObject reference describes: a true if-match
   * overrides a false if-unmodified-since, and a failed condition is always 412, never 304.
   */
  private copyConditions(source: S3Object, request: Request): Response | undefined {
    const unquote = (value: string) => value.trim().replace(/^W\//, "").replace(/^"|"$/g, "")
    const etags = (header: string | null) =>
      header === null ? undefined : header.split(",").map(unquote)
    const have = unquote(source.etag)
    const hit = (list: string[] | undefined) => list?.includes("*") || list?.includes(have)
    const modified = Math.floor(source.lastModified / 1000) * 1000
    const date = (name: string) => Date.parse(request.headers.get(name) ?? "")
    const ifMatch = etags(request.headers.get("x-amz-copy-source-if-match"))
    const ifNoneMatch = etags(request.headers.get("x-amz-copy-source-if-none-match"))
    const since = date("x-amz-copy-source-if-modified-since")
    const until = date("x-amz-copy-source-if-unmodified-since")
    const failed = (name: string) =>
      this.error(
        "PreconditionFailed",
        "At least one of the pre-conditions you specified did not hold",
        412,
        new URL(request.url).pathname,
        { Condition: name },
      )
    if (ifMatch && !hit(ifMatch)) return failed("x-amz-copy-source-If-Match")
    if (!ifMatch && modified > until) return failed("x-amz-copy-source-If-Unmodified-Since")
    if (ifNoneMatch && hit(ifNoneMatch)) return failed("x-amz-copy-source-If-None-Match")
    if (!ifNoneMatch && modified <= since) return failed("x-amz-copy-source-If-Modified-Since")
    return undefined
  }
  private async put(bucket: string, key: string, request: Request) {
    const condition = this.conditions(this.state.object(bucket, key), request, true)
    if (condition) return condition
    const copy = request.headers.get("x-amz-copy-source")
    if (copy) {
      const sourceUrl = new URL(copy.startsWith("/") ? copy : `/${copy}`, "http://mock")
      const [sourceBucket, ...sourceKey] = sourceUrl.pathname
        .slice(1)
        .split("/")
        .map(decodeURIComponent)
      const source = sourceBucket
        ? sourceUrl.searchParams.has("versionId")
          ? this.state.versions.get(
              this.versionKey(
                sourceBucket,
                sourceKey.join("/"),
                sourceUrl.searchParams.get("versionId") as string,
              ),
            )
          : this.state.object(sourceBucket, sourceKey.join("/"))
        : undefined
      if (!source) return this.error("NoSuchKey", "The specified key does not exist.", 404, copy)
      const sourceCondition = this.copyConditions(source, request)
      if (sourceCondition) return sourceCondition
      const stored = await this.putSeed({
        ...source,
        bucket,
        key,
        body: source.bytes,
        metadata:
          request.headers.get("x-amz-metadata-directive") === "REPLACE"
            ? metadata(request.headers)
            : source.metadata,
        lastModified: this.now(),
        ...(request.headers.get("x-amz-metadata-directive") === "REPLACE"
          ? {
              contentType: request.headers.get("content-type") ?? "application/octet-stream",
              cacheControl: request.headers.get("cache-control") ?? "",
              contentDisposition: request.headers.get("content-disposition") ?? "",
            }
          : {}),
      })
      this.notify("ObjectCreated:Copy", stored)
      return xml(
        `<CopyObjectResult><LastModified>${new Date(stored.lastModified).toISOString()}</LastModified><ETag>${stored.etag}</ETag></CopyObjectResult>`,
      )
    }
    const received = await this.payload(request)
    if (received instanceof Response) return received
    const { bytes, checksums } = received
    const object = await this.putSeed({
      bucket,
      key,
      body: bytes,
      metadata: metadata(request.headers),
      tags: Object.fromEntries(new URLSearchParams(request.headers.get("x-amz-tagging") ?? "")),
      checksums,
      storageClass: request.headers.get("x-amz-storage-class") ?? "STANDARD",
      ...(request.headers.get("content-type")
        ? { contentType: request.headers.get("content-type") as string }
        : {}),
      ...(request.headers.get("cache-control")
        ? { cacheControl: request.headers.get("cache-control") as string }
        : {}),
      ...(request.headers.get("content-disposition")
        ? { contentDisposition: request.headers.get("content-disposition") as string }
        : {}),
    })
    this.notify("ObjectCreated:Put", object)
    return new Response(null, {
      status: 200,
      headers: {
        etag: object.etag,
        ...(object.versionId ? { "x-amz-version-id": object.versionId } : {}),
      },
    })
  }
  private get(object: S3Object, request: Request, resource: string) {
    const all = new Uint8Array(object.bytes)
    if (faultEffect(request, "truncate_stream") !== undefined) {
      const bytes = all.slice(0, Math.floor(all.length / 2))
      const headers = this.objectHeaders(object)
      headers.set("content-length", String(bytes.length))
      headers.set("x-mockingbird-truncated", "true")
      return new Response(bytes, { status: 200, headers })
    }
    const range = request.headers.get("range")
    if (!range) return new Response(all, { status: 200, headers: this.objectHeaders(object) })
    const match = /^bytes=(\d*)-(\d*)$/.exec(range)
    if (!match)
      return this.error("InvalidRange", "The requested range is not satisfiable", 416, resource)
    const start = match[1] ? Number(match[1]) : Math.max(0, all.length - Number(match[2]))
    const end = match[1]
      ? Math.min(all.length - 1, match[2] ? Number(match[2]) : all.length - 1)
      : all.length - 1
    if (start >= all.length || end < start)
      return this.error("InvalidRange", "The requested range is not satisfiable", 416, resource)
    const bytes = all.slice(start, end + 1)
    const headers = this.objectHeaders(object)
    headers.set("content-length", String(bytes.length))
    headers.set("content-range", `bytes ${start}-${end}/${all.length}`)
    for (const name of [...headers.keys()])
      if (name.startsWith("x-amz-checksum-")) headers.delete(name)
    return new Response(bytes, { status: 206, headers })
  }
  private list(bucket: string, url: URL) {
    const prefix = url.searchParams.get("prefix") ?? ""
    const delimiter = url.searchParams.get("delimiter")
    const max = Number(url.searchParams.get("max-keys") ?? 1000)
    if (!Number.isInteger(max) || max < 0)
      return this.error("InvalidArgument", "Invalid max-keys", 400, url.pathname)
    const token = url.searchParams.get("continuation-token")
    let after = url.searchParams.get("start-after") ?? url.searchParams.get("marker") ?? ""
    try {
      if (token)
        after = new TextDecoder().decode(Uint8Array.from(atob(token), (char) => char.charCodeAt(0)))
    } catch {
      return this.error("InvalidArgument", "Invalid continuation token", 400, url.pathname)
    }
    const entries = new Map<string, S3Object | undefined>()
    for (const { value: object } of this.state.objects.list({
      where: (value) =>
        value.bucket === bucket && !value.deleteMarker && value.key.startsWith(prefix),
    })) {
      const rest = object.key.slice(prefix.length)
      const split = delimiter ? rest.indexOf(delimiter) : -1
      if (delimiter && split >= 0)
        entries.set(prefix + rest.slice(0, split + delimiter.length), undefined)
      else entries.set(object.key, object)
    }
    const sorted = [...entries]
      .sort(([a], [b]) => this.compareKeys(a, b))
      .filter(([key]) => this.compareKeys(key, after) > 0)
    const page = sorted.slice(0, Math.min(1000, max))
    const truncated = max > 0 && sorted.length > page.length
    const last = page.at(-1)?.[0]
    const encode = (value: string) =>
      xmlEscape(url.searchParams.get("encoding-type") === "url" ? awsEncode(value) : value)
    const v2 = url.searchParams.get("list-type") === "2"
    return xml(
      `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${xmlEscape(bucket)}</Name><Prefix>${encode(prefix)}</Prefix>${delimiter ? `<Delimiter>${encode(delimiter)}</Delimiter>` : ""}${v2 ? `<KeyCount>${page.length}</KeyCount>` : `<Marker>${encode(after)}</Marker>`}<MaxKeys>${Math.min(max, 1000)}</MaxKeys><IsTruncated>${truncated}</IsTruncated>${url.searchParams.get("encoding-type") === "url" ? "<EncodingType>url</EncodingType>" : ""}${page.map(([key, object]) => (object ? `<Contents><Key>${encode(key)}</Key><LastModified>${new Date(object.lastModified).toISOString()}</LastModified><ETag>${xmlEscape(object.etag)}</ETag><Size>${object.bytes.length}</Size><StorageClass>${object.storageClass ?? "STANDARD"}</StorageClass></Contents>` : `<CommonPrefixes><Prefix>${encode(key)}</Prefix></CommonPrefixes>`)).join("")}${truncated && last ? (v2 ? `<NextContinuationToken>${btoa(String.fromCharCode(...encoder.encode(last)))}</NextContinuationToken>` : `<NextMarker>${encode(last)}</NextMarker>`) : ""}${token ? `<ContinuationToken>${xmlEscape(token)}</ContinuationToken>` : ""}</ListBucketResult>`,
    )
  }
  private compareKeys(left: string, right: string) {
    const a = encoder.encode(left),
      b = encoder.encode(right)
    for (let index = 0; index < Math.min(a.length, b.length); index++) {
      const diff = (a[index] ?? 0) - (b[index] ?? 0)
      if (diff) return diff
    }
    return a.length - b.length
  }
  private async uploadPart(bucket: string, key: string, url: URL, request: Request) {
    const id = url.searchParams.get("uploadId") as string
    const upload = this.state.uploads.get(id)
    if (!upload || upload.bucket !== bucket || upload.key !== key)
      return this.error("NoSuchUpload", "The specified upload does not exist", 404, url.pathname)
    const partNumber = Number(url.searchParams.get("partNumber"))
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000)
      return this.error(
        "InvalidArgument",
        "Part number must be between 1 and 10000",
        400,
        url.pathname,
      )
    const received = await this.payload(request)
    if (received instanceof Response) return received
    const { bytes } = received
    const etag = await digest(bytes)
    this.state.parts.insert(`${id}:${partNumber}`, {
      uploadId: id,
      partNumber,
      bytes,
      etag,
    })
    return new Response(null, { status: 200, headers: { etag } })
  }
  private async complete(bucket: string, key: string, url: URL, request: Request) {
    const id = url.searchParams.get("uploadId") as string
    const upload = this.state.uploads.get(id)
    if (!upload || upload.bucket !== bucket || upload.key !== key)
      return this.error("NoSuchUpload", "The specified upload does not exist", 404, url.pathname)
    let submitted: Record<string, unknown>[]
    try {
      const parsed = awsParseXml(await request.text()).CompleteMultipartUpload as Record<
        string,
        unknown
      >
      const parts = parsed?.Part
      submitted = (Array.isArray(parts) ? parts : parts ? [parts] : []) as Record<string, unknown>[]
      if (!submitted.length) throw new TypeError()
    } catch {
      return this.error(
        "MalformedXML",
        "The XML you provided was not well-formed or did not validate",
        400,
        url.pathname,
      )
    }
    const parts = []
    let previous = 0
    for (const entry of submitted) {
      const number = Number(entry.PartNumber)
      if (number <= previous)
        return this.error(
          "InvalidPartOrder",
          "The list of parts was not in ascending order",
          400,
          url.pathname,
        )
      previous = number
      const part = this.state.parts.get(`${id}:${number}`)
      if (!part || String(entry.ETag).replace(/"/g, "") !== part.etag.replace(/"/g, ""))
        return this.error(
          "InvalidPart",
          "One or more of the specified parts could not be found",
          400,
          url.pathname,
        )
      parts.push(part)
    }
    if (parts.slice(0, -1).some((part) => part.bytes.length < 5 * 1024 * 1024))
      return this.error(
        "EntityTooSmall",
        "Your proposed upload is smaller than the minimum allowed object size",
        400,
        url.pathname,
      )
    const condition = this.conditions(this.state.object(bucket, key), request, true)
    if (condition) return condition
    const bytes = new Uint8Array(parts.reduce((total, part) => total + part.bytes.length, 0))
    let offset = 0
    for (const part of parts) {
      bytes.set(part.bytes, offset)
      offset += part.bytes.length
    }
    const hashes = Uint8Array.from(
      parts.flatMap((part) =>
        [...part.etag.replace(/"/g, "").matchAll(/../g)].map((match) =>
          Number.parseInt(match[0], 16),
        ),
      ),
    )
    const etag = `"${awsMd5(hashes)}-${parts.length}"`
    const object = await this.putSeed({
      ...upload,
      bucket,
      key,
      body: bytes,
      metadata: upload.metadata ?? {},
      etag,
    })
    this.notify("ObjectCreated:CompleteMultipartUpload", object)
    this.state.uploads.delete(id)
    for (const row of this.state.parts.list({ where: (part) => part.uploadId === id }))
      this.state.parts.delete(row.id)
    return xml(
      `<CompleteMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Location>/${xmlEscape(bucket)}/${xmlEscape(key)}</Location><Bucket>${xmlEscape(bucket)}</Bucket><Key>${xmlEscape(key)}</Key><ETag>${xmlEscape(object.etag)}</ETag></CompleteMultipartUploadResult>`,
      200,
      object.versionId ? { "x-amz-version-id": object.versionId } : {},
    )
  }
  private async deleteMany(bucket: string, request: Request) {
    let input: Record<string, unknown>
    try {
      input = awsParseXml(await request.text()).Delete as Record<string, unknown>
      if (!input || !input.Object) throw new TypeError()
    } catch {
      return this.error("MalformedXML", "Malformed XML", 400, `/${bucket}`)
    }
    const entries = (Array.isArray(input.Object) ? input.Object : [input.Object]) as Record<
      string,
      unknown
    >[]
    if (entries.length > 1000)
      return this.error("MalformedXML", "Too many objects", 400, `/${bucket}`)
    const quiet = input.Quiet === "true"
    const results = []
    for (const entry of entries) {
      const key = String(entry.Key ?? "")
      const response = this.removeObject(
        bucket,
        key,
        typeof entry.VersionId === "string" ? entry.VersionId : null,
      )
      if (!quiet)
        results.push(
          `<Deleted><Key>${xmlEscape(key)}</Key>${entry.VersionId ? `<VersionId>${xmlEscape(entry.VersionId)}</VersionId>` : ""}${response.headers.get("x-amz-delete-marker") ? `<DeleteMarker>true</DeleteMarker><DeleteMarkerVersionId>${response.headers.get("x-amz-version-id")}</DeleteMarkerVersionId>` : ""}</Deleted>`,
        )
    }
    return xml(`<DeleteResult>${results.join("")}</DeleteResult>`)
  }
  private versionKey(bucket: string, key: string, version: string) {
    return JSON.stringify([bucket, key, version])
  }
  private versioning(bucket: string) {
    const body = this.state.configurations.get(`${bucket}:versioning`)?.body ?? ""
    return /<Status>Enabled<\/Status>/.test(body)
      ? "Enabled"
      : /<Status>Suspended<\/Status>/.test(body)
        ? "Suspended"
        : undefined
  }
  private removeObject(bucket: string, key: string, versionId: string | null): Response {
    const headers: Record<string, string> = {}
    if (versionId !== null) {
      const id = this.versionKey(bucket, key, versionId)
      const prior = this.state.versions.get(id)
      this.state.versions.delete(id)
      headers["x-amz-version-id"] = versionId
      if (prior?.deleteMarker) headers["x-amz-delete-marker"] = "true"
      if (this.state.object(bucket, key)?.versionId === versionId) {
        const latest = this.state.versions.list({
          where: (value) => value.bucket === bucket && value.key === key,
          order: "newest",
        })[0]?.value
        if (latest) this.state.objects.insert(this.state.objectId(bucket, key), latest)
        else this.state.objects.delete(this.state.objectId(bucket, key))
      }
    } else if (this.versioning(bucket)) {
      const mode = this.versioning(bucket)
      const id = mode === "Enabled" ? this.state.ids.next("version-", 24) : "null"
      const marker: S3Object = {
        bucket,
        key,
        bytes: new Uint8Array(),
        etag: "",
        lastModified: this.now(),
        metadata: {},
        versionId: id,
        deleteMarker: true,
      }
      this.state.versions.insert(this.versionKey(bucket, key, id), marker)
      this.state.objects.insert(this.state.objectId(bucket, key), marker)
      headers["x-amz-version-id"] = id
      headers["x-amz-delete-marker"] = "true"
    } else {
      const deleted = this.state.object(bucket, key)
      this.state.objects.delete(this.state.objectId(bucket, key))
      if (deleted) this.notify("ObjectRemoved:Delete", deleted)
    }
    return new Response(null, { status: 204, headers })
  }
  private conditions(
    object: S3Object | undefined,
    request: Request,
    write = false,
  ): Response | undefined {
    const matches = (header: string | null) =>
      header !== null &&
      (header === "*" || header.split(",").some((value) => value.trim() === object?.etag))
    const exists = object && !object.deleteMarker
    if (request.headers.has("if-match") && (!exists || !matches(request.headers.get("if-match"))))
      return this.error(
        "PreconditionFailed",
        "At least one precondition failed",
        412,
        new URL(request.url).pathname,
      )
    if (exists && matches(request.headers.get("if-none-match")))
      return write
        ? this.error(
            "PreconditionFailed",
            "At least one precondition failed",
            412,
            new URL(request.url).pathname,
          )
        : new Response(null, { status: 304, headers: this.objectHeaders(object) })
    if (exists && !write) {
      const modified = Math.floor(object.lastModified / 1000) * 1000
      const since = Date.parse(request.headers.get("if-modified-since") ?? "")
      const unmodified = Date.parse(request.headers.get("if-unmodified-since") ?? "")
      if (!request.headers.has("if-none-match") && modified <= since)
        return new Response(null, { status: 304, headers: this.objectHeaders(object) })
      if (!request.headers.has("if-match") && modified > unmodified)
        return this.error(
          "PreconditionFailed",
          "At least one precondition failed",
          412,
          new URL(request.url).pathname,
        )
    }
    return undefined
  }
  /**
   * The object bytes of a PutObject or UploadPart: an `aws-chunked` stream is decoded (the framing
   * and trailers are not part of the object), the decoded length and every supplied checksum are
   * verified, and the checksums to keep come back as the `x-amz-checksum-*` headers they were.
   */
  private async payload(
    request: Request,
  ): Promise<{ bytes: Uint8Array; checksums: Record<string, string> } | Response> {
    const path = new URL(request.url).pathname
    const chunked = isAwsChunked(request.headers)
    const declared = Number(
      (chunked ? request.headers.get("x-amz-decoded-content-length") : null) ??
        request.headers.get("content-length"),
    )
    if (declared > S3_MAX_UPLOAD_BYTES)
      return this.error(
        "EntityTooLarge",
        "Your proposed upload exceeds the maximum allowed size",
        400,
        path,
        { ProposedSize: String(declared), MaxSizeAllowed: String(S3_MAX_UPLOAD_BYTES) },
      )
    let bytes: Uint8Array = new Uint8Array(await request.arrayBuffer())
    const checksums: Record<string, string> = Object.fromEntries(
      [...request.headers].filter(([name]) => CHECKSUM_HEADER.test(name)),
    )
    if (chunked) {
      const decoded = decodeAwsChunked(bytes)
      if (!decoded)
        return this.error(
          "IncompleteBody",
          "The aws-chunked request body is malformed or ends before its last chunk",
          400,
          path,
        )
      bytes = decoded.payload
      const length = request.headers.get("x-amz-decoded-content-length")
      if (length !== null && Number(length) !== bytes.length)
        return this.error(
          "IncompleteBody",
          "You did not provide the number of bytes specified by the x-amz-decoded-content-length HTTP header",
          400,
          path,
        )
      for (const [name, value] of Object.entries(decoded.trailers))
        if (CHECKSUM_HEADER.test(name)) checksums[name] = value
    }
    const md5 = request.headers.get("content-md5")
    if (md5 && md5 !== btoa(String.fromCharCode(...hexBytes(awsMd5(bytes)))))
      return this.error(
        "BadDigest",
        "The Content-MD5 you specified did not match what we received",
        400,
        path,
      )
    for (const [name, expected] of Object.entries(checksums)) {
      const algorithm = name.slice("x-amz-checksum-".length) as ChecksumAlgorithm
      if (
        CHECKSUM_ALGORITHMS.includes(algorithm) &&
        (await checksum(algorithm, bytes)) !== expected
      )
        return this.error(
          "BadDigest",
          `The ${algorithm.toUpperCase()} you specified did not match the calculated checksum.`,
          400,
          path,
        )
    }
    return { bytes, checksums }
  }
  private async bucketConfiguration(
    bucket: string,
    key: string,
    request: Request,
    url: URL,
  ): Promise<Response | undefined> {
    if (key) return undefined
    if (url.searchParams.has("location") && request.method === "GET")
      return xml('<LocationConstraint xmlns="http://s3.amazonaws.com/doc/2006-03-01/"/>')
    const kinds: Record<string, [string, string]> = {
      versioning: ["VersioningConfiguration", ""],
      tagging: ["Tagging", "NoSuchTagSet"],
      cors: ["CORSConfiguration", "NoSuchCORSConfiguration"],
      lifecycle: ["LifecycleConfiguration", "NoSuchLifecycleConfiguration"],
      notification: ["NotificationConfiguration", ""],
      encryption: [
        "ServerSideEncryptionConfiguration",
        "ServerSideEncryptionConfigurationNotFoundError",
      ],
      website: ["WebsiteConfiguration", "NoSuchWebsiteConfiguration"],
      publicAccessBlock: ["PublicAccessBlockConfiguration", "NoSuchPublicAccessBlockConfiguration"],
      ownershipControls: ["OwnershipControls", "OwnershipControlsNotFoundError"],
      policy: ["", "NoSuchBucketPolicy"],
    }
    const kind = Object.keys(kinds).find((name) => url.searchParams.has(name))
    if (!kind) return undefined
    const [root, missing] = kinds[kind] as [string, string]
    const id = `${bucket}:${kind}`
    if (request.method === "PUT") {
      const body = await request.text()
      try {
        if (kind === "policy") JSON.parse(body)
        else if (!(root in awsParseXml(body))) throw new TypeError()
      } catch {
        return this.error(
          kind === "policy" ? "MalformedPolicy" : "MalformedXML",
          "Malformed configuration",
          400,
          url.pathname,
        )
      }
      if (kind === "versioning" && !/<Status>(Enabled|Suspended)<\/Status>/.test(body))
        return this.error("MalformedXML", "Invalid versioning status", 400, url.pathname)
      if (kind === "cors") {
        const invalid = invalidCors(parseCors(body))
        if (invalid) return this.error(invalid[0], invalid[1], 400, url.pathname)
      }
      this.state.configurations.insert(id, { body })
      return new Response(null, { status: 200 })
    }
    if (request.method === "DELETE") {
      this.state.configurations.delete(id)
      return new Response(null, { status: 204 })
    }
    if (request.method === "GET") {
      const stored = this.state.configurations.get(id)
      if (stored)
        return new Response(stored.body, {
          headers: { "content-type": kind === "policy" ? "application/json" : "application/xml" },
        })
      return missing
        ? this.error(missing, "The configuration does not exist", 404, url.pathname)
        : xml(`<${root} xmlns="http://s3.amazonaws.com/doc/2006-03-01/"/>`)
    }
    return this.error("MethodNotAllowed", "Method not allowed", 405, url.pathname)
  }
  private corsRules(bucket: string): CorsRule[] | undefined {
    const stored = this.state.configurations.get(`${bucket}:cors`)
    return stored ? parseCors(stored.body) : undefined
  }
  /**
   * The browser preflight (`OPTIONS` on a bucket or object URL). S3 refuses one it cannot match
   * with 403 AccessForbidden "CORSResponse: ..." and no `Access-Control-*` headers.
   */
  private preflight(bucket: string, request: Request, url: URL): Response {
    if (!this.state.buckets.has(bucket))
      return this.error("NoSuchBucket", "The specified bucket does not exist", 404, url.pathname, {
        BucketName: bucket,
      })
    const origin = request.headers.get("origin")
    if (!origin)
      return this.error(
        "BadRequest",
        "Insufficient information. Origin request header needed.",
        400,
        url.pathname,
      )
    const method = request.headers.get("access-control-request-method")
    if (!method || !CORS_METHODS.includes(method))
      return this.error(
        "BadRequest",
        `Invalid Access-Control-Request-Method: ${method}`,
        400,
        url.pathname,
      )
    const requested = (request.headers.get("access-control-request-headers") ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean)
    const rules = this.corsRules(bucket)
    const refuse = (message: string) =>
      this.error("AccessForbidden", `CORSResponse: ${message}`, 403, url.pathname, {
        Method: method,
        ResourceType: url.pathname.indexOf("/", 1) < 0 ? "BUCKET" : "OBJECT",
      })
    if (!rules) return refuse("CORS is not enabled for this bucket.")
    const rule = matchRule(rules, origin, method, requested)
    if (!rule)
      return refuse(
        "This CORS request is not allowed. This is usually because the evalution of Origin, request method / Access-Control-Request-Method or Access-Control-Request-Headers are not whitelisted by the resource's CORS spec.",
      )
    return new Response(null, {
      status: 200,
      headers: {
        ...corsHeaders(rule, origin),
        ...(requested.length ? { "access-control-allow-headers": requested.join(", ") } : {}),
        ...(rule.maxAge ? { "access-control-max-age": rule.maxAge } : {}),
        vary: PREFLIGHT_VARY,
      },
    })
  }
  /** A matching rule adds the `Access-Control-*` headers to an actual cross-origin response. */
  private withCors(bucket: string, request: Request, response: Response): Response {
    const origin = request.headers.get("origin")
    if (!origin || !bucket || !this.state.buckets.has(bucket)) return response
    const rule = matchRule(this.corsRules(bucket) ?? [], origin, request.method)
    if (!rule) return response
    for (const [name, value] of Object.entries(corsHeaders(rule, origin)))
      response.headers.set(name, value)
    response.headers.append("vary", "Origin")
    return response
  }
  private async objectTagging(bucket: string, key: string, request: Request, url: URL) {
    const object = url.searchParams.has("versionId")
      ? this.state.versions.get(
          this.versionKey(bucket, key, url.searchParams.get("versionId") as string),
        )
      : this.state.object(bucket, key)
    if (!object || object.deleteMarker)
      return this.error("NoSuchKey", "The specified key does not exist", 404, url.pathname)
    if (request.method === "GET")
      return xml(
        `<Tagging><TagSet>${Object.entries(object.tags ?? {})
          .map(
            ([name, value]) =>
              `<Tag><Key>${xmlEscape(name)}</Key><Value>${xmlEscape(value)}</Value></Tag>`,
          )
          .join("")}</TagSet></Tagging>`,
      )
    let tags: Record<string, string> = {}
    if (request.method === "PUT") {
      try {
        const tagging = awsParseXml(await request.text()).Tagging as { TagSet?: { Tag?: unknown } }
        const value = tagging?.TagSet?.Tag
        const list = (Array.isArray(value) ? value : value ? [value] : []) as {
          Key: string
          Value: string
        }[]
        if (
          list.length > 10 ||
          list.some((tag) => typeof tag.Key !== "string" || typeof tag.Value !== "string") ||
          new Set(list.map((tag) => tag.Key)).size !== list.length
        )
          throw new TypeError()
        tags = Object.fromEntries(list.map((tag) => [tag.Key, tag.Value]))
      } catch {
        return this.error("MalformedXML", "Invalid tag set", 400, url.pathname)
      }
    } else if (request.method !== "DELETE")
      return this.error("MethodNotAllowed", "Method not allowed", 405, url.pathname)
    const updated = { ...object, tags }
    if (object.versionId)
      this.state.versions.insert(this.versionKey(bucket, key, object.versionId), updated)
    if (this.state.object(bucket, key)?.versionId === object.versionId)
      this.state.objects.insert(this.state.objectId(bucket, key), updated)
    return new Response(null, { status: request.method === "DELETE" ? 204 : 200 })
  }
  private listParts(bucket: string, key: string, url: URL) {
    const id = url.searchParams.get("uploadId") as string
    const upload = this.state.uploads.get(id)
    if (!upload || upload.bucket !== bucket || upload.key !== key)
      return this.error("NoSuchUpload", "The specified upload does not exist", 404, url.pathname)
    const marker = Number(url.searchParams.get("part-number-marker") ?? 0)
    const max = Math.min(1000, Number(url.searchParams.get("max-parts") ?? 1000))
    if (!Number.isInteger(max) || max < 0 || !Number.isInteger(marker) || marker < 0)
      return this.error("InvalidArgument", "Invalid pagination", 400, url.pathname)
    const all = this.state.parts
      .list({ where: (part) => part.uploadId === id && part.partNumber > marker })
      .map(({ value }) => value)
      .sort((a, b) => a.partNumber - b.partNumber)
    const page = all.slice(0, max)
    return xml(
      `<ListPartsResult><Bucket>${xmlEscape(bucket)}</Bucket><Key>${xmlEscape(key)}</Key><UploadId>${xmlEscape(id)}</UploadId><PartNumberMarker>${marker}</PartNumberMarker><NextPartNumberMarker>${page.at(-1)?.partNumber ?? marker}</NextPartNumberMarker><MaxParts>${max}</MaxParts><IsTruncated>${all.length > page.length}</IsTruncated>${page.map((part) => `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${xmlEscape(part.etag)}</ETag><Size>${part.bytes.length}</Size><LastModified>${new Date(upload.initiated).toISOString()}</LastModified></Part>`).join("")}</ListPartsResult>`,
    )
  }
  private listUploads(bucket: string, url: URL) {
    const uploads = this.state.uploads
      .list({
        where: (value) =>
          value.bucket === bucket && value.key.startsWith(url.searchParams.get("prefix") ?? ""),
      })
      .map(({ value }) => value)
    return xml(
      `<ListMultipartUploadsResult><Bucket>${xmlEscape(bucket)}</Bucket><IsTruncated>false</IsTruncated>${uploads.map((upload) => `<Upload><Key>${xmlEscape(upload.key)}</Key><UploadId>${upload.id}</UploadId><Initiated>${new Date(upload.initiated).toISOString()}</Initiated><StorageClass>STANDARD</StorageClass></Upload>`).join("")}</ListMultipartUploadsResult>`,
    )
  }
  private listVersions(bucket: string, url: URL) {
    const versions = this.state.versions
      .list({
        where: (value) =>
          value.bucket === bucket && value.key.startsWith(url.searchParams.get("prefix") ?? ""),
        order: "newest",
      })
      .map(({ value }) => value)
    return xml(
      `<ListVersionsResult><Name>${xmlEscape(bucket)}</Name><Prefix>${xmlEscape(url.searchParams.get("prefix") ?? "")}</Prefix><IsTruncated>false</IsTruncated>${versions
        .map((object) => {
          const type = object.deleteMarker ? "DeleteMarker" : "Version"
          return `<${type}><Key>${xmlEscape(object.key)}</Key><VersionId>${object.versionId}</VersionId><IsLatest>${this.state.object(bucket, object.key)?.versionId === object.versionId}</IsLatest><LastModified>${new Date(object.lastModified).toISOString()}</LastModified>${object.deleteMarker ? "" : `<ETag>${xmlEscape(object.etag)}</ETag><Size>${object.bytes.length}</Size><StorageClass>${object.storageClass ?? "STANDARD"}</StorageClass>`}</${type}>`
        })
        .join("")}</ListVersionsResult>`,
    )
  }
}
