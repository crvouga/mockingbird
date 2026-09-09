import type {
  AppointmentRecord,
  ExpectedResult,
  GetCacheEntry,
  JunctionState,
  LabTestRecord,
  OrderRecord,
  UserInfoRecord,
  UserRecord,
} from "./state.js"

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

export const seedFrom = async (
  state: JunctionState,
  source: SeedSource,
  observations?: SeedObservations,
): Promise<SeedReport> => {
  let cacheEntries = 0
  if (observations?.getCache) {
    state.installGetCache(observations.getCache)
    cacheEntries = observations.getCache.size
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
    const markersResponse = await request(source, "GET", `/v3/lab_tests/${test.id}/markers`)
    if (!markersResponse.ok) {
      expectedResults[test.id] = expectedFromMarkers(test)
      continue
    }
    const markersPayload = asRecord(await readJson(markersResponse))
    const markers = markersPayload?.markers
    if (!Array.isArray(markers) || markers.length === 0) {
      expectedResults[test.id] = expectedFromMarkers(test)
      continue
    }
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
    expectedResults[test.id] = expected.length > 0 ? expected : expectedFromMarkers(test)
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
          state.insertOrder(order)
          orders += 1

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
            state.insertAppointment(appointment)
            appointments += 1
          }
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

  return {
    users,
    orders,
    appointments,
    catalogTests: state.listLabTests().length,
    labs: state.listLabs().length,
    cacheEntries,
  }
}
