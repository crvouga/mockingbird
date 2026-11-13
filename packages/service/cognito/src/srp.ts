/**
 * The server half of Cognito's SRP-6a password verifier (USER_SRP_AUTH), matching the client
 * math in amazon-cognito-identity-js's AuthenticationHelper: the 3072-bit RFC 5054 group with
 * g = 2, k = H(N | g), x = H(salt | H(poolName + username + ":" + password)), and an HKDF of the
 * shared secret keyed by u ("Caldera Derived Key") signing poolName + username + secret block +
 * timestamp. The emulator stores the password, so it derives the verifier per sign-in.
 */
const N = BigInt(
  `0x${[
    "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DD",
    "EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED",
    "EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F",
    "83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B",
    "E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D2261898FA0510",
    "15728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7",
    "ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6BF12FFA06D98A0864D87602733EC86A64521F2B18177B200C",
    "BBE117577A615D6C770988C0BAD946E208E24FA074E5AB3143DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF",
  ].join("")}`,
)
const g = 2n
const encoder = new TextEncoder()

const modPow = (base: bigint, exponent: bigint, modulus: bigint) => {
  let result = 1n
  let b = ((base % modulus) + modulus) % modulus
  let e = exponent
  while (e > 0n) {
    if (e & 1n) result = (result * b) % modulus
    b = (b * b) % modulus
    e >>= 1n
  }
  return result
}
/** Even-length hex, with a leading 00 when the high bit is set (a positive two's-complement). */
const padHex = (value: bigint) => {
  const hex = value.toString(16)
  const even = hex.length % 2 ? `0${hex}` : hex
  return /^[89a-f]/i.test(even) ? `00${even}` : even
}
const hexBytes = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16))
const toHex = (bytes: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}
const sha256 = async (bytes: Uint8Array) =>
  toHex(await crypto.subtle.digest("SHA-256", bytes as BufferSource))
const hmac = async (key: Uint8Array, data: Uint8Array) =>
  new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      await crypto.subtle.importKey(
        "raw",
        key as BufferSource,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      ),
      data as BufferSource,
    ),
  )
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
const fromBase64 = (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0))

let k: Promise<bigint> | undefined
/** k = H(N | g), computed on first use so importing the module does no work. */
const multiplier = () => {
  k ??= sha256(hexBytes(padHex(N) + padHex(g))).then((hex) => BigInt(`0x${hex}`))
  return k
}

/** What the server keeps between the PASSWORD_VERIFIER challenge and its response. */
export type SrpChallenge = { a: string; b: string; salt: string; secretBlock: string }

/** The pool name half of a pool id (`us-east-1_abc` → `abc`), as the client library uses. */
export const poolName = (poolId: string) => poolId.split("_")[1] ?? poolId

/** Undefined when SRP_A is not a usable public value (missing, not hex, or 0 mod N). */
export async function startSrp(srpA: unknown, entropy: string): Promise<SrpChallenge | undefined> {
  if (typeof srpA !== "string" || !/^[0-9a-f]+$/i.test(srpA)) return undefined
  if (BigInt(`0x${srpA}`) % N === 0n) return undefined
  // b, the salt and the secret block come from the namespace's seeded sequence (via `entropy`),
  // so a run stays reproducible; the client's random A keeps each exchange unique.
  const b = BigInt(`0x${await sha256(encoder.encode(`b:${entropy}`))}`)
  const salt = (await sha256(encoder.encode(`salt:${entropy}`))).slice(0, 32)
  const secretBlock = base64(hexBytes(await sha256(encoder.encode(`block:${entropy}`))))
  return { a: srpA, b: b.toString(16), salt, secretBlock }
}

const verifier = async (pool: string, username: string, password: string, salt: string) => {
  const inner = await sha256(encoder.encode(`${pool}${username}:${password}`))
  const x = BigInt(`0x${await sha256(hexBytes(padHex(BigInt(`0x${salt}`)) + inner))}`)
  return modPow(g, x, N)
}
/** B = k·v + g^b mod N for the user's password. */
export async function serverB(
  challenge: SrpChallenge,
  pool: string,
  username: string,
  password: string,
) {
  const v = await verifier(pool, username, password, challenge.salt)
  return ((await multiplier()) * v + modPow(g, BigInt(`0x${challenge.b}`), N)) % N
}

/** Whether PASSWORD_CLAIM_SIGNATURE proves knowledge of the password. */
export async function verifySrp(
  challenge: SrpChallenge,
  pool: string,
  username: string,
  password: string,
  claim: { secretBlock: unknown; timestamp: unknown; signature: unknown },
): Promise<boolean> {
  if (
    typeof claim.timestamp !== "string" ||
    typeof claim.signature !== "string" ||
    claim.secretBlock !== challenge.secretBlock
  )
    return false
  const A = BigInt(`0x${challenge.a}`)
  const B = await serverB(challenge, pool, username, password)
  const u = BigInt(`0x${await sha256(hexBytes(padHex(A) + padHex(B)))}`)
  if (u === 0n) return false
  const v = await verifier(pool, username, password, challenge.salt)
  const S = modPow(A * modPow(v, u, N), BigInt(`0x${challenge.b}`), N)
  const prk = await hmac(hexBytes(padHex(u)), hexBytes(padHex(S)))
  const key = (
    await hmac(prk, concat(encoder.encode("Caldera Derived Key"), Uint8Array.of(1)))
  ).slice(0, 16)
  const expected = await hmac(
    key,
    concat(
      encoder.encode(pool),
      encoder.encode(username),
      fromBase64(challenge.secretBlock),
      encoder.encode(claim.timestamp),
    ),
  )
  return base64(expected) === claim.signature
}
