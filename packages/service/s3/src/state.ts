import { Collection, IdSequence } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"

export type S3Object = {
  bucket: string
  key: string
  bytes: Uint8Array
  etag: string
  lastModified: number
  contentType?: string
  cacheControl?: string
  contentDisposition?: string
  versionId?: string
  deleteMarker?: boolean
  storageClass?: string
  tags?: Record<string, string>
  checksums?: Record<string, string>
  metadata: Record<string, string>
}
export type MultipartUpload = {
  id: string
  bucket: string
  key: string
  initiated: number
  metadata?: Record<string, string>
  contentType?: string
  cacheControl?: string
  contentDisposition?: string
}
export type MultipartPart = {
  uploadId: string
  partNumber: number
  bytes: Uint8Array
  etag: string
}
export type S3SeedObject = Omit<S3Object, "etag" | "lastModified" | "bytes"> & {
  body: Uint8Array | string
  etag?: string
  lastModified?: number
}
const CHUNK = 0x8000
const encodeBytes = (bytes: Uint8Array) => {
  const pieces: string[] = []
  for (let offset = 0; offset < bytes.length; offset += CHUNK)
    pieces.push(String.fromCharCode(...bytes.subarray(offset, offset + CHUNK)))
  return btoa(pieces.join(""))
}
const decodeBytes = (stored: string | number[]) => {
  // Rows written before bytes were base64 held a JSON array of numbers.
  if (typeof stored !== "string") return Uint8Array.from(stored)
  const binary = atob(stored)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}
type Encoded<T extends { bytes: Uint8Array }> = Omit<T, "bytes"> & { bytes: string | number[] }
/**
 * Records with a `bytes` body, kept as base64 so a large object is a string in the row instead of
 * one JSON number per byte. Filters see the record without its body, which is only decoded for
 * the records that pass.
 */
class BlobCollection<T extends { bytes: Uint8Array }> {
  private readonly inner: Collection<Encoded<T>>
  constructor(sqlite: SqliteClient, namespace: string, name: string) {
    this.inner = new Collection(sqlite, namespace, name)
  }
  private decode(value: Encoded<T>) {
    return { ...value, bytes: decodeBytes(value.bytes) } as unknown as T
  }
  get(id: string): T | undefined {
    const value = this.inner.get(id)
    return value && this.decode(value)
  }
  has(id: string) {
    return this.inner.has(id)
  }
  insert(id: string, value: T) {
    this.inner.insert(id, { ...value, bytes: encodeBytes(value.bytes) } as Encoded<T>)
  }
  delete(id: string) {
    return this.inner.delete(id)
  }
  list(
    options: { where?: (value: Omit<T, "bytes">) => boolean; order?: "newest" | "oldest" } = {},
  ) {
    return this.inner
      .list({
        ...(options.order ? { order: options.order } : {}),
        ...(options.where ? { where: options.where } : {}),
      })
      .map((row) => ({ ...row, value: this.decode(row.value) }))
  }
}
export class S3State {
  readonly buckets: Collection<{ createdAt: number }>
  readonly objects: BlobCollection<S3Object>
  readonly versions: BlobCollection<S3Object>
  readonly configurations: Collection<{ body: string }>
  readonly uploads: Collection<MultipartUpload>
  readonly parts: BlobCollection<MultipartPart>
  readonly ids: IdSequence
  constructor(sqlite: SqliteClient, namespace: string) {
    this.buckets = new Collection(sqlite, namespace, "s3_buckets")
    this.objects = new BlobCollection(sqlite, namespace, "s3_objects")
    this.versions = new BlobCollection(sqlite, namespace, "s3_versions")
    this.configurations = new Collection(sqlite, namespace, "s3_configurations")
    this.uploads = new Collection(sqlite, namespace, "s3_uploads")
    this.parts = new BlobCollection(sqlite, namespace, "s3_parts")
    this.ids = new IdSequence(sqlite, namespace, "s3")
  }
  objectId(bucket: string, key: string) {
    return JSON.stringify([bucket, key])
  }
  object(bucket: string, key: string) {
    return this.objects.get(this.objectId(bucket, key))
  }
}
