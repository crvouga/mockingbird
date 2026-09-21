/// <reference types="node" />
import { generateKeyPairSync, randomBytes, sign } from "node:crypto"

/**
 * A throwaway self-signed certificate for `localhost` / `127.0.0.1`, generated in memory at
 * startup. The Mailosaur SDK always speaks HTTPS (it calls `https.request` whatever the base
 * URL says), so the mock has to answer over TLS; generating the certificate here means no
 * private key ships in the package and no `openssl` is needed.
 *
 * Minimal DER encoding of an X.509 v3 certificate (ECDSA P-256 / SHA-256) with a
 * subjectAltName for every host given.
 */
export type SelfSignedCertificate = { cert: string; key: string }

const tlv = (tag: number, ...parts: Uint8Array[]): Uint8Array => {
  const length = parts.reduce((sum, part) => sum + part.length, 0)
  const header =
    length < 0x80
      ? [tag, length]
      : length < 0x100
        ? [tag, 0x81, length]
        : [tag, 0x82, length >> 8, length & 0xff]
  const out = new Uint8Array(header.length + length)
  out.set(header, 0)
  let offset = header.length
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

const sequence = (...parts: Uint8Array[]) => tlv(0x30, ...parts)
const bytes = (value: string) => new TextEncoder().encode(value)

const oid = (dotted: string): Uint8Array => {
  const [first = 0, second = 0, ...rest] = dotted.split(".").map(Number)
  const out = [first * 40 + second]
  for (const arc of rest) {
    const base128 = [arc & 0x7f]
    for (let value = arc >> 7; value > 0; value >>= 7) base128.unshift((value & 0x7f) | 0x80)
    out.push(...base128)
  }
  return tlv(0x06, Uint8Array.from(out))
}

const integer = (value: Uint8Array) =>
  tlv(0x02, (value[0] ?? 0) & 0x80 ? Uint8Array.from([0, ...value]) : value)

const utcTime = (date: Date) => {
  const two = (n: number) => String(n).padStart(2, "0")
  return tlv(
    0x17,
    bytes(
      `${two(date.getUTCFullYear() % 100)}${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}` +
        `${two(date.getUTCHours())}${two(date.getUTCMinutes())}${two(date.getUTCSeconds())}Z`,
    ),
  )
}

const name = (commonName: string) =>
  sequence(tlv(0x31, sequence(oid("2.5.4.3"), tlv(0x0c, bytes(commonName)))))

const ipBytes = (ip: string) => Uint8Array.from(ip.split(".").map(Number))

const pem = (label: string, der: Uint8Array) =>
  `-----BEGIN ${label}-----\n${(
    Buffer.from(der)
      .toString("base64")
      .match(/.{1,64}/g) ?? []
  ).join("\n")}\n-----END ${label}-----\n`

/** A fresh certificate valid from a day ago for ten years, for `hosts` (names or IPv4). */
export const selfSignedCertificate = (
  hosts: readonly string[] = ["localhost", "127.0.0.1"],
): SelfSignedCertificate => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
  const algorithm = sequence(oid("1.2.840.10045.4.3.2"))
  const now = Date.now()
  const altNames = sequence(
    ...hosts.map((host) =>
      /^\d+\.\d+\.\d+\.\d+$/.test(host) ? tlv(0x87, ipBytes(host)) : tlv(0x82, bytes(host)),
    ),
  )
  const extensions = tlv(
    0xa3,
    sequence(
      sequence(oid("2.5.29.19"), tlv(0x04, sequence(tlv(0x01, Uint8Array.from([0xff]))))),
      sequence(oid("2.5.29.17"), tlv(0x04, altNames)),
    ),
  )
  const serial = randomBytes(16)
  serial[0] = (serial[0] ?? 0) & 0x7f
  const tbs = sequence(
    tlv(0xa0, integer(Uint8Array.from([2]))),
    integer(serial),
    algorithm,
    name(hosts[0] ?? "localhost"),
    sequence(utcTime(new Date(now - 86_400_000)), utcTime(new Date(now + 3_650 * 86_400_000))),
    name(hosts[0] ?? "localhost"),
    new Uint8Array(publicKey.export({ type: "spki", format: "der" })),
    extensions,
  )
  const signature = sign("sha256", tbs, privateKey)
  const certificate = sequence(tbs, algorithm, tlv(0x03, Uint8Array.from([0]), signature))
  return {
    cert: pem("CERTIFICATE", certificate),
    key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  }
}
