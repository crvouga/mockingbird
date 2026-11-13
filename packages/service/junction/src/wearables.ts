/**
 * The wearables (device data) surface: Link tokens, the provider catalog, a user's provider
 * connections, daily summaries and grouped timeseries (#757).
 *
 * Shapes follow Junction's API reference and the `@tryvital/vital-node` SDK types. There is no
 * sandbox oracle for this surface in this repository: a sandbox user has no connected devices,
 * so every value here is synthetic — a **best guess, not oracle-verified**. A connection and its
 * days of data come from `POST /__admin/users/:id/connections`; readings are derived
 * deterministically from (user, provider, day), so they need no storage and identical inputs
 * read back identical numbers on independent emulator instances.
 */
import { HttpError, jsonRes, type OperationContext } from "@crvouga/mockingbird-service"
import { missing } from "./not-found.js"
import { deterministicUuid, type JunctionState, type UserRecord } from "./state.js"

/** Daily summaries the emulator models, by their `/v2/summary/<resource>` path segment. */
export const SUMMARY_RESOURCES = ["activity", "sleep", "sleep_cycle", "body", "meal"] as const
export type SummaryResource = (typeof SUMMARY_RESOURCES)[number]

/** Grouped timeseries the emulator models, by their `/v2/timeseries/{user_id}/<resource>` segment. */
export const TIMESERIES_RESOURCES = [
  "steps",
  "distance",
  "calories_active",
  "body_weight",
  "body_fat",
  "heartrate",
  "hrv",
  "glucose",
] as const
export type TimeseriesResource = (typeof TIMESERIES_RESOURCES)[number]

export type WearableResource = SummaryResource | TimeseriesResource

/**
 * The resource name a webhook event uses (`daily.data.<name>.created`) — Junction names the
 * body-weight and body-fat streams `weight` and `fat` there.
 */
export const EVENT_RESOURCE: Readonly<Record<WearableResource, string>> = {
  activity: "activity",
  sleep: "sleep",
  sleep_cycle: "sleep_cycle",
  body: "body",
  meal: "meal",
  steps: "steps",
  distance: "distance",
  calories_active: "calories_active",
  body_weight: "weight",
  body_fat: "fat",
  heartrate: "heartrate",
  hrv: "hrv",
  glucose: "glucose",
}

export type ProviderDefinition = {
  name: string
  slug: string
  description: string
  auth_type: "oauth" | "password" | "sdk" | "email"
  /** What the device type reports as `source.type`. */
  source_type: string
  /** Junction's numeric source id, carried by timeseries webhook payloads (`source_id`). */
  source_id: number
  resources: readonly WearableResource[]
}

const ALL_ACTIVITY: readonly WearableResource[] = [
  "activity",
  "steps",
  "distance",
  "calories_active",
  "heartrate",
]

/** The provider catalog `GET /v2/providers` answers with. A subset of Junction's, by slug. */
export const WEARABLE_PROVIDERS: readonly ProviderDefinition[] = [
  {
    name: "Oura",
    slug: "oura",
    description: "Smart Sleep tracking ring",
    auth_type: "oauth",
    source_type: "ring",
    source_id: 1,
    resources: [...ALL_ACTIVITY, "sleep", "sleep_cycle", "hrv"],
  },
  {
    name: "Fitbit",
    slug: "fitbit",
    description: "Fitness trackers and smartwatches",
    auth_type: "oauth",
    source_type: "watch",
    source_id: 2,
    resources: [...ALL_ACTIVITY, "sleep", "sleep_cycle", "hrv", "body", "body_weight", "meal"],
  },
  {
    name: "Garmin",
    slug: "garmin",
    description: "Watches and fitness trackers",
    auth_type: "oauth",
    source_type: "watch",
    source_id: 3,
    resources: [...ALL_ACTIVITY, "sleep", "sleep_cycle", "hrv", "body", "body_weight", "body_fat"],
  },
  {
    name: "Whoop",
    slug: "whoop_v2",
    description: "Wearable performance tracker",
    auth_type: "oauth",
    source_type: "watch",
    source_id: 4,
    resources: ["activity", "calories_active", "heartrate", "sleep", "sleep_cycle", "hrv"],
  },
  {
    name: "Withings",
    slug: "withings",
    description: "Smart scales and health monitors",
    auth_type: "oauth",
    source_type: "scale",
    source_id: 5,
    resources: ["body", "body_weight", "body_fat", "heartrate", "steps", "sleep"],
  },
  {
    name: "Polar",
    slug: "polar",
    description: "Heart rate monitors and sports watches",
    auth_type: "oauth",
    source_type: "watch",
    source_id: 6,
    resources: [...ALL_ACTIVITY, "sleep"],
  },
  {
    name: "Freestyle Libre",
    slug: "freestyle_libre",
    description: "Continuous glucose monitor",
    auth_type: "password",
    source_type: "automatic",
    source_id: 7,
    resources: ["glucose"],
  },
  {
    name: "Dexcom",
    slug: "dexcom_v3",
    description: "Continuous glucose monitor",
    auth_type: "oauth",
    source_type: "automatic",
    source_id: 8,
    resources: ["glucose"],
  },
  {
    name: "Apple HealthKit",
    slug: "apple_health_kit",
    description: "Health data from the Apple Health app",
    auth_type: "sdk",
    source_type: "watch",
    source_id: 16,
    resources: [
      ...ALL_ACTIVITY,
      "sleep",
      "sleep_cycle",
      "hrv",
      "body",
      "body_weight",
      "body_fat",
      "glucose",
      "meal",
    ],
  },
]

const PROVIDERS_BY_SLUG = new Map(WEARABLE_PROVIDERS.map((provider) => [provider.slug, provider]))

export const wearableProvider = (slug: string): ProviderDefinition | undefined =>
  PROVIDERS_BY_SLUG.get(slug)

export const providerLogo = (slug: string): string =>
  `https://storage.googleapis.com/vital-assets/${slug}.png`

/** `{ name, slug, logo }`, the provider reference webhooks and users carry. */
export const providerRef = (provider: ProviderDefinition) => ({
  name: provider.name,
  slug: provider.slug,
  logo: providerLogo(provider.slug),
})

/** One provider connection and the inclusive day range it has data for. */
export type ConnectionRecord = {
  user_id: string
  provider: string
  created_on: string
  status: "connected" | "error"
  external_user_id: string | null
  error_details: { error_type: string; error_message: string; errored_at: string } | null
  /** `YYYY-MM-DD` bounds of the seeded data, or null for a connection with no data yet. */
  data_start: string | null
  data_end: string | null
}

export const connectionKey = (userId: string, provider: string) => `${userId}:${provider}`

export const connectionsOf = (state: JunctionState, userId: string): ConnectionRecord[] =>
  state.connections
    .list({ order: "oldest" })
    .map((entry) => entry.value)
    .filter((connection) => connection.user_id === userId)

const DATE = /^\d{4}-\d{2}-\d{2}$/

export const isCalendarDate = (value: string): boolean =>
  DATE.test(value) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value)

export const addDays = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)

const daysBetween = (start: string, end: string): string[] => {
  const days: string[] = []
  for (let day = start; day <= end; day = addDays(day, 1)) days.push(day)
  return days
}

/** A stable number in [0, 1) for one reading. */
const unit = (...parts: string[]): number => {
  let hash = 0x811c9dc5
  for (const char of parts.join("|")) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash / 0x1_0000_0000
}

const between = (low: number, high: number, ...parts: string[]) =>
  Math.round(low + (high - low) * unit(...parts))

const decimal = (low: number, high: number, places: number, ...parts: string[]) =>
  Number((low + (high - low) * unit(...parts)).toFixed(places))

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "+00:00")
const at = (day: string, hour: number, minute = 0) =>
  Date.parse(`${day}T00:00:00Z`) + (hour * 60 + minute) * 60_000

const summarySource = (provider: ProviderDefinition) => ({
  provider: provider.slug,
  type: provider.source_type,
  app_id: null,
  device_id: null,
  name: provider.name,
  slug: provider.slug,
  logo: providerLogo(provider.slug),
})

/** The `source` of one timeseries group (`{ provider, type, … }`). */
const groupSource = (provider: ProviderDefinition) => ({
  provider: provider.slug,
  type: provider.source_type,
  app_id: null,
  device_id: null,
  sport: null,
  workout_id: null,
})

type Day = { userId: string; provider: ProviderDefinition; day: string; createdAt: string }

const summaryId = (resource: string, { userId, provider, day }: Day) =>
  deterministicUuid(`junction:summary:${resource}:${userId}:${provider.slug}:${day}`)

const activity = (input: Day) => {
  const { userId, provider, day } = input
  const key = [userId, provider.slug, day]
  const steps = between(3_000, 13_000, "steps", ...key)
  const active = between(180, 750, "calories_active", ...key)
  return {
    id: summaryId("activity", input),
    user_id: userId,
    date: `${day}T00:00:00+00:00`,
    calendar_date: day,
    calories_total: active + 1_650,
    calories_active: active,
    steps,
    daily_movement: Math.round(steps * 0.76),
    distance: Math.round(steps * 0.76),
    low: between(120, 300, "low", ...key),
    medium: between(20, 90, "medium", ...key),
    high: between(0, 45, "high", ...key),
    floors_climbed: between(0, 20, "floors", ...key),
    time_zone: "UTC",
    timezone_offset: 0,
    heart_rate: {
      avg_bpm: between(64, 82, "avg_bpm", ...key),
      min_bpm: between(48, 58, "min_bpm", ...key),
      max_bpm: between(130, 175, "max_bpm", ...key),
      resting_bpm: between(52, 66, "resting_bpm", ...key),
      avg_walking_bpm: between(85, 105, "walking_bpm", ...key),
    },
    wheelchair_use: null,
    wheelchair_push: null,
    source: summarySource(provider),
    created_at: input.createdAt,
    updated_at: input.createdAt,
  }
}

/** Sleep for the night that ends on `day`: bedtime the evening before. */
const sleep = (input: Day) => {
  const { userId, provider, day } = input
  const key = [userId, provider.slug, day]
  const start = at(addDays(day, -1), 22, between(30, 90, "bedtime", ...key))
  const duration = between(6.5 * 3600, 8.5 * 3600, "duration", ...key)
  const awake = between(900, 2_700, "awake", ...key)
  const deep = between(3_600, 6_300, "deep", ...key)
  const rem = between(4_500, 7_200, "rem", ...key)
  const total = duration - awake
  return {
    id: summaryId("sleep", input),
    user_id: userId,
    date: `${day}T00:00:00+00:00`,
    calendar_date: day,
    bedtime_start: iso(start),
    bedtime_stop: iso(start + duration * 1000),
    type: "long_sleep",
    timezone_offset: 0,
    duration,
    total,
    awake,
    light: total - deep - rem,
    rem,
    deep,
    score: between(60, 95, "score", ...key),
    hr_lowest: between(44, 56, "hr_lowest", ...key),
    hr_average: between(52, 64, "hr_average", ...key),
    hr_resting: between(48, 60, "hr_resting", ...key),
    efficiency: decimal(0.82, 0.97, 2, "efficiency", ...key),
    latency: between(300, 1_500, "latency", ...key),
    temperature_delta: decimal(-0.5, 0.5, 2, "temperature_delta", ...key),
    skin_temperature: null,
    hr_dip: null,
    state: null,
    average_hrv: between(30, 80, "average_hrv", ...key),
    respiratory_rate: decimal(12, 17, 1, "respiratory_rate", ...key),
    source: summarySource(provider),
    sleep_stream: null,
    created_at: input.createdAt,
    updated_at: input.createdAt,
  }
}

/** Junction's sleep stage codes: 1 deep, 2 light, 3 REM, 4 awake. */
const sleepCycle = (input: Day) => {
  const night = sleep(input)
  const starts: number[] = []
  const ends: number[] = []
  const stages: number[] = []
  const pattern = [2, 1, 2, 3, 4]
  for (let offset = 0, index = 0; offset < night.duration; index += 1) {
    const length = Math.min(1_800, night.duration - offset)
    starts.push(offset)
    ends.push(offset + length)
    stages.push(pattern[index % pattern.length] as number)
    offset += length
  }
  return {
    id: summaryId("sleep_cycle", input),
    sleep_id: night.id,
    session_start: night.bedtime_start,
    session_end: night.bedtime_stop,
    stage_start_offset_second: starts,
    stage_end_offset_second: ends,
    stage_type: stages,
    time_zone: "UTC",
    source_provider: input.provider.slug,
    source_type: input.provider.source_type,
    source_app_id: null,
    source_device_id: null,
    created_at: input.createdAt,
    updated_at: input.createdAt,
    user_id: input.userId,
    source: summarySource(input.provider),
  }
}

const bodyWeight = (key: string[]) => decimal(62, 88, 1, "weight", ...key.slice(0, 2))
const bodyFat = (key: string[]) => decimal(14, 30, 1, "fat", ...key.slice(0, 2))

const body = (input: Day) => {
  const { userId, provider, day } = input
  const key = [userId, provider.slug, day]
  const weight = Number((bodyWeight(key) + decimal(-0.6, 0.6, 1, "drift", ...key)).toFixed(1))
  const fat = bodyFat(key)
  return {
    id: summaryId("body", input),
    user_id: userId,
    date: `${day}T00:00:00+00:00`,
    calendar_date: day,
    weight,
    fat,
    water_percentage: null,
    muscle_mass_percentage: null,
    visceral_fat_index: null,
    bone_mass_percentage: null,
    body_mass_index: Number((weight / 1.75 ** 2).toFixed(1)),
    lean_body_mass_kilogram: Number((weight * (1 - fat / 100)).toFixed(1)),
    waist_circumference_centimeter: null,
    source: summarySource(provider),
    created_at: input.createdAt,
    updated_at: input.createdAt,
  }
}

const MEALS = [
  ["Breakfast", 7],
  ["Lunch", 12],
  ["Dinner", 19],
] as const

const meals = (input: Day) =>
  MEALS.map(([name, hour]) => {
    const key = [input.userId, input.provider.slug, input.day, name]
    return {
      id: deterministicUuid(
        `junction:meal:${input.userId}:${input.provider.slug}:${input.day}:${name}`,
      ),
      user_id: input.userId,
      priority_id: 1,
      source_id: input.provider.source_id,
      provider_id: `${input.provider.slug}-${input.day}-${name.toLowerCase()}`,
      timestamp: iso(at(input.day, hour)),
      name,
      energy: { unit: "kcal", value: between(350, 900, "energy", ...key) },
      macros: {
        carbs: between(30, 110, "carbs", ...key),
        protein: between(15, 55, "protein", ...key),
        fats: { total: between(10, 40, "fat", ...key) },
      },
      micros: null,
      data: {},
      source: summarySource(input.provider),
      created_at: input.createdAt,
      updated_at: input.createdAt,
      source_app_id: null,
      source_device_id: null,
    }
  })

/** One day of samples for a timeseries resource, oldest first. */
export const timeseriesSamples = (resource: TimeseriesResource, input: Day) => {
  const { userId, provider, day } = input
  const key = [userId, provider.slug, day]
  const interval = (unitName: string, low: number, high: number) =>
    [6, 9, 12, 15, 18, 21].map((hour) => ({
      timezone_offset: 0,
      type: null,
      unit: unitName,
      timestamp: iso(at(day, hour)),
      start: iso(at(day, hour)),
      end: iso(at(day, hour + 3)),
      value: between(low, high, resource, String(hour), ...key),
    }))
  const instant = (unitName: string, times: number[], value: (minute: number) => number) =>
    times.map((minute) => ({
      timezone_offset: 0,
      type: null,
      unit: unitName,
      timestamp: iso(at(day, 0, minute)),
      value: value(minute),
    }))
  switch (resource) {
    case "steps":
      return interval("count", 300, 2_400)
    case "distance":
      return interval("m", 200, 1_800)
    case "calories_active":
      return interval("kcal", 20, 140)
    case "heartrate":
      return instant(
        "bpm",
        Array.from({ length: 24 }, (_, hour) => hour * 60),
        (minute) => between(52, 110, "hr", String(minute), ...key),
      )
    case "hrv":
      return instant("rmssd", [180], () => between(30, 80, "hrv", ...key))
    case "glucose":
      return instant(
        "mmol/L",
        Array.from({ length: 96 }, (_, index) => index * 15),
        (minute) => decimal(4.2, 7.8, 1, "glucose", String(minute), ...key),
      )
    case "body_weight":
      return instant("kg", [420], () => body(input).weight)
    case "body_fat":
      return instant("percent", [420], () => body(input).fat)
  }
}

type Window = { start: string; end: string }

const supports = (provider: ProviderDefinition, resource: WearableResource) =>
  provider.resources.includes(resource)

/** Every (connection, provider, day) with data inside `window`, by provider then day. */
const daysWithData = (
  state: JunctionState,
  userId: string,
  resource: WearableResource,
  window: Window,
  providerFilter: string | undefined,
): Day[] =>
  connectionsOf(state, userId).flatMap((connection) => {
    const provider = wearableProvider(connection.provider)
    if (!provider || !supports(provider, resource)) return []
    if (providerFilter !== undefined && provider.slug !== providerFilter) return []
    if (connection.data_start === null || connection.data_end === null) return []
    const start = connection.data_start > window.start ? connection.data_start : window.start
    const end = connection.data_end < window.end ? connection.data_end : window.end
    if (start > end) return []
    return daysBetween(start, end).map((day) => ({
      userId,
      provider,
      day,
      createdAt: connection.created_on,
    }))
  })

export const summaryRecords = (
  state: JunctionState,
  userId: string,
  resource: SummaryResource,
  window: Window,
  providerFilter?: string,
): Record<string, unknown>[] =>
  daysWithData(state, userId, resource, window, providerFilter).flatMap(
    (day): Record<string, unknown>[] => {
      switch (resource) {
        case "activity":
          return [activity(day)]
        case "sleep":
          return [sleep(day)]
        case "sleep_cycle":
          return [sleepCycle(day)]
        case "body":
          return [body(day)]
        default:
          return meals(day)
      }
    },
  )

/** `{ <provider slug>: [{ source, data: [...] }] }`, samples inside `[start, end]`. */
export const groupedTimeseries = (
  state: JunctionState,
  userId: string,
  resource: TimeseriesResource,
  bounds: { start: number; end: number },
  providerFilter?: string,
): Record<string, Array<{ source: unknown; data: unknown[] }>> => {
  const window = {
    start: new Date(bounds.start).toISOString().slice(0, 10),
    end: new Date(bounds.end).toISOString().slice(0, 10),
  }
  const groups: Record<string, Array<{ source: unknown; data: unknown[] }>> = {}
  for (const day of daysWithData(state, userId, resource, window, providerFilter)) {
    const samples = timeseriesSamples(resource, day).filter((sample) => {
      const time = Date.parse(sample.timestamp)
      return time >= bounds.start && time <= bounds.end
    })
    if (samples.length === 0) continue
    const slug = day.provider.slug
    const existing = groups[slug]?.[0]
    if (existing) existing.data.push(...samples)
    else groups[slug] = [{ source: groupSource(day.provider), data: samples }]
  }
  return groups
}

/** The raw provider payloads `GET /v2/summary/{sleep,body}/{user_id}/raw` answer with. */
const rawRecords = (
  state: JunctionState,
  userId: string,
  resource: "sleep" | "body",
  window: Window,
  providerFilter?: string,
) =>
  daysWithData(state, userId, resource, window, providerFilter).map((day) => {
    const summary = resource === "sleep" ? sleep(day) : body(day)
    const { source: _source, ...data } = summary
    return {
      timestamp: summary.date,
      data,
      provider_id: `${day.provider.slug}-${resource}-${day.day}`,
      user_id: userId,
      source_id: day.provider.source_id,
      priority_id: 1,
      id: deterministicUuid(`junction:raw:${resource}:${userId}:${day.provider.slug}:${day.day}`),
      source: providerRef(day.provider),
      priority: 1,
      source_device_id: null,
      created_at: day.createdAt,
      updated_at: day.createdAt,
    }
  })

/** `user.connected_sources`, as `GET /v2/user/{id}` renders it. */
export const connectedSources = (state: JunctionState, userId: string) =>
  connectionsOf(state, userId).flatMap((connection) => {
    const provider = wearableProvider(connection.provider)
    return provider ? [{ source: providerRef(provider), created_on: connection.created_on }] : []
  })

const syncConnectedSources = (state: JunctionState, userId: string): void => {
  const user = state.users.get(userId)
  if (!user) return
  state.users.update(userId, { ...user, connected_sources: connectedSources(state, userId) })
}

export type ConnectInput = {
  provider: string
  /** Days of data ending on `end_date` (default: today on the mock clock). Default 7; 0 for none. */
  days?: number
  start_date?: string
  end_date?: string
  status?: "connected" | "error"
  error_type?: string
}

export class WearableInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WearableInputError"
  }
}

export const MAX_SEEDED_DAYS = 366

/**
 * Connect `provider` for a user (or replace that connection) with a range of seeded days.
 * Throws {@link WearableInputError} for a bad input.
 */
export const connectProvider = (
  state: JunctionState,
  user: UserRecord,
  input: ConnectInput,
  now: number,
): ConnectionRecord => {
  const provider = wearableProvider(input.provider)
  if (!provider)
    throw new WearableInputError(
      `unknown provider ${String(input.provider)}; one of ${WEARABLE_PROVIDERS.map((entry) => entry.slug).join(", ")}`,
    )
  const today = new Date(now).toISOString().slice(0, 10)
  const end = input.end_date ?? today
  if (!isCalendarDate(end)) throw new WearableInputError("end_date must be YYYY-MM-DD")
  let start: string | null
  if (input.start_date !== undefined) {
    if (!isCalendarDate(input.start_date) || input.start_date > end)
      throw new WearableInputError("start_date must be YYYY-MM-DD, on or before end_date")
    start = input.start_date
  } else {
    const days = input.days ?? 7
    if (!Number.isInteger(days) || days < 0 || days > MAX_SEEDED_DAYS)
      throw new WearableInputError(`days must be a whole number from 0 to ${MAX_SEEDED_DAYS}`)
    start = days === 0 ? null : addDays(end, 1 - days)
  }
  if (start !== null && daysBetween(start, end).length > MAX_SEEDED_DAYS)
    throw new WearableInputError(`at most ${MAX_SEEDED_DAYS} days of data per connection`)
  const status = input.status ?? "connected"
  if (status !== "connected" && status !== "error")
    throw new WearableInputError('status must be "connected" or "error"')
  const createdOn = state.isoNow(() => now)
  const record: ConnectionRecord = {
    user_id: user.user_id,
    provider: provider.slug,
    created_on: createdOn,
    status,
    external_user_id: null,
    error_details:
      status === "error"
        ? {
            error_type: input.error_type ?? "token_refresh_failed",
            error_message: `The ${provider.name} connection needs to be re-authorised.`,
            errored_at: createdOn,
          }
        : null,
    data_start: start,
    data_end: start === null ? null : end,
  }
  const key = connectionKey(user.user_id, provider.slug)
  if (state.connections.has(key)) state.connections.update(key, record)
  else state.connections.insert(key, record)
  syncConnectedSources(state, user.user_id)
  return record
}

export const resourceAvailability = (provider: ProviderDefinition) =>
  Object.fromEntries(
    [...SUMMARY_RESOURCES, ...TIMESERIES_RESOURCES]
      .filter((resource) => supports(provider, resource))
      .map((resource) => [resource, { status: "available", scope_requirements: null }]),
  )

const renderConnection = (connection: ConnectionRecord) => {
  const provider = wearableProvider(connection.provider)
  return {
    name: provider?.name ?? connection.provider,
    slug: connection.provider,
    logo: providerLogo(connection.provider),
    created_on: connection.created_on,
    status: connection.status,
    external_user_id: connection.external_user_id,
    error_details: connection.error_details,
    resource_availability: provider ? resourceAvailability(provider) : {},
  }
}

const userMissing = (state: JunctionState, userId: string): never =>
  missing(state, "user", userId, "User not found")

const requireWearablesUser = (state: JunctionState, userId: string): UserRecord =>
  state.users.get(userId) ?? userMissing(state, userId)

const queryString = (context: OperationContext, name: string): string | undefined => {
  const value = context.query[name]
  return typeof value === "string" ? value : undefined
}

const queryError = (name: string, type: string, msg: string, input: unknown) =>
  new HttpError(422, { detail: [{ type, loc: ["query", name], msg, input }] })

/** A `start_date`/`end_date` query value: `YYYY-MM-DD` or an ISO-8601 datetime, as epoch ms. */
const parseBound = (name: string, raw: string, endOfDay: boolean): number => {
  if (isCalendarDate(raw)) return Date.parse(`${raw}T00:00:00Z`) + (endOfDay ? 86_399_999 : 0)
  const parsed = /^\d{4}-\d{2}-\d{2}T/.test(raw) ? Date.parse(raw) : Number.NaN
  if (Number.isNaN(parsed))
    throw queryError(name, "datetime_from_date_parsing", "Input should be a valid datetime", raw)
  return parsed
}

const dateRange = (context: OperationContext): { start: number; end: number } => {
  const startRaw = queryString(context, "start_date")
  if (startRaw === undefined) throw queryError("start_date", "missing", "Field required", null)
  const start = parseBound("start_date", startRaw, false)
  const endRaw = queryString(context, "end_date")
  const end = endRaw === undefined ? context.now() : parseBound("end_date", endRaw, true)
  return { start, end }
}

const dayWindow = (range: { start: number; end: number }): Window => ({
  start: new Date(range.start).toISOString().slice(0, 10),
  end: new Date(range.end).toISOString().slice(0, 10),
})

const providerFilter = (context: OperationContext): string | undefined => {
  const value = queryString(context, "provider")
  return value === undefined || value === "" ? undefined : value
}

const SUMMARY_KEY: Readonly<Record<SummaryResource, string>> = {
  activity: "activity",
  sleep: "sleep",
  sleep_cycle: "sleep_cycle",
  body: "body",
  meal: "meals",
}

const summaryHandler =
  (state: JunctionState, resource: SummaryResource) => async (context: OperationContext) => {
    const userId = context.params.user_id ?? ""
    requireWearablesUser(state, userId)
    const window = dayWindow(dateRange(context))
    return jsonRes(200, {
      [SUMMARY_KEY[resource]]: summaryRecords(
        state,
        userId,
        resource,
        window,
        providerFilter(context),
      ),
    })
  }

const rawHandler =
  (state: JunctionState, resource: "sleep" | "body") => async (context: OperationContext) => {
    const userId = context.params.user_id ?? ""
    requireWearablesUser(state, userId)
    const window = dayWindow(dateRange(context))
    return jsonRes(200, {
      [resource]: rawRecords(state, userId, resource, window, providerFilter(context)),
    })
  }

/** Every timeseries resource Junction serves, so an unmodelled one is told apart from a typo. */
const KNOWN_TIMESERIES = new Set<string>([
  ...TIMESERIES_RESOURCES,
  "afib_burden",
  "basal_body_temperature",
  "blood_oxygen",
  "blood_pressure",
  "body_mass_index",
  "body_temperature",
  "body_temperature_delta",
  "caffeine",
  "calories_basal",
  "carbohydrates",
  "cholesterol",
  "daylight_exposure",
  "electrocardiogram_voltage",
  "fall",
  "floors_climbed",
  "forced_vital_capacity",
  "handwashing",
  "heart_rate_alert",
  "heart_rate_recovery_one_minute",
  "hypnogram",
  "ige",
  "igg",
  "inhaler_usage",
  "insulin_injection",
  "lean_body_mass",
  "mindfulness_minutes",
  "note",
  "peak_expiratory_flow_rate",
  "respiratory_rate",
  "sleep_apnea_alert",
  "sleep_breathing_disturbance",
  "stand_duration",
  "stand_hour",
  "stress_level",
  "uv_exposure",
  "waist_circumference",
  "water",
  "wheelchair_push",
  "workout_distance",
  "workout_duration",
  "workout_swimming_stroke",
])

/** The emulator's own refusal for a vendor resource it does not model; never a vendor body. */
export const UNSUPPORTED_RESOURCE_STATUS = 501

export const wearableHandlers = (state: JunctionState) => ({
  generate_link_token_v2_link_token_post: async (context: OperationContext) => {
    const body = context.body.kind === "json" ? context.body.value : undefined
    const record =
      typeof body === "object" && body !== null && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : undefined
    if (!record || typeof record.user_id !== "string") {
      throw new HttpError(422, {
        detail: [
          {
            type: "missing",
            loc: ["body", "user_id"],
            msg: "Field required",
            input: record ?? body ?? null,
          },
        ],
      })
    }
    const userId = record.user_id
    requireWearablesUser(state, userId)
    if (record.provider !== undefined && record.provider !== null) {
      if (typeof record.provider !== "string" || !wearableProvider(record.provider))
        throw new HttpError(422, {
          detail: [
            {
              type: "enum",
              loc: ["body", "provider"],
              msg: `Input should be one of ${WEARABLE_PROVIDERS.map((entry) => `'${entry.slug}'`).join(", ")}`,
              input: record.provider,
            },
          ],
        })
    }
    const sequence = state.ids.next("link_")
    const token = btoa(`mockingbird-link:${userId}:${sequence}`)
    return jsonRes(200, {
      link_token: token,
      link_web_url: `https://link.tryvital.io/?token=${encodeURIComponent(token)}&env=sandbox&region=us`,
    })
  },

  get_providers_v2_providers_get: async () =>
    jsonRes(
      200,
      WEARABLE_PROVIDERS.map((provider) => ({
        name: provider.name,
        slug: provider.slug,
        description: provider.description,
        logo: providerLogo(provider.slug),
        auth_type: provider.auth_type,
        supported_resources: [...SUMMARY_RESOURCES, ...TIMESERIES_RESOURCES].filter((resource) =>
          supports(provider, resource),
        ),
      })),
    ),

  get_connected_providers_v2_user_providers__user_id__get: async (context: OperationContext) => {
    const userId = context.params.user_id ?? ""
    requireWearablesUser(state, userId)
    return jsonRes(200, { providers: connectionsOf(state, userId).map(renderConnection) })
  },

  refresh_user_id_v2_user_refresh__user_id__post: async (context: OperationContext) => {
    const userId = context.params.user_id ?? ""
    requireWearablesUser(state, userId)
    const connections = connectionsOf(state, userId)
    if (connections.length === 0) {
      throw new HttpError(400, {
        success: false,
        user_id: userId,
        error: "user has no connected sources",
        failed_sources: [],
      })
    }
    const sources = (connection: ConnectionRecord) => {
      const provider = wearableProvider(connection.provider)
      return SUMMARY_RESOURCES.filter((resource) => provider && supports(provider, resource)).map(
        (resource) => `${connection.provider}/${resource}`,
      )
    }
    return jsonRes(200, {
      success: true,
      user_id: userId,
      refreshed_sources: connections
        .filter((connection) => connection.status === "connected")
        .flatMap(sources),
      in_progress_sources: [],
      failed_sources: connections
        .filter((connection) => connection.status === "error")
        .flatMap(sources),
    })
  },

  deregister_provider_v2_user__user_id___provider__delete: async (context: OperationContext) => {
    const userId = context.params.user_id ?? ""
    const slug = context.params.provider ?? ""
    if (!wearableProvider(slug))
      throw new HttpError(422, {
        detail: [
          {
            type: "enum",
            loc: ["path", "provider"],
            msg: `Input should be one of ${WEARABLE_PROVIDERS.map((entry) => `'${entry.slug}'`).join(", ")}`,
            input: slug,
          },
        ],
      })
    requireWearablesUser(state, userId)
    const key = connectionKey(userId, slug)
    if (!state.connections.has(key))
      throw new HttpError(404, { detail: `Provider ${slug} is not connected for this user` })
    state.connections.delete(key)
    syncConnectedSources(state, userId)
    return jsonRes(200, { success: true })
  },

  get_activity_summary_v2_summary_activity__user_id__get: summaryHandler(state, "activity"),
  get_sleep_summary_v2_summary_sleep__user_id__get: summaryHandler(state, "sleep"),
  get_sleep_raw_v2_summary_sleep__user_id__raw_get: rawHandler(state, "sleep"),
  get_sleep_cycle_v2_summary_sleep_cycle__user_id__get: summaryHandler(state, "sleep_cycle"),
  get_body_summary_v2_summary_body__user_id__get: summaryHandler(state, "body"),
  get_body_raw_v2_summary_body__user_id__raw_get: rawHandler(state, "body"),
  get_meal_summary_v2_summary_meal__user_id__get: summaryHandler(state, "meal"),

  get_grouped_timeseries_v2_timeseries__user_id___resource__grouped_get: async (
    context: OperationContext,
  ) => {
    const userId = context.params.user_id ?? ""
    const resource = context.params.resource ?? ""
    if (!(TIMESERIES_RESOURCES as readonly string[]).includes(resource)) {
      if (KNOWN_TIMESERIES.has(resource))
        throw new HttpError(UNSUPPORTED_RESOURCE_STATUS, {
          detail: `mockingbird: the Junction emulator does not model the ${resource} timeseries; modelled: ${TIMESERIES_RESOURCES.join(", ")}`,
        })
      throw new HttpError(404, { detail: "Not Found" })
    }
    requireWearablesUser(state, userId)
    const groups = groupedTimeseries(
      state,
      userId,
      resource as TimeseriesResource,
      dateRange(context),
      providerFilter(context),
    )
    return jsonRes(200, { groups, next: null, next_cursor: null })
  },
})
