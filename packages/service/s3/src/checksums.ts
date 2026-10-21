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
let table64: bigint[] | undefined
const crc64nvme = (bytes: Uint8Array) => {
  table64 ??= Array.from({ length: 256 }, (_, index) => {
    let value = BigInt(index)
    for (let bit = 0; bit < 8; bit++)
      value = value & 1n ? (value >> 1n) ^ POLYNOMIAL_64 : value >> 1n
    return value
  })
  let crc = 0xffffffffffffffffn
  for (const byte of bytes)
    crc = (table64[Number((crc ^ BigInt(byte)) & 0xffn)] as bigint) ^ (crc >> 8n)
  return crc ^ 0xffffffffffffffffn
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
