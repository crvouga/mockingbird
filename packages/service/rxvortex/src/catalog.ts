/** One preset catalog row, in the field names `GET /api/v1/preset-catalog-items` uses. */
export type CatalogItem = {
  catalog_id: string
  medication_name: string
  medication_strength: string | null
  package_size: string | null
  quantity: number | null
  quantity_units: string | null
  medication_form: string | null
  route: string | null
  states: string[]
  status: "active" | "inactive"
}

/** The custom-cream anchor preset id our sandbox env points at (`ERX_CUSTOM_CREAM_ANCHOR_PRESET_ID`). */
export const CUSTOM_CREAM_ANCHOR_PRESET_ID = "e404ad76-0f82-4b04-8f25-841650e2e819"

const ALL_STATES = [
  "AZ",
  "CA",
  "CO",
  "FL",
  "GA",
  "IL",
  "MA",
  "NC",
  "NJ",
  "NV",
  "NY",
  "OH",
  "PA",
  "TX",
  "UT",
  "VA",
  "WA",
]

/**
 * The catalog every namespace starts with when no recorded corpus is loaded. Synthesised in
 * the shapes the live client parses (no sandbox recording exists yet: `corpus pull` replaces
 * it with the real rows); the custom-cream anchor preset must always resolve.
 */
export const DEFAULT_CATALOG: readonly CatalogItem[] = [
  {
    catalog_id: CUSTOM_CREAM_ANCHOR_PRESET_ID,
    medication_name: "CUSTOM",
    medication_strength: null,
    package_size: "30 grams",
    quantity: 30,
    quantity_units: "grams",
    medication_form: "Cream",
    route: "Topical",
    states: ALL_STATES,
    status: "active",
  },
  {
    catalog_id: "1c0b7f7e-3c5f-4d57-9d0a-0d8f1d3a2b10",
    medication_name: "Testosterone Cypionate",
    medication_strength: "200 mg/mL",
    package_size: "10 mL vial",
    quantity: 10,
    quantity_units: "mL",
    medication_form: "Injectable",
    route: "Intramuscular",
    states: ALL_STATES,
    status: "active",
  },
  {
    catalog_id: "5d2e9a41-8b7c-4f0e-a1d3-6c5b4a392817",
    medication_name: "Sermorelin Acetate",
    medication_strength: "9 mg",
    package_size: "1 vial",
    quantity: 1,
    quantity_units: "each",
    medication_form: "Lyophilized powder",
    route: "Subcutaneous",
    states: ALL_STATES,
    status: "active",
  },
  {
    catalog_id: "9f3a6b2c-1d4e-4a5b-8c7d-0e1f2a3b4c5d",
    medication_name: "Enclomiphene Citrate",
    medication_strength: "25 mg",
    package_size: "30 capsules",
    quantity: 30,
    quantity_units: "each",
    medication_form: "Capsule",
    route: "Oral",
    states: ALL_STATES,
    status: "active",
  },
  {
    catalog_id: "0a1b2c3d-4e5f-4a6b-9c8d-7e6f5a4b3c2d",
    medication_name: "Anastrozole",
    medication_strength: "0.5 mg",
    package_size: "30 capsules",
    quantity: 30,
    quantity_units: "each",
    medication_form: "Capsule",
    route: "Oral",
    states: ALL_STATES,
    status: "inactive",
  },
]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const optionalString = (row: Record<string, unknown>, key: string): string | null => {
  const value = row[key]
  if (value === undefined || value === null) return null
  if (typeof value !== "string") throw new Error(`${key} must be a string or null`)
  return value
}

/**
 * One catalog row from loose input: `catalog_id` and `medication_name` are required; the
 * other fields default to `null`, `states` to `[]` and `status` to `"active"`.
 */
export const parseCatalogItem = (value: unknown): CatalogItem => {
  if (!isRecord(value)) throw new Error("a catalog row must be an object")
  const { catalog_id, medication_name, quantity, states, status } = value
  if (typeof catalog_id !== "string" || catalog_id.length === 0) {
    throw new Error("catalog_id must be a non-empty string")
  }
  if (typeof medication_name !== "string") {
    throw new Error(`${catalog_id}: medication_name must be a string`)
  }
  if (quantity !== undefined && quantity !== null && typeof quantity !== "number") {
    throw new Error(`${catalog_id}: quantity must be a number or null`)
  }
  if (
    states !== undefined &&
    (!Array.isArray(states) || states.some((s) => typeof s !== "string"))
  ) {
    throw new Error(`${catalog_id}: states must be a list of state codes`)
  }
  if (status !== undefined && status !== "active" && status !== "inactive") {
    throw new Error(`${catalog_id}: status must be "active" or "inactive"`)
  }
  try {
    return {
      catalog_id,
      medication_name,
      medication_strength: optionalString(value, "medication_strength"),
      package_size: optionalString(value, "package_size"),
      quantity: typeof quantity === "number" ? quantity : null,
      quantity_units: optionalString(value, "quantity_units"),
      medication_form: optionalString(value, "medication_form"),
      route: optionalString(value, "route"),
      states: (states as string[] | undefined) ?? [],
      status: status ?? "active",
    }
  } catch (error) {
    throw new Error(`${catalog_id}: ${(error as Error).message}`)
  }
}

/**
 * Catalog rows from a JSON value: a bare array, or the `{data: [...]}` envelope
 * `GET /api/v1/preset-catalog-items` answers with (so a recorded response loads as-is).
 * Throws on the first malformed row.
 */
export const parseCatalog = (value: unknown): CatalogItem[] => {
  const rows = Array.isArray(value) ? value : isRecord(value) ? value.data : undefined
  if (!Array.isArray(rows)) throw new Error("a catalog must be an array or {data: [...]}")
  return rows.map(parseCatalogItem)
}
