/**
 * A small MIME reader for the raw messages SES `SendRawEmail` receives. It covers what mail
 * libraries produce (nodemailer, the AWS samples): folded headers, RFC 2047 encoded words,
 * nested multiparts, base64 and quoted-printable bodies. Everything is decoded as UTF-8.
 */
import type { EmailAttachment } from "./model.js"

export type ParsedMime = {
  headers: Record<string, string>
  subject: string
  from: string | null
  to: string[]
  cc: string[]
  html: string | null
  text: string | null
  attachments: EmailAttachment[]
}

type Part = { headers: Record<string, string>; body: string }

const utf8 = new TextDecoder()

const base64Bytes = (value: string): Uint8Array => {
  const binary = atob(value.replace(/[^A-Za-z0-9+/=]/g, ""))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

const quotedPrintableBytes = (value: string, underscoreSpace = false): Uint8Array => {
  const source = value.replace(/=\r?\n/g, "")
  const out: number[] = []
  for (let i = 0; i < source.length; i++) {
    const ch = source[i] ?? ""
    const hex = source.slice(i + 1, i + 3)
    if (ch === "=" && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      out.push(Number.parseInt(hex, 16))
      i += 2
    } else if (underscoreSpace && ch === "_") out.push(32)
    else for (const byte of new TextEncoder().encode(ch)) out.push(byte)
  }
  return new Uint8Array(out)
}

/** `=?utf-8?B?…?=` and `=?utf-8?Q?…?=` words in a header value. */
export const decodeWords = (value: string): string =>
  value
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(
      /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
      (_, _charset: string, kind: string, text: string) =>
        utf8.decode(
          kind.toUpperCase() === "B" ? base64Bytes(text) : quotedPrintableBytes(text, true),
        ),
    )

const splitHead = (raw: string): Part => {
  const normalized = raw.replace(/\r\n/g, "\n")
  const end = normalized.indexOf("\n\n")
  const head = end < 0 ? normalized : normalized.slice(0, end)
  const body = end < 0 ? "" : normalized.slice(end + 2)
  const headers: Record<string, string> = {}
  for (const line of head.replace(/\n[ \t]+/g, " ").split("\n")) {
    const colon = line.indexOf(":")
    if (colon <= 0) continue
    const name = line.slice(0, colon).trim().toLowerCase()
    const value = decodeWords(line.slice(colon + 1).trim())
    headers[name] = headers[name] ? `${headers[name]}, ${value}` : value
  }
  return { headers, body }
}

const param = (header: string | undefined, name: string): string | null => {
  if (!header) return null
  const match = new RegExp(`${name}\\*?=(?:"([^"]*)"|([^;\\s]+))`, "i").exec(header)
  return match ? (match[1] ?? match[2] ?? null) : null
}

const decodeBody = (part: Part): Uint8Array => {
  const encoding = (part.headers["content-transfer-encoding"] ?? "").toLowerCase()
  if (encoding === "base64") return base64Bytes(part.body)
  if (encoding === "quoted-printable") return quotedPrintableBytes(part.body)
  return new TextEncoder().encode(part.body)
}

const walk = (part: Part, out: ParsedMime): void => {
  const type = (part.headers["content-type"] ?? "text/plain").toLowerCase()
  const boundary = param(part.headers["content-type"], "boundary")
  if (type.startsWith("multipart/") && boundary) {
    const sections = part.body.split(`--${boundary}`)
    for (const section of sections.slice(1)) {
      if (section.startsWith("--")) break
      walk(splitHead(section.replace(/^\n/, "")), out)
    }
    return
  }
  const disposition = part.headers["content-disposition"] ?? ""
  const filename = param(disposition, "filename") ?? param(part.headers["content-type"], "name")
  if (/^attachment/i.test(disposition) || (filename && !type.startsWith("text/"))) {
    out.attachments.push({
      filename: filename ?? "attachment",
      contentType: type.split(";")[0]?.trim() ?? null,
      size: decodeBody(part).byteLength,
    })
    return
  }
  const text = utf8.decode(decodeBody(part)).replace(/\n$/, "")
  if (type.startsWith("text/html") && out.html === null) out.html = text
  else if (type.startsWith("text/plain") && out.text === null) out.text = text
}

/** Split an address list header (`"A, B" <a@x>, b@y`) into its addresses. */
export const addressList = (value: string | undefined): string[] =>
  (value ?? "")
    .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map((item) => item.trim())
    .filter(Boolean)

export const parseMime = (raw: string): ParsedMime => {
  const root = splitHead(raw)
  const out: ParsedMime = {
    headers: root.headers,
    subject: root.headers.subject ?? "",
    from: root.headers.from ?? null,
    to: addressList(root.headers.to),
    cc: addressList(root.headers.cc),
    html: null,
    text: null,
    attachments: [],
  }
  walk(root, out)
  return out
}

/** Raw message bytes arrive base64 encoded in `RawMessage.Data`; fall back to plain text. */
export const decodeRawMessage = (data: string): string => {
  const compact = data.replace(/\s+/g, "")
  if (/^[A-Za-z0-9+/]+=*$/.test(compact) && compact.length % 4 === 0) {
    const decoded = utf8.decode(base64Bytes(compact))
    if (/^[\x20-\x7e]+:/m.test(decoded)) return decoded
  }
  return data
}
