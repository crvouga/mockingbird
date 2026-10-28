/**
 * A raw S3 HTTP client for the oracle harness. It signs requests itself (SigV4 header auth,
 * presigned query auth, streaming `aws-chunked` payloads, or nothing at all) so a scenario
 * controls every byte on the wire, independently of the emulator's own verifier.
 */
import { createHash, createHmac } from "node:crypto"

export type Target = {
  /** e.g. `http://127.0.0.1:9000`. */
  endpoint: string
  accessKey: string
  secretKey: string
  region: string
}

export type Auth =
  /** SigV4 `Authorization` header over the SHA-256 of the body (the default). */
  | "header"
  /** SigV4 header auth with `x-amz-content-sha256: UNSIGNED-PAYLOAD`. */
  | "unsigned-payload"
  /** Presigned query-string auth. */
  | "presign"
  /** No credentials at all. */
  | "anonymous"
  /** `STREAMING-AWS4-HMAC-SHA256-PAYLOAD` signed chunks. */
  | "streaming"
  /** `STREAMING-UNSIGNED-PAYLOAD-TRAILER` with a checksum trailer. */
  | "streaming-unsigned-trailer"
  /** `STREAMING-AWS4-HMAC-SHA256-PAYLOAD-TRAILER`: signed chunks and a signed trailer. */
  | "streaming-signed-trailer"
  /** AWS Signature Version 2 `Authorization: AWS key:signature` (with a `Date` header). */
  | "v2"
  /** Presigned Signature Version 2 (`AWSAccessKeyId`, `Expires`, `Signature`). */
  | "presign-v2"

/** The request as it goes on the wire, after signing; `RequestSpec.wire` may change it. */
export type Wire = { headers: Record<string, string>; query: [string, string][]; body: Uint8Array }

export type RequestSpec = {
  method: string
  /** Path-style path, already percent-encoded where it needs to be, e.g. `/bucket/a%20b`. */
  path: string
  query?: Record<string, string> | [string, string][]
  headers?: Record<string, string>
  body?: string | Uint8Array
  auth?: Auth
  /** Override the signing time (`X-Amz-Date`). */
  date?: Date
  /** Presign lifetime in seconds. */
  expires?: number
  /** Sign with these credentials instead of the target's. */
  credentials?: { accessKey: string; secretKey: string }
  /** Sign for this region instead of the target's. */
  region?: string
  /** Corrupt the signature after computing it. */
  tamper?: boolean
  /** For `streaming*`: the chunk size in bytes. */
  chunkSize?: number
  /** For `streaming-unsigned-trailer`: the trailer to send, e.g. `x-amz-checksum-crc32`. */
  trailer?: [string, string]
  /** SigV4: sign exactly these (lowercase) header names instead of the default selection. */
  signedHeaders?: string[]
  /** SigV4 header auth: send and sign this `x-amz-content-sha256` instead of the body's hash. */
  contentSha256?: string
  /** Change the signed request before it is sent (drop a header, corrupt a chunk, ...). */
  wire?: (wire: Wire) => void
}

const sha256Hex = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex")
const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest()
const encoder = new TextEncoder()

/** RFC 3986 encoding as SigV4 specifies it (`/` kept in paths only). */
export const uriEncode = (value: string, keepSlash = false) =>
  [...encoder.encode(value)]
    .map((byte) => {
      const char = String.fromCharCode(byte)
      if (/[A-Za-z0-9\-._~]/.test(char) || (keepSlash && char === "/")) return char
      return `%${byte.toString(16).toUpperCase().padStart(2, "0")}`
    })
    .join("")

/** Encode an object key for a path: every segment encoded, slashes kept. */
export const keyPath = (bucket: string, key?: string) =>
  key === undefined ? `/${uriEncode(bucket)}` : `/${uriEncode(bucket)}/${uriEncode(key, true)}`

const trimAll = (value: string) => value.trim().replace(/\s+/g, " ")

/** The sub-resources a V2 signature covers, in MinIO's `resourceList` order. */
const V2_SUBRESOURCES = [
  "acl",
  "cors",
  "delete",
  "encryption",
  "legal-hold",
  "lifecycle",
  "location",
  "logging",
  "notification",
  "partNumber",
  "policy",
  "requestPayment",
  "response-cache-control",
  "response-content-disposition",
  "response-content-encoding",
  "response-content-language",
  "response-content-type",
  "response-expires",
  "retention",
  "select",
  "select-type",
  "tagging",
  "torrent",
  "uploadId",
  "uploads",
  "versionId",
  "versioning",
  "versions",
  "website",
]

const amzDate = (date: Date) => date.toISOString().replace(/[:-]|\.\d{3}/g, "")

const signingKey = (secret: string, day: string, region: string) => {
  const kDate = hmac(`AWS4${secret}`, day)
  const kRegion = hmac(kDate, region)
  const kService = hmac(kRegion, "s3")
  return hmac(kService, "aws4_request")
}

const canonicalQuery = (pairs: [string, string][]) =>
  pairs
    .map(([name, value]) => [uriEncode(name), uriEncode(value)] as const)
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join("&")

const toPairs = (query: RequestSpec["query"]): [string, string][] =>
  !query ? [] : Array.isArray(query) ? query : Object.entries(query)

const toBytes = (body: RequestSpec["body"]) =>
  body === undefined ? new Uint8Array() : typeof body === "string" ? encoder.encode(body) : body

const crc32 = (bytes: Uint8Array) => {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  const value = (crc ^ 0xffffffff) >>> 0
  return Buffer.from([value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff])
}
export const checksums = {
  crc32: (bytes: Uint8Array) => crc32(bytes).toString("base64"),
  sha1: (bytes: Uint8Array) => createHash("sha1").update(bytes).digest("base64"),
  sha256: (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("base64"),
  md5: (bytes: Uint8Array) => createHash("md5").update(bytes).digest("base64"),
}

export type Prepared = { url: string; init: RequestInit & { duplex?: "half" } }

/** Build the exact request a spec describes, signed for `target`. */
export const prepare = (target: Target, spec: RequestSpec): Prepared => {
  const auth = spec.auth ?? "header"
  const base = new URL(target.endpoint)
  const host = base.host
  const date = spec.date ?? new Date()
  const stamp = amzDate(date)
  const day = stamp.slice(0, 8)
  const region = spec.region ?? target.region
  const accessKey = spec.credentials?.accessKey ?? target.accessKey
  const secretKey = spec.credentials?.secretKey ?? target.secretKey
  const scope = `${day}/${region}/s3/aws4_request`
  const key = signingKey(secretKey, day, region)
  const pairs = toPairs(spec.query)
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(spec.headers ?? {}))
    headers[name.toLowerCase()] = value
  let body = toBytes(spec.body)
  const tamper = (signature: string) =>
    spec.tamper ? `${signature.slice(0, -1)}${signature.endsWith("0") ? "1" : "0"}` : signature

  const finish = (signed: [string, string][]): Prepared => {
    const wire: Wire = { headers, query: signed, body }
    spec.wire?.(wire)
    const query = wire.query
    body = wire.body
    const search = query.map(([n, v]) => `${uriEncode(n)}=${uriEncode(v)}`).join("&")
    const url = `${base.origin}${spec.path}${search ? `?${search}` : ""}`
    const hasBody =
      !["GET", "HEAD"].includes(spec.method) && (spec.body !== undefined || body.length)
    return {
      url,
      init: {
        method: spec.method,
        // MinIO gzips larger responses when the client accepts it; ask for the bytes as written.
        headers: { "accept-encoding": "identity", ...wire.headers },
        ...(hasBody ? { body: body as BodyInit } : {}),
        redirect: "manual",
      },
    }
  }

  if (auth === "anonymous") return finish(pairs)

  if (auth === "v2" || auth === "presign-v2") {
    const expires = String(Math.floor(date.getTime() / 1000) + (spec.expires ?? 900))
    const amz = Object.keys(headers)
      .filter((name) => name.startsWith("x-amz-"))
      .sort()
      .map((name) => `${name}:${headers[name]}\n`)
      .join("")
    const subresources = pairs
      .filter(([name]) => V2_SUBRESOURCES.includes(name))
      .sort(([a], [b]) => V2_SUBRESOURCES.indexOf(a) - V2_SUBRESOURCES.indexOf(b))
      .map(([name, value]) => (value ? `${name}=${value}` : name))
      .join("&")
    if (auth === "v2") headers.date ??= date.toUTCString()
    const toSign = [
      spec.method,
      headers["content-md5"] ?? "",
      headers["content-type"] ?? "",
      auth === "v2" ? headers.date : expires,
      `${amz}${spec.path}${subresources ? `?${subresources}` : ""}`,
    ].join("\n")
    const signature = tamper(createHmac("sha1", secretKey).update(toSign).digest("base64"))
    if (auth === "v2") {
      headers.authorization = `AWS ${accessKey}:${signature}`
      return finish(pairs)
    }
    return finish([
      ...pairs,
      ["AWSAccessKeyId", accessKey],
      ["Expires", expires],
      ["Signature", signature],
    ])
  }

  if (auth === "presign") {
    const signedNames = spec.signedHeaders ?? ["host"]
    const query: [string, string][] = [
      ...pairs,
      ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
      ["X-Amz-Credential", `${accessKey}/${scope}`],
      ["X-Amz-Date", stamp],
      ["X-Amz-Expires", String(spec.expires ?? 900)],
      ["X-Amz-SignedHeaders", signedNames.join(";")],
    ]
    const values: Record<string, string> = { ...headers, host }
    const canonical = [
      spec.method,
      spec.path,
      canonicalQuery(query),
      signedNames.map((name) => `${name}:${trimAll(values[name] ?? "")}\n`).join(""),
      signedNames.join(";"),
      pairs.find(([name]) => name === "X-Amz-Content-Sha256")?.[1] ?? "UNSIGNED-PAYLOAD",
    ].join("\n")
    const toSign = ["AWS4-HMAC-SHA256", stamp, scope, sha256Hex(canonical)].join("\n")
    const signature = tamper(hmac(key, toSign).toString("hex"))
    return finish([...query, ["X-Amz-Signature", signature]])
  }

  headers.host = host
  headers["x-amz-date"] = stamp
  let payloadHash: string
  const streaming =
    auth === "streaming" ||
    auth === "streaming-unsigned-trailer" ||
    auth === "streaming-signed-trailer"
  const signedChunks = auth === "streaming" || auth === "streaming-signed-trailer"
  const withTrailer = auth === "streaming-unsigned-trailer" || auth === "streaming-signed-trailer"
  if (auth === "unsigned-payload") payloadHash = "UNSIGNED-PAYLOAD"
  else if (auth === "streaming") payloadHash = "STREAMING-AWS4-HMAC-SHA256-PAYLOAD"
  else if (auth === "streaming-unsigned-trailer") payloadHash = "STREAMING-UNSIGNED-PAYLOAD-TRAILER"
  else if (auth === "streaming-signed-trailer")
    payloadHash = "STREAMING-AWS4-HMAC-SHA256-PAYLOAD-TRAILER"
  else payloadHash = sha256Hex(body)
  if (spec.contentSha256 !== undefined) payloadHash = spec.contentSha256
  headers["x-amz-content-sha256"] = payloadHash
  const raw = body
  if (streaming) {
    headers["content-encoding"] = headers["content-encoding"]
      ? `aws-chunked,${headers["content-encoding"]}`
      : "aws-chunked"
    headers["x-amz-decoded-content-length"] ??= String(raw.length)
    if (withTrailer && spec.trailer) headers["x-amz-trailer"] = spec.trailer[0]
  }
  const signedNames =
    spec.signedHeaders ??
    Object.keys(headers)
      .filter(
        (name) =>
          name === "host" ||
          name.startsWith("x-amz-") ||
          name === "content-type" ||
          name === "content-md5" ||
          name === "content-encoding" ||
          name === "content-length",
      )
      .sort()
  const canonicalHeaders = signedNames
    .map((name) => `${name}:${trimAll(String(headers[name] ?? ""))}\n`)
    .join("")
  const signedHeaders = signedNames.join(";")
  const canonical = [
    spec.method,
    spec.path,
    canonicalQuery(pairs),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n")
  const toSign = ["AWS4-HMAC-SHA256", stamp, scope, sha256Hex(canonical)].join("\n")
  const seed = tamper(hmac(key, toSign).toString("hex"))
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${seed}`
  delete headers.host

  if (streaming) {
    const size = spec.chunkSize ?? 64 * 1024
    const chunks: Uint8Array[] = []
    for (let offset = 0; offset < raw.length; offset += size)
      chunks.push(raw.subarray(offset, offset + size))
    chunks.push(new Uint8Array())
    const out: Buffer[] = []
    let previous = seed
    for (const chunk of chunks) {
      if (signedChunks) {
        const toSignChunk = [
          "AWS4-HMAC-SHA256-PAYLOAD",
          stamp,
          scope,
          previous,
          sha256Hex(""),
          sha256Hex(chunk),
        ].join("\n")
        const signature = hmac(key, toSignChunk).toString("hex")
        previous = signature
        out.push(Buffer.from(`${chunk.length.toString(16)};chunk-signature=${signature}\r\n`))
      } else out.push(Buffer.from(`${chunk.length.toString(16)}\r\n`))
      out.push(Buffer.from(chunk))
      if (chunk.length || auth === "streaming") out.push(Buffer.from("\r\n"))
    }
    if (auth === "streaming-unsigned-trailer") {
      if (spec.trailer) out.push(Buffer.from(`${spec.trailer[0]}:${spec.trailer[1]}\r\n`))
      out.push(Buffer.from("\r\n"))
    }
    if (auth === "streaming-signed-trailer") {
      const trailer = spec.trailer ? `${spec.trailer[0]}:${spec.trailer[1]}\n` : ""
      const toSignTrailer = [
        "AWS4-HMAC-SHA256-TRAILER",
        stamp,
        scope,
        previous,
        sha256Hex(trailer),
      ].join("\n")
      const signature = hmac(key, toSignTrailer).toString("hex")
      out.push(
        Buffer.from(
          `${trailer.replace(/\n$/, "")}\r\nx-amz-trailer-signature:${signature}\r\n\r\n`,
        ),
      )
    }
    body = new Uint8Array(Buffer.concat(out))
  }
  return finish(pairs)
}

export const send = async (target: Target, spec: RequestSpec) => {
  const { url, init } = prepare(target, spec)
  return fetch(url, init)
}
