/**
 * Object listing: ListObjectsV1, ListObjectsV2 (and its `metadata=true` form) and
 * ListObjectVersions, as MinIO's single-drive erasure backend answers them.
 *
 * The engine reproduces MinIO's `listPath` → `fileInfos` pipeline rather than an idealized S3
 * listing, because clients see its quirks: the limit counts walk entries *before* delimiter
 * collapsing (so a page can hold fewer keys than `max-keys`), `IsTruncated` comes from the walk
 * having more entries, a non-`/` delimiter can return the same CommonPrefix page after page, a
 * `/` delimiter reports prefixes whose objects are all delete markers, `max-keys=0` never touches
 * the bucket (no NoSuchBucket), and markers carry MinIO's `[minio_cache:v2,...]` tag.
 */
import type { Ctx, Handler, Handlers } from "../context.js"
import { xmlResponse } from "../context.js"
import { fail } from "../errors.js"
import type { ObjectVersion } from "../state.js"
import { el, isoDate, wrap } from "../xml.js"
import { OWNER_ID, OWNER_NAME } from "./buckets.js"

const MAX_OBJECT_LIST = 1000

// ── strings, Go-style ────────────────────────────────────────────────────────

/** Go's string comparison: UTF-8 byte order, which is code point order. */
const compare = (a: string, b: string): number => {
  if (a === b) return 0
  const length = Math.min(a.length, b.length)
  for (let index = 0; index < length; index++) {
    const x = a.charCodeAt(index)
    const y = b.charCodeAt(index)
    if (x === y) continue
    // A surrogate (an astral code point) sorts above every BMP unit in UTF-8.
    const xs = x >= 0xd800 && x <= 0xdfff
    const ys = y >= 0xd800 && y <= 0xdfff
    if (xs !== ys) return xs ? 1 : -1
    return x < y ? -1 : 1
  }
  return a.length - b.length
}
const less = (a: string, b: string) => compare(a, b) < 0

/** Go's `encoding/xml` replaces characters outside XML's range with U+FFFD. */
const xmlSafe = (value: string) => {
  let out = ""
  for (const char of value) {
    const code = char.codePointAt(0) as number
    const allowed =
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0d ||
      (code >= 0x20 && code <= 0xd7ff) ||
      (code >= 0xe000 && code <= 0xfffd) ||
      code >= 0x10000
    out += allowed ? char : "\ufffd"
  }
  return out
}
const text = (name: string, value: string | undefined) =>
  value === undefined ? "" : el(name, xmlSafe(value))
const optional = (name: string, value: string) => (value === "" ? "" : text(name, value))

const encoder = new TextEncoder()
const HEX = "0123456789ABCDEF"
/** MinIO's `s3URLEncode`: `url.QueryEscape` keeping `/` and `*`, encoding `~`. */
const s3URLEncode = (value: string) => {
  let out = ""
  for (const byte of encoder.encode(value)) {
    const char = String.fromCharCode(byte)
    if (/[A-Za-z0-9\-_./*]/.test(char)) out += char
    else if (byte === 0x20) out += "+"
    else out += `%${HEX[byte >> 4]}${HEX[byte & 15]}`
  }
  return out
}
const encodeName = (name: string, encodingType: string) =>
  encodingType.toLowerCase() === "url" ? s3URLEncode(name) : name

/** Go's `strconv.Atoi` on a 64-bit int: the value, or `undefined` when it does not parse. */
const atoi = (value: string): bigint | undefined => {
  if (!/^[+-]?[0-9]+$/.test(value)) return undefined
  const parsed = BigInt(value)
  if (parsed > 9223372036854775807n || parsed < -9223372036854775808n) return undefined
  return parsed
}

/** Go's `base64.StdEncoding.DecodeString` (newlines skipped, padding required). */
const decodeBase64 = (value: string): string | undefined => {
  const clean = value.replace(/[\r\n]/g, "")
  if (
    clean.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(clean)
  )
    return undefined
  const binary = atob(clean)
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}
const encodeBase64 = (value: string) => {
  let binary = ""
  for (const byte of encoder.encode(value)) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** MinIO's `IsValidObjectPrefix` (bad path components are already rejected by the pipeline). */
const validPrefix = (prefix: string) => !prefix.includes("//") && !prefix.includes("\0")

/** Whether the raw (undecoded) query parameter decodes to valid UTF-8. */
const rawParamIsUtf8 = (url: URL, name: string) => {
  for (const pair of url.search.slice(1).split("&")) {
    const [rawName = "", rawValue = ""] = pair.split(/=(.*)/s)
    if (decodeQuery(rawName) !== name) continue
    const bytes = percentBytes(rawValue)
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    } catch {
      return false
    }
    return true
  }
  return true
}
const percentBytes = (raw: string) => {
  const out: number[] = []
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index] as string
    if (char === "%" && /^[0-9a-fA-F]{2}$/.test(raw.slice(index + 1, index + 3))) {
      out.push(Number.parseInt(raw.slice(index + 1, index + 3), 16))
      index += 2
    } else if (char === "+") out.push(0x20)
    else out.push(...encoder.encode(char))
  }
  return new Uint8Array(out)
}
const decodeQuery = (raw: string) => {
  try {
    return decodeURIComponent(raw.replace(/\+/g, " "))
  } catch {
    return raw
  }
}

// ── markers ──────────────────────────────────────────────────────────────────

const MARKER_TAG = "[minio_cache:v2"

/**
 * How MinIO serves a page, from the marker's tag: `plain` walks the drive (no tag), `create`
 * walks and saves a metacache (`return:`), `stream` reads a saved metacache (`id:<uuid>`).
 */
type MarkerMode = "plain" | "create" | "stream"

/** `listPathOptions.parseMarker`: the key part of a marker and the listing id it carries. */
const parseMarker = (ctx: Ctx, marker: string): { name: string; id: string; mode: MarkerMode } => {
  if (!marker.includes(MARKER_TAG)) return { name: marker, id: "", mode: "plain" }
  const start = marker.lastIndexOf("[")
  const end = marker.lastIndexOf("]")
  const name = marker.slice(0, start)
  let id = ""
  let mode: MarkerMode = "plain"
  const tag = end > start ? marker.slice(start, end).replace(/^[[\]]+|[[\]]+$/g, "") : ""
  for (const part of tag.split(",")) {
    const kv = part.split(":")
    if (kv.length < 2) continue
    const [field, value = ""] = kv
    if (field === "id") {
      id = value
      if (mode === "plain") mode = "stream"
    } else if (
      field === "return" ||
      ((field === "p" || field === "s") && !/^[+-]?\d+$/.test(value))
    ) {
      id = ctx.core.uuid()
      mode = "create"
    }
  }
  if (id === "") mode = "plain"
  // A listing id MinIO never handed out names no metacache: the page is walked afresh.
  const known = listingIds(ctx)
  if (mode === "create") known.add(id)
  else if (mode === "stream" && !known.has(id)) return { name, id: "", mode: "plain" }
  return { name, id, mode }
}

/** The metacache ids this store has handed out (MinIO keeps them per bucket, in memory). */
const issuedIds = new WeakMap<object, Set<string>>()
const listingIds = (ctx: Ctx) => {
  const ids = issuedIds.get(ctx.core) ?? new Set<string>()
  issuedIds.set(ctx.core, ids)
  return ids
}

/** `listPathOptions.encodeMarker`. */
const encodeMarker = (name: string, id: string) =>
  id === "" ? `${name}[minio_cache:v2,return:]` : `${name}[minio_cache:v2,id:${id},p:0,s:0]`

// ── the walk ─────────────────────────────────────────────────────────────────

/** A walk entry: an object (possibly a `dir/` object) or a directory MinIO walks through. */
type Entry = { name: string; dir: boolean; key?: string; deleted?: boolean }
type Item =
  | { kind: "prefix"; name: string }
  | { kind: "object"; name: string; version: ObjectVersion }

type ListOptions = {
  prefix: string
  /** The marker as sent (tag included). */
  marker: string
  delimiter: string
  maxKeys: number
  versions: boolean
}

type WalkResult = {
  entries: Entry[]
  more: boolean
  marker: string
  id: string
  /** The last entry the walk skipped before it had enough (`lastSkippedEntry`). */
  lastSkipped: string
}

/** Every key of a bucket that still has a version, with its latest version. */
const latestByKey = (ctx: Ctx) =>
  ctx.core.state.heads
    .list({ where: (head) => head.bucket === ctx.bucket })
    .map(({ value }) => ctx.core.version(ctx.bucket, value.key, value.versionId))
    .filter((version): version is ObjectVersion => version !== undefined)

/** `maxKeysPlusOne`. */
const walkLimit = (maxKeys: number, hasMarker: boolean) =>
  (maxKeys < 0 || maxKeys > MAX_OBJECT_LIST ? MAX_OBJECT_LIST : maxKeys) + (hasMarker ? 1 : 0)

/**
 * What MinIO's drive walk emits under a prefix, in its order. Recursive walks (no delimiter, or
 * any delimiter but `/`) emit every object plus each directory they descend into; a `/` walk
 * emits one level: the objects there and the directories below it.
 */
const walkEntries = (ctx: Ctx, prefix: string, recursive: boolean): Entry[] => {
  const byName = new Map<string, Entry>()
  const add = (entry: Entry) => byName.set(`${entry.dir ? "d" : "o"}${entry.name}`, entry)
  for (const latest of latestByKey(ctx)) {
    const key = latest.key
    if (!key.startsWith(prefix)) continue
    const object = { name: key, dir: false, key, deleted: latest.deleteMarker === true }
    if (recursive) {
      for (
        let index = key.indexOf("/");
        index >= 0 && index < key.length - 1;
        index = key.indexOf("/", index + 1)
      ) {
        const dir = key.slice(0, index + 1)
        if (dir.startsWith(prefix) && dir !== prefix) add({ name: dir, dir: true })
      }
      add(object)
      continue
    }
    const rest = key.slice(prefix.length)
    const slash = rest.indexOf("/")
    if (slash >= 0 && slash < rest.length - 1)
      add({ name: prefix + rest.slice(0, slash + 1), dir: true })
    else add(object)
  }
  return [...byName.values()].sort(
    (a, b) => compare(a.name, b.name) || (a.dir ? 1 : 0) - (b.dir ? 1 : 0),
  )
}

/**
 * `erasureServerPools.listPath` + `gatherResults`: the entries at or after the marker, at most
 * `limit` of them, and whether the listing goes on. `undefined` means it ends at once (io.EOF).
 */
const walk = (ctx: Ctx, options: ListOptions, limit: number): WalkResult | undefined => {
  const { prefix } = options
  let marker = options.marker
  if (less(marker, prefix)) marker = ""
  if (marker !== "" && prefix !== "" && !marker.startsWith(prefix)) return undefined
  if (limit === 0) return undefined
  if (prefix.startsWith("/")) return undefined
  const parsed = parseMarker(ctx, marker)
  ctx.core.requireBucket(ctx.bucket)
  const recursive = options.delimiter !== "/"
  const skip = (entry: Entry) =>
    (recursive && entry.dir) ||
    less(entry.name, parsed.name) ||
    (!options.versions && entry.deleted === true)
  const entries: Entry[] = []
  let lastSkipped = ""
  let more = false
  for (const entry of walkEntries(ctx, prefix, recursive)) {
    if (skip(entry)) {
      // Only a plain walk sees skipped entries; a metacache holds just the kept ones.
      if (parsed.mode === "plain" && entries.length < limit) lastSkipped = entry.name
      continue
    }
    if (entries.length >= limit) {
      more = true
      break
    }
    entries.push(entry)
  }
  // Reading a saved recursive metacache stops at the limit without peeking past it.
  if (parsed.mode === "stream" && recursive) more = entries.length >= limit
  return { entries, more, marker: parsed.name, id: parsed.id, lastSkipped }
}

/** `fileInfos` / `fileInfoVersions`: entries → items, collapsing on the delimiter. */
const toItems = (
  ctx: Ctx,
  entries: Entry[],
  options: ListOptions,
  versionMarker: string,
): Item[] => {
  const { prefix, delimiter } = options
  const items: Item[] = []
  let previous = ""
  let afterVersion = versionMarker
  for (const entry of entries) {
    if (delimiter !== "") {
      const index = entry.name.slice(prefix.length).indexOf(delimiter)
      if (index >= 0) {
        const name = entry.name.slice(0, prefix.length + index + delimiter.length)
        if (name === previous) continue
        previous = name
        items.push({ kind: "prefix", name })
        continue
      }
    }
    if (entry.dir || entry.key === undefined) continue
    if (!options.versions) {
      const latest = ctx.core.head(ctx.bucket, entry.key)
      if (latest) items.push({ kind: "object", name: entry.name, version: latest })
      continue
    }
    let versions = ctx.core.versionsOf(ctx.bucket, entry.key)
    if (afterVersion !== "") {
      const index = versions.findIndex((version) => version.versionId === afterVersion)
      if (index >= 0) versions = versions.slice(index + 1)
      afterVersion = ""
    }
    for (const version of versions) items.push({ kind: "object", name: entry.name, version })
  }
  return items
}

type Listing = {
  objects: Extract<Item, { kind: "object" }>[]
  prefixes: string[]
  truncated: boolean
  nextMarker: string
  nextVersionId: string
}

const EMPTY: Listing = {
  objects: [],
  prefixes: [],
  truncated: false,
  nextMarker: "",
  nextVersionId: "",
}

/** The shared tail of `listObjectsGeneric` and `ListObjectVersions`. */
const paginate = (
  ctx: Ctx,
  result: WalkResult,
  options: ListOptions,
  versionMarker: string,
): Listing => {
  let entries = result.entries
  if (!options.versions || versionMarker === "")
    entries = entries.filter((entry) => less(result.marker, entry.name))
  let items = toItems(ctx, entries, options, versionMarker)
  let truncated = result.more && items.length > 0
  if (options.maxKeys > 0 && items.length > options.maxKeys) {
    items = items.slice(0, options.maxKeys)
    truncated = true
  }
  const objects: Listing["objects"] = []
  const prefixes: string[] = []
  for (const item of items) {
    if (item.kind === "object") objects.push(item)
    else if (options.delimiter === "/" || !prefixes.includes(item.name)) prefixes.push(item.name)
  }
  const last = items[items.length - 1]
  if (!truncated || !last)
    return { objects, prefixes, truncated, nextMarker: "", nextVersionId: "" }
  // ListObjects resumes after an entry the walk skipped (a directory, a deleted key) if it is later.
  const next =
    !options.versions && less(last.name, result.lastSkipped) ? result.lastSkipped : last.name
  return {
    objects,
    prefixes,
    truncated,
    nextMarker: encodeMarker(next, result.id),
    nextVersionId: last.kind === "object" ? versionIdOf(ctx, last.version) : "",
  }
}

/** The version id MinIO reports internally: `""` for objects of a never-versioned bucket. */
const versionIdOf = (ctx: Ctx, version: ObjectVersion) =>
  version.versionId === "null" && !ctx.core.bucket(ctx.bucket)?.versioning ? "" : version.versionId

/** `erasureServerPools.listObjectsGeneric`. */
const listObjects = (ctx: Ctx, options: ListOptions): Listing => {
  const { prefix, marker, maxKeys } = options
  // MinIO answers `prefix` + `max-keys=1` with a direct lookup when the prefix is an object.
  if (prefix !== "" && maxKeys === 1 && marker === "") {
    ctx.core.requireBucket(ctx.bucket)
    const latest = ctx.core.head(ctx.bucket, prefix)
    if (latest && !latest.deleteMarker)
      return { ...EMPTY, objects: [{ kind: "object", name: prefix, version: latest }] }
  }
  const result = walk(ctx, options, walkLimit(maxKeys, marker !== ""))
  return result ? paginate(ctx, result, options, "") : EMPTY
}

/** `erasureServerPools.ListObjectVersions`. */
const listVersions = (ctx: Ctx, options: ListOptions, versionMarker: string): Listing => {
  if (options.marker === "" && versionMarker !== "")
    fail("NotImplemented", {
      message: "A header you provided implies functionality that is not implemented ()",
    })
  const result = walk(ctx, options, walkLimit(options.maxKeys, options.marker !== ""))
  return result ? paginate(ctx, result, options, versionMarker) : EMPTY
}

// ── request arguments ────────────────────────────────────────────────────────

type Args = { maxKeys: number; maxKeysText: string }

/** `max-keys` as `getList*Args` parses it. */
const parseMaxKeys = (ctx: Ctx): Args => {
  const raw = ctx.query.get("max-keys") ?? ""
  if (raw === "") return { maxKeys: MAX_OBJECT_LIST, maxKeysText: String(MAX_OBJECT_LIST) }
  const parsed = atoi(raw)
  if (parsed === undefined) fail("InvalidMaxKeys")
  const value = parsed as bigint
  return {
    maxKeys: value > 2147483647n ? 2147483647 : value < -1n ? -1 : Number(value),
    maxKeysText: value.toString(),
  }
}

/** `validateListObjectsArgs`. */
const validate = (
  ctx: Ctx,
  prefix: string,
  marker: string,
  encodingType: string,
  maxKeys: number,
) => {
  if (maxKeys < 0) fail("InvalidMaxKeys")
  if (encodingType !== "" && encodingType.toLowerCase() !== "url") fail("InvalidEncodingMethod")
  if (!validPrefix(prefix) || !rawParamIsUtf8(ctx.url, "prefix")) fail("InvalidObjectName")
  if (marker !== "" && !marker.startsWith(prefix)) fail("NotImplemented")
}

// ── responses ────────────────────────────────────────────────────────────────

const OWNER = wrap("Owner", el("ID", OWNER_ID) + el("DisplayName", OWNER_NAME))

/** Go's `textproto.CanonicalMIMEHeaderKey`. */
const canonicalHeader = (name: string) =>
  /[^!#$%&'*+\-.^_`|~0-9A-Za-z]/.test(name)
    ? name
    : name
        .toLowerCase()
        .replace(/(^|-)([a-z])/g, (_, dash: string, char: string) => dash + char.toUpperCase())

/** The `<UserMetadata>`, `<UserTags>` and `<Internal>` a `metadata=true` listing adds. */
const metadataElements = (version: ObjectVersion) => {
  const entries: [string, string][] = []
  if (!version.deleteMarker) {
    if (version.contentType !== undefined) entries.push(["content-type", version.contentType])
    if (version.contentEncoding) entries.push(["content-encoding", version.contentEncoding])
    if (version.cacheControl) entries.push(["cache-control", version.cacheControl])
    if (version.contentDisposition)
      entries.push(["content-disposition", version.contentDisposition])
    if (version.contentLanguage) entries.push(["content-language", version.contentLanguage])
    if (version.storageClass && version.storageClass !== "STANDARD")
      entries.push(["x-amz-storage-class", version.storageClass])
    for (const [name, value] of Object.entries(version.metadata ?? {}))
      entries.push([canonicalHeader(`x-amz-meta-${name}`), value])
  }
  const metadata = entries.length
    ? wrap("UserMetadata", entries.map(([name, value]) => text(name, value)).join(""))
    : ""
  const blocks = version.deleteMarker ? "<K>0</K><M>0</M>" : "<K>1</K><M>0</M>"
  return metadata + optional("UserTags", version.tagging ?? "") + wrap("Internal", blocks)
}

type ObjectFields = { owner: boolean; metadata: boolean; encodingType: string }

/** An `Object` (Contents / Version / DeleteMarker) body, up to and including StorageClass. */
const objectBody = (version: ObjectVersion, name: string, fields: ObjectFields) =>
  text("Key", encodeName(name, fields.encodingType)) +
  el("LastModified", isoDate(version.lastModified)) +
  el("ETag", version.etag ? `"${version.etag}"` : "") +
  el("Size", version.deleteMarker ? 0 : version.size) +
  (fields.owner ? OWNER : "") +
  el("StorageClass", version.storageClass || "STANDARD") +
  (fields.metadata ? metadataElements(version) : "")

const commonPrefixes = (prefixes: string[], encodingType: string) =>
  prefixes
    .map((prefix) => wrap("CommonPrefixes", text("Prefix", encodeName(prefix, encodingType))))
    .join("")

const common = (ctx: Ctx) => ({
  prefix: ctx.query.get("prefix") ?? "",
  delimiter: ctx.query.get("delimiter") ?? "",
  encodingType: ctx.query.get("encoding-type") ?? "",
})

const listObjectsV1: Handler = (ctx) => {
  const { maxKeys, maxKeysText } = parseMaxKeys(ctx)
  const { prefix, delimiter, encodingType } = common(ctx)
  const marker = ctx.query.get("marker") ?? ""
  validate(ctx, prefix, marker, encodingType, maxKeys)
  const listing = listObjects(ctx, { prefix, marker, delimiter, maxKeys, versions: false })
  const fields = { owner: true, metadata: false, encodingType }
  return xmlResponse(
    "ListBucketResult",
    text("Name", ctx.bucket) +
      text("Prefix", encodeName(prefix, encodingType)) +
      text("Marker", encodeName(marker, encodingType)) +
      optional("NextMarker", encodeName(listing.nextMarker, encodingType)) +
      el("MaxKeys", maxKeysText) +
      optional("Delimiter", encodeName(delimiter, encodingType)) +
      el("IsTruncated", listing.truncated) +
      listing.objects
        .map((item) => wrap("Contents", objectBody(item.version, item.name, fields)))
        .join("") +
      commonPrefixes(listing.prefixes, encodingType) +
      optional("EncodingType", encodingType),
  )
}

const listObjectsV2 =
  (metadata: boolean): Handler =>
  (ctx) => {
    const tokens = ctx.query.getAll("continuation-token")
    if (tokens.length && tokens[0] === "") fail("IncorrectContinuationToken")
    const { maxKeys, maxKeysText } = parseMaxKeys(ctx)
    const { prefix, delimiter, encodingType } = common(ctx)
    const startAfter = ctx.query.get("start-after") ?? ""
    const fetchOwner = ctx.query.get("fetch-owner") === "true"
    let token = ""
    const rawToken = ctx.query.get("continuation-token") ?? ""
    if (rawToken !== "") {
      const decoded = decodeBase64(rawToken)
      if (decoded === undefined) fail("IncorrectContinuationToken")
      token = decoded as string
    }
    validate(ctx, prefix, token, encodingType, maxKeys)
    const marker = token || startAfter
    const listing = listObjects(ctx, { prefix, marker, delimiter, maxKeys, versions: false })
    const fields = { owner: fetchOwner, metadata, encodingType }
    return xmlResponse(
      "ListBucketResult",
      text("Name", ctx.bucket) +
        text("Prefix", encodeName(prefix, encodingType)) +
        optional("StartAfter", encodeName(startAfter, encodingType)) +
        optional("ContinuationToken", encodeBase64(token)) +
        optional("NextContinuationToken", encodeBase64(listing.nextMarker)) +
        el("KeyCount", listing.objects.length + listing.prefixes.length) +
        el("MaxKeys", maxKeysText) +
        optional("Delimiter", encodeName(delimiter, encodingType)) +
        el("IsTruncated", listing.truncated) +
        listing.objects
          .map((item) => wrap("Contents", objectBody(item.version, item.name, fields)))
          .join("") +
        commonPrefixes(listing.prefixes, encodingType) +
        optional("EncodingType", encodingType),
    )
  }

const listObjectVersions =
  (metadata: boolean): Handler =>
  (ctx) => {
    const { maxKeys, maxKeysText } = parseMaxKeys(ctx)
    const { prefix, delimiter, encodingType } = common(ctx)
    const marker = ctx.query.get("key-marker") ?? ""
    const versionMarker = ctx.query.get("version-id-marker") ?? ""
    validate(ctx, prefix, marker, encodingType, maxKeys)
    const listing = listVersions(
      ctx,
      { prefix, marker, delimiter, maxKeys, versions: true },
      versionMarker,
    )
    const fields = { owner: true, metadata, encodingType }
    const versions = listing.objects
      .map((item) => {
        const tag = item.version.deleteMarker ? "DeleteMarker" : "Version"
        return wrap(
          tag,
          objectBody(item.version, item.name, fields) +
            el("IsLatest", ctx.core.isLatest(item.version)) +
            el("VersionId", item.version.versionId || "null"),
        )
      })
      .join("")
    return xmlResponse(
      "ListVersionsResult",
      text("Name", ctx.bucket) +
        text("Prefix", encodeName(prefix, encodingType)) +
        text("KeyMarker", encodeName(marker, encodingType)) +
        optional("NextKeyMarker", encodeName(listing.nextMarker, encodingType)) +
        text("NextVersionIdMarker", listing.nextVersionId) +
        text("VersionIdMarker", versionMarker) +
        el("MaxKeys", maxKeysText) +
        optional("Delimiter", encodeName(delimiter, encodingType)) +
        el("IsTruncated", listing.truncated) +
        commonPrefixes(listing.prefixes, encodingType) +
        versions +
        optional("EncodingType", encodingType),
    )
  }

export const listingHandlers: Handlers = {
  ListObjectsV1: listObjectsV1,
  ListObjectsV2: listObjectsV2(false),
  ListObjectsV2M: listObjectsV2(true),
  ListObjectVersions: listObjectVersions(false),
  ListObjectVersionsM: listObjectVersions(true),
}
