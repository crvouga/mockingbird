const encoder = new TextEncoder()
const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
export class CognitoSigner {
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
  readonly kid: string
  constructor(seed = "cognito-signing-key") {
    this.kid = base64url(
      new Uint8Array([...encoder.encode(seed), ...new Uint8Array(32)]).slice(0, 24),
    )
  }
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
  async sign(claims: Record<string, unknown>) {
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
