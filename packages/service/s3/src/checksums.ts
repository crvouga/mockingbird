/** The additional checksum algorithms S3 verifies (`x-amz-checksum-<algorithm>`, base64 of the digest). */
const table = (polynomial: number) =>
  Array.from({ length: 256 }, (_, index) => {
    let value = index
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ polynomial : value >>> 1
    return value >>> 0
  })
const CRC32_TABLE = table(0xedb88320)
const CRC32C_TABLE = table(0x82f63b78)
const crc32 = (bytes: Uint8Array, lookup: number[]) => {
  let crc = 0xffffffff
  for (const byte of bytes) crc = (lookup[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
const POLYNOMIAL_64 = 0x9a6c9329ac4bc9b5n
/** The reflected CRC-64/NVME table, split into 32-bit halves so the hot loop never allocates. */
let table64: { hi: Uint32Array; lo: Uint32Array } | undefined
const crc64nvme = (bytes: Uint8Array) => {
  if (!table64) {
    const hi = new Uint32Array(256)
    const lo = new Uint32Array(256)
    for (let index = 0; index < 256; index++) {
      let value = BigInt(index)
      for (let bit = 0; bit < 8; bit++)
        value = value & 1n ? (value >> 1n) ^ POLYNOMIAL_64 : value >> 1n
      hi[index] = Number(value >> 32n)
      lo[index] = Number(value & 0xffffffffn)
    }
    table64 = { hi, lo }
  }
  const { hi, lo } = table64
  let crcHi = 0xffffffff
  let crcLo = 0xffffffff
  for (let index = 0; index < bytes.length; index++) {
    const slot = (crcLo ^ (bytes[index] as number)) & 0xff
    // crc >> 8, then xor the table entry
    crcLo = ((crcLo >>> 8) | (crcHi << 24)) ^ (lo[slot] as number)
    crcHi = (crcHi >>> 8) ^ (hi[slot] as number)
  }
  return (BigInt((crcHi ^ 0xffffffff) >>> 0) << 32n) | BigInt((crcLo ^ 0xffffffff) >>> 0)
}
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
const big = (value: number | bigint, width: number) => {
  const out = new Uint8Array(width)
  let rest = BigInt(value)
  for (let index = width - 1; index >= 0; index--) {
    out[index] = Number(rest & 0xffn)
    rest >>= 8n
  }
  return out
}
const subtle = async (algorithm: "SHA-1" | "SHA-256", bytes: Uint8Array) =>
  new Uint8Array(await crypto.subtle.digest(algorithm, bytes as BufferSource))

export const CHECKSUM_ALGORITHMS = ["crc32", "crc32c", "crc64nvme", "sha1", "sha256"] as const
export type ChecksumAlgorithm = (typeof CHECKSUM_ALGORITHMS)[number]

/** The base64 digest S3 would report for `bytes`. */
export const checksum = async (algorithm: ChecksumAlgorithm, bytes: Uint8Array) => {
  switch (algorithm) {
    case "crc32":
      return base64(big(crc32(bytes, CRC32_TABLE), 4))
    case "crc32c":
      return base64(big(crc32(bytes, CRC32C_TABLE), 4))
    case "crc64nvme":
      return base64(big(crc64nvme(bytes), 8))
    case "sha1":
      return base64(await subtle("SHA-1", bytes))
    case "sha256":
      return base64(await subtle("SHA-256", bytes))
  }
}

/** A request's checksum as MinIO's `hash.GetContentChecksum` reads it. */
export type RequestChecksum = {
  algorithm: ChecksumAlgorithm
  /** The base64 digest to verify; `""` while it is still to come in a trailer. */
  value: string
  /** `x-amz-checksum-type: FULL_OBJECT` (CRC only), or a `-<parts>` suffix (COMPOSITE). */
  type: "FULL_OBJECT" | "COMPOSITE"
  /** The `-<parts>` suffix of a composite value. */
  parts?: number
  trailing: boolean
}

const RAW_LENGTH: Record<ChecksumAlgorithm, number> = {
  crc32: 4,
  crc32c: 4,
  crc64nvme: 8,
  sha1: 20,
  sha256: 32,
}
/** MinIO's `BaseChecksumTypes` order, which decides which of several headers is seen first. */
const HEADER_ORDER: readonly ChecksumAlgorithm[] = [
  "sha256",
  "sha1",
  "crc32",
  "crc64nvme",
  "crc32c",
]
const CAN_MERGE = new Set<ChecksumAlgorithm>(["crc32", "crc32c", "crc64nvme"])

const decodedLength = (value: string): number | undefined => {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) return undefined
  try {
    return atob(value).length
  } catch {
    return undefined
  }
}

/** The invalid-checksum signal: the caller answers `InvalidChecksum`. */
export class InvalidChecksumError extends Error {}

const withValue = (algorithm: ChecksumAlgorithm, raw: string, full: boolean): RequestChecksum => {
  let value = raw
  let parts: number | undefined
  if (raw.includes("-")) {
    const split = raw.split("-")
    if (split.length !== 2 || !/^[+-]?\d+$/.test(split[1] as string))
      throw new InvalidChecksumError()
    value = split[0] as string
    parts = Number(split[1])
  }
  if (decodedLength(value) !== RAW_LENGTH[algorithm]) throw new InvalidChecksumError()
  return {
    algorithm,
    value,
    type: parts !== undefined && !full && algorithm !== "crc64nvme" ? "COMPOSITE" : "FULL_OBJECT",
    ...(parts !== undefined ? { parts } : {}),
    trailing: false,
  }
}

/**
 * The checksum a PUT carries (`x-amz-trailer`, `x-amz-checksum-algorithm` or one
 * `x-amz-checksum-<algorithm>` header), `undefined` for none. Throws InvalidChecksumError where
 * MinIO answers InvalidChecksum.
 */
export const requestChecksum = (headers: Headers): RequestChecksum | undefined => {
  const type = headers.get("x-amz-checksum-type") ?? ""
  const trailer = headers.get("x-amz-trailer")
  if (trailer) {
    let found: ChecksumAlgorithm | undefined
    for (const name of trailer.split(",").map((part) => part.trim())) {
      const algorithm = HEADER_ORDER.find(
        (candidate) => `x-amz-checksum-${candidate}` === name.toLowerCase(),
      )
      if (!algorithm) continue
      if (found) throw new InvalidChecksumError()
      found = algorithm
    }
    if (found) {
      if (type === "FULL_OBJECT" && !CAN_MERGE.has(found)) throw new InvalidChecksumError()
      if (type !== "" && type !== "FULL_OBJECT" && type !== "COMPOSITE")
        throw new InvalidChecksumError()
      return { algorithm: found, value: "", type: "FULL_OBJECT", trailing: true }
    }
  }
  const named = headers.get("x-amz-checksum-algorithm")
  if (named) {
    const algorithm = named.toLowerCase() as ChecksumAlgorithm
    if (!CHECKSUM_ALGORITHMS.includes(algorithm)) throw new InvalidChecksumError()
    if (type !== "" && type !== "FULL_OBJECT" && type !== "COMPOSITE")
      throw new InvalidChecksumError()
    if (type === "FULL_OBJECT" && !CAN_MERGE.has(algorithm)) throw new InvalidChecksumError()
    const value = headers.get(`x-amz-checksum-${algorithm}`) ?? ""
    if (!value) return undefined
    return withValue(algorithm, value, type === "FULL_OBJECT")
  }
  let found: [ChecksumAlgorithm, string] | undefined
  for (const algorithm of HEADER_ORDER) {
    const value = headers.get(`x-amz-checksum-${algorithm}`)
    if (!value) continue
    if (found) throw new InvalidChecksumError()
    found = [algorithm, value]
  }
  if (!found) return undefined
  if (type === "FULL_OBJECT" && !CAN_MERGE.has(found[0])) throw new InvalidChecksumError()
  return withValue(found[0], found[1], type === "FULL_OBJECT")
}
