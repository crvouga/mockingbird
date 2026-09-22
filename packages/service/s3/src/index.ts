import {
  type APIOptions,
  bootSqlite,
  faultEffect,
  sigV4AccessKeyId,
} from "@crvouga/mockingbird-service"
import { clearNamespace } from "@crvouga/mockingbird-sqlite"
import { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
import { type S3Object, type S3SeedObject, S3State } from "./state.js"

export type { S3Runtime, S3RuntimeOptions } from "./runtime.js"
export { createRuntime, S3_PRESETS } from "./runtime.js"
export type { S3Object, S3SeedObject } from "./state.js"
export { document, operationIds, supportedOperationIds }
export const S3_NAMESPACE = "s3"
export const accessKeyCredential = sigV4AccessKeyId
export type S3APIOptions = APIOptions & {
  buckets?: readonly string[]
  objects?: readonly S3SeedObject[]
  credentials?: Readonly<Record<string, string>>
  onNotification?: (event: S3Notification) => void
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
const xmlEscape = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
const xml = (body: string, status = 200, headers: HeadersInit = {}) =>
  new Response(body, { status, headers: { "content-type": "application/xml", ...headers } })
const digest = async (bytes: Uint8Array) => {
  const input = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", input))
  return `"${[...hash.slice(0, 16)].map((value) => value.toString(16).padStart(2, "0")).join("")}"`
}
const metadata = (headers: Headers) =>
  Object.fromEntries(
    [...headers]
      .filter(([name]) => name.startsWith("x-amz-meta-"))
      .map(([name, value]) => [name.slice(11), value]),
  )
const requestId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 16).toUpperCase()
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
  constructor(private readonly options: S3APIOptions = {}) {
    this.sqlite = bootSqlite(options.sqlite)
    this.namespace = options.namespace ?? S3_NAMESPACE
    this.now = options.now ?? Date.now
    this.state = new S3State(this.sqlite, this.namespace)
    void this.seed()
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
      bytes: [...bytes],
      etag: input.etag ?? (await digest(bytes)),
      lastModified: input.lastModified ?? this.now(),
      metadata: input.metadata,
      ...(input.contentType ? { contentType: input.contentType } : {}),
      ...(input.cacheControl ? { cacheControl: input.cacheControl } : {}),
      ...(input.contentDisposition ? { contentDisposition: input.contentDisposition } : {}),
    }
    this.state.objects.insert(this.state.objectId(input.bucket, input.key), object)
    return object
  }
  private error(code: string, message: string, status: number, resource: string) {
    const id = requestId()
    return xml(
      `<Error><Code>${code}</Code><Message>${xmlEscape(message)}</Message><Resource>${xmlEscape(resource)}</Resource><RequestId>${id}</RequestId><HostId>mockingbird</HostId></Error>`,
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
  private async verifyPresign(request: Request, url: URL): Promise<Response | undefined> {
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
        url.pathname,
      )
    const [accessKey, date, region] = parts as [string, string, string]
    const secret = (this.options.credentials ?? { fixture: "fixture" })[accessKey]
    if (!secret) return this.error("AccessDenied", "Invalid access key", 403, url.pathname)
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
      this.now() > signedAt + expires * 1000
    )
      return this.error("AccessDenied", "Request has expired", 403, url.pathname)
    const names = signedHeaders.split(";").filter(Boolean)
    if (!names.includes("host"))
      return this.error(
        "SignatureDoesNotMatch",
        "SignedHeaders must include host",
        403,
        url.pathname,
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
      url.pathname,
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
        url.pathname,
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
    for (const [name, value] of Object.entries(object.metadata))
      headers.set(`x-amz-meta-${name}`, value)
    return headers
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const invalidPresign = await this.verifyPresign(request, url)
    if (invalidPresign) return invalidPresign
    const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent)
    const bucket = segments.shift()
    const key = segments.join("/")
    if (!bucket)
      return this.error("InvalidURI", "Could not parse the specified URI", 400, url.pathname)
    const exists = this.state.buckets.has(bucket)
    if (request.method === "PUT" && !key && !url.search) {
      if (!exists) this.state.buckets.insert(bucket, { createdAt: this.now() })
      return new Response(null, { status: 200, headers: { location: `/${bucket}` } })
    }
    if (!exists)
      return this.error("NoSuchBucket", "The specified bucket does not exist", 404, url.pathname)
    if (request.method === "HEAD" && !key) return new Response(null, { status: 200 })
    if (request.method === "GET" && !key) return this.list(bucket, url)
    if (request.method === "POST" && !key && url.searchParams.has("delete"))
      return this.deleteMany(bucket, request)
    if (!key) return this.error("InvalidRequest", "A key is required", 400, url.pathname)
    if (request.method === "POST" && url.searchParams.has("uploads")) {
      const id = this.state.ids.next("upload-", 24)
      this.state.uploads.insert(id, { id, bucket, key, initiated: this.now() })
      return xml(
        `<InitiateMultipartUploadResult><Bucket>${xmlEscape(bucket)}</Bucket><Key>${xmlEscape(key)}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
      )
    }
    if (request.method === "PUT" && url.searchParams.has("uploadId"))
      return this.uploadPart(bucket, key, url, request)
    if (request.method === "POST" && url.searchParams.has("uploadId"))
      return this.complete(bucket, key, url)
    if (request.method === "DELETE" && url.searchParams.has("uploadId")) {
      const id = url.searchParams.get("uploadId") as string
      this.state.uploads.delete(id)
      for (const part of this.state.parts.list({ where: (value) => value.uploadId === id }))
        this.state.parts.delete(part.id)
      return new Response(null, { status: 204 })
    }
    if (request.method === "PUT") return this.put(bucket, key, request)
    if (request.method === "DELETE") {
      const deleted = this.state.object(bucket, key)
      this.state.objects.delete(this.state.objectId(bucket, key))
      if (deleted) this.notify("ObjectRemoved:Delete", deleted)
      return new Response(null, { status: 204 })
    }
    const object = this.state.object(bucket, key)
    if (!object)
      return this.error("NoSuchKey", "The specified key does not exist.", 404, url.pathname)
    if (request.headers.get("if-match") && request.headers.get("if-match") !== object.etag)
      return this.error("PreconditionFailed", "At least one precondition failed", 412, url.pathname)
    if (request.method === "HEAD")
      return new Response(null, { status: 200, headers: this.objectHeaders(object) })
    if (request.method === "GET") return this.get(object, request, url.pathname)
    return this.error("MethodNotAllowed", "The specified method is not allowed", 405, url.pathname)
  }
  private async put(bucket: string, key: string, request: Request) {
    const copy = request.headers.get("x-amz-copy-source")
    if (copy) {
      const [sourceBucket, ...sourceKey] = decodeURIComponent(copy.replace(/^\//, "")).split("/")
      const source = sourceBucket ? this.state.object(sourceBucket, sourceKey.join("/")) : undefined
      if (!source) return this.error("NoSuchKey", "The specified key does not exist.", 404, copy)
      const stored = await this.putSeed({
        ...source,
        bucket,
        key,
        body: new Uint8Array(source.bytes),
        metadata: source.metadata,
      })
      this.notify("ObjectCreated:Copy", stored)
      return xml(
        `<CopyObjectResult><LastModified>${new Date(stored.lastModified).toISOString()}</LastModified><ETag>${stored.etag}</ETag></CopyObjectResult>`,
      )
    }
    const bytes = new Uint8Array(await request.arrayBuffer())
    const object = await this.putSeed({
      bucket,
      key,
      body: bytes,
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
    this.notify("ObjectCreated:Put", object)
    return new Response(null, { status: 200, headers: { etag: object.etag } })
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
    return new Response(bytes, { status: 206, headers })
  }
  private list(bucket: string, url: URL) {
    const prefix = url.searchParams.get("prefix") ?? ""
    const delimiter = url.searchParams.get("delimiter")
    const max = Math.max(0, Math.min(1000, Number(url.searchParams.get("max-keys") ?? 1000)))
    const token = url.searchParams.get("continuation-token")
    const after = token
      ? new TextDecoder().decode(Uint8Array.from(atob(token), (value) => value.charCodeAt(0)))
      : undefined
    const keys = this.state.objects
      .list({ where: (object) => object.bucket === bucket && object.key.startsWith(prefix) })
      .map(({ value }) => value)
      .sort((left, right) => left.key.localeCompare(right.key, "en", { sensitivity: "variant" }))
      .filter((object) => !after || object.key > after)
    const contents: S3Object[] = []
    const prefixes = new Set<string>()
    for (const object of keys) {
      const rest = object.key.slice(prefix.length)
      const split = delimiter ? rest.indexOf(delimiter) : -1
      if (delimiter && split >= 0) prefixes.add(prefix + rest.slice(0, split + delimiter.length))
      else contents.push(object)
      if (contents.length + prefixes.size >= max) break
    }
    const returned = [...contents.map((object) => object.key), ...prefixes].sort()
    const truncated = keys.some(
      (object) =>
        !returned.includes(object.key) &&
        ![...prefixes].some((value) => object.key.startsWith(value)),
    )
    const next =
      truncated && returned.length
        ? btoa(String.fromCharCode(...encoder.encode(returned.at(-1) as string)))
        : undefined
    return xml(
      `<ListBucketResult><Name>${xmlEscape(bucket)}</Name><Prefix>${xmlEscape(prefix)}</Prefix><KeyCount>${contents.length + prefixes.size}</KeyCount><MaxKeys>${max}</MaxKeys><IsTruncated>${truncated}</IsTruncated>${contents.map((object) => `<Contents><Key>${xmlEscape(object.key)}</Key><LastModified>${new Date(object.lastModified).toISOString()}</LastModified><ETag>${object.etag}</ETag><Size>${object.bytes.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`).join("")}${[...prefixes].map((value) => `<CommonPrefixes><Prefix>${xmlEscape(value)}</Prefix></CommonPrefixes>`).join("")}${next ? `<NextContinuationToken>${next}</NextContinuationToken>` : ""}</ListBucketResult>`,
    )
  }
  private async uploadPart(bucket: string, key: string, url: URL, request: Request) {
    const id = url.searchParams.get("uploadId") as string
    const upload = this.state.uploads.get(id)
    if (!upload || upload.bucket !== bucket || upload.key !== key)
      return this.error("NoSuchUpload", "The specified upload does not exist", 404, url.pathname)
    const partNumber = Number(url.searchParams.get("partNumber"))
    const bytes = new Uint8Array(await request.arrayBuffer())
    const etag = await digest(bytes)
    this.state.parts.insert(`${id}:${partNumber}`, {
      uploadId: id,
      partNumber,
      bytes: [...bytes],
      etag,
    })
    return new Response(null, { status: 200, headers: { etag } })
  }
  private async complete(bucket: string, key: string, url: URL) {
    const id = url.searchParams.get("uploadId") as string
    const upload = this.state.uploads.get(id)
    if (!upload)
      return this.error("NoSuchUpload", "The specified upload does not exist", 404, url.pathname)
    const parts = this.state.parts
      .list({ where: (part) => part.uploadId === id })
      .map(({ value }) => value)
      .sort((a, b) => a.partNumber - b.partNumber)
    const bytes = new Uint8Array(parts.flatMap((part) => part.bytes))
    const object = await this.putSeed({ bucket, key, body: bytes, metadata: {} })
    this.notify("ObjectCreated:CompleteMultipartUpload", object)
    this.state.uploads.delete(id)
    for (const part of parts) this.state.parts.delete(`${id}:${part.partNumber}`)
    return xml(
      `<CompleteMultipartUploadResult><Location>/${xmlEscape(bucket)}/${xmlEscape(key)}</Location><Bucket>${xmlEscape(bucket)}</Bucket><Key>${xmlEscape(key)}</Key><ETag>${object.etag}</ETag></CompleteMultipartUploadResult>`,
    )
  }
  private async deleteMany(bucket: string, request: Request) {
    const body = await request.text()
    const keys = [...body.matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((match) => match[1] as string)
    for (const key of keys) {
      const object = this.state.object(bucket, key)
      this.state.objects.delete(this.state.objectId(bucket, key))
      if (object) this.notify("ObjectRemoved:Delete", object)
    }
    return xml(
      `<DeleteResult>${keys.map((key) => `<Deleted><Key>${xmlEscape(key)}</Key></Deleted>`).join("")}</DeleteResult>`,
    )
  }
}
