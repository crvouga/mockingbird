/**
 * The checks MinIO's generic middlewares (`cmd/generic-handlers.go`) make on every routed request
 * before its handler runs, in their order: `setRequestLimitMiddleware` (reserved and oversized
 * headers), then `setRequestValidityMiddleware` (path components, query values, multiple
 * authentication types, reserved buckets, bucket names, SSE-C over plain HTTP).
 */
import { hasMultipleAuth } from "./auth.js"
import { S3Error } from "./errors.js"

/** minio-go's `s3utils.CheckValidBucketNameStrict`, which MinIO applies to every request. */
export const isValidBucketNameStrict = (name: string) =>
  name.trim() !== "" &&
  name.length >= 3 &&
  name.length <= 63 &&
  !/^(\d+\.){3}\d+$/.test(name) &&
  !name.includes("..") &&
  !name.includes(".-") &&
  !name.includes("-.") &&
  /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(name)

/** Go's `unicode.IsSpace` over one byte. */
const isSpace = (char: string) => /^[\t\n\v\f\r \u0085 ]$/.test(char)

/** MinIO's `hasBadPathComponent`: longer than 32 KiB, or a `.` / `..` segment (space-trimmed). */
export const hasBadPathComponent = (path: string) => {
  if (path.length > 32 << 10) return true
  for (const segment of path.split(/[/\\]/)) {
    let start = 0
    let end = segment.length
    while (start < end && isSpace(segment.charAt(start))) start++
    while (end > start && isSpace(segment.charAt(end - 1))) end--
    const trimmed = segment.slice(start, end)
    if (trimmed === "." || trimmed === "..") return true
  }
  return false
}

const MAX_HEADER_SIZE = 8 * 1024
const MAX_USER_DATA_SIZE = 2 * 1024
const USER_METADATA_PREFIXES = ["x-amz-meta-", "x-minio-meta-"]
/** Internal headers a replicating MinIO may send (`validSSEReplicationHeaders`). */
const REPLICATION_HEADERS = new Set([
  "x-minio-internal-server-side-encryption-sealed-key",
  "x-minio-internal-server-side-encryption-seal-algorithm",
  "x-minio-internal-server-side-encryption-iv",
  "x-minio-internal-encrypted-multipart",
  "x-minio-internal-actual-object-size",
])
const SSE_C_HEADERS = [
  "x-amz-server-side-encryption-customer-algorithm",
  "x-amz-server-side-encryption-customer-key",
  "x-amz-server-side-encryption-customer-key-md5",
  "x-amz-copy-source-server-side-encryption-customer-algorithm",
  "x-amz-copy-source-server-side-encryption-customer-key",
  "x-amz-copy-source-server-side-encryption-customer-key-md5",
]

/** `containsReservedMetadata`: an `X-Minio-Internal-*` header, unless a replication one is sent. */
const containsReservedMetadata = (headers: Headers) => {
  let reserved = false
  for (const [name] of headers) {
    if (REPLICATION_HEADERS.has(name)) return false
    if (name.startsWith("x-minio-internal-")) reserved = true
  }
  return reserved
}

/** `isHTTPHeaderSizeTooLarge`: every header but Host over 8 KiB, or user metadata over 2 KiB. */
const isHeaderSizeTooLarge = (headers: Headers, ignore: readonly string[]) => {
  let size = 0
  let user = 0
  for (const [name, value] of headers) {
    if (name === "host" || ignore.includes(name)) continue
    const length = name.length + value.length
    size += length
    if (USER_METADATA_PREFIXES.some((prefix) => name.startsWith(prefix))) user += length
  }
  return user > MAX_USER_DATA_SIZE || size > MAX_HEADER_SIZE
}

export type Rejection = {
  error: S3Error
  /** MinIO writes these as an XML body even for HEAD, except SSE-C (headers only). */
  headersOnly: boolean
}

/**
 * Why MinIO's middlewares reject this (routed) request, if they do. `path` is the decoded URL
 * path and `bucket` its first segment.
 */
export const requestRejection = (input: {
  method: string
  path: string
  bucket: string
  query: URLSearchParams
  headers: Headers
  /** Headers the emulator itself adds, left out of the size limit. */
  ignoreHeaders?: readonly string[]
  /** Served over TLS (MinIO's `globalIsTLS`): SSE-C headers are then allowed through. */
  secure?: boolean
}): Rejection | undefined => {
  const { method, path, bucket, query, headers } = input
  const reject = (error: S3Error, headersOnly = false): Rejection => ({ error, headersOnly })
  // setRequestLimitMiddleware
  if (containsReservedMetadata(headers)) return reject(new S3Error("UnsupportedMetadata"))
  if (isHeaderSizeTooLarge(headers, input.ignoreHeaders ?? []))
    return reject(new S3Error("MetadataTooLarge"))
  // setRequestValidityMiddleware
  if (hasBadPathComponent(path)) return reject(new S3Error("InvalidResourceName"))
  for (const [name, value] of query)
    if (name !== "delimiter" && hasBadPathComponent(value))
      return reject(new S3Error("InvalidResourceName"))
  if (hasMultipleAuth(method, headers, query))
    return reject(
      new S3Error("InvalidRequest", {
        message: "Invalid Request (request has multiple authentication types, please use one)",
      }),
    )
  if (bucket === "minio" || bucket === ".minio.sys") {
    // `guessIsRPCReq`: GET/POST under `/minio/` is let through (to the handlers, here).
    const rpc = (method === "GET" || method === "POST") && path.startsWith("/minio/")
    if (!rpc) return reject(new S3Error("AllAccessDisabled"))
  } else if (bucket && !isValidBucketNameStrict(bucket))
    return reject(new S3Error("InvalidBucketName"))
  if (!input.secure && SSE_C_HEADERS.some((name) => headers.has(name)))
    return reject(new S3Error("InsecureSSECustomerRequest"), method === "HEAD")
  return undefined
}
