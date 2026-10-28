/**
 * The differential harness: a scenario is a deterministic script of S3 requests. Played against
 * MinIO it produces the oracle transcript (recorded under `golden/`); played against the emulator
 * it must produce the same transcript, exchange for exchange, once volatile values (request ids,
 * timestamps, upload/version ids, continuation tokens, the per-run bucket suffix) are masked.
 */
import { S3Client } from "@aws-sdk/client-s3"
import { type Auth, keyPath, type RequestSpec, send, type Target, uriEncode } from "./client.js"

export type Exchange = {
  step: string
  request: string
  status: number
  headers: Record<string, string>
  body: string
}
export type Recorded = { step: string; value: unknown }
export type Transcript = (Exchange | Recorded)[]

export type Res = {
  status: number
  headers: Headers
  text: string
  bytes: Uint8Array
  /** The text of the first `<tag>` element, if any. */
  tag(name: string): string | undefined
  /** The text of every `<tag>` element. */
  tags(name: string): string[]
}

export type BucketOptions = {
  objectLock?: boolean
  versioning?: "Enabled" | "Suspended"
}

export type Ctx = {
  /** The connection details for this run. */
  target: Target
  /** A bucket name unique to this run: `<base>-<run>`. */
  name(base: string): string
  /** Create (unrecorded) a bucket unique to this run and schedule its cleanup. */
  bucket(base: string, options?: BucketOptions): Promise<string>
  /** Send and record a request. */
  req(step: string, spec: RequestSpec): Promise<Res>
  /** Send a request without recording it (setup). */
  raw(spec: RequestSpec): Promise<Res>
  /** Record an arbitrary JSON-able value (SDK results), normalized like a response. */
  record(step: string, value: unknown): void
  /** An AWS SDK v3 client for this target; destroyed after the scenario. */
  sdk(options?: { forcePathStyle?: boolean }): S3Client
  /** Run `action` and return the error name it throws, or `"NO_ERROR"`. */
  errorName(action: () => Promise<unknown>): Promise<string>
}

export type Scenario = {
  name: string
  /** Skip recording/replay with a reason (a documented, deliberate gap). */
  skip?: string
  run(ctx: Ctx): Promise<void>
}

export type { Auth, RequestSpec, Target }
export { keyPath, uriEncode }

/** Headers that are transport noise or MinIO branding rather than S3 behavior. */
const IGNORED_HEADERS = new Set([
  "x-mockingbird",
  "x-mockingbird-checkpoint",
  "date",
  "server",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "strict-transport-security",
  "x-content-type-options",
  "x-xss-protection",
  "vary",
])
/** Headers whose presence matters but whose value is per-request. */
const PRESENCE_HEADERS = new Set(["x-amz-request-id", "x-amz-id-2"])
const DATE_HEADERS = new Set(["last-modified"])
/** Elements and headers that carry server-generated identifiers. */
const ID_TAGS = [
  "UploadId",
  "VersionId",
  "DeleteMarkerVersionId",
  "NextVersionIdMarker",
  "VersionIdMarker",
  "NextUploadIdMarker",
  "UploadIdMarker",
  "ContinuationToken",
  "NextContinuationToken",
  "StartAfter",
]
const ID_HEADERS = new Set(["x-amz-version-id", "x-amz-copy-source-version-id"])
const ID_QUERY = new Set([
  "uploadId",
  "versionId",
  "continuation-token",
  "version-id-marker",
  "upload-id-marker",
])
const DATE_TAGS = ["LastModified", "CreationDate", "Initiated"]
/**
 * Object-lock retain-until dates are scenario input (far-future, kept verbatim) except when a
 * bucket's default retention derives them from the wall clock: those (within a year of now)
 * become `<now+Nd>`, N whole days.
 */
const RETAIN_UNTIL_HEADER = "x-amz-object-lock-retain-until-date"
const RETAIN_UNTIL_TAG = "RetainUntilDate"
const retainUntil = (value: string) => {
  const at = Date.parse(value)
  const delta = at - Date.now()
  if (Number.isNaN(at) || Math.abs(delta) > 400 * 86_400_000) return value
  return `<now+${Math.round(delta / 86_400_000)}d>`
}
const VOLATILE_TAGS = ["RequestId", "HostId"]

export class Normalizer {
  private readonly ids = new Map<string, string>()
  constructor(
    private readonly run: string,
    /** The target's `host:port`, which appears in `Location` headers and redirects. */
    private readonly host = "",
  ) {}
  id(value: string) {
    if (value === "" || value === "null") return value
    let mapped = this.ids.get(value)
    if (!mapped) {
      mapped = `<id:${this.ids.size + 1}>`
      this.ids.set(value, mapped)
    }
    return mapped
  }
  text(value: string) {
    let out = value.split(this.run).join("<run>")
    if (this.host) out = out.split(this.host).join("<host>")
    for (const [raw, mapped] of this.ids) if (raw.length > 3) out = out.split(raw).join(mapped)
    return out
  }
  xml(body: string) {
    let out = body
    for (const tag of VOLATILE_TAGS)
      out = out.replace(new RegExp(`<${tag}>[^<]*</${tag}>`, "g"), `<${tag}>*</${tag}>`)
    out = out.replace(
      new RegExp(`<${RETAIN_UNTIL_TAG}>([^<]*)</${RETAIN_UNTIL_TAG}>`, "g"),
      (_, value: string) => `<${RETAIN_UNTIL_TAG}>${retainUntil(value)}</${RETAIN_UNTIL_TAG}>`,
    )
    for (const tag of DATE_TAGS)
      out = out.replace(new RegExp(`<${tag}>[^<]*</${tag}>`, "g"), `<${tag}><date></${tag}>`)
    for (const tag of ID_TAGS)
      out = out.replace(
        new RegExp(`<${tag}>([^<]*)</${tag}>`, "g"),
        (_, value: string) => `<${tag}>${this.id(value)}</${tag}>`,
      )
    // A multipart upload's internal path (`sha256(bucket/key)/<uuid>x<nanos>`) in error messages.
    out = out.replace(/\/[0-9a-f]{64}\/[0-9a-f-]{36}x\d+/g, "/<upload-path>")
    // A listing marker's metacache id (`key[minio_cache:v2,id:<uuid>,p:0,s:0]`) is random.
    out = out.replace(
      /(\[minio_cache:v2,id:)([^,\]<]+)/g,
      (_, head: string, id: string) => `${head}${this.id(id)}`,
    )
    // `<UserMetadata>` children come from a Go map: MinIO's order is random, so sort them.
    out = out.replace(/<UserMetadata>(.*?)<\/UserMetadata>/g, (_, inner: string) => {
      const items = inner.match(/<([^>\s/]+)>[^<]*<\/\1>/g) ?? []
      return `<UserMetadata>${items.sort().join("")}</UserMetadata>`
    })
    return this.text(out)
  }
  request(spec: RequestSpec) {
    const pairs = !spec.query
      ? []
      : Array.isArray(spec.query)
        ? spec.query
        : Object.entries(spec.query)
    const query = pairs
      .map(([name, value]) => `${name}=${ID_QUERY.has(name) ? this.id(value) : value}`)
      .join("&")
    return this.text(
      `${spec.method} ${spec.path}${query ? `?${query}` : ""}${spec.auth && spec.auth !== "header" ? ` [${spec.auth}]` : ""}`,
    )
  }
  response(step: string, spec: RequestSpec, res: Res): Exchange {
    const headers: Record<string, string> = {}
    const xml = /xml/.test(res.headers.get("content-type") ?? "") || res.text.startsWith("<?xml")
    for (const [name, value] of res.headers) {
      if (IGNORED_HEADERS.has(name)) continue
      if (name === "content-length" && xml) continue
      // MinIO gzips larger XML bodies (transport compression); object bodies never are.
      if (name === "content-encoding" && xml && value === "gzip") continue
      if (PRESENCE_HEADERS.has(name)) headers[name] = "*"
      else if (DATE_HEADERS.has(name))
        headers[name] = Number.isNaN(Date.parse(value)) ? value : "<date>"
      else if (name === RETAIN_UNTIL_HEADER) headers[name] = retainUntil(value)
      else if (ID_HEADERS.has(name)) headers[name] = this.id(value)
      else headers[name] = this.text(value)
    }
    const sorted = Object.fromEntries(
      Object.entries(headers).sort(([a], [b]) => a.localeCompare(b)),
    )
    let body: string
    if (xml) body = this.xml(res.text)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: printable ASCII plus tab/CR/LF.
    else if (/^[\x09\x0a\x0d\x20-\x7e]*$/.test(res.text) && res.bytes.length <= 4096)
      body = this.text(res.text)
    else
      body = `<${res.bytes.length} bytes sha256:${new Bun.CryptoHasher("sha256").update(res.bytes).digest("hex").slice(0, 16)}>`
    return { step, request: this.request(spec), status: res.status, headers: sorted, body }
  }
  value(input: unknown, keyName = ""): unknown {
    if (input instanceof Date) return "<date>"
    if (input instanceof Uint8Array) return `<${input.length} bytes>`
    if (Array.isArray(input)) return input.map((item) => this.value(item, keyName))
    if (input && typeof input === "object") {
      const out: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(input).sort(([a], [b]) => a.localeCompare(b))) {
        if (value === undefined) continue
        if (key === "$metadata") {
          out[key] = { httpStatusCode: (value as { httpStatusCode?: number }).httpStatusCode }
          continue
        }
        if (
          key === "RequestId" ||
          key === "HostId" ||
          key === "requestId" ||
          key === "extendedRequestId"
        )
          continue
        out[key] = this.value(value, key)
      }
      return out
    }
    if (typeof input === "string") {
      if (ID_TAGS.includes(keyName) || keyName === "VersionId") return this.id(input)
      return this.text(input)
    }
    return input
  }
}

const wrap = async (response: Response): Promise<Res> => {
  const bytes = new Uint8Array(await response.arrayBuffer())
  const text = new TextDecoder().decode(bytes)
  const all = (name: string) =>
    [...text.matchAll(new RegExp(`<${name}>([^<]*)</${name}>`, "g"))].map((match) =>
      (match[1] ?? "")
        .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) =>
          String.fromCodePoint(Number.parseInt(code, 16)),
        )
        .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&"),
    )
  return {
    status: response.status,
    headers: response.headers,
    text,
    bytes,
    tag: (name) => all(name)[0],
    tags: all,
  }
}

const quietly = async (target: Target, spec: RequestSpec) => {
  try {
    return await wrap(await send(target, spec))
  } catch {
    return undefined
  }
}

const LEGAL_HOLD_OFF =
  '<LegalHold xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>OFF</Status></LegalHold>'
// PutObjectLegalHold requires Content-MD5 (MinIO's validateLengthAndChecksum).
const LEGAL_HOLD_OFF_MD5 = new Bun.CryptoHasher("md5").update(LEGAL_HOLD_OFF).digest("base64")

/** Remove everything in a bucket (every version, every upload, governance holds) and the bucket. */
export const destroyBucket = async (target: Target, bucket: string) => {
  for (let round = 0; round < 20; round++) {
    const versions = await quietly(target, {
      method: "GET",
      path: keyPath(bucket),
      query: { versions: "", "max-keys": "1000" },
    })
    if (!versions || versions.status === 404) return
    const keys = versions.tags("Key")
    const ids = versions.tags("VersionId")
    if (!keys.length) break
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index] as string
      await quietly(target, {
        method: "PUT",
        path: keyPath(bucket, key),
        query: { "legal-hold": "" },
        body: LEGAL_HOLD_OFF,
        headers: { "content-md5": LEGAL_HOLD_OFF_MD5 },
        ...(ids[index] ? { query: { "legal-hold": "", versionId: ids[index] as string } } : {}),
      })
      await quietly(target, {
        method: "DELETE",
        path: keyPath(bucket, key),
        query: ids[index] ? { versionId: ids[index] as string } : {},
        headers: { "x-amz-bypass-governance-retention": "true" },
      })
    }
  }
  for (let round = 0; round < 10; round++) {
    const uploads = await quietly(target, {
      method: "GET",
      path: keyPath(bucket),
      query: { uploads: "" },
    })
    const keys = uploads?.tags("Key") ?? []
    const ids = uploads?.tags("UploadId") ?? []
    if (!keys.length) break
    for (let index = 0; index < keys.length; index++)
      await quietly(target, {
        method: "DELETE",
        path: keyPath(bucket, keys[index] as string),
        query: { uploadId: ids[index] as string },
      })
  }
  await quietly(target, { method: "DELETE", path: keyPath(bucket) })
}

export type PlayOptions = {
  target: Target
  /** A short lowercase suffix that makes this run's bucket names unique. */
  run: string
}

/** Play one scenario against a target and return its normalized transcript. */
export const play = async (
  scenario: Scenario,
  { target, run }: PlayOptions,
): Promise<Transcript> => {
  const transcript: Transcript = []
  const normalizer = new Normalizer(run, new URL(target.endpoint).host)
  const buckets = new Set<string>()
  const clients: S3Client[] = []
  const name = (base: string) => {
    const bucket = `${base}-${run}`
    buckets.add(bucket)
    return bucket
  }
  const raw = async (spec: RequestSpec) => {
    const res = await wrap(await send(target, spec))
    // Learn server-generated ids from setup traffic too, so later references map consistently.
    for (const tag of ID_TAGS) for (const value of res.tags(tag)) normalizer.id(value)
    for (const header of ID_HEADERS) {
      const value = res.headers.get(header)
      if (value) normalizer.id(value)
    }
    return res
  }
  const ctx: Ctx = {
    target,
    name,
    async bucket(base, options = {}) {
      const bucket = name(base)
      const created = await raw({
        method: "PUT",
        path: keyPath(bucket),
        ...(options.objectLock ? { headers: { "x-amz-bucket-object-lock-enabled": "true" } } : {}),
      })
      if (created.status !== 200)
        throw new Error(`setup: create ${bucket} -> ${created.status} ${created.text}`)
      if (options.versioning)
        await raw({
          method: "PUT",
          path: keyPath(bucket),
          query: { versioning: "" },
          body: `<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>${options.versioning}</Status></VersioningConfiguration>`,
        })
      return bucket
    },
    async req(step, spec) {
      const res = await raw(spec)
      transcript.push(normalizer.response(step, spec, res))
      return res
    },
    raw,
    record(step, value) {
      transcript.push({ step, value: normalizer.value(value) })
    },
    sdk(options = {}) {
      const client = new S3Client({
        endpoint: target.endpoint,
        region: target.region,
        forcePathStyle: options.forcePathStyle ?? true,
        maxAttempts: 1,
        credentials: { accessKeyId: target.accessKey, secretAccessKey: target.secretKey },
      })
      clients.push(client)
      return client
    },
    async errorName(action) {
      try {
        await action()
        return "NO_ERROR"
      } catch (error) {
        return error instanceof Error ? error.name : String(error)
      }
    },
  }
  try {
    await scenario.run(ctx)
  } finally {
    for (const client of clients) client.destroy()
    for (const bucket of buckets) await destroyBucket(target, bucket)
  }
  return transcript
}

/** The first difference between two transcripts, or `undefined` when they agree. */
export const diff = (expected: Transcript, actual: Transcript) => {
  const length = Math.max(expected.length, actual.length)
  for (let index = 0; index < length; index++) {
    const want = JSON.stringify(expected[index] ?? null, null, 2)
    const got = JSON.stringify(actual[index] ?? null, null, 2)
    if (want !== got) return { index, expected: expected[index], actual: actual[index] }
  }
  return undefined
}
