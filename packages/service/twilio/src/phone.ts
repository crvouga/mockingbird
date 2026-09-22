import {
  type CountryCode,
  getCountryCallingCode,
  parsePhoneNumber,
  validatePhoneNumberLength,
} from "libphonenumber-js/max"

/**
 * Lookup v2 number validation, modelled on what the live API answers (it is libphonenumber:
 * the validation errors are libphonenumber's reasons). Verified live for fictional 555-01xx
 * numbers and malformed inputs; see scripts/parity.ts.
 */

export type ValidationError =
  | "TOO_SHORT"
  | "TOO_LONG"
  | "INVALID_BUT_POSSIBLE"
  | "INVALID_COUNTRY_CODE"
  | "INVALID_LENGTH"
  | "NOT_A_NUMBER"

export type LookupResult = {
  calling_country_code: string | null
  country_code: string | null
  phone_number: string
  national_format: string | null
  valid: boolean
  validation_errors: ValidationError[]
}

const LOOKUP_BASE = "https://lookups.twilio.com/v2/PhoneNumbers/"

/** Every data package is null unless requested (and paid for) upstream. */
const PACKAGES = {
  caller_name: null,
  sim_swap: null,
  call_forwarding: null,
  line_status: null,
  line_type_intelligence: null,
  identity_match: null,
  reassigned_number: null,
  sms_pumping_risk: null,
  phone_number_quality_score: null,
  pre_fill: null,
} as const

/**
 * Lengths libphonenumber (Java, which Twilio runs) treats as possible "local only" numbers;
 * libphonenumber-js drops them from its metadata. Live: `+15550100` is INVALID_BUT_POSSIBLE,
 * not TOO_SHORT, and so is the 8-digit `+4420794601`.
 */
const LOCAL_ONLY_LENGTHS: Record<string, readonly number[]> = {
  "1": [7],
  "44": [4, 5, 6, 8],
}

const PUNCTUATION =
  "-x\u2010-\u2015\u2212\u30FC\uFF0D-\uFF0F \u00A0\u00AD\u200B\u2060\u3000()\uFF08\uFF09\uFF3B\uFF3D.\\[\\]/~\u2053\u223C\uFF5E"
/** libphonenumber's VALID_PHONE_NUMBER: pluses, then 3+ digits amid punctuation, then vanity letters. */
const VIABLE = new RegExp(
  `^(?:[0-9]{2}|\\+*(?:[${PUNCTUATION}*]*[0-9]){3,}[${PUNCTUATION}*]*[A-Za-z0-9]*)$`,
)

const KEYPAD: Record<string, string> = {
  a: "2",
  b: "2",
  c: "2",
  d: "3",
  e: "3",
  f: "3",
  g: "4",
  h: "4",
  i: "4",
  j: "5",
  k: "5",
  l: "5",
  m: "6",
  n: "6",
  o: "6",
  p: "7",
  q: "7",
  r: "7",
  s: "7",
  t: "8",
  u: "8",
  v: "8",
  w: "9",
  x: "9",
  y: "9",
  z: "9",
}

/** Letters to keypad digits (live: `+1202555012a` looks up as `+12025550122`), then digits only. */
const digitsOf = (value: string) =>
  value
    .toLowerCase()
    .replace(/[a-z]/g, (letter) => KEYPAD[letter] ?? "")
    .replace(/[^0-9]/g, "")

const invalid = (
  phone: string,
  error: ValidationError,
  nationalFormat: string | null = null,
): LookupResult => ({
  calling_country_code: null,
  country_code: null,
  phone_number: phone,
  national_format: nationalFormat,
  valid: false,
  validation_errors: [error],
})

const callingCodeOf = (country: string | undefined): string => {
  try {
    return getCountryCallingCode((country ?? "US") as CountryCode)
  } catch {
    return "1"
  }
}

/**
 * Validate the way Lookup v2 does. `raw` is the decoded path segment; `countryCode` the
 * optional `CountryCode` query parameter (the region for a national-format number).
 */
export const lookup = (raw: string, countryCode?: string): LookupResult => {
  const input = raw.trim()
  const international = input.startsWith("+")
  // Without a leading +, the number is read in the given region, else as a US number.
  const display = displayOf(input, countryCode)
  if (!VIABLE.test(input)) return invalid(display, "NOT_A_NUMBER")
  const digits = digitsOf(input)
  let parsed: ReturnType<typeof parsePhoneNumber> | undefined
  try {
    parsed = international
      ? parsePhoneNumber(`+${digits}`)
      : parsePhoneNumber(digits, { defaultCountry: (countryCode ?? "US") as CountryCode })
  } catch (error) {
    const reason = error instanceof Error ? error.message : ""
    if (reason === "INVALID_COUNTRY") return invalid(display, "INVALID_COUNTRY_CODE")
    if (reason === "TOO_LONG") return invalid(display, "TOO_LONG")
    if (reason === "TOO_SHORT") return invalid(display, "TOO_SHORT")
    return invalid(display, "NOT_A_NUMBER")
  }
  if (!parsed) return invalid(display, "NOT_A_NUMBER")
  if (parsed.isValid()) {
    return {
      calling_country_code: parsed.countryCallingCode,
      country_code: parsed.country ?? null,
      phone_number: parsed.number,
      national_format: parsed.formatNational(),
      valid: true,
      validation_errors: [],
    }
  }
  // Live: a national-format number in no given region must be valid as a US number.
  if (!international && countryCode === undefined) return invalid(display, "INVALID_COUNTRY_CODE")
  const national = parsed.nationalNumber
  // Live: the number echoed is the input's digits (a national prefix kept), not the E.164 form.
  const echoed = international ? `+${digits}` : `+${parsed.countryCallingCode}${digits}`
  return invalid(echoed, possibility(parsed.countryCallingCode, national), national)
}

const possibility = (callingCode: string, national: string): ValidationError => {
  if ((LOCAL_ONLY_LENGTHS[callingCode] ?? []).includes(national.length)) {
    return "INVALID_BUT_POSSIBLE"
  }
  const reason = validatePhoneNumberLength(`+${callingCode}${national}`)
  if (reason === "TOO_SHORT" || reason === "TOO_LONG" || reason === "INVALID_LENGTH") return reason
  return "INVALID_BUT_POSSIBLE"
}

/** The input as Lookup echoes it back: prefixed with the region's calling code when national. */
export const displayOf = (raw: string, countryCode?: string): string => {
  const input = raw.trim()
  return input.startsWith("+") ? input : `+${callingCodeOf(countryCode)}${input}`
}

/** The full Lookup v2 body for a result (every data package null, as when none is requested). */
export const lookupBody = (result: LookupResult, raw: string, countryCode?: string) => ({
  ...PACKAGES,
  ...result,
  // Live: the url names the normalized number when valid, else the input as sent.
  url: `${LOOKUP_BASE}${result.valid ? result.phone_number : encodeURI(displayOf(raw, countryCode))}`,
})

/** `+` and digits only: the key admin routes and overrides use. */
export const e164Key = (value: string): string => `+${value.replace(/[^0-9]/g, "")}`
