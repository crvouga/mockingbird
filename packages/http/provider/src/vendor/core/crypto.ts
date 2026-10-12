import { hmac } from "@noble/hashes/hmac.js"
import { sha1 } from "@noble/hashes/legacy.js"
import { md5 } from "@noble/hashes/legacy.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { Buffer } from "buffer"

const digest = (algorithm: string) => {
  if (algorithm === "sha256") return sha256
  if (algorithm === "sha1") return sha1
  if (algorithm === "md5") return md5
  throw new Error(`Unsupported digest ${algorithm}`)
}
const bytes = (input: string | Uint8Array) => typeof input === "string" ? new TextEncoder().encode(input) : input
interface Hash {
  update(input: string | Uint8Array): Hash
  digest(): Buffer
  digest(encoding: string): string
}
export function createHash(algorithm: string): Hash {
  const parts: Uint8Array[] = []
  const hash = {
    update(input: string | Uint8Array) { parts.push(bytes(input)); return hash },
    digest(encoding?: string): Buffer | string {
      const result = Buffer.from(digest(algorithm)(Buffer.concat(parts)))
      return encoding === "base64url" ? result.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : encoding ? result.toString(encoding as BufferEncoding) : result
    },
  }
  return hash as Hash
}
export function createHmac(algorithm: string, key: string | Uint8Array): Hash {
  const parts: Uint8Array[] = []
  const hash = {
    update(input: string | Uint8Array) { parts.push(bytes(input)); return hash },
    digest(encoding?: string): Buffer | string {
      const result = Buffer.from(hmac(digest(algorithm), bytes(key), Buffer.concat(parts)))
      return encoding === "base64url" ? result.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : encoding ? result.toString(encoding as BufferEncoding) : result
    },
  }
  return hash as Hash
}
/**
 * Mockingbird: where ids and tokens come from. With a seeded stream in place, everything the
 * vendor code mints replays from the seed; without one it is the platform's own randomness.
 */
let source: (() => number) | undefined
/** Mint from `next` (a seeded stream of `[0, 1)`) until told otherwise. */
export function useRandom(next: (() => number) | undefined): void { source = next }
/** Mint from `next` for one synchronous section, then put the previous source back. */
export function withRandom<T>(next: (() => number) | undefined, run: () => T): T {
  const previous = source
  source = next
  try { return run() } finally { source = previous }
}
/** `Math.random`, from the seeded stream when one is in place. */
export function random(): number { return source ? source() : Math.random() }
export function randomBytes(length: number): Buffer {
  if (!source) return Buffer.from(crypto.getRandomValues(new Uint8Array(length)))
  const out = new Uint8Array(length)
  for (let i = 0; i < length; i++) out[i] = Math.floor(source() * 256)
  return Buffer.from(out)
}
export function randomUUID(): string {
  if (!source) return crypto.randomUUID()
  const b = randomBytes(16)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const hex = b.toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) throw new Error("Buffers must have equal lengths")
  let difference = 0
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i]
  return difference === 0
}
