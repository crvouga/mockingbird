import { createHash, randomBytes, timingSafeEqual } from "node:crypto"

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"

/** Unbiased random string over a 36-character alphabet. */
export function randomString(length: number): string {
  let out = ""
  while (out.length < length) {
    for (const byte of randomBytes(length)) {
      // 252 = 7 * 36: reject the tail so every character is equally likely.
      if (byte < 252 && out.length < length) out += ALPHABET[byte % 36]
    }
  }
  return out
}

export const newId = (prefix: string) => `${prefix}_${randomString(20)}`

/** A bearer secret. 256 bits, so a plain SHA-256 is a sufficient at-rest hash. */
export const newSecret = () => randomBytes(32).toString("base64url")

export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex")

export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

export const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/

/** Lowercase, hyphenated, at most 32 characters; empty when nothing usable remains. */
export const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "")
