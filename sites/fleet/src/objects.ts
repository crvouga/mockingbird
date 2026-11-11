import { signV4 } from "@crvouga/mockingbird-service"

export type ObjectRead =
  | { status: "found"; bytes: Uint8Array; revision: string }
  | { status: "missing" }
  /** The object still has the revision the caller passed. */
  | { status: "unchanged" }

/**
 * The blob store emulator state lives in. Writes are compare-and-swap on the object's revision
 * (its ETag), which is what lets several stateless replicas share one emulator safely.
 */
export type ObjectStore = {
  get(key: string, knownRevision?: string): Promise<ObjectRead>
  /**
   * Write `bytes`. `expected` is the revision the caller last saw, or `null` when the object must
   * not exist yet. Resolves `undefined`, writing nothing, when another writer got there first.
   */
  put(key: string, bytes: Uint8Array, expected: string | null): Promise<string | undefined>
  /** Delete every object under `prefix`. Missing objects are not an error. */
  deletePrefix(prefix: string): Promise<void>
}

/** The store answered, but not with success. `status` is what it said. */
export class ObjectStoreError extends Error {
  constructor(
    readonly operation: "GET" | "PUT" | "LIST" | "DELETE",
    readonly status: number,
    /** The S3 error code from the response body, e.g. `NoSuchBucket`, when there was one. */
    readonly s3Code?: string,
  ) {
    super(`object store ${operation} failed with HTTP ${status}${s3Code ? ` (${s3Code})` : ""}`)
    this.name = "ObjectStoreError"
  }
}

/** Reject keys that could escape the configured prefix. Keys are built from ids, never from requests. */
function checkKey(key: string): void {
  if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\/?$/.test(key) || key.split("/").includes(".."))
    throw new Error(`invalid object key: ${key}`)
}

export function memoryObjectStore(): ObjectStore & { readonly objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>()
  const revisions = new Map<string, string>()
  let counter = 0
  return {
    objects,
    async get(key, knownRevision) {
      checkKey(key)
      const bytes = objects.get(key)
      const revision = revisions.get(key)
      if (!bytes || !revision) return { status: "missing" }
      if (revision === knownRevision) return { status: "unchanged" }
      return { status: "found", bytes: bytes.slice(), revision }
    },
    async put(key, bytes, expected) {
      checkKey(key)
      if ((revisions.get(key) ?? null) !== expected) return undefined
      const revision = `"${++counter}"`
      objects.set(key, bytes.slice())
      revisions.set(key, revision)
      return revision
    },
    async deletePrefix(prefix) {
      checkKey(prefix)
      for (const key of [...objects.keys()])
        if (key.startsWith(prefix)) {
          objects.delete(key)
          revisions.delete(key)
        }
    },
  }
}

export type S3Options = {
  endpoint: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
  /** Prepended to every key, ending in `/`. The only part of the bucket this store touches. */
  prefix: string
  maxBytes?: number
  fetch?: typeof fetch
}

const unescapeXml = (value: string) =>
  value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&")

/** S3-compatible store (Cloudflare R2, MinIO, AWS) with path-style addressing and SigV4. */
export function s3ObjectStore(options: S3Options): ObjectStore {
  const send = options.fetch ?? fetch
  const max = options.maxBytes ?? 64 * 1024 * 1024
  const endpoint = new URL(options.endpoint)
  if (endpoint.username || endpoint.password)
    throw new Error("S3_ENDPOINT must not contain credentials")
  const base = `${endpoint.pathname.replace(/\/$/, "")}/${encodeURIComponent(options.bucket)}`

  const request = async (
    method: string,
    path: string,
    init: { body?: Uint8Array; headers?: Record<string, string>; query?: URLSearchParams } = {},
  ) => {
    const url = new URL(endpoint)
    url.pathname = `${base}${path}`
    if (init.query) {
      init.query.sort()
      url.search = init.query.toString()
    }
    const headers = await signV4({
      method,
      url,
      body: init.body ?? new Uint8Array(),
      region: options.region,
      service: "s3",
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      headers: init.headers ?? {},
    })
    return send(url, {
      method,
      headers,
      ...(init.body ? { body: init.body as BodyInit } : {}),
      signal: AbortSignal.timeout(30_000),
    })
  }
  const failure = async (operation: ObjectStoreError["operation"], response: Response) => {
    const body = await response.text().catch(() => "")
    return new ObjectStoreError(operation, response.status, /<Code>([^<]+)<\/Code>/.exec(body)?.[1])
  }
  const objectPath = (key: string) => {
    checkKey(key)
    return `/${`${options.prefix}${key}`.split("/").map(encodeURIComponent).join("/")}`
  }

  return {
    async get(key, knownRevision) {
      const response = await request("GET", objectPath(key), {
        ...(knownRevision ? { headers: { "if-none-match": knownRevision } } : {}),
      })
      if (response.status === 404 || response.status === 304) {
        await response.body?.cancel()
        return { status: response.status === 404 ? "missing" : "unchanged" }
      }
      if (!response.ok) throw await failure("GET", response)
      const revision = response.headers.get("etag")
      if (!revision) throw new Error("object store returned no ETag; conditional writes need one")
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (bytes.length > max) throw new Error("stored state exceeds the size limit")
      return { status: "found", bytes, revision }
    },
    async put(key, bytes, expected) {
      if (bytes.length > max) throw new Error("state exceeds the object size limit")
      const response = await request("PUT", objectPath(key), {
        body: bytes,
        headers: {
          "content-type": "application/octet-stream",
          ...(expected === null ? { "if-none-match": "*" } : { "if-match": expected }),
        },
      })
      if ([409, 412].includes(response.status)) {
        await response.body?.cancel()
        return undefined
      }
      if (!response.ok) throw await failure("PUT", response)
      await response.body?.cancel()
      const revision = response.headers.get("etag")
      if (!revision) throw new Error("object store returned no ETag; conditional writes need one")
      return revision
    },
    async deletePrefix(prefix) {
      checkKey(prefix)
      let token: string | undefined
      do {
        const query = new URLSearchParams({
          "list-type": "2",
          prefix: `${options.prefix}${prefix}`,
        })
        if (token) query.set("continuation-token", token)
        const response = await request("GET", "", { query })
        if (!response.ok) throw await failure("LIST", response)
        const xml = await response.text()
        for (const match of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) {
          const key = unescapeXml(match[1] ?? "")
          // Belt and braces: never delete outside this store's prefix, whatever the listing says.
          if (!key.startsWith(`${options.prefix}${prefix}`)) continue
          const deleted = await request(
            "DELETE",
            `/${key.split("/").map(encodeURIComponent).join("/")}`,
          )
          if (!deleted.ok && deleted.status !== 404) throw await failure("DELETE", deleted)
          await deleted.body?.cancel()
        }
        token = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1]
        token = token ? unescapeXml(token) : undefined
      } while (token)
    },
  }
}
