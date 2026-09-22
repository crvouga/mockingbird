/**
 * ES384 JSON Web Tokens over WebCrypto (`crypto.subtle`), the signing algorithm the
 * self-hosted server uses — available in every modern JavaScript runtime, no Node APIs.
 */

export type JwtPayload = Record<string, unknown>

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export const base64UrlEncode = (bytes: Uint8Array): string => {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

export const base64UrlDecode = (text: string): Uint8Array<ArrayBuffer> => {
  const padded = text.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((text.length + 3) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

const encodeJson = (value: unknown) => base64UrlEncode(encoder.encode(JSON.stringify(value)))

export type SigningKey = {
  kid: string
  privateKey: CryptoKey
  publicKey: CryptoKey
  publicJwk: JsonWebKey
}

const ALGORITHM = { name: "ECDSA", namedCurve: "P-384" } as const
const SIGN = { name: "ECDSA", hash: "SHA-384" } as const

export const generateSigningKey = async (kid: string): Promise<SigningKey> => {
  const pair = (await crypto.subtle.generateKey(ALGORITHM, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair
  const publicJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey
  return {
    kid,
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    publicJwk: { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y },
  }
}

export const signJwt = async (key: SigningKey, payload: JwtPayload): Promise<string> => {
  const header = encodeJson({ alg: "ES384", kid: key.kid, typ: "JWT" })
  const body = encodeJson(payload)
  const signature = await crypto.subtle.sign(
    SIGN,
    key.privateKey,
    encoder.encode(`${header}.${body}`),
  )
  return `${header}.${body}.${base64UrlEncode(new Uint8Array(signature))}`
}

/** Decode without verifying. Undefined when it is not a JWT. */
export const decodeJwt = (
  token: string,
): { header: JwtPayload; payload: JwtPayload } | undefined => {
  const parts = token.split(".")
  if (parts.length !== 3) return undefined
  try {
    return {
      header: JSON.parse(decoder.decode(base64UrlDecode(parts[0] as string))) as JwtPayload,
      payload: JSON.parse(decoder.decode(base64UrlDecode(parts[1] as string))) as JwtPayload,
    }
  } catch {
    return undefined
  }
}

/**
 * Verify signature, issuer and time claims; resolves the payload, or undefined when the token
 * is not one this key signed or is outside its validity window at `now` (epoch ms).
 */
export const verifyJwt = async (
  key: SigningKey,
  token: string,
  options: { issuer: string; now: number },
): Promise<JwtPayload | undefined> => {
  const decoded = decodeJwt(token)
  if (decoded?.header.alg !== "ES384" || decoded.header.kid !== key.kid) return undefined
  const [header, body, signature] = token.split(".") as [string, string, string]
  let valid = false
  try {
    valid = await crypto.subtle.verify(
      SIGN,
      key.publicKey,
      base64UrlDecode(signature) as Uint8Array<ArrayBuffer>,
      encoder.encode(`${header}.${body}`),
    )
  } catch {
    return undefined
  }
  if (!valid) return undefined
  const { payload } = decoded
  const seconds = Math.floor(options.now / 1000)
  if (payload.iss !== options.issuer) return undefined
  if (typeof payload.exp === "number" && payload.exp < seconds) return undefined
  if (typeof payload.nbf === "number" && payload.nbf > seconds + 60) return undefined
  return payload
}

/** SHA-256, base64url (PKCE `S256` code challenges). */
export const sha256Base64Url = async (value: string): Promise<string> =>
  base64UrlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))))

/** SHA-256 hex, for the mock's password hashes. */
export const sha256Hex = async (value: string): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
