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

export type ExpectedResultLoinc = {
  id: number
  name: string
  slug: string
  code: string
  unit: string | null
}

export type ExpectedResult = {
  id: number
  name: string
  slug: string
  lab_id: number | null
  provider_id: string | null
  required: boolean
  loinc: ExpectedResultLoinc | null
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

/** Panel constituents mirrored from the sandbox (`GET /v3/lab_tests/{id}/markers`). */
export const EXPECTED_RESULTS: Readonly<Record<string, readonly ExpectedResult[]>> = {
  "b439efda-1e07-4d2c-8afb-51771c7cc0cb": [
    {
      id: 1109,
      name: "Cholesterol, Total",
      slug: "cholesterol-total",
      lab_id: 6,
      provider_id: "001065",
      required: true,
      loinc: {
        id: 11940,
        name: "Cholesterol [Mass/Vol]",
        slug: "cholesterol-mass-vol",
        code: "2093-3",
        unit: "mg/dL",
      },
    },
    {
      id: 1110,
      name: "HDL Cholesterol",
      slug: "hdl-cholesterol",
      lab_id: 6,
      provider_id: "011817",
      required: true,
      loinc: {
        id: 11858,
        name: "Cholesterol in HDL [Mass/Vol]",
        slug: "cholesterol-in-hdl-mass-vol",
        code: "2085-9",
        unit: "mg/dL",
      },
    },
    {
      id: 1112,
      name: "Triglycerides",
      slug: "triglycerides",
      lab_id: 6,
      provider_id: "001172",
      required: true,
      loinc: {
        id: 16384,
        name: "Triglyceride [Mass/Vol]",
        slug: "triglyceride-mass-vol",
        code: "2571-8",
        unit: "mg/dL",
      },
    },
    {
      id: 242764,
      name: "LDL Calc Comment:",
      slug: "ldl-calc-comment",
      lab_id: 6,
      provider_id: "011926",
      required: true,
      loinc: {
        id: 53832,
        name: "Service comment [Interp]",
        slug: "service-comment-interp",
        code: "8251-1",
        unit: null,
      },
    },
    {
      id: 242780,
      name: "VLDL Cholesterol Cal",
      slug: "vldl-cholesterol-cal",
      lab_id: 6,
      provider_id: "011925",
      required: true,
      loinc: {
        id: 5062,
        name: "Cholesterol in VLDL Calc [Mass/Vol]",
        slug: "cholesterol-in-vldl-calc-mass-vol",
        code: "13458-5",
        unit: "mg/dL",
      },
    },
    {
      id: 242790,
      name: "LDL Chol Calc (NIH)",
      slug: "ldl-chol-calc-nih",
      lab_id: 6,
      provider_id: "012065",
      required: true,
      loinc: {
        id: 5060,
        name: "Cholesterol in LDL Calc [Mass/Vol]",
        slug: "cholesterol-in-ldl-calc-mass-vol",
        code: "13457-7",
        unit: "mg/dL",
      },
    },
  ],
  "c533549c-1e62-4afe-9a0e-0567a9b2bcc2": [
    {
      id: 364,
      name: "AST (SGOT)",
      slug: "ast-sgot",
      lab_id: 6,
      provider_id: "001123",
      required: true,
      loinc: {
        id: 10684,
        name: "AST [Catalytic activity/Vol]",
        slug: "ast-catalytic-activity-vol",
        code: "1920-8",
        unit: "U/L",
      },
    },
    {
      id: 471,
      name: "ALT (SGPT)",
      slug: "alt-sgpt",
      lab_id: 6,
      provider_id: "001545",
      required: true,
      loinc: {
        id: 9362,
        name: "ALT [Catalytic activity/Vol]",
        slug: "alt-catalytic-activity-vol",
        code: "1742-6",
        unit: "U/L",
      },
    },
    {
      id: 1045,
      name: "BUN",
      slug: "bun",
      lab_id: 6,
      provider_id: "001040",
      required: true,
      loinc: {
        id: 19958,
        name: "Urea nitrogen [Mass/Vol]",
        slug: "urea-nitrogen-mass-vol",
        code: "3094-0",
        unit: "mg/dL",
      },
    },
    {
      id: 1050,
      name: "eGFR",
      slug: "egfr",
      lab_id: 6,
      provider_id: "100779",
      required: true,
      loinc: {
        id: 61049,
        name: "GFR/1.73 sq M.predicted Creatinine-based formula (CKD-EPI 2021) (S/P/Bld) [Vol rate/Area]",
        slug: "gfr-1-73-sq-m-predicted-creatinine-based-formula-ckd-epi-2021-s-p-bld-vol-rate-area",
        code: "98979-8",
        unit: "mL/min/{1.73_m2}",
      },
    },
    {
      id: 1051,
      name: "Creatinine",
      slug: "creatinine",
      lab_id: 6,
      provider_id: "001370",
      required: true,
      loinc: {
        id: 12675,
        name: "Creatinine [Mass/Vol]",
        slug: "creatinine-mass-vol",
        code: "2160-0",
        unit: "mg/dL",
      },
    },
    {
      id: 1238,
      name: "Protein, Total",
      slug: "protein-total",
      lab_id: 6,
      provider_id: "001073",
      required: true,
      loinc: {
        id: 18410,
        name: "Protein [Mass/Vol]",
        slug: "protein-mass-vol",
        code: "2885-2",
        unit: "g/dL",
      },
    },
    {
      id: 1266,
      name: "Calcium",
      slug: "calcium",
      lab_id: 6,
      provider_id: "001016",
      required: true,
      loinc: {
        id: 9833,
        name: "Calcium [Mass/Vol]",
        slug: "calcium-mass-vol",
        code: "17861-6",
        unit: "mg/dL",
      },
    },
    {
      id: 1267,
      name: "BUN/Creatinine Ratio",
      slug: "bun-creatinine-ratio",
      lab_id: 6,
      provider_id: "011577",
      required: true,
      loinc: {
        id: 19962,
        name: "Urea nitrogen/Creatinine [Mass ratio]",
        slug: "urea-nitrogen-creatinine-mass-ratio",
        code: "3097-3",
        unit: "mg/mg{creat}",
      },
    },
    {
      id: 1268,
      name: "Carbon Dioxide, Total",
      slug: "carbon-dioxide-total",
      lab_id: 6,
      provider_id: "001578",
      required: true,
      loinc: {
        id: 11320,
        name: "CO2 [Moles/Vol]",
        slug: "co2-moles-vol",
        code: "2028-9",
        unit: "mmol/L",
      },
    },
    {
      id: 1269,
      name: "Glucose",
      slug: "glucose",
      lab_id: 6,
      provider_id: "001032",
      required: true,
      loinc: {
        id: 14491,
        name: "Glucose [Mass/Vol]",
        slug: "glucose-mass-vol",
        code: "2345-7",
        unit: "mg/dL",
      },
    },
    {
      id: 1270,
      name: "Potassium",
      slug: "potassium",
      lab_id: 6,
      provider_id: "001180",
      required: true,
      loinc: {
        id: 18272,
        name: "Potassium [Moles/Vol]",
        slug: "potassium-moles-vol",
        code: "2823-3",
        unit: "mmol/L",
      },
    },
    {
      id: 1271,
      name: "Sodium",
      slug: "sodium",
      lab_id: 6,
      provider_id: "001198",
      required: true,
      loinc: {
        id: 18724,
        name: "Sodium [Moles/Vol]",
        slug: "sodium-moles-vol",
        code: "2951-2",
        unit: "mmol/L",
      },
    },
    {
      id: 1272,
      name: "Chloride",
      slug: "chloride",
      lab_id: 6,
      provider_id: "001206",
      required: true,
      loinc: {
        id: 11738,
        name: "Chloride [Moles/Vol]",
        slug: "chloride-moles-vol",
        code: "2075-0",
        unit: "mmol/L",
      },
    },
    {
      id: 1370,
      name: "Bilirubin, Total",
      slug: "bilirubin-total",
      lab_id: 6,
      provider_id: "001099",
      required: true,
      loinc: {
        id: 11239,
        name: "Bilirubin [Mass/Vol]",
        slug: "bilirubin-mass-vol",
        code: "1975-2",
        unit: "mg/dL",
      },
    },
    {
      id: 1956,
      name: "Albumin",
      slug: "albumin",
      lab_id: 6,
      provider_id: "001081",
      required: true,
      loinc: {
        id: 9462,
        name: "Albumin [Mass/Vol]",
        slug: "albumin-mass-vol",
        code: "1751-7",
        unit: "g/dL",
      },
    },
    {
      id: 2304,
      name: "Globulin, Total",
      slug: "globulin-total",
      lab_id: 6,
      provider_id: "012039",
      required: true,
      loinc: {
        id: 2951,
        name: "Globulin Calc (S) [Mass/Vol]",
        slug: "globulin-calc-s-mass-vol",
        code: "10834-0",
        unit: "g/L",
      },
    },
    {
      id: 13,
      name: "Alkaline Phosphatase",
      slug: "alkaline-phosphatase",
      lab_id: 6,
      provider_id: "001107",
      required: true,
      loinc: {
        id: 45530,
        name: "ALP [Catalytic activity/Vol]",
        slug: "alp-catalytic-activity-vol",
        code: "6768-6",
        unit: "U/L",
      },
    },
  ],
}

export const expectedResultsFor = (labTestId: string): readonly ExpectedResult[] =>
  EXPECTED_RESULTS[labTestId] ?? []
