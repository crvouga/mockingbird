/** Lab-test catalog mirrored from the Junction sandbox (`GET /v3/lab_test`). */
export type CatalogMarker = {
  id: number
  name: string
  slug: string
  description: string | null
  lab_id: number | null
  provider_id: string | null
  type: string | null
  unit: string | null
  price: string | null
  aoe: unknown
  a_la_carte_enabled: boolean
  common_tat_days: number | null
  worst_case_tat_days: number | null
  is_orderable: boolean | null
}

export type LabTestRecord = {
  id: string
  slug: string
  name: string
  sample_type: string
  method: string
  price: number
  is_active: boolean
  status: string
  fasting: boolean
  lab: Record<string, unknown>
  markers: CatalogMarker[] | null
  is_delegated: boolean
  auto_generated: boolean
  has_collection_instructions: boolean | null
  common_tat_days: number | null
  worst_case_tat_days: number | null
}

export const LAB_TEST_CATALOG: readonly LabTestRecord[] = [
  {
    id: "c533549c-1e62-4afe-9a0e-0567a9b2bcc2",
    slug: "comprehensive_metabolic_panel",
    name: "CMP",
    sample_type: "serum",
    method: "walk_in_test",
    price: 0,
    is_active: true,
    status: "active",
    fasting: false,
    lab: {
      id: 6,
      slug: "labcorp",
      name: "Labcorp",
      first_line_address: "Labcorp",
      city: "San Diego",
      zipcode: "92128",
      collection_methods: ["at_home_phlebotomy", "walk_in_test", "on_site_collection"],
      sample_types: ["serum", "saliva", "urine"],
      logo_url: null,
    },
    markers: [
      {
        id: 2075,
        name: "Comp. Metabolic Panel (14)",
        slug: "comp-metabolic-panel-14",
        description: "Comp. Metabolic Panel (14)",
        lab_id: 6,
        provider_id: "322000",
        type: "biomarker",
        unit: null,
        price: "N/A",
        aoe: {
          questions: [
            {
              id: 1,
              required: false,
              code: "FSTING",
              value: "FASTING",
              type: "choice",
              sequence: 1,
              answers: [
                { id: 1, code: "N", value: "No" },
                { id: 2, code: "Y", value: "Yes" },
              ],
              constraint: null,
              default: null,
            },
          ],
        },
        a_la_carte_enabled: true,
        common_tat_days: 3,
        worst_case_tat_days: 5,
        is_orderable: true,
      },
    ],
    is_delegated: false,
    auto_generated: false,
    has_collection_instructions: false,
    common_tat_days: 3,
    worst_case_tat_days: 5,
  },
  {
    id: "0cb9f34f-c3df-4a13-8ca1-19429a82611b",
    slug: "general_wellness_female_002",
    name: "Female General Wellness",
    sample_type: "dried_blood_spot",
    method: "testkit",
    price: 45,
    is_active: true,
    status: "active",
    fasting: false,
    lab: {
      id: 3,
      slug: "ussl",
      name: "USSL",
      first_line_address: "15150 Avenue of Science, Suite 100",
      city: "San Diego",
      zipcode: "92128",
      collection_methods: ["testkit"],
      sample_types: ["dried_blood_spot"],
      logo_url: null,
    },
    markers: null,
    is_delegated: false,
    auto_generated: false,
    has_collection_instructions: false,
    common_tat_days: null,
    worst_case_tat_days: null,
  },
  {
    id: "b439efda-1e07-4d2c-8afb-51771c7cc0cb",
    slug: "lipid_panel_athome",
    name: "Lipid Panel: At Home",
    sample_type: "serum",
    method: "at_home_phlebotomy",
    price: 0,
    is_active: true,
    status: "active",
    fasting: false,
    lab: {
      id: 6,
      slug: "labcorp",
      name: "Labcorp",
      first_line_address: "Labcorp",
      city: "San Diego",
      zipcode: "92128",
      collection_methods: ["at_home_phlebotomy", "walk_in_test", "on_site_collection"],
      sample_types: ["serum", "saliva", "urine"],
      logo_url: null,
    },
    markers: [
      {
        id: 1975,
        name: "Lipid Panel",
        slug: "lipid-panel",
        description: "Lipid Panel",
        lab_id: 6,
        provider_id: "303756",
        type: "biomarker",
        unit: null,
        price: "N/A",
        aoe: {
          questions: [
            {
              id: 1,
              required: false,
              code: "FSTING",
              value: "FASTING",
              type: "choice",
              sequence: 1,
              answers: [
                { id: 1, code: "N", value: "No" },
                { id: 2, code: "Y", value: "Yes" },
              ],
              constraint: null,
              default: null,
            },
          ],
        },
        a_la_carte_enabled: true,
        common_tat_days: 3,
        worst_case_tat_days: 5,
        is_orderable: true,
      },
    ],
    is_delegated: false,
    auto_generated: false,
    has_collection_instructions: false,
    common_tat_days: 3,
    worst_case_tat_days: 5,
  },
]

export const labTestById = (id: string): LabTestRecord | undefined =>
  LAB_TEST_CATALOG.find((test) => test.id === id)
