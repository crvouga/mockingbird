const encoder = new TextEncoder()
const algorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }
const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")

/** Synthetic private material belongs only in protected namespace state/archives. */
export type CognitoSigningKey = { kid: string; publicKey: JsonWebKey; privateKey: JsonWebKey }
export class CognitoSigner {
  private readonly pair: Promise<CryptoKeyPair>
  readonly kid: string
  constructor(key?: CognitoSigningKey) {
    this.kid = key?.kid ?? crypto.randomUUID()
    this.pair = key
      ? Promise.all([
          crypto.subtle.importKey("jwk", key.publicKey, algorithm, true, ["verify"]),
          crypto.subtle.importKey("jwk", key.privateKey, algorithm, true, ["sign"]),
        ]).then(([publicKey, privateKey]) => ({ publicKey, privateKey }))
      : crypto.subtle.generateKey(
          { ...algorithm, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
          true,
          ["sign", "verify"],
        )
  }
  async export(): Promise<CognitoSigningKey> {
    const pair = await this.pair
    return {
      kid: this.kid,
      publicKey: await crypto.subtle.exportKey("jwk", pair.publicKey),
      privateKey: await crypto.subtle.exportKey("jwk", pair.privateKey),
    }
  }
  async jwks() {
    return {
      keys: [
        {
          ...(await crypto.subtle.exportKey("jwk", (await this.pair).publicKey)),
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
      algorithm,
      (await this.pair).privateKey,
      encoder.encode(input),
    )
    return `${input}.${base64url(new Uint8Array(signature))}`
  }
}
