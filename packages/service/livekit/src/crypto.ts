const encoder = new TextEncoder()
const bytesToBase64 = (bytes: Uint8Array) => {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}
export const base64url = (bytes: Uint8Array) =>
  bytesToBase64(bytes).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")
export const decode64url = (value: string) => {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"))
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}
export const hmac = async (secret: string, value: string) => {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)))
}
export const jwt = async (secret: string, claims: Record<string, unknown>) => {
  const head = base64url(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })))
  const payload = base64url(encoder.encode(JSON.stringify(claims)))
  return `${head}.${payload}.${base64url(await hmac(secret, `${head}.${payload}`))}`
}
export const verifyJwt = async (
  token: string,
  secrets: Readonly<Record<string, string>>,
  now: number,
) => {
  const [head, body, signature] = token.split(".")
  if (!head || !body || !signature) return undefined
  try {
    const header = JSON.parse(new TextDecoder().decode(decode64url(head))) as Record<
      string,
      unknown
    >
    const claims = JSON.parse(new TextDecoder().decode(decode64url(body))) as Record<
      string,
      unknown
    >
    if (header.alg !== "HS256" || typeof claims.iss !== "string" || !secrets[claims.iss])
      return undefined
    const expected = base64url(await hmac(secrets[claims.iss] as string, `${head}.${body}`))
    if (signature !== expected) return undefined
    const seconds = Math.floor(now / 1000)
    if (
      typeof claims.exp !== "number" ||
      claims.exp < seconds ||
      (typeof claims.nbf === "number" && claims.nbf > seconds + 10)
    )
      return undefined
    return claims
  } catch {
    return undefined
  }
}
export const bodySha256 = async (body: string) =>
  bytesToBase64(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(body))))
