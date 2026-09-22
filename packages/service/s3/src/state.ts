import { Collection, IdSequence } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"

export type S3Object = {
  bucket: string
  key: string
  bytes: number[]
  etag: string
  lastModified: number
  contentType?: string
  cacheControl?: string
  contentDisposition?: string
  metadata: Record<string, string>
}
export type MultipartUpload = { id: string; bucket: string; key: string; initiated: number }
export type MultipartPart = { uploadId: string; partNumber: number; bytes: number[]; etag: string }
export type S3SeedObject = Omit<S3Object, "etag" | "lastModified" | "bytes"> & {
  body: Uint8Array | string
  etag?: string
  lastModified?: number
}
export class S3State {
  readonly buckets: Collection<{ createdAt: number }>
  readonly objects: Collection<S3Object>
  readonly uploads: Collection<MultipartUpload>
  readonly parts: Collection<MultipartPart>
  readonly ids: IdSequence
  constructor(sqlite: SqliteClient, namespace: string) {
    this.buckets = new Collection(sqlite, namespace, "s3_buckets")
    this.objects = new Collection(sqlite, namespace, "s3_objects")
    this.uploads = new Collection(sqlite, namespace, "s3_uploads")
    this.parts = new Collection(sqlite, namespace, "s3_parts")
    this.ids = new IdSequence(sqlite, namespace, "s3")
  }
  objectId(bucket: string, key: string) {
    return JSON.stringify([bucket, key])
  }
  object(bucket: string, key: string) {
    return this.objects.get(this.objectId(bucket, key))
  }
}
