/**
 * Appointment scheduling surface: phlebotomy + PSC availability/booking lifecycle,
 * cancellation reasons, area serviceability, and PSC site info.
 *
 * Slot data is generated deterministically (seeded by zip/site/date), so walks are
 * reproducible without any provider-side state.
 */
import { HttpError, jsonRes, opaqueToken, type OperationContext } from "@crvouga/mockingbird-service"
import type {
  AppointmentEventRecord,
  AppointmentModality,
  AppointmentRecord,
  BookingKeyRecord,
  JunctionState,
} from "./state.js"

const cachedResponse = (state: JunctionState, context: OperationContext) => {
  const body =
    context.request.method.toUpperCase() === "GET" || context.request.method.toUpperCase() === "HEAD"
      ? undefined
      : context.body.kind === "json"
        ? context.body.value
        : context.body.kind === "form"
          ? context.body.value
          : undefined
  const key = state.cacheKeyForRequest(
    context.request.method,
    context.url.pathname,
    context.url.searchParams,
    body,
  )
  const cached = state.getGetCache(key)
  if (!cached) return undefined
  if (key.toLowerCase().includes("availability")) {
    materializeAvailabilityBookingKeys(state, context, cached.body)
    rotateAvailabilityBookingKeys(state, cached.body, context.now())
  }
  const headers = new Headers(cached.headers)
  if (!headers.has("content-type")) headers.set("content-type", "application/json")
  return new Response(JSON.stringify(cached.body), { status: cached.status, headers })
}

/**
 * Ensure booking_key records exist for a cached availability response.
 * Prefer deterministic slot generation (rich address/provider), then fill any remaining
 * oracle keys from the cached body using the request zip.
 */
const materializeAvailabilityBookingKeys = (
  state: JunctionState,
  context: OperationContext,
  cachedBody: unknown,
) => {
  const requestBody =
    context.body.kind === "json" &&
    typeof context.body.value === "object" &&
    context.body.value !== null &&
    !Array.isArray(context.body.value)
      ? (context.body.value as Record<string, unknown>)
      : {}
  const zip =
    typeof requestBody.zip_code === "string" && /^\d{5}/.test(requestBody.zip_code)
      ? requestBody.zip_code.slice(0, 5)
      : "85004"
  const path = context.url.pathname
  const modalityHint = path.includes("psc")
    ? ("patient_service_center" as const)
    : path.includes("phlebotomy")
      ? ("phlebotomy" as const)
      : undefined
  state.hydrateBookingKeysFromAvailability(cachedBody, context.now(), zip, modalityHint)
  // Normalize address/provider/modality on oracle keys so book/reschedule match generated shape.
  if (typeof cachedBody === "object" && cachedBody !== null && !Array.isArray(cachedBody)) {
    const root = cachedBody as Record<string, unknown>
    const dayBuckets: unknown[] = []
    if (Array.isArray(root.days)) dayBuckets.push(...root.days)
    if (Array.isArray(root.slots)) dayBuckets.push(...root.slots)
    for (const day of dayBuckets) {
      if (typeof day !== "object" || day === null || Array.isArray(day)) continue
      const daySlots = (day as Record<string, unknown>).slots
      const slots = Array.isArray(daySlots) ? daySlots : [day]
      for (const entry of slots) {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue
        const slot = entry as Record<string, unknown>
        const bookingKey = typeof slot.booking_key === "string" ? slot.booking_key : ""
        if (!bookingKey) continue
        const record = state.bookingKeys.get(bookingKey)
        if (!record) continue
        if (modalityHint) record.modality = modalityHint
        record.zip_code = zip
        record.provider = record.modality === "patient_service_center" ? "quest" : "getlabs"
        record.address = addressFromAvailabilityRequest(requestBody, zip)
        record.location = zipLocation(zip)
        state.bookingKeys.update(bookingKey, record)
      }
    }
  }
}

/**
 * Vital mints fresh booking_key values on every availability response while the slot
 * skeleton stays stable, and previously issued keys remain bookable. Mirror that: each
 * serve registers a new record per slot position (deriving slot facts from the current
 * record for that position) and rewrites the served body, leaving stale keys bookable
 * until consumed/expired.
 */
const rotateAvailabilityBookingKeys = (
  state: JunctionState,
  cachedBody: unknown,
  nowMs: number,
): void => {
  if (typeof cachedBody !== "object" || cachedBody === null || Array.isArray(cachedBody)) return
  const root = cachedBody as Record<string, unknown>
  const dayBuckets: unknown[] = []
  if (Array.isArray(root.days)) dayBuckets.push(...root.days)
  if (Array.isArray(root.slots)) dayBuckets.push(...root.slots)
  for (const day of dayBuckets) {
    if (typeof day !== "object" || day === null || Array.isArray(day)) continue
    const daySlots = (day as Record<string, unknown>).slots
    const slots = Array.isArray(daySlots) ? daySlots : [day]
    for (let index = 0; index < slots.length; index += 1) {
      const slot = slots[index]
      if (typeof slot !== "object" || slot === null || Array.isArray(slot)) continue
      const entry = slot as Record<string, unknown>
      const sealedKey = typeof entry.booking_key === "string" ? entry.booking_key : ""
      if (!sealedKey) continue
      const sealed = state.bookingKeys.get(sealedKey)
      if (!sealed) continue
      const freshKey = bookingKeyRotationFor(state, sealedKey, nowMs, index)
      const record: BookingKeyRecord = {
        ...sealed,
        key: freshKey,
        consumed_by_order_id: null,
        created_at: new Date(nowMs).toISOString(),
      }
      state.bookingKeys.insert(freshKey, record)
      entry.booking_key = freshKey
    }
  }
}

/**
 * Derive a fresh, unused booking key for a rotated slot. Mixing the sealed key, clock,
 * slot index, and an attempt counter keeps re-serves unique even under frozen test
 * clocks where consecutive serves share the same millisecond.
 */
const bookingKeyRotationFor = (
  state: JunctionState,
  sealedKey: string,
  nowMs: number,
  index: number,
): string => {
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const candidate = state.bookingKeyFor(`rotation:${sealedKey}:${nowMs}:${index}:${attempt}`)
    if (!state.bookingKeys.has(candidate)) return candidate
  }
  return state.bookingKeyFor(
    `rotation:${sealedKey}:${nowMs}:${index}:fallback:${state.bookingKeys.list().length}`,
  )
}

type DayBucket = Record<string, unknown>

/**
 * Rotation for the generated (cache-miss) availability paths: newly created slot
 * records are replaced with fresh records on every serve so repeated reads mint
 * fresh keys like the oracle, and the served body carries only the fresh keys.
 * When `override` is given (phlebotomy — Vital echoes the availability request
 * address on book), the fresh record's address/location/zip are re-aligned.
 */
const rotateGeneratedAvailabilityKeys = (
  state: JunctionState,
  days: Array<Record<string, unknown>>,
  nowMs: number,
  override?: { address: Record<string, unknown>; location: { lng: number; lat: number }; zip: string },
): void => {
  for (const day of days) {
    const slots = Array.isArray(day.slots) ? day.slots : []
    for (let index = 0; index < slots.length; index += 1) {
      const slot = slots[index]
      if (typeof slot !== "object" || slot === null || Array.isArray(slot)) continue
      const entry = slot as Record<string, unknown>
      const currentKey = typeof entry.booking_key === "string" ? entry.booking_key : ""
      if (!currentKey) continue
      const current = state.bookingKeys.get(currentKey)
      if (!current) continue
      const freshKey = bookingKeyRotationFor(state, currentKey, nowMs, index)
      const record: BookingKeyRecord = {
        ...current,
        key: freshKey,
        ...(override ?? {}),
        consumed_by_order_id: null,
        created_at: new Date(nowMs).toISOString(),
      }
      state.bookingKeys.insert(freshKey, record)
      entry.booking_key = freshKey
    }
  }
}

const PHLEBOTOMY_PROVIDERS = ["getlabs", "phlebfinders"] as const
type PhlebotomyProviderName = (typeof PHLEBOTOMY_PROVIDERS)[number]

const zipTimezone = (zip: string): string => {
  const prefix = Number(zip.slice(0, 3))
  if (!Number.isFinite(prefix) || prefix === 0) return "America/New_York"
  if (prefix < 500) return "America/New_York"
  if (prefix < 800) return "America/Chicago"
  // Arizona does not observe DST — Vital uses America/Phoenix for 850–865.
  if (prefix >= 850 && prefix <= 865) return "America/Phoenix"
  if (prefix < 900) return "America/Denver"
  return "America/Los_Angeles"
}

/** Known Vital sandbox centroids for booking location parity. */
const ZIP_LOCATION: Readonly<Record<string, { lat: number; lng: number }>> = {
  "85004": { lat: 33.6242904, lng: -111.9283407 },
}

const zipLocation = (zip: string): { lat: number; lng: number } => {
  const known = ZIP_LOCATION[zip.slice(0, 5)]
  if (known) return { ...known }
  // Deterministic fallback centroid so unknown zips stay stable across runs.
  const prefix = Number(zip.slice(0, 3)) || 0
  return {
    lat: 30 + (prefix % 20) * 0.4,
    lng: -120 + (prefix % 30) * 0.5,
  }
}

const cityStateForZip = (zip: string): { city: string; state: string } => {
  const tz = zipTimezone(zip)
  if (tz === "America/Phoenix") return { city: "Phoenix", state: "AZ" }
  if (tz === "America/Los_Angeles") return { city: "Los Angeles", state: "CA" }
  if (tz === "America/Denver") return { city: "Denver", state: "CO" }
  if (tz === "America/Chicago") return { city: "Chicago", state: "IL" }
  return { city: "New York", state: "NY" }
}

export const addressFromAvailabilityRequest = (
  requestBody: Record<string, unknown>,
  zip: string,
): Record<string, unknown> => {
  const { city, state } = cityStateForZip(zip)
  const firstLine =
    typeof requestBody.first_line === "string" && requestBody.first_line.length > 0
      ? requestBody.first_line
      : "1 Main St"
  const secondLine =
    typeof requestBody.second_line === "string"
      ? requestBody.second_line
      : requestBody.second_line === null
        ? ""
        : ""
  return {
    first_line: firstLine,
    second_line: secondLine,
    city:
      typeof requestBody.city === "string" && requestBody.city.length > 0
        ? requestBody.city
        : city,
    state:
      typeof requestBody.state === "string" && requestBody.state.length > 0
        ? requestBody.state
        : state,
    zip_code:
      typeof requestBody.zip_code === "string" && /^\d{5}/.test(requestBody.zip_code)
        ? requestBody.zip_code.slice(0, 5)
        : zip,
    unit: typeof requestBody.unit === "string" ? requestBody.unit : null,
    access_notes: null,
  }
}

const seededRandom = (seed: number): (() => number) => {
  let value = seed >>> 0 || 1
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0
    return value / 0x1_0000_0000
  }
}

const seedFor = (parts: ReadonlyArray<string | number>): number => {
  let hash = 0x811c9dc5
  for (const part of parts) {
    const text = String(part)
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i)
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
  }
  return hash >>> 0
}

const isoDate = (date: Date): string => date.toISOString().slice(0, 10)

const addDays = (iso: string, days: number): string => {
  const date = new Date(`${iso}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return isoDate(date)
}

const SCHEDULED_ORDER_EVENT: Record<AppointmentModality, string> = {
  phlebotomy: "collecting_sample.at_home_phlebotomy.appointment_scheduled",
  patient_service_center: "collecting_sample.walk_in_test.appointment_scheduled",
}

const CANCELLED_ORDER_EVENT: Record<AppointmentModality, string> = {
  phlebotomy: "collecting_sample.at_home_phlebotomy.appointment_cancelled",
  patient_service_center: "collecting_sample.walk_in_test.appointment_cancelled",
}

export const CANCELLATION_REASONS = [
  {
    id: "5c0257ef-6fea-4a22-b20a-3ddab573d5c9",
    name: "Did not fast for appointment",
    is_refundable: true,
  },
  { id: "448c519c-64b4-4497-ae73-622fa93371b3", name: "Do not trust company", is_refundable: true },
  {
    id: "d378e152-12d1-433e-9dd1-e0410f9331dc",
    name: "Getlabs cannot deliver to my preferred lab",
    is_refundable: true,
  },
  { id: "7be75f90-303d-4656-8eed-9bd3e20cb2cc", name: "Getlabs - late", is_refundable: true },
  {
    id: "ae3ec4dc-387c-42ac-835a-bf88fc4e411b",
    name: "Getlabs -Phleb Out Sick",
    is_refundable: true,
  },
  {
    id: "e2396e00-dd49-4f38-a395-51d6304c3312",
    name: "Getlabs rescheduled time does not work for patient",
    is_refundable: true,
  },
  { id: "5330c863-ac80-4316-901b-d305d0df74d5", name: "No longer interested", is_refundable: true },
  { id: "2b9f23fd-163e-4483-bb10-90c74a67e0dc", name: "Other", is_refundable: true },
  {
    id: "98f861dd-fe61-4817-a9d6-1b99b19cd0fb",
    name: "Provider asked me to cancel",
    is_refundable: true,
  },
  {
    id: "7dfd7da5-ed6e-40bb-a7e4-c8003f0c10a9",
    name: "Scheduled for wrong patient",
    is_refundable: true,
  },
  {
    id: "796da8c8-e654-4347-8ded-1026410c1976",
    name: "Scheduled time no longer works",
    is_refundable: true,
  },
  {
    id: "ba02af35-a34f-4a7a-abe5-5f766e8f6cd1",
    name: "Unable to get lab order from provider",
    is_refundable: true,
  },
  {
    id: "0c9425db-f11e-49c5-b976-3c0d1d4a4ea8",
    name: "Wanted to book in-person appointment",
    is_refundable: true,
  },
  {
    id: "2599a0ea-0b4a-42fe-8df6-d8f7c68182e7",
    name: "Went to lab for appointment",
    is_refundable: true,
  },
] as const

/** PSC offers a single cancellation reason in the sandbox. */
export const PSC_CANCELLATION_REASONS = [
  { id: "226a6520-667c-495f-8500-c20722d231d0", name: "Other", is_refundable: true },
] as const

/** The phlebotomy reason named "Other" requires explanatory notes. */
export const OTHER_CANCELLATION_REASON_ID = "2b9f23fd-163e-4483-bb10-90c74a67e0dc"

const PSC_LABS = [
  {
    lab_id: 25,
    slug: "sonora_quest",
    supported_bill_types: ["client_bill"],
    capabilities: ["appointment_scheduling_via_junction"],
  },
  {
    lab_id: 6,
    slug: "labcorp",
    supported_bill_types: ["client_bill", "commercial_insurance", "patient_bill"],
    capabilities: [],
  },
  {
    lab_id: 13,
    slug: "bioreference",
    supported_bill_types: ["patient_bill_passthrough"],
    capabilities: [],
  },
  {
    lab_id: 4,
    slug: "quest",
    supported_bill_types: ["client_bill", "commercial_insurance", "patient_bill"],
    capabilities: ["appointment_scheduling_via_junction"],
  },
] as const

/** Lab 3 (USSL) exists in the catalog but is excluded from PSC info in the sandbox. */
export const UNSUPPORTED_PSC_LAB_ID = 3

const AREA_LAB_BILLS: Readonly<Record<string, readonly string[]>> = {
  sonora_quest: ["client_bill"],
  labcorp: ["client_bill", "commercial_insurance", "patient_bill"],
  bioreference: ["patient_bill_passthrough"],
  quest: ["client_bill", "commercial_insurance", "patient_bill"],
}

const AREA_LABS: ReadonlyArray<{
  slug: string
  lab_id: number
  appointment_with_vital: boolean
  capabilities: readonly string[]
}> = [
  { slug: "sonora_quest", lab_id: 25, appointment_with_vital: true, capabilities: [] },
  { slug: "labcorp", lab_id: 6, appointment_with_vital: false, capabilities: [] },
  { slug: "bioreference", lab_id: 13, appointment_with_vital: false, capabilities: [] },
  {
    slug: "quest",
    lab_id: 4,
    appointment_with_vital: true,
    capabilities: ["appointment_scheduling_via_junction"],
  },
]

/** Zips where getlabs phlebotomy is offered (mirrors sandbox coverage). */
const PHLEBOTOMY_SERVED_PREFIXES: readonly number[] = [850, 900, 303, 917, 891]

const phlebotomyServed = (zip: string): boolean => {
  const prefix = Number(zip.slice(0, 3))
  return PHLEBOTOMY_SERVED_PREFIXES.includes(prefix)
}

/**
 * Deterministic PSC inventory model: the true number of sites within the radius is a
 * seeded function of zip + lab scaled by radius (the sandbox derives it from real geo
 * data); `psc/info` returns the nearest sites capped at 30. Unserviced zip prefixes
 * (000, 96x territories with no national-lab coverage) have no inventory.
 */
const UNSERVICED_PSC_PREFIXES: readonly number[] = [0]

const withinRadiusFor = (zip: string, labSlug: string, radius: number): number => {
  if (UNSERVICED_PSC_PREFIXES.includes(Number(zip.slice(0, 3)))) return 0
  const seed = seedFor(["psc-count", zip, labSlug])
  const fraction = seededRandom(seed)()
  return Math.round(fraction * radius * 1.6)
}

const PSC_SITE_NAMES = ["Downtown", "Midtown", "Harbor", "Central", "University", "Parkside"]
const PSC_SITE_HOURS: Readonly<Record<string, string>> = {
  monday: "08:00-17:00",
  tuesday: "08:00-17:00",
  wednesday: "08:00-17:00",
  thursday: "08:00-17:00",
  friday: "08:00-14:00",
}

const pscSiteFor = (zip: string, labSlug: string, index: number, radius: number) => {
  const random = seededRandom(seedFor(["psc-site", zip, labSlug, index]))
  const prefix = Number(zip.slice(0, 3))
  const state = prefix >= 900 ? "CA" : prefix >= 600 ? "CO" : prefix >= 300 ? "GA" : "NY"
  const city = PSC_SITE_NAMES[index % PSC_SITE_NAMES.length]
  const siteCodeSeed = seededRandom(seedFor(["psc-code", labSlug, index]))
  const siteCode =
    labSlug === "quest" || labSlug === "sonora_quest"
      ? Array.from({ length: 3 }, () =>
          String.fromCharCode(65 + Math.floor(siteCodeSeed() * 26)),
        ).join("")
      : String(10_000 + Math.floor(siteCodeSeed() * 89_999))
  return {
    name: `${labSlug.replace("_", " ")} - ${city}`,
    state,
    city,
    zip_code: zip,
    first_line: `${100 + Math.floor(random() * 800)} Main St`,
    phone_number: `+1${200 + Math.floor(random() * 700)}555${String(1000 + Math.floor(random() * 8999))}`,
    hours: PSC_SITE_HOURS,
    distance: Math.round((0.5 + random() * radius) * 10) / 10,
    site_code: siteCode,
    location: {
      lng: -122.4 + (random() - 0.5) * 0.2,
      lat: 37.77 + (random() - 0.5) * 0.2,
    },
  }
}

/**
 * Deterministic area model: `within_radius` mirrors the PSC inventory count per lab, the
 * phlebotomy section mirrors getlabs market coverage, and central_labs always lists the
 * four national labs with their billing/capability profiles.
 */
const areaInfoFor = (zip: string, radius: number) => {
  const served = phlebotomyServed(zip)
  const centralLabs: Record<string, unknown> = {}
  for (const lab of AREA_LABS) {
    centralLabs[lab.slug] = {
      patient_service_centers: {
        appointment_with_vital: lab.appointment_with_vital,
        within_radius: withinRadiusFor(zip, lab.slug, radius),
        radius: String(radius),
        capabilities: [...lab.capabilities],
      },
      supported_bill_types: [...(AREA_LAB_BILLS[lab.slug] ?? [])],
      lab_id: lab.lab_id,
    }
  }
  return {
    zip_code: zip,
    phlebotomy: {
      is_served: served,
      providers: served ? [{ name: "getlabs", service_types: ["appointment-ready"] }] : [],
    },
    central_labs: centralLabs,
  }
}

const jsonObject = (context: OperationContext): Record<string, unknown> => {
  const body = context.body
  const value = body.kind === "json" ? body.value : undefined
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(422, {
      detail: [
        {
          type: "model_attributes_type",
          loc: ["body"],
          msg: "Input should be a valid dictionary or object to extract fields from",
          input: value,
        },
      ],
    })
  }
  return value as Record<string, unknown>
}

const isUuid = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)

const uuidError = (value: string, loc: string[]) => {
  const characters = Array.from(value)
  const invalidIndex = characters.findIndex((character) => !/^[0-9a-f-]$/i.test(character))
  const error =
    invalidIndex >= 0
      ? `invalid character: expected an optional prefix of \`urn:uuid:\` followed by [0-9a-fA-F-], found \`${characters[invalidIndex]}\` at ${invalidIndex + 1}`
      : `invalid length: expected length 32 for simple format, found ${value.replaceAll("-", "").length}`
  return {
    type: "uuid_parsing",
    loc,
    msg: `Input should be a valid UUID, ${error}`,
    input: value,
    ctx: { error },
  }
}

const ALLOWED_RADII = [10, 20, 25, 50, 100] as const
const DEFAULT_RADIUS = 25

const radiusOf = (context: OperationContext): number => {
  const raw = context.query.radius
  if (raw === undefined) return DEFAULT_RADIUS
  const value = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : Number.NaN
  if (!ALLOWED_RADII.includes(value as (typeof ALLOWED_RADII)[number])) {
    throw new HttpError(422, {
      detail: [
        {
          type: "enum",
          loc: ["query", "radius"],
          msg: "Input should be '10', '20', '25', '50' or '100'",
          input: raw,
          ctx: { expected: "'10', '20', '25', '50' or '100'" },
        },
      ],
    })
  }
  return value
}

const zipCodeOf = (context: OperationContext, required: boolean): string | undefined => {
  const raw = context.query.zip_code
  if (raw === undefined) {
    if (required) {
      throw new HttpError(422, {
        detail: [
          {
            type: "missing",
            loc: ["query", "zip_code"],
            msg: "Field required",
            input: undefined,
          },
        ],
      })
    }
    return undefined
  }
  if (typeof raw !== "string") throw new HttpError(422, { detail: "zip_code must be a string" })
  return raw
}

const startDateOf = (context: OperationContext, nowMs: number): string => {
  const raw = context.query.start_date
  if (raw === undefined) return addDays(isoDate(new Date(nowMs)), 1)
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new HttpError(422, {
      detail: [
        {
          type: "date_from_datetime_parsing",
          loc: ["query", "start_date"],
          msg: "Input should be a valid date or datetime, invalid character in year",
          input: raw,
          ctx: { error: "invalid character in year" },
        },
      ],
    })
  }
  return raw
}

const appointmentOfOrder = (
  state: JunctionState,
  orderId: string,
): AppointmentRecord | undefined => {
  const binding = state.appointmentsByOrder.get(orderId)
  if (!binding) return undefined
  return state.appointments.get(binding.appointment_id)
}

const renderAppointment = (appointment: AppointmentRecord): Record<string, unknown> => ({
  id: appointment.id,
  user_id: appointment.user_id,
  order_id: appointment.order_id,
  address: appointment.address,
  location: appointment.location,
  start_at: appointment.start_at,
  end_at: appointment.end_at,
  iana_timezone: appointment.iana_timezone,
  type: appointment.type,
  provider: appointment.provider,
  status: appointment.status,
  provider_id: appointment.provider_id,
  external_id: appointment.external_id,
  can_reschedule: appointment.can_reschedule,
  event_status: appointment.event_status,
  event_data: appointment.event_data,
  order_transaction_id: appointment.order_transaction_id,
  appointment_notes: appointment.appointment_notes,
  events: appointment.events,
})

type SlotSeed = {
  bookingKey: string
  start: string
  end: string
  expiresAt: string
  price: number
  isPriority: boolean
  numAppointmentsAvailable: number
  modality: AppointmentModality
  provider: "getlabs" | "phlebfinders" | "quest"
  siteCode: string | null
  zipCode: string
  address: Record<string, unknown>
  location: { lng: number; lat: number }
}

const phlebotomyAddress = (zip: string): Record<string, unknown> => {
  const { city, state } = cityStateForZip(zip)
  return {
    first_line: "1 Main St",
    second_line: "",
    city,
    state,
    zip_code: zip,
    unit: null,
    access_notes: null,
  }
}

const persistSlot = (state: JunctionState, seed: SlotSeed, nowMs: number): BookingKeyRecord => {
  const record: BookingKeyRecord = {
    key: seed.bookingKey,
    start: seed.start,
    end: seed.end,
    expires_at: seed.expiresAt,
    price: seed.price,
    is_priority: seed.isPriority,
    num_appointments_available: seed.numAppointmentsAvailable,
    modality: seed.modality,
    provider: seed.provider,
    site_code: seed.siteCode,
    zip_code: seed.zipCode,
    address: seed.address,
    location: seed.location,
    consumed_by_order_id: null,
    created_at: new Date(nowMs).toISOString(),
  }
  state.bookingKeys.insert(seed.bookingKey, record)
  return record
}

const generatePhlebotomySlots = (
  state: JunctionState,
  zip: string,
  startDate: string,
  provider: PhlebotomyProviderName,
  nowMs: number,
): { timezone: string; days: Array<Record<string, unknown>> } => {
  const random = seededRandom(seedFor(["phlebotomy", provider, zip, startDate]))
  const timezone = zipTimezone(zip)
  const days: Array<Record<string, unknown>> = []
  for (let day = 0; day < 3; day++) {
    const date = addDays(startDate, day)
    const slots: Array<Record<string, unknown>> = []
    const slotCount = 2 + Math.floor(random() * 3)
    for (let slot = 0; slot < slotCount; slot++) {
      const hour = 8 + Math.floor(random() * 8)
      const minute = random() < 0.5 ? 0 : 30
      const start = new Date(`${date}T00:00:00Z`)
      start.setUTCHours(hour, minute, 0, 0)
      if (start.getTime() <= nowMs) continue
      const end = new Date(start.getTime() + 45 * 60_000)
      const salt = `${provider}:${zip}:${date}:${start.toISOString()}`
      const seed: SlotSeed = {
        bookingKey: state.bookingKeyFor(salt),
        start: start.toISOString(),
        end: end.toISOString(),
        expiresAt: new Date(start.getTime() - 60 * 60_000).toISOString(),
        price: random() < 0.5 ? 0 : 30,
        isPriority: random() < 0.3,
        numAppointmentsAvailable: 1 + Math.floor(random() * 4),
        modality: "phlebotomy",
        provider,
        siteCode: null,
        zipCode: zip,
        address: phlebotomyAddress(zip),
        location: zipLocation(zip),
      }
      const record = persistSlot(state, seed, nowMs)
      slots.push({
        booking_key: record.key,
        start: record.start,
        end: record.end,
        expires_at: record.expires_at,
        price: record.price,
        is_priority: record.is_priority,
        num_appointments_available: record.num_appointments_available,
      })
    }
    if (slots.length > 0) days.push({ date, slots })
  }
  return { timezone, days }
}

const generatePscSlots = (
  state: JunctionState,
  zip: string,
  startDate: string,
  siteCodes: string[] | null,
  nowMs: number,
): { timezone: string; days: Array<Record<string, unknown>> } => {
  const siteCount = Math.max(withinRadiusFor(zip, "quest", 25), 1)
  const sites = Array.from({ length: Math.min(siteCount, 30) }, (_, index) =>
    pscSiteFor(zip, "quest", index, 25),
  ).filter((site) => siteCodes === null || siteCodes.includes(site.site_code))
  const random = seededRandom(seedFor(["psc", zip, startDate, (siteCodes ?? []).sort().join("|")]))
  const timezone = zipTimezone(zip)
  const days: Array<Record<string, unknown>> = []
  for (let day = 0; day < 3; day++) {
    const date = addDays(startDate, day)
    const slots: Array<Record<string, unknown>> = []
    const slotCount = 2 + Math.floor(random() * 3)
    for (let slot = 0; slot < slotCount; slot++) {
      const hour = 7 + Math.floor(random() * 9)
      const minute = random() < 0.5 ? 0 : 30
      const start = new Date(`${date}T00:00:00Z`)
      start.setUTCHours(hour, minute, 0, 0)
      if (start.getTime() <= nowMs) continue
      const end = new Date(start.getTime() + 15 * 60_000)
      const site = sites.length > 0 ? sites[slot % sites.length] : undefined
      const salt = `psc:${zip}:${site?.site_code ?? "none"}:${date}:${start.toISOString()}`
      const seed: SlotSeed = {
        bookingKey: state.bookingKeyFor(salt),
        start: start.toISOString(),
        end: end.toISOString(),
        expiresAt: new Date(start.getTime() - 60 * 60_000).toISOString(),
        price: 0,
        isPriority: false,
        numAppointmentsAvailable: 1 + Math.floor(random() * 6),
        modality: "patient_service_center",
        provider: "quest",
        siteCode: site?.site_code ?? null,
        zipCode: zip,
        address: site
          ? {
              first_line: site.first_line,
              second_line: null,
              city: site.city,
              state: site.state,
              zip_code: site.zip_code,
              unit: null,
            }
          : phlebotomyAddress(zip),
        location: site?.location ?? zipLocation(zip),
      }
      const record = persistSlot(state, seed, nowMs)
      slots.push({
        booking_key: record.key,
        start: record.start,
        end: record.end,
        expires_at: record.expires_at,
        price: record.price,
        is_priority: record.is_priority,
        num_appointments_available: record.num_appointments_available,
        site_code: record.site_code,
      })
    }
    if (slots.length > 0) days.push({ date, slots })
  }
  return { timezone, days }
}

function notFound(message: string): never {
  throw new HttpError(404, { detail: message })
}

function invalidBookingKey(): never {
  throw new HttpError(400, { detail: "Invalid or expired booking key" })
}

type Order = NonNullable<ReturnType<JunctionState["orders"]["get"]>>

const requireOrder = (
  state: JunctionState,
  orderId: string,
  context: OperationContext,
  missingMessage = "This order doesn't exist.",
): Order => {
  if (!isUuid(orderId)) {
    throw new HttpError(422, { detail: [uuidError(orderId, ["path", "order_id"])] })
  }
  const order: Order | undefined = state.orders.get(orderId)
  if (order === undefined) notFound(missingMessage)
  const loaded: Order = order
  state.applyDueSimulateTransitions(context.now(), (_due, finalStatus, flags) => {
    applySimulateTransition(state, loaded, finalStatus, flags, context)
  })
  const fresh: Order | undefined = state.orders.get(orderId)
  if (fresh === undefined) notFound(missingMessage)
  return fresh
}

const orderCollectionMethod = (order: Order): string => {
  if (typeof order.lab_test.method === "string" && order.lab_test.method.length > 0) {
    return order.lab_test.method
  }
  if (typeof order.details?.type === "string" && order.details.type.length > 0) {
    return order.details.type
  }
  return ""
}

const requirePhlebotomyCapableOrder = (order: Order): void => {
  if (orderCollectionMethod(order) !== "at_home_phlebotomy") {
    notFound("This order doesn't have a phlebotomy order.")
  }
}

const requirePscCapableOrder = (order: Order): void => {
  const method = orderCollectionMethod(order)
  if (method !== "walk_in_test" && method !== "on_site_collection") {
    notFound("This order is not a walk-in phlebotomy order.")
  }
}

const requireOrderHasRequisition = (order: Order): void => {
  const hasRequisition = order.events.some(
    (entry) =>
      typeof entry.status === "string" && entry.status.endsWith(".requisition_created"),
  )
  if (hasRequisition) return
  const lowLevel =
    typeof order.last_event?.status === "string"
      ? (order.last_event.status.split(".").at(-1) ?? order.last_event.status)
      : typeof order.status === "string" && order.status.length > 0
        ? order.status
        : "ordered"
  throw new HttpError(400, {
    detail: `This order does not have a requisition, it's still in state ${lowLevel}.`,
  })
}

const appendOrderStatusEvent = (
  state: JunctionState,
  order: Order,
  status: string,
  context: OperationContext,
): void => {
  const now = state.isoNow(context.now)
  const eventId =
    Number.parseInt(
      opaqueToken(`junction:order-event:${order.id}:${order.events.length}`, 8),
      16,
    ) %
      1_000_000_000 ||
    order.events.length + 1
  const event = {
    id: eventId,
    created_at: now,
    status,
    status_detail: null,
  }
  order.status = status.split(".")[0] ?? order.status
  order.updated_at = now
  order.events.push(event)
  order.last_event = event
  if (status.endsWith(".requisition_created")) {
    if (order.sample_id === null) {
      order.sample_id = opaqueToken(`junction:sample:${order.id}`, 12).toUpperCase()
    }
    if (order.requisition_form_url === null) {
      order.requisition_form_url = `https://storage.googleapis.com/vital_labs_sandbox/mock/requisition_forms/${order.id}_${order.sample_id}.pdf`
    }
  }
  const transactionOrder = order.order_transaction.orders.find((entry) => entry.id === order.id)
  if (transactionOrder) {
    transactionOrder.low_level_status = status.split(".").at(-1) ?? status
    transactionOrder.low_level_status_created_at = new Date(context.now()).toISOString()
    transactionOrder.updated_at = new Date(context.now()).toISOString()
  }
  if (status.startsWith("completed")) order.order_transaction.status = "completed"
  if (status.startsWith("cancelled")) order.order_transaction.status = "cancelled"
}

const applySimulationFlags = (order: Order, flags: Record<string, unknown> | null): boolean => {
  if (!flags) return false
  let changed = false
  if (typeof flags.interpretation === "string") {
    order.interpretation = flags.interpretation
    changed = true
  }
  if (typeof flags.has_missing_results === "boolean") {
    order.has_missing_results = flags.has_missing_results
    changed = true
  }
  if (Array.isArray(flags.result_types)) {
    order.result_types = flags.result_types as string[]
    changed = true
  }
  return changed
}

/**
 * Mirror api.sandbox.tryvital.io `/v3/order/{id}/test` semantics (probed 2026-09):
 * - First call on a fresh order always creates `received.{method}.requisition_created`.
 * - `at_home_phlebotomy` (and other non-walk-in methods): further `/test` calls are no-ops.
 * - `walk_in_test` after requisition:
 *   - matching `appointment_*` / `requisition_created` → no-op
 *   - matching `partial_results` → append partial only (default interpretation normal)
 *   - matching `ordered` / `completed` / `cancelled`, or any mismatched-method status →
 *     jump through partial then completed (+ result date fields)
 *   - `failed.*` → append the failed status
 */
const applySimulateTransition = (
  state: JunctionState,
  order: Order,
  finalStatus: string,
  flags: Record<string, unknown> | null,
  context: OperationContext,
): void => {
  const orderMethod =
    typeof order.lab_test.method === "string" && order.lab_test.method.length > 0
      ? order.lab_test.method
      : typeof order.details?.type === "string" && order.details.type.length > 0
        ? order.details.type
        : "at_home_phlebotomy"
  const hasCancelled = order.events.some((entry) =>
    typeof entry.status === "string" ? entry.status.startsWith("cancelled.") : false,
  )
  if (hasCancelled) return

  const hasRequisition = order.events.some((entry) =>
    typeof entry.status === "string" ? entry.status.endsWith(".requisition_created") : false,
  )
  const hasPartial = order.events.some((entry) =>
    typeof entry.status === "string" ? entry.status.endsWith(".partial_results") : false,
  )
  const hasCompleted = order.events.some((entry) =>
    typeof entry.status === "string" ? entry.status.endsWith(".completed") : false,
  )

  const requestedParts = finalStatus.split(".")
  const requestedMethod =
    requestedParts.length >= 3 ? (requestedParts[1] ?? orderMethod) : orderMethod
  const methodMismatch = requestedMethod !== orderMethod
  const normalizedTarget = (() => {
    if (requestedParts.length >= 3)
      return `${requestedParts[0]}.${orderMethod}.${requestedParts.slice(2).join(".")}`
    return finalStatus
  })()
  const targetTail = normalizedTarget.split(".").at(-1) ?? normalizedTarget

  let statusesToApply: string[] = []
  let applyFlags = false
  let markCompleteDates = false

  if (!hasRequisition) {
    statusesToApply = [`received.${orderMethod}.requisition_created`]
  } else if (orderMethod === "walk_in_test") {
    if (hasCompleted) {
      statusesToApply = []
    } else if (normalizedTarget.startsWith("failed.")) {
      statusesToApply = [normalizedTarget]
    } else if (
      !methodMismatch &&
      (targetTail === "appointment_pending" ||
        targetTail === "appointment_scheduled" ||
        targetTail === "appointment_cancelled" ||
        targetTail === "redraw_available" ||
        targetTail === "requisition_created" ||
        targetTail === "requisition_bypassed")
    ) {
      statusesToApply = []
    } else if (!methodMismatch && targetTail === "partial_results") {
      if (!hasPartial) statusesToApply = [`sample_with_lab.${orderMethod}.partial_results`]
      applyFlags = true
      if (!flags || typeof flags.interpretation !== "string") {
        order.interpretation = order.interpretation ?? "normal"
      }
    } else {
      // ordered / completed / cancelled / mismatched-method → complete jump
      statusesToApply = []
      if (!hasPartial) statusesToApply.push(`sample_with_lab.${orderMethod}.partial_results`)
      statusesToApply.push(`completed.${orderMethod}.completed`)
      applyFlags = true
      markCompleteDates = true
      if (!flags || typeof flags.interpretation !== "string") {
        order.interpretation = order.interpretation ?? "normal"
      }
    }
  }

  if (statusesToApply.length === 0 && !applyFlags && !markCompleteDates) return

  for (const status of statusesToApply) {
    appendOrderStatusEvent(state, order, status, context)
  }
  if (applyFlags) applySimulationFlags(order, flags)
  if (markCompleteDates) {
    const now = new Date(context.now())
    const commonDays =
      typeof order.lab_test.common_tat_days === "number" && order.lab_test.common_tat_days > 0
        ? order.lab_test.common_tat_days
        : 3
    const worstDays =
      typeof order.lab_test.worst_case_tat_days === "number" &&
      order.lab_test.worst_case_tat_days > 0
        ? order.lab_test.worst_case_tat_days
        : 5
    const expected = new Date(now)
    expected.setUTCDate(expected.getUTCDate() + commonDays)
    const worst = new Date(now)
    worst.setUTCDate(worst.getUTCDate() + worstDays)
    order.expected_result_by_date = expected.toISOString().slice(0, 10)
    order.worst_case_result_by_date = worst.toISOString().slice(0, 10)
  }
  state.orders.update(order.id, order)
  state.publishOrderWebhook(order, "labtest.order.updated", context.now())
}

const linkAppointmentToOrder = (
  state: JunctionState,
  order: Order,
  appointment: AppointmentRecord,
  status: string,
  nowIso: string,
): void => {
  const data = order.details.data as Record<string, unknown> | null | undefined
  if (data && typeof data === "object") {
    data.appointment_id = appointment.id
    data.updated_at = nowIso
  }
  const event = {
    id: order.events.length + 1,
    created_at: nowIso,
    status,
    status_detail: null,
  }
  order.status = status.split(".")[0] ?? order.status
  order.updated_at = nowIso
  order.events.push(event)
  order.last_event = event
  const transactionOrder = order.order_transaction.orders.find((entry) => entry.id === order.id)
  if (transactionOrder) {
    transactionOrder.low_level_status = status.split(".").at(-1) ?? status
    transactionOrder.low_level_status_created_at = nowIso
    transactionOrder.updated_at = nowIso
  }
  state.orders.update(order.id, order)
  state.publishOrderWebhook(order, "labtest.order.updated")
}

const appendAppointmentEvent = (
  appointment: AppointmentRecord,
  status: AppointmentEventRecord["status"],
  at: string,
): AppointmentEventRecord => {
  const event: AppointmentEventRecord = { created_at: at, status, data: null }
  appointment.events.push(event)
  appointment.event_status = status
  return event
}

const cancelAppointment = (
  state: JunctionState,
  appointment: AppointmentRecord,
  order: Order,
  nowMs: number,
): AppointmentRecord => {
  const nowIso = state.isoNow(() => nowMs)
  appointment.status = "cancelled"
  appendAppointmentEvent(appointment, "cancelled", nowIso)
  state.appointments.update(appointment.id, appointment)
  const eventStatus = CANCELLED_ORDER_EVENT[appointment.type]
  const event = {
    id: order.events.length + 1,
    created_at: nowIso,
    status: eventStatus,
    status_detail: null,
  }
  order.status = "collecting_sample"
  order.updated_at = nowIso
  order.events.push(event)
  order.last_event = event
  state.orders.update(order.id, order)
  state.publishAppointmentWebhook(appointment, order.team_id, nowMs)
  state.publishOrderWebhook(order, "labtest.order.updated", nowMs)
  return appointment
}

export const schedulingHandlers = (state: JunctionState) => ({
  get_phlebotomy_appointment_cancellation_reason_v3_order_phlebotomy_appointment_cancellation_reasons_get:
    async () => jsonRes(200, CANCELLATION_REASONS),

  get_psc_appointment_cancellation_reason_v3_order_psc_appointment_cancellation_reasons_get:
    async () => jsonRes(200, PSC_CANCELLATION_REASONS),

  get_area_info_v3_order_area_info_get: async (context: OperationContext) => {
    const hit = cachedResponse(state, context)
    if (hit) return hit
    const rawZip = zipCodeOf(context, true) ?? ""
    const radius = radiusOf(context)
    if (!/^\d{5}(?:-?\d{4})?$/.test(rawZip)) {
      throw new HttpError(422, {
        detail: [
          {
            type: "string_pattern_mismatch",
            loc: ["query", "zip_code"],
            msg: "String should match pattern '^\\d{5}(?:-?\\d{4})?$'",
            input: rawZip,
            ctx: { pattern: "^\\d{5}(?:-?\\d{4})?$" },
          },
        ],
      })
    }
    const zip = rawZip.slice(0, 5)
    return jsonRes(200, areaInfoFor(zip, radius))
  },

  get_psc_info_v3_order_psc_info_get: async (context: OperationContext) => {
    const hit = cachedResponse(state, context)
    if (hit) return hit
    const zip = zipCodeOf(context, true) ?? ""
    const labIdRaw = context.query.lab_id
    if (labIdRaw === undefined) {
      throw new HttpError(422, {
        detail: [
          {
            type: "missing",
            loc: ["query", "lab_id"],
            msg: "Field required",
            input: undefined,
          },
        ],
      })
    }
    if (typeof labIdRaw !== "string" || !/^-?\d+$/.test(labIdRaw)) {
      throw new HttpError(422, {
        detail: [
          {
            type: "int_parsing",
            loc: ["query", "lab_id"],
            msg: "Input should be a valid integer, unable to parse string as an integer",
            input: labIdRaw,
            ctx: { error: {} },
          },
        ],
      })
    }
    if (!/^\d{5}$/.test(zip)) {
      throw new HttpError(422, {
        detail: [
          {
            type: "string_pattern_mismatch",
            loc: ["query", "zip_code"],
            msg: "String should match pattern '^\\d{5}$'",
            input: zip,
            ctx: { pattern: "^\\d{5}$" },
          },
        ],
      })
    }
    const labId = Number(labIdRaw)
    const radius = radiusOf(context)
    const capabilitiesRaw = context.query.capabilities
    const capabilityList = Array.isArray(capabilitiesRaw)
      ? capabilitiesRaw.map(String)
      : capabilitiesRaw !== undefined
        ? [String(capabilitiesRaw)]
        : []
    const knownCapabilities = [
      "stat",
      "appointment_scheduling_via_junction",
      "appointment_scheduling_with_lab",
    ]
    if (capabilityList.some((capability) => !knownCapabilities.includes(capability))) {
      throw new HttpError(422, {
        detail: [
          {
            type: "enum",
            loc: ["query", "capabilities", 0],
            msg: "Input should be 'stat', 'appointment_scheduling_via_junction' or 'appointment_scheduling_with_lab'",
            input: capabilityList,
            ctx: {
              expected:
                "'stat', 'appointment_scheduling_via_junction' or 'appointment_scheduling_with_lab'",
            },
          },
        ],
      })
    }
    const lab = PSC_LABS.find((entry) => entry.lab_id === labId)
    if (labId === UNSUPPORTED_PSC_LAB_ID) {
      throw new HttpError(404, { detail: "Lab not supported for PSC info." })
    }
    if (!lab) {
      throw new HttpError(404, { detail: "Lab not found." })
    }
    // The sandbox returns the nearest sites within the radius, capped at 30 entries; the
    // mock synthesizes a deterministic inventory of the same contract.
    const within = withinRadiusFor(zip, lab.slug, radius)
    const centerCount = Math.min(within, 30)
    const centers = Array.from({ length: centerCount }, (_, index) => {
      const site = pscSiteFor(zip, lab.slug, index, radius)
      return {
        metadata: {
          name: site.name,
          state: site.state,
          city: site.city,
          zip_code: site.zip_code,
          first_line: site.first_line,
          second_line: null,
          phone_number: site.phone_number,
          fax_number: null,
          hours: site.hours,
        },
        distance: site.distance,
        site_code: site.site_code,
        supported_bill_types: [...lab.supported_bill_types],
        location: site.location,
        capabilities: [...lab.capabilities],
      }
    })
    return jsonRes(200, {
      lab_id: labId,
      slug: lab.slug,
      patient_service_centers: centers,
    })
  },

  get_phlebotomy_appointment_availability_v3_order_phlebotomy_appointment_availability_post: async (
    context: OperationContext,
  ) => {
    const hit = cachedResponse(state, context)
    if (hit) return hit
    const body = jsonObject(context)
    const zip = typeof body.zip_code === "string" ? body.zip_code : ""
    if (!/^\d{5}$/.test(zip)) {
      throw new HttpError(422, {
        detail: [
          {
            type: "value_error",
            loc: ["body", "zip_code"],
            msg: `Value error, Invalid zip code: ${zip}`,
            input: body.zip_code,
            ctx: { error: {} },
          },
        ],
      })
    }
    if (typeof body.first_line !== "string" || typeof body.city !== "string") {
      throw new HttpError(422, {
        detail: [
          {
            type: "missing",
            loc: ["body", "first_line"],
            msg: "Field required",
            input: body,
          },
        ],
      })
    }
    const startDate = startDateOf(context, context.now())
    const { timezone, days } = generatePhlebotomySlots(
      state,
      zip,
      startDate,
      "getlabs",
      context.now(),
    )
    if (days.length === 0) notFound("No availability found")
    // Align booking-key address/location with the availability request (Vital echoes it on book).
    rotateGeneratedAvailabilityKeys(state, days, context.now(), {
      address: addressFromAvailabilityRequest(body, zip),
      location: zipLocation(zip),
      zip,
    })
    return jsonRes(200, { timezone, slots: days })
  },

  get_psc_appointment_availability_v3_order_psc_appointment_availability_post: async (
    context: OperationContext,
  ) => {
    const hit = cachedResponse(state, context)
    if (hit) return hit
    const lab = context.query.lab
    if (lab !== "quest") {
      throw new HttpError(422, {
        detail: [
          {
            type: "enum",
            loc: ["query", "lab"],
            msg: "Input should be 'quest'",
            input: lab,
            ctx: { expected: "'quest'" },
          },
        ],
      })
    }
    const zip = zipCodeOf(context, false)
    const startDate = startDateOf(context, context.now())
    const siteCodesRaw = context.query.site_codes
    let siteCodes: string[] | null = null
    if (siteCodesRaw !== undefined) {
      if (typeof siteCodesRaw !== "string") {
        throw new HttpError(422, { detail: "site_codes must be a JSON array string" })
      }
      try {
        const parsed: unknown = JSON.parse(siteCodesRaw)
        if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
          throw new Error("not an array of strings")
        }
        siteCodes = parsed as string[]
      } catch {
        throw new HttpError(422, { detail: "site_codes must be a JSON array of strings" })
      }
    }
    const { timezone, days } = generatePscSlots(
      state,
      zip ?? "",
      startDate,
      siteCodes,
      context.now(),
    )
    if (days.length === 0) notFound("No slots found")
    rotateGeneratedAvailabilityKeys(state, days, context.now())
    return jsonRes(200, { timezone, slots: days })
  },

  get_phlebotomy_appointment_v3_order__order_id__phlebotomy_appointment_get: async (
    context: OperationContext,
  ) => {
    const orderId = context.params.order_id ?? ""
    const order = requireOrder(state, orderId, context)
    const appointment = appointmentOfOrder(state, order.id)
    if (appointment?.type !== "phlebotomy") notFound("No appointment for this order")
    return jsonRes(200, renderAppointment(appointment))
  },

  get_psc_appointment_v3_order__order_id__psc_appointment_get: async (
    context: OperationContext,
  ) => {
    const orderId = context.params.order_id ?? ""
    const order = requireOrder(state, orderId, context)
    const appointment = appointmentOfOrder(state, order.id)
    if (appointment?.type !== "patient_service_center") notFound("No appointment for this order")
    return jsonRes(200, renderAppointment(appointment))
  },

  book_phlebotomy_appointment_v3_order__order_id__phlebotomy_appointment_book_post: async (
    context: OperationContext,
  ) => {
    const orderId = context.params.order_id ?? ""
    const order = requireOrder(state, orderId, context)
    requirePhlebotomyCapableOrder(order)
    requireOrderHasRequisition(order)
    const existing = appointmentOfOrder(state, order.id)
    if (existing && existing.status !== "cancelled") {
      throw new HttpError(400, { detail: "Appointment already booked for this order" })
    }
    const body = jsonObject(context)
    const bookingKey = typeof body.booking_key === "string" ? body.booking_key : ""
    const record = bookingKey === "" ? undefined : state.bookingKeys.get(bookingKey)
    if (
      record?.modality !== "phlebotomy" ||
      record.consumed_by_order_id !== null ||
      (record.expires_at !== null && new Date(record.expires_at).getTime() <= context.now())
    ) {
      invalidBookingKey()
    }
    const nowIso = state.isoNow(context.now)
    const appointmentId = state.nextAppointmentId()
    const appointment: AppointmentRecord = {
      id: appointmentId,
      order_id: order.id,
      user_id: order.user_id,
      provider_id: state.appointmentProviderIdFor(`${order.id}:${bookingKey}`),
      external_id: `getlabs-${state.appointmentProviderIdFor(orderId)}`,
      type: "phlebotomy",
      provider: record.provider as AppointmentRecord["provider"],
      // Vital quirk: top-level status + events[0].status are pending, but event_status is scheduled.
      status: "pending",
      event_status: "scheduled",
      start_at: record.start,
      end_at: record.end,
      iana_timezone: zipTimezone(record.zip_code),
      address: record.address,
      location: record.location,
      can_reschedule: true,
      booking_key: record.key,
      site_code: null,
      appointment_notes: null,
      order_transaction_id: order.order_transaction.id,
      event_data: null,
      events: [],
      created_at: nowIso,
      updated_at: nowIso,
    }
    appendAppointmentEvent(appointment, "pending", nowIso)
    appointment.event_status = "scheduled"
    state.appointments.insert(appointmentId, appointment)
    state.appointmentsByOrder.insert(order.id, { appointment_id: appointmentId })
    record.consumed_by_order_id = order.id
    state.bookingKeys.update(record.key, record)
    linkAppointmentToOrder(state, order, appointment, SCHEDULED_ORDER_EVENT.phlebotomy, nowIso)
    state.publishAppointmentWebhook(appointment, order.team_id, context.now())
    return jsonRes(200, renderAppointment(appointment))
  },

  book_psc_appointment_v3_order__order_id__psc_appointment_book_post: async (
    context: OperationContext,
  ) => {
    const orderId = context.params.order_id ?? ""
    const order = requireOrder(state, orderId, context)
    requirePscCapableOrder(order)
    requireOrderHasRequisition(order)
    const idempotencyKey = context.request.headers.get("x-idempotency-key")
    if (idempotencyKey !== null && idempotencyKey !== "") {
      const replay = state.cancelIdempotency.get(`psc-book:${idempotencyKey}`)
      if (replay) return jsonRes(200, replay.response)
    }
    const existing = appointmentOfOrder(state, order.id)
    if (existing && existing.status !== "cancelled") {
      throw new HttpError(400, { detail: "Appointment already booked for this order" })
    }
    const body = jsonObject(context)
    const bookingKey = typeof body.booking_key === "string" ? body.booking_key : ""
    const siteCode = typeof body.site_code === "string" ? body.site_code : ""
    if (siteCode === "") {
      throw new HttpError(400, { detail: "site_code is required for PSC appointments" })
    }
    const record = bookingKey === "" ? undefined : state.bookingKeys.get(bookingKey)
    if (
      record === undefined ||
      (record.modality === "patient_service_center" &&
        record.consumed_by_order_id !== null &&
        record.consumed_by_order_id !== order.id) ||
      (record.expires_at !== null && new Date(record.expires_at).getTime() <= context.now())
    ) {
      invalidBookingKey()
    }
    if (record.modality !== "patient_service_center") {
      throw new HttpError(400, { detail: "Booking key is not a patient service center slot" })
    }
    if (record.site_code !== null && record.site_code !== siteCode) {
      throw new HttpError(400, { detail: "Booking key does not match the requested site" })
    }
    const nowIso = state.isoNow(context.now)
    const appointmentId = state.nextAppointmentId()
    const appointment: AppointmentRecord = {
      id: appointmentId,
      order_id: order.id,
      user_id: order.user_id,
      provider_id: state.appointmentProviderIdFor(`${order.id}:${record.key}`),
      external_id: `quest-${state.appointmentProviderIdFor(orderId)}`,
      type: "patient_service_center",
      provider: "quest",
      status: "confirmed",
      event_status: "scheduled",
      start_at: record.start,
      end_at: record.end,
      iana_timezone: zipTimezone(record.zip_code),
      address: record.address,
      location: record.location,
      can_reschedule: true,
      booking_key: record.key,
      site_code: siteCode,
      appointment_notes: null,
      order_transaction_id: order.order_transaction.id,
      event_data: null,
      events: [],
      created_at: nowIso,
      updated_at: nowIso,
    }
    appendAppointmentEvent(appointment, "scheduled", nowIso)
    state.appointments.insert(appointmentId, appointment)
    state.appointmentsByOrder.insert(order.id, { appointment_id: appointmentId })
    record.consumed_by_order_id = order.id
    state.bookingKeys.update(record.key, record)
    linkAppointmentToOrder(
      state,
      order,
      appointment,
      SCHEDULED_ORDER_EVENT.patient_service_center,
      nowIso,
    )
    state.publishAppointmentWebhook(appointment, order.team_id, context.now())
    const response = renderAppointment(appointment)
    if (idempotencyKey !== null && idempotencyKey !== "") {
      state.cancelIdempotency.insert(`psc-book:${idempotencyKey}`, {
        order_id: order.id,
        response,
      })
    }
    return jsonRes(200, response)
  },

  reschedule_phlebotomy_appointment_v3_order__order_id__phlebotomy_appointment_reschedule_patch:
    async (context: OperationContext) => {
      const orderId = context.params.order_id ?? ""
      const order = requireOrder(state, orderId, context)
      const body = jsonObject(context)
      const bookingKey = typeof body.booking_key === "string" ? body.booking_key : ""
      const appointment = appointmentOfOrder(state, order.id)
      if (appointment?.type !== "phlebotomy") notFound("No appointment for this order")
      if (appointment.status === "cancelled")
        throw new HttpError(400, { detail: "Cannot reschedule a cancelled appointment" })
      const record = bookingKey === "" ? undefined : state.bookingKeys.get(bookingKey)
      if (
        record === undefined ||
        record.modality !== "phlebotomy" ||
        (record.consumed_by_order_id !== null && record.consumed_by_order_id !== order.id) ||
        (record.expires_at !== null && new Date(record.expires_at).getTime() <= context.now())
      ) {
        invalidBookingKey()
      }
      const nowIso = state.isoNow(context.now)
      appointment.start_at = record.start
      appointment.end_at = record.end
      appointment.iana_timezone = zipTimezone(record.zip_code)
      appointment.address = record.address
      appointment.location = record.location
      appointment.booking_key = record.key
      appendAppointmentEvent(appointment, "scheduled", nowIso)
      state.appointments.update(appointment.id, appointment)
      record.consumed_by_order_id = order.id
      state.bookingKeys.update(record.key, record)
      state.publishAppointmentWebhook(appointment, order.team_id, context.now())
      return jsonRes(200, renderAppointment(appointment))
    },

  reschedule_psc_appointment_v3_order__order_id__psc_appointment_reschedule_patch: async (
    context: OperationContext,
  ) => {
    const orderId = context.params.order_id ?? ""
    const order = requireOrder(state, orderId, context)
    const body = jsonObject(context)
    const bookingKey = typeof body.booking_key === "string" ? body.booking_key : ""
    const appointment = appointmentOfOrder(state, order.id)
    if (appointment?.type !== "patient_service_center") notFound("No appointment for this order")
    if (appointment.status === "cancelled")
      throw new HttpError(400, { detail: "Cannot reschedule a cancelled appointment" })
    const record = bookingKey === "" ? undefined : state.bookingKeys.get(bookingKey)
    if (
      record === undefined ||
      record.modality !== "patient_service_center" ||
      (record.consumed_by_order_id !== null && record.consumed_by_order_id !== order.id) ||
      (record.expires_at !== null && new Date(record.expires_at).getTime() <= context.now())
    ) {
      invalidBookingKey()
    }
    if (record.site_code !== null && appointment.site_code !== record.site_code) {
      throw new HttpError(400, { detail: "Booking key does not match the appointment site" })
    }
    const nowIso = state.isoNow(context.now)
    appointment.start_at = record.start
    appointment.end_at = record.end
    appointment.iana_timezone = zipTimezone(record.zip_code)
    appointment.address = record.address
    appointment.location = record.location
    appointment.booking_key = record.key
    appendAppointmentEvent(appointment, "scheduled", nowIso)
    state.appointments.update(appointment.id, appointment)
    record.consumed_by_order_id = order.id
    state.bookingKeys.update(record.key, record)
    state.publishAppointmentWebhook(appointment, order.team_id, context.now())
    return jsonRes(200, renderAppointment(appointment))
  },

  cancel_phlebotomy_appointment_v3_order__order_id__phlebotomy_appointment_cancel_patch: async (
    context: OperationContext,
  ) => {
    const orderId = context.params.order_id ?? ""
    const order = requireOrder(state, orderId, context)
    const body = jsonObject(context)
    const reasonId =
      typeof body.cancellation_reason_id === "string" ? body.cancellation_reason_id : ""
    const appointment = appointmentOfOrder(state, order.id)
    if (appointment?.type !== "phlebotomy") notFound("No appointment for this order")
    const reason = CANCELLATION_REASONS.find((entry) => entry.id === reasonId)
    if (!reason) {
      throw new HttpError(400, { detail: "Invalid cancellation reason id" })
    }
    if (reasonId === OTHER_CANCELLATION_REASON_ID && typeof body.notes !== "string") {
      throw new HttpError(400, { detail: "notes is required for reason 'Other'" })
    }
    if (appointment.status === "cancelled") return jsonRes(200, renderAppointment(appointment))
    appointment.appointment_notes = typeof body.notes === "string" ? body.notes : null
    cancelAppointment(state, appointment, order, context.now())
    return jsonRes(200, renderAppointment(appointment))
  },

  cancel_psc_appointment_v3_order__order_id__psc_appointment_cancel_patch: async (
    context: OperationContext,
  ) => {
    const orderId = context.params.order_id ?? ""
    const order = requireOrder(state, orderId, context)
    const body = jsonObject(context)
    const reasonId = typeof body.cancellationReasonId === "string" ? body.cancellationReasonId : ""
    const appointment = appointmentOfOrder(state, order.id)
    if (appointment?.type !== "patient_service_center") notFound("No appointment for this order")
    const reason = PSC_CANCELLATION_REASONS.find((entry) => entry.id === reasonId)
    if (!reason) {
      throw new HttpError(400, { detail: "Invalid cancellation reason id" })
    }
    if (appointment.status === "cancelled") return jsonRes(200, renderAppointment(appointment))
    appointment.appointment_notes = typeof body.note === "string" ? body.note : null
    cancelAppointment(state, appointment, order, context.now())
    return jsonRes(200, renderAppointment(appointment))
  },
})

/** Cancels any active appointment linked to `orderId`; used by order cancellation cascade. */
export const cascadeCancelAppointments = (
  state: JunctionState,
  orderId: string,
  nowMs: number,
): void => {
  const appointment = appointmentOfOrder(state, orderId)
  if (!appointment || appointment.status === "cancelled") return
  const order = state.orders.get(orderId)
  if (!order) return
  cancelAppointment(state, appointment, order, nowMs)
}

export { applySimulateTransition, appointmentOfOrder, renderAppointment, requireOrder }
