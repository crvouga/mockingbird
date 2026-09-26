import { extractCodes } from "@crvouga/mockingbird-service"

/**
 * How Mailosaur turns a raw message into the parsed `html` / `text` content its SDK models read:
 * links, verification codes and images, plus address parsing for `Name <email>` strings.
 */

export type MessageAddress = { name: string; email?: string; phone?: string }
export type Link = { href: string; text: string }
export type Code = { value: string }
export type Image = { src: string; alt: string }

export type MessageContent = {
  body: string | null
  links: Link[]
  codes: Code[]
  images?: Image[]
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
}

export const decodeEntities = (value: string): string =>
  value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      return String.fromCodePoint(Number.parseInt(entity.slice(2), 16))
    }
    if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10))
    return ENTITIES[entity.toLowerCase()] ?? whole
  })

/** The text a reader sees: no head, styles, scripts, comments or tags; entities decoded. */
export const visibleText = (html: string): string =>
  decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(head|style|script|title)\b[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<[^>]*>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim()

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"')\]]+/gi

/**
 * Verification codes as Mailosaur lists them in `codes[]`: every distinct standalone run of
 * 4–8 digits in the readable text, in order of appearance. Digits inside URLs are not codes
 * (a link's query string is not something a person types).
 */
export const findCodes = (readable: string): Code[] =>
  extractCodes(readable.replace(URL_PATTERN, " ")).map((value) => ({ value }))

/** Every `<a href>` with its visible text, in document order. */
export const htmlLinks = (html: string): Link[] => {
  const links: Link[] = []
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const attributes = match[1] ?? ""
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attributes)
    const raw = href?.[1] ?? href?.[2] ?? href?.[3]
    if (raw === undefined || raw.trim() === "") continue
    links.push({ href: decodeEntities(raw.trim()), text: visibleText(match[2] ?? "") })
  }
  return links
}

/** Every `<img src>` with its alt text. */
export const htmlImages = (html: string): Image[] => {
  const images: Image[] = []
  for (const match of html.matchAll(/<img\b([^>]*)>/gi)) {
    const attributes = match[1] ?? ""
    const src = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attributes)
    const alt = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attributes)
    const value = src?.[1] ?? src?.[2]
    if (value)
      images.push({ src: decodeEntities(value), alt: decodeEntities(alt?.[1] ?? alt?.[2] ?? "") })
  }
  return images
}

/** URLs written out in a plain-text body. */
export const textLinks = (text: string): Link[] =>
  [...text.matchAll(URL_PATTERN)].map((match) => ({ href: match[0], text: match[0] }))

export const htmlContent = (html: string | null | undefined): MessageContent => {
  if (html === null || html === undefined || html === "") {
    return { body: null, links: [], codes: [], images: [] }
  }
  return {
    body: html,
    links: htmlLinks(html),
    codes: findCodes(visibleText(html)),
    images: htmlImages(html),
  }
}

export const textContent = (text: string | null | undefined): MessageContent => {
  if (text === null || text === undefined || text === "")
    return { body: null, links: [], codes: [] }
  return { body: text, links: textLinks(text), codes: findCodes(text) }
}

const PHONE = /^\+?[0-9][0-9\s().-]{5,}$/

/** `"Ada <ada@example.com>"`, `"ada@example.com"`, `"+15555550100"` or `{name, email, phone}`. */
export const parseAddress = (value: unknown): MessageAddress | undefined => {
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>
    const email = typeof record.email === "string" ? record.email.trim() : undefined
    const phone = typeof record.phone === "string" ? record.phone.trim() : undefined
    if (!email && !phone) return undefined
    return {
      name: typeof record.name === "string" ? record.name : "",
      ...(email ? { email } : {}),
      ...(phone ? { phone } : {}),
    }
  }
  if (typeof value !== "string" || value.trim() === "") return undefined
  const trimmed = value.trim()
  const angle = /^(.*?)\s*<([^<>]+)>\s*$/.exec(trimmed)
  if (angle) {
    return {
      name: (angle[1] ?? "").replace(/^"(.*)"$/, "$1").trim(),
      email: (angle[2] ?? "").trim(),
    }
  }
  if (!trimmed.includes("@") && PHONE.test(trimmed)) return { name: "", phone: trimmed }
  return { name: "", email: trimmed }
}

export const parseAddresses = (value: unknown): MessageAddress[] => {
  const list = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : value === undefined || value === null
        ? []
        : [value]
  return list.map(parseAddress).filter((a): a is MessageAddress => a !== undefined)
}

/** The lower-cased email or phone of an address, as searches and the outbox compare them. */
export const addressKey = (address: MessageAddress): string =>
  (address.email ?? address.phone ?? "").toLowerCase()
