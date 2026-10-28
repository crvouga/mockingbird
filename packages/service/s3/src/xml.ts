import { awsParseXml } from "@crvouga/mockingbird-service"

/** Go's `xml.Header`, which MinIO writes before every XML body. */
export const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>\n'
export const S3_XMLNS = "http://s3.amazonaws.com/doc/2006-03-01/"

/** Escape text exactly as Go's `encoding/xml` does (`"` → `&#34;`, `'` → `&#39;`, ...). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: Go replaces characters outside XML's range.
const ESCAPED = /[&<>"'\t\n\r\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/g
export const esc = (value: unknown): string =>
  String(value).replace(ESCAPED, (char) => {
    switch (char) {
      case "&":
        return "&amp;"
      case "<":
        return "&lt;"
      case ">":
        return "&gt;"
      case '"':
        return "&#34;"
      case "'":
        return "&#39;"
      case "\t":
        return "&#x9;"
      case "\n":
        return "&#xA;"
      case "\r":
        return "&#xD;"
      default:
        // Outside XML's character range: Go writes U+FFFD.
        return "\uFFFD"
    }
  })

/** `<name>escaped value</name>`, or nothing when the value is `undefined`. */
export const el = (name: string, value: unknown): string =>
  value === undefined || value === null ? "" : `<${name}>${esc(value)}</${name}>`

/** `<name>` around already-encoded children. */
export const wrap = (name: string, children: string): string => `<${name}>${children}</${name}>`

/** A whole XML document as MinIO encodes it: the header, then the root element. */
export const doc = (root: string, children: string, xmlns: string | false = S3_XMLNS): string =>
  `${XML_HEADER}<${root}${xmlns ? ` xmlns="${xmlns}"` : ""}>${children}</${root}>`

/** S3 timestamps in XML bodies: RFC 3339 with milliseconds, UTC (`2006-01-02T15:04:05.000Z`). */
export const isoDate = (ms: number): string => new Date(ms).toISOString()

/** HTTP-date (`Mon, 02 Jan 2006 15:04:05 GMT`). */
export const httpDate = (ms: number): string => new Date(ms).toUTCString()

export type XmlNode = Record<string, unknown>

/** Parse a request body; throws on anything Go's decoder would reject. */
export const parseXml = (body: string): XmlNode => awsParseXml(body) as XmlNode

/** A child that may repeat, as an array. */
export const many = (value: unknown): XmlNode[] =>
  value === undefined || value === null
    ? []
    : ((Array.isArray(value) ? value : [value]) as XmlNode[])

/** A scalar child's text ("" for an empty element, `undefined` when absent). */
export const text = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined
  if (typeof value === "object") {
    const inner = (value as { "#text"?: unknown })["#text"]
    return inner === undefined ? "" : String(inner)
  }
  return String(value)
}
