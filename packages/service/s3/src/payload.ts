/**
 * The request body as an operation sees it, as MinIO's `isReqAuthenticated`, PutObject's
 * `newSignV4ChunkedReader` / `newUnsignedV4ChunkedReader` and `hash.Reader` produce it:
 * `aws-chunked` framing removed (chunk and trailer signatures verified), the declared length
 * enforced, then `Content-MD5`, `x-amz-content-sha256` and a trailing `x-amz-checksum-*` checked.
 */
import {
  type AuthType,
  contentSha256,
  type SignedRequest,
  sha256Hex,
  skipContentSha256,
  type Verified,
} from "./auth.js"
import { CHECKSUM_ALGORITHMS, type ChecksumAlgorithm, checksum } from "./checksums.js"
import { decodeAwsChunked, readChunks } from "./chunked.js"
import { md5Base64 } from "./digest.js"
import { fail } from "./errors.js"
import type { Operation } from "./router.js"

export type Payload = { bytes(): Promise<Uint8Array>; trailers(): Promise<Record<string, string>> }

const STREAMING: readonly AuthType[] = [
  "streaming-signed",
  "streaming-signed-trailer",
  "streaming-unsigned-trailer",
]
/** Operations whose handlers read the body themselves through a `hash.Reader` of known size. */
export const PUT_OPERATIONS: readonly Operation[] = ["PutObject", "UploadPart"]

export type PayloadOptions = {
  auth: AuthType
  verified?: Verified
  op: Operation
  strict: boolean
  signed: SignedRequest
}

type Read = { bytes: Uint8Array; trailers: Record<string, string> }

const concat = (chunks: Uint8Array[]) => {
  const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/** The trailing checksum `x-amz-trailer` declares, if any. */
const trailingChecksum = (headers: Headers): ChecksumAlgorithm | undefined => {
  const declared = (headers.get("x-amz-trailer") ?? "").trim().toLowerCase()
  const algorithm = declared.replace(/^x-amz-checksum-/, "")
  return declared.startsWith("x-amz-checksum-") &&
    (CHECKSUM_ALGORITHMS as readonly string[]).includes(algorithm)
    ? (algorithm as ChecksumAlgorithm)
    : undefined
}

/** `hash.Reader` at EOF: the MD5 (BadDigest), then the SHA-256, then a trailing checksum. */
const verify = async (
  bytes: Uint8Array,
  options: PayloadOptions,
  trailers: Record<string, string>,
) => {
  const { headers } = options.signed
  const md5 = headers.get("content-md5")
  if (md5 && md5Base64(bytes) !== md5) fail("BadDigest")
  const presigned = options.auth === "presigned"
  if ((options.auth === "signed" || presigned) && !skipContentSha256(options.signed, presigned)) {
    const expected = contentSha256(options.signed, presigned).toLowerCase()
    // Lenient mode only checks a well-formed hash (MinIO refuses a malformed one up front).
    const checked = options.strict ? expected !== "" : /^[0-9a-f]{64}$/.test(expected)
    if (checked && (await sha256Hex(bytes)) !== expected) fail("ContentSHA256Mismatch")
  }
  const algorithm =
    options.strict && STREAMING.includes(options.auth) ? trailingChecksum(headers) : undefined
  if (algorithm) {
    const value = trailers[`x-amz-checksum-${algorithm}`] ?? ""
    if (!value || (await checksum(algorithm, bytes)) !== value) fail("ContentChecksumMismatch")
  }
}

/** PutObject / UploadPart in strict mode: MinIO's readers, byte for byte. */
const readStrictPut = async (raw: Uint8Array, options: PayloadOptions): Promise<Read> => {
  const { headers } = options.signed
  const streaming = STREAMING.includes(options.auth)
  const decoded = headers.get("x-amz-decoded-content-length")
  const size = streaming && decoded !== null ? Number(decoded) : raw.length
  if (!streaming) {
    await verify(raw, options, {})
    return { bytes: raw, trailers: {} }
  }
  const chunks: Uint8Array[] = []
  let total = 0
  const result = await readChunks(raw, {
    ...(options.auth !== "streaming-unsigned-trailer" && options.verified?.seed
      ? { seed: options.verified.seed }
      : {}),
    ...(options.auth !== "streaming-signed"
      ? {
          trailers: (headers.get("x-amz-trailer") ?? "")
            .split(",")
            .map((name) => name.trim())
            .filter(Boolean),
        }
      : {}),
    onData(data) {
      total += data.length
      // ioutil.HardLimitReader: reading past the declared length fails at once.
      if (total > size) fail("ExcessData")
      chunks.push(data)
    },
  })
  const bytes = concat(chunks)
  if (result.end === "eof") await verify(bytes, options, result.trailers)
  if (total < size) fail("IncompleteBody")
  return { bytes, trailers: result.trailers }
}

/** Every other request (and lenient mode): the body as sent, digests checked when read. */
const readOther = async (raw: Uint8Array, options: PayloadOptions): Promise<Read> => {
  const { headers } = options.signed
  if (options.op === "PostObject") return { bytes: raw, trailers: {} }
  let bytes: Uint8Array = raw
  let trailers: Record<string, string> = {}
  const chunked =
    STREAMING.includes(options.auth) ||
    (headers.get("content-encoding") ?? "").split(",").some((v) => v.trim() === "aws-chunked")
  if (!options.strict && chunked && headers.has("x-amz-decoded-content-length")) {
    const decoded = decodeAwsChunked(raw)
    if (!decoded) fail("IncompleteBody")
    bytes = decoded?.payload ?? raw
    trailers = decoded?.trailers ?? {}
    if (Number(headers.get("x-amz-decoded-content-length")) !== bytes.length) fail("IncompleteBody")
    const md5 = headers.get("content-md5")
    if (md5 !== null && md5Base64(bytes) !== md5) fail("BadDigest")
    return { bytes, trailers }
  }
  await verify(bytes, options, trailers)
  return { bytes, trailers }
}

export const readPayload = (request: Request, options: PayloadOptions): Payload => {
  let read: Promise<Read> | undefined
  const load = () => {
    read ??= (async () => {
      const raw = new Uint8Array(await request.arrayBuffer())
      return options.strict && PUT_OPERATIONS.includes(options.op)
        ? readStrictPut(raw, options)
        : readOther(raw, options)
    })()
    return read
  }
  return {
    bytes: async () => (await load()).bytes,
    trailers: async () => (await load()).trailers,
  }
}
