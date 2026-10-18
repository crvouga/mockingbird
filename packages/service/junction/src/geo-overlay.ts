/**
 * ZIP overlays: aliases and per-ZIP overrides on top of whatever geo mode answers.
 *
 * `createRuntime({ zipOverlays: { aliases: { "07105": "85004" }, overrides: { "07105": {
 * phlebotomy_served: true, no_pscs: true } } } })`. An alias makes one ZIP answer as another
 * (coverage, recordings and the synthetic model all use the target); an override then edits the
 * answer for a ZIP: `phlebotomy.is_served` on `area/info`, and an empty PSC list.
 */
import { jsonRes, type OperationContext } from "@crvouga/mockingbird-service"
import type { JunctionState } from "./state.js"

export type ZipOverride = {
  /** `phlebotomy.is_served` on `GET /v3/order/area/info` (and its `providers`). */
  phlebotomy_served?: boolean
  /** No patient service centers: `psc/info` lists none and `area/info` counts none. */
  no_pscs?: boolean
}

export type ZipOverlays = {
  /** ZIP → the ZIP it answers as. */
  aliases?: Record<string, string>
  /** ZIP → what to change in its answers. Looked up by the requested ZIP, then by its alias. */
  overrides?: Record<string, ZipOverride>
}

const ZIP = /^\d{5}$/

export const validateZipOverlays = (overlays: ZipOverlays): void => {
  for (const [from, to] of Object.entries(overlays.aliases ?? {})) {
    if (!ZIP.test(from) || typeof to !== "string" || !ZIP.test(to))
      throw new TypeError(
        `zipOverlays.aliases: expected 5-digit ZIPs (got ${from} -> ${String(to)})`,
      )
  }
  for (const [zip, override] of Object.entries(overlays.overrides ?? {})) {
    if (!ZIP.test(zip)) throw new TypeError(`zipOverlays.overrides: ${zip} is not a 5-digit ZIP`)
    for (const [key, value] of Object.entries(override)) {
      if (key !== "phlebotomy_served" && key !== "no_pscs")
        throw new TypeError(`zipOverlays.overrides.${zip}: unknown field ${key}`)
      if (typeof value !== "boolean")
        throw new TypeError(`zipOverlays.overrides.${zip}.${key}: expected a boolean`)
    }
  }
}

const zipOf = (context: OperationContext): string | undefined => {
  const fromQuery = context.url.searchParams.get("zip_code")
  if (fromQuery !== null) return fromQuery.slice(0, 5)
  const body = context.body
  if (body.kind === "json" && typeof body.value === "object" && body.value !== null) {
    const zip = (body.value as Record<string, unknown>).zip_code
    if (typeof zip === "string") return zip.slice(0, 5)
  }
  return undefined
}

const asZip = (context: OperationContext, zip: string): OperationContext => {
  const url = new URL(context.url)
  const hadQuery = url.searchParams.has("zip_code")
  if (hadQuery) url.searchParams.set("zip_code", zip)
  const body =
    context.body.kind === "json" &&
    typeof context.body.value === "object" &&
    context.body.value !== null &&
    typeof (context.body.value as Record<string, unknown>).zip_code === "string"
      ? { ...context.body, value: { ...(context.body.value as object), zip_code: zip } }
      : context.body
  return {
    ...context,
    url,
    query: hadQuery ? { ...context.query, zip_code: zip } : context.query,
    body,
  }
}

type Handler = (context: OperationContext) => Promise<Response> | Response

const jsonOf = async (response: Response): Promise<Record<string, unknown> | undefined> => {
  if (response.status !== 200) return undefined
  try {
    const value: unknown = await response.clone().json()
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const patched = (response: Response, body: Record<string, unknown>): Response => {
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  headers.delete("content-encoding")
  return jsonRes(response.status, body, Object.fromEntries(headers))
}

/**
 * Wrap a serviceability handler so aliases resolve before it runs and overrides edit its
 * answer. A namespace with no overlays passes straight through.
 */
export const withZipOverlays =
  (state: JunctionState, kind: "area" | "psc" | "availability", handler: Handler): Handler =>
  async (context) => {
    const overlays = state.zipOverlays
    const requested = zipOf(context)
    if (requested === undefined || (!overlays.aliases && !overlays.overrides))
      return handler(context)
    const target = overlays.aliases?.[requested]
    const response = await handler(target === undefined ? context : asZip(context, target))
    const override =
      overlays.overrides?.[requested] ??
      (target === undefined ? undefined : overlays.overrides?.[target])
    if (target === undefined && !override) return response
    const body = await jsonOf(response)
    if (!body) return response
    if (target !== undefined && typeof body.zip_code === "string") body.zip_code = requested
    if (override && kind === "area") {
      if (override.phlebotomy_served !== undefined) {
        const phlebotomy = record(body.phlebotomy) ?? {}
        const had = Array.isArray(phlebotomy.providers) ? phlebotomy.providers : []
        phlebotomy.is_served = override.phlebotomy_served
        phlebotomy.providers = !override.phlebotomy_served
          ? []
          : had.length > 0
            ? had
            : [{ name: "getlabs", service_types: ["appointment-ready"] }]
        body.phlebotomy = phlebotomy
      }
      if (override.no_pscs === true) {
        for (const lab of Object.values(record(body.central_labs) ?? {})) {
          const centers = record(record(lab)?.patient_service_centers)
          if (centers) centers.within_radius = 0
        }
      }
    }
    if (override?.no_pscs === true && kind === "psc") body.patient_service_centers = []
    return patched(response, body)
  }
