import type {
  AppointmentModality,
  AppointmentRecord,
  ExpectedResult,
  GetCacheEntry,
  JunctionState,
  LabTestRecord,
  OrderRecord,
  UserInfoRecord,
  UserRecord,
} from "./state.js"
import { addressFromAvailabilityRequest } from "./scheduling.js"

export type SeedSource = {
  fetch: (request: Request) => Promise<Response>
  baseUrl: string
  headers: Record<string, string>
}

export type SeedObservations = {
  getCache?: ReadonlyMap<string, GetCacheEntry>
}

export type SeedReport = {
  users: number
  orders: number
  appointments: number
  catalogTests: number
  labs: number
  cacheEntries: number
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/**
 * Parse the availability POST body embedded in an observation cache key
 * (`"<METHOD> <path>?<query> <JSON body>"`).
 */
const parseAvailabilityRequestBody = (cacheKey: string): Record<string, unknown> | undefined => {
  const jsonStart = cacheKey.indexOf(" {")
  if (jsonStart === -1) return undefined
  try {
    const parsed: unknown = JSON.parse(cacheKey.slice(jsonStart + 1))
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    return undefined
  }
  return undefined
}

/**
 * Vital echoes the availability request address on book/reschedule. Re-stamp every
 * booking-key record hydrated from one availability observation so its address matches
 * the availability request — the oracle's behavior for both modalities.
 */
const alignBookingKeyAddresses = (
  state: JunctionState,
  body: unknown,
  requestBody: Record<string, unknown>,
  zip: string,
  modalityHint?: AppointmentModality,
): void => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return
  const root = body as Record<string, unknown>
  const dayBuckets: unknown[] = []
  if (Array.isArray(root.days)) dayBuckets.push(...root.days)
  if (Array.isArray(root.slots)) dayBuckets.push(...root.slots)
  for (const day of dayBuckets) {
    const slots = Array.isArray((day as Record<string, unknown>)?.slots)
      ? ((day as Record<string, unknown>).slots as unknown[])
      : [day]
    for (const slot of slots) {
      if (typeof slot !== "object" || slot === null || Array.isArray(slot)) continue
      const bookingKey = (slot as Record<string, unknown>).booking_key
      if (typeof bookingKey !== "string" || bookingKey === "") continue
      const record = state.bookingKeys.get(bookingKey)
      if (!record || (modalityHint !== undefined && record.modality !== modalityHint)) continue
      record.address = addressFromAvailabilityRequest(requestBody, zip)
      state.bookingKeys.update(bookingKey, record)
    }
  }
}

const request = async (
  source: SeedSource,
  method: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> => {
  const url = new URL(path, source.baseUrl.endsWith("/") ? source.baseUrl : `${source.baseUrl}/`)
  const headers = new Headers(init.headers)
  for (const [name, value] of Object.entries(source.headers)) headers.set(name, value)
  return source.fetch(new Request(url, { ...init, method, headers }))
}

const readJson = async (response: Response): Promise<unknown> => {
  if (response.status === 204) return null
  const text = await response.text()
  if (text.trim() === "") return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined

const mapUser = (value: unknown): UserRecord | undefined => {
  const record = asRecord(value)
  if (!record) return undefined
  const userId = asString(record.user_id)
  const clientUserId = asString(record.client_user_id)
  if (!userId || !clientUserId) return undefined
  return {
    user_id: userId,
    team_id: asString(record.team_id) ?? "00000000-0000-4000-8000-000000000000",
    client_user_id: clientUserId,
    created_on: asString(record.created_on) ?? new Date(0).toISOString(),
    connected_sources: Array.isArray(record.connected_sources) ? record.connected_sources : [],
    fallback_time_zone:
      typeof record.fallback_time_zone === "object" && record.fallback_time_zone !== null
        ? (record.fallback_time_zone as UserRecord["fallback_time_zone"])
        : null,
    fallback_birth_date:
      typeof record.fallback_birth_date === "object" && record.fallback_birth_date !== null
        ? (record.fallback_birth_date as UserRecord["fallback_birth_date"])
        : null,
    ingestion_start: asString(record.ingestion_start) ?? null,
    ingestion_end: asString(record.ingestion_end) ?? null,
  }
}

const mapLabTest = (value: unknown): LabTestRecord | undefined => {
  const record = asRecord(value)
  if (!record) return undefined
  const id = asString(record.id)
  if (!id) return undefined
  return clone(record) as LabTestRecord
}

const mapOrder = (value: unknown): OrderRecord | undefined => {
  const record = asRecord(value)
  if (!record) return undefined
  const id = asString(record.id)
  const userId = asString(record.user_id)
  if (!id || !userId) return undefined
  return clone(record) as OrderRecord
}

const mapAppointment = (value: unknown, orderId: string, userId: string): AppointmentRecord | undefined => {
  const record = asRecord(value)
  if (!record) return undefined
  const id = asString(record.id)
  if (!id) return undefined
  return {
    ...(clone(record) as AppointmentRecord),
    id,
    order_id: asString(record.order_id) ?? orderId,
    user_id: asString(record.user_id) ?? userId,
  }
}

const demographicsFromOrder = (order: OrderRecord): UserInfoRecord => {
  const details =
    order.patient_details && typeof order.patient_details === "object"
      ? (order.patient_details as Record<string, unknown>)
      : {}
  const address =
    order.patient_address && typeof order.patient_address === "object"
      ? (order.patient_address as Record<string, unknown>)
      : {}
  return {
    first_name: details.first_name ?? null,
    last_name: details.last_name ?? null,
    dob: details.dob ?? null,
    gender: details.gender ?? null,
    phone_number: details.phone_number ?? null,
    email: details.email ?? null,
    gender_identity: null,
    sexual_orientation: null,
    race: null,
    ethnicity: null,
    medical_proxy: null,
    address: {
      first_line: address.first_line ?? "",
      second_line: typeof address.second_line === "string" ? address.second_line : "",
      country: address.country ?? "",
      zip: address.zip ?? "",
      city: address.city ?? "",
      state: address.state ?? "",
      access_notes: null,
    },
  }
}

const ensureUserInfoForOrder = async (
  state: JunctionState,
  source: SeedSource,
  order: OrderRecord,
): Promise<void> => {
  if (state.userInfo.get(order.user_id)) return
  const infoResponse = await request(source, "GET", `/v2/user/${order.user_id}/info/latest`)
  if (infoResponse.ok) {
    const info = asRecord(await readJson(infoResponse))
    if (info) {
      state.userInfo.insert(order.user_id, info as UserInfoRecord)
      return
    }
  }
  state.userInfo.insert(order.user_id, demographicsFromOrder(order))
}

const expectedFromMarkers = (labTest: LabTestRecord): ExpectedResult[] => {
  const markers = labTest.markers ?? []
  return markers.map((marker) => ({
    id: marker.id,
    name: marker.name,
    slug: marker.slug,
    lab_id: marker.lab_id,
    provider_id: marker.provider_id,
    required: true,
    loinc: null,
  }))
}

const expectedFromMarkersResponse = async (
  source: SeedSource,
  test: LabTestRecord,
): Promise<ExpectedResult[]> => {
  const markersResponse = await request(source, "GET", `/v3/lab_tests/${test.id}/markers`)
  if (!markersResponse.ok) return expectedFromMarkers(test)
  const markersPayload = asRecord(await readJson(markersResponse))
  const markers = markersPayload?.markers
  if (!Array.isArray(markers) || markers.length === 0) return expectedFromMarkers(test)
  const expected: ExpectedResult[] = []
  const cleaned: NonNullable<LabTestRecord["markers"]> = []
  for (const entry of markers) {
    const record = asRecord(entry)
    if (!record) continue
    const expectedField = record.expected_results
    if (Array.isArray(expectedField) && expectedField.length > 0 && expected.length === 0) {
      for (const item of expectedField) {
        const expectedRecord = asRecord(item)
        if (expectedRecord) expected.push(clone(expectedRecord) as ExpectedResult)
      }
    }
    const { expected_results: _ignored, ...rest } = record
    cleaned.push(rest as NonNullable<LabTestRecord["markers"]>[number])
  }
  test.markers = cleaned
  return expected.length > 0 ? expected : expectedFromMarkers(test)
}

export const ensureLabTests = async (
  state: JunctionState,
  source: SeedSource,
  ids: readonly string[],
): Promise<number> => {
  let added = 0
  for (const id of ids) {
    if (!id) continue
    const response = await request(source, "GET", `/v3/lab_tests/${id}`)
    if (!response.ok) continue
    const test = mapLabTest(await readJson(response))
    if (!test) continue
    const expected = await expectedFromMarkersResponse(source, test)
    const existed = Boolean(state.labTestById(id))
    state.upsertLabTest(test, expected)
    if (!existed) added += 1
  }
  return added
}

/**
 * Pull any warmup-registered orders that user-list seeding missed (e.g. orders whose
 * user was deleted during warmup and therefore no longer appears in `/v2/user`).
 */
export const ensureOrders = async (
  state: JunctionState,
  source: SeedSource,
  ids: readonly string[],
): Promise<number> => {
  let added = 0
  for (const id of ids) {
    if (!id) continue
    const orderResponse = await request(source, "GET", `/v3/order/${id}`)
    if (!orderResponse.ok) continue
    const order = mapOrder(await readJson(orderResponse))
    if (!order) continue
    if (!state.users.has(order.user_id) && !state.deletedUsers.has(order.user_id)) {
      const userResponse = await request(source, "GET", `/v2/user/${order.user_id}`)
      if (userResponse.ok) {
        const user = mapUser(await readJson(userResponse))
        if (user) state.insertUser(user)
      } else {
        state.deletedUsers.insert(order.user_id, { user_id: order.user_id })
      }
    }
    const existed = Boolean(state.orders.get(id))
    if (existed) state.orders.update(id, order)
    else state.insertOrder(order)
    if (order.lab_test?.id) state.upsertLabTest(order.lab_test)
    await ensureUserInfoForOrder(state, source, order)
    if (!existed) added += 1
  }
  return added
}

export const seedFrom = async (
  state: JunctionState,
  source: SeedSource,
  observations?: SeedObservations,
): Promise<SeedReport> => {
  let cacheEntries = 0
  if (observations?.getCache) {
    state.installGetCache(observations.getCache)
    cacheEntries = observations.getCache.size
    const nowMs = Date.now()
    for (const [key, entry] of observations.getCache) {
      if (!key.toLowerCase().includes("availability")) continue
      const zipMatch = key.match(/"zip_code":"(\d{5})"/)
      const modality = key.toLowerCase().includes("psc")
        ? ("patient_service_center" as const)
        : key.toLowerCase().includes("phlebotomy")
          ? ("phlebotomy" as const)
          : undefined
      const zip = zipMatch?.[1] ?? "85004"
      state.hydrateBookingKeysFromAvailability(entry.body, nowMs, zip, modality)
      // Vital echoes the availability request address on book/reschedule. Align the
      // freshly hydrated oracle-key records with the request address embedded in the
      // observation cache key so book/reschedule render the same address as the
      // oracle instead of the hydrate placeholder.
      const requestBody = parseAvailabilityRequestBody(key)
      if (requestBody) alignBookingKeyAddresses(state, entry.body, requestBody, zip, modality)
    }
  }

  const labTests: LabTestRecord[] = []
  let cursor: string | null = null
  for (;;) {
    const path =
      cursor === null
        ? "/v3/lab_test"
        : `/v3/lab_test?next_cursor=${encodeURIComponent(cursor)}`
    const response = await request(source, "GET", path)
    if (!response.ok) break
    const payload = asRecord(await readJson(response))
    const data = payload?.data
    if (Array.isArray(data)) {
      for (const entry of data) {
        const test = mapLabTest(entry)
        if (test) labTests.push(test)
      }
    }
    cursor = asString(payload?.next_cursor) ?? null
    if (cursor === null) break
  }

  const labsResponse = await request(source, "GET", "/v3/lab_tests/labs")
  const labsPayload = labsResponse.ok ? await readJson(labsResponse) : []
  const labs = Array.isArray(labsPayload)
    ? labsPayload.filter(
        (entry): entry is Record<string, unknown> =>
          typeof entry === "object" && entry !== null && !Array.isArray(entry),
      )
    : []

  const expectedResults: Record<string, ExpectedResult[]> = {}
  for (const test of labTests) {
    expectedResults[test.id] = await expectedFromMarkersResponse(source, test)
  }

  if (labTests.length > 0 || labs.length > 0) {
    const currentTests = state.listLabTests()
    const currentLabs = state.listLabs()
    const currentExpected = Object.fromEntries(
      currentTests.map((test) => [test.id, state.expectedResultsFor(test.id)]),
    )
    state.replaceCatalog({
      labTests: labTests.length > 0 ? labTests : currentTests,
      labs: labs.length > 0 ? labs : currentLabs,
      expectedResults:
        Object.keys(expectedResults).length > 0 ? expectedResults : currentExpected,
    })
  }

  let users = 0
  let orders = 0
  let appointments = 0
  const pendingOrders: Array<{
    order: OrderRecord
    appointments: AppointmentRecord[]
    /** Position in the oracle's newest-first team-wide list — the oracle's own tie order. */
    listPosition?: number
  }> = []
  let offset = 0
  const limit = 100
  for (;;) {
    const listResponse = await request(source, "GET", `/v2/user?offset=${offset}&limit=${limit}`)
    if (!listResponse.ok) break
    const listPayload = asRecord(await readJson(listResponse))
    const listed = Array.isArray(listPayload?.users) ? listPayload.users : []
    if (listed.length === 0) break
    for (const entry of listed) {
      const listedUser = mapUser(entry)
      if (!listedUser) continue
      const detailResponse = await request(source, "GET", `/v2/user/${listedUser.user_id}`)
      const user =
        detailResponse.ok ? (mapUser(await readJson(detailResponse)) ?? listedUser) : listedUser
      state.insertUser(user)
      users += 1

      const infoResponse = await request(
        source,
        "GET",
        `/v2/user/${user.user_id}/info/latest`,
      )
      if (infoResponse.ok) {
        const info = asRecord(await readJson(infoResponse))
        if (info) state.userInfo.insert(user.user_id, info as UserInfoRecord)
      }

      let page = 1
      for (;;) {
        const ordersResponse = await request(
          source,
          "GET",
          `/v3/orders?user_id=${encodeURIComponent(user.user_id)}&page=${page}&size=100`,
        )
        if (!ordersResponse.ok) break
        const ordersPayload = asRecord(await readJson(ordersResponse))
        const orderEntries = Array.isArray(ordersPayload?.orders)
          ? ordersPayload.orders
          : Array.isArray(ordersPayload?.data)
            ? ordersPayload.data
            : []
        if (orderEntries.length === 0) break
        for (const orderEntry of orderEntries) {
          const summary = asRecord(orderEntry)
          const orderId = asString(summary?.id) ?? asString(summary?.order_id)
          if (!orderId) continue
          const orderResponse = await request(source, "GET", `/v3/order/${orderId}`)
          if (!orderResponse.ok) continue
          const order = mapOrder(await readJson(orderResponse))
          if (!order) continue
          const orderAppointments: AppointmentRecord[] = []
          for (const modality of ["phlebotomy", "psc"] as const) {
            const path =
              modality === "phlebotomy"
                ? `/v3/order/${order.id}/phlebotomy/appointment`
                : `/v3/order/${order.id}/psc/appointment`
            const appointmentResponse = await request(source, "GET", path)
            if (!appointmentResponse.ok) continue
            const appointment = mapAppointment(
              await readJson(appointmentResponse),
              order.id,
              order.user_id,
            )
            if (!appointment) continue
            orderAppointments.push(appointment)
          }
          pendingOrders.push({ order, appointments: orderAppointments })
        }
        const total = typeof ordersPayload?.total === "number" ? ordersPayload.total : undefined
        if (total !== undefined && page * 100 >= total) break
        if (orderEntries.length < 100) break
        page += 1
      }
    }
    offset += listed.length
    if (listed.length < limit) break
  }

  // Team-wide order pass: /v2/user can be empty while orphan orders remain
  // (users deleted, orders retained). List payloads are full ClientFacingOrder
  // objects, so we can seed without per-id GETs.
  {
    let page = 1
    for (;;) {
      const ordersResponse = await request(source, "GET", `/v3/orders?page=${page}&size=100`)
      if (!ordersResponse.ok) break
      const ordersPayload = asRecord(await readJson(ordersResponse))
      const orderEntries = Array.isArray(ordersPayload?.orders)
        ? ordersPayload.orders
        : Array.isArray(ordersPayload?.data)
          ? ordersPayload.data
          : []
      if (orderEntries.length === 0) break
      let listPosition = (page - 1) * 100
      for (const orderEntry of orderEntries) {
        const order = mapOrder(orderEntry)
        if (!order) continue
        // Do not resurrect users that are absent from /v2/user — orphan orders
        // keep their user_id but the team user list must match sandbox membership.
        if (!state.users.has(order.user_id) && !state.deletedUsers.has(order.user_id)) {
          state.deletedUsers.insert(order.user_id, { user_id: order.user_id })
        }
        listPosition += 1
        const existing = pendingOrders.find((pending) => pending.order.id === order.id)
        if (existing) {
          // Team-wide list order is the oracle's own tie order — restamp even for
          // orders first discovered through the per-user pass.
          existing.listPosition = listPosition
          continue
        }
        pendingOrders.push({ order, appointments: [], listPosition })
      }
      const total = typeof ordersPayload?.total === "number" ? ordersPayload.total : undefined
      if (total !== undefined && page * 100 >= total) break
      if (orderEntries.length < 100) break
      page += 1
    }
  }

  // Insert oldest-first so collection seq matches the oracle's list order: primary key
  // is updated_at asc, ties follow the oracle's newest-first list position (reversed),
  // because the sandbox orders same-instant rows by creation order there too.
  pendingOrders.sort((left, right) => {
    const leftAt = Date.parse(String(left.order.updated_at ?? left.order.created_at ?? "")) || 0
    const rightAt = Date.parse(String(right.order.updated_at ?? right.order.created_at ?? "")) || 0
    if (leftAt !== rightAt) return leftAt - rightAt
    if (left.listPosition !== undefined && right.listPosition !== undefined) {
      return right.listPosition - left.listPosition
    }
    // Orders discovered only via per-user detail fetches keep id order as a stable fallback.
    return left.order.id.localeCompare(right.order.id)
  })
  for (const pending of pendingOrders) {
    const labTest = pending.order.lab_test
    if (labTest?.id && (labTest.markers?.length ?? 0) === 0) {
      const expected = await expectedFromMarkersResponse(source, labTest)
      pending.order.lab_test = labTest
      if (state.orders.get(pending.order.id)) {
        state.orders.update(pending.order.id, pending.order)
      }
      state.upsertLabTest(labTest, expected)
    }
    if (state.orders.get(pending.order.id)) {
      state.orders.update(pending.order.id, pending.order)
      if (pending.order.lab_test?.id) state.upsertLabTest(pending.order.lab_test)
      continue
    }
    state.insertOrder(pending.order)
    if (pending.order.lab_test?.id) state.upsertLabTest(pending.order.lab_test)
    await ensureUserInfoForOrder(state, source, pending.order)
    orders += 1
    for (const appointment of pending.appointments) {
      if (state.appointments.get(appointment.id)) continue
      state.insertAppointment(appointment)
      appointments += 1
    }
  }

  // Refresh panels that still lack markers so create_order matches Vital.
  await ensureLabTests(
    state,
    source,
    state
      .listLabTests()
      .filter((test) => (test.markers?.length ?? 0) === 0)
      .map((test) => test.id),
  )

  return {
    users,
    orders,
    appointments,
    catalogTests: state.listLabTests().length,
    labs: state.listLabs().length,
    cacheEntries,
  }
}
