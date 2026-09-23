const encoder = new TextEncoder()
export const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
export const random = (): string => base64url(crypto.getRandomValues(new Uint8Array(32)))
export const hash = async (value: string): Promise<string> =>
  base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))))
export class Signer {
  private readonly pair = crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )
  readonly kid = random()
  async jwks() {
    const pair = await this.pair
    return {
      keys: [
        {
          ...(await crypto.subtle.exportKey("jwk", pair.publicKey)),
          kid: this.kid,
          use: "sig",
          alg: "RS256",
        },
      ],
    }
  }
  async sign(claims: Record<string, unknown>): Promise<string> {
    const header = base64url(
      encoder.encode(JSON.stringify({ alg: "RS256", kid: this.kid, typ: "JWT" })),
    )
    const payload = base64url(encoder.encode(JSON.stringify(claims)))
    const input = `${header}.${payload}`
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      (await this.pair).privateKey,
      encoder.encode(input),
    )
    return `${input}.${base64url(new Uint8Array(signature))}`
  }
}

export const halfHash = async (value: string): Promise<string> =>
  base64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))).slice(0, 16),
  )

export async function verifyAppleSecret(
  token: string,
  clientId: string,
  apple: { teamId: string; keyId: string; publicKey: JsonWebKey },
  now: number,
): Promise<boolean> {
  try {
    const parts = token.split(".")
    const [header, payload, signature] = parts
    if (parts.length !== 3 || !header || !payload || !signature) return false
    const decode = (value: string) =>
      Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))
    const h = JSON.parse(new TextDecoder().decode(decode(header)))
    const p = JSON.parse(new TextDecoder().decode(decode(payload)))
    const seconds = Math.floor(now / 1000)
    if (
      h.alg !== "ES256" ||
      h.kid !== apple.keyId ||
      p.iss !== apple.teamId ||
      p.sub !== clientId ||
      p.aud !== "https://appleid.apple.com" ||
      typeof p.iat !== "number" ||
      typeof p.exp !== "number" ||
      p.iat > seconds + 60 ||
      p.exp <= seconds ||
      p.exp <= p.iat ||
      p.exp - p.iat > 15777000
    )
      return false
    const key = await crypto.subtle.importKey(
      "jwk",
      apple.publicKey,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    )
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      decode(signature),
      encoder.encode(`${header}.${payload}`),
    )
  } catch {
    return false
  }
}
