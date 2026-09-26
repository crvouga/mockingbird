import { type CorpusAddress, STATE_NAMES } from "./corpus.js"
import { corpusPlaceId, normalize, parseStreetInCity, synthesize } from "./places.js"

/**
 * The Address Validation API (`POST https://addressvalidation.googleapis.com/v1:validateAddress`)
 * over the same corpus as Places and Geocoding.
 *
 * Shapes follow Google's reference: `ValidationResult` (`verdict`, `address`, `geocode`,
 * `uspsData`) and `google.rpc.Status` errors. Google encodes responses as proto3 JSON, so
 * `false` booleans and empty lists are omitted rather than sent.
 *
 * - https://developers.google.com/maps/documentation/address-validation/reference/rest/v1/TopLevel/validateAddress
 * - https://developers.google.com/maps/documentation/address-validation/reference/rest/v1/ValidationResult
 * - https://developers.google.com/maps/documentation/address-validation/understand-response
 *
 * Every answer is a pure function of the request and the namespace's corpus. A street the corpus
 * holds (or one synthesized in a corpus city, as for Autocomplete) is a delivery point: DPV `Y`,
 * with a deterministic ZIP+4. Admin rows can pin any part of the verdict (`validation`).
 */

export type Granularity =
  | "SUB_PREMISE"
  | "PREMISE"
  | "PREMISE_PROXIMITY"
  | "BLOCK"
  | "ROUTE"
  | "OTHER"
export type PossibleNextAction = "FIX" | "CONFIRM_ADD_SUBPREMISES" | "CONFIRM" | "ACCEPT"
export type DpvConfirmation = "Y" | "N" | "S" | "D"

export const GRANULARITIES: readonly Granularity[] = [
  "SUB_PREMISE",
  "PREMISE",
  "PREMISE_PROXIMITY",
  "BLOCK",
  "ROUTE",
  "OTHER",
]
export const NEXT_ACTIONS: readonly PossibleNextAction[] = [
  "FIX",
  "CONFIRM_ADD_SUBPREMISES",
  "CONFIRM",
  "ACCEPT",
]
export const DPV_CODES: readonly DpvConfirmation[] = ["Y", "N", "S", "D"]

/** Per-row controls set through `PUT /__admin/corpus`: pin the verdict a test needs. */
export type ValidationOverrides = {
  granularity?: Granularity
  addressComplete?: boolean
  possibleNextAction?: PossibleNextAction
  dpvConfirmation?: DpvConfirmation
  unconfirmedComponentTypes?: string[]
  /** USPS refuses the address: `uspsData.errorMessage`, and no DPV code. */
  uspsErrorMessage?: string
  /** An apartment building: a missing unit is `D`, an unknown one `S`. */
  multiUnit?: boolean
  /** The units USPS knows for a `multiUnit` row. Absent: every unit is known. */
  units?: string[]
}

/** A `google.rpc.Status` error, as Google's API front end sends it. */
export type GoogleApiError = {
  code: number
  message: string
  status: string
  details?: Record<string, unknown>[]
}

export class ValidationRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ValidationRequestError"
  }
}

type InputAddress = {
  regionCode: string | undefined
  addressLines: string[]
  locality: string | undefined
  administrativeArea: string | undefined
  postalCode: string | undefined
}

export type ValidateRequest = { address: InputAddress; enableUspsCass: boolean }

const TOP_LEVEL = new Set([
  "address",
  "previousResponseId",
  "enableUspsCass",
  "languageOptions",
  "sessionToken",
])
/** `google.type.PostalAddress` fields (camelCase, as the JSON mapping accepts). */
const POSTAL_ADDRESS = new Set([
  "revision",
  "regionCode",
  "languageCode",
  "postalCode",
  "sortingCode",
  "administrativeArea",
  "locality",
  "sublocality",
  "addressLines",
  "recipients",
  "organization",
])
const MAX_INPUT_LENGTH = 280
/** Vendored PostalAddress limits: `addressLines` has `maxItems: 3`, items `maxLength: 80`. */
const MAX_ADDRESS_LINES = 3
const MAX_ADDRESS_LINE_LENGTH = 80

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const optionalString = (value: unknown, field: string): string | undefined => {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string") {
    throw new ValidationRequestError(
      `Invalid value at '${field}' (TYPE_STRING), ${JSON.stringify(value)}`,
    )
  }
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

/** Parse and check a request body; throws {@link ValidationRequestError} for a 400. */
export const parseValidateRequest = (body: unknown): ValidateRequest => {
  if (!isRecord(body)) throw new ValidationRequestError("Invalid JSON payload received.")
  for (const key of Object.keys(body)) {
    if (!TOP_LEVEL.has(key)) {
      throw new ValidationRequestError(
        `Invalid JSON payload received. Unknown name "${key}": Cannot find field.`,
      )
    }
  }
  const address = body.address
  if (address === undefined || address === null) {
    throw new ValidationRequestError("Address is missing from the request.")
  }
  if (!isRecord(address)) {
    throw new ValidationRequestError(
      `Invalid value at 'address' (type.googleapis.com/google.type.PostalAddress), ${JSON.stringify(address)}`,
    )
  }
  for (const key of Object.keys(address)) {
    if (!POSTAL_ADDRESS.has(key)) {
      throw new ValidationRequestError(
        `Invalid JSON payload received. Unknown name "${key}" at 'address': Cannot find field.`,
      )
    }
  }
  const rawLines = address.addressLines ?? []
  if (!Array.isArray(rawLines) || rawLines.some((line) => typeof line !== "string")) {
    throw new ValidationRequestError(
      `Invalid value at 'address.address_lines' (TYPE_STRING), ${JSON.stringify(rawLines)}`,
    )
  }
  // The vendored PostalAddress caps addressLines at 3 items of 80 characters each; the mock
  // echoes the lines into the response, whose schema caps them the same way, so an over-long or
  // over-long-list request is rejected here rather than echoed into a non-conformant response.
  if ((rawLines as string[]).length > MAX_ADDRESS_LINES) {
    throw new ValidationRequestError(
      `Invalid value at 'address.address_lines' (repeated STRING), a maximum of ${MAX_ADDRESS_LINES} address lines is allowed.`,
    )
  }
  const overLong = (rawLines as string[]).findIndex((line) => line.length > MAX_ADDRESS_LINE_LENGTH)
  if (overLong !== -1) {
    throw new ValidationRequestError(
      `Invalid value at 'address.address_lines[${overLong}]' (STRING), the maximum length is ${MAX_ADDRESS_LINE_LENGTH} characters.`,
    )
  }
  const addressLines = (rawLines as string[]).map((line) => line.trim()).filter(Boolean)
  if (addressLines.length === 0) {
    throw new ValidationRequestError("Address lines are missing from the request.")
  }
  const enable = body.enableUspsCass
  if (enable !== undefined && enable !== null && typeof enable !== "boolean") {
    throw new ValidationRequestError(
      `Invalid value at 'enable_usps_cass' (TYPE_BOOL), ${JSON.stringify(enable)}`,
    )
  }
  const input: InputAddress = {
    regionCode: optionalString(address.regionCode, "address.region_code")?.toUpperCase(),
    addressLines,
    locality: optionalString(address.locality, "address.locality"),
    administrativeArea: optionalString(address.administrativeArea, "address.administrative_area"),
    postalCode: optionalString(address.postalCode, "address.postal_code"),
  }
  const length = [
    ...input.addressLines,
    input.locality ?? "",
    input.administrativeArea ?? "",
    input.postalCode ?? "",
  ].join("").length
  if (length > MAX_INPUT_LENGTH) {
    throw new ValidationRequestError(
      `The total length of the address fields must not exceed ${MAX_INPUT_LENGTH} characters.`,
    )
  }
  const region = input.regionCode ?? "US"
  if (enable === true && region !== "US" && region !== "PR") {
    throw new ValidationRequestError(
      "USPS CASS validation is only supported for addresses in the US and PR regions.",
    )
  }
  return { address: input, enableUspsCass: enable === true }
}

// ---------------------------------------------------------------------------------------------
// Street parsing

/** USPS Publication 28 suffix and directional abbreviations (the ones the corpus uses). */
const ABBREVIATIONS: Record<string, string> = {
  north: "N",
  south: "S",
  east: "E",
  west: "W",
  northeast: "NE",
  northwest: "NW",
  southeast: "SE",
  southwest: "SW",
  avenue: "Ave",
  av: "Ave",
  street: "St",
  str: "St",
  road: "Rd",
  drive: "Dr",
  boulevard: "Blvd",
  lane: "Ln",
  parkway: "Pkwy",
  place: "Pl",
  court: "Ct",
  circle: "Cir",
  highway: "Hwy",
  terrace: "Ter",
  square: "Sq",
  plaza: "Plz",
  trail: "Trl",
  way: "Way",
  mall: "Mall",
}
const DIRECTIONALS = new Set(["n", "s", "e", "w", "ne", "nw", "se", "sw"])

/** Secondary unit designators to their USPS abbreviation. */
const DESIGNATORS: Record<string, string> = {
  apt: "Apt",
  apartment: "Apt",
  unit: "Unit",
  ste: "Ste",
  suite: "Ste",
  bldg: "Bldg",
  building: "Bldg",
  fl: "Fl",
  floor: "Fl",
  rm: "Rm",
  room: "Rm",
  spc: "Spc",
  space: "Spc",
  lot: "Lot",
  trlr: "Trlr",
  "#": "#",
}

const UNIT_AT_END =
  /[\s,]+(#|apt|apartment|unit|ste|suite|bldg|building|fl|floor|rm|room|spc|space|lot|trlr)\.?\s*#?\s*([A-Za-z0-9-]+)$/i
const UNIT_ONLY =
  /^(#|apt|apartment|unit|ste|suite|bldg|building|fl|floor|rm|room|spc|space|lot|trlr)?\.?\s*#?\s*([A-Za-z0-9-]+)$/i
const STREET_NUMBER = /^([A-Za-z]?\d+[A-Za-z]?(?:-\d+)?)\s+(.+)$/

type Unit = { designator: string; value: string }

const unitText = (unit: Unit) =>
  unit.designator === "#" ? `#${unit.value}` : `${unit.designator} ${unit.value}`

const parseUnit = (designator: string | undefined, value: string): Unit => ({
  designator: DESIGNATORS[(designator ?? "#").toLowerCase()] ?? "#",
  value: value.toUpperCase(),
})

/** Split a trailing unit (`… Apt 4`, `… Building A`) off a street line. */
const splitUnit = (line: string): { street: string; unit: Unit | undefined } => {
  const match = UNIT_AT_END.exec(line)
  if (!match || match.index === 0) return { street: line.trim(), unit: undefined }
  return {
    street: line.slice(0, match.index).trim(),
    unit: parseUnit(match[1], match[2] as string),
  }
}

/** A street key for matching: lowercase, USPS abbreviations, no punctuation. */
export const streetKey = (street: string): string =>
  normalize(street)
    .split(" ")
    .map((word) => (ABBREVIATIONS[word] ?? word).toLowerCase())
    .join(" ")

/** USPS-standardize the caller's street spelling, keeping the other words as typed. */
const standardizeStreet = (street: string): string =>
  street
    .replace(/[.,]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      const lower = word.toLowerCase()
      if (DIRECTIONALS.has(lower)) return lower.toUpperCase()
      return ABBREVIATIONS[lower] ?? word
    })
    .join(" ")

const stateCode = (value: string | undefined): string | undefined => {
  if (!value) return undefined
  const upper = value.trim().toUpperCase()
  if (STATE_NAMES[upper]) return upper
  const byName = Object.entries(STATE_NAMES).find(([, name]) => name.toUpperCase() === upper)
  return byName?.[0] ?? upper
}

// ---------------------------------------------------------------------------------------------
// Resolution

type Resolved = {
  /** The corpus row the address resolved to (for a synthesized street: its city's row). */
  row: CorpusAddress
  /** Output street line, without the unit. */
  street: string | undefined
  number: string | undefined
  route: string
  unit: Unit | undefined
  /** The corpus holds this exact premise (not synthesized). */
  inCorpus: boolean
  postal: "confirmed" | "replaced" | "inferred"
  locality: "confirmed" | "replaced"
  state: "confirmed" | "replaced"
}

type Unresolved = { street: string; unit: Unit | undefined; hasNumber: boolean }

const cityRows = (rows: readonly CorpusAddress[], city: string, state: string | undefined) =>
  rows.filter(
    (row) =>
      normalize(row.city) === normalize(city) && (state === undefined || row.state === state),
  )

const resolve = (
  input: InputAddress,
  rows: readonly CorpusAddress[],
): { resolved: Resolved } | { unresolved: Unresolved } => {
  const [first = "", ...rest] = input.addressLines
  let streetLine = first
  let unit: Unit | undefined
  let locality = input.locality
  let state = stateCode(input.administrativeArea)
  let zip = input.postalCode?.slice(0, 5)
  let candidates: CorpusAddress[] = []

  if (locality || zip) {
    // Componentized: line 1 is the street, an optional line 2 the unit.
    const second = rest.join(" ").trim()
    if (second) {
      const only = UNIT_ONLY.exec(second)
      if (only) unit = parseUnit(only[1], only[2] as string)
    }
  } else {
    // Everything in addressLines: "<street>, <city>, <ST> <zip>".
    const joined = input.addressLines.join(", ")
    const parsed = parseStreetInCity(joined, rows)
    if (parsed) {
      streetLine = parsed.line1
      locality = parsed.row.city
      state = parsed.row.state
      const zipMatch = /\b(\d{5})(?:-\d{4})?\s*(?:,?\s*(?:USA|US|United States))?$/i.exec(joined)
      zip = zipMatch?.[1]
    }
  }

  const split = splitUnit(streetLine)
  const street = split.street
  unit = unit ?? split.unit
  const numbered = STREET_NUMBER.exec(street)

  if (locality) candidates = cityRows(rows, locality, state)
  let localityStatus: Resolved["locality"] = "confirmed"
  let stateStatus: Resolved["state"] = "confirmed"
  if (candidates.length === 0 && zip) {
    // Google corrects the city (and state) from a ZIP it knows.
    candidates = rows.filter((row) => row.zip === zip)
    if (candidates.length > 0) {
      localityStatus = "replaced"
      if (state !== undefined && candidates[0]?.state !== state) stateStatus = "replaced"
    }
  }
  if (candidates.length === 0 || !numbered) {
    return { unresolved: { street, unit, hasNumber: !!numbered } }
  }

  const number = numbered[1] as string
  const key = streetKey(street)
  const exact = candidates.find((row) => streetKey(row.line1) === key)
  const base =
    exact ??
    candidates.find((row) => zip !== undefined && row.zip === zip) ??
    (candidates[0] as CorpusAddress)
  const outStreet = exact ? exact.line1 : standardizeStreet(street)
  const routeMatch = STREET_NUMBER.exec(outStreet)
  return {
    resolved: {
      row: base,
      street: outStreet,
      number,
      route: routeMatch ? (routeMatch[2] as string) : outStreet,
      unit,
      inCorpus: !!exact,
      postal: zip === undefined ? "inferred" : zip === base.zip ? "confirmed" : "replaced",
      locality: localityStatus,
      state: stateStatus,
    },
  }
}

// ---------------------------------------------------------------------------------------------
// Response

/** A small deterministic hash (FNV-1a), for ZIP+4 digits and response ids. */
const fnv = (value: string, seed = 0x811c9dc5): number => {
  let hash = seed >>> 0
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

const zipPlus4 = (row: CorpusAddress, street: string): string =>
  String((fnv(`${row.id}|${streetKey(street)}`) % 9999) + 1).padStart(4, "0")

/** A deterministic UUID-shaped `responseId` for a request body. */
export const responseId = (seed: string): string => {
  const hex = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x7f4a7c15]
    .map((s) => fnv(seed, s).toString(16).padStart(8, "0"))
    .join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

type ConfirmationLevel = "CONFIRMED" | "UNCONFIRMED_BUT_PLAUSIBLE" | "UNCONFIRMED_AND_SUSPICIOUS"

type Component = {
  componentName: { text: string; languageCode?: string }
  componentType: string
  confirmationLevel: ConfirmationLevel
  inferred?: true
  replaced?: true
}

const component = (
  text: string,
  componentType: string,
  confirmationLevel: ConfirmationLevel,
  flags: { inferred?: boolean; replaced?: boolean } = {},
): Component => ({
  componentName: { text, languageCode: "en" },
  componentType,
  confirmationLevel,
  ...(flags.inferred ? { inferred: true as const } : {}),
  ...(flags.replaced ? { replaced: true as const } : {}),
})

/** A short, PII-free label of the answer, for the request journal (`FIX/N`, `ACCEPT/Y`). */
export type ValidationOutcome = {
  body: Record<string, unknown>
  /** The corpus row id the address resolved to, if any. */
  rowId: string | undefined
  verdictClass: string
}

const compact = <T extends Record<string, unknown>>(value: T): T =>
  Object.fromEntries(
    Object.entries(value).filter(
      ([, v]) => v !== undefined && v !== false && !(Array.isArray(v) && v.length === 0),
    ),
  ) as T

const uniq = (values: string[]) => [...new Set(values)]

/** Validate one address against the namespace's corpus. */
export const validateAddress = (
  request: ValidateRequest,
  rows: readonly CorpusAddress[],
  options: { dpvOverride?: DpvConfirmation } = {},
): ValidationOutcome => {
  const { address: input, enableUspsCass } = request
  const region = input.regionCode ?? "US"
  const usps = region === "US" || region === "PR"
  const outcome = region === "US" ? resolve(input, rows) : undefined

  let granularity: Granularity
  let inputGranularity: Granularity
  let addressComplete: boolean
  let nextAction: PossibleNextAction
  let dpv: DpvConfirmation | undefined
  let dpvFootnote: string | undefined
  let unconfirmed: string[] = []
  let missing: string[] = []
  let hasReplaced = false
  let hasInferred = false
  let uspsError: string | undefined
  const components: Component[] = []
  let postalAddress: Record<string, unknown>
  let formattedAddress: string
  let geocode: Record<string, unknown> | undefined
  let standardized: Record<string, unknown> | undefined
  let rowId: string | undefined

  if (!outcome || "unresolved" in outcome) {
    // Nothing the corpus can place: Google cannot confirm the street or the city.
    const street = outcome && "unresolved" in outcome ? outcome.unresolved : undefined
    const hasNumber = street?.hasNumber ?? STREET_NUMBER.test(input.addressLines[0] ?? "")
    const unit = street?.unit
    const cityKnown =
      input.locality !== undefined &&
      cityRows(rows, input.locality, stateCode(input.administrativeArea)).length > 0
    inputGranularity = unit ? "SUB_PREMISE" : hasNumber ? "PREMISE" : "ROUTE"
    addressComplete = false
    nextAction = "FIX"
    if (cityKnown && !hasNumber) {
      // A known street without a house number (`N Central Ave`, Phoenix): route level.
      granularity = "ROUTE"
      missing = ["street_number"]
      dpv = undefined
    } else {
      granularity = "OTHER"
      dpv = usps ? "N" : undefined
    }
    const streetText = street?.street ?? input.addressLines[0] ?? ""
    const split = STREET_NUMBER.exec(streetText)
    const routeLevel: ConfirmationLevel = cityKnown
      ? "UNCONFIRMED_BUT_PLAUSIBLE"
      : "UNCONFIRMED_AND_SUSPICIOUS"
    if (split) {
      components.push(component(split[1] as string, "street_number", routeLevel))
      components.push(component(split[2] as string, "route", routeLevel))
    } else if (streetText) {
      components.push(
        component(streetText, "route", cityKnown ? "CONFIRMED" : "UNCONFIRMED_AND_SUSPICIOUS"),
      )
    }
    if (unit) components.push(component(unitText(unit), "subpremise", routeLevel))
    if (input.locality) {
      components.push(
        component(
          input.locality,
          "locality",
          cityKnown ? "CONFIRMED" : "UNCONFIRMED_AND_SUSPICIOUS",
        ),
      )
    }
    const state = stateCode(input.administrativeArea)
    if (state) {
      components.push(
        component(
          state,
          "administrative_area_level_1",
          STATE_NAMES[state] ? "CONFIRMED" : "UNCONFIRMED_AND_SUSPICIOUS",
        ),
      )
    }
    if (input.postalCode) {
      const zipKnown = rows.some((row) => row.zip === input.postalCode?.slice(0, 5))
      components.push(
        component(
          input.postalCode,
          "postal_code",
          zipKnown ? "CONFIRMED" : "UNCONFIRMED_AND_SUSPICIOUS",
        ),
      )
    }
    components.push(
      component(region === "US" ? "USA" : region, "country", "CONFIRMED", {
        inferred: input.regionCode === undefined,
      }),
    )
    hasInferred = input.regionCode === undefined
    unconfirmed = components
      .filter((c) => c.confirmationLevel !== "CONFIRMED")
      .map((c) => c.componentType)
    const line = [streetText, unit ? unitText(unit) : ""].filter(Boolean).join(" ")
    postalAddress = compact({
      regionCode: region,
      languageCode: "en",
      postalCode: input.postalCode,
      administrativeArea: state,
      locality: input.locality,
      addressLines: line ? [line] : undefined,
    })
    formattedAddress = [
      line,
      input.locality,
      [state, input.postalCode].filter(Boolean).join(" "),
      region === "US" ? "USA" : region,
    ]
      .filter(Boolean)
      .join(", ")
  } else {
    const r = outcome.resolved
    const row = r.row
    rowId = row.id
    const street = r.street as string
    const validation = row.validation ?? {}
    const plus4 = zipPlus4(row, street)
    inputGranularity = r.unit ? "SUB_PREMISE" : "PREMISE"
    granularity = "PREMISE"
    addressComplete = true
    nextAction = "ACCEPT"
    dpv = "Y"
    dpvFootnote = "AABB"
    let unitLevel: ConfirmationLevel = "CONFIRMED"

    if (validation.multiUnit) {
      if (!r.unit) {
        missing = ["subpremise"]
        addressComplete = false
        nextAction = "CONFIRM_ADD_SUBPREMISES"
        dpv = "D"
        dpvFootnote = "AAN1"
      } else if (
        validation.units === undefined ||
        validation.units.some((u) => u.toUpperCase() === r.unit?.value)
      ) {
        granularity = "SUB_PREMISE"
      } else {
        unitLevel = "UNCONFIRMED_BUT_PLAUSIBLE"
        nextAction = "CONFIRM"
        dpv = "S"
        dpvFootnote = "AACC"
      }
    } else if (r.unit) {
      // A unit on a single delivery point: USPS delivers without it (footnote CC).
      unitLevel = "UNCONFIRMED_BUT_PLAUSIBLE"
      nextAction = "CONFIRM"
      dpvFootnote = "AACC"
    }

    if (r.postal === "replaced" || r.locality === "replaced" || r.state === "replaced") {
      hasReplaced = true
      if (nextAction === "ACCEPT") nextAction = "CONFIRM"
    }

    components.push(component(r.number as string, "street_number", "CONFIRMED"))
    components.push(component(r.route, "route", "CONFIRMED"))
    if (r.unit) components.push(component(unitText(r.unit), "subpremise", unitLevel))
    components.push(
      component(row.city, "locality", "CONFIRMED", { replaced: r.locality === "replaced" }),
    )
    components.push(
      component(row.state, "administrative_area_level_1", "CONFIRMED", {
        replaced: r.state === "replaced",
      }),
    )
    components.push(
      component(row.zip, "postal_code", "CONFIRMED", {
        inferred: r.postal === "inferred",
        replaced: r.postal === "replaced",
      }),
    )
    components.push(component(plus4, "postal_code_suffix", "CONFIRMED", { inferred: true }))
    components.push(
      component("USA", "country", "CONFIRMED", { inferred: input.regionCode === undefined }),
    )
    hasInferred = true
    unconfirmed = components
      .filter((c) => c.confirmationLevel !== "CONFIRMED")
      .map((c) => c.componentType)

    if (validation.granularity) granularity = validation.granularity
    if (validation.addressComplete !== undefined) addressComplete = validation.addressComplete
    if (validation.possibleNextAction) nextAction = validation.possibleNextAction
    if (validation.dpvConfirmation) dpv = validation.dpvConfirmation
    if (validation.unconfirmedComponentTypes)
      unconfirmed = [...validation.unconfirmedComponentTypes]
    if (validation.uspsErrorMessage) uspsError = validation.uspsErrorMessage

    const line = [street, r.unit ? unitText(r.unit) : ""].filter(Boolean).join(" ")
    const zip = `${row.zip}-${plus4}`
    postalAddress = {
      regionCode: "US",
      languageCode: "en",
      postalCode: zip,
      administrativeArea: row.state,
      locality: row.city,
      addressLines: [line],
    }
    formattedAddress = `${line}, ${row.city}, ${row.state} ${zip}, USA`
    const place = r.inCorpus
      ? { placeId: corpusPlaceId(row), lat: row.lat, lng: row.lng }
      : synthesize(street, row)
    geocode = {
      location: { latitude: place.lat, longitude: place.lng },
      placeId: place.placeId,
      placeTypes: r.unit ? ["subpremise"] : ["premise"],
    }
    standardized = {
      firstAddressLine: line.toUpperCase(),
      cityStateZipAddressLine: `${row.city.toUpperCase()} ${row.state} ${zip}`,
      city: row.city.toUpperCase(),
      state: row.state,
      zipCode: row.zip,
      zipCodeExtension: plus4,
    }
  }

  if (options.dpvOverride) dpv = options.dpvOverride
  if (dpv === "N") standardized = undefined
  if (dpv !== undefined && dpvFootnote === undefined) dpvFootnote = dpv === "N" ? "A1M1" : "AABB"
  if (dpv === "N") dpvFootnote = "A1M1"

  const verdict = compact({
    inputGranularity,
    validationGranularity: granularity,
    geocodeGranularity: granularity === "SUB_PREMISE" ? "PREMISE" : granularity,
    addressComplete,
    hasUnconfirmedComponents: unconfirmed.length > 0,
    hasInferredComponents: hasInferred,
    hasReplacedComponents: hasReplaced,
    possibleNextAction: nextAction,
  })
  const address = compact({
    formattedAddress,
    postalAddress,
    addressComponents: components,
    missingComponentTypes: uniq(missing),
    unconfirmedComponentTypes: uniq(unconfirmed),
  })
  const uspsData = usps
    ? uspsError
      ? compact({ errorMessage: uspsError, cassProcessed: enableUspsCass })
      : compact({
          standardizedAddress: standardized,
          dpvConfirmation: dpv,
          dpvFootnote: dpv ? dpvFootnote : undefined,
          postOfficeCity: standardized ? standardized.city : undefined,
          postOfficeState: standardized ? standardized.state : undefined,
          cassProcessed: enableUspsCass,
        })
    : undefined
  const result = compact({ verdict, address, geocode, uspsData })
  const verdictClass = `${nextAction}/${uspsError ? "ERROR" : (dpv ?? "-")}`
  return {
    body: { result, responseId: responseId(JSON.stringify({ input, enableUspsCass })) },
    rowId,
    verdictClass,
  }
}
