import { Collection, IdSequence, opaqueToken } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { LabTestRecord } from "./catalog.js"

export type { CatalogMarker, LabTestRecord } from "./catalog.js"
export { LAB_TEST_CATALOG, labTestById } from "./catalog.js"

export type UserInfoRecord = Record<string, unknown>

export type JunctionWebhookEvent = {
  event_type: "labtest.order.created" | "labtest.order.updated"
  data: Record<string, unknown>
  team_id: string
  user_id: string
  client_user_id: string
}

export type WebhookEventRecord = {
  sequence: number
  event: JunctionWebhookEvent
}

export type WebhookDeliveryAttempt = {
  message_id: string
  event: JunctionWebhookEvent
  attempt: number
  scheduled_at: string
  timeout_ms: number
  acknowledged: boolean
}

export const WEBHOOK_RETRY_DELAYS_MS = [
  0, 5_000, 300_000, 1_800_000, 7_200_000, 18_000_000, 36_000_000, 36_000_000,
] as const

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const seededRandom = (seed: number) => {
  let value = seed >>> 0
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0
    return value / 0x1_0000_0000
  }
}

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
  status: "active" | "completed" | "cancelled"
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

export type WebhookPublisher = (event: JunctionWebhookEvent) => void

export type JunctionWebhookOptions = {
  seed?: number
  jitterRatio?: number
  timeoutMs?: number
}

export class JunctionState {
  private readonly publishEvent: WebhookPublisher | undefined
  private readonly webhookRandom: () => number
  private readonly webhookJitterRatio: number
  private readonly webhookTimeoutMs: number
  readonly users: Collection<UserRecord>
  readonly ids: IdSequence
  readonly byClientId: Collection<{ user_id: string }>
  readonly deletedUsers: Collection<{ user_id: string }>
  readonly userInfo: Collection<UserInfoRecord>
  readonly orders: Collection<OrderRecord>
  readonly orderIdempotency: Collection<{
    order_id: string
    response: unknown
    fingerprint: string
  }>
  readonly cancelIdempotency: Collection<{ order_id: string; response: unknown }>

  readonly orderByTransaction: Collection<{ order_id: string }>
  readonly webhookEvents: Collection<WebhookEventRecord>
  readonly webhookDeliveryAttempts: Collection<WebhookDeliveryAttempt>

  constructor(
    sqlite: SqliteClient,
    namespace: string,
    publisher?: WebhookPublisher,
    webhookOptions: JunctionWebhookOptions = {},
  ) {
    this.publishEvent = publisher
    this.webhookRandom = seededRandom(webhookOptions.seed ?? 0x4a554e43)
    this.webhookJitterRatio = Math.max(0, Math.min(webhookOptions.jitterRatio ?? 0.1, 1))
    this.webhookTimeoutMs = Math.max(1, webhookOptions.timeoutMs ?? 15_000)
    this.users = new Collection(sqlite, namespace, "users")
    this.byClientId = new Collection(sqlite, namespace, "users_by_client")
    this.deletedUsers = new Collection(sqlite, namespace, "users_deleted")
    this.userInfo = new Collection(sqlite, namespace, "user_info")
    this.orders = new Collection(sqlite, namespace, "orders")
    this.orderIdempotency = new Collection(sqlite, namespace, "orders_idempotency")
    this.cancelIdempotency = new Collection(sqlite, namespace, "cancel_idempotency")
    this.orderByTransaction = new Collection(sqlite, namespace, "orders_by_transaction")
    this.webhookEvents = new Collection(sqlite, namespace, "webhook_events")
    this.webhookDeliveryAttempts = new Collection(sqlite, namespace, "webhook_delivery_attempts")
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

  publishWebhook(event: JunctionWebhookEvent, now = Date.now()): void {
    const sequence = this.webhookEvents.nextSequence()
    const snapshot = clone(event)
    this.webhookEvents.insert(String(sequence), { sequence, event: snapshot })
    const messageId = deterministicUuid(`junction:webhook:${sequence}`)
    for (const [index, delay] of WEBHOOK_RETRY_DELAYS_MS.entries()) {
      const jitter =
        delay === 0 ? 0 : delay * this.webhookJitterRatio * (this.webhookRandom() * 2 - 1)
      const scheduledAt = new Date(now + Math.max(0, Math.round(delay + jitter))).toISOString()
      this.webhookDeliveryAttempts.insert(`${messageId}:${index + 1}`, {
        message_id: messageId,
        event: clone(snapshot),
        attempt: index + 1,
        scheduled_at: scheduledAt,
        timeout_ms: this.webhookTimeoutMs,
        acknowledged: index === 0,
      })
    }
    this.publishEvent?.(snapshot)
  }

  webhookEventsInOrder(): JunctionWebhookEvent[] {
    return this.webhookEvents.list({ order: "oldest" }).map((entry) => clone(entry.value.event))
  }

  webhookDeliveryAttemptsInOrder(): WebhookDeliveryAttempt[] {
    return this.webhookDeliveryAttempts.list({ order: "oldest" }).map((entry) => clone(entry.value))
  }

  publishOrderWebhook(
    order: OrderRecord,
    eventType: JunctionWebhookEvent["event_type"],
    now = Date.now(),
  ): void {
    const user = this.users.get(order.user_id)
    if (!user) return
    this.publishWebhook(
      {
        event_type: eventType,
        data: order as unknown as Record<string, unknown>,
        team_id: order.team_id,
        user_id: order.user_id,
        client_user_id: user.client_user_id,
      },
      now,
    )
  }

  isoNow(now: () => number): string {
    return new Date(now()).toISOString().replace(/\.\d{3}Z$/, "+00:00")
  }
}
