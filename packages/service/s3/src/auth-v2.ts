/** AWS Signature Version 2 (header and presigned), as MinIO's `cmd/signature-v2.go` checks it. */
import { checkKey, hmacRaw, type Lookup, SIGN_V4, type SignedRequest } from "./auth.js"
import { fail } from "./errors.js"

const encoder = new TextEncoder()

/** The sub-resources a V2 signature covers, in MinIO's `resourceList` order. */
const RESOURCES = [
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

const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))

/** Go's `url.QueryUnescape`: `+` is a space, a bad `%` escape is an error (`undefined`). */
const queryUnescape = (value: string) => {
  if (/%(?![0-9A-Fa-f]{2})/.test(value)) return undefined
  try {
    return decodeURIComponent(value.replace(/\+/g, " "))
  } catch {
    // Go keeps invalid UTF-8 bytes; decode them one by one.
    return value
      .replace(/\+/g, " ")
      .replace(/%([0-9A-Fa-f]{2})/g, (_, code: string) =>
        String.fromCharCode(Number.parseInt(code, 16)),
      )
  }
}

const unescapeQueries = (rawQuery: string) => {
  const out: string[] = []
  for (const query of rawQuery.split("&")) {
    const value = queryUnescape(query)
    if (value === undefined) fail("InvalidQueryParams")
    out.push(value as string)
  }
  return out
}

/** `x-amz-*` headers, lowercased, sorted, multi-values joined with `,`. */
const canonicalAmzHeaders = (headers: Headers) => {
  const lines: [string, string][] = []
  for (const [name, value] of headers) if (name.startsWith("x-amz-")) lines.push([name, value])
  return lines
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}:${value}`)
    .join("\n")
}

const canonicalResource = (resource: string, query: string) => {
  const values = new Map<string, string>()
  for (const entry of query.split("&")) {
    const index = entry.indexOf("=")
    if (index < 0) values.set(entry, "")
    else values.set(entry.slice(0, index), entry.slice(index + 1))
  }
  const parts: string[] = []
  for (const name of RESOURCES) {
    const value = values.get(name)
    if (value === undefined) continue
    parts.push(value === "" ? name : `${name}=${value}`)
  }
  return parts.length ? `${resource}?${parts.join("&")}` : resource
}

const stringToSign = (request: SignedRequest, query: string, date: string) => {
  let amz = canonicalAmzHeaders(request.headers)
  if (amz) amz += "\n"
  return (
    [
      request.method,
      request.headers.get("content-md5") ?? "",
      request.headers.get("content-type") ?? "",
      date,
      amz,
    ].join("\n") + canonicalResource(request.rawPath, query)
  )
}

const sign = async (secret: string, value: string) =>
  base64(await hmacRaw("SHA-1", encoder.encode(secret), value))

/** Go's `base64.StdEncoding.DecodeString`, or undefined. */
const decode64 = (value: string) => {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
    return undefined
  return atob(value)
}
const sameSignature = (a: string, b: string) => {
  const left = decode64(a)
  const right = decode64(b)
  return left !== undefined && right !== undefined && left === right
}

/** MinIO's `getReqAccessKeyV2`: the presigned `AWSAccessKeyId`, else `AWS <key>:<signature>`. */
export const requestAccessKeyV2 = (request: SignedRequest, lookup: Lookup) => {
  const presigned = request.query.get("AWSAccessKeyId")
  if (presigned) {
    checkKey(lookup, presigned)
    return presigned
  }
  const fields = (request.headers.get("authorization") ?? "").split(" ")
  if (fields.length !== 2) fail("MissingFields")
  const keySign = (fields[1] as string).trim().split(":")
  if (keySign.length !== 2) fail("MissingFields")
  checkKey(lookup, keySign[0] as string)
  return keySign[0] as string
}

/** MinIO's `doesSignV2Match`. */
const verifyHeaderV2 = async (request: SignedRequest, lookup: Lookup) => {
  const header = request.headers.get("authorization") ?? ""
  if (!header) fail("AuthHeaderEmpty")
  if (!header.startsWith("AWS") || header.startsWith(SIGN_V4)) fail("SignatureVersionNotSupported")
  const accessKey = requestAccessKeyV2(request, lookup)
  const secret = checkKey(lookup, accessKey)
  const queries = unescapeQueries(request.rawQuery)
  const prefix = `AWS ${accessKey}:`
  if (!header.startsWith(prefix)) fail("SignatureDoesNotMatch")
  const expected = await sign(
    secret,
    stringToSign(request, queries.join("&"), request.headers.get("date") ?? ""),
  )
  if (!sameSignature(header.slice(prefix.length), expected)) fail("SignatureDoesNotMatch")
  return accessKey
}

/** MinIO's `doesPresignV2SignatureMatch`. */
const verifyPresignV2 = async (request: SignedRequest, lookup: Lookup, now: number) => {
  const filtered: string[] = []
  let signature = ""
  let expires = ""
  let accessKey = ""
  for (const query of unescapeQueries(request.rawQuery)) {
    const index = query.indexOf("=")
    if (index < 0) fail("InvalidQueryParams")
    const name = query.slice(0, index)
    const value = query.slice(index + 1)
    if (name === "AWSAccessKeyId") accessKey = value
    else if (name === "Signature") signature = value
    else if (name === "Expires") expires = value
    else filtered.push(query)
  }
  if (!accessKey || !signature || !expires) fail("InvalidQueryParams")
  const secret = checkKey(lookup, accessKey)
  if (!/^[+-]?\d+$/.test(expires)) fail("MalformedExpires")
  if (Number(expires) < Math.floor(now / 1000)) fail("ExpiredPresignRequest")
  const expected = await sign(secret, stringToSign(request, filtered.join("&"), expires))
  if (!sameSignature(signature, expected)) fail("SignatureDoesNotMatch")
  return accessKey
}

/** MinIO's `isReqAuthenticatedV2` then `getReqAccessKeyV2`: the verified access key. */
export const verifyV2 = async (
  request: SignedRequest,
  lookup: Lookup,
  now: number,
  presigned: boolean,
): Promise<string> => {
  if (presigned) await verifyPresignV2(request, lookup, now)
  else await verifyHeaderV2(request, lookup)
  return requestAccessKeyV2(request, lookup)
}
