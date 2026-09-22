import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  annotateResponse,
  bootSqlite,
  createService,
  defineOperations,
  faultEffect,
  HttpError,
  type OperationContext,
  type Service,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { Hono } from "hono"
import type { CorpusAddress } from "./corpus.js"
import { document, type SupportedOperationId } from "./generated/openapi.js"
import {
  autocomplete,
  findPlace,
  geocode,
  geometry,
  normalize,
  type Place,
  pickFields,
  placeById,
  placeResult,
  prediction,
  unknownFields,
} from "./places.js"
import { mapsJavaScript } from "./shim.js"
import { GoogleMapsState, type Settings } from "./state.js"

export type { FetchAPI } from "@crvouga/mockingbird-core"
export type { SqliteClient } from "@crvouga/mockingbird-sqlite"
export type { CorpusAddress } from "./corpus.js"
export { DEFAULT_CORPUS, PHOENIX_DEMO_ADDRESS, STATE_NAMES } from "./corpus.js"
export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export type { AddressComponent, Place, Prediction } from "./places.js"
export { corpusPlaceId } from "./places.js"
export type { ShimOptions } from "./shim.js"
export { mapsJavaScript } from "./shim.js"
export type { Settings } from "./state.js"

export const GOOGLE_MAPS_NAMESPACE = "google-maps"

/** Google's own wording for the two ways a key is refused. */
export const MISSING_KEY_MESSAGE =
  "You must use an API key to authenticate each request to Google Maps Platform APIs. For additional information, please refer to http://g.co/dev/maps-no-account"
export const INVALID_KEY_MESSAGE = "The provided API key is invalid. "

/** Google statuses the mock answers with (always HTTP 200, as Google does). */
export type GoogleStatus =
  | "OK"
  | "ZERO_RESULTS"
  | "INVALID_REQUEST"
  | "OVER_QUERY_LIMIT"
  | "REQUEST_DENIED"
  | "UNKNOWN_ERROR"
  | "NOT_FOUND"

export type GoogleMapsAPIOptions = APIOptions & {
  /** Addresses every namespace resolves. Default: {@link DEFAULT_CORPUS}. */
  corpus?: readonly CorpusAddress[]
  /** Initial per-namespace settings (accepted keys, public URL for the JS shim). */
  settings?: Partial<Settings>
  /** The public namespace name, so the JS shim can call back into the same namespace. */
  publicNamespace?: string
}

/** The API key a request carries (`?key=`): how keys map to namespaces. */
export const keyCredential = (request: Request): string | undefined =>
  new URL(request.url).searchParams.get("key") ?? undefined

const CORS = { "access-control-allow-origin": "*" }

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body, null, 3), {
    status,
    headers: { "content-type": "application/json; charset=UTF-8", ...CORS },
  })

/** The empty collection each endpoint carries next to a non-OK status. */
const EMPTY: Record<string, Record<string, unknown>> = {
  PlaceAutocomplete: { predictions: [] },
  PlaceDetails: { html_attributions: [] },
  Geocode: { results: [] },
  FindPlaceFromText: { candidates: [] },
}

const DEFAULT_MESSAGES: Partial<Record<GoogleStatus, string>> = {
  OVER_QUERY_LIMIT:
    "You have exceeded your rate-limit for this API. For more information on Google Maps Platform rate limits, please see https://developers.google.com/maps/documentation/places/web-service/usage-and-billing",
  UNKNOWN_ERROR: "An unknown error occurred. Please try again.",
  REQUEST_DENIED: INVALID_KEY_MESSAGE,
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : Array.isArray(value) ? String(value[0]) : undefined

/**
 * Stateless-over-a-corpus mock of Google Places Autocomplete / Details / Find Place, the
 * Geocoding API and a Maps JavaScript shim. Every answer is HTTP 200 with Google's `status`.
 */
export class GoogleMapsAPI implements FetchAPI {
  readonly app: Hono
  readonly sqlite: SqliteClient
  readonly state: GoogleMapsState
  private readonly service: Service
  private readonly publicNamespace: string

  constructor(options: GoogleMapsAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite)
    const namespace = options.namespace ?? GOOGLE_MAPS_NAMESPACE
    this.publicNamespace = options.publicNamespace ?? "default"
    this.state = new GoogleMapsState(sqlite, namespace, {
      corpus: options.corpus ?? [],
      settings: options.settings ?? {},
    })
    const handlers = defineOperations<SupportedOperationId>({
      PlaceAutocomplete: (context) => this.autocomplete(context),
      PlaceDetails: (context) => this.details(context),
      Geocode: (context) => this.geocode(context),
      FindPlaceFromText: (context) => this.findPlace(context),
      MapsJavaScriptApi: (context) => this.script(context),
    })
    this.service = createService({
      document,
      handlers,
      sqlite,
      namespace,
      ...(options.now ? { now: options.now } : {}),
      notFound: () =>
        new Response("<html><body><h1>Not Found</h1></body></html>", {
          status: 404,
          headers: { "content-type": "text/html; charset=UTF-8", ...CORS },
        }),
      onError: (error) => {
        if (error instanceof HttpError) return error.toResponse()
        throw error
      },
      before: (context) => this.gate(context),
    })
    this.app = this.service.app
    this.sqlite = this.service.sqlite
  }

  fetch(request: Request): Promise<Response> {
    return this.service.fetch(request)
  }

  async reset(): Promise<void> {
    await this.service.reset()
    this.state.ensureSeeded()
  }

  /** The addresses this namespace resolves (custom rows first). */
  corpus(): CorpusAddress[] {
    return this.state.corpus()
  }

  private status(operationId: string, status: GoogleStatus, message?: string): Response {
    return json({
      ...EMPTY[operationId],
      ...(message ? { error_message: message } : {}),
      status,
    })
  }

  /** Key check and status-effect faults, before every web-service call. */
  private gate(context: OperationContext): Response | undefined {
    const operationId = context.operation.operationId
    if (operationId === "MapsJavaScriptApi") return undefined
    const key = text(context.query.key)
    if (!key) return this.status(operationId, "REQUEST_DENIED", MISSING_KEY_MESSAGE)
    const keys = this.state.current().keys
    if (keys.length > 0 && !keys.includes(key)) {
      return this.status(operationId, "REQUEST_DENIED", INVALID_KEY_MESSAGE)
    }
    const forced = faultEffect(context.request, "google_status")
    if (forced !== undefined) {
      const status = (
        typeof forced.status === "string" ? forced.status : "UNKNOWN_ERROR"
      ) as GoogleStatus
      const message =
        typeof forced.error_message === "string" ? forced.error_message : DEFAULT_MESSAGES[status]
      return this.status(operationId, status, message)
    }
    return undefined
  }

  private noted(response: Response, context: OperationContext, place?: Place): Response {
    const session = text(context.query.sessiontoken)
    const ids: Record<string, string> = {}
    if (place) ids.placeId = place.placeId
    // The session token is an opaque UUID, not an address: metadata only.
    if (session) ids.sessionToken = session
    return Object.keys(ids).length > 0 ? annotateResponse(response, { ids }) : response
  }

  private autocomplete(context: OperationContext): Response {
    const input = text(context.query.input)
    if (!input) return this.status("PlaceAutocomplete", "INVALID_REQUEST")
    const components = text(context.query.components)
    if (components !== undefined) {
      const countries = components
        .split("|")
        .map((c) => c.trim().toLowerCase())
        .filter((c) => c.startsWith("country:"))
        .map((c) => c.slice("country:".length))
      if (countries.length > 0 && !countries.includes("us")) {
        return this.noted(json({ predictions: [], status: "ZERO_RESULTS" }), context)
      }
    }
    const types = text(context.query.types)
    let places = autocomplete(input, this.state.corpus())
    if (types === "address") places = places.filter((p) => p.kind === "street_address")
    if (places.length === 0) {
      return this.noted(json({ predictions: [], status: "ZERO_RESULTS" }), context)
    }
    return this.noted(
      json({ predictions: places.map((p) => prediction(p, input)), status: "OK" }),
      context,
      places[0],
    )
  }

  private details(context: OperationContext): Response {
    const placeId = text(context.query.place_id)
    if (!placeId) return this.status("PlaceDetails", "INVALID_REQUEST")
    const fields = text(context.query.fields)
    if (unknownFields(fields).length > 0) {
      return this.status(
        "PlaceDetails",
        "INVALID_REQUEST",
        `Error while parsing 'fields' parameter: Unsupported field name '${unknownFields(fields)[0]}'. `,
      )
    }
    const place = placeById(placeId, this.state.corpus())
    if (!place) return this.noted(this.status("PlaceDetails", "NOT_FOUND"), context)
    return this.noted(
      json({
        html_attributions: [],
        result: pickFields(placeResult(place), fields, "all"),
        status: "OK",
      }),
      context,
      place,
    )
  }

  private geocode(context: OperationContext): Response {
    const address = text(context.query.address)
    const placeId = text(context.query.place_id)
    const components = text(context.query.components)
    const zip = components
      ?.split("|")
      .find((c) => c.startsWith("postal_code:"))
      ?.slice("postal_code:".length)
    if (!address && !placeId && !zip) return this.status("Geocode", "INVALID_REQUEST")
    const rows = this.state.corpus()
    const place = placeId
      ? placeById(placeId, rows)
      : address
        ? geocode(address, rows)
        : geocode(zip as string, rows)
    if (!place) return this.noted(json({ results: [], status: "ZERO_RESULTS" }), context)
    const full = placeResult(place)
    return this.noted(
      json({
        results: [
          {
            address_components: full.address_components,
            formatted_address: full.formatted_address,
            geometry: geometry(place, true),
            place_id: place.placeId,
            types: full.types,
          },
        ],
        status: "OK",
      }),
      context,
      place,
    )
  }

  private findPlace(context: OperationContext): Response {
    const input = text(context.query.input)
    const inputtype = text(context.query.inputtype)
    if (!input || (inputtype !== "textquery" && inputtype !== "phonenumber")) {
      return this.status("FindPlaceFromText", "INVALID_REQUEST")
    }
    const fields = text(context.query.fields)
    if (unknownFields(fields).length > 0) {
      return this.status(
        "FindPlaceFromText",
        "INVALID_REQUEST",
        `Error while parsing 'fields' parameter: Unsupported field name '${unknownFields(fields)[0]}'. `,
      )
    }
    const place = inputtype === "textquery" ? findPlace(input, this.state.corpus()) : undefined
    if (!place) return this.noted(json({ candidates: [], status: "ZERO_RESULTS" }), context)
    return this.noted(
      json({ candidates: [pickFields(placeResult(place), fields, ["place_id"])], status: "OK" }),
      context,
      place,
    )
  }

  private script(context: OperationContext): Response {
    const key = text(context.query.key) ?? ""
    const settings = this.state.current()
    const origin = (settings.publicUrl ?? context.url.origin).replace(/\/$/, "")
    const prefix =
      this.publicNamespace === "default" ? "" : `/ns/${encodeURIComponent(this.publicNamespace)}`
    const callback = text(context.query.callback) ?? null
    const safeCallback = callback && /^[A-Za-z_$][\w$.]*$/.test(callback) ? callback : null
    const authFailed = !key || (settings.keys.length > 0 && !settings.keys.includes(key))
    return new Response(
      mapsJavaScript({ base: `${origin}${prefix}`, key, authFailed, callback: safeCallback }),
      {
        status: 200,
        headers: { "content-type": "text/javascript; charset=UTF-8", ...CORS },
      },
    )
  }
}

export type { GoogleMapsRuntime, GoogleMapsRuntimeOptions } from "./runtime.js"
export { createRuntime, GOOGLE_MAPS_PRESETS } from "./runtime.js"
/** Normalized form used for address matching (lowercase, alphanumerics, single spaces). */
export { normalize }
