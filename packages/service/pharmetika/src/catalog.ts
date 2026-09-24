/**
 * One medication template as `GET /api/pharmetika/provider_access/profile/medication_templates`
 * returns it. Our live client walks the payload for nodes with `medication_display_name` and a
 * `map_dose_to_product` object (dose label → product identifier) and makes one catalog item
 * per dose.
 */
export type MedicationTemplate = {
  template_identifier: string
  medication_display_name: string
  description: string | null
  /** Dose label → the `product_identifier` orders reference. */
  map_dose_to_product: Record<string, string>
  qty_options: number[]
  default_sigs: string[]
  available_states: string[]
  /**
   * DEA schedule (2–5) of a controlled substance, else 0. The live client never reads it;
   * the mock uses it to answer `controlled` / `control_level` from validate, which routes
   * the order to EPCS prepare instead of submit.
   */
  controlled: number
}

const STATES = [
  "AZ",
  "CA",
  "CO",
  "FL",
  "GA",
  "IL",
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
 * The templates every namespace starts with. No sandbox recording exists (the vendor has no
 * public spec), so the rows are synthesised in the field names the live client parses; pass
 * `templates` to load recorded rows instead. Testosterone is schedule III, so it exercises
 * the EPCS path.
 */
export const DEFAULT_TEMPLATES: readonly MedicationTemplate[] = [
  {
    template_identifier: "tmpl-testosterone-cypionate",
    medication_display_name: "Testosterone Cypionate (Grapeseed Oil) Injectable",
    description: "Sterile solution, multi-dose vial",
    map_dose_to_product: { "200 mg/mL": "PMK-TESTCYP-200" },
    qty_options: [5, 10],
    default_sigs: ["Inject 0.5 mL intramuscularly once weekly"],
    available_states: STATES,
    controlled: 3,
  },
  {
    template_identifier: "tmpl-sermorelin",
    medication_display_name: "Sermorelin Acetate Injectable",
    description: "Lyophilized powder for reconstitution, vial",
    map_dose_to_product: { "9 mg": "PMK-SERM-9", "15 mg": "PMK-SERM-15" },
    qty_options: [1, 2],
    default_sigs: ["Inject 300 mcg subcutaneously nightly"],
    available_states: STATES,
    controlled: 0,
  },
  {
    template_identifier: "tmpl-enclomiphene",
    medication_display_name: "Enclomiphene Citrate Capsule",
    description: "Oral capsule",
    map_dose_to_product: { "12.5 mg": "PMK-ENCLO-12", "25 mg": "PMK-ENCLO-25" },
    qty_options: [30, 90],
    default_sigs: ["Take 1 capsule by mouth daily"],
    available_states: STATES,
    controlled: 0,
  },
  {
    template_identifier: "tmpl-oxytocin-troche",
    medication_display_name: "Oxytocin Troche",
    description: "Sublingual troche",
    map_dose_to_product: { "100 IU": "PMK-OXY-100" },
    qty_options: [30],
    default_sigs: ["Dissolve 1 troche under the tongue as needed"],
    available_states: ["AZ", "TX", "FL"],
    controlled: 0,
  },
]

/** The clinics `clinic/clinic_list` returns before any are configured. */
export type Clinic = { identifier: string; data: { name: string } }

export const DEFAULT_CLINICS: readonly Clinic[] = [
  { identifier: "clinic-acme-0001", data: { name: "Acme" } },
  { identifier: "clinic-acme-west-0002", data: { name: "Acme West" } },
]
