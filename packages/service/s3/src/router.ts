/**
 * Request → operation, in the exact precedence of MinIO's `cmd/api-router.go`: object routes
 * first (most specific query first), then bucket routes, then the root. A route matches when its
 * method matches and every listed query parameter is present (a fixed value must also match).
 */
export type Operation =
  // object
  | "HeadObject"
  | "GetObjectAttributes"
  | "UploadPartCopy"
  | "UploadPart"
  | "ListParts"
  | "CompleteMultipartUpload"
  | "CreateMultipartUpload"
  | "AbortMultipartUpload"
  | "GetObjectAcl"
  | "PutObjectAcl"
  | "GetObjectTagging"
  | "PutObjectTagging"
  | "DeleteObjectTagging"
  | "SelectObjectContent"
  | "GetObjectRetention"
  | "GetObjectLegalHold"
  | "GetObjectLambda"
  | "GetObject"
  | "CopyObject"
  | "PutObjectRetention"
  | "PutObjectLegalHold"
  | "PutObjectExtract"
  | "AppendObject"
  | "PutObject"
  | "DeleteObject"
  | "RestoreObject"
  // bucket
  | "GetBucketLocation"
  | "GetBucketPolicy"
  | "GetBucketLifecycle"
  | "GetBucketEncryption"
  | "GetObjectLockConfiguration"
  | "GetBucketReplication"
  | "GetBucketVersioning"
  | "GetBucketNotification"
  | "ListenNotification"
  | "ResetBucketReplicationStatus"
  | "GetBucketAcl"
  | "PutBucketAcl"
  | "GetBucketCors"
  | "PutBucketCors"
  | "DeleteBucketCors"
  | "GetBucketWebsite"
  | "GetBucketAccelerate"
  | "GetBucketRequestPayment"
  | "GetBucketLogging"
  | "GetBucketTagging"
  | "DeleteBucketWebsite"
  | "DeleteBucketTagging"
  | "ListMultipartUploads"
  | "ListObjectsV2M"
  | "ListObjectsV2"
  | "ListObjectVersionsM"
  | "ListObjectVersions"
  | "GetBucketPolicyStatus"
  | "PutBucketLifecycle"
  | "PutBucketReplication"
  | "PutBucketEncryption"
  | "PutBucketPolicy"
  | "PutObjectLockConfiguration"
  | "PutBucketTagging"
  | "PutBucketVersioning"
  | "PutBucketNotification"
  | "ResetBucketReplicationStart"
  | "CreateBucket"
  | "HeadBucket"
  | "PostObject"
  | "DeleteObjects"
  | "DeleteBucketPolicy"
  | "DeleteBucketReplication"
  | "DeleteBucketLifecycle"
  | "DeleteBucketEncryption"
  | "DeleteBucket"
  | "GetBucketReplicationMetricsV2"
  | "GetBucketReplicationMetrics"
  | "ValidateBucketReplicationCreds"
  | "ListObjectsV1"
  // root
  | "ListBuckets"
  // fallbacks
  | "NotImplemented"
  | "Unsupported"

type Route = {
  op: Operation
  methods: readonly string[]
  /** `[name, value]` pairs; `undefined` value means "present with any value". */
  query?: readonly (readonly [string, string | undefined])[]
  /** The copy-source header must name `bucket/key`. */
  copySource?: boolean
  /**
   * A header that must be present. With a value, `mux.HeadersRegexp`: the value is an unanchored
   * pattern (`true` matches `untrue`); `type/subtype*` instead compares a parsed media type.
   */
  header?: readonly [string, string | undefined]
}

const q = (...names: string[]) => names.map((name) => [name, undefined] as const)
const r = (
  op: Operation,
  methods: string | readonly string[],
  extra: Omit<Route, "op" | "methods"> = {},
): Route => ({ op, methods: typeof methods === "string" ? [methods] : methods, ...extra })

const REJECTED_OBJECT: Route[] = [
  r("NotImplemented", ["PUT", "DELETE", "GET"], { query: q("torrent") }),
  r("NotImplemented", "DELETE", { query: q("acl") }),
]

const OBJECT_ROUTES: Route[] = [
  ...REJECTED_OBJECT,
  r("HeadObject", "HEAD"),
  r("GetObjectAttributes", "GET", { query: q("attributes") }),
  r("UploadPartCopy", "PUT", { copySource: true, query: q("partNumber", "uploadId") }),
  r("UploadPart", "PUT", { query: q("partNumber", "uploadId") }),
  r("ListParts", "GET", { query: q("uploadId") }),
  r("CompleteMultipartUpload", "POST", { query: q("uploadId") }),
  r("CreateMultipartUpload", "POST", { query: q("uploads") }),
  r("AbortMultipartUpload", "DELETE", { query: q("uploadId") }),
  r("GetObjectAcl", "GET", { query: q("acl") }),
  r("PutObjectAcl", "PUT", { query: q("acl") }),
  r("GetObjectTagging", "GET", { query: q("tagging") }),
  r("PutObjectTagging", "PUT", { query: q("tagging") }),
  r("DeleteObjectTagging", "DELETE", { query: q("tagging") }),
  r("SelectObjectContent", "POST", {
    query: [
      ["select", undefined],
      ["select-type", "2"],
    ],
  }),
  r("GetObjectRetention", "GET", { query: q("retention") }),
  r("GetObjectLegalHold", "GET", { query: q("legal-hold") }),
  r("GetObjectLambda", "GET", { query: q("lambdaArn") }),
  r("GetObject", "GET"),
  r("CopyObject", "PUT", { copySource: true }),
  r("PutObjectRetention", "PUT", { query: q("retention") }),
  r("PutObjectLegalHold", "PUT", { query: q("legal-hold") }),
  r("PutObjectExtract", "PUT", { header: ["x-amz-meta-snowball-auto-extract", "true"] }),
  r("AppendObject", "PUT", { header: ["x-amz-write-offset-bytes", undefined] }),
  r("PutObject", "PUT"),
  r("DeleteObject", "DELETE"),
  r("RestoreObject", "POST", { query: q("restore") }),
]

const REJECTED_BUCKET: Route[] = [
  r("NotImplemented", ["GET", "PUT", "DELETE"], { query: q("inventory") }),
  r("NotImplemented", ["PUT", "DELETE"], { query: q("cors") }),
  r("NotImplemented", ["GET", "PUT", "DELETE"], { query: q("metrics") }),
  r("NotImplemented", "PUT", { query: q("website") }),
  r("NotImplemented", ["PUT", "DELETE"], { query: q("logging") }),
  r("NotImplemented", ["PUT", "DELETE"], { query: q("accelerate") }),
  r("NotImplemented", ["PUT", "DELETE"], { query: q("requestPayment") }),
  r("NotImplemented", ["DELETE", "PUT", "HEAD"], { query: q("acl") }),
  r("NotImplemented", ["DELETE", "PUT", "GET"], { query: q("publicAccessBlock") }),
  r("NotImplemented", ["DELETE", "PUT", "GET"], { query: q("ownershipControls") }),
  r("NotImplemented", ["DELETE", "PUT", "GET"], { query: q("intelligent-tiering") }),
  r("NotImplemented", ["DELETE", "PUT", "GET"], { query: q("analytics") }),
]

const BUCKET_ROUTES: Route[] = [
  r("GetBucketLocation", "GET", { query: q("location") }),
  r("GetBucketPolicy", "GET", { query: q("policy") }),
  r("GetBucketLifecycle", "GET", { query: q("lifecycle") }),
  r("GetBucketEncryption", "GET", { query: q("encryption") }),
  r("GetObjectLockConfiguration", "GET", { query: q("object-lock") }),
  r("GetBucketReplication", "GET", { query: q("replication") }),
  r("GetBucketVersioning", "GET", { query: q("versioning") }),
  r("GetBucketNotification", "GET", { query: q("notification") }),
  r("ListenNotification", "GET", { query: q("events") }),
  r("ResetBucketReplicationStatus", "GET", { query: q("replication-reset-status") }),
  r("GetBucketAcl", "GET", { query: q("acl") }),
  r("PutBucketAcl", "PUT", { query: q("acl") }),
  r("GetBucketCors", "GET", { query: q("cors") }),
  r("PutBucketCors", "PUT", { query: q("cors") }),
  r("DeleteBucketCors", "DELETE", { query: q("cors") }),
  r("GetBucketWebsite", "GET", { query: q("website") }),
  r("GetBucketAccelerate", "GET", { query: q("accelerate") }),
  r("GetBucketRequestPayment", "GET", { query: q("requestPayment") }),
  r("GetBucketLogging", "GET", { query: q("logging") }),
  r("GetBucketTagging", "GET", { query: q("tagging") }),
  r("DeleteBucketWebsite", "DELETE", { query: q("website") }),
  r("DeleteBucketTagging", "DELETE", { query: q("tagging") }),
  r("ListMultipartUploads", "GET", { query: q("uploads") }),
  r("ListObjectsV2M", "GET", {
    query: [
      ["list-type", "2"],
      ["metadata", "true"],
    ],
  }),
  r("ListObjectsV2", "GET", { query: [["list-type", "2"]] }),
  r("ListObjectVersionsM", "GET", {
    query: [
      ["versions", undefined],
      ["metadata", "true"],
    ],
  }),
  r("ListObjectVersions", "GET", { query: q("versions") }),
  r("GetBucketPolicyStatus", "GET", { query: q("policyStatus") }),
  r("PutBucketLifecycle", "PUT", { query: q("lifecycle") }),
  r("PutBucketReplication", "PUT", { query: q("replication") }),
  r("PutBucketEncryption", "PUT", { query: q("encryption") }),
  r("PutBucketPolicy", "PUT", { query: q("policy") }),
  r("PutObjectLockConfiguration", "PUT", { query: q("object-lock") }),
  r("PutBucketTagging", "PUT", { query: q("tagging") }),
  r("PutBucketVersioning", "PUT", { query: q("versioning") }),
  r("PutBucketNotification", "PUT", { query: q("notification") }),
  r("ResetBucketReplicationStart", "PUT", { query: q("replication-reset") }),
  r("CreateBucket", "PUT"),
  r("HeadBucket", "HEAD"),
  r("PostObject", "POST", { header: ["content-type", "multipart/form-data*"] }),
  r("DeleteObjects", "POST", { query: q("delete") }),
  r("DeleteBucketPolicy", "DELETE", { query: q("policy") }),
  r("DeleteBucketReplication", "DELETE", { query: q("replication") }),
  r("DeleteBucketLifecycle", "DELETE", { query: q("lifecycle") }),
  r("DeleteBucketEncryption", "DELETE", { query: q("encryption") }),
  r("DeleteBucket", "DELETE"),
  r("GetBucketReplicationMetricsV2", "GET", { query: [["replication-metrics", "2"]] }),
  r("GetBucketReplicationMetrics", "GET", { query: q("replication-metrics") }),
  r("ValidateBucketReplicationCreds", "GET", { query: q("replication-check") }),
  ...REJECTED_BUCKET,
  r("ListObjectsV1", "GET"),
]

const ROOT_ROUTES: Route[] = [
  r("ListenNotification", "GET", { query: q("events") }),
  r("ListBuckets", "GET"),
]

const matches = (route: Route, method: string, query: URLSearchParams, headers: Headers) => {
  if (!route.methods.includes(method)) return false
  for (const [name, value] of route.query ?? []) {
    if (!query.has(name)) return false
    if (value !== undefined && query.get(name) !== value) return false
  }
  // `HeadersRegexp(X-Amz-Copy-Source, ".*?(\/|%2F).*?")`: case-sensitive, so `%2f` does not count.
  if (route.copySource && !/\/|%2F/.test(headers.get("x-amz-copy-source") ?? "")) return false
  if (route.header) {
    const [name, value] = route.header
    const actual = headers.get(name)
    if (actual === null) return false
    // `type/subtype*`: the media type, parameters stripped, case-insensitive.
    if (value?.endsWith("*")) {
      if (actual.split(";")[0]?.trim().toLowerCase() !== value.slice(0, -1)) return false
    } else if (value !== undefined && !actual.includes(value)) return false
  }
  return true
}

/** The operation MinIO's router would dispatch this request to. */
export const route = (
  method: string,
  bucket: string,
  key: string,
  query: URLSearchParams,
  headers: Headers,
): Operation => {
  const table = !bucket ? ROOT_ROUTES : key ? OBJECT_ROUTES : BUCKET_ROUTES
  for (const entry of table) if (matches(entry, method, query, headers)) return entry.op
  // MinIO's PostPolicy route has no path template, so a form POST to `/bucket/key` reaches it too
  // (and PostObject answers MethodNotAllowed).
  const postPolicy = BUCKET_ROUTES.find((entry) => entry.op === "PostObject")
  if (key && postPolicy && matches(postPolicy, method, query, headers)) return "PostObject"
  return "Unsupported"
}
