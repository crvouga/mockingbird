import {
  type AdminRoutes,
  type Clock,
  createRuntime as createServiceRuntime,
  type FaultPreset,
  type RequestLog,
  type ServiceRuntime,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { type CorpusAddress, DEFAULT_CORPUS } from "./corpus.js"
import { document } from "./generated/openapi.js"
import { GOOGLE_MAPS_NAMESPACE, GoogleMapsAPI, keyCredential } from "./index.js"
import type { Settings } from "./state.js"

const WEB_SERVICES = ["PlaceAutocomplete", "PlaceDetails", "Geocode", "FindPlaceFromText"] as const

const everyWebService = (rule: Record<string, unknown>) =>
  WEB_SERVICES.map((operationId) => ({ operationId, ...rule }))

/**
 * Every named Google misbehaviour our consumer branches on, switched on with
 * `POST /__admin/faults {"preset": "<name>", "count"?: n}`. Google answers these with HTTP 200
 * and a non-OK `status`, which is what our client's consecutive-failure counter reads.
 */
export const GOOGLE_MAPS_PRESETS: Record<string, FaultPreset> = {
  over_query_limit: {
    description: "Every web-service call answers status OVER_QUERY_LIMIT (HTTP 200)",
    rules: everyWebService({ effect: "google_status", params: { status: "OVER_QUERY_LIMIT" } }),
  },
  request_denied: {
    description: "Every web-service call answers status REQUEST_DENIED, as for a revoked key",
    rules: everyWebService({ effect: "google_status", params: { status: "REQUEST_DENIED" } }),
  },
  unknown_error: {
    description: "Every web-service call answers status UNKNOWN_ERROR (Google's transient failure)",
    rules: everyWebService({ effect: "google_status", params: { status: "UNKNOWN_ERROR" } }),
  },
  zero_results: {
    description: "Every web-service call answers status ZERO_RESULTS",
    rules: everyWebService({ effect: "google_status", params: { status: "ZERO_RESULTS" } }),
  },
  geocode_zero_results: {
    description: "Geocoding answers ZERO_RESULTS, so our client falls back to Find Place",
    rules: [
      { operationId: "Geocode", effect: "google_status", params: { status: "ZERO_RESULTS" } },
    ],
  },
  autocomplete_over_query_limit: {
    description:
      "Only Place Autocomplete answers OVER_QUERY_LIMIT (the manual-entry fallback path)",
    rules: [
      {
        operationId: "PlaceAutocomplete",
        effect: "google_status",
        params: { status: "OVER_QUERY_LIMIT" },
      },
    ],
  },
  server_error: {
    description: "Every web-service call answers HTTP 500 (our client counts !res.ok as a failure)",
    rules: everyWebService({ status: 500, body: { error: "Internal Server Error" } }),
  },
  slow: {
    description: "Every web-service call is held 6 s: past QA's 5 s wait for predictions",
    rules: everyWebService({ latencyMs: 6_000 }),
  },
  script_unavailable: {
    description: "The Maps JavaScript API answers 503, so the script's onerror fires",
    rules: [{ operationId: "MapsJavaScriptApi", status: 503, body: "Service Unavailable" }],
  },
}

export type GoogleMapsRuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  seed?: number | string
  adminKey?: string
  onLog?: (entry: RequestLog) => void
  /** Addresses every namespace resolves. Default: the QA corpus. */
  corpus?: readonly CorpusAddress[]
  settings?: Partial<Settings>
}

export type GoogleMapsRuntime = ServiceRuntime<GoogleMapsAPI>

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const adminError = (status: number, message: string) =>
  json(status, { error: { type: "mockingbird_admin", message } })
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** One admin-supplied address, or the reason it is refused. */
export const parseAddress = (value: unknown, index: number): CorpusAddress | string => {
  if (!isRecord(value)) return `addresses[${index}] must be an object`
  for (const key of ["line1", "city", "state", "zip"] as const) {
    if (typeof value[key] !== "string" || !(value[key] as string).trim()) {
      return `addresses[${index}].${key} must be a non-empty string`
    }
  }
  const state = String(value.state).toUpperCase()
  if (!/^[A-Z]{2}$/.test(state)) return `addresses[${index}].state must be a two-letter code`
  const lat = value.lat === undefined ? 0 : Number(value.lat)
  const lng = value.lng === undefined ? 0 : Number(value.lng)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return `addresses[${index}].lat/lng must be numbers`
  }
  return {
    id:
      typeof value.id === "string" && value.id
        ? value.id
        : `custom-${String(value.zip)}-${String(value.line1)
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")}`,
    line1: String(value.line1).trim(),
    city: String(value.city).trim(),
    state,
    zip: String(value.zip).trim(),
    county: typeof value.county === "string" ? value.county : "",
    lat,
    lng,
  }
}

const adminRoutes = (runtime: ServiceRuntime<GoogleMapsAPI>): AdminRoutes => ({
  "GET /corpus": ({ namespace }) => {
    const api = runtime.instance(namespace)
    return json(200, {
      addresses: api.corpus(),
      custom: api.state.custom.count(),
    })
  },
  "PUT /corpus": ({ body, namespace }) => {
    const list = Array.isArray(body) ? body : isRecord(body) ? body.addresses : undefined
    if (!Array.isArray(list)) {
      return adminError(400, 'expected {"addresses": [{line1, city, state, zip, lat?, lng?}]}')
    }
    const rows: CorpusAddress[] = []
    for (const [index, each] of list.entries()) {
      const parsed = parseAddress(each, index)
      if (typeof parsed === "string") return adminError(400, parsed)
      rows.push(parsed)
    }
    const api = runtime.instance(namespace)
    api.state.replaceCustom(rows)
    return json(200, { custom: rows })
  },
  "DELETE /corpus": ({ namespace }) => {
    runtime.instance(namespace).state.replaceCustom([])
    return json(200, { status: "ok" })
  },
  "GET /settings": ({ namespace }) => json(200, runtime.instance(namespace).state.current()),
  "PUT /settings": ({ body, namespace }) => {
    if (!isRecord(body)) return adminError(400, "expected a JSON object")
    const patch: Partial<Settings> = {}
    if (body.keys !== undefined) {
      if (!Array.isArray(body.keys)) return adminError(400, "keys: string[]")
      patch.keys = body.keys.map(String)
    }
    if (body.publicUrl !== undefined) {
      if (body.publicUrl !== null && typeof body.publicUrl !== "string") {
        return adminError(400, "publicUrl: string | null")
      }
      patch.publicUrl = body.publicUrl as string | null
    }
    return json(200, runtime.instance(namespace).state.update(patch))
  },
})

/**
 * The Google Maps mock with Mockingbird's full service contract: `/health`, `/__admin/*`,
 * namespaces by header, by `/ns/<name>` path prefix, or by API key
 * (`PUT /__admin/credentials {"credentials": {"<PLACES_KEY>": "<namespace>"}}`), clock control,
 * fault presets and a request journal. Google Maps sends no webhooks.
 */
export const createRuntime = (options: GoogleMapsRuntimeOptions = {}): GoogleMapsRuntime =>
  createServiceRuntime<GoogleMapsAPI>({
    name: GOOGLE_MAPS_NAMESPACE,
    document,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    credential: keyCredential,
    presets: GOOGLE_MAPS_PRESETS,
    create: ({ sqlite, namespace, publicNamespace, clock }) =>
      new GoogleMapsAPI({
        sqlite,
        namespace,
        publicNamespace,
        now: clock.now,
        ...(options.corpus ? { corpus: options.corpus } : {}),
        ...(options.settings ? { settings: options.settings } : {}),
      }),
    describe: () => ({
      corpus: options.corpus
        ? `custom (${options.corpus.length})`
        : `qa-routing-zip-corpus (${DEFAULT_CORPUS.length})`,
    }),
    admin: adminRoutes,
  })
