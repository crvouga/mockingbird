/**
 * HMAC and encoding primitives for vendor webhook signatures, over WebCrypto so they run
 * wherever the mocks do (Node, Bun, workers).
 */

export type HmacAlgorithm = "SHA-1" | "SHA-256" | "SHA-512"
export type ByteEncoding = "hex" | "base64"

const encoder = new TextEncoder()

export const toBase64 = (bytes: ArrayBuffer | Uint8Array): string => {
  let binary = ""
  for (const byte of bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

export const fromBase64 = (value: string): Uint8Array =>
  Uint8Array.from(atob(value), (char) => char.charCodeAt(0))

export const toHex = (bytes: ArrayBuffer | Uint8Array): string =>
  [...(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")

const keyBytes = (key: string | Uint8Array): Uint8Array =>
  typeof key === "string" ? encoder.encode(key) : key

/** HMAC of `message` under `key` (a UTF-8 string or raw bytes), encoded as hex or base64. */
export const hmac = async (
  algorithm: HmacAlgorithm,
  key: string | Uint8Array,
  message: string | Uint8Array,
  encoding: ByteEncoding = "hex",
): Promise<string> => {
  const imported = await crypto.subtle.importKey(
    "raw",
    keyBytes(key) as BufferSource,
    { name: "HMAC", hash: algorithm },
    false,
    ["sign"],
  )
  const signed = await crypto.subtle.sign(
    "HMAC",
    imported,
    (typeof message === "string" ? encoder.encode(message) : message) as BufferSource,
  )
  return encoding === "hex" ? toHex(signed) : toBase64(signed)
}

/** SHA digest of `input`, hex-encoded. */
export const sha = async (
  algorithm: "SHA-1" | "SHA-256" | "SHA-512",
  input: string | Uint8Array,
): Promise<string> =>
  toHex(
    await crypto.subtle.digest(
      algorithm,
      (typeof input === "string" ? encoder.encode(input) : input) as BufferSource,
    ),
  )

/**
 * The raw key of a Svix-style secret: `whsec_<base64>` (Svix, Resend, Junction) or
 * `fwhsec_<base64>` (Flex). A bare base64 secret is accepted too.
 */
export const svixSecretBytes = (secret: string): Uint8Array => {
  const raw = secret.replace(/^f?whsec_/, "")
  try {
    return fromBase64(raw)
  } catch {
    throw new TypeError("webhook secret must be whsec_<base64> (as Svix issues it)")
  }
}

/** `v1,<base64 HMAC-SHA256>` over `"<id>.<timestamp>.<body>"`, as Svix signs. */
export const signSvix = async (
  secret: string,
  messageId: string,
  timestampSeconds: number,
  body: string,
): Promise<string> =>
  `v1,${await hmac("SHA-256", svixSecretBytes(secret), `${messageId}.${timestampSeconds}.${body}`, "base64")}`

/** `t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`, as Stripe (and Persona) sign. */
export const signTimestamped = async (
  secret: string,
  timestampSeconds: number,
  body: string,
): Promise<string> =>
  `t=${timestampSeconds},v1=${await hmac("SHA-256", secret, `${timestampSeconds}.${body}`, "hex")}`

/**
 * Twilio's `X-Twilio-Signature`: base64 HMAC-SHA1 of the full URL followed by every form
 * parameter as `key + value`, keys sorted. Sign against the public URL the app is
 * configured with, not the address the request is actually posted to.
 */
export const signTwilio = async (
  authToken: string,
  url: string,
  params: Record<string, string>,
): Promise<string> => {
  const payload =
    url +
    Object.keys(params)
      .sort()
      .map((key) => `${key}${params[key]}`)
      .join("")
  return hmac("SHA-1", authToken, payload, "base64")
}

/** Constant-time string comparison, so a verifier in a test double does not leak timing. */
export const timingSafeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
