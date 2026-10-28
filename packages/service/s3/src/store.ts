/**
 * The object store over S3State: buckets, versions and their latest-version pointers, with the
 * versioning rules every write and delete shares (null versions, delete markers, head repair).
 */
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { fail } from "./errors.js"
import type { BucketRecord, ObjectVersion } from "./state.js"
import { S3State } from "./state.js"

export type S3Notification = {
  eventName:
    | "ObjectCreated:Put"
    | "ObjectCreated:Post"
    | "ObjectCreated:Copy"
    | "ObjectCreated:CompleteMultipartUpload"
    | "ObjectRemoved:Delete"
    | "ObjectRemoved:DeleteMarkerCreated"
  bucket: string
  key: string
  etag?: string
  size?: number
  versionId?: string
  occurredAt: string
}

export type CoreOptions = {
  sqlite: SqliteClient
  namespace: string
  now: () => number
  random: () => number
  region: string
  /** access key → secret key. */
  credentials: Readonly<Record<string, string>>
  /** `strict`: MinIO's auth exactly. `lenient`: unsigned requests act as the owner. */
  authentication: "strict" | "lenient"
  onNotification?: (event: S3Notification) => void
}

const HEX = "0123456789abcdef"

/** MinIO's `wildcard.MatchSimple` (`*` any run, `?` any byte or the end), over UTF-8 bytes. */
const matchSimple = (pattern: string, name: string): boolean => {
  if (pattern === "*") return true
  const p = new TextEncoder().encode(pattern)
  const n = new TextEncoder().encode(name)
  const deep = (s: number, q: number): boolean => {
    while (q < p.length) {
      const c = p[q]
      if (c === 42) return q === p.length - 1 || deep(s, q + 1) || (s < n.length && deep(s + 1, q))
      if (c === 63) {
        if (s >= n.length) return true
      } else if (s >= n.length || n[s] !== c) return false
      s++
      q++
    }
    return s >= n.length && q >= p.length
  }
  return deep(0, 0)
}

/**
 * Why Go's `uuid.Parse` rejects `value` (its error text), or `undefined` when it is a UUID.
 * Accepted spellings: 36 chars with dashes, 32 hex digits, `{...}` (38) or `urn:uuid:...` (45).
 */
export const uuidError = (value: string): string | undefined => {
  let body = value
  switch (value.length) {
    case 36:
      break
    case 45:
      if (value.slice(0, 9).toLowerCase() !== "urn:uuid:")
        return `invalid urn prefix: ${JSON.stringify(value.slice(0, 9))}`
      body = value.slice(9)
      break
    case 38:
      body = value.slice(1)
      break
    case 32:
      return /^[0-9a-fA-F]{32}$/.test(value) ? undefined : "invalid UUID format"
    default:
      return `invalid UUID length: ${new TextEncoder().encode(value).length}`
  }
  if ([8, 13, 18, 23].some((index) => body.charAt(index) !== "-")) return "invalid UUID format"
  return /^[0-9a-fA-F]{32}$/.test(uuidHex(body)) ? undefined : "invalid UUID format"
}
const uuidHex = (body: string) =>
  body.length === 32
    ? body
    : body.slice(0, 8) +
      body.slice(9, 13) +
      body.slice(14, 18) +
      body.slice(19, 23) +
      body.slice(24, 36)

/**
 * A request's version id as MinIO reads it (`uuid.Parse` after trimming): `""`, `"null"`, or
 * the canonical lowercase UUID it spells. `undefined` when it is not a version id at all
 * (MinIO's InvalidVersionID).
 */
export const parseVersionId = (raw: string): string | undefined => {
  const value = raw.trim()
  if (value === "" || value === "null") return value
  if (uuidError(value) !== undefined) return undefined
  const body = value.length === 45 ? value.slice(9) : value.length === 38 ? value.slice(1) : value
  const hex = uuidHex(body).toLowerCase()
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Shared state and rules; handlers reach it as `ctx.core`. */
export class S3Core {
  readonly state: S3State
  constructor(readonly options: CoreOptions) {
    this.state = new S3State(options.sqlite, options.namespace)
  }
  get region() {
    return this.options.region
  }
  now() {
    return this.options.now()
  }
  /** A random-looking hex string from the seeded stream. */
  randomHex(length: number) {
    let out = ""
    for (let index = 0; index < length; index++)
      out += HEX.charAt(Math.floor(this.options.random() * 16))
    return out
  }
  /** A UUID v4 from the seeded stream (MinIO's version id format). */
  uuid() {
    const raw = this.randomHex(32).split("")
    raw[12] = "4"
    raw[16] = HEX.charAt(8 + (Number.parseInt(raw[16] as string, 16) % 4))
    const value = raw.join("")
    return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
  }
  notify(event: Omit<S3Notification, "occurredAt">) {
    this.options.onNotification?.({ ...event, occurredAt: new Date(this.now()).toISOString() })
  }

  // ── buckets ──────────────────────────────────────────────────────────────
  bucket(name: string): BucketRecord | undefined {
    return this.state.buckets.get(name)
  }
  requireBucket(name: string): BucketRecord {
    const bucket = this.bucket(name)
    if (!bucket) fail("NoSuchBucket")
    return bucket as BucketRecord
  }
  saveBucket(name: string, record: BucketRecord) {
    if (this.state.buckets.has(name)) this.state.buckets.update(name, record)
    else this.state.buckets.insert(name, record)
  }
  config(bucket: string, kind: string): string | undefined {
    return this.state.configurations.get(this.state.configId(bucket, kind))?.body
  }
  setConfig(bucket: string, kind: string, body: string | undefined) {
    const id = this.state.configId(bucket, kind)
    if (body === undefined) this.state.configurations.delete(id)
    else this.state.configurations.insert(id, { bucket, kind, body })
  }
  /** Remove a bucket and everything it holds. */
  dropBucket(name: string) {
    for (const row of this.state.versions.list({ where: (value) => value.bucket === name })) {
      this.state.blobs.release(row.value.blob)
      this.state.versions.delete(row.id)
    }
    for (const row of this.state.heads.list({ where: (value) => value.bucket === name }))
      this.state.heads.delete(row.id)
    for (const row of this.state.configurations.list({ where: (value) => value.bucket === name }))
      this.state.configurations.delete(row.id)
    for (const row of this.state.uploads.list({ where: (value) => value.bucket === name })) {
      for (const part of this.state.parts.list({ where: (value) => value.uploadId === row.id })) {
        this.state.blobs.release(part.value.blob)
        this.state.parts.delete(part.id)
      }
      this.state.uploads.delete(row.id)
    }
    this.state.buckets.delete(name)
  }

  // ── versions ─────────────────────────────────────────────────────────────
  /** The latest version of a key (possibly a delete marker). */
  head(bucket: string, key: string): ObjectVersion | undefined {
    const pointer = this.state.heads.get(this.state.headId(bucket, key))
    return pointer ? this.version(bucket, key, pointer.versionId) : undefined
  }
  version(bucket: string, key: string, versionId: string): ObjectVersion | undefined {
    return this.state.versions.get(this.state.versionId(bucket, key, versionId))
  }
  /** Every version of a key, newest first. */
  versionsOf(bucket: string, key: string) {
    return this.state.versions
      .list({ where: (value) => value.bucket === bucket && value.key === key, order: "newest" })
      .map(({ value }) => value)
  }
  bytes(version: ObjectVersion): Uint8Array<ArrayBuffer> {
    return this.state.blobs.get(version.blob)
  }
  private setHead(bucket: string, key: string) {
    const latest = this.versionsOf(bucket, key)[0]
    const id = this.state.headId(bucket, key)
    if (latest) this.state.heads.insert(id, { bucket, key, versionId: latest.versionId })
    else this.state.heads.delete(id)
  }
  /**
   * MinIO's `PrefixEnabled`: versioning is Enabled and `key` matches none of the bucket's
   * excluded prefixes (nor, with ExcludeFolders, ends in `/`).
   */
  versioned(bucket: string, key = ""): boolean {
    const record = this.bucket(bucket)
    if (record?.versioning !== "Enabled") return false
    if (key === "") return true
    if (record.versioningExcludeFolders && key.endsWith("/")) return false
    return !(record.versioningExcludedPrefixes ?? []).some((prefix) =>
      matchSimple(`${prefix}*`, key),
    )
  }
  /** Versioning is Suspended at the bucket level. */
  suspended(bucket: string): boolean {
    return this.bucket(bucket)?.versioning === "Suspended"
  }
  /** The id a new write of `key` gets: a fresh UUID when versioning applies, else `"null"`. */
  nextVersionId(bucket: string, key = "") {
    // MinIO's putOpts: directory objects (`a/`) never get a new version.
    return this.versioned(bucket, key) && !key.endsWith("/") ? this.uuid() : "null"
  }
  /**
   * DeleteObject's versioning rules (MinIO's `erasureServerPools.DeleteObject`): with a version
   * id, remove exactly that version; without one, a latest delete marker is returned as is, a
   * versioned key gets a new delete marker, a suspended bucket a `null` delete marker (replacing
   * the null version), and anything else loses its `null` version. A key with no versions at all
   * is left alone (`undefined`). The result is the removed version or the marker written/found.
   */
  deleteObject(
    bucket: string,
    key: string,
    versionId: string,
    now: number,
  ): { version: ObjectVersion; marker: boolean } | undefined {
    if (versionId) {
      const removed = this.removeVersion(bucket, key, versionId)
      return removed ? { version: removed, marker: !!removed.deleteMarker } : undefined
    }
    const latest = this.head(bucket, key)
    if (!latest) return undefined
    if (latest.deleteMarker) return { version: latest, marker: true }
    if (!this.versioned(bucket, key) && !this.suspended(bucket)) {
      const removed = this.removeVersion(bucket, key, "null")
      return removed ? { version: removed, marker: false } : undefined
    }
    const marker = this.write(
      {
        bucket,
        key,
        versionId: this.versioned(bucket, key) ? this.uuid() : "null",
        deleteMarker: true,
        etag: "",
        lastModified: now,
        metadata: {},
      },
      new Uint8Array(),
    )
    return { version: marker, marker: true }
  }
  /**
   * Store a new version as the latest. In an unversioned or suspended bucket it replaces the
   * `null` version; in a versioned bucket it is added with a fresh id.
   */
  write(
    input: Omit<ObjectVersion, "versionId" | "blob" | "size"> & { versionId?: string },
    bytes: Uint8Array,
  ): ObjectVersion {
    const versionId = input.versionId ?? this.nextVersionId(input.bucket, input.key)
    const id = this.state.versionId(input.bucket, input.key, versionId)
    const prior = this.state.versions.get(id)
    if (prior) this.state.blobs.release(prior.blob)
    const record: ObjectVersion = this.withDefaultRetention({
      ...input,
      versionId,
      size: bytes.length,
      ...(input.deleteMarker ? {} : { blob: this.state.blobs.put(bytes) }),
    })
    if (prior) this.state.versions.delete(id)
    this.state.versions.insert(id, record)
    this.setHead(input.bucket, input.key)
    return record
  }
  /** Store a version that shares an existing blob (copies keep one copy of the bytes). */
  writeShared(input: Omit<ObjectVersion, "versionId"> & { versionId?: string }): ObjectVersion {
    this.state.blobs.retain(input.blob)
    const versionId = input.versionId ?? this.nextVersionId(input.bucket, input.key)
    const id = this.state.versionId(input.bucket, input.key, versionId)
    const prior = this.state.versions.get(id)
    if (prior) {
      this.state.blobs.release(prior.blob)
      this.state.versions.delete(id)
    }
    const record: ObjectVersion = this.withDefaultRetention({ ...input, versionId })
    this.state.versions.insert(id, record)
    this.setHead(input.bucket, input.key)
    return record
  }
  /**
   * MinIO's `checkPutObjectLockAllowed` default: in an object-lock bucket with a default
   * retention rule, a new version written without its own retention or legal hold is retained
   * until now + the rule's period.
   */
  private withDefaultRetention(record: ObjectVersion): ObjectVersion {
    if (record.deleteMarker || record.retention || record.legalHold) return record
    const bucket = this.bucket(record.bucket)
    const rule = bucket?.objectLock ? bucket.defaultRetention : undefined
    if (!rule) return record
    const until = new Date(this.now())
    if (rule.days !== undefined) until.setUTCDate(until.getUTCDate() + rule.days)
    else until.setUTCFullYear(until.getUTCFullYear() + (rule.years ?? 0))
    return { ...record, retention: { mode: rule.mode, until: until.toISOString() } }
  }
  /** Change a stored version in place (tags, retention, legal hold) without reordering it. */
  update(version: ObjectVersion) {
    this.state.versions.update(
      this.state.versionId(version.bucket, version.key, version.versionId),
      version,
    )
  }
  /** Permanently delete one version and repoint the key's head. */
  removeVersion(bucket: string, key: string, versionId: string): ObjectVersion | undefined {
    const id = this.state.versionId(bucket, key, versionId)
    const prior = this.state.versions.get(id)
    if (!prior) return undefined
    this.state.blobs.release(prior.blob)
    this.state.versions.delete(id)
    this.setHead(bucket, key)
    return prior
  }
  /** The current object of every key in a bucket (delete markers excluded). */
  currentObjects(bucket: string): ObjectVersion[] {
    const out: ObjectVersion[] = []
    for (const { value } of this.state.heads.list({ where: (head) => head.bucket === bucket })) {
      const version = this.version(bucket, value.key, value.versionId)
      if (version && !version.deleteMarker) out.push(version)
    }
    return out
  }
  /** Every version in a bucket, newest first. */
  allVersions(bucket: string): ObjectVersion[] {
    return this.state.versions
      .list({ where: (value) => value.bucket === bucket, order: "newest" })
      .map(({ value }) => value)
  }
  isLatest(version: ObjectVersion) {
    return (
      this.state.heads.get(this.state.headId(version.bucket, version.key))?.versionId ===
      version.versionId
    )
  }
  /** No versions at all. Pending multipart uploads do not count: MinIO deletes them with the bucket. */
  bucketIsEmpty(bucket: string) {
    return !this.state.versions.list({ where: (value) => value.bucket === bucket }).length
  }
}
