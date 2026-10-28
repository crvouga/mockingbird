/**
 * Virtual-hosted-style addressing (https://docs.aws.amazon.com/AmazonS3/latest/userguide/VirtualHosting.html):
 * `Host: <bucket>.<base host>` with the key as the whole path. A request is rewritten to the
 * path-style form the rest of the emulator speaks; the original signing path is recovered from
 * the bucket the rewrite records in a header.
 */
export const DEFAULT_VIRTUAL_HOSTS: readonly string[] = ["localhost"]
export const VIRTUAL_BUCKET_HEADER = "x-mockingbird-s3-virtual-bucket"

/** The bucket a `Host` names under one of the base hosts, or `undefined` for a path-style host. */
export const virtualBucket = (host: string, bases: readonly string[]): string | undefined => {
  if (host.startsWith("[")) return undefined
  const name = host.replace(/:\d+$/, "").toLowerCase()
  const base = [...bases]
    .map((value) => value.toLowerCase().replace(/^\.+|\.+$/g, ""))
    .filter((value) => value && name.endsWith(`.${value}`) && name.length > value.length + 1)
    .sort((a, b) => b.length - a.length)[0]
  return base ? name.slice(0, name.length - base.length - 1) : undefined
}

/**
 * The same request addressed path-style, with the bucket in the path. Paths under `keep`
 * (the admin prefix) and requests that are not virtual-hosted are returned unchanged.
 */
export const toPathStyle = (request: Request, bases: readonly string[], keep?: string): Request => {
  const url = new URL(request.url)
  const bucket = virtualBucket(url.host, bases)
  if (!bucket || request.headers.get(VIRTUAL_BUCKET_HEADER) === bucket) return request
  if (keep && (url.pathname === keep || url.pathname.startsWith(`${keep}/`))) return request
  url.pathname = url.pathname === "/" ? `/${bucket}` : `/${bucket}${url.pathname}`
  const headers = new Headers(request.headers)
  headers.set(VIRTUAL_BUCKET_HEADER, bucket)
  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers,
    signal: request.signal,
  }
  if (request.body) {
    init.body = request.body
    init.duplex = "half"
  }
  return new Request(url, init)
}

/** Go's `path.Clean` for a rooted path. */
const cleanRooted = (path: string) => {
  const out: string[] = []
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") out.pop()
    else out.push(segment)
  }
  return `/${out.join("/")}`
}

/**
 * The object name MinIO's handlers see for a decoded path key (`trimLeadingSlash`): a key that
 * starts with `/` (from `/bucket//key`) is cleaned (`//` collapsed, a trailing `/` kept) and its
 * leading slash dropped; any other key is unchanged.
 */
export const objectName = (key: string) => {
  if (!key.startsWith("/")) return key
  const cleaned = cleanRooted(key)
  return (key.length > 1 && key.endsWith("/") && cleaned !== "/" ? `${cleaned}/` : cleaned).slice(1)
}
