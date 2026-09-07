import { Collection, IdSequence, opaqueToken } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"

export type UserRecord = {
  user_id: string
  team_id: string
  client_user_id: string
  created_on: string
  connected_sources: unknown[]
  fallback_time_zone: { id: string; source_slug: string; updated_at: string } | null
  fallback_birth_date: { value: string; source_slug: string; updated_at: string } | null
  ingestion_start: string | null
  ingestion_end: string | null
}

/** Fixed mock team id — volatile on the real side, stable in the mock. */
export const MOCK_TEAM_ID = "11111111-1111-4111-8111-111111111111"

/** Deterministic UUID derived from a salt + sequence (version/variant bits fixed). */
export const deterministicUuid = (input: string): string => {
  const raw = opaqueToken(input, 32)
  let hex = ""
  for (let i = 0; i < raw.length && hex.length < 32; i++) {
    hex += (raw.charCodeAt(i) % 16).toString(16)
  }
  hex = hex.padEnd(32, "0").slice(0, 32)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

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
  result: string
  reference_range: string | null
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
  markers: CatalogMarker[]
}

export type OrderEventRecord = {
  id: number
  created_at: string
  status: string
  status_detail: null
}

export type OrderTransactionEmbed = {
  id: string
  status: "active"
  orders: Array<{
    id: string
    created_at: string
    updated_at: string
  }>
}

export type OrderRecord = {
  id: string
  user_id: string
  team_id: string
  patient_details: Record<string, unknown>
  patient_address: Record<string, unknown>
  lab_test: LabTestRecord
  details: {
    type: "testkit"
    data: {
      id: string
      shipment: Record<string, unknown>
      created_at: string
      updated_at: string
    }
  }
  sample_id: string
  notes: null
  clinical_notes: string | null
  passthrough: string | null
  created_at: string
  updated_at: string
  events: OrderEventRecord[]
  status: null
  last_event: OrderEventRecord
  health_insurance_id: null
  requisition_form_url: string
  shipping_details: null
  has_abn: boolean
  order_transaction: OrderTransactionEmbed
}

const marker = (
  id: number,
  name: string,
  slug: string,
  unit: string,
  result: string,
  reference_range: string,
): CatalogMarker => ({
  id,
  name,
  slug,
  description: name,
  lab_id: 1,
  provider_id: null,
  type: "biomarker",
  unit,
  price: null,
  aoe: null,
  a_la_carte_enabled: false,
  common_tat_days: 2,
  worst_case_tat_days: 5,
  is_orderable: true,
  result,
  reference_range,
})

const LAB: Record<string, unknown> = {
  id: 1,
  slug: "mockingbird-lab",
  name: "Mockingbird Central Lab",
  first_line_address: "123 Mockingbird Lane",
  city: "Mockville",
  zipcode: "00000",
  collection_methods: ["testkit"],
  sample_types: ["dried_blood_spot"],
  logo_url: null,
}

const labTest = (
  slug: string,
  name: string,
  price: number,
  markers: CatalogMarker[],
): LabTestRecord => ({
  id: deterministicUuid(`junction:lab_test:${slug}`),
  slug,
  name,
  sample_type: "dried_blood_spot",
  method: "testkit",
  price,
  is_active: true,
  status: "active",
  fasting: false,
  lab: LAB,
  markers,
})

/**
 * Fixed catalog of orderable lab tests. Identical across every independent mock instance, so
 * list/get-lab-test responses agree on both halves of a differential comparison without any
 * handshake. Results are derived purely from marker.slug + order id.
 */
export const LAB_TEST_CATALOG: readonly LabTestRecord[] = [
  labTest("complete-blood-count", "Complete Blood Count (CBC)", 45, [
    marker(1, "White Blood Cell Count", "wbc", "10^9/L", "7.2", "3.8-10.8"),
    marker(2, "Red Blood Cell Count", "rbc", "10^6/uL", "4.92", "4.20-5.80"),
    marker(3, "Hemoglobin", "hemoglobin", "g/dL", "14.8", "13.5-17.5"),
    marker(4, "Hematocrit", "hematocrit", "%", "43.5", "38.5-50.0"),
    marker(5, "Platelet Count", "platelet_count", "10^9/L", "245", "150-400"),
  ]),
  labTest("lipids-panel", "Lipids Panel", 45, [
    marker(6, "Total Cholesterol", "total_cholesterol", "mg/dL", "182", "<200"),
    marker(7, "LDL Cholesterol", "ldl_cholesterol", "mg/dL", "108", "<100"),
    marker(8, "HDL Cholesterol", "hdl_cholesterol", "mg/dL", "52", ">=40"),
    marker(9, "Triglycerides", "triglycerides", "mg/dL", "128", "<150"),
  ]),
  labTest("hemoglobin-a1c", "Hemoglobin A1c", 29, [
    marker(10, "Hemoglobin A1c", "hemoglobin_a1c", "%", "5.4", "4.0-5.6"),
  ]),
]

export const labTestById = (id: string): LabTestRecord | undefined =>
  LAB_TEST_CATALOG.find((test) => test.id === id)

export class JunctionState {
  readonly users: Collection<UserRecord>
  readonly ids: IdSequence
  readonly byClientId: Collection<{ user_id: string }>
  readonly deletedUsers: Collection<{ user_id: string }>
  readonly orders: Collection<OrderRecord>
  readonly orderByTransaction: Collection<{ order_id: string }>

  constructor(sqlite: SqliteClient, namespace: string) {
    this.users = new Collection(sqlite, namespace, "users")
    this.byClientId = new Collection(sqlite, namespace, "users_by_client")
    this.deletedUsers = new Collection(sqlite, namespace, "users_deleted")
    this.orders = new Collection(sqlite, namespace, "orders")
    this.orderByTransaction = new Collection(sqlite, namespace, "orders_by_transaction")
    this.ids = new IdSequence(sqlite, namespace, "junction")
  }

  nextUserId(): string {
    const token = this.ids.next("usr_")
    return deterministicUuid(`junction:user:${token}`)
  }

  nextOrderId(): string {
    const token = this.ids.next("ord_")
    return deterministicUuid(`junction:order:${token}`)
  }

  transactionIdFor(orderId: string): string {
    return deterministicUuid(`junction:transaction:${orderId}`)
  }

  testkitIdFor(orderId: string): string {
    return deterministicUuid(`junction:testkit:${orderId}`)
  }

  isoNow(now: () => number): string {
    return new Date(now()).toISOString().replace(/\.\d{3}Z$/, "+00:00")
  }
}
