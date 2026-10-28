/**
 * Bucket configuration documents: lifecycle, encryption, notification, replication (and MinIO's
 * replication extensions). MinIO here has no KMS, no notification targets and no remote
 * replication targets, so encryption and replication configurations can never be stored, and a
 * notification configuration only when it has no queues.
 */
import {
  EMPTY_NOTIFICATION,
  EventError,
  goDurationError,
  parseNotificationConfig,
  parseReplicationConfig,
  parseSseConfig,
} from "../bucket-config/documents.js"
import { GoError } from "../bucket-config/goxml.js"
import {
  hasTransitionTier,
  marshalLifecycle,
  parseLifecycle,
  validateLifecycle,
} from "../bucket-config/lifecycle.js"
import { type Ctx, type Handlers, ok } from "../context.js"
import { MINIO_ERRORS } from "../errors.generated.js"
import { fail, S3Error } from "../errors.js"

const MALFORMED_XML = MINIO_ERRORS.MalformedXML[1]
const INTERNAL_ERROR = MINIO_ERRORS.InternalError[1]
const GO_BOOLS: Record<string, boolean> = {
  "1": true,
  t: true,
  T: true,
  TRUE: true,
  true: true,
  True: true,
  "0": false,
  f: false,
  F: false,
  FALSE: false,
  false: false,
  False: false,
}
const LIFECYCLE_UPDATED = "lifecycle-updated-at"

/** A configuration document as MinIO writes it: `xml.Marshal` output, no XML header. */
const rawXml = (body: string) =>
  new Response(body, { status: 200, headers: { "content-type": "application/xml" } })

/** `toAPIError` for what decoding a lifecycle configuration can throw. */
const lifecycleFailure = (error: unknown): never => {
  if (!(error instanceof GoError)) throw error
  switch (error.kind) {
    case "syntax":
      return fail("MalformedXML", { message: `${MALFORMED_XML} (${error.message})` })
    case "strconv-range":
      return fail("BadRequest", { message: error.message })
    case "lifecycle":
      return fail("InvalidArgument", { message: error.message })
    default:
      return fail("InternalError", { message: `${INTERNAL_ERROR}: cause(${error.message})` })
  }
}

/** MinIO's `validateLengthAndChecksum`: a decodable Content-MD5 or a checksum header. */
const hasChecksum = (headers: Headers) => {
  const base64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
  const md5 = headers.get("content-md5")
  if (md5) return base64.test(md5)
  for (const algorithm of ["crc32", "crc32c", "crc64nvme", "sha1", "sha256"]) {
    const value = headers.get(`x-amz-checksum-${algorithm}`)
    if (value) return base64.test(value)
  }
  return false
}

/**
 * PutBucketLifecycle's `validateLengthAndChecksum`, which MinIO runs before it authenticates (so
 * before the Content-MD5 format check): the pipeline calls it ahead of authentication.
 */
export const lifecyclePreflight = (headers: Headers) => {
  if (!hasChecksum(headers)) fail("MissingContentMD5")
}

/** The body, ignoring a Content-MD5 mismatch (MinIO does not surface it for these documents). */
const lenientText = async (ctx: Ctx) => {
  const copy = ctx.request.bodyUsed ? undefined : ctx.request.clone()
  try {
    return await ctx.text()
  } catch (error) {
    if (copy && error instanceof S3Error && error.errorName === "BadDigest") return copy.text()
    throw error
  }
}

const versioned = (ctx: Ctx) => ctx.core.bucket(ctx.bucket)?.versioning === "Enabled"
const replicationNotFound = () => fail("ReplicationConfigurationNotFoundError")

/** `iso8601Format` (`20060102T150405Z`). */
const compactIso = (ms: number) => new Date(ms).toISOString().replace(/[-:]|\.\d{3}/g, "")

export const bucketConfigHandlers: Handlers = {
  // ── lifecycle ──────────────────────────────────────────────────────────────
  async PutBucketLifecycle(ctx) {
    if (!hasChecksum(ctx.headers)) fail("MissingContentMD5")
    const body = await lenientText(ctx)
    let config: ReturnType<typeof parseLifecycle>
    try {
      config = parseLifecycle(body, () => ctx.core.uuid())
      validateLifecycle(config, ctx.core.bucket(ctx.bucket)?.objectLock === true)
    } catch (error) {
      return lifecycleFailure(error)
    }
    if (hasTransitionTier(config)) fail("InvalidStorageClass")
    // MinIO does not check that the bucket exists; there is nothing to store it on.
    if (ctx.core.bucket(ctx.bucket)) {
      ctx.core.setConfig(ctx.bucket, "lifecycle", marshalLifecycle(config))
      ctx.core.setConfig(ctx.bucket, LIFECYCLE_UPDATED, String(ctx.now))
    }
    return ok()
  },
  GetBucketLifecycle(ctx) {
    const flag = ctx.query.get("withUpdatedAt")
    let withUpdatedAt = false
    if (flag) {
      // `strconv.ParseBool`, untrimmed.
      const parsed = GO_BOOLS[flag]
      if (parsed === undefined) fail("InvalidLifecycleQueryParameter")
      withUpdatedAt = parsed === true
    }
    ctx.core.requireBucket(ctx.bucket)
    const stored = ctx.core.config(ctx.bucket, "lifecycle")
    if (!stored) fail("NoSuchLifecycleConfiguration")
    const response = rawXml(stored as string)
    if (withUpdatedAt)
      response.headers.set(
        "x-minio-lifecycleconfig-updatedat",
        compactIso(Number(ctx.core.config(ctx.bucket, LIFECYCLE_UPDATED) ?? ctx.now)),
      )
    return response
  },
  DeleteBucketLifecycle(ctx) {
    ctx.core.requireBucket(ctx.bucket)
    ctx.core.setConfig(ctx.bucket, "lifecycle", undefined)
    ctx.core.setConfig(ctx.bucket, LIFECYCLE_UPDATED, undefined)
    return ok({}, 204)
  },

  // ── encryption ─────────────────────────────────────────────────────────────
  async PutBucketEncryption(ctx) {
    ctx.core.requireBucket(ctx.bucket)
    try {
      parseSseConfig(await ctx.text())
    } catch (error) {
      if (!(error instanceof GoError)) throw error
      fail("MalformedXML", { message: `${MALFORMED_XML} (${error.message})` })
    }
    // MinIO without a KMS cannot apply a default bucket encryption.
    return fail("KMSNotConfigured")
  },
  GetBucketEncryption(ctx) {
    ctx.core.requireBucket(ctx.bucket)
    return fail("NoSuchBucketSSEConfig")
  },
  DeleteBucketEncryption(ctx) {
    ctx.core.requireBucket(ctx.bucket)
    return ok({}, 204)
  },

  // ── notification ───────────────────────────────────────────────────────────
  GetBucketNotification(ctx) {
    ctx.core.requireBucket(ctx.bucket)
    return rawXml(EMPTY_NOTIFICATION)
  },
  async PutBucketNotification(ctx) {
    ctx.core.requireBucket(ctx.bucket)
    if (!(Number(ctx.headers.get("content-length") ?? "-1") > 0)) fail("MissingContentLength")
    try {
      parseNotificationConfig(await ctx.text(), ctx.core.region)
    } catch (error) {
      if (error instanceof EventError) fail(error.api)
      if (error instanceof GoError) fail("MalformedXML")
      throw error
    }
    return ok()
  },

  // ── replication ────────────────────────────────────────────────────────────
  async PutBucketReplication(ctx) {
    ctx.core.requireBucket(ctx.bucket)
    if (!versioned(ctx)) fail("ReplicationNeedsVersioningError")
    let arns: string[] = []
    try {
      arns = parseReplicationConfig(await ctx.text())
    } catch (error) {
      if (!(error instanceof GoError)) throw error
      fail("MalformedXML", { message: error.message })
    }
    // `validateReplicationDestination`: MinIO has no remote targets to resolve an ARN to.
    for (const arn of arns) {
      const tokens = arn.split(":")
      if (!arn.startsWith("arn:minio:") || tokens.length !== 6 || !tokens[4] || !tokens[5])
        fail("BucketRemoteArnInvalid", {
          message: `${MINIO_ERRORS.BucketRemoteArnInvalid[1]} (invalid ARN ${arn})`,
        })
      if (tokens[2] !== "replication") fail("BucketRemoteArnTypeInvalid")
      fail("RemoteTargetNotFoundError")
    }
    return fail("RemoteTargetNotFoundError")
  },
  GetBucketReplication(ctx) {
    ctx.core.requireBucket(ctx.bucket)
    return replicationNotFound()
  },
  DeleteBucketReplication(ctx) {
    ctx.core.requireBucket(ctx.bucket)
    return fail("RemoteTargetNotFoundError")
  },
  GetBucketReplicationMetrics(ctx) {
    ctx.core.requireBucket(ctx.bucket)
    return replicationNotFound()
  },
  GetBucketReplicationMetricsV2(ctx) {
    ctx.core.requireBucket(ctx.bucket)
    return replicationNotFound()
  },
  ResetBucketReplicationStart(ctx) {
    const olderThan = ctx.query.get("older-than")
    if (olderThan) {
      const problem = goDurationError(olderThan)
      if (problem)
        fail("InvalidArgument", {
          message: `Invalid arguments provided for ${ctx.bucket}/: (invalid query parameter older-than ${olderThan} for ${ctx.bucket} : ${problem})`,
        })
    }
    ctx.core.requireBucket(ctx.bucket)
    return replicationNotFound()
  },
  ResetBucketReplicationStatus(ctx) {
    ctx.core.requireBucket(ctx.bucket)
    return replicationNotFound()
  },
  ValidateBucketReplicationCreds(ctx) {
    if (!ctx.core.bucket(ctx.bucket))
      fail("ReplicationValidationError", {
        message: `${MINIO_ERRORS.ReplicationValidationError[1]} (Bucket not found: ${ctx.bucket})`,
      })
    if (!versioned(ctx)) fail("ReplicationNeedsVersioningError")
    const message = MINIO_ERRORS.ReplicationConfigurationNotFoundError[1]
    return fail("ReplicationConfigurationNotFoundError", {
      message: `${message} (${message}: ${ctx.bucket})`,
    })
  },
}
