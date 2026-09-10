import { Collection, IdSequence, opaqueToken } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import {
  EXPECTED_RESULTS,
  type ExpectedResult,
  type LabTestRecord,
  LAB_TEST_CATALOG,
  TEAM_LABS,
} from "./catalog.js"

export type { CatalogMarker, ExpectedResult, LabTestRecord } from "./catalog.js"
export { expectedResultsFor, LAB_TEST_CATALOG, labTestById, TEAM_LABS } from "./catalog.js"

export type GetCacheEntry = {
  status: number
  headers: Record<string, string>
  body: unknown
}

const sortedQueryString = (params: URLSearchParams): string => {
  const entries = [...params.entries()].sort(([left], [right]) => left.localeCompare(right))
  return new URLSearchParams(entries).toString()
}

export const observationCacheKey = (
  url: URL | string,
  method = "GET",
  body?: unknown,
): string => {
  const parsed = typeof url === "string" ? new URL(url, "https://observation.local") : url
  const query = sortedQueryString(parsed.searchParams)
  const pathAndQuery = `${parsed.pathname}${query ? `?${query}` : ""}`
  const head = `${method.toUpperCase()} ${pathAndQuery}`
  if (body === undefined) return head
  return `${head} ${JSON.stringify(body)}`
}

export type UserInfoRecord = Record<string, unknown>

export type AppointmentModality = "phlebotomy" | "patient_service_center"
export type AppointmentProviderName = "getlabs" | "phlebfinders" | "quest"
export type AppointmentStatus =
  | "confirmed"
  | "pending"
  | "reserved"
  | "in_progress"
  | "completed"
  | "cancelled"
export type AppointmentEventStatus =
  | "pending"
  | "reserved"
  | "scheduled"
  | "completed"
  | "cancelled"
  | "in_progress"

export type AppointmentEventRecord = {
  created_at: string
  status: AppointmentEventStatus
  data: Record<string, unknown> | null
}

export type AppointmentRecord = {
  id: string
  order_id: string
  user_id: string
  provider_id: string
  external_id: string | null
  type: AppointmentModality
  provider: AppointmentProviderName
  status: AppointmentStatus
  event_status: AppointmentEventStatus
  start_at: string | null
  end_at: string | null
  iana_timezone: string | null
  address: Record<string, unknown>
  location: { lng: number; lat: number }
  can_reschedule: boolean
  booking_key: string | null
  site_code: string | null
  appointment_notes: string | null
  order_transaction_id: string | null
  event_data: Record<string, unknown> | null
  events: AppointmentEventRecord[]
  created_at: string
  updated_at: string
}

export type BookingKeyRecord = {
  key: string
  start: string
  end: string
  expires_at: string | null
  price: number
  is_priority: boolean
  num_appointments_available: number
  modality: AppointmentModality
  provider: AppointmentProviderName
  site_code: string | null
  zip_code: string
  address: Record<string, unknown>
  location: { lng: number; lat: number }
  consumed_by_order_id: string | null
  created_at: string
}

export type PendingSimulateTransition = {
  order_id: string
  due_at: number
  final_status: string
  flags: Record<string, unknown> | null
}

export type JunctionWebhookEvent = {
  event_type: "labtest.order.created" | "labtest.order.updated" | "labtest.appointment.updated"
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
  interpretation: string | null
  has_missing_results: boolean | null
  result_types: string[] | null
  expected_result_by_date: string | null
  worst_case_result_by_date: string | null
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

  readonly appointments: Collection<AppointmentRecord>
  readonly appointmentsByOrder: Collection<{ appointment_id: string }>
  readonly bookingKeys: Collection<BookingKeyRecord>
  readonly pendingSimulateTransitions: Collection<PendingSimulateTransition>

  readonly orderByTransaction: Collection<{ order_id: string }>
  readonly webhookEvents: Collection<WebhookEventRecord>
  readonly webhookDeliveryAttempts: Collection<WebhookDeliveryAttempt>

  readonly labTests: Collection<LabTestRecord>
  readonly labs: Collection<Record<string, unknown>>
  readonly expectedResults: Collection<ExpectedResult[]>
  readonly getCache: Collection<GetCacheEntry>

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
    this.appointments = new Collection(sqlite, namespace, "appointments")
    this.appointmentsByOrder = new Collection(sqlite, namespace, "appointments_by_order")
    this.bookingKeys = new Collection(sqlite, namespace, "booking_keys")
    this.pendingSimulateTransitions = new Collection(
      sqlite,
      namespace,
      "pending_simulate_transitions",
    )
    this.orderByTransaction = new Collection(sqlite, namespace, "orders_by_transaction")
    this.webhookEvents = new Collection(sqlite, namespace, "webhook_events")
    this.webhookDeliveryAttempts = new Collection(sqlite, namespace, "webhook_delivery_attempts")
    this.labTests = new Collection(sqlite, namespace, "lab_tests")
    this.labs = new Collection(sqlite, namespace, "labs")
    this.expectedResults = new Collection(sqlite, namespace, "expected_results")
    this.getCache = new Collection(sqlite, namespace, "get_cache")
    this.ids = new IdSequence(sqlite, namespace, "junction")
    this.seedDefaultCatalog()
  }

  seedDefaultCatalog(): void {
    this.replaceCatalog({
      labTests: [...LAB_TEST_CATALOG],
      labs: [...TEAM_LABS],
      expectedResults: Object.fromEntries(
        Object.entries(EXPECTED_RESULTS).map(([id, results]) => [id, [...results]]),
      ),
    })
  }

  private clearCollection<T>(collection: Collection<T>): void {
    for (const entry of collection.list()) collection.delete(entry.id)
  }

  labKeyOf(lab: Record<string, unknown>): string {
    if (lab.id !== undefined && lab.id !== null) return String(lab.id)
    if (typeof lab.slug === "string" && lab.slug.length > 0) return lab.slug
    return opaqueToken(`junction:lab:${JSON.stringify(lab)}`, 16)
  }

  labTestById(id: string): LabTestRecord | undefined {
    return this.labTests.get(id)
  }

  upsertLabTest(test: LabTestRecord, expectedResults?: readonly ExpectedResult[]): void {
    const existing = this.labTests.get(test.id)
    let next = clone(test)
    if (existing) {
      const incomingMarkers = next.markers?.length ?? 0
      const existingMarkers = existing.markers?.length ?? 0
      // Order embeds are often thinner than catalog GETs — keep richer marker/method
      // data so create_order method matching stays aligned with Vital.
      if (incomingMarkers === 0 && existingMarkers > 0) {
        next = { ...next, markers: existing.markers }
      }
      if (
        (typeof next.method !== "string" || next.method.length === 0) &&
        typeof existing.method === "string" &&
        existing.method.length > 0
      ) {
        next = { ...next, method: existing.method }
      }
      if (existing.auto_generated !== true && next.auto_generated === true) {
        next = {
          ...next,
          auto_generated: false,
          method: existing.method,
          name: existing.name,
          slug: existing.slug,
        }
      }
      this.labTests.update(test.id, next)
    } else {
      this.labTests.insert(test.id, next)
    }
    // Never clobber seeded panel expansions (e.g. Lipid → 6 LOINCs) when callers
    // only pass the lab_test envelope from an order payload.
    if (expectedResults === undefined && this.expectedResults.get(test.id)) return
    const fromNested = (next.markers ?? []).flatMap((marker) => {
      const nested = (marker as { expected_results?: unknown }).expected_results
      if (!Array.isArray(nested) || nested.length === 0) return []
      return nested.filter(
        (entry): entry is ExpectedResult =>
          typeof entry === "object" && entry !== null && !Array.isArray(entry),
      )
    })
    const expected =
      expectedResults ??
      (fromNested.length > 0
        ? fromNested
        : (next.markers ?? []).map((marker) => ({
            id: marker.id,
            name: marker.name,
            slug: marker.slug,
            lab_id: marker.lab_id,
            provider_id: marker.provider_id,
            required: true,
            loinc: null,
          })))
    if (this.expectedResults.get(test.id)) this.expectedResults.update(test.id, [...expected])
    else this.expectedResults.insert(test.id, [...expected])
  }

  listLabTests(): LabTestRecord[] {
    return this.labTests.list({ order: "oldest" }).map((entry) => entry.value)
  }

  listLabs(): Record<string, unknown>[] {
    return this.labs.list({ order: "oldest" }).map((entry) => entry.value)
  }

  expectedResultsFor(labTestId: string): ExpectedResult[] {
    return this.expectedResults.get(labTestId) ?? []
  }

  replaceCatalog(input: {
    labTests: readonly LabTestRecord[]
    labs: readonly Record<string, unknown>[]
    expectedResults: Readonly<Record<string, readonly ExpectedResult[]>>
  }): void {
    this.clearCollection(this.labTests)
    this.clearCollection(this.labs)
    this.clearCollection(this.expectedResults)
    for (const test of input.labTests) this.labTests.insert(test.id, clone(test))
    for (const lab of input.labs) this.labs.insert(this.labKeyOf(lab), clone(lab))
    for (const [labTestId, results] of Object.entries(input.expectedResults)) {
      this.expectedResults.insert(labTestId, clone([...results]))
    }
  }

  putGetCache(key: string, entry: GetCacheEntry): void {
    this.getCache.insert(key, clone(entry))
  }

  getGetCache(key: string): GetCacheEntry | undefined {
    const entry = this.getCache.get(key)
    return entry ? clone(entry) : undefined
  }

  installGetCache(entries: Iterable<[string, GetCacheEntry]>): void {
    for (const [key, entry] of entries) this.putGetCache(key, entry)
  }

  /**
   * Materialize booking_key records from a cached availability payload so subsequent
   * book/reschedule calls succeed against observation-seeded mocks.
   */
  hydrateBookingKeysFromAvailability(
    body: unknown,
    nowMs: number,
    zipCode = "00000",
    modalityHint?: AppointmentModality,
  ): void {
    if (typeof body !== "object" || body === null || Array.isArray(body)) return
    const root = body as Record<string, unknown>
    const dayBuckets: unknown[] = []
    if (Array.isArray(root.days)) dayBuckets.push(...root.days)
    if (Array.isArray(root.slots)) dayBuckets.push(...root.slots)
    const slotEntries: unknown[] = []
    for (const day of dayBuckets) {
      if (typeof day !== "object" || day === null || Array.isArray(day)) {
        slotEntries.push(day)
        continue
      }
      const daySlots = (day as Record<string, unknown>).slots
      if (Array.isArray(daySlots)) slotEntries.push(...daySlots)
      else if (typeof (day as Record<string, unknown>).booking_key === "string") {
        slotEntries.push(day)
      }
    }
    const zip = /^\d{5}/.test(zipCode) ? zipCode.slice(0, 5) : "00000"
    const zipPrefix = Number(zip.slice(0, 3))
    const cityState =
      zipPrefix >= 850 && zipPrefix <= 865
        ? { city: "Phoenix", state: "AZ" }
        : zipPrefix >= 900
          ? { city: "Los Angeles", state: "CA" }
          : zipPrefix >= 800
            ? { city: "Denver", state: "CO" }
            : zipPrefix >= 600
              ? { city: "Chicago", state: "IL" }
              : zipPrefix >= 300 && zipPrefix < 400
                ? { city: "Atlanta", state: "GA" }
                : { city: "New York", state: "NY" }
    const location =
      zip === "85004"
        ? { lat: 33.6242904, lng: -111.9283407 }
        : {
            lat: 30 + (zipPrefix % 20) * 0.4,
            lng: -120 + (zipPrefix % 30) * 0.5,
          }
    for (const entry of slotEntries) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue
      const slot = entry as Record<string, unknown>
      const bookingKey = typeof slot.booking_key === "string" ? slot.booking_key : ""
      if (bookingKey === "" || this.bookingKeys.get(bookingKey)) continue
      const start = typeof slot.start === "string" ? slot.start : new Date(nowMs).toISOString()
      const end =
        typeof slot.end === "string" ? slot.end : new Date(nowMs + 45 * 60_000).toISOString()
      const modality: AppointmentModality =
        modalityHint ??
        (typeof slot.site_code === "string" && slot.site_code.length > 0
          ? "patient_service_center"
          : "phlebotomy")
      this.bookingKeys.insert(bookingKey, {
        key: bookingKey,
        start,
        end,
        expires_at: typeof slot.expires_at === "string" ? slot.expires_at : null,
        price: typeof slot.price === "number" ? slot.price : 0,
        is_priority: slot.is_priority === true,
        num_appointments_available:
          typeof slot.num_appointments_available === "number"
            ? slot.num_appointments_available
            : 1,
        modality,
        provider: modality === "patient_service_center" ? "quest" : "getlabs",
        site_code: typeof slot.site_code === "string" ? slot.site_code : null,
        zip_code: zip,
        address: {
          first_line: "1 Main St",
          second_line: "",
          city: cityState.city,
          state: cityState.state,
          zip_code: zip,
          unit: null,
          access_notes: null,
        },
        location,
        consumed_by_order_id: null,
        created_at: new Date(nowMs).toISOString(),
      })
    }
  }

  cacheKeyForRequest(
    method: string,
    pathname: string,
    searchParams?: URLSearchParams | string | Record<string, string> | null,
    body?: unknown,
  ): string {
    const params = new URLSearchParams()
    if (searchParams instanceof URLSearchParams) {
      for (const [key, value] of searchParams.entries()) params.append(key, value)
    } else if (typeof searchParams === "string") {
      const raw = searchParams.startsWith("?") ? searchParams.slice(1) : searchParams
      for (const [key, value] of new URLSearchParams(raw).entries()) params.append(key, value)
    } else if (searchParams && typeof searchParams === "object") {
      for (const [key, value] of Object.entries(searchParams)) params.append(key, value)
    }
    const query = sortedQueryString(params)
    const url = `https://observation.local${pathname}${query ? `?${query}` : ""}`
    return observationCacheKey(url, method, body)
  }

  insertUser(user: UserRecord): void {
    this.users.insert(user.user_id, clone(user))
    this.byClientId.insert(user.client_user_id, { user_id: user.user_id })
  }

  insertOrder(order: OrderRecord): void {
    this.orders.insert(order.id, clone(order))
    const transactionId = order.order_transaction?.id
    if (typeof transactionId === "string" && transactionId.length > 0) {
      this.orderByTransaction.insert(transactionId, { order_id: order.id })
    }
  }

  insertAppointment(appointment: AppointmentRecord): void {
    this.appointments.insert(appointment.id, clone(appointment))
    this.appointmentsByOrder.insert(appointment.order_id, { appointment_id: appointment.id })
  }

  nextUserId(): string {
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const token = this.ids.next("usr_")
      const id = deterministicUuid(`junction:user:${token}`)
      if (!this.users.has(id) && !this.deletedUsers.has(id)) return id
    }
    const token = this.ids.next("usr_")
    return deterministicUuid(`junction:user:post-seed:${token}:${this.users.list().length}`)
  }

  nextOrderId(): string {
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const token = this.ids.next("ord_")
      const id = deterministicUuid(`junction:order:${token}`)
      if (!this.orders.has(id)) return id
    }
    const token = this.ids.next("ord_")
    return deterministicUuid(`junction:order:post-seed:${token}:${this.orders.list().length}`)
  }

  nextAppointmentId(): string {
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const token = this.ids.next("apt_")
      const id = deterministicUuid(`junction:appointment:${token}`)
      if (!this.appointments.has(id)) return id
    }
    const token = this.ids.next("apt_")
    return deterministicUuid(
      `junction:appointment:post-seed:${token}:${this.appointments.list().length}`,
    )
  }

  bookingKeyFor(input: string): string {
    return deterministicUuid(`junction:booking:${input}`)
  }

  appointmentProviderIdFor(input: string): string {
    return opaqueToken(`junction:appointment-provider:${input}`, 12)
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

  publishAppointmentWebhook(
    appointment: AppointmentRecord,
    teamId: string,
    now = Date.now(),
  ): void {
    const user = this.users.get(appointment.user_id)
    if (!user) return
    this.publishWebhook(
      {
        event_type: "labtest.appointment.updated",
        data: appointment as unknown as Record<string, unknown>,
        team_id: teamId,
        user_id: appointment.user_id,
        client_user_id: user.client_user_id,
      },
      now,
    )
  }

  queueSimulateTransition(transition: PendingSimulateTransition): void {
    this.pendingSimulateTransitions.insert(
      `${transition.order_id}:${transition.due_at}`,
      transition,
    )
  }

  /** Apply any simulate transitions whose delay has elapsed; called lazily on reads. */
  applyDueSimulateTransitions(
    nowMs: number,
    apply: (order: OrderRecord, finalStatus: string, flags: Record<string, unknown> | null) => void,
  ): void {
    for (const entry of this.pendingSimulateTransitions.list({ order: "oldest" })) {
      const transition = entry.value
      if (transition.due_at > nowMs) continue
      const order = this.orders.get(transition.order_id)
      if (order) apply(order, transition.final_status, transition.flags)
      this.pendingSimulateTransitions.delete(entry.id)
    }
  }

  isoNow(now: () => number): string {
    return new Date(now()).toISOString().replace(/\.\d{3}Z$/, "+00:00")
  }
}
