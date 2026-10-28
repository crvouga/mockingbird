/**
 * Request authentication, ported from MinIO's `cmd/auth-handler.go`, `signature-v4*.go`,
 * `generic-handlers.go` (`setAuthMiddleware`) and `signature-v2.go` (in `auth-v2.ts`): which
 * scheme a request uses, and whether its signature holds, in MinIO's exact error precedence.
 */
import { fail, S3Error } from "./errors.js"

export type AuthType =
  | "anonymous"
  | "signed-v2"
  | "presigned-v2"
  | "streaming-signed"
  | "streaming-signed-trailer"
  | "streaming-unsigned-trailer"
  | "signed"
  | "presigned"
  | "post-policy"
  /** `Authorization: Bearer ...`: MinIO's console JWT, which S3 operations treat as anonymous. */
  | "jwt"
  /** An `Action=` query (STS), which S3 operations treat as anonymous. */
  | "sts"
  | "unknown"

export const SIGN_V4 = "AWS4-HMAC-SHA256"
export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
export const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD"
export const STREAMING_PAYLOAD = "STREAMING-AWS4-HMAC-SHA256-PAYLOAD"
export const STREAMING_PAYLOAD_TRAILER = "STREAMING-AWS4-HMAC-SHA256-PAYLOAD-TRAILER"
export const STREAMING_UNSIGNED_TRAILER = "STREAMING-UNSIGNED-PAYLOAD-TRAILER"
/** MinIO's `globalMaxSkewTime`. */
export const MAX_SKEW_MS = 15 * 60 * 1000

const encoder = new TextEncoder()

export const hex = (bytes: ArrayBuffer | Uint8Array) =>
  [...(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")
export const sha256Hex = async (data: string | Uint8Array) =>
  hex(
    await crypto.subtle.digest(
      "SHA-256",
      (typeof data === "string" ? encoder.encode(data) : data) as BufferSource,
    ),
  )
export const hmacRaw = async (hash: "SHA-256" | "SHA-1", key: Uint8Array, value: string) => {
  const imported = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash },
    false,
    ["sign"],
  )
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, encoder.encode(value)))
}
export const hmac256 = (key: Uint8Array, value: string) => hmacRaw("SHA-256", key, value)

/** RFC 3986 percent-encoding of every byte outside `A-Za-z0-9-_.~` (and `/` when kept). */
export const uriEncode = (value: string, keepSlash = false) => {
  let out = ""
  for (const byte of encoder.encode(value)) {
    const char = String.fromCharCode(byte)
    if (/[A-Za-z0-9\-_.~]/.test(char) || (keepSlash && char === "/")) out += char
    else out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`
  }
  return out
}

/** Go's `url.Values.Encode()` with `+` → `%20`: keys sorted, values in request order. */
export const canonicalQuery = (pairs: readonly (readonly [string, string])[]) => {
  const keys = [...new Set(pairs.map(([name]) => name))].sort()
  return keys
    .flatMap((key) =>
      pairs
        .filter(([name]) => name === key)
        .map(([, value]) => `${uriEncode(key)}=${uriEncode(value)}`),
    )
    .join("&")
}

export const isSignatureV4 = (headers: Headers) =>
  (headers.get("authorization") ?? "").startsWith(SIGN_V4)
export const isSignatureV2 = (headers: Headers) => {
  const value = headers.get("authorization") ?? ""
  return value.startsWith("AWS") && !value.startsWith(SIGN_V4)
}
export const isPresignedV4 = (query: URLSearchParams) => query.has("X-Amz-Credential")
export const isPresignedV2 = (query: URLSearchParams) => query.has("AWSAccessKeyId")
export const isPostPolicy = (method: string, headers: Headers) =>
  method === "POST" &&
  (headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() === "multipart/form-data"

/** MinIO's `getRequestAuthType`. */
export const authType = (method: string, headers: Headers, query: URLSearchParams): AuthType => {
  const sha = headers.get("x-amz-content-sha256")
  if (isSignatureV2(headers)) return "signed-v2"
  if (isPresignedV2(query)) return "presigned-v2"
  if (sha === STREAMING_PAYLOAD && method === "PUT") return "streaming-signed"
  if (sha === STREAMING_PAYLOAD_TRAILER && method === "PUT") return "streaming-signed-trailer"
  if (sha === STREAMING_UNSIGNED_TRAILER && method === "PUT") return "streaming-unsigned-trailer"
  if (isSignatureV4(headers)) return "signed"
  if (isPresignedV4(query)) return "presigned"
  if ((headers.get("authorization") ?? "").startsWith("Bearer")) return "jwt"
  if (isPostPolicy(method, headers)) return "post-policy"
  if (query.has("Action")) return "sts"
  if (!headers.has("authorization")) return "anonymous"
  return "unknown"
}

/** MinIO's `hasMultipleAuth`: more than one of the schemes at once is refused. */
export const hasMultipleAuth = (method: string, headers: Headers, query: URLSearchParams) =>
  [
    isSignatureV2(headers),
    isPresignedV2(query),
    isSignatureV4(headers),
    isPresignedV4(query),
    isPostPolicy(method, headers),
  ].filter(Boolean).length > 1

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

/** `Date.UTC` that refuses out-of-range fields, as Go's `time.Parse` does. */
const utc = (year: number, month: number, day: number, hour = 0, minute = 0, second = 0) => {
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return Number.NaN
  const ms = Date.UTC(year, month - 1, day, hour, minute, second)
  const check = new Date(ms)
  return check.getUTCDate() === day && check.getUTCMonth() === month - 1 ? ms : Number.NaN
}

/** Go `time.Parse("20060102T150405Z", value)` → epoch ms, or NaN. */
export const parseAmzDate = (value: string) => {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value)
  if (!match) return Number.NaN
  const [, y, mo, d, h, mi, s] = match.map(Number) as number[]
  return utc(y as number, mo as number, d as number, h, mi, s)
}

/** Go `time.Parse("20060102", value)` → epoch ms, or NaN. */
export const parseYyyymmdd = (value: string) => {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(value)
  if (!match) return Number.NaN
  const [, y, mo, d] = match.map(Number) as number[]
  return utc(y as number, mo as number, d as number)
}

/** Go `time.RFC1123` (`Mon, 02 Jan 2006 15:04:05 MST`) and `time.RFC1123Z` (`... -0700`). */
const parseRfc1123 = (value: string) => {
  const match =
    /^([A-Z][a-z]{2}), (\d{2}) ([A-Z][a-z]{2}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) (?:([A-Z]{3,5})|([+-])(\d{2})(\d{2}))$/.exec(
      value,
    )
  if (!match || !DAYS.includes(match[1] as string)) return Number.NaN
  const month = MONTHS.indexOf(match[3] as string) + 1
  if (!month) return Number.NaN
  const ms = utc(
    Number(match[4]),
    month,
    Number(match[2]),
    Number(match[5]),
    Number(match[6]),
    Number(match[7]),
  )
  if (match[9] === undefined) return ms
  const offset = (Number(match[10]) * 60 + Number(match[11])) * 60 * 1000
  return match[9] === "+" ? ms - offset : ms + offset
}

/** MinIO's `amztime.Parse`: ISO8601 basic, RFC1123 or RFC1123Z. */
export const parseAnyAmzDate = (value: string) => {
  const iso = parseAmzDate(value)
  return Number.isNaN(iso) ? parseRfc1123(value) : iso
}

/**
 * MinIO's `setAuthMiddleware`, which runs before any request validation: an unknown scheme is
 * refused, and a header-signed request must carry a parseable date within 15 minutes of now.
 */
export const checkAuthMiddleware = (auth: AuthType, headers: Headers, now: number) => {
  if (auth === "unknown") fail("SignatureVersionNotSupported")
  if (!["signed", "signed-v2", "streaming-signed", "streaming-signed-trailer"].includes(auth))
    return
  let date = Number.NaN
  let found = false
  for (const name of ["x-amz-date", "date"]) {
    const value = headers.get(name)
    if (!value) continue
    found = true
    date = parseAnyAmzDate(value)
    if (Number.isNaN(date)) fail("MalformedDate")
    break
  }
  if (!found) fail("MissingDateHeader")
  if (Math.abs(now - date) > MAX_SKEW_MS) fail("RequestTimeTooSkewed")
}

export type Credential = {
  accessKey: string
  date: string
  region: string
  service: string
  request: string
}
export const scopeOf = (credential: Credential) =>
  `${credential.date}/${credential.region}/${credential.service}/${credential.request}`

/** MinIO's `isValidRegion` (its default region is `""`, so `US` only matches an unset region). */
const isValidRegion = (requestRegion: string, configured: string) => {
  if (!configured) return true
  const normalize = (value: string) => (value === "US" ? "" : value)
  return normalize(requestRegion) === normalize(configured)
}

/** The AuthorizationHeaderMalformed error, whose message names the server region. */
const regionError = (region: string) =>
  new S3Error("AuthorizationHeaderMalformed", {
    message: `The authorization header is malformed; the region is wrong; expecting '${region}'.`,
  })

/**
 * MinIO's `parseCredentialHeader`: `Credential=<key>/<yyyymmdd>/<region>/s3/aws4_request`.
 * `region` is the server region, or `""` to accept any (GetBucketLocation, ListBuckets).
 */
export const parseCredential = (
  element: string,
  region: string,
  serverRegion = region,
): Credential => {
  const trimmed = element.trim()
  const equals = trimmed.indexOf("=")
  if (equals < 0) fail("MissingFields")
  if (trimmed.slice(0, equals) !== "Credential") fail("MissingCredTag")
  const elements = trimmed
    .slice(equals + 1)
    .trim()
    .replace(/\/+$/, "")
    .split("/")
  if (elements.length < 5) fail("CredMalformed")
  const accessKey = elements.slice(0, -4).join("/")
  if (accessKey.length < 3) fail("InvalidAccessKeyID")
  const [date, scopeRegion, service, request] = elements.slice(-4) as [
    string,
    string,
    string,
    string,
  ]
  if (Number.isNaN(parseYyyymmdd(date))) fail("MalformedCredentialDate")
  if (!isValidRegion(scopeRegion, region || scopeRegion)) throw regionError(serverRegion)
  if (service !== "s3") fail("InvalidServiceS3")
  if (request !== "aws4_request") fail("InvalidRequestVersion")
  return { accessKey, date, region: scopeRegion, service, request }
}

const parseSignedHeaders = (element: string) => {
  const fields = element.trim().split("=")
  if (fields.length !== 2) fail("MissingFields")
  if (fields[0] !== "SignedHeaders") fail("MissingSignHeadersTag")
  if (!fields[1]) fail("MissingFields")
  return (fields[1] as string).split(";")
}
const parseSignature = (element: string) => {
  const fields = element.trim().split("=")
  if (fields.length !== 2) fail("MissingFields")
  if (fields[0] !== "Signature") fail("MissingSignTag")
  if (!fields[1]) fail("MissingFields")
  return fields[1] as string
}

/** MinIO's `parseSignV4` over an `Authorization` header. */
const parseSignV4 = (raw: string, region: string, serverRegion: string) => {
  const first = raw.trim().split(",")[0] ?? ""
  const credentialElement = first.startsWith(SIGN_V4) ? first.slice(SIGN_V4.length) : first
  const compact = raw.replace(/ /g, "")
  if (!compact) fail("AuthHeaderEmpty")
  if (!compact.startsWith(SIGN_V4)) fail("SignatureVersionNotSupported")
  const fields = compact.slice(SIGN_V4.length).trim().split(",")
  if (fields.length !== 3) fail("MissingFields")
  const credential = parseCredential(credentialElement.trim(), region, serverRegion)
  const signedNames = parseSignedHeaders(fields[1] as string)
  const signature = parseSignature(fields[2] as string)
  return { credential, signedNames, signature }
}

export const signingKey = async (secret: string, date: string, region: string) => {
  let key = await hmac256(encoder.encode(`AWS4${secret}`), date)
  key = await hmac256(key, region)
  key = await hmac256(key, "s3")
  return hmac256(key, "aws4_request")
}

/** The request facts signature checks read. */
export type SignedRequest = {
  method: string
  /** Decoded path (`/bucket/a b`), as Go's `URL.Path`. */
  path: string
  /** The path as sent, still percent-encoded, path-style (SigV2 signs it as is). */
  rawPath: string
  /** The query string as sent, without `?`. */
  rawQuery: string
  host: string
  headers: Headers
  query: URLSearchParams
}

const trimAll = (value: string) => value.trim().replace(/\s+/g, " ")

/** MinIO's `extractSignedHeaders`: the value of every signed header, `host` mandatory. */
const extractSignedHeaders = (names: string[], request: SignedRequest) => {
  if (!names.includes("host")) fail("UnsignedHeaders")
  const out = new Map<string, string>()
  for (const name of names) {
    const lower = name.toLowerCase()
    const value = lower === "host" ? null : request.headers.get(lower)
    if (value !== null) out.set(lower, value)
    else if (lower !== "host" && request.query.has(name))
      out.set(lower, request.query.getAll(name).join(","))
    else if (name === "expect") out.set(lower, "100-continue")
    else if (name === "host") out.set(lower, request.host)
    else if (name === "transfer-encoding") out.set(lower, "")
    else if (name === "content-length") out.set(lower, request.headers.get("content-length") ?? "0")
    else fail("UnsignedHeaders")
  }
  return [...out].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
}

/** MinIO's `checkMetaHeaders` (presigned only): every `x-amz-meta-*` header must be signed. */
const checkMetaHeaders = (signed: [string, string][], request: SignedRequest) => {
  const values = new Map(signed)
  for (const [name, value] of request.headers)
    if (name.startsWith("x-amz-meta-") && values.get(name) !== value) fail("UnsignedHeaders")
}

const canonicalRequest = (
  request: SignedRequest,
  headers: [string, string][],
  query: string,
  payload: string,
) =>
  [
    request.method,
    uriEncode(request.path, true),
    query,
    headers.map(([name, value]) => `${name}:${trimAll(value)}\n`).join(""),
    headers.map(([name]) => name).join(";"),
    payload,
  ].join("\n")

const stringToSign = async (canonical: string, stamp: string, scope: string) =>
  [SIGN_V4, stamp, scope, await sha256Hex(canonical)].join("\n")

/** What a verified V4 request proves: the key, and for streaming payloads the chunk seed. */
export type Verified = {
  accessKey: string
  /** For streaming payloads: the seed signature, signing key, scope and stamp. */
  seed?: { signature: string; key: Uint8Array; scope: string; stamp: string }
}

export type Lookup = (accessKey: string) => string | undefined

/** MinIO's `checkKeyValid`: the secret of a configured key, or InvalidAccessKeyId. */
export const checkKey = (lookup: Lookup, accessKey: string) => {
  const secret = lookup(accessKey)
  if (secret === undefined) fail("InvalidAccessKeyID")
  return secret as string
}

/** MinIO's `getContentSha256Cksum`: the payload hash a V4 signature covers. */
export const contentSha256 = (request: SignedRequest, presigned: boolean) => {
  if (presigned)
    return (
      request.query.get("X-Amz-Content-Sha256") ??
      request.headers.get("x-amz-content-sha256") ??
      UNSIGNED_PAYLOAD
    )
  return request.headers.get("x-amz-content-sha256") ?? EMPTY_SHA256
}

/** MinIO's `skipContentSha256Cksum`: no payload hash to verify. */
export const skipContentSha256 = (request: SignedRequest, presigned: boolean) => {
  const value = presigned
    ? (request.query.get("X-Amz-Content-Sha256") ?? request.headers.get("x-amz-content-sha256"))
    : request.headers.get("x-amz-content-sha256")
  return value === null || value === UNSIGNED_PAYLOAD || value === STREAMING_UNSIGNED_TRAILER
}

/**
 * MinIO's `doesSignatureMatch` for an `Authorization: AWS4-HMAC-SHA256 ...` request, signed over
 * `payload` (the `x-amz-content-sha256` value, or a streaming marker).
 */
export const verifyHeaderV4 = async (
  request: SignedRequest,
  region: string,
  serverRegion: string,
  lookup: Lookup,
  payload: string,
  options: { streaming?: boolean } = {},
): Promise<Verified> => {
  const { credential, signedNames, signature } = parseSignV4(
    request.headers.get("authorization") ?? "",
    region,
    serverRegion,
  )
  if (options.streaming && request.headers.get("x-amz-content-sha256") !== payload)
    fail("ContentSHA256Mismatch")
  const headers = extractSignedHeaders(signedNames, request)
  const secret = checkKey(lookup, credential.accessKey)
  const stamp = request.headers.get("x-amz-date") || request.headers.get("date")
  if (!stamp) fail("MissingDateHeader")
  if (Number.isNaN(parseAmzDate(stamp as string))) fail("MalformedDate")
  const query = canonicalQuery([...request.query])
  const canonical = canonicalRequest(request, headers, query, payload)
  const key = await signingKey(secret, credential.date, credential.region)
  const scope = scopeOf(credential)
  const expected = hex(await hmac256(key, await stringToSign(canonical, stamp as string, scope)))
  if (expected !== signature) fail("SignatureDoesNotMatch")
  // Chunk signatures are keyed by the request date (MinIO's `seedDate`), not the scope date.
  const day = (stamp as string).slice(0, 8)
  return {
    accessKey: credential.accessKey,
    seed: {
      signature: expected,
      key: day === credential.date ? key : await signingKey(secret, day, credential.region),
      scope: `${day}/${credential.region}/s3/aws4_request`,
      stamp: stamp as string,
    },
  }
}

const PRESIGN_PARAMS = [
  "X-Amz-Algorithm",
  "X-Amz-Credential",
  "X-Amz-Signature",
  "X-Amz-Date",
  "X-Amz-SignedHeaders",
  "X-Amz-Expires",
]
const DEFAULT_SIG_PARAMS = new Set([
  "X-Amz-Content-Sha256",
  "X-Amz-Security-Token",
  "X-Amz-Algorithm",
  "X-Amz-Date",
  "X-Amz-Expires",
  "X-Amz-SignedHeaders",
  "X-Amz-Credential",
  "X-Amz-Signature",
])
const DURATION_UNITS: Record<string, number> = {
  ns: 1e-9,
  us: 1e-6,
  µs: 1e-6,
  ms: 1e-3,
  s: 1,
  m: 60,
  h: 3600,
}

/** Go's `time.ParseDuration(value + "s")` in seconds, or NaN. */
const parseExpires = (value: string) => {
  const text = `${value}s`
  const match = /^([-+]?)((?:(?:\d+\.?\d*|\.\d+)(?:ns|us|µs|ms|s|m|h))+)$/.exec(text)
  if (!match) return Number.NaN
  let total = 0
  for (const part of (match[2] as string).matchAll(/(\d+\.?\d*|\.\d+)(ns|us|µs|ms|s|m|h)/g))
    total += Number(part[1]) * (DURATION_UNITS[part[2] as string] as number)
  return match[1] === "-" ? -total : total
}

/** MinIO's `doesPresignedSignatureMatch`. */
export const verifyPresignV4 = async (
  request: SignedRequest,
  region: string,
  serverRegion: string,
  lookup: Lookup,
  now: number,
): Promise<Verified> => {
  const query = request.query
  for (const name of PRESIGN_PARAMS) if (!query.has(name)) fail("InvalidQueryParams")
  if (query.get("X-Amz-Algorithm") !== SIGN_V4) fail("InvalidQuerySignatureAlgo")
  const credential = parseCredential(
    `Credential=${query.get("X-Amz-Credential")}`,
    region,
    serverRegion,
  )
  const date = parseAmzDate(query.get("X-Amz-Date") ?? "")
  if (Number.isNaN(date)) fail("MalformedPresignedDate")
  const expires = parseExpires(query.get("X-Amz-Expires") ?? "")
  if (Number.isNaN(expires)) fail("MalformedExpires")
  if (expires < 0) fail("NegativeExpires")
  if (expires > 604800) fail("MaximumExpires")
  const signedNames = parseSignedHeaders(`SignedHeaders=${query.get("X-Amz-SignedHeaders")}`)
  parseSignature(`Signature=${query.get("X-Amz-Signature")}`)
  const secret = checkKey(lookup, credential.accessKey)
  const headers = extractSignedHeaders(signedNames, request)
  checkMetaHeaders(headers, request)
  if (date > now + MAX_SKEW_MS) fail("RequestNotReadyYet")
  if (now - date > expires * 1000) fail("ExpiredPresignRequest")
  // MinIO rebuilds the auth parameters from what it parsed; a value that does not round-trip
  // (`X-Amz-Expires=900.5`, a credential with a trailing slash) cannot match.
  const rebuilt: [string, string][] = []
  const payload = contentSha256(request, true)
  if (query.get("X-Amz-Content-Sha256")) rebuilt.push(["X-Amz-Content-Sha256", payload])
  rebuilt.push(
    ["X-Amz-Algorithm", SIGN_V4],
    ["X-Amz-Date", query.get("X-Amz-Date") as string],
    ["X-Amz-Expires", String(Math.trunc(expires))],
    ["X-Amz-SignedHeaders", signedNames.join(";")],
    ["X-Amz-Credential", `${credential.accessKey}/${scopeOf(credential)}`],
  )
  for (const [name, value] of rebuilt)
    if (name !== "X-Amz-Algorithm" && name !== "X-Amz-Content-Sha256" && query.get(name) !== value)
      fail("SignatureDoesNotMatch")
  const pairs = [...rebuilt, ...[...query].filter(([name]) => !DEFAULT_SIG_PARAMS.has(name))]
  const canonical = canonicalRequest(request, headers, canonicalQuery(pairs), payload)
  const key = await signingKey(secret, credential.date, credential.region)
  const expected = hex(
    await hmac256(
      key,
      await stringToSign(canonical, query.get("X-Amz-Date") as string, scopeOf(credential)),
    ),
  )
  if (expected !== query.get("X-Amz-Signature")) fail("SignatureDoesNotMatch")
  return { accessKey: credential.accessKey }
}

/**
 * MinIO's `getReqAccessKeyV4`: the access key a V4 request names (the presigned credential, else
 * the `Authorization` credential), checked against the configured keys. No signature check.
 */
export const requestAccessKeyV4 = (
  request: SignedRequest,
  region: string,
  serverRegion: string,
  lookup: Lookup,
) => {
  let credential: Credential
  try {
    credential = parseCredential(
      `Credential=${request.query.get("X-Amz-Credential") ?? ""}`,
      region,
      serverRegion,
    )
  } catch {
    const header = request.headers.get("authorization") ?? ""
    const raw = header.startsWith(SIGN_V4) ? header.slice(SIGN_V4.length) : header
    const fields = raw.trim().split(",")
    if (fields.length !== 3) fail("MissingFields")
    credential = parseCredential(fields[0] as string, region, serverRegion)
  }
  checkKey(lookup, credential.accessKey)
  return credential.accessKey
}

/** MinIO's `etag.FromContentMD5`: false when `Content-MD5` is present but not a base64 MD5. */
export const validContentMd5 = (headers: Headers) => {
  const value = headers.get("content-md5")
  if (value === null) return true
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value) || !value)
    return false
  return atob(value).length === 16
}

/** The access key a request names, without verifying anything (lenient mode). */
export const claimedAccessKey = (headers: Headers, query: URLSearchParams) => {
  const header = /Credential=([^/,\s]+)/.exec(headers.get("authorization") ?? "")?.[1]
  const presigned = (query.get("X-Amz-Credential") ?? "").split("/")[0]
  const v2 =
    /^AWS ([^:]+):/.exec(headers.get("authorization") ?? "")?.[1] ?? query.get("AWSAccessKeyId")
  return header ?? (presigned || undefined) ?? v2 ?? undefined
}

/** Go's `hex.DecodeString` succeeds. */
const isHex = (value: string) => value.length % 2 === 0 && /^[0-9a-fA-F]*$/.test(value)

/** Operations whose handler authenticates itself, after its own checks (`isPutActionAllowed`). */
const PUT_ACTIONS = new Set(["PutObject", "UploadPart"])
const STREAMING_TYPES: readonly AuthType[] = [
  "streaming-signed",
  "streaming-signed-trailer",
  "streaming-unsigned-trailer",
]
/** A 5 TiB object or part is MinIO's `isMaxObjectSize`. */
const MAX_OBJECT_SIZE = 5 * 1024 ** 4

export type AuthInput = {
  op: string
  auth: AuthType
  signed: SignedRequest
  /** The server region. */
  region: string
  lookup: Lookup
  now: number
  strict: boolean
}
export type Authenticated = {
  identity: { anonymous: boolean; accessKey?: string }
  verified?: Verified
}

/** The checks PutObject and UploadPart make before they authenticate. */
const putPreflight = (op: string, auth: AuthType, request: SignedRequest) => {
  const { headers, query } = request
  if (headers.has("x-amz-copy-source")) fail("InvalidCopySource")
  if (!validContentMd5(headers)) fail("InvalidDigest")
  let size = Number(headers.get("content-length") ?? "0")
  const decoded = headers.get("x-amz-decoded-content-length")
  if (STREAMING_TYPES.includes(auth) && decoded !== null) {
    if (decoded === "") fail("MissingContentLength")
    if (!/^[+-]?\d+$/.test(decoded))
      fail("InternalError", {
        message: `We encountered an internal error, please try again.: cause(strconv.ParseInt: parsing ${JSON.stringify(decoded)}: invalid syntax)`,
      })
    size = Number(decoded)
  }
  if (size === -1) fail("MissingContentLength")
  if (op === "UploadPart") {
    const part = query.get("partNumber") ?? ""
    // Go's strconv.Atoi: anything outside int64 is a parse failure too.
    if (!/^[+-]?\d+$/.test(part) || Number(part) <= 0 || BigInt(part) > 9223372036854775807n)
      fail("InvalidPart")
  }
  if (size > MAX_OBJECT_SIZE) fail("EntityTooLarge")
  if (op === "UploadPart" && Number(query.get("partNumber")) > 10000) fail("InvalidMaxParts")
}

/** `x-amz-content-sha256` / `X-Amz-Content-Sha256` must decode as hex (`isReqAuthenticated`). */
const checkPayloadHashFormat = (request: SignedRequest, presigned: boolean, put: boolean) => {
  if (skipContentSha256(request, presigned)) return
  if (put) {
    if (!isHex(contentSha256(request, presigned))) fail("ContentSHA256Mismatch")
    return
  }
  if (presigned) {
    const value = request.query.get("X-Amz-Content-Sha256")
    if (value && !isHex(value)) fail("ContentSHA256Mismatch")
    return
  }
  const value = request.headers.get("x-amz-content-sha256")
  if (value !== null && (!value || !isHex(value))) fail("ContentSHA256Mismatch")
}

const anonymous: Authenticated = { identity: { anonymous: true } }

/**
 * Who sent the request, in MinIO's order: `authenticateRequest` (+ `isReqAuthenticated`) for
 * most operations, `isPutActionAllowed` then the signature check for PutObject / UploadPart.
 * Lenient mode checks presigned signatures only and treats everything else as the owner.
 */
export const authenticate = async (input: AuthInput): Promise<Authenticated> => {
  const { op, auth, signed, region, lookup, now, strict } = input
  if (!strict) {
    if (auth === "unknown") fail("SignatureVersionNotSupported")
    if (auth === "presigned") {
      const verified = await verifyPresignV4(signed, region, region, lookup, now)
      return { identity: { anonymous: false, accessKey: verified.accessKey }, verified }
    }
    const accessKey = claimedAccessKey(signed.headers, signed.query)
    return { identity: { anonymous: false, ...(accessKey ? { accessKey } : {}) } }
  }
  const { verifyV2, requestAccessKeyV2 } = await import("./auth-v2.js")
  if (op === "PostObject" && auth === "post-policy") return { identity: { anonymous: false } }
  // DeleteMultipleObjectsHandler's validateLengthAndChecksum runs before it authenticates.
  if (op === "DeleteObjects") {
    const md5 = signed.headers.get("content-md5")
    if (md5 && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(md5))
      fail("MissingContentMD5")
  }
  if (PUT_ACTIONS.has(op)) {
    putPreflight(op, auth, signed)
    let accessKey: string | undefined
    switch (auth) {
      case "unknown":
        fail("SignatureVersionNotSupported")
        break
      case "signed-v2":
      case "presigned-v2":
        accessKey = requestAccessKeyV2(signed, lookup)
        break
      case "signed":
      case "presigned":
      case "streaming-signed":
      case "streaming-signed-trailer":
        accessKey = requestAccessKeyV4(signed, region, region, lookup)
        break
      case "streaming-unsigned-trailer":
        try {
          accessKey = requestAccessKeyV4(signed, region, region, lookup)
        } catch (error) {
          if (!(error instanceof S3Error && error.errorName === "MissingFields")) throw error
        }
        break
    }
    if (!accessKey) return anonymous
    switch (auth) {
      case "streaming-signed":
      case "streaming-signed-trailer": {
        const payload = auth === "streaming-signed" ? STREAMING_PAYLOAD : STREAMING_PAYLOAD_TRAILER
        const verified = await verifyHeaderV4(signed, region, region, lookup, payload, {
          streaming: true,
        })
        return { identity: { anonymous: false, accessKey }, verified }
      }
      case "streaming-unsigned-trailer":
        if (signed.headers.get("authorization"))
          await verifyHeaderV4(signed, region, region, lookup, STREAMING_UNSIGNED_TRAILER)
        return { identity: { anonymous: false, accessKey } }
      case "signed-v2":
      case "presigned-v2":
        await verifyV2(signed, lookup, now, auth === "presigned-v2")
        return { identity: { anonymous: false, accessKey } }
      default: {
        const presigned = auth === "presigned"
        const verified = presigned
          ? await verifyPresignV4(signed, region, region, lookup, now)
          : await verifyHeaderV4(signed, region, region, lookup, contentSha256(signed, false))
        checkPayloadHashFormat(signed, presigned, true)
        return { identity: { anonymous: false, accessKey }, verified }
      }
    }
  }
  switch (auth) {
    case "unknown":
    case "streaming-signed":
    case "streaming-signed-trailer":
    case "streaming-unsigned-trailer":
      return fail("SignatureVersionNotSupported")
    case "signed-v2":
    case "presigned-v2": {
      const accessKey = await verifyV2(signed, lookup, now, auth === "presigned-v2")
      return { identity: { anonymous: false, accessKey } }
    }
    case "signed":
    case "presigned": {
      // GetBucketLocation and ListBuckets accept a signature scoped to any region.
      const scopeRegion = op === "GetBucketLocation" || op === "ListBuckets" ? "" : region
      const presigned = auth === "presigned"
      const verified = presigned
        ? await verifyPresignV4(signed, scopeRegion, region, lookup, now)
        : await verifyHeaderV4(signed, scopeRegion, region, lookup, contentSha256(signed, false))
      if (!validContentMd5(signed.headers)) fail("InvalidDigest")
      checkPayloadHashFormat(signed, presigned, false)
      return { identity: { anonymous: false, accessKey: verified.accessKey }, verified }
    }
    default:
      return anonymous
  }
}
