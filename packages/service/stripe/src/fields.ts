import { invalidRequest, parameterInvalidEmpty } from "./errors.js"
import type { Params } from "./params.js"

const METADATA_MAX_KEYS = 50
const METADATA_MAX_KEY_LENGTH = 40
const METADATA_MAX_VALUE_LENGTH = 500

const length = (value: string) => [...value].length

/**
 * Apply Stripe's metadata semantics: `""` clears everything, a key with `""` deletes it, other
 * keys merge; then enforce the documented limits on the result.
 */
export const mergeMetadata = (
  current: Record<string, string>,
  incoming: unknown,
): Record<string, string> => {
  if (incoming === undefined) return current
  if (incoming === "") return {}
  const next: Record<string, string> = { ...current }
  for (const [key, value] of Object.entries(incoming as Record<string, string>)) {
    if (length(key) > METADATA_MAX_KEY_LENGTH)
      throw invalidRequest(
        `Metadata keys can have up to ${METADATA_MAX_KEY_LENGTH} characters, but you passed in a key that is ${length(key)} characters. Invalid key: ${key}`,
      )
    if (length(value) > METADATA_MAX_VALUE_LENGTH)
      throw invalidRequest(
        `Metadata values can have up to ${METADATA_MAX_VALUE_LENGTH} characters, but you passed in a value that is ${length(value)} characters. Invalid value: ${value}`,
      )
    if (value === "") delete next[key]
    else next[key] = value
  }
  const count = Object.keys(next).length
  if (count > METADATA_MAX_KEYS)
    throw invalidRequest(
      `Metadata can have up to ${METADATA_MAX_KEYS} keys, but you've set ${count}.`,
    )
  return next
}

/** Optional string: absent keeps `current`, `""` unsets to null. */
export const optionalString = (
  params: Params,
  key: string,
  current: string | null,
): string | null => {
  const value = params[key]
  if (value === undefined) return current
  if (value === "") return null
  return value as string
}

/** Ruby's `String#strip`: leading and trailing ASCII whitespace and NULs. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: mirrors Ruby strip
export const strip = (value: string) => value.replace(/^[\s\0]+|[\s\0]+$/g, "")

/** Optional string that Stripe strips: absent keeps `current`, blank unsets to null. */
export const strippedString = (
  params: Params,
  key: string,
  current: string | null,
): string | null => {
  const value = params[key]
  if (value === undefined) return current
  const stripped = strip(value as string)
  return stripped === "" ? null : stripped
}

/** Required string: `""` is rejected because the field cannot be unset. */
export const requiredString = (params: Params, key: string, current: string): string => {
  const value = params[key]
  if (value === undefined) return current
  if (value === "") throw parameterInvalidEmpty(key)
  return value as string
}

export const optionalBoolean = (
  params: Params,
  key: string,
  current: boolean | null,
): boolean | null => {
  const value = params[key]
  return value === undefined ? current : (value as boolean)
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export const validateEmail = (value: string) => {
  if (!EMAIL.test(value))
    throw invalidRequest(`Invalid email address: ${value}`, "email", "email_invalid")
  return value
}

const STATEMENT_DESCRIPTOR_FORBIDDEN = ["<", ">", "\\", '"', "'"]

export const validateStatementDescriptor = (value: string) => {
  for (const char of STATEMENT_DESCRIPTOR_FORBIDDEN) {
    if (value.includes(char))
      throw invalidRequest(
        `The statement descriptor cannot include ${char}.`,
        "statement_descriptor",
      )
  }
  if (!/[A-Za-z]/.test(value))
    throw invalidRequest(
      "The statement descriptor must contain at least one Latin character.",
      "statement_descriptor",
    )
  return value
}

/** Stripe echoes decimals back the way Ruby's BigDecimal#to_s prints them (`0.15e1`). */
export const rubyBigDecimal = (raw: string) => {
  const negative = raw.startsWith("-")
  const unsigned = negative ? raw.slice(1) : raw
  const [intPart = "", fracPart = ""] = unsigned.split(".")
  const digits = `${intPart}${fracPart}`.replace(/^0+/, "")
  if (digits === "") return "0.0"
  const leadingZeros = `${intPart}${fracPart}`.length - digits.length
  const exponent = intPart.length - leadingZeros
  const significant = digits.replace(/0+$/, "")
  return `${negative ? "-" : ""}0.${significant}e${exponent}`
}

const DECIMAL = /^-?\d+(\.\d+)?$/
const MAX_DECIMAL_PLACES = 12

/** Normalise a decimal string: strip trailing fraction zeros and the sign of zero. */
export const normalizeDecimal = (raw: string) => {
  const negative = raw.startsWith("-")
  const unsigned = negative ? raw.slice(1) : raw
  const [intRaw = "0", fracRaw = ""] = unsigned.split(".")
  const intPart = intRaw.replace(/^0+(?=\d)/, "")
  const frac = fracRaw.replace(/0+$/, "")
  const text = frac === "" ? intPart : `${intPart}.${frac}`
  return negative && text !== "0" ? `-${text}` : text
}

export const parseUnitAmountDecimal = (raw: string, param: string) => {
  if (!DECIMAL.test(raw)) throw invalidRequest(`Invalid decimal: ${raw}`, param)
  const places = raw.split(".")[1]?.length ?? 0
  if (places > MAX_DECIMAL_PLACES)
    throw invalidRequest(
      `Invalid decimal: ${rubyBigDecimal(raw)}; must contain at most ${MAX_DECIMAL_PLACES} decimal places.`,
      param,
    )
  const normalized = normalizeDecimal(raw)
  if (normalized.startsWith("-"))
    throw invalidRequest(
      `This value must be greater than or equal to 0 (it currently is '${rubyBigDecimal(raw)}').`,
      param,
    )
  return normalized
}

/** `unit_amount` is the integer view of the decimal, or null when it has a fraction. */
export const unitAmountOf = (decimal: string) => (decimal.includes(".") ? null : Number(decimal))
