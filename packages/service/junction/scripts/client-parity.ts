import { type Vital, VitalClient } from "@tryvital/vital-node"
import { JunctionAPI } from "../src/index.js"

const apiKey = process.env.JUNCTION_API_KEY ?? "sk_us_mockingbird"
const baseUrl = process.env.JUNCTION_MOCK_BASE_URL ?? "https://junction.mockingbird.local"

const withMockFetch = async <T>(api: JunctionAPI, run: (client: VitalClient) => Promise<T>) => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? new Request(input, init) : new Request(input, init)
      return api.fetch(request)
    },
    { preconnect: originalFetch.preconnect },
  )
  try {
    return await run(new VitalClient({ apiKey, environment: baseUrl }))
  } finally {
    globalThis.fetch = originalFetch
  }
}

const VOLATILE_KEYS = new Set([
  "userId",
  "user_id",
  "id",
  "orderId",
  "order_id",
  "appointmentId",
  "appointment_id",
  "providerId",
  "provider_id",
  "externalId",
  "external_id",
  "transactionId",
  "transaction_id",
  "orderTransactionId",
  "order_transaction_id",
  "teamId",
  "team_id",
  "clientUserId",
  "client_user_id",
  "createdOn",
  "created_on",
  "createdAt",
  "created_at",
  "updatedAt",
  "updated_at",
  "signedUrl",
  "requisitionFormUrl",
  "requisition_form_url",
  "bookingKey",
  "booking_key",
  "sampleId",
  "sample_id",
  "specimenNumber",
  "specimen_number",
])

/**
 * Volatility-aware normalizer: strips identity/timestamp/token fields (they differ by
 * design between mock and sandbox), canonicalizes known enum drift, and sorts object keys
 * so structural shape comparison is stable.
 */
const normalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalize)
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Uint8Array) return `bytes:${value.length}`
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !VOLATILE_KEYS.has(key))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalize(entry)]),
    )
  }
  return value
}

export type SchedulingScenarioResult = {
  user: unknown
  labTest: unknown
  labs: unknown
  markers: unknown
  areaInfo: unknown
  pscInfo: unknown
  cancellationReasons: unknown
  order: unknown
  appointment: unknown
  availabilityDayCount: number
  resultMetadata: unknown
  simulated: unknown
}

/**
 * Full lab-testing + scheduling scenario executed through the Vital SDK client:
 * user creation, catalog, serviceability, order lifecycle, appointment lifecycle,
 * and results. Booking itself is excluded (real-side slots are provider-owned), but
 * the scenario exercises availability + cancellation reasons around it.
 */
const runSchedulingScenario = async (
  client: VitalClient,
  clientUserId: string,
): Promise<SchedulingScenarioResult> => {
  const created = await client.user.create({ clientUserId })
  const userId = created.userId
  const labTest = await client.labTests.getById("c533549c-1e62-4afe-9a0e-0567a9b2bcc2")
  const labs = await client.labTests.getLabs()
  const markers = await client.labTests.getMarkersForLabTest("c533549c-1e62-4afe-9a0e-0567a9b2bcc2")
  const areaInfo = await client.labTests.getAreaInfo({
    zipCode: "92101",
  })
  const pscInfo = await client.labTests.getPscInfo({ labId: 6, zipCode: "94105" })
  const cancellationReasons = await client.labTests.getPhlebotomyAppointmentCancellationReason()
  const orderResponse = await client.labTests.createOrder({
    userId,
    patientDetails: {
      firstName: "Ada",
      lastName: "Lovelace",
      dob: "1990-01-01",
      gender: "female",
      phoneNumber: "+14155551234",
      email: "ada@example.com",
    },
    patientAddress: {
      firstLine: "1 Main St",
      city: "San Diego",
      state: "CA",
      zip: "92101",
      country: "US",
    },
    orderSet: { labTestIds: ["c533549c-1e62-4afe-9a0e-0567a9b2bcc2"] },
  })
  const orderId = orderResponse.order.id
  const appointmentAvailability = await client.labTests.getPhlebotomyAppointmentAvailability({
    body: {
      firstLine: "1 Main St",
      city: "San Diego",
      state: "CA",
      zipCode: "92101",
    },
  })
  const order = await client.labTests.getOrder(orderId)
  let appointment: Vital.ClientFacingAppointment | undefined
  try {
    appointment = await client.labTests.getPhlebotomyAppointment(orderId)
  } catch {
    appointment = undefined
  }
  const resultMetadata = await client.labTests.getResultMetadata(orderId)
  const simulated = await client.labTests.simulateOrderProcess(orderId, {
    finalStatus: "completed.at_home_phlebotomy.completed",
  })
  return {
    user: created,
    labTest,
    labs,
    markers,
    areaInfo,
    pscInfo,
    cancellationReasons,
    order,
    appointment: appointment ?? { notFound: true },
    availabilityDayCount: appointmentAvailability.slots.length,
    resultMetadata,
    simulated,
  }
}

/**
 * Shape projection for provider-owned geo surfaces (area info, PSC info): every lab slug
 * is a lab_id + billing/capability profile, and center/site payloads carry the fixed
 * metadata contract. Exact per-zip values differ by design between mock and sandbox.
 */
const shapeOf = (value: unknown, depth = 0): unknown => {
  if (depth > 3) return "…"
  if (Array.isArray(value)) {
    const first = value[0]
    return {
      arrayLength: value.length,
      item: first === undefined ? null : shapeOf(first, depth + 1),
    }
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, shapeOf(entry, depth + 1)]),
    )
  }
  if (typeof value === "number") return `number(${Number.isInteger(value) ? "int" : "float"})`
  if (typeof value === "boolean") return "boolean"
  if (typeof value === "string") {
    return /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)/.test(value) ? "day-hours" : "string"
  }
  return value
}

const main = async () => {
  const mock = new JunctionAPI({ now: () => 1_700_000_000_000 })
  const mockResult = await withMockFetch(mock, (client) =>
    runSchedulingScenario(client, "sdk-client-1"),
  )
  process.stdout.write(`${JSON.stringify(normalize(mockResult), null, 2)}\n`)
}

if (import.meta.main) await main()

export { normalize, runSchedulingScenario, shapeOf, withMockFetch }
