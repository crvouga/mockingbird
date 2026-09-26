import { toHex } from "./signing.js"

/**
 * A minimal S3 `PutObject` for mocks whose vendor hands the app an `s3://` object (GxG
 * results, Daily transcripts): the mock writes the object into the stack's local S3
 * (s3rver, MinIO) so the app's own `GetObject` / `CopyObject` finds it. Path-style
 * addressing, SigV4-signed, no SDK.
 */
export type S3Target = {
  /** e.g. `http://127.0.0.1:4569`. */
  endpoint: string
  bucket: string
  region?: string
  accessKeyId?: string
  secretAccessKey?: string
  fetch?: (request: Request) => Promise<Response>
}

const encoder = new TextEncoder()

const hmacBytes = async (key: Uint8Array, message: string): Promise<Uint8Array> => {
  const imported = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, encoder.encode(message)))
}

const sha256Hex = async (data: Uint8Array | string): Promise<string> =>
  toHex(
    await crypto.subtle.digest(
      "SHA-256",
      (typeof data === "string" ? encoder.encode(data) : data) as BufferSource,
    ),
  )

const encodeSegment = (segment: string) =>
  encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )

/** SigV4 headers for one request (service `s3`, unsigned query, signed payload hash). */
export const signV4 = async (input: {
  method: string
  url: URL
  body: Uint8Array
  region: string
  service: string
  accessKeyId: string
  secretAccessKey: string
  headers?: Record<string, string>
  now?: Date
}): Promise<Record<string, string>> => {
  const now = input.now ?? new Date()
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "")
  const date = amzDate.slice(0, 8)
  const payloadHash = await sha256Hex(input.body)
  const headers: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(input.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    ),
    host: input.url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  }
  const signedHeaders = Object.keys(headers).sort()
  const canonicalRequest = [
    input.method,
    input.url.pathname
      .split("/")
      .map((s) => encodeSegment(decodeURIComponent(s)))
      .join("/"),
    [...input.url.searchParams]
      .map(([k, v]) => `${encodeSegment(k)}=${encodeSegment(v)}`)
      .sort()
      .join("&"),
    signedHeaders.map((h) => `${h}:${String(headers[h]).trim()}\n`).join(""),
    signedHeaders.join(";"),
    payloadHash,
  ].join("\n")
  const scope = `${date}/${input.region}/${input.service}/aws4_request`
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonicalRequest)].join(
    "\n",
  )
  let key = await hmacBytes(encoder.encode(`AWS4${input.secretAccessKey}`), date)
  key = await hmacBytes(key, input.region)
  key = await hmacBytes(key, input.service)
  key = await hmacBytes(key, "aws4_request")
  const signature = toHex(await hmacBytes(key, stringToSign))
  const { host: _host, ...rest } = headers
  return {
    ...rest,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders.join(";")}, Signature=${signature}`,
  }
}

/** Write one object; resolves to its `s3://bucket/key` URI. Throws on a non-2xx answer. */
export const putObject = async (
  target: S3Target,
  key: string,
  body: Uint8Array | string,
  contentType = "application/octet-stream",
): Promise<string> => {
  const bytes = typeof body === "string" ? encoder.encode(body) : body
  const url = new URL(
    `${target.endpoint.replace(/\/+$/, "")}/${encodeSegment(target.bucket)}/${key
      .split("/")
      .map(encodeSegment)
      .join("/")}`,
  )
  const headers = await signV4({
    method: "PUT",
    url,
    body: bytes,
    region: target.region ?? "us-east-1",
    service: "s3",
    accessKeyId: target.accessKeyId ?? "S3RVER",
    secretAccessKey: target.secretAccessKey ?? "S3RVER",
    headers: { "content-type": contentType },
  })
  const send = target.fetch ?? ((request: Request) => fetch(request))
  const response = await send(new Request(url, { method: "PUT", headers, body: bytes as BodyInit }))
  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new Error(`S3 PutObject ${url.pathname} failed: ${response.status} ${text.slice(0, 200)}`)
  }
  await response.body?.cancel()
  return `s3://${target.bucket}/${key}`
}
