/**
 * A-la-carte markers and order-set pricing.
 *
 * - `GET /v3/lab_tests/markers`: the markers a team can order one by one.
 *   https://docs.junction.com/api-reference/lab-testing/biomarkers
 * - `POST /v3/lab_test/estimate_order_set_pricing`: what an order set costs.
 *   https://docs.junction.com/api-reference/lab-testing/estimate-order-set-pricing
 *
 * Both follow the published contract. Nothing here is checked against the live sandbox (prices
 * are contract-owned), so the emulator prices from the catalog it holds: a lab test's `price`
 * and a marker's `price`, or the `pricing` of a configured {@link MarkerCatalogEntry}.
 */
import { HttpError, jsonRes, type OperationContext } from "@crvouga/mockingbird-service"
import type { CatalogMarker, ExpectedResult } from "./catalog.js"
import { BILLING_TYPES } from "./lab-accounts.js"
import { paginateMarkers } from "./orders.js"
import type { JunctionState } from "./state.js"

/** Pricing the way Junction states it: minor units, or why it is not stated. */
export type MarkerPricing =
  | {
      base_amount_minor: number
      modifiers?: readonly Record<string, unknown>[] | null
    }
  | { unspecified: "refer_to_contract" | "price_unavailable" }

/**
 * A marker the mock offers on top of (or in place of) the ones embedded in catalog lab tests:
 * `createRuntime({ markerCatalog: [...] })`. Fields not given take the vendor's defaults.
 */
export type MarkerCatalogEntry = {
  id: number
  name: string
  slug?: string
  description?: string | null
  lab_id?: number | null
  provider_id?: string | null
  type?: "biomarker" | "panel" | null
  unit?: string | null
  /** Dollars, as the vendor prints them (`"12.50"`); a number is formatted to two decimals. */
  price?: string | number | null
  /** Stated pricing, when `price` cannot say it (modifiers, `refer_to_contract`). */
  pricing?: MarkerPricing
  /** Ask-on-order questions: `{ questions: [...] }`. */
  aoe?: unknown
  /** Default `false`, as at the vendor. */
  a_la_carte_enabled?: boolean
  common_tat_days?: number | null
  worst_case_tat_days?: number | null
  is_orderable?: boolean | null
  /** What the marker reports. Default: none. */
  expected_results?: readonly ExpectedResult[]
  components?: readonly MarkerCatalogEntry[] | null
}

const slugOf = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

const priceText = (price: string | number | null | undefined): string | null => {
  if (price === undefined || price === null) return null
  return typeof price === "number" ? price.toFixed(2) : price
}

/** Whole cents of a dollar amount (`"12.50"`, `12.5`), or `undefined` for `"N/A"` and the like. */
const minorOf = (price: unknown): number | undefined => {
  if (typeof price === "number") return Number.isFinite(price) ? Math.round(price * 100) : undefined
  if (typeof price !== "string" || !/^\s*\$?\d+(?:\.\d+)?\s*$/.test(price)) return undefined
  return Math.round(Number(price.replace("$", "")) * 100)
}

const UNAVAILABLE: MarkerPricing = { unspecified: "price_unavailable" }

type Offered = {
  marker: Record<string, unknown>
  pricing: MarkerPricing
}

const fromEntry = (entry: MarkerCatalogEntry): Offered => {
  const { pricing, expected_results, components, price, ...rest } = entry
  const marker: Record<string, unknown> = {
    slug: slugOf(entry.name),
    description: null,
    lab_id: null,
    provider_id: null,
    type: "biomarker",
    unit: null,
    aoe: null,
    a_la_carte_enabled: false,
    common_tat_days: null,
    worst_case_tat_days: null,
    is_orderable: true,
    ...rest,
    price: priceText(price),
    expected_results: [...(expected_results ?? [])],
  }
  if (components) marker.components = components.map((child) => fromEntry(child).marker)
  const minor = minorOf(price)
  return {
    marker,
    pricing: pricing ?? (minor === undefined ? UNAVAILABLE : { base_amount_minor: minor }),
  }
}

/**
 * Every marker the team can order: those embedded in active catalog lab tests, then the
 * configured {@link MarkerCatalogEntry} list, which wins on a shared id.
 */
const offeredMarkers = (state: JunctionState): Map<number, Offered> => {
  const offered = new Map<number, Offered>()
  for (const test of state.listLabTests()) {
    if (test.status !== "active") continue
    for (const marker of test.markers ?? []) {
      if (offered.has(marker.id)) continue
      const nested = (marker as { expected_results?: unknown }).expected_results
      const minor = minorOf(marker.price)
      offered.set(marker.id, {
        marker: {
          ...marker,
          expected_results: Array.isArray(nested) ? nested : state.expectedResultsFor(test.id),
        },
        pricing: minor === undefined ? UNAVAILABLE : { base_amount_minor: minor },
      })
    }
  }
  for (const entry of state.markerCatalog) offered.set(entry.id, fromEntry(entry))
  return offered
}

export const validateMarkerCatalog = (entries: readonly MarkerCatalogEntry[]): void => {
  const seen = new Set<number>()
  for (const entry of entries) {
    if (!Number.isInteger(entry.id) || typeof entry.name !== "string" || entry.name === "")
      throw new TypeError("markerCatalog entries need an integer id and a name")
    if (seen.has(entry.id)) throw new TypeError(`markerCatalog: duplicate marker id ${entry.id}`)
    seen.add(entry.id)
    if (entry.pricing !== undefined) {
      const stated = entry.pricing
      const ok =
        "unspecified" in stated
          ? stated.unspecified === "refer_to_contract" || stated.unspecified === "price_unavailable"
          : Number.isInteger(stated.base_amount_minor)
      if (!ok) throw new TypeError(`markerCatalog: marker ${entry.id} has invalid pricing`)
    }
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const queryError = (type: string, name: string, msg: string, input: unknown, index?: number) => ({
  type,
  loc: index === undefined ? ["query", name] : ["query", name, index],
  msg,
  input,
})

const booleanParam = (params: URLSearchParams, name: string): boolean | null => {
  const raw = params.get(name)
  if (raw === null) return null
  const lowered = raw.toLowerCase()
  if (["true", "1", "t", "yes", "on"].includes(lowered)) return true
  if (["false", "0", "f", "no", "off"].includes(lowered)) return false
  throw new HttpError(422, {
    detail: [
      queryError(
        "bool_parsing",
        name,
        "Input should be a valid boolean, unable to interpret input",
        raw,
      ),
    ],
  })
}

const markerQuery = (params: URLSearchParams) => {
  const labIds = params.getAll("lab_id").map((raw, index) => {
    if (!/^-?\d+$/.test(raw))
      throw new HttpError(422, {
        detail: [
          queryError(
            "int_parsing",
            "lab_id",
            "Input should be a valid integer, unable to parse string as an integer",
            raw,
            index,
          ),
        ],
      })
    return Number(raw)
  })
  const labAccountId = params.get("lab_account_id")
  if (labAccountId !== null && !UUID.test(labAccountId))
    throw new HttpError(422, {
      detail: [
        queryError(
          "uuid_parsing",
          "lab_account_id",
          "Input should be a valid UUID, invalid length or character",
          labAccountId,
        ),
      ],
    })
  return {
    labIds,
    labSlug: params.get("lab_slug"),
    name: (params.get("name") ?? "").toLowerCase(),
    aLaCarte: booleanParam(params, "a_la_carte_enabled"),
    includePricing: booleanParam(params, "include_pricing") === true,
    labAccountId,
  }
}

const jsonBody = (context: OperationContext): Record<string, unknown> => {
  const value = context.body.kind === "json" ? context.body.value : undefined
  if (typeof value !== "object" || value === null || Array.isArray(value))
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
  return value as Record<string, unknown>
}

const missing = (field: string, input: unknown) => ({
  type: "missing",
  loc: ["body", field],
  msg: "Field required",
  input,
})

const MODALITIES = ["testkit", "walk_in_test", "at_home_phlebotomy", "on_site_collection"]

type OrderSetInput = {
  lab_test_ids: string[]
  marker_ids: number[]
  provider_ids: string[]
}

const orderSetInputs = (body: Record<string, unknown>): OrderSetInput[] => {
  const errors: unknown[] = []
  const sets = body.order_sets
  if (sets === undefined) errors.push(missing("order_sets", body))
  else if (!Array.isArray(sets))
    errors.push({
      type: "list_type",
      loc: ["body", "order_sets"],
      msg: "Input should be a valid list",
      input: sets,
    })
  else if (sets.length === 0)
    errors.push({
      type: "too_short",
      loc: ["body", "order_sets"],
      msg: "List should have at least 1 item after validation, not 0",
      input: sets,
      ctx: { field_type: "List", min_length: 1, actual_length: 0 },
    })
  if (body.modality === undefined) errors.push(missing("modality", body))
  else if (typeof body.modality !== "string" || !MODALITIES.includes(body.modality))
    errors.push({
      type: "enum",
      loc: ["body", "modality"],
      msg: "Input should be 'testkit', 'walk_in_test', 'at_home_phlebotomy' or 'on_site_collection'",
      input: body.modality,
      ctx: { expected: MODALITIES.map((each) => `'${each}'`).join(", ") },
    })
  if (body.us_state === undefined) errors.push(missing("us_state", body))
  else if (typeof body.us_state !== "string")
    errors.push({
      type: "string_type",
      loc: ["body", "us_state"],
      msg: "Input should be a valid string",
      input: body.us_state,
    })
  if (
    body.billing !== undefined &&
    body.billing !== null &&
    !(BILLING_TYPES as readonly unknown[]).includes(body.billing)
  )
    errors.push({
      type: "enum",
      loc: ["body", "billing"],
      msg: `Input should be ${BILLING_TYPES.map((each) => `'${each}'`).join(", ")}`,
      input: body.billing,
    })
  const parsed: OrderSetInput[] = []
  if (Array.isArray(sets)) {
    sets.forEach((raw, index) => {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        errors.push({
          type: "model_attributes_type",
          loc: ["body", "order_sets", index],
          msg: "Input should be a valid dictionary or object to extract fields from",
          input: raw,
        })
        return
      }
      const set = raw as Record<string, unknown>
      const addOn = (set.add_on ?? {}) as Record<string, unknown>
      const stringList = (value: unknown, loc: (string | number)[]): string[] => {
        if (value === undefined || value === null) return []
        if (!Array.isArray(value) || !value.every((each) => typeof each === "string")) {
          errors.push({
            type: "list_type",
            loc,
            msg: "Input should be a valid list of strings",
            input: value,
          })
          return []
        }
        return value as string[]
      }
      const markerIds = addOn.marker_ids
      let ids: number[] = []
      if (markerIds !== undefined && markerIds !== null) {
        if (!Array.isArray(markerIds) || !markerIds.every((each) => Number.isInteger(each)))
          errors.push({
            type: "int_type",
            loc: ["body", "order_sets", index, "add_on", "marker_ids"],
            msg: "Input should be a valid list of integers",
            input: markerIds,
          })
        else ids = markerIds as number[]
      }
      parsed.push({
        lab_test_ids: stringList(set.lab_test_ids, ["body", "order_sets", index, "lab_test_ids"]),
        marker_ids: ids,
        provider_ids: stringList(addOn.provider_ids, [
          "body",
          "order_sets",
          index,
          "add_on",
          "provider_ids",
        ]),
      })
    })
  }
  if (errors.length > 0) throw new HttpError(422, { detail: errors })
  return parsed
}

const sumPricing = (parts: readonly MarkerPricing[]): MarkerPricing => {
  let base = 0
  const modifiers: Record<string, unknown>[] = []
  for (const part of parts) {
    if ("unspecified" in part) return part
    base += part.base_amount_minor
    modifiers.push(...(part.modifiers ?? []))
  }
  return modifiers.length > 0 ? { base_amount_minor: base, modifiers } : { base_amount_minor: base }
}

export const markerHandlers = (state: JunctionState) => ({
  get_markers_v3_lab_tests_markers_get: async (context: OperationContext) => {
    const query = markerQuery(context.url.searchParams)
    const labs = state.listLabs()
    const labIdOfSlug = (slug: string): number | undefined => {
      const lab = labs.find((entry) => entry.slug === slug)
      return typeof lab?.id === "number" ? lab.id : undefined
    }
    // `lab_slug` wins over `lab_id`; a known lab account narrows to its lab.
    let wanted: readonly number[] | null = query.labIds.length > 0 ? query.labIds : null
    if (query.labSlug !== null) wanted = [labIdOfSlug(query.labSlug) ?? Number.NaN]
    const account =
      query.labAccountId === null
        ? undefined
        : state.listLabAccounts().find((entry) => entry.id === query.labAccountId)
    const accountLab = account ? labIdOfSlug(account.lab) : undefined
    const picked = [...offeredMarkers(state).entries()].filter(([, { marker }]) => {
      if (marker.is_orderable === false) return false
      const labId = marker.lab_id as number | null
      if (wanted !== null && (labId === null || !wanted.includes(labId))) return false
      if (account && labId !== accountLab) return false
      if (query.aLaCarte !== null && (marker.a_la_carte_enabled === true) !== query.aLaCarte)
        return false
      if (query.name !== "") {
        const named = String(marker.name).toLowerCase().includes(query.name)
        const coded = String(marker.provider_id ?? "").toLowerCase() === query.name
        if (!named && !coded) return false
      }
      return true
    })
    const page = paginateMarkers(
      context.query,
      picked.map(([, { marker }]) => marker),
    )
    if (!query.includePricing) return jsonRes(200, page)
    const start = (page.page - 1) * page.size
    const data: Record<string, MarkerPricing> = {}
    for (const [id] of picked.slice(start, start + page.size)) {
      const entry = picked.find(([each]) => each === id)
      if (entry) data[String(id)] = entry[1].pricing
    }
    return jsonRes(200, { ...page, pricing: { currency: "USD", data } })
  },

  estimate_order_set_pricing_v3_lab_test_estimate_order_set_pricing_post: async (
    context: OperationContext,
  ) => {
    const body = jsonBody(context)
    const sets = orderSetInputs(body)
    const offered = offeredMarkers(state)
    const data = sets.map((set) => {
      if (
        set.lab_test_ids.length === 0 &&
        set.marker_ids.length === 0 &&
        set.provider_ids.length === 0
      )
        throw new HttpError(400, {
          detail: "No markers found for the supplied lab tests. Please check the lab test ids",
        })
      const parts: MarkerPricing[] = []
      for (const id of set.lab_test_ids) {
        const test = state.labTestById(id)
        if (!test) throw new HttpError(400, { detail: "Test does not exist" })
        parts.push({ base_amount_minor: minorOf(test.price) ?? 0 })
      }
      const addOns = new Map<number, MarkerPricing>()
      const find = (matches: (marker: Record<string, unknown>) => boolean) =>
        [...offered.entries()].find(([, entry]) => matches(entry.marker))
      for (const id of set.marker_ids) {
        const found = offered.get(id)
        if (!found) throw new HttpError(400, { detail: `Marker does not exist: ${id}` })
        addOns.set(id, found.pricing)
      }
      for (const providerId of set.provider_ids) {
        const found = find((marker) => marker.provider_id === providerId)
        if (!found) throw new HttpError(400, { detail: `Marker does not exist: ${providerId}` })
        addOns.set(found[0], found[1].pricing)
      }
      parts.push(...addOns.values())
      const pricing = sumPricing(parts)
      return {
        aggregate_pricing: pricing,
        components: [
          {
            id: "lab_charge",
            pricing,
            marker_breakdown:
              addOns.size > 0
                ? Object.fromEntries([...addOns].map(([id, each]) => [String(id), each]))
                : null,
          },
        ],
      }
    })
    return jsonRes(200, { currency: "USD", data })
  },
})

/** A catalog marker as `source_markers` names it on a result line. */
export const sourceMarkerOf = (marker: CatalogMarker) => ({
  marker_id: marker.id,
  name: marker.name,
  slug: marker.slug,
  provider_id: marker.provider_id,
})
