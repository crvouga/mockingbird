/**
 * Gene by Gene's two address checks, and the deterministic courier menu behind them.
 *
 * 1. **Quote** (`getShippingOptions`), as recorded against staging (`corpus/address-parity.json`):
 *    request validation (HTTP 400 problem details), then two address rules (HTTP 200
 *    `errorMessages`), then the carrier's own refusals (HTTP 500 `ErrorDto`), then the menu for the
 *    destination class. A quote that passes returns a menu even for an address the place check
 *    rejects.
 * 2. **Place** (`POST /api/v2/orders` with `shipments`, and `updateShipmentAddress`): the quote's
 *    refusals, then the USPS deliverability class (`Address Not Found`).
 *
 * The split between the two is the production behaviour this mock exists to reproduce (a rural
 * street quotes fine and the order then fails). Nothing here calls a carrier or USPS: the zone
 * table, the ZIP3 → state table and the committed corpus are the oracle. Prices and dates are
 * deterministic in the mock clock; live parity compares code sets and classes, never prices.
 */
import type { AddressDto } from "./types.js"

/** Every order address line (1, 2 and 3) is capped at 35 UTF-16 code units. */
export const MAX_ADDRESS_LINE = 35

/** Ship-from: the vendor's sample origin and lab (return labels come back here). */
export const SHIP_FROM = {
  addressLine1: "1445 N Loop W",
  city: "Houston",
  stateOrRegion: "TX",
  postalCode: "77008",
  countryCode: "US",
  timeZone: "America/Chicago",
} as const

// --- courier services --------------------------------------------------------------------------

export type CourierService = {
  courierName: string
  courierServiceCode: string
  courierServiceDisplayName: string
  /** Zone-6 residential price recorded for rural Oklahoma ZIP 73938, deluxe bundle, quantity 1. */
  anchorPrice: number
  isOneRate: boolean
  /** Business days in transit for `zone`, before the weekend skip. */
  transitDays: (zone: number) => number
}

const DHL_EXPEDITED: CourierService = {
  courierName: "DHL",
  courierServiceCode: "DHL_PARCEL_EXPEDITED",
  courierServiceDisplayName: "DHL Expedited",
  anchorPrice: 6,
  isOneRate: false,
  transitDays: (zone) => 2 + Math.ceil(zone / 2),
}

/** The domestic outbound menu, in the order staging lists it. */
export const COURIER_SERVICES: readonly CourierService[] = [
  DHL_EXPEDITED,
  {
    courierName: "FedEx",
    courierServiceCode: "FEDEX_PRIORITY_OVERNIGHT",
    courierServiceDisplayName: "FedEx Priority Overnight",
    anchorPrice: 62.23,
    isOneRate: false,
    transitDays: () => 1,
  },
  {
    courierName: "FedEx",
    courierServiceCode: "FEDEX_2_DAY_ONE_RATE",
    courierServiceDisplayName: "FedEx Standard 2Day One Rate",
    anchorPrice: 14.91,
    isOneRate: true,
    transitDays: () => 2,
  },
  {
    courierName: "FedEx",
    courierServiceCode: "FEDEX_EXPRESS_SAVER_ONE_RATE",
    courierServiceDisplayName: "FedEx Express Saver One Rate",
    anchorPrice: 14.91,
    isOneRate: true,
    transitDays: () => 3,
  },
]

/**
 * The menu for a destination outside the US, in the order staging lists it. The codes and names
 * are recorded; the prices are synthetic (no international quote has been recorded with prices).
 */
export const INTERNATIONAL_SERVICES: readonly CourierService[] = [
  {
    courierName: "FedEx",
    courierServiceCode: "FEDEX_INTERNATIONAL_PRIORITY",
    courierServiceDisplayName: "FedEx International Priority",
    anchorPrice: 96.4,
    isOneRate: false,
    transitDays: () => 3,
  },
  {
    courierName: "FedEx",
    courierServiceCode: "FEDEX_INTERNATIONAL_CONNECT_PLUS",
    courierServiceDisplayName: "FedEx International Connect Plus",
    anchorPrice: 58.75,
    isOneRate: false,
    transitDays: () => 5,
  },
  {
    courierName: "FedEx",
    courierServiceCode: "FEDEX_INTERNATIONAL_ECONOMY",
    courierServiceDisplayName: "FedEx International Economy",
    anchorPrice: 71.2,
    isOneRate: false,
    transitDays: () => 6,
  },
]

/**
 * The return leg baked into the bundle. Never an outbound quote option, but `POST /orders`
 * accepts it (non-prod placement falls back to it when it does not quote).
 */
export const RETURN_COURIER = {
  courierServiceCode: "DHL_DOMESTIC_RETURN",
  courierServiceDisplayName: "DHL Domestic Return",
} as const

/** Display name for every code `POST /orders` stores. */
export const courierServiceName = (code: string): string | null =>
  code === RETURN_COURIER.courierServiceCode
    ? RETURN_COURIER.courierServiceDisplayName
    : ([...COURIER_SERVICES, ...INTERNATIONAL_SERVICES].find((s) => s.courierServiceCode === code)
        ?.courierServiceDisplayName ?? null)

// --- zones -------------------------------------------------------------------------------------

/** Price factor per zone; zone 6 (the anchor) is 1. */
export const ZONE_FACTORS: Readonly<Record<number, number>> = {
  2: 0.72,
  3: 0.8,
  4: 0.88,
  5: 0.94,
  6: 1,
  7: 1.12,
  8: 1.35,
  /** Outside the US: the international menu's own anchor prices. */
  9: 1,
}

const inRange = (zip3: number, ranges: readonly (readonly [number, number])[]) =>
  ranges.some(([lo, hi]) => zip3 >= lo && zip3 <= hi)

/** ZIP3 prefixes of the territories (Puerto Rico, the Virgin Islands, Guam): DHL only. */
const TERRITORY_ZIP3: readonly (readonly [number, number])[] = [
  [6, 9],
  [969, 969],
]

/** The zone international destinations price in. */
export const INTERNATIONAL_ZONE = 9

/** Destination zone from Houston (ZIP3 770), or undefined for a ZIP3 that is not digits. */
export const zoneFor = (zip3: string): number | undefined => {
  const n = Number(zip3)
  if (!/^\d{3}$/.test(zip3)) return undefined
  if (inRange(n, TERRITORY_ZIP3)) return 8
  if (inRange(n, [[770, 778]])) return 2
  if (
    inRange(n, [
      [750, 769],
      [779, 799],
    ])
  )
    return 3
  if (inRange(n, [[730, 749]])) return 6
  if (
    inRange(n, [
      [800, 847],
      [850, 865],
    ])
  )
    return 5
  if (
    inRange(n, [
      [900, 961],
      [100, 149],
      [980, 994],
    ])
  )
    return 7
  if (
    inRange(n, [
      [967, 968],
      [995, 999],
    ])
  )
    return 8
  return 4
}

/** Zone 8 (Hawaii, Alaska) drops FedEx Express Saver, as staging quotes it. */
export const menuFor = (zone: number): readonly CourierService[] =>
  zone === INTERNATIONAL_ZONE
    ? INTERNATIONAL_SERVICES
    : zone === 8
      ? COURIER_SERVICES.filter((s) => s.courierServiceCode !== "FEDEX_EXPRESS_SAVER_ONE_RATE")
      : COURIER_SERVICES

/** Round half away from zero to cents. */
export const roundCents = (value: number): number =>
  (Math.sign(value) * Math.round(Math.abs(value) * 100 + 1e-7)) / 100

/** The ZIP whose recorded quote is the anchor: its DHL price carries no residential surcharge. */
export const ANCHOR_ZIP = "73938"
export const RESIDENTIAL_DHL_SURCHARGE = 0.5

export const priceFor = (
  service: CourierService,
  zone: number,
  options: { residential: boolean; zip5: string },
): number => {
  const base = roundCents(
    (service.anchorPrice * (ZONE_FACTORS[zone] ?? 1)) / (ZONE_FACTORS[6] as number),
  )
  const surcharge =
    options.residential &&
    service.courierServiceCode === "DHL_PARCEL_EXPEDITED" &&
    options.zip5 !== ANCHOR_ZIP
  return surcharge ? roundCents(base + RESIDENTIAL_DHL_SURCHARGE) : base
}

// --- ZIP3 → state (USPS prefix assignments) -----------------------------------------------------

const STATE_RANGES: readonly (readonly [number, number, string])[] = [
  [5, 5, "NY"],
  [6, 7, "PR"],
  [8, 8, "VI"],
  [9, 9, "PR"],
  [10, 27, "MA"],
  [28, 29, "RI"],
  [30, 38, "NH"],
  [39, 49, "ME"],
  [50, 54, "VT"],
  [55, 55, "MA"],
  [56, 59, "VT"],
  [60, 69, "CT"],
  [70, 89, "NJ"],
  [90, 99, "AE"],
  [100, 149, "NY"],
  [150, 196, "PA"],
  [197, 199, "DE"],
  [200, 200, "DC"],
  [201, 201, "VA"],
  [202, 205, "DC"],
  [206, 219, "MD"],
  [220, 246, "VA"],
  [247, 268, "WV"],
  [270, 289, "NC"],
  [290, 299, "SC"],
  [300, 319, "GA"],
  [320, 339, "FL"],
  [340, 340, "AA"],
  [341, 349, "FL"],
  [350, 369, "AL"],
  [370, 385, "TN"],
  [386, 397, "MS"],
  [398, 399, "GA"],
  [400, 427, "KY"],
  [430, 459, "OH"],
  [460, 479, "IN"],
  [480, 499, "MI"],
  [500, 528, "IA"],
  [530, 549, "WI"],
  [550, 567, "MN"],
  [569, 569, "DC"],
  [570, 577, "SD"],
  [580, 588, "ND"],
  [590, 599, "MT"],
  [600, 629, "IL"],
  [630, 658, "MO"],
  [660, 679, "KS"],
  [680, 693, "NE"],
  [700, 714, "LA"],
  [716, 729, "AR"],
  [730, 732, "OK"],
  [733, 733, "TX"],
  [734, 749, "OK"],
  [750, 799, "TX"],
  [800, 816, "CO"],
  [820, 831, "WY"],
  [832, 838, "ID"],
  [840, 847, "UT"],
  [850, 865, "AZ"],
  [870, 884, "NM"],
  [885, 885, "TX"],
  [889, 898, "NV"],
  [900, 961, "CA"],
  [962, 966, "AP"],
  [967, 968, "HI"],
  [969, 969, "GU"],
  [970, 979, "OR"],
  [980, 994, "WA"],
  [995, 999, "AK"],
]

/** The state USPS assigns a ZIP3 prefix to, or undefined for an unassigned prefix. */
export const stateForZip3 = (zip3: string): string | undefined => {
  if (!/^\d{3}$/.test(zip3)) return undefined
  const n = Number(zip3)
  return STATE_RANGES.find(([lo, hi]) => n >= lo && n <= hi)?.[2]
}

// --- the committed address corpus ---------------------------------------------------------------

/** ZIP3 prefixes the place-time USPS check never finds (quote still answers their zone). */
export const UNDELIVERABLE_ZIP3: readonly string[] = ["000", "590"]

export type CorpusKind = "quote-ok-place-not-found" | "quote-ok-place-ok"

export type CorpusAddress = {
  kind: CorpusKind
  addressLine1: string
  city: string
  stateOrRegion: string
  postalCode: string
  /** Why the row is in the corpus. */
  note: string
}

/** Synthetic streets (no real person): quote returns a menu, place answers Address Not Found. */
export const QUOTE_OK_PLACE_NOT_FOUND: readonly CorpusAddress[] = [
  {
    kind: "quote-ok-place-not-found",
    addressLine1: "1 Unlisted County Road 9",
    city: "Nowhere",
    stateOrRegion: "MT",
    postalCode: "59001",
    note: "rural route the USPS file does not list",
  },
  {
    kind: "quote-ok-place-not-found",
    addressLine1: "501 N 5th St",
    city: "Phoenix",
    stateOrRegion: "AZ",
    postalCode: "85004",
    note: "street number the deliverability check rejects; quote still returns the zone-5 menu",
  },
  {
    kind: "quote-ok-place-not-found",
    addressLine1: "4440 County Road 000",
    city: "Valles Mines",
    stateOrRegion: "MO",
    postalCode: "63087",
    note: "same class as the production rural miss; this street number is synthetic",
  },
]

/** Public landmarks: quote and place both succeed. */
export const QUOTE_OK_PLACE_OK: readonly CorpusAddress[] = [
  {
    kind: "quote-ok-place-ok",
    addressLine1: "1600 Amphitheatre Pkwy",
    city: "Mountain View",
    stateOrRegion: "CA",
    postalCode: "94043",
    note: "zone 7",
  },
  {
    kind: "quote-ok-place-ok",
    addressLine1: "1445 N Loop W",
    city: "Houston",
    stateOrRegion: "TX",
    postalCode: "77008",
    note: "vendor's own sample origin, zone 2 (line2 `Ste 900` stays on line2)",
  },
  {
    kind: "quote-ok-place-ok",
    addressLine1: "350 Fifth Avenue",
    city: "New York",
    stateOrRegion: "NY",
    postalCode: "10118",
    note: "zone 7",
  },
  {
    kind: "quote-ok-place-ok",
    addressLine1: "1 Infinite Loop",
    city: "Cupertino",
    stateOrRegion: "CA",
    postalCode: "95014",
    note: "zone 7",
  },
]

export const ADDRESS_CORPUS: readonly CorpusAddress[] = [
  ...QUOTE_OK_PLACE_NOT_FOUND,
  ...QUOTE_OK_PLACE_OK,
]

/** Case, punctuation and spacing do not change which corpus row a line matches. */
export const normalizeLine = (line: string): string =>
  line.toLowerCase().replace(/[.,#]/g, " ").replace(/\s+/g, " ").trim()

// --- the two checks -----------------------------------------------------------------------------

const blank = (value: string | null | undefined) =>
  typeof value !== "string" || value.trim().length === 0

const tooLong = (value: string | null | undefined) =>
  typeof value === "string" && value.length > MAX_ADDRESS_LINE

/**
 * `PO Box` and `P.O. Box` (staging quotes a spelled-out `Post Office Box` like a street). Each
 * run of spaces has one place to go, so a long line cannot make the match backtrack.
 */
const PO_BOX = /\bp\s*(?:\.\s*)?o\s*(?:\.\s*)?box\b/i

/** The state codes staging quotes as a US domestic address; anything else (AE, ZZ) is refused. */
const US_STATES: ReadonlySet<string> = new Set(
  (
    "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH " +
    "NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR VI GU AS MP"
  ).split(" "),
)
const TERRITORY_STATES: ReadonlySet<string> = new Set(["PR", "VI", "GU", "AS", "MP"])

export const MESSAGES = {
  lineLength: "Address Lines cannot be longer than 35 characters.",
  state: "Invalid state or region for US domestic address.",
  postal:
    "Code: DESTINATION.POSTALCODE.MISSING.ORINVALID,Message: Destination postal code missing or invalid.",
  /** The carrier's text, typo (`edEx`) included, as staging returns it. */
  zipState:
    "Code: CRSVZIP.CODE.INVALID,Message: edEx service is not currently available to this ZIP/postal code. Enter new information or contact FedEx Customer Service (U.S. and Canada, please dial 1.800.GoFedEx 1.800.463.3339).",
  addressNotFound: "Address Not Found",
} as const

/** FluentValidation's labels for the address fields it checks, as staging words them. */
const LABELS = {
  RecipientName: "Recipient Name",
  AddressLine1: "Address Line1",
  City: "City",
  StateOrRegion: "State Or Region",
  CountryCode: "Country Code",
  PostalCode: "Postal Code",
} as const

/**
 * The request validation staging runs before looking at the address (HTTP 400 problem details),
 * keyed `<prefix>.<Field>` in key order. Recorded rules: recipient, line1, city and state must not
 * be empty; state and country must be exactly 2 characters (a blank state fails both rules); a
 * non-empty postal code needs at least 5 characters. Phone is not checked.
 */
export const addressValidationErrors = (
  address: AddressDto | undefined,
  prefix = "shippingAddress",
): Record<string, string[]> => {
  const a = address ?? {}
  const errors: Record<string, string[]> = {}
  const add = (field: keyof typeof LABELS, message: string) => {
    const key = `${prefix}.${field}`
    errors[key] = [...(errors[key] ?? []), message]
  }
  const label = (field: keyof typeof LABELS) => `'Shipping Address ${LABELS[field]}'`
  const notEmpty = (field: keyof typeof LABELS, value: string | null | undefined) => {
    if (blank(value)) add(field, `${label(field)} must not be empty.`)
  }
  const exactly2 = (field: keyof typeof LABELS, value: string | null | undefined) => {
    if (typeof value === "string" && value.length !== 2) {
      add(
        field,
        `${label(field)} must be 2 characters in length. You entered ${value.length} characters.`,
      )
    }
  }
  notEmpty("RecipientName", a.recipientName)
  notEmpty("AddressLine1", a.addressLine1)
  notEmpty("City", a.city)
  notEmpty("StateOrRegion", a.stateOrRegion)
  exactly2("StateOrRegion", a.stateOrRegion)
  exactly2("CountryCode", a.countryCode)
  if (typeof a.postalCode === "string" && a.postalCode.length > 0 && a.postalCode.length < 5) {
    add(
      "PostalCode",
      `The length of ${label("PostalCode")} must be at least 5 characters. You entered ${a.postalCode.length} characters.`,
    )
  }
  return Object.fromEntries(Object.entries(errors).sort(([x], [y]) => x.localeCompare(y)))
}

export type QuoteVerdict =
  /** HTTP 400 problem details. */
  | { kind: "validation"; errors: Record<string, string[]> }
  /** HTTP 200 with `errorMessages` and no options. */
  | { kind: "errorMessages"; errorMessages: string[] }
  /** HTTP 500 `ErrorDto`: the carrier refused the destination. */
  | { kind: "carrier"; message: string }
  | { kind: "ok"; zone: number; services: readonly CourierService[] }

/**
 * What staging's quote answers for an address, in the order it decides: request validation, the
 * two address rules (any line over 35 characters, a state that is not a US state or territory),
 * the carrier's refusals (a US postal code that is not a ZIP, a state that disagrees with the
 * ZIP3), then the menu: DHL only for a PO Box or a territory, no Express Saver in zone 8, the
 * international FedEx menu outside the US. Values are judged as sent: nothing is trimmed,
 * abbreviated or coerced.
 */
export const quoteVerdict = (address: AddressDto | undefined): QuoteVerdict => {
  const errors = addressValidationErrors(address)
  if (Object.keys(errors).length > 0) return { kind: "validation", errors }
  const a = address as AddressDto
  const us = a.countryCode === "US"
  const state = (a.stateOrRegion as string).toUpperCase()
  const errorMessages: string[] = []
  if (tooLong(a.addressLine1) || tooLong(a.addressLine2) || tooLong(a.addressLine3)) {
    errorMessages.push(MESSAGES.lineLength)
  }
  if (us && !US_STATES.has(state)) errorMessages.push(MESSAGES.state)
  if (errorMessages.length > 0) return { kind: "errorMessages", errorMessages }
  if (!us) return { kind: "ok", zone: INTERNATIONAL_ZONE, services: INTERNATIONAL_SERVICES }
  const postal = a.postalCode ?? ""
  if (!/^\d{5}(-\d{4})?$/.test(postal)) return { kind: "carrier", message: MESSAGES.postal }
  const zip3 = postal.slice(0, 3)
  const zone = zoneFor(zip3) as number
  const dhlOnly =
    TERRITORY_STATES.has(state) ||
    inRange(Number(zip3), TERRITORY_ZIP3) ||
    (typeof a.addressLine1 === "string" && PO_BOX.test(a.addressLine1))
  if (dhlOnly) return { kind: "ok", zone, services: [DHL_EXPEDITED] }
  const assigned = stateForZip3(zip3)
  if (assigned && assigned !== state) return { kind: "carrier", message: MESSAGES.zipState }
  return { kind: "ok", zone, services: menuFor(zone) }
}

export type PlaceClass =
  | { ok: true }
  | { ok: false; kind: "structural" | "address-not-found"; reason: string }

/**
 * The place-time check: whatever the quote would refuse, then the USPS deliverability class.
 * Only the Address Not Found answer is recorded live (`corpus/address-parity.json`); a quote
 * refusal at place answers the same `not validated` template with the quote's first message, and
 * a carrier refusal (not a ZIP, ZIP3 in another state) is Address Not Found. `extra` are
 * namespace corpus rows (`PUT /__admin/addresses/corpus`); a `quote-ok-place-ok` row for the same
 * line1 and ZIP5 wins over every Address Not Found rule.
 */
export const placeCheck = (
  address: AddressDto | undefined,
  extra: readonly CorpusAddress[] = [],
): PlaceClass => {
  const verdict = quoteVerdict(address)
  if (verdict.kind === "validation") {
    const [first] = Object.values(verdict.errors).flat()
    return { ok: false, kind: "structural", reason: first as string }
  }
  if (verdict.kind === "errorMessages") {
    return { ok: false, kind: "structural", reason: verdict.errorMessages[0] as string }
  }
  const notFound = {
    ok: false,
    kind: "address-not-found",
    reason: MESSAGES.addressNotFound,
  } as const
  if (verdict.kind === "carrier") return notFound
  const a = address as AddressDto
  if (a.countryCode !== "US") return { ok: true }
  const line = normalizeLine(a.addressLine1 as string)
  const zip5 = (a.postalCode as string).slice(0, 5)
  const zip3 = zip5.slice(0, 3)
  const corpus = [...extra, ...ADDRESS_CORPUS]
  const listed = (kind: CorpusKind) =>
    corpus.some(
      (row) =>
        row.kind === kind &&
        normalizeLine(row.addressLine1) === line &&
        (kind === "quote-ok-place-not-found" || row.postalCode.slice(0, 5) === zip5),
    )
  if (listed("quote-ok-place-ok")) return { ok: true }
  if (UNDELIVERABLE_ZIP3.includes(zip3)) return notFound
  if (listed("quote-ok-place-not-found")) return notFound
  return { ok: true }
}

/** `Shipping address(es) not validated: <addressLine1 as sent> : <reason>`. */
export const notValidatedMessage = (address: AddressDto | undefined, reason: string): string =>
  `Shipping address(es) not validated: ${address?.addressLine1 ?? ""} : ${reason}`

// --- the quote ----------------------------------------------------------------------------------

export type ShippingOption = {
  courierName: string
  courierServiceCode: string
  courierServiceDisplayName: string
  estimatedShipDate: string
  estimatedPrice: number
  estimatedDeliveryDate: string | null
  attributes: Record<string, string>
}

/** The priced menu for an address the quote accepts, or undefined when it refuses it. */
export const quoteMenu = (
  address: AddressDto,
  nowMs: number,
): { zone: number; options: ShippingOption[] } | undefined => {
  const verdict = quoteVerdict(address)
  if (verdict.kind !== "ok") return undefined
  const { zone } = verdict
  const zip5 = (address.postalCode ?? "").slice(0, 5)
  const ship = nextBusinessMorning(nowMs)
  const residential = address.isCommercial !== true
  return {
    zone,
    options: verdict.services.map((service) => {
      const transit = service.transitDays(zone) + (zone === 8 ? 2 : 0)
      return {
        courierName: service.courierName,
        courierServiceCode: service.courierServiceCode,
        courierServiceDisplayName: service.courierServiceDisplayName,
        estimatedShipDate: net7(chicagoToUtc(ship, 8)),
        estimatedPrice: priceFor(service, zone, { residential, zip5 }),
        estimatedDeliveryDate:
          transit > 0 ? net7(chicagoToUtc(addBusinessDays(ship, transit), 17)) : null,
        attributes: { isSaturdayDelivery: "false", isOneRate: String(service.isOneRate) },
      }
    }),
  }
}

// --- time: America/Chicago calendar days, .NET 7-digit instants --------------------------------

type Day = { y: number; m: number; d: number }

const chicagoFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: SHIP_FROM.timeZone,
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
  hourCycle: "h23",
})

const chicagoParts = (ms: number) => {
  const parts: Record<string, number> = {}
  for (const part of chicagoFormat.formatToParts(new Date(ms))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value)
  }
  return parts as {
    year: number
    month: number
    day: number
    hour: number
    minute: number
    second: number
  }
}

/** The America/Chicago calendar day an instant falls on. */
export const chicagoDay = (ms: number): Day => {
  const p = chicagoParts(ms)
  return { y: p.year, m: p.month, d: p.day }
}

const offsetMs = (ms: number) => {
  const p = chicagoParts(ms)
  return (
    Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000
  )
}

/** The UTC instant of `hour`:00 America/Chicago on `day`. */
export const chicagoToUtc = (day: Day, hour: number): number => {
  const guess = Date.UTC(day.y, day.m - 1, day.d, hour)
  return guess - offsetMs(guess - offsetMs(guess))
}

const weekday = (day: Day) => new Date(Date.UTC(day.y, day.m - 1, day.d)).getUTCDay()
const nextDay = (day: Day): Day => {
  const next = new Date(Date.UTC(day.y, day.m - 1, day.d + 1))
  return { y: next.getUTCFullYear(), m: next.getUTCMonth() + 1, d: next.getUTCDate() }
}
const isWeekend = (day: Day) => weekday(day) === 0 || weekday(day) === 6

export const addBusinessDays = (day: Day, count: number): Day => {
  let current = day
  for (let left = count; left > 0; ) {
    current = nextDay(current)
    if (!isWeekend(current)) left--
  }
  return current
}

/** The next business day after today in Houston (the warehouse ships at 08:00 local). */
export const nextBusinessMorning = (nowMs: number): Day => addBusinessDays(chicagoDay(nowMs), 1)

/** `2026-06-02T13:00:00.0000000Z`: .NET's round-trip format, seven fractional digits. */
export const net7 = (ms: number): string =>
  new Date(ms).toISOString().replace(/\.(\d{3})Z$/, ".$10000Z")

/** `M/D/YYYY` in America/Chicago (`Order.Shipped` `CloseoutDate`). */
export const closeoutDate = (ms: number): string => {
  const { y, m, d } = chicagoDay(ms)
  return `${m}/${d}/${y}`
}

// --- tracking numbers ---------------------------------------------------------------------------

/** `count` decimal digits derived from `seed` (FNV-1a, re-salted per chunk): same seed, same digits. */
export const hashDigits = (seed: string, count: number): string => {
  let out = ""
  for (let chunk = 0; out.length < count; chunk++) {
    let h = 0x811c9dc5 ^ chunk
    for (const ch of `${chunk}:${seed}`) {
      h ^= ch.charCodeAt(0)
      h = Math.imul(h, 0x01000193) >>> 0
    }
    out += String(h % 1_000_000_000).padStart(9, "0")
  }
  return out.slice(0, count)
}

/**
 * Deterministic tracking numbers shaped like the live ones (never copied from a real one): DHL
 * eCommerce `420` + destination ZIP5 + 26 digits hashed from the shipment id, 34 digits in all
 * (the return label uses the lab's ZIP 77008), and a 12-digit FedEx number for `FEDEX_*`
 * outbound shipments. The lengths are the recorded production ones
 * (`GXG/docs/gxg-list-orders-prod.json`: 34-digit `420…` return labels, 12-digit FedEx).
 */
export const trackingNumberFor = (input: {
  shipmentId: string
  isReturnShipment: boolean
  courierServiceCode: string | null
  postalCode: string | null | undefined
}): string => {
  if (!input.isReturnShipment && input.courierServiceCode?.startsWith("FEDEX_")) {
    return hashDigits(`fedex:${input.shipmentId}`, 12)
  }
  const zip5 = input.isReturnShipment
    ? SHIP_FROM.postalCode
    : /^\d{5}/.test(input.postalCode ?? "")
      ? (input.postalCode as string).slice(0, 5)
      : SHIP_FROM.postalCode
  return `420${zip5}${hashDigits(`dhl:${input.shipmentId}`, 26)}`
}
