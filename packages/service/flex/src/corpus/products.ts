/** [product_id, purpose, merchant product id, eligibility, visit_type, client_reference_id, created_at] */
export type CorpusRow = readonly [string, string, string, string, string | null, string, string]

export const CORPUS_ROWS: readonly CorpusRow[] = [
  ["fprod_00000000000000000000000001", "membership", "prod_demo_membership", "auto_substantiation", "notApplicable", "demo:membership:prod_demo_membership", "2025-01-01T00:00:00.000Z"],
  ["fprod_00000000000000000000000002", "marketplace", "prod_demo_shop", "auto_substantiation", "notApplicable", "demo:marketplace:prod_demo_shop", "2025-01-01T00:00:00.000Z"],
  ["fprod_00000000000000000000000003", "rx", "demo-rx", "prescription", "notApplicable", "demo:rx:demo-rx", "2025-01-01T00:00:00.000Z"],
  ["fprod_00000000000000000000000004", "rx", "demo-consult", "letter_of_medical_necessity", "hairGrowth", "demo:rx:demo-consult", "2025-01-01T00:00:00.000Z"],
  ["fprod_00000000000000000000000005", "membership", "prod_demo_ineligible", "not_eligible", null, "demo:membership:prod_demo_ineligible", "2025-01-01T00:00:00.000Z"],
]
