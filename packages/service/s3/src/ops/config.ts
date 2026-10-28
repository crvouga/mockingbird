/**
 * Bucket sub-resources: the bucket policy (Put/Get/Delete, GetBucketPolicyStatus), MinIO's
 * dummies (website, accelerate, requestPayment, logging), ListenNotification, and bucket CORS.
 * CORS follows Amazon S3 rather than MinIO (which only stubs it): see `cors-handling.ts`.
 * Lifecycle, encryption, notification and replication live in `bucket-config.ts`.
 */
import { EVENT_NAMES } from "../bucket-config/documents.js"
import { type Handlers, ok, xmlResponse } from "../context.js"
import { invalidCors, parseCors } from "../cors.js"
import { fail, S3Error } from "../errors.js"
import {
  conditionValues,
  marshalBucketPolicy,
  parseBucketPolicy,
  policyAllows,
  policyError,
  storedPolicy,
} from "../policy.js"
import { el, XML_HEADER } from "../xml.js"
import { bucketConfigHandlers } from "./bucket-config.js"
import { requireBucket } from "./common.js"

/** `maxBucketPolicySize`. */
const MAX_POLICY_BYTES = 20 * 1024

/** A body MinIO writes verbatim with `writeSuccessResponseXML`. */
const rawXml = (body: string) =>
  new Response(body, { status: 200, headers: { "content-type": "application/xml" } })

const S3NS = 'xmlns="http://s3.amazonaws.com/doc/2006-03-01/"'

export const configHandlers: Handlers = {
  ...bucketConfigHandlers,

  async PutBucketPolicy(ctx) {
    requireBucket(ctx)
    const body = await ctx.body()
    const declared = ctx.headers.get("content-length")
    const length = declared !== null ? Number(declared) : body.length
    if (!(length > 0)) fail("MissingContentLength")
    if (length > MAX_POLICY_BYTES) fail("PolicyTooLarge")
    let document: string
    try {
      const policy = parseBucketPolicy(new TextDecoder().decode(body), ctx.bucket)
      if (policy.version === "") fail("PolicyInvalidVersion")
      document = marshalBucketPolicy(policy)
    } catch (error) {
      if (error instanceof S3Error) throw error
      throw policyError(error)
    }
    ctx.core.setConfig(ctx.bucket, "policy", document)
    return ok({}, 204)
  },
  GetBucketPolicy(ctx) {
    requireBucket(ctx)
    const stored = ctx.core.config(ctx.bucket, "policy")
    if (stored === undefined) fail("NoSuchBucketPolicy")
    return new Response(stored, {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-length": String(new TextEncoder().encode(stored).length),
      },
    })
  },
  DeleteBucketPolicy(ctx) {
    requireBucket(ctx)
    ctx.core.setConfig(ctx.bucket, "policy", undefined)
    return ok({}, 204)
  },
  GetBucketPolicyStatus(ctx) {
    requireBucket(ctx)
    const policy = storedPolicy(ctx.core, ctx.bucket)
    const values = conditionValues(ctx)
    const allows = (action: string) =>
      policy !== undefined && policyAllows(policy, action, ctx.bucket, "", values)
    const isPublic = allows("s3:ListBucket") && allows("s3:PutObject")
    return xmlResponse("PolicyStatus", el("IsPublic", isPublic ? "TRUE" : "FALSE"))
  },

  // ── MinIO's dummy handlers (dummy-handlers.go) ──────────────────────────────────────────
  GetBucketWebsite(ctx) {
    requireBucket(ctx)
    return fail("NoSuchWebsiteConfiguration")
  },
  GetBucketAccelerate(ctx) {
    requireBucket(ctx)
    return rawXml(`${XML_HEADER.trimEnd()}<AccelerateConfiguration ${S3NS}/>`)
  },
  GetBucketRequestPayment(ctx) {
    requireBucket(ctx)
    return rawXml(
      `${XML_HEADER.trimEnd()}<RequestPaymentConfiguration ${S3NS}><Payer>BucketOwner</Payer></RequestPaymentConfiguration>`,
    )
  },
  GetBucketLogging(ctx) {
    requireBucket(ctx)
    return rawXml(
      `${XML_HEADER.trimEnd()}<BucketLoggingStatus ${S3NS}><!--<LoggingEnabled><TargetBucket>myLogsBucket</TargetBucket><TargetPrefix>add/this/prefix/to/my/log/files/access_log-</TargetPrefix></LoggingEnabled>--></BucketLoggingStatus>`,
    )
  },
  DeleteBucketWebsite() {
    return ok()
  },

  // ── bucket CORS, with Amazon S3's semantics ─────────────────────────────────────────────
  GetBucketCors(ctx) {
    requireBucket(ctx)
    const stored = ctx.core.config(ctx.bucket, "cors")
    if (stored === undefined) fail("NoSuchCORSConfiguration")
    return rawXml(stored as string)
  },
  async PutBucketCors(ctx) {
    requireBucket(ctx)
    const body = await ctx.text()
    let rules: ReturnType<typeof parseCors>
    try {
      if (!/<CORSConfiguration[\s>/]/.test(body)) throw new TypeError("not a CORSConfiguration")
      rules = parseCors(body)
    } catch {
      return fail("MalformedXML")
    }
    const invalid = invalidCors(rules)
    if (invalid) fail("MalformedXML", { code: invalid[0], message: invalid[1] })
    ctx.core.setConfig(ctx.bucket, "cors", body)
    return ok()
  },
  DeleteBucketCors(ctx) {
    requireBucket(ctx)
    ctx.core.setConfig(ctx.bucket, "cors", undefined)
    return ok({}, 204)
  },

  // ── ListenNotification (MinIO extension) ────────────────────────────────────────────────
  ListenNotification(ctx) {
    const prefixes = ctx.query.getAll("prefix")
    const suffixes = ctx.query.getAll("suffix")
    const validValue = (value: string) =>
      !value.split("/").some((segment) => segment === "." || segment === "..") &&
      new TextEncoder().encode(value).length <= 1024 &&
      !value.includes("\\")
    if (prefixes.length > 1) fail("FilterNamePrefix")
    if (prefixes.length === 1 && !validValue(prefixes[0] as string)) fail("FilterValueInvalid")
    if (suffixes.length > 1) fail("FilterNameSuffix")
    if (suffixes.length === 1 && !validValue(suffixes[0] as string)) fail("FilterValueInvalid")
    for (const name of ctx.query.getAll("events"))
      if (!EVENT_NAMES.has(name)) fail("EventNotification")
    if (ctx.bucket) requireBucket(ctx)
    // MinIO holds the connection open and streams matching events as JSON lines; the emulator
    // keeps the stream open (no events) until the client goes away.
    let timer: ReturnType<typeof setInterval> | undefined
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const space = new TextEncoder().encode(" ")
        timer = setInterval(() => controller.enqueue(space), 5000)
        ctx.request.signal.addEventListener("abort", () => {
          clearInterval(timer)
          try {
            controller.close()
          } catch {}
        })
      },
      cancel() {
        clearInterval(timer)
      },
    })
    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "x-accel-buffering": "no",
        "x-mockingbird-s3-unrouted": "streamed",
      },
    })
  },
}
