import { Collection, IdSequence } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"

export type VersioningStatus = "Enabled" | "Suspended"

export type BucketRecord = {
  createdAt: number
  versioning?: VersioningStatus
  /** Created with `x-amz-bucket-object-lock-enabled: true`. */
  objectLock?: boolean
  /** MinIO's versioning extension: prefixes (wildcard patterns) that stay unversioned. */
  versioningExcludedPrefixes?: string[]
  /** MinIO's versioning extension: keys ending in `/` stay unversioned. */
  versioningExcludeFolders?: boolean
  /** The object-lock configuration's default retention, applied to new versions. */
  defaultRetention?: { mode: "GOVERNANCE" | "COMPLIANCE"; days?: number; years?: number }
}

export type ChecksumAlgorithmName = "CRC32" | "CRC32C" | "CRC64NVME" | "SHA1" | "SHA256"
export type StoredChecksum = {
  algorithm: ChecksumAlgorithmName
  /** base64 digest, with `-<parts>` for a composite multipart checksum. */
  value: string
  type: "FULL_OBJECT" | "COMPOSITE"
}

export type PartInfo = {
  number: number
  size: number
  /** Unquoted. */
  etag: string
  checksum?: string
}

/** One version of an object (or a delete marker). The unversioned object is version `"null"`. */
export type ObjectVersion = {
  bucket: string
  key: string
  versionId: string
  deleteMarker?: boolean
  /** Blob id of the bytes; absent for delete markers. */
  blob?: string
  size: number
  /** Unquoted ETag (`<md5 hex>` or `<md5 hex>-<parts>`); "" for delete markers. */
  etag: string
  lastModified: number
  contentType?: string
  contentEncoding?: string
  contentDisposition?: string
  contentLanguage?: string
  cacheControl?: string
  /** The `Expires` header as sent. */
  expires?: string
  websiteRedirect?: string
  /** User metadata, names lowercased without the `x-amz-meta-` prefix. */
  metadata: Record<string, string>
  /** URL-encoded tag set (`a=1&b=2`), as S3 stores `x-amz-tagging`. */
  tagging?: string
  storageClass?: string
  checksum?: StoredChecksum
  /** Present when the object was assembled by CompleteMultipartUpload. */
  parts?: PartInfo[]
  retention?: { mode: "GOVERNANCE" | "COMPLIANCE"; until: string }
  legalHold?: "ON" | "OFF"
  /** Server-side encryption the object was written with. */
  sse?: { algorithm: "AES256" | "aws:kms"; kmsKeyId?: string; bucketKey?: boolean }
  /** Any other stored headers to replay verbatim (lowercased name → value). */
  extra?: Record<string, string>
}

/** The object fields a multipart upload carries until completion. */
export type MultipartUpload = Omit<
  ObjectVersion,
  "versionId" | "blob" | "size" | "etag" | "lastModified" | "deleteMarker" | "parts" | "checksum"
> & {
  id: string
  initiated: number
  checksumAlgorithm?: ChecksumAlgorithmName
  checksumType?: "FULL_OBJECT" | "COMPOSITE"
}

export type MultipartPart = {
  uploadId: string
  partNumber: number
  blob: string
  size: number
  /** Unquoted. */
  etag: string
  lastModified: number
  checksums?: Partial<Record<ChecksumAlgorithmName, string>>
}

const CHUNK = 0x8000
const encodeBytes = (bytes: Uint8Array) => {
  const pieces: string[] = []
  for (let offset = 0; offset < bytes.length; offset += CHUNK)
    pieces.push(String.fromCharCode(...bytes.subarray(offset, offset + CHUNK)))
  return btoa(pieces.join(""))
}
const decodeBytes = (stored: string) => {
  const binary = atob(stored)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/** Object bytes, base64 in a row, written once and shared by every version that points at them. */
export class BlobStore {
  private readonly inner: Collection<{ data: string; refs: number }>
  constructor(
    sqlite: SqliteClient,
    namespace: string,
    private readonly ids: IdSequence,
  ) {
    this.inner = new Collection(sqlite, namespace, "s3_blobs")
  }
  put(bytes: Uint8Array): string {
    const id = this.ids.next("blob-", 16)
    this.inner.insert(id, { data: encodeBytes(bytes), refs: 1 })
    return id
  }
  get(id: string | undefined): Uint8Array<ArrayBuffer> {
    if (!id) return new Uint8Array()
    const row = this.inner.get(id)
    return row ? decodeBytes(row.data) : new Uint8Array()
  }
  retain(id: string | undefined) {
    if (!id) return
    const row = this.inner.get(id)
    if (row) this.inner.update(id, { ...row, refs: row.refs + 1 })
  }
  release(id: string | undefined) {
    if (!id) return
    const row = this.inner.get(id)
    if (!row) return
    if (row.refs <= 1) this.inner.delete(id)
    else this.inner.update(id, { ...row, refs: row.refs - 1 })
  }
}

export class S3State {
  readonly buckets: Collection<BucketRecord>
  /** Every version, keyed `[bucket, key, versionId]`. Sequence order is write order. */
  readonly versions: Collection<ObjectVersion>
  /** The latest version of each key, keyed `[bucket, key]`. */
  readonly heads: Collection<{ bucket: string; key: string; versionId: string }>
  /** Bucket sub-resources (policy, lifecycle, tagging, ...), keyed `[bucket, kind]`. */
  readonly configurations: Collection<{ bucket: string; kind: string; body: string }>
  readonly uploads: Collection<MultipartUpload>
  readonly parts: Collection<MultipartPart>
  readonly blobs: BlobStore
  readonly ids: IdSequence
  constructor(sqlite: SqliteClient, namespace: string) {
    this.ids = new IdSequence(sqlite, namespace, "s3")
    this.buckets = new Collection(sqlite, namespace, "s3_buckets")
    this.versions = new Collection(sqlite, namespace, "s3_versions")
    this.heads = new Collection(sqlite, namespace, "s3_heads")
    this.configurations = new Collection(sqlite, namespace, "s3_configurations")
    this.uploads = new Collection(sqlite, namespace, "s3_uploads")
    this.parts = new Collection(sqlite, namespace, "s3_parts")
    this.blobs = new BlobStore(sqlite, namespace, this.ids)
  }
  versionId(bucket: string, key: string, versionId: string) {
    return JSON.stringify([bucket, key, versionId])
  }
  headId(bucket: string, key: string) {
    return JSON.stringify([bucket, key])
  }
  configId(bucket: string, kind: string) {
    return JSON.stringify([bucket, kind])
  }
  partId(uploadId: string, partNumber: number) {
    return `${uploadId}:${partNumber}`
  }
}
