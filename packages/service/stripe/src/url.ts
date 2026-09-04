import { invalidRequest } from "./errors.js"

const MAX_URL_LENGTH = 2048
const PCT = "%[0-9A-Fa-f]{2}"
const MARK = "[A-Za-z0-9._~!$&'()*+,;=-]"
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/
const HTTP_AUTHORITY = /^https?:\/\//i
const URL_GRAMMAR = new RegExp(
  `^(?:(?:${MARK}|${PCT}|:)*@)?` +
    `(\\[(?:[0-9A-Fa-f:.]+|v[0-9A-Fa-f]+\\.(?:${MARK}|:)+)\\]|(?:${MARK}|${PCT})*)` +
    "(?::\\d*)?" +
    `(?:/(?:${MARK}|${PCT}|[:@])*)*` +
    `(?:\\?(?:[^#%]|${PCT})*)?` +
    `(?:#(?:${MARK}|${PCT}|[:@/?])*)?$`,
)

const urlInvalid = (message: string, param: string) => invalidRequest(message, param, "url_invalid")

const isHttpUrl = (value: string) => {
  const scheme = SCHEME.exec(value)
  if (scheme && !HTTP_AUTHORITY.test(value)) return false
  const rest = scheme ? value.slice(scheme[0].length + 2) : value
  const match = URL_GRAMMAR.exec(rest)
  return match !== null && (match[1] ?? "").length > 0
}

/**
 * Stripe's URL acceptance order: total length, ASCII-only, RFC 3986 shape with an http(s)
 * scheme (implied when absent) and a host, then an optional stricter per-field length cap.
 */
export const validateUrl = (value: string, param: string, lengthLimit?: number) => {
  if (value.length > MAX_URL_LENGTH)
    throw urlInvalid(`Invalid URL: URL must be ${MAX_URL_LENGTH} characters or less.`, param)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ASCII range check
  if (/[^\x00-\x7F]/.test(value))
    throw urlInvalid(
      "Invalid URL: Non-ASCII characters in URLs must be percent-encoded in order for the URL to be valid.",
      param,
    )
  if (!isHttpUrl(value)) throw urlInvalid("Not a valid URL", param)
  if (lengthLimit !== undefined && value.length > lengthLimit)
    throw invalidRequest(
      `Invalid string length: please limit to ${lengthLimit - 1} characters`,
      param,
    )
  return value
}
