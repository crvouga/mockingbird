import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { validateArchive, type FleetArchive } from "./fleet-archive.js"

export type ProtectedArchive = { format: "mockingbird.jwe/v1"; jwe: string }
export type ArchiveProtector = { readonly policy: { format: string; activeKeyId: string }; seal(archive: FleetArchive): Promise<ProtectedArchive>; open(envelope: unknown): Promise<FleetArchive> }
export type ProtectionOptions = { activeKeyId: string; trustedKeyIds: readonly string[]; resolveKey(id: string): Promise<Uint8Array>; maxBytes?: number }
const decode = (s: string) => { if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("archive authentication failed"); return Buffer.from(s, "base64url") }

/** RFC 7516 compact JWE, RFC 7518 direct A256GCM; keys are resolved outside the archive. */
export function archiveProtector(options: ProtectionOptions): ArchiveProtector {
  if (!options.activeKeyId || !options.trustedKeyIds.includes(options.activeKeyId)) throw new Error("active archive key must be trusted")
  const max = options.maxBytes ?? 64 * 1024 * 1024
  const key = async (id: string) => {
    try {
      if (!options.trustedKeyIds.includes(id)) throw new Error()
      const value = await options.resolveKey(id)
      if (!(value instanceof Uint8Array) || value.length !== 32) throw new Error()
      return value
    } catch { throw new Error("archive protection key unavailable or untrusted") }
  }
  return {
    policy: { format: "JWE:dir:A256GCM", activeKeyId: options.activeKeyId },
    async seal(archive) {
      validateArchive(archive)
      const plaintext = Buffer.from(JSON.stringify(archive))
      if (plaintext.length > max) throw new Error("protected archive exceeds byte limit")
      const header = Buffer.from(JSON.stringify({ alg: "dir", enc: "A256GCM", kid: options.activeKeyId, cty: "application/json" })).toString("base64url")
      const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", await key(options.activeKeyId), iv)
      cipher.setAAD(Buffer.from(header, "ascii"))
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
      return { format: "mockingbird.jwe/v1", jwe: [header, "", iv.toString("base64url"), ciphertext.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(".") }
    },
    async open(envelope) {
      if (!envelope || typeof envelope !== "object" || (envelope as ProtectedArchive).format !== "mockingbird.jwe/v1" || typeof (envelope as ProtectedArchive).jwe !== "string") throw new Error("expected protected archive")
      const parts = (envelope as ProtectedArchive).jwe.split(".")
      if (parts.length !== 5 || parts[1] !== "" || (envelope as ProtectedArchive).jwe.length > max * 2) throw new Error("archive authentication failed")
      const [protectedHeader, , iv, ciphertext, tag] = parts as [string, string, string, string, string]
      let header: { alg?: string; enc?: string; kid?: string; cty?: string }
      try { header = JSON.parse(decode(protectedHeader).toString("utf8")) as typeof header } catch { throw new Error("archive authentication failed") }
      if (!header || header.alg !== "dir" || header.enc !== "A256GCM" || !header.kid || Object.keys(header).some((k) => !["alg", "enc", "kid", "cty"].includes(k))) throw new Error("unsupported archive protection header")
      const material = await key(header.kid)
      try {
        const nonce = decode(iv), auth = decode(tag), encrypted = decode(ciphertext)
        if (nonce.length !== 12 || auth.length !== 16 || encrypted.length > max) throw new Error()
        const decipher = createDecipheriv("aes-256-gcm", material, nonce)
        decipher.setAAD(Buffer.from(protectedHeader, "ascii")); decipher.setAuthTag(auth)
        return validateArchive(JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8")))
      } catch { throw new Error("archive authentication failed") }
    },
  }
}
