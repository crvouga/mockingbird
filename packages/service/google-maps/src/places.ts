import { fromBase64, opaqueToken, toBase64 } from "@crvouga/mockingbird-service"
import { type CorpusAddress, STATE_NAMES } from "./corpus.js"

/**
 * Address resolution over the corpus, in Google's response shapes.
 *
 * Every answer is a pure function of the request and the namespace's corpus, so two instances
 * always agree. Addresses the corpus does not hold but whose city (and state/ZIP) it does are
 * *synthesized*: QA types `"<fuzzed number and street> <corpus city>"`, and the mock answers
 * with that street in the corpus row's city, state and ZIP. A synthesized place id carries the
 * whole address (`Ei…`, as Google's own address-only place ids carry theirs), so Place Details
 * resolves it without any stored state.
 */

/** One resolvable place: a corpus row, a synthesized street address, or a ZIP centroid. */
export type Place = {
  placeId: string
  kind: "street_address" | "postal_code"
  line1: string
  city: string
  state: string
  zip: string
  county: string
  lat: number
  lng: number
}

export type AddressComponent = { long_name: string; short_name: string; types: string[] }
export type Prediction = {
  description: string
  matched_substrings: { length: number; offset: number }[]
  place_id: string
  reference: string
  structured_formatting: {
    main_text: string
    main_text_matched_substrings: { length: number; offset: number }[]
    secondary_text: string
  }
  terms: { offset: number; value: string }[]
  types: string[]
}

const MAX_PREDICTIONS = 5

export const normalize = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()

const base64url = (value: string) =>
  toBase64(new TextEncoder().encode(value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
const fromBase64url = (value: string): string | undefined => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      fromBase64(value.replace(/-/g, "+").replace(/_/g, "/")),
    )
  } catch {
    return undefined
  }
}

/** The stable place id of a corpus row. */
export const corpusPlaceId = (row: Pick<CorpusAddress, "id">): string =>
  `ChIJ${opaqueToken(`gmaps:${row.id}`, 23)}`

const postalPlaceId = (zip: string): string => `ChIJ${opaqueToken(`gmaps:zip:${zip}`, 23)}`

const fromRow = (row: CorpusAddress): Place => ({
  placeId: corpusPlaceId(row),
  kind: "street_address",
  line1: row.line1,
  city: row.city,
  state: row.state,
  zip: row.zip,
  county: row.county,
  lat: row.lat,
  lng: row.lng,
})

/** A deterministic offset (±0.009°) so synthesized addresses do not all sit on one point. */
const jitter = (seed: string, axis: string): number => {
  const token = opaqueToken(`gmaps:jitter:${axis}:${seed}`, 4)
  let n = 0
  for (const char of token) n = (n * 31 + char.charCodeAt(0)) % 1800
  return (n - 900) / 100_000
}

const round = (value: number) => Math.round(value * 1e7) / 1e7

type SynthPayload = { l: string; c: string; s: string; z: string; n: string; a: number; o: number }

/** A street address the corpus does not hold, in a corpus row's city. */
export const synthesize = (line1: string, row: CorpusAddress): Place => {
  const payload: SynthPayload = {
    l: line1,
    c: row.city,
    s: row.state,
    z: row.zip,
    n: row.county,
    a: round(row.lat + jitter(line1, "lat")),
    o: round(row.lng + jitter(line1, "lng")),
  }
  return {
    placeId: `Ei${base64url(JSON.stringify(payload))}`,
    kind: "street_address",
    line1,
    city: row.city,
    state: row.state,
    zip: row.zip,
    county: row.county,
    lat: payload.a,
    lng: payload.o,
  }
}

const postalPlace = (row: CorpusAddress): Place => ({
  placeId: postalPlaceId(row.zip),
  kind: "postal_code",
  line1: "",
  city: row.city,
  state: row.state,
  zip: row.zip,
  county: row.county,
  lat: row.lat,
  lng: row.lng,
})

/** Resolve a place id minted by this mock (corpus row, synthesized address, ZIP centroid). */
export const placeById = (placeId: string, rows: readonly CorpusAddress[]): Place | undefined => {
  if (placeId.startsWith("Ei")) {
    const decoded = fromBase64url(placeId.slice(2))
    if (decoded === undefined) return undefined
    try {
      const p = JSON.parse(decoded) as Partial<SynthPayload>
      if (
        typeof p.l !== "string" ||
        typeof p.c !== "string" ||
        typeof p.s !== "string" ||
        typeof p.z !== "string" ||
        typeof p.a !== "number" ||
        typeof p.o !== "number"
      ) {
        return undefined
      }
      return {
        placeId,
        kind: "street_address",
        line1: p.l,
        city: p.c,
        state: p.s,
        zip: p.z,
        county: typeof p.n === "string" ? p.n : "",
        lat: p.a,
        lng: p.o,
      }
    } catch {
      return undefined
    }
  }
  for (const row of rows) {
    if (corpusPlaceId(row) === placeId) return fromRow(row)
    if (postalPlaceId(row.zip) === placeId) return postalPlace(row)
  }
  return undefined
}

const STREET_NUMBER = /^([A-Za-z]?\d+[A-Za-z]?(?:-\d+)?)\s+(.+)$/

/** Split `line1` into Google's street_number and route. */
const splitStreet = (line1: string): { number: string | undefined; route: string } => {
  const match = STREET_NUMBER.exec(line1.trim())
  return match
    ? { number: match[1] as string, route: (match[2] as string).trim() }
    : { number: undefined, route: line1.trim() }
}

export const addressComponents = (place: Place): AddressComponent[] => {
  const out: AddressComponent[] = []
  if (place.kind === "street_address") {
    const { number, route } = splitStreet(place.line1)
    if (number) out.push({ long_name: number, short_name: number, types: ["street_number"] })
    out.push({ long_name: route, short_name: route, types: ["route"] })
  } else {
    out.push({ long_name: place.zip, short_name: place.zip, types: ["postal_code"] })
  }
  out.push({ long_name: place.city, short_name: place.city, types: ["locality", "political"] })
  if (place.county) {
    out.push({
      long_name: place.county,
      short_name: place.county,
      types: ["administrative_area_level_2", "political"],
    })
  }
  out.push({
    long_name: STATE_NAMES[place.state] ?? place.state,
    short_name: place.state,
    types: ["administrative_area_level_1", "political"],
  })
  out.push({ long_name: "United States", short_name: "US", types: ["country", "political"] })
  if (place.kind === "street_address") {
    out.push({ long_name: place.zip, short_name: place.zip, types: ["postal_code"] })
  }
  return out
}

export const formattedAddress = (place: Place): string =>
  place.kind === "street_address"
    ? `${place.line1}, ${place.city}, ${place.state} ${place.zip}, USA`
    : `${place.city}, ${place.state} ${place.zip}, USA`

export const geometry = (place: Place, withType = false) => {
  const span = place.kind === "street_address" ? 0.00135 : 0.02
  return {
    location: { lat: place.lat, lng: place.lng },
    ...(withType
      ? { location_type: place.kind === "street_address" ? "ROOFTOP" : "APPROXIMATE" }
      : {}),
    viewport: {
      northeast: { lat: round(place.lat + span), lng: round(place.lng + span) },
      southwest: { lat: round(place.lat - span), lng: round(place.lng - span) },
    },
  }
}

const placeTypes = (place: Place) =>
  place.kind === "street_address" ? ["street_address"] : ["postal_code"]

/** Every Place Details field, keyed by the `fields` names Google accepts. */
export const placeResult = (place: Place): Record<string, unknown> => ({
  address_components: addressComponents(place),
  adr_address:
    place.kind === "street_address"
      ? `<span class="street-address">${place.line1}</span>, <span class="locality">${place.city}</span>, <span class="region">${place.state}</span> <span class="postal-code">${place.zip}</span>, <span class="country-name">USA</span>`
      : `<span class="locality">${place.city}</span>, <span class="region">${place.state}</span> <span class="postal-code">${place.zip}</span>, <span class="country-name">USA</span>`,
  formatted_address: formattedAddress(place),
  geometry: geometry(place),
  name: place.kind === "street_address" ? place.line1 : place.zip,
  place_id: place.placeId,
  reference: place.placeId,
  types: placeTypes(place),
  url: `https://maps.google.com/?q=${encodeURIComponent(formattedAddress(place))}`,
  utc_offset: 0,
  vicinity: place.city,
})

/** Google's field names (and the JS API's plural spellings) to result keys. */
const FIELD_ALIASES: Record<string, string> = {
  address_component: "address_components",
  address_components: "address_components",
  adr_address: "adr_address",
  formatted_address: "formatted_address",
  geometry: "geometry",
  "geometry/location": "geometry",
  "geometry/viewport": "geometry",
  name: "name",
  place_id: "place_id",
  reference: "reference",
  type: "types",
  types: "types",
  url: "url",
  utc_offset: "utc_offset",
  vicinity: "vicinity",
}

/** Only the requested fields (`fields=address_component,geometry`); every field when absent. */
export const pickFields = (
  result: Record<string, unknown>,
  fields: string | undefined,
  fallback: readonly string[] | "all",
): Record<string, unknown> => {
  const requested = (fields ?? "")
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean)
  if (requested.length === 0) {
    if (fallback === "all") return result
    return Object.fromEntries(fallback.map((key) => [key, result[key]]))
  }
  if (requested.includes("*")) return result
  const keys = new Set(requested.map((f) => FIELD_ALIASES[f]).filter((k): k is string => !!k))
  return Object.fromEntries(Object.entries(result).filter(([key]) => keys.has(key)))
}

/** Whether every field named in `fields` is one Google knows (unknown ones are INVALID_REQUEST). */
export const unknownFields = (fields: string | undefined): string[] =>
  (fields ?? "")
    .split(",")
    .map((f) => f.trim())
    .filter((f) => f && f !== "*" && !(f in FIELD_ALIASES))

const secondary = (place: Place) => `${place.city}, ${place.state}, USA`

export const prediction = (place: Place, input: string): Prediction => {
  const main = place.kind === "street_address" ? place.line1 : place.zip
  const second = secondary(place)
  const description = `${main}, ${second}`
  const matched = Math.min(input.trim().length, main.length)
  const terms: { offset: number; value: string }[] = []
  let offset = 0
  for (const value of [main, place.city, place.state, "USA"]) {
    terms.push({ offset, value })
    offset += value.length + 2
  }
  return {
    description,
    matched_substrings: [{ length: matched, offset: 0 }],
    place_id: place.placeId,
    reference: place.placeId,
    structured_formatting: {
      main_text: main,
      main_text_matched_substrings: [{ length: matched, offset: 0 }],
      secondary_text: second,
    },
    terms,
    types: place.kind === "street_address" ? ["premise", "geocode"] : ["postal_code", "geocode"],
  }
}

const tokens = (value: string) => normalize(value).split(" ").filter(Boolean)
const IGNORED = new Set(["usa", "us", "united", "states"])

/** Every input token is a prefix of a distinct haystack token. */
const tokensMatch = (input: string[], haystack: string[]): boolean => {
  const used = new Set<number>()
  for (const token of input) {
    const at = haystack.findIndex((h, i) => !used.has(i) && h.startsWith(token))
    if (at < 0) return false
    used.add(at)
  }
  return true
}

const rowHaystack = (row: CorpusAddress) =>
  tokens(`${row.line1} ${row.city} ${row.state} ${STATE_NAMES[row.state] ?? ""} ${row.zip}`)

/**
 * `"<number> <street…> <city>[ <ST>][ <zip>]"` where the city is a corpus city: the street and
 * the row it lands in. Comma-separated input (`"<line1>, <city>, <ST> <zip>"`) works too.
 */
export const parseStreetInCity = (
  input: string,
  rows: readonly CorpusAddress[],
): { line1: string; row: CorpusAddress } | undefined => {
  const trimmed = input.trim().replace(/[,\s]+(USA|US|United States)$/i, "")
  const match = STREET_NUMBER.exec(trimmed)
  if (!match) return undefined
  const number = match[1] as string
  const rest = (match[2] as string).replace(/,/g, " ").replace(/\s+/g, " ").trim()
  const restNorm = normalize(rest)
  // Longest city first, so "New York" beats "York".
  const candidates = [...rows].sort((a, b) => b.city.length - a.city.length)
  for (const row of candidates) {
    const city = normalize(row.city)
    const suffixes = [
      `${city} ${row.state.toLowerCase()} ${row.zip}`,
      `${city} ${row.state.toLowerCase()}`,
      `${city} ${row.zip}`,
      city,
    ]
    for (const suffix of suffixes) {
      if (!restNorm.endsWith(` ${suffix}`)) continue
      const streetNorm = restNorm.slice(0, restNorm.length - suffix.length).trim()
      if (!streetNorm) continue
      // Recover the street in the caller's casing: the words before the city.
      const words = rest.split(" ")
      const streetWords = words.slice(0, streetNorm.split(" ").length)
      const street = streetWords.join(" ").replace(/[,\s]+$/, "")
      return { line1: `${number} ${street}`, row }
    }
  }
  return undefined
}

/** Place Autocomplete over the corpus: synthesized first, then matching rows. */
export const autocomplete = (input: string, rows: readonly CorpusAddress[]): Place[] => {
  const wanted = tokens(input).filter((t) => !IGNORED.has(t))
  if (wanted.length === 0) return []
  const out: Place[] = []
  const synth = parseStreetInCity(input, rows)
  if (synth) {
    const exact = rows.find(
      (row) =>
        normalize(row.line1) === normalize(synth.line1) &&
        normalize(row.city) === normalize(synth.row.city),
    )
    out.push(exact ? fromRow(exact) : synthesize(synth.line1, synth.row))
  }
  for (const row of rows) {
    if (out.length >= MAX_PREDICTIONS) break
    if (out.some((p) => p.placeId === corpusPlaceId(row))) continue
    if (tokensMatch(wanted, rowHaystack(row))) out.push(fromRow(row))
  }
  return out
}

/**
 * Geocoding: a full address resolves to its corpus row or a synthesized address; a bare ZIP
 * or `"<city>, <ST>"` resolves to the ZIP centroid. A street with no locatable city is none.
 */
export const geocode = (address: string, rows: readonly CorpusAddress[]): Place | undefined => {
  const n = normalize(address)
  if (!n) return undefined
  const synth = parseStreetInCity(address, rows)
  if (synth) {
    const exact = rows.find(
      (row) =>
        normalize(row.line1) === normalize(synth.line1) &&
        normalize(row.city) === normalize(synth.row.city),
    )
    return exact ? fromRow(exact) : synthesize(synth.line1, synth.row)
  }
  const wanted = tokens(address).filter((t) => !IGNORED.has(t))
  if (wanted.length === 1 && /^\d{5}$/.test(wanted[0] as string)) {
    const row = rows.find((r) => r.zip === wanted[0])
    return row ? postalPlace(row) : undefined
  }
  if (!/\d/.test(n)) {
    const row = rows.find((r) => {
      const city = tokens(r.city)
      return (
        wanted.length >= city.length &&
        city.every((t, i) => wanted[i] === t) &&
        wanted.slice(city.length).every((t) => t === r.state.toLowerCase())
      )
    })
    return row ? postalPlace(row) : undefined
  }
  return undefined
}

/** Find Place From Text: geocoding first, then the looser autocomplete match. */
export const findPlace = (input: string, rows: readonly CorpusAddress[]): Place | undefined =>
  geocode(input, rows) ?? autocomplete(input, rows)[0]
