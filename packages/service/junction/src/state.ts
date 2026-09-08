import { Collection, IdSequence, opaqueToken } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { LabTestRecord } from "./catalog.js"

export type { CatalogMarker, LabTestRecord } from "./catalog.js"
export { LAB_TEST_CATALOG, labTestById } from "./catalog.js"

export type UserInfoRecord = Record<string, unknown>

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

export type OrderEventRecord = {
  id: number
  created_at: string
  status: string
  status_detail: null
}

export type OrderTransactionEmbed = {
  id: string
  status: "active" | "cancelled"
  orders: Array<{
    id: string
    low_level_status: string
    low_level_status_created_at: string
    origin: string
    parent_id: null
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
  details: Record<string, unknown>
  sample_id: string | null
  notes: null
  clinical_notes: string | null
  passthrough: string | null
  created_at: string
  updated_at: string
  events: OrderEventRecord[]
  status: string
  last_event: OrderEventRecord
  physician: { first_name: string; last_name: string; npi: string }
  health_insurance_id: null
  requisition_form_url: string | null
  shipping_details: null
  has_abn: boolean
  billing_type: string
  priority: boolean
  activate_by: null
  icd_codes: null
  interpretation: null
  has_missing_results: null
  expected_result_by_date: null
  worst_case_result_by_date: null
  origin: string
  order_transaction: OrderTransactionEmbed
}

export class JunctionState {
  readonly users: Collection<UserRecord>
  readonly ids: IdSequence
  readonly byClientId: Collection<{ user_id: string }>
  readonly deletedUsers: Collection<{ user_id: string }>
  readonly userInfo: Collection<UserInfoRecord>
  readonly orders: Collection<OrderRecord>
  readonly orderIdempotency: Collection<{ order_id: string; response: unknown }>
  readonly cancelIdempotency: Collection<{ order_id: string; response: unknown }>

  readonly orderByTransaction: Collection<{ order_id: string }>

  constructor(sqlite: SqliteClient, namespace: string) {
    this.users = new Collection(sqlite, namespace, "users")
    this.byClientId = new Collection(sqlite, namespace, "users_by_client")
    this.deletedUsers = new Collection(sqlite, namespace, "users_deleted")
    this.userInfo = new Collection(sqlite, namespace, "user_info")
    this.orders = new Collection(sqlite, namespace, "orders")
    this.orderIdempotency = new Collection(sqlite, namespace, "orders_idempotency")
    this.cancelIdempotency = new Collection(sqlite, namespace, "cancel_idempotency")
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
