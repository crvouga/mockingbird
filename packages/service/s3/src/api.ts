/**
 * The request pipeline, in MinIO's order: routing (`api-router.go`; an unmatched request skips
 * the middlewares), request limits and validity (`setRequestLimitMiddleware`,
 * `setRequestValidityMiddleware`), authentication and authorization (`checkRequestAuthType`),
 * then the operation handler. Any `S3Error` thrown on the way becomes MinIO's XML error (or, for HEAD,
 * the `x-minio-error-*` headers with no body).
 */
import { type APIOptions, bootSqlite } from "@crvouga/mockingbird-service"
import { clearNamespace } from "@crvouga/mockingbird-sqlite"
import {
  type AuthType,
  authenticate,
  authType,
  checkAuthMiddleware,
  type SignedRequest,
  type Verified,
} from "./auth.js"
import type { Ctx, Identity } from "./context.js"
import { corsPreflight, withCors } from "./cors-handling.js"
import { S3Error } from "./errors.js"
import {
  DEFAULT_VIRTUAL_HOSTS,
  objectName,
  toPathStyle,
  VIRTUAL_BUCKET_HEADER,
  virtualBucket,
} from "./hosting.js"
import { lifecyclePreflight } from "./ops/bucket-config.js"
import { createBucketPreflight } from "./ops/buckets.js"
import { handlers } from "./ops/index.js"
import { readPayload } from "./payload.js"
import { authorize } from "./policy.js"
import { type Operation, route } from "./router.js"
import type { ObjectVersion } from "./state.js"
import { S3Core, type S3Notification } from "./store.js"
import { requestRejection } from "./validation.js"
import { doc, el } from "./xml.js"

export type S3SeedObject = {
  bucket: string
  key: string
  body: Uint8Array | string
  metadata?: Record<string, string>
  contentType?: string
  cacheControl?: string
  contentDisposition?: string
  contentEncoding?: string
  /** URL-encoded tag set, or a record of tags. */
  tags?: Record<string, string> | string
  storageClass?: string
  etag?: string
  lastModified?: number
}

export type S3APIOptions = APIOptions & {
  buckets?: readonly string[]
  objects?: readonly S3SeedObject[]
  /** access key → secret key. Default `{ fixture: "fixture" }`. */
  credentials?: Readonly<Record<string, string>>
  /**
   * `lenient` (default): unsigned requests act as the bucket owner and header signatures are not
   * checked; presigned URLs still are. `strict`: MinIO's authentication exactly — every request
   * must be signed by a known key (or allowed anonymously by a bucket policy).
   */
  authentication?: "lenient" | "strict"
  /** The server region (`x-amz-bucket-region`, signature scope). Default `us-east-1`. */
  region?: string
  /**
   * Base hosts for virtual-hosted-style addressing: `Host: <bucket>.<base>` names the bucket and
   * the path is the key. Default `["localhost"]`; `[]` leaves every request path-style.
   */
  virtualHosts?: readonly string[]
  onNotification?: (event: S3Notification) => void
  /** A seeded stream of `[0, 1)` for request and version ids. */
  random?: () => number
}

export const S3_NAMESPACE = "s3"
/** S3 accepts at most 5 GiB in a single PUT and in each multipart part. */
export const S3_MAX_UPLOAD_BYTES = 5 * 1024 ** 3
const HOST_ID = "dd9025bab4ad464b049177c95eb6ebf374d3b3fd1af9251148b658df7ac2e3e8"
const encoder = new TextEncoder()

const safeDecode = (value: string) => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * Marks a response MinIO writes outside its middleware chain: `error` (no route matched: no
 * request ids), `bare` (an unrouted OPTIONS: no common headers at all) or `streamed` (a body
 * written straight to the connection, e.g. S3 Select: request ids only). Stripped by `finish`.
 */
const UNROUTED = "x-mockingbird-s3-unrouted"

/** MinIO's `errorResponseHandler`, for a request no route matches. */
const unroutedResponse = (method: string, path: string, region: string) => {
  if (method === "OPTIONS")
    return new Response(null, {
      status: 200,
      headers: { [UNROUTED]: "bare", "content-length": "0" },
    })
  const body = doc(
    "Error",
    el("Code", "BadRequest") +
      el("Message", `An unsupported API call for method: ${method} at '${path}'`) +
      el("Resource", path) +
      (region ? el("Region", region) : "") +
      "<RequestId></RequestId><HostId></HostId>",
    false,
  )
  return new Response(body, {
    status: 400,
    headers: { [UNROUTED]: "error", "content-type": "application/xml" },
  })
}

export class S3API {
  readonly core: S3Core
  private readonly sqlite
  private readonly namespace: string
  private readonly ready: Promise<void>
  constructor(private readonly options: S3APIOptions = {}) {
    this.sqlite = bootSqlite(options.sqlite)
    this.namespace = options.namespace ?? S3_NAMESPACE
    this.core = new S3Core({
      sqlite: this.sqlite,
      namespace: this.namespace,
      now: options.now ?? Date.now,
      random: options.random ?? Math.random,
      region: options.region ?? "us-east-1",
      credentials: options.credentials ?? { fixture: "fixture" },
      authentication: options.authentication ?? "lenient",
      ...(options.onNotification ? { onNotification: options.onNotification } : {}),
    })
    this.ready = this.seed()
  }
  get state() {
    return this.core.state
  }
  private async seed() {
    for (const bucket of this.options.buckets ?? [])
      if (!this.core.bucket(bucket)) this.core.saveBucket(bucket, { createdAt: this.core.now() })
    for (const object of this.options.objects ?? []) await this.putSeed(object)
  }
  async reset() {
    clearNamespace(this.sqlite, this.namespace)
    await this.seed()
  }
  /** Store an object directly (fixtures, the admin plane), creating its bucket if needed. */
  async putSeed(input: S3SeedObject): Promise<ObjectVersion> {
    if (!this.core.bucket(input.bucket))
      this.core.saveBucket(input.bucket, { createdAt: this.core.now() })
    const bytes = typeof input.body === "string" ? encoder.encode(input.body) : input.body
    const { md5Hex } = await import("./digest.js")
    const tagging =
      typeof input.tags === "string"
        ? input.tags
        : input.tags
          ? new URLSearchParams(Object.entries(input.tags)).toString()
          : undefined
    return this.core.write(
      {
        bucket: input.bucket,
        key: input.key,
        etag: input.etag?.replace(/"/g, "") ?? md5Hex(bytes),
        lastModified: input.lastModified ?? this.core.now(),
        metadata: Object.fromEntries(
          Object.entries(input.metadata ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
        ),
        ...(input.contentType ? { contentType: input.contentType } : {}),
        ...(input.cacheControl ? { cacheControl: input.cacheControl } : {}),
        ...(input.contentDisposition ? { contentDisposition: input.contentDisposition } : {}),
        ...(input.contentEncoding ? { contentEncoding: input.contentEncoding } : {}),
        ...(tagging ? { tagging } : {}),
        ...(input.storageClass ? { storageClass: input.storageClass } : {}),
      },
      bytes,
    )
  }

  private requestId() {
    return this.core.randomHex(16).toUpperCase()
  }

  async fetch(input: Request): Promise<Response> {
    await this.ready
    const bases = this.options.virtualHosts ?? DEFAULT_VIRTUAL_HOSTS
    const request = toPathStyle(input, bases)
    const url = new URL(request.url)
    const raw = url.pathname
    const slash = raw.indexOf("/", 1)
    const bucket = safeDecode(raw.slice(1, slash < 0 ? undefined : slash))
    const key = slash < 0 ? "" : safeDecode(raw.slice(slash + 1))
    const path = safeDecode(raw)
    // A rewritten virtual-hosted request was signed without its bucket in the path.
    const signedPath =
      virtualBucket(url.host, bases) !== undefined &&
      request.headers.get(VIRTUAL_BUCKET_HEADER) === bucket
        ? path.slice(bucket.length + 1) || "/"
        : path
    const requestId = this.requestId()
    const scope = { bucket: "", key: "" }
    let response: Response
    try {
      if (request.method === "OPTIONS" && bucket)
        response = await corsPreflight(this.core, bucket, request, url)
      else response = await this.handle(request, url, bucket, key, path, signedPath, scope)
    } catch (error) {
      if (!(error instanceof S3Error)) throw error
      response = this.renderError(error, request.method, path, scope)
    }
    return this.finish(withCors(this.core, bucket, request, response), requestId)
  }

  private renderError(
    error: S3Error,
    method: string,
    path: string,
    scope: { bucket: string; key: string },
    /** Write the XML body even for HEAD (MinIO's middlewares use `writeErrorResponse`). */
    xml = false,
  ) {
    const headers = new Headers(error.options.headers)
    if (error.status === 503 || error.status === 429) headers.set("retry-after", "60")
    if ((method === "HEAD" || error.options.headersOnly) && !xml) {
      headers.set("x-minio-error-code", error.code)
      headers.set("x-minio-error-desc", `"${error.message}"`)
      return new Response(null, { status: error.status, headers })
    }
    const key = error.options.key ?? scope.key
    const bucket = error.options.bucket ?? scope.bucket
    const body = doc(
      "Error",
      el("Code", error.code) +
        el(
          "Message",
          error.code === "InvalidRegion"
            ? `Region does not match; expecting '${this.core.region}'.`
            : error.message,
        ) +
        Object.entries(error.options.fields ?? {})
          .map(([name, value]) => el(name, value))
          .join("") +
        (key ? el("Key", key) : "") +
        (bucket ? el("BucketName", bucket) : "") +
        el("Resource", error.options.resource ?? path) +
        (this.core.region ? el("Region", this.core.region) : "") +
        "<RequestId></RequestId>" +
        `<HostId>${HOST_ID}</HostId>` +
        (error.options.actualObjectSize
          ? el("ActualObjectSize", error.options.actualObjectSize)
          : "") +
        (error.options.rangeRequested ? el("RangeRequested", error.options.rangeRequested) : ""),
      false,
    )
    headers.set("content-type", "application/xml")
    return new Response(body, { status: error.status, headers })
  }

  /** MinIO's `setCommonHeaders` plus the request ids, filled into the error body too. */
  private async finish(response: Response, requestId: string) {
    const headers = new Headers(response.headers)
    const unrouted = headers.get(UNROUTED)
    headers.delete(UNROUTED)
    if (unrouted !== "bare" && unrouted !== "streamed") {
      headers.set("accept-ranges", "bytes")
      if (this.core.region) headers.set("x-amz-bucket-region", this.core.region)
    }
    if (!unrouted || unrouted === "streamed") {
      headers.set("x-amz-request-id", requestId)
      headers.set("x-amz-id-2", HOST_ID)
    }
    let body: BodyInit | null = response.body
    if (headers.get("content-type") === "application/xml" && response.body) {
      const text = (await response.text()).replace(
        "<RequestId></RequestId>",
        unrouted ? "<RequestId></RequestId>" : `<RequestId>${requestId}</RequestId>`,
      )
      body = text
      headers.set("content-length", String(encoder.encode(text).length))
    } else if (
      response.body === null &&
      !headers.has("content-length") &&
      response.status !== 204 &&
      response.status !== 304
    )
      headers.set("content-length", "0")
    return new Response(body, { status: response.status, statusText: response.statusText, headers })
  }

  private async handle(
    request: Request,
    url: URL,
    bucket: string,
    key: string,
    path: string,
    signedPath: string,
    scope: { bucket: string; key: string },
  ): Promise<Response> {
    const method = request.method
    const query = url.searchParams
    const headers = request.headers
    // api-router.go: a request no route matches skips every middleware.
    const op: Operation = route(method, bucket, key, query, headers)
    if (op === "Unsupported") return unroutedResponse(method, path, this.core.region)
    // setAuthMiddleware: an unknown scheme, a missing/bad/skewed date, before any validation.
    const auth = authType(method, headers, query)
    if (this.core.options.authentication === "strict")
      try {
        checkAuthMiddleware(auth, headers, this.core.now())
      } catch (error) {
        if (!(error instanceof S3Error)) throw error
        return this.renderError(error, method, path, scope, true)
      }
    // setRequestLimitMiddleware, setRequestValidityMiddleware
    const rejection = requestRejection({
      method,
      path,
      bucket,
      query,
      headers,
      ignoreHeaders: [VIRTUAL_BUCKET_HEADER],
      secure: url.protocol === "https:",
    })
    if (rejection) {
      if (rejection.headersOnly) throw rejection.error
      return this.renderError(rejection.error, method, path, scope, true)
    }
    // Routes that answer without a handler context (no BucketName/Key in the error).
    if (op === "NotImplemented") throw new S3Error("NotImplemented")
    if (op === "AppendObject")
      throw new S3Error("BadRequest", {
        message: `An unsupported API call for method: ${method} at '${path}'`,
      })
    // The router saw the raw key (`/bucket//` is an object route); handlers see MinIO's name.
    key = objectName(key)
    scope.bucket = bucket
    scope.key = key
    if (op === "CreateBucket") createBucketPreflight(headers)
    if (op === "PutBucketLifecycle") lifecyclePreflight(headers)
    const signed: SignedRequest = {
      method,
      path: signedPath,
      rawPath: url.pathname,
      rawQuery: url.search.slice(1),
      host: url.host,
      headers,
      query,
    }
    const { identity, verified } = await this.authenticate(op, auth, signed)
    const payload = readPayload(request, {
      auth,
      ...(verified ? { verified } : {}),
      op,
      strict: this.core.options.authentication === "strict",
      signed,
    })
    const ctx: Ctx = {
      core: this.core,
      request,
      method,
      url,
      query,
      headers,
      bucket,
      key,
      path,
      op,
      auth,
      identity,
      ...(verified ? { verified } : {}),
      now: this.core.now(),
      body: () => payload.bytes(),
      text: async () => new TextDecoder().decode(await payload.bytes()),
      trailers: () => payload.trailers(),
    }
    await authorize(ctx)
    const handler = handlers[op]
    if (!handler) throw new S3Error("NotImplemented")
    return handler(ctx)
  }

  private authenticate(
    op: Operation,
    auth: AuthType,
    signed: SignedRequest,
  ): Promise<{ identity: Identity; verified?: Verified }> {
    const { credentials, authentication, region } = this.core.options
    return authenticate({
      op,
      auth,
      signed,
      region,
      lookup: (accessKey) =>
        Object.hasOwn(credentials, accessKey) ? credentials[accessKey] : undefined,
      now: this.core.now(),
      strict: authentication === "strict",
    })
  }
}
