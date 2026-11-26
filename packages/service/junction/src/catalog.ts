/** Lab-test rows returned by Junction. */
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

/** Vendor lab slugs and modality IDs used by the synthetic order and scheduling fixtures. */
function exampleLab(id: number, slug: string, name: string, kitOnly = false) {
  return {id, slug, name, first_line_address: "1 Example Street", city: "Example City", zipcode: "00000",
    collection_methods: kitOnly ? ["testkit"] : ["at_home_phlebotomy", "walk_in_test", "on_site_collection"],
    sample_types: kitOnly ? ["dried_blood_spot"] : ["serum"], logo_url: null}
}

const labcorp = exampleLab(6, "labcorp", "Labcorp")
const ussl = exampleLab(3, "ussl", "USSL", true)
export const TEAM_LABS: readonly Record<string, unknown>[] = [
  labcorp, ussl, exampleLab(4,"quest","Quest"), exampleLab(13,"bioreference","BioReference"), exampleLab(25,"sonora_quest","Sonora Quest"),
  exampleLab(22,"nexus","Nexus"), exampleLab(27,"mtl","MTL"), exampleLab(26,"crl","CRL"), exampleLab(21,"ihd","IHD")
]

function exampleMarker(id: number, name: string, slug: string): CatalogMarker {
  return {id, name, slug, description: name, lab_id: 6, provider_id: `DEMO-${id}`, type:"biomarker", unit:null, price:"N/A",
    aoe:{questions:[{id:1, required:false, code:"FASTING",value:"Fasting?",type:"choice",sequence:1,answers:[{id:1,code:"N",value:"No"},{id:2,code:"Y",value:"Yes"}],constraint:null,default:null}]},
    a_la_carte_enabled:true,common_tat_days:3,worst_case_tat_days:5,is_orderable:true}
}

function exampleTest(id: string, slug: string, name: string, method: string, marker?: CatalogMarker): LabTestRecord {
  return {id,slug,name,method,sample_type:marker ? "serum" : "dried_blood_spot",price:10,
    is_active:true,status:"active",fasting:false,lab:marker ? labcorp : ussl,markers:marker ? [marker] : null,
    is_delegated:false,auto_generated:false,has_collection_instructions:false,common_tat_days:3,worst_case_tat_days:5}
}

export const LAB_TEST_CATALOG: readonly LabTestRecord[] = [
  exampleTest("10000000-0000-4000-8000-000000000001","example_walk_in","Example walk-in panel","walk_in_test",exampleMarker(7001,"Example serum marker","example-serum")),
  exampleTest("10000000-0000-4000-8000-000000000002","example_home_kit","Example home kit","testkit"),
  exampleTest("10000000-0000-4000-8000-000000000003","example_at_home","Example at-home panel","at_home_phlebotomy",exampleMarker(7002,"Example lipid marker","example-lipid")),
]

export const labTestById = (id: string) => LAB_TEST_CATALOG.find(test => test.id === id)

function exampleResult(id: number, name: string): ExpectedResult {
  return {id, name, slug: `example-result-${id}`,lab_id:6,provider_id:`DEMO-R${id}`,required:true,loinc:null}
}
export const EXPECTED_RESULTS: Readonly<Record<string, readonly ExpectedResult[]>> = {
  "10000000-0000-4000-8000-000000000001":[exampleResult(7011,"Example serum result")],
  "10000000-0000-4000-8000-000000000003":[exampleResult(7012,"Example lipid result")]
}
export const expectedResultsFor = (labTestId: string): readonly ExpectedResult[] => EXPECTED_RESULTS[labTestId] ?? []
