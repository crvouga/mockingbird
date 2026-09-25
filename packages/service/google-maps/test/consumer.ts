/**
 * A port of our member app's Google Maps consumers, the acceptance oracle:
 *
 * - `lib/ui/address-autocomplete/address-autocomplete-native-rest.tsx`: the URL builders, the
 *   prediction/details parsers and the consecutive-failure counter that switches the sheet to
 *   manual entry (threshold 2), minus React state.
 * - `lib/ui/address-autocomplete/parse-place-details.ts`: `parseAddressComponents`.
 * - `lib/ui/address-autocomplete/address-autocomplete-web.tsx`: the same flow over
 *   `google.maps.places` (AutocompleteService + PlacesService.getDetails + session tokens).
 * - `features/bloodwork/shared/lab-finder/use-geocoded-address.ts`: Geocoding, falling back to
 *   Find Place From Text, on native (REST) and web (`google.maps`).
 *
 * The app hardcodes `https://maps.googleapis.com` (seam G-Y1); the port takes a base URL.
 */
export type Fetch = (request: Request) => Promise<Response>

export type AddressPrediction = { placeId: string; mainText: string; secondaryText: string }
export type ParsedAddress = {
  line1: string
  line2?: string
  city: string
  state: string
  zip: string
}
type AddressComponent = { long_name: string; short_name: string; types: string[] }
export type GeocodedLocation = { lat: number; lng: number }

const CONSECUTIVE_FAILURE_THRESHOLD = 2

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function findComponent(components: AddressComponent[], type: string) {
  return components.find((c) => c.types.includes(type))
}

/** `parse-place-details.ts`, verbatim. */
export function parseAddressComponents(
  components: AddressComponent[],
  fallbackLine1?: string,
): ParsedAddress {
  const streetNumber = findComponent(components, "street_number")?.long_name ?? ""
  const route = findComponent(components, "route")?.long_name ?? ""
  const subpremise = findComponent(components, "subpremise")?.long_name
  const city =
    findComponent(components, "locality")?.long_name ??
    findComponent(components, "sublocality_level_1")?.long_name ??
    findComponent(components, "administrative_area_level_2")?.long_name ??
    ""
  const state = findComponent(components, "administrative_area_level_1")?.short_name ?? ""
  const zip = findComponent(components, "postal_code")?.long_name ?? ""
  const line1 = streetNumber ? `${streetNumber} ${route}`.trim() : fallbackLine1?.trim() || route
  return {
    line1,
    ...(subpremise ? { line2: subpremise } : {}),
    city,
    state: state.toUpperCase(),
    zip,
  }
}

export function parseAutocompletePredictions(data: unknown): AddressPrediction[] {
  if (!isRecord(data)) return []
  const status = data.status
  if (status !== "OK" && status !== "ZERO_RESULTS") return []
  const raw = data.predictions
  if (!Array.isArray(raw)) return []
  const out: AddressPrediction[] = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    const placeId = item.place_id
    const formatting = item.structured_formatting
    if (typeof placeId !== "string" || !isRecord(formatting)) continue
    const mainText = formatting.main_text
    const secondaryText = formatting.secondary_text
    if (typeof mainText !== "string") continue
    out.push({
      placeId,
      mainText,
      secondaryText: typeof secondaryText === "string" ? secondaryText : "",
    })
  }
  return out
}

export function parseDetailsAddress(data: unknown, fallbackLine1?: string): ParsedAddress | null {
  if (!isRecord(data)) return null
  if (data.status !== "OK") return null
  const result = data.result
  if (!isRecord(result)) return null
  const components = result.address_components
  if (!Array.isArray(components)) return null
  const typed: AddressComponent[] = []
  for (const c of components) {
    if (!isRecord(c)) continue
    const longName = c.long_name
    const shortName = c.short_name
    const types = c.types
    if (typeof longName !== "string" || typeof shortName !== "string" || !Array.isArray(types))
      continue
    typed.push({
      long_name: longName,
      short_name: shortName,
      types: types.filter((t): t is string => typeof t === "string"),
    })
  }
  if (typed.length === 0) return null
  return parseAddressComponents(typed, fallbackLine1)
}

export const buildAutocompleteUrl = (base: string, apiKey: string, input: string): string => {
  const params = new URLSearchParams({
    input,
    types: "address",
    components: "country:us",
    key: apiKey,
  })
  return `${base}/maps/api/place/autocomplete/json?${params.toString()}`
}

export const buildDetailsUrl = (base: string, apiKey: string, placeId: string): string => {
  const params = new URLSearchParams({
    place_id: placeId,
    fields: "address_component",
    key: apiKey,
  })
  return `${base}/maps/api/place/details/json?${params.toString()}`
}

const isAutocompleteSuccessStatus = (status: unknown) =>
  status === "OK" || status === "ZERO_RESULTS"

/**
 * `AddressAutocompleteNativeRestContent` without React: the same requests, parsers and the
 * degraded-state machine (`apiUnavailable` after two consecutive failures).
 */
export class NativeAddressAutocomplete {
  consecutiveFailures = 0
  apiUnavailable = false
  predictions: AddressPrediction[] = []

  constructor(
    private readonly base: string,
    private readonly apiKey: string,
    private readonly fetch: Fetch,
  ) {}

  private recordFailure() {
    this.consecutiveFailures += 1
    if (this.consecutiveFailures >= CONSECUTIVE_FAILURE_THRESHOLD) this.apiUnavailable = true
  }

  private recordSuccess() {
    this.consecutiveFailures = 0
  }

  /** "Back to search" from manual entry. */
  resetDegradedState() {
    this.consecutiveFailures = 0
    this.apiUnavailable = false
  }

  async fetchPredictions(input: string): Promise<AddressPrediction[]> {
    if (!input.trim()) {
      this.predictions = []
      return this.predictions
    }
    try {
      const res = await this.fetch(
        new Request(buildAutocompleteUrl(this.base, this.apiKey, input.trim())),
      )
      if (!res.ok) {
        this.recordFailure()
        this.predictions = []
        return this.predictions
      }
      const data: unknown = await res.json()
      if (!isRecord(data)) {
        this.recordFailure()
        this.predictions = []
        return this.predictions
      }
      const status = data.status
      if (typeof status === "string" && !isAutocompleteSuccessStatus(status)) {
        this.recordFailure()
        this.predictions = []
        return this.predictions
      }
      this.recordSuccess()
      this.predictions = parseAutocompletePredictions(data)
      return this.predictions
    } catch {
      this.recordFailure()
      this.predictions = []
      return this.predictions
    }
  }

  async selectPrediction(prediction: AddressPrediction): Promise<ParsedAddress | null> {
    try {
      const res = await this.fetch(
        new Request(buildDetailsUrl(this.base, this.apiKey, prediction.placeId)),
      )
      if (!res.ok) {
        this.recordFailure()
        return null
      }
      const data: unknown = await res.json()
      if (isRecord(data) && typeof data.status === "string" && data.status !== "OK") {
        this.recordFailure()
        return null
      }
      const parsed = parseDetailsAddress(data, prediction.mainText)
      if (parsed) {
        this.recordSuccess()
        return parsed
      }
      this.recordFailure()
      return null
    } catch {
      this.recordFailure()
      return null
    }
  }
}

/** `formatBloodworkAddress` from `lab-finder-utils.ts`. */
export const formatBloodworkAddress = (addr: {
  line1: string
  line2?: string
  city: string
  state: string
  zip: string
}): string =>
  [addr.line1, addr.line2, addr.city, `${addr.state} ${addr.zip}`].filter(Boolean).join(", ")

function parseLatLng(loc: { lat?: number; lng?: number } | undefined): GeocodedLocation | null {
  if (loc?.lat == null || loc?.lng == null) return null
  return { lat: loc.lat, lng: loc.lng }
}

type GeocodeJsonResponse = {
  status?: string
  results?: Array<{ geometry?: { location?: { lat?: number; lng?: number } } }>
}
type FindPlaceJsonResponse = {
  status?: string
  candidates?: Array<{ geometry?: { location?: { lat?: number; lng?: number } } }>
}

export async function geocodeWithHttp(
  fetch: Fetch,
  base: string,
  address: string,
  apiKey: string,
): Promise<GeocodedLocation | null> {
  const url = `${base}/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${apiKey}`
  const response = await fetch(new Request(url))
  if (!response.ok) return null
  const data = (await response.json()) as GeocodeJsonResponse
  if (data.status !== "OK") return null
  return parseLatLng(data.results?.[0]?.geometry?.location)
}

export async function findPlaceWithHttp(
  fetch: Fetch,
  base: string,
  address: string,
  apiKey: string,
): Promise<GeocodedLocation | null> {
  const params = new URLSearchParams({
    input: address,
    inputtype: "textquery",
    fields: "geometry",
    key: apiKey,
  })
  const response = await fetch(
    new Request(`${base}/maps/api/place/findplacefromtext/json?${params.toString()}`),
  )
  if (!response.ok) return null
  const data = (await response.json()) as FindPlaceJsonResponse
  if (data.status !== "OK") return null
  return parseLatLng(data.candidates?.[0]?.geometry?.location)
}

export async function geocodeOnNative(
  fetch: Fetch,
  base: string,
  address: string,
  apiKey: string,
): Promise<GeocodedLocation | null> {
  const fromGeocode = await geocodeWithHttp(fetch, base, address, apiKey)
  if (fromGeocode != null) return fromGeocode
  return findPlaceWithHttp(fetch, base, address, apiKey)
}

// ---------------------------------------------------------------------------------------------
// Web: the Maps JavaScript API (the mock's shim), loaded into a minimal fake window.

type LatLngLike = { lat(): number; lng(): number }
type PlaceLike = { address_components?: AddressComponent[]; geometry?: { location?: LatLngLike } }
type GoogleMaps = {
  Geocoder: new () => {
    geocode(
      request: { address: string },
      callback: (results: PlaceLike[] | null, status: string) => void,
    ): Promise<unknown>
  }
  places: {
    AutocompleteService: new () => {
      getPlacePredictions(
        request: Record<string, unknown>,
        callback: (
          results:
            | {
                place_id: string
                structured_formatting: { main_text: string; secondary_text: string }
              }[]
            | null,
          status: string,
        ) => void,
      ): Promise<unknown>
    }
    PlacesService: new (
      attribution: unknown,
    ) => {
      getDetails(
        request: Record<string, unknown>,
        callback: (place: PlaceLike | null, status: string) => void,
      ): Promise<unknown>
      findPlaceFromQuery(
        request: { query: string; fields: string[] },
        callback: (results: PlaceLike[] | null, status: string) => void,
      ): Promise<unknown>
    }
    AutocompleteSessionToken: new () => object
    PlacesServiceStatus: Record<string, string>
  }
}

export type FakeWindow = {
  google?: { maps?: GoogleMaps }
  gm_authFailure?: () => void
  fetch: typeof fetch
  document: { createElement(tag: string): { style: Record<string, string>; remove(): void } }
  [callback: string]: unknown
}

/** A window with just enough DOM for our web code, whose `fetch` goes to `send`. */
export const fakeWindow = (send: Fetch): FakeWindow => {
  const element = () => ({ style: {} as Record<string, string>, remove: () => {} })
  return {
    fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
      send(new Request(input, init))) as typeof fetch,
    document: { createElement: element },
  }
}

/**
 * `loadGoogleMapsScript` for the fake window: fetch `${base}/maps/api/js?key=…&libraries=places`
 * (the URL the app builds, on the mock's origin) and evaluate it; `onScriptError` on a non-2xx.
 */
export const loadGoogleMapsScript = async (
  win: FakeWindow,
  send: Fetch,
  base: string,
  apiKey: string,
  libraries: string[] = [],
): Promise<"loaded" | "error"> => {
  if (win.google?.maps) return "loaded"
  const libs = [...new Set(["places", ...libraries])].sort().join(",")
  const response = await send(new Request(`${base}/maps/api/js?key=${apiKey}&libraries=${libs}`))
  if (!response.ok) return "error"
  const source = await response.text()
  new Function("window", "globalThis", "fetch", source)(win, win, win.fetch)
  return "loaded"
}

const maps = (win: FakeWindow): GoogleMaps => {
  const google = win.google?.maps
  if (!google) throw new Error("google.maps is not loaded")
  return google
}

/** `AddressAutocompleteWeb`'s flow: predictions with a session token, then details. */
export class WebAddressAutocomplete {
  consecutiveFailures = 0
  apiUnavailable = false
  searchReturnedEmpty = false
  authFailed = false
  private sessionToken: object
  private readonly autocomplete: InstanceType<GoogleMaps["places"]["AutocompleteService"]>
  private readonly places: InstanceType<GoogleMaps["places"]["PlacesService"]>

  constructor(private readonly win: FakeWindow) {
    const google = maps(win)
    win.gm_authFailure = () => {
      this.authFailed = true
    }
    this.autocomplete = new google.places.AutocompleteService()
    this.places = new google.places.PlacesService(win.document.createElement("div"))
    this.sessionToken = new google.places.AutocompleteSessionToken()
  }

  private recordFailure() {
    this.consecutiveFailures += 1
    if (this.consecutiveFailures >= CONSECUTIVE_FAILURE_THRESHOLD) this.apiUnavailable = true
  }

  private recordSuccess() {
    this.consecutiveFailures = 0
  }

  fetchPredictions(input: string): Promise<AddressPrediction[]> {
    const google = maps(this.win)
    return new Promise((resolve) => {
      void this.autocomplete.getPlacePredictions(
        {
          input,
          componentRestrictions: { country: "us" },
          types: ["address"],
          sessionToken: this.sessionToken,
        },
        (results, status) => {
          if (status === google.places.PlacesServiceStatus.OK && results) {
            this.recordSuccess()
            this.searchReturnedEmpty = results.length === 0
            resolve(
              results.map((r) => ({
                placeId: r.place_id,
                mainText: r.structured_formatting.main_text,
                secondaryText: r.structured_formatting.secondary_text,
              })),
            )
            return
          }
          if (status === google.places.PlacesServiceStatus.ZERO_RESULTS) {
            this.recordSuccess()
            this.searchReturnedEmpty = true
            resolve([])
            return
          }
          this.recordFailure()
          this.searchReturnedEmpty = false
          resolve([])
        },
      )
    })
  }

  selectPrediction(prediction: AddressPrediction): Promise<ParsedAddress | null> {
    const google = maps(this.win)
    return new Promise((resolve) => {
      void this.places.getDetails(
        {
          placeId: prediction.placeId,
          fields: ["address_components"],
          sessionToken: this.sessionToken,
        },
        (place, status) => {
          this.sessionToken = new google.places.AutocompleteSessionToken()
          if (status !== google.places.PlacesServiceStatus.OK || !place?.address_components) {
            this.recordFailure()
            resolve(null)
            return
          }
          this.recordSuccess()
          resolve(parseAddressComponents(place.address_components, prediction.mainText))
        },
      )
    })
  }
}

export function geocodeWithGoogleMaps(
  win: FakeWindow,
  address: string,
): Promise<GeocodedLocation | null> {
  return new Promise((resolve) => {
    const geocoder = new (maps(win).Geocoder)()
    void geocoder.geocode({ address }, (results, status) => {
      if (status !== "OK" || !results?.[0]?.geometry?.location) {
        resolve(null)
        return
      }
      const loc = results[0].geometry.location
      resolve({ lat: loc.lat(), lng: loc.lng() })
    })
  })
}

export function findPlaceWithGoogleMaps(
  win: FakeWindow,
  address: string,
): Promise<GeocodedLocation | null> {
  return new Promise((resolve) => {
    const google = maps(win)
    const attributionDiv = win.document.createElement("div")
    attributionDiv.style.display = "none"
    const service = new google.places.PlacesService(attributionDiv)
    void service.findPlaceFromQuery({ query: address, fields: ["geometry"] }, (results, status) => {
      attributionDiv.remove()
      if (status !== google.places.PlacesServiceStatus.OK || !results?.[0]?.geometry?.location) {
        resolve(null)
        return
      }
      const loc = results[0].geometry.location
      resolve({ lat: loc.lat(), lng: loc.lng() })
    })
  })
}

export async function geocodeOnWeb(
  win: FakeWindow,
  address: string,
): Promise<GeocodedLocation | null> {
  const fromGeocoder = await geocodeWithGoogleMaps(win, address)
  if (fromGeocoder != null) return fromGeocoder
  return findPlaceWithGoogleMaps(win, address)
}

// ---------------------------------------------------------------------------------------------
// Address Validation: a checkout's pre-charge ship-to check (wire level, `fetch` + JSON).

export type ShipToAddress = {
  line1: string
  line2?: string
  city: string
  state: string
  zip: string
}

export type ShipToVerdict =
  | { kind: "unavailable"; reason: string }
  | { kind: "reject"; reason: string }
  | {
      kind: "accept"
      formattedAddress: string | undefined
      corrected: boolean
      suggestion: ShipToAddress | undefined
    }

const ACCEPTED_GRANULARITIES = new Set(["SUB_PREMISE", "PREMISE", "PREMISE_PROXIMITY"])
const REJECTED_ACTIONS = new Set(["FIX", "CONFIRM_ADD_SUBPREMISES"])
const CRITICAL_COMPONENTS = new Set([
  "street_number",
  "route",
  "locality",
  "postal_code",
  "administrative_area_level_1",
])

/** The request body a checkout sends: one address line, or two with an apt/suite. */
export function validationRequestBody(address: ShipToAddress) {
  return {
    address: {
      regionCode: "US",
      addressLines: address.line2 ? [address.line1, address.line2] : [address.line1],
      locality: address.city,
      administrativeArea: address.state,
      postalCode: address.zip,
    },
    enableUspsCass: true,
  }
}

/** The fail-open evaluation: Google unavailable accepts, a USPS or verdict problem rejects. */
export function evaluateAddressValidation(
  status: number,
  bodyText: string,
  input: ShipToAddress,
): ShipToVerdict {
  if (status < 200 || status >= 300) {
    return { kind: "unavailable", reason: `Google Address Validation HTTP ${status}` }
  }
  let data: unknown
  try {
    data = JSON.parse(bodyText)
  } catch {
    return { kind: "unavailable", reason: "non-JSON body" }
  }
  if (!isRecord(data)) return { kind: "unavailable", reason: "non-object body" }
  if (isRecord(data.error) && data.error.status === "REQUEST_DENIED") {
    return { kind: "unavailable", reason: "REQUEST_DENIED" }
  }
  const result = isRecord(data.result) ? data.result : undefined
  const verdict = result && isRecord(result.verdict) ? result.verdict : undefined
  if (!result || !verdict) return { kind: "unavailable", reason: "no verdict" }
  const address = isRecord(result.address) ? result.address : {}
  const usps = isRecord(result.uspsData) ? result.uspsData : undefined
  if (typeof usps?.errorMessage === "string" && usps.errorMessage) {
    return { kind: "reject", reason: `USPS rejected this address: ${usps.errorMessage}` }
  }
  if (!ACCEPTED_GRANULARITIES.has(String(verdict.validationGranularity))) {
    return { kind: "reject", reason: `granularity ${String(verdict.validationGranularity)}` }
  }
  if (verdict.addressComplete !== true) return { kind: "reject", reason: "incomplete" }
  const action = String(verdict.possibleNextAction)
  if (REJECTED_ACTIONS.has(action)) return { kind: "reject", reason: `next action ${action}` }
  const unconfirmed = Array.isArray(address.unconfirmedComponentTypes)
    ? (address.unconfirmedComponentTypes as unknown[]).map(String)
    : []
  const critical = unconfirmed.find((type) => CRITICAL_COMPONENTS.has(type))
  if (critical) return { kind: "reject", reason: `unconfirmed ${critical}` }
  if (usps) {
    const dpv = typeof usps.dpvConfirmation === "string" ? usps.dpvConfirmation : ""
    const accepted =
      dpv === "" || dpv === "Y" || (dpv === "S" && (action === "ACCEPT" || action === "CONFIRM"))
    if (!accepted) return { kind: "reject", reason: `DPV ${dpv}` }
  }
  const postal = isRecord(address.postalAddress) ? address.postalAddress : undefined
  const lines = Array.isArray(postal?.addressLines) ? (postal.addressLines as unknown[]) : []
  const suggestion: ShipToAddress | undefined = postal
    ? {
        line1: String(lines[0] ?? ""),
        ...(lines[1] ? { line2: String(lines[1]) } : {}),
        city: String(postal.locality ?? ""),
        state: String(postal.administrativeArea ?? ""),
        zip: String(postal.postalCode ?? ""),
      }
    : undefined
  const corrected =
    !!suggestion &&
    (suggestion.line1.toLowerCase() !== input.line1.toLowerCase() ||
      suggestion.city.toLowerCase() !== input.city.toLowerCase() ||
      suggestion.state.toUpperCase() !== input.state.toUpperCase() ||
      suggestion.zip.slice(0, 5) !== input.zip.slice(0, 5))
  return {
    kind: "accept",
    formattedAddress:
      typeof address.formattedAddress === "string" ? address.formattedAddress : undefined,
    corrected,
    suggestion,
  }
}

/** POST `<base>/v1:validateAddress?key=…` and evaluate the answer. */
export async function validateShipTo(
  send: Fetch,
  base: string,
  key: string | undefined,
  address: ShipToAddress,
): Promise<ShipToVerdict> {
  const url = `${base}/v1:validateAddress${key === undefined ? "" : `?key=${encodeURIComponent(key)}`}`
  const res = await send(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validationRequestBody(address)),
    }),
  )
  return evaluateAddressValidation(res.status, await res.text(), address)
}
